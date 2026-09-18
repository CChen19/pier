/**
 * D102 Evidence-Preserving Reducer Invoker & Tool Result Handler.
 *
 * Implements:
 *  - Interception of diagnostic command tool results from `bash`.
 *  - Full untruncated output retrieval from Pi temporary files.
 *  - P0 content-addressed archival of original source log before replacement.
 *  - Secret pattern detection and project trust verification (security boundaries).
 *  - Fast in-process model invocation with timeout protection (default 5s).
 *  - Zero-tolerance byte-for-byte quotation validation against original source.
 *  - Block-level content replacement (preserves write-lock warnings).
 *  - Fail-open resilience: errors or validation failures transparently fallback to full text.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { countLines } from './observation-core.ts';
import {
  containsLikelySecret,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MIN_BYTES,
  DEFAULT_TIMEOUT_MS,
  extractLikelySecretMatch,
  formatReceiptText,
  fullOutputPathFromNotice,
  isDiagnosticCommand,
  mergeUsage,
  reducerInputPrompt,
  reducerInstructions,
  sha256Hex,
  validateReceipt,
  type UsageLike,
  type UsageTotals,
} from './reducer-core.ts';
import {
  appendEfficiencyLog,
  efficiencyLogPath,
  readBashFullOutput,
  reducerObjectPath,
  resolveSessionRoot,
  storeContentAddressedObject,
} from './efficiency-store.ts';
import type { EvidencePreservingReducerConfig } from './efficiency-config-core.ts';
import { diagnosticGateRequest, evaluateDiagnosticGate } from './jev-core.ts';
import type { JevRuntime } from './jev-client.ts';

/** P0-1 seam: the runtime plus a live confidence gate (config can reload mid-session). */
export interface JevEprGateDependency {
  ask: JevRuntime['ask'];
  getMinConfidence: () => number;
}

export interface ToolResultEventLike {
  toolName: string;
  toolCallId: string;
  input?: Record<string, unknown>;
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  details?: Record<string, unknown>;
  isError: boolean;
  usage?: UsageLike;
}

export interface ReducerInvocationResult {
  /** pi's ToolResultEventResult.content uses TextContent, so the literal type must stay narrow. */
  content?: Array<{ type: 'text'; text: string; [k: string]: unknown }>;
  /** Complete pi `Usage` (see mergeUsage): a partial object crashes pi's footer renderer. */
  usage?: UsageTotals;
}

let untrustedWarningEmitted = false;

export async function handleReducerToolResult(
  event: ToolResultEventLike,
  ctx: ExtensionContext,
  config: EvidencePreservingReducerConfig,
  opts?: { epoch?: number; jev?: JevEprGateDependency },
): Promise<ReducerInvocationResult | undefined> {
  if (!config.enabled) return undefined;
  const epoch = opts?.epoch ?? 0;

  // 1. Candidate command & tool gate: strictly bash only
  if (event.toolName !== 'bash') return undefined;
  const command = typeof event.input?.command === 'string' ? event.input.command.trim() : '';
  if (!command) return undefined;
  // 1.5 Project trust boundary — BEFORE the jev gate: an untrusted project must
  // not send commands to a third-party API even when user-level EPR is on;
  // the host mechanism refuses here, so its second opinion must not fire either.
  const isTrusted =
    typeof (ctx as { isProjectTrusted?: () => boolean }).isProjectTrusted === 'function'
      ? (ctx as { isProjectTrusted: () => boolean }).isProjectTrusted()
      : false;
  if (!isTrusted) {
    if (!untrustedWarningEmitted) {
      untrustedWarningEmitted = true;
      console.warn('[pi-herdr] EPR 提炼已在未受信任项目中被安全禁用');
    }
    return undefined;
  }

  // 2. jev diagnostic gate: only for regex-missed commands (P0-1, RFC
  // docs/rfc-jev-integration.md §3). The regex fast path stays authoritative;
  // any jev failure keeps the "not diagnostic" verdict.
  if (!isDiagnosticCommand(command)) {
    const gate = opts?.jev;
    if (!gate) return undefined;
    const result = await gate.ask(diagnosticGateRequest(command), {
      questionId: 'epr-diagnostic-gate',
      timeoutMs: 1500, // measured: cold TLS handshake hit 1002ms and timed out at 1s (e2e 2026-09-18); warm calls run 250-770ms
      sessionId: ctx.sessionManager?.getSessionId?.(),
      extra: { site: 'epr-gate', commandSha256: sha256Hex(command) },
      enrich: ({ answers }) => {
        if (!answers) return {};
        const verdict = evaluateDiagnosticGate(answers, gate.getMinConfidence());
        return { verdict: verdict.hit ? 'hit' : verdict.reason, choice: verdict.choice, noul: verdict.noul, confidence: verdict.confidence };
      },
    });
    if (!result.ok) return undefined;
    if (!evaluateDiagnosticGate(result.answers, gate.getMinConfidence()).hit) return undefined;
  }
  // 3. Find primary log text block
  const logBlock = event.content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
  if (!logBlock || typeof logBlock.text !== 'string') return undefined;

  // 4. Retrieve complete untruncated source if available
  const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS;
  const detailPath = typeof event.details?.fullOutputPath === 'string' ? event.details.fullOutputPath : undefined;
  // Pi repeats the path inside the truncation notice that ships with the result text; a replayed
  // or re-shaped event can keep only that text, and reducing the preview would lose the evidence.
  const noticePath = fullOutputPathFromNotice(logBlock.text);
  const fullOutputPath = detailPath ?? noticePath;
  const fullOutputSource = detailPath ? 'details' : noticePath ? 'notice' : 'none';
  const isTruncated =
    (event.details?.truncation as { truncated?: boolean } | undefined)?.truncated === true;

  const sessionDir = ctx.sessionManager?.getSessionDir?.();
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const sessionRoot = resolveSessionRoot(sessionDir, sessionId);

  // If truncated and no fullOutputPath or fullOutputPath cannot be read safely, fail-open!
  if (isTruncated && !fullOutputPath) {
    if (config.logEnabled && sessionRoot) {
      await logReducerAttempt(sessionRoot, sessionId ?? 'unknown', epoch, {
        commandSha256: sha256Hex(command),
        model: config.model ?? 'default',
        verificationOk: false,
        reason: 'truncated-source',
        action: 'fallback_full_text',
        fullOutputSource,
      });
    }
    return undefined;
  }

  let body = logBlock.text;
  if (fullOutputPath) {
    const full = await readBashFullOutput(fullOutputPath, maxChars);
    if (!full) {
      if (config.logEnabled && sessionRoot) {
        await logReducerAttempt(sessionRoot, sessionId ?? 'unknown', epoch, {
          commandSha256: sha256Hex(command),
          model: config.model ?? 'default',
          verificationOk: false,
          reason: 'truncated-source',
          action: 'fallback_full_text',
          fullOutputSource,
        });
      }
      // Log was truncated but full file could not be read safely -> fallback to avoid hallucinated receipts
      return undefined;
    }
    body = full.content;
  }

  const sourceBytes = Buffer.byteLength(body, 'utf8');
  const minBytes = config.minBytes ?? DEFAULT_MIN_BYTES;
  if (sourceBytes < minBytes || body.length > maxChars) return undefined;

  // 5. Secret detection check
  if (containsLikelySecret(body)) {
    if (config.logEnabled && sessionRoot) {
      await logReducerAttempt(sessionRoot, sessionId ?? 'unknown', epoch, {
        commandSha256: sha256Hex(command),
        sourceBytes,
        model: config.model ?? 'default',
        verificationOk: false,
        reason: 'likely-secret',
        action: 'fallback_full_text',
        // Which shape tripped the gate — the 2026-09-17 trial had 10 fallbacks
        // with zero evidence of what matched (test names vs real credentials).
        secretSnippet: extractLikelySecretMatch(body),
      });
    }
    return undefined; // Fail-open on sensitive data
  }

  if (!sessionRoot) return undefined;

  const sourceHash = sha256Hex(body);
  const sourceLines = countLines(body);
  const archivePath = reducerObjectPath(sessionRoot, sourceHash);

  // 6. P0: Mandatory source archive before any receipt modification
  try {
    await storeContentAddressedObject(archivePath, body);
  } catch {
    return undefined; // Fail-open if storage fails
  }

  // If localOnly mode, archival is complete; leave content unmodified
  if (config.localOnly) return undefined;
  // 7. Resolve model: configured cheap reducer first, session model as fallback
  //    (2026-09-17: user directive — gemini-3.8-flash-high stays the reducer;
  //    unavailability must degrade to the session model, not skip reduction).
  let targetModel: any = undefined;
  let reducerModelSource: 'configured' | 'session-fallback' = 'configured';
  if (config.model && typeof config.model === 'string' && config.model.includes('/')) {
    const [provider, ...rest] = config.model.split('/');
    const modelId = rest.join('/');
    try {
      targetModel = ctx.modelRegistry?.find?.(provider, modelId);
    } catch {
      targetModel = undefined;
    }
  }
  if (!targetModel) {
    targetModel = ctx.model;
    reducerModelSource = 'session-fallback';
  }
  if (!targetModel || typeof ctx.modelRegistry?.complete !== 'function') {
    return undefined;
  }
  // Unified provider/id label: the 2026-09-17 logs split one session into
  // "cliproxy/gemini-3.8-flash-high" (fallback rows) and "gemini-3.8-flash-high"
  // (applied rows), fragmenting per-model grouping.
  const reducerModelLabel =
    typeof targetModel.provider === 'string' && typeof targetModel.id === 'string'
      ? `${targetModel.provider}/${targetModel.id}`
      : (config.model ?? 'unknown');

  // 8. Invoke model in-process with timeout
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    ctx.signal && typeof (AbortSignal as any).any === 'function'
      ? (AbortSignal as any).any([ctx.signal, timeoutSignal])
      : timeoutSignal;

  const promptInput = reducerInputPrompt({
    command,
    isError: event.isError,
    sourceHash,
    sourceBytes,
    sourceLines,
    body,
  });

  const startMs = Date.now();
  let modelResult: any;
  try {
    modelResult = await ctx.modelRegistry.complete(
      targetModel,
      {
        systemPrompt: reducerInstructions(),
        messages: [{ role: 'user', content: [{ type: 'text', text: promptInput }], timestamp: Date.now() }],
      },
      {
        maxTokens: config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        cacheRetention: 'none',
        signal,
      },
    );
  } catch (err) {
    // Fail-open, but no longer silent: the 2026-09-17 trial lost 3+ attempts
    // (timeout / provider error) with no jsonl trace at all.
    if (config.logEnabled) {
      await logReducerAttempt(sessionRoot, sessionId ?? 'unknown', epoch, {
        commandSha256: sha256Hex(command),
        sourceBytes,
        model: reducerModelLabel,
        reducerModelSource,
        verificationOk: false,
        reason: 'invoke-failed',
        action: 'fallback_full_text',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startMs,
      });
    }
    return undefined; // Fail-open on timeout or provider error
  }

  const modelOutput = Array.isArray(modelResult?.content)
    ? modelResult.content.map((b: any) => (typeof b.text === 'string' ? b.text : '')).join('')
    : typeof modelResult?.text === 'string'
      ? modelResult.text
      : '';

  if (!modelOutput.trim()) return undefined;

  // 9. Strict byte-for-byte quotation validation
  const validated = validateReceipt(modelOutput, sourceHash, body, event.isError);
  if (!validated.ok) {
    if (config.logEnabled) {
      const failReason = validated.reason;
      await logReducerAttempt(sessionRoot, sessionId ?? 'unknown', epoch, {
        commandSha256: sha256Hex(command),
        sourceBytes,
        model: reducerModelLabel,
        reducerModelSource,
        verificationOk: false,
        reason: failReason,
        action: 'fallback_full_text',
        // invalid-json rows carried no evidence of what the model actually
        // returned (fences? truncation? prose?) — keep a sanitized head.
        ...(failReason === 'invalid-json' ? { rawOutputHead: JSON.stringify(modelOutput.slice(0, 200)) } : {}),
        durationMs: Date.now() - startMs,
      });
    }
    return undefined;
  }

  const modelName = targetModel.id ?? config.model ?? 'default';
  const providerName = typeof targetModel.provider === 'string' ? targetModel.provider : undefined;
  const receipt = formatReceiptText({
    command,
    sourceHash,
    sourceBytes,
    sourceLines,
    sourceArtifactPath: archivePath,
    validated: validated.value,
    model: modelName,
    provider: providerName,
    totalTokens: modelResult?.usage?.totalTokens,
  });

  const receiptBytes = Buffer.byteLength(receipt, 'utf8');
  if (receiptBytes >= sourceBytes) {
    return undefined; // Must be smaller
  }

  // 10. Block-level replacement: only replace the log text block, preserving warnings
  const nextContent = event.content.map((b): { type: 'text'; text: string } =>
    (b === logBlock ? { ...b, text: receipt } : b) as { type: 'text'; text: string });

  // Backfill usage tokens: the nested reducer model call plus whatever the tool result already carried.
  // MUST stay a COMPLETE pi `Usage`: pi persists this onto the tool-result message and its footer
  // renders it through `addUsageToTotals`, which reads `usage.cost.total` unguarded. Emitting only
  // { input, output, totalTokens } killed the whole pi process with
  // "TypeError: Cannot read properties of undefined (reading 'total')" (observed 2026-09-13 in a
  // subagent pane, stack: FooterComponent.render -> addUsageToTotals). See docs/session-format.md.
  const nextUsage = mergeUsage(event.usage, modelResult?.usage);

  if (config.logEnabled) {
    await logReducerAttempt(sessionRoot, sessionId ?? 'unknown', epoch, {
      commandSha256: sha256Hex(command),
      sourceBytes,
      receiptBytes,
      grossSavedBytes: sourceBytes - receiptBytes,
      compressionRatio: Number((receiptBytes / sourceBytes).toFixed(3)),
      model: reducerModelLabel,
      reducerModelSource,
      verificationOk: true,
      action: 'applied',
      fullOutputSource,
      durationMs: Date.now() - startMs,
    });
  }

  return {
    content: nextContent,
    usage: nextUsage,
  };
}

async function logReducerAttempt(
  sessionRoot: string,
  sessionId: string,
  epoch: number,
  record: Record<string, unknown>,
): Promise<void> {
  const logPath = efficiencyLogPath(sessionRoot, 'reducer');
  try {
    await appendEfficiencyLog(logPath, {
      schema: 'pier-efficiency/1',
      mechanism: 'evidencePreservingReducer',
      ts: new Date().toISOString(),
      sessionId,
      epoch,
      ...record,
    });
  } catch {
    /* ignore logging error */
  }
}

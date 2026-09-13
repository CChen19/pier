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
  formatReceiptText,
  isDiagnosticCommand,
  reducerInputPrompt,
  reducerInstructions,
  sha256Hex,
  validateReceipt,
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

export interface ToolResultEventLike {
  toolName: string;
  toolCallId: string;
  input?: Record<string, unknown>;
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  details?: Record<string, unknown>;
  isError: boolean;
  usage?: { input?: number; output?: number; totalTokens?: number };
}

export interface ReducerInvocationResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  usage?: { input?: number; output?: number; totalTokens?: number };
}

let untrustedWarningEmitted = false;

export async function handleReducerToolResult(
  event: ToolResultEventLike,
  ctx: ExtensionContext,
  config: EvidencePreservingReducerConfig,
  opts?: { epoch?: number },
): Promise<ReducerInvocationResult | undefined> {
  if (!config.enabled) return undefined;
  const epoch = opts?.epoch ?? 0;

  // 1. Candidate command & tool gate: strictly bash only
  if (event.toolName !== 'bash') return undefined;
  const command = typeof event.input?.command === 'string' ? event.input.command.trim() : '';
  if (!command || !isDiagnosticCommand(command)) return undefined;

  // 2. Project trust boundary check
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

  // 3. Find primary log text block
  const logBlock = event.content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
  if (!logBlock || typeof logBlock.text !== 'string') return undefined;

  // 4. Retrieve complete untruncated source if available
  const maxChars = config.maxChars ?? DEFAULT_MAX_CHARS;
  const fullOutputPath = typeof event.details?.fullOutputPath === 'string' ? event.details.fullOutputPath : undefined;
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

  // 7. Resolve model
  let targetModel: any = undefined;
  if (config.model && typeof config.model === 'string' && config.model.includes('/')) {
    const [provider, ...rest] = config.model.split('/');
    const modelId = rest.join('/');
    targetModel = ctx.modelRegistry?.find?.(provider, modelId);
  }
  if (!targetModel) {
    targetModel = ctx.model;
  }
  if (!targetModel || typeof ctx.modelRegistry?.complete !== 'function') {
    return undefined;
  }

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
  } catch {
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
      await logReducerAttempt(sessionRoot, sessionId ?? 'unknown', epoch, {
        commandSha256: sha256Hex(command),
        sourceBytes,
        model: targetModel.id ?? config.model ?? 'unknown',
        verificationOk: false,
        reason: (validated as { ok: false; reason: string }).reason,
        action: 'fallback_full_text',
        durationMs: Date.now() - startMs,
      });
    }
    return undefined;
  }

  const modelName = targetModel.id ?? config.model ?? 'default';
  const receipt = formatReceiptText({
    command,
    sourceHash,
    sourceBytes,
    sourceLines,
    sourceArtifactPath: archivePath,
    validated: validated.value,
    model: modelName,
    totalTokens: modelResult?.usage?.totalTokens,
  });

  const receiptBytes = Buffer.byteLength(receipt, 'utf8');
  if (receiptBytes >= sourceBytes) {
    return undefined; // Must be smaller
  }

  // 10. Block-level replacement: only replace the log text block, preserving warnings
  const nextContent = event.content.map((b) => (b === logBlock ? { ...b, text: receipt } : b));

  // Backfill usage tokens
  const nextUsage = {
    input: (event.usage?.input ?? 0) + (modelResult?.usage?.input ?? 0),
    output: (event.usage?.output ?? 0) + (modelResult?.usage?.output ?? 0),
    totalTokens: (event.usage?.totalTokens ?? 0) + (modelResult?.usage?.totalTokens ?? 0),
  };

  if (config.logEnabled) {
    await logReducerAttempt(sessionRoot, sessionId ?? 'unknown', epoch, {
      commandSha256: sha256Hex(command),
      sourceBytes,
      receiptBytes,
      grossSavedBytes: sourceBytes - receiptBytes,
      compressionRatio: Number((receiptBytes / sourceBytes).toFixed(3)),
      model: modelName,
      verificationOk: true,
      action: 'applied',
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

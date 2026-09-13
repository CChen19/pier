/**
 * D101 ObservationPack Plugin & Context Interceptor.
 *
 * Provides:
 *  - `obs_recall` tool for paged retrieval of replaced large tool results.
 *  - `context` lifecycle interception: projects placeholders for large tool results
 *    that have exceeded fullSends, keeping underlying JSONL intact.
 *  - Cache-aware packing decisions and role visibility guards.
 *  - Append-only telemetry auditing.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  containsReducerReceipt,
  countLines,
  deriveObservationId,
  estimateTokens,
  formatObservationPlaceholder,
  isObservationId,
  sha256Hex,
  shouldPackForCache,
} from '../observation-core.ts';
import {
  appendEfficiencyLog,
  efficiencyLogPath,
  observationObjectPath,
  readStoredObjectChunk,
  resolveSessionRoot,
  storeContentAddressedObject,
} from '../efficiency-store.ts';
import {
  resolveEfficiencyConfig,
  type EfficiencyConfig,
  type ObservationPackConfig,
} from '../efficiency-config-core.ts';
import { planToolGate, type RuntimeRoleManifest } from '../tool-gate.ts';

export const RECALL_TOOL_NAME = 'obs_recall';
export const RECALL_MAX_BYTES = 16 * 1024;
export const RECALL_MAX_LINES = 400;

const loggedPackedObsIds = new Set<string>();

interface MemoizedPlaceholder {
  placeholder: string;
  obsId: string;
  bytes: number;
}

const placeholderMemo = new Map<string, MemoizedPlaceholder>();
const MAX_MEMO_ENTRIES = 256;

export function invalidateObservationMemo(obsId: string): void {
  for (const [k, v] of placeholderMemo.entries()) {
    if (v.obsId === obsId) {
      placeholderMemo.delete(k);
    }
  }
}

export function clearObservationMemoForTest(): void {
  placeholderMemo.clear();
  loggedPackedObsIds.clear();
}

export interface ObservationPackDeps {
  pi: ExtensionAPI;
  getConfig?: (ctx: ExtensionContext) => EfficiencyConfig;
  getRuntimeManifest?: () => RuntimeRoleManifest | null;
  getRemainingHorizon?: () => number;
}

export function registerObservationPack(deps: ObservationPackDeps): void {
  const { pi, getConfig, getRuntimeManifest } = deps;

  // 1. Register obs_recall tool
  pi.registerTool({
    name: RECALL_TOOL_NAME,
    label: 'Recall Observation',
    description:
      'Recall a paged slice of a previously replaced large tool result by observation id and byte offset.',
    promptGuidelines: [
      'Call obs_recall with id and offset to inspect specific parts of large tool outputs.',
      'Check the returned next_offset and eof to page through long logs.',
    ],
    parameters: Type.Object({
      id: Type.String({ description: 'Observation ID from placeholder (e.g. obs_...)' }),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, description: 'Byte offset to recall from (default 0)' }),
      ),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      void toolCallId;
      const id = params?.id;
      const offset = params?.offset ?? 0;

      if (!isObservationId(id)) {
        return {
          content: [{ type: 'text', text: `Error: invalid observation id format: "${id}"` }],
          details: {},
        };
      }

      const sessionDir = ctx?.sessionManager?.getSessionDir?.();
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      const sessionRoot = resolveSessionRoot(sessionDir, sessionId);

      if (!sessionRoot) {
        return {
          content: [{ type: 'text', text: 'Error: session storage is unavailable for observation recall.' }],
          details: {},
        };
      }

      const filePath = observationObjectPath(sessionRoot, id);
      const startMs = Date.now();
      const effConfig = getConfig ? getConfig(ctx) : resolveEfficiencyConfig();
      const recallMaxBytes = effConfig.observationPack.recallChunkBytes ?? RECALL_MAX_BYTES;
      try {
        const chunk = await readStoredObjectChunk(filePath, offset, {
          maxBytes: recallMaxBytes,
          maxLines: RECALL_MAX_LINES,
        });

        const header = [
          `[obs_recall id=${id} offset=${offset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
          `[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
        ].join('\n');

        if (effConfig.observationPack.logEnabled) {
          const logPath = efficiencyLogPath(
            sessionRoot,
            'observation',
            undefined,
          );
          void appendEfficiencyLog(logPath, {
            schema: 'pier-efficiency/1',
            mechanism: 'observationPack',
            event: 'recall',
            ts: new Date().toISOString(),
            sessionId: sessionId ?? 'unknown',
            obsId: id,
            offset,
            chunkBytes: chunk.bytes,
            lines: chunk.lines,
            nextOffset: chunk.nextOffset,
            eof: chunk.eof,
            durationMs: Date.now() - startMs,
          }).catch(() => {});
        }

        return {
          content: [{ type: 'text', text: `${header}\n${chunk.text}` }],
          details: {
            id,
            offset,
            bytes: chunk.bytes,
            lines: chunk.lines,
            nextOffset: chunk.nextOffset,
            eof: chunk.eof,
          },
        };
      } catch (err) {
        // Self-healing: if disk file is missing or corrupted, invalidate memo to repack if needed
        invalidateObservationMemo(id);
        return {
          content: [
            {
              type: 'text',
              text: `Error: failed to recall observation ${id}: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          details: {},
        };
      }
    },
  });

  // 2. Intercept context event to project placeholders
  pi.on('context', async (event, ctx: ExtensionContext) => {
    if (!event || !Array.isArray(event.messages)) return;

    const effConfig = getConfig ? getConfig(ctx) : resolveEfficiencyConfig();
    const obsConfig: ObservationPackConfig = effConfig.observationPack;
    if (!obsConfig.enabled) return;

    // Role visibility gate check: if current role denies obs_recall, skip packing completely!
    const manifest = getRuntimeManifest ? getRuntimeManifest() : null;
    if (manifest) {
      const gate = planToolGate(RECALL_TOOL_NAME, manifest);
      if (gate.kind === 'deny') {
        return; // Skip packing: agent would not be permitted to call obs_recall
      }
    }

    const sessionDir = ctx?.sessionManager?.getSessionDir?.();
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    const sessionRoot = resolveSessionRoot(sessionDir, sessionId);
    if (!sessionRoot) return; // Fail-open if session directory is absent

    const projected = [...event.messages];
    const len = projected.length;

    // Calculate how many assistant responses followed each message
    const priorAssistantCounts = new Array<number>(len);
    let assistantCount = 0;
    for (let i = len - 1; i >= 0; i--) {
      priorAssistantCounts[i] = assistantCount;
      if (projected[i]?.role === 'assistant') {
        assistantCount++;
      }
    }

    for (let i = 0; i < len; i++) {
      const msg = projected[i];
      if (!msg || msg.role !== 'toolResult' || (msg as { isError?: boolean }).isError) continue;
      const content = (msg as { content?: Array<{ type: string; text?: string }> }).content;
      if (!Array.isArray(content) || content.length === 0) continue;
      if (!content.every((b) => b && b.type === 'text' && typeof b.text === 'string')) continue;

      const toolName = (msg as { toolName?: string }).toolName ?? 'tool';
      const toolCallId = (msg as { toolCallId?: string }).toolCallId ?? `call_${i}`;

      let approxChars = 0;
      for (const b of content) approxChars += (b.text?.length ?? 0);

      // N1' Fast Path: check memo BEFORE text join, containsReducerReceipt, and byteLength!
      // Once packed, observation remains sticky until memo eviction.
      const memoKey = `${sessionRoot}:${toolCallId}:${approxChars}`;
      const memoized = placeholderMemo.get(memoKey);
      if (memoized) {
        // Refresh LRU position
        placeholderMemo.delete(memoKey);
        placeholderMemo.set(memoKey, memoized);
        projected[i] = {
          ...msg,
          content: [{ type: 'text', text: memoized.placeholder }],
        };
        continue;
      }

      const sendCount = priorAssistantCounts[i] ?? 0;
      // Active use window: do not touch and do not store to disk prematurely!
      if (sendCount < obsConfig.fullSends) {
        continue;
      }

      const text = content.map((b) => b.text ?? '').join('\n');
      if (containsReducerReceipt(text)) continue;

      const textBytes = Buffer.byteLength(text, 'utf8');
      if (textBytes < obsConfig.thresholdBytes) continue;

      // Calculate tail tokens after this message
      let tailTokensAfter = 0;
      for (let j = i + 1; j < len; j++) {
        const afterMsg = projected[j];
        if (afterMsg && Array.isArray((afterMsg as { content?: unknown[] }).content)) {
          for (const b of (afterMsg as { content: Array<{ type: string; text?: string }> }).content) {
            if (b && b.type === 'text' && typeof b.text === 'string') {
              tailTokensAfter += estimateTokens(b.text);
            }
          }
        }
      }

      const contentHash = sha256Hex(text);
      const obsId = deriveObservationId(toolName, toolCallId, contentHash);
      const originalTokens = estimateTokens(text);
      const lines = countLines(text);
      const placeholder = formatObservationPlaceholder({
        id: obsId,
        toolName,
        bytes: textBytes,
        lines,
        tokens: originalTokens,
        text,
        fullSends: obsConfig.fullSends,
        excerptBudget: obsConfig.excerptBytes,
      });
      const placeholderTokens = estimateTokens(placeholder);
      const removedTokens = Math.max(0, originalTokens - placeholderTokens);

      const remainingHorizon = deps.getRemainingHorizon ? deps.getRemainingHorizon() : 4;
      const canPack = shouldPackForCache({
        removedTokens,
        tailTokensAfter,
        expectedRemainingRequests: remainingHorizon,
        cacheWriteReadRatio: effConfig.onlineContextCompact.cacheWriteReadRatio,
      });

      if (canPack) {
        // Only store to content-addressed storage when packing is determined profitable
        const objPath = observationObjectPath(sessionRoot, obsId);
        try {
          await storeContentAddressedObject(objPath, text, {
            bytes: textBytes,
            hash: contentHash,
            lines,
          });
        } catch {
          continue; // Fail-open on disk error
        }

        projected[i] = {
          ...msg,
          content: [{ type: 'text', text: placeholder }],
        };

        if (placeholderMemo.size >= MAX_MEMO_ENTRIES) {
          const oldest = placeholderMemo.keys().next().value;
          if (oldest) placeholderMemo.delete(oldest);
        }
        placeholderMemo.set(memoKey, {
          placeholder,
          obsId,
          bytes: textBytes,
        });

        if (obsConfig.logEnabled && !loggedPackedObsIds.has(obsId)) {
          loggedPackedObsIds.add(obsId);
          const logPath = efficiencyLogPath(sessionRoot, 'observation');
          void appendEfficiencyLog(logPath, {
            schema: 'pier-efficiency/1',
            mechanism: 'observationPack',
            event: 'packed',
            ts: new Date().toISOString(),
            sessionId: sessionId ?? 'unknown',
            obsId,
            toolName,
            originalBytes: textBytes,
            originalTokens,
            placeholderTokens,
            grossSavedTokens: removedTokens,
            sendCount,
            tailTokensAfter,
          }).catch(() => {});
        }
      }
    }

    return { messages: projected };
  });
}

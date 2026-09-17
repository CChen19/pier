/**
 * D101 ObservationPack Core.
 *
 * Pure algorithmic functions for large observation detection, deterministic ID derivation,
 * complete-line excerpt generation, chunk slicing with UTF-8 safety, and rolling prefix cache
 * economics.
 *
 * No I/O in this core; storage I/O lives in efficiency-store.ts.
 */
import { createHash } from 'node:crypto';
import { TOKEN_ACCOUNT_CACHE_RATIO } from './compact-economics-core.ts';

export const DEFAULT_THRESHOLD_BYTES = 10 * 1024; // 10KB
export const DEFAULT_FULL_SENDS = 2;
export const DEFAULT_EXCERPT_BYTES = 1024;
export const CHARS_PER_TOKEN = 4;
export const OBSERVATION_ID_RE = /^obs_[a-f0-9]{24}$/;

/** Marker from Evidence-Preserving Reducer to avoid double packing. */
export const REDUCER_RECEIPT_PREFIX = 'sol_pi_evidence_receipt_v1';

export function sha256Hex(val: string | Buffer): string {
  return createHash('sha256').update(val).digest('hex');
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = text.endsWith('\n') ? 0 : 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 0x0a) lines++;
  }
  return lines;
}

export function isObservationId(id: string): boolean {
  return OBSERVATION_ID_RE.test(id);
}

export function deriveObservationId(toolName: string, toolCallId: string, contentHash: string): string {
  const combined = `${toolName}\0${toolCallId}\0${contentHash}`;
  return `obs_${sha256Hex(combined).slice(0, 24)}`;
}

export function containsReducerReceipt(text: string): boolean {
  if (!text.includes(REDUCER_RECEIPT_PREFIX)) return false;
  return text.split('\n').some((line) => line.trim() === REDUCER_RECEIPT_PREFIX);
}

export function completeLineExcerpt(text: string, budgetBytes: number, fromEnd: boolean): string {
  if (budgetBytes <= 0 || text.length === 0) return '';

  if (!fromEnd) {
    // Head excerpt: candidate never exceeds budgetBytes * 4 chars
    const candidate = text.slice(0, Math.min(text.length, budgetBytes * 4));
    let lastEnd = 0;
    let totalBytes = 0;
    let searchIndex = 0;
    while (searchIndex < candidate.length) {
      const nextNewline = candidate.indexOf('\n', searchIndex);
      if (nextNewline === -1) break;
      const lineEnd = nextNewline + 1;
      const line = candidate.slice(lastEnd, lineEnd);
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (totalBytes + lineBytes > budgetBytes) break;
      totalBytes += lineBytes;
      lastEnd = lineEnd;
      searchIndex = lineEnd;
    }
    return candidate.slice(0, lastEnd);
  } else {
    // Tail excerpt: candidate never exceeds budgetBytes * 4 chars from end
    const startOffset = Math.max(0, text.length - budgetBytes * 4);
    const candidate = text.slice(startOffset);
    const lines = candidate.split(/(?<=\n)/);
    const selected: string[] = [];
    let selectedBytes = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      // If startOffset > 0, the first line of candidate might be partial, skip unless it follows a newline
      if (i === 0 && startOffset > 0 && text[startOffset - 1] !== '\n') {
        break;
      }
      const lineBytes = Buffer.byteLength(line, 'utf8');
      if (selectedBytes + lineBytes > budgetBytes) break;
      selected.unshift(line);
      selectedBytes += lineBytes;
    }
    return selected.join('');
  }
}

export interface ObservationPlaceholderInput {
  id: string;
  toolName: string;
  bytes: number;
  lines: number;
  tokens: number;
  text: string;
  fullSends?: number;
  excerptBudget?: number;
}

export function formatObservationPlaceholder(input: ObservationPlaceholderInput): string {
  const fullSends = input.fullSends ?? DEFAULT_FULL_SENDS;
  const excerptBudget = input.excerptBudget ?? DEFAULT_EXCERPT_BYTES;
  const headBudget = Math.floor(excerptBudget / 2);
  const tailBudget = excerptBudget - headBudget;

  const head = completeLineExcerpt(input.text, headBudget, false);
  const tail = completeLineExcerpt(input.text, tailBudget, true);

  return [
    `[large tool result replaced after its first ${fullSends} provider requests]`,
    `id: ${input.id}`,
    `tool: ${input.toolName}`,
    `original_bytes: ${input.bytes}`,
    `original_lines: ${input.lines}`,
    `estimated_tokens: ${input.tokens}`,
    `retrieve: call obs_recall with {"id":"${input.id}","offset":0}; continue with returned next_offset`,
    `[first complete lines, up to ${headBudget} bytes]`,
    head,
    `[middle omitted; last complete lines, up to ${tailBudget} bytes]`,
    tail,
    `[${input.bytes} original bytes omitted; recall via obs_recall]`,
  ].join('\n');
}

export interface RecallSliceResult {
  text: string;
  bytes: number;
  lines: number;
  nextOffset: number;
  eof: boolean;
}

/**
 * Trims multi-byte UTF-8 sequence from buffer boundary if cut mid-character.
 */
export function trimUtf8End(buffer: Buffer, limit: number): number {
  let end = limit;
  while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return end;
}

/**
 * Slices a memory buffer safely at byte offsets without cutting UTF-8 characters.
 */
export function sliceBufferChunk(
  buf: Buffer,
  offset: number,
  limits: { maxBytes: number; maxLines: number },
): RecallSliceResult {
  if (offset >= buf.length) {
    return { text: '', bytes: 0, lines: 0, nextOffset: buf.length, eof: true };
  }

  const available = buf.length - offset;
  let end = Math.min(available, limits.maxBytes);
  let newlineCount = 0;

  for (let i = 0; i < end; i++) {
    if (buf[offset + i] === 0x0a) {
      newlineCount++;
      if (newlineCount === limits.maxLines) {
        end = i + 1;
        break;
      }
    }
  }

  const trimmedEnd = trimUtf8End(buf.subarray(offset), end);
  const chunkBuf = buf.subarray(offset, offset + trimmedEnd);
  const text = chunkBuf.toString('utf8');
  const bytes = chunkBuf.length;
  const lines = countLines(text);
  const nextOffset = offset + bytes;
  const eof = nextOffset >= buf.length;

  return { text, bytes, lines, nextOffset, eof };
}

/**
 * Evaluates whether replacing an earlier message with a placeholder is profitable
 * under rolling prefix cache models.
 *
 * `cacheWriteReadRatio` must already be resolved by the caller via
 * `resolveCacheRatioFromCost` (same value OCC uses). It used to coerce
 * `'auto'|null` to a hardcoded 12.5 here, which silently diverged from OCC's
 * resolution and made OBS under-pack on implicit-cache models (2026-09-17
 * review: 20/72 packs deferred to sendCount 3–175).
 */
export function shouldPackForCache(opts: {
  removedTokens: number;
  tailTokensAfter: number;
  expectedRemainingRequests: number;
  cacheWriteReadRatio: number | null;
}): boolean {
  if (opts.removedTokens <= 0) return false;
  const ratio = opts.cacheWriteReadRatio ?? TOKEN_ACCOUNT_CACHE_RATIO;

  if (ratio <= 1.0) {
    return true; // No incremental write cost over reads
  }

  const incrementalRatio = ratio - 1.0;
  const remaining = Math.max(1, opts.expectedRemainingRequests);
  const benefitTokens = opts.removedTokens * remaining;
  const costTokens = opts.tailTokensAfter * incrementalRatio;

  return benefitTokens > costTokens;
}

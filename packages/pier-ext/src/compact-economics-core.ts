/**
 * D100 Online Context Compact Economics & Feasibility Core.
 *
 * Implements pure economics decision-making, request horizon estimation,
 * cache debt tracking, and native compaction feasibility preflights.
 *
 * Zero-dependency / pure algorithm core (except Pi's public cut point helper).
 */

import {
  findCutPoint,
  sessionEntryToContextMessages,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';

export interface CompactionEconomics {
  readonly remainingRequestScale: number;
  readonly remainingRequestStddevK: number;
  readonly windowReserveTokens: number;
  readonly firstCompactionRequestScale: number;
  readonly subsequentCompactionMargin: number;
}

export const DEFAULT_COMPACTION_ECONOMICS: CompactionEconomics = Object.freeze({
  remainingRequestScale: 1.0,
  remainingRequestStddevK: 0.0,
  windowReserveTokens: 16_384,
  firstCompactionRequestScale: 2.0,
  subsequentCompactionMargin: 1.5,
});

export type CompactionReason =
  | 'economic'
  | 'window_protection'
  | 'deferred_economic'
  | 'deferred_subsequent_margin'
  | 'deferred_carried_debt'
  | 'horizon_unavailable'
  | 'cache_ratio_unavailable'
  | 'native_not_compactable'
  | 'non_positive_saving';

export interface RequestHorizonEstimate {
  readonly completedBoundaryRequestCounts: readonly number[];
  readonly requestsPerBoundaryMean: number;
  readonly requestsPerBoundaryLowerBound: number;
  readonly unboundedExpectedRemainingRequests: number;
  readonly averageContextTokenIncrement: number | null;
  readonly windowRequestUpperBound: number | null;
  readonly expectedRemainingRequests: number;
}

export interface CompactionDecision {
  readonly writeTokens: number;
  readonly archiveTokens: number;
  readonly memoTokens: number;
  readonly contextTokens: number;
  readonly completedBoundaryRequestCounts: readonly number[] | null;
  readonly requestsPerBoundaryMean: number | null;
  readonly requestsPerBoundaryLowerBound: number | null;
  readonly unboundedExpectedRemainingRequests: number | null;
  readonly averageContextTokenIncrement: number | null;
  readonly windowRequestUpperBound: number | null;
  readonly expectedRemainingRequests: number | null;
  readonly breakevenRequests: number | null;
  readonly combinedBreakevenRequests: number | null;
  readonly effectiveHorizonRequests: number | null;
  readonly cacheWriteReadRatio: number | null;
  readonly incrementalCacheCostRatio: number | null;
  readonly priorCompactionCount: number;
  readonly carriedDebtTokens: number;
  readonly cacheDebtRepaymentTokens: number;
  readonly compact: boolean;
  readonly reason: CompactionReason;
}

const MINIMUM_VARIANCE_SAMPLES = 3;
const SMALL_SAMPLE_SCALE = 0.5;

export function estimateRemainingRequests(input: {
  readonly completedBoundaryRequestCounts: readonly number[];
  readonly remainingBoundaries: number;
  readonly scale: number;
  readonly standardDeviationK: number;
  readonly contextTokens: number;
  readonly contextWindowTokens: number | null;
  readonly averageContextTokenIncrement: number | null;
}): RequestHorizonEstimate {
  const counts = input.completedBoundaryRequestCounts;
  const mean =
    counts.reduce((total, count) => total + count, 0) /
    Math.max(1, counts.length);
  let lowerBound = mean;
  if (input.standardDeviationK !== 0) {
    if (counts.length < MINIMUM_VARIANCE_SAMPLES) {
      lowerBound *= SMALL_SAMPLE_SCALE;
    } else {
      const variance = counts.reduce((total, count) => total + (count - mean) ** 2, 0);
      const deviation = Math.sqrt(variance / (counts.length - 1));
      lowerBound = Math.max(0, mean - input.standardDeviationK * deviation);
    }
  }

  const unboundedExpectedRemainingRequests =
    1 + Math.floor(lowerBound * Math.max(0, input.remainingBoundaries) * input.scale);
  const windowRequestUpperBound =
    input.contextWindowTokens === null ||
    input.averageContextTokenIncrement === null ||
    input.averageContextTokenIncrement <= 0
      ? null
      : Math.max(
          0,
          Math.floor((input.contextWindowTokens - input.contextTokens) / input.averageContextTokenIncrement),
        );

  return {
    completedBoundaryRequestCounts: [...counts],
    requestsPerBoundaryMean: mean,
    requestsPerBoundaryLowerBound: lowerBound,
    unboundedExpectedRemainingRequests,
    averageContextTokenIncrement: input.averageContextTokenIncrement,
    windowRequestUpperBound,
    expectedRemainingRequests:
      windowRequestUpperBound === null
        ? unboundedExpectedRemainingRequests
        : Math.min(unboundedExpectedRemainingRequests, windowRequestUpperBound),
  };
}

export function decideCompaction(input: {
  readonly writeTokens: number;
  readonly archiveTokens: number;
  readonly memoTokens: number;
  readonly contextTokens: number;
  readonly completedBoundaryRequestCounts: readonly number[] | null;
  readonly remainingBoundaries: number;
  readonly averageContextTokenIncrement: number | null;
  readonly contextWindowTokens: number | null;
  readonly priorCompactionCount: number;
  readonly carriedDebtTokens: number;
  readonly cacheDebtRepaymentTokens: number;
  readonly cacheWriteReadRatio: number | null;
  readonly economics?: CompactionEconomics;
}): CompactionDecision {
  const economics = input.economics ?? DEFAULT_COMPACTION_ECONOMICS;
  const horizon =
    input.completedBoundaryRequestCounts === null
      ? null
      : estimateRemainingRequests({
          completedBoundaryRequestCounts: input.completedBoundaryRequestCounts,
          remainingBoundaries: input.remainingBoundaries,
          scale: economics.remainingRequestScale,
          standardDeviationK: economics.remainingRequestStddevK,
          contextTokens: input.contextTokens,
          contextWindowTokens: input.contextWindowTokens,
          averageContextTokenIncrement: input.averageContextTokenIncrement,
        });

  const savingTokens = input.archiveTokens - input.memoTokens;
  const incrementalCacheCostRatio =
    input.cacheWriteReadRatio === null ? null : Math.max(0, input.cacheWriteReadRatio - 1);

  const breakevenRequests =
    savingTokens > 0 && incrementalCacheCostRatio !== null
      ? (input.writeTokens * incrementalCacheCostRatio) / savingTokens
      : null;

  const combinedBreakevenRequests =
    savingTokens > 0 && incrementalCacheCostRatio !== null
      ? (input.carriedDebtTokens + input.writeTokens * incrementalCacheCostRatio) / savingTokens
      : null;

  const firstCompaction = input.priorCompactionCount === 0;
  const effectiveHorizonRequests =
    horizon === null
      ? null
      : firstCompaction
        ? Math.min(
            horizon.expectedRemainingRequests * economics.firstCompactionRequestScale,
            horizon.windowRequestUpperBound ?? Number.POSITIVE_INFINITY,
          )
        : horizon.expectedRemainingRequests;

  const windowProtection =
    input.contextWindowTokens !== null &&
    input.contextTokens >= input.contextWindowTokens - economics.windowReserveTokens;

  const baseEconomic =
    horizon !== null &&
    horizon.expectedRemainingRequests > 0 &&
    breakevenRequests !== null &&
    breakevenRequests <= horizon.expectedRemainingRequests;

  const firstEconomic =
    firstCompaction &&
    effectiveHorizonRequests !== null &&
    effectiveHorizonRequests > 0 &&
    breakevenRequests !== null &&
    breakevenRequests <= effectiveHorizonRequests;

  const subsequentMarginOpen =
    !firstCompaction &&
    horizon !== null &&
    breakevenRequests !== null &&
    breakevenRequests * economics.subsequentCompactionMargin <= horizon.expectedRemainingRequests;

  const carriedDebtGateOpen =
    !firstCompaction &&
    horizon !== null &&
    combinedBreakevenRequests !== null &&
    combinedBreakevenRequests <= horizon.expectedRemainingRequests;

  const economic = firstCompaction ? firstEconomic : baseEconomic && subsequentMarginOpen && carriedDebtGateOpen;
  const compressible = savingTokens > 0;
  const compact = compressible && (windowProtection || economic);

  return {
    writeTokens: input.writeTokens,
    archiveTokens: input.archiveTokens,
    memoTokens: input.memoTokens,
    contextTokens: input.contextTokens,
    ...(horizon ?? {
      completedBoundaryRequestCounts: null,
      requestsPerBoundaryMean: null,
      requestsPerBoundaryLowerBound: null,
      unboundedExpectedRemainingRequests: null,
      averageContextTokenIncrement: input.averageContextTokenIncrement,
      windowRequestUpperBound: null,
      expectedRemainingRequests: null,
    }),
    breakevenRequests,
    combinedBreakevenRequests,
    effectiveHorizonRequests,
    cacheWriteReadRatio: input.cacheWriteReadRatio,
    incrementalCacheCostRatio,
    priorCompactionCount: input.priorCompactionCount,
    carriedDebtTokens: input.carriedDebtTokens,
    cacheDebtRepaymentTokens: input.cacheDebtRepaymentTokens,
    compact,
    reason: !compressible
      ? 'non_positive_saving'
      : windowProtection
        ? 'window_protection'
        : economic
          ? 'economic'
          : horizon === null
            ? 'horizon_unavailable'
            : breakevenRequests === null
              ? 'cache_ratio_unavailable'
              : !firstCompaction && baseEconomic && !subsequentMarginOpen
                ? 'deferred_subsequent_margin'
                : !firstCompaction && baseEconomic && !carriedDebtGateOpen
                  ? 'deferred_carried_debt'
                  : 'deferred_economic',
  };
}

/**
 * Resolve cache write/read cost ratio for economic compaction decisions.
 *
 * Priority:
 *  1. Explicit numeric config → use as-is (e.g., 12.5 for Anthropic models)
 *  2. Model cost metadata → derive ratio from cacheWrite/cacheRead
 *  3. Fallback → 12.5 (standard Anthropic-like pricing)
 *
 * Returns null to disable economic decisions when:
 *  - Model has no cache capability (both read=0, write=0)
 *  - Model has free cache writes but no read price (write=0 while read exists)
 *    → Indicates no cache feature, not truly free writes
 *  - Missing cacheRead price → cannot compute valid ratio
 *
 * Rationale for write=0 → null (P0-1 fix):
 *  DeepSeek/Gemini report cacheWrite=0 not because writes are free,
 *  but because they don't support KV cache at all. Treating 0 as "free"
 *  would trigger spurious compactions with infinite breakeven horizon.
 */
export function resolveCacheRatioFromCost(
  ratioConfig: number | 'auto',
  cost?: { cacheRead?: number; cacheWrite?: number } | null,
): number | null {
  // Explicit config takes absolute precedence
  if (typeof ratioConfig === 'number') {
    return Number.isFinite(ratioConfig) && ratioConfig >= 0 ? ratioConfig : null;
  }

  // No model cost metadata → conservative fallback
  if (!cost) return 12.5;

  const read = cost.cacheRead ?? 0;
  const write = cost.cacheWrite ?? 0;

  // No cache capability at all
  if (read === 0 && write === 0) return null;

  // Missing read price → cannot compute ratio
  if (read === 0) return null;

  // Zero write cost → indicates no cache support, not free writes
  // (DeepSeek/Gemini/GLM report write=0 when cache is unavailable)
  if (write === 0) return null;

  return write / read;
}

function compactionMessageCount(entries: readonly SessionEntry[], startIndex: number, endIndex: number): number {
  let count = 0;
  for (let index = startIndex; index < endIndex; index++) {
    const entry = entries[index];
    if (entry && entry.type !== 'compaction' && sessionEntryToContextMessages(entry).length > 0) {
      count++;
    }
  }
  return count;
}

function branchAfterAbort(entries: readonly SessionEntry[]): SessionEntry[] {
  const last = entries.at(-1);
  const markerProvider = 'pi-herdr';
  return [
    ...entries,
    {
      type: 'message',
      id: 'pi-herdr-online-context-compact-abort-marker',
      parentId: last?.id ?? null,
      timestamp: new Date(0).toISOString(),
      message: {
        role: 'assistant',
        content: [],
        api: markerProvider,
        provider: markerProvider,
        model: 'aborted',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'aborted',
        timestamp: 0,
      },
    } as SessionEntry,
  ];
}

export function nativeCompactionFeasible(entries: readonly SessionEntry[], keepRecentTokens: number): boolean {
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const path = branchAfterAbort(entries);
  let startIndex = 0;
  for (let index = path.length - 1; index >= 0; index--) {
    const entry = path[index];
    if (entry?.type !== 'compaction') continue;
    const keptIndex = path.findIndex((item) => item.id === (entry as { firstKeptEntryId?: string }).firstKeptEntryId);
    startIndex = keptIndex >= 0 ? keptIndex : index + 1;
    break;
  }

  const cut = findCutPoint(path, startIndex, path.length, keepRecentTokens);
  const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
  const historyMessages = historyEnd > startIndex ? compactionMessageCount(path, startIndex, historyEnd) : 0;
  const prefixMessages =
    cut.isSplitTurn && cut.turnStartIndex >= 0
      ? compactionMessageCount(path, cut.turnStartIndex, cut.firstKeptEntryIndex)
      : 0;
  return historyMessages > 0 || prefixMessages > 0;
}

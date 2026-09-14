/**
 * D100 Online Context Compact Economics & Feasibility Core Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideCompaction,
  estimateRemainingRequests,
  nativeCompactionFeasible,
  resolveCacheRatioFromCost,
  type CompactionEconomics,
  DEFAULT_COMPACTION_ECONOMICS,
} from '../src/compact-economics-core.ts';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

test('estimateRemainingRequests: calculates mean and scales with remaining boundaries', () => {
  const est = estimateRemainingRequests({
    completedBoundaryRequestCounts: [4, 6],
    remainingBoundaries: 3,
    scale: 1.0,
    standardDeviationK: 0.0,
    contextTokens: 10000,
    contextWindowTokens: 100000,
    averageContextTokenIncrement: 1000,
  });

  // mean = (4+6)/2 = 5
  // lowerBound = 5
  // unbounded = 1 + floor(5 * 3 * 1.0) = 16
  // windowRequestUpperBound = floor((100000 - 10000) / 1000) = 90
  // expected = min(16, 90) = 16
  assert.equal(est.requestsPerBoundaryMean, 5);
  assert.equal(est.requestsPerBoundaryLowerBound, 5);
  assert.equal(est.unboundedExpectedRemainingRequests, 16);
  assert.equal(est.windowRequestUpperBound, 90);
  assert.equal(est.expectedRemainingRequests, 16);
});

test('estimateRemainingRequests: clamps to windowRequestUpperBound when window is tight', () => {
  const est = estimateRemainingRequests({
    completedBoundaryRequestCounts: [10],
    remainingBoundaries: 5,
    scale: 1.0,
    standardDeviationK: 0.0,
    contextTokens: 90000,
    contextWindowTokens: 100000,
    averageContextTokenIncrement: 2000,
  });

  // unbounded = 1 + floor(10 * 5) = 51
  // windowRequestUpperBound = floor((100000 - 90000) / 2000) = 5
  // expected = min(51, 5) = 5
  assert.equal(est.unboundedExpectedRemainingRequests, 51);
  assert.equal(est.windowRequestUpperBound, 5);
  assert.equal(est.expectedRemainingRequests, 5);
});

test('decideCompaction: verified mathematical breakeven formula (RFC §2.1)', () => {
  // writeTokens: 45000, archiveTokens: 22000, memoTokens: 1000, cacheWriteReadRatio: 12.5
  // savingTokens = 22000 - 1000 = 21000
  // incrementalCacheCostRatio = 12.5 - 1 = 11.5
  // breakevenRequests = (45000 * 11.5) / 21000 = 24.642857...
  const decision = decideCompaction({
    writeTokens: 45000,
    archiveTokens: 22000,
    memoTokens: 1000,
    contextTokens: 45000,
    completedBoundaryRequestCounts: [10, 10], // mean = 10, remaining = 3 -> unbounded = 31
    remainingBoundaries: 3,
    averageContextTokenIncrement: null,
    contextWindowTokens: 200000,
    priorCompactionCount: 0, // first compaction scale = 2.0 -> effective horizon = 31 * 2 = 62
    carriedDebtTokens: 0,
    cacheDebtRepaymentTokens: 0,
    cacheWriteReadRatio: 12.5,
  });

  assert.equal(decision.compact, true);
  assert.equal(decision.reason, 'economic');
  assert.ok(decision.breakevenRequests !== null);
  assert.ok(Math.abs(decision.breakevenRequests! - 24.642857) < 0.001);
  assert.equal(decision.incrementalCacheCostRatio, 11.5);
});

test('decideCompaction: non_positive_saving when archiveTokens <= memoTokens', () => {
  const decision = decideCompaction({
    writeTokens: 20000,
    archiveTokens: 1000,
    memoTokens: 1000,
    contextTokens: 20000,
    completedBoundaryRequestCounts: [5],
    remainingBoundaries: 5,
    averageContextTokenIncrement: null,
    contextWindowTokens: 100000,
    priorCompactionCount: 0,
    carriedDebtTokens: 0,
    cacheDebtRepaymentTokens: 0,
    cacheWriteReadRatio: 12.5,
  });

  assert.equal(decision.compact, false);
  assert.equal(decision.reason, 'non_positive_saving');
});

test('decideCompaction: window_protection triggers even if breakeven is not met', () => {
  const decision = decideCompaction({
    writeTokens: 90000,
    archiveTokens: 15000,
    memoTokens: 1000,
    contextTokens: 95000,
    completedBoundaryRequestCounts: [1],
    remainingBoundaries: 1, // small horizon = 2
    averageContextTokenIncrement: null,
    contextWindowTokens: 100000, // reserve = 16384 -> window cutoff is 83616 <= 95000
    priorCompactionCount: 1,
    carriedDebtTokens: 0,
    cacheDebtRepaymentTokens: 0,
    cacheWriteReadRatio: 12.5,
  });

  assert.equal(decision.compact, true);
  assert.equal(decision.reason, 'window_protection');
});

test('decideCompaction: deferred_carried_debt prevents debt accumulation on subsequent runs', () => {
  const decision = decideCompaction({
    writeTokens: 30000,
    archiveTokens: 20000,
    memoTokens: 1000,
    contextTokens: 30000,
    completedBoundaryRequestCounts: [10],
    remainingBoundaries: 2, // horizon = 21
    averageContextTokenIncrement: null,
    contextWindowTokens: 100000,
    priorCompactionCount: 1, // subsequent
    carriedDebtTokens: 500000, // heavy unpaid debt
    cacheDebtRepaymentTokens: 19000,
    cacheWriteReadRatio: 2.0, // incremental = 1.0, single breakeven = 30000 / 19000 = 1.57 (meets 21)
    // combinedBreakeven = (500000 + 30000) / 19000 = 27.89 > 21
  });

  assert.equal(decision.compact, false);
  assert.equal(decision.reason, 'deferred_carried_debt');
});

test('decideCompaction: deferred_subsequent_margin requires 1.5x margin', () => {
  const decision = decideCompaction({
    writeTokens: 30000,
    archiveTokens: 11000,
    memoTokens: 1000,
    contextTokens: 30000,
    completedBoundaryRequestCounts: [10],
    remainingBoundaries: 1, // horizon = 11
    averageContextTokenIncrement: null,
    contextWindowTokens: 100000,
    priorCompactionCount: 1,
    carriedDebtTokens: 0,
    cacheDebtRepaymentTokens: 0,
    cacheWriteReadRatio: 3.0, // incremental = 2.0, single breakeven = (30000*2)/10000 = 6.0
    // 6.0 <= 11, but 6.0 * 1.5 = 9.0 <= 11? Wait, let's make breakeven = 8.0 -> 8.0 * 1.5 = 12.0 > 11
    // (writeTokens * 2) / 10000 = 8.0 => writeTokens = 40000
  });

  const decisionMargin = decideCompaction({
    writeTokens: 40000,
    archiveTokens: 11000,
    memoTokens: 1000,
    contextTokens: 40000,
    completedBoundaryRequestCounts: [10],
    remainingBoundaries: 1, // horizon = 11
    averageContextTokenIncrement: null,
    contextWindowTokens: 100000,
    priorCompactionCount: 1,
    carriedDebtTokens: 0,
    cacheDebtRepaymentTokens: 0,
    cacheWriteReadRatio: 3.0, // incremental = 2.0 -> breakeven = (40000*2)/10000 = 8.0 <= 11
    // but 8.0 * 1.5 = 12.0 > 11!
  });

  assert.equal(decisionMargin.compact, false);
  assert.equal(decisionMargin.reason, 'deferred_subsequent_margin');
});

test('resolveCacheRatioFromCost: calculates ratio correctly or defaults to 12.5', () => {
  assert.equal(resolveCacheRatioFromCost(10), 10);
  assert.equal(resolveCacheRatioFromCost('auto', null), 12.5);
  assert.equal(resolveCacheRatioFromCost('auto', { cacheRead: 0.1, cacheWrite: 1.25 }), 12.5);
  assert.equal(resolveCacheRatioFromCost('auto', { cacheRead: 0.25, cacheWrite: 1.0 }), 4.0);
  // No cache capability at all
  assert.equal(resolveCacheRatioFromCost('auto', { cacheRead: 0, cacheWrite: 0 }), null);
  // Free cache writes with no read price → no cache capability
  assert.equal(resolveCacheRatioFromCost('auto', { cacheRead: 0.003, cacheWrite: 0 }), null);
  // Missing read price → cannot compute ratio
  assert.equal(resolveCacheRatioFromCost('auto', { cacheRead: 0, cacheWrite: 0.5 }), null);
});

test('nativeCompactionFeasible: returns false for empty or small session branch', () => {
  assert.equal(nativeCompactionFeasible([], 20000), false);

  const smallBranch: SessionEntry[] = [
    {
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      } as any,
    },
  ];
  assert.equal(nativeCompactionFeasible(smallBranch, 20000), false);
});

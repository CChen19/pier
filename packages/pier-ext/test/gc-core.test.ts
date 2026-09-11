/**
 * gc-core 决策纯函数单测（D29 判定矩阵；M22 取消 resident 豁免）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPathInside, planIsolateSweep, shouldClosePane, shouldCloseTaskTab, type GcEntryLike } from '../src/gc-core.ts';

const NOW = 1_000_000;
const TTL = 600_000; // 600s 默认

const work = (over: Partial<GcEntryLike> = {}): GcEntryLike => ({
  kind: 'task',
  status: 'consumed',
  consumedAt: NOW - TTL - 1000,
  ...over,
});

test('shouldCloseTaskTab: 全条件满足 → 关', () => {
  assert.equal(shouldCloseTaskTab({
    entries: [work()],
    paneStatuses: ['idle', 'unknown'], // 工作 pane 已关；非工作 pane 允许 unknown
    ttlMs: TTL,
    now: NOW,
  }), true);
});

test('shouldCloseTaskTab: 无工作 pane（主 tab）→ 永不关', () => {
  assert.equal(shouldCloseTaskTab({
    entries: [],
    paneStatuses: ['idle'],
    ttlMs: TTL,
    now: NOW,
  }), false);
});

test('shouldCloseTaskTab: 有 running 的工作 pane → 不关', () => {
  assert.equal(shouldCloseTaskTab({
    entries: [work({ status: 'running', consumedAt: null })],
    paneStatuses: ['working'],
    ttlMs: TTL,
    now: NOW,
  }), false);
});

test('shouldCloseTaskTab: 宽限期未过 → 不关', () => {
  assert.equal(shouldCloseTaskTab({
    entries: [work({ consumedAt: NOW - 1000 })],
    paneStatuses: ['idle'],
    ttlMs: TTL,
    now: NOW,
  }), false);
});

test('shouldCloseTaskTab: 旧 kind=resident 不当豁免（与 task 一样走 TTL）', () => {
  assert.equal(shouldCloseTaskTab({
    entries: [work({ kind: 'resident', status: 'settled', consumedAt: NOW - TTL - 1000 })],
    paneStatuses: ['idle'],
    ttlMs: TTL,
    now: NOW,
  }), true);
});

test('shouldCloseTaskTab: role=advisor 仍在 running → 不关', () => {
  assert.equal(shouldCloseTaskTab({
    entries: [work({ kind: 'advisor', status: 'running', consumedAt: null })],
    paneStatuses: ['working'],
    ttlMs: TTL,
    now: NOW,
  }), false);
});

test('shouldCloseTaskTab: blocked pane 豁免', () => {
  assert.equal(shouldCloseTaskTab({
    entries: [work()],
    paneStatuses: ['blocked'],
    ttlMs: TTL,
    now: NOW,
  }), false);
});

test('shouldCloseTaskTab: 有非 idle/done/unknown 的 pane → 不关', () => {
  assert.equal(shouldCloseTaskTab({
    entries: [work()],
    paneStatuses: ['working'],
    ttlMs: TTL,
    now: NOW,
  }), false);
});

test('shouldClosePane: 显式状态门 + 宽限 + 消失补记', () => {
  const base = { prevTurnStart: NOW };
  assert.equal(shouldClosePane({ ...base, consumedAt: NOW - 1000, herdrStatus: 'idle' }), true);
  assert.equal(shouldClosePane({ ...base, consumedAt: NOW - 1000, herdrStatus: 'done' }), true);
  assert.equal(shouldClosePane({ ...base, consumedAt: NOW - 1000, herdrStatus: 'working' }), false);
  assert.equal(shouldClosePane({ ...base, consumedAt: NOW - 1000, herdrStatus: 'blocked' }), false);
  assert.equal(shouldClosePane({ ...base, consumedAt: NOW - 1000, herdrStatus: 'unknown' }), false);
  // 本轮消费的不收（宽限：结算通知那一轮人可看）
  assert.equal(shouldClosePane({ ...base, consumedAt: NOW + 500, herdrStatus: 'idle' }), false);
  assert.equal(shouldClosePane({ ...base, consumedAt: null, herdrStatus: 'idle' }), false);
  // pane 消失 → 补记 closed
  assert.equal(shouldClosePane({ ...base, consumedAt: null, herdrStatus: undefined }), true);
});

/* ── isolate worktree collection (regression: the sweep deleted its own worktree) ── */

test('planIsolateSweep: untracked pier/* branches are not candidates without opt-in', () => {
  const plan = planIsolateSweep({
    branches: ['pier/other-session', 'pier/mine'],
    worktreesByBranch: new Map([['pier/other-session', '/wt/other'], ['pier/mine', '/wt/mine']]),
    registeredBranches: new Set(['pier/mine']),
    pendingBranches: new Set(),
    sessionOwned: [],
    cwd: '/repo',
    sweepOrphans: false,
  });
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.skipped, []);
});

test('planIsolateSweep: opt-in sweeps untracked branches but never the current worktree', () => {
  const plan = planIsolateSweep({
    branches: ['pier/self', 'pier/other', 'pier/pending', 'pier/branchless'],
    worktreesByBranch: new Map([
      ['pier/self', '/wt/self'],
      ['pier/other', '/wt/other'],
      ['pier/pending', '/wt/pending'],
    ]),
    registeredBranches: new Set(),
    pendingBranches: new Set(['pier/pending']),
    sessionOwned: [],
    cwd: '/wt/self',
    sweepOrphans: true,
  });
  assert.deepEqual(plan.candidates.map((c) => c.branch), ['pier/other']);
  assert.deepEqual(plan.skipped, [
    { branch: 'pier/self', reason: 'self' },
    { branch: 'pier/pending', reason: 'pending' },
  ]);
});

test('planIsolateSweep: session-owned isolates stay candidates and prefer the live worktree path', () => {
  const plan = planIsolateSweep({
    branches: [],
    worktreesByBranch: new Map([['pier/mine', '/wt/moved']]),
    registeredBranches: new Set(['pier/mine']),
    pendingBranches: new Set(),
    sessionOwned: [{ branch: 'pier/mine', worktreePath: '/wt/recorded' }],
    cwd: '/repo',
    sweepOrphans: false,
  });
  assert.deepEqual(plan.candidates, [{ branch: 'pier/mine', worktreePath: '/wt/moved' }]);
});

test('planIsolateSweep: a session-owned worktree under the cwd is still protected', () => {
  const plan = planIsolateSweep({
    branches: [],
    worktreesByBranch: new Map(),
    registeredBranches: new Set(),
    pendingBranches: new Set(),
    sessionOwned: [{ branch: 'pier/nested', worktreePath: '/wt/pier/nested' }],
    cwd: '/wt/pier/nested',
    sweepOrphans: false,
  });
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.skipped, [{ branch: 'pier/nested', reason: 'self' }]);
});

test('isPathInside: equal paths and real children match, siblings and prefixes do not', () => {
  assert.equal(isPathInside('/wt/a', '/wt/a'), true);
  assert.equal(isPathInside('/wt/a/sub', '/wt/a'), true);
  assert.equal(isPathInside('/wt/a/sub', '/wt/a/'), true);
  assert.equal(isPathInside('/wt/ab', '/wt/a'), false);
  assert.equal(isPathInside('/wt/a', '/wt/a/sub'), false);
  // Windows separators normalize to the same test.
  assert.equal(isPathInside('C:\\wt\\a\\sub', 'C:\\wt\\a'), true);
});

/**
 * A14：spawn 就绪等待的纯规划（退避 / 提前失败 / 失败话术）。
 * 实证背景：并发 3–4 个隔离 worker 时 3/5 次失败，错误只有一句 "pipe not ready within 30000ms"，
 * 而子进程其实已经崩溃（A13 的 stack trace 就在它的 pane 上）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  READY_BASE_INTERVAL_MS,
  READY_MAX_INTERVAL_MS,
  READY_TAIL_CHARS,
  planReadyAttempt,
  readyBackoffMs,
  readyFailureText,
} from '../src/subagent-ready.ts';

test('readyBackoffMs: 指数退避并封顶（500ms → 1s → 2s → 4s → 4s）', () => {
  assert.equal(readyBackoffMs(0), READY_BASE_INTERVAL_MS);
  assert.equal(readyBackoffMs(1), 1000);
  assert.equal(readyBackoffMs(2), 2000);
  assert.equal(readyBackoffMs(3), 4000);
  assert.equal(readyBackoffMs(4), READY_MAX_INTERVAL_MS);
  assert.equal(readyBackoffMs(99), READY_MAX_INTERVAL_MS);
  // 负值/小数不应产生奇怪的间隔
  assert.equal(readyBackoffMs(-3), READY_BASE_INTERVAL_MS);
  assert.equal(readyBackoffMs(1.7), 1000);
});

test('planReadyAttempt: 就绪优先；pane 消失立刻失败；超时按上限收敛', () => {
  assert.deepEqual(planReadyAttempt({ elapsedMs: 10, attempt: 0, timeoutMs: 90_000, alive: true, ready: true }), { kind: 'ready' });
  // pane 没了 → 不再等（等待一个永远不会出现的 pipe 没有意义）
  assert.deepEqual(planReadyAttempt({ elapsedMs: 10, attempt: 0, timeoutMs: 90_000, alive: false, ready: false }), { kind: 'give-up', reason: 'pane-gone' });
  // 探活不可用（null）不得当作死亡：继续退避重试
  assert.deepEqual(planReadyAttempt({ elapsedMs: 10, attempt: 0, timeoutMs: 90_000, alive: null, ready: false }), { kind: 'retry', delayMs: 500 });
  assert.deepEqual(planReadyAttempt({ elapsedMs: 89_999, attempt: 7, timeoutMs: 90_000, alive: true, ready: false }), { kind: 'retry', delayMs: 4000 });
  assert.deepEqual(planReadyAttempt({ elapsedMs: 90_000, attempt: 8, timeoutMs: 90_000, alive: true, ready: false }), { kind: 'give-up', reason: 'timeout' });
  // pane 消失优先于超时：即使已过时限也报 pane-gone（原因更准确）
  assert.deepEqual(planReadyAttempt({ elapsedMs: 120_000, attempt: 9, timeoutMs: 90_000, alive: false, ready: false }), { kind: 'give-up', reason: 'pane-gone' });
});

test('readyFailureText: 三种形态说清原因（崩溃附 pane 尾部、working 说明可重试）', () => {
  const crashed = readyFailureText({
    paneId: 'wX:p9',
    reason: 'pane-gone',
    elapsedMs: 4_200,
    timeoutMs: 90_000,
    tail: 'TypeError: Cannot read properties of undefined (reading \'total\')',
  });
  assert.match(crashed, /wX:p9 exited before its pipe became ready/);
  assert.match(crashed, /last output of wX:p9/);
  assert.match(crashed, /Cannot read properties of undefined/);

  const slow = readyFailureText({
    paneId: 'wX:p9', reason: 'timeout', elapsedMs: 90_000, timeoutMs: 90_000, lastStatus: 'working',
    hint: 'Tip: pass run_in_background to avoid blocking the master turn while the worker boots.',
  });
  assert.match(slow, /pipe not ready within 90s/);
  assert.match(slow, /alive and working/);
  assert.match(slow, /retrying the same call is safe/);
  assert.match(slow, /run_in_background/);

  const stuck = readyFailureText({ paneId: 'wX:p9', reason: 'timeout', elapsedMs: 90_000, timeoutMs: 90_000, lastStatus: 'idle' });
  assert.match(stuck, /never registered its pipe/);
  assert.match(stuck, /failed to load the pier extension/);
  assert.doesNotMatch(stuck, /last output/);
});

test('READY_TAIL_CHARS: 够放下崩溃栈开头但不会把整屏塞进错误里', () => {
  assert.ok(READY_TAIL_CHARS >= 500 && READY_TAIL_CHARS <= 4000);
});

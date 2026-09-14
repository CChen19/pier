/**
 * B9：静默吞异常的可观测化。行为不变（清照做），但留下可查痕迹。
 * 历史教训：pane GC 的 ReferenceError 与 /todos 人工编辑持久化都曾静默失效数周。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SWALLOW_BUFFER_MAX,
  formatSwallowedErrors,
  resetSwallowedErrors,
  swallow,
  swallowedErrors,
} from '../src/swallow.ts';

test('swallow: 记录 tag/原因/时间，且不抛出（清理路径必须继续）', () => {
  resetSwallowedErrors();
  let continued = false;
  try {
    throw new ReferenceError('persistEdit is not defined');
  } catch (err) {
    swallow('todo.persist-edit', err, {});
    continued = true;
  }
  assert.equal(continued, true);
  const entries = swallowedErrors();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.tag, 'todo.persist-edit');
  assert.match(entries[0]!.message, /ReferenceError: persistEdit is not defined/);
  assert.ok(entries[0]!.at > 0);
});

test('swallow: 环形缓冲有界（不随会话无限增长）', () => {
  resetSwallowedErrors();
  for (let i = 0; i < SWALLOW_BUFFER_MAX + 25; i += 1) swallow('t', new Error(`e${i}`), {});
  const entries = swallowedErrors();
  assert.equal(entries.length, SWALLOW_BUFFER_MAX);
  // 保留最新的一批
  assert.match(entries[entries.length - 1]!.message, /e74$/); // 最新一条是第 75 个（索引 74）
});

test('swallow: PIER_TRACE / 旧 PI_HERDR_TRACE 打开时写到 stderr', () => {
  resetSwallowedErrors();
  const seen: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); };
  try {
    swallow('x.y', new Error('loud'), { PIER_TRACE: '1' });
    swallow('x.z', new Error('quiet'), {});
    swallow('x.w', new Error('legacy'), { PI_HERDR_TRACE: '1' });
  } finally {
    console.error = orig;
  }
  assert.equal(seen.length, 2);
  assert.match(seen[0]!, /swallowed x\.y: Error: loud/);
  assert.match(seen[1]!, /swallowed x\.w: Error: legacy/);
});

test('formatSwallowedErrors: 空态明确、非空时给最近 10 条', () => {
  resetSwallowedErrors();
  assert.match(formatSwallowedErrors(), /none this session/);
  for (let i = 0; i < 12; i += 1) swallow(`tag${i}`, new Error(`m${i}`), {});
  const text = formatSwallowedErrors();
  assert.match(text, /swallowed errors: 12 this session \(last 10\)/);
  assert.match(text, /tag11: Error: m11/);
  assert.doesNotMatch(text, /tag1: Error: m1$/m, '最旧的被截断');
});

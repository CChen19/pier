/**
 * subSessionState must tolerate herdr-reported session paths that do not
 * exist yet (session 01a055c5: spawn-failed on `null.length`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HerdrClientLike } from '../src/herdr-client.ts';
import { createSessionIo } from '../src/subagent-session-io.ts';

function io(reported: string | null, sessionsDir: string, ownSession = '') {
  return createSessionIo({
    client: {
      getAgentSessionPath: async () => reported,
    } as unknown as HerdrClientLike,
    getSessionId: () => ownSession,
    sessionsDir: () => sessionsDir,
  });
}

test('subSessionState: missing reported jsonl is skipped (01a055c5 null.length)', async () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pier-session-io-'));
  const ghost = join(sessionsDir, 'not-created-yet.jsonl');
  const state = await io(ghost, sessionsDir).subSessionState('wC:p4', sessionsDir, Date.now());
  assert.deepEqual(state, { text: null, pendingTool: false, activity: false, turnEnded: false });
});

test('subSessionState: readable session after injectTs still settles', async () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pier-session-io-'));
  const file = join(sessionsDir, 'child.jsonl');
  const ts = 1_800_000_000_000;
  writeFileSync(file, JSON.stringify({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      timestamp: ts + 10,
      stopReason: 'stop',
    },
  }) + '\n');
  const state = await io(file, sessionsDir).subSessionState('wC:p4', sessionsDir, ts);
  assert.deepEqual(state, { text: 'ok', pendingTool: false, activity: true, turnEnded: true });
});

test('subSessionState (A16): toolResult 已写、下一条 assistant 未到时，回合未结束', async () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pier-session-io-'));
  const file = join(sessionsDir, 'child-midflight.jsonl');
  const ts = 1_800_000_000_000;
  const lines = [
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'task' }], timestamp: ts } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall' }], timestamp: ts + 10, stopReason: 'toolUse' } },
    { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }], timestamp: ts + 20 } },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const state = await io(file, sessionsDir).subSessionState('wC:p4', sessionsDir, ts);
  // activity=true 但 turnEnded=false —— 旧规则会在这里误判完工。
  assert.deepEqual(state, { text: null, pendingTool: false, activity: true, turnEnded: false });
});

test('subSessionState: 会话追加后必须重新推导（派生结果按 size/mtime 失效）', async () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pier-session-io-'));
  const file = join(sessionsDir, 'child-growing.jsonl');
  const ts = 1_800_000_000_000;
  writeFileSync(file, JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall' }], timestamp: ts + 10, stopReason: 'toolUse' },
  }) + '\n');
  const session = io(file, sessionsDir);

  const mid = await session.subSessionState('wC:p4', sessionsDir, ts);
  assert.deepEqual(mid, { text: null, pendingTool: true, activity: true, turnEnded: false });

  // 追加收尾消息后，同一 sinceTs 必须看到新状态（缓存若失效会导致永久挂着 pendingTool）。
  writeFileSync(file, JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text: 'finished' }], timestamp: ts + 20, stopReason: 'stop' },
  }) + '\n', { flag: 'a' });
  const settled = await session.subSessionState('wC:p4', sessionsDir, ts);
  assert.deepEqual(settled, { text: 'finished', pendingTool: false, activity: true, turnEnded: true });
});

test('collectFinalText: 首次未读到收尾文本，追加后重试必须读到（缓存 null 也不能永久命中）', async () => {
  const sessionsDir = mkdtempSync(join(tmpdir(), 'pier-session-io-'));
  const file = join(sessionsDir, 'child-late-text.jsonl');
  const ts = 1_800_000_000_000;
  writeFileSync(file, JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'toolCall' }], timestamp: ts + 10, stopReason: 'toolUse' },
  }) + '\n');
  const session = io(file, sessionsDir);

  assert.equal(await session.collectFinalText('wC:p4', sessionsDir, ts, 1), null);

  writeFileSync(file, JSON.stringify({
    type: 'message',
    message: { role: 'assistant', content: [{ type: 'text', text: 'late result' }], timestamp: ts + 30, stopReason: 'stop' },
  }) + '\n', { flag: 'a' });
  assert.equal(await session.collectFinalText('wC:p4', sessionsDir, ts, 1), 'late result');
});

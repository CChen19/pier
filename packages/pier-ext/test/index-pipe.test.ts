/**
 * Common-segment pipe dispatch over the subagent port.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePipeRequest, type MachineRequest } from '../src/index-pipe.ts';
import { emptySubagentPortBox, type SubagentPort } from '../src/subagent-port.ts';

function fakePort(over: Partial<SubagentPort> = {}): SubagentPort {
  return {
    applyReplySession() {},
    reconcileOnReply() { return []; },
    listRunningSubs() { return []; },
    async settleStatLine() { return null; },
    ...over,
  };
}

test('handlePipeRequest: ping / prompt / steer follow_up / interrupt', async () => {
  const inMsgs: string[] = [];
  const asMsgs: Array<{ text: string; mode: string }> = [];
  let aborted = 0;
  const state: { pending: MachineRequest | null } = { pending: null };
  const session = {
    paneId: 'p0',
    port: emptySubagentPortBox(),
    claimSettleNotice: () => true,
    deliverNotice: async () => {},
    sendUserMessageIn: async (content: string) => { inMsgs.push(content); },
    sendUserMessageAs: async (content: string, mode: 'steer' | 'followUp') => { asMsgs.push({ text: content, mode }); },
    abort: () => { aborted++; },
    setPendingMachineRequest: (req: MachineRequest | null) => { state.pending = req; },
  };

  assert.deepEqual(await handlePipeRequest({ type: 'ping', id: '1' }, session), {
    type: 'ok', id: '1', detail: 'p0',
  });

  await handlePipeRequest({ type: 'prompt', id: '2', text: 'go', from: 'src', push: true }, session);
  assert.ok(state.pending !== null && state.pending.id === '2');
  assert.deepEqual(inMsgs, ['go']);

  await handlePipeRequest({ type: 'follow_up', id: '3', text: 'more', steer: true }, session);
  assert.deepEqual(asMsgs, [{ text: 'more', mode: 'steer' }]);

  await handlePipeRequest({ type: 'interrupt', id: '4' }, session);
  assert.equal(aborted, 1);
  assert.equal(state.pending, null);
});

test('handlePipeRequest: reply binds port, claims once, delivers notice', async () => {
  const applied: Array<[string, string | null]> = [];
  const notices: string[] = [];
  const claimed: string[] = [];
  const port = emptySubagentPortBox();
  port.current = fakePort({
    applyReplySession(paneId, sessionFile) { applied.push([paneId, sessionFile]); },
    reconcileOnReply() { return ['Reconciled: x']; },
    async settleStatLine() { return 'stat: clean'; },
  });
  const latch = new Set<string>();
  const session = {
    paneId: 'p0',
    port,
    claimSettleNotice: (key: string) => {
      claimed.push(key);
      if (latch.has(key)) return false;
      latch.add(key);
      return true;
    },
    deliverNotice: async (content: string) => { notices.push(content); },
    sendUserMessageIn: async () => {},
    sendUserMessageAs: async () => {},
    abort: () => {},
    setPendingMachineRequest: () => {},
  };

  const req = {
    type: 'reply' as const,
    id: 'r1',
    paneId: 'p2',
    text: 'done',
    sessionFile: '/tmp/s.jsonl',
  };
  assert.equal((await handlePipeRequest(req, session)).type, 'ok');
  assert.deepEqual(applied, [['p2', '/tmp/s.jsonl']]);
  assert.match(notices[0], /p2/);
  assert.match(notices[0], /done/);
  assert.match(notices[0], /Session: \/tmp\/s.jsonl/);
  assert.match(notices[0], /stat: clean/);
  assert.match(notices[0], /Reconciled: x/);

  await handlePipeRequest(req, session);
  assert.equal(notices.length, 1, 'duplicate claim must not re-deliver');
  assert.deepEqual(claimed, ['p2:r1', 'p2:r1']);
});

test('handlePipeRequest reply (B8): claim key 与 poll-loop 同源（子进程回包回显请求 id）', async () => {
  // 契约：父进程发 `prompt-<taskId>` → 子进程 pendingMachineRequest.id 就是它 → 结算时
  // index.ts 用 `id: req.id` 推 reply → 两条路径的 `${paneId}:${id}` 必然相等。
  // 唯一例外是 restore 时的 `probe-<paneId>` 兜底 id，它不会收到 push 回包（父进程内存态已丢），
  // 因此不会与 reply 路径撞车。任何一侧改了 id 生成/回显方式，这个测试会先报警。
  const claims: string[] = [];
  const state: { pending: MachineRequest | null } = { pending: null };
  const port = emptySubagentPortBox();
  port.current = fakePort();
  const session = {
    paneId: 'p0',
    port,
    claimSettleNotice: (key: string) => { claims.push(key); return true; },
    deliverNotice: async () => {},
    sendUserMessageIn: async () => {},
    sendUserMessageAs: async () => {},
    abort: () => {},
    setPendingMachineRequest: (req: MachineRequest | null) => { state.pending = req; },
  };

  // 父进程（poll-loop 侧）发送的 id：`prompt-<taskId>`（core/subagent.ts:976）
  const sentId = 'prompt-3f1a-任务';
  await handlePipeRequest({ type: 'prompt', id: sentId, text: 'go', from: 'src', push: true }, session);
  assert.equal(state.pending?.id, sentId, '父进程发出的 id 正是 pending 里的 id');
  const requestIdForPoller = sentId; // core/subagent.ts 把同一个值传给 startPoller

  // 子进程结算时按 index.ts 的形状回推（id 回显）
  await handlePipeRequest(
    { type: 'reply', id: state.pending!.id, paneId: 'p2', text: 'done', sessionFile: null },
    session,
  );

  assert.deepEqual(claims, [`p2:${sentId}`]);
  // poll-loop 侧的 key 形状：`${paneId}:${requestId}`（subagent-poll-loop.ts:217）
  assert.equal(`${'p2'}:${requestIdForPoller}`, claims[0]);
});

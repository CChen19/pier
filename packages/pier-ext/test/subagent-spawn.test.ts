/**
 * subagent spawn 行为回归（session 01a03bf0 实证双缺陷）：
 *  1. ecc0bc4 误删 prompt 注入块 → `injectTs is not defined`（spawn-failed）+
 *     台账幽灵 running 条目 + 子 pane 无任务上下文；
 *  2. spawn 中途失败不回收台账/pane → D96 提醒风暴 + send_message 打到空会话。
 * 缝：subagent 工具 execute（真 pipe 服务器 + 全假件 client/env）。
 * 时序关键：子会话定稿文本由 pipe sim 在收到 prompt 后写入（timestamp ≥ injectTs，
 * 过 lastAssistantText 的 sinceTs 过滤）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import subagentPlugin from '../src/core/subagent.ts';
import { PiSurface } from '../src/pi-surface.ts';
import { pipeNameFor, pipePathFor, type PipeRequest } from '../src/pipe-channel.ts';
import type { HerdrClientLike } from '../src/herdr-client.ts';
import { emptySubagentPortBox, type SubagentPortBox } from '../src/subagent-port.ts';

const SUB_TEXT = 'REPORT: all channel-fee contact points mapped';
const PROMPT = '你在 apnv3-backend 仓库探查渠道费用触点（只读）。输出完整报告。';

interface FakePi {
  tools: Map<string, { execute?: (...a: unknown[]) => unknown }>;
  listeners: Map<string, Array<(...a: unknown[]) => unknown>>;
  entries: Array<[string, unknown]>;
  registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }): void;
  on(event: string, handler: (...a: unknown[]) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
}



interface Harness {
  closePaneCalls: string[];
  waitAgentCalls: Array<{ paneId: string; states: string[] }>;
  prompts: PipeRequest[];
  /** pipe sim 收到 prompt 时回调（写子会话定稿文本，模拟子代理即时产出）。 */
  onPrompt?: () => void;
}

function fakePi(): FakePi {
  return {
    tools: new Map<string, { execute?: (...a: unknown[]) => unknown }>(),
    listeners: new Map<string, Array<(...a: unknown[]) => unknown>>(),
    entries: [] as Array<[string, unknown]>,
    registerTool(def: { name: string; execute?: (...a: unknown[]) => unknown }) {
      this.tools.set(def.name, def);
    },
    on(event: string, handler: (...a: unknown[]) => unknown) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
    },
    appendEntry(customType: string, data: unknown) {
      this.entries.push([customType, data]);
    },
  };
}

/** 可配置假 client：p0=master（t0）；splitPane → p2。 */
function fakeClient(sessionFile: string, h: Harness): HerdrClientLike {
  return {
    available: true,
    tabList: async () => [{ tabName: 'main', tabId: 't0', workspaceId: 'w1', label: 'main' }],
    listPanes: async () => [
      { paneId: 'p0', tabId: 't0', agentStatus: 'working' },
      { paneId: 'p2', tabId: 't0', agentStatus: 'idle' },
    ],
    listAgents: async () => [],
    waitAgent: async (paneId: string, states: string[]) => {
      h.waitAgentCalls.push({ paneId, states });
      return 'idle';
    },
    getAgentSessionPath: async () => sessionFile,
    createTab: async () => ({ tabId: 't9', paneId: 'p9' }),
    splitPane: async () => 'p2',
    sendPaneText: async () => undefined,
    exportLayout: async () => {
      throw new Error('layout export unavailable in test');
    },
    tabClose: async () => undefined,
    closePane: async (paneId: string) => {
      h.closePaneCalls.push(paneId);
    },
  } as unknown as HerdrClientLike;
}

/** 真 pipe 服务器（一连接一请求；prompt 可配置 ok/reject，可选 onPrompt 回调）。 */
async function startPipeSim(cwd: string, h: Harness, opts: { rejectPrompt?: boolean }): Promise<net.Server> {
  const sockPath = pipePathFor(pipeNameFor(cwd, 'p2'));
  try {
    if (existsSync(sockPath)) unlinkSync(sockPath);
  } catch { /* 残留清理尽力而为 */ }
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const req = JSON.parse(buf.slice(0, i)) as PipeRequest;
      buf = '';
      const isPrompt = req.type === 'prompt' || req.type === 'follow_up';
      if (isPrompt) {
        h.prompts.push(req);
        h.onPrompt?.();
      }
      const reject = isPrompt && opts.rejectPrompt;
      const res = reject
        ? { type: 'error' as const, id: req.id, message: 'sim rejected' }
        : { type: 'ok' as const, id: req.id };
      sock.write(JSON.stringify(res) + '\n');
    });
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(sockPath, () => resolve());
  await promise;
  return server;
}

async function mountSpawn(pi: FakePi, sessionFile: string, h: Harness): Promise<{ root: Context; port: SubagentPortBox }> {
  const surface = new PiSurface(pi as unknown as object);
  const port = emptySubagentPortBox();
  const root = new Context();
  const deps = {
    client: fakeClient(sessionFile, h),
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    extPath: new URL('../src/index.ts', import.meta.url).pathname,
    sessionRoot: root,
    port,
    getSessionId: () => '',
    reconcileOnSettlement: () => [],
    withReconcileNotes: (b: string) => b,
    claimSettleNotice: () => true,
    terminalState: { activePaneIds: () => new Set<string>() },
  };
  root.provide('pi-herdr.surface', surface);
  root.provide('pi-herdr.subagent-deps', deps);
  await root.plugin(subagentPlugin);
  return { root, port };
}

interface SpawnCtx {
  pi: FakePi;
  port: SubagentPortBox;
  h: Harness;
  cwd: string;
}

async function withSpawnEnv(fn: (ctx: SpawnCtx) => Promise<void>, opts: { rejectPrompt?: boolean } = {}): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'pier-spawn-home-'));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = home; // 台账/会话扫描根重定向（不污染 ~/.pi）
  const cwd = mkdtempSync(join(tmpdir(), 'pier-spawn-cwd-'));
  const sessionFile = join(cwd, 'sub-session.jsonl');
  const h: Harness = {
    closePaneCalls: [],
    waitAgentCalls: [],
    prompts: [],
    // 子代理产出模拟：prompt 注入后写定稿文本（ts ≥ injectTs）
    onPrompt: opts.rejectPrompt ? undefined : () => writeFileSync(sessionFile, JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: SUB_TEXT }],
        timestamp: Date.now(),
        stopReason: 'stop',
      },
    }) + '\n'),
  };
  const server = await startPipeSim(cwd, h, opts);
  const pi = fakePi();
  const mounted = await mountSpawn(pi, sessionFile, h);
  try {
    await fn({ pi, port: mounted.port, h, cwd });
  } finally {
    await mounted.root.fiber.dispose();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
}

test('spawn 回归（01a03bf0 缺陷 1）：prompt 必须注入 + 无 ReferenceError + 正常结算', async () => {
  await withSpawnEnv(async ({ pi, port, h, cwd }) => {
    const tool = pi.tools.get('subagent');
    assert.ok(tool?.execute, 'subagent 工具已注册');
    const r = await tool.execute!('tc1', { description: '探查', prompt: PROMPT }, undefined, undefined, { cwd }) as {
      content: Array<{ text: string }>;
    };
    const text = r.content[0].text;
    assert.ok(!/injectTs is not defined/.test(text), `不出现 ReferenceError：${text}`);
    assert.ok(!/failed to spawn/.test(text), `不出现 spawn-failed：${text}`);
    assert.match(text, /REPORT: all channel-fee contact points mapped/);
    assert.equal(h.prompts.length, 1, 'prompt 恰好注入一次');
    assert.equal((h.prompts[0] as { text?: string }).text, PROMPT, 'prompt 全文注入');
    assert.equal((h.prompts[0] as { push?: boolean }).push, false, '前台 push=false');
    assert.deepEqual(port.current?.listRunningSubs() ?? [], [], '无幽灵 running 条目');
  });
});

test('spawn 回归（01a03bf0 缺陷 2）：pipe 拒绝 → 台账回收 + 关 pane + spawn-failed 文案', async () => {
  await withSpawnEnv(async ({ pi, port, h, cwd }) => {
    const tool = pi.tools.get('subagent');
    assert.ok(tool?.execute);
    const r = await tool.execute!('tc2', { description: '探查', prompt: PROMPT }, undefined, undefined, { cwd }) as {
      content: Array<{ text: string }>;
    };
    const text = r.content[0].text;
    assert.match(text, /failed to spawn/);
    assert.match(text, /sim rejected/);
    assert.deepEqual(h.closePaneCalls, ['p2'], '失败 pane 必须关闭');
    assert.deepEqual(port.current?.listRunningSubs() ?? [], [], '台账无幽灵条目');
    const subsEntries = pi.entries.filter(([t]) => t === 'pi-herdr.subs');
    assert.ok(subsEntries.length > 0, '台账有写入');
    const last = subsEntries[subsEntries.length - 1][1] as { subs?: Array<{ paneId: string; status: string }> };
    assert.ok(!last.subs?.some((s) => s.paneId === 'p2'), '最后的台账快照已回收 p2');
  }, { rejectPrompt: true });
});

test('spawn 回归（A7）：run_in_background=true 立即返回，不进入前台 waitAgent 循环', async () => {
  await withSpawnEnv(async ({ pi, port, h, cwd }) => {
    const tool = pi.tools.get('subagent');
    assert.ok(tool?.execute);
    const r = await tool.execute!(
      'tc3',
      { description: '后台探查', prompt: PROMPT, run_in_background: true },
      undefined,
      undefined,
      { cwd },
    ) as {
      content: Array<{ text: string }>;
      details?: { paneId?: string; taskId?: string; background?: boolean; role?: string };
    };
    const text = r.content[0].text;
    assert.match(text, /^started subagent p2 \(task [0-9a-f-]+\)$/);
    assert.equal(r.details?.background, true, 'details.background 应为 true');
    assert.equal(r.details?.paneId, 'p2');
    assert.ok(typeof r.details?.taskId === 'string' && r.details.taskId.length > 0, 'taskId 存在');
    assert.equal(h.waitAgentCalls.length, 0, '后台模式绝不调用 waitAgent 进入前台等待循环');
    assert.equal(h.prompts.length, 1, 'prompt 注入一次');
    assert.equal((h.prompts[0] as { push?: boolean }).push, true, '后台模式 push=true');

    // 检查 running 台账条目正常存在且在 listRunningSubs（background && running）中
    const running = port.current?.listRunningSubs() ?? [];
    assert.equal(running.length, 1, '后台子代理在台账中保持 running 状态');
    assert.equal(running[0].paneId, 'p2');
    assert.equal(running[0].description, '后台探查');
  });
});

test('subagent action send & resume（B1）：短 taskId 唯一前缀 (>=4)、歧义与未找到解析', async () => {
  await withSpawnEnv(async ({ pi, h, cwd }) => {
    const tool = pi.tools.get('subagent');
    assert.ok(tool?.execute);

    // 启动后台子任务，获得自动生成的完整 UUID taskId
    const spawned = await tool.execute!(
      'tc_spawn',
      { description: '后台任务', prompt: PROMPT, run_in_background: true },
      undefined,
      undefined,
      { cwd },
    ) as {
      content: Array<{ text: string }>;
      details?: { paneId?: string; taskId?: string };
    };
    const fullTaskId = spawned.details?.taskId;
    assert.ok(typeof fullTaskId === 'string' && fullTaskId.length >= 8);
    const short8 = fullTaskId.slice(0, 8);
    const short4 = fullTaskId.slice(0, 4);
    const short3 = fullTaskId.slice(0, 3);

    // 1. send 使用 8 位短前缀 → 成功投递
    const sendRes8 = await tool.execute!(
      'tc_send8',
      { action: 'send', agentId: short8, message: '8-char prefix message' },
      undefined,
      undefined,
      { cwd },
    ) as { content: Array<{ text: string }> };
    assert.match(sendRes8.content[0].text, /Message sent to subagent p2/);
    assert.equal(h.prompts.length, 2);
    assert.equal((h.prompts[1] as { text?: string }).text, '8-char prefix message');

    // 2. send 使用 4 位短前缀 → 成功投递
    const sendRes4 = await tool.execute!(
      'tc_send4',
      { action: 'send', agentId: short4, message: '4-char prefix message' },
      undefined,
      undefined,
      { cwd },
    ) as { content: Array<{ text: string }> };
    assert.match(sendRes4.content[0].text, /Message sent to subagent p2/);
    assert.equal(h.prompts.length, 3);

    // 3. send 使用 <4 字符短前缀且非精确匹配 → 拒绝并提示至少 4 字符（A1：硬失败 = reject）
    await assert.rejects(
      async () => {
        await tool.execute!('tc_send_short', { action: 'send', agentId: short3, message: 'too short' }, undefined, undefined, { cwd });
      },
      /is too short \(minimum 4 characters\)/,
    );

    // 4. send 使用不存在的 id → 报错 unknown subagent id
    await assert.rejects(
      async () => {
        await tool.execute!('tc_send_notfound', { action: 'send', agentId: '00000000', message: 'not found' }, undefined, undefined, { cwd });
      },
      /unknown subagent id "00000000"/,
    );

    // 5. resume 使用 8 位短前缀 → 成功解析历史并恢复 (paneId 匹配 existing 则 reuse)
    const resume8 = await tool.execute!(
      'tc_resume8',
      { action: 'resume', taskId: short8 },
      undefined,
      undefined,
      { cwd },
    ) as { content: Array<{ text: string }>; details?: { taskId?: string } };
    assert.match(resume8.content[0].text, /resumed subagent/);
    assert.equal(resume8.details?.taskId, fullTaskId, '返回详情恢复为完整 taskId');

    // 6. resume 使用 <4 字符前缀 → 提示 too short（A1：硬失败 = reject）
    await assert.rejects(
      async () => {
        await tool.execute!('tc_resume_short', { action: 'resume', taskId: short3 }, undefined, undefined, { cwd });
      },
      /is too short \(minimum 4 characters\)/,
    );

    // 7. resume 使用不存在的前缀 → 提示 no history
    await assert.rejects(
      async () => {
        await tool.execute!('tc_resume_notfound', { action: 'resume', taskId: 'ffffffff' }, undefined, undefined, { cwd });
      },
      /no history for task "ffffffff"/,
    );

    // 8. resume 歧义前缀：追加一条同前缀历史条目后，使用 4 位前缀触发歧义
    const { preferredHistoryFile } = await import('../src/storage-layout.ts');
    const { appendHistory } = await import('../src/history-store.ts');
    const agentRoot = process.env.PI_CODING_AGENT_DIR!;
    const histFile = preferredHistoryFile(agentRoot, cwd);
    const ambiguousTaskId = `${short4}9999-0000-1111-2222-333344445555`;
    appendHistory(histFile, {
      taskId: ambiguousTaskId,
      kind: 'task',
      paneId: 'p3',
      tabId: 't0',
      workspaceId: 'w1',
      cwd,
      description: '歧义冲突任务',
      sessionFile: null,
      launchCommand: ['node', 'cli.js'],
      status: 'settled',
      createdAt: Date.now() + 10,
    });

    const ambiguousText = await (async () => {
      try {
        await tool.execute!('tc_resume_amb', { action: 'resume', taskId: short4 }, undefined, undefined, { cwd });
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('expected an ambiguous prefix to throw');
    })();
    assert.match(ambiguousText, /ambiguous task id/);
    assert.match(ambiguousText, new RegExp(fullTaskId));
    assert.match(ambiguousText, new RegExp(ambiguousTaskId));
  });
});



test('waitSubReady (A14): 子 pane 已消失 → 立刻失败并附上它的最后输出（不再空等 90s）', async () => {
  const { createSpawner } = await import('../src/subagent-spawn.ts');
  const spawner = createSpawner({
    client: {
      listAgents: async () => [], // pane 不在 → 视为子进程已退出
      readPane: async () => ({ text: 'TypeError: boom at footer.render', revision: 1, truncated: false }),
    } as unknown as Parameters<typeof createSpawner>[0]['client'],
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    runtime: { nodePath: '/usr/bin/node', cliPath: '/cli.js', extPath: '/ext.ts' },
    git: { listWorktrees: async () => [] },
  } as unknown as Parameters<typeof createSpawner>[0]);

  const started = Date.now();
  const out = await spawner.waitSubReady('/tmp/pier-a14-nonexistent', 'wA14:p404');
  const elapsed = Date.now() - started;

  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.failure.reason, 'pane-gone');
  assert.match(out.message, /exited before its pipe became ready/);
  assert.match(out.message, /TypeError: boom at footer\.render/);
  assert.ok(elapsed < 10_000, `pane-gone 必须快速失败，实际用了 ${elapsed}ms`);
});

test('waitSubReady (0.9.1): 子 pane 失败时附带 agentExplain 诊断信息', async () => {
  const { createSpawner } = await import('../src/subagent-spawn.ts');
  const spawner = createSpawner({
    client: {
      available: true,
      listAgents: async () => [],
      readPane: async () => ({ text: 'SyntaxError: unexpected token', revision: 1, truncated: false }),
      agentExplain: async () => ({
        matched_rule: 'pi-worker',
        skip_state_reason: 'process_crashed',
      }),
    } as unknown as Parameters<typeof createSpawner>[0]['client'],
    env: { paneId: 'p0', tabId: 't0', workspaceId: 'w1' },
    runtime: { nodePath: '/usr/bin/node', cliPath: '/cli.js', extPath: '/ext.ts' },
    git: { listWorktrees: async () => [] },
  } as unknown as Parameters<typeof createSpawner>[0]);

  const out = await spawner.waitSubReady('/tmp/pier-091-explain', 'wA14:p405');
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.message, /Herdr detection diagnosis:/);
  assert.match(out.message, /matched rule: pi-worker/);
  assert.match(out.message, /skip reason: process_crashed/);
});

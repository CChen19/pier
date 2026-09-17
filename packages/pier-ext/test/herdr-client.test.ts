/**
 * herdr-client: env detection, Noop contract, NDJSON socket protocol.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  HerdrClient,
  NoopHerdrClient,
  createHerdrClient,
  detectHerdrEnv,
  herdrSocketTarget,
  herdrUnavailableHint,
} from '../src/herdr-client.ts';
import { LOCK_BATCH_LIMIT } from '../src/lock-core.ts';
import { withCleanup } from './test-utils.ts';

type RpcHandler = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;

class FakeHerdrServer {
  readonly socketPath: string;
  readonly received: Array<{ method: string; params: Record<string, unknown> }> = [];
  hang = false;
  rawResponse: string | null = null;
  error: { code: string; message: string } | null = null;
  handler: RpcHandler = () => ({ ok: true });
  private server: Server | null = null;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  listen(): Promise<void> {
    this.server = createServer((socket) => {
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', (chunk: string) => {
        buf += chunk;
        const idx = buf.indexOf('\n');
        if (idx < 0) return;
        if (this.hang) return;
        if (this.rawResponse != null) {
          socket.write(this.rawResponse);
          socket.end();
          return;
        }
        let msg: { id?: string; method?: string; params?: Record<string, unknown> };
        try {
          msg = JSON.parse(buf.slice(0, idx).trim()) as typeof msg;
        } catch {
          socket.write(JSON.stringify({ id: '1', error: { code: 'parse', message: 'bad json' } }) + '\n');
          socket.end();
          return;
        }
        this.received.push({ method: String(msg.method ?? ''), params: msg.params ?? {} });
        if (this.error) {
          socket.write(JSON.stringify({ id: msg.id ?? '1', error: this.error }) + '\n');
          socket.end();
          return;
        }
        void Promise.resolve(this.handler(String(msg.method ?? ''), msg.params ?? {})).then((result) => {
          socket.write(JSON.stringify({ id: msg.id ?? '1', result }) + '\n');
          socket.end();
        }, (err: Error) => {
          socket.write(JSON.stringify({ id: msg.id ?? '1', error: { code: 'error', message: err.message } }) + '\n');
          socket.end();
        });
      });
    });
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      // 与 HerdrClient.target() 同源转换：win32 映射 \\.\pipe\，否则以原始文件路径 listen 报 EACCES
      this.server!.listen(herdrSocketTarget(this.socketPath), () => resolve());
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        try { unlinkSync(this.socketPath); } catch { /* already gone */ }
        resolve();
      });
    });
  }
}

function clientFor(server: FakeHerdrServer): HerdrClient {
  return new HerdrClient({
    socketPath: server.socketPath,
    paneId: 'p-self',
    workspaceId: 'w1',
    tabId: 't1',
  });
}

test('detectHerdrEnv: requires HERDR_ENV=1 plus socket and pane', () => {
  assert.equal(detectHerdrEnv({}), null);
  assert.equal(detectHerdrEnv({ HERDR_ENV: '1' }), null);
  assert.equal(detectHerdrEnv({ HERDR_ENV: '1', HERDR_SOCKET_PATH: '/tmp/s' }), null);
  const env = detectHerdrEnv({
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: '/tmp/s',
    HERDR_PANE_ID: 'p1',
    HERDR_WORKSPACE_ID: 'w1',
    HERDR_TAB_ID: 't1',
  });
  assert.deepEqual(env, { socketPath: '/tmp/s', paneId: 'p1', workspaceId: 'w1', tabId: 't1' });
});

test('detectHerdrEnv: missing workspace/tab default to empty string', () => {
  const env = detectHerdrEnv({
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: '/tmp/s',
    HERDR_PANE_ID: 'p1',
  });
  assert.deepEqual(env, { socketPath: '/tmp/s', paneId: 'p1', workspaceId: '', tabId: '' });
});

test('createHerdrClient: missing env → Noop; present env → live client', () => {
  const missing = createHerdrClient({});
  assert.equal(missing.env, null);
  assert.equal(missing.client.available, false);
  assert.ok(missing.client instanceof NoopHerdrClient);

  const live = createHerdrClient({
    HERDR_ENV: '1',
    HERDR_SOCKET_PATH: '/tmp/s',
    HERDR_PANE_ID: 'p1',
  });
  assert.equal(live.client.available, true);
  assert.ok(live.client instanceof HerdrClient);
});

test('NoopHerdrClient: queries empty; spawn/split/createTab throw', async () => {
  const c = new NoopHerdrClient();
  assert.equal(c.available, false);
  assert.deepEqual(await c.listAgents(), []);
  assert.deepEqual(await c.tabList(), []);
  assert.equal(await c.tabGet(), null);
  assert.equal(await c.waitAgent(), null);
  assert.deepEqual(await c.readPane(), { text: '', revision: 0, truncated: false });
  await assert.rejects(() => c.spawnSubPane(), /herdr-managed pane/);
  await assert.rejects(() => c.splitPane(), /herdr-managed pane/);
  await assert.rejects(() => c.createTab(), /herdr-managed pane/);
});

test('herdrSocketTarget: Unix passthrough; Windows named-pipe prefix', () => {
  assert.equal(herdrSocketTarget('/tmp/herdr.sock', 'darwin'), '/tmp/herdr.sock');
  assert.equal(herdrSocketTarget('/tmp/herdr.sock', 'linux'), '/tmp/herdr.sock');
  assert.equal(herdrSocketTarget('herdr-pipe', 'win32'), '\\\\.\\pipe\\herdr-pipe');
  assert.equal(herdrSocketTarget('\\\\.\\pipe\\already', 'win32'), '\\\\.\\pipe\\already');
});

test('HerdrClient: pane.list maps fields; connection roundtrip', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr');
  const server = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  server.handler = (method) => {
    if (method === 'pane.list') {
      return { panes: [{ pane_id: 'p2', tab_id: 't1', workspace_id: 'w1', agent_status: 'idle' }] };
    }
    return {};
  };
  await server.listen();
  try {
    const panes = await clientFor(server).listPanes();
    assert.deepEqual(panes, [{ paneId: 'p2', tabId: 't1', workspaceId: 'w1', agentStatus: 'idle' }]);
    assert.equal(server.received[0]?.method, 'pane.list');
  } finally {
    await server.close();
  }
}));

test('HerdrClient: listAgents maps agent_session.value', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr');
  const server = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  server.handler = () => ({
    agents: [{
      pane_id: 'p2',
      agent: 'pi',
      agent_status: 'working',
      agent_session: { value: '/sess/a.jsonl', kind: 'path' },
      state_labels: { k: 'v' },
      tokens: { 'pi-todo': 'x' },
    }],
  });
  await server.listen();
  try {
    const agents = await clientFor(server).listAgents();
    assert.equal(agents.length, 1);
    assert.equal(agents[0].paneId, 'p2');
    assert.equal(agents[0].session, '/sess/a.jsonl');
    assert.equal(agents[0].status, 'working');
    assert.equal(await clientFor(server).getAgentSessionPath('p2'), '/sess/a.jsonl');
    assert.equal(await clientFor(server).getAgentSessionPath('missing'), null);
  } finally {
    await server.close();
  }
}));

test('HerdrClient: splitPane / spawnSubPane extract nested pane_id via findIdIn', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr');
  const server = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  server.handler = (method) => {
    if (method === 'pane.split') return { created: { pane_id: 'p-new' } };
    if (method === 'layout.apply') return { layout: { tab_id: 't-new', pane: { pane_id: 'p-spawn' } } };
    return {};
  };
  await server.listen();
  try {
    const c = clientFor(server);
    assert.equal(await c.splitPane({ direction: 'right', cwd: '/repo' }), 'p-new');
    const spawned = await c.spawnSubPane({ label: 'task', command: ['pi'], cwd: '/repo' });
    assert.deepEqual(spawned, { tabId: 't-new', paneId: 'p-spawn' });
    assert.equal(server.received[0]?.params.direction, 'right');
  } finally {
    await server.close();
  }
}));

test('HerdrClient: splitPane throws when response has no pane_id', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr');
  const server = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  server.handler = () => ({ ok: true });
  await server.listen();
  try {
    await assert.rejects(() => clientFor(server).splitPane({}), /no pane_id/);
  } finally {
    await server.close();
  }
}));

test('HerdrClient: createTab requires tab_id; sendPaneText appends CR', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr');
  const server = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  server.handler = (method) => {
    if (method === 'tab.create') return { tab_id: 't9', root: { pane_id: 'p9' } };
    return {};
  };
  await server.listen();
  try {
    const c = clientFor(server);
    assert.deepEqual(await c.createTab({ workspaceId: 'w1', label: 'main' }), { tabId: 't9', paneId: 'p9' });
    await c.sendPaneText('p9', 'hello');
    const send = server.received.find((r) => r.method === 'pane.send_text');
    assert.equal(send?.params.text, 'hello\r');
  } finally {
    await server.close();
  }
}));

test('HerdrClient: tabList drops tabs without tab_id; tabGet / tabClose / closePane', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr');
  const server = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  server.handler = (method) => {
    if (method === 'tab.list') {
      return { tabs: [{ tab_id: 't1', workspace_id: 'w1', label: 'main', pane_count: 2, agent_status: 'idle' }, { label: 'bad' }] };
    }
    if (method === 'tab.get') return { tab: { tab_id: 't1', workspace_id: 'w1', label: 'main', pane_count: 1 } };
    return {};
  };
  await server.listen();
  try {
    const c = clientFor(server);
    const tabs = await c.tabList();
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].tabId, 't1');
    assert.equal(tabs[0].paneCount, 2);
    const got = await c.tabGet('t1');
    assert.equal(got?.label, 'main');
    await c.tabClose('t1');
    await c.closePane('p2');
    assert.ok(server.received.some((r) => r.method === 'tab.close' && r.params.tab_id === 't1'));
    assert.ok(server.received.some((r) => r.method === 'pane.close' && r.params.pane_id === 'p2'));
  } finally {
    await server.close();
  }
}));

test('HerdrClient: exportLayout reads nested layout envelope; failure → null', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr');
  const server = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  server.handler = () => ({ layout: { tab_id: 't1', zoomed: true, root: { type: 'pane' } } });
  await server.listen();
  try {
    const layout = await clientFor(server).exportLayout({ paneId: 'p1' });
    // D-4: focusedPaneId rides along (null when the server omits it).
    assert.deepEqual(layout, { tabId: 't1', zoomed: true, root: { type: 'pane' }, focusedPaneId: null });
  } finally {
    await server.close();
  }
  const missing = new HerdrClient({
    socketPath: join(dir.path, 'no-such.sock'),
    paneId: 'p',
    workspaceId: 'w',
    tabId: 't',
  });
  assert.equal(await missing.exportLayout({ paneId: 'p' }), null);
}));

test('HerdrClient: waitAgent maps timeout errors to null; other errors throw', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr');
  const server = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  server.error = { code: 'timeout', message: 'agent wait timeout' };
  await server.listen();
  try {
    assert.equal(await clientFor(server).waitAgent('p2', ['idle'], 50), null);
  } finally {
    await server.close();
  }
}));

test('HerdrClient: waitAgent returns agent_status on success', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr');
  const server = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  server.handler = () => ({ agent: { agent_status: 'idle' } });
  await server.listen();
  try {
    assert.equal(await clientFor(server).waitAgent('p2', ['idle'], 200), 'idle');
  } finally {
    await server.close();
  }
}));

test('HerdrClient: bad frame and error envelope reject', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr');
  const bad = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  bad.rawResponse = 'not-json\n';
  await bad.listen();
  try {
    await assert.rejects(() => clientFor(bad).focusPane('p'), /bad frame/);
  } finally {
    await bad.close();
  }
  const errServer = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  errServer.error = { code: 'not_found', message: 'no pane' };
  await errServer.listen();
  try {
    await assert.rejects(() => clientFor(errServer).focusPane('p'), /not_found: no pane/);
  } finally {
    await errServer.close();
  }
}));

test('HerdrClient: connection refused rejects control RPCs; report* swallows', async () => {
  const c = new HerdrClient({
    socketPath: join('/tmp', `pier-herdr-missing-${randomUUID()}.sock`),
    paneId: 'p',
    workspaceId: 'w',
    tabId: 't',
  });
  await assert.rejects(() => c.focusPane('p'));
  await c.reportAgent('idle', null);
  await c.reportDisplayAgent('worker');
  await c.reportAskFlag('waiting');
});

test('D-2 丙：pier 不再上报 session 路径（原生 herdr:pi 独占该字段）', () => {
  // 契约：客户端不存在 reportAgentSession，源码里也没有 pane.report_agent_session 调用点。
  // 若将来有人重新加上"顺手报个 session"，这条测试会失败——那时必须先证明原生集成不再上报。
  const client = readFileSync(join(import.meta.dirname, '../src/herdr-client.ts'), 'utf8');
  assert.equal(typeof (HerdrClient.prototype as unknown as Record<string, unknown>).reportAgentSession, 'undefined');
  assert.ok(!client.includes("'pane.report_agent_session'"), 'herdr-client 不应再发送 pane.report_agent_session');
  const index = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8');
  assert.ok(!/reportSession\(|reportAgentSession\(/.test(index), 'index.ts 不应再有 session 上报路径');
});

test('HerdrClient: reportLockTokens batches at LOCK_BATCH_LIMIT', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr');
  const server = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  await server.listen();
  try {
    const tokens: Record<string, string | null> = {};
    for (let i = 0; i < LOCK_BATCH_LIMIT + 1; i++) tokens[`lock-${i}`] = `p|${i}`;
    await clientFor(server).reportLockTokens(tokens);
    const meta = server.received.filter((r) => r.method === 'pane.report_metadata');
    assert.equal(meta.length, 2);
    assert.equal(Object.keys(meta[0].params.tokens as object).length, LOCK_BATCH_LIMIT);
    assert.equal(Object.keys(meta[1].params.tokens as object).length, 1);
  } finally {
    await server.close();
  }
}));

test('HerdrClient: readPane unwraps read envelope; waitForOutput timeout → discriminated result', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr');
  const server = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  server.handler = (method) => {
    if (method === 'pane.read') return { read: { text: 'hi', revision: 3, truncated: true } };
    if (method === 'pane.wait_for_output') return { matched: true };
    return {};
  };
  await server.listen();
  try {
    const read = await clientFor(server).readPane('p2', { source: 'recent', lines: 20 });
    assert.deepEqual(read, { text: 'hi', revision: 3, truncated: true });
    assert.equal(server.received[0]?.params.strip_ansi, false);
    const ok = await clientFor(server).waitForOutput('p2', { type: 'substring', value: 'x' }, 50);
    assert.deepEqual(ok, { matched: true });
  } finally {
    await server.close();
  }
  const hang = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  hang.error = { code: 'timeout', message: 'wait timeout' };
  await hang.listen();
  try {
    assert.deepEqual(await clientFor(hang).waitForOutput('p2', { type: 'substring', value: 'x' }, 50), { matched: false, reason: 'timeout' });
  } finally {
    await hang.close();
  }
}));

test('HerdrClient (0.9.1): openPluginPane popup, nested agent.explain, ping version, 0.9.1 list fields', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr-091');
  const server = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  server.handler = (method, params) => {
    if (method === 'plugin.pane.open') {
      if (params.placement === 'popup') return { type: 'plugin_pane_opened', plugin_pane: { plugin_id: 'pier.workbench', entrypoint: 'dashboard', pane: { pane_id: 'w1:p8' } } };
      return { type: 'plugin_pane_opened', plugin_pane: { pane: { pane_id: 'w1:p8', tab_id: 'w1:t3' } } };
    }
    if (method === 'popup.close') return { type: 'ok' };
    if (method === 'agent.explain') {
      return { type: 'agent_explain', explain: { matched_rule: 'pi-standard', skip_state_reason: 'process_crashed' } };
    }
    if (method === 'ping') return { type: 'pong', version: '0.9.1', protocol: 22 };
    if (method === 'agent.list') {
      return {
        agents: [{
          pane_id: 'p2',
          agent: 'pi',
          agent_status: 'working',
          agent_session: { value: '/sess/a.jsonl', kind: 'path' },
          state_labels: {},
          tokens: {},
          foreground_cwd: '/repo/sub',
        }],
      };
    }
    if (method === 'pane.list') {
      return {
        panes: [{
          pane_id: 'p2',
          tab_id: 't1',
          workspace_id: 'w1',
          agent_status: 'idle',
          foreground_cwd: '/repo/sub',
          terminal_title: '⠋ npm run dev',
          terminal_title_stripped: 'npm run dev',
        }],
      };
    }
    return {};
  };
  await server.listen();
  try {
    const client = clientFor(server);
    const popRes = await client.openPluginPane({
      pluginId: 'pier.workbench',
      entrypoint: 'dashboard',
      placement: 'popup',
    });
    assert.deepEqual(popRes, { mode: 'popup', ok: true });

    assert.equal(await client.closePopup(), true);

    const explain = await client.agentExplain('w1:p1');
    assert.equal(explain?.matched_rule, 'pi-standard');
    assert.equal(explain?.skip_state_reason, 'process_crashed');
    assert.equal(explain?.type, undefined, 'unwraps {type, explain} envelope');

    assert.equal(await client.getServerVersion(), '0.9.1');
    assert.equal(await client.getServerVersion(), '0.9.1');
    assert.equal(server.received.filter((r) => r.method === 'ping').length, 1);

    const agents = await client.listAgents();
    assert.equal(agents[0]?.foregroundCwd, '/repo/sub');

    const panes = await client.listPanes();
    assert.equal(panes[0]?.foregroundCwd, '/repo/sub');
    assert.equal(panes[0]?.terminalTitle, '⠋ npm run dev');
    assert.equal(panes[0]?.terminalTitleStripped, 'npm run dev');
  } finally {
    await server.close();
  }

  const oldServer = new FakeHerdrServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  oldServer.handler = async (method, params) => {
    if (method === 'plugin.pane.open') {
      if (params.placement === 'popup') {
        throw new Error("unknown variant `popup`, expected one of `overlay`, `split`, `tab`, `zoomed`");
      }
      return { type: 'plugin_pane_opened', plugin_pane: { pane: { pane_id: 'w1:p9', tab_id: 'w1:t4' } } };
    }
    if (method === 'popup.close') {
      throw new Error('popup_not_open');
    }
    return {};
  };
  await oldServer.listen();
  try {
    const client = clientFor(oldServer);
    const res = await client.openPluginPane({
      pluginId: 'pier.workbench',
      entrypoint: 'dashboard',
      placement: 'popup',
    });
    assert.equal(res.mode, 'fallback_tab');
    if (res.mode !== 'fallback_tab') throw new Error('expected fallback_tab');
    assert.equal(res.paneId, 'w1:p9');
    assert.equal(await client.closePopup(), false);
  } finally {
    await oldServer.close();
  }
}));

test('herdrUnavailableHint (B5): 传输层失败给出可动作的一句话，其它错误返回 null', () => {
  assert.match(String(herdrUnavailableHint(new Error('connect ENOENT /tmp/herdr.sock'))), /herdr unreachable/);
  assert.match(String(herdrUnavailableHint(new Error('connect ECONNREFUSED 127.0.0.1:1'))), /HERDR_SOCKET_PATH/);
  assert.match(String(herdrUnavailableHint(new Error('socket hang up'))), /herdr unreachable/);
  // 业务错误不该被包装成"herdr 不可达"
  assert.equal(herdrUnavailableHint(new Error('pane_not_found: wX:p9')), null);
  assert.equal(herdrUnavailableHint(new Error('invalid regex')), null);
});

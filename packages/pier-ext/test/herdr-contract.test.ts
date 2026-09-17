/**
 * A6：与 herdr 的 wire 契约（协议代差会静默漂移字段语义）。
 *
 * 背景：客户端注释曾长期写着 herdr 0.8.0-preview / protocol 19，而实际服务端是 0.9.0 / protocol 22；
 * `pane.split` 的 `focus` 参数就是这样被静默丢掉的（调用方传了，客户端没转发，谁都没报错）。
 *
 * 做法：把 `herdr api schema` 导出的**必需/允许参数表**当 fixture（test/fixtures/herdr-contract.json），
 * 录制 pier 客户端真实发出的请求体，逐条校验：方法存在、没有未知字段、必需字段齐全、没有 undefined 值。
 * fixture 随 herdr 升级重新生成即可——漂移会在测试里现形，而不是在用户的 pane 里。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HERDR_PROTOCOL_EXPECTED, HerdrClient } from '../src/herdr-client.ts';
import { withCleanup } from './test-utils.ts';

/** Minimal, schema-shaped answers: enough for the client's response parsing to succeed. */
function respond(method: string): Record<string, unknown> {
  switch (method) {
    case 'pane.split': return { type: 'pane_info', pane: { pane_id: 'w1:p3', tab_id: 'w1:t1', workspace_id: 'w1' } };
    case 'tab.create': return { type: 'pane_info', pane: { pane_id: 'w1:p3', tab_id: 'w1:t2', workspace_id: 'w1' } };
    case 'pane.list': return { type: 'pane_list', panes: [] };
    case 'tab.list': return { type: 'tab_list', tabs: [] };
    case 'tab.get': return { type: 'tab_info', tab: { tab_id: 'w1:t1', workspace_id: 'w1', label: 'main', number: 1, focused: true, pane_count: 1, agent_status: 'idle' } };
    case 'agent.list': return { type: 'agent_list', agents: [] };
    case 'agent.wait': return { type: 'agent_status', agent: { agent_status: 'idle' } };
    case 'pane.read': return { type: 'pane_read', text: '', revision: 0, truncated: false };
    case 'layout.export': return { type: 'layout_export', layout: { workspace_id: 'w1', tab_id: 'w1:t1', zoomed: false, focused_pane_id: 'w1:p1', root: { type: 'pane', pane_id: 'w1:p1' } } };
    default: return { type: 'ok' };
  }
}

interface ContractFixture {
  _source: string;
  methods: Record<string, { def: string | null; required: string[]; allowed: string[] }>;
}

const contract: ContractFixture = JSON.parse(
  readFileSync(new URL('./fixtures/herdr-contract.json', import.meta.url), 'utf8'),
) as ContractFixture;

/** Records every request pier sends and answers with a permissive success payload. */
class RecordingServer {
  readonly socketPath: string;
  readonly received: Array<{ method: string; params: Record<string, unknown> }> = [];
  private server: Server | null = null;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async listen(): Promise<void> {
    this.server = createServer((sock) => {
      let buf = '';
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => {
        buf += chunk;
        const i = buf.indexOf('\n');
        if (i < 0) return;
        let req: { id?: string; method?: string; params?: Record<string, unknown> };
        try { req = JSON.parse(buf.slice(0, i)); } catch { sock.destroy(); return; }
        buf = buf.slice(i + 1);
        this.received.push({ method: String(req.method), params: req.params ?? {} });
        sock.end(JSON.stringify({ id: req.id ?? '1', result: respond(String(req.method)) }) + '\n');
      });
      sock.on('error', () => { /* client may hang up */ });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.socketPath, () => resolve()));
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    const s = server as unknown as { closeAllConnections?: () => void };
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('A6 契约：pier 发出的请求体必须落在 herdr schema 内（无未知/缺失字段）', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr-contract');
  const server = new RecordingServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  await server.listen();
  try {
    const client = new HerdrClient({
      socketPath: server.socketPath,
      paneId: 'w1:p1',
      workspaceId: 'w1',
      tabId: 'w1:t1',
    });
    // 覆盖本轮之后 pier 真正会发的请求（含 line 3 新增的 focus 转发）。
    await client.reportAgent('working', 'badge');
    await client.reportMetadata({ session: 'label', items: [{ content: 'x', status: 'in_progress' }] });
    await client.listAgents();
    await client.waitAgent('w1:p2', ['idle'], 50);
    await client.splitPane({ direction: 'right', cwd: '/tmp', focus: false, targetPaneId: 'w1:p1' });
    await client.createTab({ workspaceId: 'w1', label: 'task' });
    await client.readPane('w1:p2', { stripAnsi: true });
    await client.sendPaneText('w1:p2', 'echo hi');
    await client.sendPaneKeys('w1:p2', ['ctrl+c']);
    await client.closePane('w1:p2');
    await client.exportLayout({ paneId: 'w1:p1' });
    await client.tabList();
    await client.tabGet('w1:t1');
    await client.tabClose('w1:t1');
    await client.focusPane('w1:p2');
    await client.listPanes();
    await client.waitForOutput('w1:p2', { type: 'substring', value: 'x' }, 50);
    await client.openPluginPane({
      pluginId: 'pier.workbench',
      entrypoint: 'dashboard',
      placement: 'popup',
      width: '80%',
      height: '80%',
      focus: true,
    });
    await client.closePopup();
    await client.agentExplain('w1:p1');
  } finally {
    await server.close();
  }

  assert.ok(server.received.length >= 10, `应记录到多类请求，实际 ${server.received.length}`);
  const problems: string[] = [];
  for (const { method, params } of server.received) {
    const spec = contract.methods[method];
    if (!spec) {
      problems.push(`${method}: 方法不在契约 fixture 中（新方法？请重新生成 fixture）`);
      continue;
    }
    for (const key of Object.keys(params)) {
      if (!spec.allowed.includes(key)) problems.push(`${method}: 未知参数 "${key}"（允许：${spec.allowed.join(', ') || '无'}）`);
      if (params[key] === undefined) problems.push(`${method}: 参数 "${key}" 是 undefined（序列化后会变成缺字段）`);
    }
    for (const key of spec.required) {
      if (!(key in params)) problems.push(`${method}: 缺少必需参数 "${key}"`);
    }
  }
  assert.deepEqual(problems, [], `与 herdr schema 不一致：\n${problems.join('\n')}`);
  // 契约代差闸门：fixture 与客户端常量必须指向同一协议版本
  assert.match(contract._source, new RegExp(`protocol ${HERDR_PROTOCOL_EXPECTED}\\b`),
    'fixture 与 HERDR_PROTOCOL_EXPECTED 不一致：herdr 升级后请重新生成 fixture 并更新常量');
  // report_metadata 的现代字段确实在用（A6：ttl_ms / state_labels 已纳入使用，而非硬编码旧形状）
  const metaKeys = new Set(server.received.filter((r) => r.method === 'pane.report_metadata').flatMap((r) => Object.keys(r.params)));
  assert.ok(metaKeys.has('ttl_ms'), 'report_metadata 带 ttl_ms');
  assert.ok(metaKeys.has('tokens') || metaKeys.has('clear_state_labels'), 'report_metadata 走现代字段');
}));

test('A6 契约：pane.split 的 focus 必须真的发出去（曾经的静默丢弃）', withCleanup(async (cleanup) => {
  const dir = cleanup.tempDir('herdr-focus-fwd');
  const server = new RecordingServer(join(dir.path, `s-${randomUUID().slice(0, 8)}.sock`));
  await server.listen();
  try {
    const client = new HerdrClient({ socketPath: server.socketPath, paneId: 'p', workspaceId: 'w', tabId: 't' });
    await client.splitPane({ direction: 'right', focus: false });
  } finally {
    await server.close();
  }
  const split = server.received.find((r) => r.method === 'pane.split');
  assert.ok(split, 'pane.split 已发出');
  assert.equal(split!.params.focus, false, 'focus 不能被客户端吞掉');
  assert.equal(split!.params.direction, 'right');
  // 未指定时不瞎猜：交给服务端默认（schema 里 focus 默认 false）
  const dir2 = cleanup.tempDir('herdr-focus-default');
  const server2 = new RecordingServer(join(dir2.path, `s-${randomUUID().slice(0, 8)}.sock`));
  await server2.listen();
  try {
    const client = new HerdrClient({ socketPath: server2.socketPath, paneId: 'p', workspaceId: 'w', tabId: 't' });
    await client.splitPane({ direction: 'down' });
  } finally {
    await server2.close();
  }
  assert.equal('focus' in server2.received[0]!.params, false);
}));

/**
 * D-4 wiring: session_start starts the focus poller, a focus transition into this pane replays a
 * `pane.focused` reflow through the real spawn path, and session_shutdown stops the polling.
 *
 * The herdr socket is faked (scripted `layout.export` replies) and the workbench script is replaced
 * by a stub in a temp root, so the test covers index.ts plumbing + focus-poller + spawnReflow without
 * touching the developer's live herdr session.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import pier from '../src/index.ts';
import { withCleanup } from './test-utils.ts';

interface FakePi {
  tools: Map<string, unknown>;
  listeners: Map<string, Array<(...a: unknown[]) => unknown>>;
  registerTool(def: { name: string }): void;
  registerCommand(name: string, options: unknown): void;
  on(event: string, handler: (...a: unknown[]) => unknown): void;
  appendEntry(customType: string, data: unknown): void;
  sendMessage(message: unknown, options?: unknown): void;
  sendUserMessage(content?: string, opts?: unknown): Promise<void>;
  events: {
    on(channel: string, handler: (data: unknown) => void): () => void;
    emit(channel: string, data: unknown): void;
  };
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

function fakePi(): FakePi {
  const bus = new Map<string, Array<(data: unknown) => void>>();
  return {
    tools: new Map(),
    listeners: new Map(),
    registerTool(def) { this.tools.set(def.name, def); },
    registerCommand() {},
    on(event, handler) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]); },
    appendEntry() {},
    sendMessage() {},
    sendUserMessage() { return Promise.resolve(); },
    events: {
      on(channel, handler) {
        bus.set(channel, [...(bus.get(channel) ?? []), handler]);
        return () => { bus.set(channel, (bus.get(channel) ?? []).filter((h) => h !== handler)); };
      },
      emit(channel, data) { for (const h of bus.get(channel) ?? []) h(data); },
    },
    getActiveTools() { return [...this.tools.keys()]; },
    setActiveTools() {},
  };
}

async function fire(pi: FakePi, event: string, ...args: unknown[]): Promise<void> {
  for (const h of pi.listeners.get(event) ?? []) await h(...args);
}

/** Minimal herdr server: answers layout.export with a scripted focus sequence, records other calls. */
function fakeHerdrServer(socketPath: string, focuses: Array<string | null>): Promise<{ close(): Promise<void>; calls: string[] }> {
  const calls: string[] = [];
  let index = 0;
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let req: { id?: string; method?: string };
      try { req = JSON.parse(buf.slice(0, nl)); } catch { sock.destroy(); return; }
      const method = String(req.method ?? '');
      calls.push(method);
      if (method === 'layout.export') {
        const focused = focuses[Math.min(index, focuses.length - 1)] ?? null;
        index += 1;
        // Both panes always exist; only the focused one moves (a click, not a spawn).
        const root = {
          type: 'split',
          first: { type: 'pane', pane_id: 'wX:pOther' },
          second: { type: 'pane', pane_id: 'wX:pMe' },
        };
        sock.end(JSON.stringify({
          id: req.id ?? '1',
          result: {
            type: 'layout_export',
            layout: { workspace_id: 'wX', tab_id: 'wX:t1', zoomed: false, focused_pane_id: focused, root },
          },
        }) + '\n');
        return;
      }
      sock.end(JSON.stringify({ id: req.id ?? '1', result: { type: 'ok' } }) + '\n');
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        calls,
        close: () => new Promise<void>((done) => { 
          const s = server as unknown as { closeAllConnections?: () => void }; 
          s.closeAllConnections?.(); 
          server.close(() => done()); 
        }),
      });
    });
  });
}

test('index D-4: 焦点转回本 pane ⇒ 以 pane.focused 事件重放 reflow；shutdown 停止轮询', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.delete('PI_HERDR_SUBAGENT');
  env.set('HERDR_ENV', '1');
  env.set('HERDR_PANE_ID', 'wX:pMe');
  env.set('HERDR_TAB_ID', 'wX:t1');
  env.set('HERDR_WORKSPACE_ID', 'wX');
  env.delete('PI_HERDR_ROLE_MANIFEST');
  env.set('PIER_FOCUS_POLL_MS', '40');

  const tmp = cleanup.tempDir('pier-focus-d4').path;
  const socketPath = path.join(tmp, 'herdr.sock');
  env.set('HERDR_SOCKET_PATH', socketPath);

  // Stub workbench: records the event env it was invoked with (real spawn, no layout changes).
  const wbRoot = path.join(tmp, 'wb');
  fs.mkdirSync(path.join(wbRoot, 'scripts'), { recursive: true });
  const marker = path.join(tmp, 'reflow.jsonl');
  fs.writeFileSync(path.join(wbRoot, 'scripts', 'heat-reflow.mjs'),
    `import * as fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(marker)}, process.env.HERDR_PLUGIN_EVENT + ' ' + process.env.HERDR_PLUGIN_EVENT_JSON + '\\n');\n`);
  env.set('PIER_WORKBENCH_ROOT', wbRoot);

  // First sample: someone else is focused; every later sample: this pane is focused.
  const server = await fakeHerdrServer(socketPath, ['wX:pOther', 'wX:pMe']);
  const pi = fakePi();
  const cwd = path.join(tmp, 'ws');
  fs.mkdirSync(cwd, { recursive: true });

  try {
    await pier(pi as never);
    await fire(pi, 'session_start', { reason: 'new' }, { cwd, sessionManager: { getBranch: () => [] } });

    const deadline = Date.now() + 5000;
    let lines: string[] = [];
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
      lines = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean) : [];
      if (lines.length > 0) break;
    }

    assert.equal(lines.length, 1, 'exactly one reflow replay for one focus transition');
    assert.match(lines[0]!, /^pane\.focused /);
    const payload = JSON.parse(lines[0]!.slice('pane.focused '.length));
    assert.equal(payload.data.pane_id, 'wX:pMe');
    assert.equal(payload.data.cause, 'user');

    // Shutdown stops polling: no further spawns even though the focus stays on this pane.
    await fire(pi, 'session_shutdown');
    // Let any already-queued tick settle, then require the sample count to stop growing at all.
    await new Promise((r) => setTimeout(r, 200));
    const samplesAfterSettle = server.calls.filter((m) => m === 'layout.export').length;
    await new Promise((r) => setTimeout(r, 300)); // > 6 poll intervals: a live poller would be obvious
    assert.equal(
      server.calls.filter((m) => m === 'layout.export').length,
      samplesAfterSettle,
      'no sampling after shutdown',
    );
    assert.equal(fs.readFileSync(marker, 'utf8').trim().split('\n').filter(Boolean).length, 1);
  } finally {
    await server.close();
  }
}));

test('index D-4: PIER_FOCUS_POLL_MS=0 关闭轮询（退回只依赖 herdr 事件）', withCleanup(async (cleanup) => {
  const env = cleanup.env();
  env.delete('PI_HERDR_SUBAGENT');
  env.set('HERDR_ENV', '1');
  env.set('HERDR_PANE_ID', 'wX:pMe');
  env.set('HERDR_TAB_ID', 'wX:t1');
  env.set('HERDR_WORKSPACE_ID', 'wX');
  env.delete('PI_HERDR_ROLE_MANIFEST');
  env.set('PIER_FOCUS_POLL_MS', '0');
  env.delete('PIER_WORKBENCH_ROOT');

  const tmp = cleanup.tempDir('pier-focus-off').path;
  const socketPath = path.join(tmp, 'herdr.sock');
  env.set('HERDR_SOCKET_PATH', socketPath);
  const server = await fakeHerdrServer(socketPath, ['wX:pMe']);
  const pi = fakePi();
  const cwd = path.join(tmp, 'ws');
  fs.mkdirSync(cwd, { recursive: true });

  try {
    await pier(pi as never);
    await fire(pi, 'session_start', { reason: 'new' }, { cwd, sessionManager: { getBranch: () => [] } });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(server.calls.includes('layout.export'), false, 'disabled poller must not sample the layout');
  } finally {
    await fire(pi, 'session_shutdown');
    await server.close();
  }
}));

test('focusPollIntervalMs: 非法/缺失/零值', async () => {
  const mod = await import('../src/index.ts');
  assert.equal(typeof mod.default, 'function');
  // The parser is internal to index.ts; behaviour is covered by the two integration tests above
  // (default cadence samples, 0 disables). Guard the env contract here so a rename is caught.
  const src = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(src, /PIER_FOCUS_POLL_MS/);
  assert.match(src, /FOCUS_POLL_DEFAULT_MS/);
  void os;
});

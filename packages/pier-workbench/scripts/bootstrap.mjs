#!/usr/bin/env node
/**
 * v1.3 M7 main tab bootstrap (D28): herdr plugin [[events]] workspace.created / worktree.opened hook.
 *
 * When triggered, workspace.create already includes a tab + root pane (verified schema: workspace_created
 * envelope contains workspace/tab/root_pane) — bootstrap does not create a new tab, but rather:
 *   1. Idempotency check: workspace already has a pi master pane (agent=pi or title contains ⏳) -> skip;
 *   2. Injects pi launch command into root pane (or first pane of the workspace) via pane.send_text + CR
 *      (same channel as subpanes, verified to reach stdin);
 *   3. tab.rename -> mainTabLabel;
 *   4. Appends bootstrap record to HERDR_PLUGIN_STATE_DIR/boot.jsonl (used by [[startup]] restore).
 * M22: no longer creates todo-board; no longer automatically adds persistent panes.
 * All failures degrade to logs + non-zero exit; event hook errors do not affect herdr server.
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const SOCKET = process.env.HERDR_SOCKET_PATH;
const here = path.dirname(fileURLToPath(import.meta.url));
// v1.3 M7 empirical: herdr did not inject HERDR_PLUGIN_STATE_DIR (directory did not exist) ->
// Bootstrap record follows the same convention as history, residing at ~/.pi/agent/herdr-pi/boot.jsonl (read by both plugin and extension).
const BOOT_FILE = path.join(os.homedir(), '.pi', 'agent', 'herdr-pi', 'boot.jsonl');

// Config resolution: user mode (plugin install) config is in HERDR_PLUGIN_CONFIG_DIR (herdr-managed
// checkout gets replaced on reinstall, so config cannot live in plugin dir); dev mode (link) falls back
// to scripts/boot-config.json (inside repo, template at .example.json).
function readBootConfig(here) {
  const candidates = [
    process.env.HERDR_PLUGIN_CONFIG_DIR ? path.join(process.env.HERDR_PLUGIN_CONFIG_DIR, 'boot-config.json') : null,
    path.join(here, 'boot-config.json'),
  ].filter(Boolean);
  for (const f of candidates) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* next candidate */ }
  }
  return null;
}

let config = null;
try {
  config = readBootConfig(here);
  if (!config) throw new Error('no boot-config.json in HERDR_PLUGIN_CONFIG_DIR or scripts/');
} catch (e) {
  console.error('[bootstrap] ' + e.message);
  process.exit(0);
}

const TARGET = process.platform === 'win32' && SOCKET
  ? (SOCKET.startsWith('\\\\.\\pipe\\') ? SOCKET : '\\\\.\\pipe\\' + SOCKET)
  : SOCKET;

function request(method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(TARGET);
    sock.setEncoding('utf8');
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; sock.destroy(); reject(new Error(method + ' timeout')); } }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ id: '1', method, params }) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      sock.destroy();
      let msg;
      try { msg = JSON.parse(buf.slice(0, i).trim()); } catch { return reject(new Error('bad frame')); }
      msg.error ? reject(new Error(`${msg.error.code}: ${msg.error.message}`)) : resolve(msg.result);
    });
    sock.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
  });
}

function deepFindFirst(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (typeof obj[key] === 'string') return obj[key];
  for (const v of Object.values(obj)) {
    const r = deepFindFirst(v, key, depth + 1);
    if (r) return r;
  }
  return null;
}

async function main() {
  // Tightening gate (Scenario B isolation): when autoBootstrap=false, new workspaces do not automatically inject pi
  // (users can disable when running other agents in herdr; default true = product behavior unchanged).
  if (config.autoBootstrap === false) {
    console.log('[bootstrap] autoBootstrap disabled; skip');
    process.exit(0);
  }
  let event = {};
  try { event = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON ?? '{}'); } catch { /* empty */ }
  const wsId = event?.workspace?.workspace_id ?? deepFindFirst(event, 'workspace_id') ?? '';
  if (!wsId) {
    console.error('[bootstrap] no workspace_id in event payload');
    process.exit(0);
  }
  const panes = (await request('pane.list', {})).panes ?? [];
  const wsPanes = panes.filter((p) => p.workspace_id === wsId);
  // D91 icon transition: new title prefix ▶..., legacy sessions ⏳... (dual match preserves idempotency)
  const hasMaster = wsPanes.some((p) => p.agent === 'pi' || (typeof p.title === 'string' && /⏳|▶/.test(p.title)));
  if (hasMaster) {
    console.log(`[bootstrap] workspace ${wsId} already has a master pi; skip`);
    process.exit(0);
  }

  const rootPaneId = event?.root_pane?.pane_id ?? deepFindFirst(event, 'pane_id') ?? '';
  const target = wsPanes.find((p) => p.pane_id === rootPaneId) ?? wsPanes[0];
  if (!target) {
    console.error('[bootstrap] workspace has no pane to launch into');
    process.exit(0);
  }

  // Tier 1 hmr dev stance (d87): when hmrDev=true, master launch line includes --expose-internals +
  // PI_HERDR_HMR=1 (dual gate; bootstrap.ts missing either means zero watchers). Default false = production stance unchanged.
  // Launch line emits platform-specific shell syntax: win32=PowerShell (& + '' escape + $env:), POSIX=sh ('\'' escape + env prefix).
  const hmrDev = config.hmrDev === true;
  const cliParts = [config.piNode, config.piCli];
  if (hmrDev) cliParts.splice(1, 0, '--expose-internals');
  // D97: master also fullscreen (prerequisite for slim frame static display); PI_HERDR_TUI=regular escape hatch
  if (process.env.PI_HERDR_TUI !== 'regular') cliParts.push('--tui-mode', 'fullscreen');
  cliParts.push('-e', config.extPath);
  const quote = (s) => (process.platform === 'win32' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`);
  const cli = (process.platform === 'win32' ? '& ' : '') + cliParts.map(quote).join(' ');
  const launch = hmrDev
    ? (process.platform === 'win32' ? `$env:PI_HERDR_HMR='1'; ${cli}` : `PI_HERDR_HMR=1 ${cli}`)
    : cli;
  await request('pane.send_text', { pane_id: target.pane_id, text: launch + '\r' });

  const tabId = event?.tab?.tab_id ?? deepFindFirst(event, 'tab_id') ?? target.tab_id ?? '';
  if (tabId && config.mainTabLabel) {
    try { await request('tab.rename', { tab_id: tabId, label: config.mainTabLabel }); } catch (e) { console.error('[bootstrap] rename failed: ' + e.message); }
  }

  try {
    fs.mkdirSync(path.dirname(BOOT_FILE), { recursive: true });
    fs.appendFileSync(BOOT_FILE,
      JSON.stringify({ workspace_id: wsId, tab_id: tabId, pane_id: target.pane_id, cwd: target.cwd ?? '', ts: Date.now() }) + '\n');
  } catch (e) {
    console.error('[bootstrap] boot record write failed: ' + e.message);
  }
  console.log(`[bootstrap] main tab ready: ws=${wsId} tab=${tabId} pane=${target.pane_id}`);
  process.exit(0);
}

main().catch((e) => { console.error('[bootstrap] ' + e.message); process.exit(1); });

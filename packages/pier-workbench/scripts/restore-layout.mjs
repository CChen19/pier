#!/usr/bin/env node
/**
 * v1.3 M7 layout restore (D28): herdr plugin [[startup]] hook (runs once after session restore + socket ready).
 * Reads HERDR_PLUGIN_STATE_DIR/boot.jsonl (bootstrap records appended during workspace bootstrap); for each entry:
 *  - tab has disappeared -> rebuild main tab via layout.apply if workspace is still alive (cwd from record);
 *  - tab exists but pane is gone -> focus + split a new pane and reinject launch command;
 *  - pane exists and is already pi -> skip; pane exists but was reset (non-pi) -> reinject launch command.
 * one-shot: exits after running (official herdr startup semantics: not a persistent daemon).
 */
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { latestBootRecordPerWorkspace, parseBootRecords } from '../src/restore-plan.ts';

const SOCKET = process.env.HERDR_SOCKET_PATH;
const here = path.dirname(fileURLToPath(import.meta.url));
// Same convention as bootstrap: ~/.pi/agent/herdr-pi/boot.jsonl (empirically confirmed HERDR_PLUGIN_STATE_DIR was not injected).
const BOOT_FILE = path.join(os.homedir(), '.pi', 'agent', 'herdr-pi', 'boot.jsonl');

// Config resolution follows same convention as bootstrap: HERDR_PLUGIN_CONFIG_DIR (user mode) -> scripts/ (dev mode).
let config = null;
try {
  const candidates = [
    process.env.HERDR_PLUGIN_CONFIG_DIR ? path.join(process.env.HERDR_PLUGIN_CONFIG_DIR, 'boot-config.json') : null,
    path.join(here, 'boot-config.json'),
  ].filter(Boolean);
  for (const f of candidates) {
    try { config = JSON.parse(fs.readFileSync(f, 'utf8')); break; } catch { /* next candidate */ }
  }
  if (!config) throw new Error('no boot-config.json in HERDR_PLUGIN_CONFIG_DIR or scripts/');
} catch (e) {
  console.error('[restore-layout] ' + e.message);
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

/** F05: append-only log -> newest record per workspace, so restore never rebuilds a tab twice. */
function readBootRecords() {
  try {
    if (!fs.existsSync(BOOT_FILE)) return [];
    return latestBootRecordPerWorkspace(parseBootRecords(fs.readFileSync(BOOT_FILE, 'utf8')));
  } catch {
    return [];
  }
}

/** Depth-first search for the first matching string field (handles diverse herdr envelope shapes where ID positions vary; replaces regex parsing). */
function deepFindId(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (typeof obj[key] === 'string') return obj[key];
  for (const v of Object.values(obj)) {
    const r = deepFindId(v, key, depth + 1);
    if (r) return r;
  }
  return null;
}

/** Master launch argv (D97: default fullscreen; PI_HERDR_TUI=regular escape hatch). */
function masterCommand() {
  const parts = [config.piNode, config.piCli];
  if (process.env.PI_HERDR_TUI !== 'regular') parts.push('--tui-mode', 'fullscreen');
  parts.push('-e', config.extPath);
  return parts;
}

async function relaunchInPane(paneId) {
  // Raw argv -> platform shell syntax (win32=PowerShell `&`+`''` escaping, POSIX=sh single-quote `'\''` escaping)
  const quote = (s) => (process.platform === 'win32' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`);
  const launch = (process.platform === 'win32' ? '& ' : '') + masterCommand().map(quote).join(' ');
  await request('pane.send_text', { pane_id: paneId, text: launch + '\r' });
}

async function main() {
  const records = readBootRecords();
  console.log(`[restore-layout] ${records.length} boot record(s)`);
  const panes = (await request('pane.list', {})).panes ?? [];

  for (const rec of records) {
    const wsPanes = panes.filter((p) => p.workspace_id === rec.workspace_id);
    let tab = null;
    try { tab = (await request('tab.get', { tab_id: rec.tab_id }))?.tab ?? null; } catch { /* tab gone */ }

    if (!tab) {
      // Main tab disappeared: rebuild if workspace is still alive (closing the last tab closes the workspace, so rebuild is the only remaining path)
      let ws = null;
      try { ws = (await request('workspace.get', { workspace_id: rec.workspace_id }))?.workspace ?? null; } catch { /* workspace gone */ }
      if (!ws) { console.log(`[restore-layout] ws ${rec.workspace_id} gone; skip`); continue; }
      const cwd = rec.cwd || process.cwd();
      let created = null;
      try {
        created = await request('layout.apply', {
          workspace_id: rec.workspace_id,
          tab_label: config.mainTabLabel,
          root: { type: 'pane', command: masterCommand(), cwd },
        });
      } catch (e) {
        console.error(`[restore-layout] rebuild failed: ${e.message}`);
        continue;
      }
      console.log(`[restore-layout] ws ${rec.workspace_id}: main tab rebuilt`);
      continue;
    }

    const paneAlive = wsPanes.some((p) => p.pane_id === rec.pane_id);
    if (!paneAlive) {
      // Tab exists, pane is gone -> reinject into new pane
      const anchor = wsPanes.find((p) => p.tab_id === rec.tab_id);
      if (!anchor) continue;
      try {
        await request('pane.focus', { pane_id: anchor.pane_id });
        const split = await request('pane.split', { direction: 'right', cwd: rec.cwd || undefined });
        const paneId = deepFindId(split, 'pane_id') ?? '';
        if (paneId) await relaunchInPane(paneId);
        console.log(`[restore-layout] ws ${rec.workspace_id}: master pane relaunched (${paneId})`);
      } catch (e) {
        console.error(`[restore-layout] pane rebuild failed: ${e.message}`);
      }
      continue;
    }

    // Pane is alive: not running pi (reset to raw shell) -> reinject
    const p = wsPanes.find((x) => x.pane_id === rec.pane_id);
    const isPi = p?.agent === 'pi' || (typeof p?.title === 'string' && /⏳|▶/.test(p.title));
    if (!isPi) {
      try { await relaunchInPane(rec.pane_id); console.log(`[restore-layout] ws ${rec.workspace_id}: pane ${rec.pane_id} relaunched`); }
      catch (e) { console.error(`[restore-layout] relaunch failed: ${e.message}`); }
    } else {
      console.log(`[restore-layout] ws ${rec.workspace_id}: main pane healthy; skip`);
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error('[restore-layout] ' + e.message); process.exit(1); });

#!/usr/bin/env node
/**
 * Pier Ops Dashboard entrypoint.
 *
 * Runs as a Herdr plugin pane (or CLI tool with --once).
 * Connects to Herdr's socket API, fetches session.snapshot,
 * and renders an auto-refreshing ops dashboard.
 */
import * as net from 'node:net';
import { composeDashboardLines } from '../src/dashboard-model.ts';

const args = process.argv.slice(2);
const onceMode = args.includes('--once');

const SOCKET = process.env.HERDR_SOCKET_PATH;
const TARGET = process.platform === 'win32' && SOCKET
  ? (SOCKET.startsWith('\\\\.\\pipe\\') ? SOCKET : '\\\\.\\pipe\\' + SOCKET)
  : SOCKET;

if (!SOCKET) {
  console.log(
    [
      '==================== PIER OPS DASHBOARD ==================== (standalone)',
      'No HERDR_SOCKET_PATH — offline. Inside Herdr 0.9.1, /dashboard opens the modal popup.',
      '================================================================================',
    ].join('\n'),
  );
  process.exit(0);
}

let targetWorkspaceId = null;
if (process.env.HERDR_PLUGIN_CONTEXT_JSON) {
  try {
    const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON);
    targetWorkspaceId = ctx?.workspace_id ?? null;
  } catch {
    // Ignore invalid context JSON
  }
}

function request(method, params = {}, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (!TARGET) return reject(new Error('no socket path'));
    const sock = net.createConnection(TARGET);
    sock.setEncoding('utf8');
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error(method + ' timeout'));
      }
    }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ id: 'dash-1', method, params }) + '\n'));
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
    sock.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
  });
}

async function fetchSnapshot() {
  try {
    return await request('session.snapshot', {});
  } catch {
    return null;
  }
}

async function renderOnce() {
  const snapshot = await fetchSnapshot();
  const lines = composeDashboardLines(snapshot, { targetWorkspaceId });
  console.log(lines.join('\n'));
}

async function closePopupSafe() {
  try {
    await request('popup.close', {}, 1000);
  } catch {
    // Best effort, ignore if not a popup
  }
}

async function runLoop() {
  let running = true;
  const cleanup = async () => {
    if (!running) return;
    running = false;
    await closePopupSafe();
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Enable raw keyboard handling if in an interactive terminal / popup
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (key) => {
        // 'q', 'Q', Esc ('\u001b'), Ctrl+C ('\u0003'), Enter ('\r' / '\n')
        if (key === 'q' || key === 'Q' || key === '\u001b' || key === '\u0003') {
          void cleanup();
        }
      });
    } catch {
      // Non-critical fallback if raw mode fails
    }
  }

  async function tick() {
    if (!running) return;
    const snapshot = await fetchSnapshot();
    const lines = composeDashboardLines(snapshot, { targetWorkspaceId });
    lines.push('Controls: [q / Esc] Close  [Ctrl+C] Exit');
    process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
  }

  await tick();
  const interval = setInterval(tick, 3000);
  interval.unref?.();
}

if (onceMode) {
  renderOnce().then(() => process.exit(0)).catch(() => process.exit(0));
} else {
  runLoop().catch(() => process.exit(0));
}

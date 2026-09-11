#!/usr/bin/env node
/**
 * Herdr plugin event hook: registers the Pier sidebar agent view via agent.view.set.
 *
 * Invoked on workspace/pane lifecycle events (e.g. workspace.created, pane.created).
 * Strictly best-effort: silently exits on any socket/API error so Herdr workflows are never disrupted.
 */
import * as net from 'node:net';
import { buildAgentViewSetParams } from '../src/agent-view.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const params = buildAgentViewSetParams();

if (dryRun) {
  console.log(JSON.stringify(params, null, 2));
  process.exit(0);
}

const SOCKET = process.env.HERDR_SOCKET_PATH;
if (!SOCKET) {
  process.exit(0); // Best-effort: exit silently when no socket path available
}

const TARGET = process.platform === 'win32'
  ? (SOCKET.startsWith('\\\\.\\pipe\\') ? SOCKET : '\\\\.\\pipe\\' + SOCKET)
  : SOCKET;

function request(method, params = {}, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(TARGET);
    sock.setEncoding('utf8');
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new Error('timeout'));
      }
    }, timeoutMs);
    sock.on('connect', () => sock.write(JSON.stringify({ id: 'av-1', method, params }) + '\n'));
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

// Fire and forget: best effort registration
request('agent.view.set', params)
  .then(() => process.exit(0))
  .catch(() => process.exit(0));

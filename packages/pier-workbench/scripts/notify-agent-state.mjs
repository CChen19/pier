#!/usr/bin/env node
/**
 * Herdr plugin event hook: pane.agent_status_changed -> notify when blocked.
 *
 * Invoked by Herdr when events occur; Herdr injects HERDR_PLUGIN_EVENT_JSON
 * and HERDR_SOCKET_PATH. Reads the event and sends notification.show over socket.
 *
 * Kept minimal as a one-shot process with no long-lived daemon footprint.
 */
import * as net from 'node:net';
import { buildNotificationParams } from '../src/notify.ts';

const SOCKET = process.env.HERDR_SOCKET_PATH;
const rawEvent = process.env.HERDR_PLUGIN_EVENT_JSON;

if (!rawEvent) {
  process.exit(0); // No event payload (e.g. link validation or manual dry-run), exit silently
}

let event;
try {
  event = JSON.parse(rawEvent);
} catch {
  process.exit(0);
}

const params = buildNotificationParams(event);
if (!params) {
  process.exit(0); // Gated out (not pi, not blocked, or malformed event)
}

if (!SOCKET) process.exit(2);

const TARGET = process.platform === 'win32'
  ? (SOCKET.startsWith('\\\\.\\pipe\\') ? SOCKET : '\\\\.\\pipe\\' + SOCKET)
  : SOCKET;

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(TARGET);
    sock.setEncoding('utf8');
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; sock.destroy(); reject(new Error('timeout')); } }, 5000);
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

request('notification.show', params).catch(() => process.exit(1));

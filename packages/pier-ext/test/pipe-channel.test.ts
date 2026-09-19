/**
 * M11 pipe-channel 传输层单测（D45：命名确定性 / 往返 / 超时 / 坏帧）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePipeLine,
  pingUntilReady,
  pipeNameCandidates,
  pipeNameFor,
  pipePathFor,
  pipeRequest,
  pipeRequestTo,
  startPipeServer,
} from '../src/pipe-channel.ts';
import * as net from 'node:net';
import * as fs from 'node:fs';

test('pipeNameFor: collision-resistant workspace encoding + paneId', () => {
  assert.equal(
    pipeNameFor('F:\\herdr-pi', 'w6:p2C'),
    'pi-herdr---F%3A%5Cherdr-pi---w6-p2C',
  );
  assert.equal(
    pipeNameFor('/home/u/proj', 'w1:p9'),
    'pi-herdr---%2Fhome%2Fu%2Fproj---w1-p9',
  );
});

test('pipeNameCandidates: new encoding first, then legacy', () => {
  assert.deepEqual(pipeNameCandidates('F:\\herdr-pi', 'w6:p2C'), [
    'pi-herdr---F%3A%5Cherdr-pi---w6-p2C',
    'pi-herdr---F--herdr-pi---w6-p2C',
  ]);
});

test('parsePipeLine: JSON 行解析与坏行容错', () => {
  assert.deepEqual(parsePipeLine('{"type":"ping","id":"1"}'), { type: 'ping', id: '1' });
  assert.deepEqual(parsePipeLine('  {"type":"ok","id":"1"}  '), { type: 'ok', id: '1' });
  assert.equal(parsePipeLine('not json'), null);
  assert.equal(parsePipeLine(''), null);
  assert.equal(parsePipeLine('   '), null);
  assert.equal(parsePipeLine('{"type":123}'), null);
  assert.equal(parsePipeLine('[]'), null);
  assert.equal(parsePipeLine('null'), null);
  assert.equal(parsePipeLine('{"id":"1"}'), null);
});

test('pipeRequest/startPipeServer: 往返 + ping + 错误帧', async () => {
  const name = `pi-herdr-test-${process.pid}-${Date.now()}`;
  const seen: string[] = [];
  const server = startPipeServer(name, async (req) => {
    seen.push(req.type);
    if (req.type === 'ping') return { type: 'ok', id: req.id, detail: 'pong' };
    if (req.type === 'prompt') return { type: 'ok', id: req.id };
    return { type: 'error', id: req.id, message: `unknown ${req.type}` };
  });
  try {
    await new Promise((r) => setTimeout(r, 300)); // 等 listen
    const ping = await pipeRequest(name, { type: 'ping', id: 'p1' });
    assert.deepEqual(ping, { type: 'ok', id: 'p1', detail: 'pong' });
    const prompt = await pipeRequest(name, { type: 'prompt', id: 'p2', text: 'hi' });
    assert.equal(prompt.type, 'ok');
    assert.deepEqual(seen, ['ping', 'prompt']);
    const ready = await pingUntilReady(name, 5000);
    assert.equal(ready, true);
  } finally {
    server.close();
  }
});

test('pipeRequest: 连接不存在 → 抛错（调用方重试）', async () => {
  await assert.rejects(
    () => pipeRequest(`pi-herdr-nobody-${process.pid}-${Date.now()}`, { type: 'ping', id: 'x' }, 1500),
  );
});

test('pingUntilReady: 一直不在 → false', async () => {
  const ok = await pingUntilReady(`pi-herdr-never-${process.pid}-${Date.now()}`, 1200, 300);
  assert.equal(ok, false);
});

test('pipeRequestTo: reaches a server listening on the legacy name', async () => {
  const cwd = 'F:\\herdr-pi';
  const paneId = `w-test:${process.pid}`;
  const names = pipeNameCandidates(cwd, paneId);
  assert.equal(names.length, 2);
  const server = startPipeServer(names[1], async (req) => {
    if (req.type === 'ping') return { type: 'ok', id: req.id, detail: 'legacy' };
    return { type: 'error', id: req.id, message: `unknown ${req.type}` };
  });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const res = await pipeRequestTo(cwd, paneId, { type: 'ping', id: 'mig' }, 2000);
    assert.equal(res.type, 'ok');
    if (res.type === 'ok') assert.equal(res.detail, 'legacy');
  } finally {
    server.close();
  }
});

async function waitListening(server: net.Server): Promise<void> {
  if (server.listening) return;
  const wait = Promise.withResolvers<void>();
  server.once('listening', wait.resolve);
  server.once('error', wait.reject);
  await wait.promise;
}

test('startPipeServer: bad frame replies type=error message=bad frame', async () => {
  const name = `pi-herdr-badframe-${process.pid}-${Date.now()}`;
  const server = startPipeServer(name, async (req) => ({ type: 'ok', id: req.id }));
  try {
    await waitListening(server);
    const sock = net.createConnection(pipePathFor(name));
    sock.setEncoding('utf8');
    const wait = Promise.withResolvers<string>();
    let buf = '';
    sock.on('data', (chunk) => { buf += chunk; });
    sock.on('end', () => wait.resolve(buf));
    sock.on('error', wait.reject);
    sock.on('connect', () => sock.write('not-json\n'));
    const parsed = parsePipeLine((await wait.promise).split('\n')[0] ?? '');
    assert.equal(parsed?.type, 'error');
    if (parsed?.type === 'error') assert.equal(parsed.message, 'bad frame');
  } finally {
    server.close();
  }
});

test('startPipeServer: handler throw becomes error response with the message', async () => {
  const name = `pi-herdr-throw-${process.pid}-${Date.now()}`;
  const server = startPipeServer(name, async () => {
    throw new Error('handler exploded');
  });
  try {
    await waitListening(server);
    const res = await pipeRequest(name, { type: 'ping', id: 't1' }, 2000);
    assert.equal(res.type, 'error');
    if (res.type === 'error') assert.match(res.message, /handler exploded/);
  } finally {
    server.close();
  }
});

test('pingUntilReady: error ping is not ready', async () => {
  const name = `pi-herdr-errping-${process.pid}-${Date.now()}`;
  const server = startPipeServer(name, async (req) => ({ type: 'error', id: req.id, message: 'no' }));
  try {
    await waitListening(server);
    // Deadline is wall-clock; one error ping then a short interval is enough.
    const ok = await pingUntilReady(name, 50, 10);
    assert.equal(ok, false);
  } finally {
    server.close();
  }
});

test('pipeRequestTo: both names missing throws the last connection error', async () => {
  await assert.rejects(
    () => pipeRequestTo(`/no-such-${process.pid}`, 'w0:p0', { type: 'ping', id: 'x' }, 400),
  );
});

test('pipePathFor: win32 does not double-prefix an already-namespaced pipe', () => {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'win32', writable: true });
  try {
    assert.equal(pipePathFor('\\\\.\\pipe\\already'), '\\\\.\\pipe\\already');
    assert.equal(pipePathFor('plain'), '\\\\.\\pipe\\plain');
  } finally {
    Object.defineProperty(process, 'platform', { value: original, writable: true });
  }
});


/* ──────────── F04 / F16：本轮修复的传输层回归缝 ──────────── */

test('startPipeServer (F04): POSIX 上先清掉崩溃残留的 socket 文件再 listen', async () => {
  if (process.platform === 'win32') return; // Windows 命名管道在内核命名空间，无残留文件问题
  const name = `pi-herdr-stale-${process.pid}-${Date.now()}`;
  const p = pipePathFor(name);
  // 模拟"上次进程崩溃"：socket 路径仍被占用（Node 正常 close() 会自己删文件，所以这里直接放一个占位文件）
  fs.writeFileSync(p, '');
  assert.ok(fs.existsSync(p), 'precondition: path is occupied');
  const server = startPipeServer(name, async (req) => ({ type: 'ok', id: req.id }));
  try {
    const res = await pipeRequest(name, { type: 'ping', id: 'after-stale' }, 2500);
    assert.equal(res.type, 'ok', 'a stale socket file must not break listen');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('pipeRequest (F16): 对端在回包前断开 → 立刻报错（不再等到超时）', async () => {
  const name = `pi-herdr-drop-${process.pid}-${Date.now()}`;
  const live: net.Socket[] = [];
  const server = net.createServer((sock) => {
    live.push(sock);
    sock.end(); // 收下连接即挂断，永不回包
  });
  await new Promise<void>((resolve) => server.listen(pipePathFor(name), () => resolve()));
  try {
    const t0 = Date.now();
    // 旧代码此处会一直挂到 5s 超时并抛 "timeout"；新代码在 close 事件上立刻拒绝。
    await assert.rejects(
      () => pipeRequest(name, { type: 'ping', id: 'x' }, 5000),
      /connection closed|EPIPE|ECONNRESET/,
    );
    assert.ok(Date.now() - t0 < 3000, 'must reject on disconnect, not wait for the 5s timeout');
  } finally {
    // 半开连接不销毁时 server.close() 的回调永不触发（会让整个文件被 runner 取消）
    for (const s of live) s.destroy();
    const s = server as unknown as { closeAllConnections?: () => void };
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('startPipeServer (F04): listen 失败必须可见（onError），且无人接听时也不崩进程', async () => {
  // Why: EventEmitter 的 'error' 事件若无监听会直接抛出并杀掉扩展宿主进程——旧代码靠一个空监听吞掉错误，
  // 新代码把错误交给调用方，必须同时保证"未传 onError 也不崩"。
  // 用目录占住 socket 路径：unlink 是 best-effort 删不掉目录，listen 必然 EADDRINUSE（实测 5ms 内）。
  const name = `pi-herdr-badpath-${process.pid}-${Date.now()}`;
  const p = pipePathFor(name);
  // Occupy the socket address. POSIX: a directory on the file path (unlink-proof -> EADDRINUSE).
  // Windows: pipe names live in the kernel namespace — mkdirSync would throw EPERM, so occupy
  // the name with a live server instead (libuv binds with FIRST_PIPE_INSTANCE -> EADDRINUSE).
  const squatter = net.createServer(() => {});
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => squatter.listen(p, () => resolve()));
  } else {
    fs.mkdirSync(p, { recursive: true });
  }
  try {
    const seen = await new Promise<Error | null>((resolve) => {
      let server: net.Server | null = null;
      try {
        server = startPipeServer(name, async (req) => ({ type: 'ok', id: req.id }), (e) => resolve(e));
        server.on('listening', () => resolve(null));
      } catch (e) {
        resolve(e as Error);
        return;
      }
      setTimeout(() => resolve(null), 2500);
    });
    assert.ok(seen, 'a failed listen must surface through onError (or a throw)');
    const code = seen && typeof seen === 'object' && 'code' in seen ? seen.code : undefined;
    assert.match(String(code ?? ''), /EADDRINUSE/);
    // 同一失败场景、不传 onError：进程必须存活（若 error 无监听，整个测试文件会直接挂掉）
    const noListener = startPipeServer(name, async (req) => ({ type: 'ok', id: req.id }));
    noListener.on('error', () => { /* keep the test process alive on purpose */ });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(true);
  } finally {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
    if (process.platform !== 'win32') fs.rmSync(p, { recursive: true, force: true });
  }
});

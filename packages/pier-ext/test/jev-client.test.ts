/**
 * jev 直连客户端单测（RFC docs/rfc-jev-integration.md §5/§6）。
 * 缝：fake fetch + 临时 sessionRoot——失败面（disabled/no-key/429/超时/网络/坏 JSON）
 * 全部 fail-open；遥测只落元数据不落 body。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJevRuntime } from '../src/jev-client.ts';
import type { JevConfig } from '../src/efficiency-config-core.ts';
import type { JevQuestion } from '../src/jev-core.ts';

const QUESTIONS: Record<string, JevQuestion> = {
  kind: { type: 'noul', instructions: 'Is this a test?' },
};

function config(overrides: Partial<JevConfig> = {}): JevConfig {
  return {
    enabled: true,
    logEnabled: true,
    model: 'jev-1.13.0',
    timeoutMs: 500,
    minConfidence: 0.6,
    apiKey: 'sk-test',
    ...overrides,
  };
}

function okBody(): unknown {
  return {
    model: 'jev-1.13.0',
    answers: { kind: { type: 'noul', noul: 0.9 } },
    usage: { input_tokens: 42, output_tokens: 3 },
  };
}

async function readLog(root: string): Promise<string> {
  return readFile(join(root, 'efficiency-logs', 'jev.jsonl'), 'utf8');
}

test('disabled / no-api-key：不发请求，fail-open 并记录原因', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pier-jev-'));
  let fetchCalls = 0;
  const runtime = createJevRuntime(() => config({ enabled: false }), {
    fetchImpl: () => {
      fetchCalls++;
      return Promise.resolve(new Response('{}'));
    },
    getSessionRoot: () => root,
  });
  assert.equal(runtime.available, false);
  const disabled = await runtime.ask({ state: { command: 'x' }, questions: QUESTIONS }, { questionId: 'q' });
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.equal(disabled.reason, 'disabled');

  const keyless = createJevRuntime(() => config({ apiKey: undefined }), { getSessionRoot: () => root });
  const noKey = await keyless.ask({ state: { command: 'x' }, questions: QUESTIONS }, { questionId: 'q' });
  if (!noKey.ok) assert.equal(noKey.reason, 'no-api-key');
  assert.equal(fetchCalls, 0);
  assert.match(await readLog(root), /"reason":"disabled"/);
  await rm(root, { recursive: true, force: true });
});

test('enrich 钩子：失败路径收到空答案，判定值写进遥测行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pier-jev-'));
  const outcomes: string[] = [];
  const runtime = createJevRuntime(() => config(), {
    fetchImpl: async () => new Response('{"oops"', { status: 200 }),
    getSessionRoot: () => root,
  });
  const failed = await runtime.ask({ state: 's', questions: QUESTIONS }, {
    questionId: 'q',
    enrich: ({ ok, answers }) => {
      outcomes.push(`${ok}:${answers === null}`);
      return { verdict: 'unparsed' };
    },
  });
  assert.equal(failed.ok, false);
  assert.deepEqual(outcomes, ['false:true']);
  assert.match(await readLog(root), /"verdict":"unparsed"/);
  await rm(root, { recursive: true, force: true });
});

test('成功路径：解析答案；遥测含 stateHash 不含 body 明文', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pier-jev-'));
  let seenAuth = '';
  let seenUrl = '';
  const runtime = createJevRuntime(() => config(), {
    fetchImpl: async (input, init) => {
      seenUrl = String(input);
      seenAuth = (init?.headers as Record<string, string>).Authorization ?? '';
      return new Response(JSON.stringify(okBody()), { status: 200 });
    },
    getSessionRoot: () => root,
  });
  const result = await runtime.ask({ state: { command: 'SECRET-CMD-XYZ' }, questions: QUESTIONS }, { questionId: 'epr-gate' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.answers.kind!.type, 'noul');
    assert.equal(result.model, 'jev-1.13.0');
  }
  assert.ok(seenUrl.endsWith('/v1/systemone'));
  assert.equal(seenAuth, 'Bearer sk-test');
  const log = await readLog(root);
  assert.match(log, /"questionId":"epr-gate"/);
  assert.match(log, /"verdict":"answered"/);
  assert.match(log, /"stateHash":"/);
  // Telemetry discipline: no request bodies, not even command plaintext.
  assert.ok(!log.includes('SECRET-CMD-XYZ'));
  assert.ok(!log.includes('sk-test'));
  await rm(root, { recursive: true, force: true });
});

test('429 / 网络 / 坏 JSON / 超时：一律 fail-open 带原因', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pier-jev-'));
  const mk = (fetchImpl: typeof fetch) => createJevRuntime(() => config(), { fetchImpl, getSessionRoot: () => root });

  const limited = await mk(async () => new Response('rate limited', { status: 429 }))
    .ask({ state: 's', questions: QUESTIONS }, { questionId: 'q' });
  if (!limited.ok) assert.equal(limited.reason, 'rate-limited');

  const netFail = await mk(async () => {
    throw new Error('ECONNRESET');
  }).ask({ state: 's', questions: QUESTIONS }, { questionId: 'q' });
  if (!netFail.ok) assert.equal(netFail.reason, 'network-error');

  const badJson = await mk(async () => new Response('not json', { status: 200 }))
    .ask({ state: 's', questions: QUESTIONS }, { questionId: 'q' });
  assert.equal(badJson.ok, false);

  const timed = await mk((_input, init) => {
    const { promise, reject } = Promise.withResolvers<Response>();
    init?.signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
    return promise;
  }).ask({ state: 's', questions: QUESTIONS }, { questionId: 'q' });
  if (!timed.ok) assert.equal(timed.reason, 'timeout');
  assert.match(await readLog(root), /"reason":"rate-limited"/);
  await rm(root, { recursive: true, force: true });
});

test('available getter 跟随配置重载；baseUrl 去尾斜杠', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pier-jev-'));
  const mutable = config();
  let seenUrl = '';
  const runtime = createJevRuntime(() => mutable, {
    fetchImpl: async (input) => {
      seenUrl = String(input);
      return new Response(JSON.stringify(okBody()), { status: 200 });
    },
  });
  assert.equal(runtime.available, true);
  mutable.enabled = false;
  assert.equal(runtime.available, false, 'config reload must propagate');
  mutable.enabled = true;
  mutable.baseUrl = 'https://relay.example.com/';
  await runtime.ask({ state: 's', questions: QUESTIONS }, { questionId: 'q' });
  assert.equal(seenUrl, 'https://relay.example.com/v1/systemone');
  await rm(root, { recursive: true, force: true });
});

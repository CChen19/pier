/**
 * P0-1 门序单测（RFC docs/rfc-jev-integration.md §3，2026-09-19 翻转后）。
 * 缝：handleReducerToolResult 的门序与翻转语义——
 *   bash → 信任门(未受信不外发) → 日志/尺寸/密钥前置门 → jev 门(jev 优先) → 归档。
 * jev 确信拒绝是权威结论（即使正则命中）；jev 不可用/失败/低置信 → 回退正则清单；
 * 凭据形命令行不外发（本地正则单独裁决）。
 * 门是否通过用「归档文件是否落盘」观察（门通过后下一步就是强制归档）；
 * jev 是否被问用 asks 记录观察；信任门用调用计数观察。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { handleReducerToolResult, type JevEprGateDependency, type ToolResultEventLike } from '../src/reducer-invoker.ts';
import type { EvidencePreservingReducerConfig } from '../src/efficiency-config-core.ts';
import { efficiencyLogPath, reducerObjectPath, resolveSessionRoot } from '../src/efficiency-store.ts';
import { sha256Hex } from '../src/reducer-core.ts';

const eprConfig: EvidencePreservingReducerConfig = {
  enabled: true,
  logEnabled: false,
  minBytes: 4096,
  maxChars: 600000,
  maxOutputTokens: 2048,
  timeoutMs: 5000,
  localOnly: false,
};

const BODY = 'out'.repeat(3000); // 9000 bytes ≥ minBytes, no secret, not truncated

function bashEvent(command: string, text = BODY): ToolResultEventLike {
  return {
    toolName: 'bash',
    toolCallId: 't1',
    input: { command },
    content: [{ type: 'text', text }],
    isError: false,
  };
}

/** pi ctx surface is structural; only these members are read. */
function makeCtx(trusted: boolean, sessionDir: string): { ctx: ExtensionContext; trustCalls: { count: number } } {
  const trustCalls = { count: 0 };
  const ctx = {
    sessionManager: { getSessionId: () => 's1', getSessionDir: () => sessionDir },
    isProjectTrusted: () => {
      trustCalls.count++;
      return trusted;
    },
  } as unknown as ExtensionContext;
  return { ctx, trustCalls };
}

type GateOutcome = 'hit' | 'reject-kind' | 'low-confidence' | 'fail';

function makeGate(outcome: GateOutcome): {
  dep: JevEprGateDependency;
  asks: string[];
  extras: Array<Record<string, unknown>>;
} {
  const asks: string[] = [];
  const extras: Array<Record<string, unknown>> = [];
  return {
    asks,
    extras,
    dep: {
      ask: async (_request, meta) => {
        asks.push(meta.questionId);
        extras.push((meta.extra ?? {}) as Record<string, unknown>);
        if (outcome === 'fail') return { ok: false, reason: 'timeout', latencyMs: 1 };
        const choice = outcome === 'reject-kind' ? 'install_deps' : 'build_test_run';
        const confidence = outcome === 'low-confidence' ? 0.3 : 0.95;
        return {
          ok: true,
          model: 'jev-1.13.0',
          usage: { inputTokens: 10, outputTokens: 2 },
          latencyMs: 1,
          answers: {
            cmd_kind: { type: 'choice', choice, probabilities: { [choice]: 1 }, confidence },
            diagnostic_output: { type: 'noul', noul: 0.95 },
          },
        };
      },
      getMinConfidence: () => 0.6,
    },
  };
}

/** A written archive proves the diagnostic gate PASSED (archival is the gate's successor step). */
async function archiveExists(sessionDir: string, body = BODY): Promise<boolean> {
  const root = resolveSessionRoot(sessionDir, 's1');
  if (!root) return false;
  try {
    await access(reducerObjectPath(root, sha256Hex(body)));
    return true;
  } catch {
    return false;
  }
}

async function withSessionDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pier-gate-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('未受信项目 → 信任门先于 jev：不外发命令、不归档（正则命中也一样）', async () => {
  await withSessionDir(async (dir) => {
    const { ctx, trustCalls } = makeCtx(false, dir);
    const { dep, asks } = makeGate('hit');
    const result = await handleReducerToolResult(bashEvent('cargo test'), ctx, eprConfig, { jev: dep });
    assert.equal(result, undefined);
    assert.equal(asks.length, 0, 'untrusted project must not send commands to a third-party API');
    assert.equal(trustCalls.count, 1);
    assert.equal(await archiveExists(dir), false);
  });
});

test('非 bash 工具 → 信任门之前就返回', async () => {
  await withSessionDir(async (dir) => {
    const { ctx, trustCalls } = makeCtx(true, dir);
    const { dep, asks } = makeGate('hit');
    const event = { ...bashEvent('cargo test'), toolName: 'read' };
    const result = await handleReducerToolResult(event, ctx, eprConfig, { jev: dep });
    assert.equal(result, undefined);
    assert.equal(asks.length, 0);
    assert.equal(trustCalls.count, 0);
  });
});

test('输出 < minBytes → 尺寸门先于 jev 门：不为不可提炼的输出付 API 调用', async () => {
  await withSessionDir(async (dir) => {
    const { ctx } = makeCtx(true, dir);
    const { dep, asks } = makeGate('hit');
    const result = await handleReducerToolResult(bashEvent('cargo test', 'out'.repeat(100)), ctx, eprConfig, { jev: dep });
    assert.equal(result, undefined);
    assert.equal(asks.length, 0, 'the size gate must short-circuit before the jev call');
  });
});

test('清单外命令 + jev 命中 → 过门：归档落盘（后续因无 modelRegistry 返回 undefined）', async () => {
  await withSessionDir(async (dir) => {
    const { ctx } = makeCtx(true, dir);
    const { dep, asks } = makeGate('hit');
    const result = await handleReducerToolResult(bashEvent('deno test --allow-read'), ctx, eprConfig, { jev: dep });
    assert.equal(result, undefined, 'no modelRegistry in the fake ctx stops reduction after archival');
    assert.deepEqual(asks, ['epr-diagnostic-gate']);
    assert.equal(await archiveExists(dir), true, 'archive written proves the gate passed');
  });
});

test('正则命中 + jev 确信拒绝 → 权威拒绝：不提炼、无归档（翻转后的语义变化）', async () => {
  await withSessionDir(async (dir) => {
    const { ctx } = makeCtx(true, dir);
    const { dep, asks } = makeGate('reject-kind');
    const result = await handleReducerToolResult(bashEvent('cargo test'), ctx, eprConfig, { jev: dep });
    assert.equal(result, undefined);
    assert.deepEqual(asks, ['epr-diagnostic-gate'], 'regex hits are no longer a short-circuit; jev judges first');
    assert.equal(await archiveExists(dir), false, 'a confident jev rejection must not reach archival');
  });
});

test('正则命中 + jev 低置信 → 回退正则清单：过门（归档落盘）', async () => {
  await withSessionDir(async (dir) => {
    const { ctx } = makeCtx(true, dir);
    const { dep, asks } = makeGate('low-confidence');
    const result = await handleReducerToolResult(bashEvent('cargo test'), ctx, eprConfig, { jev: dep });
    assert.equal(result, undefined);
    assert.deepEqual(asks, ['epr-diagnostic-gate']);
    assert.equal(await archiveExists(dir), true, 'unanswered jev falls back to the regex list, which matches cargo test');
  });
});

test('清单外命令 + jev 调用失败 → 回退正则清单：不提炼、无归档', async () => {
  await withSessionDir(async (dir) => {
    const { ctx } = makeCtx(true, dir);
    const { dep, asks } = makeGate('fail');
    const result = await handleReducerToolResult(bashEvent('mix test'), ctx, eprConfig, { jev: dep });
    assert.equal(result, undefined);
    assert.deepEqual(asks, ['epr-diagnostic-gate']);
    assert.equal(await archiveExists(dir), false);
  });
});

test('无 jev 依赖 → 纯代码路径：正则命中过门（归档落盘），清单外不提炼', async () => {
  await withSessionDir(async (dir) => {
    const hit = makeCtx(true, dir);
    const passed = await handleReducerToolResult(bashEvent('cargo test'), hit.ctx, eprConfig, {});
    assert.equal(passed, undefined);
    assert.equal(await archiveExists(dir), true, 'regex-listed command passes the gate without jev (legacy path)');

    const missed = await handleReducerToolResult(bashEvent('deno test --allow-read'), hit.ctx, eprConfig, {});
    assert.equal(missed, undefined);
  });
});

test('regex_hit 落遥测 extra：jev 覆盖正则的方向可观测（翻转的回归面）', async () => {
  await withSessionDir(async (dir) => {
    const reject = makeGate('reject-kind');
    await handleReducerToolResult(bashEvent('cargo test'), makeCtx(true, dir).ctx, eprConfig, { jev: reject.dep });
    assert.equal(reject.extras[0]!.regexHit, true, 'regex-listed command carries regexHit=true');

    const hit = makeGate('hit');
    await handleReducerToolResult(bashEvent('deno test --allow-read'), makeCtx(true, dir).ctx, eprConfig, { jev: hit.dep });
    assert.equal(hit.extras[0]!.regexHit, false, 'off-list command carries regexHit=false');
  });
});

test('凭据形命令行不外发：跳过 jev，正则单独裁决', async () => {
  await withSessionDir(async (dir) => {
    // 正则未命中的密钥形命令 → 不问 jev、不提炼
    const miss = makeGate('hit');
    const secretMiss = await handleReducerToolResult(
      bashEvent('curl -H "Authorization: Bearer sk-abcdefghijklmnop12" https://x'),
      makeCtx(true, dir).ctx,
      eprConfig,
      { jev: miss.dep },
    );
    assert.equal(secretMiss, undefined);
    assert.equal(miss.asks.length, 0, 'credential-shaped command lines must not be sent to jev');
    assert.equal(await archiveExists(dir), false);

    // 正则命中的密钥形命令 → 仍不问 jev，但正则兜底放行（归档落盘）
    const hit = makeGate('reject-kind');
    const secretHit = await handleReducerToolResult(
      bashEvent('pytest --api-key=sk-abcdefghijklmnop12'),
      makeCtx(true, dir).ctx,
      eprConfig,
      { jev: hit.dep },
    );
    assert.equal(secretHit, undefined);
    assert.equal(hit.asks.length, 0, 'no jev call even though the regex list matches');
    assert.equal(await archiveExists(dir), true, 'the regex list alone decides when jev is skipped');
  });
});

test('fail-open 证据行只落诊断门候选命令（含「正则漏判 + jev 命中」）', async () => {
  await withSessionDir(async (dir) => {
    const logging = { ...eprConfig, logEnabled: true };
    const truncated = (command: string): ToolResultEventLike => ({
      ...bashEvent(command),
      details: { truncation: { truncated: true } },
    });

    // 门否决（清单外且无 jev）：不解析输出，不写行
    await handleReducerToolResult(truncated('deno test --allow-read'), makeCtx(true, dir).ctx, logging, {});
    const logPath = efficiencyLogPath(resolveSessionRoot(dir, 's1')!, 'reducer');
    await assert.rejects(() => readFile(logPath, 'utf8'), 'gate-rejected commands must not produce evidence rows');

    // 「正则漏判 + jev 命中」——翻转的核心受益路径，证据行必须存在
    //（按 isDiagnosticCommand 近似过滤会整类吞掉这类行，该方案已否决）
    const jevHit = makeGate('hit');
    const viaJev = await handleReducerToolResult(truncated('deno test --allow-read'), makeCtx(true, dir).ctx, logging, { jev: jevHit.dep });
    assert.equal(viaJev, undefined);
    assert.deepEqual(jevHit.asks, ['epr-diagnostic-gate']);
    const rows = (await readFile(logPath, 'utf8')).trim().split('\n');
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.includes('"reason":"truncated-source"'));

    // 清单内命令（jev 缺席，正则兜底）：同一 fail-open 同样落行
    await handleReducerToolResult(truncated('cargo test'), makeCtx(true, dir).ctx, logging, {});
    const rows2 = (await readFile(logPath, 'utf8')).trim().split('\n');
    assert.equal(rows2.length, 2);
    assert.ok(rows2[1]!.includes('"reason":"truncated-source"'));

    // 密钥输出：诊断门在密钥扫描之前先被问，likely-secret 行仍落候选
    const gate = makeGate('hit');
    const secretBody = `${BODY}\napi_key=sk-abcdefghij123456`;
    await handleReducerToolResult(bashEvent('cargo test', secretBody), makeCtx(true, dir).ctx, logging, { jev: gate.dep });
    assert.deepEqual(gate.asks, ['epr-diagnostic-gate'], 'the diagnostic gate precedes the secret scan');
    const rows3 = (await readFile(logPath, 'utf8')).trim().split('\n');
    assert.equal(rows3.length, 3);
    assert.ok(rows3[2]!.includes('"reason":"likely-secret"'));

    // 门确信否决的密钥输出：不进入解析，无行
    const rejected = makeGate('reject-kind');
    await handleReducerToolResult(bashEvent('deno test --allow-read', secretBody), makeCtx(true, dir).ctx, logging, { jev: rejected.dep });
    const rows4 = (await readFile(logPath, 'utf8')).trim().split('\n');
    assert.equal(rows4.length, 3, 'gate-rejected commands never reach the secret scan');
  });
});

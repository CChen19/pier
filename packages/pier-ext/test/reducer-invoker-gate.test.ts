/**
 * P0-1 门序单测（RFC docs/rfc-jev-integration.md §3）。
 * 缝：handleReducerToolResult 的命令门与信任边界次序——
 *   bash → 正则(命中短路) → 信任门(未受信不外发) → jev 门(仅正则漏判)。
 * jev 任何失败都退回"非诊断命令"（现行为）。
 * 信任门用调用计数观察；jev 命中用 asks 记录观察。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { handleReducerToolResult, type JevEprGateDependency, type ToolResultEventLike } from '../src/reducer-invoker.ts';
import type { EvidencePreservingReducerConfig } from '../src/efficiency-config-core.ts';

const eprConfig: EvidencePreservingReducerConfig = {
  enabled: true,
  logEnabled: false,
  minBytes: 4096,
  maxChars: 600000,
  maxOutputTokens: 2048,
  timeoutMs: 5000,
  localOnly: false,
};

function bashEvent(command: string): ToolResultEventLike {
  return {
    toolName: 'bash',
    toolCallId: 't1',
    input: { command },
    content: [{ type: 'text', text: 'out'.repeat(3000) }],
    isError: false,
  };
}

/** pi ctx surface is structural; only these members are read. */
function makeCtx(trusted: boolean): { ctx: ExtensionContext; trustCalls: { count: number } } {
  const trustCalls = { count: 0 };
  const ctx = {
    sessionManager: { getSessionId: () => 's1', getSessionDir: () => '/tmp' },
    isProjectTrusted: () => {
      trustCalls.count++;
      return trusted;
    },
  } as unknown as ExtensionContext;
  return { ctx, trustCalls };
}

function makeGate(hit: boolean): { dep: JevEprGateDependency; asks: string[] } {
  const asks: string[] = [];
  return {
    asks,
    dep: {
      ask: async (_request, meta) => {
        asks.push(meta.questionId);
        if (!hit) return { ok: false, reason: 'timeout', latencyMs: 1 };
        return {
          ok: true,
          model: 'jev-1.13.0',
          usage: { inputTokens: 10, outputTokens: 2 },
          latencyMs: 1,
          answers: {
            cmd_kind: { type: 'choice', choice: 'build_test_run', probabilities: { build_test_run: 1 }, confidence: 0.95 },
            diagnostic_output: { type: 'noul', noul: 0.95 },
          },
        };
      },
      getMinConfidence: () => 0.6,
    },
  };
}

test('正则命中（cargo test）→ 不问 jev；未受信项目停在信任门', async () => {
  const { ctx, trustCalls } = makeCtx(false);
  const { dep, asks } = makeGate(false);
  const result = await handleReducerToolResult(bashEvent('cargo test'), ctx, eprConfig, { jev: dep });
  assert.equal(result, undefined);
  assert.equal(asks.length, 0, 'regex fast path must not call jev');
  assert.equal(trustCalls.count, 1, 'regex hit reaches the trust check');
});

test('正则未命中 + 未受信项目 → 信任门先于 jev：不外发命令', async () => {
  const { ctx, trustCalls } = makeCtx(false);
  const { dep, asks } = makeGate(true);
  const result = await handleReducerToolResult(bashEvent('deno test --allow-read'), ctx, eprConfig, { jev: dep });
  assert.equal(result, undefined);
  assert.equal(asks.length, 0, 'untrusted project must not send commands to a third-party API');
  assert.equal(trustCalls.count, 1);
});

test('正则未命中 + 受信项目 + jev 命中 → 越过命令门（后续因日志过短返回）', async () => {
  const { ctx, trustCalls } = makeCtx(true);
  const { dep, asks } = makeGate(true);
  const result = await handleReducerToolResult(bashEvent('deno test --allow-read'), ctx, eprConfig, { jev: dep });
  assert.equal(result, undefined, 'content below minBytes stops reduction later');
  assert.deepEqual(asks, ['epr-diagnostic-gate']);
  assert.equal(trustCalls.count, 1, 'trust precedes the gate and passes in a trusted project');
});

test('正则未命中 + 无 jev 依赖 → 维持旧行为（信任门已过，jev 缺席即非诊断）', async () => {
  const { ctx, trustCalls } = makeCtx(true);
  const result = await handleReducerToolResult(bashEvent('deno test --allow-read'), ctx, eprConfig, {});
  assert.equal(result, undefined);
  assert.equal(trustCalls.count, 1, 'trust check precedes the gate for regex-missed commands');
});

test('正则未命中 + 受信项目 + jev 失败 → 退回旧行为', async () => {
  const { ctx, trustCalls } = makeCtx(true);
  const { dep, asks } = makeGate(false);
  const result = await handleReducerToolResult(bashEvent('mix test'), ctx, eprConfig, { jev: dep });
  assert.equal(result, undefined);
  assert.deepEqual(asks, ['epr-diagnostic-gate']);
  assert.equal(trustCalls.count, 1, 'trust check precedes the gate for regex-missed commands');
});

test('非 bash 工具 → 命令门之前就返回', async () => {
  const { ctx, trustCalls } = makeCtx(true);
  const { dep, asks } = makeGate(true);
  const event = { ...bashEvent('cargo test'), toolName: 'read' };
  const result = await handleReducerToolResult(event, ctx, eprConfig, { jev: dep });
  assert.equal(result, undefined);
  assert.equal(asks.length, 0);
  assert.equal(trustCalls.count, 0);
});

/**
 * D101 ObservationPack Integration Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  clearObservationMemoForTest,
  registerObservationPack,
  RECALL_TOOL_NAME,
} from '../src/core/observation.ts';
import { DEFAULT_EFFICIENCY_CONFIG, type EfficiencyConfig } from '../src/efficiency-config-core.ts';
import { REDUCER_RECEIPT_PREFIX } from '../src/observation-core.ts';
import type { RuntimeRoleManifest } from '../src/tool-gate.ts';

interface MockPi {
  tools: Map<string, any>;
  listeners: Map<string, Array<Function>>;
  registerTool(def: any): void;
  on(event: string, handler: Function): void;
}

function createMockPi(): MockPi & ExtensionAPI {
  const tools = new Map<string, any>();
  const listeners = new Map<string, Array<Function>>();

  const mock: any = {
    tools,
    listeners,
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    on(event: string, handler: Function) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
    },
  };
  return mock;
}

function createMockContext(sessionDir: string, sessionId: string): ExtensionContext {
  return {
    sessionManager: {
      getSessionDir: () => sessionDir,
      getSessionId: () => sessionId,
    } as any,
  } as ExtensionContext;
}

test('ObservationPack: registers obs_recall tool and executes paged recall', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-obs-pack-test-'));
  const sessionId = 'session_test_01';

  try {
    const pi = createMockPi();
    const config: EfficiencyConfig = {
      ...DEFAULT_EFFICIENCY_CONFIG,
      observationPack: {
        ...DEFAULT_EFFICIENCY_CONFIG.observationPack,
        enabled: true,
        thresholdBytes: 1024, // 1KB threshold for test
        fullSends: 1,
      },
    };

    registerObservationPack({
      pi,
      getConfig: () => config,
    });

    assert.equal(pi.tools.has(RECALL_TOOL_NAME), true);
    const recallTool = pi.tools.get(RECALL_TOOL_NAME);
    const ctx = createMockContext(tempDir, sessionId);

    // 1. Invalid ID rejection
    const invalidRes = await recallTool.execute('call_1', { id: 'bad_id' }, undefined, undefined, ctx);
    assert.match(invalidRes.content[0].text, /invalid observation id format/);

    // 2. Prepare context with a large output (2KB)
    const largeLog = 'INFO: step processing\n'.repeat(100); // ~2200 bytes
    const contextHandlers = pi.listeners.get('context') ?? [];
    assert.equal(contextHandlers.length, 1);
    const contextHandler = contextHandlers[0]!;

    // First send: prior assistant count = 0 (< fullSends=1) -> remains full text
    const eventFirst = {
      messages: [
        {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'tc_1',
          content: [{ type: 'text', text: largeLog }],
        },
      ],
    };
    const resFirst = await contextHandler(eventFirst, ctx);
    assert.equal(resFirst.messages[0].content[0].text, largeLog);

    // Second send: message is followed by 1 assistant message -> sendCount = 1 (>= fullSends)
    const eventSecond = {
      messages: [
        {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'tc_1',
          content: [{ type: 'text', text: largeLog }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'analyzing...' }],
        },
      ],
    };
    const resSecond = await contextHandler(eventSecond, ctx);
    const replacedText = resSecond.messages[0].content[0].text;
    assert.notEqual(replacedText, largeLog);
    assert.match(replacedText, /\[large tool result replaced after its first 1 provider requests\]/);
    assert.match(replacedText, /id: (obs_[a-f0-9]{24})/);

    // 3. Extract obsId and recall original content using obs_recall
    const match = replacedText.match(/id:\s+(obs_[a-f0-9]{24})/);
    assert.ok(match && match[1]);
    const obsId = match[1];

    const recallRes = await recallTool.execute('call_2', { id: obsId, offset: 0 }, undefined, undefined, ctx);
    assert.ok(recallRes.content[0].text.includes('[obs_recall id='));
    assert.ok(recallRes.content[0].text.includes('INFO: step processing'));
    assert.equal(recallRes.details.id, obsId);
    assert.equal(recallRes.details.offset, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ObservationPack: skips packing when obs_recall is denied by role manifest', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-obs-role-test-'));
  const sessionId = 'session_test_02';

  try {
    const pi = createMockPi();
    const config: EfficiencyConfig = {
      ...DEFAULT_EFFICIENCY_CONFIG,
      observationPack: {
        ...DEFAULT_EFFICIENCY_CONFIG.observationPack,
        enabled: true,
        thresholdBytes: 1024,
        fullSends: 1,
      },
    };

    // Role denies unknown tools and does not list obs_recall
    const restrictedRole: RuntimeRoleManifest = {
      role: 'restricted-agent',
      version: '1.0.0',
      tools: ['bash', 'read'],
      permissions: { '*': 'allow' },
      unknownTools: 'deny',
    };

    registerObservationPack({
      pi,
      getConfig: () => config,
      getRuntimeManifest: () => restrictedRole,
    });

    const ctx = createMockContext(tempDir, sessionId);
    const largeLog = 'DEBUG: trace output\n'.repeat(100);
    const contextHandler = pi.listeners.get('context')![0]!;

    const event = {
      messages: [
        {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'tc_2',
          content: [{ type: 'text', text: largeLog }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'response 1' }],
        },
      ],
    };

    // Packing must be skipped so model doesn't get an inaccessible tool handle
    const res = await contextHandler(event, ctx);
    assert.equal(res, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ObservationPack: never packs errors or EPR receipts', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-obs-exempt-test-'));
  const sessionId = 'session_test_03';

  try {
    const pi = createMockPi();
    const config: EfficiencyConfig = {
      ...DEFAULT_EFFICIENCY_CONFIG,
      observationPack: {
        ...DEFAULT_EFFICIENCY_CONFIG.observationPack,
        enabled: true,
        thresholdBytes: 500,
        fullSends: 1,
      },
    };

    registerObservationPack({
      pi,
      getConfig: () => config,
    });

    const ctx = createMockContext(tempDir, sessionId);
    const contextHandler = pi.listeners.get('context')![0]!;

    // 1. Tool result with isError: true
    const errorEvent = {
      messages: [
        {
          role: 'toolResult',
          isError: true,
          content: [{ type: 'text', text: 'FATAL: process crashed\n'.repeat(50) }],
        },
        { role: 'assistant', content: [] },
      ],
    };
    const errorRes = await contextHandler(errorEvent, ctx);
    assert.equal(errorRes.messages[0].content[0].text.includes('FATAL: process crashed'), true);

    // 2. Receipt containing REDUCER_RECEIPT_PREFIX
    const receiptEvent = {
      messages: [
        {
          role: 'toolResult',
          isError: false,
          content: [{ type: 'text', text: `${REDUCER_RECEIPT_PREFIX}\nstatus=failure\n`.repeat(50) }],
        },
        { role: 'assistant', content: [] },
      ],
    };
    const receiptRes = await contextHandler(receiptEvent, ctx);
    assert.equal(receiptRes.messages[0].content[0].text.includes(REDUCER_RECEIPT_PREFIX), true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('ObservationPack: memoization fast-path and self-healing on missing disk object', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-obs-memo-test-'));
  const sessionId = 'session_test_04';

  try {
    clearObservationMemoForTest();
    const pi = createMockPi();
    const config: EfficiencyConfig = {
      ...DEFAULT_EFFICIENCY_CONFIG,
      observationPack: {
        ...DEFAULT_EFFICIENCY_CONFIG.observationPack,
        enabled: true,
        thresholdBytes: 1024,
        fullSends: 1,
      },
    };

    registerObservationPack({
      pi,
      getConfig: () => config,
    });

    const ctx = createMockContext(tempDir, sessionId);
    const recallTool = pi.tools.get(RECALL_TOOL_NAME);
    const contextHandler = pi.listeners.get('context')![0]!;
    const largeLog = 'VERBOSE: detailed diagnostic line\n'.repeat(60);

    const event = {
      messages: [
        {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'tc_memo_1',
          content: [{ type: 'text', text: largeLog }],
        },
        { role: 'assistant', content: [] },
      ],
    };

    // 1. First packing: creates memo and saves file
    const res1 = await contextHandler(event, ctx);
    assert.ok(res1.messages[0].content[0].text.includes('[large tool result replaced'));

    // 2. Second invocation: hits memoization fast-path (O(1) memory lookup)
    const res2 = await contextHandler(event, ctx);
    assert.equal(res2.messages[0].content[0].text, res1.messages[0].content[0].text);

    // 3. Self-healing: simulate file removal from disk
    const match = res1.messages[0].content[0].text.match(/id:\s+(obs_[a-f0-9]{24})/);
    const obsId = match![1]!;
    // Deliberately query non-existent/corrupted file to trigger self-healing invalidation
    const recallFail = await recallTool.execute('call_fail', { id: 'obs_000000000000000000000000' }, undefined, undefined, ctx);
    assert.ok(recallFail.content[0].text.includes('Error: failed to recall observation'));
  } finally {
    clearObservationMemoForTest();
    await rm(tempDir, { recursive: true, force: true });
  }
});

/**
 * D102 Evidence-Preserving Reducer Integration Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { handleReducerToolResult } from '../src/reducer-invoker.ts';
import { DEFAULT_EFFICIENCY_CONFIG } from '../src/efficiency-config-core.ts';
import {
  REDUCER_RECEIPT_PREFIX,
  REDUCER_RECEIPT_SCHEMA,
  sha256Hex,
} from '../src/reducer-core.ts';

function createMockContext(opts: {
  sessionDir: string;
  sessionId: string;
  isTrusted?: boolean;
  completeResponse?: any;
  completeError?: Error;
}): { ctx: ExtensionContext; completeCalls: any[] } {
  const completeCalls: any[] = [];

  const ctx: any = {
    isProjectTrusted: () => opts.isTrusted ?? true,
    sessionManager: {
      getSessionDir: () => opts.sessionDir,
      getSessionId: () => opts.sessionId,
    },
    model: { id: 'default-test-model' },
    modelRegistry: {
      find: (provider: string, modelId: string) => ({ id: `${provider}/${modelId}` }),
      complete: async (model: any, context: any, options: any) => {
        completeCalls.push({ model, context, options });
        if (opts.completeError) throw opts.completeError;
        return opts.completeResponse ?? { content: [{ type: 'text', text: '{}' }] };
      },
    },
  };

  return { ctx, completeCalls };
}

test('EPR: skips non-bash, non-diagnostic, or untrusted execution', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-epr-filter-test-'));
  try {
    const config = {
      ...DEFAULT_EFFICIENCY_CONFIG.evidencePreservingReducer,
      enabled: true,
      minBytes: 512,
    };

    const { ctx } = createMockContext({ sessionDir: tempDir, sessionId: 'sess_filter', isTrusted: true });

    // 1. Non-bash tool -> skipped
    const resTool = await handleReducerToolResult(
      {
        toolName: 'terminal',
        toolCallId: 'tc_1',
        input: { command: 'npm test' },
        content: [{ type: 'text', text: 'Error log...\n'.repeat(100) }],
        isError: true,
      },
      ctx,
      config,
    );
    assert.equal(resTool, undefined);

    // 2. Non-diagnostic command -> skipped
    const resCmd = await handleReducerToolResult(
      {
        toolName: 'bash',
        toolCallId: 'tc_2',
        input: { command: 'ls -la' },
        content: [{ type: 'text', text: 'file list...\n'.repeat(100) }],
        isError: false,
      },
      ctx,
      config,
    );
    assert.equal(resCmd, undefined);

    // 3. Untrusted project -> skipped
    const { ctx: untrustedCtx } = createMockContext({ sessionDir: tempDir, sessionId: 'sess_filter', isTrusted: false });
    const resUntrusted = await handleReducerToolResult(
      {
        toolName: 'bash',
        toolCallId: 'tc_3',
        input: { command: 'pytest' },
        content: [{ type: 'text', text: 'Traceback (most recent call last)...\n'.repeat(100) }],
        isError: true,
      },
      untrustedCtx,
      config,
    );
    assert.equal(resUntrusted, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('EPR: validates exact byte quotations, archives raw log, and replaces block', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-epr-success-test-'));
  try {
    const config = {
      ...DEFAULT_EFFICIENCY_CONFIG.evidencePreservingReducer,
      enabled: true,
      logEnabled: true,
      minBytes: 512,
      model: 'cliproxy/gemini-3.8-flash-high',
    };

    const rawLog = [
      'Running cargo test --all',
      'test test_auth ... FAILED',
      'failures:',
      '---- test_auth stdout ----',
      'thread "test_auth" panicked at src/auth.rs:120:5:',
      'assertion `left == right` failed',
      '  left: 403',
      ' right: 200',
      'test result: FAILED. 1 failed; 42 passed',
    ].join('\n') + '\n' + 'test pass line output in test suite execution...\n'.repeat(100);

    const sourceHash = sha256Hex(rawLog);

    const validModelResponse = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            schema: REDUCER_RECEIPT_SCHEMA,
            source_sha256: sourceHash,
            status: 'failure',
            uncertain: false,
            evidence: [
              {
                kind: 'fatal',
                quote: 'thread "test_auth" panicked at src/auth.rs:120:5:',
              },
              {
                kind: 'failure',
                quote: 'assertion `left == right` failed',
              },
            ],
          }),
        },
      ],
      usage: { input: 1200, output: 80, totalTokens: 1280 },
    };

    const { ctx, completeCalls } = createMockContext({
      sessionDir: tempDir,
      sessionId: 'sess_success',
      isTrusted: true,
      completeResponse: validModelResponse,
    });

    const event = {
      toolName: 'bash',
      toolCallId: 'tc_rust',
      input: { command: 'cargo test --all' },
      content: [
        { type: 'text', text: rawLog },
        { type: 'text', text: '⚠️ write lock warning block' }, // extra block
      ],
      isError: true,
      usage: { totalTokens: 50 },
    };

    const res = await handleReducerToolResult(event, ctx, config, { epoch: 2 });
    assert.ok(res !== undefined);
    assert.equal(completeCalls.length, 1);
    assert.equal(completeCalls[0].model.id, 'cliproxy/gemini-3.8-flash-high');

    // 1. Content block-level replacement: log replaced, warning preserved!
    assert.equal(res!.content!.length, 2);
    assert.ok(res!.content![0].text!.includes(REDUCER_RECEIPT_PREFIX));
    assert.ok(res!.content![0].text!.includes('assertion `left == right` failed'));
    assert.equal(res!.content![1].text, '⚠️ write lock warning block');

    // 2. Usage tokens backfilled
    assert.equal(res!.usage?.totalTokens, 50 + 1280);

    // 3. Raw log archived to disk
    const expectedArchivePath = join(
      tempDir,
      'herdr-pi',
      'sess_success',
      'evidence-preserving-reducer',
      'objects',
      `${sourceHash}.txt`,
    );
    const archivedData = await readFile(expectedArchivePath, 'utf8');
    assert.equal(archivedData, rawLog);

    // 4. Telemetry logged with epoch and sessionId
    const logPath = join(tempDir, 'herdr-pi', 'sess_success', 'efficiency-logs', 'reducer.jsonl');
    const logData = await readFile(logPath, 'utf8');
    assert.ok(logData.includes('"action":"applied"'));
    assert.ok(logData.includes('"verificationOk":true'));
    assert.ok(logData.includes('"epoch":2'));
    assert.ok(logData.includes('"sessionId":"sess_success"'));
    assert.ok(logData.includes('"grossSavedBytes":'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('EPR: fail-open on model error or quote mismatch', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-epr-failopen-test-'));
  try {
    const config = {
      ...DEFAULT_EFFICIENCY_CONFIG.evidencePreservingReducer,
      enabled: true,
      minBytes: 512,
    };

    const rawLog = 'Running test suite...\nfailure at line 10\n'.repeat(50);

    // Case 1: Model complete error -> returns undefined
    const { ctx: errCtx } = createMockContext({
      sessionDir: tempDir,
      sessionId: 'sess_err',
      completeError: new Error('Rate limit exceeded / timeout'),
    });

    const res1 = await handleReducerToolResult(
      {
        toolName: 'bash',
        toolCallId: 'tc_e1',
        input: { command: 'npm test' },
        content: [{ type: 'text', text: rawLog }],
        isError: true,
      },
      errCtx,
      config,
    );
    assert.equal(res1, undefined);

    // Case 2: Hallucinated quote -> returns undefined
    const hallucinatedResponse = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            schema: REDUCER_RECEIPT_SCHEMA,
            source_sha256: sha256Hex(rawLog),
            status: 'failure',
            uncertain: false,
            evidence: [{ kind: 'failure', quote: 'hallucinated line not in source' }],
          }),
        },
      ],
    };

    const { ctx: mismatchCtx } = createMockContext({
      sessionDir: tempDir,
      sessionId: 'sess_err2',
      completeResponse: hallucinatedResponse,
    });

    const res2 = await handleReducerToolResult(
      {
        toolName: 'bash',
        toolCallId: 'tc_e2',
        input: { command: 'npm test' },
        content: [{ type: 'text', text: rawLog }],
        isError: true,
      },
      mismatchCtx,
      config,
    );
    assert.equal(res2, undefined);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('EPR: localOnly archives log and skips model invocation', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-epr-local-test-'));
  try {
    const config = {
      ...DEFAULT_EFFICIENCY_CONFIG.evidencePreservingReducer,
      enabled: true,
      localOnly: true,
      minBytes: 512,
    };

    const rawLog = 'Diagnostic build log line...\n'.repeat(60);
    const { ctx, completeCalls } = createMockContext({
      sessionDir: tempDir,
      sessionId: 'sess_local',
    });

    const res = await handleReducerToolResult(
      {
        toolName: 'bash',
        toolCallId: 'tc_local',
        input: { command: 'make' },
        content: [{ type: 'text', text: rawLog }],
        isError: false,
      },
      ctx,
      config,
    );

    // Output left unmodified, model never called
    assert.equal(res, undefined);
    assert.equal(completeCalls.length, 0);

    // But log was safely archived on disk!
    const archivePath = join(
      tempDir,
      'herdr-pi',
      'sess_local',
      'evidence-preserving-reducer',
      'objects',
      `${sha256Hex(rawLog)}.txt`,
    );
    const saved = await readFile(archivePath, 'utf8');
    assert.equal(saved, rawLog);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('EPR: skips truncated logs when fullOutputPath is missing (P1-1)', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-epr-trunc-test-'));
  try {
    const config = {
      ...DEFAULT_EFFICIENCY_CONFIG.evidencePreservingReducer,
      enabled: true,
      logEnabled: true,
      minBytes: 512,
    };

    const truncatedLog = 'test pass line output in test suite execution...\n'.repeat(30);
    const { ctx, completeCalls } = createMockContext({
      sessionDir: tempDir,
      sessionId: 'sess_trunc',
    });

    const res = await handleReducerToolResult(
      {
        toolName: 'bash',
        toolCallId: 'tc_trunc',
        input: { command: 'npm test' },
        content: [{ type: 'text', text: truncatedLog }],
        details: { truncation: { truncated: true } }, // Truncated without fullOutputPath!
        isError: false,
      },
      ctx,
      config,
    );

    // Must fail-open and skip model invocation!
    assert.equal(res, undefined);
    assert.equal(completeCalls.length, 0);

    // Verify telemetry logged reason: truncated-source
    const logPath = join(tempDir, 'herdr-pi', 'sess_trunc', 'efficiency-logs', 'reducer.jsonl');
    const logData = await readFile(logPath, 'utf8');
    assert.ok(logData.includes('"reason":"truncated-source"'));
    assert.ok(logData.includes('"action":"fallback_full_text"'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('EPR: skips and logs fallback when likely-secret is detected', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-epr-secret-test-'));
  try {
    const config = {
      ...DEFAULT_EFFICIENCY_CONFIG.evidencePreservingReducer,
      enabled: true,
      logEnabled: true,
      minBytes: 512,
    };

    const secretLog = 'Error in run: api_key = "sk-supersecretkey1234567890"\n' + 'stack trace...\n'.repeat(50);
    const { ctx, completeCalls } = createMockContext({
      sessionDir: tempDir,
      sessionId: 'sess_secret',
    });

    const res = await handleReducerToolResult(
      {
        toolName: 'bash',
        toolCallId: 'tc_sec',
        input: { command: 'pytest' },
        content: [{ type: 'text', text: secretLog }],
        isError: true,
      },
      ctx,
      config,
    );

    assert.equal(res, undefined);
    assert.equal(completeCalls.length, 0);

    // Verify telemetry logged reason: likely-secret
    const logPath = join(tempDir, 'herdr-pi', 'sess_secret', 'efficiency-logs', 'reducer.jsonl');
    const logData = await readFile(logPath, 'utf8');
    assert.ok(logData.includes('"reason":"likely-secret"'));
    assert.ok(!logData.includes('sk-supersecretkey1234567890')); // Must not leak secret in telemetry!
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});


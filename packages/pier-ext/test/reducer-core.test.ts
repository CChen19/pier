/**
 * D102 Evidence-Preserving Reducer Core Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  containsLikelySecret,
  formatReceiptText,
  isDiagnosticCommand,
  REDUCER_RECEIPT_PREFIX,
  REDUCER_RECEIPT_SCHEMA,
  sha256Hex,
  validateReceipt,
} from '../src/reducer-core.ts';

test('isDiagnosticCommand: detects test and build commands correctly', () => {
  assert.equal(isDiagnosticCommand('npm test'), true);
  assert.equal(isDiagnosticCommand('pnpm test --run'), true);
  assert.equal(isDiagnosticCommand('cargo test --all'), true);
  assert.equal(isDiagnosticCommand('pytest tests/'), true);
  assert.equal(isDiagnosticCommand('node --test "test/*.test.ts"'), true);
  assert.equal(isDiagnosticCommand('vitest run'), true);
  assert.equal(isDiagnosticCommand('make build'), true);

  assert.equal(isDiagnosticCommand('ls -la'), false);
  assert.equal(isDiagnosticCommand('git status'), false);
  assert.equal(isDiagnosticCommand('echo "done"'), false);
});

test('isDiagnosticCommand: pins every alternation, separator and word boundary', () => {
  // Every top-level alternation of DIAGNOSTIC_COMMAND must be reachable.
  for (const cmd of [
    'lake build',
    'lake env lean Foo.lean',
    'lean --run Main.lean',
    'coq top',
    'cargo build --release',
    'cargo check',
    'zig build -Doptimize=ReleaseFast',
    'python -m pytest tests',
    'python3 -m unittest discover',
    'python3 -m py_compile main.py',
    'ctest --output-on-failure',
    'cmake --build build',
    'ninja all',
    'go test ./...',
    'bazel test //pkg:all',
    'yarn test --watch=false',
  ]) {
    assert.equal(isDiagnosticCommand(cmd), true, cmd);
  }

  // Separators in the leading class: ; & | ( ) whitespace.
  for (const cmd of ['make test', 'echo hi && cargo test', 'true; pytest -q', '(npm test)', 'a | jest', 'x&vitest run']) {
    assert.equal(isDiagnosticCommand(cmd), true, cmd);
  }

  // Word boundaries: a diagnostic word must not match inside a longer word.
  for (const cmd of ['makefile targets', 'makeup kit', 'leaning tower', 'coqtop -q', 'golist all', 'jesting around', 'npm run test']) {
    assert.equal(isDiagnosticCommand(cmd), false, cmd);
  }
});

test('formatReceiptText: newline-separated lines and a placeholder for unknown line numbers', () => {
  const receipt = formatReceiptText({
    command: 'npm test',
    sourceHash: 'a'.repeat(64),
    sourceBytes: 100,
    sourceLines: 3,
    sourceArtifactPath: '/tmp/artifact.txt',
    model: 'test-model',
    validated: {
      status: 'failure',
      uncertain: false,
      evidence: [
        { kind: 'fatal', line: undefined, quote: 'boom', quoteSha256: 'b'.repeat(64) },
        { kind: 'failure', line: 7, quote: 'assert failed', quoteSha256: 'c'.repeat(64) },
      ],
    },
  });
  const lines = receipt.split('\n');
  assert.equal(lines[0], REDUCER_RECEIPT_PREFIX);
  assert.match(receipt, /- kind=fatal line=\? /);
  assert.match(receipt, /- kind=failure line=7 /);
  assert.match(receipt, /source_artifact=\/tmp\/artifact.txt/);
  assert.match(receipt, /reducer_model=test-model/);
  assert.ok(lines.every((l) => !l.includes('\r')), 'receipt stays LF-joined');
});

test('containsLikelySecret: detects credential patterns', () => {
  assert.equal(containsLikelySecret('Authorization: Bearer secret_token_12345'), true);
  assert.equal(containsLikelySecret('const api_key = "sk-1234567890abcdef"'), true);
  assert.equal(containsLikelySecret('access_token: ghp_abcdef123456'), true);

  assert.equal(containsLikelySecret('Test failed at line 42: assert.equal(1, 2)'), false);
  assert.equal(containsLikelySecret('Standard compilation output ok'), false);
});

test('validateReceipt: verifies exact byte-for-byte quotations', () => {
  const sourceLog = [
    'Running test suite...',
    'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
    '+ actual - expected',
    '+ 404',
    '- 200',
    '    at Context.<anonymous> (test/api.test.ts:45:12)',
    '1 failed, 12 passed',
  ].join('\n');

  const sourceHash = sha256Hex(sourceLog);

  // 1. Valid failure receipt with verbatim quote
  const validReceipt = JSON.stringify({
    schema: REDUCER_RECEIPT_SCHEMA,
    source_sha256: sourceHash,
    status: 'failure',
    uncertain: false,
    evidence: [
      {
        kind: 'failure',
        quote: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
      },
      {
        kind: 'summary',
        quote: '1 failed, 12 passed',
      },
    ],
  });

  const res1 = validateReceipt(validReceipt, sourceHash, sourceLog, true);
  assert.equal(res1.ok, true);
  if (res1.ok) {
    assert.equal(res1.value.status, 'failure');
    assert.equal(res1.value.evidence.length, 2);
    assert.equal(res1.value.evidence[0]!.line, 2);
  }

  // 2. Hallucinated / slightly altered quote must fail
  const alteredReceipt = JSON.stringify({
    schema: REDUCER_RECEIPT_SCHEMA,
    source_sha256: sourceHash,
    status: 'failure',
    uncertain: false,
    evidence: [
      {
        kind: 'failure',
        quote: 'AssertionError: Expected values to be strictly equal:', // missing [ERR_ASSERTION]
      },
    ],
  });

  const res2 = validateReceipt(alteredReceipt, sourceHash, sourceLog, true);
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, 'unverifiable-quote');
});

test('validateReceipt: catches status and schema mismatches', () => {
  const sourceLog = 'Error: connection refused at port 8080';
  const sourceHash = sha256Hex(sourceLog);

  // Status mismatch: isError is true, but receipt claims success
  const mismatchStatus = JSON.stringify({
    schema: REDUCER_RECEIPT_SCHEMA,
    source_sha256: sourceHash,
    status: 'success',
    uncertain: false,
    evidence: [],
  });

  const res = validateReceipt(mismatchStatus, sourceHash, sourceLog, true);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'schema-mismatch');
});

test('validateReceipt: enforces failure evidence when failure signals present', () => {
  const sourceLog = 'panic: runtime error in thread main';
  const sourceHash = sha256Hex(sourceLog);

  // Only summary evidence provided for a panic
  const noFailureEvidence = JSON.stringify({
    schema: REDUCER_RECEIPT_SCHEMA,
    source_sha256: sourceHash,
    status: 'failure',
    uncertain: false,
    evidence: [{ kind: 'summary', quote: 'panic: runtime error' }], // missing fatal/failure kind
  });

  const res = validateReceipt(noFailureEvidence, sourceHash, sourceLog, true);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'missing-failure-evidence');
});

test('formatReceiptText: generates receipt banner with source artifact path and readback info', () => {
  const receipt = formatReceiptText({
    command: 'npm test',
    sourceHash: 'abcdef1234567890',
    sourceBytes: 15000,
    sourceLines: 200,
    sourceArtifactPath: '/tmp/session/objects/abcdef1234567890.txt',
    model: 'cliproxy/gemini-3.8-flash-high',
    totalTokens: 520,
    validated: {
      status: 'failure',
      uncertain: false,
      evidence: [
        {
          kind: 'failure',
          line: 42,
          quote: 'AssertionError: expected 1 to equal 2',
          quoteSha256: 'quote1234',
        },
      ],
    },
  });

  assert.ok(receipt.includes(REDUCER_RECEIPT_PREFIX));
  assert.ok(receipt.includes('source_artifact=/tmp/session/objects/abcdef1234567890.txt'));
  assert.ok(receipt.includes('readback=use bash with explicit range'));
  assert.ok(receipt.includes('reducer_model=cliproxy/gemini-3.8-flash-high'));
});

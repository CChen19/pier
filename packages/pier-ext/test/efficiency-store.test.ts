/**
 * D101-D103 Efficiency Store & I/O Adapter Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEfficiencyLog,
  clearVerifiedObjectCacheForTest,
  efficiencyLogPath,
  isValidSessionId,
  observationObjectPath,
  readBashFullOutput,
  readStoredObjectChunk,
  reducerObjectPath,
  resolveSessionRoot,
  storeContentAddressedObject,
} from '../src/efficiency-store.ts';

test('isValidSessionId & resolveSessionRoot: validates format and prevents path traversal', () => {
  assert.equal(isValidSessionId('session-123_abc.test'), true);
  assert.equal(isValidSessionId('01a03bf0'), true);

  assert.equal(isValidSessionId('../../etc/passwd'), false);
  assert.equal(isValidSessionId(''), false);
  assert.equal(isValidSessionId(null), false);
  assert.equal(isValidSessionId('bad/id'), false);

  assert.equal(
    resolveSessionRoot('/tmp/sessions', '01a03bf0'),
    join('/tmp/sessions', 'herdr-pi', '01a03bf0'),
  );
  assert.equal(resolveSessionRoot(null, '01a03bf0'), null);
  assert.equal(resolveSessionRoot('/tmp/sessions', '../../bad'), null);
});

test('path helpers generate clean normalized paths', () => {
  const root = '/tmp/sessions/herdr-pi/sess_1';
  assert.equal(
    observationObjectPath(root, 'obs_123'),
    join(root, 'observation-pack', 'objects', 'obs_123.txt'),
  );
  assert.equal(
    reducerObjectPath(root, 'hash_abc'),
    join(root, 'evidence-preserving-reducer', 'objects', 'hash_abc.txt'),
  );
  assert.equal(
    efficiencyLogPath(root, 'compact'),
    join(root, 'efficiency-logs', 'compact.jsonl'),
  );
});

test('storeContentAddressedObject & readStoredObjectChunk: round-trip, idempotence and integrity', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-store-test-'));
  try {
    const filePath = join(tempDir, 'objects', 'test_obj.txt');
    const content = 'Hello world!\nLine 2\nLine 3\n';

    // 1. Initial write
    const res = await storeContentAddressedObject(filePath, content);
    assert.equal(res.path, filePath);
    assert.equal(res.bytes, Buffer.byteLength(content, 'utf8'));
    assert.equal(res.lines, 3);

    // 2. Idempotent write with same content
    const res2 = await storeContentAddressedObject(filePath, content);
    assert.equal(res2.hash, res.hash);

    // 3. Read chunk
    const chunk = await readStoredObjectChunk(filePath, 0, { maxBytes: 1024, maxLines: 2 });
    assert.equal(chunk.text, 'Hello world!\nLine 2\n');
    assert.equal(chunk.lines, 2);
    assert.equal(chunk.eof, false);

    // 4. Corrupted file with mismatched size must throw
    clearVerifiedObjectCacheForTest();
    await writeFile(filePath, 'tampered content');
    await assert.rejects(
      () => storeContentAddressedObject(filePath, content),
      /size mismatch/,
    );

    // 5. Corrupted file with exact same length but different content must throw hash mismatch
    clearVerifiedObjectCacheForTest();
    const tamperedSameLength = 'Hello world!\nLine 2\nLine 9\n'; // exact 27 bytes as content
    assert.equal(Buffer.byteLength(tamperedSameLength, 'utf8'), Buffer.byteLength(content, 'utf8'));
    await writeFile(filePath, tamperedSameLength, 'utf8');
    await assert.rejects(
      () => storeContentAddressedObject(filePath, content),
      /hash mismatch/,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('appendEfficiencyLog: appends newline-delimited JSON', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-log-test-'));
  try {
    const logPath = join(tempDir, 'logs', 'test.jsonl');
    await appendEfficiencyLog(logPath, { event: 'step_1', val: 100 });
    await appendEfficiencyLog(logPath, { event: 'step_2', val: 200 });

    const raw = await readFile(logPath, 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], { event: 'step_1', val: 100 });
    assert.deepEqual(lines[1], { event: 'step_2', val: 200 });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('readBashFullOutput: rejects non-bash logs and paths outside tmpdir', async () => {
  assert.equal(await readBashFullOutput('/tmp/not-bash.log', 1000), null);
  assert.equal(await readBashFullOutput(null, 1000), null);
  assert.equal(await readBashFullOutput('/tmpEvil/pi-bash-fake.log', 1000), null);
  assert.equal(await readBashFullOutput('/tmp/../etc/pi-bash-fake.log', 1000), null);

  const tempFile = join(tmpdir(), 'pi-bash-test1234.log');
  await writeFile(tempFile, 'Full diagnostic output text\nPass', 'utf8');
  try {
    const res = await readBashFullOutput(tempFile, 1000);
    assert.ok(res !== null);
    assert.equal(res!.content, 'Full diagnostic output text\nPass');
    assert.equal(res!.lines, 2);
  } finally {
    await rm(tempFile, { force: true });
  }
});

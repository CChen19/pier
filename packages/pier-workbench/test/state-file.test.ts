/**
 * F15：插件状态文件的并发安全写入。钩子是「每个事件一个进程」，多个 pane 同时出事件时
 * 朴素 writeFileSync 会互相截断 → 读回 JSON 失败 → 状态被当成空（表现为"插件忘了所有 tab"）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readJsonSafe, writeJsonAtomic } from '../src/state-file.ts';

test('writeJsonAtomic/readJsonSafe: 往返，且目录不存在时会自建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pier-state-'));
  const file = path.join(dir, 'nested', 'tab-layout.json');
  writeJsonAtomic(file, { tabs: { 'w1:t1': { enabled: true } }, panes: {}, debounce: null });
  assert.deepEqual(readJsonSafe(file, null), { tabs: { 'w1:t1': { enabled: true } }, panes: {}, debounce: null });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeJsonAtomic: 不留下临时文件，覆盖写不产生半截 JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pier-state2-'));
  const file = path.join(dir, 'tab-layout.json');
  for (let i = 0; i < 20; i += 1) writeJsonAtomic(file, { i, blob: 'x'.repeat(500) });
  assert.deepEqual(readJsonSafe(file, null), { i: 19, blob: 'x'.repeat(500) });
  assert.deepEqual(fs.readdirSync(dir), ['tab-layout.json'], '临时文件必须被 rename 消费掉');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJsonSafe: 半截/非法 JSON 与缺失文件都回退到默认值（不抛）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pier-state3-'));
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{"tabs": {"w1:t1":');
  assert.deepEqual(readJsonSafe(file, { tabs: {} }), { tabs: {} });
  assert.equal(readJsonSafe(path.join(dir, 'missing.json'), 'fallback'), 'fallback');
  fs.rmSync(dir, { recursive: true, force: true });
});

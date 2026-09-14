/**
 * F05：boot.jsonl 是追加日志。同一个 workspace 被反复 bootstrap 会有多条记录，
 * 逐条恢复会在重启后重复重建 main tab / master pane。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestBootRecordPerWorkspace, parseBootRecords } from '../src/restore-plan.ts';

test('parseBootRecords: 跳过空行、坏行与缺少 workspace_id 的记录', () => {
  const text = [
    '',
    '{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p1"}',
    '{"workspace_id":"w2"', // 半截（崩溃写坏）行
    '{"tab_id":"w3:t1"}', // 没有 workspace_id
    'null',
    '[]',
    '{"workspace_id":"w3","tab_id":"w3:t1","pane_id":"w3:p1"}',
    '   ',
  ].join('\n');
  assert.deepEqual(parseBootRecords(text).map((r) => r.workspace_id), ['w1', 'w3']);
  assert.deepEqual(parseBootRecords(''), []);
});

test('latestBootRecordPerWorkspace: 同 workspace 只保留最新一条（追加顺序 = 时间顺序）', () => {
  const records = parseBootRecords([
    '{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p1"}',
    '{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p9"}',
    '{"workspace_id":"w1","tab_id":"w1:t1","pane_id":"w1:p2"}',
    '{"workspace_id":"w2","tab_id":"w2:t1","pane_id":"w2:p1"}',
    '{"workspace_id":"w1","tab_id":"w1:t2","pane_id":"w1:p3"}',
  ].join('\n'));
  const latest = latestBootRecordPerWorkspace(records);
  assert.equal(latest.length, 2, '一个 workspace 恰好恢复一次');
  const w1 = latest.find((r) => r.workspace_id === 'w1');
  assert.equal(w1?.pane_id, 'w1:p3', '取最后一条（关机时有效的 pane）');
  assert.equal(w1?.tab_id, 'w1:t2');
  assert.equal(latest.find((r) => r.workspace_id === 'w2')?.pane_id, 'w2:p1');
  assert.deepEqual(latestBootRecordPerWorkspace([]), []);
});

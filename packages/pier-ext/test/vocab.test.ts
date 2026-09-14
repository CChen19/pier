/**
 * vocab: confirmation / settlement copy contracts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSettlementNotice, formatTodoConfirmation } from '../src/vocab.ts';

test('formatTodoConfirmation: 无 blocked 时保持 DSH 对齐；有 blocked 时补一列（A4）', () => {
  assert.equal(
    formatTodoConfirmation([
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'completed' },
    ]),
    'Updated todo list: 1 pending, 1 in progress, 1 completed.',
  );
  // A4 实证：apnv3 01a040cc 返回 "0 pending, 0 in progress, 0 completed."，而列表里其实是 blocked 项。
  assert.equal(
    formatTodoConfirmation([
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'completed' },
      { content: 'd', status: 'blocked' },
      { content: 'e', status: 'blocked' },
    ]),
    'Updated todo list: 1 pending, 1 in progress, 1 completed, 2 blocked.',
  );
  assert.equal(
    formatTodoConfirmation([{ content: 'x', status: 'blocked' }]),
    'Updated todo list: 0 pending, 0 in progress, 0 completed, 1 blocked.',
  );
  // abandoned 仍然不计入任何一列（D34）
  assert.equal(
    formatTodoConfirmation([{ content: 'x', status: 'abandoned' }]),
    'Updated todo list: 0 pending, 0 in progress, 0 completed.',
  );
});

test('formatSettlementNotice: with and without closing message', () => {
  assert.equal(
    formatSettlementNotice('p1 (task)', 'done'),
    'Background subagent p1 (task) finished and will do no further work unless you send it more. Its closing message: done',
  );
  assert.equal(
    formatSettlementNotice('p1 (task)', null),
    'Background subagent p1 (task) finished and will do no further work unless you send it more. It left no closing message.',
  );
});

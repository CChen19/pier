/**
 * Compact todo widget: one persistent status row, full detail stays behind /todos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIDGET_MAX_LINES, todoWidgetComponent, widgetLines } from '../src/core/todo.ts';
import { styledWidth } from '../src/ansi-text.ts';
import type { TodoItem } from '../src/vocab.ts';

const it = (
  content: string,
  status: TodoItem['status'],
  extra?: Pick<TodoItem, 'blocker' | 'phase'>,
): TodoItem => ({ content, status, ...extra });

test('widgetLines: mixed plan renders exactly one row focused on in-progress work', () => {
  const items = [
    it('old work', 'completed', { phase: 'done' }),
    it('current implementation', 'in_progress', { phase: 'build' }),
    it('next test', 'pending', { phase: 'verify' }),
    it('wait review', 'blocked', { blocker: 'maintainer approval' }),
  ];
  const lines = widgetLines(items);
  assert.equal(WIDGET_MAX_LINES, 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'todo: ▶1  ○1  ■1  ✓1 · ▶ current implementation · /todos');
  assert.doesNotMatch(lines[0]!, /old work|next test|\[build\]/);
});

test('widgetLines: without active work, pending item is the next focus', () => {
  const lines = widgetLines([
    it('waiting', 'blocked', { blocker: 'operator' }),
    it('actionable next', 'pending'),
  ]);
  assert.deepEqual(lines, ['todo: ○1  ■1 · ○ actionable next · /todos']);
});

test('widgetLines: blocked-only plan shows the blocker on the same row', () => {
  const lines = widgetLines([it('deploy', 'blocked', { blocker: 'production approval' })]);
  assert.deepEqual(lines, ['todo: ■1 · ■ deploy — production approval · /todos']);
});

test('widgetLines: a human gate keeps only the summary row', () => {
  const items = [it('ask user', 'in_progress'), it('later', 'pending')];
  assert.deepEqual(widgetLines(items, { blockedDepth: 1 }), ['todo: ▶1  ○1 · /todos']);
});

test('widgetLines: empty or fully settled plans disappear immediately', () => {
  assert.deepEqual(widgetLines([]), []);
  assert.deepEqual(widgetLines([
    it('done', 'completed'),
    it('dropped', 'abandoned'),
  ]), []);
});

test('todoWidgetComponent: long CJK task is clipped to one physical row', () => {
  const component = todoWidgetComponent('todo: ▶1 · ▶ 实现一个很长很长的当前任务名称 · /todos');
  const rendered = component.render(24);
  assert.equal(rendered.length, 1);
  assert.ok(styledWidth(rendered[0]!) <= 24);
  assert.match(rendered[0]!, /…$/);
});

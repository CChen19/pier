import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentViewSetParams } from '../src/agent-view.ts';

test('buildAgentViewSetParams: default parameters conform to Herdr 0.9.0 agent.view.set schema', () => {
  const params = buildAgentViewSetParams();

  assert.equal(params.source, 'pier.workbench');
  assert.equal(params.label, 'Pier');

  // Filter must target pi agents or panes with the pi-todo token
  assert.deepEqual(params.filter, {
    op: 'any',
    filters: [
      { op: 'eq', field: 'agent', value: 'pi' },
      { op: 'exists', field: { token: 'pi-todo' } },
    ],
  });

  // Sort by attention descending, then pane order ascending
  assert.deepEqual(params.sort, [
    { field: 'attention', order: 'desc' },
    { field: 'pane_order', order: 'asc' },
  ]);
});

test('buildAgentViewSetParams: supports custom options override', () => {
  const custom = buildAgentViewSetParams({
    source: 'custom.source',
    label: 'Custom View',
    tokenKey: 'custom-token',
  });

  assert.equal(custom.source, 'custom.source');
  assert.equal(custom.label, 'Custom View');
  assert.deepEqual(custom.filter, {
    op: 'any',
    filters: [
      { op: 'eq', field: 'agent', value: 'pi' },
      { op: 'exists', field: { token: 'custom-token' } },
    ],
  });
});

test('buildAgentViewSetParams: supports explicit filter override', () => {
  const custom = buildAgentViewSetParams({
    filter: {
      op: 'exists',
      field: { token: 'custom-only' },
    },
  });

  assert.deepEqual(custom.filter, {
    op: 'exists',
    field: { token: 'custom-only' },
  });
});

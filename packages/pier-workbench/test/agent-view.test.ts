import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentViewSetParams } from '../src/agent-view.ts';

test('buildAgentViewSetParams: default parameters conform to Herdr 0.9.0 agent.view.set schema', () => {
  const params = buildAgentViewSetParams();

  assert.equal(params.source, 'pier.workbench');
  assert.equal(params.label, 'Pier');

  // No harness filter: agent.view.set replaces Herdr's built-in Agents
  // projection globally, so any filter silently hides the harnesses it omits
  assert.equal(params.filter, null);

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
  });

  assert.equal(custom.source, 'custom.source');
  assert.equal(custom.label, 'Custom View');
  assert.equal(custom.filter, null);
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

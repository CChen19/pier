import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSnapshot,
  composeDashboardLines,
  type SessionSnapshotData,
} from '../src/dashboard-model.ts';

const SAMPLE_SNAPSHOT: SessionSnapshotData = {
  version: '0.9.0',
  protocol: 22,
  focused_workspace_id: 'wD',
  focused_tab_id: 'wD:t1',
  focused_pane_id: 'wD:p1',
  workspaces: [
    { workspace_id: 'wA', label: 'backend', focused: false, agent_status: 'idle', pane_count: 1, tab_count: 1 },
    { workspace_id: 'wD', label: 'pier', focused: true, agent_status: 'working', pane_count: 2, tab_count: 2 },
  ],
  tabs: [
    { tab_id: 'wD:t1', workspace_id: 'wD', number: 1, label: 'main', focused: true, agent_status: 'working' },
    { tab_id: 'wD:t2', workspace_id: 'wD', number: 2, label: 'sub-task', focused: false, agent_status: 'blocked' },
  ],
  panes: [
    {
      pane_id: 'wD:p1',
      workspace_id: 'wD',
      tab_id: 'wD:t1',
      agent: 'pi',
      display_agent: 'master',
      agent_status: 'working',
      focused: true,
      tokens: { 'pi-todo': '▶1 ○2 ■0 ✓1 · Building dashboard' },
    },
    {
      pane_id: 'wD:p2',
      workspace_id: 'wD',
      tab_id: 'wD:t2',
      agent: 'pi',
      display_agent: 'worker',
      agent_status: 'blocked',
      focused: false,
      title: 'Waiting for auth input',
      tokens: { 'lock-1234': 'locked-file' },
    },
    {
      pane_id: 'wA:p1',
      workspace_id: 'wA',
      tab_id: 'wA:t1',
      agent: 'pi',
      display_agent: 'master',
      agent_status: 'idle',
      focused: false,
    },
  ],
};

test('normalizeSnapshot: handles null and malformed inputs gracefully', () => {
  assert.equal(normalizeSnapshot(null), null);
  assert.equal(normalizeSnapshot(undefined), null);
  assert.equal(normalizeSnapshot('string'), null);

  const empty = normalizeSnapshot({});
  assert.deepEqual(empty?.workspaces, []);
  assert.deepEqual(empty?.tabs, []);
  assert.deepEqual(empty?.panes, []);
});

test('normalizeSnapshot: unpacks nested response envelopes', () => {
  // Direct
  const direct = normalizeSnapshot(SAMPLE_SNAPSHOT);
  assert.equal(direct?.version, '0.9.0');
  assert.equal(direct?.protocol, 22);
  assert.equal(direct?.workspaces?.length, 2);

  // Wrapped in { snapshot: ... }
  const wrapped = normalizeSnapshot({ snapshot: SAMPLE_SNAPSHOT });
  assert.equal(wrapped?.version, '0.9.0');
  assert.equal(wrapped?.panes?.length, 3);

  // Wrapped in { result: { snapshot: ... } } (standard socket RPC envelope)
  const rpc = normalizeSnapshot({ result: { snapshot: SAMPLE_SNAPSHOT } });
  assert.equal(rpc?.version, '0.9.0');
  assert.equal(rpc?.focused_workspace_id, 'wD');
});

test('composeDashboardLines: formats empty state gracefully', () => {
  const lines = composeDashboardLines(null, { now: 1700000000000 });
  assert.ok(lines.some((l) => l.includes('PIER OPS DASHBOARD')));
  assert.ok(lines.some((l) => l.includes('Waiting for Herdr session snapshot')));
});

test('composeDashboardLines: renders complete ops dashboard with workspaces, tabs, and panes', () => {
  const lines = composeDashboardLines(SAMPLE_SNAPSHOT, { now: 1700000000000 });
  const text = lines.join('\n');

  // Header
  assert.ok(text.includes('PIER OPS DASHBOARD'));
  assert.ok(text.includes('Herdr v0.9.0, proto 22'));

  // Workspaces line
  assert.ok(text.includes('[*wD: pier:working]'));
  assert.ok(text.includes('[wA: backend:idle]'));

  // Current workspace details
  assert.ok(text.includes('Current Workspace: wD (pier)'));

  // Tabs
  assert.ok(text.includes('*#1[main](working)'));
  assert.ok(text.includes('#2[sub-task](blocked)'));

  // Table header
  assert.ok(text.includes('PANE ID'));
  assert.ok(text.includes('ROLE'));
  assert.ok(text.includes('STATUS'));

  // Panes in wD
  assert.ok(text.includes('wD:p1'));
  assert.ok(text.includes('master'));
  assert.ok(text.includes('working'));
  assert.ok(text.includes('▶1 ○2 ■0 ✓1 · Building dashboard'));

  assert.ok(text.includes('wD:p2'));
  assert.ok(text.includes('worker'));
  assert.ok(text.includes('! BLOCKED'));
  assert.ok(text.includes('Waiting for auth input'));
  assert.ok(text.includes('[1 lock]'));

  // Alert & Summary
  assert.ok(text.includes('⚠️  ALERT: 1 SUBAGENT(S) BLOCKED — WAITING ON HUMAN DECISION'));
  assert.ok(text.includes('Summary: 2 pane(s) | Pier agents: 2 (1 working, 1 blocked, 0 idle)'));
});

test('composeDashboardLines: targetWorkspaceId option overrides focused workspace', () => {
  const lines = composeDashboardLines(SAMPLE_SNAPSHOT, {
    targetWorkspaceId: 'wA',
    now: 1700000000000,
  });
  const text = lines.join('\n');

  assert.ok(text.includes('Current Workspace: wA (backend)'));
  assert.ok(text.includes('wA:p1'));
  // Should not contain wD panes in the current workspace table
  assert.ok(!text.includes('wD:p1'));
  assert.ok(text.includes('Summary: 1 pane(s) | Pier agents: 1 (0 working, 0 blocked, 1 idle)'));
});

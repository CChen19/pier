import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatStandaloneDashboard,
  installDashboardCommand,
} from '../src/dashboard-command.ts';
import type { HerdrClientLike, HerdrEnv, OpenPluginPaneOptions, OpenPluginPaneResult } from '../src/herdr-client.ts';
import type { TodoItem } from '../src/vocab.ts';

class MockHerdrClient implements Partial<HerdrClientLike> {
  available = true;
  lastOpenOpts: OpenPluginPaneOptions | null = null;
  mode: OpenPluginPaneResult['mode'] = 'popup';
  shouldThrow = false;

  async openPluginPane(opts: OpenPluginPaneOptions): Promise<OpenPluginPaneResult> {
    this.lastOpenOpts = opts;
    if (this.shouldThrow) {
      throw new Error('plugin not found');
    }
    if (this.mode === 'popup') return { mode: 'popup', ok: true };
    if (this.mode === 'fallback_tab') return { mode: 'fallback_tab', tabId: 't2' };
    return { mode: 'pane', paneId: 'p2' };
  }
}

test('formatStandaloneDashboard: formats todos and locks correctly', () => {
  const todos: TodoItem[] = [
    { content: 'Build task', status: 'in_progress' },
    { content: 'Waiting human approval', status: 'blocked', blocker: 'needs review' },
    { content: 'Initial setup', status: 'completed' },
    { content: 'Future plan', status: 'pending' },
  ];
  const locks = ['/path/to/file.ts'];
  const text = formatStandaloneDashboard({ todos, locks, now: 1726567200000 });

  assert.match(text, /PIER OPS DASHBOARD/);
  assert.match(text, /Mode: Standalone/);
  assert.match(text, /Todos: 4 total \(1 done, 1 working, 1 blocked, 1 pending\)/);
  assert.match(text, /Active: ▶ Build task/);
  assert.match(text, /Blocked: ■ Waiting human approval \(needs review\)/);
  assert.match(text, /Write Locks: \/path\/to\/file\.ts/);
});

test('formatStandaloneDashboard: handles empty state gracefully', () => {
  const text = formatStandaloneDashboard({ todos: [], locks: [] });
  assert.match(text, /Todos: \(none\)/);
  assert.match(text, /Write Locks: \(none\)/);
});

test('installDashboardCommand: Level 1 (Herdr 0.9.1 popup)', async () => {
  const client = new MockHerdrClient();
  const env: HerdrEnv = { socketPath: '/tmp/herdr.sock', paneId: 'p1', workspaceId: 'w1', tabId: 't1' };
  let registeredHandler: ((args: unknown, ctx: unknown) => Promise<void>) | null = null;

  const mockPi = {
    registerCommand: (name: string, options: { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }) => {
      if (name === 'dashboard') registeredHandler = options.handler;
    },
  };

  installDashboardCommand({
    pi: mockPi,
    client: client as unknown as HerdrClientLike,
    env,
    getTodoItems: () => [],
    getHeldLocks: () => [],
  });

  assert.ok(registeredHandler, 'should register /dashboard command');

  const notifications: Array<{ text: string; level?: string }> = [];
  const fakeCtx = { ui: { notify: (text: string, level?: string) => notifications.push({ text, level }) } };

  await registeredHandler!(null, fakeCtx);

  assert.equal(client.lastOpenOpts?.pluginId, 'pier.workbench');
  assert.equal(client.lastOpenOpts?.entrypoint, 'dashboard');
  assert.equal(client.lastOpenOpts?.placement, 'popup');
  assert.equal(notifications.length, 0, 'No notification needed on clean popup open');
});

test('installDashboardCommand: Level 2 (Herdr < 0.9.1 fallback_tab)', async () => {
  const client = new MockHerdrClient();
  client.mode = 'fallback_tab';
  const env: HerdrEnv = { socketPath: '/tmp/herdr.sock', paneId: 'p1', workspaceId: 'w1', tabId: 't1' };
  let registeredHandler: ((args: unknown, ctx: unknown) => Promise<void>) | null = null;

  const mockPi = {
    registerCommand: (name: string, options: { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }) => {
      if (name === 'dashboard') registeredHandler = options.handler;
    },
  };

  installDashboardCommand({
    pi: mockPi,
    client: client as unknown as HerdrClientLike,
    env,
  });

  const notifications: Array<{ text: string; level?: string }> = [];
  const fakeCtx = { ui: { notify: (text: string, level?: string) => notifications.push({ text, level }) } };

  await registeredHandler!(null, fakeCtx);

  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /opened in new tab/);
});

test('installDashboardCommand: Level 3 (Non-Herdr standalone fallback)', async () => {
  const client = new MockHerdrClient();
  client.available = false; // Outside Herdr
  let registeredHandler: ((args: unknown, ctx: unknown) => Promise<void>) | null = null;

  const mockPi = {
    registerCommand: (name: string, options: { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }) => {
      if (name === 'dashboard') registeredHandler = options.handler;
    },
  };

  const sampleTodos: TodoItem[] = [{ content: 'Local task', status: 'in_progress' }];

  installDashboardCommand({
    pi: mockPi,
    client: client as unknown as HerdrClientLike,
    env: null,
    getTodoItems: () => sampleTodos,
    getHeldLocks: () => ['local.lock'],
  });

  const notifications: Array<{ text: string; level?: string }> = [];
  const fakeCtx = { ui: { notify: (text: string, level?: string) => notifications.push({ text, level }) } };

  await registeredHandler!(null, fakeCtx);

  assert.equal(client.lastOpenOpts, null, 'Should not attempt client.openPluginPane outside Herdr');
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /Mode: Standalone/);
  assert.match(notifications[0].text, /Local task/);
  assert.match(notifications[0].text, /local\.lock/);
});

test('installDashboardCommand: Level 3 error fallback when plugin pane fails', async () => {
  const client = new MockHerdrClient();
  client.shouldThrow = true; // Error inside Herdr
  const env: HerdrEnv = { socketPath: '/tmp/herdr.sock', paneId: 'p1', workspaceId: 'w1', tabId: 't1' };
  let registeredHandler: ((args: unknown, ctx: unknown) => Promise<void>) | null = null;

  const mockPi = {
    registerCommand: (name: string, options: { description: string; handler: (args: unknown, ctx: unknown) => Promise<void> }) => {
      if (name === 'dashboard') registeredHandler = options.handler;
    },
  };

  installDashboardCommand({
    pi: mockPi,
    client: client as unknown as HerdrClientLike,
    env,
    getTodoItems: () => [{ content: 'Fallback task', status: 'completed' }],
  });

  const notifications: Array<{ text: string; level?: string }> = [];
  const fakeCtx = { ui: { notify: (text: string, level?: string) => notifications.push({ text, level }) } };

  // Should not throw, should fall back to local standalone view
  await registeredHandler!(null, fakeCtx);

  assert.equal(notifications.length, 1);
  assert.match(notifications[0].text, /Mode: Standalone/);
  assert.match(notifications[0].text, /Fallback task/);
});

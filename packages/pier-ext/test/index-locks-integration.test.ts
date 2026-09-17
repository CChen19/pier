import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installWriteLocks } from '../src/index-locks.ts';
import { lockTokenKey, lockTokenValue } from '../src/lock-core.ts';
import type { HerdrClientLike, HerdrEnv, AgentInfo } from '../src/herdr-client.ts';

class MockPi {
  handlers = new Map<string, Array<(...args: any[]) => any>>();
  commands = new Map<string, any>();

  on(event: string, fn: (...args: any[]) => any) {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
  }

  registerCommand(name: string, opts: any) {
    this.commands.set(name, opts);
  }

  async emit(event: string, ...args: any[]) {
    const list = this.handlers.get(event) ?? [];
    for (const fn of list) {
      const res = await fn(...args);
      if (res) return res;
    }
  }
}

test('installWriteLocks: uses foregroundCwd when available from live agents', async () => {
  const pi = new MockPi();
  const reportedTokens: Array<Record<string, string | null>> = [];

  // Another pane p2 holds a lock on /repo/sub/file.ts
  const lockedPath = process.platform === 'win32' ? 'c:/repo/sub/file.ts' : '/repo/sub/file.ts';
  const lockKey = lockTokenKey(lockedPath);
  const otherAgentToken: Record<string, string | null> = {
    [lockKey]: lockTokenValue(lockedPath, 'p2'),
  };

  const client: Partial<HerdrClientLike> = {
    available: true,
    listAgents: async (): Promise<AgentInfo[]> => [
      {
        paneId: 'p1', // our own pane
        agent: 'pi',
        status: 'working',
        session: null,
        stateLabels: {},
        tokens: {},
        foregroundCwd: process.platform === 'win32' ? 'C:\\repo\\sub' : '/repo/sub',
      },
      {
        paneId: 'p2', // other pane
        agent: 'pi',
        status: 'working',
        session: null,
        stateLabels: {},
        tokens: otherAgentToken,
      },
    ],
    reportLockTokens: async (tokens) => {
      reportedTokens.push(tokens);
    },
  };

  const env: HerdrEnv = {
    socketPath: '/tmp/herdr.sock',
    paneId: 'p1',
    workspaceId: 'w1',
    tabId: 't1',
  };

  const handle = installWriteLocks(pi as any, {
    client: client as unknown as HerdrClientLike,
    env,
    hard: true, // hard block
  });

  // Call write on relative path 'file.ts' with context cwd = '/repo' (root)
  // Because foregroundCwd is '/repo/sub', 'file.ts' should resolve to '/repo/sub/file.ts' and COLLIDE with p2!
  const rootCwd = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  const blockResult = await pi.emit('tool_call', {
    toolName: 'write',
    toolCallId: 'call-1',
    input: { path: 'file.ts' },
  }, { cwd: rootCwd });

  assert.ok(blockResult?.block, 'Should block due to collision resolved via foregroundCwd');
  assert.match(blockResult.reason, /locked by pane p2/);

  assert.deepEqual(handle.getHeldLocks(), [], 'Blocked call should not acquire lock');
});

test('installWriteLocks: falls back to ctx.cwd when foregroundCwd is not reported', async () => {
  const pi = new MockPi();

  const lockedPath = process.platform === 'win32' ? 'c:/repo/file.ts' : '/repo/file.ts';
  const lockKey = lockTokenKey(lockedPath);
  const otherAgentToken: Record<string, string | null> = {
    [lockKey]: lockTokenValue(lockedPath, 'p2'),
  };

  const client: Partial<HerdrClientLike> = {
    available: true,
    listAgents: async (): Promise<AgentInfo[]> => [
      {
        paneId: 'p1',
        agent: 'pi',
        status: 'working',
        session: null,
        stateLabels: {},
        tokens: {},
        // No foregroundCwd reported (e.g. Herdr < 0.9.1)
      },
      {
        paneId: 'p2',
        agent: 'pi',
        status: 'working',
        session: null,
        stateLabels: {},
        tokens: otherAgentToken,
      },
    ],
    reportLockTokens: async () => {},
  };

  const env: HerdrEnv = {
    socketPath: '/tmp/herdr.sock',
    paneId: 'p1',
    workspaceId: 'w1',
    tabId: 't1',
  };

  installWriteLocks(pi as any, {
    client: client as unknown as HerdrClientLike,
    env,
    hard: true,
  });

  const rootCwd = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  const blockResult = await pi.emit('tool_call', {
    toolName: 'write',
    toolCallId: 'call-2',
    input: { path: 'file.ts' },
  }, { cwd: rootCwd });

  assert.ok(blockResult?.block, 'Should block by falling back to ctx.cwd');
  assert.match(blockResult.reason, /locked by pane p2/);
});

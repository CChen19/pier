import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeSubagentList } from '../src/subagent-list-action.ts';
import type { SubEntry } from '../src/subagent-core.ts';

test('executeSubagentList: shows [cwd: ...] when foregroundCwd differs from sub.cwd', async () => {
  const subs: SubEntry[] = [
    {
      taskId: 'task-1',
      paneId: 'p-1',
      kind: 'task',
      description: 'Worker 1',
      cwd: '/workspace/repo',
      background: true,
      status: 'running',
      createdAt: 1000,
    },
    {
      taskId: 'task-2',
      paneId: 'p-2',
      kind: 'task',
      description: 'Worker 2',
      cwd: '/workspace/repo',
      background: true,
      status: 'running',
      createdAt: 1000,
    },
  ];

  const result = await executeSubagentList({
    subs: () => subs,
    probeAlive: async (paneId) => {
      if (paneId === 'p-1') {
        return {
          paneExists: true,
          agentStatus: 'working',
          lastActivityMs: 1000,
          foregroundCwd: '/workspace/repo/packages/sub',
        };
      }
      return {
        paneExists: true,
        agentStatus: 'working',
        lastActivityMs: 1000,
        foregroundCwd: '/workspace/repo', // same cwd
      };
    },
    readAskFlag: async () => null,
    now: () => 2000,
  });

  const text = result.content[0].text;
  assert.match(text, /p-1 \[running working, active 1s ago\] \(task\) \[cwd: sub\] Worker 1/);
  assert.match(text, /p-2 \[running working, active 1s ago\] \(task\) Worker 2/);
  assert.ok(!text.includes('p-2 [running working, active 1s ago] (task) [cwd:'));
});

test('executeSubagentList: empty list', async () => {
  const result = await executeSubagentList({
    subs: () => [],
    probeAlive: async () => ({ paneExists: false, agentStatus: null, lastActivityMs: null }),
    readAskFlag: async () => null,
  });
  assert.match(result.content[0].text, /No background subagents/);
});

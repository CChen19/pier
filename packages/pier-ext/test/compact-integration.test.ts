/**
 * D100 Online Context Compact Integration & Lifecycle Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompactCoordinator,
  COMPACT_STATE_CUSTOM_TYPE,
  COMPACTION_CONTINUE_TYPE,
  restoreCoordinatorState,
} from '../src/compact-coordinator.ts';
import type { TodoItem } from '../src/todo-core.ts';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

function createMockContext(opts: {
  tokens?: number;
  hasPending?: boolean;
  branch?: any[];
}): { ctx: ExtensionContext; abortCalls: number; compactCalls: any[] } {
  let abortCalls = 0;
  const compactCalls: any[] = [];

  const ctx: any = {
    getContextUsage: () => ({
      tokens: opts.tokens ?? 50000,
      contextWindow: 128000,
    }),
    getSystemPrompt: () => 'System prompt text',
    hasPendingMessages: () => opts.hasPending ?? false,
    isIdle: () => true,
    sessionManager: {
      getBranch: () => opts.branch ?? [],
      getSessionDir: () => '/tmp/sessions',
      getSessionId: () => 'test_sess_01',
    },
    abort() {
      abortCalls++;
    },
    compact(options: any) {
      compactCalls.push(options);
    },
  };

  return { ctx, abortCalls: () => abortCalls, compactCalls };
}

test('CompactCoordinator: tracks boundary completion only for tool source', () => {
  const coordinator = new CompactCoordinator();

  // 1. Reconcile source must be ignored
  coordinator.recordBoundaryCompleted(1, 'reconcile');
  assert.equal(coordinator.pendingBoundaryCompleted, false);

  // 2. Human command source must be ignored
  coordinator.recordBoundaryCompleted(1, 'human');
  assert.equal(coordinator.pendingBoundaryCompleted, false);

  // 3. Tool source is captured
  coordinator.onBeforeProviderRequest(1000);
  coordinator.onBeforeProviderRequest(1200);
  coordinator.recordBoundaryCompleted(1, 'tool');
  assert.equal(coordinator.pendingBoundaryCompleted, true);
  assert.deepEqual(coordinator.state.completedBoundaryRequestCounts, [2]);
});

test('CompactCoordinator: user input acts as correction and clears pending plan; extension messages do not', () => {
  const coordinator = new CompactCoordinator();
  coordinator.state.completedBoundaryRequestCounts = [5, 5];
  coordinator.state.carriedDebtTokens = 10000;
  coordinator.pendingBoundaryCompleted = true;

  // 1. Extension message (e.g. D96 notice, pipe injection) must NOT reset state
  coordinator.onInput({ text: '注意：仍有 1 个后台 subagent 在运行', source: 'extension' });
  assert.deepEqual(coordinator.state.completedBoundaryRequestCounts, [5, 5]);
  assert.equal(coordinator.state.carriedDebtTokens, 10000);
  assert.equal(coordinator.pendingBoundaryCompleted, true);

  // 2. Human steer input (source: 'interactive', streamingBehavior: 'steer') MUST reset state (P1-2 fix)
  coordinator.onInput({ text: 'Wait, change the direction', source: 'interactive', streamingBehavior: 'steer' });
  assert.deepEqual(coordinator.state.completedBoundaryRequestCounts, []);
  assert.equal(coordinator.state.carriedDebtTokens, 0);
  assert.equal(coordinator.pendingBoundaryCompleted, false);
});

test('CompactCoordinator: turn_end skips abort if user has pending messages or disabled', () => {
  const coordinator = new CompactCoordinator();
  coordinator.pendingBoundaryCompleted = true;

  const todos: TodoItem[] = [{ content: 'Task 1', status: 'pending' }];

  // Case 1: OCC disabled
  const { ctx: ctxDisabled, abortCalls: aborts1 } = createMockContext({});
  coordinator.onTurnEnd({
    ctx: ctxDisabled,
    todos,
    config: {
      enabled: false,
      logEnabled: false,
      cacheWriteReadRatio: 12.5,
      firstCompactionRequestScale: 2.0,
      subsequentCompactionMargin: 1.5,
    },
  });
  assert.equal(aborts1(), 0);

  // Case 2: User has pending messages queued (e.g. steer message in progress)
  coordinator.pendingBoundaryCompleted = true;
  const { ctx: ctxPending, abortCalls: aborts2 } = createMockContext({ hasPending: true });
  coordinator.onTurnEnd({
    ctx: ctxPending,
    todos,
    config: {
      enabled: true,
      logEnabled: false,
      cacheWriteReadRatio: 12.5,
      firstCompactionRequestScale: 2.0,
      subsequentCompactionMargin: 1.5,
    },
  });
  assert.equal(aborts2(), 0);
});

test('CompactCoordinator: full lifecycle from turn_end abort through agent_settled compact', async () => {
  const coordinator = new CompactCoordinator();
  coordinator.state.completedBoundaryRequestCounts = [10]; // established horizon
  coordinator.pendingBoundaryCompleted = true;

  const todos: TodoItem[] = [
    { content: 'Done item', status: 'completed' },
    { content: 'Remaining task', status: 'in_progress', blocker: 'awaiting approval' },
  ];

  // Prepare a branch with enough messages (>20k tokens) so nativeCompactionFeasible passes
  const branchEntries = Array.from({ length: 25 }, (_, i) => ({
    type: 'message',
    id: `msg_${i}`,
    parentId: i > 0 ? `msg_${i - 1}` : null,
    message: {
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: 'Some long log content exceeding threshold...\n'.repeat(200) }],
    },
  }));

  const mock = createMockContext({ tokens: 60000, branch: branchEntries });
  let reminderCancelled = false;

  // 1. turn_end triggers economic abort
  coordinator.onTurnEnd({
    ctx: mock.ctx,
    todos,
    config: {
      enabled: true,
      logEnabled: false,
      cacheWriteReadRatio: 2.0, // generous ratio so breakeven is met easily
      firstCompactionRequestScale: 2.0,
      subsequentCompactionMargin: 1.5,
    },
    cancelReminder: () => {
      reminderCancelled = true;
    },
  });

  assert.equal(mock.abortCalls(), 1);
  assert.equal(coordinator.intentionalAbort, true);
  assert.equal(reminderCancelled, true);
  assert.ok(coordinator.selectedCompaction !== null);

  // 2. agent_settled carries out compaction
  const sentMessages: any[] = [];
  const appendedEntries: any[] = [];
  const mockPi: any = {
    appendEntry(type: string, data: any) {
      appendedEntries.push({ type, data });
    },
    sendMessage(msg: any, opts: any) {
      sentMessages.push({ msg, opts });
      return Promise.resolve();
    },
  };

  const settlePromise = coordinator.onAgentSettled({
    ctx: mock.ctx,
    todos,
    pi: mockPi,
    config: {
      enabled: true,
      logEnabled: false,
      cacheWriteReadRatio: 2.0,
      firstCompactionRequestScale: 2.0,
      subsequentCompactionMargin: 1.5,
    },
  });

  // Verify compact was called with remaining task instructions
  assert.equal(mock.compactCalls.length, 1);
  const compactCall = mock.compactCalls[0];
  assert.ok(compactCall.customInstructions.includes('Remaining task'));
  assert.ok(compactCall.customInstructions.includes('awaiting approval'));

  // Trigger completion callback
  compactCall.onComplete({ summary: 'Compacted history summary' });
  await settlePromise;

  // Verify post-compaction state
  assert.equal(coordinator.compactionInFlight, false);
  assert.equal(coordinator.intentionalAbort, false);
  assert.equal(coordinator.state.priorCompactionCount, 1);

  // Verify state persisted to session entry
  assert.equal(appendedEntries.length, 1);
  assert.equal(appendedEntries[0].type, COMPACT_STATE_CUSTOM_TYPE);

  // Verify silent continuation message dispatched
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].msg.customType, COMPACTION_CONTINUE_TYPE);
  assert.equal(sentMessages[0].opts.triggerTurn, true);
});

test('restoreCoordinatorState: replays state from branch custom entries', () => {
  const branch = [
    { type: 'message', id: 'm1' },
    {
      type: 'custom',
      customType: COMPACT_STATE_CUSTOM_TYPE,
      data: {
        version: 1,
        epoch: 3,
        completedBoundaryRequestCounts: [4, 6],
        carriedDebtTokens: 12000,
        cacheDebtRepaymentTokens: 5000,
        priorCompactionCount: 2,
        positiveContextDeltaTotal: 8000,
        positiveContextDeltaCount: 4,
        lastContextTokens: 45000,
        currentBoundaryRequestCount: 1,
      },
    },
  ];

  const restored = restoreCoordinatorState(branch);
  assert.equal(restored.epoch, 3);
  assert.deepEqual(restored.completedBoundaryRequestCounts, [4, 6]);
  assert.equal(restored.carriedDebtTokens, 12000);
  assert.equal(restored.priorCompactionCount, 2);
});

test('CompactCoordinator: decrements carried debt on each provider request and clamps to zero (P2-6)', () => {
  const coordinator = new CompactCoordinator();
  coordinator.state.carriedDebtTokens = 1000;
  coordinator.state.cacheDebtRepaymentTokens = 300;

  // Request 1: 1000 - 300 = 700
  coordinator.onBeforeProviderRequest(10000);
  assert.equal(coordinator.state.carriedDebtTokens, 700);

  // Request 2: 700 - 300 = 400
  coordinator.onBeforeProviderRequest(10500);
  assert.equal(coordinator.state.carriedDebtTokens, 400);

  // Request 3: 400 - 300 = 100
  coordinator.onBeforeProviderRequest(11000);
  assert.equal(coordinator.state.carriedDebtTokens, 100);

  // Request 4: 100 - 300 = 0 (clamps to zero and resets repayment tokens)
  coordinator.onBeforeProviderRequest(11500);
  assert.equal(coordinator.state.carriedDebtTokens, 0);
  assert.equal(coordinator.state.cacheDebtRepaymentTokens, 0);
});

test('CompactCoordinator: onError safely resets inFlight and intentional flags (8.2)', async () => {
  const coordinator = new CompactCoordinator();
  coordinator.selectedCompaction = {
    compact: true,
    reason: 'economic',
  } as any;
  coordinator.intentionalAbort = true;

  const mock = createMockContext({});
  const mockPi: any = { appendEntry: () => {}, sendMessage: () => Promise.resolve() };

  const settlePromise = coordinator.onAgentSettled({
    ctx: mock.ctx,
    todos: [],
    pi: mockPi,
    config: {
      enabled: true,
      logEnabled: false,
      cacheWriteReadRatio: 2.0,
      firstCompactionRequestScale: 2.0,
      subsequentCompactionMargin: 1.5,
    },
  });

  assert.equal(coordinator.compactionInFlight, true);
  assert.equal(mock.compactCalls.length, 1);

  // Simulate user abort / compaction error
  mock.compactCalls[0].onError(new Error('User pressed ESC / cancelled'));
  await settlePromise;

  assert.equal(coordinator.compactionInFlight, false);
  assert.equal(coordinator.intentionalAbort, false);
});

test('CompactCoordinator: turn_end falls back when usage.tokens is null or 0 (P2-11)', () => {
  const coordinator = new CompactCoordinator();
  coordinator.state.lastContextTokens = 35000;
  coordinator.pendingBoundaryCompleted = true;

  const mock = createMockContext({});
  // Mock usage with null tokens (as Pi returns right after compaction before next response)
  mock.ctx.getContextUsage = () => ({ tokens: null as any, contextWindow: 128000 });

  coordinator.onTurnEnd({
    ctx: mock.ctx,
    todos: [{ content: 'test', status: 'completed' }],
    config: {
      enabled: true,
      logEnabled: false,
      cacheWriteReadRatio: 12.5,
      firstCompactionRequestScale: 2.0,
      subsequentCompactionMargin: 1.5,
    },
  });

  // Must not throw or poison with 0
  assert.equal(coordinator.state.lastContextTokens, 35000);
});



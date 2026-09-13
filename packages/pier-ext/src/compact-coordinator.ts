/**
 * D100 Online Context Compact Coordinator.
 *
 * Orchestrates:
 *  - Tracking todo completion boundaries (filtered to source === 'tool').
 *  - Evaluating KV-cache economics & window protection on turn_end.
 *  - Guarding against ejecting queued messages (hasPendingMessages check).
 *  - Aborting turn and executing Pi native compaction with custom instructions.
 *  - Feeding remaining tasks forward and injecting continuation turn.
 *  - Persisting state to session entries across branches and restores.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  decideCompaction,
  DEFAULT_COMPACTION_ECONOMICS,
  nativeCompactionFeasible,
  resolveCacheRatioFromCost,
  type CompactionDecision,
} from './compact-economics-core.ts';
import type { TodoItem } from './todo-core.ts';
import type { TodoCompletionSource } from './todos-service.ts';
import type { OnlineContextCompactConfig } from './efficiency-config-core.ts';
import {
  appendEfficiencyLog,
  efficiencyLogPath,
  resolveSessionRoot,
} from './efficiency-store.ts';

export const COMPACT_STATE_CUSTOM_TYPE = 'pi-herdr.efficiency-state';
export const COMPACTION_CONTINUE_TYPE = 'pi-herdr.compaction-continue';
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const DEFAULT_MEMO_TOKENS = 1_000;

export interface CoordinatorState {
  version: 1;
  epoch: number;
  completedBoundaryRequestCounts: number[];
  carriedDebtTokens: number;
  cacheDebtRepaymentTokens: number;
  priorCompactionCount: number;
  positiveContextDeltaTotal: number;
  positiveContextDeltaCount: number;
  lastContextTokens: number | null;
  currentBoundaryRequestCount: number;
}

export function initialCoordinatorState(): CoordinatorState {
  return {
    version: 1,
    epoch: 0,
    completedBoundaryRequestCounts: [],
    carriedDebtTokens: 0,
    cacheDebtRepaymentTokens: 0,
    priorCompactionCount: 0,
    positiveContextDeltaTotal: 0,
    positiveContextDeltaCount: 0,
    lastContextTokens: null,
    currentBoundaryRequestCount: 0,
  };
}

export function restoreCoordinatorState(entries: readonly unknown[]): CoordinatorState {
  if (!Array.isArray(entries)) return initialCoordinatorState();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; customType?: string; data?: unknown };
    if (entry && entry.type === 'custom' && entry.customType === COMPACT_STATE_CUSTOM_TYPE) {
      const d = entry.data as Partial<CoordinatorState>;
      if (d && d.version === 1 && Array.isArray(d.completedBoundaryRequestCounts)) {
        return {
          version: 1,
          epoch: typeof d.epoch === 'number' ? d.epoch : 0,
          completedBoundaryRequestCounts: [...d.completedBoundaryRequestCounts],
          carriedDebtTokens: typeof d.carriedDebtTokens === 'number' ? d.carriedDebtTokens : 0,
          cacheDebtRepaymentTokens: typeof d.cacheDebtRepaymentTokens === 'number' ? d.cacheDebtRepaymentTokens : 0,
          priorCompactionCount: typeof d.priorCompactionCount === 'number' ? d.priorCompactionCount : 0,
          positiveContextDeltaTotal: typeof d.positiveContextDeltaTotal === 'number' ? d.positiveContextDeltaTotal : 0,
          positiveContextDeltaCount: typeof d.positiveContextDeltaCount === 'number' ? d.positiveContextDeltaCount : 0,
          lastContextTokens: typeof d.lastContextTokens === 'number' ? d.lastContextTokens : null,
          currentBoundaryRequestCount: typeof d.currentBoundaryRequestCount === 'number' ? d.currentBoundaryRequestCount : 0,
        };
      }
    }
  }
  return initialCoordinatorState();
}

export class CompactCoordinator {
  state: CoordinatorState = initialCoordinatorState();
  compactionInFlight = false;
  intentionalAbort = false;
  selectedCompaction: CompactionDecision | null = null;
  pendingBoundaryCompleted = false;

  recordBoundaryCompleted(count: number, source?: TodoCompletionSource): void {
    // Only count completed transitions originating from model tool calls
    if (source !== 'tool' || count <= 0) return;
    this.pendingBoundaryCompleted = true;
    if (this.state.currentBoundaryRequestCount > 0) {
      this.state.completedBoundaryRequestCounts.push(this.state.currentBoundaryRequestCount);
      this.state.currentBoundaryRequestCount = 0;
    }
  }

  onBeforeProviderRequest(contextTokens: number): void {
    this.state.currentBoundaryRequestCount++;
    if (this.state.carriedDebtTokens > 0 && this.state.cacheDebtRepaymentTokens > 0) {
      this.state.carriedDebtTokens = Math.max(
        0,
        this.state.carriedDebtTokens - this.state.cacheDebtRepaymentTokens,
      );
      if (this.state.carriedDebtTokens === 0) {
        this.state.cacheDebtRepaymentTokens = 0;
      }
    }
    if (this.state.lastContextTokens !== null && contextTokens > this.state.lastContextTokens) {
      this.state.positiveContextDeltaTotal += contextTokens - this.state.lastContextTokens;
      this.state.positiveContextDeltaCount++;
    }
    this.state.lastContextTokens = contextTokens;
  }

  onInput(event: { text?: string; source?: string; streamingBehavior?: string }): void {
    // Ignore internal messages dispatched by extensions (D96 reminders, pipe injections, followUps)
    if (event.source === 'extension' || event.text?.startsWith('CORRECTION:')) {
      return;
    }

    const fromHuman =
      event.source === 'interactive' ||
      event.source === 'rpc' ||
      event.source === undefined;

    // If human typed a new prompt or steer directive, reset expectations (correction)
    if (fromHuman) {
      this.selectedCompaction = null;
      this.intentionalAbort = false;
      this.pendingBoundaryCompleted = false;
      this.state.completedBoundaryRequestCounts = [];
      this.state.carriedDebtTokens = 0;
      this.state.epoch++;
    }
  }

  onTurnEnd(opts: {
    ctx: ExtensionContext;
    todos: readonly TodoItem[];
    config: OnlineContextCompactConfig;
    cancelReminder?: () => void;
  }): void {
    const boundary = this.pendingBoundaryCompleted;
    this.pendingBoundaryCompleted = false;

    if (!boundary || this.selectedCompaction) return;
    if (!opts.config.enabled) return;

    // Safety guard: if user typed something that is queued, don't abort!
    if (opts.ctx.hasPendingMessages?.()) return;

    const usage = opts.ctx.getContextUsage?.();
    const contextTokens =
      typeof usage?.tokens === 'number' && usage.tokens > 0
        ? usage.tokens
        : this.state.lastContextTokens ?? 0;
    const contextWindowTokens = usage?.contextWindow ?? opts.ctx.model?.contextWindow ?? null;
    const fixedTokens = Math.ceil(Buffer.byteLength(opts.ctx.getSystemPrompt?.() ?? '') / 4);
    const keepRecentTokens = opts.config.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
    const archiveTokens = Math.max(0, contextTokens - fixedTokens - keepRecentTokens);
    const remainingBoundaries = opts.todos.filter(
      (it) => it.status !== 'completed' && it.status !== 'abandoned',
    ).length;

    const averageContextTokenIncrement =
      this.state.positiveContextDeltaCount > 0
        ? this.state.positiveContextDeltaTotal / this.state.positiveContextDeltaCount
        : null;

    const cacheRatio = resolveCacheRatioFromCost(
      opts.config.cacheWriteReadRatio,
      opts.ctx.model?.cost,
    );

    const decision = decideCompaction({
      writeTokens: contextTokens,
      archiveTokens,
      memoTokens: DEFAULT_MEMO_TOKENS,
      contextTokens,
      completedBoundaryRequestCounts: this.state.completedBoundaryRequestCounts,
      remainingBoundaries,
      averageContextTokenIncrement,
      contextWindowTokens,
      priorCompactionCount: this.state.priorCompactionCount,
      carriedDebtTokens: this.state.carriedDebtTokens,
      cacheDebtRepaymentTokens: this.state.cacheDebtRepaymentTokens,
      cacheWriteReadRatio: cacheRatio,
      economics: {
        ...DEFAULT_COMPACTION_ECONOMICS,
        firstCompactionRequestScale: opts.config.firstCompactionRequestScale,
        subsequentCompactionMargin: opts.config.subsequentCompactionMargin,
      },
    });

    if (decision.compact) {
      const branch = opts.ctx.sessionManager?.getBranch?.() ?? [];
      const keepRecentTokens = opts.config.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
      const feasible = nativeCompactionFeasible(branch, keepRecentTokens);
      if (!feasible) {
        if (opts.config.logEnabled) {
          this.logDecision(opts.ctx, { ...decision, compact: false, reason: 'native_not_compactable' });
        }
        return;
      }

      this.selectedCompaction = decision;
      this.intentionalAbort = true;
      opts.cancelReminder?.();
      opts.ctx.abort();
    } else if (opts.config.logEnabled) {
      this.logDecision(opts.ctx, decision);
    }
  }

  async onAgentSettled(opts: {
    ctx: ExtensionContext;
    todos: readonly TodoItem[];
    pi: ExtensionAPI;
    config: OnlineContextCompactConfig;
    cancelReminder?: () => void;
  }): Promise<void> {
    if (!this.selectedCompaction || !opts.ctx.isIdle()) return;
    const decision = this.selectedCompaction;
    this.selectedCompaction = null;

    opts.cancelReminder?.();
    this.compactionInFlight = true;

    const remaining = opts.todos.filter(
      (it) => it.status !== 'completed' && it.status !== 'abandoned',
    );
    const taskLines = remaining
      .map((it) => `- [${it.status}] ${it.content}${it.blocker ? ` (waiting on: ${it.blocker})` : ''}`)
      .join('\n');

    const customInstructions = [
      'Preserve completed work, verification results, important decisions, and remaining work.',
      remaining.length > 0 ? `Active/remaining tasks to preserve:\n${taskLines}` : 'All listed tasks are completed.',
    ].join('\n\n');

    const startMs = Date.now();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      opts.ctx.compact({
        customInstructions,
        onComplete: (compaction) => {
          try {
            this.state.priorCompactionCount++;
            const incrementalRatio = decision.incrementalCacheCostRatio ?? 0;
            this.state.carriedDebtTokens = decision.writeTokens * incrementalRatio;
            this.state.cacheDebtRepaymentTokens = Math.max(0, decision.archiveTokens - decision.memoTokens);
            this.state.epoch++;

            (opts.pi as { appendEntry?: (type: string, data: unknown) => void }).appendEntry?.(
              COMPACT_STATE_CUSTOM_TYPE,
              this.state,
            );

            if (opts.config.logEnabled) {
              const sessionDir = opts.ctx.sessionManager?.getSessionDir?.();
              const sessionId = opts.ctx.sessionManager?.getSessionId?.();
              const root = resolveSessionRoot(sessionDir, sessionId);
              if (root) {
                const logPath = efficiencyLogPath(root, 'compact');
                void appendEfficiencyLog(logPath, {
                  schema: 'pier-efficiency/1',
                  mechanism: 'onlineContextCompact',
                  ts: new Date().toISOString(),
                  sessionId: sessionId ?? 'unknown',
                  epoch: this.state.epoch,
                  decision: decision.reason,
                  writeTokens: decision.writeTokens,
                  archiveTokens: decision.archiveTokens,
                  savedTokens: Math.max(0, decision.archiveTokens - decision.memoTokens),
                  breakevenRequests: decision.breakevenRequests,
                  expectedRemainingRequests: decision.expectedRemainingRequests,
                  carriedDebtTokens: this.state.carriedDebtTokens,
                  summaryTokens: typeof compaction?.summary === 'string' ? Math.ceil(compaction.summary.length / 4) : 0,
                  priorCompactionCount: this.state.priorCompactionCount,
                  durationMs: Date.now() - startMs,
                }).catch(() => {});
              }
            }

            try {
              (opts.pi as { sendMessage?: (msg: unknown, o: unknown) => Promise<void> }).sendMessage?.(
                {
                  customType: COMPACTION_CONTINUE_TYPE,
                  content: 'Online context compaction finished. Active tasks preserved. Continue working on remaining tasks.',
                  display: false,
                },
                { triggerTurn: true },
              );
            } catch {
              /* ignore continuation failure */
            }
          } finally {
            this.compactionInFlight = false;
            this.intentionalAbort = false;
            finish();
          }
        },
        onError: () => {
          this.compactionInFlight = false;
          this.intentionalAbort = false;
          finish();
        },
      });
    });
  }

  rebuildFromBranch(entries: readonly unknown[]): void {
    this.state = restoreCoordinatorState(entries);
    this.selectedCompaction = null;
    this.compactionInFlight = false;
    this.intentionalAbort = false;
    this.pendingBoundaryCompleted = false;
  }

  getRemainingHorizon(remainingBoundaries = 3): number {
    const counts = this.state.completedBoundaryRequestCounts;
    if (counts.length === 0) return 4;
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    return Math.max(1, 1 + Math.floor(mean * remainingBoundaries));
  }

  private logDecision(ctx: ExtensionContext, decision: CompactionDecision): void {
    const sessionDir = ctx.sessionManager?.getSessionDir?.();
    const sessionId = ctx.sessionManager?.getSessionId?.();
    const root = resolveSessionRoot(sessionDir, sessionId);
    if (!root) return;
    const logPath = efficiencyLogPath(root, 'compact');
    void appendEfficiencyLog(logPath, {
      schema: 'pier-efficiency/1',
      mechanism: 'onlineContextCompact',
      event: 'decision',
      ts: new Date().toISOString(),
      sessionId: sessionId ?? 'unknown',
      epoch: this.state.epoch,
      decision: decision.reason,
      compact: decision.compact,
      writeTokens: decision.writeTokens,
      archiveTokens: decision.archiveTokens,
      breakevenRequests: decision.breakevenRequests,
      expectedRemainingRequests: decision.expectedRemainingRequests,
    }).catch(() => {});
  }
}

/**
 * core/subagent — master-only loader entry (tools, registry, poller, GC).
 *
 * Inbound deps via `pi-herdr.subagent-deps`. Outbound pipe/settle queries bind
 * atomically onto `port.current` (see subagent-port.ts). Settlement reconcile
 * stays in index session state; this plugin consumes it through the port.
 */
import { Context } from '@deepseek-ai/cordis';
import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { basename, join, dirname } from 'node:path';
import type { PiSurface } from '../pi-surface.ts';
import type { HerdrClientLike } from '../herdr-client.ts';
import { Semaphore, SUBS_CUSTOM_TYPE, agoText, buildAliveNotice, buildBlockedGateNotice, buildIsolatePreamble, classifyWorktreeZone, foldSubsRegistry, formatSubagentResult, isAlive, isPathUnder, makeProgressUpdate, makeRegistry, planIsolateWorktree, tabNameForTask, type AliveProbe, type SubEntry } from '../subagent-core.ts';
import { applyReportedSessionFile, appendHistory, preferredHistoryFile, inheritOutcome, latestGeneration, readHistory, type HistoryEntry } from '../history-store.ts';
import { runtimePolicy } from '../runtime-policy.ts';
import { platformPaths } from '../platform-paths.ts';
import type { SubagentPort, SubagentPortBox } from '../subagent-port.ts';
import {
  FOREGROUND_POLL_MS,
  planForegroundTick,
  planIsolateRepoGuard,
  planLaunchValidation,
  planPatienceExpiry,
} from '../subagent-launch.ts';
import { toolError } from '../tool-error.ts'

/** Raw tool arguments: every field is validated inside the action handlers. */
type ToolParams = Record<string, unknown> | undefined;;
import { mkdirSync, stat as statCb } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import { promisify } from 'node:util';
const statAsync = promisify(statCb);
import { pipeNameFor, pipeRequestTo } from '../pipe-channel.ts';
import { composeForRole } from '../manifest-compose.ts';
import type { TerminalStateSlot } from './terminal.ts';
import { createGitIo } from '../subagent-git-io.ts';
import { createSessionIo } from '../subagent-session-io.ts';
import { createSpawner } from '../subagent-spawn.ts';
import { createPoller } from '../subagent-poll-loop.ts';
import { createGcController } from '../subagent-gc.ts';
import {
  computeSubagentOutputDelta,
  formatSubagentOutput,
  resolveSubagentStatus,
  type SubagentOutputCursor,
} from '../subagent-output-core.ts';
import type { HerdrAgentState } from '../herdr-client.ts';
import { swallow } from '../swallow.ts';


interface SubagentEnv {
  paneId: string;
  tabId: string;
  workspaceId: string;
}

interface SubagentDeps {
  client: HerdrClientLike;
  env: SubagentEnv | null;
  /** Extension entry (index.ts) path — launchLine `-e`. */
  extPath: string;
  /** Master tree root (scope mount). */
  sessionRoot: Context;
  port: SubagentPortBox;
  getSessionId: () => string;
  reconcileOnSettlement: (description: string, outcome: 'settled' | 'failed') => string[];
  withReconcileNotes: (base: string, notes: readonly string[]) => string;
  claimSettleNotice: (key: string) => boolean;
  /**
   * Settlement notice injector from index: buffer while busy, flush at turn_end.
   * Tests may omit it and fall back to pi.sendUserMessage(followUp).
   */
  deliverNotice?: (content: string, paneId?: string) => Promise<void>;
  /** Panes whose settlement notice is still buffered (GC exemption). */
  noticePending?: () => ReadonlySet<string>;
  /** Terminal-family GC exemption (live terminal panes are not collected). */
  terminalState: TerminalStateSlot;
}

const SUBAGENT_DESCRIPTION = [
  'Delegate a self-contained subtask to an isolated subagent that runs in its own herdr pane as an interactive pi session (separate context window; it does NOT see this conversation). A human can also open that pane and talk to the subagent directly.',
  '`action` (optional, default "spawn"): spawn | resume | list | send | interrupt | output.',
  '[spawn] `description`: short display label for the pane; `prompt`: the COMPLETE task — include all needed context, since only the prompt reaches the subagent. The description also doubles as the todo-reconcile key: when delegating a todo entry, use the entry content WITHOUT its ` <sub>` marker as the description, and the entry is auto-completed when this subagent settles.',
  '[spawn] The subagent shares this workspace and works independently; the result is its final text answer.',
  '[spawn] Concurrent delegation is supported: several spawn calls in one message run in parallel (at most 4 at once). Use this for well-scoped, independent subtasks; do not delegate the current step itself.',
  '[spawn] `run_in_background` (default false): when true, the call returns immediately with an agentId; the subagent keeps running in its pane. Use action list to see its state, action send to give it follow-up work, action interrupt to stop it. When it settles, you receive a notification message with its closing output.',
  '[spawn] `tab` (optional): name of a task tab to place the subagent into (join if a tab with this name exists, otherwise create it). Overrides the default placement. Default placement groups by git worktree: a subagent working in your checkout shares your tab; one working in a separate worktree (pass its path via `cwd`; create worktrees with `git worktree add`) gets its own tab named after the worktree directory.',
  '[spawn] `role` + `allowed_tools`: when role matches a profile (searched: workspace .pi-herdr/roles/ → user-global ~/.pi/agent/herdr-pi/roles/ → builtin), the worker toolset becomes the composed manifest — baseline ∪ allowed_tools minus role-deny tools (deny always wins). Custom roles: drop a JSON profile into .pi-herdr/roles/ (master/worker-default reserved). Unknown role names remain display labels only.',
  '[spawn] `isolate` (default false): creates a FRESH git worktree for this subagent and runs it there (branch pier/<slug> from your HEAD under ~/.herdr/worktrees/<repo>/). Three-way choice: heavy independent writing in parallel with your own edits or other workers, or work needing its own clean reviewable diff → isolate; read-mostly or sequential helper work → omit (shared checkout, writes guarded by the write-lock); targeting an existing directory/worktree → cwd. In isolate mode the subagent\'s writes cannot conflict with your checkout; its panes group into a tab named after the worktree; its prompt is prefixed with commit discipline (commit to its own branch, NEVER push); when it settles you get a diff summary (commits since base, files changed, uncommitted count). Review with git log/diff HEAD..<branch>, merge with git merge --no-ff <branch>; once merged and clean the worktree auto-removes (branch kept). Mutually exclusive with cwd.',
  '[resume] `taskId`: revive a finished (collected) subagent from the delegation ledger — opens its saved conversation in a new pane (pi --session), then use action send to give it new work. The ledger is an append-only JSONL file, one row per status change (same taskId rows = generations, latest row is current): fields taskId, description, status (running|settled|consumed|closed), outcome (closing text), paneId, sessionFile, launchCommand, createdAt. It is per-checkout at ~/.pi/agent/herdr-pi/history/<flattened-cwd>/history.jsonl. Use action list for live panes from this session; for earlier sessions or closed panes, grep the ledger for the taskId.',
  '[list] no extra parameters: list background subagents with live state (running / idle), pane ids, last activity, role, and descriptions. Foreground one-shot panes are not listed.',
  '[send] `agentId` + `message`: follow-up to a background subagent. If working, delivered at next tool-call gap (steer, seconds); if idle, wakes a new turn. After settle, send to wake it; do not spawn a duplicate.',
  '[interrupt] `agentId`: abort the current turn (fire-and-return). The pane stays; you can send again.',
  '[output] `agentId` (required, the subagent pane id): view incremental output of a running or background subagent since the last output call. Text returned to the model is bounded (default 6000 chars) with status metadata (running/idle/blocked/settled), revision, truncated flag, and whether the buffer reset/scrolled (restart: true). Use this to observe subagent progress before settlement.',
].join(' ');

/** Subagent concurrency limit (max parallel delegations) */
const SUBAGENT_CONCURRENCY = 4;
const SUBAGENT_TIMEOUT_MS = runtimePolicy.subagentTimeoutMs;

function defaultAgentSessionsDir(): string {
  const base = process.env.PI_CODING_AGENT_DIR || platformPaths.agentDataDir;
  return join(base, 'sessions');
}

function agentRootDir(): string {
  return dirname(defaultAgentSessionsDir());
}

async function readSubagentOutput(
  client: HerdrClientLike,
  paneId: string,
): Promise<{ text: string; revision: number; truncated: boolean }> {
  if (typeof client.readAgent === 'function') {
    try {
      return await client.readAgent(paneId, { source: 'recent', stripAnsi: true });
    } catch {
      return await client.readPane(paneId, { source: 'recent', stripAnsi: true });
    }
  }
  return await client.readPane(paneId, { source: 'recent', stripAnsi: true });
}

export type TaskIdResolutionResult =
  | { kind: 'resolved'; taskId: string }
  | { kind: 'ambiguous'; query: string; candidates: string[] }
  | { kind: 'too_short'; query: string }
  | { kind: 'not_found'; query: string };

/**
 * Resolve a full or short task ID against known candidates.
 *
 * Why (B1): Subagent listings truncate task IDs to 8 hex characters (`taskId.slice(0, 8)`),
 * and users/agents often pass short prefixes. Unique prefix matching (minimum 4 chars)
 * allows unambiguous short IDs to resolve, while ambiguous prefixes fail with actionable
 * candidate listings. Exact matches always resolve regardless of length.
 */
export function resolveTaskIdPrefix(
  query: string,
  candidates: Iterable<string>,
): TaskIdResolutionResult {
  const trimmed = query.trim();
  if (!trimmed) {
    return { kind: 'not_found', query: trimmed };
  }

  const unique = Array.from(new Set(candidates));

  // Exact match wins immediately (even if < 4 chars).
  const exact = unique.find((c) => c === trimmed);
  if (exact) {
    return { kind: 'resolved', taskId: exact };
  }

  // Prefix matching requires at least 4 characters to avoid massive accidental collisions.
  if (trimmed.length < 4) {
    return { kind: 'too_short', query: trimmed };
  }

  const lower = trimmed.toLowerCase();
  const matches = unique.filter((c) => c.toLowerCase().startsWith(lower));

  if (matches.length === 1) {
    return { kind: 'resolved', taskId: matches[0] };
  }
  if (matches.length > 1) {
    matches.sort();
    return { kind: 'ambiguous', query: trimmed, candidates: matches };
  }

  return { kind: 'not_found', query: trimmed };
}

export default function subagentPlugin(ctx: Context): void {
  const surface = ctx.get('pi-herdr.surface') as PiSurface<object>;
  const d = ctx.get('pi-herdr.subagent-deps') as SubagentDeps;
  const { client, env, sessionRoot, port, terminalState } = d;
  const pi = surface.raw as {
    appendEntry?: (customType: string, data: unknown) => void;
    sendUserMessage?: (content: string, opts?: { deliverAs?: string }) => Promise<void>;
  };
  const scoped = surface.forModule(import.meta.url);

  const runtime = {
    nodePath: process.execPath,
    cliPath: process.argv[1] ?? '',
    extPath: d.extPath,
  };
  const subSemaphore = new Semaphore(SUBAGENT_CONCURRENCY);
  /** B4 timestamps machine injection so grace-period working events are not mistaken for takeover. */
  const lastMachineInjectAt = new Map<string, number>();
  /* Persist the subagent registry as custom branch state so parent restarts can rebuild it. */
  const subs = new Map<string, SubEntry>();
  /** In-memory cursor for incremental subagent output observation. */
  const outputCursors = new Map<string, SubagentOutputCursor>();
  /** D98 excludes branches during worktree-add-to-registry races from orphan collection. */
  const pendingIsolateBranches = new Set<string>();
  /** D50 tracks the latest machine request per pane for interrupt claims and poll deduplication. */
  const lastRequestIdByPane = new Map<string, string>();

  /** O1 suppresses duplicate snapshots because 01a03c0d found 48% of session rows were heartbeat repeats. */
  let lastSubsSnapshot = '';

  function persistSubs(): void {
    try {
      const reg = makeRegistry([...subs.values()]);
      const snap = JSON.stringify(reg);
      if (snap === lastSubsSnapshot) return; // Avoid duplicate writes from the 1s/5s observation loops.
      lastSubsSnapshot = snap;
      pi.appendEntry?.(SUBS_CUSTOM_TYPE, reg);
    } catch (err) {
      // Best-effort (session logging must not break delegation) — but a ghost running subagent is the
      // symptom when this silently fails, so keep the reason queryable (B9).
      swallow('subagent.persist-subs', err);
    }
  }
  /** E2 deduplicates gate notices while blocked but permits a later, distinct human question. */
  const blockedGateNotified = new Set<string>();
  const git = createGitIo();

  const boundPort: SubagentPort = {
    applyReplySession(paneId, sessionFile) {
      const entry = subs.get(paneId);
      if (!entry) return;
      const next = applyReportedSessionFile(entry.sessionFile, sessionFile);
      if (next === entry.sessionFile) return;
      entry.sessionFile = next;
      persistSubs();
      writeHistory(entry, undefined, 'session-report');
    },
    reconcileOnReply(paneId) {
      const entry = subs.get(paneId);
      return entry ? d.reconcileOnSettlement(entry.description, 'settled') : [];
    },
    listRunningSubs() {
      return [...subs.values()]
        .filter((s) => s.background && s.status === 'running')
        .map((s) => ({ paneId: s.paneId, description: s.description }));
    },
    async settleStatLine(paneId) {
      const entry = subs.get(paneId);
      return entry ? await git.worktreeStatLine(entry) : null;
    },
  };
  port.current = boundPort;
  ctx.effect(() => () => {
    if (port.current === boundPort) port.current = null;
  }, 'subagent-port');
  function rebuildSubs(eventCtx: unknown): void {
    try {
      const entries = (eventCtx as { sessionManager?: { getBranch?: () => readonly unknown[] } })
        ?.sessionManager?.getBranch?.() ?? [];
      const reg = foldSubsRegistry(entries as Parameters<typeof foldSubsRegistry>[0]);
      for (const sub of reg.subs) subs.set(sub.paneId, sub);
      lastSubsSnapshot = ''; // Force persistence because branch replay replaced live state.
    } catch {
      /* Registry recovery failure must not block the live session. */
    }
  }

  /** B6 closes crash-stale running rows only after herdr confirms their pane is gone; 01a03c0d
   * showed p6/p7 otherwise remained permanently running. */
  async function sweepZombieRunning(): Promise<void> {
    if (!client.available || subs.size === 0) return;
    let livePaneIds: ReadonlySet<string>;
    try {
      livePaneIds = new Set((await client.listPanes()).map((p) => p.paneId));
    } catch {
      return; // Do not close agents when liveness lookup itself failed.
    }
    let changed = false;
    for (const [paneId, e] of subs) {
      if (e.status !== 'running' || livePaneIds.has(paneId)) continue;
      e.status = 'closed';
      writeHistory(e, { status: 'closed', closedAt: Date.now() }, 'zombie-sweep');
      changed = true;
    }
    if (changed) persistSubs();
  }

  scoped.on('session_start', async (_event: unknown, eventCtx: unknown) => {
    rebuildSubs(eventCtx);
    await sweepZombieRunning();
  });
  scoped.on('session_tree', async (_event: unknown, eventCtx: unknown) => {
    rebuildSubs(eventCtx);
    await sweepZombieRunning();
  });

  /* ── B1 liveness rewrite for subagent errors ─────────────────────
   * A false no-output result caused the model to seize work from a healthy subagent. Probe
   * agent.list and session mtime before the tool result enters model context; if alive, emit the
   * same notice as A2 backgrounding. This hook enforces what prompting alone could not. */
  scoped.on('tool_result', async (rawEvent: unknown) => {
    const event = (rawEvent ?? {}) as { toolName?: string; isError?: boolean; content?: Array<{ type: string; text?: string }> };
    if (event.toolName !== 'subagent' || !event.isError) return;
    // Extract only pane ids carried by our own errors; leave unrelated errors untouched.
    const errText = (event.content ?? []).map((c) => c.text ?? '').join(' ');
    const paneId = [...subs.keys()].find((id) => errText.includes(id))
      ?? (errText.match(/\bw[A-Za-z0-9]+:p\d+\b/) ?? [])[0];
    if (!paneId) return;
    const entry = subs.get(paneId);
    if (!entry || entry.status === 'settled' || entry.status === 'consumed') return;
    const probe = await probeAlive(paneId, entry.cwd);
    if (!isAlive(probe, Date.now())) return; // Preserve the original error only when the agent is truly dead.
    // Move a live agent to the poller so its eventual result can replace the false error.
    if (!pollers.has(paneId)) {
      entry.background = true;
      startPoller(paneId, entry.cwd, entry.createdAt, entry.createdAt, entry.description, lastRequestIdByPane.get(paneId) ?? `probe-${paneId}`);
      persistSubs();
    }
    const notice = buildAliveNotice(
      { paneId, description: entry.description, scenario: 'error-alive', probe },
      Date.now(),
    );
    return { content: [{ type: 'text', text: notice }] };
  });

  function histFile(cwd: string): string {
    return preferredHistoryFile(agentRootDir(), cwd);
  }

  function toHistory(e: SubEntry, outcome: string | null): HistoryEntry {
    return {
      taskId: e.taskId,
      kind: e.kind,
      paneId: e.paneId,
      tabId: e.tabId,
      tabName: e.tabName,
      workspaceId: env?.workspaceId ?? '',
      cwd: e.cwd,
      description: e.description,
      sessionFile: e.sessionFile,
      launchCommand: e.launchCommand,
      status: e.status,
      outcome,
      createdAt: e.createdAt,
      consumedAt: e.consumedAt ?? null,
      closedAt: null,
      revivedFrom: e.revivedFrom ?? null,
    };
  }

  /** B5 retains the latest non-empty outcome because closed generations otherwise hid settled
   * results behind outcome:null in latest-generation views. */
  const lastOutcomeByTask = new Map<string, string>();

  function writeHistory(e: SubEntry, patch?: Partial<HistoryEntry>, via?: string): void {
    const outcome = inheritOutcome(lastOutcomeByTask.get(e.taskId), patch?.outcome);
    if (typeof outcome === 'string' && outcome.length > 0) lastOutcomeByTask.set(e.taskId, outcome);
    appendHistory(histFile(e.cwd), { ...toHistory(e, outcome), ...(patch ?? {}), ...(via ? { via } : {}) });
  }

  const injectNotice = (content: string): Promise<void> =>
    d.deliverNotice ? d.deliverNotice(content)
      : (pi.sendUserMessage?.(content, { deliverAs: 'followUp' }) ?? Promise.resolve());

  const session = createSessionIo({
    client,
    getSessionId: d.getSessionId,
    sessionsDir: defaultAgentSessionsDir,
  });
  const spawn = createSpawner({ client, env, runtime, git });
  const poller = createPoller({
    client,
    sessionRoot,
    subs,
    persistSubs,
    writeHistory,
    blockedGateNotified,
    lastMachineInjectAt,
    session,
    git,
    injectNotice,
    reconcileOnSettlement: d.reconcileOnSettlement,
    withReconcileNotes: d.withReconcileNotes,
    claimSettleNotice: d.claimSettleNotice,
  });
  const gc = createGcController({
    client,
    env,
    subs,
    persistSubs,
    writeHistory,
    terminalState,
    noticePending: d.noticePending,
    pendingIsolateBranches,
    git,
    injectNotice,
  });
  gc.startTicker(ctx);
  scoped.on('turn_start', () => gc.onTurnStart());

  const { resolveSessionFile, collectFinalText, readAskFlag, probeAlive, subSessionState } = session;
  const { spawnPaneInTaskTab, launchLine, approveFor, waitSubReady, findExistingPane } = spawn;
  const { startPoller, pollers } = poller;
  const runGit = (...args: Parameters<typeof git.runGit>) => git.runGit(...args);
  const listWorktrees = (...args: Parameters<typeof git.listWorktrees>) => git.listWorktrees(...args);

  /** Revive a closed task; resume and automatic send_message revival share this path. */
  async function reviveEntry(entry: SubEntry): Promise<SubEntry> {
    // D98: Do not revive a released isolate worktree because its directory is gone and cwd is invalid.
    if (entry.isolate?.releasedAt != null) {
      throw new Error(`isolate worktree ${entry.isolate.branch} was released (merged) — delegate a new subagent instead`);
    }
    const latest = latestGeneration(readHistory(histFile(entry.cwd)), entry.taskId) ?? entry;
    const resumeFile = latest.sessionFile && /\.jsonl$/.test(latest.sessionFile) ? latest.sessionFile : null;
    // D86 trust matches spawn: pass -a only for the master's checkout/worktrees; revive has no tool context, so use process cwd.
    const approve = await approveFor(entry.cwd, process.cwd());
    const spawned = await spawnPaneInTaskTab(
      { desiredTab: entry.tabName || latest.tabName || null, description: entry.description },
      entry.cwd,
      { PI_HERDR_SUBAGENT: '1' },
      launchLine(resumeFile, null, approve),
    );
    const ready = await waitSubReady(entry.cwd, spawned.paneId);
    if (!ready.ok) throw new Error(ready.message);
    entry.paneId = spawned.paneId;
    entry.tabId = spawned.tabId;
    entry.tabName = spawned.tabName;
    entry.sessionFile = resumeFile;
    entry.status = 'running';
    entry.consumedAt = null;
    entry.revivedFrom = latest.paneId;
    entry.launchCommand = [launchLine(resumeFile, null, approve)];
    entry.createdAt = Date.now();
    writeHistory(entry, undefined, 'revive');
    return entry;
  }


  async function executeSubagentResume(params: Record<string, unknown> | undefined, toolCtx: unknown) {
      if (!client.available) {
        return toolError('requires a herdr-managed pane.');
      }
      const cwd = (toolCtx as { cwd?: string }).cwd ?? process.cwd();
      const rawTaskId = String(params?.taskId ?? params?.agentId ?? '').trim();
      if (!rawTaskId) {
        return toolError('missing taskId for resume (see action list or delegation ledger).');
      }
      const history = readHistory(histFile(cwd));
      const resolution = resolveTaskIdPrefix(rawTaskId, history.map((e) => e.taskId));
      if (resolution.kind === 'too_short') {
        return toolError(`Error: task id prefix "${rawTaskId}" is too short (minimum 4 characters).`);
      }
      if (resolution.kind === 'ambiguous') {
        const list = resolution.candidates.slice(0, 5).join(', ');
        const more = resolution.candidates.length > 5 ? `, ... (+${resolution.candidates.length - 5} more)` : '';
        return toolError(`Error: ambiguous task id "${rawTaskId}" matches ${resolution.candidates.length} tasks: ${list}${more}`);
      }
      if (resolution.kind === 'not_found') {
        return toolError(`Error: no history for task "${rawTaskId}" in this workspace.`);
      }
      const taskId = resolution.taskId;
      const latest = latestGeneration(history, taskId);
      if (!latest) {
        return toolError(`Error: no history for task "${taskId}" in this workspace.`);
      }
      const release = await subSemaphore.acquire();
      try {
        // D94: Reuse an existing pane for the same session to avoid competing pi processes.
        const existing = await findExistingPane(latest.sessionFile);
        if (existing) {
          const entry: SubEntry = {
            taskId,
            kind: latest.kind,
            paneId: existing.paneId,
            tabId: existing.tabId,
            tabName: latest.tabName ?? tabNameForTask(latest.description),
            cwd,
            description: latest.description,
            background: true,
            status: 'running',
            sessionFile: latest.sessionFile ?? null,
            launchCommand: latest.launchCommand,
            createdAt: Date.now(),
            revivedFrom: latest.paneId,
            consumedAt: null,
          };
          subs.set(entry.paneId, entry);
          persistSubs();
          writeHistory(entry, undefined, 'resume');
          return {
            content: [{
              type: 'text',
              text: `resumed subagent ${entry.paneId} from task ${taskId} (reused existing pane with same session; pi still running there).`,
            }],
            details: { paneId: entry.paneId, taskId },
          };
        }
        // Create a new pane only when no existing one can be reused.
        const entry: SubEntry = {
          taskId,
          kind: latest.kind,
          paneId: '',
          tabId: '',
          tabName: latest.tabName ?? tabNameForTask(latest.description),
          cwd,
          description: latest.description,
          background: true,
          status: 'running',
          sessionFile: latest.sessionFile,
          launchCommand: latest.launchCommand,
          createdAt: Date.now(),
          revivedFrom: latest.paneId,
          consumedAt: null,
        };
        await reviveEntry(entry);
        subs.set(entry.paneId, entry);
        persistSubs();
        return {
          content: [{
            type: 'text',
            text: entry.sessionFile
              ? `resumed subagent ${entry.paneId} from task ${taskId} (session restored).`
              : `resumed subagent ${entry.paneId} from task ${taskId} (session file missing; fresh conversation).`,
          }],
          details: { paneId: entry.paneId, taskId },
        };
      } catch (err) {
        return toolError(`Error: failed to resume task "${taskId}": ${(err as Error).message}`);
      } finally {
        release();
      }
  }

  async function executeSubagentList() {
      const listed = [...subs.values()].filter((s) => s.background);
      if (listed.length === 0) {
        return { content: [{ type: 'text', text: 'No background subagents started (from this session branch).' }], details: {} };
      }
      // Deduplicate by taskId so only the newest generation appears after revival; old paneIds do not repeat.
      const byTask = new Map<string, SubEntry>();
      for (const sub of listed) {
        const prev = byTask.get(sub.taskId);
        if (!prev || sub.createdAt >= prev.createdAt) byTask.set(sub.taskId, sub);
      }
      // C1: Probe liveness in real time (pane status and session activity) so the master can distinguish work from a true hang.
      const probes = new Map<string, AliveProbe>();
      await Promise.all([...byTask.values()].map(async (sub) => {
        if (sub.status === 'closed') return;
        try { probes.set(sub.paneId, await probeAlive(sub.paneId, sub.cwd)); } catch { /* Best effort for display. */ }
      }));
      const lines: string[] = [];
      for (const sub of byTask.values()) {
        const tabTag = sub.tabName ? ` [tab: ${sub.tabName}]` : '';
        // D98: Include the worktree branch on isolate entries, including closed ones; settlement stats already report merge state.
        const wtTag = sub.isolate ? ` [wt: ${sub.isolate.branch}]` : '';
        if (sub.status === 'closed') {
          lines.push(`${sub.taskId.slice(0, 8)} [idle] (${sub.kind}, closed; action send revives)${tabTag}${wtTag} ${sub.description}`);
          continue;
        }
        // The registry is authoritative: settled is idle, everything else is running, including blocked human gates (DSH mapping).
        const state = sub.status === 'settled' ? 'idle' : 'running';
        // D94: Mark when the user has taken over.
        const takeoverMark = sub.userTakeover ? ', user-controlled' : '';
        const probe = probes.get(sub.paneId);
        const statusTag = probe?.agentStatus ? ` ${probe.agentStatus}` : '';
        const activityTag = probe?.lastActivityMs != null ? `, active ${agoText(probe.lastActivityMs, Date.now())}` : '';
        // E: For blocked agents, include the gate-question summary so the master sends the user to that pane instead of taking over.
        let gateTag = '';
        if (probe?.agentStatus === 'blocked') {
          const q = await readAskFlag(sub.paneId);
          gateTag = q ? ` — AWAITING HUMAN: "${q}"` : ' — AWAITING HUMAN decision';
        }
        lines.push(`${sub.paneId} [${state}${takeoverMark}${statusTag}${activityTag}${gateTag}] (${sub.kind})${tabTag}${wtTag} ${sub.description}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
  }

  function resolveSubEntry(
    rawId: string,
    cwd?: string,
  ): { entry: SubEntry } | { error: string } {
    if (!rawId) {
      return { error: 'Error: unknown subagent id "" (see action list)' };
    }
    const direct = subs.get(rawId);
    if (direct) return { entry: direct };

    const byTaskId = new Map<string, SubEntry>();
    for (const sub of subs.values()) {
      const prev = byTaskId.get(sub.taskId);
      if (!prev || sub.createdAt >= prev.createdAt) byTaskId.set(sub.taskId, sub);
    }
    const res = resolveTaskIdPrefix(rawId, byTaskId.keys());
    if (res.kind === 'resolved') {
      return { entry: byTaskId.get(res.taskId)! };
    }
    if (res.kind === 'ambiguous') {
      const list = res.candidates.slice(0, 5).join(', ');
      const more = res.candidates.length > 5 ? `, ... (+${res.candidates.length - 5} more)` : '';
      return { error: `Error: ambiguous subagent id "${rawId}" matches ${res.candidates.length} tasks: ${list}${more}` };
    }
    if (res.kind === 'too_short') {
      return { error: `Error: subagent id prefix "${rawId}" is too short (minimum 4 characters).` };
    }

    if (cwd) {
      const hist = readHistory(histFile(cwd));
      const histTaskIds = Array.from(new Set(hist.map((e) => e.taskId)));
      const histRes = resolveTaskIdPrefix(rawId, histTaskIds);
      if (histRes.kind === 'resolved') {
        const latest = latestGeneration(hist, histRes.taskId);
        if (latest) {
          const entry: SubEntry = {
            taskId: latest.taskId,
            kind: latest.kind,
            paneId: latest.paneId,
            tabId: latest.tabId,
            tabName: latest.tabName ?? '',
            cwd: latest.cwd,
            description: latest.description,
            background: true,
            status: 'closed',
            sessionFile: latest.sessionFile,
            launchCommand: latest.launchCommand,
            createdAt: latest.createdAt,
            consumedAt: latest.consumedAt ?? null,
            revivedFrom: latest.paneId,
          };
          subs.set(entry.paneId, entry);
          return { entry };
        }
      }
      if (histRes.kind === 'ambiguous') {
        const list = histRes.candidates.slice(0, 5).join(', ');
        const more = histRes.candidates.length > 5 ? `, ... (+${histRes.candidates.length - 5} more)` : '';
        return { error: `Error: ambiguous subagent id "${rawId}" matches ${histRes.candidates.length} tasks: ${list}${more}` };
      }
    }

    return { error: `Error: unknown subagent id "${rawId}" (see action list)` };
  }

  async function executeSubagentSend(params: Record<string, unknown> | undefined, toolCtx?: unknown) {
      const rawId = String(params?.agentId ?? params?.taskId ?? '').trim();
      const cwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
      const resolved = resolveSubEntry(rawId, cwd);
      if ('error' in resolved) {
        return toolError(resolved.error);
      }
      const entry = resolved.entry;
      const spawnedAt = Date.now();
      try {
        // A closed task is revived automatically because the pane is only a temporary host.
        if (entry.status === 'closed') {
          await reviveEntry(entry);
          subs.set(entry.paneId, entry);
          persistSubs();
        }
        // M11 (D46): follow_up uses the extension pipe. B3 adds steering so supplemental instructions reach a long-running worker
        // within seconds during a tool-call gap; the old followUp queue waited for the entire run and caused 20-minute rework (01a03c0d).
        const ready = await waitSubReady(entry.cwd, entry.paneId);
        if (!ready.ok) throw new Error(ready.message);
        const fuId = `fu-${Date.now()}`;
        const res = await pipeRequestTo(entry.cwd, entry.paneId, {
          type: 'follow_up',
          id: fuId,
          text: String(params?.message ?? ''),
          from: pipeNameFor(entry.cwd, env?.paneId ?? ''),
          push: true,
          steer: true,
        });
        if (res.type !== 'ok') {
          throw new Error(`pipe follow_up rejected: ${res.type === 'error' ? res.message : 'unknown response'}`);
        }
        lastMachineInjectAt.set(entry.paneId, Date.now()); // B4: attribute working state during the observation window.
        // Regression hardening (D98 liveness evidence): an exception between status='running' and startPoller could leave a ghost
        // running entry without a poller, never settling and skipped by GC; roll back to the previous status on failure.
        const prevStatus = entry.status;
        entry.status = 'running';
        persistSubs();
        try {
          lastRequestIdByPane.set(entry.paneId, fuId);
          startPoller(entry.paneId, entry.cwd, spawnedAt, Date.now(), entry.description, fuId);
        } catch (inner) {
          entry.status = prevStatus;
          persistSubs();
          throw inner;
        }
        return { content: [{ type: 'text', text: `Message sent to subagent ${entry.paneId}.` }], details: { paneId: entry.paneId } };
      } catch (err) {
        return toolError(`Error: failed to reach subagent ${entry.paneId}: ${(err as Error).message}`);
      }
  }

  async function executeSubagentInterrupt(params: Record<string, unknown> | undefined, toolCtx?: unknown) {
      const rawId = String(params?.agentId ?? params?.taskId ?? '').trim();
      const cwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
      const resolved = resolveSubEntry(rawId, cwd);
      if ('error' in resolved) {
        return toolError(resolved.error);
      }
      const entry = resolved.entry;
      if (entry.status === 'closed') {
        // DSH alignment: an idle or finished target is an idempotent no-op.
        return { content: [{ type: 'text', text: `Interrupt accepted for subagent ${entry.paneId} (already idle/closed; no-op).` }], details: {} };
      }
      try {
        const res = await pipeRequestTo(entry.cwd, entry.paneId, {
          type: 'interrupt',
          id: `int-${Date.now()}`,
        });
        if (res.type !== 'ok') {
          throw new Error(`pipe interrupt rejected: ${res.type === 'error' ? res.message : 'unknown response'}`);
        }
        // Do not send a settlement notice for an interrupted turn because the requester already knows.
        const lastId = lastRequestIdByPane.get(entry.paneId);
        if (lastId) d.claimSettleNotice(`${entry.paneId}:${lastId}`);
        return { content: [{ type: 'text', text: `Interrupt accepted for subagent ${entry.paneId} (fire-and-return).` }], details: { paneId: entry.paneId } };
      } catch (err) {
        return toolError(`Error: failed to reach subagent ${entry.paneId}: ${(err as Error).message}`);
      }
  }

  async function executeSubagentOutput(params: Record<string, unknown> | undefined, toolCtx?: unknown) {
    const rawId = String(params?.agentId ?? params?.taskId ?? '').trim();
    if (!rawId) {
      return toolError('Error: missing agentId for output (see action list)');
    }
    const cwd = (toolCtx as { cwd?: string })?.cwd ?? process.cwd();
    const resolved = resolveSubEntry(rawId, cwd);
    if ('error' in resolved) {
      return toolError(resolved.error);
    }
    const entry = resolved.entry;
    let agentState: HerdrAgentState | null = null;
    let askFlag: string | null = null;
    try {
      const agents = await client.listAgents();
      const a = agents.find((x) => x.paneId === entry.paneId);
      agentState = a?.status ?? null;
      askFlag = a?.tokens?.['pi-ask'] ?? null;
    } catch {
      /* Best effort */
    }
    if (!askFlag && agentState === 'blocked') {
      try {
        askFlag = await readAskFlag(entry.paneId);
      } catch {
        /* Best effort */
      }
    }
    const status = resolveSubagentStatus({
      localStatus: entry.status,
      herdrStatus: agentState,
      hasAskFlag: Boolean(askFlag),
    });

    let rawRead: { text: string; revision: number; truncated: boolean };
    try {
      rawRead = await readSubagentOutput(client, entry.paneId);
    } catch (err) {
      return toolError(`Error: failed to read output for subagent ${entry.paneId}: ${(err as Error).message}`);
    }

    const prevCursor = outputCursors.get(entry.paneId);
    const maxChars = typeof params?.max_chars === 'number'
      ? params.max_chars
      : typeof params?.maxChars === 'number'
        ? params.maxChars
        : undefined;
    const deltaResult = computeSubagentOutputDelta(prevCursor, rawRead.text, { maxChars });
    outputCursors.set(entry.paneId, deltaResult.nextCursor);

    const formatted = formatSubagentOutput({
      paneId: entry.paneId,
      status,
      revision: rawRead.revision,
      bufferTruncated: rawRead.truncated,
      deltaResult,
      askQuestion: askFlag,
    });

    return {
      content: [{ type: 'text', text: formatted }],
      details: {
        paneId: entry.paneId,
        status,
        revision: rawRead.revision,
        truncated: rawRead.truncated || deltaResult.truncated,
        restart: deltaResult.restart,
        deltaLength: deltaResult.delta.length,
      },
    };
  }

  scoped.registerTool({
    name: 'subagent',
    label: 'Subagent',
    // B4: the model picks tools from the system prompt's snippet/guideline surface; this tool is the
    // one place where delegation decisions are made, so state them here rather than hoping for recall.
    promptSnippet: 'subagent: delegate a self-contained task to a pi worker pane (spawn/isolate/background/send/output/interrupt/resume/list).',
    promptGuidelines: [
      'Use subagent when the work is self-contained and the result is what matters: pipelines that would flood this context, long builds/test runs, or independent parts of a bigger change that can proceed in parallel.',
      'Prefer run_in_background: true for work that will not finish in a few tool calls, then collect with action: "output" — a foreground subagent blocks this turn.',
      'Use isolate: true when the worker will write files for a task you (or another worker) are editing at the same time, or when you want its own reviewable branch; use cwd to send work into an existing worktree (create it with git worktree add first).',
      'Keep the prompt complete and self-contained: the worker does not see this conversation, so include paths, acceptance criteria, the test command, and what to report back.',
      'Do not poll with action: "output" in a tight loop: the pane pushes a settlement notice when it finishes. Check once, then continue other work.',
      'Send follow-up instructions with action: "send" (delivered as a steer between tool calls) instead of spawning a second worker for the same task.',
    ],
    description: SUBAGENT_DESCRIPTION,
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('spawn'),
        Type.Literal('resume'),
        Type.Literal('list'),
        Type.Literal('send'),
        Type.Literal('interrupt'),
        Type.Literal('output'),
      ], { description: 'Operation to perform (default: spawn)' })),
      description: Type.Optional(Type.String({ description: '[spawn] Short label for this subtask (pane title)' })),
      prompt: Type.Optional(Type.String({ description: '[spawn] The complete self-contained task for the subagent' })),
      run_in_background: Type.Optional(Type.Boolean({ description: '[spawn] Return immediately with an agentId; the subagent keeps running in its own pane (default false)' })),
      cwd: Type.Optional(Type.String({ description: '[spawn] Working directory for the subagent (absolute, or relative to this workspace). Use it to delegate into a git worktree: panes group by worktree — same checkout as you share your tab; a separate worktree gets its own tab named after the worktree directory. Create worktrees yourself with git worktree add. Use isolate:true instead when you want a FRESH worktree created for this task rather than targeting an existing one' })),
      isolate: Type.Optional(Type.Boolean({ description: '[spawn] Create a fresh git worktree and run the subagent there. Use when the task writes files heavily and independently — in parallel with your own edits or other workers\' — or needs its own clean, reviewable diff. For read-mostly or sequential helper work omit it (shared checkout, writes guarded by the write-lock); use `cwd` only to target an existing directory/worktree (e.g. a retained pier worktree). Mechanics: branch pier/<slug> from your HEAD under ~/.herdr/worktrees/<repo>/; its writes cannot conflict with your checkout; panes group into a tab named after the worktree; the prompt is prefixed with commit discipline (commit to its branch, never push); on settle you get a diff summary. Review with git log/diff HEAD..<branch>, merge with git merge --no-ff <branch>; once merged and clean the worktree auto-removes (branch kept). Mutually exclusive with cwd' })),
      role: Type.Optional(Type.String({ description: '[spawn] Role label or profile name. When role matches a profile (searched: workspace .pi-herdr/roles/ → user-global ~/.pi/agent/herdr-pi/roles/ → builtin), the worker toolset becomes the composed manifest. Unknown role names remain display labels only.' })),
      tab: Type.Optional(Type.String({ description: '[spawn] Name of a task tab to place the subagent into (join if exists, otherwise create). Default placement groups by git worktree.' })),
      allowed_tools: Type.Optional(Type.Array(Type.String(), { description: '[spawn] Additional tools for role composition (union with role baseline)' })),
      taskId: Type.Optional(Type.String({ description: '[resume] The task id to revive from the delegation ledger' })),
      agentId: Type.Optional(Type.String({ description: '[send|interrupt|output] The subagent id (herdr pane id)' })),
      message: Type.Optional(Type.String({ description: '[send] The follow-up message' })),
      max_chars: Type.Optional(Type.Integer({ description: '[output] Maximum characters of output delta to return (default 6000, 100-16000)' })),
    }),
    // B2: 23/38 real spawns omitted `action` even though it is optional; normalize so the schema the
    // model is validated against and the code path never disagree, and so `spawn` is explicit in logs.
    prepareArguments: (args: unknown) => {
      const rec = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
      const hasAction = typeof rec.action === 'string' && rec.action.trim() !== '';
      return hasAction ? rec : { ...rec, action: 'spawn' };
    },
    async execute(toolCallId: string, params: ToolParams, signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined, toolCtx: unknown) {
      void toolCallId;
      void signal;
      const action = typeof params?.action === 'string' && params.action.trim() ? params.action.trim() : 'spawn';
      if (action === 'resume') return executeSubagentResume(params, toolCtx);
      if (action === 'list') return executeSubagentList();
      if (action === 'send') return executeSubagentSend(params, toolCtx);
      if (action === 'interrupt') return executeSubagentInterrupt(params, toolCtx);
      if (action === 'output') return executeSubagentOutput(params, toolCtx);
      if (action !== 'spawn') {
        return toolError(`Error: unknown action "${action}" (valid: spawn, resume, list, send, interrupt, output)`);
      }
      const launch = planLaunchValidation(params, client.available);
      if (launch.kind === 'error') {
        return toolError(launch.text);
      }
      const { spec, background, isolate, cwdParam, roleKind: kind, suggested, manifestRole, tab } = launch;
      const masterCwd = (toolCtx as { cwd?: string }).cwd ?? process.cwd();
      // Move taskId generation above the original spawn section because isolate planning needs taskHex; this is behavior-neutral.
      const taskId = randomUUID();
      // D98 2c: Create the isolate through pier's execFile git path (decision 1), not herdr's
      // socket worktree.create, which has bootstrap races, missing root-pane env, worker/master
      // workspace separation, and linked_worktree_source rejection. The model makes the decision; do not infer it.
      let isolateMeta: SubEntry['isolate'] | null = null;
      let cwd = masterCwd;
      if (isolate) {
        const baseSha = await runGit(masterCwd, ['rev-parse', 'HEAD']);
        const isoGuard = planIsolateRepoGuard(baseSha);
        if (isoGuard.kind === 'error') {
          return toolError(isoGuard.text);
        }
        const sha = isoGuard.sha.trim();
        const pierBranches = new Set(
          ((await runGit(masterCwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/pier/'])) ?? '')
            .split('\n').filter(Boolean),
        );
        const worktrees = await listWorktrees(masterCwd);
        const repoName = basename(worktrees[0] ?? masterCwd);
        const plan = planIsolateWorktree({
          description: spec.description,
          taskHex: taskId.slice(0, 6),
          existingPierBranches: pierBranches,
        });
        const wtPath = join(platformPaths.worktreeBaseDir, repoName, plan.worktreeDirName);
        try {
          mkdirSync(dirname(wtPath), { recursive: true }); // git worktree add does not create its parent directory, so a first run would fail.
        } catch { /* Existing directory or permissions failure is handled by worktree add. */ }
        // Keep the branch pending between worktree add and subs.set: the 2–3s readiness wait lets the ticker
        // scan, and without this guard it could reclaim a new clean =HEAD-ancestor worktree as an orphan.
        pendingIsolateBranches.add(plan.branch);
        const added = await runGit(masterCwd, ['worktree', 'add', '-b', plan.branch, wtPath, sha]);
        if (added === null) {
          pendingIsolateBranches.delete(plan.branch);
          return toolError(`Error: failed to create worktree ${wtPath} (branch ${plan.branch}) — run \`git worktree prune\` and retry if it reports stale entries`);
        }
        git.invalidateWorktreesCache(); // Invalidate the 5s cache so the zone classifier sees the new worktree immediately.
        cwd = wtPath;
        isolateMeta = { worktreePath: wtPath, branch: plan.branch, baseSha: sha, releasedAt: null, retainNotified: false };
        spec.prompt = `${buildIsolatePreamble({ worktreePath: wtPath, branch: plan.branch, baseShort: sha.slice(0, 7) })}\n\n${spec.prompt}`;
      } else if (cwdParam) {
        cwd = pathResolve(masterCwd, cwdParam);
        try {
          const st = await statAsync(cwd);
          if (!st.isDirectory()) throw new Error('not a directory');
        } catch {
          return toolError(`Error: \`cwd\` is not an existing directory: ${cwdParam}`);
        }
      }
      // D86 R1: Group by the git worktree containing cwd (main checkout → main tab; other worktree → directory-named tab).
      const zone = classifyWorktreeZone({
        cwd,
        masterCwd,
        worktrees: await listWorktrees(masterCwd),
      });
      // D86 trust: pass -a only for the master's checkout/worktrees; external directories remain behind pi's Trust dialog.
      const approve = isPathUnder(cwd, masterCwd) || zone.zone === 'worktree';
      let roleManifestEnv: Record<string, string> = {};
      let roleModel: string | null = null;
      try {
        // planLaunchValidation always names a role ('worker-default' by default); keep the same fallback
        // here for callers that build a launch spec directly.
        const roleName = manifestRole ?? 'worker-default';
        const { role, manifest } = composeForRole(roleName, suggested, { loadRoleOpts: { baseDir: masterCwd } });
        roleManifestEnv = {
          PI_HERDR_ROLE_MANIFEST: JSON.stringify({
            role: role.role,
            version: role.version,
            tools: manifest.tools,
            permissions: manifest.permissions,
            unknownTools: manifest.unknownTools,
            services: role.services ?? {},
          }),
        };
        // WS-D10: Route the model by role; omission intentionally uses the process default.
        if (typeof role.model === 'string' && role.model.trim()) roleModel = role.model.trim();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return toolError(`Error: role "${manifestRole}" manifest invalid — ${msg}`);
      }
      const release = await subSemaphore.acquire();
      let paneId = '';
      try {
        const spawnedAt = Date.now();
        const spawned = await spawnPaneInTaskTab(
          { desiredTab: tab, description: spec.description, zone },
          cwd,
          { PI_HERDR_SUBAGENT: '1', ...roleManifestEnv },
          launchLine(null, roleModel, approve),
        );
        paneId = spawned.paneId;
        const entry: SubEntry = {
          taskId,
          kind,
          paneId,
          tabId: spawned.tabId,
          tabName: spawned.tabName,
          cwd,
          description: spec.description,
          background,
          status: 'running',
          sessionFile: null,
          launchCommand: [launchLine(null, roleModel, approve)],
          createdAt: Date.now(),
          revivedFrom: null,
          ...(isolateMeta ? { isolate: isolateMeta } : {}),
        };
        const ready = await waitSubReady(cwd, paneId);
        if (!ready.ok) throw new Error(ready.message);
        entry.sessionFile = await resolveSessionFile(paneId, cwd);
        subs.set(paneId, entry);
        persistSubs();
        onUpdate?.(makeProgressUpdate(`subagent ready in pane ${paneId}; injecting prompt via pipe…`));
        // M11 (D45/D46): Inject through the extension pipe to the child extension's sendUserMessage(followUp);
        // reserve the PTY keyboard channel entirely for the person, with no soft-lock window or mixed input.
        // Regression evidence (session 01a03bf0): ecc0bc4's foreground-wait rewrite once removed this block,
        // leaving the prompt uninjected and injectTs undefined (ReferenceError → spawn-failed, with a ghost
        // running ledger entry). Keep injection and injectTs together in future refactors.
        const injectTs = Date.now();
        const injected = await pipeRequestTo(cwd, paneId, {
          type: 'prompt',
          id: `prompt-${taskId}`,
          text: spec.prompt,
          from: pipeNameFor(cwd, env?.paneId ?? ''),
          push: background,
        });
        if (injected.type !== 'ok') {
          throw new Error(`pipe prompt rejected: ${injected.type === 'error' ? injected.message : 'unknown response'}`);
        }
        lastMachineInjectAt.set(paneId, injectTs); // B4: attribute working state during the observation window.

        // A7: run_in_background returns immediately after successful injection instead of blocking in foreground wait.
        if (background) {
          entry.background = true;
          lastRequestIdByPane.set(paneId, `prompt-${taskId}`);
          startPoller(paneId, cwd, spawnedAt, injectTs, spec.description, `prompt-${taskId}`);
          persistSubs();
          writeHistory(entry, undefined, 'to-background');
          return {
            content: [{ type: 'text', text: `started subagent ${paneId} (task ${taskId})` }],
            details: { paneId, taskId, background: true, role: kind },
          };
        }

        // A1+A2 (user-verified fix): foreground waiting uses a content gate plus a patience threshold before backgrounding.
        // Treating idle as settled with a hard 90s window misclassified real 4–6 minute working periods as no-output;
        // three healthy subagents were observed becoming consumed at 101s while producing results four minutes later.
        const PATIENCE_MS = runtimePolicy.foregroundPatienceMs;
        const patienceDeadline = Date.now() + PATIENCE_MS;
        let text: string | null = null;
        let settledKind: 'settled' | 'timeout' = 'timeout';
        while (Date.now() < Math.min(patienceDeadline, spawnedAt + SUBAGENT_TIMEOUT_MS)) {
          const state = await client.waitAgent(paneId, ['idle', 'done', 'blocked'], 30_000);
          const session = (state === 'idle' || state === 'done')
            ? await subSessionState(paneId, cwd, injectTs)
            : { text: null, pendingTool: false, activity: false };
          const tick = planForegroundTick({ state, session });
          if (tick.kind === 'blocked') {
            const question = await readAskFlag(paneId);
            entry.background = true;
            lastRequestIdByPane.set(paneId, `prompt-${taskId}`);
            startPoller(paneId, cwd, spawnedAt, injectTs, spec.description, `prompt-${taskId}`);
            persistSubs();
            writeHistory(entry, undefined, 'to-background');
            return {
              content: [{ type: 'text', text: buildBlockedGateNotice({ paneId, description: spec.description, question }) }],
              details: { paneId, taskId, background: true, blocked: true, role: kind },
            };
          }
          if (tick.kind === 'settled') {
            text = tick.text;
            settledKind = 'settled';
            break;
          }
          if (tick.kind === 'wait') {
            await new Promise((r) => setTimeout(r, tick.delayMs));
            continue;
          }
          if (tick.kind === 'collect-final') {
            text = await collectFinalText(paneId, cwd, injectTs, 6);
            if (text) { settledKind = 'settled'; break; }
            await new Promise((r) => setTimeout(r, FOREGROUND_POLL_MS));
            continue;
          }
        }
        if (!text) {
          const probe = await probeAlive(paneId, cwd);
          if (planPatienceExpiry(isAlive(probe, Date.now())) === 'move-to-background') {
            entry.background = true;
            lastRequestIdByPane.set(paneId, `prompt-${taskId}`);
            startPoller(paneId, cwd, spawnedAt, injectTs, spec.description, `prompt-${taskId}`);
            persistSubs();
            const notice = buildAliveNotice(
              { paneId, description: spec.description, scenario: 'moved-to-bg', probe },
              Date.now(),
            );
            return {
              content: [{ type: 'text', text: notice }],
              details: { paneId, taskId, background: true, movedToBackground: true, role: kind },
            };
          }
          settledKind = 'timeout';
        }
        const outcome =
          settledKind === 'timeout' ? { kind: 'timeout' as const, text: text ?? '' }
          : text ? { kind: 'completed' as const, text }
          : { kind: 'no-output' as const, text: '' };
        entry.status = 'consumed';
        entry.consumedAt = Date.now();
        persistSubs();
        writeHistory(entry, { outcome: outcome.kind === 'completed' ? text : null }, 'fg-settle');
        return {
          content: [{ type: 'text', text: formatSubagentResult(outcome, spec.description) }],
          details: { paneId, taskId, background, role: kind },
        };
      } catch (err) {
        // Regression fix (session 01a03bf0): a mid-spawn failure must remove the ledger entry and close its pane,
        // otherwise a ghost running entry never settles, causing D96 reminder storms and send_message calls
        // to land in an empty session with no task context. Pane closure is best effort; GC covers board exceptions.
        if (paneId) {
          subs.delete(paneId);
          persistSubs();
          void client.closePane(paneId).catch(() => { /* Best effort only. */ });
        }
        // D98 2d: If isolate startup never becomes ready, best-effort remove the new worktree and branch (no work
        // exists to preserve); failure stays silent because the branch is harmless and remains visible to git worktree list.
        if (isolateMeta) {
          void runGit(masterCwd, ['worktree', 'remove', '--force', isolateMeta.worktreePath])
            .then(() => runGit(masterCwd, ['branch', '-D', isolateMeta!.branch]))
            .catch(() => { /* Best effort only. */ });
        }
        return {
          content: [{
            type: 'text',
            text: formatSubagentResult(
              { kind: 'spawn-failed', text: String((err as Error)?.message ?? err) },
              spec.description,
            ),
          }],
          details: {},
        };
      } finally {
        release();
        if (isolateMeta) pendingIsolateBranches.delete(isolateMeta.branch); // D98: release the creation-window guard on every success/failure path.
      }
    },
  });
}

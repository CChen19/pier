/**
 * M23 heat reflow domain logic (migrated from scripts/heat-reflow.mjs).
 *
 * All dependencies are injected via `ReflowDeps`. Planner is in heat-layout.ts.
 * Hook processes do not use cordis: user-mode GitHub checkout lacks node_modules.
 */
import {
  REFLOW_DEBOUNCE_MS,
  countPanes,
  firstPaneId,
  planGridHeat,
  shouldAcceptFocus,
  shouldFireDebounced,
  unwrapLayout,
  type AgentStatusMap,
} from './heat-layout.ts';

export interface ReflowEvent {
  hook: string;
  type: string;
  paneId: string | null;
  workspaceId: string | null;
  tabId: string | null;
  cause: string | null;
}

export interface ReflowDeps {
  ev: ReflowEvent;
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  loadState: () => Record<string, unknown>;
  saveState: (state: Record<string, unknown>) => void;
  /** Injected for testing (production = setTimeout sleep). */
  sleep: (ms: number) => Promise<void>;
  /** Tier 2 semantic bridge: pulls agent status snapshot on event (pane.list; default = unranked). */
  listAgentStatuses?: () => Promise<AgentStatusMap>;
  /** D95: ask_user_question waiting flag (tokens['pi-ask'] non-empty). Default = no ask. */
  listAskFlags?: () => Promise<Record<string, boolean>>;
  /**
   * Tightening gate (Scenario B isolation): tabs containing pi agent panes — non-pi tabs (claude code /
   * codex / pure shell) do not reflow. Default = no filter (unit test / legacy backward compatibility).
   */
  piTabIds?: () => Promise<Set<string>>;
}

/** Whether the tab belongs to pier (contains pi panes). Passes through if dep omitted; snapshot failure treated as not in set (conservative no-op). */
async function isPiTab(deps: ReflowDeps, tabId: string): Promise<boolean> {
  if (!deps.piTabIds) return true;
  try { return (await deps.piTabIds()).has(tabId); } catch { return false; }
}
type ReflowState = Record<string, any>;

async function onCreated(deps: ReflowDeps, paneId: string): Promise<void> {
  const state = deps.loadState();
  state.panes = state.panes ?? {};
  if (!state.panes[paneId]) state.panes[paneId] = { createdAt: Date.now() };
  // D95: record pane->tab mapping (pane.closed event lacks tab_id, needs reverse lookup to reflow on close)
  if (deps.ev.tabId) state.panes[paneId].tabId = deps.ev.tabId;
  deps.saveState(state);
  // D95: pane count changed -> triggers count reflow (dimensions recomputed by tier weights, positions unchanged; focus inherits lastFocus)
  await onCountChanged(deps);
}

/**
 * D95 shared reflow core: debounce -> layout.export(pane_id) -> focus inherits lastFocus (or falls back to first)
 * -> applyTiered -> record tab state. Shared across count/status/closed (focus events have their own path).
 */
async function onCountChanged(deps: ReflowDeps): Promise<void> {
  const paneId = deps.ev.paneId;
  const now = Date.now();
  const state0 = deps.loadState() as ReflowState;
  const token = `cnt:${now}:${paneId ?? ''}`;
  state0.debounce = { token, paneId, at: now };
  deps.saveState(state0);
  await deps.sleep(REFLOW_DEBOUNCE_MS);
  const latest = deps.loadState() as ReflowState;
  if (!shouldFireDebounced({ stored: latest.debounce?.token ?? '', incoming: token })) return;

  const evPaneId = deps.ev.paneId;
  const latest0 = deps.loadState() as ReflowState;
  // D95: closed event has no tab_id -> reverse lookup tab from pane mapping (recorded by onCreated); if still missing -> fall back to export
  const closedTab = evPaneId && (latest0.panes?.[evPaneId] as { tabId?: string } | undefined)?.tabId;
  const exported = await deps.request('layout.export', closedTab
    ? { tab_id: closedTab }
    : (evPaneId ? { pane_id: evPaneId } : {}));
  const { root, tabId: exportedTabId, zoomed } = unwrapLayout(exported);
  const tabId = exportedTabId ?? deps.ev.tabId;
  if (!root || !tabId) return;
  if (!(await isPiTab(deps, tabId))) return;
  const tabCfg = latest.tabs?.[tabId] ?? { enabled: true };
  const lastFocus = typeof (tabCfg as { lastFocusPaneId?: unknown }).lastFocusPaneId === 'string'
    ? (tabCfg as { lastFocusPaneId: string }).lastFocusPaneId
    : null;
  const focusPaneId = lastFocus && flattenIn(root, lastFocus) ? lastFocus : firstPaneId(root);
  const applied = await applyTiered(deps, { root, tabId, focusPaneId, zoomed, tabCfg });
  if (!applied) return;
  latest.tabs = latest.tabs ?? {};
  latest.tabs[tabId] = { ...tabCfg, lastFocusPaneId: focusPaneId, lastApplyAt: Date.now() };
  deps.saveState(latest);
}

/** Tier 3 shared core: fetch status snapshot -> in-place grid planning -> apply -> record tab state. */
async function applyTiered(
  deps: ReflowDeps,
  opts: { root: ReturnType<typeof unwrapLayout>['root']; tabId: string; focusPaneId: string; zoomed: boolean; tabCfg: Record<string, unknown> },
): Promise<boolean> {
  const statuses = await (deps.listAgentStatuses?.() ?? Promise.resolve({}));
  const askFlags = await (deps.listAskFlags?.() ?? Promise.resolve({}));
  const plan = planGridHeat({
    root: opts.root!,
    focusPaneId: opts.focusPaneId,
    paneCount: countPanes(opts.root!),
    zoomed: opts.zoomed,
    enabled: (opts.tabCfg as { enabled?: boolean }).enabled !== false,
    statuses,
    askFlags,
  });
  if (plan.type !== 'apply') return false;
  // D91 in-place grid heat: only emits ratio ops (zero swaps — pane positions stay fixed, focused cell expands in place)
  for (const op of plan.ops) {
    await deps.request('layout.set_split_ratio', { tab_id: opts.tabId, path: op.path, ratio: op.ratio });
  }
  return true;
}

async function onFocused(deps: ReflowDeps): Promise<void> {
  const paneId = deps.ev.paneId;
  if (!paneId) return;
  const now = Date.now();
  const state = deps.loadState();
  state.panes = state.panes ?? {};
  // d90 Tier 2 fix: unrecorded pane (plugin has not seen pane.created) = existing pane -> accept immediately.
  // Previously improvised createdAt=now -> rejected within 3s whitelist -> tabs with old panes never reflowed
  // (d90 empirical evidence: rapid clicks on p1/p3F all rejected). Only known panes pass through the age gate (F1: suppresses spawn auto-focus).
  const known = Boolean(state.panes[paneId]);
  if (known) {
    const age = now - state.panes[paneId].createdAt;
    if (!shouldAcceptFocus({ paneAgeMs: age, cause: deps.ev.cause })) return;
  }

  const token = `${now}:${paneId}`;
  state.debounce = { token, paneId, at: now };
  deps.saveState(state);
  await deps.sleep(REFLOW_DEBOUNCE_MS);
  const latest = deps.loadState() as ReflowState;
  if (!shouldFireDebounced({ stored: latest.debounce?.token ?? '', incoming: token })) return;

  const exported = await deps.request('layout.export', { pane_id: paneId });
  const { root, tabId: exportedTabId, zoomed } = unwrapLayout(exported);
  const tabId = exportedTabId ?? deps.ev.tabId;
  if (!root || !tabId) return;
  if (!(await isPiTab(deps, tabId))) return;
  const tabCfg = latest.tabs?.[tabId] ?? { enabled: true };
  const applied = await applyTiered(deps, { root, tabId, focusPaneId: paneId, zoomed, tabCfg });
  if (!applied) return;
  latest.tabs = latest.tabs ?? {};
  latest.tabs[tabId] = { ...tabCfg, lastFocusPaneId: paneId, lastApplyAt: Date.now() };
  deps.saveState(latest);
}

/**
 * Tier 2 semantic bridge (D90-F): agent status changes (blocked appears/disappears) -> event-driven reflow.
 * Focus stays fixed (inheriting tab's lastFocusPaneId); re-sorts and redistributes weights only within secondary panes.
 * No polling: pane.agent_status_changed event is pushed immediately (D3 compliant, zero new protocols).
 */
async function onAgentStatusChanged(deps: ReflowDeps): Promise<void> {
  const paneId = deps.ev.paneId;
  if (!paneId) return;
  const now = Date.now();
  const state = deps.loadState() as ReflowState;

  const token = `st:${now}:${paneId}`;
  state.debounce = { token, paneId, at: now };
  deps.saveState(state);
  await deps.sleep(REFLOW_DEBOUNCE_MS);
  const latest = deps.loadState() as ReflowState;
  if (!shouldFireDebounced({ stored: latest.debounce?.token ?? '', incoming: token })) return;

  const exported = await deps.request('layout.export', { pane_id: paneId });
  const { root, tabId: exportedTabId, zoomed } = unwrapLayout(exported);
  const tabId = exportedTabId ?? deps.ev.tabId;
  if (!root || !tabId) return;
  if (!(await isPiTab(deps, tabId))) return;
  const tabCfg = latest.tabs?.[tabId] ?? { enabled: true };
  // Focus inherits lastFocus; if pane is not in tree or never focused -> degrade to first pane
  const lastFocus = typeof (tabCfg as { lastFocusPaneId?: unknown }).lastFocusPaneId === 'string'
    ? (tabCfg as { lastFocusPaneId: string }).lastFocusPaneId
    : null;
  const focusPaneId = lastFocus && flattenIn(root, lastFocus) ? lastFocus : firstPaneId(root);
  const applied = await applyTiered(deps, { root, tabId, focusPaneId, zoomed, tabCfg });
  if (!applied) return;
  latest.tabs = latest.tabs ?? {};
  latest.tabs[tabId] = { ...tabCfg, lastFocusPaneId: focusPaneId, lastApplyAt: Date.now() };
  deps.saveState(latest);
}

function flattenIn(root: ReturnType<typeof unwrapLayout>['root'], paneId: string): boolean {
  if (!root) return false;
  const walk = (n: NonNullable<typeof root>): boolean =>
    n.type === 'pane' ? n.pane_id === paneId : walk(n.first) || walk(n.second);
  return walk(root);
}

/**
 * Parses Herdr hook event environment variables (HERDR_PLUGIN_EVENT / _EVENT_JSON).
 * Real payloads have two shapes (empirically confirmed in spike d84 dump):
 *  - pane_focused flat: {"event":"pane_focused","data":{"type","pane_id","workspace_id"}} (no cause)
 *  - pane_created nested: {"event":"pane_created","data":{"type","pane":{pane_id,...}}}
 * Compatible with manual/test flat + cause shapes (d84-manual: data.pane_id + cause=user).
 */
export function parseEventEnv(env: Record<string, string | undefined> = process.env): ReflowEvent {
  let event: Record<string, any> = {};
  try { event = JSON.parse(env.HERDR_PLUGIN_EVENT_JSON ?? '{}'); } catch { /* empty */ }
  const hook = env.HERDR_PLUGIN_EVENT ?? event.type ?? '';
  const data = event.data ?? event;
  const pane = data.pane && typeof data.pane === 'object' ? data.pane : {};
  return {
    hook,
    type: event.type ?? hook,
    paneId: data.pane_id ?? pane.pane_id ?? event.pane_id ?? null,
    workspaceId: data.workspace_id ?? pane.workspace_id ?? event.workspace_id ?? null,
    tabId: data.tab_id ?? pane.tab_id ?? event.tab_id ?? null,
    cause: data.cause ?? pane.cause ?? event.cause ?? null,
  };
}

/** Domain workflow (independently unit testable). */
export async function runReflow(deps: ReflowDeps): Promise<void> {
  const isCreated = /pane\.created|pane_created/i.test(String(deps.ev.hook) + String(deps.ev.type));
  const isFocused = /pane\.focused|pane_focused/i.test(String(deps.ev.hook) + String(deps.ev.type));
  const isStatus = /pane\.agent_status_changed/i.test(String(deps.ev.hook) + String(deps.ev.type));
  const isClosed = /pane\.closed|pane_closed/i.test(String(deps.ev.hook) + String(deps.ev.type));
  if (isClosed) {
    // D95: pane recycling (subagent finished and GC'd) -> count reflow (tree contracts; positions natural, no migration)
    await onCountChanged(deps);
    return;
  }
  if (isCreated && deps.ev.paneId) {
    await onCreated(deps, deps.ev.paneId);
    return;
  }
  if (isFocused) {
    await onFocused(deps);
    return;
  }
  if (isStatus) {
    await onAgentStatusChanged(deps);
  }
}

export default function reflowPlugin(ctx: { get: (k: string) => unknown }): Promise<void> {
  return runReflow(ctx.get('workbench.deps') as ReflowDeps);
}

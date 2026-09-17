/**
 * Pure model and formatting logic for the Pier Ops Dashboard.
 *
 * Composes a readable, formatted ops dashboard from Herdr's session snapshot.
 * Designed as a pure function (no I/O or global state) to allow complete offline unit testing.
 */

export interface SnapshotWorkspace {
  workspace_id: string;
  number?: number;
  label?: string;
  focused?: boolean;
  pane_count?: number;
  tab_count?: number;
  active_tab_id?: string;
  agent_status?: string;
}

export interface SnapshotTab {
  tab_id: string;
  workspace_id: string;
  number?: number;
  label?: string;
  focused?: boolean;
  pane_count?: number;
  agent_status?: string;
}

export interface SnapshotPane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  terminal_id?: string;
  focused?: boolean;
  agent_status?: string;
  agent?: string | null;
  display_agent?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  tokens?: Record<string, string>;
  state_labels?: Record<string, string>;
}

export interface SessionSnapshotData {
  version?: string;
  protocol?: number;
  workspaces?: SnapshotWorkspace[];
  tabs?: SnapshotTab[];
  panes?: SnapshotPane[];
  focused_workspace_id?: string | null;
  focused_tab_id?: string | null;
  focused_pane_id?: string | null;
}

export interface ComposeDashboardOptions {
  targetWorkspaceId?: string | null;
  now?: number;
}

/**
 * Normalizes raw socket responses into SessionSnapshotData.
 * Supports:
 *   - Direct SessionSnapshot object
 *   - Wrapped { snapshot: ... }
 *   - Wrapped { result: { snapshot: ... } }
 */
export function normalizeSnapshot(raw: unknown): SessionSnapshotData | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;
  const candidate = (root.result && typeof root.result === 'object' && (root.result as Record<string, unknown>).snapshot)
    ? (root.result as Record<string, unknown>).snapshot
    : (root.snapshot && typeof root.snapshot === 'object')
      ? root.snapshot
      : root;

  if (!candidate || typeof candidate !== 'object') return null;
  const s = candidate as Record<string, unknown>;

  const workspaces = Array.isArray(s.workspaces) ? (s.workspaces as SnapshotWorkspace[]) : [];
  const tabs = Array.isArray(s.tabs) ? (s.tabs as SnapshotTab[]) : [];
  const panes = Array.isArray(s.panes) ? (s.panes as SnapshotPane[]) : [];

  return {
    version: typeof s.version === 'string' ? s.version : undefined,
    protocol: typeof s.protocol === 'number' ? s.protocol : undefined,
    workspaces,
    tabs,
    panes,
    focused_workspace_id: typeof s.focused_workspace_id === 'string' ? s.focused_workspace_id : null,
    focused_tab_id: typeof s.focused_tab_id === 'string' ? s.focused_tab_id : null,
    focused_pane_id: typeof s.focused_pane_id === 'string' ? s.focused_pane_id : null,
  };
}

/**
 * Pads or truncates string to exact width.
 */
function pad(str: string, width: number): string {
  if (str.length > width) return str.slice(0, width - 1) + '…';
  return str.padEnd(width, ' ');
}

/**
 * Formats unix timestamp to ISO-like time string (HH:MM:SS).
 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().split(' ')[0] ?? '';
}

/**
 * Generates formatted dashboard text lines from snapshot data.
 */
export function composeDashboardLines(
  rawSnapshot: unknown,
  options?: ComposeDashboardOptions
): string[] {
  const data = normalizeSnapshot(rawSnapshot);
  const now = options?.now ?? Date.now();
  const timeStr = formatTime(now);

  const lines: string[] = [];
  const verStr = data?.version ? `Herdr v${data.version}` : 'Herdr (offline)';
  const protoStr = data?.protocol ? `proto ${data.protocol}` : '';
  const meta = [verStr, protoStr].filter(Boolean).join(', ');

  lines.push(`==================== PIER OPS DASHBOARD ==================== [${timeStr}] (${meta})`);

  if (!data || (!data.workspaces?.length && !data.panes?.length)) {
    lines.push('');
    lines.push('  No active Herdr session or empty workspace data.');
    lines.push('  Waiting for Herdr session snapshot...');
    lines.push('');
    lines.push('================================================================================');
    return lines;
  }

  // 1. Workspaces overview line
  const wsItems = data.workspaces?.map((w) => {
    const isFocused = w.focused || w.workspace_id === data.focused_workspace_id;
    const focusMark = isFocused ? '*' : '';
    const statusMark = w.agent_status && w.agent_status !== 'unknown' ? `:${w.agent_status}` : '';
    return `[${focusMark}${w.workspace_id}: ${w.label ?? 'unnamed'}${statusMark}]`;
  }) ?? [];

  lines.push(`Workspaces (${wsItems.length}): ${wsItems.join(' ')}`);
  lines.push('--------------------------------------------------------------------------------');

  // Determine active/target workspace
  const targetId = options?.targetWorkspaceId
    ?? data.focused_workspace_id
    ?? data.workspaces?.[0]?.workspace_id;

  const currentWs = data.workspaces?.find((w) => w.workspace_id === targetId)
    ?? { workspace_id: targetId ?? 'unknown', label: 'default' };

  const wsTabs = data.tabs?.filter((t) => t.workspace_id === currentWs.workspace_id) ?? [];
  const wsPanes = data.panes?.filter((p) => p.workspace_id === currentWs.workspace_id) ?? [];

  lines.push(`Current Workspace: ${currentWs.workspace_id} (${currentWs.label ?? 'unnamed'}) | Tabs: ${wsTabs.length} | Panes: ${wsPanes.length}`);

  // 2. Tabs in current workspace
  if (wsTabs.length > 0) {
    const tabParts = wsTabs.map((t) => {
      const isFocused = t.focused || t.tab_id === data.focused_tab_id;
      const f = isFocused ? '*' : ' ';
      return `${f}#${t.number ?? '?'}[${t.label ?? t.tab_id}](${t.agent_status ?? 'unknown'})`;
    });
    lines.push(`Tabs: ${tabParts.join('  ')}`);
  }

  lines.push('--------------------------------------------------------------------------------');

  // 3. Panes table
  lines.push(
    `${pad('PANE ID', 10)} ${pad('ROLE', 8)} ${pad('STATUS', 10)} ${pad('FOC', 4)} ${pad('TODO / TITLE / TOKENS', 44)}`
  );
  lines.push(
    `${'-'.repeat(10)} ${'-'.repeat(8)} ${'-'.repeat(10)} ${'-'.repeat(4)} ${'-'.repeat(44)}`
  );

  let blockedCount = 0;
  let workingCount = 0;
  let idleCount = 0;
  let pierCount = 0;

  for (const p of wsPanes) {
    const isFocused = p.focused || p.pane_id === data.focused_pane_id;
    const focMark = isFocused ? ' *  ' : '    ';
    const role = p.display_agent ?? (p.agent ? p.agent : '-');
    const status = p.agent_status ?? 'unknown';

    if (p.agent === 'pi' || p.tokens?.['pi-todo']) {
      pierCount++;
      if (status === 'blocked') blockedCount++;
      else if (status === 'working') workingCount++;
      else if (status === 'idle') idleCount++;
    }

    // Extract todo / title: pi-todo wins; else Herdr 0.9.1 stripped OSC title over raw title/spinner.
    let desc = p.tokens?.['pi-todo'] ?? p.terminal_title_stripped ?? p.title ?? p.terminal_title ?? '';
    // Collect active locks if any
    const lockTokens = Object.keys(p.tokens ?? {}).filter((k) => k.startsWith('lock-'));
    if (lockTokens.length > 0) {
      desc += ` [${lockTokens.length} lock${lockTokens.length > 1 ? 's' : ''}]`;
    }
    if (!desc && (p.foreground_cwd || p.cwd)) {
      const activeCwd = p.foreground_cwd || p.cwd || '';
      desc = `cwd: ${activeCwd.split('/').pop() || activeCwd}`;
    }

    // Highlight blocked state with indicator
    const statusDisplay = status === 'blocked' ? '! BLOCKED' : status;

    lines.push(
      `${pad(p.pane_id, 10)} ${pad(role, 8)} ${pad(statusDisplay, 10)} ${focMark} ${pad(desc, 44)}`
    );
  }

  if (wsPanes.length === 0) {
    lines.push('  (No panes in this workspace)');
  }

  lines.push('--------------------------------------------------------------------------------');

  // 4. Alert & Summary
  if (blockedCount > 0) {
    lines.push(`⚠️  ALERT: ${blockedCount} SUBAGENT(S) BLOCKED — WAITING ON HUMAN DECISION`);
  }

  lines.push(
    `Summary: ${wsPanes.length} pane(s) | Pier agents: ${pierCount} (${workingCount} working, ${blockedCount} blocked, ${idleCount} idle)`
  );
  lines.push('================================================================================');

  return lines;
}

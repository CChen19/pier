/**
 * F05: `boot.jsonl` is append-only — bootstrap.mjs appends one record per `workspace.created` /
 * `worktree.opened`, so a workspace that was opened, closed and reopened has several records.
 * restore-layout.mjs used to walk *every* record, which rebuilds the same main tab/pane repeatedly
 * after a session restore (duplicate master panes in one workspace).
 *
 * These helpers are pure so the restore decision can be tested without a live herdr socket; the
 * script stays a thin socket wrapper.
 */

export interface BootRecord {
  workspace_id: string;
  tab_id?: string;
  pane_id?: string;
  cwd?: string;
  [key: string]: unknown;
}

/** Parse boot.jsonl, dropping blank/corrupt lines and records without a workspace id. */
export function parseBootRecords(text: string): BootRecord[] {
  const out: BootRecord[] = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // A half-written tail line must not break the restore.
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.workspace_id !== 'string' || rec.workspace_id === '') continue;
    out.push(rec as BootRecord);
  }
  return out;
}

/**
 * Newest record per workspace (file order is append order, so the last record wins).
 * The newest record carries the tab/pane ids that were valid at shutdown, which is exactly what the
 * restore path needs.
 */
export function latestBootRecordPerWorkspace(records: readonly BootRecord[]): BootRecord[] {
  const byWorkspace = new Map<string, BootRecord>();
  for (const rec of records) byWorkspace.set(rec.workspace_id, rec);
  return [...byWorkspace.values()];
}

import type { HerdrClientLike } from './herdr-client.ts';
import { foldSubsRegistry, makeRegistry, SUBS_CUSTOM_TYPE, type SubEntry } from './subagent-core.ts';
import { swallow } from './swallow.ts';

export interface SubagentRegistryHost {
  pi: { appendEntry?: (customType: string, data: unknown) => void };
  client: HerdrClientLike;
  subs: Map<string, SubEntry>;
  writeHistory: (entry: SubEntry, patch?: { status?: SubEntry['status']; closedAt?: number }, via?: string) => void;
}

export interface SubagentRegistry {
  /** Append the registry snapshot to the session branch; duplicate snapshots are skipped (O1). */
  persist(): void;
  /** Replay `pi-herdr.subs` entries from the session branch into the live map. */
  rebuild(eventCtx: unknown): void;
  /** B6: close running rows whose pane herdr no longer lists. */
  sweepZombieRunning(): Promise<void>;
}

/** Owns durable registry projection and startup recovery, separate from tool actions. */
export function createSubagentRegistry(host: SubagentRegistryHost): SubagentRegistry {
  let lastSnapshot = '';

  function persist(): void {
    try {
      const registry = makeRegistry([...host.subs.values()]);
      const snapshot = JSON.stringify(registry);
      if (snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;
      host.pi.appendEntry?.(SUBS_CUSTOM_TYPE, registry);
    } catch (err) {
      // Best-effort: session logging must not break delegation, but a ghost running subagent is the
      // symptom when this fails silently, so keep the reason queryable (B9).
      swallow('subagent.persist-subs', err);
    }
  }

  function rebuild(eventCtx: unknown): void {
    try {
      const entries = (eventCtx as { sessionManager?: { getBranch?: () => readonly unknown[] } })
        ?.sessionManager?.getBranch?.() ?? [];
      const registry = foldSubsRegistry(entries as Parameters<typeof foldSubsRegistry>[0]);
      for (const entry of registry.subs) host.subs.set(entry.paneId, entry);
      lastSnapshot = ''; // Branch replay replaced live state; force the next persist.
    } catch {
      /* Registry recovery failure must not block the live session. */
    }
  }

  async function sweepZombieRunning(): Promise<void> {
    if (!host.client.available || host.subs.size === 0) return;
    let livePaneIds: ReadonlySet<string>;
    try {
      livePaneIds = new Set((await host.client.listPanes()).map((pane) => pane.paneId));
    } catch {
      return; // Do not close agents when the liveness lookup itself failed.
    }
    let changed = false;
    for (const [paneId, entry] of host.subs) {
      if (entry.status !== 'running' || livePaneIds.has(paneId)) continue;
      entry.status = 'closed';
      host.writeHistory(entry, { status: 'closed', closedAt: Date.now() }, 'zombie-sweep');
      changed = true;
    }
    if (changed) persist();
  }

  return { persist, rebuild, sweepZombieRunning };
}

/**
 * P0 (RFC docs/rfc-pi-0.86-dynamic-tools.md §4): mutable role state for mid-session switching.
 *
 * pi 0.86 records `setActiveTools` changes as transcript tool deltas (toolsRemoved/toolsAdded
 * before the next request), so a switch survives resume and branch navigation on pi's side.
 * This module owns pier's half: replaying the gate manifest from the last `pi-herdr.role-manifest`
 * entry, and planning the active-set transition with ALL registered tools as the universe —
 * a switch may re-admit tools that an earlier session_start prune removed from the active set,
 * so intersecting with the *current* active list (planActiveTools semantics) would lose them.
 */
import type { PermissionAction, UnknownToolStance } from './role-manifest.ts';
import type { RuntimeRoleManifest } from './tool-gate.ts';

/** Shape persisted in ROLE_MANIFEST_CUSTOM_TYPE entries (v1 payload, switch adds origin/switchedBy). */
export interface RoleManifestRecord {
  version: 1;
  role: string;
  manifestVersion?: string;
  tools: string[];
  permissions: Record<string, PermissionAction>;
  unknownTools: UnknownToolStance;
  guidelines?: string[];
  /** 'switch' records a mid-session switch; the session_start anchor write omits it (env origin). */
  origin?: 'switch';
  switchedBy?: string;
  ts?: number;
}

/** State carried across a process for the armed role system; manifest==null means unarmed (bare pi). */
export interface RoleState {
  manifest: RuntimeRoleManifest | null;
  origin: 'env' | 'switch';
  switchedBy: string | null;
  switchedAt: number | null;
}

export function initialRoleState(manifest: RuntimeRoleManifest | null): RoleState {
  return { manifest, origin: 'env', switchedBy: null, switchedAt: null };
}

/**
 * Last `pi-herdr.role-manifest` record on the branch, or null. Session entries are pi JSONL
 * objects ({ type: 'custom', customType, data }); unknown shapes are skipped, not fatal —
 * replay must never break session startup.
 */
export function latestRoleManifestRecord(entries: readonly unknown[]): RoleManifestRecord | null {
  let found: RoleManifestRecord | null = null;
  for (const raw of entries) {
    const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry?.type !== 'custom' || entry.customType !== 'pi-herdr.role-manifest') continue;
    const data = entry.data as Partial<RoleManifestRecord> | undefined;
    if (
      !data ||
      typeof data.role !== 'string' ||
      !Array.isArray(data.tools) ||
      !data.tools.every((t) => typeof t === 'string')
    ) {
      continue;
    }
    found = {
      version: 1,
      role: data.role,
      manifestVersion: typeof data.manifestVersion === 'string' ? data.manifestVersion : undefined,
      tools: data.tools as string[],
      permissions:
        data.permissions && typeof data.permissions === 'object' && !Array.isArray(data.permissions)
          ? (data.permissions as Record<string, PermissionAction>)
          : {},
      unknownTools: data.unknownTools === 'allow' ? 'allow' : 'deny',
      guidelines: (() => {
        if (!Array.isArray(data.guidelines)) return undefined;
        const list = data.guidelines.filter((g): g is string => typeof g === 'string');
        return list.length > 0 ? list : undefined;
      })(),
      origin: data.origin === 'switch' ? 'switch' : undefined,
      switchedBy: typeof data.switchedBy === 'string' ? data.switchedBy : undefined,
      ts: typeof data.ts === 'number' ? data.ts : undefined,
    };
  }
  return found;
}

/** Rebuild a runtime manifest from a persisted record (resume replay path). */
export function manifestFromRecord(rec: RoleManifestRecord): RuntimeRoleManifest {
  return {
    role: rec.role,
    version: rec.manifestVersion,
    tools: rec.tools,
    permissions: rec.permissions,
    unknownTools: rec.unknownTools,
    ...(rec.guidelines && rec.guidelines.length > 0 ? { guidelines: rec.guidelines } : {}),
  };
}

/** Whether the record differs from the state that would be written now (drives change-only writes). */
export function roleRecordDiffers(rec: RoleManifestRecord | null, state: RoleState): boolean {
  const m = state.manifest;
  if (!m) return false;
  if (!rec) return true;
  return rec.role !== m.role || JSON.stringify(rec.tools) !== JSON.stringify(m.tools);
}

/** Switch plan: widening (needs human confirm when driven by /pier-role) + diff summary. */
export interface RoleSwitchPlan {
  widening: boolean;
  added: string[];
  removed: string[];
}

export function planRoleSwitch(oldTools: readonly string[], newTools: readonly string[]): RoleSwitchPlan {
  const oldSet = new Set(oldTools);
  const newSet = new Set(newTools);
  const added = newTools.filter((t) => !oldSet.has(t));
  const removed = oldTools.filter((t) => !newSet.has(t));
  return { widening: added.length > 0, added, removed };
}

/**
 * Active set for a switch, over ALL registered tools (not the current active set — a switch may
 * re-admit tools an earlier session_start prune removed). Mirrors planActiveTools' two-branch
 * stance semantics (tool-gate.ts): unknownTools 'allow' keeps every registered tool except
 * explicit denies (master + D82 user-installed-extension axis), 'deny' intersects with the
 * manifest. Result keeps registration order; the caller relies on the composeManifest contract
 * that every valid manifest baseline includes the coordination tools.
 */
export function planSwitchActiveTools(
  manifestTools: readonly string[],
  registeredToolNames: readonly string[],
  opts?: { unknownTools?: UnknownToolStance; permissions?: Record<string, PermissionAction> },
): string[] {
  if ((opts?.unknownTools ?? 'deny') === 'allow') {
    const denied = new Set(
      Object.entries(opts?.permissions ?? {})
        .filter(([, action]) => action === 'deny')
        .map(([name]) => name),
    );
    return registeredToolNames.filter((name) => !denied.has(name));
  }
  const wanted = new Set(manifestTools);
  return registeredToolNames.filter((name) => wanted.has(name));
}

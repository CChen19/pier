/** Why: Preserve the established compatibility and safety behavior (D3, M18, S2). */
import { resolve, sep } from 'node:path';

/** Why: Preserve the established compatibility and safety behavior. */
export const WRITE_LOCK_ENV = 'PI_HERDR_WRITE_LOCK';
/** Why: Preserve the established compatibility and safety behavior. */
export const WRITE_TOOLS = ['write', 'edit'] as const;
/** Why: Preserve the established compatibility and safety behavior. */
export const LOCK_TOKEN_PREFIX = 'lock-';
/** Why: Preserve the established compatibility and safety behavior. */
export const LOCK_BATCH_LIMIT = 16;
/** Why: Preserve the established compatibility and safety behavior. */
export const LOCK_TTL_MS = 60 * 60 * 1000;

/** Why: Preserve the established compatibility and safety behavior. */
export interface LockAgentView {
  paneId: string;
  tokens: Record<string, string | null>;
}

/** Why: Preserve the established compatibility and safety behavior. */

export function normalizeLockPath(p: string, cwd: string): string {
  const abs = resolve(cwd, p);
  const unified = sep === '\\' ? abs.replace(/\\/g, '/') : abs;
  return unified.toLowerCase().replace(/\/+$/, '');
}

/** Why: Preserve the established compatibility and safety behavior. */

/** Why: Preserve the established compatibility and safety behavior. */
export function fnv1a64(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

export function lockTokenKey(normPath: string): string {
  return `${LOCK_TOKEN_PREFIX}${fnv1a64(normPath)}`;
}

export function lockTokenValue(normPath: string, paneId: string): string {
  return `${paneId}|${normPath}`;
}

export function parseLockTokenValue(v: string): { holderPaneId: string; path: string } | null {
  const i = v.indexOf('|');
  if (i <= 0 || i === v.length - 1) return null;
  return { holderPaneId: v.slice(0, i), path: v.slice(i + 1) };
}

/** Why: Preserve the established compatibility and safety behavior. */
export function isLockTokenKey(key: string): boolean {
  return key.startsWith(LOCK_TOKEN_PREFIX) && key.length > LOCK_TOKEN_PREFIX.length;
}

/** Why: Preserve the established compatibility and safety behavior. */

export function writePathsOfTool(toolName: string, input: unknown): string[] {
  if (!(WRITE_TOOLS as readonly string[]).includes(toolName)) return [];
  const p = (input as { path?: unknown } | null | undefined)?.path;
  return typeof p === 'string' && p.trim() ? [p] : [];
}

/** Why: Preserve the established compatibility and safety behavior. */

/**
 * Every *other* pane currently holding a beacon for this path (deduped, in list order).
 * A lock is a beacon rather than a mutex, so several panes can hold the same path.
 */
export function findLockHolders(
  agents: readonly LockAgentView[],
  ownPaneId: string,
  normPath: string,
): string[] {
  const key = lockTokenKey(normPath);
  const holders: string[] = [];
  for (const a of agents) {
    const v = a.tokens[key];
    if (typeof v !== 'string' || !v) continue;
    const parsed = parseLockTokenValue(v);
    if (parsed && parsed.holderPaneId !== ownPaneId && !holders.includes(parsed.holderPaneId)) {
      holders.push(parsed.holderPaneId);
    }
  }
  return holders;
}

export function findLockConflict(
  agents: readonly LockAgentView[],
  ownPaneId: string,
  normPath: string,
): { holderPaneId: string } | null {
  const [first] = findLockHolders(agents, ownPaneId, normPath);
  return first === undefined ? null : { holderPaneId: first };
}

/** Where to look for the full holder table: humans use the slash command, agents can read herdr's tokens. */
export const LOCK_HOLDERS_HINT =
  'holders: /locks (human view in this pane) · herdr agent list → tokens (agent-readable)';

function holdersLabel(holders: readonly string[]): string {
  return holders.length === 1 ? `pane ${holders[0]}` : `panes ${holders.join(', ')}`;
}

/** Why: Preserve the established compatibility and safety behavior. */

export type WriteGuardPlan =
  | { kind: 'skip' }
  | { kind: 'pass'; paths: string[] }
  | { kind: 'warn'; paths: string[]; holderPaneIds: string[]; warning: string }
  | { kind: 'block'; paths: string[]; holderPaneIds: string[]; reason: string };

export function planWriteGuard(opts: {
  toolName: string;
  input: unknown;
  agents: readonly LockAgentView[];
  ownPaneId: string;
  cwd: string;
  hard: boolean;
}): WriteGuardPlan {
  const raw = writePathsOfTool(opts.toolName, opts.input);
  if (raw.length === 0) return { kind: 'skip' };
  const paths = raw.map((p) => normalizeLockPath(p, opts.cwd));
  for (const norm of paths) {
    const holders = findLockHolders(opts.agents, opts.ownPaneId, norm);
    if (holders.length === 0) continue;
    if (opts.hard) {
      return {
        kind: 'block',
        paths,
        holderPaneIds: holders,
        reason: `file locked by ${holdersLabel(holders)}: ${norm} is being edited in another pane. Wait for it to settle, or coordinate before writing. ${LOCK_HOLDERS_HINT}`,
      };
    }
    return {
      kind: 'warn',
      paths,
      holderPaneIds: holders,
      warning: formatConflictWarning(norm, holders),
    };
  }
  return { kind: 'pass', paths };
}

/** Why: Preserve the established compatibility and safety behavior. */

export function acquireTokensFor(normPaths: readonly string[], paneId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of normPaths) out[lockTokenKey(p)] = lockTokenValue(p, paneId);
  return out;
}

export function releaseTokensFor(normPaths: readonly string[]): Record<string, null> {
  const out: Record<string, null> = {};
  for (const p of normPaths) out[lockTokenKey(p)] = null;
  return out;
}

export function formatConflictWarning(normPath: string, holders: readonly string[]): string {
  return `⚠️ write conflict: ${normPath} is locked by ${holdersLabel(holders)} (edited in another pane that has not settled). This write went through (soft mode) — coordinate to avoid clobbering each other's changes. ${LOCK_HOLDERS_HINT}`;
}

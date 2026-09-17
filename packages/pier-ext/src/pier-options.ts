/**
 * B10: environment naming. Two prefixes grew side by side — `PI_HERDR_*` (mostly older tuning knobs)
 * and `PIER_*` (newer ones). Telling them apart by memory is impossible, so this module fixes one
 * rule and enforces it in code:
 *
 *  - `PIER_*` is the canonical namespace for *pier options* (timeouts, windows, toggles). It reads
 *    the historical `PI_HERDR_*` spelling as a fallback alias, so existing shells keep working.
 *  - `PI_HERDR_SUBAGENT`, `PI_HERDR_ROLE_MANIFEST`, `PI_HERDR_TUI`, `PI_HERDR_META_KEY` stay as they
 *    are: those are *contracts* handed to the child process by pier itself (or read by pi/herdr), and
 *    renaming them would split running workers from their parent.
 *
 * `pierOption()` is the single reader; `pierConfigCatalog()` feeds `/pier-config` so the knobs are
 * discoverable in one place instead of only by reading the source.
 */
export interface OptionSpec {
  /** Canonical name. */
  readonly name: string;
  /** Historical `PI_HERDR_*` spelling still accepted. */
  readonly legacy?: string;
  /** Default when neither name is set. */
  readonly fallback: string;
  readonly description: string;
}

/** Every pier option, with its alias and default. Keep in sync with `runtimePolicy`/config readers. */
export const PIER_OPTIONS: readonly OptionSpec[] = [
  // Numeric fallbacks MUST equal runtime-policy.ts (guarded by test/pier-options.test.ts): the table is
  // what `/pier-config doctor` shows, so a hand-typed number here is a documented lie.
  { name: 'PIER_GIT_TIMEOUT_MS', legacy: 'PI_HERDR_GIT_TIMEOUT_MS', fallback: '10000', description: 'git command timeout (worktree/status batches)' },
  { name: 'PIER_SUBAGENT_TIMEOUT_MS', legacy: 'PI_HERDR_SUBAGENT_TIMEOUT_MS', fallback: '600000', description: 'subagent inactivity budget before forced termination' },
  { name: 'PIER_READY_TIMEOUT_MS', legacy: 'PI_HERDR_READY_TIMEOUT_MS', fallback: '90000', description: 'how long to wait for a spawned pane to open its pipe' },
  { name: 'PIER_OBSERVATION_WINDOW_MS', legacy: 'PI_HERDR_OBSERVATION_WINDOW_MS', fallback: '30000', description: 'observation window before a subagent is called settled' },
  { name: 'PIER_POLL_INTERVAL_MS', legacy: 'PI_HERDR_POLL_INTERVAL_MS', fallback: '30000', description: 'subagent poll cadence' },
  { name: 'PIER_GC_TICK_MS', legacy: 'PI_HERDR_GC_TICK_MS', fallback: '30000', description: 'idle GC sweep cadence (panes/worktrees)' },
  { name: 'PIER_FOCUS_POLL_MS', fallback: '1500', description: 'pane-focus sampling cadence for the heat layout (0 disables; 0.9.1+ defaults to 0)' },
  { name: 'PIER_TERMINAL_PROMPT', legacy: 'PI_HERDR_TERMINAL_PROMPT', fallback: '(auto from $SHELL)', description: 'prompt strategy for terminal readiness: bash|zsh|powershell|pwsh' },
  { name: 'PIER_SLIM_FRAME', legacy: 'PI_HERDR_SLIM_FRAME', fallback: '1', description: 'mutation frame around todo-tool cards (0 disables)' },
  { name: 'PIER_TRACE', legacy: 'PI_HERDR_TRACE', fallback: '', description: 'write diagnostics (renderers, swallowed errors) to stderr' },
  { name: 'PIER_TERM_IDLE_MS', legacy: 'PI_HERDR_TERM_IDLE_MS', fallback: '1800000', description: 'idle time before pier nudges about an open terminal' },
  { name: 'PIER_TERM_GRACE_MS', legacy: 'PI_HERDR_TERM_GRACE_MS', fallback: '30000', description: 'settle grace before the terminal idle nudge' },
  { name: 'PIER_TERM_READ_MAX', legacy: 'PI_HERDR_TERM_READ_MAX', fallback: '8000', description: 'characters returned per terminal read' },
  { name: 'PIER_TODO_GRACE_MS', legacy: 'PI_HERDR_TODO_GRACE_MS', fallback: '30000', description: 'settle grace before the unfinished-todo reminder' },
  { name: 'PIER_HMR', legacy: 'PI_HERDR_HMR', fallback: '', description: 'dev: enable the cordis HMR boundary (requires --expose-internals)' },
  { name: 'PIER_SETTLEMENT_WINDOW_MS', legacy: 'PI_HERDR_SETTLEMENT_WINDOW_MS', fallback: '60000', description: 'settlement notice window / machine-inject grace / takeover idle' },
  { name: 'PIER_FOREGROUND_PATIENCE_MS', legacy: 'PI_HERDR_FOREGROUND_PATIENCE_MS', fallback: '300000', description: 'foreground patience before demoting a subagent to background' },
  { name: 'PIER_SESSION_TTL_SECONDS', legacy: 'PI_HERDR_SESSION_TTL_SECONDS', fallback: '600', description: 'session retention after a subagent exits, before GC' },
  { name: 'PIER_ISOLATE_SWEEP_ORPHANS', legacy: 'PI_HERDR_ISOLATE_SWEEP_ORPHANS', fallback: '', description: 'opt-in sweeping of isolate worktrees this session never registered' },
];

/**
 * Read a pier option: canonical name first, then the legacy alias, then the fallback.
 * An empty string counts as unset for both names (shells export empty vars easily).
 */
export function pierOption(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const spec = PIER_OPTIONS.find((o) => o.name === name);
  const legacy = spec?.legacy;
  for (const key of [name, legacy]) {
    if (!key) continue;
    const raw = env[key];
    if (typeof raw === 'string' && raw.trim() !== '') return raw;
  }
  return undefined;
}

/**
 * Human-readable option table for `/pier-config doctor`, one line per option:
 * `NAME = value (source) — description`. Legacy env names are called out so a stale export is visible.
 */
export function formatOptionRows(env: NodeJS.ProcessEnv = process.env): string[] {
  return pierOptionRows(env).map((row) => {
    const source = row.source === 'env' ? 'env' : row.source === 'legacy-env' ? 'env (legacy name)' : 'default';
    return `  ${row.name} = ${row.value}  (${source})  — ${row.description}`;
  });
}

/** `/pier-config` catalog rows: name, effective value and where it came from. */
export function pierOptionRows(env: NodeJS.ProcessEnv = process.env): Array<{
  name: string;
  value: string;
  source: 'env' | 'legacy-env' | 'default';
  description: string;
}> {
  return PIER_OPTIONS.map((spec) => {
    const own = typeof env[spec.name] === 'string' && env[spec.name]!.trim() !== '';
    if (own) return { name: spec.name, value: String(env[spec.name]), source: 'env' as const, description: spec.description };
    const legacyRaw = spec.legacy ? env[spec.legacy] : undefined;
    const viaLegacy = typeof legacyRaw === 'string' && legacyRaw.trim() !== '';
    if (viaLegacy) {
      return { name: spec.name, value: String(legacyRaw), source: 'legacy-env' as const, description: spec.description };
    }
    return { name: spec.name, value: spec.fallback, source: 'default' as const, description: spec.description };
  });
}

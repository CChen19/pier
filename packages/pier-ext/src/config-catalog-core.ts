/**
 * D104 Config Catalog Core (pure).
 *
 * Single source of truth for the five pier configuration planes: knob descriptors,
 * effective-value provenance (env > workspace > user > default) and text rendering
 * for `/pier-config show|check|doc`.
 *
 * No I/O here; file/env reading lives in config-guide.ts. The catalog is guarded
 * against drift by test/config-catalog-core.test.ts, which diffs it against
 * schemas/efficiency-config.schema.json, schemas/role-manifest.schema.json and the
 * env keys actually read by runtime-policy.ts / efficiency-config-core.ts.
 */

export type ConfigPlaneId = 'efficiency' | 'roles' | 'pi' | 'boot' | 'env';

export type ConfigKind = 'boolean' | 'number' | 'string' | 'enum';

export interface ConfigKnob {
  readonly plane: ConfigPlaneId;
  /** Dotted path inside the plane's file, or the env var name for the `env` plane. */
  readonly key: string;
  readonly kind: ConfigKind;
  readonly defaultValue?: string | number | boolean;
  /** Highest-precedence env override for a file-plane knob. */
  readonly envVar?: string;
  /** Lower bound for numeric knobs (mirrors the runtime validator). */
  readonly min?: number;
  /** Historical spellings still accepted for an env knob (B10: canonical `PIER_*` first). */
  readonly aliases?: readonly string[];
  /** One-line effect/impact, shown by `show`. */
  readonly impact: string;
  /** Where to read more (docs/schema anchor). */
  readonly docRef?: string;
  /** True when pier only reads the value (owned by pi / herdr). */
  readonly readOnly?: boolean;
}

export interface ConfigPlane {
  readonly id: ConfigPlaneId;
  readonly title: string;
  readonly owner: 'pier' | 'pi' | 'workbench';
  /** Human-facing path templates, in precedence order. */
  readonly files: readonly string[];
  /** What to do to change this plane. */
  readonly editHint: string;
}

export const CONFIG_PLANES: readonly ConfigPlane[] = Object.freeze([
  {
    id: 'efficiency',
    title: 'Efficiency mechanisms (D100-D103)',
    owner: 'pier',
    files: ['<workspace>/.pi-herdr/config.json', '~/.pi/agent/herdr-pi/config.json', 'PI_HERDR_* env'],
    editHint: 'Edit the workspace or user JSON (env wins); see docs/efficiency-trial.md',
  },
  {
    id: 'roles',
    title: 'Role profiles (D82/D11)',
    owner: 'pier',
    files: ['<workspace>/.pi-herdr/roles/<name>.json', '~/.pi/agent/herdr-pi/roles/<name>.json', 'builtin src/roles/'],
    editHint: 'Add or edit a role JSON; builtin names (master/worker-default) cannot be overridden',
  },
  {
    id: 'pi',
    title: "Pi's own settings (read-only here)",
    owner: 'pi',
    files: ['~/.pi/agent/settings.json', '<trusted-project>/.pi/settings.json'],
    editHint: 'Use pi\'s /settings for everything except the OCC-relevant compaction.* keys',
  },
  {
    id: 'boot',
    title: 'Workbench boot-config',
    owner: 'workbench',
    files: ['$HERDR_PLUGIN_CONFIG_DIR/boot-config.json', 'packages/pier-workbench/scripts/boot-config.json'],
    editHint: 'Prefer `npx pier-setup@latest update --force` over hand-editing paths',
  },
  {
    id: 'env',
    title: 'Runtime policy env (PIER_* / PI_HERDR_*)',
    owner: 'pier',
    files: ['process environment (per-process, no file)'],
    editHint: 'Export the variable before starting pi; it applies to new processes only',
  },
] as const);

/** Efficiency knobs: mirrors schemas/efficiency-config.schema.json (guarded by the drift test). */
const EFFICIENCY_KNOBS: readonly ConfigKnob[] = [
  { plane: 'efficiency', key: 'onlineContextCompact.enabled', kind: 'boolean', defaultValue: false, envVar: 'PI_HERDR_COMPACT_ENABLE', impact: 'Todo-driven online compaction (OCC) master switch', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'onlineContextCompact.logEnabled', kind: 'boolean', defaultValue: false, envVar: 'PI_HERDR_COMPACT_LOG', impact: 'Write compact.jsonl decisions', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'onlineContextCompact.cacheWriteReadRatio', kind: 'string', defaultValue: 'auto', envVar: 'PI_HERDR_CACHE_RATIO', impact: 'KV cache write/read cost ratio; auto = model cost, then input/cacheRead, then provider family (gemini 4 / grok+deepseek 10), then token-account 2.0 — never disables OCC', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'onlineContextCompact.firstCompactionRequestScale', kind: 'number', defaultValue: 2.0, min: 1.0, impact: 'First-compaction horizon relaxation', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'onlineContextCompact.subsequentCompactionMargin', kind: 'number', defaultValue: 1.5, min: 1.0, impact: 'Safety margin required for later compactions', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'onlineContextCompact.keepRecentTokens', kind: 'number', defaultValue: 20000, min: 1000, impact: 'Native compaction tail window; inherited from pi unless set here', docRef: 'docs/configuration.md' },
  { plane: 'efficiency', key: 'observationPack.enabled', kind: 'boolean', defaultValue: false, envVar: 'PI_HERDR_OBS_PACK_ENABLE', impact: 'Project large tool outputs as placeholders (observationPack)', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'observationPack.logEnabled', kind: 'boolean', defaultValue: false, envVar: 'PI_HERDR_OBS_PACK_LOG', impact: 'Write observation.jsonl packed/recall records', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'observationPack.thresholdBytes', kind: 'number', defaultValue: 10240, min: 1024, impact: 'Minimum output size before packing applies', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'observationPack.fullSends', kind: 'number', defaultValue: 2, min: 1, impact: 'Provider requests that keep the full text before packing', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'observationPack.recallChunkBytes', kind: 'number', defaultValue: 16384, min: 1024, impact: 'obs_recall page size', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'observationPack.excerptBytes', kind: 'number', defaultValue: 1024, min: 128, impact: 'Whole-line head/tail excerpt kept in the placeholder', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.enabled', kind: 'boolean', defaultValue: false, envVar: 'PI_HERDR_REDUCER_ENABLE', impact: 'Reduce long bash diagnostic logs to a verified receipt (EPR)', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.logEnabled', kind: 'boolean', defaultValue: false, envVar: 'PI_HERDR_REDUCER_LOG', impact: 'Write reducer.jsonl attempts and fallback reasons', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.model', kind: 'string', envVar: 'PI_HERDR_REDUCER_MODEL', impact: 'Cheap model used for reduction (provider/model); defaults to the session model', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.minBytes', kind: 'number', defaultValue: 4096, min: 512, impact: 'Minimum log size before reduction is attempted', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.maxChars', kind: 'number', defaultValue: 600000, min: 1000, impact: 'Skip reduction above this log size', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.maxOutputTokens', kind: 'number', defaultValue: 2048, min: 128, impact: 'Reduction output token budget', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.timeoutMs', kind: 'number', defaultValue: 5000, min: 500, impact: 'Synchronous reduction budget; timeout falls back to the full log', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'evidencePreservingReducer.localOnly', kind: 'boolean', defaultValue: false, impact: 'Archive the raw log but never call a model', docRef: 'docs/efficiency-trial.md' },
  { plane: 'efficiency', key: 'jev.enabled', kind: 'boolean', defaultValue: false, envVar: 'PIER_JEV_ENABLE', impact: 'Jev decision layer (System One classification) master switch; every call site fails open', docRef: 'docs/rfc-jev-integration.md' },
  { plane: 'efficiency', key: 'jev.logEnabled', kind: 'boolean', defaultValue: false, envVar: 'PIER_JEV_LOG', impact: 'Write jev.jsonl question outcomes (no request/response bodies)', docRef: 'docs/rfc-jev-integration.md' },
  { plane: 'efficiency', key: 'jev.baseUrl', kind: 'string', envVar: 'PIER_JEV_BASE_URL', impact: 'API root override (relay/gateway); default https://api.typesafe.ai', docRef: 'docs/rfc-jev-integration.md' },
  { plane: 'efficiency', key: 'jev.model', kind: 'string', defaultValue: 'jev-1.13.0', envVar: 'PIER_JEV_MODEL', impact: 'Pinned versioned model id; aliases drift silently and skew tuned thresholds', docRef: 'docs/rfc-jev-integration.md' },
  { plane: 'efficiency', key: 'jev.timeoutMs', kind: 'number', defaultValue: 2000, min: 500, envVar: 'PIER_JEV_TIMEOUT_MS', impact: 'Total per-call budget via AbortController hard kill', docRef: 'docs/rfc-jev-integration.md' },
  { plane: 'efficiency', key: 'jev.minConfidence', kind: 'number', defaultValue: 0.6, min: 0, envVar: 'PIER_JEV_MIN_CONFIDENCE', impact: 'Minimum Choice/Score confidence to adopt an answer; below counts as unanswered', docRef: 'docs/rfc-jev-integration.md' },
  { plane: 'efficiency', key: 'jev.apiKey', kind: 'string', envVar: 'PIER_JEV_API_KEY', impact: 'API key; PIER_JEV_API_KEY env > config value > TYPESAFE_API_KEY env', docRef: 'docs/rfc-jev-integration.md' },
];

/** Role-manifest keys (mirrors schemas/role-manifest.schema.json). Roles are per-file, so these are inventory keys. */
const ROLE_KNOBS: readonly ConfigKnob[] = [
  { plane: 'roles', key: 'role', kind: 'string', impact: 'Role name (must match the file name)', docRef: 'docs/sidebar-role-config.md' },
  { plane: 'roles', key: 'version', kind: 'string', impact: 'Role profile version string', docRef: 'docs/sidebar-role-config.md' },
  { plane: 'roles', key: 'model', kind: 'string', impact: 'Dispatch routing: provider/model for panes spawned with this role', docRef: 'docs/sidebar-role-config.md' },
  { plane: 'roles', key: 'description', kind: 'string', impact: 'Human description shown in role listings', docRef: 'docs/sidebar-role-config.md' },
  { plane: 'roles', key: 'guidelines', kind: 'string', impact: 'Per-role behavior constraints injected as a pier-role prompt section each turn (RFC rfc-pi-0.86-dynamic-tools §4.6)', docRef: 'docs/rfc-pi-0.86-dynamic-tools.md' },
  { plane: 'roles', key: 'manifest.tools', kind: 'string', impact: 'Visible tool names for the role', docRef: 'docs/sidebar-role-config.md' },
  { plane: 'roles', key: 'manifest.rules', kind: 'string', impact: 'Permission map: tool name → allow|ask|deny', docRef: 'docs/sidebar-role-config.md' },
  { plane: 'roles', key: 'manifest.unknownTools', kind: 'enum', impact: 'Stance for tools missing from manifest.tools: allow|deny', docRef: 'docs/sidebar-role-config.md' },
  { plane: 'roles', key: 'services.todos', kind: 'string', impact: 'Todo service mode for the role: serial|parallel', docRef: 'docs/sidebar-role-config.md' },
];

/** Pi-owned keys pier only reads. */
const PI_KNOBS: readonly ConfigKnob[] = [
  { plane: 'pi', key: 'compaction.enabled', kind: 'boolean', impact: 'When false, OCC is disabled too (unless PI_HERDR_COMPACT_ENABLE=1)', docRef: 'docs/efficiency-trial.md', readOnly: true },
  { plane: 'pi', key: 'compaction.keepRecentTokens', kind: 'number', impact: 'Inherited as the OCC retention window when not set in the efficiency config', docRef: 'docs/efficiency-trial.md', readOnly: true },
];

/** Workbench boot-config keys (template: packages/pier-workbench/scripts/boot-config.example.json). */
const BOOT_KNOBS: readonly ConfigKnob[] = [
  { plane: 'boot', key: 'mainTabLabel', kind: 'string', impact: 'Label of the main tab the workbench keeps', readOnly: true },
  { plane: 'boot', key: 'piNode', kind: 'string', impact: 'Absolute node binary used to launch pi', readOnly: true },
  { plane: 'boot', key: 'piCli', kind: 'string', impact: 'Absolute path to pi\'s cli.js', readOnly: true },
  { plane: 'boot', key: 'extPath', kind: 'string', impact: 'Absolute path to the pier extension entry (index.ts)', readOnly: true },
  { plane: 'boot', key: 'workbenchPluginId', kind: 'string', impact: 'herdr plugin id the boot script drives', readOnly: true },
  { plane: 'boot', key: 'hmrDev', kind: 'boolean', impact: 'Enable hot-reload wiring for local development', readOnly: true },
];

/**
 * Runtime policy / behaviour env knobs. Bounds mirror runtime-policy.ts (parseEnvInt) and
 * the readers in terminal-core.ts / todo-reminder-core.ts / pi-surface bootstrap.
 */
const ENV_KNOBS: readonly ConfigKnob[] = [
  { plane: 'env', key: 'PIER_SUBAGENT_TIMEOUT_MS', aliases: ['PI_HERDR_SUBAGENT_TIMEOUT_MS'], kind: 'number', defaultValue: 600000, min: 1000, impact: 'Subagent inactivity budget before forced termination' },
  { plane: 'env', key: 'PIER_GC_TICK_MS', aliases: ['PI_HERDR_GC_TICK_MS'], kind: 'number', defaultValue: 30000, min: 1000, impact: 'Subagent GC ticker interval' },
  { plane: 'env', key: 'PIER_POLL_INTERVAL_MS', aliases: ['PI_HERDR_POLL_INTERVAL_MS'], kind: 'number', defaultValue: 30000, min: 1000, impact: 'Subagent state observation poll interval' },
  { plane: 'env', key: 'PIER_SETTLEMENT_WINDOW_MS', aliases: ['PI_HERDR_SETTLEMENT_WINDOW_MS'], kind: 'number', defaultValue: 60000, min: 0, impact: 'Settlement notice window / machine-inject grace / takeover idle' },
  { plane: 'env', key: 'PIER_OBSERVATION_WINDOW_MS', aliases: ['PI_HERDR_OBSERVATION_WINDOW_MS'], kind: 'number', defaultValue: 30000, min: 0, impact: 'Post-settle observation window before auto-consume' },
  { plane: 'env', key: 'PIER_FOREGROUND_PATIENCE_MS', aliases: ['PI_HERDR_FOREGROUND_PATIENCE_MS'], kind: 'number', defaultValue: 300000, min: 0, impact: 'Foreground patience before demoting a subagent to background' },
  { plane: 'env', key: 'PIER_SESSION_TTL_SECONDS', aliases: ['PI_HERDR_SESSION_TTL_SECONDS'], kind: 'number', defaultValue: 600, min: 0, impact: 'Session retention after subagent exit before GC' },
  { plane: 'env', key: 'PIER_GIT_TIMEOUT_MS', aliases: ['PI_HERDR_GIT_TIMEOUT_MS'], kind: 'number', defaultValue: 10000, min: 1, impact: 'git worktree/diff/cleanup execution timeout' },
  { plane: 'env', key: 'PIER_READY_TIMEOUT_MS', aliases: ['PI_HERDR_READY_TIMEOUT_MS'], kind: 'number', defaultValue: 90000, min: 1000, impact: 'Subagent pane pipe readiness wait (backoff; a dead pane fails fast)' },
  { plane: 'env', key: 'PIER_ISOLATE_SWEEP_ORPHANS', aliases: ['PI_HERDR_ISOLATE_SWEEP_ORPHANS'], kind: 'string', impact: 'Opt-in sweeping of orphaned isolate worktrees' },
  { plane: 'env', key: 'PIER_FOCUS_POLL_MS', kind: 'number', defaultValue: 1500, min: 0, impact: 'Pane-focus sampling cadence for the workbench heat layout (0 disables). Default 1500ms on Herdr <0.9.1; 0 (event-first) on 0.9.1+' },
  { plane: 'env', key: 'PIER_TERMINAL_PROMPT', aliases: ['PI_HERDR_TERMINAL_PROMPT'], kind: 'string', impact: 'Terminal readiness prompt strategy: bash|zsh|powershell|pwsh (default: $SHELL)' },
  // B10: canonical names are `PIER_*`; the `PI_HERDR_*` spelling stays accepted (aliases).
  { plane: 'env', key: 'PIER_TODO_GRACE_MS', aliases: ['PI_HERDR_TODO_GRACE_MS'], kind: 'number', defaultValue: 30000, min: 1, impact: 'Delay before the unfinished-todo reminder fires (0/NaN falls back to the default)' },
  { plane: 'env', key: 'PIER_TERM_IDLE_MS', aliases: ['PI_HERDR_TERM_IDLE_MS'], kind: 'number', defaultValue: 1800000, min: 1, impact: 'Terminal idle threshold before a nudge is due (0/NaN falls back to the default)' },
  { plane: 'env', key: 'PIER_TERM_GRACE_MS', aliases: ['PI_HERDR_TERM_GRACE_MS'], kind: 'number', defaultValue: 30000, min: 1, impact: 'Extra grace after terminal idle before reading (0/NaN falls back to the default)' },
  { plane: 'env', key: 'PIER_TERM_READ_MAX', aliases: ['PI_HERDR_TERM_READ_MAX'], kind: 'number', defaultValue: 8000, min: 1, impact: 'Maximum terminal characters read per operation (0/NaN falls back to the default)' },
  { plane: 'env', key: 'PIER_TRACE', aliases: ['PI_HERDR_TRACE'], kind: 'string', impact: 'Write pier diagnostics to stderr (or to this file when it is a path)' },
  { plane: 'env', key: 'PIER_SLIM_FRAME', aliases: ['PI_HERDR_SLIM_FRAME'], kind: 'string', impact: 'Force the slim transcript frame on/off' },
  { plane: 'env', key: 'PIER_HMR', aliases: ['PI_HERDR_HMR'], kind: 'string', impact: 'Force hot-reload wiring on/off' },
];

export const CONFIG_KNOBS: readonly ConfigKnob[] = Object.freeze([
  ...EFFICIENCY_KNOBS,
  ...ROLE_KNOBS,
  ...PI_KNOBS,
  ...BOOT_KNOBS,
  ...ENV_KNOBS,
]);

export function catalogKeysForPlane(plane: ConfigPlaneId): string[] {
  return CONFIG_KNOBS.filter((k) => k.plane === plane).map((k) => k.key);
}

export function planeById(id: ConfigPlaneId): ConfigPlane | undefined {
  return CONFIG_PLANES.find((p) => p.id === id);
}

/** Dotted-path getter for parsed JSON layers. */
export function readDotted(obj: unknown, dotted: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  let cursor: unknown = obj;
  for (const part of dotted.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * Secret-shaped KEY names (not values). Deliberately narrower than a bare `token` match so
 * that legitimate keys like `compaction.keepRecentTokens` are still shown verbatim.
 */
const SECRET_LIKE = /(api[_-]?key|apikey|authorization|bearer|access[_-]?token|client[_-]?secret|password|credential)/i;

/** True when a value should never be echoed verbatim in command output. */
export function isSecretLike(key: string): boolean {
  return SECRET_LIKE.test(key);
}

export function formatValue(value: unknown): string {
  if (value === undefined) return '(unset)';
  if (typeof value === 'string') return value === '' ? '""' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return JSON.stringify(value);
}

/** Renders a knob value, masking secret-looking keys. */
export function redactValue(key: string, value: unknown): string {
  if (isSecretLike(key) && value !== undefined && value !== '') return '***';
  return formatValue(value);
}

export type ConfigSource = 'env' | 'workspace' | 'user' | 'default' | 'pi';

export interface ResolvedKnob {
  readonly knob: ConfigKnob;
  readonly value: string;
  readonly source: ConfigSource;
  /** Env var that actually supplied the value when it is an alias of `knob.key`. */
  readonly via?: string;
  /** Set when a workspace layer exists but was ignored (untrusted project). */
  readonly note?: string;
}

export interface RawConfigLayers {
  readonly env?: Record<string, string | undefined>;
  /** Parsed workspace efficiency config (untrusted layers are reported, never honored). */
  readonly workspace?: unknown;
  readonly user?: unknown;
  readonly workspaceTrusted?: boolean;
  /** Result of loadPiNativeCompactionSettings (pi-owned values pier reads). */
  readonly piSettings?: { enabled?: boolean; keepRecentTokens?: number };
}

function resolveFileKnob(
  knob: ConfigKnob,
  layers: RawConfigLayers,
): ResolvedKnob {
  const env = layers.env ?? {};
  const envRaw = knob.envVar ? env[knob.envVar] : undefined;
  if (envRaw !== undefined && envRaw !== '') {
    return { knob, value: redactValue(knob.key, envRaw), source: 'env' };
  }

  const workspaceValue = readDotted(layers.workspace, knob.key);
  const userValue = readDotted(layers.user, knob.key);
  if (layers.workspace !== undefined && !layers.workspaceTrusted) {
    // Untrusted workspace layer exists but is ignored by the loader: surface both facts.
    if (workspaceValue !== undefined) {
      if (userValue !== undefined) {
        return { knob, value: redactValue(knob.key, userValue), source: 'user', note: 'workspace layer ignored (untrusted project)' };
      }
      return { knob, value: redactValue(knob.key, knob.defaultValue), source: 'default', note: 'workspace value ignored (untrusted project)' };
    }
  } else if (workspaceValue !== undefined) {
    return { knob, value: redactValue(knob.key, workspaceValue), source: 'workspace' };
  }

  if (userValue !== undefined) return { knob, value: redactValue(knob.key, userValue), source: 'user' };
  return { knob, value: redactValue(knob.key, knob.defaultValue), source: 'default' };
}

/** Resolves efficiency + pi knobs from parsed layers. */
export function resolveConfigKnobs(layers: RawConfigLayers): ResolvedKnob[] {
  const out: ResolvedKnob[] = [];
  for (const knob of EFFICIENCY_KNOBS) out.push(resolveFileKnob(knob, layers));

  // Effective-value rule from loadEfficiencyConfigFromDisk: pi's compaction.enabled=false
  // disables OCC unless PI_HERDR_COMPACT_ENABLE forces it on.
  const occ = out.find((e) => e.knob.key === 'onlineContextCompact.enabled');
  const envForced = (layers.env?.PI_HERDR_COMPACT_ENABLE ?? '') !== '';
  if (occ && occ.value === 'true' && layers.piSettings?.enabled === false && !envForced) {
    const index = out.indexOf(occ);
    out[index] = { ...occ, value: 'false', note: 'pi compaction.enabled=false disables OCC (set PI_HERDR_COMPACT_ENABLE=1 to force)' };
  }

  for (const knob of PI_KNOBS) {
    const raw = knob.key === 'compaction.enabled' ? layers.piSettings?.enabled : layers.piSettings?.keepRecentTokens;
    if (raw !== undefined) out.push({ knob, value: redactValue(knob.key, raw), source: 'pi' });
    else out.push({ knob, value: formatValue(undefined), source: 'pi', note: 'not set in pi settings' });
  }
  return out;
}

/** Resolves the env plane: only catalog keys are ever read. */
export function resolveEnvKnobs(env: Record<string, string | undefined> = {}): ResolvedKnob[] {
  return ENV_KNOBS.map((knob) => {
    // Same precedence as pierOption(): canonical first, then the historical spelling, empty = unset.
    for (const name of [knob.key, ...(knob.aliases ?? [])]) {
      const raw = env[name];
      if (raw === undefined || raw === '') continue;
      return {
        knob,
        value: redactValue(knob.key, raw),
        source: 'env' as const,
        ...(name === knob.key ? {} : { via: name }),
      };
    }
    return { knob, value: redactValue(knob.key, knob.defaultValue), source: 'default' as const };
  });
}

/* ── checks ─────────────────────────────────────────────────────────────── */

export interface CheckReport {
  readonly plane: ConfigPlaneId;
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/** Validates env knobs against catalog bounds (mirrors parseEnvInt's warn-and-default behaviour). */
export function checkEnvKnobs(env: Record<string, string | undefined> = {}): string[] {
  const issues: string[] = [];
  for (const knob of ENV_KNOBS) {
    for (const name of [knob.key, ...(knob.aliases ?? [])]) {
      const raw = env[name];
      if (raw === undefined || raw === '') continue;
      if (knob.kind !== 'number') continue;
      const parsed = Number.parseInt(raw, 10);
      const min = knob.min ?? 0;
      if (!Number.isFinite(parsed) || parsed < min) {
        issues.push(`${name}="${raw}" is not a valid integer >= ${min} (runtime falls back to ${formatValue(knob.defaultValue)})`);
      }
    }
  }
  return issues;
}

/* ── rendering ──────────────────────────────────────────────────────────── */

const SOURCE_TAG: Record<ConfigSource, string> = {
  env: 'env',
  workspace: 'workspace',
  user: 'user',
  default: 'default',
  pi: 'pi',
};

function sourceLabel(entry: ResolvedKnob): string {
  const base = entry.via ? `${SOURCE_TAG[entry.source]} via ${entry.via}` : SOURCE_TAG[entry.source];
  return entry.note ? `${base} (${entry.note})` : base;
}

/** Short non-default summary of one plane: "3 changed (env 1 / workspace 1 / user 1)". */
export function summarizePlane(entries: readonly ResolvedKnob[]): string {
  const changed = entries.filter((e) => e.source !== 'default');
  if (changed.length === 0) return 'all defaults';
  const bySource = new Map<ConfigSource, number>();
  for (const e of changed) bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
  const parts = [...bySource.entries()].map(([s, n]) => `${SOURCE_TAG[s]} ${n}`);
  return `${changed.length} set (${parts.join(', ')})`;
}

/** Index lines for `/pier-config` (kept short: one line per plane). */
export function renderIndex(lines: {
  efficiency: readonly ResolvedKnob[];
  pi: readonly ResolvedKnob[];
  env: readonly ResolvedKnob[];
  roleSummary: string;
  bootSummary: string;
}): string[] {
  const enabled = (prefix: string): number =>
    lines.efficiency.filter((e) => e.knob.key === `${prefix}.enabled` && e.value === 'true').length;
  const out: string[] = [];
  out.push(`pier config — 5 planes, env > workspace > user > default`);
  out.push(`  efficiency  ${summarizePlane(lines.efficiency)} — OCC ${enabled('onlineContextCompact') ? 'on' : 'off'} / OBS ${enabled('observationPack') ? 'on' : 'off'} / EPR ${enabled('evidencePreservingReducer') ? 'on' : 'off'}`);
  out.push(`  roles       ${lines.roleSummary}`);
  out.push(`  pi          ${summarizePlane(lines.pi)} — OCC reads compaction.* only`);
  out.push(`  boot        ${lines.bootSummary}`);
  out.push(`  env         ${summarizePlane(lines.env)}`);
  out.push(`  show: /pier-config show <efficiency|roles|pi|boot|env|all>   check: /pier-config check   report: /pier-config doc`);
  return out;
}

/** Full listing for one plane. */
export function renderPlane(plane: ConfigPlaneId, entries: readonly ResolvedKnob[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const key = entry.knob.envVar && entry.knob.plane === 'efficiency' && entry.knob.envVar
      ? `${entry.knob.key}${entry.source === 'env' ? ' (from ' + entry.knob.envVar + ')' : ''}`
      : entry.knob.key;
    const flags = [entry.knob.readOnly ? 'read-only' : '', entry.knob.docRef ?? ''].filter(Boolean).join('; ');
    out.push(`  ${key} = ${entry.value}  [${sourceLabel(entry)}]${flags ? `  (${flags})` : ''}`);
    if (entry.knob.impact) out.push(`      ${entry.knob.impact}`);
  }
  void plane;
  return out;
}

/** Validated-issue lines for `check`. */
export function renderCheck(reports: readonly CheckReport[]): string[] {
  const out: string[] = [];
  for (const report of reports) {
    out.push(`  ${report.ok ? 'ok  ' : 'FAIL'} ${report.plane}`);
    for (const issue of report.issues) out.push(`      - ${issue}`);
  }
  return out;
}

export interface ReportMeta {
  readonly generatedAt: string;
  readonly cwd: string;
  readonly workspaceTrusted: boolean;
  readonly piVersion?: string;
}

/** Machine-truth markdown report (`/pier-config doc`). */
export function renderReport(entries: readonly ResolvedKnob[], meta: ReportMeta): string {
  const lines: string[] = [];
  lines.push('# pier config report');
  lines.push('');
  lines.push(`- generated: ${meta.generatedAt}`);
  lines.push(`- cwd: ${meta.cwd}`);
  lines.push(`- workspace trusted: ${meta.workspaceTrusted}`);
  if (meta.piVersion) lines.push(`- pi: ${meta.piVersion}`);
  lines.push('');
  lines.push('Precedence: env > workspace (trusted) > user > default.');
  lines.push('');
  for (const plane of CONFIG_PLANES) {
    const planeEntries = entries.filter((e) => e.knob.plane === plane.id);
    lines.push(`## ${plane.id} — ${plane.title}`);
    lines.push('');
    lines.push(`Files: ${plane.files.map((f) => `\`${f}\``).join(' , ')}`);
    lines.push('');
    lines.push(`> ${plane.editHint}`);
    lines.push('');
    if (planeEntries.length === 0) {
      lines.push('(no value-carrying knobs; per-file plane)');
      lines.push('');
      continue;
    }
    lines.push('| key | value | source | impact |');
    lines.push('|---|---|---|---|');
    for (const entry of planeEntries) {
      const value = entry.value.replace(/\|/g, '\\|');
      lines.push(`| \`${entry.knob.key}\` | ${value} | ${sourceLabel(entry)} | ${entry.knob.impact.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

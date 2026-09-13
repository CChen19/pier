/**
 * D104 Config Guide adapter.
 *
 * Thin I/O layer over config-catalog-core: reads the real files/env for the five
 * configuration planes, aggregates validation issues, and renders the strings used by
 * `/pier-config show|check|doc`. All paths are injectable so tests never touch the
 * developer's real home directory.
 *
 * Fail-open: every read is wrapped; a broken plane degrades to a reported issue rather
 * than throwing into pi's command pipeline.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_PLANES,
  checkEnvKnobs,
  formatValue,
  readDotted,
  renderCheck,
  renderIndex,
  renderPlane,
  renderReport,
  resolveConfigKnobs,
  resolveEnvKnobs,
  summarizePlane,
  type CheckReport,
  type ConfigPlaneId,
  type ResolvedKnob,
} from './config-catalog-core.ts';
import {
  defaultUserEfficiencyConfigFile,
  defaultWorkspaceEfficiencyConfigFile,
  loadPiNativeCompactionSettings,
  validateEfficiencyConfig,
} from './efficiency-config-core.ts';
import { RESERVED_ROLE_NAMES, loadRoleConfig, roleLayers } from './role-loader.ts';

export const CONFIG_GUIDANCE_PROMPT = [
  '[PIER-CONFIG] The user wants to inspect or change pier configuration. Follow this workflow strictly:',
  '',
  '1. Ground yourself first: run `/pier-config show all` (or read the files) and use the reported EFFECTIVE VALUE and SOURCE',
  '   (env > workspace > user > default). Only entries whose source is `default` are worth changing; an ignored workspace file',
  '   (untrusted project) must be reported as such instead of edited blindly.',
  '2. Route by plane:',
  '   - efficiency (D100-D103): read `docs/efficiency-trial.md` before proposing values.',
  '   - roles: read `docs/sidebar-role-config.md` and `schemas/role-manifest.schema.json`; builtin role names cannot be overridden.',
  "   - pi (settings.json): recommend pi's own `/settings`; the only OCC-relevant keys here are `compaction.enabled` and",
  '     `compaction.keepRecentTokens` (read-only from our side).',
  '   - boot (boot-config.json): manual edits are risky; prefer `npx pier-setup@latest update --force`, and only patch paths when asked.',
  '   - env (PIER_* / PI_HERDR_*): affects new processes only; state that explicitly.',
  '3. Explain before changing: 2-3 sentences on what the knob controls, its cost/benefit (tokens, latency, safety, blast radius),',
  '   and 2-3 recommended values for common scenarios. Then ask what the user actually wants to achieve.',
  '4. Before writing: show a precise diff (file path, current -> proposed value) and the activation path',
  '   (hot / needs `/reload` / needs a new session or process restart). Wait for explicit confirmation. Change ONE plane at a time.',
  '5. Apply with the normal `edit`/`write` tools (write locks apply), then run `/pier-config check` and report the result back.',
  '6. If a change cannot take effect in the current process, say so and tell the user exactly what to restart.',
  '',
  'Forbidden: dumping `process.env`; writing secrets or tokens into any config file; editing multiple planes before confirmation;',
  'touching `.pi-herdr/` of an untrusted project.',
].join('\n');

export interface ConfigPlaneFile {
  readonly path: string;
  readonly label: string;
  readonly exists: boolean;
  readonly ignored?: boolean;
}

export interface ConfigGuideDeps {
  cwd?: string;
  env?: Record<string, string | undefined>;
  isProjectTrusted?: boolean;
  /** Pi agent dir holding settings.json (defaults to ~/.pi/agent; mirrors PI_CODING_AGENT_DIR). */
  agentDir?: string;
  /** User-level efficiency config path (defaults to ~/.pi/agent/herdr-pi/config.json). */
  userConfigPath?: string;
  /** herdr plugin config dir holding the user-mode boot-config.json. */
  herdrPluginConfigDir?: string;
  /** Repository root used to probe the dev-mode boot-config.json. */
  repoRoot?: string;
}

export interface ConfigGuideSnapshot {
  readonly entries: readonly ResolvedKnob[];
  readonly reports: readonly CheckReport[];
  readonly files: Readonly<Record<ConfigPlaneId, readonly ConfigPlaneFile[]>>;
  readonly workspaceTrusted: boolean;
  readonly roleSummary: string;
  readonly bootSummary: string;
}

function defaultAgentDir(env: Record<string, string | undefined>): string {
  return env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
}

/** Repo root of this checkout (works in-repo; in node_modules the probe simply finds nothing). */
function defaultRepoRoot(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return resolve(here, '..', '..', '..');
  } catch {
    return process.cwd();
  }
}

function readJsonLayer(path: string): { value: unknown; issue?: string } {
  if (!existsSync(path)) return { value: undefined };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (err) {
    return { value: undefined, issue: `${path}: invalid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
}

function listJsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

/** Collects the whole snapshot for the guide/command. */
export function collectConfigSnapshot(deps: ConfigGuideDeps = {}): ConfigGuideSnapshot {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const workspaceTrusted = deps.isProjectTrusted ?? false;
  const agentDir = deps.agentDir ?? defaultAgentDir(env);
  const userConfigPath = deps.userConfigPath ?? defaultUserEfficiencyConfigFile();
  const workspaceConfigPath = defaultWorkspaceEfficiencyConfigFile(cwd);
  const repoRoot = deps.repoRoot ?? defaultRepoRoot();
  const herdrPluginConfigDir = deps.herdrPluginConfigDir ?? env.HERDR_PLUGIN_CONFIG_DIR;

  const reports: CheckReport[] = [];
  const files: Record<ConfigPlaneId, ConfigPlaneFile[]> = {
    efficiency: [],
    roles: [],
    pi: [],
    boot: [],
    env: [],
  };

  /* ── efficiency ───────────────────────────────────────────────────────── */
  const workspaceLayer = readJsonLayer(workspaceConfigPath);
  const userLayer = readJsonLayer(userConfigPath);
  const efficiencyIssues: string[] = [];
  if (workspaceLayer.issue) efficiencyIssues.push(workspaceLayer.issue);
  if (userLayer.issue) efficiencyIssues.push(userLayer.issue);

  if (workspaceLayer.value !== undefined) {
    if (!workspaceTrusted) {
      efficiencyIssues.push(`${workspaceConfigPath}: ignored — the project is not trusted (values below come from user/default)`);
    } else {
      const validated = validateEfficiencyConfig(workspaceLayer.value);
      for (const issue of validated.issues) efficiencyIssues.push(`${workspaceConfigPath}: ${issue}`);
    }
  }
  if (userLayer.value !== undefined) {
    const validated = validateEfficiencyConfig(userLayer.value);
    for (const issue of validated.issues) efficiencyIssues.push(`${userConfigPath}: ${issue}`);
  }

  files.efficiency.push(
    { path: workspaceConfigPath, label: 'workspace', exists: workspaceLayer.value !== undefined, ignored: !workspaceTrusted },
    { path: userConfigPath, label: 'user', exists: userLayer.value !== undefined },
  );

  /* ── pi settings ──────────────────────────────────────────────────────── */
  let piSettings: { enabled?: boolean; keepRecentTokens?: number } = {};
  const piSettingsPath = join(agentDir, 'settings.json');
  try {
    piSettings = loadPiNativeCompactionSettings({ cwd, isProjectTrusted: workspaceTrusted, agentDir });
  } catch {
    piSettings = {};
  }
  const piIssues: string[] = [];
  if (!existsSync(piSettingsPath)) {
    piIssues.push(`${piSettingsPath}: not found (pi defaults apply; use pi's /settings to create it)`);
  }
  files.pi.push({ path: piSettingsPath, label: 'agent', exists: existsSync(piSettingsPath) });

  /* ── env ──────────────────────────────────────────────────────────────── */
  const envIssues = checkEnvKnobs(env);
  files.env.push({ path: '(process environment)', label: 'env', exists: true });

  /* ── roles ────────────────────────────────────────────────────────────── */
  const layerDirs = roleLayers({ baseDir: cwd });
  const roleIssues: string[] = [];
  const roleNames = new Set<string>();
  const customLayerNames = new Set<string>();
  const layerCounts: string[] = [];
  for (const layer of layerDirs) {
    const names = listJsonFiles(layer.dir);
    const kind: ConfigPlaneFile['label'] = layer.label.startsWith('workspace')
      ? 'workspace'
      : layer.label.startsWith('user') ? 'user' : 'builtin';
    files.roles.push({ path: layer.dir, label: kind, exists: names.length > 0 });
    layerCounts.push(`${kind} ${names.length}`);
    for (const file of names) {
      const name = file.replace(/\.json$/, '');
      roleNames.add(name);
      if (kind !== 'builtin') customLayerNames.add(name);
    }
  }
  for (const name of [...roleNames].sort()) {
    try {
      loadRoleConfig(name, { baseDir: cwd });
    } catch (err) {
      const issues = (err as { issues?: readonly string[] }).issues ?? [];
      roleIssues.push(`role "${name}": ${err instanceof Error ? err.message : String(err)}${issues.length ? ` — ${issues.join('; ')}` : ''}`);
    }
  }
  // Built-in names come from the bundled layer by design; only custom layers are suspicious.
  const reservedPresent = [...customLayerNames].filter((n) => RESERVED_ROLE_NAMES.includes(n));
  if (reservedPresent.length > 0) {
    roleIssues.push(`reserved role name(s) shadowed in a custom layer (ignored for built-ins): ${reservedPresent.join(', ')}`);
  }
  const roleSummary = `${roleNames.size} role(s): ${layerCounts.join(' / ')}`;

  /* ── boot-config ──────────────────────────────────────────────────────── */
  const bootIssues: string[] = [];
  const bootCandidates: Array<{ path: string; label: string }> = [];
  if (herdrPluginConfigDir) bootCandidates.push({ path: join(herdrPluginConfigDir, 'boot-config.json'), label: 'herdr plugin config-dir' });
  bootCandidates.push({ path: join(repoRoot, 'packages', 'pier-workbench', 'scripts', 'boot-config.json'), label: 'dev (repo)' });
  let bootFound: { path: string; label: string } | null = null;
  for (const candidate of bootCandidates) {
    const exists = existsSync(candidate.path);
    files.boot.push({ path: candidate.path, label: candidate.label, exists });
    if (exists && !bootFound) bootFound = candidate;
  }
  if (!bootFound) {
    bootIssues.push(`boot-config.json not found in: ${bootCandidates.map((c) => c.path).join(' , ')} (run \`npx pier-setup@latest install\`)`);
  } else {
    const parsed = readJsonLayer(bootFound.path);
    if (parsed.issue) {
      bootIssues.push(parsed.issue);
    } else {
      for (const key of ['piNode', 'piCli', 'extPath'] as const) {
        const value = readDotted(parsed.value, key);
        if (typeof value !== 'string' || value === '') {
          bootIssues.push(`${bootFound.path}: missing required key "${key}"`);
          continue;
        }
        // A stale absolute path is the most common post-reinstall breakage (e.g. an npm
        // install path that no longer exists while pi still loads the extension elsewhere).
        if (!existsSync(value)) {
          bootIssues.push(
            `${bootFound.path}: "${key}" points to a path that does not exist: ${value} (stale after a reinstall? re-run \`npx pier-setup@latest update --force\`)`,
          );
        }
      }
    }
  }
  const bootSummary = bootFound ? `present (${bootFound.label})` : 'missing (run pier-setup)';

  /* ── resolution + reports ─────────────────────────────────────────────── */
  const entries = [
    ...resolveConfigKnobs({ env, workspace: workspaceLayer.value, user: userLayer.value, workspaceTrusted, piSettings }),
    ...resolveEnvKnobs(env),
  ];

  reports.push({ plane: 'efficiency', ok: efficiencyIssues.length === 0, issues: efficiencyIssues });
  reports.push({ plane: 'roles', ok: roleIssues.length === 0, issues: roleIssues });
  reports.push({ plane: 'pi', ok: true, issues: piIssues });
  reports.push({ plane: 'boot', ok: bootIssues.length === 0, issues: bootIssues });
  reports.push({ plane: 'env', ok: envIssues.length === 0, issues: envIssues });

  return { entries, reports, files, workspaceTrusted, roleSummary, bootSummary };
}

/* ── rendering used by the command ───────────────────────────────────────── */

export function guideIndexLines(snapshot: ConfigGuideSnapshot): string[] {
  const pick = (plane: ConfigPlaneId, prefix: string): readonly ResolvedKnob[] =>
    snapshot.entries.filter((e) => e.knob.plane === plane && e.knob.key.startsWith(prefix));
  return renderIndex({
    efficiency: pick('efficiency', ''),
    pi: pick('pi', ''),
    env: pick('env', ''),
    roleSummary: snapshot.roleSummary,
    bootSummary: snapshot.bootSummary,
  });
}

export function guidePlaneLines(snapshot: ConfigGuideSnapshot, plane: ConfigPlaneId | 'all'): string[] {
  const planes = plane === 'all' ? CONFIG_PLANES.map((p) => p.id) : [plane];
  const out: string[] = [];
  for (const id of planes) {
    const meta = CONFIG_PLANES.find((p) => p.id === id);
    if (!meta) continue;
    out.push(`${id} — ${meta.title}`);
    for (const file of snapshot.files[id]) {
      const status = file.exists ? (file.ignored ? 'present (IGNORED: untrusted project)' : 'present') : 'absent';
      out.push(`  file [${file.label}] ${file.path} — ${status}`);
    }
    out.push(`  hint: ${meta.editHint}`);
    const entries = snapshot.entries.filter((e) => e.knob.plane === id);
    if (entries.length > 0) out.push(...renderPlane(id, entries));
    else out.push(`  (per-file plane: ${entrySummaryForPlane(snapshot, id)})`);
    out.push('');
  }
  return out;
}

function entrySummaryForPlane(snapshot: ConfigGuideSnapshot, plane: ConfigPlaneId): string {
  const report = snapshot.reports.find((r) => r.plane === plane);
  if (!report) return 'no data';
  return report.ok ? 'no issues' : `${report.issues.length} issue(s) — see /pier-config check`;
}

export function guideCheckLines(snapshot: ConfigGuideSnapshot): string[] {
  const lines = renderCheck(snapshot.reports);
  const anyFail = snapshot.reports.some((r) => !r.ok);
  lines.push(anyFail ? '  → fix the FAIL planes above (values are still shown by `show`)' : '  → all planes look consistent');
  return lines;
}

export function guideReportMarkdown(snapshot: ConfigGuideSnapshot, meta: { generatedAt: string; cwd: string; piVersion?: string }): string {
  const body = renderReport(snapshot.entries, {
    generatedAt: meta.generatedAt,
    cwd: meta.cwd,
    workspaceTrusted: snapshot.workspaceTrusted,
    piVersion: meta.piVersion,
  });
  const filesSection = ['', '## Files observed', ''];
  for (const plane of CONFIG_PLANES) {
    for (const file of snapshot.files[plane.id]) {
      filesSection.push(`- [${plane.id}] ${file.label}: \`${file.path}\` — ${file.exists ? (file.ignored ? 'present, ignored (untrusted project)' : 'present') : 'absent'}`);
    }
  }
  const checkSection = ['', '## Checks', '', ...guideCheckLines(snapshot).map((l) => `- ${l.trim()}`)];
  return `${body}\n${filesSection.join('\n')}\n${checkSection.join('\n')}\n`;
}

/** Summary line shown by `/efficiency` after convergence. */
export function efficiencyPointerLine(snapshot: ConfigGuideSnapshot): string {
  const occ = snapshot.entries.find((e) => e.knob.key === 'onlineContextCompact.enabled');
  const obs = snapshot.entries.find((e) => e.knob.key === 'observationPack.enabled');
  const epr = snapshot.entries.find((e) => e.knob.key === 'evidencePreservingReducer.enabled');
  const state = (entry: ResolvedKnob | undefined): string => (entry ? entry.value : 'false');
  return `OCC ${state(occ)} / OBS ${state(obs)} / EPR ${state(epr)} — details: /pier-config show efficiency (${summarizePlane(snapshot.entries.filter((e) => e.knob.plane === 'efficiency'))})`;
}

/** Small helper used by tests and `show` for reading a single knob. */
export function knobValue(snapshot: ConfigGuideSnapshot, plane: ConfigPlaneId, key: string): string {
  const entry = snapshot.entries.find((e) => e.knob.plane === plane && e.knob.key === key);
  return entry ? `${entry.value} [${entry.source}]` : formatValue(undefined);
}

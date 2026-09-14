/**
 * D104 config-catalog-core tests.
 *
 * Beyond behaviour, this file is the catalog's drift guard: the knob list must stay in
 * sync with schemas/efficiency-config.schema.json, schemas/role-manifest.schema.json and
 * the env keys the runtime actually reads. Adding a config key without documenting it
 * (or removing one that is still read) fails here instead of silently going stale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_KNOBS,
  CONFIG_PLANES,
  catalogKeysForPlane,
  checkEnvKnobs,
  formatValue,
  isSecretLike,
  planeById,
  readDotted,
  redactValue,
  renderCheck,
  renderIndex,
  renderPlane,
  renderReport,
  resolveConfigKnobs,
  resolveEnvKnobs,
  summarizePlane,
} from '../src/config-catalog-core.ts';
import { PIER_OPTIONS } from '../src/pier-options.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

function schemaPropertyPaths(file: string): string[] {
  const schema = JSON.parse(readFileSync(join(repoRoot, 'packages', 'pier-ext', 'schemas', file), 'utf8'));
  const out: string[] = [];
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    const props = node.properties as Record<string, unknown> | undefined;
    if (!props) return;
    for (const [key, value] of Object.entries(props)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.push(path);
      walk((value ?? {}) as Record<string, unknown>, path);
    }
  };
  walk(schema as Record<string, unknown>, '');
  return out;
}

test('catalog covers every schema key for the efficiency and role planes (drift guard)', () => {
  const efficiencySchema = schemaPropertyPaths('efficiency-config.schema.json').filter(
    (k) => k !== 'version' && !/^onlineContextCompact$|^observationPack$|^evidencePreservingReducer$/.test(k),
  );
  const efficiencyCatalog = new Set(catalogKeysForPlane('efficiency'));
  for (const key of efficiencySchema) {
    assert.equal(efficiencyCatalog.has(key), true, `schema key "${key}" is missing from the catalog`);
  }
  // No stale entries: every catalog key must still exist in the schema.
  for (const key of efficiencyCatalog) {
    assert.equal(efficiencySchema.includes(key), true, `catalog key "${key}" no longer exists in the schema`);
  }

  // Role manifests are per-file; the catalog tracks the schema's inventory. `services.todos.mode`
  // is covered by the catalog's `services.todos` entry (mode is described in its docRef).
  const roleSchema = schemaPropertyPaths('role-manifest.schema.json');
  const roleCatalog = new Set(catalogKeysForPlane('roles'));
  const aliases: Record<string, string> = { 'services.todos.mode': 'services.todos' };
  for (const key of roleSchema) {
    if (['role', 'version', 'model', 'description', 'manifest', 'services', 'services.todos'].includes(key)) continue;
    const mapped = aliases[key] ?? key;
    assert.equal(roleCatalog.has(mapped), true, `role schema key "${key}" (mapped to "${mapped}") is missing from the catalog`);
  }
});

test('catalog covers the env keys the runtime reads (drift guard)', () => {
  const sources = [
    'src/runtime-policy.ts',
    'src/terminal-core.ts',
    'src/todo-reminder-core.ts',
    'src/efficiency-config-core.ts',
    'src/config-guide.ts',
  ]
    .map((rel) => readFileSync(join(repoRoot, 'packages', 'pier-ext', rel), 'utf8'))
    .join('\n');
  const found = new Set((sources.match(/\bPI(_HERDR)?_[A-Z0-9_]+\b/g) ?? []).filter((n) => !n.endsWith('_')));
  // Internal/pi-owned names that are not user configuration.
  const allowlist = new Set([
    'PI_HERDR_ROLE_MANIFEST',
    'PI_HERDR_SUBAGENT',
    'PI_SESSION_FILE',
    'PI_SESSION_ID',
    'PI_CODING_AGENT_DIR',
  ]);
  const catalog = new Set(catalogKeysForPlane('env'));
  const efficiencyKnobEnv = new Set(CONFIG_KNOBS.filter((k) => k.plane === 'efficiency' && k.envVar).map((k) => k.envVar!));
  // B10: pier-options is the registry for PIER_* knobs (plus the legacy PI_HERDR_* aliases they accept).
  const optionEnv = new Set(PIER_OPTIONS.flatMap((o) => [o.name, ...(o.legacy ? [o.legacy] : [])]));
  for (const name of found) {
    if (allowlist.has(name)) continue;
    assert.equal(
      catalog.has(name) || efficiencyKnobEnv.has(name) || optionEnv.has(name),
      true,
      `env var ${name} is read by the runtime but missing from the catalog`,
    );
  }
});

test('readDotted walks parsed JSON layers and tolerates bad shapes', () => {
  const layer = { observationPack: { thresholdBytes: 20480 }, mode: 'x' };
  assert.equal(readDotted(layer, 'observationPack.thresholdBytes'), 20480);
  assert.equal(readDotted(layer, 'observationPack.missing'), undefined);
  assert.equal(readDotted(layer, 'mode.deeper'), undefined);
  assert.equal(readDotted(undefined, 'a.b'), undefined);
  assert.equal(readDotted([1, 2], '0'), undefined);
});

test('resolveConfigKnobs applies env > workspace > user > default and marks untrusted workspaces', () => {
  const layers = {
    env: { PI_HERDR_OBS_PACK_ENABLE: '1' },
    workspace: { observationPack: { thresholdBytes: 4096 }, evidencePreservingReducer: { enabled: true } },
    user: { observationPack: { thresholdBytes: 8192, fullSends: 5 } },
    workspaceTrusted: true,
  };
  const resolved = resolveConfigKnobs(layers);
  const get = (key: string) => resolved.find((r) => r.knob.key === key)!;

  assert.equal(get('observationPack.enabled').value, '1', 'env wins');
  assert.equal(get('observationPack.enabled').source, 'env');
  assert.equal(get('observationPack.thresholdBytes').value, '4096', 'workspace beats user');
  assert.equal(get('observationPack.thresholdBytes').source, 'workspace');
  assert.equal(get('observationPack.fullSends').value, '5', 'falls back to the user layer');
  assert.equal(get('observationPack.fullSends').source, 'user');
  assert.equal(get('evidencePreservingReducer.localOnly').value, 'false', 'default layer');
  assert.equal(get('evidencePreservingReducer.localOnly').source, 'default');

  const untrusted = resolveConfigKnobs({ ...layers, workspaceTrusted: false });
  const threshold = untrusted.find((r) => r.knob.key === 'observationPack.thresholdBytes')!;
  assert.equal(threshold.value, '8192', 'untrusted workspace value is ignored');
  assert.equal(threshold.source, 'user');
  assert.match(threshold.note ?? '', /untrusted/);
});

test('resolveConfigKnobs reports pi-disabled compaction as the effective OCC value', () => {
  const enabled = resolveConfigKnobs({
    env: {},
    user: { onlineContextCompact: { enabled: true } },
    piSettings: { enabled: false },
  }).find((r) => r.knob.key === 'onlineContextCompact.enabled')!;
  assert.equal(enabled.value, 'false');
  assert.match(enabled.note ?? '', /compaction\.enabled=false/);

  const forced = resolveConfigKnobs({
    env: { PI_HERDR_COMPACT_ENABLE: '1' },
    user: { onlineContextCompact: { enabled: true } },
    piSettings: { enabled: false },
  }).find((r) => r.knob.key === 'onlineContextCompact.enabled')!;
  assert.equal(forced.value, '1');
  assert.equal(forced.source, 'env');

  const piKnob = resolveConfigKnobs({ piSettings: { keepRecentTokens: 35000 } }).find(
    (r) => r.knob.key === 'compaction.keepRecentTokens',
  )!;
  assert.equal(piKnob.value, '35000');
  assert.equal(piKnob.source, 'pi');
});

test('resolveEnvKnobs and checkEnvKnobs only touch catalog keys', () => {
  const env = { PIER_GC_TICK_MS: '5000', PI_HERDR_TERM_IDLE_MS: '0', PIER_SESSION_TTL_SECONDS: 'nope', SECRET_TOKEN: 'x' };
  const resolved = resolveEnvKnobs(env);
  assert.equal(resolved.length, catalogKeysForPlane('env').length);
  assert.equal(resolved.find((r) => r.knob.key === 'PIER_GC_TICK_MS')!.source, 'env');
  assert.equal(resolved.find((r) => r.knob.key === 'PIER_GC_TICK_MS')!.value, '5000');
  assert.equal(resolved.some((r) => r.knob.key === 'SECRET_TOKEN'), false, 'unknown env keys are never reported');

  const issues = checkEnvKnobs(env);
  assert.equal(issues.length, 2, issues.join(' | '));
  assert.ok(issues.some((i) => i.includes('PIER_SESSION_TTL_SECONDS')));
  assert.ok(issues.some((i) => i.includes('PI_HERDR_TERM_IDLE_MS')));
  assert.deepEqual(checkEnvKnobs({ PIER_GC_TICK_MS: '30000' }), []);
});

test('secret-shaped keys are redacted and never rendered verbatim', () => {
  assert.equal(isSecretLike('evidencePreservingReducer.model'), false);
  assert.equal(isSecretLike('apiKey'), true);
  assert.equal(redactValue('apiKey', 'sk-live-123'), '***');
  assert.equal(redactValue('observationPack.fullSends', 2), '2');
  assert.equal(formatValue(undefined), '(unset)');

  const resolved = [
    { knob: { plane: 'env' as const, key: 'PI_HERDR_TRACE', kind: 'string' as const, impact: 'trace file' }, value: '/tmp/t.log', source: 'env' as const },
  ];
  const report = renderReport(resolved, { generatedAt: 'now', cwd: '/w', workspaceTrusted: true });
  assert.match(report, /# pier config report/);
  assert.match(report, /## env — Runtime policy env/);
  assert.match(report, /Precedence: env > workspace \(trusted\) > user > default\./);
});

test('renderers cover the five planes and stay compact', () => {
  const resolved = [
    ...resolveConfigKnobs({ env: {}, user: { observationPack: { enabled: true } }, workspaceTrusted: false }),
    ...resolveEnvKnobs({}),
  ];
  const index = renderIndex({
    efficiency: resolved.filter((r) => r.knob.plane === 'efficiency'),
    pi: resolved.filter((r) => r.knob.plane === 'pi'),
    env: resolved.filter((r) => r.knob.plane === 'env'),
    roleSummary: '2 role(s)',
    bootSummary: 'missing',
  });
  assert.match(index[0], /5 planes/);
  assert.ok(index.length <= 8, 'index stays a short summary');
  assert.ok(index.some((l) => l.includes('OCC on / OBS on / EPR off')) || index.some((l) => l.includes('OBS on')));

  const efficiencyLines = renderPlane('efficiency', resolved.filter((r) => r.knob.plane === 'efficiency'));
  assert.ok(efficiencyLines.some((l) => l.includes('observationPack.enabled = true')));
  assert.equal(renderPlane('efficiency', []).length, 0);

  assert.deepEqual(CONFIG_PLANES.map((p) => p.id), ['efficiency', 'roles', 'pi', 'boot', 'env']);
  assert.equal(planeById('roles')?.owner, 'pier');
  assert.equal(summarizePlane([]), 'all defaults');
  assert.equal(summarizePlane([{ knob: CONFIG_KNOBS[0]!, value: 'true', source: 'env' }]), '1 set (env 1)');

  const check = renderCheck([
    { plane: 'env', ok: false, issues: ['bad value'] },
    { plane: 'pi', ok: true, issues: [] },
  ]);
  assert.ok(check.some((l) => l.includes('FAIL env')));
  assert.ok(check.some((l) => l.includes('- bad value')));
  assert.ok(check.some((l) => l.includes('ok   pi')));
});

/**
 * D104 config-guide adapter tests.
 *
 * Everything runs against temp directories and an injected env, so the developer's real
 * ~/.pi/agent and .pi-herdr are never read. Covers the precedence reporting (including the
 * untrusted-workspace case), the pi-owned read-only values, per-plane checks and rendering.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_GUIDANCE_PROMPT,
  collectConfigSnapshot,
  defaultHerdrPluginConfigDirs,
  efficiencyPointerLine,
  guideCheckLines,
  guideIndexLines,
  guidePlaneLines,
  guideReportMarkdown,
  knobValue,
  type ConfigGuideDeps,
} from '../src/config-guide.ts';

interface Fixture {
  base: string;
  deps: ConfigGuideDeps;
  paths: {
    cwd: string;
    agentDir: string;
    userConfigPath: string;
    workspaceConfigPath: string;
    herdrDir: string;
    rolesDir: string;
  };
}

async function makeFixture(opts: { brokenRole?: boolean; reservedRole?: boolean; trustWorkspace?: boolean } = {}): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), 'pier-cfg-guide-'));
  const cwd = join(base, 'repo');
  const agentDir = join(base, 'agent');
  const herdrDir = join(base, 'herdr-plugin');
  const rolesDir = join(cwd, '.pi-herdr', 'roles');
  const userConfigPath = join(base, 'user-efficiency.json');
  const workspaceConfigPath = join(cwd, '.pi-herdr', 'config.json');

  await mkdir(agentDir, { recursive: true });
  await mkdir(herdrDir, { recursive: true });
  await mkdir(rolesDir, { recursive: true });
  await mkdir(join(cwd, '.pi'), { recursive: true });

  // pi owns this file; OCC reads compaction.* only.
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 35000 } }));
  // user-level efficiency config enables OCC (but pi's compaction.enabled=false wins unless env forces it).
  await writeFile(userConfigPath, JSON.stringify({ version: 1, onlineContextCompact: { enabled: true } }));
  // workspace efficiency config enables OBS with a custom threshold.
  await writeFile(workspaceConfigPath, JSON.stringify({ version: 1, observationPack: { enabled: true, thresholdBytes: 4096 } }));
  // Real paths on disk: the boot plane verifies piNode/piCli/extPath exist.
  const bootPaths = { piNode: join(base, 'node'), piCli: join(base, 'cli.js'), extPath: join(base, 'ext.ts') };
  for (const target of Object.values(bootPaths)) await writeFile(target, '');
  await writeFile(
    join(herdrDir, 'boot-config.json'),
    JSON.stringify({ mainTabLabel: 'main', ...bootPaths }),
  );
  await writeFile(
    join(rolesDir, 'auditor.json'),
    JSON.stringify({
      role: 'auditor',
      version: '1.0.0',
      manifest: { tools: ['read', 'todo_write', 'ask_user_question'], rules: {}, unknownTools: 'allow' },
    }),
  );
  if (opts.brokenRole) await writeFile(join(rolesDir, 'broken.json'), JSON.stringify({ role: 'broken' }));
  if (opts.reservedRole) {
    await writeFile(
      join(rolesDir, 'master.json'),
      JSON.stringify({
        role: 'master',
        version: '9.9.9',
        manifest: { tools: ['todo_write', 'ask_user_question'], rules: {}, unknownTools: 'allow' },
      }),
    );
  }

  return {
    base,
    paths: { cwd, agentDir, userConfigPath, workspaceConfigPath, herdrDir, rolesDir },
    deps: {
      cwd,
      env: { HERDR_PLUGIN_CONFIG_DIR: herdrDir },
      isProjectTrusted: opts.trustWorkspace ?? true,
      agentDir,
      userConfigPath,
      herdrPluginConfigDir: herdrDir,
      repoRoot: base,
    },
  };
}

test('collectConfigSnapshot: reports effective values, sources and per-plane checks', async () => {
  const fx = await makeFixture();
  try {
    const snapshot = collectConfigSnapshot(fx.deps);

    // workspace beats default; pi-disabled compaction overrides an explicitly enabled OCC.
    assert.equal(knobValue(snapshot, 'efficiency', 'observationPack.enabled'), 'true [workspace]');
    assert.equal(knobValue(snapshot, 'efficiency', 'observationPack.thresholdBytes'), '4096 [workspace]');
    assert.equal(knobValue(snapshot, 'efficiency', 'onlineContextCompact.enabled'), 'false [user]');
    const occ = snapshot.entries.find((e) => e.knob.key === 'onlineContextCompact.enabled')!;
    assert.match(occ.note ?? '', /pi compaction\.enabled=false/);
    assert.equal(knobValue(snapshot, 'pi', 'compaction.keepRecentTokens'), '35000 [pi]');

    const byPlane = new Map(snapshot.reports.map((r) => [r.plane, r]));
    assert.equal(byPlane.get('efficiency')!.ok, true, byPlane.get('efficiency')!.issues.join(' | '));
    assert.equal(byPlane.get('boot')!.ok, true, byPlane.get('boot')!.issues.join(' | '));
    assert.equal(byPlane.get('roles')!.ok, true, byPlane.get('roles')!.issues.join(' | '));

    const bootFile = snapshot.files.boot.find((f) => f.label === 'herdr plugin config-dir')!;
    assert.equal(bootFile.exists, true);
    assert.equal(snapshot.bootSummary.includes('present'), true);
    assert.equal(snapshot.roleSummary, '3 role(s): workspace 1 / user 0 / builtin 2');

    // Rendering
    const index = guideIndexLines(snapshot);
    assert.ok(index.some((l) => l.includes('/pier-config show')));
    const efficiencyLines = guidePlaneLines(snapshot, 'efficiency');
    assert.ok(efficiencyLines.some((l) => l.includes('observationPack.enabled = true')));
    assert.ok(efficiencyLines.some((l) => l.includes(fx.paths.workspaceConfigPath) && l.includes('present')));
    assert.ok(guideCheckLines(snapshot).some((l) => l.includes('all planes look consistent')));

    const report = guideReportMarkdown(snapshot, { generatedAt: '2026-09-13T00:00:00Z', cwd: fx.paths.cwd, piVersion: 'test' });
    assert.match(report, /# pier config report/);
    assert.match(report, /## Files observed/);
    assert.match(report, new RegExp(fx.paths.herdrDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(efficiencyPointerLine(snapshot), /OCC false \/ OBS true \/ EPR false/);
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('collectConfigSnapshot: untrusted workspace is ignored and marked', async () => {
  const fx = await makeFixture({ trustWorkspace: false });
  try {
    const snapshot = collectConfigSnapshot(fx.deps);
    assert.equal(snapshot.workspaceTrusted, false);
    assert.equal(knobValue(snapshot, 'efficiency', 'observationPack.enabled'), 'false [default]', 'workspace value must not apply');
    const efficiencyReport = snapshot.reports.find((r) => r.plane === 'efficiency')!;
    assert.equal(efficiencyReport.ok, false);
    assert.ok(efficiencyReport.issues.some((i) => i.includes('not trusted')));
    const fileLines = guidePlaneLines(snapshot, 'efficiency');
    assert.ok(fileLines.some((l) => l.includes('IGNORED: untrusted project')));
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('collectConfigSnapshot: flags broken JSON, invalid roles and bad env values', async () => {
  const fx = await makeFixture({ brokenRole: true, reservedRole: true });
  try {
    await writeFile(fx.paths.workspaceConfigPath, '{ not json');
    const env = { ...fx.deps.env, PIER_GC_TICK_MS: 'abc', PI_HERDR_TERM_IDLE_MS: '0' };
    const snapshot = collectConfigSnapshot({ ...fx.deps, env });

    const efficiency = snapshot.reports.find((r) => r.plane === 'efficiency')!;
    assert.equal(efficiency.ok, false);
    assert.ok(efficiency.issues.some((i) => i.includes('invalid JSON')));

    const roles = snapshot.reports.find((r) => r.plane === 'roles')!;
    assert.equal(roles.ok, false);
    assert.ok(roles.issues.some((i) => i.includes('broken')));
    assert.ok(roles.issues.some((i) => i.includes('master')));

    const envReport = snapshot.reports.find((r) => r.plane === 'env')!;
    assert.equal(envReport.ok, false);
    assert.ok(envReport.issues.some((i) => i.includes('PIER_GC_TICK_MS')));
    assert.ok(envReport.issues.some((i) => i.includes('PI_HERDR_TERM_IDLE_MS')));

    const boot = snapshot.reports.find((r) => r.plane === 'boot')!;
    assert.equal(boot.ok, true, boot.issues.join(' | '));
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('collectConfigSnapshot: a stale boot-config path is reported as an issue', async () => {
  const fx = await makeFixture();
  try {
    await writeFile(
      join(fx.paths.herdrDir, 'boot-config.json'),
      JSON.stringify({ mainTabLabel: 'main', piNode: '/nonexistent/node', piCli: '/nonexistent/cli.js', extPath: '/nonexistent/ext.ts' }),
    );
    const snapshot = collectConfigSnapshot(fx.deps);
    const boot = snapshot.reports.find((r) => r.plane === 'boot')!;
    assert.equal(boot.ok, false);
    assert.equal(boot.issues.filter((i) => i.includes('does not exist')).length, 3);
    assert.ok(boot.issues.some((i) => i.includes('pier-setup')));
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('collectConfigSnapshot: missing boot-config and missing pi settings are reported, not thrown', async () => {
  const fx = await makeFixture();
  try {
    const snapshot = collectConfigSnapshot({
      ...fx.deps,
      env: {},
      herdrPluginConfigDir: join(fx.base, 'nope'),
      repoRoot: join(fx.base, 'nope'),
      agentDir: join(fx.base, 'nope-agent'),
    });
    assert.equal(snapshot.bootSummary, 'missing (run pier-setup)');
    const boot = snapshot.reports.find((r) => r.plane === 'boot')!;
    assert.equal(boot.ok, false);
    assert.ok(boot.issues.some((i) => i.includes('not found')));
    const pi = snapshot.reports.find((r) => r.plane === 'pi')!;
    assert.ok(pi.issues.some((i) => i.includes('not found')));
    // A missing plane must not break rendering.
    assert.ok(guidePlaneLines(snapshot, 'all').length > 5);
  } finally {
    await rm(fx.base, { recursive: true, force: true });
  }
});

test('defaultHerdrPluginConfigDirs follows XDG and LOCALAPPDATA', () => {
  const xdg = defaultHerdrPluginConfigDirs({ XDG_CONFIG_HOME: '/xdg' });
  assert.deepEqual(xdg, [join('/xdg', 'herdr', 'plugins', 'config', 'pier.workbench')]);
  const win = defaultHerdrPluginConfigDirs({ XDG_CONFIG_HOME: '/xdg', LOCALAPPDATA: '/local' });
  assert.equal(win.length, 2);
  assert.equal(win[1], join('/local', 'herdr', 'plugins', 'config', 'pier.workbench'));
  const fallback = defaultHerdrPluginConfigDirs({});
  assert.equal(fallback.length, 1);
  assert.match(fallback[0]!, /herdr[/\\]plugins[/\\]config[/\\]pier\.workbench$/);
});

test('guidance prompt stays a stable instruction block', () => {
  assert.match(CONFIG_GUIDANCE_PROMPT, /^\[PIER-CONFIG\]/);
  assert.match(CONFIG_GUIDANCE_PROMPT, /\/pier-config show all/);
  assert.match(CONFIG_GUIDANCE_PROMPT, /Forbidden: dumping `process\.env`/);
  assert.match(CONFIG_GUIDANCE_PROMPT, /Change ONE plane at a time/);
});

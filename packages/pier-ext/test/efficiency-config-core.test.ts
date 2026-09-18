/**
 * D100-D103 Efficiency Configuration Core Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadEfficiencyConfigFromDisk,
  resolveEfficiencyConfig,
  validateEfficiencyConfig,
} from '../src/efficiency-config-core.ts';
import { loadPiNativeCompactionSettings } from '../src/efficiency-config-io.ts';

test('validateEfficiencyConfig: default empty object is valid and returns defaults', () => {
  const res = validateEfficiencyConfig({});
  assert.equal(res.ok, true);
  assert.deepEqual(res.issues, []);
  assert.equal(res.config.version, 1);
  assert.equal(res.config.onlineContextCompact.enabled, false);
  assert.equal(res.config.onlineContextCompact.cacheWriteReadRatio, 'auto');
  assert.equal(res.config.observationPack.enabled, false);
  assert.equal(res.config.evidencePreservingReducer.enabled, false);
});

test('validateEfficiencyConfig: non-object returns error', () => {
  const res = validateEfficiencyConfig('not an object');
  assert.equal(res.ok, false);
  assert.match(res.issues[0]!, /必须是 JSON 对象/);
});

test('validateEfficiencyConfig: rejects unknown top-level and section keys', () => {
  const res = validateEfficiencyConfig({
    version: 1,
    foo: 'bar',
    onlineContextCompact: {
      enabled: true,
      unknownKey: 123,
    },
    observationPack: {
      extra: true,
    },
    evidencePreservingReducer: {
      badProp: 'hello',
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.issues.some((i) => i.includes('未知顶层配置项: "foo"')), true);
  assert.equal(res.issues.some((i) => i.includes('onlineContextCompact 未知配置项: "unknownKey"')), true);
  assert.equal(res.issues.some((i) => i.includes('observationPack 未知配置项: "extra"')), true);
  assert.equal(res.issues.some((i) => i.includes('evidencePreservingReducer 未知配置项: "badProp"')), true);
});

test('validateEfficiencyConfig: valid customized configuration passes', () => {
  const res = validateEfficiencyConfig({
    version: 1,
    onlineContextCompact: {
      enabled: true,
      logEnabled: true,
      cacheWriteReadRatio: 12.5,
      firstCompactionRequestScale: 2.5,
      subsequentCompactionMargin: 1.8,
    },
    observationPack: {
      enabled: true,
      logEnabled: true,
      thresholdBytes: 20480,
      fullSends: 3,
      recallChunkBytes: 32768,
      excerptBytes: 512,
    },
    evidencePreservingReducer: {
      enabled: true,
      logEnabled: true,
      model: 'cliproxy/gemini-3.8-flash-high',
      minBytes: 8192,
      maxChars: 500000,
      maxOutputTokens: 1024,
      timeoutMs: 4000,
      localOnly: true,
    },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.issues, []);
  assert.equal(res.config.onlineContextCompact.enabled, true);
  assert.equal(res.config.onlineContextCompact.cacheWriteReadRatio, 12.5);
  assert.equal(res.config.observationPack.thresholdBytes, 20480);
  assert.equal(res.config.evidencePreservingReducer.model, 'cliproxy/gemini-3.8-flash-high');
  assert.equal(res.config.evidencePreservingReducer.localOnly, true);
});

test('validateEfficiencyConfig: detects invalid types and bounds', () => {
  const res = validateEfficiencyConfig({
    version: 2,
    onlineContextCompact: {
      enabled: 'true' as any,
      cacheWriteReadRatio: -5,
      firstCompactionRequestScale: 0.5,
    },
    observationPack: {
      thresholdBytes: 100, // < 1024
      fullSends: 0,
    },
    evidencePreservingReducer: {
      minBytes: 100, // < 512
      timeoutMs: 200, // < 500
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.issues.some((i) => i.includes('version 必须是 1')), true);
  assert.equal(res.issues.some((i) => i.includes('cacheWriteReadRatio 必须是 "auto" 或非负有限数')), true);
  assert.equal(res.issues.some((i) => i.includes('firstCompactionRequestScale 必须是 >= 1.0 的数字')), true);
  assert.equal(res.issues.some((i) => i.includes('thresholdBytes 必须是 >= 1024 的整数')), true);
  assert.equal(res.issues.some((i) => i.includes('fullSends 必须是 >= 1 的整数')), true);
  assert.equal(res.issues.some((i) => i.includes('minBytes 必须是 >= 512 的整数')), true);
  assert.equal(res.issues.some((i) => i.includes('timeoutMs 必须是 >= 500 的整数')), true);
});

test('resolveEfficiencyConfig: workspace config replaces user config if trusted', () => {
  const userConfig = {
    version: 1,
    onlineContextCompact: { enabled: true, cacheWriteReadRatio: 10 },
  };
  const workspaceConfig = {
    version: 1,
    onlineContextCompact: { enabled: false },
  };

  const resolved = resolveEfficiencyConfig({
    userConfig,
    workspaceConfig,
    isProjectTrusted: true,
    env: {},
  });
  assert.equal(resolved.onlineContextCompact.enabled, false);
});

test('resolveEfficiencyConfig: workspace config is ignored if project is untrusted', () => {
  const warnings: string[] = [];
  const userConfig = {
    version: 1,
    onlineContextCompact: { enabled: true },
  };
  const workspaceConfig = {
    version: 1,
    onlineContextCompact: { enabled: false },
    evidencePreservingReducer: { enabled: true, model: 'malicious/model' },
  };

  const resolved = resolveEfficiencyConfig({
    userConfig,
    workspaceConfig,
    isProjectTrusted: false,
    env: {},
    onWarning: (w) => warnings.push(w),
  });

  assert.equal(resolved.onlineContextCompact.enabled, true);
  assert.equal(resolved.evidencePreservingReducer.enabled, false);
  assert.equal(warnings.some((w) => w.includes('未被信任')), true);
});

test('resolveEfficiencyConfig: environment variables override file configs', () => {
  const env = {
    PI_HERDR_COMPACT_ENABLE: '1',
    PI_HERDR_COMPACT_LOG: 'true',
    PI_HERDR_CACHE_RATIO: '15.5',
    PI_HERDR_OBS_PACK_ENABLE: '1',
    PI_HERDR_OBS_PACK_LOG: '1',
    PI_HERDR_REDUCER_ENABLE: '1',
    PI_HERDR_REDUCER_LOG: '1',
    PI_HERDR_REDUCER_MODEL: 'custom/fast-model',
  };

  const resolved = resolveEfficiencyConfig({
    userConfig: { version: 1 },
    env,
  });

  assert.equal(resolved.onlineContextCompact.enabled, true);
  assert.equal(resolved.onlineContextCompact.logEnabled, true);
  assert.equal(resolved.onlineContextCompact.cacheWriteReadRatio, 15.5);
  assert.equal(resolved.observationPack.enabled, true);
  assert.equal(resolved.observationPack.logEnabled, true);
  assert.equal(resolved.evidencePreservingReducer.enabled, true);
  assert.equal(resolved.evidencePreservingReducer.logEnabled, true);
  assert.equal(resolved.evidencePreservingReducer.model, 'custom/fast-model');
});

test('resolveEfficiencyConfig: env ratio "auto" supported', () => {
  const resolved = resolveEfficiencyConfig({
    env: { PI_HERDR_CACHE_RATIO: 'auto' },
  });
  assert.equal(resolved.onlineContextCompact.cacheWriteReadRatio, 'auto');
});

test('validateEfficiencyConfig: section validation issues force enabled=false (P1-5 fail-open)', () => {
  const res = validateEfficiencyConfig({
    version: 1,
    observationPack: {
      enabled: true,
      thresholBytes: 1024, // typo!
    },
    evidencePreservingReducer: {
      enabled: true,
      timeoutMs: 100, // invalid bound < 500
    },
  });

  assert.equal(res.ok, false);
  // Flawed sections must be forced to enabled = false
  assert.equal(res.config.observationPack.enabled, false);
  assert.equal(res.config.evidencePreservingReducer.enabled, false);
});

test('loadPiNativeCompactionSettings: loads without crashing when paths do not exist', () => {
  const settings = loadPiNativeCompactionSettings({
    cwd: '/tmp/nonexistent-pier-test-dir',
    isProjectTrusted: false,
    agentDir: '/tmp/nonexistent-pier-agent-dir',
  });
  assert.equal(typeof settings, 'object');
  assert.equal(settings.enabled, undefined);
  assert.equal(settings.keepRecentTokens, undefined);
});

test('loadPiNativeCompactionSettings: reads agentDir settings and gates the project file on trust', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-pi-settings-unit-'));
  try {
    const agentDir = join(tempDir, 'agent');
    const projectDir = join(tempDir, 'project');
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(projectDir, '.pi'), { recursive: true });
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 35000 } }));
    await writeFile(join(projectDir, '.pi', 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 99999 } }));

    const trusted = loadPiNativeCompactionSettings({ cwd: projectDir, isProjectTrusted: true, agentDir });
    assert.equal(trusted.enabled, false);
    assert.equal(trusted.keepRecentTokens, 99999, 'project settings win when the project is trusted');

    const untrusted = loadPiNativeCompactionSettings({ cwd: projectDir, isProjectTrusted: false, agentDir });
    assert.equal(untrusted.keepRecentTokens, 35000, 'untrusted project settings are ignored');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('loadEfficiencyConfigFromDisk: respects Pi native compaction settings and inheritance (A4)', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'pier-pi-settings-test-'));
  try {
    const agentDir = join(tempDir, 'agent');
    const projectDir = join(tempDir, 'project');
    // Isolated user-level efficiency config (never the developer's real ~/.pi/agent/herdr-pi/config.json).
    const userConfigPath = join(tempDir, 'user-efficiency-config.json');
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(projectDir, '.pi-herdr'), { recursive: true });
    await mkdir(join(projectDir, '.pi'), { recursive: true });

    // Pi native global settings disable compaction and set a custom window.
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 35000 } }));

    // Efficiency config explicitly ENABLES OCC — so the assertion below is non-vacuous.
    await writeFile(
      join(projectDir, '.pi-herdr', 'config.json'),
      JSON.stringify({ version: 1, onlineContextCompact: { enabled: true } }),
    );

    const config1 = loadEfficiencyConfigFromDisk({
      cwd: projectDir,
      isProjectTrusted: true,
      agentDir,
      userConfigPath,
      env: {}, // no env override
    });
    assert.equal(config1.onlineContextCompact.enabled, false, 'pi compaction.enabled=false disables an explicitly enabled OCC');
    assert.equal(config1.onlineContextCompact.keepRecentTokens, 35000, 'inherits pi keepRecentTokens');

    // Environment explicitly forcing OCC enable wins over pi's disabled state.
    const config2 = loadEfficiencyConfigFromDisk({
      cwd: projectDir,
      isProjectTrusted: true,
      agentDir,
      userConfigPath,
      env: { PI_HERDR_COMPACT_ENABLE: '1' },
    });
    assert.equal(config2.onlineContextCompact.enabled, true);

    // Explicit efficiency keepRecentTokens wins over pi's inherited value.
    await writeFile(
      join(projectDir, '.pi-herdr', 'config.json'),
      JSON.stringify({ version: 1, onlineContextCompact: { enabled: true, keepRecentTokens: 12345 } }),
    );
    const config3 = loadEfficiencyConfigFromDisk({
      cwd: projectDir,
      isProjectTrusted: true,
      agentDir,
      userConfigPath,
      env: { PI_HERDR_COMPACT_ENABLE: '1' },
    });
    assert.equal(config3.onlineContextCompact.keepRecentTokens, 12345);

    // Untrusted project .pi/settings.json is ignored (global 35000 wins).
    await writeFile(join(projectDir, '.pi', 'settings.json'), JSON.stringify({ compaction: { keepRecentTokens: 99999 } }));
    const config4 = loadEfficiencyConfigFromDisk({
      cwd: projectDir,
      isProjectTrusted: false, // untrusted!
      agentDir,
      userConfigPath,
      env: { PI_HERDR_COMPACT_ENABLE: '1' },
    });
    assert.equal(config4.onlineContextCompact.keepRecentTokens, 35000);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// jev 决策层段（RFC docs/rfc-jev-integration.md §6）
// ---------------------------------------------------------------------------

test('validateEfficiencyConfig: jev 段校验与 fail-open', () => {
  const bad = validateEfficiencyConfig({ version: 1, jev: { enabled: true, timeoutMs: 100 } });
  assert.equal(bad.ok, false);
  assert.equal(bad.config.jev.enabled, false, 'section issues force enabled=false');
  assert.ok(bad.issues.some((i) => i.includes('jev.timeoutMs')));
  assert.ok(validateEfficiencyConfig({ version: 1, jev: { unknownKey: 1 } }).issues.some((i) => i.includes('jev 未知配置项')));

  const good = validateEfficiencyConfig({ version: 1, jev: { enabled: true, apiKey: ' k ', minConfidence: 0.75 } });
  assert.equal(good.ok, true);
  assert.equal(good.config.jev.apiKey, 'k', 'key is trimmed');
  assert.equal(good.config.jev.minConfidence, 0.75);
  assert.equal(good.config.jev.model, 'jev-1.13.0', 'pinned versioned id');
});

test('resolveEfficiencyConfig: PIER_JEV_* env 覆盖 > 配置 apiKey > TYPESAFE_API_KEY 兜底', () => {
  const byEnv = resolveEfficiencyConfig({
    env: {
      PIER_JEV_ENABLE: '1',
      PIER_JEV_MODEL: 'jev-1.13.1',
      PIER_JEV_TIMEOUT_MS: '1500',
      PIER_JEV_MIN_CONFIDENCE: '0.8',
      PIER_JEV_API_KEY: 'pk',
    },
  });
  assert.equal(byEnv.jev.enabled, true);
  assert.equal(byEnv.jev.model, 'jev-1.13.1');
  assert.equal(byEnv.jev.timeoutMs, 1500);
  assert.equal(byEnv.jev.minConfidence, 0.8);
  assert.equal(byEnv.jev.apiKey, 'pk');

  const byForeignEnv = resolveEfficiencyConfig({ env: { PIER_JEV_ENABLE: '1', TYPESAFE_API_KEY: 'fk' } });
  assert.equal(byForeignEnv.jev.apiKey, 'fk', 'SDK-convention env fills a missing key');

  const byConfig = resolveEfficiencyConfig({ userConfig: { jev: { apiKey: 'ck' } }, env: {} });
  assert.equal(byConfig.jev.apiKey, 'ck');
  assert.equal(byConfig.jev.enabled, false, 'key alone does not enable the layer');

  const none = resolveEfficiencyConfig({ env: {} });
  assert.equal(none.jev.apiKey, undefined);
  assert.equal(none.jev.enabled, false);

  const badEnv = resolveEfficiencyConfig({ env: { PIER_JEV_TIMEOUT_MS: '100' } });
  assert.equal(badEnv.jev.timeoutMs, 2000, 'invalid env falls back to default');
});


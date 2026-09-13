/**
 * D100-D103 Efficiency Configuration Core Tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EFFICIENCY_CONFIG,
  resolveEfficiencyConfig,
  validateEfficiencyConfig,
} from '../src/efficiency-config-core.ts';

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


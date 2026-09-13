/**
 * D100-D103 Efficiency Configuration Core.
 *
 * Provides zero-dependency parsing, validation, and multi-tier resolution
 * for pier efficiency mechanisms (OCC, ObservationPack, EPR).
 *
 * Contract:
 *  - Unknown keys rejected to catch typos; all issues collected in one pass.
 *  - Project-level configuration requires `isProjectTrusted: true` (security boundary).
 *  - Workspace config shallow-replaces user config.
 *  - Fail-open: configuration parse/validation errors disable the affected mechanism
 *    and emit a single-line warning, never crashing normal agent sessions.
 *  - Environment variables (PI_HERDR_*) take highest precedence.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface OnlineContextCompactConfig {
  enabled: boolean;
  logEnabled: boolean;
  cacheWriteReadRatio: number | 'auto';
  keepRecentTokens?: number;
  firstCompactionRequestScale: number;
  subsequentCompactionMargin: number;
}

export interface ObservationPackConfig {
  enabled: boolean;
  logEnabled: boolean;
  thresholdBytes: number;
  fullSends: number;
  recallChunkBytes: number;
  excerptBytes: number;
}

export interface EvidencePreservingReducerConfig {
  enabled: boolean;
  logEnabled: boolean;
  model?: string;
  minBytes: number;
  maxChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
  localOnly: boolean;
}

export interface EfficiencyConfig {
  version: 1;
  onlineContextCompact: OnlineContextCompactConfig;
  observationPack: ObservationPackConfig;
  evidencePreservingReducer: EvidencePreservingReducerConfig;
}

export const DEFAULT_EFFICIENCY_CONFIG: EfficiencyConfig = Object.freeze({
  version: 1,
  onlineContextCompact: Object.freeze({
    enabled: false,
    logEnabled: false,
    cacheWriteReadRatio: 'auto',
    keepRecentTokens: 20000,
    firstCompactionRequestScale: 2.0,
    subsequentCompactionMargin: 1.5,
  }),
  observationPack: Object.freeze({
    enabled: false,
    logEnabled: false,
    thresholdBytes: 10240,
    fullSends: 2,
    recallChunkBytes: 16384,
    excerptBytes: 1024,
  }),
  evidencePreservingReducer: Object.freeze({
    enabled: false,
    logEnabled: false,
    minBytes: 4096,
    maxChars: 600000,
    maxOutputTokens: 2048,
    timeoutMs: 5000,
    localOnly: false,
  }),
});

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const TOP_LEVEL_KEYS = new Set([
  'version',
  'onlineContextCompact',
  'observationPack',
  'evidencePreservingReducer',
]);

const OCC_KEYS = new Set([
  'enabled',
  'logEnabled',
  'cacheWriteReadRatio',
  'keepRecentTokens',
  'firstCompactionRequestScale',
  'subsequentCompactionMargin',
]);

const OBS_KEYS = new Set([
  'enabled',
  'logEnabled',
  'thresholdBytes',
  'fullSends',
  'recallChunkBytes',
  'excerptBytes',
]);

const EPR_KEYS = new Set([
  'enabled',
  'logEnabled',
  'model',
  'minBytes',
  'maxChars',
  'maxOutputTokens',
  'timeoutMs',
  'localOnly',
]);

export interface ValidateConfigResult {
  ok: boolean;
  config: EfficiencyConfig;
  issues: string[];
}

export function validateEfficiencyConfig(raw: unknown): ValidateConfigResult {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      config: {
        version: 1,
        onlineContextCompact: { ...DEFAULT_EFFICIENCY_CONFIG.onlineContextCompact, enabled: false },
        observationPack: { ...DEFAULT_EFFICIENCY_CONFIG.observationPack, enabled: false },
        evidencePreservingReducer: { ...DEFAULT_EFFICIENCY_CONFIG.evidencePreservingReducer, enabled: false },
      },
      issues: ['efficiency config 必须是 JSON 对象'],
    };
  }

  const topIssues: string[] = [];
  const occIssues: string[] = [];
  const obsIssues: string[] = [];
  const eprIssues: string[] = [];

  for (const k of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(k)) {
      topIssues.push(`未知顶层配置项: "${k}"`);
    }
  }

  if (raw.version !== undefined && raw.version !== 1) {
    topIssues.push(`version 必须是 1 (当前: ${JSON.stringify(raw.version)})`);
  }

  // Section 1: onlineContextCompact
  let occ: OnlineContextCompactConfig = { ...DEFAULT_EFFICIENCY_CONFIG.onlineContextCompact };
  if (raw.onlineContextCompact !== undefined) {
    if (!isPlainObject(raw.onlineContextCompact)) {
      occIssues.push('onlineContextCompact 必须是 JSON 对象');
    } else {
      const o = raw.onlineContextCompact;
      for (const k of Object.keys(o)) {
        if (!OCC_KEYS.has(k)) occIssues.push(`onlineContextCompact 未知配置项: "${k}"`);
      }
      if (o.enabled !== undefined) {
        if (typeof o.enabled !== 'boolean') occIssues.push('onlineContextCompact.enabled 必须是 boolean');
        else occ.enabled = o.enabled;
      }
      if (o.logEnabled !== undefined) {
        if (typeof o.logEnabled !== 'boolean') occIssues.push('onlineContextCompact.logEnabled 必须是 boolean');
        else occ.logEnabled = o.logEnabled;
      }
      if (o.cacheWriteReadRatio !== undefined) {
        if (o.cacheWriteReadRatio === 'auto') {
          occ.cacheWriteReadRatio = 'auto';
        } else if (typeof o.cacheWriteReadRatio === 'number' && Number.isFinite(o.cacheWriteReadRatio) && o.cacheWriteReadRatio >= 0) {
          occ.cacheWriteReadRatio = o.cacheWriteReadRatio;
        } else {
          occIssues.push('onlineContextCompact.cacheWriteReadRatio 必须是 "auto" 或非负有限数');
        }
      }
      if (o.keepRecentTokens !== undefined) {
        if (typeof o.keepRecentTokens === 'number' && Number.isInteger(o.keepRecentTokens) && o.keepRecentTokens >= 1000) {
          occ.keepRecentTokens = o.keepRecentTokens;
        } else {
          occIssues.push('onlineContextCompact.keepRecentTokens 必须是 >= 1000 的整数');
        }
      }
      if (o.firstCompactionRequestScale !== undefined) {
        if (typeof o.firstCompactionRequestScale === 'number' && Number.isFinite(o.firstCompactionRequestScale) && o.firstCompactionRequestScale >= 1.0) {
          occ.firstCompactionRequestScale = o.firstCompactionRequestScale;
        } else {
          occIssues.push('onlineContextCompact.firstCompactionRequestScale 必须是 >= 1.0 的数字');
        }
      }
      if (o.subsequentCompactionMargin !== undefined) {
        if (typeof o.subsequentCompactionMargin === 'number' && Number.isFinite(o.subsequentCompactionMargin) && o.subsequentCompactionMargin >= 1.0) {
          occ.subsequentCompactionMargin = o.subsequentCompactionMargin;
        } else {
          occIssues.push('onlineContextCompact.subsequentCompactionMargin 必须是 >= 1.0 的数字');
        }
      }
    }
  }

  // Section 2: observationPack
  let obs: ObservationPackConfig = { ...DEFAULT_EFFICIENCY_CONFIG.observationPack };
  if (raw.observationPack !== undefined) {
    if (!isPlainObject(raw.observationPack)) {
      obsIssues.push('observationPack 必须是 JSON 对象');
    } else {
      const o = raw.observationPack;
      for (const k of Object.keys(o)) {
        if (!OBS_KEYS.has(k)) obsIssues.push(`observationPack 未知配置项: "${k}"`);
      }
      if (o.enabled !== undefined) {
        if (typeof o.enabled !== 'boolean') obsIssues.push('observationPack.enabled 必须是 boolean');
        else obs.enabled = o.enabled;
      }
      if (o.logEnabled !== undefined) {
        if (typeof o.logEnabled !== 'boolean') obsIssues.push('observationPack.logEnabled 必须是 boolean');
        else obs.logEnabled = o.logEnabled;
      }
      if (o.thresholdBytes !== undefined) {
        if (typeof o.thresholdBytes === 'number' && Number.isInteger(o.thresholdBytes) && o.thresholdBytes >= 1024) {
          obs.thresholdBytes = o.thresholdBytes;
        } else {
          obsIssues.push('observationPack.thresholdBytes 必须是 >= 1024 的整数');
        }
      }
      if (o.fullSends !== undefined) {
        if (typeof o.fullSends === 'number' && Number.isInteger(o.fullSends) && o.fullSends >= 1) {
          obs.fullSends = o.fullSends;
        } else {
          obsIssues.push('observationPack.fullSends 必须是 >= 1 的整数');
        }
      }
      if (o.recallChunkBytes !== undefined) {
        if (typeof o.recallChunkBytes === 'number' && Number.isInteger(o.recallChunkBytes) && o.recallChunkBytes >= 1024) {
          obs.recallChunkBytes = o.recallChunkBytes;
        } else {
          obsIssues.push('observationPack.recallChunkBytes 必须是 >= 1024 的整数');
        }
      }
      if (o.excerptBytes !== undefined) {
        if (typeof o.excerptBytes === 'number' && Number.isInteger(o.excerptBytes) && o.excerptBytes >= 128) {
          obs.excerptBytes = o.excerptBytes;
        } else {
          obsIssues.push('observationPack.excerptBytes 必须是 >= 128 的整数');
        }
      }
    }
  }

  // Section 3: evidencePreservingReducer
  let epr: EvidencePreservingReducerConfig = { ...DEFAULT_EFFICIENCY_CONFIG.evidencePreservingReducer };
  if (raw.evidencePreservingReducer !== undefined) {
    if (!isPlainObject(raw.evidencePreservingReducer)) {
      eprIssues.push('evidencePreservingReducer 必须是 JSON 对象');
    } else {
      const o = raw.evidencePreservingReducer;
      for (const k of Object.keys(o)) {
        if (!EPR_KEYS.has(k)) eprIssues.push(`evidencePreservingReducer 未知配置项: "${k}"`);
      }
      if (o.enabled !== undefined) {
        if (typeof o.enabled !== 'boolean') eprIssues.push('evidencePreservingReducer.enabled 必须是 boolean');
        else epr.enabled = o.enabled;
      }
      if (o.logEnabled !== undefined) {
        if (typeof o.logEnabled !== 'boolean') eprIssues.push('evidencePreservingReducer.logEnabled 必须是 boolean');
        else epr.logEnabled = o.logEnabled;
      }
      if (o.model !== undefined) {
        if (typeof o.model === 'string' && o.model.trim()) {
          epr.model = o.model.trim();
        } else if (o.model === '' || o.model === null) {
          epr.model = undefined;
        } else {
          eprIssues.push('evidencePreservingReducer.model 必须是非空字符串');
        }
      }
      if (o.minBytes !== undefined) {
        if (typeof o.minBytes === 'number' && Number.isInteger(o.minBytes) && o.minBytes >= 512) {
          epr.minBytes = o.minBytes;
        } else {
          eprIssues.push('evidencePreservingReducer.minBytes 必须是 >= 512 的整数');
        }
      }
      if (o.maxChars !== undefined) {
        if (typeof o.maxChars === 'number' && Number.isInteger(o.maxChars) && o.maxChars >= 1000) {
          epr.maxChars = o.maxChars;
        } else {
          eprIssues.push('evidencePreservingReducer.maxChars 必须是 >= 1000 的整数');
        }
      }
      if (o.maxOutputTokens !== undefined) {
        if (typeof o.maxOutputTokens === 'number' && Number.isInteger(o.maxOutputTokens) && o.maxOutputTokens >= 128) {
          epr.maxOutputTokens = o.maxOutputTokens;
        } else {
          eprIssues.push('evidencePreservingReducer.maxOutputTokens 必须是 >= 128 的整数');
        }
      }
      if (o.timeoutMs !== undefined) {
        if (typeof o.timeoutMs === 'number' && Number.isInteger(o.timeoutMs) && o.timeoutMs >= 500) {
          epr.timeoutMs = o.timeoutMs;
        } else {
          eprIssues.push('evidencePreservingReducer.timeoutMs 必须是 >= 500 的整数');
        }
      }
      if (o.localOnly !== undefined) {
        if (typeof o.localOnly !== 'boolean') eprIssues.push('evidencePreservingReducer.localOnly 必须是 boolean');
        else epr.localOnly = o.localOnly;
      }
    }
  }

  // Fail-open: any section with validation issues has its enabled flag forced to false
  if (topIssues.length > 0) {
    occ.enabled = false;
    obs.enabled = false;
    epr.enabled = false;
  }
  if (occIssues.length > 0) {
    occ.enabled = false;
  }
  if (obsIssues.length > 0) {
    obs.enabled = false;
  }
  if (eprIssues.length > 0) {
    epr.enabled = false;
  }

  const issues = [...topIssues, ...occIssues, ...obsIssues, ...eprIssues];

  return {
    ok: issues.length === 0,
    config: {
      version: 1,
      onlineContextCompact: occ,
      observationPack: obs,
      evidencePreservingReducer: epr,
    },
    issues,
  };
}

function parseEnvBool(val: string | undefined): boolean | undefined {
  if (!val) return undefined;
  const s = val.trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'off') return false;
  return undefined;
}

export interface ResolveConfigOptions {
  workspaceConfig?: unknown;
  userConfig?: unknown;
  env?: Record<string, string | undefined>;
  isProjectTrusted?: boolean;
  onWarning?: (message: string) => void;
}

export function resolveEfficiencyConfig(opts: ResolveConfigOptions = {}): EfficiencyConfig {
  const env = opts.env ?? process.env;
  const warn = opts.onWarning ?? ((msg) => console.warn(`[pi-herdr] efficiency config warning: ${msg}`));
  const isTrusted = opts.isProjectTrusted ?? false;

  let baseRaw: unknown = undefined;

  if (opts.workspaceConfig !== undefined) {
    if (isTrusted) {
      baseRaw = opts.workspaceConfig;
    } else {
      warn('工作区能效配置未被信任（isProjectTrusted=false），已安全忽略工作区配置');
      baseRaw = opts.userConfig;
    }
  } else {
    baseRaw = opts.userConfig;
  }

  let resolved: EfficiencyConfig;
  if (baseRaw !== undefined) {
    const validated = validateEfficiencyConfig(baseRaw);
    if (!validated.ok) {
      warn(`配置存在校验问题，已安全回退默认值: ${validated.issues.join('; ')}`);
    }
    resolved = validated.config;
  } else {
    resolved = {
      version: 1,
      onlineContextCompact: { ...DEFAULT_EFFICIENCY_CONFIG.onlineContextCompact },
      observationPack: { ...DEFAULT_EFFICIENCY_CONFIG.observationPack },
      evidencePreservingReducer: { ...DEFAULT_EFFICIENCY_CONFIG.evidencePreservingReducer },
    };
  }

  // Apply environment variable overrides (highest precedence)
  const occEnabled = parseEnvBool(env.PI_HERDR_COMPACT_ENABLE);
  if (occEnabled !== undefined) resolved.onlineContextCompact.enabled = occEnabled;

  const occLog = parseEnvBool(env.PI_HERDR_COMPACT_LOG);
  if (occLog !== undefined) resolved.onlineContextCompact.logEnabled = occLog;

  const cacheRatioRaw = env.PI_HERDR_CACHE_RATIO;
  if (cacheRatioRaw !== undefined) {
    if (cacheRatioRaw.trim().toLowerCase() === 'auto') {
      resolved.onlineContextCompact.cacheWriteReadRatio = 'auto';
    } else {
      const num = Number(cacheRatioRaw);
      if (Number.isFinite(num) && num >= 0) {
        resolved.onlineContextCompact.cacheWriteReadRatio = num;
      } else {
        warn(`无效环境变量 PI_HERDR_CACHE_RATIO="${cacheRatioRaw}"，忽略`);
      }
    }
  }

  const obsEnabled = parseEnvBool(env.PI_HERDR_OBS_PACK_ENABLE);
  if (obsEnabled !== undefined) resolved.observationPack.enabled = obsEnabled;

  const obsLog = parseEnvBool(env.PI_HERDR_OBS_PACK_LOG);
  if (obsLog !== undefined) resolved.observationPack.logEnabled = obsLog;

  const redEnabled = parseEnvBool(env.PI_HERDR_REDUCER_ENABLE);
  if (redEnabled !== undefined) resolved.evidencePreservingReducer.enabled = redEnabled;

  const redLog = parseEnvBool(env.PI_HERDR_REDUCER_LOG);
  if (redLog !== undefined) resolved.evidencePreservingReducer.logEnabled = redLog;

  const redModel = env.PI_HERDR_REDUCER_MODEL;
  if (redModel !== undefined && redModel.trim()) {
    resolved.evidencePreservingReducer.model = redModel.trim();
  }

  return resolved;
}

export function defaultUserEfficiencyConfigDir(): string {
  return join(homedir(), '.pi', 'agent', 'herdr-pi');
}

export function defaultWorkspaceEfficiencyConfigFile(cwd: string): string {
  return join(cwd, '.pi-herdr', 'config.json');
}

export function defaultUserEfficiencyConfigFile(): string {
  return join(defaultUserEfficiencyConfigDir(), 'config.json');
}

export function loadEfficiencyConfigFromDisk(opts: {
  cwd?: string;
  isProjectTrusted?: boolean;
  env?: Record<string, string | undefined>;
  onWarning?: (msg: string) => void;
} = {}): EfficiencyConfig {
  const cwd = opts.cwd ?? process.cwd();
  const wsPath = defaultWorkspaceEfficiencyConfigFile(cwd);
  const userPath = defaultUserEfficiencyConfigFile();

  let workspaceConfig: unknown = undefined;
  if (existsSync(wsPath)) {
    try {
      workspaceConfig = JSON.parse(readFileSync(wsPath, 'utf8'));
    } catch (err) {
      opts.onWarning?.(`无法解析工作区能效配置文件 ${wsPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let userConfig: unknown = undefined;
  if (existsSync(userPath)) {
    try {
      userConfig = JSON.parse(readFileSync(userPath, 'utf8'));
    } catch (err) {
      opts.onWarning?.(`无法解析用户能效配置文件 ${userPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return resolveEfficiencyConfig({
    workspaceConfig,
    userConfig,
    isProjectTrusted: opts.isProjectTrusted,
    env: opts.env,
    onWarning: opts.onWarning,
  });
}


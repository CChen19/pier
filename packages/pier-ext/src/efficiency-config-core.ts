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

import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadPiNativeCompactionSettings, readJsonConfig } from './efficiency-config-io.ts';

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

/**
 * Jev decision layer (RFC docs/rfc-jev-integration.md). Optional System One
 * classification calls that upgrade hand-written heuristics; every call site
 * fails open to the existing heuristic on any error, timeout, or low confidence.
 */
export interface JevConfig {
  enabled: boolean;
  logEnabled: boolean;
  /** API root override (relay/gateway); default https://api.typesafe.ai. */
  baseUrl?: string;
  /** Pinned versioned model id — aliases (jev-latest) move silently and would skew tuned thresholds. */
  model: string;
  /** Total per-call budget in ms (AbortController hard kill; the SDK has no total-budget mode). */
  timeoutMs: number;
  /** Minimum Choice/Score confidence to accept an answer; below = treat the question as unanswered. */
  minConfidence: number;
  /** Resolution: PIER_JEV_API_KEY env > this value > TYPESAFE_API_KEY env (SDK convention). */
  apiKey?: string;
}

export interface EfficiencyConfig {
  version: 1;
  onlineContextCompact: OnlineContextCompactConfig;
  observationPack: ObservationPackConfig;
  evidencePreservingReducer: EvidencePreservingReducerConfig;
  jev: JevConfig;
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
  jev: Object.freeze({
    enabled: false,
    logEnabled: false,
    model: 'jev-1.13.0',
    timeoutMs: 2000,
    minConfidence: 0.6,
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
  'jev',
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

const JEV_KEYS: Record<string, true> = {
  enabled: true,
  logEnabled: true,
  baseUrl: true,
  model: true,
  timeoutMs: true,
  minConfidence: true,
  apiKey: true,
};

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
        jev: { ...DEFAULT_EFFICIENCY_CONFIG.jev, enabled: false },
      },
      issues: ['efficiency config 必须是 JSON 对象'],
    };
  }

  const topIssues: string[] = [];
  const occIssues: string[] = [];
  const obsIssues: string[] = [];
  const eprIssues: string[] = [];
  const jevIssues: string[] = [];

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

  // Section 4: jev decision layer
  let jev: JevConfig = { ...DEFAULT_EFFICIENCY_CONFIG.jev };
  if (raw.jev !== undefined) {
    if (!isPlainObject(raw.jev)) {
      jevIssues.push('jev 必须是 JSON 对象');
    } else {
      const o = raw.jev;
      for (const k of Object.keys(o)) {
        if (JEV_KEYS[k] !== true) jevIssues.push(`jev 未知配置项: "${k}"`);
      }
      if (o.enabled !== undefined) {
        if (typeof o.enabled !== 'boolean') jevIssues.push('jev.enabled 必须是 boolean');
        else jev.enabled = o.enabled;
      }
      if (o.logEnabled !== undefined) {
        if (typeof o.logEnabled !== 'boolean') jevIssues.push('jev.logEnabled 必须是 boolean');
        else jev.logEnabled = o.logEnabled;
      }
      if (o.baseUrl !== undefined) {
        if (typeof o.baseUrl === 'string' && o.baseUrl.trim()) {
          jev.baseUrl = o.baseUrl.trim();
        } else if (o.baseUrl === '' || o.baseUrl === null) {
          jev.baseUrl = undefined;
        } else {
          jevIssues.push('jev.baseUrl 必须是非空字符串');
        }
      }
      if (o.model !== undefined) {
        if (typeof o.model === 'string' && o.model.trim()) {
          jev.model = o.model.trim();
        } else {
          jevIssues.push('jev.model 必须是非空字符串');
        }
      }
      if (o.timeoutMs !== undefined) {
        if (typeof o.timeoutMs === 'number' && Number.isInteger(o.timeoutMs) && o.timeoutMs >= 500) {
          jev.timeoutMs = o.timeoutMs;
        } else {
          jevIssues.push('jev.timeoutMs 必须是 >= 500 的整数');
        }
      }
      if (o.minConfidence !== undefined) {
        if (typeof o.minConfidence === 'number' && Number.isFinite(o.minConfidence) && o.minConfidence >= 0 && o.minConfidence <= 1) {
          jev.minConfidence = o.minConfidence;
        } else {
          jevIssues.push('jev.minConfidence 必须是 0 到 1 之间的数字');
        }
      }
      if (o.apiKey !== undefined) {
        if (typeof o.apiKey === 'string' && o.apiKey.trim()) {
          jev.apiKey = o.apiKey.trim();
        } else if (o.apiKey === '' || o.apiKey === null) {
          jev.apiKey = undefined;
        } else {
          jevIssues.push('jev.apiKey 必须是非空字符串');
        }
      }
    }
  }

  // Fail-open: any section with validation issues has its enabled flag forced to false
  if (topIssues.length > 0) {
    occ.enabled = false;
    obs.enabled = false;
    epr.enabled = false;
    jev.enabled = false;
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
  if (jevIssues.length > 0) {
    jev.enabled = false;
  }

  const issues = [...topIssues, ...occIssues, ...obsIssues, ...eprIssues, ...jevIssues];

  return {
    ok: issues.length === 0,
    config: {
      version: 1,
      onlineContextCompact: occ,
      observationPack: obs,
      evidencePreservingReducer: epr,
      jev,
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
      jev: { ...DEFAULT_EFFICIENCY_CONFIG.jev },
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

  // jev decision layer (new mechanism: canonical PIER_JEV_* only, no legacy spelling exists).
  // TYPESAFE_API_KEY is a foreign-convention fallback (TypeSafe SDK reads it), so it ranks
  // below pier's own env and below an explicit config-file key.
  const jevEnabled = parseEnvBool(env.PIER_JEV_ENABLE);
  if (jevEnabled !== undefined) resolved.jev.enabled = jevEnabled;

  const jevLog = parseEnvBool(env.PIER_JEV_LOG);
  if (jevLog !== undefined) resolved.jev.logEnabled = jevLog;

  const jevModel = env.PIER_JEV_MODEL;
  if (jevModel !== undefined && jevModel.trim()) {
    resolved.jev.model = jevModel.trim();
  }

  const jevBase = env.PIER_JEV_BASE_URL;
  if (jevBase !== undefined && jevBase.trim()) {
    resolved.jev.baseUrl = jevBase.trim();
  }

  const jevTimeoutRaw = env.PIER_JEV_TIMEOUT_MS;
  if (jevTimeoutRaw !== undefined) {
    const num = Number(jevTimeoutRaw);
    if (Number.isInteger(num) && num >= 500) {
      resolved.jev.timeoutMs = num;
    } else {
      warn(`无效环境变量 PIER_JEV_TIMEOUT_MS="${jevTimeoutRaw}"（需 >= 500 的整数），忽略`);
    }
  }

  const jevMinConfRaw = env.PIER_JEV_MIN_CONFIDENCE;
  if (jevMinConfRaw !== undefined) {
    const num = Number(jevMinConfRaw);
    if (Number.isFinite(num) && num >= 0 && num <= 1) {
      resolved.jev.minConfidence = num;
    } else {
      warn(`无效环境变量 PIER_JEV_MIN_CONFIDENCE="${jevMinConfRaw}"（需 0 到 1），忽略`);
    }
  }

  const jevKey = env.PIER_JEV_API_KEY;
  if (jevKey !== undefined && jevKey.trim()) {
    resolved.jev.apiKey = jevKey.trim();
  }
  if (!resolved.jev.apiKey && env.TYPESAFE_API_KEY && env.TYPESAFE_API_KEY.trim()) {
    resolved.jev.apiKey = env.TYPESAFE_API_KEY.trim();
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
  /** Override the Pi agent dir used to read native `settings.json` (tests/isolation). */
  agentDir?: string;
  /** Override the user-level efficiency config file path (tests/isolation). */
  userConfigPath?: string;
} = {}): EfficiencyConfig {
  const cwd = opts.cwd ?? process.cwd();
  const wsPath = defaultWorkspaceEfficiencyConfigFile(cwd);
  const userPath = opts.userConfigPath ?? defaultUserEfficiencyConfigFile();

  const warnFile = (label: string, filePath: string, error: unknown): void => {
    opts.onWarning?.(`${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  };
  const workspaceConfig = readJsonConfig(wsPath, (error) => warnFile('无法解析工作区能效配置文件', wsPath, error));
  const userConfig = readJsonConfig(userPath, (error) => warnFile('无法解析用户能效配置文件', userPath, error));
  const resolved = resolveEfficiencyConfig({
    workspaceConfig,
    userConfig,
    isProjectTrusted: opts.isProjectTrusted,
    env: opts.env,
    onWarning: opts.onWarning,
  });

  const piSettings = loadPiNativeCompactionSettings({
    cwd,
    isProjectTrusted: opts.isProjectTrusted,
    agentDir: opts.agentDir,
  });

  // If user disabled compaction globally in pi settings, and env didn't explicitly force OCC enable, respect it!
  const env = opts.env ?? process.env;
  if (piSettings.enabled === false && !env.PI_HERDR_COMPACT_ENABLE) {
    resolved.onlineContextCompact.enabled = false;
  }

  const hasExplicitKeepRecent = [
    opts.isProjectTrusted ? workspaceConfig : undefined,
    userConfig,
  ].some((config) => isPlainObject(config)
    && isPlainObject(config.onlineContextCompact)
    && config.onlineContextCompact.keepRecentTokens !== undefined);

  if (!hasExplicitKeepRecent && typeof piSettings.keepRecentTokens === 'number') {
    resolved.onlineContextCompact.keepRecentTokens = piSettings.keepRecentTokens;
  }

  return resolved;
}


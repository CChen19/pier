import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PiCompactionSettings {
  enabled?: boolean;
  keepRecentTokens?: number;
}

function readCompactionSettings(filePath: string): PiCompactionSettings {
  if (!existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !('compaction' in parsed)) return {};
    const compaction = parsed.compaction;
    if (!compaction || typeof compaction !== 'object') return {};
    const result: PiCompactionSettings = {};
    if ('enabled' in compaction && typeof compaction.enabled === 'boolean') result.enabled = compaction.enabled;
    if ('keepRecentTokens' in compaction && typeof compaction.keepRecentTokens === 'number') {
      result.keepRecentTokens = compaction.keepRecentTokens;
    }
    return result;
  } catch {
    return {};
  }
}

function defaultAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
}

/** Read pi's own compaction settings (global, plus the project file when trusted). */
export function loadPiNativeCompactionSettings(opts: {
  cwd?: string;
  isProjectTrusted?: boolean;
  agentDir?: string;
} = {}): PiCompactionSettings {
  const cwd = opts.cwd ?? process.cwd();
  const globalSettings = readCompactionSettings(join(opts.agentDir ?? defaultAgentDir(), 'settings.json'));
  if (!opts.isProjectTrusted) return globalSettings;
  const projectSettings = readCompactionSettings(join(cwd, '.pi', 'settings.json'));
  return { ...globalSettings, ...projectSettings };
}

export function readJsonConfig(filePath: string, onError?: (error: unknown) => void): unknown | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    onError?.(error);
    return undefined;
  }
}

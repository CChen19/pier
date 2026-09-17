/**
 * Child-session JSONL I/O: path resolution, settlement text, liveness probes.
 *
 * Why: pollLoop, foreground wait, and revive all shared the same candidate
 * order (reported path/id before recent-file fallback, excluding the parent
 * session). Keeping it in one adapter prevents settlement text from crossing sessions.
 */
import { accessSync, constants, statSync } from 'node:fs';
import type { HerdrClientLike } from './herdr-client.ts';
import {
  deriveSubSessionState,
  lastAssistantText,
  listSessionFiles,
  readSessionFile,
  sessionFileById,
  type SessionEntryLike,
  type SubSessionState,
} from './session-tail.ts';
import type { AliveProbe } from './subagent-core.ts';

export interface SessionIoHost {
  client: HerdrClientLike;
  getSessionId: () => string;
  sessionsDir: () => string;
}

export interface SessionIo {
  resolveSessionFileCandidates(paneId: string, cwd: string): Promise<string[]>;
  resolveSessionFile(paneId: string, cwd: string): Promise<string | null>;
  collectFinalText(paneId: string, cwd: string, sinceTs: number, attempts?: number): Promise<string | null>;
  readAskFlag(paneId: string): Promise<string | null>;
  probeAlive(paneId: string, cwd: string): Promise<AliveProbe>;
  subSessionState(paneId: string, cwd: string, sinceTs: number): Promise<SubSessionState>;
}

/** Cheap change fingerprint of a session file; null when it does not exist. */
interface FileStamp {
  size: number;
  mtimeMs: number;
}

function stampOf(file: string): FileStamp | null {
  try {
    const s = statSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/** Readable regular file check: parsing the file would read it in full (up to MBs). */
function isReadableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Memo of values derived from a session file, keyed by path and invalidated by (size, mtime).
 *
 * Why: worker sessions grow to tens of MB, and the poll loop re-derives the same idle state every
 * tick (collectFinalText re-derives up to `attempts` times). Measured on a 31.6MB session:
 * file read + JSON.parse + derive ≈ 227ms, so an unchanged file must not be parsed twice.
 * An append-only JSONL changes size on every write, so (size, mtime) is a sound fingerprint.
 */
class DerivedCache<T> {
  private readonly entries = new Map<string, { stamp: FileStamp; sinceTs: number; value: T }>();
  private readonly limit: number;

  constructor(limit = 32) {
    this.limit = limit;
  }

  get(file: string, stamp: FileStamp, sinceTs: number): T | undefined {
    const hit = this.entries.get(file);
    if (!hit || hit.stamp.size !== stamp.size || hit.stamp.mtimeMs !== stamp.mtimeMs || hit.sinceTs !== sinceTs) {
      return undefined;
    }
    return hit.value;
  }

  set(file: string, stamp: FileStamp, sinceTs: number, value: T): void {
    this.entries.delete(file);
    this.entries.set(file, { stamp, sinceTs, value });
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export function createSessionIo(h: SessionIoHost): SessionIo {
  const stateCache = new DerivedCache<SubSessionState>();
  const finalTextCache = new DerivedCache<string | null>();

  async function resolveSessionFileCandidates(paneId: string, cwd: string): Promise<string[]> {
    const out: string[] = [];
    try {
      const reported = await h.client.getAgentSessionPath(paneId);
      if (reported) {
        if (/\.jsonl$/.test(reported)) out.push(reported);
        else {
          const byId = sessionFileById(cwd, h.sessionsDir(), reported);
          if (byId) out.push(byId);
        }
      }
    } catch {
      /* Reports may be unavailable during startup. */
    }
    const ownSession = h.getSessionId();
    for (const f of listSessionFiles(cwd, h.sessionsDir(), 4)) {
      if (f !== ownSession && !out.includes(f)) out.push(f);
    }
    return out;
  }

  async function resolveSessionFile(paneId: string, cwd: string): Promise<string | null> {
    for (const file of await resolveSessionFileCandidates(paneId, cwd)) {
      if (isReadableFile(file)) return file;
    }
    return null;
  }

  async function collectFinalText(
    paneId: string,
    cwd: string,
    sinceTs: number,
    attempts = 12,
  ): Promise<string | null> {
    for (let i = 0; i < attempts; i++) {
      for (const file of await resolveSessionFileCandidates(paneId, cwd)) {
        const stamp = stampOf(file);
        if (!stamp) continue;
        const cached = finalTextCache.get(file, stamp, sinceTs);
        if (cached !== undefined) {
          if (cached) return cached;
          continue;
        }
        const entries: SessionEntryLike[] | null = readSessionFile(file);
        if (!entries) continue;
        const text = lastAssistantText(entries, { sinceTs })?.text ?? null;
        finalTextCache.set(file, stamp, sinceTs, text);
        if (text) return text;
      }
      const wait = Promise.withResolvers<void>();
      setTimeout(wait.resolve, 500);
      await wait.promise;
    }
    return null;
  }

  async function readAskFlag(paneId: string): Promise<string | null> {
    try {
      const a = (await h.client.listAgents()).find((x) => x.paneId === paneId);
      const v = a?.tokens?.['pi-ask'];
      return typeof v === 'string' && v ? v : null;
    } catch {
      return null;
    }
  }

  async function probeAlive(paneId: string, cwd: string): Promise<AliveProbe> {
    const probe: AliveProbe = { paneExists: false, agentStatus: null, lastActivityMs: null };
    try {
      const agents = await h.client.listAgents();
      const a = agents.find((x) => x.paneId === paneId);
      probe.paneExists = a != null;
      probe.agentStatus = a?.status ?? null;
      if (a?.foregroundCwd) probe.foregroundCwd = a.foregroundCwd;
    } catch {
      /* Fall back to session activity when agent.list is unavailable. */
    }
    for (const file of await resolveSessionFileCandidates(paneId, cwd)) {
      const stamp = stampOf(file);
      // Session files can disappear during candidate scanning; a vanished file has no activity.
      if (!stamp) continue;
      if (probe.lastActivityMs == null || stamp.mtimeMs > probe.lastActivityMs) probe.lastActivityMs = stamp.mtimeMs;
    }
    return probe;
  }

  async function subSessionState(
    paneId: string,
    cwd: string,
    sinceTs: number,
  ): Promise<SubSessionState> {
    for (const file of await resolveSessionFileCandidates(paneId, cwd)) {
      const stamp = stampOf(file);
      // A missing or vanished path is skipped: herdr often reports a .jsonl path before the worker
      // creates the file, and waitAgent(idle) returns immediately, which used to throw
      // `Cannot read properties of null (reading 'length')` (session 01a055c5).
      if (!stamp) continue;
      const cached = stateCache.get(file, stamp, sinceTs);
      if (cached) return cached;
      const entries = readSessionFile(file);
      // An empty/unparsable file has no state to cache; the next candidate may still have one.
      if (!entries?.length) continue;
      const state = deriveSubSessionState(entries, sinceTs);
      stateCache.set(file, stamp, sinceTs, state);
      return state;
    }
    return { text: null, pendingTool: false, activity: false, turnEnded: false };
  }

  return {
    resolveSessionFileCandidates,
    resolveSessionFile,
    collectFinalText,
    readAskFlag,
    probeAlive,
    subSessionState,
  };
}


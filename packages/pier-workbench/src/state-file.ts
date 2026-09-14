/**
 * F15: plugin state files (tab-layout.json, boot-config.json) are written by one-shot hook processes
 * that can run concurrently (several panes emitting events at once). A plain `writeFileSync` can
 * interleave with another writer, leaving truncated JSON behind — and `loadState` then silently falls
 * back to an empty state, which looks like "the plugin forgot every tab".
 *
 * Write to a unique temp file in the same directory and rename it over the target: rename is atomic,
 * so readers only ever see a complete document.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Read JSON, returning `fallback` for a missing/partial/invalid file (never throws). */
export function readJsonSafe<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomically replace `file` with `JSON.stringify(value)` (same-directory temp + rename). */
export function writeJsonAtomic(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value));
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse the replace while another process holds the file: clear the temp file and
    // fall back to a direct write (losing atomicity beats losing the update).
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    fs.writeFileSync(file, JSON.stringify(value));
  }
}

/**
 * A14: spawn readiness had a single 30 s ping window and reported failures as one bare line
 * ("subagent pane wD:pJ pipe not ready within 30000ms"), even when the child process had already
 * died with a stack trace on its screen. With 3–4 concurrent isolated workers (each running heavy
 * commands) that window was hit repeatedly, and the diagnosis cost far more than the retry would.
 *
 * This module is the pure half: how long to wait, how to back off, when to give up early
 * (the pane is gone — no point in waiting for a pipe that cannot appear) and how to word the
 * failure so the model and the human can act on it.
 */

/** Ping cadence: quick first probes, then exponential backoff capped at `READY_MAX_INTERVAL_MS`. */
export const READY_BASE_INTERVAL_MS = 500;
export const READY_MAX_INTERVAL_MS = 4000;

/** Wait this long between two samples of the child pane's liveness (pane.list + pane read). */
export const READY_LIVENESS_SAMPLE_MS = 2500;

export interface ReadyProbe {
  /** The pane still exists in pane.list (unknown shells count as alive). */
  readonly paneAlive: boolean;
  /** Tail of the pane's screen, used only to explain a failure. */
  readonly tail?: string | null;
}

export type ReadyAttemptPlan =
  | { readonly kind: 'ready' }
  | { readonly kind: 'retry'; readonly delayMs: number }
  | { readonly kind: 'give-up'; readonly reason: 'pane-gone' | 'timeout' };

/**
 * Decide one readiness attempt.
 * `alive` is tri-state on purpose: an unavailable liveness probe (`null`) must not be read as death,
 * otherwise a slow herdr socket would fail spawns that are merely slow to boot.
 */
export function planReadyAttempt(opts: {
  elapsedMs: number;
  attempt: number;
  timeoutMs: number;
  alive: boolean | null;
  ready: boolean;
}): ReadyAttemptPlan {
  if (opts.ready) return { kind: 'ready' };
  if (opts.alive === false) return { kind: 'give-up', reason: 'pane-gone' };
  if (opts.elapsedMs >= opts.timeoutMs) return { kind: 'give-up', reason: 'timeout' };
  return { kind: 'retry', delayMs: readyBackoffMs(opts.attempt) };
}

/** Exponential backoff with a cap: 500ms, 1s, 2s, 4s, 4s, … */
export function readyBackoffMs(attempt: number, baseMs = READY_BASE_INTERVAL_MS, capMs = READY_MAX_INTERVAL_MS): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(capMs, baseMs * 2 ** n);
}

/** How many characters of pane tail to attach to a failure (enough for a stack trace head). */
export const READY_TAIL_CHARS = 1200;

export interface ReadyFailure {
  readonly paneId: string;
  readonly reason: 'pane-gone' | 'timeout';
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  /** Some agent states the wait observed (working/idle/…), for the "agent never reported" case. */
  readonly lastStatus?: string | null;
  readonly tail?: string | null;
  /** True when the child process exited (pane gone) rather than never starting to report. */
  readonly hint?: string | null;
}

/**
 * Failure text for the model. The three cases it must distinguish:
 *  1. the pane died (usually the child crashed — the tail carries the reason, cf. A13's stack trace);
 *  2. the pane is alive but never opened its pipe (extension failed to load, wrong pane env);
 *  3. the pane is alive and its agent is working, just slower than the timeout (retry is safe).
 */
export function readyFailureText(failure: ReadyFailure): string {
  const seconds = Math.round(failure.elapsedMs / 1000);
  const head = failure.reason === 'pane-gone'
    ? `subagent pane ${failure.paneId} exited before its pipe became ready (waited ${seconds}s)`
    : `subagent pane ${failure.paneId} pipe not ready within ${seconds}s (limit ${Math.round(failure.timeoutMs / 1000)}s)`;
  const why = failure.reason === 'pane-gone'
    ? 'The child process is gone — its last output below usually carries the reason.'
    : failure.lastStatus === 'working'
      ? 'The pane is alive and working, so the prompt may simply be slow to boot; retrying the same call is safe.'
      : 'The pane is alive but never registered its pipe — the child pi process may still be starting, or it failed to load the pier extension.';
  const tail = failure.tail ? `\nlast output of ${failure.paneId}:\n${failure.tail}` : '';
  const hint = failure.hint ? `\n${failure.hint}` : '';
  return `${head}\n${why}${hint}${tail}`;
}

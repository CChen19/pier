/**
 * Tier 1 wrap-up: workbench (herdr side) second tree — the other half of D78 tree boundary = process boundary.
 *
 * Recipe follows pi-herdr/bootstrap.ts (dogfood acceptance), but trimmed down per D81 trichotomy:
 * workbench hook scripts = **one-shot short-lived processes** (worker archetype) — bare Context root +
 * manual mount, **no loader/hmr/timer** (hot reloading belongs only to long-lived master processes).
 *
 * Plugin-style modules (src/reflow.ts, etc.) obtain dependencies via service injection (`workbench.deps`),
 * and dispose before process exit — following the same discipline as the master side.
 */
import { Context } from '@deepseek-ai/cordis';

export interface WorkbenchApp {
  /** Root context (one-shot: mount plugins -> run to completion -> dispose -> exit). */
  root: Context;
}

export async function createWorkbenchApp(): Promise<WorkbenchApp> {
  const root = new Context();
  return { root };
}

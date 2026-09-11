/**
 * ask_user_question multi-select: pure state machine + a thin TUI component.
 *
 * Why: the previous multi path asked the human to *type* "1,3" into a text prompt,
 * which is the weakest part of the human gate. This module renders a real toggle
 * list (space to toggle, enter to confirm, esc to decline) with the authored
 * choices, an optional trailing free-text row, and a live selection count.
 *
 * The transition function is pure so the UX is testable without a terminal; the
 * component only maps keys to it. Installing the free-text row is opt-out
 * (`allowOther: false`) for pure-choice questions.
 */
import { truncateStyled } from './ansi-text.ts';

export interface MultiSelectOption {
  label: string;
  description?: string;
}

export interface MultiSelectConfig {
  options: readonly MultiSelectOption[];
  /** Render the trailing free-text row (pi-herdr's "Other"). */
  allowOther: boolean;
  /** 0-based index of the recommended option, marked in the list. */
  recommended?: number;
}

export interface MultiSelectState {
  /** Cursor row: 0..options.length-1 are choices, options.length is the Other row. */
  cursor: number;
  /** Toggle state per authored option (never includes the Other row). */
  selected: readonly boolean[];
}

export type MultiSelectKey = 'up' | 'down' | 'toggle' | 'confirm' | 'cancel' | 'all' | 'ignore';

export type MultiSelectOutcome =
  | { kind: 'selected'; labels: string[] }
  | { kind: 'other' }
  | { kind: 'cancel' };

export interface MultiSelectStep {
  state: MultiSelectState;
  outcome?: MultiSelectOutcome;
}

export function createMultiSelectState(config: MultiSelectConfig): MultiSelectState {
  return { cursor: 0, selected: config.options.map(() => false) };
}

/** Total rows including the optional Other row; the cursor wraps inside this. */
export function rowCount(config: MultiSelectConfig): number {
  return config.options.length + (config.allowOther ? 1 : 0);
}

export function isOtherRow(state: MultiSelectState, config: MultiSelectConfig): boolean {
  return config.allowOther && state.cursor === config.options.length;
}

export function selectedLabels(state: MultiSelectState, config: MultiSelectConfig): string[] {
  const labels: string[] = [];
  config.options.forEach((option, i) => {
    if (state.selected[i]) labels.push(option.label);
  });
  return labels;
}

/** Apply one key. A returned outcome ends the interaction. */
export function stepMultiSelect(state: MultiSelectState, key: MultiSelectKey, config: MultiSelectConfig): MultiSelectStep {
  const rows = rowCount(config);
  if (rows === 0) return key === 'cancel' ? { state, outcome: { kind: 'cancel' } } : { state };
  switch (key) {
    case 'cancel':
      return { state, outcome: { kind: 'cancel' } };
    case 'up':
    case 'down': {
      const delta = key === 'up' ? -1 : 1;
      const cursor = (state.cursor + delta + rows) % rows;
      return { state: { ...state, cursor } };
    }
    case 'all': {
      const anyUnselected = state.selected.some((v) => !v);
      return { state: { ...state, selected: state.selected.map(() => anyUnselected) } };
    }
    case 'toggle': {
      if (isOtherRow(state, config)) return { state };
      const selected = state.selected.map((v, i) => (i === state.cursor ? !v : v));
      return { state: { ...state, selected } };
    }
    case 'confirm': {
      if (isOtherRow(state, config)) return { state, outcome: { kind: 'other' } };
      // Enter on a choice row confirms the current toggles; a single-choice
      // question (multi: false) needs no separate space press.
      if (config.options.length === 1) {
        return { state, outcome: { kind: 'selected', labels: [config.options[0]!.label] } };
      }
      return { state, outcome: { kind: 'selected', labels: selectedLabels(state, config) } };
    }
    default:
      return { state };
  }
}

/* ── Key matching ──────────────────────────────────────────────────── */

export type KeyMatcher = (data: string, key: Exclude<MultiSelectKey, 'ignore'>) => boolean;

/**
 * Fallback matcher for raw key sequences, used when pi-tui cannot be imported.
 * Ordering inside `handleInput` matters for escape: arrow sequences are matched
 * before the bare ESC key because both start with 0x1b.
 */
export const FALLBACK_KEY_SEQUENCES: Record<Exclude<MultiSelectKey, 'ignore'>, readonly string[]> = {
  up: ['\x1b[A', '\x1bOA', 'k'],
  down: ['\x1b[B', '\x1bOB', 'j'],
  toggle: [' '],
  confirm: ['\r', '\n'],
  cancel: ['\x1b', '\x03'],
  all: ['a', 'A'],
};

export const fallbackKeyMatcher: KeyMatcher = (data, key) => FALLBACK_KEY_SEQUENCES[key].includes(data);

/**
 * Prefer pi-tui's `matchesKey` (it understands terminal variations and keybindings
 * remaps); fall back to the built-in sequences when the package is unavailable.
 */
export async function loadKeyMatcher(): Promise<KeyMatcher> {
  try {
    const tui = await import('@earendil-works/pi-tui') as {
      matchesKey?: (data: string, key: unknown) => boolean;
      Key?: Record<string, unknown>;
    };
    const Key = tui.Key;
    if (typeof tui.matchesKey === 'function' && Key && typeof Key.up === 'string') {
      const map: Record<string, unknown> = {
        up: Key.up,
        down: Key.down,
        toggle: Key.space,
        confirm: Key.enter,
        cancel: Key.escape,
        all: 'a',
      };
      return (data, key) => tui.matchesKey!(data, map[key]);
    }
  } catch {
    /* pi-tui absent: use the built-in sequences. */
  }
  return fallbackKeyMatcher;
}

/* ── TUI component ─────────────────────────────────────────────────── */

export interface MinimalTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface MultiSelectComponent {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
}

export interface MultiSelectUiOptions {
  title: string;
  config: MultiSelectConfig;
  theme: MinimalTheme;
  matcher: KeyMatcher;
  /** Called with the outcome; the host resolves ctx.ui.custom. */
  done(outcome: MultiSelectOutcome): void;
  /** Ask for the gate label used by the renderer (tests only). */
  requestRender?: () => void;
}

const RECOMMENDED = ' (Recommended)';

export function multiSelectLines(state: MultiSelectState, config: MultiSelectConfig, theme: MinimalTheme): string[] {
  const lines: string[] = [];
  config.options.forEach((option, i) => {
    const cursor = i === state.cursor ? theme.fg('accent', '> ') : '  ';
    const box = state.selected[i] ? theme.fg('success', '[x]') : '[ ]';
    const label = `${option.label}${config.recommended === i ? RECOMMENDED : ''}`;
    const styled = state.selected[i] ? theme.bold(label) : label;
    const desc = option.description ? theme.fg('dim', ` — ${option.description}`) : '';
    lines.push(`${cursor}${box} ${styled}${desc}`);
  });
  if (config.allowOther) {
    const cursor = isOtherRow(state, config) ? theme.fg('accent', '> ') : '  ';
    lines.push(`${cursor}${theme.fg('dim', '[ ] Other (type your own)')}`);
  }
  return lines;
}

export function multiSelectFooter(state: MultiSelectState, config: MultiSelectConfig, theme: MinimalTheme): string {
  const picked = selectedLabels(state, config).length;
  const count = picked > 0 ? theme.fg('success', ` · ${picked} selected`) : '';
  return theme.fg('dim', '↑/↓ move · space toggle · a all · enter confirm · esc cancel') + count;
}

export function createMultiSelectComponent(opts: MultiSelectUiOptions): MultiSelectComponent {
  let state = createMultiSelectState(opts.config);
  let finished = false;
  const finish = (outcome: MultiSelectOutcome): void => {
    if (finished) return;
    finished = true;
    opts.done(outcome);
  };
  return {
    render(width: number): string[] {
      const head = opts.theme.bold(opts.title);
      const body = multiSelectLines(state, opts.config, opts.theme);
      const footer = multiSelectFooter(state, opts.config, opts.theme);
      return [head, ...body, '', footer].map((line) => truncateStyled(line, width));
    },
    handleInput(data: string): void {
      if (finished) return;
      // Arrow sequences are checked before the bare ESC key (shared 0x1b prefix).
      const key: MultiSelectKey = opts.matcher(data, 'up') ? 'up'
        : opts.matcher(data, 'down') ? 'down'
        : opts.matcher(data, 'toggle') ? 'toggle'
        : opts.matcher(data, 'confirm') ? 'confirm'
        : opts.matcher(data, 'cancel') ? 'cancel'
        : opts.matcher(data, 'all') ? 'all'
        : 'ignore';
      if (key === 'ignore') return;
      const next = stepMultiSelect(state, key, opts.config);
      state = next.state;
      opts.requestRender?.();
      if (next.outcome) finish(next.outcome);
    },
    invalidate(): void { /* No cached lines. */ },
  };
}

/**
 * Run the toggle list through `ctx.ui.custom`.
 * Returns null when the host cannot render custom components (RPC mode / older pi),
 * so the caller can fall back to the typed-index prompt.
 */
export async function runMultiSelect(
  custom: (factory: unknown) => Promise<unknown>,
  title: string,
  config: MultiSelectConfig,
): Promise<MultiSelectOutcome | null> {
  const matcher = await loadKeyMatcher();
  const result = await custom((tui: unknown, theme: unknown, _keybindings: unknown, done: (value: unknown) => void) =>
    createMultiSelectComponent({
      title,
      config,
      theme: theme as MinimalTheme,
      matcher,
      done: (outcome) => done(outcome),
      requestRender: () => (tui as { requestRender?: () => void } | undefined)?.requestRender?.(),
    }));
  if (result === undefined || result === null) return null;
  const outcome = result as MultiSelectOutcome;
  if (outcome.kind === 'cancel' || outcome.kind === 'other' || outcome.kind === 'selected') return outcome;
  return null;
}

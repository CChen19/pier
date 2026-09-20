/**
 * TUI renderers for pier's own session custom entries and reminder messages.
 *
 * Why: pier persists authority in the session JSONL (todo edits, subagent registry,
 * terminal registry, role manifests, soft-approvals) and injects reminder messages.
 * Without a renderer those transcript rows are raw JSON, which buries the one line
 * that matters. The line builders here are pure (unit-tested); the component is a
 * thin string array plus an ANSI-aware truncator, so this module needs no pi-tui
 * import and degrades to "no renderer" on older pi builds.
 */
import { TODO_EDIT_CUSTOM_TYPE, type TodoEditPayload } from './todo-core.ts';
import { SUBS_CUSTOM_TYPE, type SubsRegistry } from './subagent-core.ts';
import { TERMINALS_CUSTOM_TYPE, TERM_REMINDER_CUSTOM_TYPE, type TerminalsRegistry } from './terminal-core.ts';
import { TODO_REMINDER_CUSTOM_TYPE } from './todo-reminder-core.ts';

// Width handling lives in its own module so the ask_user_question UI can reuse it
// without pulling the todo/subagent/terminal cores into its import graph.
import { charWidth, styledWidth, truncateStyled } from './ansi-text.ts';
export { charWidth, styledWidth, truncateStyled };

/** Role manifest entry is written by index.ts; keep the literal here to avoid an import cycle. */
export const ROLE_MANIFEST_CUSTOM_TYPE = 'pi-herdr.role-manifest';
/** Soft-approval trace written by the worker manifest gate in index.ts. */
export const APPROVAL_NEEDED_CUSTOM_TYPE = 'pi-herdr.approval-needed';

/** Structural subset of pi's Theme that the builders actually use. */
export interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Structural subset of pi's Component; enough for `registerEntryRenderer`. */
export interface RenderComponent {
  render(width: number): string[];
  invalidate(): void;
}

export interface RendererApi {
  registerEntryRenderer?(
    customType: string,
    renderer: (entry: unknown, options: { expanded: boolean }, theme: RenderTheme) => RenderComponent | undefined,
  ): void;
  registerMessageRenderer?(
    customType: string,
    renderer: (message: unknown, options: { expanded: boolean }, theme: RenderTheme) => RenderComponent | undefined,
  ): void;
}

/* ── Pure line builders ────────────────────────────────────────────── */

/** Component wrapper: render is a no-op transform except for width clipping. */
export function card(lines: readonly string[]): RenderComponent {
  return {
    render: (width: number) => lines.map((line) => truncateStyled(line, width)),
    invalidate() { /* No cached state. */ },
  };
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const EDIT_VERB: Record<string, string> = {
  done: '✓ done',
  drop: '■ dropped',
  unblock: '○ unblocked',
  rm: '✗ removed',
};

export function formatEditCounts(edits: ReadonlyArray<{ op: string }>): string {
  const counts = new Map<string, number>();
  for (const edit of edits) counts.set(edit.op, (counts.get(edit.op) ?? 0) + 1);
  return [...counts.entries()]
    .map(([op, n]) => `${EDIT_VERB[op] ?? op}${n > 1 ? ` ×${n}` : ''}`)
    .join(' · ');
}

export function todoEditLines(data: unknown, theme: RenderTheme, expanded: boolean): string[] {
  const payload = data as TodoEditPayload | undefined;
  const edits = Array.isArray(payload?.edits) ? payload.edits : [];
  if (edits.length === 0) return [theme.fg('dim', 'todo · no edits')];
  const head = `${theme.fg('accent', theme.bold('todo'))} ${theme.fg('dim', `· ${edits.length} edit${edits.length > 1 ? 's' : ''}`)} ${formatEditCounts(edits)}`;
  if (!expanded) return [head];
  return [
    head,
    ...edits.map((edit) => theme.fg('dim', `  ${EDIT_VERB[edit.op] ?? edit.op} — ${clip(String(edit.content ?? ''), 90)}`)),
  ];
}

export function subsLines(data: unknown, theme: RenderTheme, expanded: boolean): string[] {
  const subs = (data as SubsRegistry | undefined)?.subs;
  if (!Array.isArray(subs) || subs.length === 0) return [theme.fg('dim', 'subagents · none')];
  const running = subs.filter((s) => s.status === 'running').length;
  const head = `${theme.fg('accent', theme.bold('subagents'))} ${theme.fg('dim', `· ${subs.length} tracked`)}${running ? ` ${theme.fg('success', `${running} running`)}` : ''}`;
  if (!expanded) return [head];
  return [
    head,
    ...subs.map((sub) => theme.fg(
      'dim',
      `  ${sub.status === 'running' ? '●' : '○'} ${sub.paneId} · ${sub.status} · ${clip(String(sub.description ?? ''), 70)}`,
    )),
  ];
}

export function terminalsLines(data: unknown, theme: RenderTheme, expanded: boolean): string[] {
  const terminals = (data as TerminalsRegistry | undefined)?.terminals;
  if (!Array.isArray(terminals) || terminals.length === 0) return [theme.fg('dim', 'terminals · none')];
  const head = `${theme.fg('accent', theme.bold('terminals'))} ${theme.fg('dim', `· ${terminals.length} open`)}`;
  if (!expanded) return [head];
  return [
    head,
    ...terminals.map((t) => theme.fg('dim', `  ${t.paneId} · ${clip(String(t.label ?? t.cwd ?? ''), 70)}`)),
  ];
}

export function roleManifestLines(data: unknown, theme: RenderTheme): string[] {
  const rec = (data ?? {}) as {
    role?: unknown;
    manifestVersion?: unknown;
    tools?: unknown;
    permissions?: unknown;
    origin?: unknown;
    switchedBy?: unknown;
  };
  const role = typeof rec.role === 'string' ? rec.role : '?';
  const version = typeof rec.manifestVersion === 'string' || typeof rec.manifestVersion === 'number' ? String(rec.manifestVersion) : '?';
  const tools = Array.isArray(rec.tools) ? rec.tools.length : 0;
  const gates = Object.values((rec.permissions ?? {}) as Record<string, unknown>)
    .filter((v) => v === 'deny' || v === 'ask').length;
  const tail = gates > 0 ? theme.fg('warning', ` · ${gates} gated`) : '';
  // P0: switch provenance — origin 'switch' marks a mid-session swap (vs the session_start anchor).
  const switched =
    rec.origin === 'switch'
      ? theme.fg('accent', ` ⇄ ${typeof rec.switchedBy === 'string' && rec.switchedBy ? rec.switchedBy : '?'}`)
      : '';
  return [`${theme.fg('accent', theme.bold('role'))} ${role} ${theme.fg('dim', `v${version} · ${tools} tools`)}${tail}${switched}`];
}

export function approvalLines(data: unknown, theme: RenderTheme): string[] {
  const rec = (data ?? {}) as { role?: unknown; tool?: unknown };
  const role = typeof rec.role === 'string' ? rec.role : '?';
  const tool = typeof rec.tool === 'string' ? rec.tool : '?';
  return [`${theme.fg('warning', '⚠ approval needed')} ${theme.fg('dim', `· ${tool} (${role})`)}`];
}

/** Reminder custom messages carry the full injected text; restyle without altering it. */
export function reminderLines(message: unknown, theme: RenderTheme, label: string, expanded: boolean): string[] {
  const content = typeof (message as { content?: unknown } | undefined)?.content === 'string'
    ? String((message as { content: string }).content)
    : '';
  const firstLine = content.split('\n').find((line) => line.trim().length > 0) ?? label;
  const head = `${theme.fg('warning', `↻ ${label}`)}`;
  if (!expanded) return [head, theme.fg('dim', `  ${clip(firstLine, 110)}`)];
  return [head, ...content.split('\n').map((line) => theme.fg('dim', line))];
}

/* ── Installation ──────────────────────────────────────────────────── */

function entryCard(
  build: (data: unknown, theme: RenderTheme, expanded: boolean) => string[],
): (entry: unknown, options: { expanded: boolean }, theme: RenderTheme) => RenderComponent {
  return (entry, options, theme) => card(build((entry as { data?: unknown } | undefined)?.data, theme, options.expanded));
}

function messageCard(
  build: (message: unknown, theme: RenderTheme, expanded: boolean) => string[],
): (message: unknown, options: { expanded: boolean }, theme: RenderTheme) => RenderComponent {
  return (message, options, theme) => card(build(message, theme, options.expanded));
}

/**
 * Register pier's transcript renderers. Returns the custom types actually registered,
 * so the caller can log coverage and tests can assert the degrade path.
 *
 * Why best-effort: entry/message renderers are display-only. A pi build without the
 * API (pre-0.80.4) or a throwing renderer must never break tool registration, so each
 * registration is individually guarded.
 */
export function installRenderers(pi: unknown): string[] {
  const api = pi as RendererApi;
  const registered: string[] = [];
  const entry = (type: string, build: (data: unknown, theme: RenderTheme, expanded: boolean) => string[]): void => {
    if (typeof api.registerEntryRenderer !== 'function') return;
    try {
      api.registerEntryRenderer(type, entryCard(build));
      registered.push(type);
    } catch {
      /* Older pi or a conflicting renderer: keep the default rendering. */
    }
  };
  const message = (type: string, build: (msg: unknown, theme: RenderTheme, expanded: boolean) => string[]): void => {
    if (typeof api.registerMessageRenderer !== 'function') return;
    try {
      api.registerMessageRenderer(type, messageCard(build));
      registered.push(type);
    } catch {
      /* Best effort; the message still reaches the model. */
    }
  };

  entry(TODO_EDIT_CUSTOM_TYPE, (data, theme, expanded) => todoEditLines(data, theme, expanded));
  entry(SUBS_CUSTOM_TYPE, (data, theme, expanded) => subsLines(data, theme, expanded));
  entry(TERMINALS_CUSTOM_TYPE, (data, theme, expanded) => terminalsLines(data, theme, expanded));
  entry(ROLE_MANIFEST_CUSTOM_TYPE, (data, theme) => roleManifestLines(data, theme));
  entry(APPROVAL_NEEDED_CUSTOM_TYPE, (data, theme) => approvalLines(data, theme));
  message(TODO_REMINDER_CUSTOM_TYPE, (msg, theme, expanded) => reminderLines(msg, theme, 'todo reminder', expanded));
  message(TERM_REMINDER_CUSTOM_TYPE, (msg, theme, expanded) => reminderLines(msg, theme, 'terminal nudge', expanded));
  return registered;
}

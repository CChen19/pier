/**
 * renderers: ANSI-aware clipping, pure card builders, and best-effort installation.
 *
 * Why: these renderers are display-only, so the risk we test is "wrong text in the
 * transcript" and "registration breaks the extension", not tool behavior.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL_NEEDED_CUSTOM_TYPE,
  ROLE_MANIFEST_CUSTOM_TYPE,
  approvalLines,
  card,
  charWidth,
  formatEditCounts,
  installRenderers,
  reminderLines,
  roleManifestLines,
  styledWidth,
  subsLines,
  terminalsLines,
  todoEditLines,
  truncateStyled,
  type RenderComponent,
  type RenderTheme,
} from '../src/renderers.ts';
import { TODO_EDIT_CUSTOM_TYPE } from '../src/todo-core.ts';
import { SUBS_CUSTOM_TYPE } from '../src/subagent-core.ts';
import { TERMINALS_CUSTOM_TYPE, TERM_REMINDER_CUSTOM_TYPE } from '../src/terminal-core.ts';
import { TODO_REMINDER_CUSTOM_TYPE } from '../src/todo-reminder-core.ts';

/** Plain theme: styling is identity, so assertions read the raw text. */
const plain: RenderTheme = { fg: (_c, t) => t, bold: (t) => t };
/** Marker theme: exposes which colors the builders request. */
const marker: RenderTheme = { fg: (c, t) => `[${c}]${t}`, bold: (t) => `**${t}**` };

const ANSI_LINE = '\x1b[31mred\x1b[0m and \x1b[1mbold\x1b[0m';

test('styledWidth: escapes are zero-width, ASCII counts one cell each', () => {
  assert.equal(styledWidth('abc'), 3);
  assert.equal(styledWidth(ANSI_LINE), 'red and bold'.length);
  assert.equal(styledWidth(''), 0);
});

test('charWidth: CJK and emoji are wide, control and combining are zero', () => {
  assert.equal(charWidth(0x41), 1);
  assert.equal(charWidth(0x4e2d), 2); // 中
  assert.equal(charWidth(0x1f680), 2); // 🚀
  assert.equal(charWidth(0x0301), 0);
  assert.equal(charWidth(0x0a), 0);
});

test('truncateStyled: passthrough when it fits, ellipsis when it does not', () => {
  assert.equal(truncateStyled('short', 10), 'short');
  const cut = truncateStyled('0123456789', 5);
  assert.equal(cut.endsWith('…'), true);
  assert.equal(styledWidth(cut), 5);
  assert.equal(truncateStyled('anything', 0), '');
});

test('truncateStyled: wide glyphs consume two cells and escapes survive the cut', () => {
  const cjk = '中中中中中';
  assert.equal(styledWidth(cjk), 10);
  const cut = truncateStyled(cjk, 5);
  assert.equal(styledWidth(cut), 5);

  const styled = `\x1b[32m${'ab'.repeat(20)}\x1b[0m`;
  const clipped = truncateStyled(styled, 8);
  assert.equal(styledWidth(clipped), 8);
  assert.equal(clipped.startsWith('\x1b[32m'), true);
});

test('card: render clips to the requested width and invalidate is safe', () => {
  const component: RenderComponent = card(['abcdefghij', 'x']);
  assert.deepEqual(component.render(4).map((l) => styledWidth(l)), [4, 1]);
  component.invalidate();
});

test('formatEditCounts: verbs per op and ×N for repeats', () => {
  assert.equal(
    formatEditCounts([{ op: 'done' }, { op: 'done' }, { op: 'unblock' }, { op: 'weird' }]),
    '✓ done ×2 · ○ unblocked · weird',
  );
  assert.equal(formatEditCounts([]), '');
});

test('todoEditLines: collapsed shows the summary, expanded shows each edit', () => {
  const data = { version: 1, ts: 1, edits: [{ op: 'done', content: 'ship it' }, { op: 'rm', content: 'stale' }] };
  const collapsed = todoEditLines(data, plain, false);
  assert.equal(collapsed.length, 1);
  assert.match(collapsed[0]!, /todo/);
  assert.match(collapsed[0]!, /2 edits/);

  const expanded = todoEditLines(data, plain, true);
  assert.equal(expanded.length, 3);
  assert.match(expanded[1]!, /done — ship it/);
  assert.match(expanded[2]!, /removed — stale/);
});

test('todoEditLines: malformed or empty payloads never throw', () => {
  assert.deepEqual(todoEditLines(undefined, plain, true).length, 1);
  assert.deepEqual(todoEditLines({ edits: [] }, plain, true).length, 1);
  assert.deepEqual(todoEditLines({ edits: 'nope' }, plain, false).length, 1);
});

test('subsLines: counts running entries and lists them when expanded', () => {
  const data = {
    version: 2,
    subs: [
      { paneId: 'wD:p4', status: 'running', description: 'workbench upgrade' },
      { paneId: 'wD:p5', status: 'settled', description: 'poll-loop tests' },
    ],
  };
  const head = subsLines(data, plain, false);
  assert.equal(head.length, 1);
  assert.match(head[0]!, /2 tracked/);
  assert.match(head[0]!, /1 running/);

  const expanded = subsLines(data, plain, true);
  assert.equal(expanded.length, 3);
  assert.match(expanded[1]!, /● wD:p4 · running/);
  assert.match(expanded[2]!, /○ wD:p5 · settled/);
});

test('subsLines: empty or malformed registry renders a single dim line', () => {
  assert.match(subsLines({ version: 2, subs: [] }, plain, true)[0]!, /none/);
  assert.match(subsLines(undefined, plain, true)[0]!, /none/);
});

test('terminalsLines: open panes with labels', () => {
  const data = { version: 1, terminals: [{ paneId: 'wD:p9', label: 'dev server', cwd: '/repo' }] };
  assert.match(terminalsLines(data, plain, false)[0]!, /1 open/);
  const expanded = terminalsLines(data, plain, true);
  assert.match(expanded[1]!, /wD:p9/);
  assert.match(expanded[1]!, /dev server/);
  assert.match(terminalsLines({}, plain, false)[0]!, /none/);
});

test('roleManifestLines: role, version, tool count and gated permission count', () => {
  const data = { role: 'worker-default', manifestVersion: 'v1', tools: ['read', 'bash', 'write'], permissions: { bash: 'deny', write: 'ask', read: 'allow' } };
  const lines = roleManifestLines(data, marker);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /\[accent\]\*\*role\*\*/);
  assert.match(lines[0]!, /worker-default/);
  assert.match(lines[0]!, /v1 · 3 tools/);
  assert.match(lines[0]!, /\[warning\] · 2 gated/);
});

test('roleManifestLines: unknown shapes fall back to placeholders', () => {
  assert.match(roleManifestLines(undefined, plain)[0]!, /role \? v\? · 0 tools/);
});

test('approvalLines: tool and role are both visible', () => {
  assert.match(approvalLines({ role: 'worker', tool: 'bash' }, plain)[0]!, /approval needed · bash \(worker\)/);
  assert.match(approvalLines({}, plain)[0]!, /· \? \(\?\)/);
});

test('reminderLines: collapsed keeps one dim line, expanded keeps the full body', () => {
  const message = { content: 'Reminder 1/3: you stopped with unfinished todos\nsecond line' };
  const collapsed = reminderLines(message, plain, 'todo reminder', false);
  assert.equal(collapsed.length, 2);
  assert.match(collapsed[0]!, /↻ todo reminder/);
  assert.match(collapsed[1]!, /Reminder 1\/3/);

  const expanded = reminderLines(message, plain, 'todo reminder', true);
  assert.equal(expanded.length, 3);
  assert.match(expanded[2]!, /second line/);
});

test('reminderLines: empty content falls back to the label', () => {
  const lines = reminderLines({}, plain, 'terminal nudge', false);
  assert.match(lines[1]!, /terminal nudge/);
});

test('installRenderers: registers every pier custom type when the API exists', () => {
  const entryTypes: string[] = [];
  const messageTypes: string[] = [];
  const pi = {
    registerEntryRenderer: (type: string) => { entryTypes.push(type); },
    registerMessageRenderer: (type: string) => { messageTypes.push(type); },
  };
  const registered = installRenderers(pi);
  assert.deepEqual(entryTypes, [
    TODO_EDIT_CUSTOM_TYPE,
    SUBS_CUSTOM_TYPE,
    TERMINALS_CUSTOM_TYPE,
    ROLE_MANIFEST_CUSTOM_TYPE,
    APPROVAL_NEEDED_CUSTOM_TYPE,
  ]);
  assert.deepEqual(messageTypes, [TODO_REMINDER_CUSTOM_TYPE, TERM_REMINDER_CUSTOM_TYPE]);
  assert.equal(registered.length, 7);
});

test('installRenderers: missing API registers nothing and never throws', () => {
  assert.deepEqual(installRenderers({}), []);
});

test('installRenderers: a throwing registration is contained per type', () => {
  let calls = 0;
  const pi = {
    registerEntryRenderer: () => { calls += 1; throw new Error('boom'); },
    registerMessageRenderer: () => { calls += 1; },
  };
  const registered = installRenderers(pi);
  assert.equal(calls, 7);
  assert.deepEqual(registered, [TODO_REMINDER_CUSTOM_TYPE, TERM_REMINDER_CUSTOM_TYPE]);
});

test('installRenderers: registered entry renderer closes over the right custom type', () => {
  const seen = new Map<string, (entry: unknown, options: { expanded: boolean }, theme: RenderTheme) => RenderComponent>();
  const pi = {
    registerEntryRenderer: (type: string, renderer: (entry: unknown, options: { expanded: boolean }, theme: RenderTheme) => RenderComponent) => {
      seen.set(type, renderer);
    },
  };
  installRenderers(pi);
  const renderer = seen.get(SUBS_CUSTOM_TYPE)!;
  const component = renderer(
    { customType: SUBS_CUSTOM_TYPE, data: { version: 2, subs: [{ paneId: 'p1', status: 'running', description: 'x' }] } },
    { expanded: false },
    plain,
  );
  assert.match(component.render(80)[0]!, /subagents/);
});

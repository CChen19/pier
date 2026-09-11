/**
 * ask-multi: toggle-list state machine, component key handling and the custom-UI bridge.
 *
 * Why: this is the human gate's most-used interaction, so the transitions (toggle,
 * wrap-around, confirm, free-text row, cancel) are pinned by tests instead of being
 * verified by hand in a terminal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { styledWidth } from '../src/ansi-text.ts';
import {
  createMultiSelectComponent,
  createMultiSelectState,
  fallbackKeyMatcher,
  multiSelectFooter,
  multiSelectLines,
  rowCount,
  runMultiSelect,
  selectedLabels,
  stepMultiSelect,
  type MinimalTheme,
  type MultiSelectConfig,
  type MultiSelectOutcome,
  type MultiSelectState,
} from '../src/ask-multi.ts';
import { prepareAsk, runAsk, type AskUi } from '../src/ask-user.ts';

const plain: MinimalTheme = { fg: (_c, t) => t, bold: (t) => t };

const config = (over: Partial<MultiSelectConfig> = {}): MultiSelectConfig => ({
  options: [{ label: 'alpha' }, { label: 'beta', description: 'second' }, { label: 'gamma' }],
  allowOther: true,
  ...over,
});

const feed = (state: MultiSelectState, keys: Parameters<typeof stepMultiSelect>[1][], cfg: MultiSelectConfig): MultiSelectState => {
  let current = state;
  for (const key of keys) current = stepMultiSelect(current, key, cfg).state;
  return current;
};

test('rowCount and isOtherRow account for the optional free-text row', () => {
  assert.equal(rowCount(config()), 4);
  assert.equal(rowCount(config({ allowOther: false })), 3);
});

test('cursor wraps in both directions over choices and the Other row', () => {
  const cfg = config();
  assert.equal(feed(createMultiSelectState(cfg), ['up'], cfg).cursor, 3);
  const last = feed(createMultiSelectState(cfg), ['up'], cfg);
  assert.equal(stepMultiSelect(last, 'down', cfg).state.cursor, 0);
  assert.equal(stepMultiSelect(createMultiSelectState(cfg), 'down', cfg).state.cursor, 1);
});

test('cursor never reaches the Other row when allowOther is false', () => {
  const cfg = config({ allowOther: false });
  assert.equal(feed(createMultiSelectState(cfg), ['up'], cfg).cursor, 2);
});

test('space toggles only the cursor row and keeps selection order', () => {
  const cfg = config();
  const picked = feed(createMultiSelectState(cfg), ['down', 'down', 'toggle', 'up', 'up', 'toggle'], cfg);
  assert.deepEqual(selectedLabels(picked, cfg), ['alpha', 'gamma']);
  const untoggled = stepMultiSelect(picked, 'toggle', cfg).state;
  assert.deepEqual(selectedLabels(untoggled, cfg), ['gamma']);
});

test('space on the Other row is a no-op', () => {
  const cfg = config();
  const onOther = feed(createMultiSelectState(cfg), ['up'], cfg);
  const step = stepMultiSelect(onOther, 'toggle', cfg);
  assert.equal(step.outcome, undefined);
  assert.deepEqual(selectedLabels(step.state, cfg), []);
});

test('a toggles everything on, then everything off', () => {
  const cfg = config();
  const all = stepMultiSelect(createMultiSelectState(cfg), 'all', cfg).state;
  assert.deepEqual(selectedLabels(all, cfg), ['alpha', 'beta', 'gamma']);
  const none = stepMultiSelect(all, 'all', cfg).state;
  assert.deepEqual(selectedLabels(none, cfg), []);
});

test('enter on a choice row confirms the toggles, including an empty selection', () => {
  const cfg = config();
  const empty = stepMultiSelect(createMultiSelectState(cfg), 'confirm', cfg);
  assert.deepEqual(empty.outcome, { kind: 'selected', labels: [] });
  const some = stepMultiSelect(feed(createMultiSelectState(cfg), ['toggle', 'down', 'toggle'], cfg), 'confirm', cfg);
  assert.deepEqual(some.outcome, { kind: 'selected', labels: ['alpha', 'beta'] });
});

test('enter on the Other row requests the free-text path', () => {
  const cfg = config();
  const onOther = feed(createMultiSelectState(cfg), ['up'], cfg);
  assert.deepEqual(stepMultiSelect(onOther, 'confirm', cfg).outcome, { kind: 'other' });
});

test('a single-option confirm returns that option', () => {
  const cfg = config({ options: [{ label: 'only' }] });
  assert.deepEqual(stepMultiSelect(createMultiSelectState(cfg), 'confirm', cfg).outcome, {
    kind: 'selected',
    labels: ['only'],
  });
});

test('escape cancels and empty configurations stay safe', () => {
  const cfg = config();
  assert.deepEqual(stepMultiSelect(createMultiSelectState(cfg), 'cancel', cfg).outcome, { kind: 'cancel' });
  const noOptions: MultiSelectConfig = { options: [], allowOther: false };
  assert.deepEqual(stepMultiSelect(createMultiSelectState(noOptions), 'cancel', noOptions).outcome, { kind: 'cancel' });
  assert.equal(stepMultiSelect(createMultiSelectState(noOptions), 'down', noOptions).outcome, undefined);
});

test('fallbackKeyMatcher understands arrows, esc, vim keys and space', () => {
  assert.equal(fallbackKeyMatcher('\x1b[A', 'up'), true);
  assert.equal(fallbackKeyMatcher('\x1bOA', 'up'), true);
  assert.equal(fallbackKeyMatcher('\x1b[B', 'down'), true);
  assert.equal(fallbackKeyMatcher('k', 'up'), true);
  assert.equal(fallbackKeyMatcher(' ', 'toggle'), true);
  assert.equal(fallbackKeyMatcher('\r', 'confirm'), true);
  assert.equal(fallbackKeyMatcher('\x1b', 'cancel'), true);
  assert.equal(fallbackKeyMatcher('x', 'cancel'), false);
});

test('multiSelectLines marks the cursor, toggles, recommendation and description', () => {
  const cfg = config({ recommended: 1 });
  const state = feed(createMultiSelectState(cfg), ['down', 'toggle'], cfg);
  const lines = multiSelectLines(state, cfg, plain);
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /^ {2}\[ \] alpha$/);
  assert.match(lines[1]!, /^> \[x\] beta \(Recommended\) — second$/);
  assert.match(lines[3]!, /Other \(type your own\)/);
});

test('multiSelectLines hides the Other row when allowOther is false', () => {
  const cfg = config({ allowOther: false });
  const lines = multiSelectLines(createMultiSelectState(cfg), cfg, plain);
  assert.equal(lines.length, 3);
  assert.equal(lines.some((l) => /Other/.test(l)), false);
});

test('multiSelectFooter reports the selection count', () => {
  const cfg = config();
  const idle = multiSelectFooter(createMultiSelectState(cfg), cfg, plain);
  assert.match(idle, /space toggle/);
  assert.equal(/selected/.test(idle), false);
  const picked = multiSelectFooter(feed(createMultiSelectState(cfg), ['toggle'], cfg), cfg, plain);
  assert.match(picked, /1 selected/);
});

test('component: renders title, rows and footer, and clips to width', () => {
  let outcome: MultiSelectOutcome | null = null;
  const component = createMultiSelectComponent({
    title: 'Pick several',
    config: config(),
    theme: plain,
    matcher: fallbackKeyMatcher,
    done: (o) => { outcome = o; },
  });
  const lines = component.render(12);
  assert.equal(lines[0], 'Pick several');
  assert.equal(lines.length, 7); // title + 4 rows + spacer + footer
  for (const line of lines) assert.equal(styledWidth(line) <= 12, true);
  component.invalidate();
  assert.equal(outcome, null);
});

test('component: key sequences drive the state machine and finish once', () => {
  const outcomes: MultiSelectOutcome[] = [];
  let renders = 0;
  const component = createMultiSelectComponent({
    title: 'Q',
    config: config(),
    theme: plain,
    matcher: fallbackKeyMatcher,
    done: (o) => outcomes.push(o),
    requestRender: () => { renders += 1; },
  });
  component.handleInput('x'); // ignored
  component.handleInput(' ');
  component.handleInput('\x1b[B');
  component.handleInput(' ');
  component.handleInput('\r');
  component.handleInput(' '); // ignored after finish
  assert.deepEqual(outcomes, [{ kind: 'selected', labels: ['alpha', 'beta'] }]);
  assert.equal(renders, 4);
});

test('component: enter on the Other row finishes with the other outcome', () => {
  const outcomes: MultiSelectOutcome[] = [];
  const component = createMultiSelectComponent({
    title: 'Q',
    config: config(),
    theme: plain,
    matcher: fallbackKeyMatcher,
    done: (o) => outcomes.push(o),
  });
  component.handleInput('\x1b[A'); // wrap to the Other row
  component.handleInput('\r');
  assert.deepEqual(outcomes, [{ kind: 'other' }]);
});

test('runMultiSelect: bridges the component through ui.custom and forwards outcomes', async () => {
  const seen: { step: string }[] = [];
  const custom = async (factory: unknown): Promise<unknown> => {
    const done = (value: unknown): void => { seen.push({ step: JSON.stringify(value) }); };
    const component = (factory as (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (value: unknown) => void,
    ) => { handleInput(data: string): void })({ requestRender() {} }, plain, {}, done);
    component.handleInput(' ');
    component.handleInput('\r');
    return { kind: 'selected', labels: ['alpha'] };
  };
  const outcome = await runMultiSelect(custom, 'Q', config());
  assert.deepEqual(outcome, { kind: 'selected', labels: ['alpha'] });
  assert.deepEqual(seen, [{ step: JSON.stringify({ kind: 'selected', labels: ['alpha'] }) }]);
});

test('runMultiSelect: undefined from ui.custom (RPC mode) degrades to null', async () => {
  assert.equal(await runMultiSelect(async () => undefined, 'Q', config()), null);
  assert.equal(await runMultiSelect(async () => 'garbage', 'Q', config()), null);
});

/* ── ask_user_question integration ─────────────────────────────────── */

test('prepareAsk: allowOther defaults to true and can be turned off per question', () => {
  const base = prepareAsk({ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }] });
  assert.equal(base.ok, true);
  assert.equal(base.ok && base.spec.mode === 'questionnaire' && base.spec.questions[0]!.allowOther, true);

  const off = prepareAsk({ questions: [{ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }], allowOther: false }] });
  assert.equal(off.ok && off.spec.mode === 'questionnaire' && off.spec.questions[0]!.allowOther, false);
});

test('runAsk multi: uses the toggle list when ctx.ui.custom exists', async () => {
  const calls: string[] = [];
  const ui: AskUi = {
    input: async () => { calls.push('input'); return undefined; },
    custom: async (factory) => {
      calls.push('custom');
      const component = (factory as (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => { handleInput(d: string): void })(
        {}, plain, {}, () => {},
      );
      component.handleInput(' ');
      component.handleInput('\x1b[B');
      component.handleInput(' ');
      component.handleInput('\r');
      return { kind: 'selected', labels: ['a', 'b'] };
    },
  };
  const spec = prepareAsk({ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }], multi: true });
  assert.equal(spec.ok, true);
  const result = await runAsk(spec.ok ? spec.spec : { mode: 'freeform', question: '' }, ui);
  assert.equal(result.details.cancelled, false);
  assert.deepEqual(result.details.answers[0]!.selected, ['a', 'b']);
  assert.deepEqual(calls, ['custom']);
});

test('runAsk multi: the Other row opens a free-text input', async () => {
  const ui: AskUi = {
    input: async () => 'typed by hand',
    custom: async (factory) => {
      const component = (factory as (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => { handleInput(d: string): void })(
        {}, plain, {}, () => {},
      );
      component.handleInput('\x1b[A'); // Other row
      component.handleInput('\r');
      return { kind: 'other' };
    },
  };
  const spec = prepareAsk({ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }], multi: true });
  const result = await runAsk(spec.ok ? spec.spec : { mode: 'freeform', question: '' }, ui);
  assert.equal(result.details.answers[0]!.kind, 'custom');
  assert.equal(result.details.answers[0]!.customInput, 'typed by hand');
});

test('runAsk multi: esc declines the question', async () => {
  const ui: AskUi = {
    input: async () => 'unused',
    custom: async () => ({ kind: 'cancel' }),
  };
  const spec = prepareAsk({ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }], multi: true });
  const result = await runAsk(spec.ok ? spec.spec : { mode: 'freeform', question: '' }, ui);
  assert.equal(result.details.cancelled, true);
});

test('runAsk multi: without ctx.ui.custom the typed-index path still works', async () => {
  const answers: string[] = [];
  const ui: AskUi = {
    input: async () => { answers.push('input'); return '1,3'; },
  };
  const spec = prepareAsk({ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], multi: true });
  const result = await runAsk(spec.ok ? spec.spec : { mode: 'freeform', question: '' }, ui);
  assert.deepEqual(result.details.answers[0]!.selected, ['a', 'c']);
  assert.deepEqual(answers, ['input']);
});

test('runAsk multi: custom() present but returning undefined (RPC mode) falls back to typed indices', async () => {
  const calls: string[] = [];
  const ui: AskUi = {
    custom: async () => { calls.push('custom'); return undefined; },
    input: async () => { calls.push('input'); return '2'; },
  };
  const spec = prepareAsk({ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }], multi: true });
  const result = await runAsk(spec.ok ? spec.spec : { mode: 'freeform', question: '' }, ui);
  assert.deepEqual(result.details.answers[0]!.selected, ['b']);
  assert.deepEqual(calls, ['custom', 'input']);
});

test('runAsk multi: allowOther false rejects free text but keeps numeric parsing', async () => {
  let reply = 'not a number';
  const ui: AskUi = { input: async () => reply };
  const spec = prepareAsk({
    question: 'Pick',
    options: [{ label: 'a' }, { label: 'b' }],
    multi: true,
    allowOther: false,
  });
  const cancelled = await runAsk(spec.ok ? spec.spec : { mode: 'freeform', question: '' }, ui);
  assert.equal(cancelled.details.cancelled, true);

  reply = '2';
  const picked = await runAsk(spec.ok ? spec.spec : { mode: 'freeform', question: '' }, ui);
  assert.deepEqual(picked.details.answers[0]!.selected, ['b']);
});

test('single-select questions keep the select dialog and hide the Other row when allowOther is false', async () => {
  const titles: string[] = [];
  const ui: AskUi = {
    select: async (title: string) => { titles.push(title); return '2. b'; },
    input: async () => undefined,
  };
  const spec = prepareAsk({ question: 'Pick', options: [{ label: 'a' }, { label: 'b' }], allowOther: false });
  const result = await runAsk(spec.ok ? spec.spec : { mode: 'freeform', question: '' }, ui);
  assert.equal(result.details.answers[0]!.answer, 'b');
  assert.equal(/Other/.test(titles[0]!), false);
});

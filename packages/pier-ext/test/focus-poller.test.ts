/**
 * D-4：焦点轮询（herdr 0.9 鼠标焦点是客户端本地行为，pane.focused 不会到插件）。
 * 缝：采样解析 / 触发决策（变更 + 限流 + cause 区分点击与自动聚焦）/ 触发执行（子进程 + 事件载荷）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOCUS_FIRE_MIN_INTERVAL_MS,
  collectPaneIds,
  parseFocusSample,
  planFocusTick,
  reflowScriptPath,
  spawnReflow,
  startFocusPoller,
  isHerdr091OrLater,
  resolveDefaultFocusPollMs,
  type FocusPollerState,
  type FocusSample,
} from '../src/focus-poller.ts';

const sample = (focused: string | null, paneIds: string[]): FocusSample => ({ focusedPaneId: focused, paneIds });
const state = (focused: string | null, paneIds: string[], lastFireAt = 0): FocusPollerState => ({
  lastFocusedPaneId: focused,
  lastPaneIds: paneIds,
  lastFireAt,
});

test('collectPaneIds/parseFocusSample: 真实 layout.export 载荷（单 pane / 分屏 / 缺失 focus）', () => {
  // 实测形状（probe 2026-09-13）：{type:'layout_export', layout:{focused_pane_id, root:{type:'pane',pane_id}}}
  assert.deepEqual(collectPaneIds({ type: 'pane', pane_id: 'wD:p1' }), ['wD:p1']);
  assert.deepEqual(
    collectPaneIds({ type: 'split', first: { type: 'pane', pane_id: 'a' }, second: { type: 'split', first: { type: 'pane', pane_id: 'b' }, second: { type: 'pane', pane_id: 'c' } } }),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(collectPaneIds(null), []);
  assert.deepEqual(
    parseFocusSample({ root: { type: 'pane', pane_id: 'wD:p2' }, focusedPaneId: 'wD:p2' }),
    { focusedPaneId: 'wD:p2', paneIds: ['wD:p2'] },
  );
  // 老 herdr 不给 focused_pane_id → null（调用方据此静默），而不是把 root 里的 pane 当焦点
  assert.deepEqual(parseFocusSample({ root: { type: 'pane', pane_id: 'wD:p2' } }), { focusedPaneId: null, paneIds: ['wD:p2'] });
  assert.equal(parseFocusSample(null), null);
});

test('planFocusTick: 首次采样只记基线（启动即聚焦不得触发布局变化）', () => {
  const r = planFocusTick({ myPaneId: 'me', sample: sample('me', ['me']), prev: null, now: 1000 });
  assert.equal(r.fire, false);
  assert.equal(r.state.lastFocusedPaneId, 'me');
});

test('planFocusTick: 焦点转移到我 + 面板集合未变 ⇒ 判定人类点击（cause=user，绕过 3s 白名单）', () => {
  const r = planFocusTick({
    myPaneId: 'me',
    sample: sample('me', ['other', 'me']),
    prev: state('other', ['other', 'me']),
    now: 5000,
  });
  assert.equal(r.fire, true);
  assert.equal(r.cause, 'user');
  assert.equal(r.state.lastFireAt, 5000);
});

test('planFocusTick: 同一 tick 里新面板出现 ⇒ cause=null（spawn 自动聚焦不得抢布局，F1）', () => {
  const r = planFocusTick({
    myPaneId: 'me',
    sample: sample('me', ['other', 'me', 'fresh']),
    prev: state('other', ['other', 'me']),
    now: 5000,
  });
  assert.equal(r.fire, true);
  assert.equal(r.cause, null);
});

test('planFocusTick: 焦点在别处 / 焦点没变 / 空 paneId 都不触发', () => {
  assert.equal(planFocusTick({ myPaneId: 'me', sample: sample('other', ['me', 'other']), prev: state('me', ['me', 'other']), now: 9000 }).fire, false);
  // 持续聚焦：不重复触发（否则每个 tick 都会 spawn 一次 reflow）
  assert.equal(planFocusTick({ myPaneId: 'me', sample: sample('me', ['me']), prev: state('me', ['me'], 1000), now: 9000 }).fire, false);
  assert.equal(planFocusTick({ myPaneId: '', sample: sample('me', ['me']), prev: state('other', ['me']), now: 9000 }).fire, false);
  // 焦点在别处时也要推进基线（离开再回来算一次新转移）
  const away = planFocusTick({ myPaneId: 'me', sample: sample('other', ['me', 'other']), prev: state('me', ['me', 'other']), now: 9000 });
  assert.equal(away.state.lastFocusedPaneId, 'other');
});

test('planFocusTick: 限流窗口内的连点不重复 spawn', () => {
  const first = planFocusTick({ myPaneId: 'me', sample: sample('me', ['me', 'o']), prev: state('o', ['me', 'o']), now: 10_000 });
  assert.equal(first.fire, true);
  const again = planFocusTick({
    myPaneId: 'me',
    sample: sample('me', ['me', 'o']),
    prev: state('o', ['me', 'o'], first.state.lastFireAt),
    now: 10_000 + FOCUS_FIRE_MIN_INTERVAL_MS - 1,
  });
  assert.equal(again.fire, false);
  // 离开再回来且超过限流窗口 → 再次触发
  const later = planFocusTick({
    myPaneId: 'me',
    sample: sample('me', ['me', 'o']),
    prev: state('o', ['me', 'o'], first.state.lastFireAt),
    now: 10_000 + FOCUS_FIRE_MIN_INTERVAL_MS,
  });
  assert.equal(later.fire, true);
});

test('startFocusPoller: 采样→触发一次，且样本失败不推进基线', async () => {
  const samples: Array<FocusSample | Error> = [
    sample('other', ['me', 'other']),
    sample('me', ['me', 'other']),
    new Error('socket down'),
    sample('me', ['me', 'other']), // 失败后重采样：基线没被推进，仍是"新转移到 me"
  ];
  const fired: Array<{ paneId: string; cause: string | null }> = [];
  const errors: unknown[] = [];
  let clock = 1000;
  const poller = startFocusPoller({
    myPaneId: 'me',
    intervalMs: 0, // 手动 tick，避免测试里跑真定时器
    now: () => (clock += 1000),
    sample: async () => {
      const next = samples.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    },
    fire: (paneId, cause) => fired.push({ paneId, cause }),
    onError: (e) => errors.push(e),
  });
  for (let i = 0; i < 4; i += 1) await poller.tick();
  poller.stop();
  assert.deepEqual(fired, [{ paneId: 'me', cause: 'user' }]);
  assert.equal(errors.length, 1);
});

test('startFocusPoller: intervalMs=0 不注册定时器，stop() 幂等', async () => {
  const poller = startFocusPoller({
    myPaneId: 'me',
    intervalMs: 0,
    sample: async () => null,
    fire: () => { throw new Error('must not fire'); },
  });
  await poller.tick();
  poller.stop();
  poller.stop();
});

test('spawnReflow: 以 herdr 事件载荷调用 workbench 脚本（pane.focused + JSON + cause）', () => {
  const seen: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const fakeSpawn = ((cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    seen.push({ cmd, args, env: opts.env });
    return { on: () => {}, unref: () => {} };
  }) as unknown as typeof import('node:child_process').spawn;
  spawnReflow({ paneId: 'wD:p9', cause: 'user', env: { HERDR_SOCKET_PATH: '/tmp/x.sock' }, spawnFn: fakeSpawn });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.args.length, 1);
  assert.match(seen[0]!.args[0]!, /heat-reflow\.mjs$/);
  assert.equal(seen[0]!.env.HERDR_PLUGIN_EVENT, 'pane.focused');
  assert.equal(seen[0]!.env.HERDR_SOCKET_PATH, '/tmp/x.sock');
  assert.deepEqual(JSON.parse(String(seen[0]!.env.HERDR_PLUGIN_EVENT_JSON)), {
    event: 'pane_focused',
    type: 'pane_focused',
    data: { type: 'pane_focused', pane_id: 'wD:p9', cause: 'user' },
  });
});

test('reflowScriptPath: 默认指向同仓库的 workbench 脚本，可用 PIER_WORKBENCH_ROOT 覆盖', () => {
  const def = reflowScriptPath({});
  assert.match(def, /packages\/pier-workbench\/scripts\/heat-reflow\.mjs$/);
  assert.equal(reflowScriptPath({ PIER_WORKBENCH_ROOT: '/opt/wb' }), '/opt/wb/scripts/heat-reflow.mjs');
});

test('spawnReflow: spawn 抛错/子进程 error 事件都不得冒泡（焦点热力是舒适功能）', () => {
  const throwing = (() => { throw new Error('ENOENT'); }) as unknown as typeof import('node:child_process').spawn;
  spawnReflow({ paneId: 'p', cause: null, env: {}, spawnFn: throwing });
  const emitting = (() => ({
    on: (evt: string, cb: () => void) => { if (evt === 'error') cb(); },
    unref: () => {},
  })) as unknown as typeof import('node:child_process').spawn;
  spawnReflow({ paneId: 'p', cause: null, env: {}, spawnFn: emitting });
  assert.ok(true);
});

test('Herdr 0.9.1 adaptive cadence: isHerdr091OrLater and resolveDefaultFocusPollMs', () => {
  assert.equal(isHerdr091OrLater('0.9.1'), true);
  assert.equal(isHerdr091OrLater('0.9.1-preview'), true);
  assert.equal(isHerdr091OrLater('0.9.2'), true);
  assert.equal(isHerdr091OrLater('0.10.0'), true);
  assert.equal(isHerdr091OrLater('1.0.0'), true);

  assert.equal(isHerdr091OrLater('0.9.0'), false);
  assert.equal(isHerdr091OrLater('0.8.2'), false);
  assert.equal(isHerdr091OrLater(''), false);
  assert.equal(isHerdr091OrLater(null), false);
  assert.equal(isHerdr091OrLater(undefined), false);

  assert.equal(resolveDefaultFocusPollMs('0.9.1'), 8000);
  assert.equal(resolveDefaultFocusPollMs('0.9.0'), 1500);
  assert.equal(resolveDefaultFocusPollMs(null), 1500);
});

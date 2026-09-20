/**
 * P0（RFC docs/rfc-pi-0.86-dynamic-tools.md §4）：可变角色状态与切换纯逻辑。
 * 缝：
 *  - latestRoleManifestRecord / manifestFromRecord —— resume 重放（分支扫描最后一条 role-manifest entry）
 *  - roleRecordDiffers —— 变更才写（session_start 无条件写会把"最后一条"覆盖回 env 值，破坏重放）
 *  - planRoleSwitch —— 放宽判定（人经 /pier-role 放宽需 confirm；master 自由）
 *  - planSwitchActiveTools —— 以注册全集为论域：切换可"找回"此前被 D77 裁掉的工具
 *    （planActiveTools 的交集语义做不到，这是两个函数并存的原因）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialRoleState,
  latestRoleManifestRecord,
  manifestFromRecord,
  planRoleSwitch,
  planSwitchActiveTools,
  roleRecordDiffers,
} from '../src/role-state.ts';
import type { RuntimeRoleManifest } from '../src/tool-gate.ts';

const WORKER: RuntimeRoleManifest = {
  role: 'worker-default',
  version: '1.0.0',
  tools: ['read', 'bash', 'grep', 'todo_write', 'ask_user_question'],
  permissions: { '*': 'allow' },
  unknownTools: 'deny',
};

function roleEntry(data: unknown): unknown {
  return { type: 'custom', customType: 'pi-herdr.role-manifest', data };
}

/* ── latestRoleManifestRecord / manifestFromRecord（resume 重放） ── */

test('重放：取最后一条 role-manifest entry；无关/畸形 entry 跳过不致命', () => {
  const entries = [
    roleEntry({ version: 1, role: 'worker-default', tools: ['read'], permissions: {}, unknownTools: 'deny' }),
    { type: 'message', role: 'user' },
    { type: 'custom', customType: 'pi-herdr.todo-edit', data: { edits: [] } },
    { type: 'custom', customType: 'pi-herdr.role-manifest', data: { role: 42 } }, // 畸形：role 非字符串
    roleEntry({
      version: 1,
      role: 'reviewer',
      tools: ['read', 'grep'],
      permissions: { write: 'deny' },
      unknownTools: 'allow',
      guidelines: ['bash 只用于运行测试'],
      origin: 'switch',
      switchedBy: 'p-master',
      ts: 123,
    }),
  ];
  const rec = latestRoleManifestRecord(entries);
  assert.equal(rec?.role, 'reviewer');
  assert.equal(rec?.origin, 'switch');
  assert.equal(rec?.switchedBy, 'p-master');
  assert.deepEqual(rec?.guidelines, ['bash 只用于运行测试']);
  // 畸形 entry 被跳过后，前面的合法 entry 仍然可见（不因一条脏数据丢掉全部重放）
  assert.equal(latestRoleManifestRecord([entries[3], { type: 'custom', customType: 'x', data: null }]), null);
  const onlyBad = latestRoleManifestRecord([entries[3]]);
  assert.equal(onlyBad, null);
});

test('重放：guidelines 非字符串项被滤除；缺省字段回退默认', () => {
  const rec = latestRoleManifestRecord([
    roleEntry({ role: 'r', tools: ['read'], permissions: 'not-an-object', guidelines: ['ok', 7, null], unknownTools: 'weird' }),
  ]);
  assert.ok(rec);
  assert.deepEqual(rec.guidelines, ['ok']);
  assert.deepEqual(rec.permissions, {});
  assert.equal(rec.unknownTools, 'deny');
  const m = manifestFromRecord(rec);
  assert.equal(m.role, 'r');
  assert.deepEqual(m.tools, ['read']);
  assert.deepEqual(m.guidelines, ['ok']);
});

test('重放：空 guidelines 归一为 undefined（section 注入按缺省处理）', () => {
  const rec = latestRoleManifestRecord([roleEntry({ role: 'r', tools: ['read'], guidelines: [] })]);
  assert.ok(rec);
  assert.equal(rec.guidelines, undefined);
  assert.equal(manifestFromRecord(rec).guidelines, undefined);
});

/* ── roleRecordDiffers（变更才写） ── */

test('变更才写：null 记录 → 写；同 role+tools → 不写；tools 变化 → 写', () => {
  const state = initialRoleState(WORKER);
  assert.equal(roleRecordDiffers(null, state), true, '首启无记录必须写锚点');
  assert.equal(
    roleRecordDiffers({ version: 1, role: 'worker-default', tools: [...WORKER.tools], permissions: {}, unknownTools: 'deny' }, state),
    false,
    'resume 未切换：最后一条与 env 一致，不重复写',
  );
  assert.equal(
    roleRecordDiffers({ version: 1, role: 'reviewer', tools: ['read'], permissions: {}, unknownTools: 'deny' }, state),
    true,
    'env 与最后一条不同（切换过）→ 写',
  );
  assert.equal(roleRecordDiffers({ version: 1, role: 'worker-default', tools: ['read'], permissions: {}, unknownTools: 'deny' }, state),
    true, '同 role 但 tools 不同（档案演进）→ 写');
});

/* ── planRoleSwitch（放宽判定） ── */

test('切换计划：目标新增工具即 widening（人需 confirm 的场景）；added/removed 差集正确', () => {
  // 当前角色 ['read','grep']，目标 ['read','grep','bash'] → 新增 bash = 放宽
  const widen = planRoleSwitch(['read', 'grep'], ['read', 'grep', 'bash']);
  assert.equal(widen.widening, true);
  assert.deepEqual(widen.added, ['bash']);
  assert.deepEqual(widen.removed, []);
  // 收缩：目标为当前真子集 → 无新增 = 不触发 confirm
  const narrow = planRoleSwitch(['read', 'bash', 'edit'], ['read', 'bash']);
  assert.equal(narrow.widening, false);
  assert.deepEqual(narrow.added, []);
  assert.deepEqual(narrow.removed, ['edit']);
});

test('切换活动集：能找回被 D77 裁掉的工具（这是与 planActiveTools 并存的原因）', () => {
  // 场景：worker-default（无 edit/write）已按 D77 裁剪 active；切换到允许 edit 的角色。
  // current active = ['read','bash','grep','todo_write','ask_user_question']（无 edit）
  // 若用 planActiveTools(newTools, currentActive) 交集会丢 edit；这里以注册全集为论域。
  const registered = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'todo_write', 'ask_user_question', 'subagent'];
  const next = planSwitchActiveTools(['read', 'bash', 'edit', 'todo_write', 'ask_user_question'], registered);
  assert.deepEqual(next, ['read', 'bash', 'edit', 'todo_write', 'ask_user_question'], 'edit 被找回，且按注册顺序');
});
test('切换活动集：allow 姿态保留全部注册工具（仅去显式 deny）——master/D82 轴与 session_start 同语义', () => {
  const registered = ['read', 'bash', 'web_search', 'subagent', 'todo_write'];
  const next = planSwitchActiveTools(
    ['read', 'bash'], // manifest 不含 web_search/subagent
    registered,
    { unknownTools: 'allow', permissions: { subagent: 'deny' } },
  );
  assert.deepEqual(next, ['read', 'bash', 'web_search', 'todo_write'], '未知工具保留，仅 deny 被剔除');
});

test('切换活动集：论域外（未注册）的 manifest 工具被忽略；空交集原样返回', () => {
  assert.deepEqual(planSwitchActiveTools(['read', 'ghost_tool'], ['read', 'bash']), ['read']);
  assert.deepEqual(planSwitchActiveTools(['nope'], ['read', 'bash']), []);
});

/* ── initialRoleState ── */

test('初始状态：env 来源，无切换痕迹；bare pi 为 null manifest', () => {
  const s = initialRoleState(WORKER);
  assert.equal(s.manifest?.role, 'worker-default');
  assert.equal(s.origin, 'env');
  assert.equal(s.switchedBy, null);
  assert.equal(s.switchedAt, null);
  const bare = initialRoleState(null);
  assert.equal(bare.manifest, null);
});

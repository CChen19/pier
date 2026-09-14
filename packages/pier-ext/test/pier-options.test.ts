/**
 * B10：环境变量命名。canonical 是 `PIER_*`，历史 `PI_HERDR_*` 作为别名继续可用；
 * `PI_HERDR_SUBAGENT`/`_ROLE_MANIFEST`/`_TUI`/`_META_KEY` 是父进程交给子进程的契约，不在此列。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PIER_OPTIONS, formatOptionRows, pierOption, pierOptionRows } from '../src/pier-options.ts';
import { createRuntimePolicy } from '../src/runtime-policy.ts';
import {
  POSIX_PROMPT,
  POWERSHELL_PROMPT,
  promptStrategyFor,
  terminalIdleMs,
  terminalReminderGraceMs,
} from '../src/terminal-core.ts';

test('pierOption: canonical 优先，legacy 兜底，空串视为未设置', () => {
  assert.equal(pierOption('PIER_GIT_TIMEOUT_MS', { PIER_GIT_TIMEOUT_MS: '5000' }), '5000');
  assert.equal(pierOption('PIER_GIT_TIMEOUT_MS', { PI_HERDR_GIT_TIMEOUT_MS: '7000' }), '7000');
  // canonical 为空串时不算设置（shell 里 export X= 很常见），legacy 仍可救回
  assert.equal(pierOption('PIER_GIT_TIMEOUT_MS', { PIER_GIT_TIMEOUT_MS: '  ', PI_HERDR_GIT_TIMEOUT_MS: '9' }), '9');
  assert.equal(pierOption('PIER_GIT_TIMEOUT_MS', {}), undefined);
  // 目录外的名字按原名读（没有别名可回退）
  assert.equal(pierOption('NOT_AN_OPTION', { NOT_AN_OPTION: 'x' }), 'x');
});

test('pierOptionRows/formatOptionRows: 标出来源（env / env(legacy) / default）', () => {
  const rows = pierOptionRows({ PI_HERDR_SLIM_FRAME: '0' });
  const slim = rows.find((r) => r.name === 'PIER_SLIM_FRAME');
  assert.equal(slim?.value, '0');
  assert.equal(slim?.source, 'legacy-env');
  const rows2 = pierOptionRows({ PIER_SLIM_FRAME: '1', PI_HERDR_SLIM_FRAME: '0' });
  assert.equal(rows2.find((r) => r.name === 'PIER_SLIM_FRAME')?.source, 'env', 'canonical 压过 legacy');
  const lines = formatOptionRows({});
  assert.equal(lines.length, PIER_OPTIONS.length);
  assert.match(lines[0]!, /^\s+PIER_[A-Z_]+ = .+\(default\)/);
});

test('runtime policy 与 terminal prompt 都接受 legacy 前缀', () => {
  // legacy 名字通过 pierOption 生效（进程级 env：createRuntimePolicy 读 process.env）
  const prev = process.env.PI_HERDR_GIT_TIMEOUT_MS;
  process.env.PI_HERDR_GIT_TIMEOUT_MS = '4321';
  try {
    assert.equal(createRuntimePolicy().gitTimeoutMs, 4321);
  } finally {
    if (prev === undefined) delete process.env.PI_HERDR_GIT_TIMEOUT_MS;
    else process.env.PI_HERDR_GIT_TIMEOUT_MS = prev;
  }

  assert.equal(promptStrategyFor({ PI_HERDR_TERMINAL_PROMPT: 'powershell' }), POWERSHELL_PROMPT);
  assert.equal(promptStrategyFor({ PIER_TERMINAL_PROMPT: 'powershell', PI_HERDR_TERMINAL_PROMPT: 'bash' }), POWERSHELL_PROMPT);
  assert.equal(promptStrategyFor({ PIER_TERMINAL_PROMPT: 'bash' }), POSIX_PROMPT);
});

test('B10 收口：terminal/todo/slim-frame/HMR 的读取点都走 catalog（legacy 名仍生效）', () => {
  // 目录里必须登记这些键，且都带 legacy 别名（旧 shell 脚本不能失效）
  for (const name of ['PIER_TERM_IDLE_MS', 'PIER_TERM_GRACE_MS', 'PIER_TERM_READ_MAX', 'PIER_TODO_GRACE_MS', 'PIER_HMR']) {
    const spec = PIER_OPTIONS.find((o) => o.name === name);
    assert.ok(spec, `${name} 应在目录中`);
    assert.ok(spec!.legacy?.startsWith('PI_HERDR_'), `${name} 应保留 legacy 别名`);
  }
  const prev = process.env.PI_HERDR_TERM_IDLE_MS;
  process.env.PI_HERDR_TERM_IDLE_MS = '1234';
  process.env.PIER_TERM_GRACE_MS = '4321';
  try {
    assert.equal(terminalIdleMs(), 1234, 'legacy 名生效');
    assert.equal(terminalReminderGraceMs(), 4321, 'canonical 名生效');
  } finally {
    delete process.env.PIER_TERM_GRACE_MS;
    if (prev === undefined) delete process.env.PI_HERDR_TERM_IDLE_MS;
    else process.env.PI_HERDR_TERM_IDLE_MS = prev;
  }
});

test('B10 护栏：PIER_* 注册表与 /pier-config 目录不得再漂移（数字默认值必须等于运行时值）', async () => {
  const { CONFIG_KNOBS } = await import('../src/config-catalog-core.ts');
  const { createRuntimePolicy } = await import('../src/runtime-policy.ts');
  const env = CONFIG_KNOBS.filter((k) => k.plane === 'env');
  const catalogNames = new Set(env.flatMap((k) => [k.key, ...(k.aliases ?? [])]));
  const registryNames = new Set(PIER_OPTIONS.flatMap((o) => [o.name, ...(o.legacy ? [o.legacy] : [])]));

  // 1. 两个注册表说的是同一批名字（canonical + legacy 别名并集）
  assert.deepEqual([...registryNames].filter((n) => !catalogNames.has(n)), [], 'registry 里有目录未登记的名字');
  assert.deepEqual([...catalogNames].filter((n) => !registryNames.has(n)), [], '目录里有 registry 未登记的名字');

  // 2. 数字默认值三方一致：目录条目 = registry fallback = 运行时值。
  //    这三处曾经各不相同（GIT_TIMEOUT 120000/10000、SUBAGENT_TIMEOUT 300000/600000、
  //    POLL_INTERVAL 5000/30000），而 /pier-config doctor 显示的是 registry 那个数。
  // 构造实例而不是读单例：单例在 import 期就固化了 process.env（测试进程里可能被别处改过）。
  const runtime = createRuntimePolicy() as unknown as Record<string, number>;
  const runtimeByKnob: Record<string, number> = {
    PIER_SUBAGENT_TIMEOUT_MS: runtime.subagentTimeoutMs,
    PIER_GC_TICK_MS: runtime.gcTickMs,
    PIER_POLL_INTERVAL_MS: runtime.pollIntervalMs,
    PIER_SETTLEMENT_WINDOW_MS: runtime.settlementWindowMs,
    PIER_OBSERVATION_WINDOW_MS: runtime.observationWindowMs,
    PIER_FOREGROUND_PATIENCE_MS: runtime.foregroundPatienceMs,
    PIER_SESSION_TTL_SECONDS: runtime.sessionTtlSeconds,
    PIER_GIT_TIMEOUT_MS: runtime.gitTimeoutMs,
    PIER_READY_TIMEOUT_MS: runtime.readinessTimeoutMs,
  };
  for (const [name, value] of Object.entries(runtimeByKnob)) {
    assert.equal(env.find((k) => k.key === name)?.defaultValue, value, `${name}：目录默认值应等于运行时值`);
    assert.equal(PIER_OPTIONS.find((o) => o.name === name)?.fallback, String(value), `${name}：registry fallback 应等于运行时值`);
  }
  // 3. 目录里每个 canonical 名都必须是 PIER_*（canonical 前缀规则，legacy 只能出现在 aliases）
  for (const knob of env) {
    assert.match(knob.key, /^PIER_/, `${knob.key} 应是 canonical 名`);
    for (const alias of knob.aliases ?? []) assert.match(alias, /^PI_HERDR_/, `${alias} 应是 legacy 名`);
  }
});

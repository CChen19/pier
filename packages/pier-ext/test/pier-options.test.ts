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

/**
 * storage-layout: collision-resistant session encoding + dual-read migration.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  historyFilePath,
  historyFilePathLegacy,
  preferredHistoryFile,
  piCoreSessionDirName,
  piSessionDirCandidates,
  preferredSessionDir,
  sessionDirCandidates,
  sessionDirName,
  sessionDirNameLegacy,
  userRolesDir,
  workspaceRolesDir,
} from '../src/storage-layout.ts';
import { sessionDirName as sessionDirNameReexport } from '../src/session-tail.ts';
import { historyFilePath as historyFilePathReexport } from '../src/history-store.ts';
import { userRolesDir as userRolesDirReexport } from '../src/role-loader.ts';

test('sessionDirName: percent-encodes separators so a/b ≠ a-b', () => {
  assert.equal(sessionDirName('a/b'), '--a%2Fb--');
  assert.equal(sessionDirName('a-b'), '--a-b--');
  assert.notEqual(sessionDirName('a/b'), sessionDirName('a-b'));
  assert.equal(sessionDirName('F:\\herdr-pi'), '--F%3A%5Cherdr-pi--');
  assert.equal(sessionDirName('/home/u/proj'), '--%2Fhome%2Fu%2Fproj--');
  assert.equal(sessionDirName('a%b/c'), '--a%25b%2Fc--');
});

test('sessionDirNameLegacy: old flattening kept for dual-read', () => {
  assert.equal(sessionDirNameLegacy('F:\\herdr-pi'), '--F--herdr-pi--');
  assert.equal(sessionDirNameLegacy('/home/u/proj'), '---home-u-proj--');
  assert.equal(sessionDirNameLegacy('a/b'), sessionDirNameLegacy('a-b'));
});

test('sessionDirCandidates: new encoding first, then legacy', () => {
  assert.deepEqual(sessionDirCandidates('F:\\herdr-pi'), [
    '--F%3A%5Cherdr-pi--',
    '--F--herdr-pi--',
  ]);
});

test('historyFilePath: canonical write path uses new encoding', () => {
  assert.equal(
    historyFilePath('C:\\home\\.pi\\agent', 'F:\\herdr-pi'),
    join('C:\\home\\.pi\\agent', 'herdr-pi', 'history', '--F%3A%5Cherdr-pi--', 'history.jsonl'),
  );
});

test('preferredHistoryFile: existing legacy ledger wins over missing new dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'pier-hist-mig-'));
  try {
    const cwd = 'F:\\herdr-pi';
    assert.equal(preferredHistoryFile(root, cwd), historyFilePath(root, cwd));
    const legacy = historyFilePathLegacy(root, cwd);
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, '{}\n');
    assert.equal(preferredHistoryFile(root, cwd), legacy);
    const next = historyFilePath(root, cwd);
    mkdirSync(dirname(next), { recursive: true });
    writeFileSync(next, '{}\n');
    assert.equal(preferredHistoryFile(root, cwd), next);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preferredSessionDir: missing both → new encoding', () => {
  const parent = join(tmpdir(), 'pier-no-such-session-parent');
  assert.equal(preferredSessionDir(parent, 'a/b'), join(parent, '--a%2Fb--'));
});

test('userRolesDir: ~/.pi/agent/herdr-pi/roles (legacy layout, not XDG)', () => {
  assert.equal(userRolesDir(), join(homedir(), '.pi', 'agent', 'herdr-pi', 'roles'));
});

test('workspaceRolesDir: <base>/.pi-herdr/roles', () => {
  assert.equal(workspaceRolesDir('/repo'), join('/repo', '.pi-herdr', 'roles'));
});

test('re-exports stay stable for existing importers', () => {
  assert.equal(sessionDirNameReexport, sessionDirName);
  assert.equal(historyFilePathReexport, historyFilePath);
  assert.equal(userRolesDirReexport, userRolesDir);
});

/* ──────────── A8：pi core 自有 session 目录名（读 pi 会话必须对齐它，而不是 pier 的编码） ──────────── */

test('piCoreSessionDirName: 与 pi core 逐字节一致（本机实证样例）', () => {
  // pi core（dist/migrations.js:102）: `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  // 与 `~/.pi/agent/sessions/` 下真实目录名对齐：
  assert.equal(piCoreSessionDirName('/Users/yehaoyu/Documents/pier'), '--Users-yehaoyu-Documents-pier--');
  assert.equal(
    piCoreSessionDirName('/Users/yehaoyu/.herdr/worktrees/pier/pier-fix-batch-0-regressions-a7-a8-b1-a11'),
    '--Users-yehaoyu-.herdr-worktrees-pier-pier-fix-batch-0-regressions-a7-a8-b1-a11--',
  );
  // Windows：只有一个开头分隔符被剥离（盘符前没有分隔符，等价于 pier 的 legacy 形态）
  assert.equal(piCoreSessionDirName('F:\\herdr-pi'), '--F--herdr-pi--');
  // `%` 不转义（这正是旧实现 POSIX 全落空的原因：pier 新版编成了 %2F）
  assert.equal(piCoreSessionDirName('/a%2Fb'), '--a%2Fb--');
  assert.notEqual(piCoreSessionDirName('/home/u/proj'), sessionDirName('/home/u/proj'));
  assert.notEqual(piCoreSessionDirName('/home/u/proj'), sessionDirNameLegacy('/home/u/proj'));
});

test('piSessionDirCandidates: pi core 名在前，pier 旧编码兜底且去重', () => {
  assert.deepEqual(piSessionDirCandidates('/home/u/proj'), [
    '--home-u-proj--',
    '--%2Fhome%2Fu%2Fproj--',
    '---home-u-proj--',
  ]);
  // Windows 上 pi core 名与 legacy 相同 → 不重复
  assert.deepEqual(piSessionDirCandidates('F:\\herdr-pi'), ['--F--herdr-pi--', '--F%3A%5Cherdr-pi--']);
});

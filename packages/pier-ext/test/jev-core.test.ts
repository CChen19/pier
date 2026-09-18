/**
 * jev 决策层纯核单测（RFC docs/rfc-jev-integration.md）。
 * 缝：parseJevAnswers 严格校验、三个接入点的纯判定/合成、
 * 以及 P0-3「middle 缺席 = 逐字节旧布局」护栏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIAGNOSTIC_OUTPUT_MIN_NOUL,
  NOTICE_RANK_MIN_CONFIDENCE,
  buildExcerptWindows,
  composeNoticeRanking,
  diagnosticGateRequest,
  evaluateDiagnosticGate,
  evaluateExcerptPick,
  excerptPickRequest,
  noticeRankRequest,
  parseJevAnswers,
  type JevAnswer,
} from '../src/jev-core.ts';
import { formatObservationPlaceholder } from '../src/observation-core.ts';

// ---------------------------------------------------------------------------
// parseJevAnswers
// ---------------------------------------------------------------------------

const VALID_RAW = {
  model: 'jev-1.13.0',
  answers: {
    kind: { type: 'choice', choice: 'build_test_run', probabilities: { build_test_run: 0.9, other: 0.1 }, confidence: 0.9 },
    urgent: { type: 'noul', noul: 0.8 },
    grade: { type: 'score', score: 1.5, probabilities: { '0': 0.2, '1': 0.3, '2': 0.5 }, confidence: 0.7 },
  },
  usage: { input_tokens: 120, output_tokens: 12 },
};

test('parseJevAnswers：合法响应解析为类型化答案', () => {
  const parsed = parseJevAnswers(VALID_RAW, ['kind', 'urgent', 'grade']);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.model, 'jev-1.13.0');
  assert.equal(parsed.usage.inputTokens, 120);
  assert.equal(parsed.answers.kind!.type, 'choice');
  assert.equal(parsed.answers.urgent!.type, 'noul');
});

test('parseJevAnswers：缺答案/越界 noul/坏 usage/非对象各拒绝', () => {
  assert.equal(parseJevAnswers(VALID_RAW, ['kind', 'missing']).ok, false);
  const badNoul = structuredClone(VALID_RAW);
  badNoul.answers.urgent.noul = 1.5;
  assert.equal(parseJevAnswers(badNoul, ['urgent']).ok, false);
  const badUsage = structuredClone(VALID_RAW);
  badUsage.usage = { input_tokens: -1, output_tokens: 0 };
  assert.equal(parseJevAnswers(badUsage, ['kind']).ok, false);
  assert.equal(parseJevAnswers('nope', ['kind']).ok, false);
});

// ---------------------------------------------------------------------------
// P0-1 诊断门
// ---------------------------------------------------------------------------

test('diagnosticGateRequest：state 只含命令行，问题为英文封闭集', () => {
  const request = diagnosticGateRequest('deno test --allow-read');
  assert.deepEqual(request.state, { command: 'deno test --allow-read' });
  assert.deepEqual(Object.keys(request.questions).sort(), ['cmd_kind', 'diagnostic_output']);
});

function gateAnswers(choice: string, confidence: number, noul: number): Record<string, JevAnswer> {
  return {
    cmd_kind: { type: 'choice', choice, probabilities: { [choice]: 1 }, confidence },
    diagnostic_output: { type: 'noul', noul },
  };
}

test('evaluateDiagnosticGate：命中 / 非目标 / 低置信 / 非诊断输出', () => {
  const hit = evaluateDiagnosticGate(gateAnswers('build_test_run', 0.9, 0.95), 0.6);
  assert.equal(hit.hit, true);
  assert.deepEqual(
    { reason: hit.reason, confidence: hit.confidence, choice: hit.choice, noul: hit.noul },
    { reason: 'hit', confidence: 0.9, choice: 'build_test_run', noul: 0.95 },
  );
  assert.equal(evaluateDiagnosticGate(gateAnswers('install_deps', 0.99, 0.99), 0.6).hit, false);
  assert.equal(evaluateDiagnosticGate(gateAnswers('build_test_run', 0.5, 0.99), 0.6).reason, 'low-confidence');
  assert.equal(evaluateDiagnosticGate(gateAnswers('build_test_run', 0.9, DIAGNOSTIC_OUTPUT_MIN_NOUL - 0.01), 0.6).reason, 'non-diagnostic-output');
});

// ---------------------------------------------------------------------------
// P0-2 结算排序
// ---------------------------------------------------------------------------

function rankAnswers(scores: Array<[number, number, number]>): Record<string, JevAnswer> {
  const answers: Record<string, JevAnswer> = {};
  scores.forEach(([score, confidence, noul], i) => {
    answers[`notice_${i}_rank`] = { type: 'score', score, probabilities: {}, confidence };
    answers[`notice_${i}_fail`] = { type: 'noul', noul };
  });
  return answers;
}


test('noticeRankRequest：state 含 todo 文本（D1 决策：直接发送）与结算数组；指令按索引绑定', () => {
  const request = noticeRankRequest({ inProgressTodos: ['wire gate'], notices: ['a', 'b'] });
  assert.deepEqual(request.state, { in_progress_todos: ['wire gate'], settlements: ['a', 'b'] });
  assert.deepEqual(Object.keys(request.questions), ['notice_0_rank', 'notice_0_fail', 'notice_1_rank', 'notice_1_fail']);
  // Regression guard: keys are invisible to the model, so instructions must
  // reference settlements[i] explicitly or all notices collapse into one question.
  assert.match((request.questions.notice_1_rank as { instructions: string }).instructions, /settlements\[1\]/);
  assert.match((request.questions.notice_0_fail as { instructions: string }).instructions, /settlements\[0\]/);
});

test('composeNoticeRanking：按 0.6×score+0.4×noul 降序，平局保到达序', () => {
  // 归一化分值：0→0, 1→0.5, 2→1
  const order = composeNoticeRanking(3, rankAnswers([[0, 0.9, 0.1], [2, 0.9, 0.9], [0, 0.9, 0.1]]), 0.7);
  assert.deepEqual(order, [1, 0, 2]);
  const tie = composeNoticeRanking(2, rankAnswers([[1, 0.9, 0.5], [1, 0.9, 0.5]]), 0.7);
  assert.deepEqual(tie, [0, 1]);
});

test('composeNoticeRanking：单项低置信沉底不废批；全低置信 → null（fail-open）', () => {
  // #1 低置信(0.5)但高相关 → 沉底;#0 正常
  const one = composeNoticeRanking(2, rankAnswers([[1, 0.9, 0.5], [2, 0.5, 0.5]]), NOTICE_RANK_MIN_CONFIDENCE);
  assert.deepEqual(one, [0, 1]);
  // 全部低置信 → 整体回退到达序
  assert.equal(composeNoticeRanking(2, rankAnswers([[1, 0.5, 0.5], [1, 0.5, 0.5]]), NOTICE_RANK_MIN_CONFIDENCE), null);
  // 答案缺失 → null
  const partial = rankAnswers([[1, 0.9, 0.5]]);
  assert.equal(composeNoticeRanking(2, partial, 0.7), null);
});

test('composeNoticeRanking：失败钉住不变量——低分失败也压过高分例行', () => {
  // #0 高相关例行(score 2 / noul 0.1);#1 失败但相关分低(score 0 / noul 0.9)
  const order = composeNoticeRanking(2, rankAnswers([[2, 0.9, 0.1], [0, 0.9, 0.9]]), 0.7);
  assert.deepEqual(order, [1, 0], 'pinned failure leads regardless of score');
  // 边界:noul 恰在阈值上也钉住
  const edge = composeNoticeRanking(2, rankAnswers([[2, 0.9, 0.1], [0, 0.9, 0.7]]), 0.7);
  assert.deepEqual(edge, [1, 0]);
});

// ---------------------------------------------------------------------------
// P0-3 摘录选窗
// ---------------------------------------------------------------------------

function logWithMiddleFailure(): string {
  const head = Array.from({ length: 60 }, (_, i) => `setup line ${i}`).join('\n');
  const middle = ['ok case 1', 'ok case 2', 'Error: assertion failed in test_deep', '  at deep.ts:42', 'ok case 3'].join('\n');
  const tail = Array.from({ length: 60 }, (_, i) => `cleanup noise ${i}`).join('\n');
  return `${head}\n${middle}\n${tail}`;
}

test('buildExcerptWindows：首信号行窗口含错误行；无信号 → 空数组（不调 API）', () => {
  const windows = buildExcerptWindows(logWithMiddleFailure(), 512);
  assert.ok(windows.length >= 1);
  assert.equal(windows[0]!.id, 'first_signal');
  assert.ok(windows[0]!.text.includes('Error: assertion failed'));
  assert.equal(buildExcerptWindows('nothing wrong here\n'.repeat(100), 512).length, 0);
});

test('excerptPickRequest/evaluateExcerptPick：候选入选项；keep_head_tail 与低置信 → null', () => {
  const windows = buildExcerptWindows(logWithMiddleFailure(), 512);
  const request = excerptPickRequest(windows, 'head', 'tail');
  assert.ok(request !== null);
  const criteria = (request!.questions.window as { criteria: Record<string, string> }).criteria;
  assert.ok('keep_head_tail' in criteria && 'first_signal' in criteria);
  const pickAnswers: Record<string, JevAnswer> = {
    window: { type: 'choice', choice: 'first_signal', probabilities: {}, confidence: 0.8 },
  };
  assert.equal(evaluateExcerptPick(pickAnswers, 0.6), 'first_signal');
  const keep: Record<string, JevAnswer> = {
    window: { type: 'choice', choice: 'keep_head_tail', probabilities: {}, confidence: 0.9 },
  };
  assert.equal(evaluateExcerptPick(keep, 0.6), null);
  const low: Record<string, JevAnswer> = {
    window: { type: 'choice', choice: 'first_signal', probabilities: {}, confidence: 0.4 },
  };
  assert.equal(evaluateExcerptPick(low, 0.6), null);
  assert.equal(excerptPickRequest([], 'h', 't'), null);
});

// ---------------------------------------------------------------------------
// P0-3 占位符布局：middle 缺席必须逐字节等于旧实现
// ---------------------------------------------------------------------------

const PLACEHOLDER_INPUT = {
  id: 'obs_abc123def456abc123def456',
  toolName: 'bash',
  bytes: 65536,
  lines: 900,
  tokens: 16384,
  text: logWithMiddleFailure(),
  fullSends: 2,
  excerptBudget: 1024,
};

// Independent byte-math recomputation (not a call into completeLineExcerpt):
// head lines are 13/14 bytes -> lines 0..36 fit in the 512 budget (508B);
// tail lines are 16/17 bytes -> lines 30..59 fit (509B).
const EXPECTED_HEAD = `${Array.from({ length: 37 }, (_, i) => `setup line ${i}`).join('\n')}\n`;
const EXPECTED_TAIL = Array.from({ length: 30 }, (_, i) => `cleanup noise ${i + 30}`).join('\n');

const LEGACY_PLACEHOLDER = [
  '[large tool result replaced after its first 2 provider requests]',
  'id: obs_abc123def456abc123def456',
  'tool: bash',
  'original_bytes: 65536',
  'original_lines: 900',
  'estimated_tokens: 16384',
  'retrieve: call obs_recall with {"id":"obs_abc123def456abc123def456","offset":0}; continue with returned next_offset',
  '[first complete lines, up to 512 bytes]',
  EXPECTED_HEAD,
  '[middle omitted; last complete lines, up to 512 bytes]',
  EXPECTED_TAIL,
  '[65536 original bytes omitted; recall via obs_recall]',
].join('\n');

test('formatObservationPlaceholder：middle 缺席 → 与旧布局逐字节一致（jev 关闭护栏）', () => {
  assert.equal(formatObservationPlaceholder(PLACEHOLDER_INPUT), LEGACY_PLACEHOLDER);
});

test('formatObservationPlaceholder：middle 替换低信号半段，标签如实描述', () => {
  const withMiddle = formatObservationPlaceholder({
    ...PLACEHOLDER_INPUT,
    middle: { text: 'Error: assertion failed in test_deep\n  at deep.ts:42', label: 'first failure-signal region' },
  });
  assert.ok(withMiddle.includes('selected excerpt — first failure-signal region'));
  assert.ok(withMiddle.includes('Error: assertion failed in test_deep'));
  // 头尾两窗中信号少的一侧被替换：头部（setup 行，无信号）让位
  assert.ok(!withMiddle.includes('[first complete lines'));
  assert.ok(withMiddle.includes('[middle omitted; last complete lines'));
});

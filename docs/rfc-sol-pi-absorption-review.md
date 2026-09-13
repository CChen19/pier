# RFC 审阅意见与补充方案 —— `docs/rfc-sol-pi-absorption.md`

> **状态**: 首轮审阅意见（Review, draft 2026-09-12）；后续逐轮修复与验证记录见仓库根 `code review.md`（Round 1–4），未闭合项登记在 `docs/rfc-sol-pi-absorption.md` §9
> **审阅基线**: 本仓库 HEAD（`packages/pier-ext`）+ pi `0.84.2`（本机 `dist/` 与 `docs/`）+ 上游 `NVlabs/SoL-Pi`（已 clone 对照源码，非 README 转述）
> **配对文档**: `docs/rfc-sol-pi-absorption.md`（下文引用其 `§n`，行号见该文件 `grep -n '^#'`）

---

## 0. 结论摘要

RFC 的**方向是对的**，且有几处判断与上游/`pier` 现实一致，值得保留：

- 保留原生 `edit`/`write`、不劫持工具签名（上游 Action Fusion 会改写核心工具参数与返回格式；`pier` 还有 `index-locks.ts` 的分布式写锁与 D82 工具门禁，劫持代价更高）。
- ObservationPack 只改 `pi.on("context")` 投影、不动会话 JSONL（与上游同构）。
- EPR 做成进程内微过滤器、失败回退全文、默认全关（与上游"explicit opt-in"一致）。
- OCC 的时序（`turn_end` 判边界 → `abort` → `agent_settled` 里 `compact` → 注入续跑消息）**与上游已验证的顺序完全一致**，这点不用重设计。

但有四类问题必须先处理，否则落地会真出错或净亏：

| 级别 | 问题 | 影响 |
|---|---|---|
| P0 | EPR 不落盘原文，而 `tool_result` 改写**会持久化进会话** | "Evidence-Preserving" 名不副实，长日志原文永久丢失，且改写了权威历史 |
| P0 | 配置/日志路径 `<sessionDir>/herdr-pi/...` 在 `pier` 不存在 | 实现者会各写各的路径；resume/fork/多 pane 下互相踩 |
| P0 | OCC 缺 `nativeCompactionFeasible` 预检 | 会 abort 掉一轮之后报 `Nothing to compact (session too small)`，净亏一轮 |
| P0 | OCC 不检查 `hasPendingMessages()` | 交互模式下 `ctx.abort()` 会把用户中途 steer 的输入**弹回编辑器**（吞指令） |
| P1 | OCC 缺 cache 债务台账 + breakeven 公式（示例数字与任何公式都不自洽） | 连续压缩每次"看起来都划算"，实际反复重写缓存 |
| P1 | OBS 无缓存经济学（`pi` 的 `cache_control` 打在**最后一条消息**上 = 滚动前缀缓存） | 打包较早的消息可能"省 1 份读、花 1 整段写"，净亏；毛收益被当净收益记账 |
| P1 | EPR 未用 pi 的未截断输出（`fullOutputPath`） | 在 50KB/2000 行 preview 上做字节验真 → 可能对截断视图签发 `success` 收据（正是"隐藏证据"失败模式） |
| P1 | 无安全边界（项目级配置无条件生效、无密钥拦截、无权限位） | 恶意仓库可开启"把日志发给第三方模型"的外发通道 |
| P2 | `roles/reducer.json` 方案不可行 | role 校验强制 `manifest.tools` 含 `todo_write`+`ask_user_question`，且会让 `reducer` 成为可派发子代理角色 |

---

## 1. 事实校准（必须改的 8 条）

### 1.1 基线测试数是 545，不是 590

`§7 阶段一` 的"运行既有 590 个测试"不准。实测：

```bash
node --test "packages/pier-ext/test/*.test.ts"   # tests 545 / pass 545 / fail 0
```

`packages/pier-ext/test/` 有 59 个文件、约 602 个 `it(` 调用，但 runner 汇总为 545。

### 1.2 "无损压缩"是有损摘要

`§2 D100` 与 `§5.1` 用的"无损压缩"会误导评审：pi 的 compaction 是 **LLM 有损摘要**（见 `docs/compaction.md`：找切点 → 摘要 → 写 `CompactionEntry` → 丢弃被摘要区间）。建议措辞统一为「边界触发的原生压缩（有损摘要）+ 证据可回召」，并把"D101 会话 JSONL 物理不可变"与"OCC 会写 CompactionEntry"这两件事显式区分开（后者是**会话日志的正常增长**，不是不可变性的例外）。

### 1.3 API 名称与签名

- `§5.1` 写的 `context.abort()` / `context.compact(...)`：实际是 `ctx.abort()` / `ctx.compact(options?)`（`dist/core/extensions/types.d.ts:238,246`），`CompactOptions = { customInstructions?, onComplete?, onError? }`（同文件 `:200`）。
- 关键行为必须写进 RFC：**`ctx.compact()` 内部会先 `await this.abort()`，且"manual compaction never retries or continues the interrupted agent turn"**（`dist/core/agent-session.js` `compact()` 注释与实现）。所以 `turn_end` 里那次显式 `abort()` 是冗余的（无害，但要在文档里说明"真正的 abort 由 compact 内部完成"，否则实现者会以为要自己 abort 两次/担心竞争）。
- `agent_settled` 里调用 `ctx.compact()` 是安全的（它 fire-and-forget + 回调），但**不要在事件处理器里 `ctx.waitForIdle()`**（pi 明确警告会死锁，`docs/extensions.md:1128`）。

### 1.4 环境变量前缀违反仓库命名约定

`§4.3` 用 `PIER_*`；仓库既有约定是 `PI_HERDR_*`（`PI_HERDR_TRACE`、`PI_HERDR_ROLE_MANIFEST`、`PI_HERDR_TODO_GRACE_MS`、`PI_HERDR_TERM_READ_MAX`），且 `README.md:199` 明确"协议标识符保留 `pi-herdr` 前缀"。建议改名 `PI_HERDR_COMPACT_ENABLE` / `PI_HERDR_OBS_PACK_LOG` / `PI_HERDR_REDUCER_MODEL` …（保留环境变量覆盖确实是本地文化，与上游"no dedicated env vars"不同，这点保留）。

### 1.5 配置与日志路径不存在

`§4.4` 的 `<sessionDir>/herdr-pi/efficiency-logs/<mechanism>.jsonl` 在 `pier` 里没有对应概念：`pier` 的会话级目录是 `~/.pi/agent/herdr-pi/history/<encoded-cwd>/`（`src/storage-layout.ts:60`），pi 的会话目录是 `ctx.sessionManager.getSessionDir()`。**必须二选一写死**，建议照上游（`SoL-Pi/src/sol-pi/runtime-paths.ts`）：

```
<ctx.sessionManager.getSessionDir()>/herdr-pi/<sessionId>/
├── observation-pack/objects/obs_<hash24>.txt      # 0600
├── evidence-preserving-reducer/objects/<sha256>.txt
└── efficiency-logs/{compact,observation,reducer}.jsonl
```

理由：`getSessionDir()`/`getSessionId()` 都在 `ReadonlySessionManager` 的 Pick 列表里（`dist/core/session-manager.d.ts:140`），可稳定取得；按 sessionId 分层才能让 resume 复用、fork 重建。同时必须**对 sessionId 做安全字符校验**（上游 `/^[a-z0-9][a-z0-9._-]*$/i`）并对 `getSessionDir()` 缺失（print/RPC/无持久会话）做 fail-open。

### 1.6 `roles/reducer.json` 不可行

`§5.3 C` 与 `§6` 计划"新增内置角色 `src/roles/reducer.json`（只定义推荐模型）"。实际约束：

- `role-manifest.ts:54-56` 定义 `COORDINATION_TOOLS = ['todo_write','ask_user_question']`，校验器强制 `manifest.tools` 非空且必须包含这两个（`:110-120`），`additionalProperties:false`。所以"只写个模型名的 reducer 档案"会直接 `INVALID_ROLE_CONFIG`；为了过校验而塞假工具清单则是自欺。
- `role-loader.ts` 按名字加载 `src/roles/*.json`，`reducer` 会变成**可被 `subagent` 派发的角色**（且不在 `RESERVED_ROLE_NAMES` 里，会被 workspace/user 层文件覆盖 = 路由劫持面），与 `§5.3 A`"绝不引入子代理"自相矛盾。
- `model` 字段语义是 WS-D10「角色级派发路由」，由 spawn 注入 `--provider/--model`；复用它做进程内模型调用会污染语义。

→ 建议：**删掉 reducer 角色**，在能效配置里放一个 `models: { reducer?: "provider/model" }` 段（或 `evidencePreservingReducer.model`），单一事实来源。

### 1.7 文件名前后不一致

`§4.2` 标题写 `schemas/efficiency-config.json`，`§6` 文件树写 `schemas/efficiency-config.schema.json`。仓库约定是 `*.schema.json`（`schemas/role-manifest.schema.json`，且该 schema 的 `description` 明确"runtime 校验是手写零依赖实现，本文件是合同文档"）。照此办理。

### 1.8 "缺省继承当前会话模型"与上游相反，且经济上是自相矛盾的

`§5.3 C.2`："若未配置任何特定模型：自动读取当前会话的生效模型（`context.model`），开箱即用。"

上游是**反过来的**：`evidence-preserving-reducer/config.ts` 有 `DEFAULT_REDUCER_PROVIDER='openai-codex'` / `DEFAULT_REDUCER_MODEL='gpt-5.6-luna'`（专用快模型），`provider.ts` 用 `ctx.modelRegistry.find/complete` 直连该模型，参数 `cacheRetention:'none'`、`maxTokens≤2048`、`timeoutMs:90_000`。

用主力前沿模型做提炼的后果：

1. **省的钱变成花在同一档价格上**：提炼一次要付"整篇日志 × 输入价 + 收据输出价"，只换来"后续每轮少重放 `removedTokens × cacheRead 价`"。单轮任务下净收益 ≈ 0 甚至为负。
2. **延迟失控**：`pi.on("tool_result")` 是**串行中间件**（`docs/extensions.md:844-853`，`runner.js:693-744` 逐个 `await`），且返回的 `content` 会**整体替换**并持久化（`agent-session.js:247-270`）。`§5.3` 一边承诺"耗时 < 800ms"，一边把 `timeoutMs` 默认抄成 90s——自相矛盾；用带思考的前沿模型跑 40KB 日志很容易 10–60s，每个 `npm test` 都被拖住。

→ 建议：EPR **默认关闭且必须显式配置 reducer 模型**（或从 `ctx.modelRegistry` 里按 `cost` 自动挑"最便宜且可用"的模型，并在日志里记录所选模型与估算成本）；`timeoutMs` 默认压到 5s；`maxOutputTokens` / `cacheRetention:'none'` / `sessionId` 三个上游参数补进 schema。

---

## 2. 机制一 OCC：补齐 5 个上游已证实的守卫 + 明确公式

`§5.1` 的状态机骨架没问题，缺的是"什么时候**不许**压缩"和"钱怎么算"。上游 `online-context-compact/economics.ts` + `extension.ts` 已经把坑踩过一遍，建议直接对齐。

### 2.1 breakeven 公式必须写死（RFC 示例数字不自洽）

RFC `§4.4` 示例：`writeTokens 45000 / archiveTokens 22000 / memoTokens 1000 / ratio 12.5 → breakevenRequests 4.2`。用上游公式回算是 `45000 × (12.5-1) / 21000 = 24.6`，4.2 推不出来（任何合理公式都推不出）。**评审/后续调参依赖这些数字，不能是示意值。**

上游公式（建议照搬，已验证）：

```
incrementalCacheCostRatio = max(0, cacheWriteReadRatio - 1)     // 只算"写比读多花的那部分"
savingTokens              = archiveTokens - memoTokens
breakevenRequests         = writeTokens * incrementalCacheCostRatio / savingTokens
combinedBreakeven         = (carriedDebtTokens + writeTokens * incrementalCacheCostRatio) / savingTokens
```

两个反直觉但正确的点，必须写进注释，否则实现者会"顺手优化"错：

- 分子是 **`writeTokens`（整段重写）**，不是 `archiveTokens`。压缩的代价是"把新的前缀写一遍缓存"，跟被摘掉多少无关。
- ratio 要减 1：不压缩也要付一次 cache read，增量只是 write−read。

### 2.2 缺 cache 债务台账（`carriedDebtTokens`）

上游 `state.ts` 记录 `cacheDebtTokens / cacheDebtRepaymentTokens`：每次压缩把 `writeTokens × incrementalCacheCostRatio` 记成债务，之后每个请求用 `savingTokens` 还债，`recordProviderRequest` 里递减；**下一次压缩必须先清掉未偿债务**（`carriedDebtGateOpen`）。RFC 完全没有这个概念 → 连续两次边界压缩会各自"局部划算"，实际是把刚写好的缓存又扔掉一次。

### 2.3 缺首次/后续压缩的不对称与窗口保护

- `firstCompactionRequestScale = 2`：首次压缩把预期的剩余请求数放宽 2 倍（要建立摘要基线）；
- `subsequentCompactionMargin = 1.5`：后续压缩要求 `breakeven × 1.5 ≤ 剩余请求`；
- `windowProtection`：`contextTokens ≥ contextWindow - windowReserveTokens` 时**无条件**压缩（`§4.2` 有 `windowReserveTokens` 字段，但 `§5.1` 决策流程里从没用它 = 配置项悬空）；
- `horizon_unavailable` / `cache_ratio_unavailable` / `non_positive_saving` 这些**不压缩的显式理由**要进决策枚举（RFC 的 `reason` 只有 `"economic"` 一种，遥测里分不清"没压"是因为不划算还是没样本）。

顺带修正 `§2 D100` 的表述：应该说明"OCC 是**机会式**压缩，pi 原生阈值压缩仍是**安全网**"，两者关系（OCC 提前压；阈值压缩兜底；OCC 不应重复触发）要写清楚。

### 2.4 必须预检"压得动吗"（`nativeCompactionFeasible`）

上游在决定 `abort` 之前，用 `findCutPoint(pathWithAbortMarker, keepRecentTokens)` 模拟一次，确认 `historyMessages > 0 || prefixMessages > 0`；不满足就把决策改成 `native_not_compactable` 并**放弃 abort**。上游还特意插了一条合成的 `stopReason:'aborted'` assistant marker，因为切点判定依赖 turn 边界。

另外两点上游做不到、但 `pier` 要注意：

- manual 压缩路径**不读** `settings.compaction.enabled`（只有 `shouldCompact`/`_checkCompaction` 读，`dist/core/compaction/compaction.js:161`）。所以用户关掉自动压缩后，OCC 仍会强压 = 越权。要么尊重该设置（自行读 `~/.pi/agent/settings.json` + `<project>/.pi/settings.json`，`ctx` 不暴露 settings），要么在文档里显式声明"启用 OCC 即接管压缩时机"。
- `§4.2` 里的 `keepRecentTokens: 20000` / `windowReserveTokens: 16384` 与 pi 的 `compaction.keepRecentTokens` / `compaction.reserveTokens` **默认值完全相同**，属于复制式默认值 → 必然漂移。建议删掉这两个字段（改用 pi 的有效设置，或只保留自己的"触发经济学"参数）。

### 2.5 `abort` 会吞掉用户输入（必须加 `hasPendingMessages()` 守卫）

交互模式下扩展 `ctx.abort()` 的真实实现是：

```js
// dist/modes/interactive/interactive-mode.js  createContext().abort
abort: () => { this.restoreQueuedMessagesToEditor({ abort: true }); }
```

即**把已排队的消息吐回编辑器**。用户在长任务中途 steer 的一句话，会因为 OCC 在 `turn_end` abort 而回到输入框、不再自动发送。守卫：

```ts
if (ctx.hasPendingMessages()) { /* 本轮不压缩，等这轮 steer 消费完；或延后到下一个边界 */ }
```

上游对应的是 `pi.on("input")` 里对 `streamingBehavior !== "steer"` 的处理：**用户输入被视为"修正（correction）"，直接作废已选的压缩与全部统计样本**（`recordCorrection` 清空 `completedBoundaryRequestCounts`、cache 债务、epoch+1）。`pier` 也需要等价逻辑：`input` 事件（或 `agent_start` + 最后一次人类输入时间）→ 清样本、取消已选压缩。

### 2.6 状态必须持久化 + 分支/重置语义

RFC 全程 in-memory（`§7` 阶段三没有状态落盘项）。上游做法：

- `pi.appendEntry('sol-pi-online-context-state-v1', state)`，`session_start`/`session_tree` 时从 `getBranch()` 倒序恢复；
- `session_compact` 记录 epoch+/债务；`session_shutdown` 释放 continuation；
- `session_before_tree` 在压缩飞行中返回 `{ cancel: true }`。

`pier` 的对应物是 D38 的 `pi-herdr.todo-edit` 范式：效率状态应作为 custom entry 落进会话，并在 `rebuildFromBranch()`（`src/index.ts:111-118`）里一起恢复——否则 `/tree` 切换、`/resume`、HMR 重载后，`completedBoundaryRequestCounts` 与债务会错位，经济学输入直接失真。（注意：**高频 per-request 遥测仍然走 JSONL 文件**，不要用 `appendEntry` 写进会话，否则会话文件会被撑爆、resume 变慢。）

### 2.7 边界样本会被非模型来源污染

`todos.on('todo.completed')`（`src/todos-service.ts:74`）在以下路径都会触发，不只是"模型用 `todo_write` 推进了一步"：

- M17 结算自动对账：`reconcileOnSettlement` → `todos.applyEdits`（`src/index.ts:166-198`）；
- 人类 `/todos` 命令编辑（D38）；
- D39 归档清空：`plan.effect === 'archive-notice' && clearArchived` → `todos.replace([])`（`src/core/todo.ts:180-190`）。

这些会把"每步消耗多少请求"的样本污染成噪声。→ 建议 `emitCompletedTransitions` 带上 `source: 'tool' | 'reconcile' | 'human' | 'archive'`（或只在 `todo_write` 工具执行路径上发 `todo.completed {source:'tool'}`），经济学只吃 `source === 'tool'` 的样本，遥测里分列。

### 2.8 催办守卫要挂在**定时器触发时**，不只是决策输入

`§5.1 A.4` 提议给 `planStopTodoReminder` 输入加 `compactionInFlight`。但 `pier` 的停止催办是"settle 时判断 → `setTimeout(grace=30s)` 后才 `sendMessage(triggerTurn, followUp)`"（`src/core/todo.ts:227-262`，`todo-reminder-core.ts:29`）。只在 settle 时刻判一次不够：压缩在 30s 窗口内开始时定时器仍会点火，注入的 followUp 会与压缩的 continuation 抢生命周期。

→ 两处都要做：(a) 压缩开始（`selected` 落定）与 `ctx.compact()` 调用期间，调用现有的 `cancelTodoReminder()`（`src/core/todo.ts:222-227`）；(b) 定时器回调内再判一次 `compactionInFlight`。

### 2.9 无法区分"用户 ESC"与"扩展主动 abort"（接线缺口）

`settle-wake-core.ts:43` 与 `todo-reminder-core.ts` 都是**按 `stopReason === 'aborted'` 字符串**抑制注入的（`index.ts:363-373` 记录 `lastStopReason`）。OCC 主动 abort 同样是 `'aborted'`：

- 好的方面：D96 催办/唤醒会被自动抑制，`§5.1 A.4` 想达到的效果部分"免费"得到；
- 坏的方面：**语义被混同**——一旦将来有人想"用户 ESC 才抑制"，扩展自己的 abort 会误伤；反过来 OCC 也无法表达"我这次 abort 是意图内的"。

→ 建议在 `turn_end` 记录 stopReason 的同一处（`src/index.ts:360-373`）增加一个 `intentionalAbort`（OCC 设标记 → 记录时识别 → 传给 `planSettleWake` / `planStopTodoReminder`），RFC 的"A.4 守卫穿透"才算真正接线完毕。这也是唯一需要改 `pier` 既有核心的地方，值得在 RFC 里单独列一小节说明"接线点在哪、为什么不能只靠时间窗猜测"。

### 2.10 顺便：压缩指令可以带上 pier 的独有信息

上游只用固定 `customInstructions`（`BOUNDARY_COMPACTION_INSTRUCTIONS`）。`pier` 手里有更精确的"剩余工作"（`todos.items` 的 `pending/in_progress/blocked + blocker 文案`、`phase`）→ 建议 `ctx.compact({ customInstructions: 固定前缀 + \`remaining: ...\` })`，让摘要保住未完成项与阻塞原因。这是低成本高收益的差异化（上游甚至收集了 `pendingProgress` 却最终没用）。

---

## 3. 机制二 OBS：补缓存经济学 + 3 条判定规则 + 工具门禁

### 3.1 打包会失效前缀缓存（RFC 最大的经济性遗漏）

pi 的 Anthropic 适配器把 `cache_control` 打在 **system**、**最后一个 tool** 与**最后一条消息块**上（`dist/bundle/chunks/anthropic-messages-*.js` `convertMessages` 尾部逻辑）＝滚动式前缀缓存。因此：

- 把中间某条 `toolResult` 换成占位符 ⇒ **从该消息起到末尾的整段前缀失效重写**（写价 ≈ 读价的 `cacheWriteReadRatio` 倍）；
- 收益 = `removedTokens × cacheRead 价 × 剩余请求数`。

结论：**对"较早的大输出"打包，可能省 1 份读、花一整段写，净亏**。而 `fullSends=2` 的设计恰好是"每条消息各自到点、逐轮错开打包"——最坏的模式：每轮都重写一次缓存。→ 建议：

1. 让 `compact-economics-core` **同时服务 OBS**：输入 `removedTokens` + `tailTokensAfterThisMessage`（该消息之后的 token 数）+ 预计剩余请求数；`pack ⟺ removed × N_remaining × readRatio > tail × writeRatio`；provider 无缓存能力（模型目录 `cost.cacheRead === 0`）时恒 pack。
2. 更省事的近似：**批量打包**——每轮至多打包一次，或把打包时机对齐到 OCC 压缩点/边界点（压缩本来就要整段重写，此时打包是"顺路免费"）。
3. 遥测里必须记 `tailTokens`、`packedAt`、`sendNumber`，并把 `savedTokens` 明确标注为**毛收益**；否则"节省指标"系统性高估，后续调参无从判断。

### 3.2 三条判定规则（上游有、RFC 漏）

- **`isError` 结果永不打包**：`observation.ts:isPureTextResult` 要求 `!message.isError`。失败证据最有价值，绝不能换成占位符。`§5.2` 只写了"纯文本 `toolResult`"。
- **id 派生**：上游 `obs_<sha256(toolName \0 toolCallId \0 contentHash)[:24]>`。若按 RFC 的"内容哈希"直接做 id，两条内容相同的结果会共享 id ⇒ `sendCount` 串台（第二条可能立刻被打包，且召回语义含糊）。
- **收据不二次打包**：上游 `containsReducerReceipt()` 命中 EPR 收据前缀就跳过。RFC 两个机制各自独立设计，缺"互斥矩阵"（见 §8）。

### 3.3 `sendCount` 必须能从消息数组推导（resume/HMR/fork 一致）

上游用"该消息之后有几条 assistant 消息"来推算已发送次数（`priorAssistantCounts`），内存 map 只作补充。RFC 的"第 3 轮及以后"若只靠内存计数器，`/resume`、HMR 重挂、`/fork` 后计数归零 → 大输出重新全量发送两轮（fork 还会把 `objects/` 共享）。建议：**以消息数组推导为准，文件存在性决定是否需要落盘**。

### 3.4 `obs_recall` 要走工具门禁（自定义角色会拿不到）

`pier` 的角色门禁（D82/`tool-gate.ts:45-52`）对 `unknownTools: deny` 的角色（= 所有自定义角色）会**直接 deny 未在 `manifest.tools` 里列出的工具**。`master`/`worker-default` 是 `allow`，`obs_recall` 会自动可见；但自定义角色会出现"占位符给了 id，却调不到 `obs_recall`" = 证据变不可达（本质上就是"隐藏证据"）。→ 二选一：在角色清单里把 `obs_recall` 列为可选工具并在文档提示；或**在 OBS 启动时检查当前角色 active tools，不含 `obs_recall` 就整体不打包**（`planActiveTools` 的输出在 `index.ts:288` 附近现成可用）。

### 3.5 其他实现细节

- 用 `O_NOFOLLOW` + `0600`/`0700` 落盘，并对"同名文件内容不一致"视为完整性失败（上游 `archive.ts` 的做法）。
- 占位符的 head/tail 摘录（上游 `PLACEHOLDER_EXCERPT_BYTES = 1024`，整行切分）比 RFC 的"前后 512 字节"更好：避免把一行截成半截，模型不会误读。
- `obs_recall` 的返回也要限流与计量（上游 16KB/400 行 + header 预留）；否则模型可以把日志全量翻回来，"节省"归零。

---

## 4. 机制三 EPR：把"保真"做实

### 4.1 P0：`tool_result` 改写会持久化，原文必须落盘

已验证调用链：`runner.js:693-744`（中间件链，返回 `content` 为**整体替换**）→ `agent-session.js:247-270`（`hookResult.content` 成为工具结果）→ 写入会话 JSONL 并进入模型上下文。

所以 EPR 一旦"签发收据"，**原始日志从会话历史里永久消失**。上游因此把原文 archive 到 `objects/<sha256>.txt`，并在收据里写 `source_artifact=<path>` + `readback=use bash with an explicit byte or line range on source_artifact ...`。RFC 的 §5.3 只有"引文逐字节比对"（这只保证"收据没撒谎"，不保证"证据还在"）——**"Evidence-Preserving" 必须包含"可回读"**。

→ 建议：EPR 复用 OBS 的同一个对象存储（`<runtimeRoot>/objects/<sha256>.txt`），收据中输出路径（或 `obs_` 句柄 + `obs_recall`），并在 `§7 阶段二` 就把它抽出来（EPR 依赖它）。

### 4.2 P1：验真必须针对未截断字节

pi 的 bash 结果会截断（默认 50KB / 2000 行），完整内容写在 `details.fullOutputPath`（文本里也会出现 `Full output: <path>`）。上游 `candidate.ts` 专门读该文件，并做三道校验：文件名匹配 `pi-bash-*.log`、`realpath` 在 `tmpdir` 下、非符号链接。

若直接对 preview 验真：一条把关键失败行截掉的日志，收据可以"诚实地"引用 preview 里的行并给出 `status=success` → 正好是最该防的失败模式。→ 建议：**候选源必须是未截断字节，取不到就 fallback 全文**（并把 `reason: 'truncated-source'` 记进日志）。

### 4.3 `terminal` 不能直接做候选（pier 特有）

`pier` 的长测试循环主要跑在常驻终端里（D71），而 `terminal read` 只保留**尾部 8KB**（`src/terminal-core.ts:8` `READ_MAX_CHARS = 8000`、`:241-243` 截断并加 `…[truncated]…`，尾部优先）。对尾部片段做 EPR 验真同样是"在残缺视图上签发成功收据"。

→ 建议在 RFC 里显式声明：**EPR 候选限 `bash`**（以及未来为 `terminal` 增加"完整输出落盘路径"之后）；或者在 `terminal` 增加可选 `full_output_path`（把 PTY 输出 tee 到文件）作为后续增强项。

### 4.4 P0：安全边界（RFC 完全没有）

上游有：`LIKELY_SECRET` 正则（`api_key|authorization|bearer|access_token|secret`）命中即 fallback；`SECURITY.md` 明文"日志会发给 reducer 模型，敏感日志不要开远程提炼"；archive 目录 `0700`/文件 `0600`；**项目级配置只在项目被信任时生效**（README："`.pi/sol-pi.json` in the current project, **if the project is trusted**"）。

RFC 的 `§4.1` 让 `<workspace>/.pi-herdr/config.json` **无条件**生效，就能开启"把命令输出发给第三方 provider"——恶意仓库一条配置文件即完成数据外泄。→ 必须补：

- 项目级配置启用 EPR 需 `ctx.isProjectTrusted()`（`ExtensionContext.isProjectTrusted()` 现成可用）；不信任时该机制强制关闭并 stderr 警告一次；
- 密钥/凭据正则拦截 + 命中原因入日志；
- 落盘权限位与符号链接防护；
- `localOnly` 模式（只 archive、不调模型）；
- 遥测日志**只记 hash/字节数/模型/provider，不记正文**（RFC 的 `reducer.jsonl` 示例里有 `"command": "npm test"`、`failedQuote` 原文——`failedQuote` 可能含敏感串，建议只记 `quote_sha256`，与上游收据一致）。

### 4.5 阻塞成本与 `usage` 回填

- `§5.3` 的"< 800ms"与 `timeoutMs: 90000` 二选一，建议默认 5s（超时即 fallback），并在 RFC 写明"这是同步阻塞 `tool_result` 的路径"。
- 只对"失败命令 + 最近一次"提炼更划算（同一条命令连续跑 10 次成功，没必要 10 次都提炼）。
- 收据回填 `usage`：`tool_result` 返回值支持 `usage` 字段并被持久化进会话（`runner.js:718-721`、`agent-session.js:270`），把 reducer 的 token 用量带上，footer/`/session` 的成本统计才包含它（上游也这么做）。
- `cacheRetention:'none'` + `sessionId`（路由用 runId）+ `maxOutputTokens`：三个上游参数建议原样进 schema，避免"提炼请求写入缓存"这种隐性浪费。

### 4.6 `tool_result` 是整体替换，注意与 `index-locks` 的注册顺序

`index-locks.ts:63` 也会在 `tool_result` 上返回 `{content: [...content, warning]}`（追加写锁告警）。它是**追加**，EPR 是**替换**——若 EPR 在它之后执行，写锁告警会被吞掉。→ EPR 必须像上游 `projectReceipt` 那样**只替换日志所在的那个 content block**，并且在后处理链里跑在追加型 handler 之前（同扩展内按注册顺序；跨扩展时 pi 按加载顺序）。这点建议写进 RFC 的实现约束。

---

## 5. 配置与遥测：状态 / 遥测分离，且不要自造缓存比率

1. **状态 vs 遥测分离**（`§4.4` 只设计了遥测）：决策状态（边界样本、cache 债务、epoch、`selected`）→ `appendEntry` 进会话（分支正确、resume 正确）；per-request 高频流水（packed/recall/fallback）→ JSONL 文件。混在一起会同时失去两个优点（会话膨胀 + 状态丢失）。
2. **ratio 从模型目录推导**：`ctx.model.cost` 有 `cacheRead/cacheWrite/input/output`（`pi-ai` 的 model catalog），`cacheWriteReadRatio = cost.cacheWrite / cost.cacheRead`。硬编码 `12.5` 只对 Anthropic 一类 `1.25x/0.1x` 的定价成立；OpenAI（写=1x、读=0.25x）、DeepSeek、本地模型都不同。把 `cacheWriteReadRatio` 降级为 **override**，默认 `auto`。
3. **闭环校验（RFC 说"数据驱动调优"，可以做得更硬）**：pi 已经内置 `detectCacheMiss` / `computeCacheWaste` / `CACHE_TTL_MS`（`dist/core/cache-stats.d.ts`，且会算成美元）。→ 每次压缩/打包后，用真实的 `cacheRead/cacheWrite`、cache miss、idle 间隔回填"预测 vs 实测"字段（`predictedBreakeven` vs `observedRepaymentRequests`），这才是能自动调参的数据；顺带把"缓存已过期（idle > TTL）时压缩几乎免费"这一常识纳入决策（省下的写价本身就是 0）。
4. **配置校验语义要写死**：`additionalProperties:false` + 未知键 = 打错字，应当**一次收集全部错误并 stderr 报一行、该机制视为 disabled**（与 `role-manifest.ts` 的"防拼写静默失败"文化一致，但**不要**让配置错误中断会话）。项目级/用户级建议"整体覆盖"而非深合并（上游即如此），深合并会让"项目只写一行 false 想关掉"这类意图变得不可预测。
5. **日志 schema 加版本**：每条 JSONL 记 `schema: "pier-efficiency/1"` + `mechanism` + `epoch` + `sessionId`，并统一时间戳为 ISO（RFC 用 epoch ms，`observation` 用 ISO 更利于外部脚本；二选一即可，别混）。
6. **日志路径与清理**：加保留策略（大小/天数上限）与 `/efficiency` 命令（查看开关与最近决策）；否则 `objects/` 会无限增长（上游明确"archives 不会自动清理"，这是它的已知缺陷，别照抄）。

---

## 6. `pier` 集成接线清单（RFC 未覆盖）

| 接线点 | 要求 | 依据 |
|---|---|---|
| HMR/注册面 | 所有 `pi.on` / `registerTool` 走 `surface.forModule(key)` + `ledger`（`pi.on` 只增不减） | `src/pi-surface.ts`、bootstrap D79/D87 |
| 分支/resume | 效率状态随 `rebuildFromBranch()` 恢复 | `src/index.ts:111-118` |
| 压缩飞行期 | `session_before_tree` 返回 cancel（`pier` 有 `/tree`） | 上游同款守卫 |
| 催办 | settle 决策 + 30s 定时器双判 + `cancelTodoReminder` | `src/core/todo.ts:227-262` |
| 唤醒 | `intentionalAbort` 通道，别只靠 `stopReason==='aborted'` | `src/settle-wake-core.ts:43` |
| 角色 | `obs_recall` 可见性；`terminal` 角色禁用 `obs_recall` 时也要禁用打包 | `src/tool-gate.ts:45-52` |
| 子代理 pane | 建议默认只在 master 启用（worker 只启用 OBS 更保守）；并明确 `PI_HERDR_*` 覆盖在 worker 里是否生效 | D81 worker 旁路 |
| 会话模式 | print/RPC/无持久会话目录时整体 fail-open（`getSessionDir()` 可能为空） | `runtime-paths.ts` 上游同款 |

---

## 7. 建议的修订路线图与验收标准

在 `§7` 基础上调整（保持 4 阶段，但改内容与顺序）：

- **阶段一（纯核心）**：`efficiency-config-core`（含校验错误收集）+ `efficiency-logger-core` + `compact-economics-core`（**含债务/首次放宽/窗口保护/nativeFeasible 四个纯函数**）+ `observation-core` + `reducer-core`；基线 `node --test packages/pier-ext/test/*.test.ts` 必须 545/545 通过。**契约先行**：先定 `schemas/efficiency-config.schema.json` 与三份日志的字段表（含 `tailTokens`、`carriedDebt`、`predicted vs observed`）。
- **阶段二（共享存储 + 只读机制）**：`efficiency-store`（content-addressed、0600、O_NOFOLLOW、sessionId 校验）→ 先落 OBS（含 §3.1 缓存经济学与 §3.3 计数推导），再落 EPR archive（先只 archive，不调模型 = `localOnly`，把"证据可达"独立验证）。
- **阶段三（OCC）**：先接 `intentionalAbort` 与催办双判，再做 `todo.completed{source:'tool'}` 边界收敛，最后接 `turn_end → abort → agent_settled → compact → continuation` 全链路；补 `/tree`、`/resume`、HMR 三种恢复用例。
- **阶段四（EPR 调用）**：接 `reducer-invoker`（专用模型 + 5s 预算 + `cacheRetention:'none'` + `usage` 回填 + 密钥拦截 + 信任门控），并补 `event.content` 的 block 级替换（不吞 `index-locks` 告警）。

**必测的 fail-open / 边界矩阵**（建议单列一节）：

- 存储：目录不可创建、只读、符号链接、同名不同内容、非 UTF-8、超大（> `maxChars`）、并发写同一对象；
- 模型：无 reducer 模型、鉴权失败、超时、返回非 JSON、引文不匹配、`quote` 超 600 字符、`status` 与 `isError` 不符、失败日志缺 `fatal/failure` 证据（上游 `missing-failure-evidence`）、收据不小于原文；
- 生命周期：压缩飞行中用户 ESC、`/tree`、`/new`、SIGINT、HMR 重挂、`hasPendingMessages()` 为真、`selected` 已选但未执行时来新 prompt；
- 门禁：自定义角色无 `obs_recall`、`unknownTools: deny`、项目未受信任。

**工程约定**：把新的纯核心加入 `stryker.conf.json` 的 `mutate` 列表（阈值 high 80 / break 50）；`docs/decisions.md` 的 D100–D103 必须按该索引的要求补"代码锚点"；RFC 中可固化的 WHY 建议落 `docs/adr/0005-*.md`（短 WHY），长设计留在 RFC。

---

## 8. 建议新增章节：机制互斥矩阵

三个机制共用"上下文/证据/生命周期"，RFC 缺一节显式互斥关系，建议加：

| 场景 | 规则 | 理由 |
|---|---|---|
| EPR 收据 → OBS | 不打包（前缀/形状识别） | 收据本身就是精简证据，再摘一次会毁掉可回读性 |
| OBS 召回结果 → EPR | 不提炼 | `obs_recall` 输出已限流，且是模型主动索取 |
| OCC 压缩点 → OBS | 允许（并按 §3.1 建议主动批量打包） | 压缩本来就要整段重写缓存，顺路打包免费 |
| OCC continuation → 催办/唤醒 | 不注入（`intentionalAbort`） | 与压缩抢生命周期 |
| EPR → `isError` 语义 | 不改（沿传入值） | 错误标记不能让提炼影响 |
| 人类输入（steer/新 prompt） | 作废已选压缩 + 清空样本（correction） | 上游 `recordCorrection` 同款 |

---

## 附：主要证据锚点

**上游 `NVlabs/SoL-Pi`（clone 对照）**
`src/sol-pi/runtime-paths.ts`（sessionDir/sessionId 分层的 runtimeRoot）、`extensions/online-context-compact/{economics,extension,state,tools}.ts`（公式/债务/首次放宽/窗口保护/feasible/appendEntry 状态/`update_plan`）、`extensions/observation-pack/{index,observation}.ts`（context 投影、`isPureTextResult`、`containsReducerReceipt`、id 派生、常量）、`extensions/evidence-preserving-reducer/{index,config,provider,receipt,candidate,archive,journal}.ts`（专用模型、`cacheRetention:'none'`、`LIKELY_SECRET`、`missing-failure-evidence`、`fullOutputPath`、内容寻址 archive、appendEntry journal）。

**pi `0.84.2`（本机 dist/docs）**
`docs/extensions.md:209-249,280-320,440-500,601-620,842-875,1077-1100,1128`；`docs/compaction.md`（有损摘要、切点、阈值）；`docs/settings.md:118-127`（`compaction.enabled/reserveTokens/keepRecentTokens`）；`dist/core/extensions/types.d.ts:200-249`；`dist/core/extensions/runner.js:693-744`；`dist/core/agent-session.js:247-270`（结果替换与持久化）、`compact()`（内部先 abort）；`dist/modes/interactive/interactive-mode.js`（`abort → restoreQueuedMessagesToEditor`）；`dist/core/session-manager.d.ts:140`（`ReadonlySessionManager` 暴露面）；`dist/core/compaction/compaction.js:161`（`enabled` 只作用于 `shouldCompact`）；`dist/core/cache-stats.d.ts`（`detectCacheMiss`/`computeCacheWaste`/`CACHE_TTL_MS`）；`dist/bundle/chunks/anthropic-messages-*.js`（`cache_control` 打在最后一条消息块）。

**本仓库**
`src/todos-service.ts:74`（`todo.completed`）、`src/index.ts:111,166-198,218,360-373,288`、`src/core/todo.ts:180-190,227-262`、`src/settle-wake-core.ts:43`、`src/todo-reminder-core.ts:29`、`src/tool-gate.ts:45-52`、`src/role-manifest.ts:54-56,110-120`、`src/role-loader.ts`、`src/storage-layout.ts:60`、`src/terminal-core.ts:8,241-243`、`src/index-locks.ts:63`、`src/pi-surface.ts`、`stryker.conf.json`。

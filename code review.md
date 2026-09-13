# Code Review —— SoL-Pi 能效机制吸收（D100–D103）

> **审阅对象**: `docs/rfc-sol-pi-absorption.md`（含 `docs/rfc-sol-pi-absorption-review.md` 的审阅意见）对应的**未提交实现**
> **审阅基线**: 本仓 `master`（HEAD `8db7b95`）+ 工作区未提交改动
> **审阅日期**: 2026-09-12（Round 1） · 2026-09-13（Round 2 修复复审）
> **审阅范围**: 12 个新增源文件 / 8 个新增测试文件 / 9 个改动文件（见 §6 清单）
> **验证方式**: 全量测试 + 定向复现实验（§7 附录给出可复现脚本）

---

## Round 10 收尾结论（试用就绪，2026-09-13）

**Round 9 §15.5 的三条延后项已全部清理，并补齐“可试用”所需的入口文档。** 最终验证：`npm test` **657/657**（含 typecheck 前置）、`pier-ext` **612/612**、`npm ci --dry-run` 通过。

| 延后项 | 结果 |
|---|---|
| 其余 3 个新核心的变异证据 | ✅ 已归档：单元+集成 spec 子集跑 1160 mutants，整体 **58.79%**（`observation-core` 66.82% / `efficiency-config-core` 59.80% / `reducer-core` 48.52%）——**下界**（全量集只会多杀；全量集实测需 ~2–3h，未跑）。并针对最弱的 `reducer-core` 补测 + 把 `DIAGNOSTIC_COMMAND` 尾边界放宽到 shell 分隔符，复测 **52.52%**。报告：`reports/mutation/efficiency-cores*.json`、`reducer-core-trial.json` |
| `recordPacked()` 风格收敛 | ✅ 已做：`packOneMessage` 新增可选 `log` 参数，**memo 写入与 `observation.jsonl` 单次写入合并到同一函数**（两条打包路径各删掉 ~25 行重复日志代码，不可能再出现“写了 memo 忘了日志”） |
| index 层剪枝/路径测试 | ✅ 已做：新增 index 生命周期集成用例（`session_start` 传入 session dir → 两个 objects 目录各 301 个文件 → `session_shutdown` 后各剩 300），直接验证真实接线与默认阈值 |

本轮还新增了**试用入口**：`docs/efficiency-trial.md`（开启方式 / 建议顺序 / 观测入口与字段 / 粗判划算 / 安全与回滚 / 反馈模板 / 已知限制）+ README `Configuration` 下的 “Efficiency mechanisms (D100–D103, opt-in)” 小节 + RFC 状态行与 §9 的指引。

顺带的功能性改进：`DIAGNOSTIC_COMMAND` 尾边界由 `\s|$` 扩为 `[;&|()\s]|$`，使 `(npm test)`、`npm test&&echo ok`、`pytest;` 也能被 EPR 识别（`makefile`/`coqtop`/`npm run test` 仍不误判），并由新增用例钉住。

**当前状态：可开始试用并收集反馈。** 反馈时请按试用指南 §6 附上 `/efficiency` 输出与脱敏后的 `efficiency-logs/*.jsonl` 片段；预期第一批反馈集中在：占位符可读性（`excerptBytes`/`thresholdBytes`）、EPR 收据粒度与 reducer 模型选择、OCC 触发时机与 `cacheWriteReadRatio`。

---

## Round 9 收尾结论（2026-09-13，审阅侧执行）

**Round 8 §14.3 的 1–5 项全部关闭**：A4 测试改为真断言 + 完全隔离；角色门禁/批量打包/对象剪枝抽成可单测函数并补齐用例；RFC/ADR 措辞与计数修正。**额外修复**：round-8 声明 `typescript` 时漏了 lock 条目（干净机器 `npm ci` 会失败）——现已钉 `~5.9.3` 并修复 lock（`npm ci --dry-run` 通过）。

- 测试：`npm test` **654/654**（含 typecheck 前置）、`pier-ext` **609/609**（Round 8 为 651/606，+3 用例）。
- 文档：RFC 基线 609/654、§8 计数 64（42+7+9+6）、§9 全面披露变异证据边界；ADR 拆开“既有日志轮转 / 本轮对象剪枝”。
- 明确延后（已披露）：其余 3 个新核心的变异报告、`recordPacked()` 风格收敛、index 层剪枝事件注册测试（详见 §15.5）。

详细记录见 §15；逐轮历史见 Round 8–1 与 §0–§14。

---

## Round 8 复审结论（2026-09-13）

**P1（多块 memo 键）已闭环且实测归零；P1-B、B2 均以“诚实口径”收敛；本轮无实质性代码问题，剩余仅文档措辞与两处测试覆盖细节。** 基线核对：`npm test` **651/651**、`pier-ext` **606/606**（与 RFC `:5` 的 606/651 逐字吻合）。

| 项 | 状态 | 关键证据 |
|---|---|---|
| **P1 多块 memo 键** | ✅ 已修 + 实测闭环 | 新增单一来源 `contentJoinedLength()` + `memoKeyFor()`（`core/observation.ts:54-64`），四处共用（`:98/130` 写，`:179` 批量读，`:389/393` context 读）；**实测：单块 0.3/0.0ms，双块 0.0/0.0ms，三块 0.1/0.0ms（Round 7 双块为 33.6/32.0ms），三次请求 `horizonCalls` 均为 1**；新测 `observation-integration.test.ts:369` 用 `getRemainingHorizon` 调用次数断言“命中不再决策” |
| 批量上限语义 | ✅ | 改为“首条不饿死、后续不越界”的软上限：`accumulatedBytes + textBytes > maxBytes && packedCount > 0 → break`（`core/observation.ts:189`）；`packed-batch` 日志补 `source: 'compaction'`（`:213`）且改为 `await` + try（`:208-210`）；测试 `:311` 覆盖 `limits.maxItems` 与遥测字段 |
| **P1-B 门禁范围** | ✅ 以文档口径收敛 | tsconfig 仍为 16 文件（`--listFiles` 实测），ADR `:52` / RFC `:438` 已改为 “targeted typecheck gate … covering the 16 efficiency and lifecycle core modules”，与实测一致（不再声称 project-wide） |
| **B2 变异声明** | ✅ 声明已诚实化（覆盖仍 1/4） | ADR `:53` / RFC `:439` 改为「`compact-economics-core.ts` 315 mutants、77.46%；合并测试集 78.26%」；报告目录仍是 13 Sep 10:26 那次（只含 `compact-economics-core` + `gc-core`）——**未跑其余 3 个核心，但已不再声称已跑** |
| RFC 计数与基线 | ✅ | §8 拆为 40 纯核心 + 6 OBS + 9 OCC + 6 EPR = 61；`:5` 基线 606/651 与实测完全一致 |
| A1/A3/A4/C1 | ✅ 无回归 | 同 Round 7（shutdown `await` 剪枝、horizon 窗口接线、pi settings 读取、批量打包去重+上限+遥测+角色门禁） |

**发布面评估**：三机制默认关闭、逐项 fail-open，Round 1–8 的 P1 均已闭环；剩余项不阻塞合入。

---

## Round 7 复审结论（7 项修复后，2026-09-13）

**`npm test` 650/650、`pier-ext` 605/605 全绿（已用仓库内 `typescript`，不再依赖全局 tsc）。** Round 6 的 P1-A / A1-await / A3-接线 / A4-信任门控 / C1-去重+上限+遥测+角色门禁 均已落地；**但引入 1 个新的 P1 回归（多块内容的 memo 键不一致），且 P1-B（门禁范围）与 B2（Stryker 证据）仍未动。**

| 项 | Round 7 状态 | 关键证据 |
|---|---|---|
| P1-A typescript 依赖 | ✅ 已修 | 根 `package.json:46` + `packages/pier-ext/package.json:57` 声明 `typescript: ^5.3.3`，`package-lock.json` 同步；`node_modules/.bin/tsc` 存在且为 5.9.3（`require.resolve('typescript')` → 仓库内路径） |
| **P1 新回归：memo 键不一致** | ❌ **新发现** | `packOneMessage` 写入 `${sessionRoot}:${toolCallId}:${text.length}`（`core/observation.ts:116`），而两处读取用 `approxChars = Σ b.text.length`（`:167` 批量、`:374` context）。单块时两者相等；**多块内容差 (n−1) 个换行字符** → 快路径永久 miss。实测（4MB）：单块 `60.7 / 0.3 / 0.0 ms`，**双块 `45.9 / 33.6 / 32.0 ms`**（详见 §13.1） |
| P1-B 门禁范围 | ❌ 未动 | `tsconfig.json` 仍只列 11 个文件（program 实测 16/67）；`index.ts` / `index-master.ts` / `index-worker.ts` / `core/todo.ts` 仍不在门禁内；`ADR:52` 仍写 "project-wide typecheck gate" |
| A1 保留策略 | ✅ 已修 | `session_shutdown` 改为 `await` 两次剪枝（`index.ts:648-649`，带 try/catch）；日志 5MB 轮转本就存在 |
| A3 horizon 接线 | ✅ 已修 | `index.ts:599-602` 用 `latestCtx.getContextUsage().contextWindow` 传入 → 窗口截断能力在生产路径生效 |
| A4 pi settings | ✅ 代码 + 🟡 测试 | `agentDir ?? PI_CODING_AGENT_DIR ?? homedir`（`:461`）✅；`hasExplicitKeepRecent` 已加受信判断（`:550`）✅；新增 3 用例（`efficiency-config-core.test.ts:226`），其中 `enabled===false` 那条**在无效率配置时是空断言**（默认即 false）——我用 workspace 配置直接验证了真实行为（§13.2） |
| C1 批量打包 | ✅ 大部分 | `packOneMessage` 抽公（`:79`，context 与 batch 共用）✅；上限 20 条/10MB（`:67-68/154`）✅；`packed-batch` 遥测含 sessionId/obsId/bytes/tokens/grossSaved（`:195`）✅；角色门禁（`index.ts:477`）✅；接线断言（`compact-integration.test.ts:202`）✅。**但新特性无单测**，且受 §13.1 的键回归影响（批量看不见自己写的 memo） |
| B2 Stryker | ❌ 未动 | `reports/mutation/` 仍是 13:10:26 的旧产物：仅 `compact-economics-core`(315, 77.46%) + `gc-core`(99, 80.81%)；`observation-core` / `reducer-core` / `efficiency-config-core` 无数据；HTML 仍是 08-29；`ADR:53` / `RFC:429/439` 仍称 78.26% 为“新核心”得分、全部通过变异验证 |
| 文档口径 | 🟡 部分 | RFC `:121` 已改写为“自动读取 pi settings”✅，schema `description` 同步 ✅，基线 605/650 与实测完全吻合 ✅；但 RFC §8 子项拆分仍不准（实测 40 纯核心 + 5 + 9 + 6 = 60）；ADR 三条旧口径未改 |

测试基线（Round 7 实测）：`node --test packages/pier-ext/test/*.test.ts` → **605/605**；`npm test`（含 typecheck 前置）→ **650/650**。

**Round 8 建议顺序**：§13.1 memo 键统一（P1，一行级别）→ P1-B 门禁扩大到 `src/**` 或改写 ADR 口径 → B2 补齐三个核心的变异报告并修正文档数字 → §13.3 的批量打包新特性单测 + A4 空断言补强 → §13.4 nits。

---

## Round 6 复审结论（7 项剩余工作落实验证，2026-09-13）

**`npm test` 649/649、`pier-ext` 604/604 全绿；7 项中 6 项功能落地可信（其中 3 项测试偏薄），B2（Stryker）证据不完整；另发现 2 个 P1 级问题与 1 个被 tsc 顺带修好的真实历史 bug。**

| 项 | 状态 | 关键证据 / 问题 |
|---|---|---|
| A1 遥测与对象保留 | 🟡 对象 ✅ / 日志本就存在 | `pruneObjectsDirectory`（`efficiency-store.ts:79-132`，300 文件 / 50MB，每 50 次 store + `session_shutdown` 触发，单测 `efficiency-store.test.ts:135`）✅；**日志 5MB 轮转在 HEAD 已存在**（`:227/240`）——我 Round 4/5 的“无日志轮转”属误报，见 §12.4；残留：`session_shutdown` 用 `void` 触发（`index.ts:639-640`），进程可能先退出 |
| A2 reducer `epoch` | ✅ 已实现 | `reducer-invoker.ts:61` 新增 opts 并全链路透传（`:101/117/138/…/298`），断言 `"epoch":2`（`reducer-integration.test.ts:205-207`） |
| A3 horizon 复用 | ✅ 代码 / 🟡 接线 | 复用 `estimateRemainingRequests`（`compact-coordinator.ts:349-370`）+ 3 个单测（`compact-integration.test.ts:330+`）；新增的 `contextWindowTokens` 参数**生产路径不可达**（`index.ts:594` 闭包不传参） |
| A4 pi `compaction.*` | ✅ 代码 / 🟡 测试 | `loadPiNativeCompactionSettings`（`efficiency-config-core.ts:455-495`）+ 接入禁用/继承逻辑（`:536-556`）；唯一测试是 `typeof settings === 'object'`（`efficiency-config-core.test.ts:215`）→ 四条真实行为（禁用传递 / keepRecent 继承 / 显式优先 / 未受信不读项目文件）无断言 |
| C1 OBS 批量打包 | 🟡 部分 | `batchPackObservations`（`core/observation.ts:67-135`）+ OCC 回调（`compact-coordinator.ts:230/243-245`、`index.ts:474-486`）；**接线无测试**（仅函数自身单测）、**无遥测**、**无角色门禁**、**无工作量上限** |
| B1 typecheck 门禁 | 🟡 有了但依赖环境 | 实测注入类型错误可捕获（`error TS2322` / exit=2）；但 **`typescript` 未声明为依赖**且 `node_modules/.bin/tsc` 不存在 → 干净机器/CI 上 `npm test` 直接失败（P1-A）；且 tsconfig 仅覆盖 16/67 个源文件（P1-B） |
| B2 Stryker 证据 | ❌ 不完整 | 仅 `compact-economics-core.ts`（315 mutants，77.46%）+ `gc-core.ts`（99，80.81%）有数据；`observation-core` / `reducer-core` / `efficiency-config-core` **无任何变异数据**；ADR 的 78.26% 实为这两文件合计（324/414） |

### 本轮 P1（建议合入前处理）

- **P1-A. `npm test` 依赖开发机全局 `tsc`**：`package.json:34-35` 把 `tsc --noEmit` 前置进 `npm test`，但根与包 `package.json` 都没有 `typescript`，`node -e require.resolve('typescript')` → `MODULE_NOT_FOUND`，`node_modules/.bin/tsc` 不存在；本机之所以绿，是因为 `/opt/homebrew/bin/tsc`（外部 5.3.3）在 PATH 上。→ 在 devDependencies 声明 `typescript`（钉版本），否则 CI/新机器上整条测试入口报 `tsc: command not found`。
- **P1-B. 门禁覆盖被高估**：program 只含 16/67 个 `pier-ext/src` 文件（include 列了 11 个 + 5 个传递依赖），**`index.ts` / `index-master.ts` / `index-worker.ts` / `core/todo.ts` 均不在内**——其中 `index.ts` 承载全部 OCC/OBS/EPR 接线与新增的 `(e: any)`；ADR `:52` 的“project-wide typecheck gate”与事实不符。→ 扩到全 `src`（并修完存量错误）或在 tsconfig/RFC 明写覆盖边界。

其余新发现（批量打包的四个缺口、异常剪枝窗口、配置行为无测试、文档口径矛盾等）见 §12.1–§12.3。

---

## Round 4 复审结论（第三轮修复后，2026-09-13）

**N1′ 已彻底收敛（实测 memo 命中 0.0–0.3 ms）、P2-7/P2-9 已接线、测试 600/645 全绿**；剩余为「文档/契约未同步」与三项老遗留（遥测清理、批量打包、Stryker/typecheck 证据）。

| 项 | Round 4 状态 | 关键证据 |
|---|---|---|
| N1′ OBS 热路径 | ✅ **已修且实测收敛** | memo 查找已前置到 `text` 拼接/收据扫描/`byteLength` **之前**（`core/observation.ts:225-235`，键 `sessionRoot:toolCallId:approxChars`，`approxChars` 仅累加 `.length`）；命中时 LRU 刷新（`delete+set`）且不再决策；`containsReducerReceipt` 加 `includes` 零分配早退（`observation-core.ts:48-51`）；`completeLineExcerpt` head 路径去掉全文 `split`（`:55-77`），tail 仅在 `budgetBytes*4` 窗口内 split。**实测 8MB 项：首次 73.6 ms → 后续 0.3 / 0.0 / 0.0 ms**（Round 2 为 133 ms / Round 3 为 68–216 ms）；`getRemainingHorizon` 在命中路径仅调用 1 次 |
| N1′ 自愈 | ✅ 已修 | `invalidateObservationMemo(obsId)`（`core/observation.ts:54-60`）已挂到 `obs_recall` 读失败分支（`:165-166`）；单测 `observation-integration.test.ts:251` 覆盖「memo 快路径 + 磁盘对象丢失后自愈」 |
| P2-7 OBS 经济学 | ✅ 大部分接线 | `deps.getRemainingHorizon`（`core/observation.ts:285-289`）由 `index.ts:569` 接到 `coordinator.getRemainingHorizon()`（`compact-coordinator.ts:335-340`：有样本则 `1 + floor(mean×3)`，无样本回退 4）——OBS 终于吃 OCC 的边界样本。**但**：无单测（`grep getRemainingHorizon test/` = 0）；RFC §4.2/§5 的「OCC 压缩点批量打包」仍未实现也未改写（`rfc:244/300`） |
| P2-9 pi 压缩设置 | 🟡 改为显式配置 | 新增 `onlineContextCompact.keepRecentTokens`（默认 20000，`efficiency-config-core.ts:24/62/187-191`），coordinator 两处均改用（`compact-coordinator.ts:167/205`）。**仍不读 pi 的 `compaction.keepRecentTokens`（漂移面从硬编码转为默认值仍重复），也不管 `compaction.enabled=false`**；且新键**未同步到 schema 与 RFC**（见 N6） |
| P2-10 遥测 | 🟡 部分 | reducer 日志补 `sessionId`（`reducer-invoker.ts:283-296`）与 `grossSavedBytes`（毛收益标注，`:268`）✅；**仍缺 `epoch`；仍无轮转/保留策略** |
| P3 `as any` | ✅ 已改 | 三个热点文件 `as any` 计数归 0；EPR 入口改为 `as unknown as ToolResultEventLike`（`index.ts:263`，且已导出该类型） |
| 测试缺口 | ✅ 已补两项 | `compact-integration.test.ts:305`（`tokens:null/0` 回退，断言 `lastContextTokens` 不被污染）；`observation-integration.test.ts:251`（memo + 自愈）→ 测试数 **600/645**，与 RFC 基线完全吻合 |
| P3 其余 | ❌ 未动 | 无 typecheck 门禁（无 `tsconfig`/`tsc` 脚本）；`reports/mutation/*` 仍为 08-29（4 个新核心无 mutation 证据） |

### 本轮新增发现

- **N5（文档越界）**：RFC 新增的 §4.3 C「进程作用域与角色分工」声明「worker 默认启用 ObservationPack，OCC 与 EPR 默认保守待命」，但代码中 `isSubagent` 仅用于 todo 配置与通知路径（`index.ts:101/105/449/738`），三机制对所有进程**一律默认 false**，没有任何 worker 差异化逻辑。
- **N6（契约漂移）**：`keepRecentTokens` 进了 TS 类型与手写校验器（7 处），但 `schemas/efficiency-config.schema.json` 与 RFC §3.2 的配置块 **0 处** —— 因为 schema 是 `additionalProperties: false`，按 schema 校验会直接拒掉这个键。
- **N7（重复实现）**：`getRemainingHorizon` 自己重写了 horizon 公式（`1 + floor(mean×3)`），未复用已有且已被测的 `estimateRemainingRequests`（后者含窗口上限、方差下界、`remainingRequestScale`），且新逻辑无单测。
- **N8（小）**：RFC §7.1 的阶段验收计数已过期（阶段二「新增 3 个集成测试」现为 4；阶段三「新增 5 个」现为 8）。

**Round 5 建议顺序**：N5/N6/N7（文档与契约同步，纯文字/接线成本）→ P2-10（轮转 + reducer `epoch`）→ 批次打包二选一（实现或改写 `rfc:244/300`）→ P3（typecheck 门禁 / 一次 Stryker 归档）。

测试基线（Round 4 实测）：`node --test packages/pier-ext/test/*.test.ts` → **600/600**；`npm test` → **645/645**。

---

## Round 3 复审结论（第二轮修复后，2026-09-13）

**Round 2 的 N1/N2/N4 与两个缺失测试均已处理；剩余 3 项为 P2-7（OBS 经济学接线）、P2-9（pi 压缩设置）、P2-10（遥测清理与字段）**。N1 由「全量重算」降为「仍有一次全量预扫描」——实测 **median 52.5 ms/请求（8MB 项）**，仍是本轮唯一影响真实体验的遗留。

| 项 | Round 3 状态 | 关键证据 |
|---|---|---|
| N1 OBS 热路径 | 🟡 大部分修复 | `placeholderMemo`（**FIFO 256**，`core/observation.ts:51-52/223-227/291`）+ `storeContentAddressedObject(precomputed)`（`efficiency-store.ts:79`）；memo 命中后已跳过 sha256/countLines/摘录切片/store 重算。**但 memo 之前的全量预扫描未消除**：8MB 项每请求 median **52.5 ms**（`containsReducerReceipt` 41.7 + `byteLength` 7.5），端到端 68–216 ms/请求（详 §9.1） |
| N2 store 完整性 | ✅ 已修 | cacheKey 纳入 mtime（`efficiency-store.ts:97/111`）；新增「等长不同内容 → hash mismatch」用例并删除旧缓存（`efficiency-store.test.ts:76-90`）；`clearVerifiedObjectCacheForTest` 已被使用 |
| N4 日志字段 / 注释 | ✅ 已修 | `logDecision` 补 `sessionId`+`epoch`（`compact-coordinator.ts:344-345`，`onComplete` 在 `:282-283`）；`turn_start` 加安全前提注释（`index.ts:390-392`）；还清债务时同时清零 `cacheDebtRepaymentTokens`（`compact-coordinator.ts:113`） |
| 缺失测试（还债 / onError） | ✅ 已补 | `compact-integration.test.ts:247`（1000→700→400→100→0，并断言 repayment 归零）、`:270`（`onError` 复位 `compactionInFlight`/`intentionalAbort`） |
| N3 文档 | 🟡 大部分修复 | §4.2 公式已改为 `Math.max(0, ratio - 1)`（`rfc:242`）；遥测文件树条目已删；基线改为 598/643（我实测 **598/643** 完全吻合）。**仍存**：`status` 仍写「全量修复与生产级加固」（`rfc:3`）；§4.2/§5 仍主张 OCC 压缩点「批量打包」（`rfc:244/296`）而代码无此逻辑；§7.1 阶段三仍写「新增 5 个集成测试」（现为 7） |
| P2-7 OBS 经济学 | ❌ 未修 | `expectedRemainingRequests: 4` 仍硬编码（`core/observation.ts:265`）；无压缩点批量打包；horizon 未入配置/schema |
| P2-9 pi 压缩设置 | ❌ 未修 | `DEFAULT_KEEP_RECENT_TOKENS` 仍硬编码并同时用于 `archiveTokens` 与 `nativeCompactionFeasible`（`compact-coordinator.ts:32/167/204`）；不读 `compaction.keepRecentTokens`，也不管 `compaction.enabled=false`；RFC 无声明 |
| P2-10 遥测残留 | 🟡 部分 | 无轮转/保留策略（`rotate|prune|retention` 全仓无命中）；reducer 日志仍无 `sessionId`/`epoch`；`savedTokens` 仍未标注毛收益 |
| P3 | ❌ 未动 | 无 typecheck 门禁（无 `tsconfig`/`tsc` 脚本）；`as any` 仍在（`index.ts:262/406/454`）；RFC 全文无 `worker` 作用域说明；`reports/mutation/*` 仍为 08-29（4 个新核心无 mutation 证据） |

测试基线（Round 3 实测）：`node --test packages/pier-ext/test/*.test.ts` → **598/598**；`npm test` → **643/643**。

**Round 4 建议顺序**：§9.1 N1'（预扫描前置到 memo 之后 / 消除 `split`，几行改动却决定大日志体验）→ P2-9（读 pi 有效 `keepRecentTokens`，或至少把风险写进文档）→ P2-7（接入 OCC horizon 或改写文档）→ P2-10 清理与字段 → P3。

---

## Round 2 复审结论（修复后，2026-09-13）

**P1 五条全部修复且带测试** ✅；P2 修复 6/7 中的一半（8 · 11 · 12 全修，6 · 10 部分修），**P2-7（OBS 经济学）、P2-9（pi 压缩设置）、P2-10（遥测文件/轮转）未修**；另新增 1 个 P1 级遗留（热路径 CPU 未收敛）与 2 个 P3 级回归。

| 编号 | Round 2 状态 | 关键证据 |
|---|---|---|
| P1-1 EPR 截断 | ✅ 已修 | `reducer-invoker.ts:86-123` 检查 `details.truncation.truncated`；复现实验：返回 `undefined`、模型 0 调用、遥测 `reason:"truncated-source"`；测试 `reducer-integration.test.ts:328+` |
| P1-2 input 纠偏 | ✅ 已修 | `compact-coordinator.ts:120-136` 按 `event.source` 判定；复现实验：extension 消息保留 `[5,5]`，`interactive` steer 清空并 epoch+1；测试 `compact-integration.test.ts:66-83` |
| P1-3 OBS 热路径 I/O | 🟡 **仅修一半** | 落盘移入 `canPack`（`core/observation.ts:248-258`）+ `verifiedObjectCache`（`efficiency-store.ts:33/96/110`）已消除重复**读盘**；但每请求仍全量重复 CPU 计算 —— 实测 8MB 打包项 **≈133 ms/请求**（详见 §8 N1） |
| P1-4 settled 阻塞 | ✅ 已修 | `index.ts:454` `void coordinator.onAgentSettled(...)`；`turn_start`(`:389-391`)/`session_shutdown`(`:608-609`) 复位兜底 |
| P1-5 配置 fail-open | ✅ 已修 | `efficiency-config-core.ts:311-327` 按 section 强制 `enabled=false`（顶层 issue 全关）；测试 `efficiency-config-core.test.ts:196-211` |
| P2-6 债务台账 | 🟡 部分 | 还债递减已实现（`compact-coordinator.ts:106-113`），我实测 1000/300 → 3 次后 100、4 次后 0 ✅；**无测试**，且无 `observedRepaymentRequests` 遥测 —— RFC line 30「预测 vs 实测还债轮次」闭环仍未兑现 |
| P2-7 OBS 经济学 | ❌ 未修 | `core/observation.ts:244` 仍硬编码 `expectedRemainingRequests: 4`；无「压缩点批量打包」；RFC line 243 公式与代码/ADR 仍不一致（见 §8 R-1） |
| P2-8 recallChunkBytes | ✅ 已修 | `core/observation.ts:96` 读取配置作为 `maxBytes` |
| P2-9 pi 压缩设置 | ❌ 未修 | 全仓 `keepRecentTokens` 仅作为函数参数出现（`compact-economics-core.ts:319/331`）；`nativeCompactionFeasible` 与 `archiveTokens` 仍用 `DEFAULT_KEEP_RECENT_TOKENS`（`:32`）；不读 `compaction.enabled`；无文档声明 |
| P2-10 遥测 | 🟡 部分 | 密钥命中遥测 ✅（`reducer-invoker.ts:141`）；packed 日志条件 ✅（`observation.ts:262`）；但 reducer/`logDecision` 仍无 `sessionId`/`epoch`，**无轮转/保留策略**，`efficiency-telemetry-core.ts`/`-writer.ts`/测试仍缺失且仍列在 RFC §6/§7 |
| P2-11 tokens null | ✅ 已修 | `index.ts:397` 仅 `typeof tokens === 'number'` 才采样；`compact-coordinator.ts:158-160` 要求 `> 0` |
| P2-12 tmpdir 校验 | ✅ 已修 | `efficiency-store.ts:192-194` 改用 `relative()` + `..`/`isAbsolute` |
| P3 文档锚点 | ✅ 已修 | D100→`decideCompaction:130`、D101→`shouldPackForCache:168`、D102→`validateReceipt:117`、D103→`resolveEfficiencyConfig:358`；`decisions.md` 尾部空行已去 |
| P3 其余 | ❌ 未动 | 无 typecheck 门禁；`as any` 仍在（`index.ts:262/406/454`）；RFC 无 worker 作用域说明；矩阵行 `onError`/ESC 仍无测试；`reports/mutation/*` 仍早于本次改动 |

**Round 3 建议顺序**: §8 N1（热路径记忆化，唯一会影响真实体验的遗留）→ P2-7 / P2-9（二选一：实现或如实降级文档）→ P2-10（补轮转与字段，或修正 RFC 文件树）→ N2（完整性回归）+ 3 个缺失测试 → P3。

测试基线（Round 2 实测）: `node --test packages/pier-ext/test/*.test.ts` → **596/596**；`npm test` → **641/641**（RFC 头部写 595/640，需同步）。

---

## 0. 结论摘要（Round 1 原始记录，保留以备追溯）

**架构定调守住了**：未引入 Action Fusion（`edit`/`write` 与写锁基线未动）、未引入子代理、OCC 走 `todo_write` 闭环、OBS 只做 `context` 投影不动会话 JSONL、EPR 是进程内微过滤器 —— RFC 的五条核心原则全部落实。测试基线也准确：`593/593`（`pier-ext`）、`638/638`（monorepo），与 RFC §7 声称的「纯核 36 + 集成 12」逐一对上。

**但仍有 5 个"会真出错 / 真亏 / 违反 RFC 自身验收矩阵"的问题必须先修**，其中 P1-1 已在真实调用链上复现出错误产物。

| 级别 | 问题 | 影响 |
|---|---|---|
| **P1-1** | EPR 在**截断视图**上签发 `success` 收据（不检查 `details.truncation`） | 违反 RFC §7.2 矩阵行；在残缺日志上签"通过"收据（已复现） |
| **P1-2** | `input` 纠偏**方向反了**：扩展内部消息清空 OCC 状态，人类 steer 反被豁免 | 每次 D96 唤醒/通知都清空样本与债务；人类纠偏不生效 |
| **P1-3** | OBS 热路径 I/O 放大：每次 provider 请求重读+重哈希整对象，且未打包也落盘 | 实测 8MB 对象 **≈48ms/次/条**，阻塞每轮请求；`objects/` 无清理 |
| **P1-4** | `agent_settled` 里 `await` 整段压缩，阻塞其后所有 settled handler | 结算通知、D50 回推、todo 插件判定全部迟滞一次压缩；催办双判失效 |
| **P1-5** | 配置校验失败**没有**按 RFC 回退 `disabled` | 打错一个键名不阻止机制启用（含 EPR 的外发通道） |
| P2-6 | cache 债务台账只做了一半（无还债递减、`cacheDebtRepaymentTokens` 未参与计算） | 「预测 vs 实测还债轮次」闭环不存在，连续压缩的旧债门禁形同虚设 |
| P2-7 | OBS 未复用 OCC 经济学（硬编码 horizon=4）；无「压缩点批量打包」；打包公式三处口径不一 | 可能"省 1 份读、花一整段写"；节省指标系统性高估 |
| P2-8 | `observationPack.recallChunkBytes` 是死配置 | 用户配置不生效 |
| P2-9 | `keepRecentTokens`/`windowReserveTokens` 复制了 pi 默认值且不读实际设置；不读 `compaction.enabled` | 用户改设置后 `nativeCompactionFeasible` 误判 → abort 后"session too small"（正是 preflight 要防的净亏） |
| P2-10 | 遥测：缺 `efficiency-telemetry-core/-writer`、无轮转、无 epoch/sessionId、密钥回退无记录、pack 日志条件错 | RFC §6 模块表与 review §5 未兑现 |
| P2-11 | `usage.tokens` 为 `null` 时被打成 `0`，污染增量样本 | 压缩后 `averageContextTokenIncrement` 虚高 → OCC 长期判 `deferred_economic` |
| P2-12 | `realFile.startsWith(realTmp)` 弱包含判断 | 临时目录校验可被同前缀路径绕过 |
| P3 | 类型放水 / 无 typecheck 门禁、HMR surface 不一致、文档锚点错行、"已实现通过"状态超前、3 行矩阵无测试、无 Stryker 证据 | 可维护性与验收证据 |

**建议动作**：P1-1/2/5 各是几行改动，P1-3/4 各一处结构调整，连同 3 个缺失的矩阵测试一起修完再提交；同时把 RFC 状态从「已实现通过」降级为「已实现，待修复」。

---

## 1. P1：必须先修

### P1-1 EPR 会在截断视图上签发收据（违反 RFC §7.2 矩阵行）

**位置**: `packages/pier-ext/src/reducer-invoker.ts:83-92`

```ts
const logBlock = event.content.find((b) => b && b.type === 'text' && typeof b.text === 'string');
...
const fullOutputPath = typeof event.details?.fullOutputPath === 'string' ? event.details.fullOutputPath : undefined;

let body = logBlock.text;            // ← 没有任何 details.truncation 检查
if (fullOutputPath) { ... }
```

**现象**: 当 `details.fullOutputPath` 缺失时，代码直接用（可能被 50KB/2000 行尾部截断的）`logBlock.text` 作为"未截断原文"继续提炼、归档、签发收据。

**证据（已复现）**: 构造 `details.truncation.truncated: true` 且无 `fullOutputPath`，mock model 返回合法收据 → 返回 `status=success` 收据、写出归档对象、遥测 `action:"applied"`、`verificationOk:true`。复现脚本见 §7.1。

**影响**: 这正是 RFC §4.3 / §7.2 与 review §4.2 点名要防的失败模式——"一条把关键失败行截掉的日志可以诚实地引用 preview 里的行并给出 `success`"。当前实现只覆盖了"`fullOutputPath` 存在但读不到"这一半情形（那半是对的）。

**修复**: 显式尊重 `details.truncation`：

```ts
const truncated = event.details?.truncation?.truncated === true;
if (truncated && !fullOutputPath) return undefined;   // fail-open，记 reason: 'truncated-source'
```

**测试缺口**: RFC §7.2 该行无单测；`test/reducer-integration.test.ts` 全程未构造 `details.fullOutputPath` / `truncation`。

---

### P1-2 `input` 纠偏方向反了：扩展消息清空 OCC，人类 steer 被豁免

**位置**: `packages/pier-ext/src/compact-coordinator.ts:114-116`，接线于 `packages/pier-ext/src/index.ts:398-402`

```ts
onInput(event: { text?: string; streamingBehavior?: string }): void {
  if (event.streamingBehavior !== 'steer' && !event.text?.startsWith('CORRECTION:')) {
    // 清空 completedBoundaryRequestCounts / carriedDebtTokens / selectedCompaction / epoch+1
```

判定只看 `streamingBehavior`，不看 `source`。而 pi 中**扩展内部**发起的用户消息同样会触发 `input`：

- `pi.sendUserMessage(...)` → `agent-session.prompt(text, { source: 'extension' })`（`dist/core/agent-session.js:1107-1134`）
- `prompt()` 内 `emitInput(currentText, images, options?.source ?? 'interactive', this.isStreaming ? options?.streamingBehavior : undefined)`（同文件 `:813-822`）——**空闲时 `streamingBehavior` 为 `undefined`**

由此得到两个相反的错：

1. **内部消息清空 OCC 状态**：`index.ts:447` 的 D96 唤醒通知、`index.ts:636` 的 `notices.flush('followUp')`、pipe 注入消息，都会把 `completedBoundaryRequestCounts`、`carriedDebtTokens`、`selectedCompaction`、`pendingBoundaryCompleted` 全清、epoch+1 —— 与 RFC 想避免的"样本污染"同类，只是方向相反（不是噪声进入，而是样本被反复清零）。
2. **人类 steer 输入不生效**：人类在流式中 steer 正是 RFC §4.1 A.4 与 review §8 矩阵要求"作废已选压缩 + 清空样本"的场景，现在被 `streamingBehavior === 'steer'` 跳过。

**修复**: 按来源判定，而不是按投递方式：

```ts
const fromHuman = event.source === 'interactive' || event.source === 'rpc';
if (fromHuman) { /* reset */ }
```

（若确实想排除系统 `CORRECTION:` 前缀，保留第二个条件即可。）

---

### P1-3 ObservationPack 热路径 I/O 放大

**位置**:
- `packages/pier-ext/src/core/observation.ts:204-208`（`context` handler 内，**在 `fullSends`/`canPack` 判定之前**）
- `packages/pier-ext/src/efficiency-store.ts:86-104`（EEXIST 分支）

```ts
const objPath = observationObjectPath(sessionRoot, obsId);
try { await storeContentAddressedObject(objPath, text); } catch { continue; }
const sendCount = priorAssistantCounts[i] ?? 0;
if (sendCount < obsConfig.fullSends) continue;      // ← 落盘发生在"是否需要"之前
```

```ts
} catch (err) { if (err.code === 'EEXIST') {
  const existingHandle = await open(filePath, READ_OBJECT_FLAGS);
  const existingData = await existingHandle.readFile();     // ← 整文件读
  if (sha256Hex(existingData) !== hash) throw ...
```

**实测**（§7.2）：8MB 对象，EEXIST 校验路径 **49.0 / 48.8 / 46.1 ms**（连续 3 次，纯 CPU+磁盘）。`context` 事件在**每次 provider 请求前**触发，对上下文中每条超过阈值的工具结果各跑一次 → 少量大日志即可累积数百 ms 的同步等待，且发生在请求关键路径上。

**附带问题**: ① 未打包的消息也会落盘（占位符从未出现在 transcript，`objects/` 里留下无句柄垃圾，且仓库无清理策略）；② 与 RFC §6 承诺的"自动轮转清理"一起构成磁盘无界增长。

**修复**:
1. 把落盘移到"确定要打包"之后（或在 `sendCount >= fullSends && canPack` 分支内惰性落盘）；
2. 进程内维护 `Set<string>`（已验证的 `obsId`/path+size），EEXIST 时 size 相同即跳过全量读+哈希；
3. 补一句"该文件的生命周期由会话目录统一回收"的说明，或加保留策略。

---

### P1-4 `agent_settled` 里 `await` 整段压缩，阻塞后续 settled handler

**位置**: `packages/pier-ext/src/index.ts:450`，实现见 `packages/pier-ext/src/compact-coordinator.ts:203-282`

```ts
await coordinator.onAgentSettled({ ... });   // 内部 await 一个只在 onComplete/onError 才 resolve 的 Promise
```

pi 的事件分发是**逐 handler 串行 await**（`dist/core/extensions/runner.js:579-608`）。同扩展内按注册顺序，被 `:450` 挡在后面的 handler 包括：

| 后续 handler | 位置 | 被延迟的后果 |
|---|---|---|
| subagent 结算通知 flush | `index.ts:636` | 结算提醒迟滞一次压缩 |
| D50 machine request 回推 | `index.ts:674` | 回推延迟（5s 超时窗口内可能失败） |
| master 插件（todo/subagent） | `index.ts:701` → `index-master.ts` | **催办判定与结算对账迟滞**；且此时 `compactionInFlight` 已被复位，`planStopTodoReminder` 的双判守卫实际失效（现靠 `stopReason === 'aborted'` 兜住） |
| worker 分支（todo） | `index.ts:723` | 同上 |

**顺带**: `compact-coordinator.ts:203` 的 `!opts.ctx.isIdle()` 判据是恒真的死代码——pi 在 emit `agent_settled` 之前就已 `_isAgentRunActive = false`（`dist/core/agent-session.js:327-330`）。

**修复**: 标志位在 await 之前就已同步置位，因此直接 fire-and-forget：

```ts
void coordinator.onAgentSettled({ ... });
```

同时给 `compactionInFlight`/`intentionalAbort` 加一条兜底复位路径（例如 `turn_start`/`session_shutdown`），防止 provider 长时间无响应时状态永久卡住。

---

### P1-5 配置校验失败没有按 RFC 回退 `disabled`

**位置**: `packages/pier-ext/src/efficiency-config-core.ts:349-355`

```ts
const validated = validateEfficiencyConfig(baseRaw);
if (!validated.ok) {
  warn(`配置存在校验问题，已安全回退默认值: ${validated.issues.join('; ')}`);
}
resolved = validated.config;      // ← enabled 保持用户填的值
```

RFC §3.1 明文要求：「若发现未知字段或类型非法，一次性收集全部错误并打印单行 stderr 警告，**对应机制安全回退为 disabled（Fail-open）**」。

**影响**: `additionalProperties:false` 的防拼写静默失败设计被削弱 —— `{ "observationPack": { "enabled": true, "thresholBytes": 1024 } }`（拼错键）会保留 `enabled: true`（同时 threshold 静默回默认值）；EPR 同理，等于"打错一个键名仍可开启日志外发"。

**修复**: `!ok` 时按 section 收敛：出现 issue 的 section 强制 `enabled = false`（或整体 disabled），并补一条"非法配置 → 机制 disabled"的测试（当前测试只断言 `ok === false` 与 issues 文案）。

---

## 2. P2：与设计文档不符 / 闭环缺失

### P2-6 债务台账只做了一半（无还债，`cacheDebtRepaymentTokens` 未参与计算）

- `packages/pier-ext/src/compact-coordinator.ts:241` 每次压缩**覆盖** `carriedDebtTokens = writeTokens × incrementalRatio`，此前债务不结转、也不随请求递减（review §2.2 要求"之后每个请求用 savingTokens 还债"）。
- `cacheDebtRepaymentTokens` 在 `compact-economics-core.ts:72/141/238` 只是**输入→回显**，从未进入任何算式；`compact-coordinator.ts:40/54/75/171/242` 是读写全链路，却没有消费者。

**结果**: review §5.3 / D103 声称的"预测 vs 实测还债轮次"闭环不存在（遥测只有 `breakevenRequests` 预测值，无 `observedRepaymentRequests`；也未接 pi 的 `cache-stats` cache miss / `CACHE_TTL_MS`）。连续压缩时"必须先清掉未偿债务"的 `carriedDebtGateOpen` 退化为"只看本次新债"。

**建议**: 要么实现真正的递减台账（`onBeforeProviderRequest` 里按 `savingTokens` 递减并在遥测记录实测还债轮次），要么在 RFC 里把 D103 的闭环描述降级为"预留字段"。

### P2-7 OBS 未复用 OCC 经济学；打包时机与 RFC 不一致

- `packages/pier-ext/src/core/observation.ts:247`：`expectedRemainingRequests: 4` 硬编码，而 RFC/review 要求余量来自同一条 horizon 估计（`compact-economics-core` 已有该能力）。
- RFC §4.2「批量打包收敛：优先在 OCC 压缩点或里程碑边界执行批量投影打包，此时打包顺路免费」**未实现** —— 现在是每条消息各自到点即打包，正是"每轮重写一次前缀缓存"的最坏模式。
- 公式口径三处不一致：`observation-core.ts:180-186` 用 `tailTokensAfter × (ratio − 1)`；RFC §4.2 写 `tailTokensAfter × cacheWritePrice`（未减 1）；ADR 0005 又写 `(ratio − 1)`。建议统一为 `(ratio − 1)`（压不成也要付一次 read，增量口径与 OCC 一致），并回改 RFC 正文。

### P2-8 `observationPack.recallChunkBytes` 是死配置

`efficiency-config-core.ts:33/69/107/224-228` 定义、校验、存值，但 `obs_recall` 硬编码 `RECALL_MAX_BYTES = 16KB` / `RECALL_MAX_LINES = 400`（`core/observation.ts:95`）。用户改配置无任何效果 → 要么接线，要么从 schema/类型里删掉（避免"看似可调"的假接口）。

### P2-9 与 pi 压缩设置的双份默认值仍会漂移

- `compact-coordinator.ts:32` `DEFAULT_KEEP_RECENT_TOKENS = 20_000` 与 `compact-economics-core.ts:24-27` `windowReserveTokens: 16_384` 恰好等于 pi 的默认 `compaction.keepRecentTokens/reserveTokens`，但实现**不读 pi 的实际设置**（review §2.4 明确要求删掉或改读）。
- 具体故障：用户把 `keepRecentTokens` 调到 100k → `nativeCompactionFeasible(branch, 20000)` 判 true → `ctx.abort()` → 真实压缩报 "Nothing to compact (session too small)" → **净亏一轮**，正是该 preflight 存在的理由。
- 另外 OCC 不读 `compaction.enabled=false`；review 要求"要么尊重该设置，要么在文档里显式声明『启用 OCC 即接管压缩时机』"——目前两者都没做。

### P2-10 遥测与 RFC §6/§5 有缺口

| 缺口 | 依据 |
|---|---|
| `efficiency-telemetry-core.ts` / `efficiency-telemetry-writer.ts` / `test/efficiency-telemetry-core.test.ts` **三个文件不存在** | RFC §6 文件树与 §7 阶段验收 |
| 无日志轮转 / 保留策略（"自动轮转清理"） | RFC §6；review §5.6 明确点出上游"archives 不自动清理"是已知缺陷 |
| 日志缺 `epoch` / `sessionId`（只有 `schema`+`mechanism`+ISO `ts`） | review §5.5 |
| 密钥命中**无任何记录**（RFC 要求 `fallback: likely-secret`），其余回退原因（截断、存储失败、模型超时）也只在"验真失败"时落一条 | RFC §3.4.2 / §7.2 矩阵 |
| `core/observation.ts:257` 只在 `sendCount === fullSends` 时记 `packed`；若该点因缓存经济学未打包，之后任何真实打包都不落日志 | 采集真实命中率的目标 |
| `savedTokens` 未标注为**毛收益**（review §3.1.3 明确要求） | review §3.1 |

### P2-11 `usage.tokens` 为 `null` 时被打成 `0`，污染增量样本

`index.ts:395` `coordinator.onBeforeProviderRequest(usage?.tokens ?? 0)`。pi 在**压缩完成到下一次 assistant 响应之间**返回 `{ tokens: null, contextWindow }`（`dist/core/agent-session.js:2542-2575`，已核对）。于是：该次记 0 → `lastContextTokens = 0` → 下一次请求的整段上下文被算作一条"正增量" → `positiveContextDeltaTotal` 虚高 → `averageContextTokenIncrement` 虚高 → `windowRequestUpperBound = (window − context)/avgIncrement` 变小 → `expectedRemainingRequests` 被压小 → OCC 长期判 `deferred_economic`（压缩后恰好是最该重新校准的时刻）。

**修复**: 只在 `typeof tokens === 'number'` 时采样；`onTurnEnd` 的 `usage?.tokens ?? this.state.lastContextTokens ?? 0` 同样应区分"未知"与"0"。

### P2-12 临时目录校验使用弱包含判断

`efficiency-store.ts:180` `if (!realFile.startsWith(realTmp)) return null;` —— 若 `tmpdir()` 为 `/tmp`，则 `/tmpEvil/x.log` 可通过。其余两道检查（文件名正则、`O_NOFOLLOW` 打开）是对的，建议补 `path.relative(realTmp, realFile)` + 分隔符/`..` 校验。

---

## 3. P3：nits / 流程

1. **类型放水 + 无 typecheck 门禁**：`index.ts:262/406/450` 的 `event as any` / `ctx as any`；`ReducerInvocationResult.content` 的 `{ type: string; text?: string }` 并不满足 `ToolResultEventResult` 的 `(TextContent | ImageContent)[]`；`(opts.pi as { appendEntry?: … })` / `sendMessage` 的 cast 完全没必要（`ExtensionAPI` 上两者都有明确签名：`appendEntry<T>(customType, data?)`、`sendMessage(msg, opts)`）。仓库无 `tsconfig.json`、无 `tsc` 脚本，`node --test` 直接 strip types、Stryker 未挂 typescript-checker → 这类错误永远不可见。是否引入 typecheck 门禁是独立决定，但至少新代码不该主动擦除类型。
2. **HMR 注册边界**：`registerObservationPack`（`index.ts:559`）与新增的 `pi.on` 走裸 `pi`，绕开了 core 模块惯用的 `PiSurface.forModule` + ledger（D79/D87）。`index.ts` 既有代码同样如此，属"沿袭但未收敛"；建议在 RFC/ADR 里明确取舍（entry 层允许裸注册 vs 模块层必须走 surface）。
3. **文档锚点错行**：`docs/decisions.md:65-68` 的 D100–D103 锚点未指向决策点（`:65` 指向 `compact-economics-core.ts:133` = `readonly memoTokens: number;`；`:66→observation-core.ts:153`、`:67→reducer-core.ts:140`、`:68→efficiency-config-core.ts:246` 同样落在无关行）；建议分别改指 `decideCompaction` / `shouldPackForCache` / `validateReceipt` / `resolveEfficiencyConfig`。另该文件尾部多了一个空行。
4. **状态标注超前**：RFC 头部「已实现通过 (Implemented & Verified)」与 P1-1/P2-6/P2-10 不符，建议改为「已实现，待修复（Implemented, pending fixes）」并在 §7.1 勾选项里标注失败矩阵未覆盖的行。
5. **EPR 细节**：`reducer-invoker.ts:83` 取首个 text block，更稳妥是取最大/最后一个（防其它 extension 前置插入块）；review §4.5「同一条失败命令重复跑只提炼最近一次」未实现（10 次 `npm test` = 10 次模型调用 × 日志全量输入）。
6. **作用域未声明**：`registerObservationPack`（`index.ts:559`）与 EPR handler（`index.ts:260`）都在 master/worker 分叉**之前**注册，worker 同样启用三机制；review §6 建议 OCC/EPR 保守到 master-only。无论选哪种，应在 RFC 里写明，并说明 `PI_HERDR_*` 覆盖在 worker 内是否生效。
7. **验收证据不足**：RFC §7.2 矩阵仍有 3 行无测试（EPR 截断回退、EPR 密钥命中遥测、OCC 压缩中 ESC/`onError` 路径——`compact-integration.test.ts` 只覆盖 `onComplete`）；`reports/mutation/*` 时间戳（2026-08-29）早于本次改动，4 个新核心**没有** Stryker 分数，"Stryker 严苛覆盖"目前无凭据（本次审阅未运行：`commandRunner` 是每 mutant 全量跑测试，代价过大）。

---

## 4. 值得肯定的部分（建议保留，勿在修复中改坏）

- `nativeCompactionFeasible` 忠实移植了"合成 `stopReason:'aborted'` marker + `findCutPoint` 空切点预检 + 绝不空 abort"这一上游已验证的关键点（`compact-economics-core.ts:288-339`）。
- **写锁告警不会被吞**：EPR handler（`index.ts:260`）注册在 `installWriteLocks`（`index.ts:267`）**之前**，且只替换日志所在 block，`index-locks` 的追加告警得以保留 —— review §4.6 的硬约束正确落地（`reducer-integration.test.ts` 有断言）。
- 内容寻址存储做得很扎实：`O_EXCL` + `EEXIST` 完整性校验 + `O_NOFOLLOW` + `0600/0700` + `safeSessionId` 正则 + `sessionDir` 缺失时 fail-open。
- `validateReceipt` 三重防线（逐字节引文 + `status` 与 `isError` 一致 + 失败日志必须有 `fatal/failure` 证据）与 `LIKELY_SECRET` 过滤、`isProjectTrusted()` 信任门控、`localOnly` 模式，全部按 review §4.4 落地。
- `obsId` 确定性派生（`toolName \0 toolCallId \0 contentHash`）、`priorAssistantCounts` 推导 `sendCount`（resume/fork/HMR 一致）、`obs_recall` 角色门禁（`planToolGate` deny 即整体不打包）、`isError` 与 EPR 收据豁免打包，均与 review §3 一致。
- fail-open 贯穿全链路：存储失败、模型异常、验真失败、收据不小于原文、会话目录缺失，全部静默回退原文。
- 测试质量：36 个纯核 + 12 个集成用例与 RFC 数量一致，`efficiency-store` 覆盖了路径遍历、幂等写、篡改检测、tmpdir 校验等边界。

---

## 5. 最小修复集（建议按序）

1. `reducer-invoker.ts:88-92`：截断且无 `fullOutputPath` → fail-open（+ 矩阵测试）。
2. `compact-coordinator.ts:114-116`：改按 `event.source` 判定人类输入（+ 两条用例：extension followUp 不清空 / interactive 清空）。
3. `efficiency-config-core.ts:349-356`：校验失败 → 对应机制 disabled（+ 用例）。
4. `index.ts:450`：改为 `void` 调用，并把 `compactionInFlight` 复位兜底挂到 `turn_start`/`session_shutdown`。
5. `core/observation.ts:204-208`：落盘移到打包分支内 + 进程内已验证集合（消除每请求 48ms 级开销）。
6. 文档同步：RFC 状态降级、§4.2/§4.3 与实现口径对齐、`docs/decisions.md` 锚点修正、把 P2-6/7/10 的未兑现项标注为后续工作（或实现）。
7. 补测试：EPR 截断行、EPR 密钥命中遥测、OCC `onError`/ESC 路径；把 4 个新核心纳入一次真实 Stryker 运行并留档 `reports/`。

---

## 6. 审阅清单（文件级）

**新增源文件**（12）
`compact-economics-core.ts`(339) · `observation-core.ts`(190) · `reducer-core.ts`(231) · `efficiency-config-core.ts`(454) · `efficiency-store.ts`(202) · `compact-coordinator.ts`(327) · `reducer-invoker.ts`(259) · `core/observation.ts`(279) · `schemas/efficiency-config.schema.json`(57) · `docs/rfc-sol-pi-absorption.md` · `docs/rfc-sol-pi-absorption-review.md` · `docs/adr/0005-efficiency-mechanisms-absorption.md`

**新增测试**（8，共 48 用例）
`compact-economics-core.test.ts`(9) · `observation-core.test.ts`(7) · `reducer-core.test.ts`(6) · `efficiency-config-core.test.ts`(9) · `efficiency-store.test.ts`(5) · `compact-integration.test.ts`(5) · `observation-integration.test.ts`(3) · `reducer-integration.test.ts`(4)

**改动源文件**（9）
`index.ts` · `index-master.ts` · `todos-service.ts` · `core/todo.ts` · `todo-reminder-core.ts` · `settle-wake-core.ts` · `docs/decisions.md` · `docs/adr/README.md` · `stryker.conf.json`

---

## 7. 附录：验证与复现

### 7.1 测试基线

```bash
node --test "packages/pier-ext/test/*.test.ts"   # tests 593 / pass 593 / fail 0
npm test                                          # monorepo: tests 638 / pass 638 / fail 0
```

### 7.2 EPR 截断视图复现（P1-1）

```ts
// 关键构造：truncation.truncated=true 且无 details.fullOutputPath
const truncatedView = 'tail line output\n'.repeat(400) + 'test result: ok. 5 passed\n';
const res = await handleReducerToolResult({
  toolName: 'bash', toolCallId: 'tc', input: { command: 'npm test' },
  content: [{ type: 'text', text: truncatedView }],
  details: { truncation: { truncated: true, truncatedBy: 'lines' } },
  isError: false,
}, ctx /* isProjectTrusted:true + mock model 返回合法收据 */,
  { ...DEFAULT_EFFICIENCY_CONFIG.evidencePreservingReducer, enabled: true, minBytes: 512, logEnabled: true });

// 实测输出：reduced = true
//   sol_pi_evidence_receipt_v1 / status=success / source_bytes=6826
//   telemetry: {"action":"applied","verificationOk":true,"compressionRatio":0.132}
// 期望（RFC §7.2 矩阵行）：放弃提炼、回退全文。
```

### 7.3 内容寻址存储 EEXIST 开销（P1-3）

```ts
const content = 'x'.repeat(8 * 1024 * 1024);      // 8MB 大工具输出
await storeContentAddressedObject(p, content);    // 首次写入
for (let i = 0; i < 3; i++) {
  const t = performance.now();
  await storeContentAddressedObject(p, content);  // EEXIST 路径（= 每轮 provider 请求付出的成本）
  console.log(`EEXIST verify #${i + 1}: ${(performance.now() - t).toFixed(1)} ms`);
}
// 实测：49.0 ms / 48.8 ms / 46.1 ms
```

### 7.4 关键外部事实锚点（pi 0.84.2）

| 事实 | 位置 |
|---|---|
| 事件 handler 串行 `await` | `dist/core/extensions/runner.js:579-608` |
| `tool_result` 返回值语义（`content` 整体替换 + `usage` 持久化） | `dist/core/extensions/runner.js:653-698`、`dist/core/agent-session.js:244-271` |
| `sendUserMessage` 触发 `input` 且 `source:'extension'`；空闲时 `streamingBehavior` 为 `undefined` | `dist/core/agent-session.js:1107-1134`、`:813-822` |
| `agent_settled` 前 `_isAgentRunActive = false` | `dist/core/agent-session.js:327-330` |
| 压缩后 `getContextUsage()` 返回 `tokens: null` | `dist/core/agent-session.js:2542-2575` |
| `ctx.compact()` 的 `onComplete` 在 `finally` 清空 `_compactionAbortController` 之后调用（此处发续跑消息安全） | `dist/core/agent-session.js:1367-1482`、`:1911-1922` |
| bash 截断时才写 `details.fullOutputPath` | `dist/core/tools/output-accumulator.js:69-95` |
| pi 压缩默认值 `reserveTokens: 16384` / `keepRecentTokens: 20000` | `dist/core/compaction/compaction.js:74-78` |

---

## 8. Round 2 复审详情（修复验证与新发现）

### 8.0 验证方法

1. 逐条按 Round 1 的 file:line 复查改动后的实现；
2. 全量测试：`node --test "packages/pier-ext/test/*.test.ts"` → **596/596**；`npm test` → **641/641**（Round 1 为 593/638，净增 3 个用例：EPR 截断回退、EPR 密钥命中遥测、配置 fail-open；P1-2 由扩展现有用例覆盖）；
3. 三个定向实验（均在本仓 `spike/` 临时目录内运行后删除，未留残留）：
   - EPR 截断视图（P1-1）：mock model 返回合法收据 + `truncation.truncated:true` 且无 `fullOutputPath` → **返回 `undefined`、模型未被调用**、遥测 `{"reason":"truncated-source","action":"fallback_full_text"}`；
   - 债务还债台账（P2-6）：`carriedDebtTokens=1000 / cacheDebtRepaymentTokens=300` → 3 次 `onBeforeProviderRequest` 后 `100`，第 4 次后 `0`（下限夹紧）**符合预期**；
   - 内容寻址存储 EEXIST 成本（P1-3）：8MB 对象重复调用 **49.0 / 48.8 / 46.1 ms** —— 与 Round 1 完全同量级（见 N1）。

### 8.1 新发现

#### N1（P1 级遗留）ObservationPack 热路径 CPU 未收敛

`efficiency-store.ts` 的 `verifiedObjectCache` 只省掉了「重复读盘 + 哈希文件」，但**每次 provider 请求仍要对整段文本重算一遍**。8MB 单条打包观察实测：

| 每请求重复工作 | 位置 | 8MB 耗时 | 1MB | 128KB |
|---|---|---|---|---|
| `sha256Hex(text)`（obsId 派生用） | `core/observation.ts:225` | 14.3 ms | 1.3 ms | 0.6 ms |
| `Buffer.byteLength(text)` | `core/observation.ts:200` | 5.6 ms | 0.7 ms | 0.1 ms |
| `countLines(text)`（JS 逐字符循环） | `core/observation.ts:232` | 27.5 ms | 3.4 ms | 1.7 ms |
| `formatObservationPlaceholder`（两次 `text.split(/(?<=\n)/)` 全文切行） | `observation-core.ts:52-72` | 97.7 ms | 12.5 ms | 1.6 ms |
| **小计（不含 store）** | | **145 ms** | 17.9 ms | 4.0 ms |
| `storeContentAddressedObject` 内再算 `byteLength + sha256 + countLines` | `efficiency-store.ts:80-84` | 44.6 ms | ~5 ms | ~2 ms |
| **端到端实测（一条 8MB 打包项 / 每请求）** | | **133 ms** | ~23 ms | ~6 ms |

> 组件为单项隔离测量（JIT 已预热），端到端实测略低于组件之和（单次合并遍历 + GC 压力不同）；量级与结论不受影响。

要点：

- 该成本**每轮请求重复支付**（投影不落盘，下一轮从原始消息重算），并非一次性的；上下文里同时有 3～5 条大日志时，每轮请求额外增加 0.4–0.7 s。
- `deriveObservationId` 需要的 `contentHash`、`countLines`、`byteLength` 与 `storeContentAddressedObject` 内部算的**是同一批值、算了两遍**；后者本就 `return { path, bytes, lines, hash }`，可复用。
- 建议（按性价比排序）：
  1. 在 `core/observation.ts` 用 per-`obsId` 的 `Map` 记忆化 `{ placeholderText, placeholderTokens, lines, bytes, sha256 }`（已有的 `loggedPackedObsIds` 就是这个形态，扩成 Map 即可）——命中后每请求只剩一次 Map 查找；
  2. `completeLineExcerpt` 改为「从头扫到凑够 head 预算、从尾倒扫凑够 tail 预算」，避免全文 `split`（8MB 下这一项独占 98 ms）；
  3. `storeContentAddressedObject` 接受调用方已知的 `{hash,bytes,lines}`，避免二次计算。

#### N2（P3 级回归）`verifiedObjectCache` 削弱了 EEXIST 完整性校验

`efficiency-store.ts:110` 命中缓存即跳过 `readFile + sha256` 比对。若磁盘上的同名对象被替换成**等长**不同内容，校验将被跳过（Round 1 的 EEXIST 校验会抓到此情形）。现有测试仍能通过，是因为篡改样本（`'tampered content'`）与原文长度不同，走的是 size mismatch 分支。建议 cacheKey 纳入 `mtimeMs`/`ino`，或对 reducer 目录（内容寻址、路径即 sha256）保留校验。另：`clearVerifiedObjectCacheForTest()`（`:35-37`）目前**无任何测试调用**，属死导出。

#### N3（文档）状态与数字不实

- `docs/rfc-sol-pi-absorption.md:3` 写「已根据 code review.md 完成全量修复与生产级加固」——实际 P2-7/P2-9/P2-10 未修，N1 为 P1 级遗留；
- `:5` 写 595 / 640，实测 596 / 641；
- `:243-244`、`:296` 仍主张「OCC 压缩点批量打包」与 `tailTokensAfter × cacheWritePrice` 公式，与代码（`(ratio−1)`）和 ADR 0005（`(ratio−1)`）三方不一致；
- `:318/324/341` 仍列 `efficiency-telemetry-core.ts` / `efficiency-telemetry-writer.ts` / `efficiency-telemetry-core.test.ts`（三个文件不存在）。

建议：要么补齐实现，要么把这四处改成「当前状态 + 明确取舍」，并把 status 降为「Implemented, pending: OBS hot-path memoization / pi compaction settings / telemetry rotation」。

#### N4（小）其余细节

- `loggedPackedObsIds`（`core/observation.ts:43`）是无上限模块级 Set，跨会话累积（仅用于抑制重复日志，量级很小，但无回收）；
- `turn_start` 无条件复位 `compactionInFlight`/`intentionalAbort`（`index.ts:389-391`）在「压缩飞行中启动新 run」的极端场景会提前解除守卫——当前 pi 会拒绝压缩期间的 prompt（`agent-session.js:807`），因此安全，但建议加一行注释说明该前提；
- `logDecision`（`compact-coordinator.ts:330+`）缺少 `sessionId`/`epoch`，与 `onComplete` 的日志字段不一致，不利于按会话聚合；
- `cacheDebtRepaymentTokens` 还清后不清零（残留旧值，无功能影响）。

### 8.2 仍缺的测试（Round 1 §7 矩阵 + 本轮新逻辑）

| 缺口 | 说明 |
|---|---|
| 债务还债递减 | 本轮新逻辑（`compact-coordinator.ts:106-113`）无用例；我用手写实验验证通过 |
| OCC 压缩中 ESC / `onError` | `compact-integration.test.ts` 仍只覆盖 `onComplete` 成功路径 |
| `usage.tokens === null` 跳过采样 | `index.ts:396-398` 的分支无用例 |
| `verifiedObjectCache` 命中 / 篡改（等长不同内容） | 见 N2 |
| Stryker 分数 | 4 个新核心仍无 mutation 报告（`reports/mutation/*` 早于本次改动） |

---

## 9. Round 3 复审详情（第二轮修复验证）

### 9.0 验证方法

1. 逐条复查 Round 2 的 N1/N2/N4 与未闭合的 P2-7/9/10；
2. 全量测试：`pier-ext` **598/598**、monorepo **643/643**（Round 2 为 596/641，净增 2 个用例：还债递减、OCC `onError`）；
3. 三项定向实验（临时脚本已删）：
   - OBS 热路径：直接驱动 `registerObservationPack` 的 `context` handler（800 万字节单条工具结果，`fullSends=1`），连续 4 次请求：**515 ms（首次，memo miss）→ 97.7 / 68.7 / 216.2 ms（memo hit）**；
   - 组件归因（预热后 7 次取中位数，8MB）：`containsReducerReceipt` **41.7 ms**（其中 `text.split('\n')` 28.3 ms）、`Buffer.byteLength` **7.5 ms**、两者合并 **52.5 ms**；
   - 存储缓存：mtime 键 + 等长篡改用例均按预期 `throw /hash mismatch|size mismatch/`。

### 9.1 N1′（P1 级残留）仍然存在半量预扫描

memo 命中后跳过了 sha256/countLines/摘录/store 重算（这三项在 Round 2 合共 ~183 ms），但**命中判断排在下列全量操作之后**：

```ts
const text = content.map((b) => b.text ?? '').join('\n');   // 1 元素时不拷贝，成本可忽略
if (containsReducerReceipt(text)) continue;                  // ← 8MB：41.7 ms（全文 split + 40 万次 trim）  `core/observation.ts:207`
const textBytes = Buffer.byteLength(text, 'utf8');           // ← 8MB：7.5 ms                              `:209`
if (textBytes < obsConfig.thresholdBytes) continue;
...
const memoized = placeholderMemo.get(memoKey);               // ← 命中时已白付 ~50 ms                     `:223`
```

修复建议（按性价比）：

1. **把 memo 查找提到 `containsReducerReceipt`/`byteLength` 之前**（键用 `sessionRoot:toolCallId:text.length`，`text.length` 是 O(1)）——memo 命中必然意味着「这条消息此前已被我们打包」，因此收据扫描与阈值判定都可安全跳过；
2. `containsReducerReceipt` 改为无分配探测：先 `text.includes(REDUCER_RECEIPT_PREFIX)`（~ms 级、无数组分配），命中才做逐行精确比对（`observation-core.ts:48-50`）；
3. memo 内联缓存 `bytes`/`placeholderTokens`，命中后不再算 `Buffer.byteLength`；
4. 可选：`MAX_MEMO_ENTRIES` 淘汰改为 LRU（当前 FIFO，命中不刷新位置）。

### 9.2 本轮新引入行为的三个观察（建议写入 RFC）

1. **「一次性判定 + 粘性打包」语义**：memo 命中分支（`core/observation.ts:224-231`）直接占位，**不再重新评估 `shouldPackForCache`**。这实际上更正确——一旦上轮已发出占位符，这轮改为全文会再次重写整段前缀；但 RFC §4.2 描述的仍是「每请求按公式判定」，两者需要对齐（建议明确写「首次按公式判定，之后粘性保持，直到 memo 淘汰」）。
2. **memo 键只用 `toolCallId + text.length`**：同一 `toolCallId` 下若出现等长不同内容（实践中几乎不可能，`toolCallId` 唯一），会命中陈旧占位符 → `obs_recall` 返回旧内容（静默证据错位）。可接受，但建议加一句注释说明代价与前提。
3. **失去自愈能力**：memo 命中不再调用 `storeContentAddressedObject`，若 `objects/` 下文件被外部删除（人工清理/磁盘回收），`obs_recall` 会持续报错直到该条 memo 被淘汰。建议在 `obs_recall` 读失败时清掉对应 memo（自愈）或文档声明。

### 9.3 Round 4 待办（精确定位）

| 项 | 位置 | 动作 |
|---|---|---|
| N1′ 预扫描 | `core/observation.ts:207-223`、`observation-core.ts:48-50` | memo 前置 + 无分配收据探测（§9.1） |
| P2-9 pi 设置 | `compact-coordinator.ts:32/167/204` | 读 pi 有效 `compaction.keepRecentTokens`（或改为显式配置项），并在文档声明是否接管 `compaction.enabled` |
| P2-7 OBS horizon | `core/observation.ts:265` | 接 OCC 的 horizon（或加配置项），同步 RFC §4.2/§5 的「批量打包」表述 |
| P2-10 遥测 | `efficiency-store.ts`(`appendEfficiencyLog`)、`reducer-invoker.ts:283` | 日志轮转/上限；reducer 日志补 `sessionId`/`epoch`；`savedTokens` 标毛收益 |
| P3 | `index.ts:262/406/454`；根 `package.json`；RFC | 去 `any`（`appendEntry`/`sendMessage`/`ctx` 都有类型）、加 typecheck 门禁、补 worker 作用域声明、修正 `rfc:3/244/296` 与 §7.1 计数、留一次 Stryker 报告 |
| 测试 | `test/observation-integration.test.ts` | 补 memo 命中/粘性/淘汰用例；`usage.tokens === null` 跳过采样用例 |

---

## 10. Round 4 复审详情（第三轮修复验证）

### 10.0 验证方法

1. 逐条复查 Round 3 的 N1′/P2-7/P2-9/P2-10/P3 与新增测试；
2. 全量测试：`pier-ext` **600/600**、monorepo **645/645**（Round 3 为 598/643，净增 2 个用例）；
3. OBS 热路径基准（临时脚本已删）：直接驱动 `registerObservationPack` 的 `context` handler，800 万字节单条工具结果、`fullSends=1`、`getRemainingHorizon` 返回 25 并计数：

```text
text: 8.0 MB
request #1: 73.6 ms  packed=true      ← memo miss（sha256/countLines/摘录/store）
request #2:  0.3 ms  packed=true      ← memo hit（LRU 刷新 + 直接占位）
request #3:  0.0 ms  packed=true
request #4:  0.0 ms  packed=true
getRemainingHorizon calls: 1          ← 命中路径不再重新决策 ✅
```

对比：Round 2 为 133 ms/请求（全量重算），Round 3 为 68–216 ms/请求（memo 前仍全量预扫描），Round 4 命中路径 **≈0 ms**。N1 系列已收敛完成。

### 10.1 代码侧评估

- **快路径的键设计**：`sessionRoot:toolCallId:approxChars`（`approxChars = Σ b.text.length`，O(#blocks)、O(1)/块）。仍然存在「同 toolCallId + 等长不同内容 → 陈旧占位符」的理论风险，但比 Round 3 更明确——该键在**不触碰文本**的前提下工作，是当前 API 下最便宜的可用签名；建议在代码注释里把这一取舍写明白（目前只在测试名里体现）。
- **粘性语义**：命中即占位、不再评估 `shouldPackForCache`（注释已写明 “Once packed, observation remains sticky until memo eviction” ✅）。这是正确取舍：已发出占位符后回退全文会再重写一次前缀；但它与 RFC §4.2「每请求按公式判定」的表述仍不一致——建议 RFC 补一句。
- **`completeLineExcerpt` 重写**：head 路径改为「预算窗口内逐行扫」（`observation-core.ts:55-77`），tail 在 4KB 窗口内 split 并跳过窗口首行的半截行（`startOffset>0 && text[startOffset-1] !== '\n'` → break），语义与旧版一致且避免全文分配；现有 7 个 `observation-core` 用例覆盖整行边界 ✅。
- **`getRemainingHorizon` 接入**：方向正确（OBS 不再用魔法常量 4），但见 N7（重复公式 + 无测试 + 硬编码 3 个剩余边界）。建议改为 `estimateRemainingRequests({..., remainingBoundaries, scale, standardDeviationK:0, contextTokens, contextWindowTokens, averageContextTokenIncrement})` 的薄封装，并补 2 个单测（无样本 → 4；有样本 → 均值派生）+ 1 个集成断言（`getRemainingHorizon` 被调用且 memo 命中时不重复调用）。

### 10.2 剩余清单（Round 5）

| 优先级 | 项 | 位置 | 动作 |
|---|---|---|---|
| P1 | N5 worker 默认声明 | `rfc:287-288` vs `index.ts` | 要么实现 worker 差异化（OBS 强制开），要么改成「三机制默认全关，worker 需显式开启」 |
| P1 | N6 契约漂移 | `schemas/efficiency-config.schema.json`、`rfc` §3.2 | 把 `keepRecentTokens`（含 default/minimum）补进 schema 与 RFC 配置块 |
| P1 | N7 horizon 重复实现 | `compact-coordinator.ts:335-340` | 复用 `estimateRemainingRequests` + 补单测 |
| P2 | 遥测清理 | `efficiency-store.ts`(`appendEfficiencyLog`)、`objects/` | 加日志行数/字节上限或按会话清理；reducer 日志补 `epoch` |
| P2 | 批量打包 | `rfc:244/300` vs `compact-coordinator.ts` | 实现（压缩点顺路打包）或改写为「逐请求判定 + 粘性」 |
| P2 | pi 压缩设置 | `compact-coordinator.ts:32` | 或读 `~/.pi/agent/settings.json` 的 `compaction.*`，或在 RFC 明写「启用 OCC 即接管，`keepRecentTokens` 用本配置」 |
| P3 | N8 阶段计数 | `rfc:369/377` | 改为 4 / 8 |
| P3 | typecheck + mutation | 根 `package.json`、`reports/mutation/` | 加 `tsc --noEmit` 门禁；对 4 个新核心跑一次 Stryker 并归档 |

---

## 11. Round 5：文档收尾（仅文档/契约，2026-09-13）

本节记录由审阅侧直接完成的**纯文档/契约收尾**（未动任何 `src`/`test` 文件，改完后重跑 `npm test` → **645/645** 仍全绿）。

### 11.1 已关闭

| 原项 | 处理 | 位置 |
|---|---|---|
| N5 worker 默认越界声明 | 改写为与代码一致：「三机制在所有进程默认 `false`，不按 master/worker 差异化；worker 需显式启用」（`isSubagent` 仅用于 todo/通知） | `docs/rfc-sol-pi-absorption.md` §4.3 C |
| N6 契约漂移 | `keepRecentTokens`（integer / default 20000 / minimum 1000）补进 JSON schema 与 RFC §3.2 配置块，并新增「保留窗口说明」：不读 pi settings、启用 OCC 即接管压缩时机 | `packages/pier-ext/schemas/efficiency-config.schema.json`、RFC §3.2 |
| N8 阶段计数 | 阶段一 36→**37**、阶段二 3→**4**、阶段三 5→**8**、阶段四 4→**6**；§8 补上算式（545 + 55 = 600） | RFC §7.1 / §8 |
| 状态标注超前 | 标题改「v2 落地版 · 含 4 轮复审修正」，状态改「已实现并通过 4 轮复审（残余见 §9）」，不再声称「全量修复与生产级加固」 | RFC 顶部 |
| 残余项无登记处 | 新增 **RFC §9 残余事项与后续工作**（七项，含现状/影响/下一动作），与 ADR 的「Known residuals」互相指引 | RFC §9、`docs/adr/0005-…md` |
| 文档锚点漂移 | `D101` → `observation-core.ts:192`（`shouldPackForCache`），`D103` → `efficiency-config-core.ts:368`（`resolveEfficiencyConfig`） | `docs/decisions.md:66,68` |
| 审阅链不可追溯 | 首轮审阅文档加状态行，指向 `code review.md`（Round 1–4）与 RFC §9 | `docs/rfc-sol-pi-absorption-review.md` |
| 批量打包表述 | RFC §4.2 / §5 矩阵改为「逐请求判定 + 粘性保持；压缩点批量打包为尚未实现的后续优化」，不再声称已实现 | RFC §4.2、§5 |

### 11.2 仍属代码/工程基建（未在本次文档收尾中改动）

| 项 | 类型 | 位置 |
|---|---|---|
| 遥测日志与 `objects/` 轮转/保留策略 | 代码（I/O） | `efficiency-store.ts`(`appendEfficiencyLog`)、`objects/` |
| `reducer.jsonl` 补 `epoch` | 代码（传参） | `reducer-invoker.ts` ↔ `compact-coordinator.ts` |
| `getRemainingHorizon` 复用 `estimateRemainingRequests` + 单测 | 代码 + 测试 | `compact-coordinator.ts:335-340` |
| 读 pi 的 `compaction.*`（或加运行时提示） | 代码（可选） | `compact-coordinator.ts:32/167/205` |
| `tsc --noEmit` 门禁；4 个新核心的 Stryker 归档 | 工程基建 | 根 `package.json`、`reports/mutation/` |
| OBS 压缩点批量打包（若仍要做） | 代码（接口改动） | 需 OCC 向 OBS 暴露 bulk-pack 回调 |

> 以上均已登记在 RFC §9 与 ADR「Known residuals」，不阻塞当前默认关闭（fail-open）下的发布基线。

---

## 12. Round 6 复审详情（7 项剩余工作落实验证）

### 12.0 验证方法

1. 逐项复查 7 项改动的实现、接线、测试与文档声称；
2. `npm test`（含新的 typecheck 前置）→ **649/649**；`node --test packages/pier-ext/test/*.test.ts` → **604/604**；
3. **门禁有效性实验**：向被覆盖文件 `observation-core.ts` 临时注入 `const x: number = "not a number"` → `error TS2322` + exit=2（证明门禁非空转），随后恢复原文件（`git diff` 无残留）；
4. **门禁依赖实验**：`node -e require.resolve('typescript')` → `MODULE_NOT_FOUND`；`ls node_modules/.bin/tsc` → 不存在；仅 `/opt/homebrew/bin/tsc`（5.3.3）在 PATH 上；
5. **变异报告核对**：解析 `reports/mutation/mutation.json` 与 `reports/stryker-incremental.json`，逐文件统计 mutants/killed/survived。

### 12.1 批量打包（C1）的四个缺口

| # | 缺口 | 位置 | 影响 |
|---|---|---|---|
| 1 | **接线无测试** | `index.ts:474-486` → `compact-coordinator.ts:243-245` | 测的只是 `batchPackObservations()` 函数自身（`observation-integration.test.ts:311`）；`onBeforeCompact` 在测试中**零命中**，若将来 hook 没被调用/参数错（比如 branch→messages 映射漏掉 `custom` 条目），无测试会红 |
| 2 | **无遥测** | `core/observation.ts:67-135` | 它是**唯一绕过 `shouldPackForCache` 经济学判定**的打包路径，却不写 `observation.jsonl`、不进 `loggedPackedObsIds` → 无法事后审计“顺路免费”打包量（Round 1 §3.1.3 曾明要求记 `tailTokens`/`packedAt`） |
| 3 | **无角色门禁** | `index.ts:474-486` | 只判 `observationPack.enabled`；角色 deny `obs_recall` 时仍会落盘 + 写 memo（`context` handler 的早期 return 保证不会把占位符交给模型，但白白消耗磁盘/CPU） |
| 4 | **无工作量上限** | `core/observation.ts:74-81` | 一次性遍历整条 branch，对每个大输出做 `sha256 + countLines + placeholder + 落盘`（8MB 项 ~70ms/条）；长会话下压缩点可能出现秒级阻塞，与“压缩点本应顺路免费”的初衷相左。建议加“最大条目数/累计字节”上限 |

另：`batchPackObservations` 与 `context` handler 的循环体重复约 40 行（id 派生 / 占位符 / store+memo），两路径容易再次跑偏（缺口 2 就是这么来的），建议抽公共 `packOneMessage()`。

### 12.2 保留策略（A1）与 memo 的交互

- 剪枝按 mtime 升序删到 300 文件 / 50MB 以内（`efficiency-store.ts:79-132`）✅，并在删除时清掉 `verifiedObjectCache` 对应键（`:121-123`）。
- **已知窗口**：被剪掉的对象若仍在 `placeholderMemo` 里，模型下一次 `obs_recall` 会失败一次（随后 Round 4 的自愈机制会 invalidate + 重新落盘）。建议在 RFC/注释里写明这个“一次失败”窗口，或让剪枝跳过 memo 中仍活跃的 obsId。
- `k.startsWith(f.path)` 的缓存清理未带 `:` 分隔符（当前命名下不会误删，但不够严谨）；`session_shutdown` 的剪枝是 `void` 异步（`index.ts:639-640`），进程退出可能赶在删除完成前。

### 12.3 pi 设置读取（A4）的边界问题

- `loadPiNativeCompactionSettings` 硬编码 `~/.pi/agent/settings.json`（`efficiency-config-core.ts:460`），未尊重 `PI_CODING_AGENT_DIR`（pi SDK 有 `getAgentDir()`）；项目文件已做信任门控 ✅。
- `hasExplicitKeepRecent`（`:548-550`）读的是**原始 workspace 配置且不判信任**：未受信项目只要写入 `onlineContextCompact.keepRecentTokens` 就能阻止继承 pi 的值（影响面小，但属信任边界泄漏）。
- `(workspaceConfig as any)` / `(userConfig as any)` 属类型绕行；`reducer-invoker.ts` 的 `(validated as { ok: false; reason: string }).reason` 与本可被 narrowing 覆盖，`AbortSignal as any` 同理。
- 行为测试缺失（见下表），且 RFC §4.2.5/ADR 需要同步“现在会读 pi settings”这一事实。

### 12.4 我此前的误报更正（日志轮转）

Round 4/5 我判“日志无轮转/保留策略”，依据是 `grep -rn "rotate|prune|retention|maxLogBytes|MAX_LOG"`，该 pattern **匹配不到** `MAX_EFFICIENCY_LOG_BYTES`（`efficiency-store.ts:227`）与 `.old` 后缀重命名（`:240-244`）——该实现自 `efdfcc7`（提交版）已存在。**结论：日志轮转部分是我的误报；仅 `objects/` 剪枝确实缺失，本轮已补齐。** 教训已记于此，供后续复审参考（避免用“关键词白名单”代替逐文件阅读）。

### 12.5 顺带修好的真实历史 bug（tsc 的收益）

`index-master.ts` / `index-worker.ts` 在 HEAD（`efdfcc7`）中的 `appendEntry` 包装器写成 `appendEntry?.(customType, d)`——**`d` 在整个文件中未定义**（`git show HEAD:… | grep -n "\bd\b"` 只有这一处）。运行时会抛 `ReferenceError`，而 `core/todo.ts:195`（归档清理）与 `:392`（`/todos` 人工编辑，D38 注释处）两处调用都在 `try/catch` 里被静默吞掉 → **D38 的 todo 编辑持久化在 master 上长期失效**（回放时丢失人工编辑记录，但不影响内存态主流程）。本轮改为 `data` ✅。建议补一个“`appendEntry` 被调用且写入正确 payload”的测试（否则同类静默失败还会再来）。

### 12.6 文档口径需修正

| 位置 | 问题 |
|---|---|
| RFC `:121`（§3.2 保留窗口说明） | 仍写“本扩展**不读取** `compaction.*`；启用 OCC 即视为接管压缩时机”，与 A4 实现（会读，且 `enabled=false` 会禁用 OCC）**直接矛盾** |
| RFC `:419`（§8） | 子项拆分与实测不符：实测 39 纯核心 + 5 OBS + 9 OCC + 6 EPR = 59（总数 604 正确） |
| RFC `:429`（§9） | “全部 7 项已全量实现并通过…变异测试验证”对 B2 过度声明（3/4 新核心无变异数据） |
| ADR `:52` | “project-wide typecheck gate” → 实际覆盖 16/67 个源文件 |
| ADR `:53` | “new core modules reached 78.26%” → 78.26% 是 `compact-economics-core` + `gc-core` 两文件合计（324/414）；新核心单文件为 77.46% |
| ADR `:45` | “Telemetry logs rotate at 5MB” 描述的是自 `efdfcc7` 已存在的行为（可保留，但不应计为本轮新增） |

### 12.7 Round 7 最小修复集（按优先级）

1. **P1-A**：devDependencies 声明 `typescript`（钉版本），并确认 `npm test` 在干净环境可跑（可用 `npm ci && npm test` 验证）。
2. **P1-B**：tsconfig `include` 扩到 `src/**/*.ts`（或明写覆盖边界），同步 ADR 措辞。
3. **C1 缺口 2/4**：批量打包补 `packed-batch` 遥测 + 工作量上限；顺带抽公共 `packOneMessage()`。
4. **A4 测试**：用临时目录/临时 `settings.json` 覆盖四条行为（禁用传递 / 继承 / 显式优先 / 未受信跳过），并修 RFC `:121` 与 `hasExplicitKeepRecent` 的信任判断。
5. **B2**：对 `observation-core` / `reducer-core` / `efficiency-config-core` 跑一次变异测试并归档（HTML 报告也需刷新，当前仍是 08-29）。
6. 其余：A1 剪枝在 `session_shutdown` 改 `await`；A3 把 `contextWindowTokens` 接到生产路径或删参；批量打包加角色门禁；文档口径表（§12.6）逐项修正。

---

## 13. Round 7 复审详情（7 项修复验证 + 1 个新回归）

### 13.0 验证方法

1. 逐项复查 Round 6 §12.7 的最小修复集；
2. `npm test`（typecheck 前置 + 全量测试）→ **650/650**；`node --test packages/pier-ext/test/*.test.ts` → **605/605**；
3. 依赖验证：`ls node_modules/.bin/tsc` ✓、`require.resolve('typescript')` → 仓库内 `node_modules/typescript/lib/typescript.js`（5.9.3）→ 不再依赖 `/opt/homebrew/bin/tsc`；
4. 两个定向实验（临时脚本已删）：① 多块 vs 单块的 memo 命中计时（§13.1）；② 用临时 workspace 效率配置直接验证 pi `compaction.enabled=false` / `keepRecentTokens` 继承 / 显式优先（§13.2）。

### 13.1 P1 新回归：多块内容的 memo 键不一致（sticky 快路径失效）

```ts
// packOneMessage（:116）——写入用的键
text = content.map(b => b.text ?? '').join('\n');           // 多块时插入 (n-1) 个 '\n'
const memoKey = `${sessionRoot}:${toolCallId}:${text.length}`;

// batchPackObservations（:167）与 context handler（:374）——读取用的键
let approxChars = 0;
for (const b of content) approxChars += (b.text?.length ?? 0);   // 不含分隔符
const memoKey = `${sessionRoot}:${toolCallId}:${approxChars}`;
```

- 单块：`text.length === approxChars` → 命中（实测 0.0–0.3 ms）✅
- **多块（常见！`index-locks.ts` 会给工具结果追加写锁告警块，EPR 也保留额外块）：键相差 (n−1)** → 写与读对不上：

```text
memo fast-path timing (request 2+ should be ~0ms if the key matches):
single-block: 60.7ms / 0.3ms / 0.0ms   ← memo 生效
two-block  : 45.9ms / 33.6ms / 32.0ms  ← memo 永久 miss（每次请求重算）
```

- 影响：每次 provider 请求对多块大输出重做 `sha256Hex + countLines + formatObservationPlaceholder + storeContentAddressedObject`（4MB ≈ 33 ms，8MB ≈ 70 ms）；`batchPackObservations` 也看不见自己写入的 memo（`:167` 检查永远 miss），于是压缩点可重复打包同一条；`placeholderMemo` 被写入从未被读取的死键，提前泵出活条目（LRU 压力）。占位符本身仍正确（证据不丢），所以只影响性能/审计。
- 修复：单一键来源（如 `memoKeyFor(sessionRoot, toolCallId, chars)` 导出函数，三处共用；或在 `packOneMessage` 入参里传 `memoChars: approxChars`）。**测试**：加一个「双块内容连续两次 `context` 事件，第二次 `getRemainingHorizon` 不被调用 / prepare 耗时或 store 调用不重复」的断言（当前全套测试均为单块，所以这个回归全套绿灯）。

### 13.2 A4 行为验证（shipped 测试的空断言）

shipped 测试 `efficiency-config-core.test.ts:226` 的第 1 条断言（`pi enabled=false → OCC enabled=false`）在“未提供任何效率配置”时是**空断言**（默认就 false）。我用临时 workspace 效率配置直接跑了四条路径：

| 场景 | 结果 | 结论 |
|---|---|---|
| B) workspace `OCC.enabled=true` + pi `enabled=false` | `false`，`keepRecentTokens=35000` | 真实行为 ✓（但 shipped 测试未覆盖此组合） |
| C) 同上 + `PI_HERDR_COMPACT_ENABLE=1` | `true` | 环境变量优先 ✓ |
| D) 显式效率配置 `keepRecentTokens=12345` + pi 35000 | `12345` | 显式优先 ✓ |

建议：将 B 场景写成真实断言（临时 `.pi-herdr/config.json` 开 OCC + 临时 agentDir settings 关 pi），否则该分支回归不会被发现。另外该测试直接读真实 `~/.pi/agent/herdr-pi/config.json`（只有当开发者本机恰有该文件且开了 OCC 时会变红——属测试隔离隐患，建议把用户效率配置目录也纳入 `agentDir`/env 派生）。

### 13.3 Round 7 新特性无测试

| 新特性 | 位置 | 现状 |
|---|---|---|
| `MAX_BATCH_PACK_ITEMS` / `MAX_BATCH_PACK_BYTES` 上限 | `core/observation.ts:67-68/154` | 无用例；且检查在打包前，**单批可超 10MB 上限至多一条**（如 9.9MB + 8MB = 17.9MB），建议改为“已累计 + 本条 > 上限则停”并注明是软上限 |
| `packed-batch` 遥测 | `:195` | 无用例（连 `event` 名都未断言） |
| 批量打包的角色门禁 | `index.ts:477` | 无用例（Round 6 的 observation-integration diff 本轮未变，仍是单函数测试） |
| 多块 memo 命中 | `:116` vs `:167/:374` | 无用例（见 §13.1） |

### 13.4 遗留与 nits

- **仍开**：P1-B（门禁范围/ADR 措辞）、B2（三个核心的变异报告 + `ADR:53`/`RFC:429/439` 数字口径）、`ADR:45` 把已有日志轮转计为本轮新增。
- RFC §8 子项拆分仍不准（实测 40 纯核心 + 5 OBS + 9 OCC + 6 EPR = 60）。
- `typescript: "^5.3.3"` 实际装上 5.9.3：门禁行为跟随小版本漂移，建议钉到 `~5.9.3`（或至少 CI 锁 lockfile）。
- `packOneMessage` 的 memo 写入与 `loggedPackedObsIds` 去重分属两处，建议合并为一个 `recordPacked(result)`，避免“写了 memo 没记日志”这类偏差。
- 批量打包仍不做 `fullSends` 判定（设计如此），但建议在 `packed-batch` 日志里带上 `source: 'compaction'` 以区分两类来源。

---

## 14. Round 8 复审详情（P1 闭环验证）

### 14.0 验证方法

1. 复查 Round 7 §13 的全部条目；
2. `npm test`（typecheck + 全量）→ **651/651**；`node --test packages/pier-ext/test/*.test.ts` → **606/606**（RFC `:5` 声称 606/651，逐字吻合）；
3. **多块 memo 计时实验**（临时脚本已删）：4MB 单块 / 双块 / 三块各连续三次 provider 请求，并统计 `getRemainingHorizon` 调用次数：

```text
single-block: 405.2ms / 0.3ms / 0.0ms   horizonCalls=1
two-block   : 283.5ms / 0.0ms / 0.0ms   horizonCalls=1   ← Round 7 同一用例为 45.9/33.6/32.0ms
three-block : 186.6ms / 0.1ms / 0.0ms   horizonCalls=1
```

（首次调用耗时含 JIT 预热，不代表稳定性；关键看第 2/3 次：均 ≤ 0.1ms。）

### 14.1 代码侧评估（本轮唯一实质改动：`core/observation.ts` +28 行）

- **键来源单点化**：`contentJoinedLength(content) = Σ b.text.length + (n−1)`（`:54-60`）恰好等于 `content.map(...).join('\n').length`，语义与实现一致；`packOneMessage` 新增必填 `charLength` 参数（`:98`），从签名上让“调用方与内部键不一致”不再可能。✅
- **快路径仍为 O(#blocks)**：context handler 只累加 `b.text.length`（不做拼接/哈希）后才查 memo（`:389-394`），因此并未因修复而回退到 round-4 之前的开销。✅
- **批量上限语义修正**：由“打包前统一判 `accumulatedBytes >= maxBytes`”改为“超出且已打包至少一条才停”，既避免单批超过上限至多一条（Round 7 的 9.9MB+8MB=17.9MB 情形），又不会因首条就超限而完全空转。✅
- **遥测可审计**：`packed-batch` 现带 `source: 'compaction'` + `sessionId`/`obsId`/`originalBytes`/`originalTokens`/`placeholderTokens`/`grossSavedTokens`，并改为 `await` 写入（压缩前钩子本就串行，代价可接受，换来“日志不丢”）。✅

### 14.2 我此前的第二次误报更正（Stryker HTML 报告）

Round 6/7 我写「HTML 报告仍是 08-29 旧产物」，依据是 `ls -la reports/mutation/html/` 的**目录** mtime；实际文件为 `reports/mutation/html/index.html`，`stat` 显示 **Sep 13 10:26**（与 `mutation.json` 同一次运行）——**该报告是新的**。教训：核对文件新鲜度时应看文件本身而非目录项。（第一次误报是 Round 6 的日志轮转，已记于 §12.4。）

### 14.3 剩余项（均为细节，不阻塞）

| # | 项 | 位置 | 建议 |
|---|---|---|---|
| 1 | §9 引言仍写「全部 7 项已全量实现…并通过**变异测试**验证」 | RFC `:429` | 变异只覆盖 1 个核心（行内已限定），建议改为「…并通过自动化测试与已归档的变异测试证据（`compact-economics-core`）」 |
| 2 | 仍把既有 5MB 日志轮转列为本轮成果 | ADR `:47` | 拆句：日志轮转（既有）+ 对象剪枝（本轮新增） |
| 3 | `typescript: "^5.3.3"` 实装 5.9.3 | `package.json:46`、`pier-ext/package.json:57` | 若要门禁可复现，钉 `~5.9.3` |
| 4 | A4 测试：`enabled===false` 空断言 + 读取真实 `~/.pi/agent/herdr-pi/config.json` | `efficiency-config-core.test.ts:226` | 补“workspace 开 OCC + pi 关”真断言（Round 7 已手工验证行为正确）；用户效率配置目录也应由 `agentDir` 派生以保证隔离 |
| 5 | 角色门禁（`index.ts:477`）与 `session_shutdown` 剪枝无直接测试 | `index.ts` | 可在 index 层加一个轻量集成断言（目前只测到 coordinator 会调用 `onBeforeCompact`） |
| 6 | memo 写入与 `loggedPackedObsIds` 去重分处两地 | `core/observation.ts` | 可选合并为 `recordPacked(result)`，避免“写了 memo 未记日志”类偏差 |
| 7 | 其余 3 个新核心仍无变异数据（已披露） | `reports/mutation/` | 若需提高置信度，可对 `observation-core` / `reducer-core` / `efficiency-config-core` 各跑一次并归档（命令见 §15.5） |

---

## 15. Round 9 收尾记录（文档措辞 + 测试覆盖，2026-09-13）

本节由审阅侧直接执行，关闭 Round 8 §14.3 的 1–5 项，并对工程状态做了两处额外修正。验证：`npm test` → **654/654**、`pier-ext` → **609/609**（typecheck 前置通过）。

### 15.1 代码/依赖改动

| 改动 | 位置 | 说明 |
|---|---|---|
| 配置加载器可注入 | `efficiency-config-core.ts`（`loadEfficiencyConfigFromDisk` 新增 `agentDir`/`userConfigPath`） | 让测试不再读开发者真实 `~/.pi/agent/herdr-pi/config.json` 与 `PI_CODING_AGENT_DIR`；生产行为不变（缺省值同旧） |
| 钩子抽取 | `core/observation.ts` 新增 `createCompactionBatchPackHook({getObsConfig,getManifest,getSessionId})` | 把原先内联在 `index.ts` 里的角色门禁 + branch 映射 + 批量打包变成可单测函数；`index.ts` 降为 4 行接线，并清掉那里的 `(e: any)` |
| 剪枝抽取 | `efficiency-store.ts` 新增 `pruneSessionObjects(sessionRoot, limits?)` | 一次处理两个 objects 目录（index.ts 的 shutdown 路径改调它） |
| `typescript` 钉版 + lock 修复 | `package.json` / `packages/pier-ext/package.json` / `package-lock.json` | 由 `^5.3.3` 改为 `~5.9.3`；顺带发现并修复：**HEAD 的 lock 没有 `node_modules/typescript` 条目而 package.json 已声明**（干净机器上 `npm ci` 会因 lock 不同步而失败）——`npm install --package-lock-only` 后 lock 含 5.9.3，`npm ci --dry-run` 通过 |

### 15.2 新增/重写测试（共 +3 用例，分布：config 11→13、store 6→7、obs-integration 6→7）

| 测试 | 断言要点 |
|---|---|
| `loadPiNativeCompactionSettings: reads agentDir settings and gates the project file on trust` | 受信时项目 `.pi/settings.json` 胜出（99999）；未受信时忽略并回退全局（35000） |
| `loadEfficiencyConfigFromDisk: respects Pi native compaction settings and inheritance (A4)`（重写） | 先写 workspace 效率配置显式 `enabled: true` → 断言 pi `enabled=false` 确实把它关掉（**原用例的空断言已消除**）；env 强制优先；显式 `keepRecentTokens` 优先；未受信项目文件忽略；全程不碰 `process.env`、不读真实用户配置 |
| `createCompactionBatchPackHook honours config, role gate and branch shape` | ① 配置关 → 不落盘；② 角色 deny `obs_recall` → 不落盘；③ 允许 → 只打包 message 条目（`custom`/无 payload 条目忽略）并写 `packed-batch`（`source=compaction`、`sessionId`）；④ 二次调用命中 memo → 不重复打包、不重复记日志 |
| `pruneSessionObjects: prunes both content-addressed dirs` | 两个 objects 目录各剪一条（`maxFiles: 1`），保留各 1 个文件 |

### 15.3 文档改动

- RFC `:5` 基线 → **609/654**（实测一致）；`§8` → 共 64 个用例（**42 纯核心 + 7 OBS + 9 OCC + 6 EPR**，与逐文件计数一致）。
- RFC `§9` 引言不再宣称“全部 7 项均过变异测试”；末行明确“仅 `compact-economics-core` 有已归档变异证据（315 mutants / 77.46%；与 `gc-core` 合计 78.26%），其余 3 个新核心未跑”。§9 各行的“验证结果”列更新为本次新增的真实断言，并注明日志 5MB 轮转自首版即存在（非本轮新增）。
- ADR `Hardening & residuals resolution`：拆分“既有日志轮转 / 本轮对象剪枝”，并补一句“其余 3 个新核心暂无变异证据（已披露，未声称）”。

### 15.4 附带发现

- **lock 与 package.json 不同步**（已修，见 9.1）：Round 8 声明了 `typescript` 但未生成 lock 条目，属“干净环境安装会失败”的潜在问题。
- **本轮环境内 tsc 的一个语法怪癖**：在 `batchPackObservations({ ..., sessionId: deps.getSessionId?.(), ... })` 这种“对象字面量参数内直接内联可选调用”的写法上报 `TS1109/TS1005`（同样的代码抽成变量或在其它位置则正常）。已改为先 `const sessionId = deps.getSessionId?.();` 传入（更可读，也绕开该怪癖）；如后续遇到同类误报，优先考虑同样处理。

### 15.5 明确延后（已披露，不阻塞）

| # | 项 | 原因与建议命令 |
|---|---|---|
| 1 | `observation-core` / `reducer-core` / `efficiency-config-core` 的变异报告 | 需专门跑一次，且不能用默认 reporter（会覆盖现有 `mutation.json`）；建议：`npx stryker run --mutate "packages/pier-ext/src/observation-core.ts,packages/pier-ext/src/reducer-core.ts,packages/pier-ext/src/efficiency-config-core.ts" --jsonReporter.fileName reports/mutation/efficiency-cores.json` |
| 2 | `packRecorded()`：memo 写入与 `loggedPackedObsIds` 去重仍分处两地 | 纯风格重构（无行为缺陷）；若日后新增第三处打包路径，一并收敛 |
| 3 | `index.ts` 的 `session_shutdown` 剪枝与 `session_start` 路径派生 | 已由 `pruneSessionObjects` 单测覆盖路径逻辑；事件注册本身依赖现有 index 集成 harness，暂不补 |

### 15.6 验证据点

```text
npm test                → 654/654（含 typecheck 前置）
node --test packages/pier-ext/test/*.test.ts → 609/609
npm run typecheck       → 0 error（node_modules 内 tsc 5.9.3）
npm ci --dry-run        → 通过（lock 与 package.json 同步）
```

> 至此 Round 8 §14.3 的剩余项仅剩 15.5 中三条（均已披露且不影响交付），三机制仍为默认关闭 + fail-open。

---

## 16. Round 10 详情（试用就绪收尾）

### 16.1 本轮改动清单

| 改动 | 位置 | 说明 |
|---|---|---|
| 打包路径合并 | `core/observation.ts` | `packOneMessage` 新增可选 `log: PackLogOptions`；memo 写入 + `observation.jsonl` 单次去重写入收敛到同一函数；context 投影路径与 compaction 批量路径各删 ~25 行重复日志代码 |
| 命令识别边界放宽 | `reducer-core.ts` `DIAGNOSTIC_COMMAND` | 尾边界 `\s|$` → `[;&|()\s]|$`（子 shell / `&&` 链 / `;` 结尾可识别），并加注释说明边界集合与“词内不误判”约束 |
| 最弱核心补测 | `test/reducer-core.test.ts` | +2 用例：① 逐条钉住 `DIAGNOSTIC_COMMAND` 的每个 alternation、分隔符、词边界（含 `npm run test`/`makefile`/`coqtop` 反例）；② `formatReceiptText` 的行分隔与 `line=?` 占位 |
| index 生命周期测试 | `test/index-integration.test.ts` | 真实 composition root：`session_start` 传 session dir → 每目录 301 个对象 → `session_shutdown` 后各剩 300（验证 `sessionRoot` 派生 + 默认剪枝阈值 + `await` 生效） |
| 变异证据归档 | `reports/mutation/{efficiency-cores,efficiency-cores-integration,reducer-core-trial}.json` | 见 §16.2（`reports/` 已被 `.gitignore` 忽略，属本地证据；命令见 §16.4） |
| 试用入口文档 | `docs/efficiency-trial.md`（新增）、`README.md` | README `Configuration` 下新增 “Efficiency mechanisms (D100–D103, opt-in)” 小节；试用指南含开启顺序、观测字段、回滚、反馈模板 |
| 文档数字同步 | `docs/rfc-sol-pi-absorption.md`、`docs/adr/0005-*.md` | 基线 612/657；§8 计数 67（44 纯核心 + 7 OBS + 9 OCC + 6 EPR + 1 index）；§9 与 ADR 的变异证据行改为三档（全量集 / 子集下界 / 补测后复测）；§4.3 补 `DIAGNOSTIC_COMMAND` 边界说明；状态行改为“可开始试用”并指向试用指南 |

### 16.2 变异测试结果（本轮新增证据）

| 文件 | 测试集 | mutants | 分数 | 性质 |
|---|---|---|---|---|
| `compact-economics-core.ts` | 全量（655 测试） | 315 | 77.46% | 既有证据（同批次 `gc-core.ts` 合计 78.26%） |
| `observation-core.ts` | 单元+集成 spec 子集 | 214 | 66.82% | 下界 |
| `efficiency-config-core.ts` | 单元+集成 spec 子集 | 709 | 59.80% | 下界 |
| `reducer-core.ts` | 单元+集成 spec 子集 | 237 → 238 | 48.52% → **52.52%**（补测+边界放宽后） | 下界 |
| 三者合计 | 单元+集成 spec 子集 | 1160 | 58.79% | 下界 |

说明：子集 = 该模块自身的 spec + 对应集成 spec（⊂ 全量集），因此分数是**下界**——全量集只会多杀。全量集跑这 3 个文件的实测 ETA 为 ~2–3h（1160 mutants × 全量套件 ≈8s/mutant、并发 4），本轮未跑并已在 RFC/ADR 中如实标注。

`reducer-core.ts` 补测后的剩余 survivor（113 个）仍集中在 `DIAGNOSTIC_COMMAND` 正则（23）与收据/校验分支的字符串字面量与条件表达式（合计 ~70），属后续可继续收敛的点（不影响试用）。

### 16.3 试用就绪检查表

- [x] 三机制默认关闭、逐项 fail-open（不开启即零介入）
- [x] 开启方式双通道（环境变量 / 配置文件）+ 优先级与整体覆盖语义已文档化
- [x] 观测入口：`/efficiency` + `efficiency-logs/*.jsonl`（字段表）+ `objects/` 归档路径与剪枝策略
- [x] 安全边界：项目信任门控、密钥正则回退、EPR `localOnly`、日志脱敏（只记 sha256/字节数）
- [x] 回滚路径：置 `enabled:false` / 删环境变量即恢复
- [x] 反馈模板（附 `/efficiency` 输出 + 脱敏日志片段 + 模型与比率 + 观感）
- [x] 已知限制清单（horizon 回退 4、粘性打包、批量上限 20/10MB、memo 256、pi 设置启动时读取、变异证据边界）
- [x] `npm test` 657/657（含 typecheck 前置）、`npm ci --dry-run` 通过

### 16.4 复现命令

```bash
npm test                                    # typecheck + 全量 657
node --test packages/pier-ext/test/*.test.ts # 仅 pier-ext 612
npm run typecheck                            # 仓库内 typescript 5.9.3
```

变异复测（会向 `reports/mutation/` 写新报告；勿覆盖既有归档）：

```bash
# 单元+集成 spec 子集（下界），3 个核心
npx stryker run --mutate "packages/pier-ext/src/observation-core.ts,packages/pier-ext/src/reducer-core.ts,packages/pier-ext/src/efficiency-config-core.ts"
# 注意：CLI 不支持 --jsonReporter.fileName 点号写法，需用临时 config 文件指定独立的 reporter 文件名
```

---

## 17. D104 `/pier-config` 实现记录（2026-09-13）

> 本实现由审阅侧按已确认方案（`docs/pier-config-command.md` §2 决策）完成；本节记录交付内容、验证证据与**尚未验证**的部分。

### 17.1 交付内容

| 层 | 文件 | 内容 |
|---|---|---|
| Pure core | `src/config-catalog-core.ts` | 5 平面/57 键目录（efficiency 20 + roles 8 + pi 2 + boot 6 + env 17 + 4 个 meta）、dotted 读取、provenance（env > workspace > user > default，含未受信标注与 `pi compaction.enabled=false → OCC 失效`规则）、密钥键脱敏、索引/平面/报告/校验渲染 |
| Adapter | `src/config-guide.ts` | 真实文件与 env 读取（路径可注入）、角色三层枚举 + 校验、boot-config 探测（`$HERDR_PLUGIN_CONFIG_DIR` → dev 路径）、`check` 聚合、英文引导提示词常量 |
| Entry | `src/config-command.ts` + `index.ts` | `/pier-config` 注册（`show|check|doc|<plane>`、参数补全、无 UI 降级 `console.log`）、无参注入隐藏 custom 消息 `pi-herdr.config-guide`（`triggerTurn`）、`/efficiency` 收敛为指向新命令 |
| Docs | `docs/configuration.md`（新增）、`docs/adr/0006-*.md`（新增）、`docs/decisions.md` D104、`README.md`、`docs/pier-config-command.md` 状态 | 平面表、需求→平面查表、引导流程、安全与排障、试用入口 |
| 工程 | `tsconfig.json` include +3 文件、`stryker.conf.json` +1 mutate、`.gitignore` +`config-report.md` | 新代码进入类型门禁与变异名单 |

### 17.2 验证证据

```text
npm test                                  → 671/671（typecheck 前置）
node --test packages/pier-ext/test/*.test.ts → 626/626（新增 14）
```

| 测试 | 覆盖 |
|---|---|
| `test/config-catalog-core.test.ts`（8） | **漂移守卫**：efficiency/role schema 键 ↔ catalog 双向；runtime-policy/terminal/todo-reminder/config-core 中出现的 env 名 ↔ catalog（允许列表仅 5 个内部/pi 名）。provenance 优先级、未受信忽略、pi 禁用 OCC 的有效值、env 越界与 0 值告警、密钥键脱敏、渲染紧凑性 |
| `test/config-guide.test.ts`（5） | 临时目录+注入 env：工作区/用户/pi/boot 四类文件的读取与来源、未受信标注、坏 JSON/非法角色/保留角色名/env 非法四类 issue、boot 与 pi 设置缺失时不抛异常、引导提示词结构 |
| `test/index-integration.test.ts` +1 | 真实 composition root：命令注册、`show efficiency` 输出键值、`show bogus` 警告、`check` 头、`doc` 写入文件、无参注入 `pi-herdr.config-guide`（断言 `customType`/`display:false`/`triggerTurn`）、`/efficiency` 指向新命令 |

附带修复：`tsconfig` 纳入新文件后暴露 `role-loader.ts` 的非严格模式判别联合 narrowing 缺陷（`!result.ok` 在未开启 `strictNullChecks` 时不收窄），已改为 `result.ok === false`；`config-command.ts` 的 `sendMessage` 曾以解绑方式调用（fake pi 捕获到 0 条注入），改为在接收者上调用。

### 17.3 尚未验证（试用期反馈项）

- 真实 TUI 下 `show all`（约 60 行）的实际渲染/滚动体验；
- RPC 模式降级路径（当前仅由“无 `ui.notify` 时 `console.log`”分支的单测覆盖）；
- agent 对注入提示词的遵守程度（依赖模型，属 D104 的核心观感指标）；
- 报告文件在真实工作区中的可读性（字段/来源标注是否够用）。

### 17.4 本机陈旧配置修复（2026-09-13，试用前置）

启动检查发现本机**实际生效**的用户模式 boot-config（`~/.config/herdr/plugins/config/pier.workbench/boot-config.json`）里的
`extPath` 指向 `/Users/yehaoyu/.pi/agent/npm/node_modules/pi-pier/src/index.ts` —— 该路径已不存在（早先 npm 安装的残留），
于是每个 pi pane 启动都会打印一条 `Failed to load extension: Cannot find module …`（实测非致命：`discoverAndLoadExtensions`
把它记为一条诊断后继续，pier 仍由 `~/.pi/agent/settings.json` 的 `packages` 指向本 checkout 正常加载）。

处理：
1. 备份 `boot-config.json.bak-20260913`，把 `extPath` 改为 `/Users/yehaoyu/Documents/pier/packages/pier-ext/src/index.ts`；
2. **去重验证**：`packages` 的目录条目与 `-e <file>` 指向同一入口时 pi 只加载一次（用 dummy 扩展包实测 `dir+file → extensions=1`），
   所以修完不会出现"重复注册 handler"；
3. `config-guide.ts` 的 boot 平面新增两项能力：**默认路径探测**（未显式注入 env 时探测 `$XDG_CONFIG_HOME`/`~/.config`
   与 `%LOCALAPPDATA%` 下的 `herdr/plugins/config/pier.workbench/`，因此 pane 内不依赖 `HERDR_PLUGIN_CONFIG_DIR` 也能看到用户模式配置）
   与**路径存在性校验**（`piNode`/`piCli`/`extPath` 缺失即 FAIL 并给出 `npx pier-setup@latest update --force` 提示）；
4. 文档同步：`docs/configuration.md` 与 `docs/pier-config-command.md` 的 boot 行、`docs/INSTALL.md` §4 的安装自检步骤。

修复后实测（不注入任何 env，等价于 pane 内执行）：`boot` 平面 `ok`，并列出用户模式与 dev 两份 boot-config。

### 17.5 明确未做（有意保留）

- P3 的 TUI picker（`ui.select` 逐项改）——等反馈证明"文本索引 + agent 引导"不够用再做；
- 未把 typecheck 门禁扩到全 `src`（会暴露存量错误，见 §12/§13 的 P1-B 记录），仅纳入 3 个新文件。

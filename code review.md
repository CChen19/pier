# Code Review —— SoL-Pi 能效机制吸收（D100–D103）

> **审阅对象**: `docs/rfc-sol-pi-absorption.md`（含 `docs/rfc-sol-pi-absorption-review.md` 的审阅意见）对应的**未提交实现**
> **审阅基线**: 本仓 `master`（HEAD `8db7b95`）+ 工作区未提交改动
> **审阅日期**: 2026-09-12（Round 1） · 2026-09-13（Round 2 修复复审）
> **审阅范围**: 12 个新增源文件 / 8 个新增测试文件 / 9 个改动文件（见 §6 清单）
> **验证方式**: 全量测试 + 定向复现实验（§7 附录给出可复现脚本）

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

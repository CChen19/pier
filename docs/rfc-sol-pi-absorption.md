# RFC: pier 能效架构演进 —— 吸收 SoL-Pi 核心机制设计方案 (v2 落地版 · 含 4 轮复审修正)

> **状态 (Status)**: 已实现并完成 9 轮 code review 复审（Round 1–9）；三机制默认关闭、逐项 fail-open，**可开始试用并收集反馈**（试用指南：[docs/efficiency-trial.md](efficiency-trial.md)；残余项见 §9）  
> **目标仓库 (Target)**: `pier` (`packages/pier-ext`)  
> **验证基线 (Baseline)**: 本仓 HEAD (`packages/pier-ext`, 612 tests passing / Monorepo 657 tests passing) + pi `0.84.2` + 上游 `NVlabs/SoL-Pi` 源码  
> **审阅意见对照**: `docs/rfc-sol-pi-absorption-review.md`（首轮意见） & `code review.md`（Round 1–4 复审记录与修复验证）  
> **文档位置 (Path)**: `docs/rfc-sol-pi-absorption.md`  
> **关联 ADR**: [docs/adr/0005-efficiency-mechanisms-absorption.md](adr/0005-efficiency-mechanisms-absorption.md) (D100-D103)  

---

## 1. 背景、目标与审阅定调

在长周期、复杂的多智能体协同与研发循环中，大语言模型上下文的无谓膨胀（巨型输出重放、长测试日志扫描、未压缩历史长尾）会导致 Token 消耗和延迟成倍增加。

NVIDIA 开源的 **SoL-Pi** 验证了四个能效机制。然而，SoL-Pi 独立运行时与 `pier` 存在核心理念和工具层面的冲突：
- SoL-Pi 的 `onlineContextCompact` 强依赖其自有的 `update_plan` 工具，与 `pier` 现有的 `todo_write` 体系产生“心智分裂”与生命周期竞态。
- 外部扩展重写 `edit`/`write` 破坏了 `pier` 成熟的分布式文件写锁与 D82 工具门禁基线。

**本次架构改造的核心原则与边界**：
1. **保留原生工具**：放弃 Action Fusion，**严格保留 `pier` 原始的 `edit` 和 `write` 工具**，保持既有文件写锁（`lock-core.ts`）与安全基线不动。
2. **待办驱动压缩（OCC）**：废弃 SoL-Pi 的 `update_plan`，将其经济学上下文压缩算法全面桥接到 `pier` 的 **`TodosService` 与 `todo_write`** 闭环中；明确定性为**边界触发的原生有损摘要压缩 + 证据可回召**。
3. **观察结果冷热分级（ObservationPack）**：吸收上下文拦截与分页召回能力，引入滚动前缀缓存经济学，大幅降低长会话中的重放成本，且会话磁盘 JSONL 保持物理不可变。
4. **简洁保真的进程内日志提炼（EPR）**：
   - 坚守进程内微过滤器定位，**绝不引入子代理过度设计，绝不增加二级排障调度**；
   - 彻底废弃 `roles/reducer.json` 方案，直接收敛至能效配置 `evidencePreservingReducer.model` 单一来源，支持根据模型目录自适应推导；
   - **将“保真”做实**：`tool_result` 替换前先强制落盘原文至会话对象存储，收据附带可回读路径；严格基于未截断输出字节进行逐行子串验真；失败一律透明回退（Fail-open）至全文。
5. **分层状态与数据闭环**：
   - 决策状态（样本、债务、epoch）作为自定义条目写入会话 JSONL（支持 `/tree`、`/resume`、HMR 正确重放）；
   - 细粒度审计流水写入独立 JSONL 文件（支持配置独立开关 `logEnabled`），采集真实命中率、预测 vs 实测还债轮次，为后续持续调优提供闭环数据。

---

## 2. 核心架构决策 (ADR 索引)

对齐 `pier` 的决策编号（接续 `docs/decisions.md`）：

- **D100**: *待办驱动的经济学在线上下文压缩* —— 废弃独立计划工具，以 `TodosService` 中模型产生的任务完成过渡（`todo.completed {source: 'tool'}`）作为进度边界，结合 KV-Cache 增量成本模型与窗口压力机会式触发原生压缩（阈值压缩兜底），且在压缩期间挂起未完成待办催办与唤醒。
- **D101**: *观察结果冷热分级与前缀缓存对齐（ObservationPack）* —— 仅在 `pi.on("context")` 阶段对 >10KB 的成功纯文本工具输出在第 3 轮及以后进行占位替换；引入前缀缓存失效代价评估，会话磁盘 JSONL 保持物理不可变，注册 `obs_recall` 提供 16KB 分页幂等回召（受角色工具门禁保护）。
- **D102**: *进程内保真日志提炼与未截断字节验真（Evidence-Preserving Reducer）* —— 测试构建长日志在进程内通过轻量模型进行收据提炼并执行逐字节严格验真，收据回填 `usage` 且在替换前持久化原文；候选源限定于 `bash` 未截断文件并做密钥安全过滤与项目信任门控，模型路由收敛至专用配置，失败透明回退全文。
- **D103**: *能效状态持久化与独立闭环遥测* —— 效率决策状态随会话分支恢复（D38 范式）；每个能效机制提供独立的 `logEnabled` 开关与独立 JSONL 审计日志，记录每轮决策参数、预测盈亏平衡 vs 实测偿还轮次，提供 `/efficiency` 运行时审计指令。

---

## 3. 统一配置体系与安全边界设计

遵循“**默认保守关闭、显式按需开启、独立日志审计、项目受信任才生效**”原则。

### 3.1 配置优先级与合并语义
1. **环境变量**（最高优先级，便于 CI、Spike 与命令行临时调试）
2. **工作区配置**：`<workspace>/.pi-herdr/config.json`（**必须 `ctx.isProjectTrusted()` 为 true 才生效**；未受信任时忽略并 stderr 告警）
3. **全局用户配置**：`~/.pi/agent/herdr-pi/config.json`
4. **内置默认值**（最低优先级，全部为 `false`）

> **合并语义说明**：工作区配置对全局配置采取**整体覆盖（Shallow Replace）**而非深合并，避免“工作区只想写一行 false 禁用，却被全局默认值穿透合并”的不可预测行为。  
> **校验语义说明**：Schema 强制 `additionalProperties: false`。若发现未知字段或类型非法，一次性收集全部错误并打印单行 stderr 警告，对应机制**安全回退为 disabled（Fail-open）**，严禁中断正常会话。

### 3.2 配置模式定义 (`schemas/efficiency-config.schema.json`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://herdr-pi.local/schemas/efficiency-config.schema.json",
  "title": "pier efficiency configuration (D100-D103)",
  "type": "object",
  "properties": {
    "version": { "type": "integer", "const": 1 },
    "onlineContextCompact": {
      "type": "object",
      "properties": {
        "enabled": { "type": "boolean", "default": false, "description": "是否启用待办驱动的在线上下文压缩" },
        "logEnabled": { "type": "boolean", "default": false, "description": "是否记录在线压缩的决策与节省量日志" },
        "cacheWriteReadRatio": { 
          "oneOf": [
            { "type": "number", "minimum": 0 },
            { "type": "string", "enum": ["auto"] }
          ],
          "default": "auto",
          "description": "KV 缓存写入与读取成本比。auto 表示从 ctx.model.cost 自动推导"
        },
        "firstCompactionRequestScale": { "type": "number", "default": 2.0, "minimum": 1.0 },
        "subsequentCompactionMargin": { "type": "number", "default": 1.5, "minimum": 1.0 },
        "keepRecentTokens": { "type": "integer", "default": 20000, "minimum": 1000, "description": "原生压缩保留区大小；需与 pi 的 compaction.keepRecentTokens 保持一致（本扩展不读 pi settings）" }
      },
      "additionalProperties": false
    },
    "observationPack": {
      "type": "object",
      "properties": {
        "enabled": { "type": "boolean", "default": false, "description": "是否启用大工具输出冷热分级打包" },
        "logEnabled": { "type": "boolean", "default": false, "description": "是否记录观察结果打包与召回日志" },
        "thresholdBytes": { "type": "integer", "default": 10240, "minimum": 1024 },
        "fullSends": { "type": "integer", "default": 2, "minimum": 1 },
        "recallChunkBytes": { "type": "integer", "default": 16384, "minimum": 1024 },
        "excerptBytes": { "type": "integer", "default": 1024, "minimum": 128 }
      },
      "additionalProperties": false
    },
    "evidencePreservingReducer": {
      "type": "object",
      "properties": {
        "enabled": { "type": "boolean", "default": false, "description": "是否启用长测试日志保真提炼" },
        "logEnabled": { "type": "boolean", "default": false, "description": "是否记录提炼比对、耗时与回退日志" },
        "model": { 
          "type": "string", 
          "description": "专用的轻量 Reducer 模型 (provider/model)。缺省使用当前模型并在日志中提示经济性" 
        },
        "minBytes": { "type": "integer", "default": 4096, "minimum": 512 },
        "maxChars": { "type": "integer", "default": 600000 },
        "maxOutputTokens": { "type": "integer", "default": 2048 },
        "timeoutMs": { "type": "integer", "default": 5000, "description": "同步拦截超时上限，默认 5 秒避免阻塞" },
        "localOnly": { "type": "boolean", "default": false, "description": "仅本地归档长日志并跳过模型提炼" }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

> **保留窗口与 Pi 原生配置（`keepRecentTokens`）**：运行时校验与 TS 类型均支持该键（默认 `20000`，最小 `1000`），它同时用于 `nativeCompactionFeasible` 预检与 `archiveTokens` 估算。若未在此处显式配置，`loadEfficiencyConfigFromDisk` 会自动尝试读取 Pi 原生 `settings.json`（全局与项目受信配置）继承其 `compaction.keepRecentTokens`。若用户在 Pi 原生配置中显式将 `compaction.enabled` 设为 `false`，OCC 也会同步禁用（除非被环境变量 `PI_HERDR_COMPACT_ENABLE=1` 显式强制覆盖开启）。

### 3.3 环境变量前缀规范 (对齐 `PI_HERDR_*`)

遵循本仓库现有代码（`PI_HERDR_TRACE`、`PI_HERDR_TODO_GRACE_MS`）约定，全部采用 `PI_HERDR_*` 前缀：

| 机制 | 环境变量 | 类型与默认值 | 说明 |
|---|---|---|---|
| OCC 压缩开关 | `PI_HERDR_COMPACT_ENABLE` | `0` \| `1` (默认 0) | 开启 Todo 驱动的在线压缩 |
| OCC 日志开关 | `PI_HERDR_COMPACT_LOG` | `0` \| `1` (默认 0) | 开启在线压缩决策日志输出 |
| OCC 成本比率 | `PI_HERDR_CACHE_RATIO` | 数字 \| `auto` | 覆盖 KV 缓存写入/读取比率 |
| 观察打包开关 | `PI_HERDR_OBS_PACK_ENABLE` | `0` \| `1` (默认 0) | 开启大工具输出占位符与召回 |
| 观察打包日志 | `PI_HERDR_OBS_PACK_LOG` | `0` \| `1` (默认 0) | 开启打包与召回审计日志输出 |
| 日志提炼开关 | `PI_HERDR_REDUCER_ENABLE` | `0` \| `1` (默认 0) | 开启测试日志保真提炼 |
| 日志提炼日志 | `PI_HERDR_REDUCER_LOG` | `0` \| `1` (默认 0) | 开启提炼命中率与验真日志输出 |
| 提炼模型指定 | `PI_HERDR_REDUCER_MODEL` | 字符串 (如 `cliproxy/gemini-3.8-flash-high`) | 显式指定专用轻量模型 |

### 3.4 存储与安全边界规范

#### 1. 会话存储统一路径
所有持久化对象与日志严格锚定在 Pi 的公开会话管理器目录下：
```text
<ctx.sessionManager.getSessionDir()>/herdr-pi/<safeSessionId>/
├── observation-pack/objects/obs_<sha256_24>.txt      # 权限 0600
├── evidence-preserving-reducer/objects/<sha256>.txt # 权限 0600
└── efficiency-logs/                                 # 权限 0700
    ├── compact.jsonl
    ├── observation.jsonl
    └── reducer.jsonl
```
- **安全检查**：`safeSessionId` 必须经正则 `/^[a-z0-9][a-z0-9._-]*$/i` 严格校验，防止路径遍历；
- **权限与文件安全**：所有新建目录设为 `0700`，对象文件使用 `constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW` 标志以 `0600` 创建；
- **Fail-Open 降级**：若 `getSessionDir()` 返回空（如 print 模式、RPC 无磁盘会话）或存储不可写，全部机制透明关闭，原样放行。

#### 2. 安全过滤与凭证防泄露（EPR）
- **密钥正则扫描**：引入 `LIKELY_SECRET = /(?:api[_-]?key|authorization|bearer|access[_-]?token|secret)[^\n]{0,32}[=:][^\n]+/i`；长日志一旦匹配立即放弃提炼，原样输出全文，日志仅记 `fallback: likely-secret`；
- **敏感信息脱敏**：遥测日志中**严禁记录命令明文或失败引文字符串**，统一记录 `commandSha256`、`quoteSha256`、字节数与耗时。

---

## 4. 详细机制设计

### 4.1 机制一：待办驱动的经济学在线上下文压缩 (OCC)

#### A. 核心设计与样本源收敛
1. **样本源精准收敛**：
   - 现有的 `todos.on('todo.completed')` 会在 M17 自动结算、人工 `/todos` 编辑、D39 归档清空等非模型动作中触发。
   - **改造要求**：在 `emitCompletedTransitions` 中增加来源标记：`source: 'tool' | 'reconcile' | 'human' | 'archive'`。
   - OCC 经济学采样器**仅采集 `source === 'tool'` 的样本**，彻底剔除非模型动作的样本污染。
2. **纯算法核心与严密公式 (`compact-economics-core.ts`)**：
   ```ts
   // incrementalCacheCostRatio: 只算写比读多花的那部分
   const incrementalCacheCostRatio = Math.max(0, cacheWriteReadRatio - 1);
   const savingTokens = archiveTokens - memoTokens;

   // breakevenRequests: 单次压缩打平所需的后续请求数（分子是整段重写 writeTokens）
   const breakevenRequests = savingTokens > 0 
     ? (writeTokens * incrementalCacheCostRatio) / savingTokens 
     : null;

   // combinedBreakeven: 包含历史未偿还债务后的综合打平轮次
   const combinedBreakeven = savingTokens > 0
     ? (carriedDebtTokens + writeTokens * incrementalCacheCostRatio) / savingTokens
     : null;
   ```
   > **自洽算例验证**：  
   > 假定 `writeTokens = 45000`，`archiveTokens = 22000`，`memoTokens = 1000`，`cacheWriteReadRatio = 12.5`：  
   > `incrementalRatio = 11.5`，`savingTokens = 21000`；  
   > `breakevenRequests = 45000 * 11.5 / 21000 = 24.6` 轮。  
   > 若当前为首次压缩（`firstScale = 2.0`），且预估剩余请求为 13 轮（放宽后为 26 轮），`24.6 <= 26` 判定成立。

3. **四维守卫与不可压缩预检 (`nativeCompactionFeasible`)**：
   - **窗口保护优先**：`contextTokens >= contextWindow - windowReserveTokens` 时无条件触发；
   - **首次压缩放宽 vs 后续余量**：首次执行放宽 2 倍预期；后续压缩要求 `breakeven * subsequentCompactionMargin <= remainingRequests` 且偿还旧债；
   - **压得动预检 (`nativeCompactionFeasible`)**：上游已验证的关键点——在决定中断前，用 `findCutPoint` 模拟一次截断；若切点判定无法切出任何历史消息（`historyMessages === 0 && prefixMessages === 0`），直接将决策定为 `native_not_compactable`，**绝不调用 abort**，避免产生“中断了一轮却报 session too small”的严重净亏损。
   - **决断理由枚举**：`economic` | `window_protection` | `deferred_economic` | `deferred_subsequent_margin` | `deferred_carried_debt` | `horizon_unavailable` | `cache_ratio_unavailable` | `native_not_compactable` | `non_positive_saving`。

4. **输入纠偏与用户消息保护**：
   - **防吞输入**：在 `turn_end` 判定触发压缩前，检查 `ctx.hasPendingMessages()`。若用户在中途输入了排队消息，**本轮严禁 abort**（避免把用户输入弹回编辑器）；
   - **输入纠偏（Correction）**：监听 `pi.on("input")`。若收到人类输入（非系统 steer），视为任务目标变更，直接作废当前已选中的压缩计划，并清空历史样本计数和债务（对齐上游 `recordCorrection`）。

#### B. 压缩时序与生命周期协同
```text
[todo_write: 产生 completed(source: 'tool')]
            │
            ▼
    [turn_end 钩子] ──(ctx.hasPendingMessages() == false 且 decideCompaction.compact == true)
            │                                         │
            │ (不满足条件)                            ▼
            ▼                              标记 intentionalAbort = true
       正常下一轮                                  ctx.abort()
                                                      │
                                                      ▼
                                            [agent_settled 钩子]
                                                      │
                                                      ▼
                                           调用 cancelTodoReminder()
                                           设置 compactionInFlight = true
                                           调用 ctx.compact({ customInstructions })
                                                      │
                                                      ▼
                                           [onComplete 成功回调]
                                                      │
                                                      ▼
                                           记录 debtTokens，释放 inFlight
                                           pi.sendMessage(hidden, { triggerTurn: true })
                                                      │
                                                      ▼
                                           D39 before_agent_start 钩子
                                           自动将未完成 Todo 喂给新轮次
```

- **催办双重守卫**：
  1. 判定压缩落定及执行期间，主动调用 `cancelTodoReminder()`；
  2. 在 `todo-reminder-core` 的 30 秒定时器回调执行时，二次检查 `compactionInFlight`，若为 true 则直接退出。
- **自定义指令携带 pier 独有上下文**：
  传递给 `ctx.compact` 的 `customInstructions` 动态包含当前尚未完成的 Todo 列表、阶段以及 blocker 原因，指导原生压缩保留核心任务记忆。

---

### 4.2 机制二：观察结果冷热分级与分页召回 (ObservationPack)

#### A. 核心设计与前缀缓存协同
1. **滚动前缀缓存感知（防负优化）**：
   - Anthropic 等主流接口采用滚动前缀缓存（打在末尾消息）。若对较早前轮次的某条工具输出执行占位替换，会导致**从该位置起直到末尾的所有前缀缓存全部失效重写**。
   - **经济学约束**：只有当 `removedTokens * remainingRequests > tailTokensAfter * Math.max(0, cacheWriteReadRatio - 1)` 时才允许打包。若当前模型无额外写入成本（ratio <= 1.0），则按纯 token 净节省判定；
   - **剩余请求数（horizon）来源**：由 OCC 的边界样本派生（`coordinator.getRemainingHorizon()` = `1 + floor(边界请求数均值 × 剩余边界数)`，无样本时保守取 `4`），不再使用局部魔法常量；
   - **一次性判定 + 粘性保持**：打包决策只在首次满足条件时计算一次，其后由占位符 memo 保持占位（再次改为全文会重新失效整段前缀缓存，反而更贵）；在 OCC 压缩点顺路批量打包属于**尚未实现的后续优化**（见 §9）。
2. **纯算法规则与判定 (`observation-core.ts`)**：
   - **错误永不打包**：`!message.isError` 必须成立，失败诊断证据绝对保真；
   - **ID 确定性派生**：`obsId = "obs_" + sha256(toolName + "\0" + toolCallId + "\0" + contentHash).slice(0, 24)`，防止同内容跨工具串台；
   - **收据不二次打包**：检测到 EPR 收据标记（`containsReducerReceipt`）跳过，防止破坏精简凭证；
   - **整行安全切分**：占位符前后摘录各 512 字节，但严格按 `\n` 进行**整行切分**，杜绝半截代码误导模型。
3. **已发送轮次推导（无损重建）**：
   - 判定一条消息是否达到 `fullSends`（默认 2 次），以该消息之后在会话数组中实际跟随的 `assistant` 消息数量为基准推导（`priorAssistantCounts`）。
   - 彻底摆脱纯内存 Map 计数的缺陷，保证 `/resume`、分支切换（`/tree`）与 HMR 重载时状态 100% 确定一致。
4. **角色门禁防护**：
   - 在 `context` 事件处理中检查当前角色的激活工具集（`activeTools`）；
   - 若当前角色未开放 `obs_recall` 工具，**该角色下全局禁用 ObservationPack 替换**，严防模型拿到占位句柄却无法调阅的“证据不可达”事故。
5. **占位符记忆化与自愈（热路径 O(1)）**：
   - memo 查找**前置**于文本拼接、收据扫描与字节统计之前（键 = `sessionRoot:toolCallId:approxChars`，`approxChars` 仅累加各 text block 的 `.length`），命中后直接复用占位符与 `obsId`，每请求成本从百毫秒级降至亚毫秒级（8MB 项实测：首次 73.6 ms → 命中 0.0–0.3 ms，见 `code review.md` §10.0）；
   - 上限 256 条 FIFO+命中刷新（LRU 近似），避免无界增长；`containsReducerReceipt` 先做 `includes` 零分配探测，`completeLineExcerpt` 只在预算窗口内切行；
   - **自愈**：`obs_recall` 读取失败时调用 `invalidateObservationMemo(obsId)` 清除 memo，下次投影会重新落盘对象，避免占位符成为不可达句柄。

---

### 4.3 机制三：进程内测试日志保真提炼 (Evidence-Preserving Reducer)

#### A. 架构定调：坚守极简进程内流水线
- **绝不引入独立 Subagent，绝不拉起新 Pane，绝不增加二级排障调度**；
- 作为 `tool_result` 阶段的同步微型过滤器，耗时严格受控于 `timeoutMs`（默认 5s），超时立即 Fail-open 放行原日志。

#### B. 核心设计与“保真”做实
1. **P0 级保障：原文强制落盘与可回读性**：
   - 由于 `tool_result` 替换会直接持久化进 Pi 会话 JSONL，原文若不单独归档将永久丢失。
   - **流程**：在任何替换发生前，将原始未截断文本以 SHA-256 为文件名写入 `<sessionDir>/herdr-pi/<sessionId>/evidence-preserving-reducer/objects/<sha256>.txt`；
   - **收据注入回读指南**：生成的结构化收据中包含 `source_artifact` 本地绝对路径以及推荐的读取命令示例（如 `head/tail/grep` 范围读取），确保模型或人类在需要时可随时调取原始全量日志。
2. **P1 级保障：基于未截断输出验真**：
   - Pi 的 bash 工具默认对终端输出做 50KB/2000 行截断，完整输出写入临时文件 `details.fullOutputPath`；
   - EPR 优先读取 `fullOutputPath` 的真实文件，并执行严格的安全三道检查：
     1. 文件名符合 `pi-bash-*.log`；
     2. `fs.realpath` 确实位于操作系统临时目录下；
     3. 绝非软链接（`!lstat.isSymbolicLink()`）；
   - 若输出被截断且无法获取未截断原文，**直接放弃提炼并 fallback 全文**，严防在残缺视图上误签“测试通过”收据。
3. **候选命令范围与排除项**：
   - 仅支持 `bash` 工具执行的诊断构建测试命令（通过 `DIAGNOSTIC_COMMAND` 正则识别）；正则**两侧边界都接受 shell 分隔符**（`;`、`&`、`|`、`(`、`)`、空白），因此 `(npm test)`、`npm test&&echo ok`、`pytest;` 都能识别，而 `makefile`/`coqtop`/`npm run test` 这类“词内匹配”仍不命中；
   - **明确排除 `terminal read`**：因 `terminal read` 仅截取终端尾部 8KB，在残缺视图上提炼存在严重隐患，暂不纳入。
4. **模型调用与 Block 级局部替换**：
   - 优先使用配置项 `evidencePreservingReducer.model`，缺省直接继承当前会话模型（`ctx.model`）；
   - 内存模型调用设置：`maxTokens: 2048`, `cacheRetention: 'none'`, `timeoutMs: 5000`；
   - **与写锁告警协同**：`tool_result` 返回时，**仅替换原日志对应的那个 text block**，原样保留 `index-locks.ts` 注入的文件冲突警告块。
   - **Token 记账完整性**：将提炼消耗的 tokens 回填至工具结果的 `usage` 字段中，确保全局成本核算无遗漏。

#### C. 进程作用域与角色分工
- **Master vs Worker 分工**：三个机制（OCC / ObservationPack / EPR）的配置默认值在**所有进程一律为 `false`**，当前不按 master/worker 做差异化默认（`isSubagent` 仅用于 todo 行为与通知路径）。worker 若要启用任一机制，需显式配置 `enabled: true` 或使用环境变量。
- **环境覆盖语义**：`PI_HERDR_*` 环境变量对当前启动进程全局有效，便于子任务或测试在 worker 内部按需覆盖。

---

## 5. 机制互斥矩阵与时序协同

三个能效机制虽然各自独立，但在生命周期与上下文层面上存在严格的交互边界：

| 交互场景 | 协同处理规则 | 架构理由与依据 |
|---|---|---|
| **EPR 收据 ➔ OBS** | **永不打包**（检测到收据标记跳过） | 收据本身已经是高密度保真凭据，再次打包会导致双重折叠、破坏证据链。 |
| **OBS 召回 ➔ EPR** | **永不提炼**（过滤 `obs_recall` 工具） | `obs_recall` 返回的是模型主动请求的切片，且已硬编码限幅（16KB/400行）。 |
| **OCC 压缩 ➔ OBS** | **同源 horizon 协同**（OBS 复用 OCC 的边界样本余量；压缩点批量打包列为后续优化） | 两者共享同一套“剩余请求”估计，避免 OBS 用局部常量高估收益；批量打包需要 OCC 主动调用者接口，尚未实现（§9）。 |
| **OCC 中断 ➔ 催办/唤醒** | **完全抑制**（设置 `intentionalAbort`） | 压缩引发的正常中断绝不能误判为用户 ESC 或异常退出，严禁触发催办争抢。 |
| **人类输入 ➔ OCC 判定** | **清空样本，作废计划** | 人类发出新指令意味着上下文目标发生偏移，必须重置经济学步数预估与未偿债务。 |
| **排队消息 ➔ OCC 判定** | **放弃本轮中断**（检查 `hasPendingMessages`） | 交互模式下 abort 会导致排队/steer 消息退回输入框，必须等待排队清空。 |
| **EPR 校验 ➔ `isError` 标记** | **严格保持原样** | 提炼只改变展示的字符密度，原命令的退出码与 `isError` 状态 100% 保持不变。 |

---

## 6. 代码架构与模块划分设计

严格对齐 pier 既有的 **三层架构（Pure Core / Adapter / Entry）**：

```text
packages/pier-ext/
├── schemas/
│   └── efficiency-config.schema.json    # 新增：能效配置与日志选项 Schema (D100-D103)
├── src/
│   │   # ── 1. Pure Cores (纯算法与决策逻辑，无 I/O，100% 单测，Stryker 严苛覆盖)
│   ├── compact-economics-core.ts        # 经济学压缩算法 (含债务台账、首次放宽、feasible 纯函数)
│   ├── observation-core.ts              # 观察结果截断判定、ID确定性派生、前缀缓存经济学评估、整行快速切片
│   ├── reducer-core.ts                  # 诊断命令正则识别、密钥过滤、逐字节引文严格比对
│   ├── efficiency-config-core.ts        # 配置加载、多级覆盖合并、未知键收集与校验
│   │
│   │   # ── 2. Coordinators & Adapters (生命周期编排、I/O 与外部调用)
│   ├── compact-coordinator.ts           # 协调 todo.completed(source:tool) -> turn_end -> compact 与决策日志
│   ├── efficiency-store.ts              # 共享内容寻址存储 (0600, 0700, safeSessionId, O_NOFOLLOW)、日志流式追加与 bash 输出读取
│   ├── reducer-invoker.ts               # 进程内模型调用、5s 超时守卫、fullOutputPath 校验与提炼日志
│   │
│   │   # ── 3. Tool Registrations
│   ├── core/
│   │   └── observation.ts               # 注册 obs_recall 工具 (受角色门禁保护)、占位符记忆化与打包日志
│   │
│   │   # ── 4. Entry 改造与既有模块接线
│   ├── index.ts                         # 统一挂载 context / turn_end / tool_result 及 intentionalAbort
│   ├── todos-service.ts                 # 改造 emitCompletedTransitions 暴露 source 字段
│   ├── todo-reminder-core.ts            # 定时器与输入参数接入 compactionInFlight 互斥守卫
│   └── settle-wake-core.ts              # 识别 intentionalAbort 抑制唤醒提醒
│
└── test/
    ├── compact-economics-core.test.ts   # 纯经济学计算、债务演进与边界用例
    ├── observation-core.test.ts         # 观察打包、整行切分与前缀缓存评估用例
    ├── reducer-core.test.ts             # 逐字节比对、截断识别与密钥过滤用例
    ├── efficiency-config-core.test.ts   # 配置合并、覆盖与格式校验用例
    ├── efficiency-store.test.ts         # 安全存储、权限位、等长篡改校验与目录降级用例
    ├── observation-integration.test.ts  # 观察结果折叠、obs_recall 分页召回与角色门禁测试
    ├── compact-integration.test.ts      # 压缩全链路状态机、纠偏与中断保护用例
    └── reducer-integration.test.ts      # 截断回退、密文过滤、局部替换与原文归档集成用例
```

---

## 7. 实施分阶段路线图与验收矩阵

### 7.1 分阶段开发计划与完成状态

* **阶段一：纯核心、配置体系与存储基线 (Zero-Risk & 100% 单元测试) —— [已完成]**
  1. [x] 编写 `schemas/efficiency-config.schema.json` 契约文档；
  2. [x] 实现 `efficiency-config-core.ts`（支持环境变量覆盖、配置整体覆盖、磁盘配置文件自动读取与错误收集）；
  3. [x] 实现 `compact-economics-core.ts`（实现公式、债务追踪、首次放宽与 `nativeFeasible` 纯函数）；
  4. [x] 实现 `observation-core.ts`（整行切片、前缀缓存代价估算、派生 ID）；
  5. [x] 实现 `reducer-core.ts`（逐字节引文校验、命令识别、密钥正则过滤）；
  6. [x] 实现 `efficiency-store.ts`（安全会话目录寻址、权限控制与安全临时文件读取）；
  7. [x] **验收门禁**：既有测试保持 100% 通过，新增 37 个纯核心单测全部通过。

* **阶段二：ObservationPack 完整落地 (观察级能效) —— [已完成]**
  1. [x] 在 `core/observation.ts` 注册 `obs_recall` 工具；
  2. [x] 挂接 `pi.on("context")`，根据消息数组后续 assistant 计数推导轮次，接入缓存失效估算；
  3. [x] 挂接角色门禁检查，不可见时跳过打包；
  4. [x] 接入 `observation.jsonl` 审计流水输出；
  5. [x] **验收门禁**：测试多轮工具输出折叠、翻页召回、重启/resume 恢复一致性（新增 4 个集成测试全部通过）。

* **阶段三：Todo 驱动的在线压缩落地 (上下文级能效) —— [已完成]**
  1. [x] 改造 `TodosService`，为 `todo.completed` 增加 `source` 标记；
  2. [x] 改造 `index.ts` 引入 `intentionalAbort` 状态，更新催办守卫与唤醒抑制；
  3. [x] 实现 `compact-coordinator.ts`，打通 `turn_end` 判定、`hasPendingMessages` 检查、`ctx.compact` 调度与自定义提示词注入；
  4. [x] 决策状态（epoch、debt、样本列表）通过 `pi.appendEntry` 随分支持久化；
  5. [x] 接入 `compact.jsonl` 审计流水输出；
  6. [x] **验收门禁**：模拟多步骤待办推进，验证到达经济学边界时的自动压缩、未完成待办无缝继承与中断安全（新增 8 个集成测试全部通过）。

* **阶段四：EPR 进程内提炼落地 (委派级能效) —— [已完成]**
  1. [x] 实现 `reducer-invoker.ts`，完成 `details.fullOutputPath` 读取与三道安全路径核验；
  2. [x] 接入 `pi.on("tool_result")`，在进程内发起带 5s 超时的轻量模型调用，执行逐字节比对；
  3. [x] 任何校验不通过或异常立即 Fallback 放行完整原文；
  4. [x] 替换前强制将原文保存至 `evidence-preserving-reducer/objects/`；
  5. [x] 接入 `reducer.jsonl` 审计流水输出；
  6. [x] **验收门禁**：验证通过/失败测试命令提炼、虚假引文被拒并回退、长日志本地回读路径有效性（新增 6 个集成测试全部通过）。

---

### 7.2 必测的 Fail-Open 与极限边界测试矩阵

| 模块 | 极限边界 / 故障场景 | 预期行为 (Fail-Open / 安全断言) |
|---|---|---|
| **存储安全** | `getSessionDir()` 返回空 / 目录无写权限 / 磁盘满 | 机制静默停用，不向模型返回错误，正常放行原对话与原工具输出。 |
| **存储安全** | `sessionId` 包含非法路径字符（如 `../../etc`） | 抛弃自定义路径，回退到安全内存哈希目录，防止目录遍历。 |
| **配置安全** | 非受信项目（`ctx.isProjectTrusted() === false`）配置开启 EPR | 强制覆盖为 `disabled`，输出单行警告，绝不向外部模型发送日志。 |
| **EPR 提炼** | 模型产生虚构行、乱序行或哪怕 1 个字节的差异 | `validateReceipt` 失败，立即回退原日志全文，遥测记录原因。 |
| **EPR 提炼** | 模型超时（>5s）/ 网络中断 / 401 鉴权失败 | 捕获异常立即回退原日志全文，耗时压在 5s 内，不拖慢 Agent 主链路。 |
| **EPR 提炼** | 日志中包含 API Key / Token 等敏感特征正则 | 立即放弃提炼，原样输出全文，遥测仅记录敏感命中状态。 |
| **EPR 提炼** | bash 输出被截断且找不到 `fullOutputPath` 临时文件 | 放弃提炼，回退全文，严禁在不完整日志上签发成功收据。 |
| **OCC 压缩** | 压缩前夕检测到 `ctx.hasPendingMessages() === true` | 放弃本轮 abort，保证交互模式下排队消息顺畅送达。 |
| **OCC 压缩** | `nativeCompactionFeasible` 判定切不出任何历史消息 | 放弃 abort，决策记录为 `native_not_compactable`，避免空转。 |
| **OCC 压缩** | 压缩进行中用户强制按 ESC 键中断 | 正确清理 `compactionInFlight`，释放所有锁，不触发异常唤醒风暴。 |
| **OBS 打包** | 当前角色清单中未包含 `obs_recall` 工具 | 不对大文本执行占位替换，保持全文发送，防止模型无法召回。 |
| **OBS 打包** | 大工具输出属于报错结果（`isError: true`） | 永久豁免打包，确保失败排障上下文 100% 完整可见。 |

---

## 8. 总结与确认

本修订版设计文档已全量吸收首轮审阅意见，并完成 4 轮 code review 复审的修复闭环（逐轮验证记录见 `code review.md`）：
1. **测试基线与术语校准**：基线 545 个测试；共新增 67 个用例（44 纯核心 + 7 OBS 集成 + 9 OCC 集成 + 6 EPR 集成 + 1 index 生命周期），`packages/pier-ext` 现为 612/612，明确定性为有损摘要压缩；
2. **严防设计过度**：彻底放弃 Action Fusion，彻底放弃 Subagent 引入，EPR 坚守进程内微型过滤器定位；
3. **架构安全与闭环**：落实未截断日志落盘、前缀缓存代价权衡、状态落盘与独立遥测日志；
4. **与现有系统的无缝融合**：所有环境变量对齐 `PI_HERDR_*`，催办与唤醒守卫接线严密，角色与写锁基线得到严格维护；
5. **未闭合项透明化**：OBS 热路径记忆化已在 Round 4 实测收敛（8MB 项命中 0.0–0.3 ms）；其余已知限制与后续工作统一登记在 §9。

---

## 9. 残余事项与工程加固完成状态 (Completed Follow-ups & Hardening)

本节记录此前复审登记的 7 项技术债务与后续增强项的最终落实状态：**全部 7 项已实现并通过自动化测试验证；其中 `compact-economics-core.ts` 另有已归档的变异测试证据（见末行）。**

| 项 | 落实方案与状态 | 验证结果 |
|---|---|---|
| **遥测与对象的保留策略** | `appendEfficiencyLog` 实现 5MB 轮转为 `.old`（该轮转自首版即存在）与新对象剪枝：`pruneObjectsDirectory`（300 文件 / 50MB 阈值）+ `pruneSessionObjects`（两个 objects 目录），每 50 次存储及 `session_shutdown`（`await`）自动触发 | 单测 `pruneObjectsDirectory`、`pruneSessionObjects` 验证通过（后者断言两个目录各剪一条） |
| **reducer 日志携带 `epoch`** | `handleReducerToolResult` 接入 coordinator 动态 `epoch` 并在 `reducer.jsonl` 中输出 | 单测验证日志包含 `"epoch": 2` 与 `"sessionId"` |
| **尊重 pi 原生 `compaction.*` 设置** | `loadEfficiencyConfigFromDisk` 自动读取 `settings.json`（全局与项目受信配置，支持 `agentDir`/`PI_CODING_AGENT_DIR` 注入）；若原生禁用则 OCC 自动同步禁用；自动继承原生 `keepRecentTokens` | 单测（隔离临时目录）：显式启用 OCC + pi `enabled=false` → 禁用；env 强制优先；显式 `keepRecentTokens` 优先；未受信项目文件忽略 |
| **OBS 压缩点批量打包** | 导出 `batchPackObservations` 与 `createCompactionBatchPackHook`，OCC 触发 `ctx.compact()` 前自动回调预打包符合条件的长观察并注入记忆缓存（上限 20 条 / 10MB，写 `packed-batch` 遥测） | 单测覆盖：上限与遥测字段、角色门禁 deny → 不落盘、非 message 条目忽略、二次调用按 memo 幂等不重复 |
| **horizon 统一复用与单测** | `CompactCoordinator.getRemainingHorizon` 全面复用 `estimateRemainingRequests`（支持方差下界与窗口紧缩上限截断），生产接线传入 `contextWindow` | 单测 `getRemainingHorizon` 验证通过（覆盖缺省 4、均值派生与窗口夹紧） |
| **typecheck 静态类型门禁** | 创建 `packages/pier-ext/tsconfig.json` 覆盖 16 个核心与生命周期源文件，根 `package.json` 的 `npm test` 前置执行 `tsc --noEmit` 门禁 | `npm run typecheck` 0 错误通过 |
| **纯核心 Stryker 变异测试证据** | ① `compact-economics-core.ts` 全量测试集：315 mutants / **77.46%**（同批次 `gc-core.ts` 合计 78.26%）；② `observation-core.ts` / `reducer-core.ts` / `efficiency-config-core.ts`：用“**单元 + 集成 spec 子集**”补跑（1160 mutants，整体 **58.79%**；单文件 `observation-core` 66.82%、`efficiency-config-core` 59.80%）；③ 针对 ② 暴露的最弱环节 `reducer-core.ts` 补测（命令词边界 + 收据行格式）并把 `DIAGNOSTIC_COMMAND` 尾边界放宽到 shell 分隔符后复测：**48.52% → 52.52%**。②③ 均为**下界**（真实全量集只会多杀）；全量集跑这 3 个文件实测需 ~2–3h（1160 mutants × 全量 655 测试），未跑 | 报告：`reports/mutation/mutation.json`（全量集）、`efficiency-cores.json`（单元 spec 下界）、`efficiency-cores-integration.json`（单元+集成下界）、`reducer-core-trial.json`（补测后复测） |

> 完整的逐轮验证证据、基准数据与代码定位见仓库根 `code review.md`（Round 1–9 与附录）；**开始试用请先读 [docs/efficiency-trial.md](efficiency-trial.md)**（开启方式 / 观测入口 / 回滚 / 反馈模板）。

# 能效机制试用指南 —— OCC / ObservationPack / EPR (D100–D103)

> **面向对象**：第一次给 pier 开启能效机制的使用者。
> **本文只讲四件事**：怎么开、看什么、怎么判断划不划算、怎么反馈/关掉。
> 逐轮复审与设计讨论属本地开发文档（不入库）；本指南面向使用者。
> **状态**：三机制默认全关、逐项 fail-open，可按需逐项开启试用。

---

## 0. 30 秒摘要

| 机制 | 做什么 | 主要收益 | 何时值得开 |
|---|---|---|---|
| **ObservationPack (OBS)** | 大工具输出（默认 >10KB）发满 `fullSends` 轮后，在**投影层**替换为占位符 + `obs_recall` 分页取回（会话 JSONL 不变） | 不再每轮重放巨型输出 | 长测试/构建日志反复出现时 |
| **EPR (Evidence-Preserving Reducer)** | `bash` 诊断命令（test/build/lint 类）的长日志在进程内用轻量模型提炼成"收据"，**原文强制落盘可回读** | 一轮省掉整段日志重放 | 经常跑 `npm test`/`pytest`/`cargo test` 且日志很长 |
| **OCC (Online Context Compact)** | `todo_write` 每次完成一个边界后，按 KV-Cache 增量成本决定是否触发 pi 原生压缩并续跑 | 避免"缓存反复整段重写"的净亏，保留未完成任务记忆 | 多轮次、长任务、todo 驱动的工作流 |

三者互相独立，可单独开；互斥规则（EPR 收据不再打包、`obs_recall` 输出不提炼等）已内置。

---

## 1. 开启方式

### 1.1 环境变量（最快，只影响当前进程）

```bash
# 先用 OBS 试水（推荐第一步）：打包 + 审计日志
PI_HERDR_OBS_PACK_ENABLE=1 PI_HERDR_OBS_PACK_LOG=1 pi

# 再叠加 EPR：需要指定一个便宜的提炼模型（不指定则继承当前会话模型，通常不划算）
PI_HERDR_OBS_PACK_ENABLE=1 PI_HERDR_OBS_PACK_LOG=1 \
PI_HERDR_REDUCER_ENABLE=1 PI_HERDR_REDUCER_LOG=1 PI_HERDR_REDUCER_MODEL=cliproxy/gemini-3.8-flash-high \
pi

# 最后叠加 OCC：需要显式给压缩成本比率（auto 会尝试从 ctx.model.cost 推导）
PI_HERDR_COMPACT_ENABLE=1 PI_HERDR_COMPACT_LOG=1 PI_HERDR_CACHE_RATIO=auto pi
```

| 环境变量 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `PI_HERDR_OBS_PACK_ENABLE` | `0`/`1` | `0` | OBS 占位替换总开关 |
| `PI_HERDR_OBS_PACK_LOG` | `0`/`1` | `0` | 写 `observation.jsonl` |
| `PI_HERDR_REDUCER_ENABLE` | `0`/`1` | `0` | EPR 提炼总开关 |
| `PI_HERDR_REDUCER_LOG` | `0`/`1` | `0` | 写 `reducer.jsonl` |
| `PI_HERDR_REDUCER_MODEL` | `provider/model` | 继承当前模型 | 专用轻量提炼模型 |
| `PI_HERDR_COMPACT_ENABLE` | `0`/`1` | `0` | OCC 压缩总开关（会覆盖 pi 的 `compaction.enabled=false`） |
| `PI_HERDR_COMPACT_LOG` | `0`/`1` | `0` | 写 `compact.jsonl` |
| `PI_HERDR_CACHE_RATIO` | 数字 / `auto` | `auto` | KV 缓存写/读成本比；`auto` 时从模型 `cost.cacheWrite/cacheRead` 推导 |

> 环境变量优先级最高，便于临时试用与 A/B。想彻底关掉就删掉变量或置 `0`。

### 1.2 配置文件（持久生效）

- 用户级：`~/.pi/agent/herdr-pi/config.json`
- 工作区级：`<repo>/.pi-herdr/config.json` —— **仅当该项目被 pi 标记为受信时才生效**（未受信时整份忽略并在 stderr 告警一次）

```json
{
  "version": 1,
  "onlineContextCompact": {
    "enabled": false,
    "logEnabled": false,
    "cacheWriteReadRatio": "auto",
    "firstCompactionRequestScale": 2.0,
    "subsequentCompactionMargin": 1.5,
    "keepRecentTokens": 20000
  },
  "observationPack": {
    "enabled": true,
    "logEnabled": true,
    "thresholdBytes": 10240,
    "fullSends": 2,
    "recallChunkBytes": 16384,
    "excerptBytes": 1024
  },
  "evidencePreservingReducer": {
    "enabled": false,
    "logEnabled": false,
    "model": "cliproxy/gemini-3.8-flash-high",
    "minBytes": 4096,
    "maxChars": 600000,
    "maxOutputTokens": 2048,
    "timeoutMs": 5000,
    "localOnly": false
  }
}
```

语义要点（试用期最容易踩的三条）：

1. **优先级**：环境变量 > 工作区配置 > 用户配置 > 内置默认（全 `false`）。
2. **工作区配置是整体覆盖**，不与用户配置深合并（"工作区只写一行 `enabled:false` 就能关掉"是可预期的）。
3. **未知键 / 类型非法 → 该机制强制 `enabled:false`**（一次收集全部问题，打印单行 stderr 警告，不会中断会话）。所以"写了配置但没生效"时请先看 stderr 的 `[pi-herdr] efficiency config warning`。
4. `onlineContextCompact.keepRecentTokens` 缺省会**继承 pi 的 `compaction.keepRecentTokens`**；若 pi 里设了 `compaction.enabled=false`，OCC 会同步禁用（除非 `PI_HERDR_COMPACT_ENABLE=1` 强制）。

---

## 2. 建议的试用顺序（一次只加一个）

| 步骤 | 开什么 | 先确认 |
|---|---|---|
| 1 | OBS（`OBS_PACK_ENABLE=1` + `OBS_PACK_LOG=1`） | 折叠后模型还能正常干活；`obs_recall` 能取回原文 |
| 2 | + EPR（配 `REDUCER_MODEL`） | 收据能定位失败原因；回退（fallback）不频繁 |
| 3 | + OCC（`COMPACT_ENABLE=1`） | 压缩时机合理、压缩后能自动续跑、未完成 todo 被保留 |

每一步至少跑一次真实的长任务（测试/构建/多步重构）再决定是否叠加下一步。

---

## 3. 看什么（观测入口）

```bash
/pier-config                 # 5 平面索引（含 OCC/OBS/EPR 的一行状态）
/pier-config show efficiency # 三个机制全部键的 生效值 / 来源 / 影响
/pier-config check           # 校验（含 boot-config 路径、env 越界）
```

日志与对象都在 pi 会话目录下（`ctx.sessionManager.getSessionDir()`，通常形如
`~/.pi/agent/sessions/<项目编码>/<会话 id>/`）：

```text
<sessionDir>/herdr-pi/<sessionId>/
├── observation-pack/objects/obs_<hash24>.txt          # OBS 归档的原始大输出（0600）
├── evidence-preserving-reducer/objects/<sha256>.txt   # EPR 归档的原始日志（0600，收据里给出该路径）
└── efficiency-logs/
    ├── observation.jsonl    # packed / packed-batch / recall
    ├── reducer.jsonl        # applied / fallback（含 reason）/ 耗时
    └── compact.jsonl        # decision（含原因枚举）/ 压缩完成摘要
```

- 每个 `.jsonl` 超过 5MB 会自动轮转为 `.old`；`objects/` 超过 300 文件或 50MB 会自动剪掉最旧的。
- 常见字段：`schema`/`mechanism`/`ts`/`sessionId`；OBS 的 `obsId`/`originalBytes`/`grossSavedTokens`/`sendCount`/`source`；EPR 的 `commandSha256`（**不记命令明文**）/`sourceBytes`/`verificationOk`/`reason`/`action`/`durationMs`；OCC 的 `decision`/`breakevenRequests`/`expectedRemainingRequests`/`epoch`。
- OCC 的 `decision` 枚举含义：`economic`（经济学触发）、`window_protection`（窗口保护触发）、`deferred_*`（本轮不压，附原因）、`native_not_compactable`（pi 原生切不出历史消息，放弃 abort）、`non_positive_saving`/`horizon_unavailable`/`cache_ratio_unavailable`（样本或参数不足）。

---

## 4. 粗判"是否划算"

| 机制 | 三个数字 | 判定 |
|---|---|---|
| OBS | `grossSavedTokens` 累计 vs `recall` 次数 | 命中多、召回少 = 省；若模型频繁 recall 同一 id，说明 `excerptBytes`/`thresholdBytes` 需要调 |
| EPR | `action:"applied"` 占比、`compressionRatio`、`reason` 分布 | applied 多且 `truncated-source`/`likely-secret`/`hash-failure` 少 = 稳；若多为 `hash-failure`，考虑换更听话的 reducer 模型 |
| OCC | `breakevenRequests` vs `expectedRemainingRequests`、压缩后是否续跑 | breakeven 明显小于预期剩余请求 = 值得；频繁 `deferred_economic` = 样本还不足（多跑几个 todo 边界会自动校准） |

> 注意：OBS 的 `grossSavedTokens` 是**毛收益**（未扣打包造成的缓存重写代价）；真正的判定请结合是否"压缩点/里程碑边界"发生。

---

## 5. 安全边界与回滚

- **默认全关**：不开启时三机制完全不介入（不写对象、不写日志、不动投影）。
- **EPR 会把日志发给模型**：`localOnly: true` 时只归档不提炼；命中 `api_key|authorization|bearer|access_token|secret` 特征的行会直接放弃提炼、原样输出全文（遥测只记 `reason:"likely-secret"`）。
- **未受信项目的工作区配置整份忽略**；EPR 另外还会在运行时校验 `ctx.isProjectTrusted()`。
- **回滚**：删掉环境变量 / 把配置里的 `enabled` 置 `false` 即可即时恢复；已产生的日志与对象只影响磁盘占用（会被自动剪枝），不会影响会话正确性。

---

## 6. 反馈模板（贴这几样就能定位问题）

1. `/pier-config show all` 的完整输出（或 `/pier-config doc` 生成的报告文件）。
2. 对应 `efficiency-logs/*.jsonl` 的相关片段（**日志本身已脱敏**，只有 sha256 与字节数，可放心贴）。
3. 当时的模型 id 与 `PI_HERDR_CACHE_RATIO`（若是 `auto`，附 `ctx.model.cost` 的 `cacheRead`/`cacheWrite`）。
4. 观感一句话：占位符是否影响可读性 / 收据是否够定位失败 / 压缩后续跑是否顺畅。
5. 期望 vs 实际（例："`pip install` 的日志被折叠成占位符后，我看不到最后一行报错"、"压缩后模型忘了第 3 个未完成 todo"）。

> 反馈请附上**复现所用命令与机制开关**；如果是"某类日志不该被折叠/提炼"，附一段脱敏后的样例输出即可。

---

## 7. 当前已知限制（试用期请知悉）

- OBS 的 horizon（剩余请求估计）来自 OCC 的 todo 边界样本；**样本不足时保守回退为 4**（此时更倾向少打包）。
- 打包决策是"**首次按经济学判定 + 之后粘性保持**"，不会每轮重新评估。
- 批量打包（压缩点顺路打包）上限 **20 条 / 10MB**；占位符 memo 上限 256 条（LRU 近似）。
- pi 的 `compaction.*` 只在启动时读取一次；改了 pi 设置需要重启会话。
- `keepRecentTokens` 若在效率配置中显式给出，则以效率配置为准（不继承 pi）。
- 纯核的变异测试证据：`compact-economics-core.ts` 为全量测试集 77.46%；其余 3 个核心为“单元 + 集成 spec 子集”下的**下界**（`observation-core` 66.82% / `efficiency-config-core` 59.80% / `reducer-core` 52.52%，后者经一轮补测从 48.52% 提升）。完整清单见 RFC §9 与 ADR `Known residuals`。
- EPR 的命令识别（`DIAGNOSTIC_COMMAND`）两侧边界都接受 shell 分隔符：`(npm test)`、`npm test&&echo ok`、`pytest;` 可识别；`makefile`、`coqtop`、`npm run test` 不会误判。

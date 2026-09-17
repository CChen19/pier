# 能效试用复审截止点 —— 2026-09-17

> 用途：下次优化后只读 **本截止点之后** 的 session / `efficiency-logs`，对比 OCC/OBS/EPR 是否生效。
> 不要再从 9/15 全量扫一遍。
> 判定口径仍以 [`docs/efficiency-trial.md`](efficiency-trial.md) §3 / §4 为准。

---

## 0. 下次从这里开始

| 项 | 值 |
|---|---|
| **本复审截止** | `2026-09-17T09:25:00Z` |
| **覆盖窗口** | session 文件名日期 `2026-09-15` … `2026-09-17`（含跨天续跑） |
| **日志根** | `~/.pi/agent/sessions/<项目编码>/herdr-pi/<sessionId>/efficiency-logs/{observation,reducer,compact}.jsonl` |
| **配置快照** | `~/.pi/agent/herdr-pi/config.json`：OCC/OBS/EPR `enabled+logEnabled` 全 true；`cacheWriteReadRatio: "auto"`；reducer `cliproxy/gemini-3.8-flash-high` |
| **当时默认模型** | `cliproxy/gemini-3.8-flash-high`（`models.json` `cost.*` 全 0，`contextWindow=1048576`） |

**下次纳入规则（任一即读；唯一水位线是上面的 `2026-09-17T09:25:00Z`）：**

1. 新 session 文件名日期 `> 2026-09-17`，或同日但 start `> 08:45:39Z`（本窗口最后一条 `01a0ae8a` 的 start；09:00–09:25 之间新开的 session 也必须纳入——它们既不满足日期条件也不在下表，只有这条规则能接住）。
2. 下表已列 session 的 jsonl / `efficiency-logs/*.jsonl` **mtime > 2026-09-17T09:25:00Z**（续跑增量）。
3. `01a0ae8a-fe5b-7311-a6d2-cbbf298946a3` 复审期间仍在追加（compact.jsonl 从 1 条涨到 3 条）：下次**必须重读其尾部**，不要当作已完结。

**对比本复审基线（优化是否生效）：**

| 机制 | 本窗口基线 | 优化生效应看到 |
|---|---|---|
| OCC | 61 decision，**0 compact**；60× `cache_ratio_unavailable`，1× `non_positive_saving` | 出现 `economic` / `window_protection`，以及 `compaction-continue` / 原生 compaction entry；决策行带 `resolvedRatio`/`model`/`remainingBoundaries` |
| OBS | 72 packed 日志行（**含 2 条进程重启重复 log，去重后 70 个 obsId**；54 行 `sendCount=2` 准时，20 行迟折，最高 175），**0 recall** | 迟折（`sendCount≫2`）下降；`grossSavedTokens` 相对大输出比例上升；仍保持 recall 少 |
| EPR | 18 次，5 applied / 10 `likely-secret` / 3 `invalid-json`；3+ 次 invoke 失败无日志 | `applied` 占比升；`likely-secret` 不再打 `npm test` 自身；fallback 行带脱敏 `secretSnippet`；`invalid-json` 行带 `rawOutputHead` |

---

## 1. 已读 session 清单

路径均相对 `~/.pi/agent/sessions/`。`last_ts` 是 jsonl 最后一条带 `timestamp` 的记录。

| start (Z) | last_ts (Z) | sessionId | 项目 | 模型 | obs | compact | reducer | 备注 |
|---|---|---|---|---|---:|---:|---:|---|
| 2026-09-15T06:11:21 | 06:11:48 | `01a0a3b1-0300-7136-998d-26a925d4202d` | CRM | cliproxy/gemini | 1 | 0 | 0 | 短：拉 master |
| 2026-09-15T06:11:53 | 06:21:45 | `01a0a3b1-7ce1-72b8-9f5e-5ef1ba27760e` | CRM | cliproxy/gemini | 3 | 3 | 0 | 唯一 `non_positive_saving` |
| 2026-09-15T07:20:53 | 09-16T06:25:37 | `01a0a3f0-a9b5-75cf-a481-c74f49235244` | apnv3-backend | gemini → deepseek-v4.1-flash | 6 | 9 | 2 | 跨天；max totalTokens 614k；OBS 迟折 sendCount=175 |
| 2026-09-15T09:48:24 | 09:48:44 | `01a0a477-b93d-71e3-a91b-29107055fd02` | skillPool-apps-desktop | gemini | 0 | 0 | 0 | hello，可忽略 |
| 2026-09-16T06:09:22 | 06:16:47 | `01a0a8d5-8b8d-7410-8085-bb32469e8ee3` | skillPool | gemini | 0 | 3 | 0 | 输出未过 OBS 阈值 |
| 2026-09-16T06:28:00 | 09-17T03:03:02 | `01a0a8e6-9bd1-71b8-b847-c4e9934e7e86` | apnv3-backend | gemini → **xai/grok-4.6** | 2 | 8 | 0 | grok usage：cacheRead 有计费、cacheWrite 恒 0；仍 `cache_ratio_unavailable` |
| 2026-09-16T07:15:46 | 09-17T01:10:24 | `01a0a912-57be-706c-8663-367d0be4235c` | CRM | gemini → **xai/grok-4.6** | 12 | 3 | 0 | 同上 grok 隐式缓存 |
| 2026-09-17T01:10:24 | 01:26:14 | `01a0acea-306a-747f-84d7-21a61f2a1a7b` | pier | gemini | 12 | 2 | 0 | 两 obsId 进程重启重复 log |
| 2026-09-17T01:25:58 | 01:26:01 | `01a0acf8-7143-72be-b021-55151e7c212e` | pier | union-alpha | 0 | 0 | 0 | 模型探测，可忽略 |
| 2026-09-17T01:26:28 | 01:37:21 | `01a0acf8-e75b-70ef-9e71-d39c05388f94` | pier | gemini / union-alpha | 0 | 0 | 0 | 短切换 |
| 2026-09-17T01:37:26 | 02:36:15 | `01a0ad02-f14e-7686-be34-ee2310f68008` | pier | gemini | 12 | 16 | **15** | 三项日志最全；EPR 唯一种 applied 来源 |
| 2026-09-17T03:08:55 | 03:29:53 | `01a0ad56-b3ca-735d-b774-62572e4966b0` | apnv3-backend | gemini | 8 | 2 | 0 | |
| 2026-09-17T05:17:47 | 05:45:27 | `01a0adcc-af88-76d1-aa2b-0961d22dc141` | claude-plugins | gemini → **opencode-go/deepseek-v4.1-flash** | 4 | 2 | 1 | DeepSeek cacheRead 累加 1856 万 token，write=0 |
| 2026-09-17T05:55:25 | 07:08:27 | `01a0adef-2269-7155-831b-c583b42a398b` | apnv3-backend | gemini | 1 | 11 | 0 | |
| 2026-09-17T07:33:31 | 08:15:08 | `01a0ae48-f2a8-7278-8f51-38d5aaa00eab` | apnv3-backend | gemini | 2 | 0 | 0 | 无 todo 边界，无 compact.jsonl |
| 2026-09-17T08:45:39 | 09:21:32 | `01a0ae8a-fe5b-7311-a6d2-cbbf298946a3` | apnv3-backend | gemini | 15 | 3 | 0 | **复审时可能仍在续跑** |

未纳入：9/15 之前的 session（含 9/13 pier 开发期）；`pantheon` 本窗口无新 jsonl。

---

## 2. 复审结论（已按代码/日志校正）

### 2.1 OCC：经济通道死了，窗口通道没碰到 —— 0 次压缩

- `ctx.model.cost` 来自价格表，不是 `usage.cost`。cliproxy gemini 在 `~/.pi/agent/models.json` 里 `cacheRead=cacheWrite=0` → `resolveCacheRatioFromCost('auto')` 返回 `null` → 61 次里 60 次 `cache_ratio_unavailable`。
- **这不是「模型没有 KV cache」。** 各 session 的 `message.usage.cacheRead` 大量非零（Grok `01a0a8e6` 累加 8590 万；DeepSeek `01a0adcc` 1856 万；Gemini 同样有 hit），`cacheWrite` 一律 0。含义是没有单独 cacheWrite SKU / 单价表填了 0。
- P0-1（`compact-economics-core.ts`）把 `write=0` 当「无缓存、禁止当 free」是对的：**不能回退 ratio=1.0**（`incremental=0` → 只要 `saving>0` 就压，horizon=1 的收尾边界会白烧一次 summarization）。
- `compact = compressible && (windowProtection || economic)`。windowProtection **不依赖 ratio**。本窗口 max `writeTokens=613295`，gemini 窗 1M、reserve 16384，离 overflow 还远，所以窗口通道也没开火。
- 纯 **token 账**：压缩请求要把当前 `writeTokens` 再读一遍，breakeven = `writeTokens / savingTokens`，等价 **ratio=2**。对照 `01a0a3f0` epoch6：`222404 / 198358 ≈ 1.12`，horizon=191 该压；horizon=1 不该压。
- **horizon=1（28/61）是两个已确认机制的叠加**：
  1. 公式 `1 + floor(mean × remainingBoundaries)`——最后一个未完成 todo 被勾掉后 `remainingBoundaries=0` → 恒为 1；
  2. `onInput` 人话清空 `completedBoundaryRequestCounts`（`compact-coordinator.ts:140`，同时 `epoch++`——这解释了零压缩却 epoch 1→9）→ mean=0 → 同样恒为 1。OCC 路径清空后没有空样本回退（回退成 4 的只有 OBS 的 `getRemainingHorizon`）。
- **grok/deepseek 的 `models.json` 本地 cost 也是全 0**（`:144/:218/:250`）；`01a0a8e6`/`01a0a912` usage 里的非零 cacheRead 成本是 provider 响应回报的实际计费，不是本地静态价。因此 `auto` 从 `cost.input/cacheRead` 推导对这台机器上的所有模型都走不通，出路只有：provider 族常量、运行时 usage 实测、或显式 `PI_HERDR_CACHE_RATIO`。
- `getRemainingHorizon(3, …)` 的 `3` 是 OBS 用的 **默认 remainingBoundaries**，空样本回退是 **4**。不要写成「horizon 回退成 3」。

### 2.2 OBS：在干活，但是少折（不是多折）
- JSONL 不变、0 `obs_recall`、excerpt 够用：§4「命中多、召回少」成立。
- `shouldPackForCache` 里 **ratio 越大越不打包**。`auto`/`null` 被当成 12.5（Anthropic）。隐式缓存真实惩罚更接近 `input/cacheRead`（grok/deepseek 大约 4–10），12.5 高估了代价 → **少打包**。20/72 条拖到 `sendCount` 3–175 才折；迟折期间 `originalTokens×(sendCount-2) ≈ 590 万 token-turn` 本可早省。
- 与 OCC 的 `auto` 语义分裂：OCC → null（放弃），OBS → 12.5（保守少折）。必须共用 **解析后的** ratio。
- cliproxy gemini 单价全 0：`input/cacheRead` 算不出数，救不了默认模型；必须有「族回退」或显式 `PI_HERDR_CACHE_RATIO`。

### 2.3 EPR：28% applied，大日志和 Java 没吃到

- 5 次 applied 全是 pier `01a0ad02` 的 `cd packages/pier-workbench && npm test`，压缩比 ~0.11，收据 TAP summary 可用。
- 10× `likely-secret`：正则过宽（`secret:` 测试名、JSON `"Authorization":` 即可命中）。**pier-ext 自己的 `npm test`（~150KB）7/7 被挡** —— 最该减的日志。
- 3× `invalid-json`：同一 `commandSha256=ce1adef8…` 与 applied 混出，reducer 输出不稳（无围栏剥离、未关 thinking、5s/2048 贴边）。失败 **不记 raw 输出**。
- 遥测：fallback 行 `model=cliproxy/gemini-3.8-flash-high`，applied 行 `gemini-3.8-flash-high`，同会话分组会裂。
- 无跨运行 memo：`d89efa74` 多次 likely-secret 每次仍扫全文；`ce1adef8` 每次 2–4.5s 重提炼。
- `DIAGNOSTIC_COMMAND` 无 `mvn`/`gradlew`/`npx tsx --test`。apnv3/CRM 主业 `mvn -Dtest=…` 从未进 EPR。
- reducer 模型 = 会话模型（flash-high），每次 applied 额外 ~4500 token + 2–5s。

---

## 3. 推荐优化方案（先不改代码也能做 0）

目标默认按 **省 token**（cliproxy 单价全 0，美元账无意义）。美元账只在 grok/deepseek 有非零 `cost.input/cacheRead` 时另列。

### 0. 今天就能做（配置，不改 pier）

```bash
# token 账：压缩请求本身要再读 writeTokens 一遍 → ratio=2
# 不要设 1.0（incremental=0 → 收尾边界也会压）
export PI_HERDR_CACHE_RATIO=2
```

或写进 `~/.pi/agent/herdr-pi/config.json` 的 `onlineContextCompact.cacheWriteReadRatio: 2`。

新开的 session 应开始出现 `deferred_economic`（horizon=1 时正确不压）和 `economic`（horizon ≫ breakeven≈1.1 时压）。**旧 session 不会补压。**

EPR reducer 模型**不再建议更换**：见 §5 的用户拍板（gemini flash-high 保留，不可用回退主 session 模型）。

### 1. OCC `auto` 回退（代码，P0）

`resolveCacheRatioFromCost` 在 `auto` 时：

| 价格表 | 回退 | 不要 |
|---|---|---|
| `cacheRead=0 && cacheWrite=0`（cliproxy gemini） | **2.0**（token 账） | `null`（现状=关 OCC）；**1.0**（P0-1 防过的永远压） |
| `cacheWrite=0 && cacheRead>0`（grok/deepseek 隐式） | 若 `cost.input>0`：`input/cacheRead`（约 4–10）；否则 2.0 | 把 write=0 当 free |
| Anthropic 式 `write>0 && read>0` | `write/read`（保持） | |

经济通道活过来之后，**最后一个 todo 不要靠 `firstCompactionRequestScale=2.0` 把 horizon=1 抬成 2 再压**：`remainingBoundaries===0` 且非 `windowProtection` → 不 compact。否则 ratio=2 会在收尾边界花 20–60 万 token 做一次零后续收益的 summarization。

决策 log 补：`resolvedRatio`、`model.cost`、`remainingBoundaries`。没有这些下次还是猜。

### 2. OBS 与 OCC 共用已解析 ratio（代码，P0）

`shouldPackForCache` 不要把 `'auto'|null` 偷换成 12.5。传入 OCC 同一套 resolved number。

隐式缓存 / token 账下 `fullSends` 到期就折，避免 12.5×巨大 tail 把折拖到 sendCount=100+。

### 3. EPR（代码，P1）

1. **收窄 `LIKELY_SECRET`**：`[=:]` 后要像 token 的高熵值；排除测试名 `secret:`、JSON 空数组。fallback 必须 log 匹配片段。
2. **`DIAGNOSTIC_COMMAND` 加 `mvn`/`gradlew`/`npx tsx --test`**；考虑拿掉 `py_compile`。
3. **提炼稳健**：剥 \`\`\`json 围栏；`thinking: none`；`invalid-json` 记 raw 截断；超时也写 jsonl（现在 catch 静默）。
4. **按 `commandSha256+sourceHash` memo**：已知 `likely-secret` 不再扫；已知 applied 且 hash 相同可跳过模型。
5. **`model` 字段统一**为 `provider/id`。

### 4. 明确不做 / 降级

- **不动 `firstCompactionRequestScale` 默认 2.0**：它是首次压缩的冷启动放宽，调低只会更不压；收尾边界的无用压缩由「remainingBoundaries=0 不放宽」+ ratio=2 经济学双重挡住。
- 不把 window_protection 当 OCC 已可用：1M 窗下本试用几乎摸不到。若要当安全网，改成比例阈值（例如 15% 剩余），那是另一项产品决策。
- 不把 OBS 0 recall 当 bug。§4 判定就是召回少 = 省；要盯的是迟折。
- 不用编造价格半填 `models.json`（示例数字会被当真值）；引用该文件进文档时必须剥掉 apiKey 字段（本文件未引用）。

### 5. 落地记录（2026-09-17 当天已实施）

用户拍板：`gemini-3.8-flash-high` 继续当 reducer，**不可用时回退主 session 模型**（不是换模型）。

| 改动 | 文件 | 要点 |
|---|---|---|
| OCC `auto` 回退 | `compact-economics-core.ts` | 显式价 → `write/read`；隐式（write=0 且 input>0）→ `input/cacheRead`；族回退 gemini=4 / grok·deepseek=10；未知 → **2.0**。`auto` 不再返回 null |
| horizon 样本跨人话存活 | `compact-coordinator.ts` | `onInput` 不再清空 `completedBoundaryRequestCounts`；样本上限 16（`MAX_BOUNDARY_SAMPLES`）。超出原批准计划，用户 2026-09-17 复核后拍板保留 |
| 收尾边界门闩 | `compact-economics-core.ts` | `remainingBoundaries===0` 时不享受 firstCompaction 放宽（horizon 保持 1，breakeven≈1.9 挡住） |
| 决策日志可诊断 | `compact-coordinator.ts` | decision 行新增 `resolvedRatio` / `incrementalCacheCostRatio` / `remainingBoundaries` / `model` / `provider` |
| OBS 共用 ratio | `observation-core.ts` + `core/observation.ts` | `shouldPackForCache` 只收 number；context 事件里用与 OCC 相同的 `resolveCacheRatioFromCost` 解析 |
| EPR secret 收窄 | `reducer-core.ts` | 值形态门控（已知前缀或 ≥15 连续 token 字符且含数字）；测试名/JSON 空值/URL/函数调用不再命中；fallback 记**脱敏** `secretSnippet`（值 → `<redacted:N chars,sha8=…>`，可关联不可还原，原文永不落盘） |
| EPR 诊断命令 | `reducer-core.ts` | `DIAGNOSTIC_COMMAND` 增加 `mvn`/`mvnw`/`gradle`/`gradlew`/`npx tsx --test`（apnv3/CRM 的 mvn 主业日志进门） |
| EPR 提炼稳健 | `reducer-core.ts` | `validateReceipt` 先剥 Markdown json 围栏（模型常无视「只回 JSON」指令） |
| EPR 模型回退+标签 | `reducer-invoker.ts` | 配置模型 `find` 失败 → `ctx.model` 回退；日志记 `reducerModelSource: configured\|session-fallback`；`model` 字段统一 `provider/id` |
| EPR 遥测补全 | `reducer-invoker.ts` | invoke 超时/异常落 `invoke-failed` 行；`invalid-json` 记 `rawOutputHead`（200 字符 JSON 转义） |

验证：`tsc --strict` 零错；全量 `node --test` **781/781**（基线 745 → +36，含新增：auto 族回退矩阵、收尾边界不放宽、人话保留样本、secret 新负例、脱敏、围栏解析）。

未做（下次评估）：`thinking: none`（pi complete 选项面未证实，乱传有整路失败风险）；`commandSha256` 跨运行 memo（需要独立的存续策略，避免进程重启后误跳过真失败日志）；window_protection 比例阈值。

### 6. 下次的读法

1. 新 session 先看 `compact.jsonl`：`resolvedRatio` 是否如预期（gemini 4 / grok 10 / 未知 2）；`economic` 是否出现；horizon=1 时是否正确 `deferred_economic`。
2. `observation.jsonl`：迟折行（`sendCount≫2`）占比是否下降。
3. `reducer.jsonl`：`mvn` 命令是否进门；`secretSnippet` 形态；`invalid-json` 是否消失（围栏剥离后）；`reducerModelSource` 是否稳定 `configured`。
4. 验收数字直接对比 §0 基线表。OCC 一旦开始 compact，顺带看 `packed-batch` 是否从 0 变成非 0（`onBeforeCompact` 才会走）。

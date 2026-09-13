# 设计说明：`/pier-config` —— 配置说明与 agent 引导式改配置（D104 候选）

> **状态**：已实现（P0–P2；命令 `/pier-config`，纯核 `config-catalog-core.ts` + 适配层 `config-guide.ts` + 入口 `config-command.ts`）
> **关键决策来源**：本文 §2（已与用户确认）
> **关联**：`docs/efficiency-trial.md`（D100–D103 试用指南）、`schemas/efficiency-config.schema.json`、`schemas/role-manifest.schema.json`、`src/runtime-policy.ts`、`install.mjs`、`docs/sidebar-role-config.md`
> **命名**：命令名带品牌前缀 `/pier-config`（避免与 pi 内建 `/settings` 及未来其它插件冲突；改名成本 = 1 个常量 + 文档）

---

## 1. 背景与目标

pier 的配置散落在 **5 个平面、4 种文件、17 个环境变量**里：改哪个生效、优先级如何、哪些被信任门控静默忽略、哪些要重启进程，全靠翻文档。目标是让用户**一条 slash 命令**拿到"当前有效值 + 来源 + 该改哪里"，并在需要改动时由 **agent 讲解影响、给候选值、展示 diff、等确认、改完校验**。

命令做三件事：

1. **说清楚**：按平面列出现有**有效值与来源**（`env` / `workspace` / `user` / `default`）；
2. **引导改**：无参时注入结构化流程提示（英文），把改动交给 agent 执行（沿用写锁与人工确认）；
3. **能核对**：`check` 一次跑完各平面校验，不依赖模型。

**不做**：不替代 pi 自带 `/settings`（`~/.pi/agent/settings.json` 引导去那里改）；不内置裸写入子命令（写文件仍由 agent 的 `edit`/`write` 完成）。

---

## 2. 已确认决策

| 决策项 | 结论 |
|---|---|
| 命令名 | `/pier-config`（品牌前缀；与 pi 内建 22 个命令及现有 `todos`/`locks`/`efficiency` 均不冲突） |
| 写入能力 | **只读 + 注入引导**：命令本身不写任何配置文件 |
| 覆盖范围 | **全部 5 个平面**（效率机制 / 角色档案 / pi 原生设置 / workbench boot-config / 运行策略 env） |
| 交互形态 | **文本索引 + 注入 prompt**（TUI 与 RPC 均可降级为纯文本；不做 picker） |
| 提示词语言 | **英文**（命令输出面向用户的部分保持与原命令一致的简短中文/英文混排，注入给模型的指令块为英文） |

---

## 3. 配置平面清单（命令的覆盖矩阵）

| 平面 id | 文件 / 来源 | 优先级 | 受信门控 | 校验来源 | 规模 |
|---|---|---|---|---|---|
| `efficiency` | 用户 `~/.pi/agent/herdr-pi/config.json`；工作区 `<repo>/.pi-herdr/config.json`；env `PI_HERDR_{COMPACT,OBS_PACK,REDUCER}_*` | env > 工作区 > 用户 > 默认 | ✅ 工作区需 `isProjectTrusted()` | `validateEfficiencyConfig()` + schema | 20 键 + 8 env |
| `roles` | 内置 `src/roles/{master,worker-default}.json`；工作区 `.pi-herdr/roles/<name>.json`；用户 `~/.pi/agent/herdr-pi/roles/<name>.json` | 工作区/用户层覆盖（内置名不可劫持，D11） | ✅ 加载期校验 | `role-manifest.schema.json` + `role-loader.ts` | `role/version/model/description/manifest{unknownTools,tools,rules}/services.todos` |
| `pi` | `~/.pi/agent/settings.json`（+ 受信项目 `.pi/settings.json`） | 项目 > 全局 | ✅ | pi 自身 | 本命令只**只读**展示 `compaction.enabled/keepRecentTokens`（OCC 相关），其余引导走 `/settings` |
| `boot` | herdr plugin config-dir 的 `boot-config.json`（用户模式；缺省探测 `$XDG_CONFIG_HOME`/`~/.config` 与 `%LOCALAPPDATA%` 下的 `herdr/plugins/config/pier.workbench/`）/ `packages/pier-workbench/scripts/boot-config.json`（dev）；模板 `.example.json` | 唯一 | — | `install.mjs` 探测与写入；`check` 额外校验 `piNode`/`piCli`/`extPath` **路径存在** | `mainTabLabel/piNode/piCli/extPath/workbenchPluginId/hmrDev` |
| `env` | `PIER_*`（`runtime-policy.ts` 9 项）+ `PI_HERDR_{TRACE,HMR,SLIM_FRAME,TODO_GRACE_MS,TERM_IDLE_MS,TERM_GRACE_MS,TERM_READ_MAX}` + `PIER_ISOLATE_SWEEP_ORPHANS` | env 唯一 | — | `parseEnvInt()` 边界（非法 → 告警并回默认值） | 17 项 |

> `PI_HERDR_ROLE_MANIFEST` 由 spawn 注入、非用户配置项，仅在 `show env` 中标注为"由 pier 注入"；`PI_CODING_AGENT_DIR` 归 pi 所有，只读展示。

---

## 4. 命令面

| 命令 | 行为 | 是否注入模型 | 输出 |
|---|---|---|---|
| `/pier-config` | 5 平面索引：每平面 1–2 行（已改项数 / 生效来源 / 该改哪里）+ 注入引导流程 | ✅ | `ui.notify`（≤10 行）+ prompt |
| `/pier-config show [plane\|all]` | 纯读：列出该平面全部键的 `生效值 / 来源 / 默认 / 影响一句话` | ❌ | `ui.notify`；超过 10 行时提示用 `doc` |
| `/pier-config check` | 纯读：汇总各平面校验（未知键、类型/越界、未受信工作区被忽略、文件缺失、JSON 损坏、env 非法） | ❌ | 逐平面 `ok / warn / error` + 修复提示 |
| `/pier-config doc [path]` | 生成"有效值报告"markdown（默认 `<repo>/.pi-herdr/config-report.md`），打印路径 | ❌ | 文件 + 路径通知 |

- **参数补全**：`getArgumentCompletions()` 返回 `show|check|doc|efficiency|roles|pi|boot|env|all`。
- **长文本策略**：完整表格不进 `notify`；`show` 超限时提示 `/pier-config doc`。
- **`/efficiency` 已删除**（D104 定稿后按用户要求移除）：命令尚未发布任何 tag，功能被完全覆盖 —— 三机制状态在 `/pier-config` 索引行，全部键值/来源在 `/pier-config show efficiency`。不保留兼容别名。
- **可见性**：注册在公共段（worker 也能读自身配置）；提示词里带上"当前 pane 是否受信 / 角色"，由 agent 自行约束写入动作。

---

## 5. 注入提示词（英文，落地即用）

```text
[PIER-CONFIG] The user wants to inspect or change pier configuration. Follow this workflow strictly:

1. Ground yourself first: run `/pier-config show all` (or read the files) and use the reported EFFECTIVE VALUE and SOURCE
   (env > workspace > user > default). Only entries whose source is `default` are worth changing; an ignored workspace file
   (untrusted project) must be reported as such instead of edited blindly.
2. Route by plane:
   - efficiency (D100–D103): read `docs/efficiency-trial.md` before proposing values.
   - roles: read `docs/sidebar-role-config.md` and `schemas/role-manifest.schema.json`; builtin role names cannot be overridden.
   - pi (settings.json): recommend pi's own `/settings`; the only OCC-relevant keys here are `compaction.enabled` and
     `compaction.keepRecentTokens` (read-only from our side).
   - boot (boot-config.json): manual edits are risky; prefer `npx pier-setup@latest update --force` and only patch paths when asked.
   - env (PIER_* / PI_HERDR_*): affects new processes only; state that explicitly.
3. Explain before changing: 2–3 sentences on what the knob controls, its cost/benefit (tokens, latency, safety, blast radius),
   and 2–3 recommended values for common scenarios. Then ask what the user actually wants to achieve.
4. Before writing: show a precise diff (file path, current → proposed value) and the activation path
   (hot / needs `/reload` / needs a new session or process restart). Wait for explicit confirmation. Change ONE plane at a time.
5. Apply with the normal `edit`/`write` tools (write locks apply), then run `/pier-config check` and report the result back.
6. If a change cannot take effect in the current process, say so and tell the user exactly what to restart.

Forbidden: dumping `process.env`; writing secrets or tokens into any config file; editing multiple planes before confirmation;
touching `.pi-herdr/` of an untrusted project.
```

---

## 6. 单一事实来源与漂移守卫

新增纯核 `src/config-catalog-core.ts`：

```ts
interface ConfigKnob {
  readonly plane: 'efficiency' | 'roles' | 'pi' | 'boot' | 'env';
  readonly key: string;                 // 扁平键名，如 'observationPack.thresholdBytes' / 'PIER_GC_TICK_MS'
  readonly kind: 'boolean' | 'number' | 'string' | 'enum';
  readonly defaultValue?: unknown;
  readonly envVar?: string;             // 对应的最高优先级覆盖（若有）
  readonly impact: string;              // 一句话影响面（用于 show/doc）
  readonly docAnchor?: string;          // 指向 docs/ 或 schema 的锚点
}
interface ConfigPlane {
  readonly id: string;
  readonly owner: 'pier' | 'pi' | 'workbench';
  readonly trustGated?: boolean;
  readonly schemaPath?: string;
}
declare function resolveProvenance(layers: RawLayers, env: EnvLike): ResolvedKnob[];
declare function renderIndex/ renderPlane/ renderReport(...): string;   // 纯函数
```

**漂移守卫（关键）**：`test/config-catalog-core.test.ts` 解析两个 schema，断言 **schema 键集合 ⊆ catalog 键集合**（反向可选），任何新增配置项忘记登记即测试失败。

- 效率平面复用 `resolveEfficiencyConfig` + `loadEfficiencyConfigFromDisk`（已有 `agentDir` / `userConfigPath` 注入点）拿到有效值；provenance 由各层原始值的存在性推导（env → workspace（受信）→ user → default）。
- 角色平面复用 `role-loader.ts` 的层序；`pi` 与 `boot` 平面只做只读存在性/形状检查。
- env 平面复用 `parseEnvInt` 的边界规则（越界即 warn 并回默认）。

---

## 7. 模块与接线

| 层 | 文件 | 职责 |
|---|---|---|
| Pure core | `src/config-catalog-core.ts` | 目录、provenance、索引/报告渲染、校验汇总（无 I/O，100% 单测，入 Stryker mutate 列表） |
| Adapter | `src/config-guide.ts` | 真实文件/env 读取（路径可注入）、角色层序探测、boot-config 探测、`check` 聚合 |
| Entry | `src/config-command.ts`，由 `index.ts` 公共段 `installConfigCommand({ pi, ... })` 调用 | 注册 `/pier-config`、子命令解析、补全、注入提示 |
| Docs | `docs/configuration.md`（叙述：为什么/怎么改，人工维护）+ `/pier-config doc` 生成的"有效值报告"（机器真值，落 `.pi-herdr/`，不进版本库） | 叙述与真值分工，不重复 |

接线细节：命令走 pi 的 Map 注册（覆写即替换，HMR 安全，无需 ledger）；`index.ts` 公共段注册以获得 worker 可见性；`getConfig`/`enabled` 等读取沿用现有闭包，不引入新的全局状态。

---

## 8. 安全约束

- **只读默认**：命令不写任何文件，除非用户显式要求 `doc`（只写报告文件）。
- **env 白名单**：只读取 catalog 中登记的键，**绝不 dump `process.env`**；`PI_HERDR_ROLE_MANIFEST` 只报"由 pier 注入"。
- **密钥不入盘**：提示词明确禁止把 token 写进配置；报告与索引只显示值，遇到疑似密钥（`api_key|token|secret` 形态）时脱敏为 `***`。
- **未受信工作区标注**：`efficiency` / `roles` 的 workspace 层在 `!isProjectTrusted()` 时标注为"已忽略（未受信）"。
- **boot-config 只读提示**：引导用 `npx pier-setup@latest update --force` 重写，而非手改。
- **fail-open**：所有 I/O 包 try/catch，任何异常都降级为 `ui.notify(简短错误)`，绝不把异常抛进 pi 主链路。

---

## 9. 测试与验收

| 测试 | 覆盖 |
|---|---|
| `test/config-catalog-core.test.ts` | provenance（env > 受信工作区 > 用户 > 默认）、渲染覆盖全部键、白名单不出 `process.env`、未受信标注、疑似密钥脱敏、**schema ↔ catalog 双向覆盖断言** |
| `test/config-guide.test.ts` | 临时目录/env 下的 `show`/`check`/`doc`：坏 JSON、未知键、越界、缺文件、未受信、角色层覆盖 |
| `test/index-integration.test.ts` +1 | 命令已注册；`/pier-config show` 不抛错且含来源列；无参时注入提示（fake pi 捕获 `sendUserMessage`）；断言旧的 `/efficiency` 已不再注册 |
| `stryker.conf.json` | 加入 `src/config-catalog-core.ts` |

**验收**：`npm test` 全绿（含 typecheck 前置）；TUI 与 RPC 模式均可运行（RPC 降级为纯文本 + 注入提示）；`docs/configuration.md` 与 README 各加一处指引。

---

## 10. 分期落地

| 期 | 交付 | 验收 |
|---|---|---|
| **P0** | `config-catalog-core.ts` + `config-guide.ts` 的 `show`/`check` + `config-command.ts` 注册（无注入） + 两个测试文件 + Stryker 名单 | `npm test` 全绿；`/pier-config show efficiency` 能列出 20 键的有效值与来源 |
| **P1** | `/pier-config` 无参注入英文提示词 + `docs/configuration.md` + README 指引 + 删除 `/efficiency` | 真机会话里 `/pier-config` 能把改动引导闭环（含 diff 与 check 回读） |
| **P2** | `/pier-config doc` 报告导出（默认 `.pi-herdr/config-report.md`）+ 参数补全 + RPC 降级路径 | 报告覆盖 5 平面且与 `check` 结果一致 |
| **P3（可选）** | `ui.select` picker（仅 D100–D103 高频布尔/数字项）+ 应用后 `ctx.reload()` 提示 | 见后续反馈再定 |

---

## 11. 落地状态与遗留

已确认并落地：命令名 **`/pier-config`**；只读 + 注入引导；覆盖 5 个平面；文本索引 + 英文提示词。

| 期 | 状态 | 说明 |
|---|---|---|
| P0 | ✅ | `config-catalog-core.ts`（目录 / provenance / 渲染 / 校验汇总）、`config-guide.ts`（文件+env 读取、角色层、boot-config 探测）、`config-command.ts` + `index.ts` 注册 `show`/`check` |
| P1 | ✅ | 无参注入英文引导提示（`pi-herdr.config-guide` 隐藏消息，`triggerTurn`）、`docs/configuration.md`、README 指引、**删除 `/efficiency`**（无兼容别名，功能已被覆盖） |
| P2 | ✅ | `doc [path]` 报告导出（默认 `<repo>/.pi-herdr/config-report.md` + gitignore 提示）、`getArgumentCompletions`、无 UI 时降级为 `console.log` |
| P3 | ⏸ 未实现（有意保留） | TUI picker（仅 D100–D103 高频布尔/数字项）；等试用反馈决定是否值得 |

测试：`test/config-catalog-core.test.ts`（8，含 schema/env 漂移守卫）、`test/config-guide.test.ts`（5，临时目录）、`test/index-integration.test.ts` +1（命令注册、`show`/`check`/`doc`/注入、`/efficiency` 已移除断言）；`config-catalog-core.ts` 进入 Stryker mutate 名单。基线：`packages/pier-ext` 628/628、monorepo 673/673（含 §11 的删除 `/efficiency`）。

**仍未验证**（需要真人环境）：真实 TUI 下 `show all` 的长输出渲染与滚动体验；RPC 模式的实际降级路径（仅由无 UI 分支的单测覆盖）；以及 agent 对注入提示词的遵守程度（依赖模型，属试用反馈项）。

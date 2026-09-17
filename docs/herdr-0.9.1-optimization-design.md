# Herdr 0.9.1 特性适配与优化设计方案

**版本**: 1.0  
**适用协议**: Herdr Protocol 22 (0.9.1)  
**涉及模块**: `packages/pier-ext` (pi-pier), `packages/pier-workbench` (pier.workbench)  

---

## 1. 背景与核心原则

### 1.1 背景
Herdr 于 2026-09-16 升级至 **0.9.1 (Protocol 22)**，带来多机器会话透传（Multi-machine CLI Forwarding）、插件模态浮窗（`placement: "popup"`）、服务端终端标题清洗（`terminal_title_stripped`）、PTY 前台工作目录暴露（`foreground_cwd`）以及 Agent 判决诊断（`agent.explain`）等一系列关键新特性。

### 1.2 核心设计哲学：渐进增强与离线安全（Graceful Degradation）
pier 采用主从插件分离架构：
- 在 **Herdr 运行环境**（`HERDR_ENV=1`）下，充分利用 Herdr 提供的多窗格、Tab 编排和富客户端交互能力；
- 在 **常规终端环境**（iTerm2、Warp、VSCode 内置终端等非 Herdr 环境，`HERDR_ENV` 未定义或 `client.available === false`）下，所有功能必须提供完备的 **Fallback 路线**，保证核心流程（Todo 闭环、写锁安全、用户问答）100% 可用，**绝不发起 Socket 连接，绝不产生未捕获异常或报错中断**。

---

## 2. 方案 1：模态 Popup 仪表盘与三级降级看板

### 2.1 痛点与解决
- **原先问题**：`pier-workbench` 的运维看板通过 `placement = "tab"` 启动，每次查看都需要新建一个完整的工作区 Tab，割裂了用户的分屏与专注流。
- **0.9.1 优化**：利用 `plugin.pane.open` 的 `placement = "popup"`，呼出居中 80%×80% 的会话模态弹窗（Session-Modal Popup）。弹窗不改变原有的 Tab 与分屏结构，用户按 `q` 或 `Esc` 即可退出并自动恢复焦点。

### 2.2 三级自适应降级矩阵（Fallback Matrix）
```
                       /dashboard 指令或状态查看
                                   │
              ┌────────────────────┴────────────────────┐
              │                                         │
    在 Herdr 环境运行 (HERDR_ENV=1)             非 Herdr 独立终端环境
              │                                         │
   支持 0.9.1 (placement: popup)?                       │
      ┌───────┴───────┐                                 │
     Yes              No (旧版 Herdr)                   │
      │               │                                 │
【Level 1: Popup 模式】 【Level 2: Tab 降级】       【Level 3: 本地 TUI 兜底】
- 80%×80% 会话模态浮窗  - plugin.pane.open (tab)  - 零 Socket 依赖，绝不抛错
- 不改变已有 Tab 与分屏 - 弹窗失败自动转新 Tab      - 从当前会话读取 Todos/写锁
- 按 q/Esc 优雅关闭退出  - 控制台提示 Tab 模式       - ctx.ui.notify 纯文本渲染
```

### 2.3 关键实现细节
1. **客户端适配 (`packages/pier-ext/src/herdr-client.ts`)**：
   - 扩展 `openPluginPane` 接口，支持传入 `placement: 'popup'`、`width`、`height`。
   - 捕获旧版 Herdr 返回的 `invalid_placement` 或 `unknown method`，自动降级为 `placement: 'tab'`。
   - 提供 `closePopup()`，安全处理 `popup_not_open`。
2. **仪表盘脚本优化 (`packages/pier-workbench/scripts/dashboard.mjs`)**：
   - 在交互式 TTY 下自动接管按键（Raw Mode），监听 `q` / `Q` / `Esc` / `Ctrl+C`，主动调用 `popup.close` 并优雅退出。
   - 在离线（无 `HERDR_SOCKET_PATH`）模式下，输出 Standalone 离线提示并安全退出（退出码 0）。
3. **Pi 命令扩展 (`packages/pier-ext/src/dashboard-command.ts`)**：
   - 注册 `/dashboard` 命令，实现上述三级自适应逻辑。

---

## 3. 方案 2：基于 `foreground_cwd` 的动态路径感知与 `agent.explain` 启动智能诊断

### 3.1 痛点与解决
1. **静态 `cwd` 造成的路径偏差与写锁穿透**：
   - 当前写锁系统（`lock-core.ts`）与子 Agent 列表（`subagent-list-action.ts`）依赖启动时的静态 `cwd`。当子 Agent 在命令中执行了 `cd sub-directory` 时，静态路径与 PTY 实际操作目录不符，可能导致文件规范化路径（`normalizeLockPath`）失真，引发锁冲突漏判。
   - **0.9.1 优化**：读取 Herdr 服务端在 `agent.list` 和 `pane.list` 中返回的真实 `foreground_cwd`（当前控制 PTY 的前台进程工作目录），动态校准锁路径与状态显示。
2. **子 Agent 就绪超时的“黑盒诊断”（A14 机制痛点）**：
   - 当后台子 Agent 启动超过阈值（如 90s）未进入就绪状态时，原逻辑只能判定为 `timeout` 并读取尾部杂乱文本。主模型无法得知 Herdr 内部为何未识别其状态。
   - **0.9.1 优化**：利用 `agent.explain` 查询服务端规则判决原因（`matched_rule`、`skip_state_reason`、`screen_detection_skip_reason` 等），生成白盒诊断报告并注入给主模型。

### 3.2 方案 2 详细设计规范

#### 1) 动态工作目录感知（`foreground_cwd`）
- **写锁守卫动态计算 (`packages/pier-ext/src/index-locks.ts`)**：
  在 `planWriteGuard` 收集各 Agent 持有的锁信息时，将每个 Agent 的 `foregroundCwd`（若存在）作为相对路径解析的基准目录，避免因子进程目录切换导致的路径偏差。
- **子 Agent 列表视图 (`packages/pier-ext/src/subagent-list-action.ts`)**：
  在 `subagent(action: "list")` 响应中，若子 Agent 的前台目录与其初始启动目录不一致，增加 `[cwd: <relative-or-basename>]` 标签，让主控模型和人类直观了解其实际执行位置。

#### 2) 智能诊断接入（`agent.explain` 与强化 A14）
- **就绪判定探针 (`packages/pier-ext/src/subagent-spawn.ts`)**：
  在 `waitSubReady` 判定为 `give-up` 之前，通过 `client.agentExplain(paneId)` 获取服务端诊断证据：
  ```typescript
  if (plan.kind === 'give-up') {
    let diagHint: string | null = null;
    if (h.client.available) {
      try {
        const diag = await h.client.agentExplain(paneId);
        if (diag) {
          const parts: string[] = [];
          if (diag.skip_state_reason) parts.push(`skip reason: ${diag.skip_state_reason}`);
          if (diag.screen_detection_skip_reason) parts.push(`screen rule bypassed: ${diag.screen_detection_skip_reason}`);
          if (diag.matched_rule) parts.push(`matched rule: ${diag.matched_rule}`);
          if (parts.length > 0) diagHint = `Herdr detection diagnosis: ${parts.join('; ')}`;
        }
      } catch {
        /* Best effort */
      }
    }
    const failure: ReadyFailure = {
      paneId,
      reason: plan.reason,
      lastStatus,
      tail,
      hint: diagHint ?? (lastStatus === 'working' ? 'Tip: pass run_in_background...' : null),
    };
    return { ok: false, failure, message: readyFailureText(failure) };
  }
  ```

### 3.3 方案 2 的 Fallback 降级设计

| 运行环境 | `foreground_cwd` 处理 | `agent.explain` 处理 |
|---|---|---|
| **Herdr ≥ 0.9.1** | 优先采用真实前台工作目录，精准规范化路径。 | 遇到超时或异常时返回完整判决链条与跳过原因。 |
| **Herdr < 0.9.1** | `foreground_cwd` 字段缺省，自动回退到初始 `cwd` / `process.cwd()`。 | 服务端返回不支持，`agentExplain` 捕获异常并返回 `null`，保持原有的 tail 输出机制。 |
| **非 Herdr 独立终端** | `client.available === false`，纯本地单进程，使用 `process.cwd()`。 | `NoopHerdrClient.agentExplain()` 直接返回 `null`，不发网络请求，无任何报错。 |

---

## 4. 方案 3：利用 `terminal_title_stripped` 优化终端标题与 Spinner 清洗

### 4.1 痛点与解决
- **原先问题**：
  在观察常驻终端（`terminal` 工具）及运维看板（Dashboard）时，各个 Pane 的标题通常携带动态 Spinner 字符、ANSI 颜色代码或处于缺省状态（仅能回退显示静态 `cwd`）。客户端本地维护的 `stripAnsi` 和各类过滤逻辑容易随不同工具的转义符变动而偶发截断或失真。
- **0.9.1 优化**：
  Herdr 0.9.1 服务端原生在 `PaneInfo` / `AgentInfo` 中清洗并剥离了 Spinner 与 ANSI 序列，生成干净的 `terminal_title_stripped`。
  1. 在 `pier-workbench` 的 `dashboard-model.ts` 中优先采用 `terminal_title_stripped` 展示非 pi 任务或 shell 的真实工作内容（如 `npm test --watch`）；
  2. 在 `pier-ext` 的 `terminal action: "list"` 中补充展示当前活跃终端的标题（`title="..."`）。

### 4.2 Fallback 路线
- **Herdr ≥ 0.9.1**：展示清洗后的终端标题；
- **旧版 Herdr / 非 Herdr**：字段缺省时优雅退回至原有的 `title` 或 `cwd`，保持原输出格式 100% 稳定。

---

## 5. 方案 4：基于 Herdr 0.9.1 事件流优化 Focus Heat 布局与自适应降低轮询开销

### 5.1 痛点与历史背景（D-4 决策回顾）
- **历史问题**：
  在 Herdr 0.9.0 早期版本中，客户端鼠标点击焦点是由客户端本地计算光标的，并未稳定向插件系统广播 `pane.focused` 事件。为了让工作台的“焦点热力布局”（点击哪个 Pane，哪个 Pane 自动放大占主导位）生效，`pier-ext` 为每个 pi 进程启动了 `focus-poller.ts`，以 **1.5 秒** 的高频轮询 `layout.export`，并在聚焦到自身时手动拉起 `heat-reflow.mjs`。
- **弊端**：
  多 Agent 并行运行时，每个进程每秒高频调用 Socket RPC，造成不必要的 CPU / I/O 消耗，且点击放大存在 0~1.5s 的感知迟滞。

### 5.2 0.9.1 优化实现
1. **Herdr 0.9.1 原生修复**：
   Herdr 0.9.1 规范了鼠标转义解码，并保证所有客户端手动窗格选择（鼠标/键盘）均会即时向 Socket API 派发权威的 `pane.focused` 事件。
2. **自适应事件优先（Adaptive Event-First Polling）**：
   - 当运行在 Herdr ≥ 0.9.1 环境下，`focus-poller` 的默认轮询周期由 **1500ms 大幅放宽至 8000ms**（仅作为防止极端丢包的低频兜底守卫），降幅超 80% 的空闲 Socket 调用。
   - 用户支持通过环境变量 `PIER_FOCUS_POLL_MS=0` 彻底关闭轮询，纯享 `<50ms` 的瞬时事件驱动热力响应。
   - 遇到 Herdr < 0.9.1 环境，自动平滑保持 1500ms 快速轮询，确保旧环境体验不倒退。

---

## 6. 后续方案规划

- **方案 5**：基于 `herdr --machine <id>` 探索跨物理机/跨云环境的远程 Agent 编排能力。

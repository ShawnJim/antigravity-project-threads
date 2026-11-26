# Antigravity Project Threads (`project-threads`)

在 **Antigravity 2.0 Desktop** 中复刻 **Claude Code Projects** 风格的持续项目总控与并发工作线程体系：将左侧主窗口锚定为常驻 **`[Coordinator]`** 总控会话，后台通过原生 `ConversationService` 并发派发物理隔离的 **Git Worktree**（或零拷贝只读）子线程，并在右侧 **Project Threads** 辅助面板实时监控与内联预览对话。

---

## 核心特性 (Highlights)

- **常驻总控会话 (`/coord`)**：
  - 左侧主画布始终保持 `[Coordinator] <项目名>` 上下文干净精炼，专注于需求拆解、架构决策、任务派发与结果验收。
  - 内置 `PreToolUse` 守护钩子与持久规则，防止总控会话误退化为普通单线程执行或临时 Subagent。
- **双模并发工作线程 (`dispatch_thread`)**：
  - **独立 Git Worktree 模式 (`createWorktree: true`)**：自动在 `../.worktrees/<repo>/<thread-slug>` 创建独立分支检出副本，支持多任务并行改代码互不污染。
  - **共享只读排查模式 (`createWorktree: false`)**：零磁盘拷贝直接在主仓库执行代码检索、日志分析与方案调研。
- **严格的工程 / 会话级隔离**：
  - 基于实时 `GetConversation` 元数据与 Git 主仓库根目录做 Fail-Closed 作用域判定，每个工程的工作线程列表、Coordinator 绑定与共享记忆完全独立，绝不跨项目串流。
- **异步后台感知与分段式完成回调**：
  - 自动识别仍在运行后台命令（`run_command` 异步任务）的线程，杜绝半途误报完成。
  - 基于内核级原子锁（`wx` claim lock）去重，子线程真正收尾后自动向 `[Coordinator]` 推送结构化分段完成卡片。
- **Swarm 风格实时监控看板 + 1:1 原生内联 `Preview` 抽屉**：
  - 对齐 Antigravity 内置 Swarm Overview 视觉体系（`--pt-*` 独立命名空间令牌、深浅色自适应、实时步骤环形进度条与流光状态展示）。
  - **点击卡片优先内联 `Preview`**：点击任意线程默认在右侧边栏滑出与主聊天窗 1:1 对齐的原生对话流（含 `Worked for Xm Ys` 折叠轨迹树、文件行号胶囊跳转、步骤清单卡片与青绿流光输入框），不切走左侧主窗口；同时保留 **`Open ↗`** 一键切至主窗及常驻 **`Coordinator`** 快速返回入口。
- **共享项目记忆 (`project-memory.md`) 与多语言同步**：
  - 主仓库 `.agents/rules/project-memory.md` 自动同步至各活跃 Worktree；界面自动跟随 Antigravity 全局语言配置切换 `简体中文 / 繁體中文 / English`。

---

## 安装方法 (Installation)

> **零外部依赖**：完全基于 Antigravity 2.0 内置 Node.js 运行时构建，**无需执行 `npm install`**。

### Windows (PowerShell)

```powershell
New-Item -ItemType Directory -Force "$HOME\.gemini\config\plugins" | Out-Null
git clone https://github.com/ShawnJim/antigravity-project-threads.git "$HOME\.gemini\config\plugins\project-threads"
```

### macOS / Linux

```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/ShawnJim/antigravity-project-threads.git ~/.gemini/config/plugins/project-threads
```

### 启用与使用

1. 打开 **Antigravity 2.0** 桌面端，进入 **Customizations → Plugins**，确认 **Project Threads** 处于开启状态（更新插件代码后可 **关 → 开** 一次触发热重载）。
2. 在主对话中输入 `/coord` 将当前会话绑定为项目总控协调器。
3. 点击右上角边栏 **`+`** 选择 **Project Threads** 打开实时线程看板：
   - 点击任意线程卡片或列表行在右侧内联打开 **`Preview`** 对话抽屉（可直接追问或纠偏该线程）；
   - 点击 **`Open ↗`** 可将该线程弹出至左侧主窗口，随时点击面板顶部 **`Coordinator`** 按钮一键切回总控会话。

---

## 目录结构

```text
project-threads/
├── plugin.json                 # Antigravity 2.0 插件清单
├── mcp_config.json             # Coordinator MCP 工具服务声明
├── hooks.json                  # PreInvocation / PreToolUse / Stop 生命周期钩子
├── assets/
│   └── logo.svg
├── rules/
│   └── AGENTS.md               # Coordinator 与 Worktree 隔离规则
├── skills/
│   └── coord/
│       └── SKILL.md            # /coord 技能工作流指引
├── mcp/
│   └── server.mjs              # Stdio MCP Server (7 个总控编排工具)
├── scripts/
│   └── hook-handler.mjs        # 完成状态提取、原子去重推送与指令续期
├── lib/
│   ├── ls-client.mjs           # 本地 ConversationService HTTP+JSON 客户端
│   ├── store.mjs               # 工程隔离注册表、Git Worktree 与记忆同步引擎
│   └── transcript.mjs          # 会话日志解析、异步任务检测与原生步骤树聚合
└── sidecars/
    └── threads/
        ├── sidecar.json        # Auxiliary Pane Sidecar 视图配置
        ├── package.json
        ├── main.mjs            # 本地 API 服务与无缓存静态资源路由
        ├── index.html          # Swarm 风格看板与内联聊天抽屉骨架
        ├── theme.css           # --pt-* 独立命名空间样式表（深浅色主题）
        └── app.js              # 实时轮询、Preview 抽屉渲染与三语国际化
```

---

## License

[MIT License](./LICENSE) © 2026 [ShawnJim](https://github.com/ShawnJim)

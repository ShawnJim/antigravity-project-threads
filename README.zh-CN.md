<div align="center">
  <img src="./assets/logo.svg" width="96" height="96" alt="Project Threads Logo" />

  <h1>Antigravity Project Threads</h1>

  <p>
    为 <strong>Antigravity 2.0 Desktop</strong> 打造的 Claude Code Projects 风格常驻项目总控与并发隔离工作线程体系。
  </p>

  <p>
    <img src="https://img.shields.io/badge/version-v1.2.0--rc.1-38BDF8?style=flat-square" alt="Version v1.2.0-rc.1" />
    <img src="https://img.shields.io/badge/dependencies-零依赖%20(Node.js%20ESM)-34D399?style=flat-square" alt="零依赖" />
    <img src="https://img.shields.io/badge/platform-Antigravity%202.0-818CF8?style=flat-square" alt="Antigravity 2.0" />
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-C084FC?style=flat-square" alt="MIT License" /></a>
  </p>

  <p>
    <a href="./README.md">English</a> | <strong>简体中文</strong> | <a href="./README.zh-TW.md">繁體中文</a>
  </p>
</div>

---

**Antigravity Project Threads**（`project-threads`）在 **Antigravity 2.0 Desktop** 中复刻 **Claude Code Projects** 风格的持续项目总控与并发工作线程体系：将左侧主窗口锚定为常驻 **`[Coordinator]`** 总控会话，后台通过原生 `ConversationService` 并发派发物理隔离的 **Git Worktree**（或零拷贝只读）子线程，并在右侧 **Project Threads** 辅助面板一站式管理实时线程、**待决策（Pending Decisions）**、内联 **`Preview`** 对话、一键切换总控与插件更新。

## 核心特性

- **常驻总控会话（`/coord`）、一键换绑与旧总控保护**：
  - 左侧主画布始终保持 `[Coordinator] <项目名>` 上下文精炼聚焦，专注于需求拆解、架构决策、任务派发与结果验收，由 `PreInvocation` / `PreToolUse` / `Stop` 钩子与 `v14` 常驻协议守护。
  - **一键切换 / 换绑总控**：直接在看板项目卡片通过 **`切换总控`** / **`换绑当前`** 选择当前主窗口会话、本项目其他会话或手动输入会话 UUID 完成换绑。本项目未归档的活跃子线程与显式待决策会自动改绑回调至新总控（不会触发历史空闲线程的旧回调雪崩）；已退场旧总控会收到退场提示并拦截过期单线程写操作，避免误触发干扰。
  - **按模式区分的归档策略**：只读排查类线程（`createWorktree: false`）完成汇报后可由总控自主归档；Worktree 代码开发线程（`createWorktree: true`）在合入后仍先保留以供验收与追问，待用户确认验收通过后自动调用 `archive_thread` 归档，并同时识别常规合并与 `cherry-pick` 合入以安全清理干净的 Worktree 与分支。
- **右侧「待决策（Pending Decisions）」看板（`manage_decisions`）**：
  - 置顶展示于右侧 **Project Threads** 面板顶部，确保需要你拍板的事项不会被聊天流淹没。
  - **显式决策卡片**：总控在提出方案选择、分支合入、发版或清理建议时调用 `manage_decisions` 登记卡片，附带 1–3 个快捷操作按钮（`send_coordinator` 一键回传总控、`archive_thread` 或 `dismiss`）；若你直接在聊天框回复决策，总控也会自动调用 `resolve` 清除卡片。
  - **Worktree 自动提示卡片**：自动识别存在已提交未合入代码的分支（分支已就绪，待合入）以及已合入 / 已 `cherry-pick` 合入的分支（待验收归档），并与同线程显式决策自动去重。
- **双模并发工作线程（`dispatch_thread`）与语言跟随**：
  - **独立 Git Worktree 模式（`createWorktree: true`）**：自动在 `../.worktrees/<repo>/<thread-slug>` 创建独立分支检出副本，支持多任务并行改代码互不污染。
  - **共享只读排查模式（`createWorktree: false`）**：零磁盘拷贝直接在主仓库执行代码检索、日志分析与方案调研。
  - **自动跟随用户语言**：派发标题、任务提示词以及子线程分析与总结均自动跟随用户当前会话语言。
- **Fail-Closed 作用域隔离、项目内序号 `#N` 与异步后台感知**：
  - 基于实时 `GetConversation` 元数据与 Git 主仓库根目录执行 Fail-Closed 作用域判定，每个工程的线程列表、总控绑定、待决策与共享记忆完全独立；单线程 MCP 工具默认强制校验作用域参数（`coordinatorId` / `workspacePath`）。
  - **项目内展示序号（`#N`）**：保留全局唯一主键 `thr-xxx` 与 Worktree/分支命名的同时，为每个项目独立维护连续的 `#1`、`#2`、`#3`… 展示序号，消除跨项目跳号困扰，并支持在带作用域的 MCP 调用中使用 `#N` 检索。
  - 自动识别仍在运行后台命令（`run_command` 异步任务）的线程，杜绝半途误报完成；基于内核级原子锁（`wx` claim lock）去重，确保子线程真正收尾后向 `[Coordinator]` 推送结构化完成卡片。
- **两级模型 + 思考档位选择器、`inherit` 模式与遥测**：
  - 在 Sidecar 设置页与内联对话抽屉中提供 **两级模型家族 + 思考档位悬浮选择器**，支持线程中途无缝切模型，并对 **`Extra High`** 等高档位标签做全链路一致归一化。
  - 支持全局及项目级默认模型配置（分别设置 Worktree 代码线程与只读排查线程），原生支持 **`inherit`（跟随主会话模型）**，派发时自动解析总控最近一次已执行回合使用的模型。
  - 在线程看板实时展示每个线程的 **Token 消耗汇总**、**压缩线进度** 与 **压缩次数统计**，复用现有模型元数据轮询通道并支持带缓存的离线日志回退，零额外 RPC 开销。
- **Swarm 风格实时看板、真实项目名与 1:1 原生内联 `Preview` 抽屉**：
  - 对齐 Antigravity 内置 Swarm Overview 视觉体系（`--pt-*` 独立命名空间令牌、深浅色自适应、通过 `ReadProject` 优先展示真实 Antigravity 项目名、实时步骤环形进度条），并智能控制「回到总控」按钮显隐（已在总控页自动隐藏，离开总控时保持单一清晰入口）。
  - **点击卡片优先内联 `Preview`**：点击任意线程默认在右侧边栏滑出与主聊天窗 1:1 对齐的原生对话流（含 `Worked for Xm Ys` 折叠轨迹树、文件行号胶囊跳转、步骤清单卡片、模型切换器与流光输入框），不切走左侧主窗口；同时保留 **`Open ↗`** 一键弹出至主窗口。
- **双渠道插件检查与安全本地更新器**：
  - Sidecar **设置** 内置 **版本与更新** 卡片，检测到新版本时顶栏设置齿轮自动亮起红点提示。
  - 支持在 **`stable`**（跟踪 `origin/main` 与 `vX.Y.Z` / `stable` 正式版）与 **`dev`**（跟踪 `origin/dev` 先行版）双渠道间切换；一键更新严格校验本地工作区干净并仅执行 `--ff-only` 快进更新（存在未提交改动时自动拦截，绝不执行 `git reset --hard`）；非 Git 安装则安全引导前往 GitHub Releases；内置前后端版本漂移检测与请求超时保护，后端滞后时给出明确重载提示。
- **共享项目记忆（`project-memory.md`）与三语同步**：
  - 主仓库 `.agents/rules/project-memory.md`（内置默认 Worktree 合并与归档规范）自动同步至各活跃 Worktree（通过 `.git/info/exclude` 排除提交）；界面自动跟随 Antigravity 全局语言配置切换 `English / 简体中文 / 繁體中文`。

## MCP 总控工具（8 个）

本地 stdio MCP 服务（`mcp/server.mjs`，服务名 `project-threads_coordinator`）共提供 8 个总控编排工具：

| 工具名 | 作用说明 |
| --- | --- |
| `init_project_coordinator` | 将当前会话初始化并绑定为 `[Coordinator]`，注册生命周期钩子，确保 `.agents/rules/project-memory.md` 存在并写入默认合并归档约定。 |
| `dispatch_thread` | 通过 `ConversationService` 后台派发独立 Git Worktree（`createWorktree: true`）或零拷贝只读（`createWorktree: false`）工作线程。 |
| `list_threads` | 按项目作用域同步并列出活跃（或已归档）线程，展示 `#N` / `thr-xxx` 编号、实时 `runState`、Git 分支状态与最新摘要。 |
| `get_thread_detail` | 仅局部刷新并查询单个线程的完整元数据、Git 状态与最新总结，支持 `thr-xxx`、项目内 `#N` 或会话 UUID。 |
| `send_thread_message` | 在不切走左侧总控会话的前提下，向既有工作线程后台发送追问、纠偏或补充指令。 |
| `archive_thread` | 归档已完成或废弃的线程，并在工作区干净且已合并（含 `cherry-pick` 等价提交）时安全移除其 Git Worktree 与分支。 |
| `update_project_memory` | 读取、追加或重写 `.agents/rules/project-memory.md`，并自动向本项目下所有活跃 Worktree 广播同步。 |
| `manage_decisions` | 登记（`add`）、列出（`list`）、解决（`resolve`）或忽略（`dismiss`）置顶于右侧看板的 **待决策** 卡片及 1–3 个快捷按钮。 |

> **`v14` 协议单项目 Fail-Closed 隔离与 `#N` 序号**：`get_thread_detail`、`send_thread_message`、`archive_thread` 默认开启 fail-closed 跨项目拦截，必须传入项目作用域参数（`coordinatorId` / `workspacePath` / `projectId`）；仅在显式传入 `scope: "*"` 时才允许无作用域的全局 `thr-xxx` 访问。按项目内展示序号检索（`#1`、`#2`…）须带前导 `#` 并提供项目作用域。

## 安装方法

> **零外部依赖**：完全基于 Antigravity 2.0 内置 Node.js ESM 运行时构建，**无需执行 `npm install`**。

### 稳定版安装（推荐 — `main` 分支）

`main` 分支始终与最新正式稳定版（`vX.Y.Z` / `stable` 标签）保持一致，适合日常稳定使用。

#### Windows (PowerShell)

```powershell
New-Item -ItemType Directory -Force "$HOME\.gemini\config\plugins" | Out-Null
git clone https://github.com/agy-plugins/project-threads.git "$HOME\.gemini\config\plugins\project-threads"
```

#### macOS / Linux

```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/agy-plugins/project-threads.git ~/.gemini/config/plugins/project-threads
```

### 开发版 / 先行版安装（`dev` 分支 / `rc` 标签）

日常新功能开发与先行版（`vX.Y.Z-rc.N`）发布在 `dev` 分支，不会影响 `main` 与 `stable` 稳定标签。除命令行克隆/切分支外，干净的 Git 安装也可直接在 Sidecar **设置 → 版本与更新** 中一键切换 **`stable`** / **`dev`** 渠道：

```bash
# 直接克隆 dev 分支
git clone -b dev https://github.com/agy-plugins/project-threads.git ~/.gemini/config/plugins/project-threads

# 或将已有安装切换至 dev 分支
cd ~/.gemini/config/plugins/project-threads
git fetch origin && git checkout dev && git pull
```

### 启用与使用

1. 打开 **Antigravity 2.0** 桌面端，进入 **Customizations → Plugins**，确认 **Project Threads** 处于开启状态（更新插件代码后可 **关 → 开** 一次或重载窗口生效）。
2. 在主对话中输入 `/coord` 将当前会话绑定为项目总控协调器。
3. 点击右上角边栏 **`+`** 选择 **Project Threads** 打开实时线程看板：
   - 在看板顶部 **待决策** 区域一键处理方案选择、分支合入或验收归档提示；
   - 点击任意线程卡片或列表行在右侧内联打开 **`Preview`** 对话抽屉（可直接追问、纠偏或切换该线程模型）；
   - 点击 **`Open ↗`** 将线程弹出至主窗口，离开总控时可一键切回，或点击 **`切换总控`** / **`换绑当前`** 更换当前项目的总控会话；
   - 点击右上角 **设置** 齿轮可配置全局/项目默认模型（`inherit` 或具体模型 + 档位）并执行双渠道插件更新。

## 目录结构

```text
project-threads/
├── plugin.json                 # Antigravity 2.0 插件清单
├── mcp_config.json             # Coordinator MCP 工具服务声明
├── hooks.json                  # PreInvocation / PreToolUse / Stop 生命周期钩子
├── assets/
│   └── logo.svg                # 矢量插件与仓库 Logo
├── rules/
│   └── AGENTS.md               # Coordinator 与 Worktree 隔离规则
├── skills/
│   └── coord/
│       └── SKILL.md            # /coord 技能工作流指引
├── mcp/
│   └── server.mjs              # Stdio MCP Server（8 个总控编排工具）
├── scripts/
│   └── hook-handler.mjs        # 完成状态提取、原子去重、旧总控退场保护与 v14 指令续期
├── lib/
│   ├── ls-client.mjs           # 本地 ConversationService / LanguageServerService 客户端
│   ├── model-format.mjs        # 两级模型目录、思考档位格式化与 inherit 解析
│   ├── store.mjs               # 工程隔离注册表、#N 序号、待决策、总控换绑与 Worktree 同步
│   ├── transcript.mjs          # 会话日志解析、异步任务检测与 Token/压缩遥测
│   └── updater.mjs             # 双渠道插件版本检查与安全快进本地更新器
├── sidecars/
│   └── threads/
│       ├── sidecar.json        # Auxiliary Pane Sidecar 视图配置
│       ├── package.json
│       ├── main.mjs            # 本地 API 服务、版本漂移检测与无缓存静态资源路由
│       ├── index.html          # Swarm 风格看板、待决策区、设置页与内联聊天抽屉骨架
│       ├── theme.css           # --pt-* 独立命名空间样式表（深浅色主题）
│       └── app.js              # 实时轮询、待决策、换绑、Preview 抽屉、模型选择器、更新器与三语国际化
└── tests/
    └── *.test.mjs              # 零依赖 Node.js 自动化测试套件
```

## 运行测试

```bash
node --test tests/*.test.mjs
```

## 友情链接

友情链接：[LINUX DO - 新的理想型社区](https://linux.do)

## License

[MIT License](./LICENSE) © 2026 [ShawnJim](https://github.com/ShawnJim)

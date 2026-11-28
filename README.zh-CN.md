<div align="center">
  <img src="./assets/logo.svg" width="96" height="96" alt="Project Threads Logo" />

  <h1>Antigravity Project Threads</h1>

  <p>
    管理你的注意力，让 <strong>Antigravity 2.0 Desktop</strong> 的多 Agent 并行开发井然有序。
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

## 核心亮点

| 亮点 | 带来的体验 |
| --- | --- |
| 🧭 **主控专注决策** | 主窗常驻总控专攻拆解与拍板，远离检索日志刷屏。 |
| 🌿 **隔离并行执行** | 写代码自动隔离 Worktree，查代码零拷贝互不冲突。 |
| 📥 **待决策一键收口** | 完工自动汇总，选择、合并与归档置顶一键响应。 |
| 👀 **右侧内联预览** | 侧栏直接 1:1 追问、看进度与切模型，无需切离主窗。 |
| 🧠 **隔离与共享记忆** | 多工程独立 `#N` 编号防串线，项目规范自动同步。 |
| 🔄 **换绑与安全更新** | 一键换绑总控，内置稳定版与开发版双渠道安全升级。 |

## 核心工作流

<p align="center">
  <img src="./assets/workflow-zh-CN-light.svg#gh-light-mode-only" width="100%" alt="Antigravity Project Threads 核心工作流" />
  <img src="./assets/workflow-zh-CN-dark.svg#gh-dark-mode-only" width="100%" alt="Antigravity Project Threads 核心工作流" />
</p>
<p align="center"><sub>你只管拍板，总控拆解派发，后台线程并行执行，结果自动回流看板一键处理。</sub></p>

## 快速开始

> 零外部依赖，直接基于 Antigravity 2.0 内置 Node.js ESM 运行，无需 `npm install`。

```bash
# macOS / Linux（稳定版 main 分支）
mkdir -p ~/.gemini/config/plugins && git clone https://github.com/agy-plugins/project-threads.git ~/.gemini/config/plugins/project-threads
```

```powershell
# Windows PowerShell（稳定版 main 分支）
New-Item -ItemType Directory -Force "$HOME\.gemini\config\plugins" | Out-Null; git clone https://github.com/agy-plugins/project-threads.git "$HOME\.gemini\config\plugins\project-threads"
```

| 1️⃣ 启用插件 | 2️⃣ 固定总控 | 3️⃣ 打开看板 |
| :---: | :---: | :---: |
| 在 **Customizations → Plugins** 中启用 **Project Threads**。 | 在主对话输入 `/coord`，固定为常驻项目总控。 | 点击右上角边栏 **`+`**，查看进度、内联预览并处理待决策。 |

<details>
<summary><strong>MCP 工具与底层机制（开发者参考）</strong></summary>

### MCP 总控工具（`project-threads_coordinator`，8 个）

| 工具名 | 作用说明 |
| --- | --- |
| `init_project_coordinator` | 将当前会话绑定为 `[Coordinator]`，注册生命周期钩子并初始化 `.agents/rules/project-memory.md`。 |
| `dispatch_thread` | 通过 `ConversationService` 后台派发独立 Git Worktree（`createWorktree: true`）或零拷贝只读（`createWorktree: false`）线程。 |
| `list_threads` | 按项目作用域同步并列出活跃或已归档线程，展示 `#N` / `thr-xxx`、实时 `runState`、Git 状态与最新摘要。 |
| `get_thread_detail` | 仅局部刷新并查询单个线程的元数据、Git 状态与总结，支持 `thr-xxx`、项目内 `#N` 或会话 UUID。 |
| `send_thread_message` | 不切走左侧总控会话，向既有工作线程后台发送追问、纠偏或补充指令。 |
| `archive_thread` | 归档已完成或废弃的线程，并在工作区干净且已合并（含 `cherry-pick` 等价提交）时安全移除 Worktree 与分支。 |
| `update_project_memory` | 读取、追加或重写 `.agents/rules/project-memory.md`，并向本项目下所有活跃 Worktree 自动广播同步。 |
| `manage_decisions` | 登记（`add`）、列出（`list`）、解决（`resolve`）或忽略（`dismiss`）置顶于右侧看板的 **待决策** 卡片与 1–3 个快捷按钮。 |

### 核心机制与工程约定

- **`v14` 协议与总控换绑**：由 `PreInvocation` / `PreToolUse` / `Stop` 钩子守护；看板 **`切换总控`** / **`换绑当前`** 平滑迁移本项目活跃线程与显式待决策（避免触发历史空闲线程回调雪崩），退场旧总控收到提示并拦截过期单线程写操作。
- **按模式归档与待决策去重**：只读线程汇报后可自主归档；Worktree 代码线程（位于 `../.worktrees/<repo>/<thread-slug>`）保留至用户验收通过后自动归档，并兼容常规合并与 `cherry-pick` 清理。显式决策支持 `send_coordinator` / `archive_thread` / `dismiss` 快捷按钮，并与 Worktree 自动合并/归档提示按线程去重。
- **Fail-Closed 隔离与异步后台感知**：基于实时 `GetConversation` 元数据与 Git 主仓库根执行跨项目隔离；`get_thread_detail`、`send_thread_message`、`archive_thread` 默认强制校验作用域（`coordinatorId` / `workspacePath` / `projectId`），除非显式传 `scope: "*"`；项目内 `#N` 检索须带前导 `#`。自动识别运行中的异步 `run_command` 任务，并经原子锁（`wx`）去重推送完成卡片。
- **模型选择、遥测与原生预览**：两级模型家族 + 思考档位悬浮选择器，支持线程中途切模型、`Extra High` 全链路归一化、按模式配置默认模型与原生 **`inherit`（跟随总控）**；零额外 RPC 展示 Token 总量、压缩线进度与压缩次数（带缓存离线日志回退）。Swarm 风格看板采用 `--pt-*` 独立令牌、`ReadProject` 真实项目名、1:1 内联 **`Preview`** 抽屉与 **`Open ↗`** 弹出，界面自动跟随 `English / 简体中文 / 繁體中文`。
- **双渠道安全更新器**：可在 Sidecar **设置 → 版本与更新** 中切换 **`stable`**（`origin/main` / `vX.Y.Z`）与 **`dev`**（`origin/dev` 先行版）；Git 一键更新强制校验干净工作区并仅执行 `--ff-only` 快进（绝不执行 `git reset --hard`），非 Git 安装安全跳转 Releases，并内置版本漂移检测与请求超时保护。

</details>

<details>
<summary><strong>开发版安装、目录结构与测试</strong></summary>

### 开发版 / 先行版渠道（`dev`）

干净的 Git 安装可直接在 Sidecar **设置 → 版本与更新** 中切换 **`stable`** / **`dev`**，也可使用命令行：

```bash
# 直接克隆 dev 分支
git clone -b dev https://github.com/agy-plugins/project-threads.git ~/.gemini/config/plugins/project-threads

# 或将已有安装切换至 dev 分支
cd ~/.gemini/config/plugins/project-threads && git fetch origin && git checkout dev && git pull
```

### 目录结构

```text
project-threads/
├── plugin.json                 # Antigravity 2.0 插件清单
├── mcp_config.json             # Coordinator MCP 工具服务声明
├── hooks.json                  # PreInvocation / PreToolUse / Stop 生命周期钩子
├── assets/logo.svg             # 矢量插件与仓库 Logo
├── rules/AGENTS.md             # Coordinator 与 Worktree 隔离规则
├── skills/coord/SKILL.md       # /coord 技能工作流指引
├── mcp/server.mjs              # Stdio MCP Server（8 个总控编排工具）
├── scripts/hook-handler.mjs    # 完成提取、原子去重、旧总控保护与 v14 指令续期
├── lib/
│   ├── ls-client.mjs           # 本地 ConversationService / LanguageServerService 客户端
│   ├── model-format.mjs        # 两级模型目录、思考档位格式化与 inherit 解析
│   ├── store.mjs               # 工程隔离注册表、#N 序号、待决策、换绑与 Worktree 同步
│   ├── transcript.mjs          # 会话日志解析、异步任务检测与 Token/压缩遥测
│   └── updater.mjs             # 双渠道插件版本检查与安全快进本地更新器
├── sidecars/threads/
│   ├── sidecar.json            # Auxiliary Pane Sidecar 视图配置
│   ├── package.json
│   ├── main.mjs                # 本地 API 服务、版本漂移检测与无缓存静态资源路由
│   ├── index.html              # Swarm 风格看板、待决策区、设置页与内联聊天抽屉
│   ├── theme.css               # --pt-* 独立命名空间样式表（深浅色主题）
│   └── app.js                  # 实时轮询、待决策、换绑、Preview、模型选择器、更新器与三语
└── tests/*.test.mjs            # 零依赖 Node.js 自动化测试套件
```

### 运行测试

```bash
node --test tests/*.test.mjs
```

</details>

---

友情链接：[LINUX DO - 新的理想型社区](https://linux.do) | 开源协议：[MIT License](./LICENSE) © 2026 [ShawnJim](https://github.com/ShawnJim)

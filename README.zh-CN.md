<div align="center">
  <img src="./assets/logo.svg" width="96" height="96" alt="Project Threads Logo" />

  <h1>Antigravity Project Threads</h1>

  <p>
    <strong>把注意力留给决策，让多 Agent 并行井然有序。</strong><br />
    专为 <strong>Antigravity 2.0 Desktop</strong> 打造的注意力管理与并行工程插件：一个常驻聚焦的项目总控，搭配多条物理隔离的后台工作线程。
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

同时驱动多个 AI Agent 开发，不该让你沦为疲于奔命的“切窗调度员”。**Antigravity Project Threads**（`project-threads`）为 **Antigravity 2.0 Desktop** 打造**注意力优先的并行开发指挥台**：左侧主窗口始终锚定清醒的 **`[Coordinator]`** 总控专攻拆解与拍板，编码与排查由原生 `ConversationService` 派发至后台隔离线程，所有完成摘要、**待决策**与内联 **`Preview`** 统一收口于右侧看板——把上下文切换从人脑卸载出去。

## 为什么是 Project Threads：把注意力还给决策

| 并行开发痛点 | Project Threads 的解法 |
| --- | --- |
| 主会话被检索日志和长报错淹没 | 左侧 `[Coordinator]` 始终保持高信噪比，只聚焦架构权衡、任务拆解与验收拍板。 |
| 多任务并行改代码频繁互相踩踏 | 修改代码自动隔离在独立 Git Worktree，只读排查零拷贝直连主仓库，互不冲突。 |
| 反复切窗巡检进度、漏看关键确认 | 子线程收尾自动回传结构化总结；方案选择、分支合入与归档统一置顶收口至 **待决策** 队列，一键响应。 |
| 临时追问或切换模型打断主线心流 | 点击线程卡即可在右侧展开 1:1 内联 **`Preview`** 抽屉，不离开主窗口就能追问、纠偏或换模型。 |

## 核心能力一览

| 能力模块 | 核心体验 | 关键机制与细节 |
| --- | --- | --- |
| **常驻总控与换绑（`/coord`）** | 主窗口长驻总控专攻决策，支持一键换绑与按模式自动归档 | 由 `PreInvocation` / `PreToolUse` / `Stop` 钩子与 `v14` 协议守护；看板 **`切换总控`** / **`换绑当前`** 平滑迁移活跃线程与显式待决策（防历史空闲回调雪崩），旧总控收到退场提示并拦截过期写操作；只读线程汇报后可自主归档，Worktree 线程待用户验收通过后自动归档，并兼容常规合并与 `cherry-pick` 清理。 |
| **待决策看板（`manage_decisions`）** | 需人拍板的事项置顶收口，告别翻聊天记录找待办 | 总控登记显式决策卡片并附带 1–3 个快捷按钮（`send_coordinator` / `archive_thread` / `dismiss`），聊天直接回复后自动 `resolve`；自动检测已提交待合入与已合入/`cherry-pick` 的 Worktree 分支提示，并与同线程显式决策去重。 |
| **双模并发线程（`dispatch_thread`）** | 多任务并发无工作区冲突，全链路自动跟随你的语言 | `createWorktree: true` 自动在 `../.worktrees/<repo>/<thread-slug>` 创建独立分支检出；`createWorktree: false` 零拷贝直连主仓库只读排查；标题、任务提示词、分析与总结均自动跟随当前会话语言。 |
| **Fail-Closed 隔离与异步感知** | 多工程严格隔离、编号直观连续，杜绝半途误报完成 | 基于实时 `GetConversation` 元数据与 Git 主仓库根执行 Fail-Closed 作用域判定，单线程 MCP 默认强校验作用域；保留 `thr-xxx` 全局主键并维护项目内连续 `#1`、`#2`… 序号（支持带作用域 `#N` 检索）；识别异步 `run_command` 后台任务并用原子锁（`wx`）去重推送完成卡片。 |
| **模型选择、`inherit` 与遥测** | 按任务精细配置模型与思考深度，实时掌控上下文消耗 | 设置页与内联抽屉提供两级模型家族 + 思考档位悬浮选择器，支持中途切模型与 **`Extra High`** 全链路归一化；可分别配置全局/项目级 Worktree 与只读默认模型，原生支持 **`inherit`（跟随总控最近执行模型）**；零额外 RPC 展示总 Token、压缩线进度与压缩次数（支持带缓存离线日志回退）。 |
| **Swarm 看板与 1:1 内联 `Preview`** | 对齐原生视觉体验，不切主窗口即可随时查看与介入 | `--pt-*` 独立设计令牌、深浅色自适应、`ReadProject` 真实项目名、实时步骤环与自适应「回到总控」按钮；点击卡片默认在侧栏打开 1:1 内联 **`Preview`** 抽屉（折叠轨迹树、文件行号胶囊、步骤清单与输入框），同时保留 **`Open ↗`** 弹出至主窗口。 |
| **双渠道检查与安全更新器** | 自由切换 `stable` / `dev` 渠道，一键升级绝不伤本地改动 | 设置页内置 **版本与更新** 卡片与顶栏红点提示；Git 一键更新严格校验本地工作区干净并仅执行 `--ff-only` 快进（绝不执行 `git reset --hard`）；非 Git 安装安全跳转 Releases；内置前后端版本漂移检测与请求超时保护。 |
| **共享项目记忆与三语同步** | 架构约定自动触达每个子线程，界面无缝匹配系统语言 | 主仓库 `.agents/rules/project-memory.md`（内置默认合并归档规范）自动广播至所有活跃 Worktree 并经 `.git/info/exclude` 排除提交；界面自动跟随 Antigravity 全局语言切换 `English / 简体中文 / 繁體中文`。 |

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

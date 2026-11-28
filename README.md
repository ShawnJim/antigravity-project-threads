<div align="center">
  <img src="./assets/logo.svg" width="96" height="96" alt="Project Threads Logo" />

  <h1>Antigravity Project Threads</h1>

  <p>
    <strong>Protect your focus. Scale your output.</strong><br />
    The attention-first parallel engineering workspace for <strong>Antigravity 2.0 Desktop</strong>: one calm Coordinator for your decisions, isolated background Worker Threads for everything else.
  </p>

  <p>
    <img src="https://img.shields.io/badge/version-v1.2.0--rc.1-38BDF8?style=flat-square" alt="Version v1.2.0-rc.1" />
    <img src="https://img.shields.io/badge/dependencies-zero%20(Node.js%20ESM)-34D399?style=flat-square" alt="Zero Dependencies" />
    <img src="https://img.shields.io/badge/platform-Antigravity%202.0-818CF8?style=flat-square" alt="Antigravity 2.0" />
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-C084FC?style=flat-square" alt="MIT License" /></a>
  </p>

  <p>
    <strong>English</strong> | <a href="./README.zh-CN.md">简体中文</a> | <a href="./README.zh-TW.md">繁體中文</a>
  </p>
</div>

---

Running multiple AI agents in parallel shouldn't turn you into a full-time tab switcher. **Antigravity Project Threads** (`project-threads`) turns **Antigravity 2.0 Desktop** into an **attention-first parallel engineering workspace**: pin your main window as a calm **`[Coordinator]`** for scoping and judgment, dispatch isolated background threads via native `ConversationService`, and let structured summaries, **Pending Decisions**, and inline **`Preview`** chats converge in one right-hand sidecar board.

## Why Project Threads?

| Parallel AI Pain | How Project Threads Solves It |
| --- | --- |
| Main chat drowns in grep noise and build logs | `[Coordinator]` stays clean and high-signal for architecture tradeoffs, delegation, and review. |
| Concurrent code edits collide on the same branch | Code threads run in isolated Git Worktrees while research threads read zero-copy—zero working-tree conflicts. |
| Constant tab-switching to check progress or catch blockers | Finished threads push structured summaries back automatically; choices, merges, and sign-offs surface in the pinned **Pending Decisions** queue for one-click action. |
| Quick follow-ups or model switches break your flow | Click any thread card to open a 1:1 inline **`Preview`** drawer beside your Coordinator—steer workers or switch models without leaving your seat. |

## Core Capabilities

| Capability | What You Get | Key Mechanics |
| --- | --- | --- |
| **Persistent Coordinator & Rebinding (`/coord`)** | One calm decision center with seamless handoff and mode-aware archiving | Guarded by `PreInvocation` / `PreToolUse` / `Stop` hooks and protocol `v14`. **`Switch`** / **`Switch to This`** migrates active threads and pending explicit decisions without replaying stale idle callbacks, while retired sessions get a retired notice and write guard. Read-only threads archive autonomously after reporting; Worktree threads stay open until user acceptance and recognize both standard merges and `cherry-pick` commits before cleanup. |
| **Pending Decisions Board (`manage_decisions`)** | Actionable decisions pinned at the top of the board, never buried in chat | Explicit cards registered via `manage_decisions` include 1–3 quick actions (`send_coordinator`, `archive_thread`, `dismiss`) and auto-clear via `resolve` when answered in chat. Automatic Worktree hints detect ready-to-merge and already-merged / cherry-picked branches, deduplicated per thread. |
| **Dual-Mode Worker Threads (`dispatch_thread`)** | Conflict-free parallel execution that matches your active language | `createWorktree: true` provisions isolated branches under `../.worktrees/<repo>/<thread-slug>`; `createWorktree: false` runs zero-copy read-only investigations directly on the repo. Titles, task prompts, analysis, and final summaries automatically follow your conversation language. |
| **Fail-Closed Isolation & Async Awareness** | Strict per-project boundaries, clean local numbering, and reliable completion signals | Live `GetConversation` metadata and Git repo-root scoping isolate threads, bindings, decisions, and memory per project; single-thread MCP calls enforce scope by default. Tracks per-project `#1`, `#2`, … sequences alongside global `thr-xxx` IDs. Detects active background `run_command` tasks and uses atomic `wx` claim locks to deduplicate completion cards. |
| **Model Picker, `inherit` & Telemetry** | Right model and reasoning effort per thread, plus real-time context visibility | Two-tier model family + thinking effort selector in Settings and inline composer, with mid-thread switching and unified **`Extra High`** normalization. Separate global/project defaults for Worktree and Read-Only threads with first-class **`inherit` (Follow Coordinator)**. Zero extra RPC cost for per-thread total tokens, compaction progress, and compaction count (with cached offline transcript fallback). |
| **Swarm Board & 1:1 Inline `Preview`** | Native Antigravity aesthetics and zero-context-switch inspection | `--pt-*` scoped design tokens, automatic light/dark theming, real Antigravity project names via `ReadProject`, live progress rings, and adaptive Coordinator navigation. Clicking a card opens an inline 1:1 **`Preview`** drawer (`Worked for Xm Ys` collapsible step trees, clickable file-line pills, checklists, model picker, composer), with **`Open ↗`** to pop out anytime. |
| **Dual-Channel Safe Updater** | Stay current across `stable` and `dev` without risking local edits | Built-in **Version & Updates** card in Settings with a red-dot gear badge when updates arrive. Switch between `stable` (`origin/main` / `vX.Y.Z`) and `dev` (`origin/dev` pre-releases). One-click Git updates enforce clean-tree checks and `--ff-only` fast-forwards (never `git reset --hard`), non-Git installs link to Releases, plus backend/UI version-drift and request-timeout protection. |
| **Shared Memory & Trilingual UI** | Consistent architectural context across every Worktree and automatic locale sync | Broadcasts `.agents/rules/project-memory.md` (with default Worktree merge & archive conventions) across active Worktrees while excluding it from commits via `.git/info/exclude`. UI automatically follows Antigravity locale across `English` / `简体中文` / `繁體中文`. |

## MCP Tools (8 Tools)

The stdio MCP server (`mcp/server.mjs`, server name `project-threads_coordinator`) exposes 8 orchestration tools:

| Tool | Purpose |
| --- | --- |
| `init_project_coordinator` | Bind and pin the current session as `[Coordinator]`, register lifecycle hooks, and initialize `.agents/rules/project-memory.md`. |
| `dispatch_thread` | Spawn an isolated Git Worktree (`createWorktree: true`) or zero-copy read-only (`createWorktree: false`) background Worker Thread via `ConversationService`. |
| `list_threads` | Sync and list active (or archived) threads strictly scoped to the current project, including `#N` / `thr-xxx` IDs, live `runState`, Git branch status, and latest summary. |
| `get_thread_detail` | Refresh and inspect full metadata, Git status, and latest summary for a single thread by `thr-xxx`, project-local `#N`, or conversation UUID. |
| `send_thread_message` | Send a follow-up instruction or question to an existing Worker Thread in the background without leaving the Coordinator session. |
| `archive_thread` | Archive a finished or obsolete thread and safely clean up its clean, merged (including `cherry-pick` equivalent) Git Worktree and branch. |
| `update_project_memory` | Read, append, or replace `.agents/rules/project-memory.md` and broadcast updates to all active Worktrees in the same project. |
| `manage_decisions` | Register (`add`), inspect (`list`), clear (`resolve`), or hide (`dismiss`) **Pending Decisions** pinned at the top of the right-hand board with 1–3 quick-action buttons. |

> **Protocol `v14` Scope Isolation & `#N` Lookup**: Single-thread tools (`get_thread_detail`, `send_thread_message`, `archive_thread`) enforce fail-closed cross-project isolation—callers must provide project scope parameters (`coordinatorId` / `workspacePath` / `projectId`) unless explicitly passing `scope: "*"` for global `thr-xxx` access. Project-local sequence lookup (`#1`, `#2`, …) always requires a leading `#` and project scope.

## Installation

> **Zero External Dependencies**: Built entirely on Antigravity 2.0's built-in Node.js ESM runtime—**no `npm install` required**.

### Stable Release (Recommended — `main` branch)

The `main` branch always tracks the latest stable release (`vX.Y.Z` / `stable` tag).

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

### Development & Pre-Release (`dev` branch / `rc` tags)

Active development and pre-release builds (`vX.Y.Z-rc.N`) live on the `dev` branch without moving the `stable` tag on `main`. You can clone `dev` directly, or switch between **`stable`** and **`dev`** anytime from Sidecar **Settings → Version & Updates** (for clean Git installs).

```bash
# Clone the dev branch directly
git clone -b dev https://github.com/agy-plugins/project-threads.git ~/.gemini/config/plugins/project-threads

# Or switch an existing installation to dev
cd ~/.gemini/config/plugins/project-threads
git fetch origin && git checkout dev && git pull
```

### Getting Started

1. Open **Antigravity 2.0 Desktop**, go to **Customizations → Plugins**, and make sure **Project Threads** is enabled (after updating plugin files, toggle **Off → On** once or reload the window to take effect).
2. Type `/coord` in your main conversation to bind it as the persistent Project Coordinator.
3. Click **`+`** in the top-right auxiliary sidebar and select **Project Threads** to open the live board:
   - Handle **Pending Decisions** pinned at the top of the board with one-click quick actions;
   - Click any thread card to open the inline **`Preview`** drawer (send follow-ups or switch models without leaving the Coordinator);
   - Click **`Open ↗`** to pop a thread into the main window, use **`Back to Coordinator`** when returning from another session, or click **`Switch`** / **`Switch to This`** to rebind the project Coordinator;
   - Open the top-right **Settings** gear to configure global/project default models (`inherit` or model + effort) and check or apply plugin updates across `stable` / `dev` channels.

## Project Structure

```text
project-threads/
├── plugin.json                 # Antigravity 2.0 plugin manifest
├── mcp_config.json             # Coordinator MCP server registration
├── hooks.json                  # PreInvocation / PreToolUse / Stop lifecycle hooks
├── assets/
│   └── logo.svg                # Vector plugin & repository logo
├── rules/
│   └── AGENTS.md               # Persistent Coordinator & Worktree isolation rules
├── skills/
│   └── coord/
│       └── SKILL.md            # /coord skill workflow instructions
├── mcp/
│   └── server.mjs              # Stdio MCP server (8 orchestration tools)
├── scripts/
│   └── hook-handler.mjs        # Completion extraction, atomic dedup, retired guard & v14 sync
├── lib/
│   ├── ls-client.mjs           # Local ConversationService / LanguageServerService client
│   ├── model-format.mjs        # Two-tier model catalog, effort formatting & inherit resolution
│   ├── store.mjs               # Scoped registry, #N sequences, decisions, rebinding & Worktree sync
│   ├── transcript.mjs          # Transcript parser, async task detector & usage telemetry
│   └── updater.mjs             # Dual-channel update checker & safe fast-forward local updater
├── sidecars/
│   └── threads/
│       ├── sidecar.json        # Auxiliary Pane Sidecar manifest
│       ├── package.json
│       ├── main.mjs            # Local API server, version-drift guard & no-cache asset router
│       ├── index.html          # Swarm-styled board, Pending Decisions, settings & preview drawer
│       ├── theme.css           # --pt-* scoped design tokens (light & dark themes)
│       └── app.js              # Live polling, decisions, rebinding, preview, picker, updater & i18n
└── tests/
    └── *.test.mjs              # Zero-dependency Node.js test suite
```

## Testing

```bash
node --test tests/*.test.mjs
```

## Community

Community Link: [LINUX DO](https://linux.do)

## License

[MIT License](./LICENSE) © 2026 [ShawnJim](https://github.com/ShawnJim)

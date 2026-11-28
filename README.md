<div align="center">
  <img src="./assets/logo.svg" width="96" height="96" alt="Project Threads Logo" />

  <h1>Antigravity Project Threads</h1>

  <p>
    Claude Code Projects–style persistent Coordinator and parallel isolated Worker Threads for <strong>Antigravity 2.0 Desktop</strong>.
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

**Antigravity Project Threads** (`project-threads`) brings a **Claude Code Projects**–style ongoing project coordination workflow to **Antigravity 2.0 Desktop**: pin your main window as an always-on **`[Coordinator]`** session, dispatch physically isolated **Git Worktree** (or zero-copy read-only) worker threads in the background via native `ConversationService`, and manage threads, **Pending Decisions**, inline **Preview** chats, Coordinator switching, and plugin updates directly in the right-hand **Project Threads** sidecar board.

## Highlights

- **Persistent Coordinator (`/coord`), One-Click Rebinding & Retired Session Protection**:
  - Keeps your main `[Coordinator] <project>` session focused on scoping, architecture decisions, task delegation, and review, guarded by `PreInvocation` / `PreToolUse` / `Stop` hooks and standing protocol `v14`.
  - **One-Click Coordinator Switching**: Rebind the project Coordinator directly from the board (**`Switch`** / **`Switch to This`**) to the current main window session, another project session, or a conversation UUID. Active unarchived threads and pending explicit decisions migrate cleanly to the new Coordinator without replaying stale idle callbacks, while retired Coordinator sessions receive a retired-session notice and are blocked from stale single-thread writes.
  - **Mode-Based Archiving Policy**: Read-only investigation threads (`createWorktree: false`) can be archived autonomously right after reporting; Worktree code threads (`createWorktree: true`) stay open for verification or follow-ups until user acceptance / sign-off and are then archived automatically, safely recognizing both standard merges and `cherry-pick` merges before removing clean Worktrees and branches.
- **Pending Decisions Board (`manage_decisions`)**:
  - Pinned at the top of the right-hand **Project Threads** panel so decisions awaiting your call never get buried in chat history.
  - **Explicit Decision Cards**: Registered by the Coordinator via `manage_decisions` with 1–3 quick-action buttons (`send_coordinator`, `archive_thread`, `dismiss`) to reply back to `[Coordinator]` in one click, and cleared via `resolve` when you answer directly in chat.
  - **Automatic Worktree Hints**: Automatically detects clean Worktree threads with unmerged commits (ready to merge) or already merged / cherry-picked branches (ready to accept & archive), deduplicated per thread against explicit decisions.
- **Dual-Mode Parallel Worker Threads (`dispatch_thread`) & Language Following**:
  - **Isolated Git Worktree Mode (`createWorktree: true`)**: Automatically provisions an isolated checkout and branch under `../.worktrees/<repo>/<thread-slug>`, enabling parallel code changes without branch or working-tree collisions.
  - **Zero-Copy Read-Only Mode (`createWorktree: false`)**: Runs code investigations, log checks, and design research directly against the repository with zero disk copy overhead.
  - **Automatic User Language Following**: Thread titles, task prompts, worker analysis, and final summaries automatically follow the user's active conversation language.
- **Fail-Closed Scope Isolation, Per-Project `#N` Sequences & Async Task Awareness**:
  - Fail-closed workspace scoping based on live `GetConversation` metadata and the Git repository root keeps threads, Coordinator bindings, decisions, and shared memory strictly isolated per project. Single-thread MCP operations enforce project scope parameters (`coordinatorId` / `workspacePath`) by default.
  - **Per-Project Display Sequences (`#N`)**: Assigns clean consecutive `#1`, `#2`, `#3`… numbers within each project alongside globally unique `thr-xxx` IDs (eliminating cross-project numbering gaps) and supports scoped `#N` lookup.
  - Detects active background commands (`run_command` async tasks) to prevent premature completion reports, and uses atomic claim locks (`wx`) to deduplicate structured completion cards pushed back to `[Coordinator]`.
- **Two-Tier Model + Thinking Effort Picker, `inherit` Mode & Usage Telemetry**:
  - Pick models and reasoning effort tiers effortlessly via the two-tier family + effort selector in both Sidecar Settings and the inline thread composer, with mid-conversation model switching and unified **`Extra High`** effort normalization.
  - Configure global or per-project default models separately for Worktree code threads and Read-Only threads, with first-class **`inherit` (Follow Coordinator)** support that dynamically resolves the Coordinator's last executed model at dispatch time.
  - Displays per-thread **total token consumption**, **compaction-line progress**, and **compaction count** directly on the board—reusing generator-metadata polling with cached offline transcript fallback at zero extra RPC cost.
- **Swarm-Styled Live Board, Real Project Names & 1:1 Inline `Preview` Drawer**:
  - Matches Antigravity's native Swarm Overview aesthetics (`--pt-*` isolated tokens, automatic light/dark theme adaptation, real Antigravity project names in the header via `ReadProject`, live progress rings, and adaptive `Coordinator` navigation that hides when already on the Coordinator session).
  - **Inline `Preview` by Default**: Clicking any thread opens a 1:1 native conversation drawer right inside the sidecar (`Worked for Xm Ys` collapsible step trees, clickable file-line pills, checklists, model picker, and follow-up composer) without leaving the main window—while keeping **`Open ↗`** for popping out into the main window.
- **Dual-Channel Update Checker & Safe Local Updater**:
  - Built-in **Version & Updates** card in Sidecar Settings with a subtle red-dot badge on the top-right Settings gear whenever an update is available.
  - Switch freely between **`stable`** (`origin/main` / `vX.Y.Z` / `stable` releases) and **`dev`** (`origin/dev` pre-releases). One-click Git updates enforce clean working-tree checks and `--ff-only` fast-forwards (never running `git reset --hard`), non-Git installs link safely to GitHub Releases, and a backend/UI version-drift guard prompts you to reload whenever the running sidecar lags behind updated plugin files.
- **Shared Project Memory (`project-memory.md`) & Trilingual UI**:
  - Automatically syncs `.agents/rules/project-memory.md` (including default Worktree merge & archive conventions) across active Worktrees, excluded from Git commits via `.git/info/exclude`.
  - Automatically follows Antigravity's global locale across `English`, `简体中文`, and `繁體中文`.

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

<div align="center">
  <img src="./assets/logo.svg" width="96" height="96" alt="Project Threads Logo" />

  <h1>Antigravity Project Threads</h1>

  <p>
    Claude Code Projects–style persistent Coordinator and parallel isolated Worker Threads for <strong>Antigravity 2.0 Desktop</strong>.
  </p>

  <p>
    <img src="https://img.shields.io/badge/version-v1.1.0-38BDF8?style=flat-square" alt="Version v1.1.0" />
    <img src="https://img.shields.io/badge/dependencies-zero%20(Node.js%20ESM)-34D399?style=flat-square" alt="Zero Dependencies" />
    <img src="https://img.shields.io/badge/platform-Antigravity%202.0-818CF8?style=flat-square" alt="Antigravity 2.0" />
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-C084FC?style=flat-square" alt="MIT License" /></a>
  </p>

  <p>
    <strong>English</strong> | <a href="./README.zh-CN.md">简体中文</a> | <a href="./README.zh-TW.md">繁體中文</a>
  </p>
</div>

---

**Antigravity Project Threads** (`project-threads`) brings a **Claude Code Projects**–style ongoing project coordination workflow to **Antigravity 2.0 Desktop**: pin your main window as an always-on **`[Coordinator]`** session, dispatch physically isolated **Git Worktree** (or zero-copy read-only) worker threads in the background via native `ConversationService`, and monitor or chat with every thread inline in the right-hand **Project Threads** sidecar board.

## Highlights

- **Persistent Coordinator (`/coord`) & Autonomous Archiving**:
  - Keeps your main `[Coordinator] <project>` session clean and focused on scoping, architecture decisions, task delegation, and review.
  - Built-in `PreInvocation` / `PreToolUse` / `Stop` hooks and persistent rules prevent the Coordinator from slipping back into ad-hoc single-threaded edits or untracked subagents.
  - **Autonomous Archiving**: Once a worker thread completes and reports back (read-only checks immediately; Worktree code threads after confirming merge or obsolescence), the Coordinator can call `archive_thread` automatically without prompting every time.
- **Dual-Mode Parallel Worker Threads (`dispatch_thread`) & Language Following**:
  - **Isolated Git Worktree Mode (`createWorktree: true`)**: Automatically provisions an isolated checkout and branch under `../.worktrees/<repo>/<thread-slug>`, enabling parallel code changes without branch or working-tree collisions.
  - **Zero-Copy Read-Only Mode (`createWorktree: false`)**: Runs code investigations, log checks, and design research directly against the repository with zero disk copy overhead.
  - **Automatic User Language Following**: Thread titles, task prompts, worker analysis, and final summaries automatically follow the user's active conversation language.
- **Two-Tier Model + Thinking Effort Picker & `inherit` Mode**:
  - Pick models and reasoning effort tiers effortlessly via the two-tier family + effort selector in both Sidecar Settings and the inline thread composer, including mid-conversation model switching.
  - Configure global or per-project default models separately for Worktree code threads and Read-Only threads, with first-class **`inherit`** support that dynamically resolves the Coordinator's current model at dispatch time.
- **Thread Token Usage & Context Compaction Telemetry**:
  - Displays per-thread **total token consumption**, **compaction-line progress**, and **compaction count** directly in the thread board.
  - Reuses existing generator-metadata polling with cached offline transcript fallback—adding zero extra RPC overhead.
- **Strict Project / Session Isolation & Async Background Awareness**:
  - Fail-closed workspace scoping based on live `GetConversation` metadata and the Git repository root keeps threads, Coordinator bindings, and project memory strictly isolated per repository.
  - Detects active background commands (`run_command` async tasks) to prevent premature completion reports, and uses atomic claim locks (`wx`) to deduplicate structured completion cards pushed back to `[Coordinator]`.
- **Swarm-Styled Live Board & 1:1 Inline `Preview` Drawer**:
  - Matches Antigravity's native Swarm Overview aesthetics (`--pt-*` isolated tokens, automatic light/dark theme adaptation, live progress rings, and shimmer status indicators).
  - **Inline `Preview` by Default**: Clicking any thread opens a 1:1 native conversation drawer right inside the sidecar (with `Worked for Xm Ys` collapsible step trees, clickable file-line pills, checklists, model picker, and follow-up composer) without leaving the main window—while keeping **`Open ↗`** and **`Coordinator`** one-click navigation.
- **Shared Project Memory (`project-memory.md`) & Trilingual UI**:
  - Automatically syncs `.agents/rules/project-memory.md` across active Worktrees (excluded from Git commits via `.git/info/exclude`).
  - Automatically follows Antigravity's global locale across `English`, `简体中文`, and `繁體中文`.

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

Active development and pre-release builds (`vX.Y.Z-rc.N`) live on the `dev` branch without moving the `stable` tag on `main`.

```bash
# Clone the dev branch directly
git clone -b dev https://github.com/agy-plugins/project-threads.git ~/.gemini/config/plugins/project-threads

# Or switch an existing installation to dev
cd ~/.gemini/config/plugins/project-threads
git fetch origin && git checkout dev && git pull
```

### Getting Started

1. Open **Antigravity 2.0 Desktop**, go to **Customizations → Plugins**, and make sure **Project Threads** is enabled (after updating plugin files, toggle **Off → On** once to hot-reload).
2. Type `/coord` in your main conversation to bind it as the persistent Project Coordinator.
3. Click **`+`** in the top-right auxiliary sidebar and select **Project Threads** to open the live board:
   - Click any thread card to open the inline **`Preview`** drawer (send follow-ups or switch models without leaving the Coordinator);
   - Click **`Open ↗`** to pop a thread into the main window, and use the top **`Coordinator`** button anytime to jump right back.

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
│   └── server.mjs              # Stdio MCP server (7 orchestration tools)
├── scripts/
│   └── hook-handler.mjs        # Completion extraction, atomic callback dedup & directive sync
├── lib/
│   ├── ls-client.mjs           # Local ConversationService / LanguageServerService client
│   ├── model-format.mjs        # Two-tier model catalog, effort formatting & inherit resolution
│   ├── store.mjs               # Project-scoped registry, Git Worktree & memory sync engine
│   └── transcript.mjs          # Transcript parser, async task detector & usage telemetry
├── sidecars/
│   └── threads/
│       ├── sidecar.json        # Auxiliary Pane Sidecar manifest
│       ├── package.json
│       ├── main.mjs            # Local API server & no-cache static asset router
│       ├── index.html          # Swarm-styled board, settings & inline preview drawer
│       ├── theme.css           # --pt-* scoped design tokens (light & dark themes)
│       └── app.js              # Live polling, inline preview, model picker & i18n
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

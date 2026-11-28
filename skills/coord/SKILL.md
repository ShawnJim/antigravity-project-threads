---
name: coord
description: >-
  Claude Projects-style ongoing project coordinator (/coord). Turns the current
  conversation into an always-on Chief-of-Staff Coordinator that decomposes
  work, dispatches isolated Git worktree or read-only investigation Worker
  Threads in the background via ConversationService, maintains a live Thread
  list, and curates Shared Project Memory.
---

# Project Coordinator (`/coord`)

When activated (or whenever the current session is bound as `[Coordinator]`), you operate this conversation as an **ongoing Project Coordinator** (modeled after Claude Code Projects). Your job is to scope goals, dispatch independent background **Worker Threads**, track their progress, and curate **Shared Project Memory** — keeping this Coordinator session clean and long-lived across all subsequent turns even when the user does not repeat `/coord`.

## Core Operating Rules

1. **NEVER Use `invoke_subagent` or `run_workflow` for Project Tasks**:
   - Subagents (`research`, `self`) do **not** register in `Project Threads` and are invisible on the user's `Project Threads` side panel.
   - Do **not** read large source files, edit application code, or run tests directly inside this Coordinator conversation.
   - Delegate **every** new code check, logic verification, bug investigation, or feature/bugfix implementation via `call_mcp_tool` -> `ServerName: "project-threads_coordinator"`, `ToolName: "dispatch_thread"`.

2. **Initialize Once per Project**:
   - On the first coordination turn in a conversation, call `init_project_coordinator` (from `project-threads_coordinator`) and **always pass `conversationId` (your current `Conversation ID` from `<user_information>`) plus `workspacePath`** to pin this session, bind lifecycle hooks (`PreInvocation`, `PreToolUse`, `Stop`), and initialize `.agents/rules/project-memory.md` (idempotently injecting default Worktree merge & archive conventions when missing).
   - Surface the side panel shortcut pill once so the user can open the live Thread board in the right-hand auxiliary pane:
     `[Project Threads](sidecar://project-threads/threads/)`

3. **Choose Worktree Mode vs Read-Only Mode in `dispatch_thread`**:
   - **Read-Only Check / Code Investigation** (e.g., "检查一下某处逻辑是否会拦截", "排查某个报错原因"):
     - Call `dispatch_thread` with `createWorktree: false`, `workspacePath: "<repoRoot>"`. Omit `model` by default so the user's configured Read-Only default model in Settings applies (only pass `model` when explicitly overriding).
     - Starts instantaneously with zero Git worktree copy overhead while still creating a tracked `thr-xxx` thread card in `Project Threads`!
   - **Code Modification / Bugfix / SQL / Unit Tests**:
     - Call `dispatch_thread` with `createWorktree: true`, `workspacePath: "<repoRoot>"`. Omit `model` by default so the user's configured Worktree default model in Settings applies.
     - Automatically creates an isolated Git worktree (`../.worktrees/<repo>/<threadId>-<slug>`) and branch (`thread/<threadId>-<slug>`) so parallel tasks never collide.
   - **Follow the User's Language**:
     - Always write `title` and `taskPrompt` in the user's active conversation language (e.g., Chinese when the user speaks Chinese, English when the user speaks English), and instruct the Worker Thread to write its analysis, replies, and final summary in that same language.

4. **Check Active Threads & Steer Existing Threads Without Navigating Away**:
   - Call `list_threads` (passing `coordinatorId` and `workspacePath`) before creating code-editing threads so you don't create overlapping branches on the same files.
   - The user keeps this Coordinator session pinned in the center and opens/chats with individual threads **inline inside the right-hand `Project Threads` sidebar** without leaving this window.
   - **Strict Single-Thread Scope Isolation**: Whenever calling `get_thread_detail`, `send_thread_message`, or `archive_thread`, **always pass `coordinatorId` and `workspacePath`** so fail-closed cross-project isolation is enforced (unscoped single-thread MCP calls are rejected fail-closed). You may reference a thread by its global ID (`thr-xxx`) or project-local `#N` sequence (leading `#` required).
   - When the user asks you (the Coordinator) to send a follow-up question or extra instruction to an existing `thr-xxx` (or `#N`) thread, call `send_thread_message(threadId="thr-xxx", coordinatorId="...", workspacePath="...", message="...")` directly instead of creating a duplicate thread.

5. **Curate Shared Project Memory & Clean Up**:
   - Whenever a project-wide constraint or reusable lesson emerges, call `update_project_memory(mode="append", content="...")`.
   - Completed Worker Threads report back automatically via the `PreInvocation` hook or when you call `list_threads` / `get_thread_detail`.
   - **Archiving Policy**: Once a Worker Thread has completed and been reported, apply different rules by thread type:
     - **Read-only investigation / check threads (`createWorktree: false`)**: You may **autonomously decide** to call `archive_thread` directly after reporting results without asking the user each time.
     - **Feature development / code-change Worktree threads (`createWorktree: true`)**: Do **NOT** auto-archive before user acceptance (even after changes are merged into a branch, keep the thread open for verification or follow-up iterations); however, **once the user confirms acceptance / sign-off** (e.g. "looks good", "ok", "accepted" / "ok了", "没问题", "验收通过") or explicitly requests archiving, **automatically call `archive_thread` directly** without waiting for a separate "archive" command.

6. **Track Pending User Decisions on the Right-Hand Board (`manage_decisions`)**:
   - Whenever your reply or thread summary card presents a decision that requires the user's call (e.g. architecture/design choice, whether to merge a branch, whether to cut a release, whether to archive/clean up), call `manage_decisions(action="add", coordinatorId="...", workspacePath="...", threadId="thr-xxx", title="...", summary="...", options=[...])` with 1–3 concise quick-action buttons (`send_coordinator` / `archive_thread` / `dismiss`) so it is pinned in the right-hand **Pending Decisions** panel for one-click handling.
   - When the user makes their decision directly in the Coordinator chat (instead of clicking the board button), promptly call `manage_decisions(action="resolve", decisionId="dec-xxx")` to clear the resolved card from the board.

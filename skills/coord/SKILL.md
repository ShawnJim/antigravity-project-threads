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
   - On the first coordination turn in a conversation, call `init_project_coordinator` (from `project-threads_coordinator`) to pin this session, bind the workspace repository, and initialize `.agents/rules/project-memory.md`.
   - Surface the side panel shortcut pill once so the user can open the live Thread board in the right-hand auxiliary pane:
     `[Project Threads](sidecar://project-threads/threads/)`

3. **Choose Worktree Mode vs Read-Only Mode in `dispatch_thread`**:
   - **Read-Only Check / Code Investigation** (e.g., "检查一下某处逻辑是否会拦截", "排查某个报错原因"):
     - Call `dispatch_thread` with `createWorktree: false`, `workspacePath: "<repoRoot>"`, `model: "pro"`.
     - Starts instantaneously with zero Git worktree copy overhead while still creating a tracked `thr-xxx` thread card in `Project Threads`!
   - **Code Modification / Bugfix / SQL / Unit Tests**:
     - Call `dispatch_thread` with `createWorktree: true`, `workspacePath: "<repoRoot>"`.
     - Automatically creates an isolated Git worktree (`../.worktrees/<repo>/<threadId>-<slug>`) and branch (`thread/<threadId>-<slug>`) so parallel tasks never collide.

4. **Check Active Threads & Steer Existing Threads Without Navigating Away**:
   - Call `list_threads` before creating code-editing threads so you don't create overlapping branches on the same files.
   - The user keeps this Coordinator session pinned in the center and opens/chats with individual threads **inline inside the right-hand `Project Threads` sidebar** without leaving this window.
   - When the user asks you (the Coordinator) to send a follow-up question or extra instruction to an existing `thr-xxx` thread, call `send_thread_message(threadId="thr-xxx", message="...")` directly instead of creating a duplicate thread.

5. **Curate Shared Project Memory & Clean Up**:
   - Whenever a project-wide constraint or reusable lesson emerges, call `update_project_memory(mode="append", content="...")`.
   - Completed Worker Threads report back automatically via the `PreInvocation` hook or when you call `list_threads` / `get_thread_detail`.
   - Archive finished/merged threads with `archive_thread`.

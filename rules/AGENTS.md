# Project Threads Coordination & Worktree Isolation Rules

1. **Persistent Coordinator Discipline**:
   - If a conversation is titled `[Coordinator] ...` or has been bound via `init_project_coordinator`, remain in Coordinator mode on **every** subsequent user message even when `/coord` is omitted.
   - In a Coordinator conversation, **never** call `invoke_subagent` (`research` / `self`) or `run_workflow` for codebase investigations or edits; always call `project-threads_coordinator` -> `dispatch_thread` (`createWorktree: false` for read-only checks/investigations, `createWorktree: true` for code changes) so every task creates a tracked `thr-xxx` thread in the `Project Threads` panel.
   - When dispatching a Worker Thread via `dispatch_thread`, always write `title` and `taskPrompt` in the user's active conversation language (e.g., Chinese when the user speaks Chinese, English when the user speaks English) and instruct the Worker Thread to write its analysis and final summary in that same language.
   - **Archiving Policy**: Once a Worker Thread has completed and been reported:
     - For **read-only investigation / check threads (`createWorktree: false`)**, the Coordinator may **autonomously decide** to call `archive_thread` directly after reporting results without asking the user each time.
     - For **feature development / code-change Worktree threads (`createWorktree: true`)**, do **NOT** auto-archive before user acceptance (even after changes are merged into a branch, keep the thread open for verification or follow-up iterations); however, **once the user confirms acceptance / sign-off** (e.g. "looks good", "ok", "accepted" / "ok了", "没问题", "验收通过") or explicitly requests archiving, **automatically call `archive_thread` directly** without waiting for a separate "archive" command.

2. **Worker Thread Worktree Isolation**:
   - Whenever a conversation's prompt or `.agents/rules/worker-thread-context.md` assigns an **Isolated Worktree Path** (under `.worktrees/<repo>/<thread>`), perform ALL file reads, edits, writes, and shell commands strictly inside that worktree directory. Never modify files in the main repository checkout.
   - Write your analysis and conclude completed Worker Thread assignments in the same language as the task instructions with a `### Thread Summary` (or `### 线程总结`) section summarizing root cause / findings / changes made, modified files or commit hash, and any reusable architectural notes for Shared Project Memory.

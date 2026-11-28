import { resolveLsEndpoint } from '../lib/ls-client.mjs';
import {
  initCoordinator,
  inspectWorktreeGit,
  loadRegistry,
  saveRegistry,
  syncCompletionToCoordinator,
} from '../lib/store.mjs';
import { extractThreadCompletion } from '../lib/transcript.mjs';

const DIRECTIVE_VERSION = 14;
const LEADING_SLASH_COORD_RE = /^\s*\/coord(?=$|[\s:：，,。!?！？])/i;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function extractDirectUserMessage(rawInput) {
  const s = String(rawInput || '');
  if (!s) return '';
  const reqMatches = [...s.matchAll(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi)];
  if (reqMatches.length > 0) {
    return reqMatches[reqMatches.length - 1][1].trim();
  }
  return s
    .replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .trim();
}

function buildCoordinatorDirective(coord) {
  const repo = coord.repoRoot || coord.workspacePath || '';
  const cid = coord.conversationId || '';
  const scopeLabel = repo || coord.title || coord.key || 'Current Project';
  const hasRepo = Boolean(repo);
  return [
    `[Project Coordinator Standing Protocol — Bound Scope: ${scopeLabel}]`,
    'This conversation is permanently bound as the ongoing Project Coordinator. Even when subsequent user messages omit the `/coord` prefix, you MUST continue operating strictly in Coordinator mode (always reply to the user in the language they use):',
    '1. **NEVER call `invoke_subagent` (e.g. `research` / `self`) or `run_workflow`** for project tasks — ephemeral subagents do not appear on the Project Threads board! Likewise, do NOT read large source files or edit application code directly inside this Coordinator session.',
    '2. **Dispatch EVERY new task as a Project Thread**: Whether the user asks for code changes, bug fixes, or a read-only code/logic investigation, call `call_mcp_tool` with `ServerName: "project-threads_coordinator"`, `ToolName: "dispatch_thread"` to create a tracked `thr-xxx` thread:',
    `   - **Read-only investigation / logic check / non-repo project task**: Pass \`createWorktree: false\`, \`coordinatorId: ${JSON.stringify(cid)}\`, \`workspacePath: ${JSON.stringify(repo)}\` (starts instantly with zero Git worktree copy overhead while creating a tracked \`thr-xxx\` card on the Project Threads board; omit \`model\` by default so the user's Settings default applies, and pass \`model\` only when explicitly requested).`,
    hasRepo
      ? `   - **Code changes / scripts / bug fixes**: Pass \`createWorktree: true\`, \`coordinatorId: ${JSON.stringify(cid)}\`, \`workspacePath: ${JSON.stringify(repo)}\` (automatically creates an isolated Git worktree and branch; omit \`model\` by default so the user's Settings default applies).`
      : `   - **Note**: No local Git repository is bound to this scope; keep \`createWorktree: false\` and always pass \`coordinatorId: ${JSON.stringify(cid)}\`.`,
    '   - **Match the user\'s language**: Write `title` and `taskPrompt` in the user\'s active conversation language (e.g. Chinese when the user speaks Chinese, English when the user speaks English), and instruct the Worker Thread to write its analysis and final summary in that same language.',
    '3. **Format `[THREAD_COMPLETION_SYNC]` callbacks as segmented summary cards**: When a background worker thread finishes, the system delivers a `[THREAD_COMPLETION_SYNC]` message to this session. Keep multiple callbacks cleanly separated by following this exact card layout (localized to the user\'s language):',
    '   - **Blockquote header banner**: `> **✅ [thr-xxx] <Task Title> · Completed** ([View Thread](conversation://<threadConvId>))`',
    '   - **3–5 concise takeaway bullets**: Summarize only root cause, key changes/findings, and any decision needed from the user. Do NOT dump long logs or large tables into the Coordinator session.',
    `   - **Trailing divider**: End the card with \`---\` (and if cross-cutting project conventions emerged, call \`update_project_memory\` passing \`coordinatorId: ${JSON.stringify(cid)}\`, \`workspacePath: ${JSON.stringify(repo)}\`).`,
    '   - If a callback duplicates an already-reported conclusion, acknowledge briefly in one line or stay concise without exposing internal dedup metadata. **NEVER call `dispatch_thread` again in response to a completion sync!**',
    `4. **Thread management & archiving policy**: To check thread status, steer an existing thread, or archive finished work, call \`list_threads\`, \`get_thread_detail\`, \`send_thread_message\`, or \`archive_thread\` — ALWAYS pass \`coordinatorId: ${JSON.stringify(cid)}\` and \`workspacePath: ${JSON.stringify(repo)}\` on every call so strict fail-closed cross-project isolation and project-local \`#N\` sequence lookup are enforced (single-thread calls without scope are rejected fail-closed). Follow strict mode-based archiving rules once a Worker Thread has completed and been reported: (a) **Read-only investigation / check threads (\`createWorktree: false\`)**: you may **autonomously decide** to call \`archive_thread\` directly after reporting results without asking the user each time; (b) **Feature development / code-change Worktree threads (\`createWorktree: true\`)**: do **NOT** auto-archive before user acceptance (even after changes are merged into a branch, keep the thread open for verification or follow-up iterations); however, **once the user confirms acceptance / sign-off** (e.g. "looks good", "ok", "accepted" / "ok了", "没问题", "验收通过") or explicitly requests archiving, **automatically call \`archive_thread\` directly** without waiting for a separate "archive" command.`,
    `5. **Pending Decisions board (\`manage_decisions\`)**: Whenever your reply or summary card asks the user to make a decision (e.g. architecture/design choice, whether to merge a branch, whether to release, or whether to archive/clean up), synchronously call \`manage_decisions\` with \`action: "add"\`, \`coordinatorId: ${JSON.stringify(cid)}\`, \`workspacePath: ${JSON.stringify(repo)}\`, optional \`threadId\`, concise \`title\`, optional \`summary\`, and 1–3 quick-action \`options\` (\`send_coordinator\` / \`archive_thread\` / \`dismiss\`) so it pins in the right-hand **Pending Decisions** panel. Whenever the user replies directly in chat to decide, promptly call \`manage_decisions\` with \`action: "resolve"\` and \`decisionId\` to clear it so resolved items never linger on the board.`,
  ].join('\n');
}

async function main() {
  resolveLsEndpoint();
  const eventArg = process.argv[2] || '';
  const raw = await readStdin();
  let input = {};
  try {
    input = raw ? JSON.parse(raw) : {};
  } catch {
    input = {};
  }

  const event = input.hookEventName || eventArg;
  const convId = input.conversationId || '';
  if (!convId) {
    if (event === 'Stop') process.stdout.write('{"decision":"stop"}\n');
    else if (event === 'PreToolUse') process.stdout.write('{"decision":"allow"}\n');
    else process.stdout.write('{}\n');
    return;
  }

  let reg = loadRegistry();

  if (event === 'PreToolUse') {
    const coord = Object.values(reg.coordinators).find((c) => c.conversationId === convId);
    if (!coord) {
      process.stdout.write('{"decision":"allow"}\n');
      return;
    }

    const toolName = input?.toolCall?.name || '';
    const subType = input?.toolCall?.args?.TypeName || '';
    if (
      (toolName === 'invoke_subagent' && subType !== 'browser' && subType !== 'image-generator') ||
      toolName === 'run_workflow'
    ) {
      const repo = coord.repoRoot || coord.workspacePath || '';
      const cid = coord.conversationId || '';
      process.stdout.write(
        `${JSON.stringify({
          decision: 'deny',
          reason:
            `This conversation is bound as the Project Coordinator; do not use ${toolName} to delegate project tasks (ephemeral subagents are invisible on the Project Threads board). ` +
            `Instead, call call_mcp_tool with ServerName="project-threads_coordinator", ToolName="dispatch_thread" to create a tracked thr-xxx thread ` +
            `(pass createWorktree: false, coordinatorId: ${JSON.stringify(cid)}, workspacePath: ${JSON.stringify(repo)} for read-only checks, or createWorktree: true for Git repository code changes).`,
        })}\n`,
      );
      return;
    }

    process.stdout.write('{"decision":"allow"}\n');
    return;
  }

  if (event === 'Stop') {
    const thread = Object.values(reg.threads).find((t) => t.conversationId === convId && !t.archived);
    if (thread) {
      const reason = input.terminationReason || 'NO_TOOL_CALL';
      if (reason !== 'USER_CANCELED') {
        try {
          await syncCompletionToCoordinator({
            threadId: thread.threadId,
            transcriptPath: input.transcriptPath || '',
            force: false,
            timeoutMs: 6000,
          });
        } catch {
          // Fallback: still persist local summary & state if LS/agentapi was unreachable (unless waiting on bg task)
          const comp = extractThreadCompletion(convId, input.transcriptPath || '');
          if (!comp.waitingOnBackgroundTask) {
            if (comp.cardSummary) thread.lastSummary = comp.cardSummary;
            thread.runState = 'RUN_STATE_IDLE';
            thread.hasPendingBgTask = false;
            thread.activeTool = '';
            thread.activeToolObj = null;
            thread.lastCompletedAt = new Date().toISOString();
            thread.updatedAt = thread.lastCompletedAt;
            if (thread.worktreePath) {
              const coord =
                (thread.workspaceKey && reg.coordinators?.[thread.workspaceKey]) ||
                Object.values(reg.coordinators || {}).find(
                  (c) => c.conversationId === thread.coordinatorId,
                ) ||
                null;
              thread.git = await inspectWorktreeGit(thread.worktreePath, {
                baseRef: thread.baseRef,
                defaultBranch: coord?.defaultBranch || '',
                repoRoot: thread.repoRoot || coord?.repoRoot || '',
              });
            }
            saveRegistry(reg);
          }
        }
      }
    }
    process.stdout.write('{"decision":"stop"}\n');
    return;
  }

  if (event === 'PreInvocation') {
    let coord = Object.values(reg.coordinators).find((c) => c.conversationId === convId);

    // Auto-bootstrap on the VERY FIRST `/coord` turn before `init_project_coordinator` MCP tool runs
    const directUserText = extractDirectUserMessage(input.lastUserInput);
    if (!coord && LEADING_SLASH_COORD_RE.test(directUserText)) {
      const isWorkerThread = Object.values(reg.threads || {}).some(
        (t) => t?.conversationId === convId,
      );
      if (!isWorkerThread) {
        const primaryWorkspace =
          (Array.isArray(input.workspacePaths) && input.workspacePaths[0]) || input.cwd || '';
        try {
          await initCoordinator({
            workspacePath: primaryWorkspace,
            conversationId: convId,
          });
          reg = loadRegistry();
          coord = Object.values(reg.coordinators).find((c) => c.conversationId === convId);
        } catch {
          // Non-fatal; MCP init_project_coordinator will still bind on tool execution
        }
      }
    }

    if (!coord) {
      process.stdout.write('{}\n');
      return;
    }

    const messages = [];
    let dirty = false;
    const stepCount = Number(input.initialNumSteps) || 0;
    const compacted = coord.lastStepCount && stepCount > 0 && stepCount < coord.lastStepCount;

    // Push ONLY once on initial Coordinator bind (or after /compact) to prevent context bloat
    if (coord.directiveVersion !== DIRECTIVE_VERSION || compacted) {
      messages.push(buildCoordinatorDirective(coord));
      coord.directiveVersion = DIRECTIVE_VERSION;
      dirty = true;
    }
    if (stepCount > 0 && stepCount !== coord.lastStepCount) {
      coord.lastStepCount = stepCount;
      dirty = true;
    }

    // Fallback injection ONLY for threads that have NEVER been pushed/notified and are not waiting on a background task
    const newlyFinished = Object.values(reg.threads).filter((t) => {
      if (t.archived || t.coordinatorId !== convId || !t.lastCompletedAt) return false;
      if (t.pushedToCoordinatorAt || t.notifiedCoordinatorAt) return false;
      if (t.runState === 'RUN_STATE_IDLE' || t.runState !== 'RUN_STATE_RUNNING') {
        const comp = extractThreadCompletion(t.conversationId);
        return !comp.waitingOnBackgroundTask;
      }
      return false;
    });

    if (newlyFinished.length > 0) {
      const now = new Date().toISOString();
      const bullets = newlyFinished.map((t) => {
        t.notifiedCoordinatorAt = now;
        const gitNote = t.git?.lastCommit ? ` | Latest commit: \`${t.git.lastCommit}\`` : '';
        const sum = t.lastSummary ? `\n  > ${t.lastSummary.replace(/\r?\n+/g, ' ').slice(0, 260)}` : '';
        return `- **\`${t.threadId}\`** ${t.title} (\`${t.branch || 'read-only'}\`)${gitNote}${sum}`;
      });
      messages.push(
        [
          '[Project Threads Update] The following background worker threads have completed:',
          ...bullets,
        ].join('\n'),
      );
      dirty = true;
    }

    if (dirty) saveRegistry(reg);

    if (!messages.length) {
      process.stdout.write('{}\n');
      return;
    }

    process.stdout.write(
      `${JSON.stringify({
        injectSteps: messages.map((text) => ({
          systemMessage: {
            systemMessage: text,
          },
        })),
      })}\n`,
    );
    return;
  }

  process.stdout.write('{}\n');
}

main().catch(() => {
  process.stdout.write('{}\n');
});

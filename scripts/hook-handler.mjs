import { resolveLsEndpoint } from '../lib/ls-client.mjs';
import {
  clearManualCancelFieldsInRecord,
  findRetiredCoordinatorOwner,
  getThreadDisplayId,
  hasNewUserTurnAfterCancel,
  initCoordinator,
  inspectWorktreeGit,
  loadRegistry,
  mutateRegistry,
  syncCompletionToCoordinator,
} from '../lib/store.mjs';
import { extractThreadCompletion } from '../lib/transcript.mjs';
import { consumePendingWatchdogAlertsForPreInvocation } from '../lib/watchdog.mjs';

const DIRECTIVE_VERSION = 18;
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
    '2. **Dispatch EVERY new task as a Project Thread**: Whether the user asks for code changes, bug fixes, or a read-only code/logic investigation, call `call_mcp_tool` with `ServerName: "project-threads_coordinator"`, `ToolName: "dispatch_thread"` to create a tracked project-local `thr-NNN` thread:',
    `   - **Read-only investigation / logic check / non-repo project task**: Pass \`createWorktree: false\`, \`coordinatorId: ${JSON.stringify(cid)}\`, \`workspacePath: ${JSON.stringify(repo)}\` (starts instantly with zero Git worktree copy overhead while creating a tracked \`thr-NNN\` card on the Project Threads board; omit \`model\` by default so the user's Settings default applies, and pass \`model\` only when explicitly requested).`,
    `   - **Code review / cross-review**: Pass \`createWorktree: false\`, \`threadType: "review"\`, \`coordinatorId: ${JSON.stringify(cid)}\`, \`workspacePath: ${JSON.stringify(repo)}\` (omit \`model\` by default so the user's configured Review default model in Settings applies automatically; pass \`model\` only when explicitly requested).`,
    hasRepo
      ? `   - **Code changes / scripts / bug fixes**: Pass \`createWorktree: true\`, \`coordinatorId: ${JSON.stringify(cid)}\`, \`workspacePath: ${JSON.stringify(repo)}\` (automatically creates an isolated Git worktree and branch; omit \`model\` by default so the user's Settings default applies).`
      : `   - **Note**: No local Git repository is bound to this scope; keep \`createWorktree: false\` and always pass \`coordinatorId: ${JSON.stringify(cid)}\`.`,
    '   - **Match the user\'s language**: Write `title` and `taskPrompt` in the user\'s active conversation language (e.g. Chinese when the user speaks Chinese, English when the user speaks English), and instruct the Worker Thread to write its analysis and final summary in that same language.',
    '3. **Format `[THREAD_COMPLETION_SYNC]` callbacks as segmented summary cards**: When a background worker thread finishes, the system delivers a `[THREAD_COMPLETION_SYNC]` message to this session. Keep multiple callbacks cleanly separated by following this exact card layout (localized to the user\'s language):',
    '   - **Blockquote header banner**: `> **✅ [thr-NNN] <Task Title> — Completed** ([View Thread](conversation://<threadConvId>))`',
    '   - **3–5 concise takeaway bullets**: Summarize only root cause, key changes/findings, and any decision needed from the user. Do NOT dump long logs or large tables into the Coordinator session.',
    `   - **Trailing divider**: End the card with \`---\` (and if reusable project conventions emerged, curate Shared Project Memory via \`update_project_memory\` passing \`coordinatorId: ${JSON.stringify(cid)}\`, \`workspacePath: ${JSON.stringify(repo)}\`: keep \`.agents/rules/project-memory.md\` as a thin index \`<= 60\` lines, store module-specific details in \`.agents/memory/<topic>.md\` using \`topic\`, and when conventions change or bloat appears, call \`mode: "read"\` first then consolidate via \`mode: "replace"\` or split into topics rather than endlessly appending).`,
    '   - If a callback duplicates an already-reported conclusion, acknowledge briefly in one line or stay concise without exposing internal dedup metadata. **NEVER call `dispatch_thread` again in response to a completion sync!**',
    `4. **Thread management & archiving policy**: To check thread status, steer an existing thread, or archive finished work, call \`list_threads\`, \`get_thread_detail\`, \`send_thread_message\`, or \`archive_thread\` — ALWAYS pass \`coordinatorId: ${JSON.stringify(cid)}\` and \`workspacePath: ${JSON.stringify(repo)}\` on every call so strict fail-closed cross-project isolation and project-local \`thr-NNN\` (plus legacy \`#N\`) lookup are enforced (single-thread calls without scope are rejected fail-closed). Follow strict mode-based archiving rules once a Worker Thread has completed and been reported: (a) **Read-only investigation / check threads (\`createWorktree: false\`)**: you may **autonomously decide** to call \`archive_thread\` directly after reporting results without asking the user each time; (b) **Feature development / code-change Worktree threads (\`createWorktree: true\`)**: do **NOT** auto-archive before user acceptance (even after changes are merged into a branch, keep the thread open for verification or follow-up iterations); however, **once the user confirms acceptance / sign-off** (e.g. "looks good", "ok", "accepted" / "ok了", "没问题", "验收通过") or explicitly requests archiving, **automatically call \`archive_thread\` directly** without waiting for a separate "archive" command.`,
    `5. **Pending Decisions board (\`manage_decisions\`)**: Not limited to Worker Thread completion callbacks — whenever ANY reply from you asks the user to make a call or answer a binary/multi-choice/confirmation question (including everyday planning discussions, architecture/design trade-offs, whether to open an Issue first vs. implement directly, scheduling/priority choices, whether to merge a branch, whether to release, or whether to archive/clean up), you MUST synchronously call \`manage_decisions\` with \`action: "add"\`, \`coordinatorId: ${JSON.stringify(cid)}\`, \`workspacePath: ${JSON.stringify(repo)}\`, optional \`threadId\`, concise \`title\`, optional \`summary\`, and 1–3 quick-action \`options\` (\`send_coordinator\` / \`archive_thread\` / \`dismiss\`) so it pins in the right-hand **Pending Decisions** panel (users can also submit custom instructions directly on any card). Whenever the user replies directly in chat to decide, promptly call \`manage_decisions\` with \`action: "resolve"\` and \`decisionId\` to clear it so resolved items never linger on the board.`,
  ].join('\n');
}

function buildRetiredCoordinatorNotice(coord) {
  const newCid = String(coord?.conversationId || '').trim();
  const scopeLabel = coord?.repoRoot || coord?.workspacePath || coord?.title || coord?.key || 'Current Project';
  const newLink = newCid ? `conversation://${newCid}` : '(new Coordinator session)';
  return [
    `[Project Coordinator Retired — Scope: ${scopeLabel}]`,
    `This conversation is NO LONGER the active Project Coordinator. Project coordination has been switched to the new Coordinator session: ${newLink}.`,
    'Do NOT call `dispatch_thread`, update shared coordination state, or operate on active project threads from this retired session using stale coordinator IDs from earlier conversation history.',
    `Please concisely inform the user that project coordination has moved to [New Coordinator](${newLink}) and direct any new orchestration requests there.`,
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
            `Instead, call call_mcp_tool with ServerName="project-threads_coordinator", ToolName="dispatch_thread" to create a tracked thr-NNN thread ` +
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
      const reason = String(input.terminationReason || 'NO_TOOL_CALL');
      const isUserCanceled =
        reason === 'USER_CANCELED' || /cancel|abort|interrupt/i.test(reason);
      const stopCompPre = extractThreadCompletion(convId, input.transcriptPath || '', {
        canceledAt: thread.canceledAt || '',
        bgTasksKilledAt: thread.bgTasksKilledAt || '',
      });
      const resumedFromCancel = Boolean(
        !isUserCanceled && thread.canceledAt && hasNewUserTurnAfterCancel(thread, stopCompPre),
      );
      if (isUserCanceled || (thread.canceledAt && !resumedFromCancel)) {
        const stopSuppressedStep = Math.max(
          Number.isInteger(stopCompPre.stepIndex) ? stopCompPre.stepIndex : -1,
          Number.isInteger(stopCompPre.latestUserStepIndex) ? stopCompPre.latestUserStepIndex : -1,
          Number.isInteger(stopCompPre.maxStepIndex) ? stopCompPre.maxStepIndex : -1,
        );
        const canceledAt = thread.canceledAt || new Date().toISOString();
        mutateRegistry((freshReg) => {
          const freshT =
            freshReg.threads[thread.threadId] ||
            Object.values(freshReg.threads || {}).find((x) => x.conversationId === convId);
          if (!freshT || freshT.archived) return;
          freshT.runState = 'RUN_STATE_IDLE';
          freshT.hasPendingBgTask = false;
          freshT.activeTool = '';
          freshT.activeToolObj = null;
          freshT.bucket = 'idle';
          freshT.waitingReason = '';
          if (!freshT.canceledAt) {
            freshT.canceledAt = canceledAt;
            if (stopSuppressedStep >= 0) {
              freshT.canceledStepIndex = stopSuppressedStep;
            }
          }
          if (!freshT.updatedAt || canceledAt > freshT.updatedAt) freshT.updatedAt = canceledAt;
        });
      } else {
        if (resumedFromCancel) {
          const origCanceledAt = thread.canceledAt;
          mutateRegistry((freshReg) => {
            const freshT =
              freshReg.threads[thread.threadId] ||
              Object.values(freshReg.threads || {}).find((x) => x.conversationId === convId);
            if (!freshT || freshT.archived) return;
            if (freshT.canceledAt && freshT.canceledAt === origCanceledAt) {
              clearManualCancelFieldsInRecord(
                freshT,
                stopCompPre.latestUserStepAt || new Date().toISOString(),
              );
            }
          });
        }
        try {
          await syncCompletionToCoordinator({
            threadId: thread.threadId,
            transcriptPath: input.transcriptPath || '',
            force: false,
            timeoutMs: 6000,
          });
        } catch {
          // Fallback: still persist local summary & state if LS/agentapi was unreachable (unless waiting on bg task)
          const comp = extractThreadCompletion(convId, input.transcriptPath || '', {
            canceledAt: resumedFromCancel ? '' : thread.canceledAt || '',
            bgTasksKilledAt: thread.bgTasksKilledAt || '',
          });
          if (!comp.waitingOnBackgroundTask) {
            let nextGit = null;
            if (thread.worktreePath) {
              const coord =
                (thread.workspaceKey && reg.coordinators?.[thread.workspaceKey]) ||
                Object.values(reg.coordinators || {}).find(
                  (c) => c.conversationId === thread.coordinatorId,
                ) ||
                null;
              nextGit = await inspectWorktreeGit(thread.worktreePath, {
                baseRef: thread.baseRef,
                defaultBranch: coord?.defaultBranch || '',
                repoRoot: thread.repoRoot || coord?.repoRoot || '',
              });
            }
            const completedAt = new Date().toISOString();
            mutateRegistry((freshReg) => {
              const freshT =
                freshReg.threads[thread.threadId] ||
                Object.values(freshReg.threads || {}).find((x) => x.conversationId === convId);
              if (!freshT) return;
              if (freshT.canceledAt) {
                const freshComp = extractThreadCompletion(convId, input.transcriptPath || '', {
                  canceledAt: freshT.canceledAt,
                  bgTasksKilledAt: freshT.bgTasksKilledAt || '',
                });
                if (!hasNewUserTurnAfterCancel(freshT, freshComp)) return;
                clearManualCancelFieldsInRecord(freshT, freshComp.latestUserStepAt || completedAt);
              }
              if (comp.cardSummary) freshT.lastSummary = comp.cardSummary;
              freshT.runState = 'RUN_STATE_IDLE';
              freshT.hasPendingBgTask = false;
              freshT.activeTool = '';
              freshT.activeToolObj = null;
              freshT.lastCompletedAt = completedAt;
              freshT.updatedAt = completedAt;
              if (nextGit) freshT.git = nextGit;
            });
          }
        }
      }
    }
    process.stdout.write('{"decision":"stop"}\n');
    return;
  }

  if (event === 'PreInvocation') {
    let coord = Object.values(reg.coordinators).find((c) => c.conversationId === convId);
    const directUserText = extractDirectUserMessage(input.lastUserInput);
    const hasSlashCoord = LEADING_SLASH_COORD_RE.test(directUserText);

    // Check retired Coordinator BEFORE `/coord` auto-bootstrap so a retired session
    // can never silently hijack active Coordinator ownership via `/coord`.
    if (!coord) {
      const retiredOwner = findRetiredCoordinatorOwner(reg, convId);
      if (retiredOwner) {
        const stepCount = Number(input.initialNumSteps) || 0;
        const ownerRebindSeq = Number(retiredOwner.rebindSeq) || 0;
        const prevNotice = retiredOwner.retiredNotified?.[convId] || null;
        const compactedRetired = Boolean(
          prevNotice?.lastStepCount && stepCount > 0 && stepCount < prevNotice.lastStepCount,
        );
        const alreadyNotifiedForCurrentTarget = Boolean(
          prevNotice &&
            prevNotice.targetCoordinatorId === retiredOwner.conversationId &&
            (Number(prevNotice.rebindSeq) || 0) >= ownerRebindSeq &&
            !compactedRetired &&
            !hasSlashCoord,
        );

        if (alreadyNotifiedForCurrentTarget) {
          // Avoid writing registry on every retired turn; only checkpoint stepCount periodically for /compact detection
          if (
            stepCount > 0 &&
            (!prevNotice.lastStepCount || stepCount >= prevNotice.lastStepCount + 6)
          ) {
            mutateRegistry((freshReg) => {
              const freshOwner = freshReg.coordinators?.[retiredOwner.key];
              if (!freshOwner) return;
              if (!freshOwner.retiredNotified || typeof freshOwner.retiredNotified !== 'object') {
                freshOwner.retiredNotified = {};
              }
              const curEntry = freshOwner.retiredNotified[convId] || prevNotice;
              freshOwner.retiredNotified[convId] = {
                ...curEntry,
                lastStepCount: stepCount,
              };
            });
          }
          process.stdout.write('{}\n');
          return;
        }

        const noticeText = buildRetiredCoordinatorNotice(retiredOwner);
        const notifiedAt = new Date().toISOString();
        mutateRegistry((freshReg) => {
          const freshOwner = freshReg.coordinators?.[retiredOwner.key];
          if (!freshOwner || freshOwner.conversationId === convId) return;
          if (!freshOwner.retiredNotified || typeof freshOwner.retiredNotified !== 'object') {
            freshOwner.retiredNotified = {};
          }
          freshOwner.retiredNotified[convId] = {
            notifiedAt,
            targetCoordinatorId: freshOwner.conversationId,
            rebindSeq: Number(freshOwner.rebindSeq) || 0,
            lastStepCount: stepCount,
          };
        });

        process.stdout.write(
          `${JSON.stringify({
            injectSteps: [
              {
                systemMessage: {
                  systemMessage: noticeText,
                },
              },
            ],
          })}\n`,
        );
        return;
      }
    }

    // Auto-bootstrap on the VERY FIRST `/coord` turn before `init_project_coordinator` MCP tool runs
    if (!coord && hasSlashCoord) {
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
    let shouldUpdateDirective = false;
    let shouldUpdateSteps = false;
    const stepCount = Number(input.initialNumSteps) || 0;
    const compacted = coord.lastStepCount && stepCount > 0 && stepCount < coord.lastStepCount;

    // Push ONLY once on initial Coordinator bind (or after /compact) to prevent context bloat
    if (coord.directiveVersion !== DIRECTIVE_VERSION || compacted) {
      messages.push(buildCoordinatorDirective(coord));
      shouldUpdateDirective = true;
    }
    if (stepCount > 0 && stepCount !== coord.lastStepCount) {
      shouldUpdateSteps = true;
    }

    // Fallback injection ONLY for threads that have NEVER been pushed/notified, are not suppressed by a stale
    // pre-rebind historical baseline, and are not waiting on a background task
    const resumedCancelClearMap = new Map();
    const newlyFinished = Object.values(reg.threads).filter((t) => {
      if (t.archived || t.coordinatorId !== convId || !t.lastCompletedAt) return false;
      if (t.pushedToCoordinatorAt || t.notifiedCoordinatorAt) return false;
      if (t.runState === 'RUN_STATE_IDLE' || t.runState !== 'RUN_STATE_RUNNING') {
        const comp = extractThreadCompletion(t.conversationId, '', {
          canceledAt: t.canceledAt || '',
          bgTasksKilledAt: t.bgTasksKilledAt || '',
        });
        if (t.canceledAt) {
          if (!hasNewUserTurnAfterCancel(t, comp)) {
            return false;
          }
          resumedCancelClearMap.set(t.threadId, {
            origCanceledAt: t.canceledAt,
            clearedAt: comp.latestUserStepAt || '',
          });
        }
        if (comp.waitingOnBackgroundTask) return false;
        const suppressedByBaseline =
          (Number.isInteger(t.reboundBaselineStepIndex) &&
            comp.stepIndex >= 0 &&
            comp.stepIndex <= t.reboundBaselineStepIndex) ||
          (Boolean(t.reboundBaselineAt) &&
            comp.stepIndex < 0 &&
            t.lastCompletedAt <= t.reboundBaselineAt);
        if (suppressedByBaseline) {
          return false;
        }
        return true;
      }
      return false;
    });

    const notifiedIds = [];
    const now = new Date().toISOString();
    if (newlyFinished.length > 0) {
      const bullets = newlyFinished.map((t) => {
        notifiedIds.push(t.threadId);
        const displayId = getThreadDisplayId(t) || t.threadId;
        const gitNote = t.git?.lastCommit ? ` | Latest commit: \`${t.git.lastCommit}\`` : '';
        const sum = t.lastSummary ? `\n  > ${t.lastSummary.replace(/\r?\n+/g, ' ').slice(0, 260)}` : '';
        return `- **\`${displayId}\`** ${t.title} (\`${t.branch || 'read-only'}\`)${gitNote}${sum}`;
      });
      messages.push(
        [
          '[Project Threads Update] The following background worker threads have completed:',
          ...bullets,
        ].join('\n'),
      );
    }

    // Lightweight injection for any deferred watchdog stall alerts queued while Coordinator was busy
    try {
      const watchdogNotice = consumePendingWatchdogAlertsForPreInvocation(coord);
      if (watchdogNotice) {
        messages.push(watchdogNotice);
      }
    } catch {
      // Non-fatal: watchdog notice injection must never block PreInvocation
    }

    if (
      shouldUpdateDirective ||
      shouldUpdateSteps ||
      notifiedIds.length > 0 ||
      resumedCancelClearMap.size > 0
    ) {
      mutateRegistry((freshReg) => {
        const freshCoord =
          (coord.key && freshReg.coordinators?.[coord.key]) ||
          Object.values(freshReg.coordinators || {}).find((c) => c.conversationId === convId);
        if (freshCoord && freshCoord.conversationId === convId) {
          if (shouldUpdateDirective) freshCoord.directiveVersion = DIRECTIVE_VERSION;
          if (shouldUpdateSteps) freshCoord.lastStepCount = stepCount;
        }
        for (const [tid, cancelMeta] of resumedCancelClearMap.entries()) {
          const freshT = freshReg.threads?.[tid];
          if (freshT && freshT.canceledAt === cancelMeta.origCanceledAt) {
            clearManualCancelFieldsInRecord(freshT, cancelMeta.clearedAt || now);
          }
        }
        for (const tid of notifiedIds) {
          const freshT = freshReg.threads?.[tid];
          if (freshT && !freshT.notifiedCoordinatorAt) {
            freshT.notifiedCoordinatorAt = now;
          }
        }
      });
    }

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

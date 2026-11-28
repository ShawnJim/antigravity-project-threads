import { resolveLsEndpoint } from '../lib/ls-client.mjs';
import {
  addDecision,
  archiveThread,
  buildBoardDecisions,
  dismissDecision,
  dispatchThread,
  getThreadDetail,
  getThreadDisplayId,
  initCoordinator,
  listDecisions,
  resolveDecision,
  resolveProjectScope,
  sendThreadMessage,
  syncThreads,
  updateProjectMemory,
} from '../lib/store.mjs';

// Warm endpoint cache if env vars are present
resolveLsEndpoint();

const SERVER_INFO = {
  name: 'project-threads-coordinator',
  version: '1.2.0-rc.1',
};

const TOOLS = [
  {
    name: 'init_project_coordinator',
    description:
      'Initialize and pin the current conversation as the ongoing Project Coordinator for this attention-first parallel engineering workspace, ensure isolated project memory exists (including default Worktree merge & archive conventions), and return the project coordination summary.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: {
          type: 'string',
          description: 'Absolute path to the target project/repository root (leave empty for workspace-less Antigravity Projects).',
        },
        conversationId: {
          type: 'string',
          description: 'Current Conversation ID (from <user_information> Conversation ID) to register as Coordinator so PreInvocation/PreToolUse/Stop hooks bind to this session.',
        },
        coordinatorId: {
          type: 'string',
          description: 'Alias for conversationId when registering or refreshing a Coordinator.',
        },
        projectId: {
          type: 'string',
          description: 'Optional Antigravity Project ID for strict project isolation.',
        },
        title: {
          type: 'string',
          description: 'Optional custom title for the Coordinator conversation.',
        },
        injectMergeConventions: {
          type: 'boolean',
          description: 'Whether to idempotently inject default Worktree merge & archive conventions into project-memory.md if not already present (default: true).',
        },
      },
      required: ['conversationId'],
    },
  },
  {
    name: 'dispatch_thread',
    description:
      'Spawn an asynchronous, isolated Worker Thread as a background Antigravity conversation via ConversationService inside the same Project. Automatically creates an isolated Git worktree & branch when a Git repository is present (unless createWorktree=false) and injects Shared Project Memory.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Short, descriptive task title for the thread in the user\'s active language (e.g., "Fix OAuth token refresh race" or "修复 OAuth 令牌刷新竞态").',
        },
        taskPrompt: {
          type: 'string',
          description: 'Complete self-contained instructions, context, reproduction steps, and acceptance criteria for the Worker Thread, written in the user\'s active language.',
        },
        workspacePath: {
          type: 'string',
          description: 'Absolute path of the main project repository (optional if coordinatorId/conversationId/projectId is provided).',
        },
        coordinatorId: {
          type: 'string',
          description: 'Conversation ID of the bound Project Coordinator (ensures strict project isolation).',
        },
        conversationId: {
          type: 'string',
          description: 'Current conversation ID when dispatching from an unbound or workspace-less Project session.',
        },
        projectId: {
          type: 'string',
          description: 'Optional Antigravity Project ID to spawn the Worker Thread into.',
        },
        branch: {
          type: 'string',
          description: 'Optional Git branch name (defaults to thread/<id>-<slug>, or auto-detected when registering an existing worktreePath).',
        },
        baseRef: {
          type: 'string',
          description: 'Optional Git base branch or commit ref to branch from (defaults to current branch / HEAD).',
        },
        worktreePath: {
          type: 'string',
          description: 'Optional existing Git worktree directory path to register on this thread when createWorktree=false (enables Git status tracking and archive cleanup).',
        },
        model: {
          type: 'string',
          description:
            'Optional model override: tier alias ("pro", "flash", "flash_lite") or concrete model ID / enum. Omit by default to use the user\'s configured default model in Settings (worktree vs read-only vs review based on threadType / createWorktree); pass only when overriding.',
        },
        threadType: {
          type: 'string',
          enum: ['worktree', 'readonly', 'review'],
          description:
            'Optional thread type / purpose: "worktree" (code editing in isolated Git worktree), "readonly" (fast read-only investigation), or "review" (code review / cross-review; uses the user\'s configured Review default model in Settings and defaults createWorktree to false when omitted). If omitted, inferred from createWorktree (true -> "worktree", false -> "readonly").',
        },
        createWorktree: {
          type: 'boolean',
          description:
            'Whether to create an isolated Git worktree for this thread (defaults to false when threadType is "review" or "readonly", otherwise true).',
        },
      },
      required: ['title', 'taskPrompt'],
    },
  },
  {
    name: 'list_threads',
    description:
      'Sync and list Worker Threads strictly isolated to the specified project/workspace/coordinator, including live ConversationService runState (RUNNING / IDLE), Git worktree branch, dirty file count, commits ahead, conversation:// link, and latest summary.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: {
          type: 'string',
          description: 'Absolute path of the project repository to filter by.',
        },
        coordinatorId: {
          type: 'string',
          description: 'Coordinator conversation ID to resolve project scope when workspacePath is empty.',
        },
        conversationId: {
          type: 'string',
          description: 'Current conversation ID to resolve project scope.',
        },
        projectId: {
          type: 'string',
          description: 'Optional Antigravity Project ID to filter by.',
        },
        includeArchived: {
          type: 'boolean',
          description: 'Whether to include archived threads (default: false).',
        },
        allWorkspaces: {
          type: 'boolean',
          description: 'List threads across all workspaces/projects on this machine (default: false).',
        },
      },
    },
  },
  {
    name: 'get_thread_detail',
    description:
      'Inspect full metadata, Git status, and latest completion summary of a specific Worker Thread by project-local ID (e.g. "thr-001"), legacy sequence (e.g. "#1"), internal threadId, or conversationId. Enforces strict fail-closed cross-project isolation: callers must pass project scope parameters (workspacePath / coordinatorId / conversationId / projectId), or explicitly pass scope="*" for unscoped global threadId access. Refreshes only the target thread.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description:
            'Project-local Thread ID (e.g., "thr-001"), legacy project-local sequence (e.g., "#1" — must include leading "#"), internal/global threadId, or Antigravity conversation UUID.',
        },
        workspacePath: {
          type: 'string',
          description:
            'Absolute path of the project repository (required with or instead of coordinatorId/projectId for fail-closed project isolation and "#N" lookup).',
        },
        coordinatorId: {
          type: 'string',
          description:
            'Coordinator conversation ID (required with or instead of workspacePath/projectId for fail-closed project isolation and "#N" lookup).',
        },
        conversationId: {
          type: 'string',
          description: 'Current conversation ID to resolve project scope.',
        },
        projectId: {
          type: 'string',
          description: 'Antigravity Project ID for strict project isolation.',
        },
        scope: {
          type: 'string',
          enum: ['*'],
          description:
            'Explicit opt-out ("*") to allow unscoped global threadId/conversationId lookup when no project scope parameters are provided (never permits "#N" local lookup).',
        },
      },
      required: ['threadId'],
    },
  },
  {
    name: 'update_project_memory',
    description:
      'Read, list, update, or delete two-tier isolated Shared Project Memory: a concise thin index (.agents/rules/project-memory.md, target <= 60 lines / ~4KB) plus on-demand topic knowledge files (.agents/memory/<topic>.md), automatically keeping the thin-index topic table in sync and broadcasting updates to all active Worker Thread worktrees. Anti-bloat discipline: when existing conventions change, conflict, or memory grows beyond budget, call mode="read" first and consolidate/deduplicate using mode="replace" (or move domain details into a topic file via `topic`) rather than endlessly appending. Omitting `topic` remains 100% backward-compatible with legacy single-file usage.',
    inputSchema: {
      type: 'object',
      properties: {
        workspacePath: {
          type: 'string',
          description: 'Absolute path of the project repository.',
        },
        coordinatorId: {
          type: 'string',
          description: 'Coordinator conversation ID to resolve project memory scope when workspacePath is empty.',
        },
        conversationId: {
          type: 'string',
          description: 'Current conversation ID to resolve project memory scope.',
        },
        projectId: {
          type: 'string',
          description: 'Optional Antigravity Project ID to resolve project memory scope.',
        },
        mode: {
          type: 'string',
          enum: ['read', 'append', 'replace', 'list', 'delete'],
          description:
            'Operation mode: "read" (inspect thin index or specified topic), "list" (list thin index budget + all topic files), "append" (add a concise bullet), "replace" (rewrite/consolidate thin index or create/overwrite a topic file), or "delete" (remove a topic file and update the thin index table).',
        },
        topic: {
          type: 'string',
          description:
            'Optional lowercase kebab-case topic ID (e.g. "ls-rpc", "sidecar-ui") targeting .agents/memory/<topic>.md. Omit to read/update the thin index (.agents/rules/project-memory.md).',
        },
        createOnly: {
          type: 'boolean',
          description:
            'When true with `topic`, reject with a conflict error if `.agents/memory/<topic>.md` already exists instead of overwriting it.',
        },
        title: {
          type: 'string',
          description: 'Optional human-readable topic title stored in topic metadata and the thin index table.',
        },
        summary: {
          type: 'string',
          description: 'Optional concise one-line summary for the thin index table when creating/updating a topic.',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional trigger keywords or module paths (e.g. ["sidecars/threads/", "app.js", "DOM"]) used by dispatch_thread to recommend this topic on demand.',
        },
        section: {
          type: 'string',
          description: 'Markdown H2 section heading when mode="append" (default: "Active Decisions & Constraints" for thin index).',
        },
        content: {
          type: 'string',
          description: 'Note or markdown content to append or replace.',
        },
      },
    },
  },
  {
    name: 'send_thread_message',
    description:
      'Send a follow-up instruction or question to an existing Worker Thread in the background without navigating away from the center Coordinator session. Enforces strict fail-closed cross-project isolation: callers must pass project scope parameters (workspacePath / coordinatorId / conversationId / projectId), or explicitly pass scope="*" for unscoped global threadId access.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description:
            'Target project-local Thread ID (e.g., "thr-001"), legacy sequence (e.g., "#1" — must include leading "#"), internal/global threadId, or conversation UUID.',
        },
        message: {
          type: 'string',
          description: 'Follow-up instruction, clarification, or feedback to send to the Worker Thread.',
        },
        workspacePath: {
          type: 'string',
          description:
            'Absolute path of the project repository (required with or instead of coordinatorId/projectId for fail-closed project isolation and "#N" lookup).',
        },
        coordinatorId: {
          type: 'string',
          description:
            'Coordinator conversation ID (required with or instead of workspacePath/projectId for fail-closed project isolation and "#N" lookup).',
        },
        conversationId: {
          type: 'string',
          description: 'Current conversation ID to resolve project scope.',
        },
        projectId: {
          type: 'string',
          description: 'Antigravity Project ID for strict project isolation.',
        },
        scope: {
          type: 'string',
          enum: ['*'],
          description:
            'Explicit opt-out ("*") to allow unscoped global threadId/conversationId messaging when no project scope parameters are provided.',
        },
      },
      required: ['threadId', 'message'],
    },
  },
  {
    name: 'archive_thread',
    description:
      'Archive a completed or obsolete Worker Thread conversation (hides it from active lists while preserving its transcript) and safely remove its clean, merged Git worktree & branch (unless dirty or unmerged). Enforces strict fail-closed cross-project isolation: callers must pass project scope parameters (workspacePath / coordinatorId / conversationId / projectId), or explicitly pass scope="*" for unscoped global threadId access.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description:
            'Project-local Thread ID (e.g., "thr-001"), legacy sequence (e.g., "#1" — must include leading "#"), internal/global threadId, or conversation UUID.',
        },
        workspacePath: {
          type: 'string',
          description:
            'Absolute path of the project repository (required with or instead of coordinatorId/projectId for fail-closed project isolation and "#N" lookup).',
        },
        coordinatorId: {
          type: 'string',
          description:
            'Coordinator conversation ID (required with or instead of workspacePath/projectId for fail-closed project isolation and "#N" lookup).',
        },
        conversationId: {
          type: 'string',
          description: 'Current conversation ID to resolve project scope.',
        },
        projectId: {
          type: 'string',
          description: 'Antigravity Project ID for strict project isolation.',
        },
        scope: {
          type: 'string',
          enum: ['*'],
          description:
            'Explicit opt-out ("*") to allow unscoped global threadId/conversationId archiving when no project scope parameters are provided.',
        },
        removeWorktree: {
          type: 'boolean',
          description: 'Whether to remove the thread Git worktree when clean and merged (default: true).',
        },
        forceWorktree: {
          type: 'boolean',
          description: 'Force removal even when uncommitted changes or unmerged commits exist (default: false).',
        },
        deleteBranch: {
          type: 'boolean',
          description: 'Also delete the thread Git branch after worktree removal (default: true).',
        },
      },
      required: ['threadId'],
    },
  },
  {
    name: 'manage_decisions',
    description:
      'Register, list, resolve, or dismiss Pending Decisions pinned at the top of the right-hand Project Threads board. Not limited to Worker Thread callbacks — use action="add" whenever ANY Coordinator reply asks the user to make a call (everyday planning discussions, architecture/design trade-offs, open Issue vs. implement directly, scheduling, branch merge, release, or cleanup) with 1–3 quick-action buttons, and promptly call action="resolve" once the user decides directly in chat.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'list', 'resolve', 'dismiss'],
          description: 'Operation to perform: "add", "list", "resolve", or "dismiss".',
        },
        coordinatorId: {
          type: 'string',
          description: 'Coordinator conversation ID to scope decisions to the active project.',
        },
        conversationId: {
          type: 'string',
          description: 'Current conversation ID when resolving project scope.',
        },
        workspacePath: {
          type: 'string',
          description: 'Absolute path of the project repository.',
        },
        projectId: {
          type: 'string',
          description: 'Optional Antigravity Project ID for strict project isolation.',
        },
        threadId: {
          type: 'string',
          description: 'Optional associated Worker Thread ID (e.g. "thr-044") to badge and link on the board.',
        },
        title: {
          type: 'string',
          description: 'Concise one-line decision title in the user\'s active language (required when action="add").',
        },
        summary: {
          type: 'string',
          description: 'Optional brief context or trade-off summary (1–2 sentences).',
        },
        options: {
          type: 'array',
          description: '1–3 quick-action buttons displayed on the decision card (when action="add").',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Optional option identifier (e.g. "opt-merge").' },
              label: { type: 'string', description: 'Short button label in the user\'s active language.' },
              action: {
                type: 'string',
                enum: ['send_coordinator', 'archive_thread', 'dismiss'],
                description: 'Action executed when clicked (default: "send_coordinator").',
              },
              message: {
                type: 'string',
                description: 'Instruction text sent back to the Coordinator when action="send_coordinator".',
              },
              style: {
                type: 'string',
                enum: ['primary', 'secondary', 'danger'],
                description: 'Visual emphasis of the button.',
              },
            },
            required: ['label'],
          },
        },
        decisionId: {
          type: 'string',
          description: 'Decision ID (e.g. "dec-001") or auto-decision key (required for "resolve" / "dismiss").',
        },
        optionId: {
          type: 'string',
          description: 'Optional chosen option ID when action="resolve".',
        },
        optionLabel: {
          type: 'string',
          description: 'Optional chosen option label when action="resolve".',
        },
        includeResolved: {
          type: 'boolean',
          description: 'When action="list", include resolved/dismissed explicit decisions (default: false).',
        },
        includeAuto: {
          type: 'boolean',
          description: 'When action="list", include automatic Worktree merge/archive hints (default: true).',
        },
      },
      required: ['action'],
    },
  },
];

function formatThreadIdLabel(t) {
  if (!t) return '';
  const displayId = getThreadDisplayId(t);
  return displayId ? `\`${displayId}\`` : '';
}

function formatThreadsMarkdown(snapshot) {
  const lines = [];
  if (snapshot.coordinator) {
    const c = snapshot.coordinator;
    lines.push(
      `**Coordinator**: ${c.title}` +
        (c.conversationId ? ` ([Open](conversation://${c.conversationId}))` : '') +
        (c.repoRoot ? ` | Repo: \`${c.repoRoot}\`` : ''),
    );
  }
  if (!snapshot.threads.length) {
    lines.push('No active worker threads found.');
    return lines.join('\n');
  }

  lines.push('', '| ID | Status | Thread | Branch / Worktree | Git | Summary |', '|---|---|---|---|---|---|');
  for (const t of snapshot.threads) {
    const state = t.archived
      ? 'ARCHIVED'
      : t.runState === 'RUN_STATE_RUNNING'
        ? 'RUNNING'
        : t.runState === 'RUN_STATE_IDLE'
          ? 'IDLE'
          : t.runState;
    const idCell = formatThreadIdLabel(t) || '-';
    const link = `[${t.title}](conversation://${t.conversationId})`;
    const br = t.branch ? `\`${t.branch}\`` : '-';
    const git = t.git
      ? `+${t.git.aheadCount || 0} commits${t.git.merged && t.git.aheadCount > 0 ? ` (${t.git.mergeMethod || 'merged'})` : ''}, ${t.git.dirtyCount || 0} dirty`
      : '-';
    const sum = (t.lastSummary || '').replace(/\r?\n+/g, ' ').slice(0, 90);
    lines.push(`| ${idCell} | **${state}** | ${link} | ${br} | ${git} | ${sum || '-'} |`);
  }
  return lines.join('\n');
}

async function handleToolCall(name, args = {}) {
  switch (name) {
    case 'init_project_coordinator': {
      const coord = await initCoordinator(args);
      const scopeLine = coord.repoRoot
        ? `- Git Repository Root: \`${coord.repoRoot}\` (branch: \`${coord.defaultBranch}\`)`
        : coord.workspacePath
          ? `- Workspace: \`${coord.workspacePath}\``
          : `- Project Scope: \`${coord.key}\``;
      const text = [
        `Initialized Project Coordinator: **${coord.title}**`,
        coord.conversationId ? `- Coordinator Session: [${coord.title}](conversation://${coord.conversationId})` : '',
        scopeLine,
        coord.projectId ? `- Antigravity Project ID: \`${coord.projectId}\`` : '',
        `- Group ID: \`${coord.groupId}\``,
        `- Shared Project Memory: \`${coord.memoryPath}\``,
        `- Side Panel Shortcut: [Project Threads](sidecar://project-threads/threads/)`,
      ]
        .filter(Boolean)
        .join('\n');
      return { content: [{ type: 'text', text }], structuredContent: coord };
    }

    case 'dispatch_thread': {
      const dispatchArgs = { ...args };
      if (!dispatchArgs.model) delete dispatchArgs.model;
      const t = await dispatchThread(dispatchArgs);
      const displayId = getThreadDisplayId(t) || t.threadId;
      const idHeading = `**\`${displayId}\`**`;
      const threadTypeLabel = t.threadType || (t.worktreePath ? 'worktree' : 'readonly');
      const text = [
        `Dispatched Worker Thread ${idHeading}: [${t.title}](conversation://${t.conversationId})`,
        `- Conversation ID: \`${t.conversationId}\``,
        `- Project Scope: \`${t.workspaceKey}\`${t.projectId ? ` (projectId: \`${t.projectId}\`)` : ''}`,
        `- Model: \`${t.modelDisplayName || t.model}\` | Type: \`${threadTypeLabel}\` | Initial State: \`${t.runState}\``,
        t.worktreePath ? `- Isolated Git Worktree: \`${t.worktreePath}\`` : '- Git Worktree: (disabled or non-git workspace)',
        t.branch ? `- Assigned Branch: \`${t.branch}\` (from \`${t.baseRef}\`)` : '',
      ]
        .filter(Boolean)
        .join('\n');
      return { content: [{ type: 'text', text }], structuredContent: t };
    }

    case 'list_threads': {
      const snap = await syncThreads(args);
      return {
        content: [{ type: 'text', text: formatThreadsMarkdown(snap) }],
        structuredContent: snap,
      };
    }

    case 'get_thread_detail': {
      try {
        const allowUnscoped = String(args.scope || '').trim() === '*';
        const t = await getThreadDetail({
          threadId: args.threadId || '',
          workspacePath: args.workspacePath || '',
          coordinatorId: args.coordinatorId || '',
          conversationId: args.conversationId || '',
          projectId: args.projectId || '',
          requireScope: !allowUnscoped,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(t, null, 2) }],
          structuredContent: t,
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err.message }],
        };
      }
    }

    case 'update_project_memory': {
      try {
        const rawTopic = String(args.topic || '').trim();
        const mode = String(
          args.mode || (args.content !== undefined && args.content !== '' ? (rawTopic ? 'replace' : 'append') : 'read'),
        )
          .trim()
          .toLowerCase();
        const result = await updateProjectMemory({
          workspacePath: args.workspacePath || '',
          conversationId: args.conversationId || args.coordinatorId || '',
          coordinatorId: args.coordinatorId || '',
          projectId: args.projectId || '',
          content: args.content !== undefined ? String(args.content) : '',
          mode,
          section: args.section,
          topic: rawTopic,
          title: args.title || '',
          summary: args.summary || '',
          keywords: args.keywords,
          createOnly: Boolean(args.createOnly),
        });

        const budgetNote = result?.budgetWarning ? `\n\n> Thin Index Budget Notice: ${result.budgetWarning}` : '';

        if (mode === 'list') {
          const topics = Array.isArray(result.topics) ? result.topics : [];
          const budget = result.budget || {};
          const lines = [
            `Shared Project Memory Thin Index: \`${result.path || '(unresolved)'}\` (${budget.lineCount || 0} lines, ${budget.byteSize || 0} bytes)`,
          ];
          if (topics.length > 0) {
            lines.push(
              '',
              '| `topic` ID | Topic | Keywords / Paths | Summary | Size |',
              '| :--- | :--- | :--- | :--- | :--- |',
              ...topics.map(
                (t) =>
                  `| \`${t.id}\` | ${String(t.title || t.id).replace(/\|/g, '\\|')} | ${(t.keywords || []).map((k) => `\`${String(k).replace(/\|/g, '\\|')}\``).join(', ')} | ${String(t.summary || '-').replace(/\|/g, '\\|')} | ${t.lineCount || 0}L / ${t.byteSize || 0}B |`,
              ),
            );
          } else {
            lines.push('', 'No topic knowledge files yet (`.agents/memory/<topic>.md`).');
          }
          return {
            content: [{ type: 'text', text: `${lines.join('\n')}${budgetNote}` }],
            structuredContent: result,
          };
        }

        if (mode === 'read') {
          if (rawTopic) {
            const topicRec = result.topic || result;
            const text = topicRec?.exists
              ? `Topic \`${topicRec.id}\` (\`${topicRec.relativePath || topicRec.path}\`)\nTitle: ${topicRec.title}\nKeywords: ${(topicRec.keywords || []).join(', ')}\nSummary: ${topicRec.summary || '-'}\n\n${topicRec.content || ''}`
              : `(Topic "${rawTopic}" does not exist yet at ${topicRec?.path || '.agents/memory/'})`;
            return {
              content: [{ type: 'text', text }],
              structuredContent: result,
            };
          }
          return {
            content: [
              {
                type: 'text',
                text:
                  (result.content ||
                    (result.path
                      ? `(Empty memory at ${result.path})`
                      : '(No project scope resolved; provide workspacePath or coordinatorId/conversationId)')) +
                  budgetNote,
              },
            ],
            structuredContent: result,
          };
        }

        if (mode === 'delete') {
          const text = result.deleted
            ? `Deleted topic \`${result.id}\` (\`${result.path}\`), refreshed thin index table, and synced to active worktrees.${budgetNote}`
            : `Topic \`${result.id}\` did not exist on disk; ensured thin index table is clean and synced to active worktrees.${budgetNote}`;
          return {
            content: [{ type: 'text', text }],
            structuredContent: result,
          };
        }

        if (rawTopic) {
          const tRec = result.topic || {};
          return {
            content: [
              {
                type: 'text',
                text: `Updated topic \`${tRec.id || rawTopic}\` (\`${tRec.relativePath || tRec.path || ''}\`), refreshed thin index table, and synced to active worktrees.${budgetNote}\n\n${tRec.content || ''}`,
              },
            ],
            structuredContent: result,
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: `Updated Shared Project Memory (\`${result.path}\`) and synced to active worktrees.${budgetNote}\n\n${result.content}`,
            },
          ],
          structuredContent: result,
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: err.message }],
        };
      }
    }

    case 'send_thread_message': {
      const allowUnscoped = String(args.scope || '').trim() === '*';
      const res = await sendThreadMessage({
        ...args,
        requireScope: !allowUnscoped,
      });
      const displayId = getThreadDisplayId(res.thread) || res.thread.threadId;
      const idLabel = `**\`${displayId}\`**`;
      return {
        content: [
          {
            type: 'text',
            text: `Sent follow-up message to ${idLabel} (${res.thread.title}). It is now running in the background; live progress is visible in the right-hand Project Threads panel.`,
          },
        ],
        structuredContent: res,
      };
    }

    case 'archive_thread': {
      const allowUnscoped = String(args.scope || '').trim() === '*';
      const res = await archiveThread(args.threadId, {
        workspacePath: args.workspacePath || '',
        coordinatorId: args.coordinatorId || '',
        conversationId: args.conversationId || '',
        projectId: args.projectId || '',
        requireScope: !allowUnscoped,
        removeWorktree: args.removeWorktree !== undefined ? Boolean(args.removeWorktree) : true,
        forceWorktree: Boolean(args.forceWorktree),
        deleteBranch: args.deleteBranch !== undefined ? Boolean(args.deleteBranch) : true,
      });
      const removedPath = res.removedWorktreePath || res.thread?.worktreePath || '';
      const branchName = res.deletedBranch || res.thread?.branch || '';
      const displayId = getThreadDisplayId(res.thread) || res.thread?.threadId || '';
      const idLabel = `\`${displayId}\``;
      const lines = [
        `Archived thread ${idLabel} ([${res.thread.title}](conversation://${res.thread.conversationId})).`,
        `- Worktree removed: \`${res.worktreeRemoved}\`${res.worktreeRemoved && removedPath ? ` (\`${removedPath}\`)` : ''}`,
        `- Branch deleted: \`${res.branchDeleted}\`${res.branchDeleted && branchName ? ` (\`${branchName}\`)` : ''}`,
      ];
      if (res.pruned) {
        lines.push(`- Pruned stale worktree entry (\`${removedPath}\` was already missing on disk).`);
      }
      if (res.skippedReason) {
        lines.push(`- Skipped reason: \`${res.skippedReason}\``);
      }
      if (res.worktreeError) {
        lines.push(`- Worktree notice: ${res.worktreeError}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], structuredContent: res };
    }

    case 'manage_decisions': {
      const action = String(args.action || '').trim().toLowerCase();
      if (!['add', 'list', 'resolve', 'dismiss'].includes(action)) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Invalid action "${args.action || ''}". Expected one of: add, list, resolve, dismiss.`,
            },
          ],
        };
      }

      if (action === 'add') {
        const title = String(args.title || '').trim();
        if (!title) {
          return {
            isError: true,
            content: [{ type: 'text', text: '`title` is required when action="add".' }],
          };
        }
        const scope = await resolveProjectScope({
          workspacePath: args.workspacePath || '',
          conversationId: args.conversationId || args.coordinatorId || '',
          coordinatorId: args.coordinatorId || '',
          projectId: args.projectId || '',
        });
        const created = addDecision({
          workspaceKey: scope.scopeKey || '',
          workspacePath: args.workspacePath || scope.baseDir || '',
          projectId: args.projectId || scope.projectId || '',
          coordinatorId: args.coordinatorId || args.conversationId || '',
          conversationId: args.conversationId || '',
          threadId: args.threadId || '',
          title,
          summary: args.summary || '',
          options: args.options,
        });
        const optLabels = (created.options || []).map((o) => `\`${o.label}\` (${o.action})`).join(', ');
        const linkedDisplayId = created.threadLocalId || created.threadId;
        const text = [
          `Pinned Pending Decision **\`${created.id}\`**: ${created.title}`,
          created.threadId ? `- Linked Thread: \`${linkedDisplayId}\`` : '',
          created.summary ? `- Summary: ${created.summary}` : '',
          optLabels ? `- Quick Actions: ${optLabels}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        return { content: [{ type: 'text', text }], structuredContent: created };
      }

      if (action === 'list') {
        const scope = await resolveProjectScope({
          workspacePath: args.workspacePath || '',
          conversationId: args.conversationId || args.coordinatorId || '',
          coordinatorId: args.coordinatorId || '',
          projectId: args.projectId || '',
        });
        const scopeParams = {
          workspaceKey: scope.scopeKey || '',
          workspacePath: args.workspacePath || scope.baseDir || '',
          projectId: args.projectId || scope.projectId || '',
          coordinatorId: args.coordinatorId || '',
          conversationId: args.conversationId || '',
          includeResolved: Boolean(args.includeResolved),
        };
        const includeAuto = args.includeAuto !== false;
        let items;
        if (args.includeResolved) {
          const explicitAll = listDecisions(scopeParams);
          const autoPending = includeAuto
            ? buildBoardDecisions(scopeParams).filter((d) => d.source === 'auto')
            : [];
          items = [...explicitAll, ...autoPending];
        } else {
          items = includeAuto ? buildBoardDecisions(scopeParams) : listDecisions(scopeParams);
        }
        const lines = items.length
          ? [
              '| ID | Source | Status | Thread | Title |',
              '|---|---|---|---|---|',
              ...items.map(
                (d) =>
                  `| \`${d.id}\` | ${d.source || 'explicit'} | ${d.status || 'pending'} | ${d.threadId ? `\`${d.threadLocalId || d.threadId}\`` : '-'} | ${String(d.title || '').replace(/\|/g, '\\|')} |`,
              ),
            ]
          : ['No pending decisions found for this project scope.'];
        return {
          content: [{ type: 'text', text: lines.join('\n') }],
          structuredContent: { scopeKey: scope.scopeKey || '', decisions: items },
        };
      }

      if (action === 'resolve') {
        const decisionId = String(args.decisionId || '').trim();
        if (!decisionId) {
          return {
            isError: true,
            content: [{ type: 'text', text: '`decisionId` is required when action="resolve".' }],
          };
        }
        const updated = resolveDecision({
          decisionId,
          optionId: args.optionId || '',
          optionLabel: args.optionLabel || '',
        });
        const text = `Resolved decision \`${updated.id}\` (${updated.title})${updated.resolvedOptionLabel ? ` — chosen: **${updated.resolvedOptionLabel}**` : ''}.`;
        return { content: [{ type: 'text', text }], structuredContent: updated };
      }

      // action === 'dismiss'
      const decisionId = String(args.decisionId || '').trim();
      if (!decisionId && !args.threadId) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: '`decisionId` (or `threadId`) is required when action="dismiss".',
            },
          ],
        };
      }
      const dismissed = dismissDecision(decisionId || { threadId: args.threadId });
      const text = `Dismissed decision \`${dismissed.decisionId || dismissed.key || decisionId}\`.`;
      return { content: [{ type: 'text', text }], structuredContent: dismissed };
    }

    default:
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      };
  }
}

function sendJson(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function dispatchRpc(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { id, method, params } = msg;

  // Notifications have no id
  if (id === undefined || id === null) return;

  try {
    if (method === 'initialize') {
      const requested = params?.protocolVersion || '2024-11-05';
      const protocolVersion = ['2025-03-26', '2024-11-05'].includes(requested)
        ? requested
        : '2024-11-05';
      sendJson({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        },
      });
      return;
    }

    if (method === 'ping') {
      sendJson({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      sendJson({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }

    if (method === 'tools/call') {
      const toolResult = await handleToolCall(params?.name, params?.arguments || {});
      sendJson({ jsonrpc: '2.0', id, result: toolResult });
      return;
    }

    sendJson({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (err) {
    sendJson({
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: `Error: ${err.message}` }],
      },
    });
  }
}

// Stdio reader supporting standard MCP newline-delimited JSON (preserves request ordering)
let buffer = '';
let rpcQueue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line || line.startsWith('Content-Length:')) continue;
    try {
      const parsed = JSON.parse(line);
      rpcQueue = rpcQueue.then(() => dispatchRpc(parsed));
    } catch (err) {
      process.stderr.write(`[project-threads mcp] parse error: ${err.message}\n`);
    }
  }
});

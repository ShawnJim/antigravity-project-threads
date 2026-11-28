import { resolveLsEndpoint } from '../lib/ls-client.mjs';
import {
  archiveThread,
  dispatchThread,
  initCoordinator,
  loadRegistry,
  readProjectMemory,
  resolveProjectScope,
  sendThreadMessage,
  syncThreads,
  updateProjectMemory,
} from '../lib/store.mjs';

// Warm endpoint cache if env vars are present
resolveLsEndpoint();

const SERVER_INFO = {
  name: 'project-threads-coordinator',
  version: '1.1.0',
};

const TOOLS = [
  {
    name: 'init_project_coordinator',
    description:
      'Initialize and pin the current conversation as the ongoing Project Coordinator (Claude Projects style), ensure isolated project memory exists, and return the project coordination summary.',
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
          description: 'Optional Git branch name (defaults to thread/<id>-<slug>).',
        },
        baseRef: {
          type: 'string',
          description: 'Optional Git base branch or commit ref to branch from (defaults to current branch / HEAD).',
        },
        model: {
          type: 'string',
          description:
            'Optional model override: tier alias ("pro", "flash", "flash_lite") or concrete model ID / enum. Omit by default to use the user\'s configured default model in Settings (worktree vs read-only); pass only when overriding.',
        },
        createWorktree: {
          type: 'boolean',
          description: 'Whether to create an isolated Git worktree for this thread (default: true).',
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
    description: 'Inspect full metadata, Git status, and latest completion summary of a specific Worker Thread by threadId (e.g. thr-001) or conversationId.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description: 'Thread ID (e.g., "thr-001") or Antigravity conversation UUID.',
        },
      },
      required: ['threadId'],
    },
  },
  {
    name: 'update_project_memory',
    description:
      'Read or update the isolated Project Memory (.agents/rules/project-memory.md or per-project memory file) and automatically broadcast updates to all active Worker Thread worktrees in the same project.',
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
          enum: ['read', 'append', 'replace'],
          description: 'Use "read" to inspect memory, "append" to add a decision bullet under `section`, or "replace" to rewrite the full file.',
        },
        section: {
          type: 'string',
          description: 'Markdown H2 section heading when mode="append" (default: "Active Decisions & Constraints").',
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
      'Send a follow-up instruction or question to an existing Worker Thread in the background without navigating away from the center Coordinator session.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description: 'Target Thread ID (e.g., "thr-001") or conversation UUID.',
        },
        message: {
          type: 'string',
          description: 'Follow-up instruction, clarification, or feedback to send to the Worker Thread.',
        },
      },
      required: ['threadId', 'message'],
    },
  },
  {
    name: 'archive_thread',
    description:
      'Archive a completed or obsolete Worker Thread conversation (hides it from active lists while preserving its transcript) and safely remove its clean, merged Git worktree & branch (unless dirty or unmerged).',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description: 'Thread ID (e.g., "thr-001") or conversation UUID.',
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
];

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
    const link = `[${t.title}](conversation://${t.conversationId})`;
    const br = t.branch ? `\`${t.branch}\`` : '-';
    const git = t.git
      ? `+${t.git.aheadCount || 0} commits, ${t.git.dirtyCount || 0} dirty`
      : '-';
    const sum = (t.lastSummary || '').replace(/\r?\n+/g, ' ').slice(0, 90);
    lines.push(`| \`${t.threadId}\` | **${state}** | ${link} | ${br} | ${git} | ${sum || '-'} |`);
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
      const text = [
        `Dispatched Worker Thread **\`${t.threadId}\`**: [${t.title}](conversation://${t.conversationId})`,
        `- Conversation ID: \`${t.conversationId}\``,
        `- Project Scope: \`${t.workspaceKey}\`${t.projectId ? ` (projectId: \`${t.projectId}\`)` : ''}`,
        `- Model: \`${t.modelDisplayName || t.model}\` | Initial State: \`${t.runState}\``,
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
      await syncThreads({ includeArchived: true, allWorkspaces: true });
      const reg = loadRegistry();
      const t =
        reg.threads[args.threadId] ||
        Object.values(reg.threads).find((x) => x.conversationId === args.threadId);
      if (!t) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Thread not found: ${args.threadId}` }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(t, null, 2) }],
        structuredContent: t,
      };
    }

    case 'update_project_memory': {
      const mode = args.mode || (args.content ? 'append' : 'read');
      if (mode === 'read') {
        const scope = await resolveProjectScope({
          workspacePath: args.workspacePath || '',
          conversationId: args.conversationId || args.coordinatorId || '',
          coordinatorId: args.coordinatorId || '',
          projectId: args.projectId || '',
        });
        const mem = scope.scopeKey
          ? readProjectMemory(scope.baseDir, scope.scopeKey)
          : { path: '', content: '' };
        return {
          content: [
            {
              type: 'text',
              text:
                mem.content ||
                (mem.path
                  ? `(Empty memory at ${mem.path})`
                  : '(No project scope resolved; provide workspacePath or coordinatorId/conversationId)'),
            },
          ],
          structuredContent: mem,
        };
      }
      const updated = await updateProjectMemory({
        workspacePath: args.workspacePath || '',
        conversationId: args.conversationId || args.coordinatorId || '',
        coordinatorId: args.coordinatorId || '',
        projectId: args.projectId || '',
        content: args.content || '',
        mode,
        section: args.section,
      });
      return {
        content: [
          {
            type: 'text',
            text: `Updated Shared Project Memory (\`${updated.path}\`) and synced to active worktrees.\n\n${updated.content}`,
          },
        ],
        structuredContent: updated,
      };
    }

    case 'send_thread_message': {
      const res = await sendThreadMessage(args);
      return {
        content: [
          {
            type: 'text',
            text: `Sent follow-up message to **\`${res.thread.threadId}\`** (${res.thread.title}). It is now running in the background; live progress is visible in the right-hand Project Threads panel.`,
          },
        ],
        structuredContent: res,
      };
    }

    case 'archive_thread': {
      const res = await archiveThread(args.threadId, {
        removeWorktree: args.removeWorktree !== undefined ? Boolean(args.removeWorktree) : true,
        forceWorktree: Boolean(args.forceWorktree),
        deleteBranch: args.deleteBranch !== undefined ? Boolean(args.deleteBranch) : true,
      });
      const removedPath = res.removedWorktreePath || res.thread?.worktreePath || '';
      const branchName = res.deletedBranch || res.thread?.branch || '';
      const lines = [
        `Archived thread \`${res.thread.threadId}\` ([${res.thread.title}](conversation://${res.thread.conversationId})).`,
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

// Stdio reader supporting standard MCP newline-delimited JSON
let buffer = '';
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
      dispatchRpc(parsed);
    } catch (err) {
      process.stderr.write(`[project-threads mcp] parse error: ${err.message}\n`);
    }
  }
});

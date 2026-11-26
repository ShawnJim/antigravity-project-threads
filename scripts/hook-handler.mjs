import { resolveLsEndpoint } from '../lib/ls-client.mjs';
import {
  inspectWorktreeGit,
  loadRegistry,
  saveRegistry,
  syncCompletionToCoordinator,
} from '../lib/store.mjs';
import { extractThreadCompletion } from '../lib/transcript.mjs';

const DIRECTIVE_VERSION = 6;

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

function summarizeCoordinatorThreads(reg, coord) {
  const scopeThreads = Object.values(reg.threads || {}).filter(
    (t) =>
      !t.archived &&
      (t.coordinatorId === coord.conversationId || (coord.key && t.workspaceKey === coord.key)),
  );
  const running = scopeThreads.filter((t) => t.runState === 'RUN_STATE_RUNNING').length;
  const ready = scopeThreads.length - running;
  return { total: scopeThreads.length, running, ready };
}

function buildTurnCoordinatorReminder(coord, reg) {
  const repo = coord.repoRoot || coord.workspacePath || '';
  const cid = coord.conversationId || '';
  const scopeLabel = repo || coord.title || coord.key || 'Current Project';
  const counts = summarizeCoordinatorThreads(reg, coord);
  return [
    `[Project Coordinator Standing Protocol — Scope: ${scopeLabel} | Threads: ${counts.running} running, ${counts.ready} idle]`,
    '当前会话处于常驻总控协调器（Coordinator）模式，本轮请继续严格遵守总控规范：',
    `1. 禁止调用 \`invoke_subagent\`（\`research\` / \`self\`）或 \`run_workflow\`，禁止直接在总控会话大面积读改业务代码；所有新排查或改动一律调用 \`project-threads_coordinator\` -> \`dispatch_thread\`（只读排查传 \`createWorktree: false\`，改代码传 \`createWorktree: true\`，必传 \`coordinatorId: ${JSON.stringify(cid)}\`, \`workspacePath: ${JSON.stringify(repo)}\`）。`,
    '2. 对已有线程补充指令请用 `send_thread_message`；若本轮是 `[THREAD_COMPLETION_SYNC]` 子线程完成回调，请按 `> **✅ [thr-xxx] <标题> · 执行完毕**（[查看完整线程](conversation://<id>)）` + 3–5 条核心要点 + 末尾 `---` 分段卡片格式输出，严禁针对回调重复新建线程。',
  ].join('\n');
}

function buildCoordinatorDirective(coord) {
  const repo = coord.repoRoot || coord.workspacePath || '';
  const cid = coord.conversationId || '';
  const scopeLabel = repo || coord.title || coord.key || 'Current Project';
  const hasRepo = Boolean(repo);
  return [
    `[Project Coordinator Standing Protocol — Bound Scope: ${scopeLabel}]`,
    '当前会话已永久绑定为项目总控协调器（Coordinator）。即使后续用户消息未输入 `/coord` 前缀，你也必须严格按总控模式运作：',
    '1. **严禁调用 `invoke_subagent`（如 `research` / `self`）或 `run_workflow`** 来派发项目任务——临时子代理不会进入右侧 Project Threads 看板！同样严禁在当前总控会话中直接大面积读取业务源码或修改代码。',
    '2. **所有新任务一律创建 Project Thread**：无论是代码修改、Bug 修复，还是“检查/排查/核实某处逻辑”的只读问题，都必须通过 `call_mcp_tool` 调用 `ServerName: "project-threads_coordinator"`, `ToolName: "dispatch_thread"` 创建可追踪的 `thr-xxx` 线程：',
    `   - **只读代码排查 / 逻辑核实 / 非仓库项目任务**：传 \`createWorktree: false\`, \`coordinatorId: ${JSON.stringify(cid)}\`, \`workspacePath: ${JSON.stringify(repo)}\`, \`model: "pro"\`（秒级启动，不额外克隆分支目录，同时在当前项目 Project Threads 看板生成 \`thr-xxx\` 线程卡片）。`,
    hasRepo
      ? `   - **代码修改 / 脚本编写 / Bug 修复**：传 \`createWorktree: true\`, \`coordinatorId: ${JSON.stringify(cid)}\`, \`workspacePath: ${JSON.stringify(repo)}\`（自动创建独立 Git Worktree 与分支隔离执行）。`
      : `   - **注意**：当前项目未绑定本地 Git 仓库目录，请保持 \`createWorktree: false\` 并必传 \`coordinatorId: ${JSON.stringify(cid)}\`。`,
    '3. **处理 `[THREAD_COMPLETION_SYNC]` 自动回传汇报（分段独立卡片样式）**：当子线程执行完毕时，系统会自动向你投递 `[THREAD_COMPLETION_SYNC]` 消息。为保证多个连续回调在总控会话中像多段独立会话一样清晰隔离，必须严格遵循：',
    '   - **首行引用标题横幅**：`> **✅ [thr-xxx] <任务标题> · 执行完毕**（[查看完整线程](conversation://<threadConvId>)）`',
    '   - **精炼要点列表**：仅输出 **3–5 条核心结论要点**（根因 / 关键变更或结论 / 待用户确认项），切勿将冗长日志或大表格倾倒至总控会话。',
    `   - **末尾分段分割线**：以 \`---\` 结束本段卡片（若有跨任务通用规则可顺带调用 \`update_project_memory\` 沉淀并传 \`coordinatorId: ${JSON.stringify(cid)}\`, \`workspacePath: ${JSON.stringify(repo)}\`）。`,
    '   - 若某条回调与此前已汇报结论重复，仅做 1 行简短确认或保持静默，不输出内部去重元信息；**严禁针对回调再次调用 `dispatch_thread` 重复建线程**！',
    `4. 当用户询问现有线程进度、向已有线程补充指令或要求归档时，调用 \`list_threads\`（必传 \`coordinatorId: ${JSON.stringify(cid)}\`, \`workspacePath: ${JSON.stringify(repo)}\`）/ \`get_thread_detail\` / \`send_thread_message\` / \`archive_thread\`。`,
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

  const reg = loadRegistry();

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
            `当前会话已绑定为 Project Coordinator 总控会话，禁止使用 ${toolName} 派发任务（子代理不会创建 Project Threads 看板卡片）。` +
            `请改用 call_mcp_tool 调用 ServerName="project-threads_coordinator", ToolName="dispatch_thread" 创建 thr-xxx 线程` +
            `（只读代码排查请传 createWorktree: false, coordinatorId: ${JSON.stringify(cid)}, workspacePath: ${JSON.stringify(repo)}；有 Git 仓库修改代码请传 createWorktree: true）。`,
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
          });
        } catch {
          // Fallback: still persist local summary & state if LS/agentapi was unreachable (unless waiting on bg task)
          const comp = extractThreadCompletion(convId, input.transcriptPath || '');
          if (!comp.waitingOnBackgroundTask) {
            if (comp.cardSummary) thread.lastSummary = comp.cardSummary;
            thread.runState = 'RUN_STATE_IDLE';
            thread.lastCompletedAt = new Date().toISOString();
            thread.updatedAt = thread.lastCompletedAt;
            if (thread.worktreePath) {
              thread.git = await inspectWorktreeGit(thread.worktreePath, thread.baseRef);
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
    const coord = Object.values(reg.coordinators).find((c) => c.conversationId === convId);
    if (!coord) {
      process.stdout.write('{}\n');
      return;
    }

    const messages = [];
    let dirty = false;
    const stepCount = Number(input.initialNumSteps) || 0;
    const invocationNum = Number(input.invocationNum || 1);
    const isTurnStart = !Number.isFinite(invocationNum) || invocationNum <= 1;
    const compacted = coord.lastStepCount && stepCount > 0 && stepCount < coord.lastStepCount;

    if (coord.directiveVersion !== DIRECTIVE_VERSION || compacted) {
      messages.push(buildCoordinatorDirective(coord));
      coord.directiveVersion = DIRECTIVE_VERSION;
      dirty = true;
    } else if (isTurnStart) {
      messages.push(buildTurnCoordinatorReminder(coord, reg));
    }
    if (stepCount > 0 && stepCount !== coord.lastStepCount) {
      coord.lastStepCount = stepCount;
      dirty = true;
    }

    // Fallback injection ONLY for threads that have NEVER been pushed/notified and are not waiting on a background task
    const newlyFinished = Object.values(reg.threads).filter((t) => {
      if (t.archived || t.coordinatorId !== convId || !t.lastCompletedAt) return false;
      if (t.pushedToCoordinatorAt || t.notifiedCoordinatorAt) return false;
      if (t.runState === 'RUN_STATE_RUNNING') return false;
      const comp = extractThreadCompletion(t.conversationId);
      if (comp.waitingOnBackgroundTask) return false;
      return true;
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
          '[Project Threads Update] 以下后台子线程也已完成：',
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

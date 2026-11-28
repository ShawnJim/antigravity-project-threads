import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  getThreadMessages,
  loadRegistry,
  saveRegistry,
  sendThreadMessage,
  syncThreads,
} from '../lib/store.mjs';
import { peekLiveActivity } from '../lib/transcript.mjs';

function createTempEnv(t, prefix = 'pt-steps-') {
  const tempRoot = mkdtempSync(join(tmpdir(), prefix));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  const stateDir = join(appDataDir, 'project-threads');
  mkdirSync(stateDir, { recursive: true });

  const envKeys = [
    'ANTIGRAVITY_GEMINI_DIR',
    'ANTIGRAVITY_APP_DATA_DIR',
    'ANTIGRAVITY_LS_ADDRESS',
    'ANTIGRAVITY_CSRF_TOKEN',
    'ANTIGRAVITY_AGENTAPI_EXE',
  ];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;
  delete process.env.ANTIGRAVITY_LS_ADDRESS;
  delete process.env.ANTIGRAVITY_CSRF_TOKEN;
  delete process.env.ANTIGRAVITY_AGENTAPI_EXE;

  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  return { tempRoot, geminiDir, appDataDir, stateDir };
}

function writeTranscript(appDataDir, convId, steps) {
  const txDir = join(appDataDir, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(txDir, { recursive: true });
  const txPath = join(txDir, 'transcript.jsonl');
  writeFileSync(txPath, `${steps.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');
  return txPath;
}

function makeUpdateStepsStep(stepIndex, stepsArr, createdAt) {
  return {
    step_index: stepIndex,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: createdAt,
    tool_calls: [
      {
        name: 'update_steps',
        args: {
          steps: JSON.stringify(stepsArr),
        },
      },
    ],
  };
}

test('peekLiveActivity retains latest stepsList/stepsProgress during and after turn 1, clears on turn 2 follow-up, and shows turn 2 updates', (t) => {
  const { appDataDir } = createTempEnv(t, 'pt-steps-turns-');
  const convId = 'conv-steps-turn-scope-001';
  const t0 = new Date(Date.now() - 60_000).toISOString();
  const t1 = new Date(Date.now() - 50_000).toISOString();
  const t2 = new Date(Date.now() - 40_000).toISOString();
  const t3 = new Date(Date.now() - 30_000).toISOString();
  const t4 = new Date(Date.now() - 20_000).toISOString();
  const t5 = new Date(Date.now() - 10_000).toISOString();

  const turn1InProgress = [
    { title: '调研代码结构', status: 'done' },
    { title: '实现核心修改', status: 'in_progress' },
    { title: '补充单元测试', status: 'pending' },
    { title: '校验并提交', status: 'pending' },
  ];
  const turn1Done = turn1InProgress.map((s) => ({ ...s, status: 'done' }));

  // 1. Turn 1 running: reports latest update_steps (1/4, currentTitle = '实现核心修改')
  const baseTurn1Running = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: t0,
      content: '<USER_REQUEST>\n# 子线程任务分配: [thr-077] 优化步骤进度\n</USER_REQUEST>',
    },
    makeUpdateStepsStep(1, turn1InProgress, t1),
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: t1,
      tool_calls: [{ name: 'read_file', args: { Path: '"C:\\repo\\lib\\transcript.mjs"' } }],
    },
  ];
  writeTranscript(appDataDir, convId, baseTurn1Running);

  const act1Running = peekLiveActivity(convId, { runState: 'RUN_STATE_RUNNING' });
  assert.deepEqual(act1Running.stepsProgress, {
    done: 1,
    total: 4,
    currentTitle: '实现核心修改',
  });
  assert.deepEqual(act1Running.stepsList, turn1InProgress);
  assert.equal(act1Running.toolStepCount, 1);

  // 2. Turn 1 completed (IDLE): retains final 4/4 checklist
  const baseTurn1Done = [
    ...baseTurn1Running,
    makeUpdateStepsStep(3, turn1Done, t2),
    {
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: t2,
      content: '已完成第 1 轮全部改动。\n\n### 线程总结\n- 完成 4 步改动。',
    },
  ];
  writeTranscript(appDataDir, convId, baseTurn1Done);

  const act1Done = peekLiveActivity(convId, { runState: 'RUN_STATE_IDLE' });
  assert.deepEqual(act1Done.stepsProgress, {
    done: 4,
    total: 4,
    currentTitle: '',
  });
  assert.deepEqual(act1Done.stepsList, turn1Done);
  assert.equal(act1Done.lastStepIndex, 4);

  // 3. Turn 2 user follow-up arrives (running, no tool calls yet): stale turn 1 steps must be cleared
  const turn2JustSent = [
    ...baseTurn1Done,
    {
      step_index: 5,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: t3,
      content: '<USER_REQUEST>\n再顺手排查一下深色主题渲染\n</USER_REQUEST>',
    },
  ];
  writeTranscript(appDataDir, convId, turn2JustSent);

  const act2JustSent = peekLiveActivity(convId, { runState: 'RUN_STATE_RUNNING' });
  assert.equal(act2JustSent.stepsProgress, null);
  assert.equal(act2JustSent.stepsList, null);
  assert.equal(act2JustSent.activeTool, '');
  assert.equal(act2JustSent.toolStepCount, 0);

  // 4. Turn 2 running tools without calling update_steps: still null (never leaks turn 1 4/4)
  const turn2WorkingNoSteps = [
    ...turn2JustSent,
    {
      step_index: 6,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: t3,
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"node check.mjs"', toolSummary: '"Inspect theme"' } }],
    },
  ];
  writeTranscript(appDataDir, convId, turn2WorkingNoSteps);

  const act2WorkingNoSteps = peekLiveActivity(convId, { runState: 'RUN_STATE_RUNNING' });
  assert.equal(act2WorkingNoSteps.stepsProgress, null);
  assert.equal(act2WorkingNoSteps.stepsList, null);
  assert.equal(act2WorkingNoSteps.activeTool, 'Inspect theme');
  assert.equal(act2WorkingNoSteps.toolStepCount, 1);

  // 5. Turn 2 finishes without ever calling update_steps: remains null in IDLE
  const turn2DoneNoSteps = [
    ...turn2WorkingNoSteps,
    {
      step_index: 7,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: t4,
      content: '已完成排查并修复。\n\n### 线程总结\n- 修复深色主题问题。',
    },
  ];
  writeTranscript(appDataDir, convId, turn2DoneNoSteps);

  const act2DoneNoSteps = peekLiveActivity(convId, { runState: 'RUN_STATE_IDLE' });
  assert.equal(act2DoneNoSteps.stepsProgress, null);
  assert.equal(act2DoneNoSteps.stepsList, null);
  assert.equal(act2DoneNoSteps.lastStepIndex, 7);

  // 6. Turn 2 calls update_steps: immediately displays turn 2 checklist (and supersedes previous turn)
  const turn2StepsActive = [
    { title: '抓包确认渲染差异', status: 'done' },
    { title: '修复图片切换标记', status: 'in_progress' },
    { title: '回归校验', status: 'pending' },
  ];
  const turn2WithSteps = [
    ...turn2WorkingNoSteps,
    makeUpdateStepsStep(7, turn2StepsActive, t4),
  ];
  writeTranscript(appDataDir, convId, turn2WithSteps);

  const act2WithSteps = peekLiveActivity(convId, { runState: 'RUN_STATE_RUNNING' });
  assert.deepEqual(act2WithSteps.stepsProgress, {
    done: 1,
    total: 3,
    currentTitle: '修复图片切换标记',
  });
  assert.deepEqual(act2WithSteps.stepsList, turn2StepsActive);

  // 7. Turn 3 delivered via agentapi send-message fallback (SYSTEM_MESSAGE sender=system high-priority): also starts a fresh turn
  const turn3Fallback = [
    ...turn2WithSteps,
    {
      step_index: 8,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: t5,
      content:
        'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-28T14:30:00Z sender=system priority=MESSAGE_PRIORITY_HIGH content=请补充一条边界测试\n</SYSTEM_MESSAGE>',
    },
  ];
  writeTranscript(appDataDir, convId, turn3Fallback);

  const act3Fallback = peekLiveActivity(convId, { runState: 'RUN_STATE_RUNNING' });
  assert.equal(act3Fallback.stepsProgress, null);
  assert.equal(act3Fallback.stepsList, null);
});

test('peekLiveActivity does NOT clear stepsList/stepsProgress on system reminders, hooks, bg task callbacks, subagent replies, or notices', (t) => {
  const { appDataDir } = createTempEnv(t, 'pt-steps-sys-');
  const convId = 'conv-steps-sys-safe-002';
  const nowIso = new Date().toISOString();

  const turn1Steps = [
    { title: '分析根因', status: 'done' },
    { title: '编写修复', status: 'done' },
    { title: '运行测试', status: 'done' },
  ];

  const steps = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: nowIso,
      content: '<USER_REQUEST>\nFix parser edge case\n</USER_REQUEST>',
    },
    makeUpdateStepsStep(1, turn1Steps, nowIso),
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: nowIso,
      content: '### Thread Summary\nAll 3 stages completed.',
    },
    // Plain system reminder (no [Message])
    {
      step_index: 3,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: nowIso,
      content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\nReminder: work efficiently.\n</SYSTEM_MESSAGE>',
    },
    // PreInvocation SDK hook injection
    {
      step_index: 4,
      source: 'SYSTEM_SDK',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: nowIso,
      content: '<SYSTEM_MESSAGE>\nThe following system message was injected by a PreInvocation hook:\n[Project Threads Update]\n</SYSTEM_MESSAGE>',
    },
    // Background task completion callback
    {
      step_index: 5,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: nowIso,
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${nowIso} sender=${convId}/task-1 priority=MESSAGE_PRIORITY_HIGH content=Task id "${convId}/task-1" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`,
    },
    // Subagent reply (sender is a conversation UUID)
    {
      step_index: 6,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: nowIso,
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${nowIso} sender=12bb1c49-0e11-4bc1-a0e9-1f7250c5ba85 priority=MESSAGE_PRIORITY_HIGH content=COMPLETED / TASK_COMPLETED\n</SYSTEM_MESSAGE>`,
    },
    // Low-priority host notice & browser host facts
    {
      step_index: 7,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: nowIso,
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${nowIso} sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your subagents and background tasks have been stopped.\n</SYSTEM_MESSAGE>`,
    },
    {
      step_index: 8,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: nowIso,
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${nowIso} sender=system priority=MESSAGE_PRIORITY_LOW content=[BROWSER_HOST_FACTS subagent=12bb1c49-0e11-4bc1-a0e9-1f7250c5ba85] ok\n</SYSTEM_MESSAGE>`,
    },
    // Completion sync system callback
    {
      step_index: 9,
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: nowIso,
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${nowIso} sender=system priority=MESSAGE_PRIORITY_HIGH content=[THREAD_COMPLETION_SYNC] Worker thread \`thr-077\` has finished.\n</SYSTEM_MESSAGE>`,
    },
    // Stream interrupted USER_INPUT error marker and SYSTEM-sourced USER_INPUT
    {
      step_index: 10,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: nowIso,
      content: 'Error: The stream was interrupted.',
    },
    {
      step_index: 11,
      source: 'SYSTEM',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: nowIso,
      content: '<USER_REQUEST>internal synthetic message</USER_REQUEST>',
    },
  ];
  writeTranscript(appDataDir, convId, steps);

  const act = peekLiveActivity(convId, { runState: 'RUN_STATE_IDLE' });
  assert.deepEqual(act.stepsProgress, {
    done: 3,
    total: 3,
    currentTitle: '',
  });
  assert.deepEqual(act.stepsList, turn1Steps);
  assert.equal(act.lastStepIndex, 2);
});

test('sendThreadMessage, getThreadMessages, and syncThreads clear stale turn 1 stepsList across optimistic and persisted transitions', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-steps-e2e-');
  const ws = join(tempRoot, 'repo');
  mkdirSync(ws, { recursive: true });
  const convId = 'conv-steps-e2e-0000003';
  const coordId = 'conv-coord-steps-000003';
  const nowIso = new Date().toISOString();

  const turn1Done = [
    { title: '步骤一', status: 'done' },
    { title: '步骤二', status: 'done' },
    { title: '步骤三', status: 'done' },
  ];
  const turn1Transcript = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: nowIso,
      content: '<USER_REQUEST>\n# 子线程任务分配: [thr-301] 测试轮次隔离\n</USER_REQUEST>',
    },
    makeUpdateStepsStep(1, turn1Done, nowIso),
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: nowIso,
      content: '### 线程总结\n第 1 轮完成。',
    },
  ];
  writeTranscript(appDataDir, convId, turn1Transcript);

  let mockRunState = 'RUN_STATE_IDLE';
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/product.v1.ConversationService/GetConversation') {
        res.end(
          JSON.stringify({
            conversation: {
              id: payload.conversationId,
              state: { runState: mockRunState, updateTime: new Date().toISOString() },
            },
          }),
        );
        return;
      }
      if (req.url === '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage') {
        mockRunState = 'RUN_STATE_RUNNING';
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
        res.end(JSON.stringify({ generatorMetadata: [] }));
        return;
      }
      res.end(JSON.stringify({}));
    });
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => server.close());
  const port = server.address().port;
  process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${port}`;
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';

  const reg = loadRegistry();
  reg.coordinators[ws.toLowerCase()] = {
    key: ws.toLowerCase(),
    conversationId: coordId,
    workspacePath: ws,
    repoRoot: ws,
    title: '[Coordinator] StepsScope',
  };
  reg.threads['thr-301'] = {
    threadId: 'thr-301',
    conversationId: convId,
    coordinatorId: coordId,
    workspaceKey: ws.toLowerCase(),
    title: '测试轮次隔离',
    model: 'pro',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    createdAt: nowIso,
    updatedAt: nowIso,
    stepsProgress: { done: 3, total: 3, currentTitle: '' },
    stepsList: turn1Done,
  };
  saveRegistry(reg);

  // 1. Follow-up sent before LS flushes USER_INPUT into transcript.jsonl: cleared immediately
  const sendRes = await sendThreadMessage({
    threadId: 'thr-301',
    message: '第二轮追问：检查一下边界条件',
    coordinatorId: coordId,
    workspacePath: ws,
    requireScope: true,
  });
  assert.equal(sendRes.ok, true);
  assert.equal(sendRes.thread.stepsProgress, null);
  assert.equal(sendRes.thread.stepsList, null);

  // 2. Optimistic window in getThreadMessages (before transcript.jsonl has turn 2 USER_INPUT): still null
  const msgOptimistic = await getThreadMessages({
    threadId: 'thr-301',
    coordinatorId: coordId,
    workspacePath: ws,
    requireScope: true,
  });
  assert.equal(msgOptimistic.thread.stepsProgress, null);
  assert.equal(msgOptimistic.thread.stepsList, null);

  // 3. LS flushes turn 2 USER_INPUT and calls update_steps -> getThreadMessages shows turn 2 steps
  const turn2NewSteps = [
    { title: '复核边界条件', status: 'in_progress' },
    { title: '补充断言', status: 'pending' },
  ];
  const turn2RunningWithSteps = [
    ...turn1Transcript,
    {
      step_index: 3,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: new Date(Date.now() + 1000).toISOString(),
      content: '<USER_REQUEST>\n第二轮追问：检查一下边界条件\n</USER_REQUEST>',
    },
    makeUpdateStepsStep(4, turn2NewSteps, new Date(Date.now() + 1500).toISOString()),
  ];
  writeTranscript(appDataDir, convId, turn2RunningWithSteps);

  const msgTurn2Active = await getThreadMessages({
    threadId: 'thr-301',
    coordinatorId: coordId,
    workspacePath: ws,
    requireScope: true,
  });
  assert.deepEqual(msgTurn2Active.thread.stepsProgress, {
    done: 0,
    total: 2,
    currentTitle: '复核边界条件',
  });
  assert.deepEqual(msgTurn2Active.thread.stepsList, turn2NewSteps);

  // 4. Turn 3 follow-up finishes without update_steps -> syncThreads persists cleared steps
  const turn3Transcript = [
    ...turn2RunningWithSteps,
    {
      step_index: 5,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: new Date(Date.now() + 2000).toISOString(),
      content: '<USER_REQUEST>\n第三轮简单追问：确认已提交\n</USER_REQUEST>',
    },
    {
      step_index: 6,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(Date.now() + 3000).toISOString(),
      content: '### 线程总结\n边界条件已核查，无异常。',
    },
  ];
  writeTranscript(appDataDir, convId, turn3Transcript);
  mockRunState = 'RUN_STATE_IDLE';

  const synced = await syncThreads({
    workspacePath: ws,
    coordinatorId: coordId,
  });
  const syncedThread = synced.threads.find((th) => th.threadId === 'thr-301');
  assert.equal(syncedThread?.stepsProgress, null);
  assert.equal(syncedThread?.stepsList, null);
  assert.equal(loadRegistry().threads['thr-301'].stepsProgress, null);
  assert.equal(loadRegistry().threads['thr-301'].stepsList, null);

  // 5. Verify test file itself uses strict LF line endings
  const rawSelf = readFileSync(new URL(import.meta.url));
  assert.ok(!rawSelf.includes(Buffer.from('\r')), 'steps-progress-turn-scope.test.mjs must use LF line endings');
});

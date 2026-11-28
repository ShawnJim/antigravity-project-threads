import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  extractThreadCompletion,
  parseThreadTranscript,
  peekLiveActivity,
  scanPendingBackgroundTasks,
} from '../lib/transcript.mjs';
import {
  loadRegistry,
  saveRegistry,
  syncCompletionToCoordinator,
  syncThreads,
} from '../lib/store.mjs';

function createTempEnv(t, prefix = 'pt-bg-') {
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

function writeMockAgentApiScript(dir, name, jsBody) {
  const jsPath = join(dir, `${name}.mjs`);
  writeFileSync(jsPath, jsBody, 'utf8');
  if (process.platform === 'win32') {
    const cmdPath = join(dir, `${name}.cmd`);
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`, 'utf8');
    return cmdPath;
  }
  const shPath = join(dir, name);
  writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`, 'utf8');
  chmodSync(shPath, 0o755);
  return shPath;
}

function writeTranscript(appDataDir, convId, steps) {
  const txDir = join(appDataDir, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(txDir, { recursive: true });
  const txPath = join(txDir, 'transcript.jsonl');
  writeFileSync(txPath, `${steps.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');
  return txPath;
}

test('ignores quoted background task output in completed DONE commands and read_file steps (thr-016 reproduction)', (t) => {
  const { appDataDir } = createTempEnv(t, 'pt-bg-thr016-');
  const convId = 'a6c8eb63-a3fe-454b-b0c6-9a825be6b7d1';
  const nowIso = new Date().toISOString();

  const steps = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: nowIso,
      content: '<USER_REQUEST>\n# Worker Thread Assignment: [thr-016] Investigate callback routing\n</USER_REQUEST>',
    },
    {
      step_index: 25,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: nowIso,
      tool_calls: [
        { name: 'read_file', args: { Path: '"C:\\repo\\lib\\transcript.mjs"' } },
      ],
    },
    {
      step_index: 26,
      type: 'GENERIC',
      status: 'DONE',
      created_at: nowIso,
      content: [
        'Created At: 2026-11-28T11:58:05+08:00',
        'Completed At: 2026-11-28T11:58:05+08:00',
        'Showing lines 430-455 of 1304',
        '439: const bgMatch = nextStep.content.match(',
        '440:   /Tool is running as a background task with task id:\\s*([^\\r\\n]+)/i,',
        '441: );',
      ].join('\n'),
    },
    {
      step_index: 39,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: nowIso,
      tool_calls: [
        {
          name: 'run_command',
          args: {
            CommandLine: '"node -e ..."' ,
            toolSummary: '"Check thr-015 turn history and coordinator conversation files"',
          },
        },
      ],
    },
    {
      step_index: 42,
      type: 'GENERIC',
      status: 'DONE',
      created_at: nowIso,
      content: [
        'Created At: 2026-11-28T11:58:33+08:00',
        'Completed At: 2026-11-28T11:58:41+08:00',
        'Command exited with code 0.',
        '',
        'Command output:',
        '371 step: 371 GENERIC 2026-11-28T03:54:52Z Created At: 2026-11-28T11:54:52+08:00 Tool is running as a background task with task id: a00572bd-bc45-4b80-afb2-c7e6c3557630/task-371 Task Description: cd "C:\\Users\\25103\\IdeaProj',
      ].join('\n'),
    },
    {
      step_index: 43,
      type: 'GENERIC',
      created_at: nowIso,
      // Synthetic step omitting status, but containing raw cat output with synchronous completion markers
      content: [
        'Created At: 2026-11-28T11:58:42+08:00',
        'Completed At: 2026-11-28T11:58:43+08:00',
        'Command exited with code 0.',
        'Tool is running as a background task with task id: a00572bd-bc45-4b80-afb2-c7e6c3557630/task-999',
      ].join('\n'),
    },
    {
      step_index: 74,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: nowIso,
      content: [
        '### Thread Summary',
        '- **Root Cause**: `syncCompletionToCoordinator()` routes via `t.coordinatorId || coord?.conversationId`.',
      ].join('\n'),
    },
  ];

  writeTranscript(appDataDir, convId, steps);

  assert.deepEqual(scanPendingBackgroundTasks(steps, 0, { conversationId: convId }), []);

  const act = peekLiveActivity(convId, { runState: 'RUN_STATE_IDLE' });
  assert.equal(act.hasPendingBgTask, false);
  assert.equal(act.pendingBgTaskSummary, '');
  assert.equal(act.lastStepIndex, 74);
  assert.match(act.lastSummary, /\*\*Root Cause\*\*:/);

  const comp = extractThreadCompletion(convId);
  assert.equal(comp.waitingOnBackgroundTask, false);
  assert.equal(comp.stepIndex, 74);
  assert.match(comp.fullReport, /### Thread Summary/);

  const parsed = parseThreadTranscript(convId);
  const traceItems = parsed.items.filter((it) => it.kind === 'trace');
  const checkCall = traceItems.flatMap((tr) => tr.calls).find((c) => c.target.includes('Check thr-015'));
  assert.ok(checkCall, 'expected Check thr-015 tool call in timeline');
  assert.equal(checkCall.running, false);
  assert.equal(checkCall.done, true);

  const finalReply = parsed.items.find((it) => it.id === 'step-74');
  assert.ok(finalReply);
  assert.equal(finalReply.isFinalReply, true);
  assert.equal(finalReply.showFooter, true);
});

test('preserves genuine pending background tasks while waiting, then clears upon completion', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-bg-real-');
  const convId = 'conv-real-bg-0000001';
  const coordId = 'conv-coord-bg-000001';
  const nowIso = new Date().toISOString();

  const initialSteps = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: nowIso,
      content: '<USER_REQUEST>Run integration suite</USER_REQUEST>',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: nowIso,
      tool_calls: [
        {
          name: 'run_command',
          args: {
            CommandLine: '"npm test"',
            toolSummary: '"Run integration test suite"',
          },
        },
      ],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: nowIso,
      content: [
        `Created At: ${nowIso}`,
        `Tool is running as a background task with task id: ${convId}/task-2`,
        'Task Description: npm test',
      ].join('\n'),
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: nowIso,
      content: 'Launched the integration test suite in the background and waiting for it to finish.',
    },
  ];
  writeTranscript(appDataDir, convId, initialSteps);

  const actWaiting = peekLiveActivity(convId, { runState: 'RUN_STATE_IDLE' });
  assert.equal(actWaiting.hasPendingBgTask, true);
  assert.equal(actWaiting.pendingBgTaskSummary, 'Run integration test suite');

  const compWaiting = extractThreadCompletion(convId);
  assert.equal(compWaiting.waitingOnBackgroundTask, true);
  assert.deepEqual(compWaiting.pendingTaskIds, [`${convId}/task-2`]);

  const reg = loadRegistry();
  reg.coordinators['__test__'] = {
    key: '__test__',
    conversationId: coordId,
    workspacePath: '',
    title: '[Coordinator] BG Test',
  };
  reg.threads['thr-201'] = {
    threadId: 'thr-201',
    conversationId: convId,
    coordinatorId: coordId,
    workspaceKey: '__test__',
    title: 'Run tests',
    model: 'pro',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  saveRegistry(reg);

  const syncBlocked = await syncCompletionToCoordinator({ threadId: 'thr-201', force: false });
  assert.equal(syncBlocked.synced, false);
  assert.equal(syncBlocked.reason, 'waiting_on_background_task');

  // Background task finishes and agent writes final Thread Summary
  const completedSteps = [
    ...initialSteps,
    {
      step_index: 4,
      type: 'SYSTEM_MESSAGE',
      status: 'DONE',
      created_at: new Date(Date.now() + 2000).toISOString(),
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=${nowIso} sender=${convId}/task-2 priority=MESSAGE_PRIORITY_HIGH content=Task id "${convId}/task-2" finished with result:\nCommand exited with code 0.\n</SYSTEM_MESSAGE>`,
    },
    {
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: new Date(Date.now() + 3000).toISOString(),
      content: '### Thread Summary\nAll 42 integration tests passed.',
    },
  ];
  writeTranscript(appDataDir, convId, completedSteps);

  const actDone = peekLiveActivity(convId, { runState: 'RUN_STATE_IDLE' });
  assert.equal(actDone.hasPendingBgTask, false);
  assert.equal(actDone.lastStepIndex, 5);
  assert.match(actDone.lastSummary, /All 42 integration tests passed/);

  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59997';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
  process.env.ANTIGRAVITY_AGENTAPI_EXE = writeMockAgentApiScript(
    tempRoot,
    'ok-bg-api',
    `process.stdout.write(JSON.stringify({ response: { sendMessage: { recipientId: 'ok' } } }));`,
  );

  const syncOk = await syncCompletionToCoordinator({ threadId: 'thr-201', force: false, timeoutMs: 5000 });
  assert.equal(syncOk.ok, true);
  assert.equal(syncOk.synced, true);
  const regAfter = loadRegistry();
  assert.equal(regAfter.threads['thr-201'].hasPendingBgTask, false);
  assert.equal(regAfter.threads['thr-201'].activeTool, '');
  assert.equal(regAfter.threads['thr-201'].bucket, 'waiting');
});

test('handles IsDaemon, manage_task status/cancel, and orphaned tasks superseded by Thread Summary', (t) => {
  const { appDataDir } = createTempEnv(t, 'pt-bg-edge-');
  const convId = 'conv-edge-bg-000001';
  const nowIso = new Date().toISOString();

  // 1. IsDaemon: true never blocks
  const daemonSteps = [
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: '"npm run dev"', IsDaemon: true, toolSummary: '"Start dev server"' } },
      ],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: nowIso,
      content: `Created At: ${nowIso}\nTool is running as a background task with task id: ${convId}/task-2`,
    },
  ];
  assert.deepEqual(scanPendingBackgroundTasks(daemonSteps, 0, { conversationId: convId }), []);

  // 2. manage_task status DONE and "cannot kill task ... task is not running" clear pending tasks
  const manageDoneSteps = [
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"sleep 5"', toolSummary: '"Run build"' } }],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: nowIso,
      content: `Created At: ${nowIso}\nTool is running as a background task with task id: ${convId}/task-2`,
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'manage_task', args: { Action: '"status"', TaskId: `"${convId}/task-2"` } }],
    },
    {
      step_index: 4,
      type: 'GENERIC',
      status: 'DONE',
      created_at: nowIso,
      content: `Created At: ${nowIso}\nCompleted At: ${nowIso}\nTask: ${convId}/task-2\nStatus: DONE\n`,
    },
  ];
  assert.deepEqual(scanPendingBackgroundTasks(manageDoneSteps, 0, { conversationId: convId }), []);

  // 3. Orphaned real task followed by final ### Thread Summary clears when idle/completed, stays active while running
  const orphanSteps = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      created_at: nowIso,
      content: '<USER_REQUEST>Investigate issue</USER_REQUEST>',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: '"node server.js"', toolSummary: '"Start helper"' } }],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: nowIso,
      content: `Created At: ${nowIso}\nTool is running as a background task with task id: ${convId}/task-2`,
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: nowIso,
      content: '### Thread Summary\nCompleted investigation and committed fix.',
    },
  ];
  writeTranscript(appDataDir, convId, orphanSteps);

  const runningAct = peekLiveActivity(convId, { runState: 'RUN_STATE_RUNNING' });
  assert.equal(runningAct.hasPendingBgTask, true);

  const idleAct = peekLiveActivity(convId, { runState: 'RUN_STATE_IDLE' });
  assert.equal(idleAct.hasPendingBgTask, false);
  assert.equal(extractThreadCompletion(convId).waitingOnBackgroundTask, false);
});

test('syncThreads clears stale persisted hasPendingBgTask/activeTool and reconciles missed callback when IDLE', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-bg-sync-');
  const convId = 'a6c8eb63-a3fe-454b-b0c6-9a825be6b999';
  const coordId = 'conv-coord-recover-01';
  const nowIso = new Date().toISOString();
  const completedAgo = new Date(Date.now() - 15000).toISOString();

  writeTranscript(appDataDir, convId, [
    {
      step_index: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: completedAgo,
      content: '<USER_REQUEST>\n# Worker Thread Assignment: [thr-016] Investigate bug\n</USER_REQUEST>',
    },
    {
      step_index: 39,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: completedAgo,
      tool_calls: [
        {
          name: 'run_command',
          args: {
            CommandLine: '"node -e ..."' ,
            toolSummary: '"Check thr-015 turn history and coordinator conversation files"',
          },
        },
      ],
    },
    {
      step_index: 42,
      type: 'GENERIC',
      status: 'DONE',
      created_at: completedAgo,
      content: [
        'Created At: 2026-11-28T11:58:33+08:00',
        'Completed At: 2026-11-28T11:58:41+08:00',
        'Command exited with code 0.',
        '371 step: 371 GENERIC 2026-11-28T03:54:52Z Tool is running as a background task with task id: a00572bd-bc45-4b80-afb2-c7e6c3557630/task-371 Task Description: foo',
      ].join('\n'),
    },
    {
      step_index: 74,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: completedAgo,
      content: '### Thread Summary\n- **Root Cause**: Fixed callback routing analysis.',
    },
  ]);

  const sendLog = join(tempRoot, 'recover-send.jsonl');
  process.env.ANTIGRAVITY_AGENTAPI_EXE = writeMockAgentApiScript(
    tempRoot,
    'recover-api',
    `import { appendFileSync } from 'node:fs';
     appendFileSync(${JSON.stringify(sendLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
     process.stdout.write(JSON.stringify({ response: { sendMessage: { recipientId: 'ok' } } }));`,
  );

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/product.v1.ConversationService/GetConversation') {
        res.end(JSON.stringify({
          conversation: {
            id: payload.conversationId,
            state: { runState: 'RUN_STATE_IDLE', updateTime: completedAgo },
          },
        }));
        return;
      }
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
        res.end(JSON.stringify({
          generatorMetadata: [{
            chatModel: {
              model: 'MODEL_PLACEHOLDER_M531',
              responseModel: 'gemini-4-hydrogen-tiered-xhigh',
              modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
            },
          }],
        }));
        return;
      }
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
        res.end(JSON.stringify({ clientModelConfigs: [] }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${server.address().port}`;
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
  t.after(() => new Promise((r) => server.close(r)));

  const reg = loadRegistry();
  reg.coordinators['__test__'] = {
    key: '__test__',
    conversationId: coordId,
    workspacePath: '',
    title: '[Coordinator] Test',
  };
  reg.threads['thr-016'] = {
    threadId: 'thr-016',
    conversationId: convId,
    coordinatorId: coordId,
    workspaceKey: '__test__',
    title: 'Investigate callback routing',
    model: 'pro',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    lastSummary: '# Worker Thread Assignment: [thr-016] Investigate bug',
    lastCompletedAt: completedAgo,
    notifiedCoordinatorAt: '',
    hasPendingBgTask: true,
    activeTool: 'Check thr-015 turn history and coordinator conversation files',
    activeToolObj: { category: 'cmd', target: 'Check thr-015 turn history and coordinator conversation files' },
    bucket: 'working',
    waitingReason: '',
    createdAt: '2020-01-01T00:00:00Z',
    updatedAt: nowIso,
  };
  saveRegistry(reg);

  const snap = await syncThreads({ allWorkspaces: true });
  const th = snap.threads.find((x) => x.threadId === 'thr-016');
  assert.equal(th.hasPendingBgTask, false);
  assert.equal(th.activeTool, '');
  assert.equal(th.activeToolObj, null);
  assert.equal(th.bucket, 'waiting');
  assert.equal(th.waitingReason, 'review');
  assert.match(th.lastSummary, /\*\*Root Cause\*\*:/);

  const persisted = loadRegistry().threads['thr-016'];
  assert.equal(persisted.hasPendingBgTask, false);
  assert.equal(persisted.activeTool, '');
  assert.equal(persisted.bucket, 'waiting');
  assert.equal(persisted.lastSyncedStepIndex, 74);
  assert.ok(persisted.pushedToCoordinatorAt);
  assert.ok(persisted.notifiedCoordinatorAt);

  // Subsequent sync must not duplicate callback delivery
  await syncThreads({ allWorkspaces: true });
  const deliveries = readFileSync(sendLog, 'utf8').trim().split(/\r?\n/);
  assert.equal(deliveries.length, 1);
});

test('modified .mjs files preserve LF line endings', () => {
  for (const rel of ['../lib/transcript.mjs', '../lib/store.mjs', '../scripts/hook-handler.mjs', './pending-bg-task.test.mjs']) {
    const bytes = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!bytes.includes(Buffer.from('\r')), `${rel} must use LF line endings`);
  }
});

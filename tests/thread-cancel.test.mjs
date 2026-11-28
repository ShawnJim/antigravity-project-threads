import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';

const execFileAsync = promisify(execFile);

import {
  cancelCascadeInvocation,
  forceStopCascadeTree,
  isCascadeNotRunningError,
  resetLsEndpointCache,
  resetModelConfigCache,
} from '../lib/ls-client.mjs';
import {
  archiveThread,
  cancelThread,
  clearManualCancelFieldsInRecord,
  dispatchThread,
  getThreadMessages,
  hasNewUserTurnAfterCancel,
  loadRegistry,
  normalizeKey,
  saveRegistry,
  sendThreadMessage,
  syncCompletionToCoordinator,
  syncThreads,
} from '../lib/store.mjs';
import {
  extractThreadCompletion,
  parseThreadTranscript,
  peekLiveActivity,
  resetTranscriptCaches,
} from '../lib/transcript.mjs';
import { mergeWatchdogStateMaps, patrolProjectScope } from '../lib/watchdog.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function createTempEnv(t, prefix = 'pt-thread-cancel-') {
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
  resetLsEndpointCache();
  resetModelConfigCache();
  resetTranscriptCaches();

  t.after(() => {
    resetLsEndpointCache();
    resetModelConfigCache();
    resetTranscriptCaches();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Ignore Windows temp lock
    }
  });

  return { tempRoot, geminiDir, appDataDir, stateDir };
}

function initGitRepo(repoDir) {
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), '# Demo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });
}

function writeMockAgentApi(tempRoot, logFile) {
  const jsFile = join(tempRoot, 'mock-agentapi.mjs');
  writeFileSync(
    jsFile,
    `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ response: { sendMessage: { recipientId: 'ok' } } }));
`,
    'utf8',
  );
  if (process.platform === 'win32') {
    const cmdFile = join(tempRoot, 'mock-agentapi.cmd');
    writeFileSync(cmdFile, `@echo off\r\n"${process.execPath}" "${jsFile}" %*\r\n`, 'utf8');
    return cmdFile;
  }
  const shFile = join(tempRoot, 'mock-agentapi.sh');
  writeFileSync(shFile, `#!/bin/sh\nexec "${process.execPath}" "${jsFile}" "$@"\n`, 'utf8');
  chmodSync(shFile, 0o755);
  return shFile;
}

function writeTranscript(appDataDir, convId, steps) {
  const txDir = join(appDataDir, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(txDir, { recursive: true });
  const txPath = join(txDir, 'transcript.jsonl');
  writeFileSync(txPath, `${steps.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');
  return txPath;
}

function extractFunctionSource(source, fnName) {
  let start = source.indexOf(`async function ${fnName}(`);
  if (start === -1) start = source.indexOf(`function ${fnName}(`);
  assert.notEqual(start, -1, `${fnName} must exist in sidecars/threads/app.js`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  assert.notEqual(bodyStart, -1, `Could not find body brace for ${fnName}`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unclosed function ${fnName}`);
}

function startMockLsServer(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let rawBody = '';
    req.on('data', (chunk) => {
      rawBody += chunk;
    });
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        parsed = {};
      }
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsed,
      });
      handler(req, res, parsed);
    });
  });

  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = `127.0.0.1:${server.address().port}`;
      process.env.ANTIGRAVITY_LS_ADDRESS = address;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-cancel-test';
      resetLsEndpointCache();
      t.after(() => new Promise((r) => server.close(r)));
      resolveListen({ address, requests });
    });
  });
}

test('Issue #20 LS client: cancelCascadeInvocation and forceStopCascadeTree payloads, paths, idle classification, and error propagation', async (t) => {
  createTempEnv(t, 'pt-ls-cancel-');

  let mode = 'ok';
  const mockLs = await startMockLsServer(t, (req, res, body) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/exa.language_server_pb.LanguageServerService/CancelCascadeInvocation') {
      if (mode === 'cascade_not_found') {
        res.statusCode = 500;
        res.end(JSON.stringify({ code: 'unknown', message: 'cascade not found' }));
        return;
      }
      if (mode === 'invalid_arg') {
        res.statusCode = 400;
        res.end(JSON.stringify({ code: 'invalid_argument', message: 'conversation id is required' }));
        return;
      }
      if (mode === 'auth_fail') {
        res.statusCode = 403;
        res.end(JSON.stringify({ code: 'permission_denied', message: 'forbidden' }));
        return;
      }
      if (mode === 'slow_timeout') {
        // Hold open until client times out
        return;
      }
      res.end(JSON.stringify({ ok: true, echo: body }));
      return;
    }

    if (req.url === '/exa.language_server_pb.LanguageServerService/ForceStopCascadeTree') {
      if (mode === 'tree_500') {
        res.statusCode = 500;
        res.end(JSON.stringify({ code: 'internal', message: 'unexpected crash' }));
        return;
      }
      res.end(JSON.stringify({ stoppedConversationIds: [body.conversationId] }));
      return;
    }

    res.statusCode = 404;
    res.end('{}');
  });

  await assert.rejects(() => cancelCascadeInvocation(''), /conversationId is required/);
  await assert.rejects(() => forceStopCascadeTree('  '), /conversationId is required/);

  // 1. Standard CancelCascadeInvocation payload & CSRF headers
  const res1 = await cancelCascadeInvocation('conv-111', {
    killBackgroundTasks: true,
    notifyParent: false,
  });
  assert.equal(res1.ok, true);
  assert.equal(
    mockLs.requests[0].url,
    '/exa.language_server_pb.LanguageServerService/CancelCascadeInvocation',
  );
  assert.equal(mockLs.requests[0].headers['x-antigravity-csrf-token'], 'csrf-cancel-test');
  assert.deepEqual(mockLs.requests[0].body, {
    cascadeId: 'conv-111',
    killBackgroundTasks: true,
    notifyParent: false,
  });

  // Omit notifyParent by default
  await cancelCascadeInvocation('conv-222');
  assert.deepEqual(mockLs.requests[1].body, {
    cascadeId: 'conv-222',
    killBackgroundTasks: true,
  });
  assert.equal('notifyParent' in mockLs.requests[1].body, false);

  // 2. ForceStopCascadeTree payload & path
  const treeRes = await forceStopCascadeTree('conv-tree-1');
  assert.deepEqual(treeRes, { stoppedConversationIds: ['conv-tree-1'] });
  assert.equal(
    mockLs.requests[2].url,
    '/exa.language_server_pb.LanguageServerService/ForceStopCascadeTree',
  );
  assert.deepEqual(mockLs.requests[2].body, { conversationId: 'conv-tree-1' });

  // 3. Error propagation & idle classification
  mode = 'cascade_not_found';
  let caughtNotFound = null;
  await assert.rejects(
    async () => {
      try {
        await cancelCascadeInvocation('conv-missing');
      } catch (err) {
        caughtNotFound = err;
        throw err;
      }
    },
    /cascade not found/,
  );
  assert.equal(isCascadeNotRunningError(caughtNotFound), true);

  mode = 'invalid_arg';
  let caughtInvalid = null;
  await assert.rejects(
    async () => {
      try {
        await cancelCascadeInvocation('conv-bad');
      } catch (err) {
        caughtInvalid = err;
        throw err;
      }
    },
    /HTTP 400/,
  );
  assert.equal(isCascadeNotRunningError(caughtInvalid), false);

  mode = 'auth_fail';
  let caughtAuth = null;
  await assert.rejects(
    async () => {
      try {
        await cancelCascadeInvocation('conv-auth');
      } catch (err) {
        caughtAuth = err;
        throw err;
      }
    },
    /HTTP 403/,
  );
  assert.equal(isCascadeNotRunningError(caughtAuth), false);

  mode = 'slow_timeout';
  let caughtTimeout = null;
  await assert.rejects(
    async () => {
      try {
        await cancelCascadeInvocation('conv-timeout', { timeoutMs: 80 });
      } catch (err) {
        caughtTimeout = err;
        throw err;
      }
    },
    /timed out/,
  );
  assert.equal(isCascadeNotRunningError(caughtTimeout), false);

  mode = 'tree_500';
  await assert.rejects(() => forceStopCascadeTree('conv-crash'), /HTTP 500/);
});

test('Issue #20 store cancelThread: fail-closed scope isolation, retired coordinator, archived rejection, watchdog tombstones, idempotency, and LS failure safety', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-store-cancel-');
  const repoA = join(tempRoot, 'repo-a');
  const repoB = join(tempRoot, 'repo-b');
  initGitRepo(repoA);
  initGitRepo(repoB);
  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);

  const now0 = '2026-11-29T02:00:00.000Z';
  const initReg = loadRegistry();
  initReg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'coord-a-active',
    retiredCoordinatorIds: ['coord-a-retired'],
    projectId: 'proj-a',
    workspacePath: repoA,
    repoRoot: repoA,
    defaultBranch: 'main',
    title: '[Coordinator] Repo A',
  };
  initReg.coordinators[keyB] = {
    key: keyB,
    conversationId: 'coord-b-active',
    projectId: 'proj-b',
    workspacePath: repoB,
    repoRoot: repoB,
    defaultBranch: 'main',
    title: '[Coordinator] Repo B',
  };

  // Mixed topology (#11 / #12):
  // - Legacy global key "thr-001" in Repo A
  // - Unified scoped key "pt-...-thr-001" with localId "thr-001" in Repo B
  initReg.threads['thr-001'] = {
    threadId: 'thr-001',
    projectSeq: 1,
    localId: 'thr-001',
    displayId: 'thr-001',
    conversationId: 'conv-a-1',
    coordinatorId: 'coord-a-active',
    workspaceKey: keyA,
    projectId: 'proj-a',
    workspacePath: repoA,
    repoRoot: repoA,
    title: 'Legacy Alpha Task',
    runState: 'RUN_STATE_RUNNING',
    hasPendingBgTask: true,
    activeTool: 'Running npm test',
    activeToolObj: { category: 'cmd', target: 'npm test' },
    bucket: 'working',
    waitingReason: '',
    archived: false,
    createdAt: now0,
    updatedAt: now0,
  };
  initReg.threads['pt-bbbb2222-thr-001'] = {
    threadId: 'pt-bbbb2222-thr-001',
    projectSeq: 1,
    localId: 'thr-001',
    displayId: 'thr-001',
    conversationId: 'conv-b-1',
    coordinatorId: 'coord-b-active',
    workspaceKey: keyB,
    projectId: 'proj-b',
    workspacePath: repoB,
    repoRoot: repoB,
    title: 'Scoped Beta Task',
    runState: 'RUN_STATE_RUNNING',
    hasPendingBgTask: false,
    activeTool: 'read_file',
    bucket: 'working',
    waitingReason: '',
    archived: false,
    createdAt: now0,
    updatedAt: now0,
  };
  initReg.threads['pt-aaaa1111-thr-002'] = {
    threadId: 'pt-aaaa1111-thr-002',
    projectSeq: 2,
    localId: 'thr-002',
    displayId: 'thr-002',
    conversationId: 'conv-a-2-archived',
    coordinatorId: 'coord-a-active',
    workspaceKey: keyA,
    projectId: 'proj-a',
    workspacePath: repoA,
    repoRoot: repoA,
    title: 'Archived Alpha Task',
    runState: 'RUN_STATE_IDLE',
    bucket: 'archived',
    archived: true,
    createdAt: now0,
    updatedAt: now0,
  };
  initReg.watchdogState[keyA] = {
    coordinatorId: 'coord-a-active',
    updatedAt: now0,
    threads: {
      'thr-001': {
        state: 'stalled',
        stalled: true,
        stallReason: 'bg_task_silent',
        stalledSinceAt: now0,
        updatedAt: now0,
      },
    },
  };
  saveRegistry(initReg);

  // Write transcript with an active background task for conv-a-1
  writeTranscript(appDataDir, 'conv-a-1', [
    {
      step_index: 0,
      type: 'USER_INPUT',
      content: 'Run long test suite',
      created_at: '2026-11-29T02:00:01.000Z',
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      content: '',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
      created_at: '2026-11-29T02:00:02.000Z',
    },
    {
      step_index: 2,
      type: 'GENERIC',
      status: 'RUNNING',
      content: 'Tool is running as a background task with task id: conv-a-1/task-1',
      created_at: '2026-11-29T02:00:03.000Z',
    },
  ]);

  const cancelRpcCalls = [];
  const depsOk = {
    cancelCascadeInvocation: async (cid, opts) => {
      cancelRpcCalls.push({ cid, opts });
      return { ok: true };
    },
    now: () => '2026-11-29T02:05:00.000Z',
  };

  // 1. Fail-closed checks: missing scope, retired coordinator, unresolvable coordinator/conversation, cross-project
  await assert.rejects(() => cancelThread({ threadId: 'thr-001' }, depsOk), /Project scope is required/);
  await assert.rejects(
    () => cancelThread({ threadId: 'thr-001', workspacePath: repoA, coordinatorId: 'coord-a-retired' }, depsOk),
    /retired/,
  );
  await assert.rejects(
    () => cancelThread({ threadId: 'thr-001', workspacePath: repoA, coordinatorId: 'coord-unknown' }, depsOk),
    /fail-closed/i,
  );
  await assert.rejects(
    () => cancelThread({ threadId: 'thr-001', conversationId: 'conv-unknown-scope' }, depsOk),
    /Cross-project access denied|Thread not found/i,
  );
  await assert.rejects(
    () => cancelThread({ threadId: 'pt-bbbb2222-thr-001', workspacePath: repoA }, depsOk),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () => cancelThread({ threadId: 'thr-002', workspacePath: repoA }, depsOk),
    /archived/i,
  );
  assert.equal(cancelRpcCalls.length, 0, 'Fail-closed rejections must never call LS');

  // 2. Real LS transport/5xx failure -> returns { ok: false, error } and leaves registry untouched
  const failRes = await cancelThread(
    { threadId: 'thr-001', workspacePath: repoA },
    {
      cancelCascadeInvocation: async () => {
        const err = new Error('LanguageServerService/CancelCascadeInvocation timed out after 8000ms');
        err.code = 'ETIMEDOUT';
        throw err;
      },
    },
  );
  assert.equal(failRes.ok, false);
  assert.match(failRes.error, /timed out/);
  const regAfterFail = loadRegistry();
  assert.equal(regAfterFail.threads['thr-001'].runState, 'RUN_STATE_RUNNING');
  assert.equal(regAfterFail.threads['thr-001'].hasPendingBgTask, true);
  assert.equal(regAfterFail.threads['thr-001'].bucket, 'working');

  // 3. Mixed topology priority: workspacePath=repoB + threadId="thr-001" MUST cancel Repo B's pt-bbbb2222-thr-001, NOT Repo A's legacy thr-001
  const cancelB = await cancelThread({ threadId: 'thr-001', workspacePath: repoB }, depsOk);
  assert.equal(cancelB.ok, true);
  assert.equal(cancelB.action, 'cancel');
  assert.equal(cancelB.threadId, 'pt-bbbb2222-thr-001');
  assert.equal(cancelB.displayId, 'thr-001');
  assert.equal(cancelB.canceled, true);
  assert.equal(cancelB.alreadyIdle, false);
  assert.equal(cancelRpcCalls[0].cid, 'conv-b-1');
  assert.equal(cancelRpcCalls[0].opts.killBackgroundTasks, true);
  assert.equal(loadRegistry().threads['thr-001'].runState, 'RUN_STATE_RUNNING');

  // 4. Cancel Repo A's thr-001: converges fields, writes Watchdog cleared tombstone, prevents stale pending bg task resurrection
  const cancelA = await cancelThread({ threadId: 'thr-001', workspacePath: repoA }, depsOk);
  assert.equal(cancelA.ok, true);
  assert.equal(cancelA.action, 'cancel');
  assert.equal(cancelA.threadId, 'thr-001');
  assert.equal(cancelA.canceled, true);
  assert.equal(cancelA.alreadyIdle, false);
  assert.equal(cancelA.thread.runState, 'RUN_STATE_IDLE');
  assert.equal(cancelA.thread.hasPendingBgTask, false);
  assert.equal(cancelA.thread.activeTool, '');
  assert.equal(cancelA.thread.activeToolObj, null);
  assert.equal(cancelA.thread.bucket, 'idle');

  const regAfterCancelA = loadRegistry();
  const wdEntry = regAfterCancelA.watchdogState[keyA].threads['thr-001'];
  assert.equal(wdEntry.state, 'cleared');
  assert.equal(wdEntry.updatedAt, '2026-11-29T02:05:00.000Z');
  // Tombstone prevents stale memory map from resurrecting old stalled state
  const mergedWd = mergeWatchdogStateMaps(
    {
      [keyA]: {
        coordinatorId: 'coord-a-active',
        updatedAt: now0,
        threads: {
          'thr-001': { state: 'stalled', stalled: true, updatedAt: now0 },
        },
      },
    },
    regAfterCancelA.watchdogState,
  );
  assert.equal(mergedWd[keyA].threads['thr-001'].state, 'cleared');

  // Stale transcript bg task before canceledAt must not resurrect hasPendingBgTask
  const liveActAfterCancel = peekLiveActivity('conv-a-1', {
    runState: regAfterCancelA.threads['thr-001'].runState,
    canceledAt: regAfterCancelA.threads['thr-001'].canceledAt,
  });
  assert.equal(liveActAfterCancel.hasPendingBgTask, false);

  // 5. Idempotency: even if local runState is IDLE, cancelThread STILL calls LS;
  //    when LS reports "cascade not found" & GetConversation confirms RUN_STATE_IDLE -> alreadyIdle: true
  let lsProbeCount = 0;
  const idleRes = await cancelThread(
    { threadId: 'thr-001', workspacePath: repoA },
    {
      cancelCascadeInvocation: async () => {
        lsProbeCount += 1;
        throw new Error('exa.language_server_pb.LanguageServerService/CancelCascadeInvocation failed (HTTP 500): {"code":"unknown","message":"cascade not found"}');
      },
      getConversation: async () => ({ conversation: { state: { runState: 'RUN_STATE_IDLE' } } }),
      now: () => '2026-11-29T02:06:00.000Z',
    },
  );
  assert.equal(lsProbeCount, 1, 'must not blindly skip LS cancel based on local runState');
  assert.equal(idleRes.ok, true);
  assert.equal(idleRes.action, 'cancel');
  assert.equal(idleRes.canceled, false);
  assert.equal(idleRes.alreadyIdle, true);

  // 6. If LS reports "cascade not found" but GetConversation shows RUN_STATE_RUNNING, must NOT report alreadyIdle
  const stillRunningErr = await cancelThread(
    { threadId: 'thr-001', workspacePath: repoA },
    {
      cancelCascadeInvocation: async () => {
        throw new Error('exa.language_server_pb.LanguageServerService/CancelCascadeInvocation failed (HTTP 500): {"code":"unknown","message":"cascade not found"}');
      },
      getConversation: async () => ({ conversation: { state: { runState: 'RUN_STATE_RUNNING' } } }),
    },
  );
  assert.equal(stillRunningErr.ok, false);
  assert.match(stillRunningErr.error, /cascade not found/);

  // 7. Concurrent archive during LS cancel flight must reject and NEVER un-archive
  const regConc = loadRegistry();
  regConc.threads['pt-conc-arc'] = {
    threadId: 'pt-conc-arc',
    projectSeq: 3,
    localId: 'thr-003',
    displayId: 'thr-003',
    conversationId: 'conv-conc-arc',
    coordinatorId: 'coord-a-active',
    workspaceKey: keyA,
    projectId: 'proj-a',
    workspacePath: repoA,
    repoRoot: repoA,
    title: 'Concurrent Archive Race',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    archived: false,
    createdAt: '2026-11-29T02:07:00.000Z',
    updatedAt: '2026-11-29T02:07:00.000Z',
  };
  regConc.threads['pt-conc-send'] = {
    threadId: 'pt-conc-send',
    projectSeq: 4,
    localId: 'thr-004',
    displayId: 'thr-004',
    conversationId: 'conv-conc-send',
    coordinatorId: 'coord-a-active',
    workspaceKey: keyA,
    projectId: 'proj-a',
    workspacePath: repoA,
    repoRoot: repoA,
    title: 'Concurrent Follow-up Race',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    archived: false,
    pendingUserMessages: [],
    createdAt: '2026-11-29T02:07:00.000Z',
    updatedAt: '2026-11-29T02:07:00.000Z',
  };
  saveRegistry(regConc);

  await assert.rejects(
    () =>
      cancelThread(
        { threadId: 'thr-003', workspacePath: repoA },
        {
          cancelCascadeInvocation: async () => {
            await archiveThread('thr-003', { workspacePath: repoA, removeWorktree: false });
            return { ok: true };
          },
        },
      ),
    /archived/i,
  );
  const regAfterConcArc = loadRegistry();
  assert.equal(regAfterConcArc.threads['pt-conc-arc'].archived, true);
  assert.equal(regAfterConcArc.threads['pt-conc-arc'].bucket, 'archived');

  // 8. Concurrent new follow-up during LS cancel flight must NOT overwrite restarted RUNNING state
  const concSendRes = await cancelThread(
    { threadId: 'thr-004', workspacePath: repoA },
    {
      cancelCascadeInvocation: async () => {
        const cur = loadRegistry();
        cur.threads['pt-conc-send'].pendingUserMessages.push({
          id: 'pm-concurrent-1',
          text: 'Restart immediately',
          createdAt: '2026-11-29T02:08:00.000Z',
        });
        cur.threads['pt-conc-send'].runState = 'RUN_STATE_RUNNING';
        cur.threads['pt-conc-send'].bucket = 'working';
        cur.threads['pt-conc-send'].updatedAt = '2026-11-29T02:08:00.000Z';
        saveRegistry(cur);
        return { ok: true };
      },
      now: () => '2026-11-29T02:08:01.000Z',
    },
  );
  assert.equal(concSendRes.ok, true);
  assert.equal(loadRegistry().threads['pt-conc-send'].runState, 'RUN_STATE_RUNNING');
  assert.equal(loadRegistry().threads['pt-conc-send'].bucket, 'working');

  // 9. Archived thread remains rejected after archiveThread
  await archiveThread('thr-001', { workspacePath: repoA, removeWorktree: false });
  await assert.rejects(
    () => cancelThread({ threadId: 'thr-001', workspacePath: repoA }, depsOk),
    /archived/i,
  );
});

test('Issue #20 callback safety: manual cancel suppresses false [THREAD_COMPLETION_SYNC], while follow-up restart restores completion sync', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-cancel-sync-');
  const repoDir = join(tempRoot, 'repo-sync');
  initGitRepo(repoDir);
  const key = normalizeKey(repoDir);
  const sendLog = join(tempRoot, 'agentapi-sends.jsonl');
  process.env.ANTIGRAVITY_AGENTAPI_EXE = writeMockAgentApi(tempRoot, sendLog);

  const lsState = { runState: 'RUN_STATE_RUNNING' };
  await startMockLsServer(t, (req, res, body) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/product.v1.ConversationService/GetConversation') {
      res.end(
        JSON.stringify({
          conversation: {
            id: body.conversationId,
            state: { runState: lsState.runState },
            annotations: { archived: false },
          },
        }),
      );
      return;
    }
    if (req.url === '/exa.language_server_pb.LanguageServerService/CancelCascadeInvocation') {
      lsState.runState = 'RUN_STATE_IDLE';
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage') {
      lsState.runState = 'RUN_STATE_RUNNING';
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
      res.end(JSON.stringify({ generatorMetadata: [] }));
      return;
    }
    if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
      res.end(JSON.stringify({ clientModelConfigs: [] }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  const reg = loadRegistry();
  reg.coordinators[key] = {
    key,
    conversationId: 'coord-sync-1',
    projectId: 'proj-sync',
    workspacePath: repoDir,
    repoRoot: repoDir,
    defaultBranch: 'main',
    title: '[Coordinator] Sync Repo',
  };
  reg.threads['pt-sync-thr-001'] = {
    threadId: 'pt-sync-thr-001',
    projectSeq: 1,
    localId: 'thr-001',
    displayId: 'thr-001',
    conversationId: 'conv-worker-sync-1',
    coordinatorId: 'coord-sync-1',
    workspaceKey: key,
    projectId: 'proj-sync',
    workspacePath: repoDir,
    repoRoot: repoDir,
    title: 'Investigate race',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    archived: false,
    lastCompletedAt: '',
    notifiedCoordinatorAt: '',
    pushedToCoordinatorAt: '',
    createdAt: new Date(Date.now() - 30_000).toISOString(),
    updatedAt: new Date(Date.now() - 20_000).toISOString(),
  };
  saveRegistry(reg);

  // Transcript has an intermediate assistant response before the user manually stops it
  writeTranscript(appDataDir, 'conv-worker-sync-1', [
    {
      step_index: 0,
      type: 'USER_INPUT',
      content: 'Investigate race',
      created_at: new Date(Date.now() - 25_000).toISOString(),
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      content: 'Preliminary partial output before user canceled.',
      tool_calls: [],
      created_at: new Date(Date.now() - 20_000).toISOString(),
    },
  ]);

  // 1. User clicks Stop -> LS cancels and local thread settles cleanly
  const cancelRes = await cancelThread({ threadId: 'thr-001', workspacePath: repoDir });
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.canceled, true);

  // 2. Automated completion sync (Stop / syncThreads reconciler) MUST suppress false callback
  const autoSyncRes = await syncCompletionToCoordinator({
    threadId: 'pt-sync-thr-001',
    force: false,
  });
  assert.equal(autoSyncRes.synced, false);
  assert.equal(autoSyncRes.reason, 'suppressed_by_manual_cancel');

  // Stop hook invocation with non-USER_CANCELED fallback reason must also suppress callback
  const stopHookRes = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'hook-handler.mjs'), 'Stop'], {
    input: JSON.stringify({
      hookEventName: 'Stop',
      conversationId: 'conv-worker-sync-1',
      terminationReason: 'NO_TOOL_CALL',
    }),
    encoding: 'utf8',
    env: process.env,
  });
  assert.equal(stopHookRes.status, 0);

  // PreInvocation hook on coordinator must not inject stale completion notice for canceled thread
  const preHookRes = spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts', 'hook-handler.mjs'), 'PreInvocation'],
    {
      input: JSON.stringify({
        hookEventName: 'PreInvocation',
        conversationId: 'coord-sync-1',
        lastUserInput: 'Status check?',
      }),
      encoding: 'utf8',
      env: process.env,
    },
  );
  assert.equal(preHookRes.status, 0);
  assert.equal(preHookRes.stdout.includes('[Project Threads Update]'), false);

  await syncThreads({ workspacePath: repoDir, backgroundSideEffects: false });
  assert.equal(existsSync(sendLog), false, 'Canceled turn must never dispatch [THREAD_COMPLETION_SYNC]');

  // 3. Follow-up message restarts the thread -> subsequent turn completion MUST sync normally!
  const followUpRes = await sendThreadMessage({
    threadId: 'thr-001',
    workspacePath: repoDir,
    message: 'Please continue and finish the analysis.',
  });
  assert.equal(followUpRes.ok, true);
  assert.equal(Boolean(loadRegistry().threads['pt-sync-thr-001'].canceledAt), false);

  lsState.runState = 'RUN_STATE_IDLE';
  writeTranscript(appDataDir, 'conv-worker-sync-1', [
    {
      step_index: 0,
      type: 'USER_INPUT',
      content: 'Investigate race',
      created_at: new Date(Date.now() - 25_000).toISOString(),
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      content: 'Preliminary partial output before user canceled.',
      tool_calls: [],
      created_at: new Date(Date.now() - 20_000).toISOString(),
    },
    {
      step_index: 2,
      type: 'USER_INPUT',
      content: 'Please continue and finish the analysis.',
      created_at: new Date(Date.now() - 5_000).toISOString(),
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      content: '### Thread Summary\nCompleted full analysis after restart.',
      tool_calls: [],
      created_at: new Date().toISOString(),
    },
  ]);

  const restartedSyncRes = await syncCompletionToCoordinator({
    threadId: 'pt-sync-thr-001',
    force: false,
  });
  assert.equal(restartedSyncRes.ok, true);
  assert.equal(restartedSyncRes.synced, true);
  assert.equal(existsSync(sendLog), true);
  const sentLines = readFileSync(sendLog, 'utf8').trim().split('\n');
  assert.equal(sentLines.length, 1);
  assert.match(sentLines[0], /\[THREAD_COMPLETION_SYNC\]/);
  assert.match(sentLines[0], /Completed full analysis after restart/);
});

test('Issue #20 Sidecar API & Frontend UI: rev 9, thread_cancel capability, click vs Enter isolation, #thread-toast 3-way routing, and static hygiene', async (t) => {
  const mainMjs = readFileSync(join(REPO_ROOT, 'sidecars/threads/main.mjs'), 'utf8');
  const appJs = readFileSync(join(REPO_ROOT, 'sidecars/threads/app.js'), 'utf8');
  const indexHtml = readFileSync(join(REPO_ROOT, 'sidecars/threads/index.html'), 'utf8');
  const themeCss = readFileSync(join(REPO_ROOT, 'sidecars/threads/theme.css'), 'utf8');

  // 1. Server API revision 9 & capability wiring
  assert.match(mainMjs, /const\s+SERVER_API_REVISION\s*=\s*9\s*;/);
  assert.match(mainMjs, /['"]thread_cancel['"]/);
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/thread_cancel['"],\s*handleThreadCancel\)/);
  assert.match(mainMjs, /handleThreadCancel[\s\S]*?serverInfo:\s*buildServerInfo\(\)/);
  assert.match(appJs, /const\s+EXPECTED_SERVER_API_REVISION\s*=\s*9\s*;/);
  assert.match(appJs, /function\s+supportsThreadCancel\s*\(/);
  assert.match(appJs, /serverCapabilities\.has\(['"]thread_cancel['"]\)/);
  assert.match(
    appJs,
    /postApi\(\s*['"]\/api\/thread_cancel['"][\s\S]*?timeoutMs:\s*0[\s\S]*?allowGetFallback:\s*false[\s\S]*?expectServerInfo:\s*true/,
  );
  assert.match(appJs, /!res\?\.ok\s*\|\|\s*res\.action\s*!==\s*['"]cancel['"]/);
  assert.match(appJs, /elSendBtn\.addEventListener\(\s*['"]click['"]\s*,\s*handleComposerPrimaryAction\s*\)/);

  // Verify #thread-toast DOM & CSS exist
  assert.match(indexHtml, /id="thread-toast-bar"/);
  assert.match(indexHtml, /id="thread-toast"/);
  assert.match(indexHtml, /id="thread-toast-detail"/);
  assert.match(themeCss, /\.thread-toast-bar\s*\{/);

  // 2. Invoke main.mjs handler through mocked sidecar_sdk in temp env
  const { tempRoot } = createTempEnv(t, 'pt-main-cancel-');
  const repoDir = join(tempRoot, 'repo-sidecar');
  initGitRepo(repoDir);
  const key = normalizeKey(repoDir);
  const reg = loadRegistry();
  reg.coordinators[key] = {
    key,
    conversationId: 'coord-sidecar-1',
    workspacePath: repoDir,
    repoRoot: repoDir,
    title: '[Coordinator] Sidecar Repo',
  };
  reg.threads['pt-sc-thr-001'] = {
    threadId: 'pt-sc-thr-001',
    projectSeq: 1,
    localId: 'thr-001',
    displayId: 'thr-001',
    conversationId: 'conv-sc-worker-1',
    coordinatorId: 'coord-sidecar-1',
    workspaceKey: key,
    workspacePath: repoDir,
    repoRoot: repoDir,
    title: 'Sidecar Cancel Target',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    archived: false,
    createdAt: '2026-11-29T02:00:00.000Z',
    updatedAt: '2026-11-29T02:00:00.000Z',
  };
  saveRegistry(reg);

  await startMockLsServer(t, (req, res, body) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/exa.language_server_pb.LanguageServerService/CancelCascadeInvocation') {
      res.end(JSON.stringify({ ok: true, cascadeId: body.cascadeId }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  // Execute main.mjs with stubbed sidecar_sdk via ESM loader hook in a small child process
  const sdkShimPath = join(tempRoot, 'sidecar-sdk-stub.mjs');
  writeFileSync(
    sdkShimPath,
    `export class Response { constructor(body, init) { this.body = body; this.init = init; } }
export class SidecarApp {
  constructor() { this.routes = []; }
  page() {}
  api(path, handler, method) { this.routes.push({ path, handler, method }); globalThis.__PT_ROUTES = this.routes; }
  run() {}
  start() {}
}
`,
    'utf8',
  );
  const loaderHookPath = join(tempRoot, 'loader.mjs');
  writeFileSync(
    loaderHookPath,
    `import { pathToFileURL } from 'node:url';
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'sidecar_sdk') {
    return { url: pathToFileURL(${JSON.stringify(sdkShimPath)}).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`,
    'utf8',
  );
  const driverPath = join(tempRoot, 'run-main-route.mjs');
  writeFileSync(
    driverPath,
    `import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register(pathToFileURL(${JSON.stringify(loaderHookPath)}).href);
await import(pathToFileURL(${JSON.stringify(join(REPO_ROOT, 'sidecars/threads/main.mjs'))}).href);
const routes = globalThis.__PT_ROUTES || [];
const postCancel = routes.find((r) => r.path === '/api/thread_cancel' && r.method === 'POST');
const getCancel = routes.find((r) => r.path === '/api/thread_cancel_get' && r.method === 'GET');
const resOk = await postCancel.handler({ threadId: 'thr-001', workspace: ${JSON.stringify(repoDir)} });
const resErr = await getCancel.handler({ threadId: 'thr-001' });
process.stdout.write(JSON.stringify({ hasPost: Boolean(postCancel), hasGet: Boolean(getCancel), resOk, resErr }));
process.exit(0);
`,
    'utf8',
  );
  const { stdout: routeRun } = await execFileAsync(process.execPath, [driverPath], {
    cwd: REPO_ROOT,
    env: process.env,
    encoding: 'utf8',
  });
  const routeResult = JSON.parse(routeRun);
  assert.equal(routeResult.hasPost, true);
  assert.equal(routeResult.hasGet, true);
  assert.equal(routeResult.resOk.ok, true, JSON.stringify(routeResult.resOk));
  assert.equal(routeResult.resOk.action, 'cancel');
  assert.equal(routeResult.resOk.canceled, true);
  assert.equal(routeResult.resOk.serverInfo.apiRevision, 9);
  assert.equal(routeResult.resOk.serverInfo.capabilities.includes('thread_cancel'), true);
  assert.equal(routeResult.resErr.ok, false);
  assert.equal(routeResult.resErr.action, 'cancel');
  assert.match(routeResult.resErr.error, /Project scope is required/);
  assert.equal(routeResult.resErr.serverInfo.apiRevision, 9);

  // 3. Frontend VM harness: button state, click vs Enter isolation, capability check, write safety, #thread-toast 3-way routing
  const i18nStart = appJs.indexOf('const I18N = {');
  let depth = 0;
  let inBrace = false;
  let i18nEnd = -1;
  for (let i = i18nStart; i < appJs.length; i++) {
    if (appJs[i] === '{') {
      depth++;
      inBrace = true;
    } else if (appJs[i] === '}') {
      depth--;
      if (inBrace && depth === 0) {
        i18nEnd = i + 1;
        break;
      }
    }
  }
  const constStart = appJs.indexOf('const BOARD_POLL_MS');
  const constEnd = appJs.indexOf('const params =', constStart);
  const apiStart = appJs.indexOf('function createApiError(');
  const apiEnd = appJs.indexOf('// ---------- Rich Markdown', apiStart);
  const fnNames = [
    'syncSendButtonState',
    'renderBoardToast',
    'scheduleBoardToastTimer',
    'pauseBoardToastTimer',
    'resumeBoardToastTimer',
    'toggleToastDetail',
    'clearToast',
    'clearExpiredToastOnRecovery',
    'flashToast',
    'supportsThreadCancel',
    'sendChatFollowUp',
    'isSendButtonStopMode',
    'cancelRunningThread',
    'handleComposerPrimaryAction',
  ];
  const extractedFns = fnNames.map((fn) => extractFunctionSource(appJs, fn)).join('\n');

  const makeMockEl = (id = '') => {
    const classes = new Set();
    const attrs = {};
    return {
      id,
      className: '',
      textContent: '',
      innerHTML: '',
      title: '',
      value: '',
      disabled: false,
      hidden: false,
      scrollTop: 0,
      scrollHeight: 100,
      style: {},
      dataset: {},
      attrs,
      classList: {
        add: (...names) => names.forEach((n) => classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        toggle: (n, force) => {
          if (force === undefined) {
            if (classes.has(n)) classes.delete(n);
            else classes.add(n);
          } else if (force) {
            classes.add(n);
          } else {
            classes.delete(n);
          }
        },
        contains: (n) => classes.has(n),
      },
      setAttribute(k, v) {
        attrs[k] = String(v);
      },
      removeAttribute(k) {
        delete attrs[k];
      },
      querySelector(sel) {
        if (sel === '.stop-sq') return this.innerHTML.includes('stop-sq') ? {} : null;
        if (sel === 'svg') return this.innerHTML.includes('<svg') ? {} : null;
        return null;
      },
      appendChild() {},
      focus() {},
    };
  };

  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeMockEl(id));
    return elements.get(id);
  };
  const elBoardScreen = getEl('board-screen');
  const elThreadScreen = getEl('thread-screen');
  const elSettingsScreen = getEl('settings-screen');
  elBoardScreen.hidden = true;
  elThreadScreen.hidden = false;
  elSettingsScreen.hidden = true;
  const elChatInput = getEl('chat-input');
  const elSendBtn = getEl('btn-send');
  const elChatStream = getEl('chat-stream');
  const elLiveBar = getEl('live-bar');
  const elToast = getEl('toast');
  const elToastDetail = getEl('toast-detail');
  elToastDetail.hidden = true;
  const elToastDetailMsg = getEl('toast-detail-msg');
  const elToastDetailCopy = getEl('toast-detail-copy');
  const elToastDetailClose = getEl('toast-detail-close');
  const elThreadToastBar = getEl('thread-toast-bar');
  elThreadToastBar.hidden = true;
  const elThreadToast = getEl('thread-toast');
  const elThreadToastDetail = getEl('thread-toast-detail');
  elThreadToastDetail.hidden = true;
  const elThreadToastDetailMsg = getEl('thread-toast-detail-msg');
  const elThreadToastDetailCopy = getEl('thread-toast-detail-copy');
  const elThreadToastDetailClose = getEl('thread-toast-detail-close');
  const elSettingsToast = getEl('settings-toast');

  const fetchCalls = [];
  const headerUpdates = [];
  const refreshCalls = [];
  const refreshBoardCalls = [];
  let nextResponseFactory = () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () =>
      JSON.stringify({
        ok: true,
        action: 'cancel',
        canceled: true,
        alreadyIdle: false,
        locale: 'zh-CN',
        serverInfo: {
          apiRevision: 9,
          capabilities: ['update_status', 'update_check', 'update_apply', 'thread_cancel'],
          versionDrifted: false,
        },
        thread: {
          threadId: 'pt-ui-thr-001',
          runState: 'RUN_STATE_IDLE',
          hasPendingBgTask: false,
          bucket: 'idle',
          archived: false,
        },
      }),
  });

  const vmCtx = {
    console,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Promise,
    Error,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Math,
    JSON,
    document: {
      createElement: () => makeMockEl('tmp'),
      getElementById: getEl,
    },
    doFetch: async (url, opts) => {
      fetchCalls.push({ url: String(url), opts });
      return nextResponseFactory(url, opts);
    },
    fetch: async (url, opts) => {
      fetchCalls.push({ url: String(url), opts });
      return nextResponseFactory(url, opts);
    },
    headerUpdates,
    refreshCalls,
    refreshBoardCalls,
  };

  vm.runInNewContext(
    `
    ${appJs.slice(constStart, constEnd)}
    ${appJs.slice(i18nStart, i18nEnd)}
    let curLocale = 'zh-CN';
    const L = () => I18N[curLocale] || I18N.en;
    const ICONS = { arrowUp: '<svg></svg>' };
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    let scopeEpoch = 1;
    let settingsScreenOpen = false;
    let openThreadId = 'pt-ui-thr-001';
    let openThreadObj = {
      threadId: 'pt-ui-thr-001',
      runState: 'RUN_STATE_RUNNING',
      hasPendingBgTask: false,
      archived: false,
    };
    let lastThreadStamp = 'st-prev';
    let backendVersionMismatch = null;
    let serverCapabilities = new Set(['thread_cancel']);
    let sidecarFetchSupportsSignal = null;
    const pendingModelByThread = new Map();
    const cancelingThreadIds = new Set();
    let sendFollowUpInFlight = false;
    const boardToastState = { text: '', tone: 'ok', timer: null, expiresAt: 0, remainingMs: 0, hoverPaused: false, detailOpen: false };
    const threadToastState = { text: '', tone: 'ok', timer: null, expiresAt: 0, remainingMs: 0, hoverPaused: false, detailOpen: false };
    const settingsToastState = { text: '', tone: 'ok', timer: null, expiresAt: 0 };
    let toastCopyResetTimer = null;
    let threadToastCopyResetTimer = null;
    const elBoardScreen = document.getElementById('board-screen');
    const elThreadScreen = document.getElementById('thread-screen');
    const elSettingsScreen = document.getElementById('settings-screen');
    const elChatInput = document.getElementById('chat-input');
    const elSendBtn = document.getElementById('btn-send');
    const elChatStream = document.getElementById('chat-stream');
    const elLiveBar = document.getElementById('live-bar');
    const elToast = document.getElementById('toast');
    const elToastDetail = document.getElementById('toast-detail');
    const elToastDetailMsg = document.getElementById('toast-detail-msg');
    const elToastDetailCopy = document.getElementById('toast-detail-copy');
    const elToastDetailClose = document.getElementById('toast-detail-close');
    const elThreadToastBar = document.getElementById('thread-toast-bar');
    const elThreadToast = document.getElementById('thread-toast');
    const elThreadToastDetail = document.getElementById('thread-toast-detail');
    const elThreadToastDetailMsg = document.getElementById('thread-toast-detail-msg');
    const elThreadToastDetailCopy = document.getElementById('thread-toast-detail-copy');
    const elThreadToastDetailClose = document.getElementById('thread-toast-detail-close');
    const elSettingsToast = document.getElementById('settings-toast');
    const applyLocale = (loc) => { if (loc) curLocale = loc; };
    const closeModelMenu = () => {};
    const autoResizeInput = () => { syncSendButtonState(); };
    const buildScopePayload = (extra = {}) => ({ workspace: '/demo/repo', workspaceKey: '/demo/repo', ...extra });
    const renderThreadHeader = (th) => { openThreadObj = th; headerUpdates.push(th); syncSendButtonState(); };
    const refreshOpenThread = async (a, b) => { refreshCalls.push({ a, b }); };
    const refreshBoard = async (force) => { refreshBoardCalls.push(Boolean(force)); };
    ${appJs.slice(apiStart, apiEnd)}
    ${extractedFns}
    this.api = {
      I18N,
      syncSendButtonState,
      handleComposerPrimaryAction,
      sendChatFollowUp,
      cancelRunningThread,
      flashToast,
      clearToast,
      toggleToastDetail,
      setThreadObj: (th) => { openThreadObj = th; syncSendButtonState(); },
      setOpenThreadId: (id) => { openThreadId = String(id || ''); },
      setCapabilities: (caps) => { serverCapabilities = new Set(caps); syncSendButtonState(); },
      setScreenState: ({ boardHidden, threadHidden, settingsOpen }) => {
        elBoardScreen.hidden = Boolean(boardHidden);
        elThreadScreen.hidden = Boolean(threadHidden);
        settingsScreenOpen = Boolean(settingsOpen);
      },
      getStates: () => ({
        openThreadObj,
        lastThreadStamp,
        boardToastText: boardToastState.text,
        threadToastText: threadToastState.text,
        settingsToastText: settingsToastState.text,
      }),
    };
    `,
    vmCtx,
  );

  // Check initial running + empty input -> stop button active
  vmCtx.api.syncSendButtonState();
  assert.equal(elSendBtn.classList.contains('running-stop'), true);
  assert.equal(elSendBtn.dataset.mode, 'stop');
  assert.equal(elSendBtn.title, vmCtx.api.I18N['zh-CN'].stopThreadTip);

  // Check hasPendingBgTask=true also activates stop button
  vmCtx.api.setThreadObj({
    threadId: 'pt-ui-thr-001',
    runState: 'RUN_STATE_IDLE',
    hasPendingBgTask: true,
    archived: false,
  });
  assert.equal(elSendBtn.classList.contains('running-stop'), true);
  assert.equal(elSendBtn.dataset.mode, 'stop');

  // Empty input Enter calls sendChatFollowUp() -> MUST be no-op (0 fetch calls)
  elChatInput.value = '   ';
  await vmCtx.api.sendChatFollowUp();
  assert.equal(fetchCalls.length, 0, 'Enter on empty input must NEVER cancel thread');

  // Typing text switches button back to ready send mode and clicks send /api/thread_send
  elChatInput.value = 'Check status';
  vmCtx.api.syncSendButtonState();
  assert.equal(elSendBtn.classList.contains('running-stop'), false);
  assert.equal(elSendBtn.classList.contains('ready'), true);
  assert.equal(elSendBtn.dataset.mode, 'send');
  nextResponseFactory = () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () =>
      JSON.stringify({
        ok: true,
        thread: {
          threadId: 'pt-ui-thr-001',
          runState: 'RUN_STATE_RUNNING',
          hasPendingBgTask: false,
          archived: false,
        },
      }),
  });
  await vmCtx.api.handleComposerPrimaryAction();
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/thread_send');

  // Clear input -> stop mode; clicking #btn-send calls /api/thread_cancel with strict POST & no GET fallback
  fetchCalls.length = 0;
  elChatInput.value = '';
  vmCtx.api.syncSendButtonState();
  assert.equal(elSendBtn.classList.contains('running-stop'), true);

  // Concurrent double-click while first request is in-flight only fires once
  let resolveSlowCancel = null;
  nextResponseFactory = () =>
    new Promise((resolve) => {
      resolveSlowCancel = () =>
        resolve({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () =>
            JSON.stringify({
              ok: true,
              action: 'cancel',
              canceled: true,
              alreadyIdle: false,
              locale: 'zh-CN',
              serverInfo: {
                apiRevision: 9,
                capabilities: ['update_status', 'update_check', 'update_apply', 'thread_cancel'],
                versionDrifted: false,
              },
              thread: {
                threadId: 'pt-ui-thr-001',
                runState: 'RUN_STATE_IDLE',
                hasPendingBgTask: false,
                bucket: 'idle',
                archived: false,
              },
            }),
        });
    });

  const firstClick = vmCtx.api.handleComposerPrimaryAction();
  assert.equal(elSendBtn.disabled, true);
  assert.equal(elSendBtn.classList.contains('is-canceling'), true);
  const secondClick = vmCtx.api.handleComposerPrimaryAction();
  assert.equal(fetchCalls.length, 1, 'cancelingThreadIds lock must block duplicate concurrent clicks');
  resolveSlowCancel();
  await Promise.all([firstClick, secondClick]);

  assert.equal(fetchCalls[0].url, '/api/thread_cancel');
  assert.equal(fetchCalls[0].opts.method, 'POST');
  assert.equal(elSendBtn.disabled, false);
  assert.equal(elSendBtn.classList.contains('running-stop'), false);
  assert.equal(elThreadToastBar.hidden, false);
  assert.equal(elThreadToast.textContent, vmCtx.api.I18N['zh-CN'].stopThreadOk);
  assert.equal(elToast.textContent, '', 'thread toast must not leak to #toast');
  assert.equal(refreshCalls.length >= 1, true);

  // Missing res.action === 'cancel' is rejected visibly in #thread-toast
  vmCtx.api.setThreadObj({
    threadId: 'pt-ui-thr-001',
    runState: 'RUN_STATE_RUNNING',
    hasPendingBgTask: false,
    archived: false,
  });
  nextResponseFactory = () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () =>
      JSON.stringify({
        ok: true,
        action: 'wrong_action',
        serverInfo: {
          apiRevision: 9,
          capabilities: ['update_status', 'update_check', 'update_apply', 'thread_cancel'],
          versionDrifted: false,
        },
      }),
  });
  await vmCtx.api.handleComposerPrimaryAction();
  assert.match(elThreadToast.className, /toast err is-interactive/);
  assert.match(elThreadToast.innerHTML, /data-toast-action="close"/);

  // HTTP 404 on /api/thread_cancel MUST NOT fall back to GET and surfaces reload notice
  fetchCalls.length = 0;
  nextResponseFactory = () => ({
    ok: false,
    status: 404,
    headers: { get: () => 'text/plain' },
    text: async () => 'Not Found',
  });
  await vmCtx.api.handleComposerPrimaryAction();
  assert.equal(fetchCalls.length, 1, 'allowGetFallback: false must never issue _get replay');
  assert.equal(fetchCalls[0].url, '/api/thread_cancel');
  assert.equal(elThreadToastDetailMsg.textContent, vmCtx.api.I18N['zh-CN'].stopThreadUnsupportedErr);

  // Missing thread_cancel capability shows visible reload notice in #thread-toast without hitting network
  fetchCalls.length = 0;
  vmCtx.api.setCapabilities([]);
  await vmCtx.api.handleComposerPrimaryAction();
  assert.equal(fetchCalls.length, 0);
  assert.match(elThreadToast.className, /toast warn is-interactive/);
  assert.equal(elThreadToastDetailMsg.textContent, vmCtx.api.I18N['zh-CN'].stopThreadUnsupportedErr);

  // Detail toggle works on #thread-toast-detail
  vmCtx.api.toggleToastDetail(true, 'thread');
  assert.equal(elThreadToastDetail.hidden, false);
  vmCtx.api.clearToast({ target: 'thread' });
  assert.equal(elThreadToastBar.hidden, true);
  assert.equal(elThreadToastDetail.hidden, true);

  // Verify 3-way routing: board vs thread vs settings
  vmCtx.api.setScreenState({ boardHidden: false, threadHidden: true, settingsOpen: false });
  vmCtx.api.flashToast('Board notice', 'ok', 2000);
  assert.equal(elToast.textContent, 'Board notice');
  assert.equal(elThreadToast.textContent, '');
  vmCtx.api.setScreenState({ boardHidden: true, threadHidden: true, settingsOpen: true });
  vmCtx.api.flashToast('Settings notice', 'ok', 2000);
  assert.equal(elSettingsToast.textContent, 'Settings notice');

  // [P2-1] Context-aware toast & board refresh when user leaves/switches away from canceling thread
  vmCtx.api.setCapabilities(['thread_cancel']);
  vmCtx.api.setScreenState({ boardHidden: true, threadHidden: false, settingsOpen: false });
  vmCtx.api.setOpenThreadId('pt-ui-thr-001');
  vmCtx.api.setThreadObj({
    threadId: 'pt-ui-thr-001',
    localId: 'thr-001',
    displayId: 'thr-001',
    runState: 'RUN_STATE_RUNNING',
    hasPendingBgTask: false,
    archived: false,
  });
  let resolveSwitchedCancel = null;
  nextResponseFactory = () =>
    new Promise((resolve) => {
      resolveSwitchedCancel = () =>
        resolve({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () =>
            JSON.stringify({
              ok: true,
              action: 'cancel',
              canceled: true,
              alreadyIdle: false,
              locale: 'zh-CN',
              serverInfo: {
                apiRevision: 9,
                capabilities: ['thread_cancel'],
                versionDrifted: false,
              },
              thread: {
                threadId: 'pt-ui-thr-001',
                localId: 'thr-001',
                displayId: 'thr-001',
                runState: 'RUN_STATE_IDLE',
                hasPendingBgTask: false,
                archived: false,
              },
            }),
        });
    });
  refreshCalls.length = 0;
  refreshBoardCalls.length = 0;
  const switchedCancelPromise = vmCtx.api.cancelRunningThread();
  // User switches to another thread B while cancel is in-flight
  vmCtx.api.setOpenThreadId('pt-ui-thr-002');
  vmCtx.api.setThreadObj({
    threadId: 'pt-ui-thr-002',
    localId: 'thr-002',
    runState: 'RUN_STATE_IDLE',
    archived: false,
  });
  resolveSwitchedCancel();
  await switchedCancelPromise;
  assert.equal(
    elThreadToast.textContent,
    `[thr-001] ${vmCtx.api.I18N['zh-CN'].stopThreadOk}`,
    'Switched-thread cancel toast must prefix [thr-NNN]',
  );
  assert.equal(refreshCalls.length, 0, 'Must not refresh thread B after thread A cancel');

  // Now close drawer while cancel is in-flight -> routes to board toast and calls refreshBoard(false)
  vmCtx.api.setOpenThreadId('pt-ui-thr-001');
  vmCtx.api.setThreadObj({
    threadId: 'pt-ui-thr-001',
    localId: 'thr-001',
    displayId: 'thr-001',
    runState: 'RUN_STATE_RUNNING',
    hasPendingBgTask: false,
    archived: false,
  });
  let resolveBoardCancel = null;
  nextResponseFactory = () =>
    new Promise((resolve) => {
      resolveBoardCancel = () =>
        resolve({
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () =>
            JSON.stringify({
              ok: true,
              action: 'cancel',
              canceled: true,
              alreadyIdle: false,
              locale: 'zh-CN',
              serverInfo: {
                apiRevision: 9,
                capabilities: ['thread_cancel'],
                versionDrifted: false,
              },
              thread: {
                threadId: 'pt-ui-thr-001',
                localId: 'thr-001',
                displayId: 'thr-001',
                runState: 'RUN_STATE_IDLE',
                hasPendingBgTask: false,
                archived: false,
              },
            }),
        });
    });
  const boardCancelPromise = vmCtx.api.cancelRunningThread();
  // User returns to Kanban board
  vmCtx.api.setScreenState({ boardHidden: false, threadHidden: true, settingsOpen: false });
  vmCtx.api.setOpenThreadId('');
  vmCtx.api.setThreadObj(null);
  resolveBoardCancel();
  await boardCancelPromise;
  assert.equal(refreshBoardCalls.length, 1, 'Returning to board after cancel must trigger refreshBoard(false)');
  assert.equal(refreshBoardCalls[0], false);
  assert.equal(elToast.textContent, `[thr-001] ${vmCtx.api.I18N['zh-CN'].stopThreadOk}`);

  // [P2-2] #thread-toast-detail long message container must cap max-height with vertical scroll
  const toastDetailThemeCss = readFileSync(join(REPO_ROOT, 'sidecars/threads/theme.css'), 'utf8');
  assert.match(
    toastDetailThemeCss,
    /#thread-toast-detail\s+\.toast-detail-msg\s*\{[\s\S]*?max-height:\s*160px;[\s\S]*?overflow-y:\s*auto;/,
  );

  // 4. Trilingual I18N keys & zero middle dots & zero native dialogs & strict LF
  const stopKeys = [
    'stopThreadTip',
    'stoppingThreadTip',
    'stopThreadUnsupportedTip',
    'stopThreadOk',
    'stopThreadAlreadyIdleOk',
    'stopThreadErr',
    'stopThreadUnsupportedErr',
  ];
  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    for (const k of stopKeys) {
      const val = vmCtx.api.I18N[loc][k];
      assert.ok(typeof val === 'string' && val.length > 0, `Missing I18N.${loc}.${k}`);
      assert.equal(val.includes('\u00b7'), false, `I18N.${loc}.${k} must not contain U+00B7`);
    }
  }
  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appJs), false);

  const mjsFiles = ['lib', 'mcp', 'scripts', 'sidecars/threads', 'tests'].flatMap((dir) => {
    const abs = join(REPO_ROOT, dir);
    return readdirSync(abs)
      .filter((f) => f.endsWith('.mjs'))
      .map((f) => `${dir}/${f}`);
  });
  for (const rel of mjsFiles) {
    const raw = readFileSync(join(REPO_ROOT, rel));
    assert.equal(raw.includes(Buffer.from('\r')), false, `${rel} must use strict LF`);
  }
  const zeroDotDirs = ['lib', 'mcp', 'scripts', 'sidecars/threads', 'skills', 'rules'];
  const zeroDotFiles = [
    ...zeroDotDirs.flatMap((dir) =>
      readdirSync(join(REPO_ROOT, dir))
        .filter((f) => /\.(?:mjs|js|md|html|css|json|sh|cmd)$/i.test(f))
        .map((f) => `${dir}/${f}`),
    ),
    'tests/thread-cancel.test.mjs',
  ];
  for (const rel of zeroDotFiles) {
    const raw = readFileSync(join(REPO_ROOT, rel), 'utf8');
    assert.equal(raw.includes('\u00b7'), false, `${rel} must have zero U+00B7`);
  }
});

test('5. P0-1: saveRegistry merge uses monotonic cancelClearedAt tombstone and never resurrects canceledAt', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-cancel-p0-1-');
  const repoDir = join(tempRoot, 'repo-p0-1');
  initGitRepo(repoDir);
  const scopeKey = normalizeKey(repoDir);

  const t0 = '2026-11-29T02:00:00.000Z';
  const lsState = { runState: 'RUN_STATE_IDLE', updateTime: t0 };
  const mockLs = await startMockLsServer(t, (req, res, body) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/product.v1.ConversationService/GetConversation') {
      res.end(
        JSON.stringify({
          conversation: {
            id: body.conversationId,
            conversationId: body.conversationId,
            state: { runState: lsState.runState, updateTime: lsState.updateTime },
            annotations: { archived: false },
          },
        }),
      );
      return;
    }
    if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
      res.end(JSON.stringify({ generatorMetadata: [] }));
      return;
    }
    if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
      res.end(JSON.stringify({ clientModelConfigs: [] }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  process.env.ANTIGRAVITY_LS_ADDRESS = mockLs.address;
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-p0-1';

  const sendLog = join(tempRoot, 'agentapi.log');
  process.env.ANTIGRAVITY_AGENTAPI_EXE = writeMockAgentApi(tempRoot, sendLog);

  const reg = loadRegistry();
  reg.coordinators[scopeKey] = {
    key: scopeKey,
    conversationId: 'coord-p0-1',
    workspacePath: repoDir,
    repoRoot: repoDir,
    projectId: 'proj-p0-1',
    title: '[Coordinator] P0-1',
  };
  reg.threads['pt-p01-thr-001'] = {
    threadId: 'pt-p01-thr-001',
    projectSeq: 1,
    localId: 'thr-001',
    displayId: 'thr-001',
    conversationId: 'conv-p01-1',
    coordinatorId: 'coord-p0-1',
    workspaceKey: scopeKey,
    projectId: 'proj-p0-1',
    workspacePath: repoDir,
    repoRoot: repoDir,
    title: 'Tombstone Test',
    runState: 'RUN_STATE_IDLE',
    hasPendingBgTask: false,
    bucket: 'idle',
    archived: false,
    canceledAt: t0,
    canceledStepIndex: 1,
    createdAt: t0,
    updatedAt: t0,
  };
  saveRegistry(reg);

  // Same-millisecond clear must strictly bump cancelClearedAt > t0 and preserve RUN_STATE_RUNNING
  // even when disk holds older/equal canceledAt = t0 and stale updatedAt <= disk.canceledAt!
  const memReg = loadRegistry();
  const memT = memReg.threads['pt-p01-thr-001'];
  clearManualCancelFieldsInRecord(memT, t0);
  memT.runState = 'RUN_STATE_RUNNING';
  memT.updatedAt = '2026-11-29T01:59:59.000Z'; // Deliberately stale updatedAt < diskT.canceledAt
  assert.equal('canceledAt' in memT, false);
  assert.equal(memT.cancelClearedAt > t0, true, 'Same-ms clear must strictly advance cancelClearedAt past canceledAt');

  saveRegistry(memReg);
  const mergedSameMs = loadRegistry();
  assert.equal(mergedSameMs.threads['pt-p01-thr-001'].canceledAt, undefined);
  assert.equal(mergedSameMs.threads['pt-p01-thr-001'].runState, 'RUN_STATE_RUNNING');
  assert.equal(mergedSameMs.threads['pt-p01-thr-001'].cancelClearedAt > t0, true);

  // Simulate another writer flushing a stale disk snapshot with canceledAt=t0 & no cancelClearedAt,
  // then saving our resumed memReg (with stale updatedAt < t0): cancelClearedAt must win cleanly!
  const regPath = join(tempRoot, '.gemini', 'antigravity', 'project-threads', 'registry.json');
  const staleDisk = loadRegistry();
  staleDisk.threads['pt-p01-thr-001'].canceledAt = t0;
  staleDisk.threads['pt-p01-thr-001'].canceledStepIndex = 1;
  delete staleDisk.threads['pt-p01-thr-001'].cancelClearedAt;
  staleDisk.threads['pt-p01-thr-001'].runState = 'RUN_STATE_IDLE';
  staleDisk.threads['pt-p01-thr-001'].updatedAt = t0;
  writeFileSync(regPath, JSON.stringify(staleDisk, null, 2), 'utf8');

  saveRegistry(memReg);
  const afterMerge = loadRegistry();
  assert.equal(afterMerge.threads['pt-p01-thr-001'].canceledAt, undefined);
  assert.equal(afterMerge.threads['pt-p01-thr-001'].runState, 'RUN_STATE_RUNNING');
  assert.equal(afterMerge.threads['pt-p01-thr-001'].cancelClearedAt > t0, true);

  // Verify getThreadMessages clearing cancel (on new user turn) also writes cancelClearedAt monotonically
  writeTranscript(appDataDir, 'conv-p01-1', [
    { step_index: 0, type: 'USER_INPUT', content: 'start', created_at: t0 },
    { step_index: 1, type: 'PLANNER_RESPONSE', content: 'partial', created_at: t0 },
    { step_index: 2, type: 'USER_INPUT', content: 'sidebar resume', created_at: '2026-11-29T02:00:05.000Z' },
  ]);
  const rReset = loadRegistry();
  rReset.threads['pt-p01-thr-001'].canceledAt = '2026-11-29T02:00:02.000Z';
  rReset.threads['pt-p01-thr-001'].canceledStepIndex = 1;
  rReset.threads['pt-p01-thr-001'].runState = 'RUN_STATE_RUNNING';
  delete rReset.threads['pt-p01-thr-001'].cancelClearedAt;
  saveRegistry(rReset);
  lsState.runState = 'RUN_STATE_RUNNING';
  lsState.updateTime = '2026-11-29T02:00:05.000Z';
  await getThreadMessages({ threadId: 'thr-001', workspacePath: repoDir });
  const afterMsgRead = loadRegistry().threads['pt-p01-thr-001'];
  assert.equal(afterMsgRead.canceledAt, undefined);
  assert.ok(afterMsgRead.cancelClearedAt > '2026-11-29T02:00:02.000Z');
});

test('6. P0-2: Native sidebar resumption lifts cancel suppression across Stop, PreInvocation, syncCompletionToCoordinator, and syncThreads (including step 0 pre-reply cancel)', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-cancel-p0-2-');
  const repoDir = join(tempRoot, 'repo-p0-2');
  initGitRepo(repoDir);
  const scopeKey = normalizeKey(repoDir);

  const sendLog = join(tempRoot, 'agentapi.log');
  process.env.ANTIGRAVITY_AGENTAPI_EXE = writeMockAgentApi(tempRoot, sendLog);

  const t0 = new Date(Date.now() - 20_000).toISOString();
  const tCancel = new Date(Date.now() - 10_000).toISOString();
  const tResumeUser = new Date(Date.now() - 4_000).toISOString();
  const tResumeDone = new Date(Date.now() - 1_000).toISOString();

  const lsState = { runState: 'RUN_STATE_RUNNING', updateTime: t0 };
  const mockLs = await startMockLsServer(t, (req, res, body) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/exa.language_server_pb.LanguageServerService/CancelCascadeInvocation') {
      lsState.runState = 'RUN_STATE_IDLE';
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/product.v1.ConversationService/GetConversation') {
      res.end(
        JSON.stringify({
          conversation: {
            id: body.conversationId,
            conversationId: body.conversationId,
            state: { runState: lsState.runState, updateTime: lsState.updateTime },
            annotations: { archived: false },
          },
        }),
      );
      return;
    }
    if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
      res.end(JSON.stringify({ generatorMetadata: [] }));
      return;
    }
    if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
      res.end(JSON.stringify({ clientModelConfigs: [] }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  process.env.ANTIGRAVITY_LS_ADDRESS = mockLs.address;
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-p0-2';

  const reg = loadRegistry();
  reg.coordinators[scopeKey] = {
    key: scopeKey,
    conversationId: 'coord-p0-2',
    workspacePath: repoDir,
    repoRoot: repoDir,
    projectId: 'proj-p0-2',
    runState: 'RUN_STATE_IDLE',
    title: '[Coordinator] P0-2',
    directiveVersion: 18,
  };
  reg.threads['pt-p02-thr-001'] = {
    threadId: 'pt-p02-thr-001',
    projectSeq: 1,
    localId: 'thr-001',
    displayId: 'thr-001',
    conversationId: 'conv-p02-1',
    coordinatorId: 'coord-p0-2',
    workspaceKey: scopeKey,
    projectId: 'proj-p0-2',
    workspacePath: repoDir,
    repoRoot: repoDir,
    title: 'Native Sidebar Resume Before First Reply',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    archived: false,
    createdAt: t0,
    updatedAt: t0,
  };
  saveRegistry(reg);

  // Transcript only has initial step_index=0 USER_INPUT (no assistant reply yet!)
  writeTranscript(appDataDir, 'conv-p02-1', [
    { step_index: 0, type: 'USER_INPUT', content: 'Initial task', created_at: t0 },
  ]);

  // 1. Cancel BEFORE any assistant reply -> canceledStepIndex must include step_index=0 so initial user turn never un-suppresses!
  const cancelRes = await cancelThread(
    { threadId: 'thr-001', workspacePath: repoDir },
    { now: () => tCancel },
  );
  assert.equal(cancelRes.ok, true);
  const canceledRec = loadRegistry().threads['pt-p02-thr-001'];
  assert.equal(canceledRec.canceledStepIndex, 0);
  assert.equal(hasNewUserTurnAfterCancel(canceledRec, peekLiveActivity('conv-p02-1')), false);

  const preSuppressedSync = await syncCompletionToCoordinator({
    threadId: 'pt-p02-thr-001',
    force: false,
  });
  assert.equal(preSuppressedSync.synced, false);
  assert.equal(preSuppressedSync.reason, 'no_completion_content');

  // Even if lastSummary was transiently populated on disk, manual cancel still suppresses before new user turn!
  const withStaleSummary = loadRegistry();
  withStaleSummary.threads['pt-p02-thr-001'].lastSummary = 'Stale summary';
  saveRegistry(withStaleSummary);
  const suppressedWithSummary = await syncCompletionToCoordinator({
    threadId: 'pt-p02-thr-001',
    force: false,
  });
  assert.equal(suppressedWithSummary.synced, false);
  assert.equal(suppressedWithSummary.reason, 'suppressed_by_manual_cancel');

  // 2. User resumes directly in Antigravity native sidebar (writes new USER_INPUT step=1 + assistant final step=2)
  writeTranscript(appDataDir, 'conv-p02-1', [
    { step_index: 0, type: 'USER_INPUT', content: 'Initial task', created_at: t0 },
    { step_index: 1, type: 'USER_INPUT', content: 'Continue directly from native sidebar', created_at: tResumeUser },
    { step_index: 2, type: 'PLANNER_RESPONSE', content: 'Completed after native sidebar resume.', tool_calls: [], created_at: tResumeDone },
  ]);
  const postComp = extractThreadCompletion('conv-p02-1', '', { canceledAt: canceledRec.canceledAt });
  assert.equal(postComp.latestUserStepIndex, 1);
  assert.equal(hasNewUserTurnAfterCancel(canceledRec, postComp), true);

  // Verify PreInvocation lifts cancel & emits [Project Threads Update] when lastCompletedAt is already present
  const preCheckReg = loadRegistry();
  preCheckReg.threads['pt-p02-thr-001'].lastCompletedAt = tResumeDone;
  saveRegistry(preCheckReg);
  const runHookAsync = (eventName, payloadObj) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [join(REPO_ROOT, 'scripts', 'hook-handler.mjs'), eventName],
        { encoding: 'utf8', env: process.env },
        (err, stdout, stderr) => {
          if (err) reject(err);
          else resolve({ stdout, stderr });
        },
      );
      child.stdin.end(JSON.stringify(payloadObj));
    });
  const preHookRes = await runHookAsync('PreInvocation', {
    hookEventName: 'PreInvocation',
    conversationId: 'coord-p0-2',
    lastUserInput: 'Any updates?',
  });
  assert.match(preHookRes.stdout, /\[Project Threads Update\]/);
  assert.match(preHookRes.stdout, /thr-001/);
  const afterPreHook = loadRegistry().threads['pt-p02-thr-001'];
  assert.equal(afterPreHook.canceledAt, undefined);
  assert.ok(afterPreHook.cancelClearedAt);
  assert.ok(afterPreHook.notifiedCoordinatorAt);

  // 3. Re-seed canceled state (simulating PreInvocation hadn't fired yet) and test Stop hook with normal NO_TOOL_CALL reason
  const regStop = loadRegistry();
  regStop.threads['pt-p02-thr-001'].canceledAt = tCancel;
  regStop.threads['pt-p02-thr-001'].canceledStepIndex = 0;
  delete regStop.threads['pt-p02-thr-001'].cancelClearedAt;
  delete regStop.threads['pt-p02-thr-001'].lastCompletedAt;
  delete regStop.threads['pt-p02-thr-001'].notifiedCoordinatorAt;
  delete regStop.threads['pt-p02-thr-001'].pushedToCoordinatorAt;
  saveRegistry(regStop);

  lsState.runState = 'RUN_STATE_IDLE';
  lsState.updateTime = tResumeDone;
  await runHookAsync('Stop', {
    hookEventName: 'Stop',
    conversationId: 'conv-p02-1',
    terminationReason: 'NO_TOOL_CALL',
  });
  const afterStop = loadRegistry().threads['pt-p02-thr-001'];
  assert.equal(afterStop.canceledAt, undefined, 'Stop hook must clear stale cancel tombstone once resumed');
  assert.ok(afterStop.cancelClearedAt);
  assert.ok(afterStop.pushedToCoordinatorAt, 'Stop hook must push resumed completion to Coordinator');
  assert.equal(existsSync(sendLog), true);

  // 4. Independent thread resumed directly in native sidebar & converged IDLE (>8s reconciler grace) -> syncThreads heals & notifies!
  rmSync(sendLog, { force: true });
  const tStep4Cancel = new Date(Date.now() - 25_000).toISOString();
  const tStep4User = new Date(Date.now() - 12_000).toISOString();
  const tStep4Done = new Date(Date.now() - 9_500).toISOString();
  lsState.runState = 'RUN_STATE_IDLE';
  lsState.updateTime = tStep4Done;
  const regSync = loadRegistry();
  regSync.threads['pt-p02-thr-002'] = {
    threadId: 'pt-p02-thr-002',
    projectSeq: 2,
    localId: 'thr-002',
    displayId: 'thr-002',
    conversationId: 'conv-p02-2',
    coordinatorId: 'coord-p0-2',
    workspaceKey: scopeKey,
    projectId: 'proj-p0-2',
    workspacePath: repoDir,
    repoRoot: repoDir,
    title: 'Native Sidebar Idle Missed Poll',
    runState: 'RUN_STATE_IDLE',
    bucket: 'idle',
    archived: false,
    canceledAt: tStep4Cancel,
    canceledStepIndex: 0,
    createdAt: t0,
    updatedAt: tStep4Cancel,
  };
  saveRegistry(regSync);
  writeTranscript(appDataDir, 'conv-p02-2', [
    { step_index: 0, type: 'USER_INPUT', content: 'Initial prompt', created_at: t0 },
    { step_index: 1, type: 'USER_INPUT', content: 'Native sidebar follow-up', created_at: tStep4User },
    { step_index: 2, type: 'PLANNER_RESPONSE', content: 'Side-channel resume completed cleanly.', tool_calls: [], created_at: tStep4Done },
  ]);

  await syncThreads({ workspacePath: repoDir, backgroundSideEffects: false });
  const afterSync = loadRegistry().threads['pt-p02-thr-002'];
  assert.equal(afterSync.canceledAt, undefined);
  assert.ok(afterSync.cancelClearedAt);
  assert.ok(afterSync.pushedToCoordinatorAt);
  assert.equal(existsSync(sendLog), true);
});

test('7. P0-3: bgTasksKilledAt permanently suppresses pre-kill ghost background tasks across follow-ups and Watchdog while detecting new post-kill tasks', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-cancel-p0-3-');
  const repoDir = join(tempRoot, 'repo-p0-3');
  initGitRepo(repoDir);
  const scopeKey = normalizeKey(repoDir);

  const tOldUser = '2026-11-29T02:00:00.000Z';
  const tOldBg = '2026-11-29T02:00:02.000Z';
  const tCancelKill = '2026-11-29T02:01:00.000Z';
  const tFollowUp = '2026-11-29T02:02:00.000Z';
  const tNewBg = '2026-11-29T02:03:00.000Z';

  let lsRunState = 'RUN_STATE_RUNNING';
  const mockLs = await startMockLsServer(t, (req, res, body) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/exa.language_server_pb.LanguageServerService/CancelCascadeInvocation') {
      lsRunState = 'RUN_STATE_IDLE';
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage') {
      lsRunState = 'RUN_STATE_RUNNING';
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/product.v1.ConversationService/GetConversation') {
      res.end(
        JSON.stringify({
          conversation: {
            id: body.conversationId,
            conversationId: body.conversationId,
            state: { runState: lsRunState, updateTime: tFollowUp },
            annotations: { archived: false },
          },
        }),
      );
      return;
    }
    if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
      res.end(JSON.stringify({ generatorMetadata: [] }));
      return;
    }
    if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
      res.end(JSON.stringify({ clientModelConfigs: [] }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  process.env.ANTIGRAVITY_LS_ADDRESS = mockLs.address;
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-p0-3';
  const sendLog = join(tempRoot, 'agentapi.log');
  process.env.ANTIGRAVITY_AGENTAPI_EXE = writeMockAgentApi(tempRoot, sendLog);

  const reg = loadRegistry();
  reg.coordinators[scopeKey] = {
    key: scopeKey,
    conversationId: 'coord-p0-3',
    workspacePath: repoDir,
    repoRoot: repoDir,
    projectId: 'proj-p0-3',
    runState: 'RUN_STATE_IDLE',
    title: '[Coordinator] P0-3',
  };
  reg.threads['pt-p03-thr-001'] = {
    threadId: 'pt-p03-thr-001',
    projectSeq: 1,
    localId: 'thr-001',
    displayId: 'thr-001',
    conversationId: 'conv-p03-1',
    coordinatorId: 'coord-p0-3',
    workspaceKey: scopeKey,
    projectId: 'proj-p0-3',
    workspacePath: repoDir,
    repoRoot: repoDir,
    title: 'Ghost BG Task Test',
    runState: 'RUN_STATE_RUNNING',
    hasPendingBgTask: true,
    bucket: 'working',
    archived: false,
    createdAt: tOldUser,
    updatedAt: tOldBg,
  };
  saveRegistry(reg);

  writeTranscript(appDataDir, 'conv-p03-1', [
    { step_index: 0, type: 'USER_INPUT', content: 'Start server', created_at: tOldUser },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      content: '',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm run dev' } }],
      created_at: '2026-11-29T02:00:01.000Z',
    },
    {
      step_index: 2,
      type: 'GENERIC',
      status: 'RUNNING',
      content: 'Tool is running as a background task with task id: conv-p03-1/bg-old',
      created_at: tOldBg,
    },
  ]);

  // 1. Cancel with killBackgroundTasks=true -> records bgTasksKilledAt
  const cancelRes = await cancelThread(
    { threadId: 'thr-001', workspacePath: repoDir, killBackgroundTasks: true },
    { now: () => tCancelKill },
  );
  assert.equal(cancelRes.ok, true);
  assert.equal(loadRegistry().threads['pt-p03-thr-001'].bgTasksKilledAt, tCancelKill);

  // 2. Follow up via sendThreadMessage -> clears canceledAt, preserves bgTasksKilledAt
  const sendRes = await sendThreadMessage({
    threadId: 'thr-001',
    workspacePath: repoDir,
    message: 'Run quick follow-up check',
  });
  assert.equal(sendRes.ok, true);
  lsRunState = 'RUN_STATE_IDLE';
  writeTranscript(appDataDir, 'conv-p03-1', [
    { step_index: 0, type: 'USER_INPUT', content: 'Start server', created_at: tOldUser },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      content: '',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm run dev' } }],
      created_at: '2026-11-29T02:00:01.000Z',
    },
    {
      step_index: 2,
      type: 'GENERIC',
      status: 'RUNNING',
      content: 'Tool is running as a background task with task id: conv-p03-1/bg-old',
      created_at: tOldBg,
    },
    { step_index: 3, type: 'USER_INPUT', content: 'Run quick follow-up check', created_at: tFollowUp },
    { step_index: 4, type: 'PLANNER_RESPONSE', content: 'Follow-up complete.', tool_calls: [], created_at: tFollowUp },
  ]);

  const postFollowRec = loadRegistry().threads['pt-p03-thr-001'];
  assert.equal(postFollowRec.canceledAt, undefined);
  assert.equal(postFollowRec.bgTasksKilledAt, tCancelKill);

  // Old killed bg task MUST stay suppressed across all readers
  const liveOld = peekLiveActivity('conv-p03-1', {
    runState: 'RUN_STATE_IDLE',
    bgTasksKilledAt: postFollowRec.bgTasksKilledAt,
  });
  assert.equal(liveOld.hasPendingBgTask, false);

  const compOld = extractThreadCompletion('conv-p03-1', '', {
    bgTasksKilledAt: postFollowRec.bgTasksKilledAt,
  });
  assert.equal(compOld.waitingOnBackgroundTask, false);

  const parsedOld = parseThreadTranscript('conv-p03-1', [], {
    bgTasksKilledAt: postFollowRec.bgTasksKilledAt,
  });
  const oldBgItem = parsedOld.items
    .flatMap((it) => it.calls || it.entries || [])
    .find((entry) => entry.rawTarget === 'npm run dev');
  assert.ok(oldBgItem);
  assert.equal(oldBgItem.running, false);

  // getThreadMessages settles IDLE with hasPendingBgTask=false
  const msgView = await getThreadMessages({ threadId: 'thr-001', workspacePath: repoDir });
  assert.equal(msgView.thread.hasPendingBgTask, false);

  // Watchdog patrol sees idle + no pending bg task -> must NOT flag bg_task_silent stall
  const wdOut = await patrolProjectScope(scopeKey, {
    deps: { now: () => Date.parse('2026-11-29T02:45:00.000Z') },
  });
  assert.equal(wdOut.stalledCount, 0);

  // 3. A NEW background task started AFTER bgTasksKilledAt MUST still be tracked!
  writeTranscript(appDataDir, 'conv-p03-1', [
    { step_index: 0, type: 'USER_INPUT', content: 'Start server', created_at: tOldUser },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      content: '',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm run dev' } }],
      created_at: '2026-11-29T02:00:01.000Z',
    },
    {
      step_index: 2,
      type: 'GENERIC',
      status: 'RUNNING',
      content: 'Tool is running as a background task with task id: conv-p03-1/bg-old',
      created_at: tOldBg,
    },
    { step_index: 3, type: 'USER_INPUT', content: 'Start fresh bg task', created_at: tFollowUp },
    {
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      content: '',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'node worker.mjs' } }],
      created_at: '2026-11-29T02:02:59.000Z',
    },
    {
      step_index: 5,
      type: 'GENERIC',
      status: 'RUNNING',
      content: 'Tool is running as a background task with task id: conv-p03-1/bg-new',
      created_at: tNewBg,
    },
  ]);
  const liveNew = peekLiveActivity('conv-p03-1', {
    runState: 'RUN_STATE_IDLE',
    bgTasksKilledAt: postFollowRec.bgTasksKilledAt,
  });
  assert.equal(liveNew.hasPendingBgTask, true);
  const compNew = extractThreadCompletion('conv-p03-1', '', {
    bgTasksKilledAt: postFollowRec.bgTasksKilledAt,
  });
  assert.equal(compNew.waitingOnBackgroundTask, true);
});

test('8. P1-1: isCascadeNotRunningError accepts Connect HTTP 404 not_found / HTTP 400 failed_precondition while rejecting unimplemented/501/404 page not found', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-cancel-p1-1-');
  const repoDir = join(tempRoot, 'repo-p1-1');
  initGitRepo(repoDir);
  const scopeKey = normalizeKey(repoDir);

  let mode = 'connect_404_not_found';
  const mockLs = await startMockLsServer(t, (req, res, body) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/exa.language_server_pb.LanguageServerService/CancelCascadeInvocation') {
      if (mode === 'connect_404_not_found') {
        res.statusCode = 404;
        res.end(JSON.stringify({ code: 'not_found', message: 'cascade not found' }));
        return;
      }
      if (mode === 'connect_400_failed_precondition') {
        res.statusCode = 400;
        res.end(JSON.stringify({ code: 'failed_precondition', message: 'cascade is not running' }));
        return;
      }
      if (mode === 'plain_404') {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain');
        res.end('404 page not found');
        return;
      }
      if (mode === 'connect_404_unimplemented') {
        res.statusCode = 404;
        res.end(JSON.stringify({ code: 'unimplemented', message: 'CancelCascadeInvocation is not implemented' }));
        return;
      }
      if (mode === 'http_501') {
        res.statusCode = 501;
        res.end(JSON.stringify({ code: 'unimplemented', message: 'Not Implemented' }));
        return;
      }
    }
    if (req.url === '/product.v1.ConversationService/GetConversation') {
      res.end(
        JSON.stringify({
          conversation: {
            id: body.conversationId,
            conversationId: body.conversationId,
            state: { runState: 'RUN_STATE_IDLE', updateTime: new Date().toISOString() },
            annotations: { archived: false },
          },
        }),
      );
      return;
    }
    res.end('{}');
  });
  process.env.ANTIGRAVITY_LS_ADDRESS = mockLs.address;
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-p1-1';

  const captureErr = async (m) => {
    mode = m;
    let err = null;
    await assert.rejects(async () => {
      try {
        await cancelCascadeInvocation('conv-p11');
      } catch (e) {
        err = e;
        throw e;
      }
    });
    return err;
  };

  assert.equal(isCascadeNotRunningError(await captureErr('connect_404_not_found')), true);
  assert.equal(isCascadeNotRunningError(await captureErr('connect_400_failed_precondition')), true);
  assert.equal(isCascadeNotRunningError(await captureErr('plain_404')), false);
  assert.equal(isCascadeNotRunningError(await captureErr('connect_404_unimplemented')), false);
  assert.equal(isCascadeNotRunningError(await captureErr('http_501')), false);

  // Verify end-to-end cancelThread treats Connect 404 not_found + IDLE getConversation as alreadyIdle: true
  const reg = loadRegistry();
  reg.coordinators[scopeKey] = {
    key: scopeKey,
    conversationId: 'coord-p1-1',
    workspacePath: repoDir,
    repoRoot: repoDir,
    projectId: 'proj-p1-1',
    title: '[Coordinator] P1-1',
  };
  reg.threads['pt-p11-thr-001'] = {
    threadId: 'pt-p11-thr-001',
    projectSeq: 1,
    localId: 'thr-001',
    displayId: 'thr-001',
    conversationId: 'conv-p11',
    coordinatorId: 'coord-p1-1',
    workspaceKey: scopeKey,
    projectId: 'proj-p1-1',
    workspacePath: repoDir,
    repoRoot: repoDir,
    title: 'Connect 404 Idle Verify',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    archived: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveRegistry(reg);

  mode = 'connect_404_not_found';
  const idleRes = await cancelThread({ threadId: 'thr-001', workspacePath: repoDir });
  assert.equal(idleRes.ok, true);
  assert.equal(idleRes.alreadyIdle, true);
  assert.equal(idleRes.thread.runState, 'RUN_STATE_IDLE');

  // Unimplemented HTTP 501 must fail rather than masquerading as alreadyIdle
  const regRetry = loadRegistry();
  regRetry.threads['pt-p11-thr-001'].runState = 'RUN_STATE_RUNNING';
  delete regRetry.threads['pt-p11-thr-001'].canceledAt;
  saveRegistry(regRetry);
  mode = 'http_501';
  const unimplRes = await cancelThread({ threadId: 'thr-001', workspacePath: repoDir });
  assert.equal(unimplRes.ok, false);
});

test('9. P1-2: 10s cancel convergence grace prevents early rebound and Watchdog refuses to overwrite concurrent cancel/cleared tombstones', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-cancel-p1-2-');
  const repoDir = join(tempRoot, 'repo-p1-2');
  initGitRepo(repoDir);
  const scopeKey = normalizeKey(repoDir);

  const t0 = new Date(Date.now() - 120_000).toISOString();
  const tCancel = new Date(Date.now() - 2_000).toISOString(); // only 2s ago (< 10s grace)
  const tUpdateWithinGrace = new Date(Date.parse(tCancel) + 1500).toISOString();

  let lsUpdateTime = tUpdateWithinGrace;
  let lsRunState = 'RUN_STATE_RUNNING';
  const mockLs = await startMockLsServer(t, (req, res, body) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/product.v1.ConversationService/GetConversation') {
      res.end(
        JSON.stringify({
          conversation: {
            id: body.conversationId,
            conversationId: body.conversationId,
            state: { runState: lsRunState, updateTime: lsUpdateTime },
            annotations: { archived: false },
          },
        }),
      );
      return;
    }
    if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
      res.end(JSON.stringify({ generatorMetadata: [] }));
      return;
    }
    if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
      res.end(JSON.stringify({ clientModelConfigs: [] }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  process.env.ANTIGRAVITY_LS_ADDRESS = mockLs.address;
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-p1-2';

  const reg = loadRegistry();
  reg.coordinators[scopeKey] = {
    key: scopeKey,
    conversationId: 'coord-p1-2',
    workspacePath: repoDir,
    repoRoot: repoDir,
    projectId: 'proj-p1-2',
    runState: 'RUN_STATE_IDLE',
    title: '[Coordinator] P1-2',
  };
  reg.threads['pt-p12-thr-001'] = {
    threadId: 'pt-p12-thr-001',
    projectSeq: 1,
    localId: 'thr-001',
    displayId: 'thr-001',
    conversationId: 'conv-p12-1',
    coordinatorId: 'coord-p1-2',
    workspaceKey: scopeKey,
    projectId: 'proj-p1-2',
    workspacePath: repoDir,
    repoRoot: repoDir,
    title: 'Grace & Watchdog Race Test',
    runState: 'RUN_STATE_IDLE',
    bucket: 'idle',
    archived: false,
    canceledAt: tCancel,
    canceledStepIndex: 0,
    createdAt: t0,
    updatedAt: tCancel,
  };
  saveRegistry(reg);
  writeTranscript(appDataDir, 'conv-p12-1', [
    { step_index: 0, type: 'USER_INPUT', content: 'Run long check', created_at: t0 },
  ]);

  // Within < 10s without new user turn, transient LS RUN_STATE_RUNNING must NOT clear canceledAt
  await syncThreads({ workspacePath: repoDir, backgroundSideEffects: false });
  const duringGrace = loadRegistry().threads['pt-p12-thr-001'];
  assert.equal(duringGrace.canceledAt, tCancel);
  assert.equal(duringGrace.runState, 'RUN_STATE_IDLE');

  // After > 10s with genuinely active LS updateTime > canceledAt + 10s, fallback clears canceledAt
  const oldCancel = new Date(Date.now() - 25_000).toISOString();
  const r2 = loadRegistry();
  r2.threads['pt-p12-thr-001'].canceledAt = oldCancel;
  saveRegistry(r2);
  lsUpdateTime = new Date(Date.parse(oldCancel) + 15_000).toISOString();
  await syncThreads({ workspacePath: repoDir, backgroundSideEffects: false });
  const afterGrace = loadRegistry().threads['pt-p12-thr-001'];
  assert.equal(afterGrace.canceledAt, undefined);
  assert.equal(afterGrace.runState, 'RUN_STATE_RUNNING');
  assert.ok(afterGrace.cancelClearedAt);

  // Watchdog patrol race: thread cancels CONCURRENTLY during getConversation probe!
  // Pre-seed previous watching/stalled candidate so patrol picks it up, then simulate concurrent cancel mid-probe
  const r3 = loadRegistry();
  r3.threads['pt-p12-thr-001'].runState = 'RUN_STATE_RUNNING';
  r3.threads['pt-p12-thr-001'].bucket = 'working';
  r3.watchdogState[scopeKey] = {
    scopeKey,
    coordinatorId: 'coord-p1-2',
    updatedAt: t0,
    threads: {
      'pt-p12-thr-001': {
        state: 'watching',
        lastProgressAt: t0,
        lastObservedStepCount: 0,
        lastObservedTranscriptSize: 0,
        lastObservedTranscriptMtimeMs: 0,
        lastObservedUpdatedAt: t0,
        stalled: false,
        updatedAt: t0,
      },
    },
  };
  saveRegistry(r3);

  const peekSeenOpts = [];
  let canceledMidProbe = false;
  const patrolOut = await patrolProjectScope(scopeKey, {
    deps: {
      now: () => Date.parse(t0) + 600_000,
      getConversation: async (cid) => {
        if (cid === 'conv-p12-1' && !canceledMidProbe) {
          canceledMidProbe = true;
          await cancelThread(
            { threadId: 'thr-001', workspacePath: repoDir },
            {
              cancelCascadeInvocation: async () => ({ ok: true }),
              now: () => new Date(Date.parse(t0) + 599_000).toISOString(),
            },
          );
        }
        return {
          conversation: {
            conversationId: cid,
            state: { runState: cid === 'coord-p1-2' ? 'RUN_STATE_IDLE' : 'RUN_STATE_RUNNING', updateTime: t0 },
            annotations: { archived: false },
          },
        };
      },
      peekLiveActivity: (cid, opts) => {
        peekSeenOpts.push({ cid, opts });
        return peekLiveActivity(cid, opts);
      },
    },
  });
  assert.equal(canceledMidProbe, true);
  assert.equal(peekSeenOpts.length >= 1, true);
  assert.ok('canceledAt' in peekSeenOpts[0].opts, 'patrolProjectScope must forward canceledAt to peekLiveActivity');
  assert.ok('bgTasksKilledAt' in peekSeenOpts[0].opts, 'patrolProjectScope must forward bgTasksKilledAt to peekLiveActivity');
  assert.equal(patrolOut.alertedCount, 0);
  const wdFinalEntry = loadRegistry().watchdogState[scopeKey].threads['pt-p12-thr-001'];
  assert.equal(wdFinalEntry.state, 'cleared', 'Watchdog must NOT overwrite concurrent cleared tombstone with stalled/watching');

  // Also verify targetThreadId IDLE patrol passes canceledAt & bgTasksKilledAt to BOTH peekLiveActivity and extractThreadCompletion
  const compSeenOpts = [];
  const peekIdleSeenOpts = [];
  const idlePatrolOut = await patrolProjectScope(scopeKey, {
    targetThreadId: 'pt-p12-thr-001',
    deps: {
      now: () => Date.parse(t0) + 650_000,
      getConversation: async (cid) => ({
        conversation: {
          conversationId: cid,
          state: { runState: 'RUN_STATE_IDLE', updateTime: t0 },
          annotations: { archived: false },
        },
      }),
      peekLiveActivity: (cid, opts) => {
        peekIdleSeenOpts.push({ cid, opts });
        return peekLiveActivity(cid, opts);
      },
      extractThreadCompletion: (cid, overridePath, opts) => {
        compSeenOpts.push({ cid, overridePath, opts });
        return extractThreadCompletion(cid, overridePath, opts);
      },
    },
  });
  assert.equal(idlePatrolOut.stalledCount, 0);
  assert.equal(peekIdleSeenOpts.length, 1);
  assert.equal(compSeenOpts.length, 1);
  assert.ok(Boolean(peekIdleSeenOpts[0].opts.canceledAt), 'IDLE patrol must forward canceledAt to peekLiveActivity');
  assert.ok(Boolean(peekIdleSeenOpts[0].opts.bgTasksKilledAt), 'IDLE patrol must forward bgTasksKilledAt to peekLiveActivity');
  assert.ok(Boolean(compSeenOpts[0].opts?.canceledAt), 'IDLE patrol must forward canceledAt to extractThreadCompletion');
  assert.ok(Boolean(compSeenOpts[0].opts?.bgTasksKilledAt), 'IDLE patrol must forward bgTasksKilledAt to extractThreadCompletion');
});

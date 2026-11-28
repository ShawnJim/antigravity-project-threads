import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
import vm from 'node:vm';

import { resetModelConfigCache } from '../lib/ls-client.mjs';
import {
  addDecision,
  archiveThread,
  cleanupThreadWorktree,
  dismissDecision,
  dispatchThread,
  getEffectiveSettings,
  initCoordinator,
  listCoordinatorCandidates,
  loadRegistry,
  markThreadRead,
  normalizeKey,
  rebindCoordinator,
  resolveDecision,
  resolveDefaultDispatchModel,
  resolveProjectScope,
  saveRegistry,
  saveSettings,
  sendThreadMessage,
  syncCompletionToCoordinator,
  syncThreads,
  updateProjectMemory,
} from '../lib/store.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function createTempEnv(t, prefix = 'pt-rebind-') {
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
  resetModelConfigCache();

  t.after(() => {
    resetModelConfigCache();
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

function createMockAgentApi(dir, name = 'agentapi', { extraScript = '' } = {}) {
  const logFile = join(dir, `${name}-calls.jsonl`);
  const scriptPath = join(dir, `${name}.mjs`);
  writeFileSync(
    scriptPath,
    [
      'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: process.argv.slice(2), projectId: process.env.ANTIGRAVITY_PROJECT_ID || "" }) + "\\n");`,
      extraScript,
      'process.stdout.write(JSON.stringify({ response: { sendMessage: { ok: true } } }));',
    ]
      .filter(Boolean)
      .join('\n'),
    'utf8',
  );
  if (process.platform === 'win32') {
    const cmdPath = join(dir, `${name}.cmd`);
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
    return { exePath: cmdPath, logFile };
  }
  const shPath = join(dir, name);
  writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, 'utf8');
  chmodSync(shPath, 0o755);
  return { exePath: shPath, logFile };
}

function runHook(event, payload, env) {
  const res = spawnSync(process.execPath, ['scripts/hook-handler.mjs', event], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: env.geminiDir,
      ANTIGRAVITY_APP_DATA_DIR: env.appDataDir,
    },
    input: JSON.stringify({ hookEventName: event, ...payload }),
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim() || '{}');
}

function startMockLs(
  t,
  {
    generatorMetadataByCascade = new Map(),
    conversations = [],
    strictConversations = false,
    onGetConversation = null,
  } = {},
) {
  const updatedConversations = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
        res.end(
          JSON.stringify({
            clientModelConfigs: [
              {
                label: 'Gemini 4 Hydrogen (XHigh)',
                modelId: 'gemini-4-hydrogen-xhigh',
                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M528' },
              },
              {
                label: 'Gemini 4 Neon (Low)',
                modelId: 'gemini-4-neon-low',
                modelOrAlias: { model: 'MODEL_PLACEHOLDER_M534' },
              },
            ],
            defaultOverrideModelConfig: { modelOrAlias: { model: 'MODEL_PLACEHOLDER_M528' } },
          }),
        );
        return;
      }
      if (
        req.url ===
        '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata'
      ) {
        const entry = generatorMetadataByCascade.get(payload.cascadeId);
        res.end(JSON.stringify({ generatorMetadata: Array.isArray(entry) ? entry : [] }));
        return;
      }
      if (req.url === '/product.v1.ConversationService/UpdateConversation') {
        updatedConversations.push(payload);
        res.end(JSON.stringify({}));
        return;
      }
      if (req.url === '/product.v1.ConversationService/GetConversation') {
        if (typeof onGetConversation === 'function') {
          onGetConversation(payload);
        }
        const hit = conversations.find((c) => c.id === payload.conversationId);
        if (!hit && strictConversations) {
          res.statusCode = 404;
          res.end(JSON.stringify({ code: 'not_found', message: 'conversation not found' }));
          return;
        }
        res.end(
          JSON.stringify({
            conversation: hit || {
              id: payload.conversationId,
              state: { runState: 'RUN_STATE_IDLE' },
            },
          }),
        );
        return;
      }
      if (req.url === '/product.v1.ConversationService/ListConversations') {
        res.end(JSON.stringify({ conversations }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });

  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${port}`;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-rebind-test';
      t.after(() => new Promise((r) => server.close(r)));
      resolveListen({ port, updatedConversations, generatorMetadataByCascade });
    });
  });
}

function extractFunctionSource(source, fnName) {
  const start = source.indexOf(`function ${fnName}(`);
  assert.notEqual(start, -1, `${fnName} must exist in sidecars/threads/app.js`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  assert.notEqual(bodyStart, -1, `Could not find body brace for ${fnName}`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not find closing brace for ${fnName}`);
}

test('P0-1 & core rebind: migrates active threads, uses independent baseline ONLY for stale IDLE threads (never mutating delivery markers), preserves recent/claimed completions, migrates legacy threads, and caps retired history', async (t) => {
  const { tempRoot, appDataDir, stateDir } = createTempEnv(t, 'pt-rebind-core-');
  const repoA = join(tempRoot, 'repo-a');
  const repoB = join(tempRoot, 'repo-b');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);

  const recentIso = new Date(Date.now() - 5000).toISOString();
  const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  writeTranscript(appDataDir, 'conv-w-001', [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Running task</USER_REQUEST>' },
  ]);
  writeTranscript(appDataDir, 'conv-w-002', [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Old task</USER_REQUEST>' },
    { step_index: 3, type: 'PLANNER_RESPONSE', content: '### 线程总结\n早已完成的历史任务。' },
  ]);
  writeTranscript(appDataDir, 'conv-w-005', [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Recent task</USER_REQUEST>' },
    { step_index: 4, type: 'PLANNER_RESPONSE', content: '### 线程总结\n刚刚完成、等待投递的任务。' },
  ]);
  writeTranscript(appDataDir, 'conv-w-006', [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Claimed task</USER_REQUEST>' },
    { step_index: 2, type: 'PLANNER_RESPONSE', content: '### 线程总结\n已有活跃 claim 锁的线程。' },
  ]);

  // Create active .claim file for thr-006
  const claimsDir = join(stateDir, 'sync-claims');
  mkdirSync(claimsDir, { recursive: true });
  writeFileSync(
    join(claimsDir, 'thr-006-step-2.claim'),
    JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
    'utf8',
  );

  const reg = loadRegistry();
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'conv-coord-a-old',
    workspacePath: repoA,
    repoRoot: repoA,
    title: '[Coordinator] RepoA',
    directiveVersion: 13,
    lastStepCount: 15,
    createdAt: staleIso,
    updatedAt: staleIso,
  };
  reg.coordinators[keyB] = {
    key: keyB,
    conversationId: 'conv-coord-b',
    workspacePath: repoB,
    repoRoot: repoB,
    title: '[Coordinator] RepoB',
    createdAt: staleIso,
    updatedAt: staleIso,
  };
  reg.threads['thr-001'] = {
    threadId: 'thr-001',
    conversationId: 'conv-w-001',
    coordinatorId: 'conv-coord-a-old',
    workspaceKey: keyA,
    title: '正在运行的任务',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
    lastCompletedAt: '',
    notifiedCoordinatorAt: '',
    createdAt: staleIso,
    updatedAt: recentIso,
  };
  reg.threads['thr-002'] = {
    threadId: 'thr-002',
    conversationId: 'conv-w-002',
    coordinatorId: 'conv-coord-a-old',
    workspaceKey: keyA,
    title: '切换前早已完成未推送的历史任务',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    lastSummary: '早已完成的历史任务。',
    lastCompletedAt: staleIso,
    notifiedCoordinatorAt: '',
    pushedToCoordinatorAt: '',
    createdAt: staleIso,
    updatedAt: staleIso,
  };
  reg.threads['thr-003'] = {
    threadId: 'thr-003',
    conversationId: 'conv-w-003',
    coordinatorId: 'conv-coord-a-old',
    workspaceKey: keyA,
    title: '已归档历史线程',
    runState: 'RUN_STATE_IDLE',
    archived: true,
    createdAt: staleIso,
    updatedAt: staleIso,
  };
  reg.threads['thr-004'] = {
    threadId: 'thr-004',
    conversationId: 'conv-w-004',
    coordinatorId: 'conv-coord-b',
    workspaceKey: keyB,
    title: '其他项目活跃线程',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
    createdAt: staleIso,
    updatedAt: staleIso,
  };
  reg.threads['thr-005'] = {
    threadId: 'thr-005',
    conversationId: 'conv-w-005',
    coordinatorId: 'conv-coord-a-old',
    workspaceKey: keyA,
    title: '5秒前刚刚完成的未投递任务',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    lastSummary: '刚刚完成、等待投递的任务。',
    lastCompletedAt: recentIso,
    notifiedCoordinatorAt: '',
    pushedToCoordinatorAt: '',
    createdAt: staleIso,
    updatedAt: recentIso,
  };
  reg.threads['thr-006'] = {
    threadId: 'thr-006',
    conversationId: 'conv-w-006',
    coordinatorId: 'conv-coord-a-old',
    workspaceKey: keyA,
    title: '持有活跃 claim 锁的线程',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    lastSummary: '已有活跃 claim 锁的线程。',
    lastCompletedAt: staleIso,
    notifiedCoordinatorAt: '',
    pushedToCoordinatorAt: '',
    createdAt: staleIso,
    updatedAt: staleIso,
  };
  reg.threads['thr-007'] = {
    threadId: 'thr-007',
    conversationId: 'conv-w-007',
    coordinatorId: 'conv-coord-a-old',
    workspaceKey: '', // legacy thread missing workspaceKey
    title: '缺少 workspaceKey 的旧活跃线程',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
    createdAt: staleIso,
    updatedAt: recentIso,
  };
  saveRegistry(reg);

  const decA = addDecision({
    workspacePath: repoA,
    coordinatorId: 'conv-coord-a-old',
    threadId: 'thr-001',
    title: '确认是否合入？',
  });

  // 1. Reject binding a registered Worker Thread as Coordinator
  await assert.rejects(
    () => rebindCoordinator({ workspacePath: repoA, newCoordinatorId: 'conv-w-001' }),
    /Cannot bind Worker Thread/,
  );

  // 2. Reject binding another project's active Coordinator
  await assert.rejects(
    () => rebindCoordinator({ workspacePath: repoA, newCoordinatorId: 'conv-coord-b' }),
    /already bound as the Coordinator for another project/,
  );

  // 3. Rebind RepoA from conv-coord-a-old -> conv-coord-a-new
  const res = await rebindCoordinator({
    workspacePath: repoA,
    newCoordinatorId: 'conv-coord-a-new',
  });
  assert.equal(res.ok, true);
  assert.equal(res.unchanged, false);
  assert.equal(res.previousCoordinatorId, 'conv-coord-a-old');
  assert.equal(res.coordinatorId, 'conv-coord-a-new');
  assert.deepEqual(res.retiredCoordinatorIds, ['conv-coord-a-old']);
  assert.deepEqual(
    [...res.migratedThreadIds].sort(),
    ['thr-001', 'thr-002', 'thr-005', 'thr-006', 'thr-007'],
  );
  assert.equal(res.migratedCount, 5);
  // ONLY thr-002 (genuinely stale IDLE without active claim) gets suppressed baseline
  assert.deepEqual(res.suppressedAvalancheThreadIds, ['thr-002']);

  const after = loadRegistry();
  assert.equal(after.coordinators[keyA].conversationId, 'conv-coord-a-new');
  assert.deepEqual(after.coordinators[keyA].retiredCoordinatorIds, ['conv-coord-a-old']);
  assert.equal(after.coordinators[keyA].directiveVersion, undefined);
  assert.equal(after.coordinators[keyA].rebindSeq, 1);

  // P0-1 invariant: thr-002 gets independent reboundBaseline* ONLY — NEVER mutates delivery markers!
  assert.equal(after.threads['thr-002'].coordinatorId, 'conv-coord-a-new');
  assert.equal(after.threads['thr-002'].lastSyncedStepIndex, undefined);
  assert.equal(after.threads['thr-002'].notifiedCoordinatorAt || '', '');
  assert.equal(after.threads['thr-002'].pushedToCoordinatorAt || '', '');
  assert.equal(after.threads['thr-002'].reboundBaselineStepIndex, 3);
  assert.ok(after.threads['thr-002'].reboundBaselineAt);

  // Recent IDLE thread (thr-005) & active-claim thread (thr-006) & running threads (thr-001, thr-007): NO baseline suppression
  for (const tid of ['thr-001', 'thr-005', 'thr-006', 'thr-007']) {
    assert.equal(after.threads[tid].coordinatorId, 'conv-coord-a-new');
    assert.equal(after.threads[tid].reboundBaselineStepIndex, undefined);
    assert.equal(after.threads[tid].reboundBaselineAt, undefined);
    assert.equal(after.threads[tid].notifiedCoordinatorAt || '', '');
  }

  // Archived thread & other project thread strictly untouched
  assert.equal(after.threads['thr-003'].coordinatorId, 'conv-coord-a-old');
  assert.equal(after.threads['thr-004'].coordinatorId, 'conv-coord-b');
  assert.equal(after.coordinators[keyB].conversationId, 'conv-coord-b');

  // Pending explicit decision in RepoA updated to new coordinator
  assert.equal(after.decisions[decA.id].coordinatorId, 'conv-coord-a-new');

  // 4. Rebinding to same coordinator with nothing left to migrate reports unchanged: true
  const sameRes = await rebindCoordinator({
    workspacePath: repoA,
    newCoordinatorId: 'conv-coord-a-new',
  });
  assert.equal(sameRes.unchanged, true);
  assert.equal(sameRes.migratedCount, 0);

  // 5. Explicit switch-back A -> B -> A removes A from retired and retires B
  const backRes = await rebindCoordinator({
    workspacePath: repoA,
    newCoordinatorId: 'conv-coord-a-old',
  });
  assert.equal(backRes.coordinatorId, 'conv-coord-a-old');
  assert.deepEqual(backRes.retiredCoordinatorIds, ['conv-coord-a-new']);
  assert.equal(loadRegistry().coordinators[keyA].rebindSeq, 2);

  // 6. retiredCoordinatorIds is capped at 50 entries
  for (let i = 1; i <= 55; i++) {
    await rebindCoordinator({
      workspacePath: repoA,
      newCoordinatorId: `conv-coord-cap-${i}`,
    });
  }
  const cappedCoord = loadRegistry().coordinators[keyA];
  assert.equal(cappedCoord.conversationId, 'conv-coord-cap-55');
  assert.equal(cappedCoord.retiredCoordinatorIds.length, 50);
  assert.equal(cappedCoord.retiredCoordinatorIds.includes('conv-coord-cap-54'), true);
  assert.equal(cappedCoord.retiredCoordinatorIds.includes('conv-coord-cap-55'), false);
});

test('P1-2 & conv: scope: initCoordinator rejects retired hijack while rebindCoordinator allows switch-back, and standalone conv: scope rebinds cleanly', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-rebind-init-conv-');
  const repoA = join(tempRoot, 'coord-repo');
  mkdirSync(repoA, { recursive: true });
  const keyA = normalizeKey(repoA);

  await initCoordinator({ workspacePath: repoA, conversationId: 'conv-init-1' });
  const reg = loadRegistry();
  reg.threads['thr-010'] = {
    threadId: 'thr-010',
    conversationId: 'conv-wt-010',
    coordinatorId: 'conv-init-1',
    workspaceKey: keyA,
    title: 'Active thread before /coord',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
  };
  reg.threads['thr-011'] = {
    threadId: 'thr-011',
    conversationId: 'conv-wt-011',
    coordinatorId: 'conv-init-1',
    workspaceKey: keyA,
    title: 'Archived thread before /coord',
    runState: 'RUN_STATE_IDLE',
    archived: true,
  };
  saveRegistry(reg);

  // User runs /coord in a fresh session for the same repository
  const nextCoord = await initCoordinator({ workspacePath: repoA, conversationId: 'conv-init-2' });
  assert.equal(nextCoord.conversationId, 'conv-init-2');
  assert.deepEqual(nextCoord.retiredCoordinatorIds, ['conv-init-1']);
  const afterInit = loadRegistry();
  assert.equal(afterInit.threads['thr-010'].coordinatorId, 'conv-init-2');
  assert.equal(afterInit.threads['thr-011'].coordinatorId, 'conv-init-1');

  // P1-2: initCoordinator (/coord) in the retired session MUST be rejected (no silent hijack!)
  await assert.rejects(
    () => initCoordinator({ workspacePath: repoA, conversationId: 'conv-init-1' }),
    /has been retired/,
  );
  assert.equal(loadRegistry().coordinators[keyA].conversationId, 'conv-init-2');

  // Whereas explicit rebindCoordinator CAN switch back to conv-init-1
  const explicitBack = await rebindCoordinator({
    workspacePath: repoA,
    newCoordinatorId: 'conv-init-1',
  });
  assert.equal(explicitBack.coordinatorId, 'conv-init-1');
  assert.deepEqual(explicitBack.retiredCoordinatorIds, ['conv-init-2']);

  // Workspace-less conv: scope rebinding
  await initCoordinator({ conversationId: 'conv-solo-old', title: 'Solo Project' });
  const regSolo = loadRegistry();
  assert.ok(regSolo.coordinators['conv:conv-solo-old']);
  regSolo.threads['thr-020'] = {
    threadId: 'thr-020',
    conversationId: 'conv-solo-worker-active',
    coordinatorId: 'conv-solo-old',
    workspaceKey: 'conv:conv-solo-old',
    title: 'Solo active thread',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
  };
  regSolo.threads['thr-021'] = {
    threadId: 'thr-021',
    conversationId: 'conv-solo-worker-archived',
    coordinatorId: 'conv-solo-old',
    workspaceKey: 'conv:conv-solo-old',
    title: 'Solo archived thread',
    runState: 'RUN_STATE_IDLE',
    archived: true,
  };
  saveRegistry(regSolo);

  const soloRebind = await rebindCoordinator({
    coordinatorId: 'conv-solo-old',
    newCoordinatorId: 'conv-solo-new',
  });
  assert.equal(soloRebind.ok, true);
  assert.equal(soloRebind.scopeKey, 'conv:conv-solo-old');
  assert.equal(soloRebind.coordinatorId, 'conv-solo-new');
  assert.deepEqual(soloRebind.retiredCoordinatorIds, ['conv-solo-old']);
  assert.deepEqual(soloRebind.migratedThreadIds, ['thr-020']);

  const afterSolo = loadRegistry();
  assert.equal(afterSolo.threads['thr-020'].coordinatorId, 'conv-solo-new');
  assert.equal(afterSolo.threads['thr-021'].coordinatorId, 'conv-solo-old');

  const resolvedNewScope = await resolveProjectScope({ conversationId: 'conv-solo-new' });
  assert.equal(resolvedNewScope.scopeKey, 'conv:conv-solo-old');
  const soloSnap = await syncThreads({ conversationId: 'conv-solo-new', includeArchived: true });
  assert.equal(soloSnap.coordinator?.conversationId, 'conv-solo-new');
  assert.deepEqual(
    soloSnap.threads.map((x) => x.threadId).sort(),
    ['thr-020', 'thr-021'],
  );
});

test('concurrent stale saveRegistry, markThreadRead (including concurrent RUN_STATE_RUNNING restart), and archiveThread preserve integrity', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-rebind-race-');
  const repoA = join(tempRoot, 'race-repo');
  mkdirSync(repoA, { recursive: true });
  const keyA = normalizeKey(repoA);

  let triggerConcurrentRestart = false;
  await startMockLs(t, {
    conversations: [
      {
        id: 'conv-race-w30',
        state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-28T01:05:00Z' },
      },
      {
        id: 'conv-race-new',
        metadata: { projectId: 'proj-race' },
        state: { runState: 'RUN_STATE_IDLE' },
      },
    ],
    onGetConversation(payload) {
      if (triggerConcurrentRestart && payload.conversationId === 'conv-race-w30') {
        triggerConcurrentRestart = false;
        const fresh = loadRegistry();
        fresh.threads['thr-030'].runState = 'RUN_STATE_RUNNING';
        fresh.threads['thr-030'].updatedAt = new Date(Date.now() + 2000).toISOString();
        saveRegistry(fresh);
      }
    },
  });

  const seed = loadRegistry();
  seed.coordinators[keyA] = {
    key: keyA,
    conversationId: 'conv-race-old',
    projectId: 'proj-race',
    workspacePath: repoA,
    repoRoot: repoA,
    title: '[Coordinator] Race',
    updatedAt: '2026-11-28T01:00:00Z',
  };
  seed.threads['thr-030'] = {
    threadId: 'thr-030',
    conversationId: 'conv-race-w30',
    coordinatorId: 'conv-race-old',
    workspaceKey: keyA,
    title: 'Active worker 30',
    runState: 'RUN_STATE_IDLE',
    lastCompletedAt: '2026-11-28T01:05:00Z',
    updatedAt: '2026-11-28T01:05:00Z',
    archived: false,
  };
  seed.threads['thr-031'] = {
    threadId: 'thr-031',
    conversationId: 'conv-race-w31',
    coordinatorId: 'conv-race-old',
    workspaceKey: keyA,
    title: 'Archive worker 31',
    runState: 'RUN_STATE_IDLE',
    archived: false,
  };
  saveRegistry(seed);

  const staleBeforeRebind = loadRegistry();

  await rebindCoordinator({
    workspacePath: repoA,
    newCoordinatorId: 'conv-race-new',
  });

  // Stale writer calls saveRegistry(staleBeforeRebind) -> must NOT revert coordinator or thread bindings
  saveRegistry(staleBeforeRebind);

  let current = loadRegistry();
  assert.equal(current.coordinators[keyA].conversationId, 'conv-race-new');
  assert.deepEqual(current.coordinators[keyA].retiredCoordinatorIds, ['conv-race-old']);
  assert.equal(current.threads['thr-030'].coordinatorId, 'conv-race-new');
  assert.equal(current.threads['thr-031'].coordinatorId, 'conv-race-new');

  // Simulate turn-1 finishing in LS while turn-2 concurrently restarts thr-030 to RUN_STATE_RUNNING
  const beforeRead = loadRegistry();
  beforeRead.threads['thr-030'].runState = 'RUN_STATE_RUNNING';
  beforeRead.threads['thr-030'].updatedAt = '2026-11-28T01:05:00Z';
  saveRegistry(beforeRead);

  triggerConcurrentRestart = true;
  await markThreadRead({ threadId: 'thr-030' });
  await archiveThread('thr-031', { removeWorktree: false });

  current = loadRegistry();
  assert.equal(triggerConcurrentRestart, false, 'onGetConversation must have fired to simulate race');
  assert.equal(current.coordinators[keyA].conversationId, 'conv-race-new');
  assert.equal(current.threads['thr-030'].coordinatorId, 'conv-race-new');
  assert.equal(
    current.threads['thr-030'].runState,
    'RUN_STATE_RUNNING',
    'markThreadRead must not overwrite concurrently restarted RUN_STATE_RUNNING with stale RUN_STATE_IDLE',
  );
  assert.ok(current.threads['thr-030'].viewedAt);
  assert.equal(current.threads['thr-031'].archived, true);
  assert.equal(current.threads['thr-031'].coordinatorId, 'conv-race-new');
});

test('P0-1 & P1-1 syncCompletionToCoordinator: suppresses stale baseline, delivers recent IDLE & follow-up turns, and handles mid-delivery rebind without dropping callback', async (t) => {
  const { tempRoot, appDataDir, stateDir } = createTempEnv(t, 'pt-rebind-sync-');
  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59997';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-sync';

  const repoA = join(tempRoot, 'sync-repo');
  mkdirSync(repoA, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoA });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoA });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoA });
  writeFileSync(join(repoA, 'a.txt'), 'init\n', 'utf8');
  execFileSync('git', ['add', 'a.txt'], { cwd: repoA });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoA });

  const keyA = normalizeKey(repoA);
  const regPath = join(stateDir, 'registry.json');
  const triggerFile = join(tempRoot, 'trigger-mid-delivery-rebind.flag');

  // Mock agentapi that simulates a concurrent coordinator rebind DURING delivery when triggerFile exists
  const midDeliveryRebindCode = `
    if (existsSync(${JSON.stringify(triggerFile)})) {
      const r = JSON.parse(readFileSync(${JSON.stringify(regPath)}, "utf8"));
      const c = r.coordinators[${JSON.stringify(keyA)}];
      if (c && c.conversationId === "conv-sync-coord-new") {
        c.retiredCoordinatorIds = [...(c.retiredCoordinatorIds || []), "conv-sync-coord-new"];
        c.conversationId = "conv-sync-coord-v3";
        c.rebindSeq = (Number(c.rebindSeq) || 0) + 1;
        if (r.threads["thr-044"]) {
          r.threads["thr-044"].coordinatorId = "conv-sync-coord-v3";
        }
        writeFileSync(${JSON.stringify(regPath)}, JSON.stringify(r, null, 2) + "\\n", "utf8");
      }
    }
  `;
  const mockApi = createMockAgentApi(tempRoot, 'agentapi', { extraScript: midDeliveryRebindCode });
  process.env.ANTIGRAVITY_AGENTAPI_EXE = mockApi.exePath;

  const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const recentIso = new Date(Date.now() - 4000).toISOString();

  writeTranscript(appDataDir, 'conv-sync-idle', [
    { step_index: 2, type: 'PLANNER_RESPONSE', content: '### 线程总结\n旧轮次已完成。' },
  ]);
  writeTranscript(appDataDir, 'conv-sync-recent', [
    { step_index: 3, type: 'PLANNER_RESPONSE', content: '### 线程总结\n4秒前刚完成的待投递结论。' },
  ]);
  writeTranscript(appDataDir, 'conv-sync-run', [
    { step_index: 4, type: 'PLANNER_RESPONSE', content: '### 线程总结\n运行中任务刚刚完成。' },
  ]);
  writeTranscript(appDataDir, 'conv-sync-inflight', [
    { step_index: 5, type: 'PLANNER_RESPONSE', content: '### 线程总结\n投递中换绑的线程结论。' },
  ]);

  const reg = loadRegistry();
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'conv-sync-coord-old',
    workspacePath: repoA,
    repoRoot: repoA,
    title: '[Coordinator] SyncRepo',
  };
  reg.threads['thr-040'] = {
    threadId: 'thr-040',
    conversationId: 'conv-sync-idle',
    coordinatorId: 'conv-sync-coord-old',
    workspaceKey: keyA,
    title: '历史陈旧 IDLE 线程',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    lastCompletedAt: staleIso,
    updatedAt: staleIso,
    notifiedCoordinatorAt: '',
    pushedToCoordinatorAt: '',
  };
  reg.threads['thr-043'] = {
    threadId: 'thr-043',
    conversationId: 'conv-sync-recent',
    coordinatorId: 'conv-sync-coord-old',
    workspaceKey: keyA,
    title: '刚刚完成的 IDLE 线程',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    lastCompletedAt: recentIso,
    updatedAt: recentIso,
    notifiedCoordinatorAt: '',
    pushedToCoordinatorAt: '',
  };
  reg.threads['thr-041'] = {
    threadId: 'thr-041',
    conversationId: 'conv-sync-run',
    coordinatorId: 'conv-sync-coord-old',
    workspaceKey: keyA,
    worktreePath: repoA,
    repoRoot: repoA,
    title: '运行中线程',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
  };
  reg.threads['thr-044'] = {
    threadId: 'thr-044',
    conversationId: 'conv-sync-inflight',
    coordinatorId: 'conv-sync-coord-old',
    workspaceKey: keyA,
    title: '投递窗口内换绑线程',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
  };
  saveRegistry(reg);

  // Rebind coordinator old -> new
  await rebindCoordinator({ workspacePath: repoA, newCoordinatorId: 'conv-sync-coord-new' });

  // 1. Stale historical IDLE thread (>2 min old) is suppressed by independent baseline WITHOUT touching delivery markers
  const staleRes = await syncCompletionToCoordinator({ threadId: 'thr-040', force: false });
  assert.equal(staleRes.ok, true);
  assert.equal(staleRes.synced, false);
  assert.equal(staleRes.reason, 'suppressed_by_rebind_baseline');
  assert.equal(existsSync(mockApi.logFile), false);
  assert.equal(loadRegistry().threads['thr-040'].lastSyncedStepIndex, undefined);

  // 2. P0-1: Recently completed IDLE thread (within 120s grace window) is NOT swallowed -> delivers to conv-sync-coord-new!
  const recentRes = await syncCompletionToCoordinator({ threadId: 'thr-043', force: false });
  assert.equal(recentRes.ok, true);
  assert.equal(recentRes.synced, true);
  assert.equal(recentRes.coordinatorId, 'conv-sync-coord-new');

  // 3. Running thread finishes -> delivers to conv-sync-coord-new
  const runRes = await syncCompletionToCoordinator({ threadId: 'thr-041', force: false });
  assert.equal(runRes.ok, true);
  assert.equal(runRes.synced, true);
  assert.equal(runRes.coordinatorId, 'conv-sync-coord-new');

  // 4. Historical IDLE thread runs a NEW follow-up turn (step_index 7 > baseline 2) -> delivers cleanly
  writeTranscript(appDataDir, 'conv-sync-idle', [
    { step_index: 2, type: 'PLANNER_RESPONSE', content: '### 线程总结\n旧轮次已完成。' },
    { step_index: 6, type: 'USER_INPUT', content: '<USER_REQUEST>继续补充校验</USER_REQUEST>' },
    { step_index: 7, type: 'PLANNER_RESPONSE', content: '### 线程总结\n已补充新轮次校验。' },
  ]);
  const nextTurnRes = await syncCompletionToCoordinator({ threadId: 'thr-040', force: false });
  assert.equal(nextTurnRes.ok, true);
  assert.equal(nextTurnRes.synced, true);
  assert.equal(nextTurnRes.coordinatorId, 'conv-sync-coord-new');

  // 5. P1-1: Mid-delivery rebind (conv-sync-coord-new -> conv-sync-coord-v3 while agentapi is running)
  writeFileSync(triggerFile, '1', 'utf8');
  const midDeliveryRes = await syncCompletionToCoordinator({ threadId: 'thr-044', force: false });
  assert.equal(midDeliveryRes.ok, false);
  assert.equal(midDeliveryRes.synced, false);
  assert.equal(midDeliveryRes.reason, 'coordinator_rebound_during_delivery');
  assert.equal(midDeliveryRes.deliveredCoordinatorId, 'conv-sync-coord-new');
  assert.equal(midDeliveryRes.coordinatorId, 'conv-sync-coord-v3');

  // Delivery markers MUST NOT be written and .claim files MUST be released!
  const afterMid = loadRegistry();
  assert.equal(afterMid.threads['thr-044'].lastSyncedStepIndex, undefined);
  assert.equal(afterMid.threads['thr-044'].notifiedCoordinatorAt || '', '');
  assert.equal(afterMid.threads['thr-044'].pushedToCoordinatorAt || '', '');
  const claimsDir = join(stateDir, 'sync-claims');
  const remainingThr044Claims = existsSync(claimsDir)
    ? readdirSync(claimsDir).filter((f) => f.startsWith('thr-044-'))
    : [];
  assert.deepEqual(remainingThr044Claims, [], 'claims must be released after mid-delivery rebind');

  // Retry immediately delivers cleanly to conv-sync-coord-v3 and persists markers
  rmSync(triggerFile, { force: true });
  const retryRes = await syncCompletionToCoordinator({ threadId: 'thr-044', force: false });
  assert.equal(retryRes.ok, true);
  assert.equal(retryRes.synced, true);
  assert.equal(retryRes.coordinatorId, 'conv-sync-coord-v3');
  const afterRetry = loadRegistry();
  assert.equal(afterRetry.threads['thr-044'].lastSyncedStepIndex, 5);
  assert.ok(afterRetry.threads['thr-044'].notifiedCoordinatorAt);

  const deliveries = readFileSync(mockApi.logFile, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(deliveries.length, 5);
  assert.equal(deliveries[4].argv.includes('conv-sync-coord-v3'), true);
});

test('P1-2 & P0-1 hook-handler PreInvocation: blocks /coord hijack in retired session, protects retired coordinator, suppresses stale IDLE, and still surfaces recent IDLE completion', async (t) => {
  const env = createTempEnv(t, 'pt-rebind-hook-');
  const repoA = join(env.tempRoot, 'hook-rebind-repo');
  mkdirSync(repoA, { recursive: true });
  const keyA = normalizeKey(repoA);

  const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const recentIso = new Date(Date.now() - 5000).toISOString();

  writeTranscript(env.appDataDir, 'conv-hook-stale', [
    { step_index: 2, type: 'PLANNER_RESPONSE', content: '### 线程总结\n早已完成的历史结论。' },
  ]);
  writeTranscript(env.appDataDir, 'conv-hook-recent', [
    { step_index: 3, type: 'PLANNER_RESPONSE', content: '### 线程总结\n5秒前刚完成的新结论。' },
  ]);

  const reg = loadRegistry();
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'conv-hook-old',
    workspacePath: repoA,
    repoRoot: repoA,
    title: '[Coordinator] HookRepo',
    directiveVersion: 13,
    lastStepCount: 10,
  };
  reg.threads['thr-050'] = {
    threadId: 'thr-050',
    conversationId: 'conv-hook-stale',
    coordinatorId: 'conv-hook-old',
    workspaceKey: keyA,
    title: '陈旧历史完成线程',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    lastSummary: '早已完成的历史结论。',
    lastCompletedAt: staleIso,
    updatedAt: staleIso,
    notifiedCoordinatorAt: '',
    pushedToCoordinatorAt: '',
  };
  reg.threads['thr-051'] = {
    threadId: 'thr-051',
    conversationId: 'conv-hook-recent',
    coordinatorId: 'conv-hook-old',
    workspaceKey: keyA,
    title: '刚刚完成的待汇报线程',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    lastSummary: '5秒前刚完成的新结论。',
    lastCompletedAt: recentIso,
    updatedAt: recentIso,
    notifiedCoordinatorAt: '',
    pushedToCoordinatorAt: '',
  };
  saveRegistry(reg);

  await rebindCoordinator({ workspacePath: repoA, newCoordinatorId: 'conv-hook-new' });

  // 1. Old retired coordinator receives concise retirement notice (NOT standing protocol)
  const oldTurn1 = runHook(
    'PreInvocation',
    { conversationId: 'conv-hook-old', initialNumSteps: 12, lastUserInput: '<USER_REQUEST>继续派发任务</USER_REQUEST>' },
    env,
  );
  const oldMsg1 = oldTurn1?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
  assert.match(oldMsg1, /Project Coordinator Retired/);
  assert.match(oldMsg1, /conversation:\/\/conv-hook-new/);
  assert.match(oldMsg1, /Do NOT call `dispatch_thread`/);
  assert.doesNotMatch(oldMsg1, /Project Coordinator Standing Protocol/);

  // 2. Subsequent normal turn on retired coordinator stays quiet
  const oldTurn2 = runHook(
    'PreInvocation',
    { conversationId: 'conv-hook-old', initialNumSteps: 14, lastUserInput: '<USER_REQUEST>再问一句</USER_REQUEST>' },
    env,
  );
  assert.deepEqual(oldTurn2, {});

  // 3. P1-2: Typing `/coord` in retired session MUST NOT hijack ownership and MUST re-inject retirement notice
  const oldSlashCoord = runHook(
    'PreInvocation',
    {
      conversationId: 'conv-hook-old',
      workspacePath: repoA,
      initialNumSteps: 15,
      lastUserInput: '<USER_REQUEST>/coord 把总控抢回来</USER_REQUEST>',
    },
    env,
  );
  const oldSlashMsg = oldSlashCoord?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
  assert.match(oldSlashMsg, /Project Coordinator Retired/);
  assert.doesNotMatch(oldSlashMsg, /Project Coordinator Standing Protocol/);
  assert.equal(loadRegistry().coordinators[keyA].conversationId, 'conv-hook-new');

  // 4. After /compact on retired coordinator (stepCount drops), retirement notice re-injects
  const oldAfterCompact = runHook(
    'PreInvocation',
    { conversationId: 'conv-hook-old', initialNumSteps: 3, lastUserInput: '<USER_REQUEST>压缩后提问</USER_REQUEST>' },
    env,
  );
  assert.match(
    oldAfterCompact?.injectSteps?.[0]?.systemMessage?.systemMessage || '',
    /Project Coordinator Retired/,
  );

  // 5. New active coordinator receives v13 standing protocol + ONLY recent thr-051 (NOT stale thr-050!)
  const newTurn1 = runHook(
    'PreInvocation',
    { conversationId: 'conv-hook-new', initialNumSteps: 1, lastUserInput: '<USER_REQUEST>开始工作</USER_REQUEST>' },
    env,
  );
  assert.equal(newTurn1.injectSteps?.length, 2);
  assert.match(newTurn1.injectSteps[0].systemMessage.systemMessage, /Project Coordinator Standing Protocol/);
  const updateMsg = newTurn1.injectSteps[1].systemMessage.systemMessage;
  assert.match(updateMsg, /thr-051/);
  assert.doesNotMatch(updateMsg, /thr-050/);
  assert.equal(loadRegistry().coordinators[keyA].directiveVersion, 13);

  // 6. Rebinding again to conv-hook-third updates retirement notice for conv-hook-old
  await rebindCoordinator({ workspacePath: repoA, newCoordinatorId: 'conv-hook-third' });
  const oldTurnAfterThird = runHook(
    'PreInvocation',
    { conversationId: 'conv-hook-old', initialNumSteps: 5, lastUserInput: '<USER_REQUEST>还在吗</USER_REQUEST>' },
    env,
  );
  assert.match(
    oldTurnAfterThird?.injectSteps?.[0]?.systemMessage?.systemMessage || '',
    /conversation:\/\/conv-hook-third/,
  );
});

test('P1-2, P1-3 & retired write guards: promotes new + demotes old coordinator, validates target via LS before updating annotations, and rejects retired IDs on all write operations', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-rebind-validate-');
  const repoA = join(tempRoot, 'val-repo');
  mkdirSync(repoA, { recursive: true });
  const keyA = normalizeKey(repoA);

  const ls = await startMockLs(t, {
    strictConversations: true,
    conversations: [
      {
        id: 'conv-val-old',
        annotations: { title: '[Coordinator] ValRepo', pinned: true },
        metadata: { projectId: 'proj-val' },
        state: { runState: 'RUN_STATE_IDLE' },
      },
      {
        id: 'conv-val-new',
        annotations: { title: 'Fresh Session' },
        metadata: { projectId: 'proj-val' },
        state: { runState: 'RUN_STATE_IDLE' },
      },
      {
        id: 'conv-val-archived',
        annotations: { title: 'Archived Chat', archived: true },
        metadata: { projectId: 'proj-val' },
        state: { runState: 'RUN_STATE_IDLE' },
      },
      {
        id: 'conv-val-tagged-worker',
        annotations: { title: 'Worker Outside Registry', tags: ['project-thread'] },
        metadata: { projectId: 'proj-val' },
        state: { runState: 'RUN_STATE_IDLE' },
      },
      {
        id: 'conv-val-other-proj',
        annotations: { title: 'Other Project Chat' },
        metadata: { projectId: 'proj-other' },
        state: { runState: 'RUN_STATE_IDLE' },
      },
    ],
  });

  const reg = loadRegistry();
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'conv-val-old',
    projectId: 'proj-val',
    workspacePath: repoA,
    repoRoot: repoA,
    title: '[Coordinator] ValRepo',
    groupId: 'proj-grp-val',
  };
  reg.threads['thr-070'] = {
    threadId: 'thr-070',
    conversationId: 'conv-val-w70',
    coordinatorId: 'conv-val-old',
    workspaceKey: keyA,
    title: 'Active worker 70',
    runState: 'RUN_STATE_IDLE',
    archived: false,
  };
  saveRegistry(reg);

  const dec = addDecision({
    workspacePath: repoA,
    coordinatorId: 'conv-val-old',
    threadId: 'thr-070',
    title: '测试决策',
  });

  // 1. P1-3 target validation rejections — and ZERO UpdateConversation calls on failure!
  await assert.rejects(
    () => rebindCoordinator({ workspacePath: repoA, newCoordinatorId: '   ' }),
    /required/,
  );
  await assert.rejects(
    () => rebindCoordinator({ workspacePath: repoA, newCoordinatorId: 'bad id with spaces' }),
    /Invalid/,
  );
  await assert.rejects(
    () => rebindCoordinator({ workspacePath: repoA, newCoordinatorId: 'conv-does-not-exist' }),
    /does not exist|not found/i,
  );
  await assert.rejects(
    () => rebindCoordinator({ workspacePath: repoA, newCoordinatorId: 'conv-val-archived' }),
    /archived conversation/i,
  );
  await assert.rejects(
    () => rebindCoordinator({ workspacePath: repoA, newCoordinatorId: 'conv-val-tagged-worker' }),
    /Worker Thread/i,
  );
  await assert.rejects(
    () => rebindCoordinator({ workspacePath: repoA, newCoordinatorId: 'conv-val-other-proj' }),
    /different project/i,
  );
  assert.equal(
    ls.updatedConversations.length,
    0,
    'UpdateConversation must NEVER be called when validation fails',
  );

  // 2. Valid rebind promotes new Coordinator AND demotes old Coordinator
  const okRes = await rebindCoordinator({
    workspacePath: repoA,
    newCoordinatorId: 'conv-val-new',
  });
  assert.equal(okRes.ok, true);
  assert.equal(ls.updatedConversations.length, 2);

  const promoteCall = ls.updatedConversations.find((u) => u.conversationId === 'conv-val-new');
  const demoteCall = ls.updatedConversations.find((u) => u.conversationId === 'conv-val-old');
  assert.ok(promoteCall, 'must promote new Coordinator');
  assert.equal(promoteCall.annotations?.pinned, true);
  assert.match(promoteCall.annotations?.title || '', /^\[Coordinator\] /);
  assert.ok(promoteCall.annotations?.tags?.includes('project-coordinator'));

  assert.ok(demoteCall, 'must demote retired Coordinator');
  assert.equal(demoteCall.annotations?.pinned, false);
  assert.match(demoteCall.annotations?.title || '', /^\[Retired Coordinator\] /);
  assert.ok(demoteCall.annotations?.tags?.includes('project-coordinator-retired'));

  // 3. Retired Coordinator ID MUST be rejected on ALL write operations
  await assert.rejects(
    () =>
      dispatchThread({
        workspacePath: repoA,
        coordinatorId: 'conv-val-old',
        title: 'Blocked dispatch',
        taskPrompt: 'Should fail',
        createWorktree: false,
      }),
    /has been retired/,
  );
  await assert.rejects(
    () =>
      sendThreadMessage({
        threadId: 'thr-070',
        message: 'Blocked message',
        coordinatorId: 'conv-val-old',
      }),
    /has been retired/,
  );
  await assert.rejects(
    () => archiveThread('thr-070', { removeWorktree: false, coordinatorId: 'conv-val-old' }),
    /has been retired/,
  );
  await assert.rejects(
    () => cleanupThreadWorktree('thr-070', { coordinatorId: 'conv-val-old' }),
    /has been retired/,
  );
  await assert.rejects(
    () =>
      updateProjectMemory({
        workspacePath: repoA,
        coordinatorId: 'conv-val-old',
        content: 'Blocked write',
        mode: 'append',
      }),
    /has been retired/,
  );
  assert.throws(
    () =>
      addDecision({
        workspacePath: repoA,
        coordinatorId: 'conv-val-old',
        title: 'Blocked decision',
      }),
    /has been retired/,
  );
  assert.throws(
    () => resolveDecision(dec.id, { coordinatorId: 'conv-val-old' }),
    /has been retired/,
  );
  assert.throws(
    () => dismissDecision(dec.id, { coordinatorId: 'conv-val-old' }),
    /has been retired/,
  );

  // Read-only memory access remains allowed
  const readMem = await updateProjectMemory({
    workspacePath: repoA,
    coordinatorId: 'conv-val-old',
    mode: 'read',
  });
  assert.equal(typeof readMem.content, 'string');
});

test('getEffectiveSettings, resolveDefaultDispatchModel (including retired-only lookup without scope args), and listCoordinatorCandidates reflect newly rebound coordinator immediately', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-rebind-inherit-');
  const genMeta = new Map();
  const conversations = [
    {
      id: 'conv-inh-old',
      annotations: { title: '[Coordinator] InheritRepo' },
      metadata: { projectId: 'proj-inh' },
      state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-28T01:00:00Z' },
    },
    {
      id: 'conv-inh-new',
      annotations: { title: 'Fresh Planning Chat' },
      metadata: { projectId: 'proj-inh' },
      state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-28T02:00:00Z' },
    },
    {
      id: 'conv-inh-worker',
      annotations: { title: '[thr-060] Worker', tags: ['project-thread'] },
      metadata: { projectId: 'proj-inh' },
      state: { runState: 'RUN_STATE_IDLE', updateTime: '2026-11-28T02:05:00Z' },
    },
  ];
  await startMockLs(t, { generatorMetadataByCascade: genMeta, conversations });

  const repoA = join(tempRoot, 'inherit-rebind-repo');
  mkdirSync(repoA, { recursive: true });
  const keyA = normalizeKey(repoA);

  genMeta.set('conv-inh-old', [
    {
      stepIndices: [1],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M528',
        responseModel: 'gemini-4-hydrogen-xhigh',
        modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
      },
    },
  ]);

  const reg = loadRegistry();
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'conv-inh-old',
    projectId: 'proj-inh',
    workspacePath: repoA,
    repoRoot: repoA,
    title: '[Coordinator] InheritRepo',
  };
  reg.threads['thr-060'] = {
    threadId: 'thr-060',
    conversationId: 'conv-inh-worker',
    coordinatorId: 'conv-inh-old',
    workspaceKey: keyA,
    title: 'Active worker',
    runState: 'RUN_STATE_IDLE',
    archived: false,
  };
  saveRegistry(reg);
  saveSettings({ defaults: { worktreeModel: 'inherit', readOnlyModel: 'inherit' } });

  const candRes = await listCoordinatorCandidates({
    workspacePath: repoA,
    coordinatorId: 'conv-inh-old',
    conversationId: 'conv-inh-new',
  });
  assert.equal(candRes.ok, true);
  assert.equal(candRes.activeThreadCount, 1);
  assert.equal(candRes.candidates.length, 1);
  assert.equal(candRes.candidates[0].id, 'conv-inh-new');
  assert.equal(candRes.candidates[0].isCurrentHost, true);

  const beforeEff = await getEffectiveSettings({ workspacePath: repoA });
  assert.equal(beforeEff.coordinatorId, 'conv-inh-old');
  assert.equal(beforeEff.coordinatorModelDisplayName, 'Gemini 4 Hydrogen (XHigh)');

  // Rebind to Turn-0 conv-inh-new
  await rebindCoordinator({ workspacePath: repoA, newCoordinatorId: 'conv-inh-new' });

  // Passing ONLY the retired coordinatorId (no workspacePath / projectId!) still resolves to conv-inh-new
  const retiredOnlyEff = await getEffectiveSettings({ coordinatorId: 'conv-inh-old' });
  assert.equal(retiredOnlyEff.coordinatorId, 'conv-inh-new');
  assert.equal(retiredOnlyEff.coordinatorModel, '');
  assert.equal(retiredOnlyEff.coordinatorModelDisplayName, '');
  assert.equal(await resolveDefaultDispatchModel({ workspacePath: repoA, createWorktree: true }), 'pro');

  genMeta.set('conv-inh-new', [
    {
      stepIndices: [1],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M534',
        responseModel: 'gemini-4-neon-low',
        modelDisplayName: 'Gemini 4 Neon (Low)',
      },
    },
  ]);
  const turn1Eff = await getEffectiveSettings({ workspacePath: repoA });
  assert.equal(turn1Eff.coordinatorId, 'conv-inh-new');
  assert.equal(turn1Eff.coordinatorModel, 'gemini-4-neon-low');
  assert.equal(turn1Eff.coordinatorModelDisplayName, 'Gemini 4 Neon (Low)');
  assert.equal(
    await resolveDefaultDispatchModel({ workspacePath: repoA, createWorktree: false }),
    'gemini-4-neon-low',
  );
});

test('Sidecar API, UI rebind modal, 3-locale I18N, P1-4 coordinator button visibility & message source guard, zero middle dots, zero native dialogs, and LF endings', () => {
  const mainMjs = readFileSync(new URL('../sidecars/threads/main.mjs', import.meta.url), 'utf8');
  const indexHtml = readFileSync(new URL('../sidecars/threads/index.html', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const themeCss = readFileSync(new URL('../sidecars/threads/theme.css', import.meta.url), 'utf8');
  const hookMjs = readFileSync(new URL('../scripts/hook-handler.mjs', import.meta.url), 'utf8');

  // 1. Backend routes & hook-handler lock discipline
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/rebind_coordinator['"]/);
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/coordinator_candidates['"]/);
  assert.match(hookMjs, /const\s+DIRECTIVE_VERSION\s*=\s*13\s*;/);
  assert.doesNotMatch(hookMjs, /\bsaveRegistry\b/, 'hook-handler must use mutateRegistry exclusively');

  // 2. HTML structure & message event source validation
  assert.match(indexHtml, /id="btn-rebind-coord"/);
  assert.match(indexHtml, /id="pt-modal-rebind-box"/);
  assert.match(indexHtml, /id="pt-modal-rebind-input"/);
  assert.match(indexHtml, /id="pt-modal-rebind-select"/);
  assert.match(appJs, /e\.source\s*!==\s*window\.parent\s*&&\s*e\.source\s*!==\s*window/);

  // 3. App wiring: /api/rebind_coordinator, settings cache clear, zero native confirm/alert/prompt
  assert.match(appJs, /\/api\/rebind_coordinator/);
  assert.match(appJs, /loadedSettingsData\s*=\s*null/);
  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appJs), false);

  // 4. CSS rules
  assert.match(themeCss, /\.coord-switch-btn\s*\{/);
  assert.match(themeCss, /\.pt-modal-rebind-box\s*\{/);
  assert.match(themeCss, /\.pt-rebind-route\s*\{/);
  assert.match(themeCss, /:root\[data-theme="light"\]\s+\.pt-rebind-route\s*\{/);

  // 5. 3-locale I18N completeness and zero middle dot in all new rebind strings
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
  const computeUiStateFn = extractFunctionSource(appJs, 'computeCoordinatorUiState');
  const ctx = {};
  vm.runInNewContext(
    `
    ${appJs.slice(i18nStart, i18nEnd)};
    ${computeUiStateFn}
    this.I18N = I18N;
    this.computeCoordinatorUiState = computeCoordinatorUiState;
    `,
    ctx,
  );

  const rebindI18nKeys = [
    'coordSwitchBtn',
    'coordSwitchThisBtn',
    'coordSwitchTip',
    'coordSwitchThisTip',
    'rebindModalTitle',
    'rebindModalOldLabel',
    'rebindModalNewLabel',
    'rebindModalUnselected',
    'rebindModalSelectLabel',
    'rebindModalSelectManual',
    'rebindModalInputLabel',
    'rebindModalInputPh',
    'rebindModalCurrentTag',
    'rebindModalRetiredTag',
    'rebindModalHostHint',
    'rebindModalMigratePill',
    'rebindModalNotice',
    'rebindModalConfirm',
    'rebindModalSwitching',
    'rebindErrEmpty',
    'rebindErrSame',
    'rebindErrWorker',
    'rebindErrToast',
    'rebindSuccessToast',
  ];
  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    for (const k of rebindI18nKeys) {
      const val = ctx.I18N[loc][k];
      assert.ok(val !== undefined, `Missing ${loc}.${k}`);
      const rendered = typeof val === 'function' ? val(2) : val;
      assert.equal(String(rendered).includes('·'), false, `${loc}.${k} must not use middle dot`);
    }
  }

  // 6. Verify coordinator button visibility, deduplication, and P1-4 fallback edge cases
  const sampleThreads = [
    { threadId: 'thr-001', conversationId: 'conv-worker-1', archived: false },
  ];

  // (a) Unbound project: all coordinator controls hidden
  const sUnbound = ctx.computeCoordinatorUiState({
    coordConvId: '',
    hostConvId: 'conv-any',
    hasLiveHostConvId: true,
    manualPopoutConvId: '',
    threads: sampleThreads,
  });
  assert.equal(sUnbound.hasCoord, false);
  assert.equal(sUnbound.showHeaderCoordBtn, false);
  assert.equal(sUnbound.showCardCoordBtn, false);
  assert.equal(sUnbound.showChatCoordBtn, false);
  assert.equal(sUnbound.showRebindBtn, false);

  // (b) Live host IS ON Coordinator: ALL "Back to Coordinator" buttons hidden, switch button calm
  const sOnCoord = ctx.computeCoordinatorUiState({
    coordConvId: 'conv-coord-1',
    hostConvId: 'conv-coord-1',
    hasLiveHostConvId: true,
    manualPopoutConvId: '',
    threads: sampleThreads,
  });
  assert.equal(sOnCoord.isOnCoordinator, true);
  assert.equal(sOnCoord.away, false);
  assert.equal(sOnCoord.showHeaderCoordBtn, false);
  assert.equal(sOnCoord.showCardCoordBtn, false);
  assert.equal(sOnCoord.showChatCoordBtn, false);
  assert.equal(sOnCoord.goalCardClickable, false);
  assert.equal(sOnCoord.showRebindBtn, true);
  assert.equal(sOnCoord.highlightRebindBtn, false);

  // (c) Live host IS ON Coordinator even if stale manualPopoutConvId remained: live host wins!
  const sOnCoordStalePopout = ctx.computeCoordinatorUiState({
    coordConvId: 'conv-coord-1',
    hostConvId: 'conv-coord-1',
    hasLiveHostConvId: true,
    manualPopoutConvId: 'conv-worker-1',
    threads: sampleThreads,
  });
  assert.equal(sOnCoordStalePopout.isOnCoordinator, true);
  assert.equal(sOnCoordStalePopout.showHeaderCoordBtn, false);
  assert.equal(sOnCoordStalePopout.showCardCoordBtn, false);
  assert.equal(sOnCoordStalePopout.showChatCoordBtn, false);
  assert.equal(sOnCoordStalePopout.activeMainWorkerConvId, '');

  // (d) P1-4: Static URL fallback (hasLiveHostConvId: false) with active manualPopoutConvId -> popout wins!
  const sStaticFallbackPopout = ctx.computeCoordinatorUiState({
    coordConvId: 'conv-coord-1',
    hostConvId: 'conv-coord-1',
    hasLiveHostConvId: false,
    manualPopoutConvId: 'conv-worker-1',
    threads: sampleThreads,
  });
  assert.equal(sStaticFallbackPopout.isOnCoordinator, false);
  assert.equal(sStaticFallbackPopout.away, true);
  assert.equal(sStaticFallbackPopout.showHeaderCoordBtn, false);
  assert.equal(sStaticFallbackPopout.showCardCoordBtn, true);
  assert.equal(sStaticFallbackPopout.showChatCoordBtn, true);
  assert.equal(sStaticFallbackPopout.activeMainWorkerConvId, 'conv-worker-1');

  // (e) P1-4: Unknown host (hostConvId empty, no popout) -> NOT falsely on Coordinator; shows single calm card entry only
  const sUnknownHost = ctx.computeCoordinatorUiState({
    coordConvId: 'conv-coord-1',
    hostConvId: '',
    hasLiveHostConvId: false,
    manualPopoutConvId: '',
    threads: sampleThreads,
  });
  assert.equal(sUnknownHost.isOnCoordinator, false);
  assert.equal(sUnknownHost.away, false);
  assert.equal(sUnknownHost.cardCoordCalm, true);
  assert.equal(sUnknownHost.showHeaderCoordBtn, false);
  assert.equal(sUnknownHost.showCardCoordBtn, true);
  assert.equal(sUnknownHost.showChatCoordBtn, false);
  assert.equal(sUnknownHost.goalCardClickable, true);

  // (f) Main window is on a Worker Thread (confirmed away): single back button on board + chat header
  const sOnWorker = ctx.computeCoordinatorUiState({
    coordConvId: 'conv-coord-1',
    hostConvId: 'conv-worker-1',
    hasLiveHostConvId: true,
    manualPopoutConvId: '',
    threads: sampleThreads,
  });
  assert.equal(sOnWorker.isOnCoordinator, false);
  assert.equal(sOnWorker.away, true);
  assert.equal(sOnWorker.showHeaderCoordBtn, false);
  assert.equal(sOnWorker.showCardCoordBtn, true);
  assert.equal(sOnWorker.showChatCoordBtn, true);
  assert.equal(sOnWorker.goalCardClickable, true);
  assert.equal(sOnWorker.activeMainWorkerConvId, 'conv-worker-1');
  assert.equal(sOnWorker.highlightRebindBtn, false);

  // (g) Main window is on a different non-worker conversation: single back button + gentle Switch-to-This highlight
  const sOnOther = ctx.computeCoordinatorUiState({
    coordConvId: 'conv-coord-1',
    hostConvId: 'conv-fresh-session',
    hasLiveHostConvId: true,
    manualPopoutConvId: '',
    threads: sampleThreads,
  });
  assert.equal(sOnOther.isOnCoordinator, false);
  assert.equal(sOnOther.showHeaderCoordBtn, false);
  assert.equal(sOnOther.showCardCoordBtn, true);
  assert.equal(sOnOther.showChatCoordBtn, true);
  assert.equal(sOnOther.switchableHostConvId, 'conv-fresh-session');
  assert.equal(sOnOther.highlightRebindBtn, true);

  // 7. LF line endings check on all modified/added .mjs files
  for (const rel of [
    '../lib/store.mjs',
    '../scripts/hook-handler.mjs',
    '../sidecars/threads/main.mjs',
    '../tests/coordinator-rebind.test.mjs',
  ]) {
    const raw = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!raw.includes(Buffer.from('\r')), `${rel} must use LF line endings`);
  }
});

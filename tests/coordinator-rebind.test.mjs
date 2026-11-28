import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  getEffectiveSettings,
  initCoordinator,
  listCoordinatorCandidates,
  loadRegistry,
  markThreadRead,
  normalizeKey,
  rebindCoordinator,
  resolveDefaultDispatchModel,
  resolveProjectScope,
  saveRegistry,
  saveSettings,
  syncCompletionToCoordinator,
  syncThreads,
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

function createMockAgentApi(dir, name = 'agentapi') {
  const logFile = join(dir, `${name}-calls.jsonl`);
  const scriptPath = join(dir, `${name}.mjs`);
  writeFileSync(
    scriptPath,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: process.argv.slice(2), projectId: process.env.ANTIGRAVITY_PROJECT_ID || "" }) + "\\n");`,
      'process.stdout.write(JSON.stringify({ response: { sendMessage: { ok: true } } }));',
    ].join('\n'),
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

function startMockLs(t, { generatorMetadataByCascade = new Map(), conversations = [] } = {}) {
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
        const hit = conversations.find((c) => c.id === payload.conversationId);
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

test('rebindCoordinator atomically switches coordinator, migrates only active same-project threads, suppresses stale IDLE avalanche, and guards invalid targets', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-rebind-core-');
  const repoA = join(tempRoot, 'repo-a');
  const repoB = join(tempRoot, 'repo-b');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);

  // Seed transcript for thr-002 (pre-existing IDLE un-notified thread)
  writeTranscript(appDataDir, 'conv-w-002', [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Old task</USER_REQUEST>' },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      content: '### 线程总结\n早已完成的历史任务。',
    },
  ]);
  // Seed transcript for thr-001 (currently RUNNING thread)
  writeTranscript(appDataDir, 'conv-w-001', [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Running task</USER_REQUEST>' },
  ]);

  const reg = loadRegistry();
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'conv-coord-a-old',
    workspacePath: repoA,
    repoRoot: repoA,
    title: '[Coordinator] RepoA',
    directiveVersion: 13,
    lastStepCount: 15,
    createdAt: '2026-11-28T01:00:00Z',
    updatedAt: '2026-11-28T01:00:00Z',
  };
  reg.coordinators[keyB] = {
    key: keyB,
    conversationId: 'conv-coord-b',
    workspacePath: repoB,
    repoRoot: repoB,
    title: '[Coordinator] RepoB',
    createdAt: '2026-11-28T01:00:00Z',
    updatedAt: '2026-11-28T01:00:00Z',
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
    createdAt: '2026-11-28T01:05:00Z',
    updatedAt: '2026-11-28T01:05:00Z',
  };
  reg.threads['thr-002'] = {
    threadId: 'thr-002',
    conversationId: 'conv-w-002',
    coordinatorId: 'conv-coord-a-old',
    workspaceKey: keyA,
    title: '切换前早已完成未推送的任务',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    lastSummary: '早已完成的历史任务。',
    lastCompletedAt: '2026-11-28T01:10:00Z',
    notifiedCoordinatorAt: '',
    pushedToCoordinatorAt: '',
    createdAt: '2026-11-28T01:00:00Z',
    updatedAt: '2026-11-28T01:10:00Z',
  };
  reg.threads['thr-003'] = {
    threadId: 'thr-003',
    conversationId: 'conv-w-003',
    coordinatorId: 'conv-coord-a-old',
    workspaceKey: keyA,
    title: '已归档历史线程',
    runState: 'RUN_STATE_IDLE',
    archived: true,
    createdAt: '2026-11-28T00:30:00Z',
    updatedAt: '2026-11-28T00:40:00Z',
  };
  reg.threads['thr-004'] = {
    threadId: 'thr-004',
    conversationId: 'conv-w-004',
    coordinatorId: 'conv-coord-b',
    workspaceKey: keyB,
    title: '其他项目活跃线程',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
    createdAt: '2026-11-28T01:00:00Z',
    updatedAt: '2026-11-28T01:00:00Z',
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
  assert.deepEqual([...res.migratedThreadIds].sort(), ['thr-001', 'thr-002']);
  assert.equal(res.migratedCount, 2);
  assert.deepEqual(res.suppressedAvalancheThreadIds, ['thr-002']);

  const after = loadRegistry();
  assert.equal(after.coordinators[keyA].conversationId, 'conv-coord-a-new');
  assert.deepEqual(after.coordinators[keyA].retiredCoordinatorIds, ['conv-coord-a-old']);
  assert.equal(after.coordinators[keyA].directiveVersion, undefined, 'new coordinator starts fresh to receive protocol');
  assert.equal(after.coordinators[keyA].rebindSeq, 1);

  // Active RUNNING thread migrated cleanly WITHOUT suppressing future completion
  assert.equal(after.threads['thr-001'].coordinatorId, 'conv-coord-a-new');
  assert.equal(after.threads['thr-001'].notifiedCoordinatorAt || '', '');
  assert.equal(after.threads['thr-001'].reboundSilentSyncAt, undefined);

  // Pre-existing IDLE un-notified thread migrated WITH anti-avalanche markers
  assert.equal(after.threads['thr-002'].coordinatorId, 'conv-coord-a-new');
  assert.equal(after.threads['thr-002'].lastSyncedStepIndex, 3);
  assert.ok(after.threads['thr-002'].notifiedCoordinatorAt);
  assert.ok(after.threads['thr-002'].reboundSilentSyncAt);

  // Archived thread & other project thread strictly untouched
  assert.equal(after.threads['thr-003'].coordinatorId, 'conv-coord-a-old');
  assert.equal(after.threads['thr-004'].coordinatorId, 'conv-coord-b');
  assert.equal(after.coordinators[keyB].conversationId, 'conv-coord-b');

  // Pending explicit decision in RepoA updated to new coordinator
  assert.equal(after.decisions[decA.id].coordinatorId, 'conv-coord-a-new');

  // 4. Switching back conv-coord-a-new -> conv-coord-a-old removes conv-coord-a-old from retired and retires conv-coord-a-new
  const backRes = await rebindCoordinator({
    workspacePath: repoA,
    newCoordinatorId: 'conv-coord-a-old',
  });
  assert.equal(backRes.coordinatorId, 'conv-coord-a-old');
  assert.deepEqual(backRes.retiredCoordinatorIds, ['conv-coord-a-new']);
  assert.equal(loadRegistry().coordinators[keyA].rebindSeq, 2);
});

test('initCoordinator (/coord) rebind and workspace-less conv: scope rebinding preserve scope and isolate archived threads', async (t) => {
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

  // User runs /coord in a new session for the same repository
  const nextCoord = await initCoordinator({ workspacePath: repoA, conversationId: 'conv-init-2' });
  assert.equal(nextCoord.conversationId, 'conv-init-2');
  assert.deepEqual(nextCoord.retiredCoordinatorIds, ['conv-init-1']);
  const afterInit = loadRegistry();
  assert.equal(afterInit.threads['thr-010'].coordinatorId, 'conv-init-2');
  assert.equal(afterInit.threads['thr-011'].coordinatorId, 'conv-init-1');

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

  // Opening the new standalone conversation resolves the same conv: scope and lists its threads
  const resolvedNewScope = await resolveProjectScope({ conversationId: 'conv-solo-new' });
  assert.equal(resolvedNewScope.scopeKey, 'conv:conv-solo-old');
  const soloSnap = await syncThreads({ conversationId: 'conv-solo-new', includeArchived: true });
  assert.equal(soloSnap.coordinator?.conversationId, 'conv-solo-new');
  assert.deepEqual(
    soloSnap.threads.map((x) => x.threadId).sort(),
    ['thr-020', 'thr-021'],
  );
});

test('concurrent stale saveRegistry, markThreadRead, and archiveThread never roll back rebound coordinatorId', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-rebind-race-');
  const repoA = join(tempRoot, 'race-repo');
  mkdirSync(repoA, { recursive: true });
  const keyA = normalizeKey(repoA);

  const seed = loadRegistry();
  seed.coordinators[keyA] = {
    key: keyA,
    conversationId: 'conv-race-old',
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

  // Capture stale snapshot BEFORE rebinding (simulates concurrent poll/hook)
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

  // markThreadRead and archiveThread also preserve rebound coordinator atomically
  await markThreadRead({ threadId: 'thr-030' });
  await archiveThread('thr-031', { removeWorktree: false });

  current = loadRegistry();
  assert.equal(current.coordinators[keyA].conversationId, 'conv-race-new');
  assert.equal(current.threads['thr-030'].coordinatorId, 'conv-race-new');
  assert.ok(current.threads['thr-030'].viewedAt);
  assert.equal(current.threads['thr-031'].archived, true);
  assert.equal(current.threads['thr-031'].coordinatorId, 'conv-race-new');
});

test('syncCompletionToCoordinator live re-reads latest targetCoordId, blocks stale IDLE avalanche, and delivers subsequent turns to new coordinator', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-rebind-sync-');
  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59997';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-sync';
  const mockApi = createMockAgentApi(tempRoot, 'agentapi');
  process.env.ANTIGRAVITY_AGENTAPI_EXE = mockApi.exePath;

  const repoA = join(tempRoot, 'sync-repo');
  mkdirSync(repoA, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoA });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoA });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoA });
  writeFileSync(join(repoA, 'a.txt'), 'init\n', 'utf8');
  execFileSync('git', ['add', 'a.txt'], { cwd: repoA });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoA });

  const keyA = normalizeKey(repoA);
  writeTranscript(appDataDir, 'conv-sync-idle', [
    { step_index: 2, type: 'PLANNER_RESPONSE', content: '### 线程总结\n旧轮次已完成。' },
  ]);
  writeTranscript(appDataDir, 'conv-sync-run', [
    { step_index: 4, type: 'PLANNER_RESPONSE', content: '### 线程总结\n运行中任务刚刚完成。' },
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
    title: '历史 IDLE 线程',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    lastCompletedAt: '2026-11-28T01:00:00Z',
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
  saveRegistry(reg);

  // Rebind coordinator
  await rebindCoordinator({ workspacePath: repoA, newCoordinatorId: 'conv-sync-coord-new' });

  // 1. Historical IDLE thread does NOT trigger stale callback delivery
  const staleRes = await syncCompletionToCoordinator({ threadId: 'thr-040', force: false });
  assert.equal(staleRes.ok, true);
  assert.equal(staleRes.synced, false);
  assert.equal(staleRes.reason, 'already_synced');
  assert.equal(existsSync(mockApi.logFile), false);

  // 2. Running thread finishes -> delivers to conv-sync-coord-new
  const runRes = await syncCompletionToCoordinator({ threadId: 'thr-041', force: false });
  assert.equal(runRes.ok, true);
  assert.equal(runRes.synced, true);
  assert.equal(runRes.coordinatorId, 'conv-sync-coord-new');

  // 3. Historical IDLE thread runs a NEW follow-up turn (step_index 7) -> delivers cleanly to conv-sync-coord-new
  writeTranscript(appDataDir, 'conv-sync-idle', [
    { step_index: 2, type: 'PLANNER_RESPONSE', content: '### 线程总结\n旧轮次已完成。' },
    { step_index: 6, type: 'USER_INPUT', content: '<USER_REQUEST>继续补充校验</USER_REQUEST>' },
    { step_index: 7, type: 'PLANNER_RESPONSE', content: '### 线程总结\n已补充新轮次校验。' },
  ]);
  const nextTurnRes = await syncCompletionToCoordinator({ threadId: 'thr-040', force: false });
  assert.equal(nextTurnRes.ok, true);
  assert.equal(nextTurnRes.synced, true);
  assert.equal(nextTurnRes.coordinatorId, 'conv-sync-coord-new');

  // 4. Mid-flight live re-read: even if a thread still holds retired coordinatorId on disk, live check routes to active coordinator
  writeTranscript(appDataDir, 'conv-sync-midflight', [
    { step_index: 1, type: 'PLANNER_RESPONSE', content: '### 线程总结\n竞态切换回调校验。' },
  ]);
  const regMid = loadRegistry();
  regMid.threads['thr-042'] = {
    threadId: 'thr-042',
    conversationId: 'conv-sync-midflight',
    coordinatorId: 'conv-sync-coord-old', // stale retired ID
    workspaceKey: keyA,
    title: '中段换绑线程',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
  };
  saveRegistry(regMid);

  const midRes = await syncCompletionToCoordinator({ threadId: 'thr-042', force: false });
  assert.equal(midRes.ok, true);
  assert.equal(midRes.synced, true);
  assert.equal(midRes.coordinatorId, 'conv-sync-coord-new');

  const deliveries = readFileSync(mockApi.logFile, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(deliveries.length, 3);
  for (const call of deliveries) {
    assert.ok(call.argv.includes('conv-sync-coord-new'), 'every delivery must route to new coordinator');
    assert.equal(call.argv.includes('conv-sync-coord-old'), false, 'must never deliver to retired coordinator');
  }
});

test('hook-handler PreInvocation protects retired coordinators without injecting standing protocol and avoids avalanche on new coordinator', async (t) => {
  const env = createTempEnv(t, 'pt-rebind-hook-');
  const repoA = join(env.tempRoot, 'hook-rebind-repo');
  mkdirSync(repoA, { recursive: true });
  const keyA = normalizeKey(repoA);

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
    conversationId: 'conv-hook-idle-worker',
    coordinatorId: 'conv-hook-old',
    workspaceKey: keyA,
    title: '切换前完成线程',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    lastSummary: '已完成',
    lastCompletedAt: '2026-11-28T01:00:00Z',
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

  // 2. Subsequent turn on retired coordinator (without compact or newer rebind) stays quiet (one-time notice)
  const oldTurn2 = runHook(
    'PreInvocation',
    { conversationId: 'conv-hook-old', initialNumSteps: 14, lastUserInput: '<USER_REQUEST>再问一句</USER_REQUEST>' },
    env,
  );
  assert.deepEqual(oldTurn2, {});

  // 3. After /compact on retired coordinator (stepCount drops), retirement notice re-injects
  const oldAfterCompact = runHook(
    'PreInvocation',
    { conversationId: 'conv-hook-old', initialNumSteps: 3, lastUserInput: '<USER_REQUEST>压缩后提问</USER_REQUEST>' },
    env,
  );
  const oldCompactMsg = oldAfterCompact?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
  assert.match(oldCompactMsg, /Project Coordinator Retired/);
  assert.match(oldCompactMsg, /conversation:\/\/conv-hook-new/);

  // 4. New active coordinator receives v13 standing protocol ONLY (zero historical IDLE thread avalanche!)
  const newTurn1 = runHook(
    'PreInvocation',
    { conversationId: 'conv-hook-new', initialNumSteps: 1, lastUserInput: '<USER_REQUEST>开始工作</USER_REQUEST>' },
    env,
  );
  assert.equal(newTurn1.injectSteps?.length, 1);
  const newMsg = newTurn1.injectSteps[0].systemMessage.systemMessage;
  assert.match(newMsg, /Project Coordinator Standing Protocol/);
  assert.doesNotMatch(newMsg, /\[Project Threads Update\]/);
  assert.equal(loadRegistry().coordinators[keyA].directiveVersion, 13);

  // 5. Rebinding again to conv-hook-third updates retirement notice for conv-hook-old
  await rebindCoordinator({ workspacePath: repoA, newCoordinatorId: 'conv-hook-third' });
  const oldTurnAfterThird = runHook(
    'PreInvocation',
    { conversationId: 'conv-hook-old', initialNumSteps: 5, lastUserInput: '<USER_REQUEST>还在吗</USER_REQUEST>' },
    env,
  );
  const oldThirdMsg = oldTurnAfterThird?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
  assert.match(oldThirdMsg, /conversation:\/\/conv-hook-third/);
});

test('getEffectiveSettings, resolveDefaultDispatchModel, and listCoordinatorCandidates reflect newly rebound coordinator immediately (including Turn-0 fallback)', async (t) => {
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

  // Candidate listing excludes worker thread & current coordinator and surfaces conv-inh-new
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

  // Before rebind: uses conv-inh-old model
  const beforeEff = await getEffectiveSettings({ workspacePath: repoA });
  assert.equal(beforeEff.coordinatorId, 'conv-inh-old');
  assert.equal(beforeEff.coordinatorModelDisplayName, 'Gemini 4 Hydrogen (XHigh)');

  // Rebind to Turn-0 conv-inh-new (no generatorMetadata yet) -> clears old model & falls back safely to 'pro'
  await rebindCoordinator({ workspacePath: repoA, newCoordinatorId: 'conv-inh-new' });
  const turn0Eff = await getEffectiveSettings({
    workspacePath: repoA,
    coordinatorId: 'conv-inh-old', // stale retired ID should transparently resolve to conv-inh-new
  });
  assert.equal(turn0Eff.coordinatorId, 'conv-inh-new');
  assert.equal(turn0Eff.coordinatorModel, '');
  assert.equal(turn0Eff.coordinatorModelDisplayName, '');
  assert.equal(await resolveDefaultDispatchModel({ workspacePath: repoA, createWorktree: true }), 'pro');

  // Once conv-inh-new runs its first turn with Gemini 4 Neon (Low), inherit resolves to new model
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

test('Sidecar API, UI rebind modal, 3-locale I18N, coordinator button visibility logic, zero middle dots, zero native dialogs, and LF endings', () => {
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

  // 2. HTML structure: Switch button in Coordinator card + in-DOM rebind modal box
  assert.match(indexHtml, /id="btn-rebind-coord"/);
  assert.match(indexHtml, /id="pt-modal-rebind-box"/);
  assert.match(indexHtml, /id="pt-modal-rebind-input"/);
  assert.match(indexHtml, /id="pt-modal-rebind-select"/);

  // 3. App wiring: /api/rebind_coordinator, settings cache clear, zero native confirm/alert/prompt
  assert.match(appJs, /\/api\/rebind_coordinator/);
  assert.match(appJs, /loadedSettingsData\s*=\s*null/);
  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appJs), false);

  // 4. CSS rules for calm secondary switch button, modal route, and light theme
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

  // 6. Verify coordinator button visibility & deduplication logic (isOnCoordinator)
  const sampleThreads = [
    { threadId: 'thr-001', conversationId: 'conv-worker-1', archived: false },
  ];

  // (a) Unbound project: all coordinator controls hidden
  const sUnbound = ctx.computeCoordinatorUiState({
    coordConvId: '',
    hostConvId: 'conv-any',
    manualPopoutConvId: '',
    threads: sampleThreads,
  });
  assert.equal(sUnbound.hasCoord, false);
  assert.equal(sUnbound.showHeaderCoordBtn, false);
  assert.equal(sUnbound.showCardCoordBtn, false);
  assert.equal(sUnbound.showChatCoordBtn, false);
  assert.equal(sUnbound.showRebindBtn, false);

  // (b) Main window IS ON Coordinator: ALL "Back to Coordinator" buttons hidden, switch button calm
  const sOnCoord = ctx.computeCoordinatorUiState({
    coordConvId: 'conv-coord-1',
    hostConvId: 'conv-coord-1',
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

  // (c) Main window IS ON Coordinator even if stale manualPopoutConvId remained: authoritative hostId wins!
  const sOnCoordStalePopout = ctx.computeCoordinatorUiState({
    coordConvId: 'conv-coord-1',
    hostConvId: 'conv-coord-1',
    manualPopoutConvId: 'conv-worker-1',
    threads: sampleThreads,
  });
  assert.equal(sOnCoordStalePopout.isOnCoordinator, true);
  assert.equal(sOnCoordStalePopout.showHeaderCoordBtn, false);
  assert.equal(sOnCoordStalePopout.showCardCoordBtn, false);
  assert.equal(sOnCoordStalePopout.showChatCoordBtn, false);
  assert.equal(sOnCoordStalePopout.activeMainWorkerConvId, '');

  // (d) Main window is on a Worker Thread (away): SINGLE back button on board (card only, header hidden) + chat header
  const sOnWorker = ctx.computeCoordinatorUiState({
    coordConvId: 'conv-coord-1',
    hostConvId: 'conv-worker-1',
    manualPopoutConvId: '',
    threads: sampleThreads,
  });
  assert.equal(sOnWorker.isOnCoordinator, false);
  assert.equal(sOnWorker.away, true);
  assert.equal(sOnWorker.showHeaderCoordBtn, false, 'header back button must stay hidden to avoid duplicate');
  assert.equal(sOnWorker.showCardCoordBtn, true);
  assert.equal(sOnWorker.showChatCoordBtn, true);
  assert.equal(sOnWorker.goalCardClickable, true);
  assert.equal(sOnWorker.activeMainWorkerConvId, 'conv-worker-1');
  assert.equal(sOnWorker.highlightRebindBtn, false, 'worker thread must not highlight Switch to This');

  // (e) Main window is on a different non-worker conversation (away): single back button + gentle Switch-to-This highlight
  const sOnOther = ctx.computeCoordinatorUiState({
    coordConvId: 'conv-coord-1',
    hostConvId: 'conv-fresh-session',
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

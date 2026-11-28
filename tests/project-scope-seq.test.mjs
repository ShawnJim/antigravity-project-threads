import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  buildBoardDecisions,
  cleanupThreadWorktree,
  dismissDecision,
  dispatchThread,
  executeDecisionAction,
  formatLocalThreadId,
  getThreadDetail,
  getThreadMessages,
  listDecisions,
  loadRegistry,
  markThreadRead,
  normalizeKey,
  parseLocalThreadSeqRef,
  resolveScopedThreadTarget,
  saveRegistry,
  sendThreadMessage,
  syncThreads,
} from '../lib/store.mjs';

function createTempEnv(t, prefix = 'pt-scope-seq-') {
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

function startMockLs(t, { conversations = {}, generatorMetadata = {} } = {}) {
  const created = [];
  const getConvCalls = [];
  const genMetaCalls = [];
  const sendCalls = [];
  const updateCalls = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/product.v1.ConversationService/CreateConversation') {
        const id = `conv-mock-${created.length + 1}`;
        created.push({ id, payload });
        res.end(
          JSON.stringify({
            conversation: {
              id,
              state: { runState: 'RUN_STATE_RUNNING' },
            },
          }),
        );
        return;
      }

      if (req.url === '/product.v1.ConversationService/UpdateConversation') {
        updateCalls.push(payload);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.url === '/product.v1.ConversationService/GetConversation') {
        const cid = String(payload.conversationId || '');
        getConvCalls.push(cid);
        const found = conversations[cid];
        if (found) {
          res.end(JSON.stringify({ conversation: found }));
          return;
        }
        res.end(
          JSON.stringify({
            conversation: {
              id: cid,
              state: { runState: 'RUN_STATE_IDLE' },
            },
          }),
        );
        return;
      }

      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
        const cid = String(payload.cascadeId || '');
        genMetaCalls.push(cid);
        res.end(JSON.stringify({ generatorMetadata: generatorMetadata[cid] || [] }));
        return;
      }

      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
        res.end(JSON.stringify({ clientModelConfigs: [] }));
        return;
      }

      if (req.url === '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage') {
        sendCalls.push(payload);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.statusCode = 404;
      res.end('{}');
    });
  });

  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const address = `127.0.0.1:${port}`;
      process.env.ANTIGRAVITY_LS_ADDRESS = address;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-scope-seq';
      t.after(() => new Promise((r) => server.close(r)));
      resolveListen({
        address,
        csrfToken: 'csrf-scope-seq',
        created,
        getConvCalls,
        genMetaCalls,
        sendCalls,
        updateCalls,
      });
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
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Could not find closing brace for ${fnName}`);
}

test('Plan A: per-project independent continuous projectSeq/localId keeps global thr-xxx primary key intact and survives concurrent saveRegistry merges', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-seq-plan-a-');
  await startMockLs(t);

  const repoA = join(tempRoot, 'proj-alpha');
  const repoB = join(tempRoot, 'proj-beta');
  initGitRepo(repoA);
  initGitRepo(repoB);
  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);

  // Dispatch 2 threads in Project A
  const a1 = await dispatchThread({
    workspacePath: repoA,
    coordinatorId: 'coord-a',
    title: 'Alpha task 1',
    taskPrompt: 'Do task 1',
    createWorktree: true,
    model: 'pro',
  });
  const a2 = await dispatchThread({
    workspacePath: repoA,
    coordinatorId: 'coord-a',
    title: 'Alpha task 2',
    taskPrompt: 'Do task 2',
    createWorktree: false,
    model: 'pro',
  });

  // Capture a stale snapshot before Project B and Project A #3 are created
  const staleSnapshot = loadRegistry();

  // Dispatch 3 threads in Project B -> must start from #1 independently
  const b1 = await dispatchThread({
    workspacePath: repoB,
    coordinatorId: 'coord-b',
    title: 'Beta task 1',
    taskPrompt: 'Beta 1',
    createWorktree: false,
    model: 'pro',
  });
  const b2 = await dispatchThread({
    workspacePath: repoB,
    coordinatorId: 'coord-b',
    title: 'Beta task 2',
    taskPrompt: 'Beta 2',
    createWorktree: false,
    model: 'pro',
  });
  const b3 = await dispatchThread({
    workspacePath: repoB,
    coordinatorId: 'coord-b',
    title: 'Beta task 3',
    taskPrompt: 'Beta 3',
    createWorktree: false,
    model: 'pro',
  });

  // Return to Project A -> must continue smoothly at #3 (NO visual jump!), while global ID stays thr-006
  const a3 = await dispatchThread({
    workspacePath: repoA,
    coordinatorId: 'coord-a',
    title: 'Alpha task 3',
    taskPrompt: 'Do task 3',
    createWorktree: true,
    model: 'pro',
  });

  // Verify global primary keys & Git worktree/branch naming remain 100% backward compatible
  assert.equal(a1.threadId, 'thr-001');
  assert.equal(a1.projectSeq, 1);
  assert.equal(a1.localId, '#1');
  assert.match(a1.branch, /^thread\/thr-001-/);

  assert.equal(a2.threadId, 'thr-002');
  assert.equal(a2.projectSeq, 2);
  assert.equal(a2.localId, '#2');

  assert.equal(b1.threadId, 'thr-003');
  assert.equal(b1.projectSeq, 1);
  assert.equal(b1.localId, '#1');

  assert.equal(b2.threadId, 'thr-004');
  assert.equal(b2.projectSeq, 2);
  assert.equal(b2.localId, '#2');

  assert.equal(b3.threadId, 'thr-005');
  assert.equal(b3.projectSeq, 3);
  assert.equal(b3.localId, '#3');

  assert.equal(a3.threadId, 'thr-006');
  assert.equal(a3.projectSeq, 3);
  assert.equal(a3.localId, '#3');
  assert.match(a3.branch, /^thread\/thr-006-/);

  // Archiving #1 in Project A must NOT cause next Project A thread to reuse #1
  await archiveThread(a1.threadId, { workspacePath: repoA, removeWorktree: true, forceWorktree: true });
  const a4 = await dispatchThread({
    workspacePath: repoA,
    coordinatorId: 'coord-a',
    title: 'Alpha task 4',
    taskPrompt: 'Do task 4',
    createWorktree: false,
    model: 'pro',
  });
  assert.equal(a4.threadId, 'thr-007');
  assert.equal(a4.projectSeq, 4);
  assert.equal(a4.localId, '#4');

  // Stale concurrent saveRegistry() must preserve max projectSeqs and existing thread projectSeq/localId
  delete staleSnapshot.threads['thr-001'].projectSeq;
  delete staleSnapshot.threads['thr-001'].localId;
  saveRegistry(staleSnapshot);

  const afterMerge = loadRegistry();
  assert.equal(afterMerge.projectSeqs[keyA], 4);
  assert.equal(afterMerge.projectSeqs[keyB], 3);
  assert.equal(afterMerge.threads['thr-001'].projectSeq, 1);
  assert.equal(afterMerge.threads['thr-001'].localId, '#1');
  assert.equal(afterMerge.threads['thr-006'].projectSeq, 3);
  assert.equal(afterMerge.threads['thr-006'].localId, '#3');
  assert.equal(formatLocalThreadId(4), '#4');
  // P1-3: strictly require leading "#" for project-local sequence; bare numbers are NEVER parsed as local seq
  assert.equal(parseLocalThreadSeqRef('#1'), 1);
  assert.equal(parseLocalThreadSeqRef('#03'), 3);
  assert.equal(parseLocalThreadSeqRef('1'), 0);
  assert.equal(parseLocalThreadSeqRef('012'), 0);
  assert.equal(parseLocalThreadSeqRef('12'), 0);
  assert.equal(parseLocalThreadSeqRef('thr-003'), 0);
});

test('Legacy registry without projectSeq/projectSeqs computes stable per-project sequences and continues seamlessly for new threads', async (t) => {
  const { tempRoot, stateDir } = createTempEnv(t, 'pt-seq-legacy-');
  await startMockLs(t);

  const repoA = join(tempRoot, 'legacy-alpha');
  const repoB = join(tempRoot, 'legacy-beta');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);

  // Write a pre-Issue-#4 legacy registry.json (no projectSeqs, no projectSeq/localId on threads)
  writeFileSync(
    join(stateDir, 'registry.json'),
    JSON.stringify(
      {
        version: 1,
        seq: 12,
        coordinators: {
          [keyA]: {
            key: keyA,
            conversationId: 'coord-legacy-a',
            workspacePath: repoA,
            repoRoot: repoA,
            title: '[Coordinator] LegacyAlpha',
          },
          [keyB]: {
            key: keyB,
            conversationId: 'coord-legacy-b',
            workspacePath: repoB,
            repoRoot: repoB,
            title: '[Coordinator] LegacyBeta',
          },
        },
        threads: {
          'thr-005': {
            threadId: 'thr-005',
            conversationId: 'conv-leg-a1',
            coordinatorId: 'coord-legacy-a',
            workspaceKey: keyA,
            title: 'Legacy A first',
            archived: true,
            runState: 'RUN_STATE_IDLE',
            createdAt: '2026-11-01T10:00:00.000Z',
            updatedAt: '2026-11-01T10:10:00.000Z',
          },
          'thr-009': {
            threadId: 'thr-009',
            conversationId: 'conv-leg-b1',
            coordinatorId: 'coord-legacy-b',
            workspaceKey: keyB,
            title: 'Legacy B first',
            archived: false,
            runState: 'RUN_STATE_IDLE',
            createdAt: '2026-11-02T10:00:00.000Z',
            updatedAt: '2026-11-02T10:10:00.000Z',
          },
          'thr-012': {
            threadId: 'thr-012',
            conversationId: 'conv-leg-a2',
            coordinatorId: 'coord-legacy-a',
            workspaceKey: keyA,
            title: 'Legacy A second',
            archived: false,
            runState: 'RUN_STATE_IDLE',
            createdAt: '2026-11-03T10:00:00.000Z',
            updatedAt: '2026-11-03T10:10:00.000Z',
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  // syncThreads decorates legacy threads cleanly without breaking them
  const snapA = await syncThreads({ workspacePath: repoA, includeArchived: true });
  const legA1 = snapA.threads.find((x) => x.threadId === 'thr-005');
  const legA2 = snapA.threads.find((x) => x.threadId === 'thr-012');
  assert.equal(legA1?.projectSeq, 1);
  assert.equal(legA1?.localId, '#1');
  assert.equal(legA2?.projectSeq, 2);
  assert.equal(legA2?.localId, '#2');

  const snapB = await syncThreads({ workspacePath: repoB, includeArchived: true });
  const legB1 = snapB.threads.find((x) => x.threadId === 'thr-009');
  assert.equal(legB1?.projectSeq, 1);
  assert.equal(legB1?.localId, '#1');

  // Local sequence lookup resolves legacy thread cleanly within project scope
  const detailA2 = await getThreadDetail({ threadId: '#2', workspacePath: repoA });
  assert.equal(detailA2.threadId, 'thr-012');
  assert.equal(detailA2.projectSeq, 2);
  assert.equal(detailA2.localId, '#2');

  // Dispatching a new thread in LegacyAlpha continues at #3 (does NOT collide with legacy #1/#2)
  const nextA = await dispatchThread({
    workspacePath: repoA,
    coordinatorId: 'coord-legacy-a',
    title: 'New A third',
    taskPrompt: 'Continue sequence cleanly',
    createWorktree: false,
    model: 'pro',
  });
  assert.equal(nextA.threadId, 'thr-013');
  assert.equal(nextA.projectSeq, 3);
  assert.equal(nextA.localId, '#3');

  // Legacy #1 and #2 stay completely stable after #3 is created
  const afterA = await syncThreads({ workspacePath: repoA, includeArchived: true });
  assert.equal(afterA.threads.find((x) => x.threadId === 'thr-005')?.localId, '#1');
  assert.equal(afterA.threads.find((x) => x.threadId === 'thr-012')?.localId, '#2');
  assert.equal(afterA.threads.find((x) => x.threadId === 'thr-013')?.localId, '#3');
});

test('Phase 1: getThreadDetail refreshes ONLY the target thread and never triggers machine-wide syncThreads scan', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-detail-local-');
  const repoA = join(tempRoot, 'local-repo-a');
  const repoB = join(tempRoot, 'local-repo-b');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);

  const mockLs = await startMockLs(t, {
    conversations: {
      'conv-target-a1': {
        id: 'conv-target-a1',
        state: {
          runState: 'RUN_STATE_IDLE',
          summary: 'Target thread finished cleanly',
          updateTime: '2026-11-28T09:00:00.000Z',
        },
        annotations: { archived: false },
        metadata: { projectId: 'proj-a' },
      },
      'conv-sibling-a2': {
        id: 'conv-sibling-a2',
        state: { runState: 'RUN_STATE_RUNNING' },
      },
      'conv-other-b1': {
        id: 'conv-other-b1',
        state: { runState: 'RUN_STATE_RUNNING' },
      },
      'conv-other-b2': {
        id: 'conv-other-b2',
        state: { runState: 'RUN_STATE_IDLE' },
        annotations: { archived: true },
      },
    },
    generatorMetadata: {
      'conv-target-a1': [
        {
          stepIndices: [1],
          chatModel: {
            model: 'MODEL_PLACEHOLDER_M532',
            responseModel: 'gemini-4-neon-high',
            modelDisplayName: 'Gemini 4 Neon (High)',
          },
        },
      ],
    },
  });

  const reg = loadRegistry();
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'coord-local-a',
    projectId: 'proj-a',
    workspacePath: repoA,
    repoRoot: repoA,
    title: '[Coordinator] LocalA',
  };
  reg.coordinators[keyB] = {
    key: keyB,
    conversationId: 'coord-local-b',
    projectId: 'proj-b',
    workspacePath: repoB,
    repoRoot: repoB,
    title: '[Coordinator] LocalB',
  };
  reg.projectSeqs = { [keyA]: 2, [keyB]: 2 };
  reg.threads = {
    'thr-001': {
      threadId: 'thr-001',
      projectSeq: 1,
      localId: '#1',
      conversationId: 'conv-target-a1',
      coordinatorId: 'coord-local-a',
      workspaceKey: keyA,
      projectId: 'proj-a',
      title: 'Target A1',
      model: 'pro',
      runState: 'RUN_STATE_RUNNING',
      archived: false,
      createdAt: '2026-11-28T08:00:00.000Z',
      updatedAt: '2026-11-28T08:00:00.000Z',
    },
    'thr-002': {
      threadId: 'thr-002',
      projectSeq: 2,
      localId: '#2',
      conversationId: 'conv-sibling-a2',
      coordinatorId: 'coord-local-a',
      workspaceKey: keyA,
      projectId: 'proj-a',
      title: 'Sibling A2',
      model: 'pro',
      runState: 'RUN_STATE_RUNNING',
      archived: false,
      createdAt: '2026-11-28T08:01:00.000Z',
      updatedAt: '2026-11-28T08:01:00.000Z',
    },
    'thr-003': {
      threadId: 'thr-003',
      projectSeq: 1,
      localId: '#1',
      conversationId: 'conv-other-b1',
      coordinatorId: 'coord-local-b',
      workspaceKey: keyB,
      projectId: 'proj-b',
      title: 'Other B1',
      model: 'pro',
      runState: 'RUN_STATE_RUNNING',
      archived: false,
      createdAt: '2026-11-28T08:02:00.000Z',
      updatedAt: '2026-11-28T08:02:00.000Z',
    },
    'thr-004': {
      threadId: 'thr-004',
      projectSeq: 2,
      localId: '#2',
      conversationId: 'conv-other-b2',
      coordinatorId: 'coord-local-b',
      workspaceKey: keyB,
      projectId: 'proj-b',
      title: 'Other B2 Archived',
      model: 'pro',
      runState: 'RUN_STATE_IDLE',
      archived: true,
      createdAt: '2026-11-28T08:03:00.000Z',
      updatedAt: '2026-11-28T08:03:00.000Z',
    },
  };
  saveRegistry(reg);

  // 1. Cross-project detail request fails closed BEFORE touching LS at all
  await assert.rejects(
    () => getThreadDetail({ threadId: 'thr-001', workspacePath: repoB }),
    /Cross-project access denied/,
  );
  assert.deepEqual(mockLs.getConvCalls, [], 'cross-project rejection must trigger zero LS GetConversation calls');
  assert.deepEqual(mockLs.genMetaCalls, [], 'cross-project rejection must trigger zero LS generator metadata calls');

  // 2. Scoped detail request for thr-001 refreshes ONLY conv-target-a1
  const detail = await getThreadDetail({ threadId: 'thr-001', workspacePath: repoA });
  assert.equal(detail.threadId, 'thr-001');
  assert.equal(detail.projectSeq, 1);
  assert.equal(detail.localId, '#1');
  assert.equal(detail.runState, 'RUN_STATE_IDLE');
  assert.equal(detail.lastSummary, 'Target thread finished cleanly');
  assert.equal(detail.modelDisplayName, 'Gemini 4 Neon (High)');

  assert.deepEqual(mockLs.getConvCalls, ['conv-target-a1'], 'must only query GetConversation for the target thread');
  assert.deepEqual(mockLs.genMetaCalls, ['conv-target-a1'], 'must only query generator metadata for the target thread');
});

test('Phase 1 & Plan A: single-thread store APIs enforce fail-closed cross-project isolation and scoped #N lookup', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-scope-guard-');
  const mockLs = await startMockLs(t);

  const repoA = join(tempRoot, 'guard-alpha');
  const repoB = join(tempRoot, 'guard-beta');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);

  const reg = loadRegistry();
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'coord-guard-a',
    projectId: 'proj-guard-a',
    workspacePath: repoA,
    repoRoot: repoA,
    title: '[Coordinator] GuardA',
  };
  reg.coordinators[keyB] = {
    key: keyB,
    conversationId: 'coord-guard-b',
    projectId: 'proj-guard-b',
    workspacePath: repoB,
    repoRoot: repoB,
    title: '[Coordinator] GuardB',
  };
  reg.projectSeqs = { [keyA]: 2, [keyB]: 1 };
  reg.threads = {
    'thr-001': {
      threadId: 'thr-001',
      projectSeq: 1,
      localId: '#1',
      conversationId: 'conv-guard-a1',
      coordinatorId: 'coord-guard-a',
      workspaceKey: keyA,
      projectId: 'proj-guard-a',
      title: 'Guard A1',
      worktreePath: '',
      archived: false,
      runState: 'RUN_STATE_IDLE',
      createdAt: '2026-11-28T07:00:00.000Z',
    },
    'thr-002': {
      threadId: 'thr-002',
      projectSeq: 2,
      localId: '#2',
      conversationId: 'conv-guard-a2',
      coordinatorId: 'coord-guard-a',
      workspaceKey: keyA,
      projectId: 'proj-guard-a',
      title: 'Guard A2',
      worktreePath: '',
      archived: false,
      runState: 'RUN_STATE_IDLE',
      createdAt: '2026-11-28T07:01:00.000Z',
    },
    'thr-003': {
      threadId: 'thr-003',
      projectSeq: 1,
      localId: '#1',
      conversationId: 'conv-guard-b1',
      coordinatorId: 'coord-guard-b',
      workspaceKey: keyB,
      projectId: 'proj-guard-b',
      title: 'Guard B1',
      worktreePath: '',
      archived: false,
      runState: 'RUN_STATE_IDLE',
      createdAt: '2026-11-28T07:02:00.000Z',
    },
  };
  saveRegistry(reg);

  // Cross-project rejections across workspacePath, coordinatorId, projectId, conversationId, and conflicting projectId
  await assert.rejects(
    () => sendThreadMessage({ threadId: 'thr-001', message: 'hi', workspacePath: repoB }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () => sendThreadMessage({ threadId: 'thr-001', message: 'hi', coordinatorId: 'coord-guard-b' }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () => sendThreadMessage({ threadId: 'thr-001', message: 'hi', projectId: 'proj-guard-b' }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () => sendThreadMessage({ threadId: 'thr-001', message: 'hi', conversationId: 'conv-guard-b1' }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () =>
      sendThreadMessage({
        threadId: 'thr-001',
        message: 'hi',
        workspacePath: repoA,
        projectId: 'proj-guard-b',
      }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () => archiveThread('thr-001', { workspacePath: repoB }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () => cleanupThreadWorktree('thr-001', { coordinatorId: 'coord-guard-b' }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () => getThreadMessages({ threadId: 'thr-001', workspacePath: repoB }),
    /Cross-project access denied/,
  );
  assert.equal(mockLs.sendCalls.length, 0, 'blocked sendThreadMessage must not invoke LS');
  assert.equal(loadRegistry().threads['thr-001'].archived, false, 'blocked archiveThread must not archive');

  // Local sequence lookup without scope fails closed
  await assert.rejects(
    () => resolveScopedThreadTarget({ threadId: '#1' }),
    /Project scope.*required/i,
  );
  // P1-3: bare numeric strings ("1", "012") are NEVER resolved as project-local sequence
  await assert.rejects(
    () => getThreadDetail({ threadId: '1', workspacePath: repoA }),
    /Thread not found: 1/,
  );
  await assert.rejects(
    () => archiveThread('012', { workspacePath: repoA }),
    /Thread not found: 012/,
  );
  // P1-1 & P2: requireScope=true rejects unscoped calls; "outside-of-project" alone never bypasses fail-closed
  await assert.rejects(
    () => resolveScopedThreadTarget({ threadId: 'thr-001', requireScope: true }),
    /Project scope is required \(fail-closed\)/,
  );
  await assert.rejects(
    () => resolveScopedThreadTarget({ threadId: 'thr-001', projectId: 'outside-of-project' }),
    /Unable to resolve project scope.*fail-closed/,
  );

  // Local sequence #1 resolves independently per project
  const targetA1 = await resolveScopedThreadTarget({ threadId: '#1', workspacePath: repoA });
  const targetB1 = await resolveScopedThreadTarget({ threadId: '#1', coordinatorId: 'coord-guard-b' });
  assert.equal(targetA1.thread.threadId, 'thr-001');
  assert.equal(targetB1.thread.threadId, 'thr-003');

  // Out-of-range local sequence in Project B does NOT bleed into Project A's #2
  await assert.rejects(
    () => resolveScopedThreadTarget({ threadId: '#2', workspacePath: repoB }),
    /Thread not found in project scope/,
  );

  // P1-2: Decision board blocks cross-project thread association AND cross-project archive_thread actions
  assert.throws(
    () =>
      addDecision({
        workspacePath: repoB,
        threadId: 'thr-001',
        title: 'Cross-project decision attempt',
      }),
    /Cross-project access denied/,
  );
  assert.throws(
    () =>
      addDecision({
        workspacePath: repoB,
        threadId: '#2',
        title: 'Out-of-range local seq in decision',
      }),
    /Thread not found in project scope/,
  );

  const decA1 = addDecision({
    workspacePath: repoA,
    threadId: '#1',
    title: 'Confirm Alpha #1',
    options: [{ id: 'arch', label: 'Archive', action: 'archive_thread', style: 'primary' }],
  });
  assert.equal(decA1.threadId, 'thr-001');
  const decList = listDecisions({ workspacePath: repoA });
  assert.equal(decList[0]?.threadLocalId, '#1');
  assert.equal(decList[0]?.threadProjectSeq, 1);
  const boardDecs = buildBoardDecisions({ workspacePath: repoA });
  assert.equal(boardDecs[0]?.threadLocalId, '#1');

  // Executing Alpha decision from Beta scope (or direct archive_thread action for Alpha thread from Beta scope) must fail closed
  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: decA1.id,
        optionId: 'arch',
        action: 'archive_thread',
        workspacePath: repoB,
      }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () =>
      executeDecisionAction({
        action: 'archive_thread',
        threadId: 'thr-001',
        workspacePath: repoB,
      }),
    /Cross-project access denied/,
  );
  assert.equal(loadRegistry().threads['thr-001'].archived, false, 'cross-project decision archive must not archive thr-001');
  assert.equal(listDecisions({ workspacePath: repoA }).length, 1, 'blocked decision must remain pending');

  // Same-project send & archive via local sequence succeed
  const sendOk = await sendThreadMessage({
    threadId: '#2',
    message: 'Follow-up via local seq',
    workspacePath: repoA,
  });
  assert.equal(sendOk.ok, true);
  assert.equal(sendOk.thread.threadId, 'thr-002');
  assert.equal(sendOk.thread.localId, '#2');
  assert.equal(mockLs.sendCalls.length, 1);

  const archOk = await archiveThread('#1', { coordinatorId: 'coord-guard-b' });
  assert.equal(archOk.ok, true);
  assert.equal(archOk.threadId, 'thr-003');
  assert.equal(archOk.localId, '#1');
  assert.equal(loadRegistry().threads['thr-003'].archived, true);

  // Direct store API without requireScope stays backward compatible for global threadId
  const unscopedDetail = await getThreadDetail('thr-001');
  assert.equal(unscopedDetail.threadId, 'thr-001');
  assert.equal(unscopedDetail.localId, '#1');
});

function runMcpStdio(repoRoot, env, requests) {
  return new Promise((resolveProc, rejectProc) => {
    const child = spawn(process.execPath, ['mcp/server.mjs'], {
      cwd: repoRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', rejectProc);
    child.on('close', (status) => {
      resolveProc({ status, stdout, stderr });
    });
    child.stdin.end(`${requests.map((r) => JSON.stringify(r)).join('\n')}\n`);
  });
}

test('MCP stdio server: schema scope params, fail-closed cross-project rejection, localized get_thread_detail, and #N display', async (t) => {
  const { tempRoot, geminiDir, appDataDir } = createTempEnv(t, 'pt-mcp-scope-');
  const repoA = join(tempRoot, 'mcp-alpha');
  const repoB = join(tempRoot, 'mcp-beta');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);

  const mockLs = await startMockLs(t, {
    conversations: {
      'conv-mcp-a1': {
        id: 'conv-mcp-a1',
        state: { runState: 'RUN_STATE_IDLE', summary: 'MCP A1 summary' },
        annotations: { archived: false },
      },
      'conv-mcp-b1': {
        id: 'conv-mcp-b1',
        state: { runState: 'RUN_STATE_RUNNING' },
        annotations: { archived: false },
      },
    },
  });

  const reg = loadRegistry();
  reg.seq = 5;
  reg.projectSeqs = { [keyA]: 1, [keyB]: 1 };
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'coord-mcp-a',
    projectId: 'proj-mcp-a',
    workspacePath: repoA,
    repoRoot: repoA,
    title: '[Coordinator] McpAlpha',
  };
  reg.coordinators[keyB] = {
    key: keyB,
    conversationId: 'coord-mcp-b',
    projectId: 'proj-mcp-b',
    workspacePath: repoB,
    repoRoot: repoB,
    title: '[Coordinator] McpBeta',
  };
  reg.threads = {
    'thr-004': {
      threadId: 'thr-004',
      projectSeq: 1,
      localId: '#1',
      conversationId: 'conv-mcp-a1',
      coordinatorId: 'coord-mcp-a',
      workspaceKey: keyA,
      projectId: 'proj-mcp-a',
      title: 'Alpha First',
      model: 'pro',
      runState: 'RUN_STATE_IDLE',
      archived: false,
      createdAt: '2026-11-28T06:00:00.000Z',
      updatedAt: '2026-11-28T06:00:00.000Z',
    },
    'thr-005': {
      threadId: 'thr-005',
      projectSeq: 1,
      localId: '#1',
      conversationId: 'conv-mcp-b1',
      coordinatorId: 'coord-mcp-b',
      workspaceKey: keyB,
      projectId: 'proj-mcp-b',
      title: 'Beta First',
      model: 'pro',
      runState: 'RUN_STATE_RUNNING',
      archived: false,
      createdAt: '2026-11-28T06:01:00.000Z',
      updatedAt: '2026-11-28T06:01:00.000Z',
    },
  };
  saveRegistry(reg);

  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    // Cross-project get_thread_detail -> must fail closed without touching LS
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'get_thread_detail',
        arguments: { threadId: 'thr-004', workspacePath: repoB },
      },
    },
    // Cross-project send_thread_message -> must fail closed
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'send_thread_message',
        arguments: { threadId: 'thr-004', message: 'should fail', coordinatorId: 'coord-mcp-b' },
      },
    },
    // Cross-project archive_thread -> must fail closed
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'archive_thread',
        arguments: { threadId: 'thr-004', projectId: 'proj-mcp-b' },
      },
    },
    // Same-project get_thread_detail by #1 -> localized refresh ONLY on conv-mcp-a1
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'get_thread_detail',
        arguments: { threadId: '#1', workspacePath: repoA },
      },
    },
    // list_threads displays `#1` (`thr-004`)
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'list_threads',
        arguments: { workspacePath: repoA },
      },
    },
    // send_thread_message by #1 with scope succeeds
    {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'send_thread_message',
        arguments: { threadId: '#1', message: 'ping alpha', workspacePath: repoA },
      },
    },
    // archive_thread by #1 with scope succeeds and formats `#1` (`thr-004`)
    {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'archive_thread',
        arguments: { threadId: '#1', workspacePath: repoA },
      },
    },
    // P1-1: Unscoped single-thread MCP calls MUST fail closed by default
    {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'get_thread_detail',
        arguments: { threadId: 'thr-005' },
      },
    },
    {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: {
        name: 'send_thread_message',
        arguments: { threadId: 'thr-005', message: 'unscoped must fail' },
      },
    },
    {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: {
        name: 'archive_thread',
        arguments: { threadId: 'thr-005' },
      },
    },
    // P1-1: Explicit scope="*" opt-out permits unscoped global threadId lookup, but STILL blocks "#1"
    {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: {
        name: 'get_thread_detail',
        arguments: { threadId: 'thr-005', scope: '*' },
      },
    },
    {
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: {
        name: 'get_thread_detail',
        arguments: { threadId: '#1', scope: '*' },
      },
    },
    // P1-3: Bare numeric "1" with scope must NOT match #1
    {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: {
        name: 'get_thread_detail',
        arguments: { threadId: '1', workspacePath: repoA },
      },
    },
  ];

  const proc = await runMcpStdio(
    repoRoot,
    {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_APP_DATA_DIR: appDataDir,
      ANTIGRAVITY_LS_ADDRESS: mockLs.address,
      ANTIGRAVITY_CSRF_TOKEN: mockLs.csrfToken,
    },
    requests,
  );

  assert.equal(proc.status, 0, proc.stderr);
  const msgs = proc.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));

  const tools = msgs.find((m) => m.id === 2)?.result?.tools || [];
  for (const toolName of ['get_thread_detail', 'send_thread_message', 'archive_thread']) {
    const tool = tools.find((x) => x.name === toolName);
    assert.ok(tool, `${toolName} must be registered`);
    for (const prop of ['workspacePath', 'coordinatorId', 'conversationId', 'projectId', 'scope']) {
      assert.ok(tool.inputSchema?.properties?.[prop], `${toolName} schema must accept ${prop}`);
    }
  }

  for (const errId of [3, 4, 5]) {
    const r = msgs.find((m) => m.id === errId)?.result;
    assert.equal(r?.isError, true, `request #${errId} must fail closed`);
    assert.match(r?.content?.[0]?.text || '', /Cross-project access denied/);
  }

  const detailRes = msgs.find((m) => m.id === 6)?.result;
  assert.equal(detailRes?.isError, undefined);
  assert.equal(detailRes?.structuredContent?.threadId, 'thr-004');
  assert.equal(detailRes?.structuredContent?.projectSeq, 1);
  assert.equal(detailRes?.structuredContent?.localId, '#1');

  // Verify conv-mcp-a1 WAS refreshed locally; conv-mcp-b1 is only refreshed once (by explicit scope="*" in #13)
  assert.equal(
    mockLs.getConvCalls.includes('conv-mcp-a1'),
    true,
    'target thread must be refreshed locally via Mock LS',
  );
  assert.equal(
    mockLs.getConvCalls.filter((id) => id === 'conv-mcp-b1').length,
    1,
    'conv-mcp-b1 must only be queried by explicit scope="*" request #13, never by #6/#7/#10/#11/#12',
  );

  const listRes = msgs.find((m) => m.id === 7)?.result;
  const listText = listRes?.content?.[0]?.text || '';
  assert.match(listText, /`#1` \(`thr-004`\)/);
  assert.equal(listText.includes('·'), false, 'MCP thread list output must not use middle dot');

  const sendRes = msgs.find((m) => m.id === 8)?.result;
  assert.equal(sendRes?.isError, undefined);
  assert.match(sendRes?.content?.[0]?.text || '', /`#1`.*`thr-004`/);

  const archRes = msgs.find((m) => m.id === 9)?.result;
  assert.equal(archRes?.isError, undefined);
  assert.match(archRes?.content?.[0]?.text || '', /`#1` \(`thr-004`\)/);
  assert.equal(loadRegistry().threads['thr-004'].archived, true);
  assert.equal(loadRegistry().threads['thr-005'].archived, false);

  // Verify P1-1 unscoped MCP calls fail closed
  for (const errId of [10, 11, 12]) {
    const r = msgs.find((m) => m.id === errId)?.result;
    assert.equal(r?.isError, true, `unscoped request #${errId} must fail closed`);
    assert.match(r?.content?.[0]?.text || '', /Project scope is required \(fail-closed\)/);
  }
  assert.equal(loadRegistry().threads['thr-005'].archived, false, 'unscoped archive_thread must not archive thr-005');

  // Verify explicit scope="*" allows global thr-005 lookup, but blocks "#1"
  const optOutGlobal = msgs.find((m) => m.id === 13)?.result;
  assert.equal(optOutGlobal?.isError, undefined);
  assert.equal(optOutGlobal?.structuredContent?.threadId, 'thr-005');

  const optOutLocal = msgs.find((m) => m.id === 14)?.result;
  assert.equal(optOutLocal?.isError, true);
  assert.match(optOutLocal?.content?.[0]?.text || '', /Project scope.*required/i);

  // Verify P1-3 bare number "1" is not treated as #1
  const bareNumRes = msgs.find((m) => m.id === 15)?.result;
  assert.equal(bareNumRes?.isError, true);
  assert.match(bareNumRes?.content?.[0]?.text || '', /Thread not found: 1/);
});

test('Opus P1-1/P1-4/P1-5 regressions: DIRECTIVE_VERSION=16 enforces scope params, syncThreads reads fresh registry for decisions (no flicker), and single-thread writes avoid stale full-table overwrites', async (t) => {
  // 1. P1-1: DIRECTIVE_VERSION=16 + SKILL.md + rules/AGENTS.md enforce passing coordinatorId & workspacePath
  const hookHandler = readFileSync(new URL('../scripts/hook-handler.mjs', import.meta.url), 'utf8');
  const skillMd = readFileSync(new URL('../skills/coord/SKILL.md', import.meta.url), 'utf8');
  const rulesMd = readFileSync(new URL('../rules/AGENTS.md', import.meta.url), 'utf8');
  assert.match(hookHandler, /const\s+DIRECTIVE_VERSION\s*=\s*16\s*;/);
  assert.match(skillMd, /get_thread_detail.*send_thread_message.*archive_thread/i);
  assert.match(skillMd, /coordinatorId.*workspacePath/i);
  assert.match(rulesMd, /Single-Thread Scope Isolation/i);
  assert.match(rulesMd, /get_thread_detail.*send_thread_message.*archive_thread/);

  const env = createTempEnv(t, 'pt-opus-p1-');
  const repoA = join(env.tempRoot, 'fresh-reg-repo');
  mkdirSync(repoA, { recursive: true });
  const keyA = normalizeKey(repoA);

  const reg = loadRegistry();
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'coord-v14-test',
    workspacePath: repoA,
    repoRoot: repoA,
    title: '[Coordinator] FreshReg',
    directiveVersion: 15,
  };
  reg.projectSeqs = { [keyA]: 2 };
  reg.threads = {
    'thr-001': {
      threadId: 'thr-001',
      projectSeq: 1,
      localId: '#1',
      conversationId: 'conv-fresh-1',
      coordinatorId: 'coord-v14-test',
      workspaceKey: keyA,
      title: 'Thread 1',
      runState: 'RUN_STATE_IDLE',
      bucket: 'waiting',
      lastCompletedAt: '2026-11-28T08:00:00.000Z',
      archived: false,
      createdAt: '2026-11-28T07:00:00.000Z',
      updatedAt: '2026-11-28T08:00:00.000Z',
    },
    'thr-002': {
      threadId: 'thr-002',
      projectSeq: 2,
      localId: '#2',
      conversationId: 'conv-fresh-2',
      coordinatorId: 'coord-v14-test',
      workspaceKey: keyA,
      title: 'Thread 2',
      runState: 'RUN_STATE_IDLE',
      bucket: 'idle',
      archived: false,
      createdAt: '2026-11-28T07:01:00.000Z',
      updatedAt: '2026-11-28T08:01:00.000Z',
    },
  };
  saveRegistry(reg);

  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const hookProc = spawnSync(process.execPath, ['scripts/hook-handler.mjs', 'PreInvocation'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: env.geminiDir,
      ANTIGRAVITY_APP_DATA_DIR: env.appDataDir,
    },
    input: JSON.stringify({
      hookEventName: 'PreInvocation',
      conversationId: 'coord-v14-test',
      initialNumSteps: 5,
    }),
    encoding: 'utf8',
  });
  assert.equal(hookProc.status, 0);
  const hookOut = JSON.parse(hookProc.stdout.trim());
  const injected = hookOut?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
  assert.match(injected, /`get_thread_detail`, `send_thread_message`, or `archive_thread`.*ALWAYS pass `coordinatorId:/);
  assert.equal(loadRegistry().coordinators[keyA].directiveVersion, 16);

  // 2. P1-4: Decision dismissed mid-syncThreads (when dirty===false) must NOT flicker back in snapshot
  const dec = addDecision({ workspacePath: repoA, threadId: 'thr-001', title: 'Flicker test decision' });
  let dismissedDuringSync = false;
  let concurrentSiblingUpdated = false;

  const customServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/product.v1.ConversationService/GetConversation') {
        if (!dismissedDuringSync && payload.conversationId === 'conv-fresh-1') {
          dismissedDuringSync = true;
          dismissDecision(dec.id);
        }
        if (payload.conversationId === 'conv-fresh-1' && !concurrentSiblingUpdated) {
          concurrentSiblingUpdated = true;
          const r = loadRegistry();
          r.threads['thr-002'].title = 'Concurrently Updated Sibling';
          saveRegistry(r);
        }
        res.end(
          JSON.stringify({
            conversation: {
              id: payload.conversationId,
              state: { runState: 'RUN_STATE_IDLE' },
              annotations: { archived: false },
            },
          }),
        );
        return;
      }
      if (req.url === '/product.v1.ConversationService/UpdateConversation') {
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
  });

  await new Promise((r) => customServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => customServer.close(r)));
  process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${customServer.address().port}`;
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-fresh-reg';

  const snap = await syncThreads({ workspacePath: repoA });
  assert.equal(dismissedDuringSync, true);
  assert.equal(
    snap.decisions.some((d) => d.id === dec.id),
    false,
    'P1-4: dismissed decision must not reappear in syncThreads snapshot even when thread list was clean',
  );

  // 3. P1-5: markThreadRead and archiveThread use mutateRegistry and never revert concurrent updates to sibling threads
  const markRes = await markThreadRead({ threadId: 'thr-001', workspacePath: repoA });
  assert.equal(markRes.ok, true);
  assert.equal(markRes.thread.localId, '#1');
  assert.equal(
    loadRegistry().threads['thr-002'].title,
    'Concurrently Updated Sibling',
    'P1-5: markThreadRead must not overwrite concurrent sibling thread edits',
  );

  const archRes = await archiveThread('thr-001', { workspacePath: repoA, removeWorktree: false });
  assert.equal(archRes.ok, true);
  assert.equal(archRes.thread.archived, true);
  assert.equal(archRes.thread.localId, '#1');
  assert.equal(
    loadRegistry().threads['thr-002'].title,
    'Concurrently Updated Sibling',
    'P1-5: archiveThread must not overwrite concurrent sibling thread edits',
  );
});

test('Sidecar UI & backend static assertions: project-local #N display with thr-xxx tooltip, no middle dot, no native dialogs, and LF endings', () => {
  const appSource = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const cssSource = readFileSync(new URL('../sidecars/threads/theme.css', import.meta.url), 'utf8');
  const mainSource = readFileSync(new URL('../sidecars/threads/main.mjs', import.meta.url), 'utf8');

  // Zero native dialogs
  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appSource), false);
  // CSS has .o2-tid styling and .o2-time uses defined --pt-dim token (not undefined --pt-muted)
  assert.match(cssSource, /\.o2-tid\s*\{/);
  assert.match(cssSource, /\.o2-time\s*\{\s*color:\s*var\(--pt-dim\);/);
  assert.equal(cssSource.includes('--pt-muted'), false, 'must not reference undefined --pt-muted CSS token');
  // Sidecar app.js forwards scope via buildScopePayload on all single-thread calls
  assert.match(appSource, /postApi\(\s*['"]\/api\/archive['"],[\s\S]{0,60}buildScopePayload\(/);
  assert.match(appSource, /postApi\(\s*['"]\/api\/cleanup_worktree['"],[\s\S]{0,80}buildScopePayload\(/);
  assert.match(appSource, /postApi\(\s*['"]\/api\/thread_mark_read['"],[\s\S]{0,80}buildScopePayload\(/);
  assert.match(appSource, /buildScopePayload\(\{\s*threadId:\s*openThreadId/);
  assert.match(appSource, /const sendPayload = buildScopePayload\(\{\s*threadId:\s*targetThreadId/);
  // Sidecar main.mjs forwards scope parameters on single-thread routes
  assert.match(mainSource, /\/api\/thread_messages[\s\S]*workspacePath:/);
  assert.match(mainSource, /handleThreadSend[\s\S]*workspacePath:/);
  assert.match(mainSource, /handleArchive[\s\S]*workspacePath:/);

  const i18nStart = appSource.indexOf('const I18N = {');
  let depth = 0;
  let inBrace = false;
  let i18nEnd = -1;
  for (let i = i18nStart; i < appSource.length; i++) {
    if (appSource[i] === '{') {
      depth++;
      inBrace = true;
    } else if (appSource[i] === '}') {
      depth--;
      if (inBrace && depth === 0) {
        i18nEnd = i + 1;
        break;
      }
    }
  }
  const i18nCode = appSource.slice(i18nStart, i18nEnd);

  const renderSwarmRowSrc = extractFunctionSource(appSource, 'renderSwarmRow');
  const renderO2CardSrc = extractFunctionSource(appSource, 'renderO2ThreadCard');
  const renderDecisionsSrc = extractFunctionSource(appSource, 'renderDecisionsPanelHtml');
  const getLocalizedDecSrc = extractFunctionSource(appSource, 'getLocalizedDecisionDisplay');
  const renderWtCardSrc = extractFunctionSource(appSource, 'renderWorktreeCard');
  const renderThreadHdrSrc = extractFunctionSource(appSource, 'renderThreadHeader');

  const headerEls = {
    'chat-tid': { textContent: '', title: '', dataset: {} },
    'chat-title-text': { textContent: '', title: '' },
    'chat-status-dot': { className: '' },
    'btn-archive-cur': { hidden: false },
    'btn-clean-wt-cur': { hidden: false, textContent: '', title: '' },
    'composer-meta': { innerHTML: '', dataset: {} },
  };

  const ctx = {};
  vm.runInNewContext(
    `
    ${i18nCode};
    let curLocale = 'zh-CN';
    const L = () => I18N[curLocale] || I18N.en;
    const ICONS = {
      chevronDown: '<svg></svg>',
      chevronRight: '<svg></svg>',
      close: '<svg></svg>',
      check: '<svg></svg>',
      doneCheck: '<svg></svg>',
      archCheck: '<svg></svg>',
      rowSpinner: '<svg></svg>',
      waitAlert: '!',
      branch: '<svg></svg>',
      folder: '<svg></svg>',
      popout: '<svg></svg>',
      plus: '+',
    };
    const pendingDecisionIds = new Set();
    const pendingModelByThread = new Map();
    let openThreadObj = null;
    let modelMenuOpen = false;
    const elLiveBar = { hidden: false };
    const document = { getElementById: (id) => headerEls[id] || null };
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const isThreadCardOpen = () => false;
    const getActiveMainWorkerConvId = () => '';
    const relTime = () => '3m';
    const renderSegmentedMbar = () => '<span class="o2-mbar"></span>';
    const cleanGoalSnippet = (th) => th.lastSummary || '';
    const computeInlineSubtitle = () => 'Ready';
    const formatModelDisplay = (m) => m || 'Gemini Pro';
    const renderThreadUsageRow = () => '';
    const updateCoordinatorControls = () => {};
    const syncSendButtonState = () => {};
    const renderModelMenu = () => {};
    ${renderSwarmRowSrc}
    ${getLocalizedDecSrc}
    ${renderDecisionsSrc}
    ${renderO2CardSrc}
    ${renderWtCardSrc}
    ${renderThreadHdrSrc}
    this.renderSwarmRow = renderSwarmRow;
    this.renderO2ThreadCard = renderO2ThreadCard;
    this.renderDecisionsPanelHtml = renderDecisionsPanelHtml;
    this.renderWorktreeCard = renderWorktreeCard;
    this.renderThreadHeader = renderThreadHeader;
    `,
    Object.assign(ctx, { headerEls }),
  );

  const sampleThread = {
    threadId: 'thr-037',
    projectSeq: 3,
    localId: '#3',
    conversationId: 'conv-ui-37',
    title: '实现按项目独立序号',
    bucket: 'idle',
    runState: 'RUN_STATE_IDLE',
    branch: 'thread/thr-037-seq',
    worktreePath: 'C:/worktrees/demo/thr-037-seq',
    updatedAt: '2026-11-28T09:00:00.000Z',
  };

  // 1. Swarm row shows #3 visually, preserves data-tid="thr-037" and tooltip "#3 (thr-037)"
  const rowHtml = ctx.renderSwarmRow(sampleThread);
  assert.match(rowHtml, /data-tid="thr-037"/);
  assert.match(rowHtml, /<span class="tid-pill" title="#3 \(thr-037\)" data-thread-id="thr-037">#3<\/span>/);

  // 2. O2 thread card shows #3 without middle dot separator, even with or without stepsProgress
  const cardNoSteps = ctx.renderO2ThreadCard(sampleThread);
  assert.match(cardNoSteps, /data-th-card="thr-037"/);
  assert.match(cardNoSteps, /<span class="o2-tid" title="#3 \(thr-037\)" data-thread-id="thr-037">#3<\/span>/);
  assert.equal(cardNoSteps.includes('·'), false, 'O2 thread card must not use middle dot separator');

  const cardWithSteps = ctx.renderO2ThreadCard({
    ...sampleThread,
    stepsProgress: { done: 2, total: 5 },
  });
  assert.match(cardWithSteps, /<span class="o2-tid" title="#3 \(thr-037\)" data-thread-id="thr-037">#3<\/span>/);

  // 3. Legacy thread without localId falls back cleanly to thr-037
  const legacyCard = ctx.renderO2ThreadCard({
    threadId: 'thr-037',
    title: 'Legacy Card',
    bucket: 'idle',
  });
  assert.match(legacyCard, /<span class="o2-tid" title="thr-037" data-thread-id="thr-037">thr-037<\/span>/);

  // 4. Decision panel badge shows #3 while data-dec-thread stays internal thr-037
  const decHtml = ctx.renderDecisionsPanelHtml([
    {
      id: 'dec-001',
      source: 'explicit',
      threadId: 'thr-037',
      threadProjectSeq: 3,
      threadLocalId: '#3',
      title: '确认合入？',
      options: [{ id: 'ok', label: '确认', action: 'send_coordinator', style: 'primary' }],
    },
  ]);
  assert.match(decHtml, /data-dec-thread="thr-037"/);
  assert.match(decHtml, />#3<\/button>/);
  assert.match(decHtml, /\(thr-037\)/);

  // 5. Worktree card displays #3 badge
  const wtHtml = ctx.renderWorktreeCard(sampleThread);
  assert.match(wtHtml, /<span class="tid-pill" title="#3 \(thr-037\)" data-thread-id="thr-037">#3<\/span>/);

  // 6. Thread detail header displays "#3 (thr-037)"
  ctx.renderThreadHeader(sampleThread);
  assert.equal(headerEls['chat-tid'].textContent, '#3 (thr-037)');
  assert.equal(headerEls['chat-tid'].dataset.threadId, 'thr-037');

  // 7. LF line endings check on all modified/added .mjs files
  for (const rel of [
    '../lib/store.mjs',
    '../mcp/server.mjs',
    '../scripts/hook-handler.mjs',
    '../sidecars/threads/main.mjs',
    '../tests/project-scope-seq.test.mjs',
    '../tests/decisions-board.test.mjs',
    '../tests/settings-default-model.test.mjs',
    '../tests/worker-language.test.mjs',
  ]) {
    const raw = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!raw.includes(Buffer.from('\r')), `${rel} must use LF line endings`);
  }
});

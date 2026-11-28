import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { resetLsEndpointCache, resetModelConfigCache } from '../lib/ls-client.mjs';
import {
  archiveThread,
  getStorePerfCounters,
  getThreadMessages,
  inspectWorktreeGit,
  loadRegistry,
  normalizeKey,
  resetRepoInfoCache,
  resetStorePerfCaches,
  resolveRepoInfo,
  resolveScopedThreadTarget,
  resolveThreadModelInfo,
  saveRegistry,
  sendThreadMessage,
  syncThreads,
} from '../lib/store.mjs';
import {
  extractTranscriptModel,
  getTranscriptCacheStats,
  loadTranscriptSteps,
  parseThreadTranscript,
  peekLiveActivity,
  resetTranscriptCaches,
  TRANSCRIPT_CACHE_MAX_ENTRIES,
} from '../lib/transcript.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function createTempEnv(t, prefix = 'pt-perf14-') {
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
  resetStorePerfCaches();
  resetTranscriptCaches();

  t.after(() => {
    resetLsEndpointCache();
    resetModelConfigCache();
    resetStorePerfCaches();
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

function initGitRepo(repoDir, initialBranch = 'main') {
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', initialBranch], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), '# Demo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });
}

function writeTranscriptPair(appDataDir, convId, compactSteps, fullSteps = null) {
  const txDir = join(appDataDir, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(txDir, { recursive: true });
  const txPath = join(txDir, 'transcript.jsonl');
  writeFileSync(txPath, `${compactSteps.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');
  let fullPath = '';
  if (Array.isArray(fullSteps)) {
    fullPath = join(txDir, 'transcript_full.jsonl');
    writeFileSync(fullPath, `${fullSteps.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');
  }
  return { txPath, fullPath };
}

function startMockLs(t, { delayMs = 0, runStates = {}, models = {} } = {}) {
  const getConvCalls = new Map();
  const genMetaCalls = new Map();
  const updateConvCalls = [];
  const sendMsgCalls = [];
  let totalGetConv = 0;
  let totalGenMeta = 0;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      const respond = () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/product.v1.ConversationService/GetConversation') {
          const cid = String(payload.conversationId || '');
          totalGetConv += 1;
          getConvCalls.set(cid, (getConvCalls.get(cid) || 0) + 1);
          res.end(
            JSON.stringify({
              conversation: {
                id: cid,
                state: {
                  runState: runStates[cid] || 'RUN_STATE_IDLE',
                  updateTime: '2026-11-29T00:10:00Z',
                },
                annotations: { archived: false },
              },
            }),
          );
          return;
        }
        if (req.url === '/product.v1.ConversationService/UpdateConversation') {
          updateConvCalls.push(payload);
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.url === '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage') {
          sendMsgCalls.push(payload);
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
          const cid = String(payload.cascadeId || '');
          totalGenMeta += 1;
          genMetaCalls.set(cid, (genMetaCalls.get(cid) || 0) + 1);
          const customModel = models[cid];
          res.end(
            JSON.stringify({
              generatorMetadata: customModel
                ? [
                    {
                      stepIndices: [1],
                      chatModel: {
                        model: customModel.modelEnum || 'MODEL_PLACEHOLDER_M531',
                        responseModel: customModel.responseModel || 'gemini-4-hydrogen-tiered-xhigh',
                        modelDisplayName: customModel.displayName,
                      },
                    },
                  ]
                : [],
            }),
          );
          return;
        }
        if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
          res.end(JSON.stringify({ clientModelConfigs: [] }));
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      };

      const d = typeof delayMs === 'function' ? delayMs(req.url, payload) : delayMs;
      if (d > 0) {
        const timer = setTimeout(respond, d);
        timer.unref?.();
      } else {
        respond();
      }
    });
  });

  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = `127.0.0.1:${server.address().port}`;
      process.env.ANTIGRAVITY_LS_ADDRESS = address;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-perf-14';
      resetLsEndpointCache();
      t.after(() => new Promise((r) => server.close(r)));
      resolveListen({
        address,
        getConvCalls,
        genMetaCalls,
        updateConvCalls,
        sendMsgCalls,
        getTotals: () => ({ totalGetConv, totalGenMeta }),
        resetCounts: () => {
          getConvCalls.clear();
          genMetaCalls.clear();
          updateConvCalls.length = 0;
          sendMsgCalls.length = 0;
          totalGetConv = 0;
          totalGenMeta = 0;
        },
      });
    });
  });
}

test('Issue #14 P0-1: syncThreads(includeArchived=true) and getThreadMessages() trigger ZERO LS RPC and ZERO transcript_full reads for 82 archived threads', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-perf-arch-');
  const repoDir = join(tempRoot, 'demo-repo');
  initGitRepo(repoDir);
  const scopeKey = normalizeKey(repoDir);

  const ls = await startMockLs(t, {
    runStates: {
      'conv-active-0001': 'RUN_STATE_RUNNING',
      'conv-active-0002': 'RUN_STATE_IDLE',
      'conv-active-0003': 'RUN_STATE_IDLE',
    },
    models: {
      'conv-active-0001': { displayName: 'Gemini 4 Hydrogen (XHigh)' },
    },
  });

  const reg = loadRegistry();
  reg.coordinators[scopeKey] = {
    key: scopeKey,
    conversationId: 'conv-coord-main-0001',
    workspacePath: repoDir,
    repoRoot: repoDir,
    defaultBranch: 'main',
    title: '[Coordinator] Demo',
  };

  // Seed 82 archived threads with truncated GENERIC tool steps + large transcript_full.jsonl
  const archivedConvIds = [];
  for (let i = 1; i <= 82; i++) {
    const num = String(i).padStart(3, '0');
    const tid = `thr-${num}`;
    const cid = `conv-arch-${num}-00001`;
    archivedConvIds.push(cid);
    writeTranscriptPair(
      appDataDir,
      cid,
      [
        { step_index: 0, type: 'USER_INPUT', content: `<USER_REQUEST>Archived task ${num}</USER_REQUEST>` },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-neon-high',
          tool_calls: [{ name: 'run_command', args: { toolSummary: 'Run tests' } }],
        },
        {
          step_index: 2,
          type: 'GENERIC',
          status: 'DONE',
          truncated_fields: ['content'],
          content: 'Command output: ok <truncated 40000 bytes>',
        },
        {
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-neon-high',
          content: `### Thread Summary\nArchived task ${num} completed.`,
        },
      ],
      [
        { step_index: 2, type: 'GENERIC', status: 'DONE', content: `FULL_ARCHIVED_TOOL_OUTPUT_${num}_${'X'.repeat(4000)}` },
      ],
    );
    reg.threads[tid] = {
      threadId: tid,
      localId: tid,
      projectSeq: i,
      conversationId: cid,
      coordinatorId: 'conv-coord-main-0001',
      workspaceKey: scopeKey,
      workspacePath: repoDir,
      repoRoot: repoDir,
      title: `Archived ${num}`,
      model: 'pro',
      modelDisplayName: i <= 80 ? 'Gemini 4 Neon (High)' : '',
      runState: 'RUN_STATE_IDLE',
      archived: true,
      bucket: 'idle',
      lastSummary: `Archived task ${num} completed.`,
      createdAt: `2026-11-01T00:${String(i % 60).padStart(2, '0')}:00Z`,
      updatedAt: '2026-11-01T01:00:00Z',
    };
  }

  // Seed 3 active threads
  for (let j = 1; j <= 3; j++) {
    const seq = 82 + j;
    const tid = `thr-0${seq}`;
    const cid = `conv-active-000${j}`;
    writeTranscriptPair(
      appDataDir,
      cid,
      [
        { step_index: 0, type: 'USER_INPUT', content: `<USER_REQUEST>Active task ${j}</USER_REQUEST>` },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-hydrogen-tiered-xhigh',
          tool_calls: [{ name: 'read_file', args: { Path: '/demo/a.js' } }],
        },
        {
          step_index: 2,
          type: 'GENERIC',
          status: 'DONE',
          truncated_fields: ['content'],
          content: 'Showing lines 1-20 <truncated 20000 bytes>',
        },
        {
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-hydrogen-tiered-xhigh',
          content: `Active reply ${j}`,
        },
      ],
      [
        { step_index: 2, type: 'GENERIC', status: 'DONE', content: `FULL_ACTIVE_TOOL_OUTPUT_${j}_${'Y'.repeat(4000)}` },
      ],
    );
    reg.threads[tid] = {
      threadId: tid,
      localId: tid,
      projectSeq: seq,
      conversationId: cid,
      coordinatorId: 'conv-coord-main-0001',
      workspaceKey: scopeKey,
      workspacePath: repoDir,
      repoRoot: repoDir,
      title: `Active ${j}`,
      model: 'pro',
      runState: j === 1 ? 'RUN_STATE_RUNNING' : 'RUN_STATE_IDLE',
      archived: false,
      createdAt: `2026-11-28T00:0${j}:00Z`,
      updatedAt: '2026-11-28T01:00:00Z',
    };
  }
  saveRegistry(reg);

  // Run 2 consecutive syncThreads passes with includeArchived: true
  const snap1 = await syncThreads({ workspacePath: repoDir, includeArchived: true });
  const snap2 = await syncThreads({ workspacePath: repoDir, includeArchived: true });
  assert.equal(snap1.threads.length, 85);
  assert.equal(snap2.threads.length, 85);

  // Every archived thread must have 0 GetConversation and 0 GeneratorMetadata RPCs
  for (const cid of archivedConvIds) {
    assert.equal(ls.getConvCalls.get(cid) || 0, 0, `archived ${cid} must trigger 0 GetConversation RPCs`);
    assert.equal(ls.genMetaCalls.get(cid) || 0, 0, `archived ${cid} must trigger 0 GeneratorMetadata RPCs`);
  }
  // Active threads WERE refreshed
  assert.ok((ls.getConvCalls.get('conv-active-0001') || 0) >= 1, 'active thread should be polled');
  // Zero transcript_full.jsonl loads across all 85 threads during syncThreads
  assert.equal(getTranscriptCacheStats().fullTranscript, 0, 'syncThreads must never read transcript_full.jsonl');

  // Verify resolveThreadModelInfo() on archived thread (both with model and without model) never calls LS and caches statically
  ls.resetCounts();
  const archWithModel = { ...reg.threads['thr-001'] };
  const archNoModel = { ...reg.threads['thr-082'] };
  await resolveThreadModelInfo(archWithModel, { forceLsCheck: true });
  await resolveThreadModelInfo(archWithModel, { forceLsCheck: true });
  await resolveThreadModelInfo(archNoModel, { forceLsCheck: true });
  await resolveThreadModelInfo(archNoModel, { forceLsCheck: true });
  assert.equal(ls.getTotals().totalGenMeta, 0, 'archived resolveThreadModelInfo must trigger 0 LS calls');
  assert.equal(getTranscriptCacheStats().fullTranscript, 0);

  // Verify getThreadMessages() on archived thread hits zero-LS-RPC fast path and zero full reads
  ls.resetCounts();
  resetRepoInfoCache();
  const t0 = performance.now();
  const archMsg = await getThreadMessages({
    threadId: 'thr-001',
    workspacePath: repoDir,
    workspaceKey: scopeKey,
  });
  const elapsedMs = performance.now() - t0;
  assert.equal(archMsg.ok, true);
  assert.equal(ls.getTotals().totalGetConv, 0, 'archived getThreadMessages must trigger 0 GetConversation RPCs');
  assert.equal(ls.getTotals().totalGenMeta, 0, 'archived getThreadMessages must trigger 0 GeneratorMetadata RPCs');
  assert.equal(getStorePerfCounters().repoInfoGitSpawns, 0, 'known workspaceKey fast path must spawn 0 git processes');
  assert.equal(getTranscriptCacheStats().fullTranscript, 0, 'GENERIC-only truncation must not load transcript_full.jsonl');
  assert.ok(archMsg.items.some((it) => it.kind === 'assistant' && it.text.includes('Archived task 001 completed')));
  assert.ok(elapsedMs < 250, `archived getThreadMessages should be fast (got ${elapsedMs.toFixed(1)}ms)`);
});

test('Issue #14 P0-1: syncThreads() single-flight deduplicates overlapping calls with identical scope signature', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-perf-sf-');
  const repoA = join(tempRoot, 'repo-a');
  const repoB = join(tempRoot, 'repo-b');
  initGitRepo(repoA);
  initGitRepo(repoB);
  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);

  const ls = await startMockLs(t, { delayMs: 120 });

  const reg = loadRegistry();
  reg.threads['thr-a1'] = {
    threadId: 'thr-a1',
    conversationId: 'conv-sf-a-000001',
    workspaceKey: keyA,
    workspacePath: repoA,
    repoRoot: repoA,
    title: 'A1',
    model: 'pro',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
    createdAt: '2026-11-28T01:00:00Z',
    updatedAt: '2026-11-28T01:00:00Z',
  };
  reg.threads['thr-b1'] = {
    threadId: 'thr-b1',
    conversationId: 'conv-sf-b-000001',
    workspaceKey: keyB,
    workspacePath: repoB,
    repoRoot: repoB,
    title: 'B1',
    model: 'pro',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
    createdAt: '2026-11-28T01:00:00Z',
    updatedAt: '2026-11-28T01:00:00Z',
  };
  saveRegistry(reg);

  // Warm repoInfoCache first so all 5 calls immediately contend in syncThreads
  await resolveRepoInfo(repoA);
  ls.resetCounts();

  const p1 = syncThreads({ workspacePath: repoA, includeArchived: true });
  const p2 = syncThreads({ workspacePath: repoA, includeArchived: true });
  const p3 = syncThreads({ workspacePath: repoA, includeArchived: true });
  const p4 = syncThreads({ workspacePath: repoA, includeArchived: true });
  const p5 = syncThreads({ workspacePath: repoB, includeArchived: true });

  assert.strictEqual(p1, p2, 'identical concurrent syncThreads calls must share the same in-flight Promise');
  assert.strictEqual(p1, p3);
  assert.strictEqual(p1, p4);
  assert.notStrictEqual(p1, p5, 'distinct project scopes must not collide in single-flight map');

  const [r1, r4, r5] = await Promise.all([p1, p4, p5]);
  assert.equal(r1.threads.length, 1);
  assert.equal(r4.threads.length, 1);
  assert.equal(r5.threads.length, 1);
  assert.equal(ls.getConvCalls.get('conv-sf-a-000001'), 1, 'overlapping same-scope syncThreads must only poll LS once');
  assert.equal(ls.getConvCalls.get('conv-sf-b-000001'), 1);

  // Subsequent sequential call after completion starts a fresh sync
  const p6 = syncThreads({ workspacePath: repoA, includeArchived: true });
  assert.notStrictEqual(p6, p1);
  await p6;
  assert.equal(ls.getConvCalls.get('conv-sf-a-000001'), 2);
});

test('Issue #14 P0-1b: lightweight probes never read transcript_full.jsonl, parseThreadTranscript loads full only for non-GENERIC truncation, and caches use true LRU >= 256', (t) => {
  const { appDataDir } = createTempEnv(t, 'pt-perf-lru-');

  assert.ok(TRANSCRIPT_CACHE_MAX_ENTRIES >= 256, `LRU capacity must be >= 256 (got ${TRANSCRIPT_CACHE_MAX_ENTRIES})`);

  // 1. Thread with ONLY GENERIC truncation: peekLiveActivity, extractTranscriptModel, and parseThreadTranscript all skip full
  const convGenericOnly = 'conv-trunc-gen-01';
  writeTranscriptPair(
    appDataDir,
    convGenericOnly,
    [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Inspect logs</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-neon-medium',
        tool_calls: [{ name: 'run_command', args: { toolSummary: 'Print logs' } }],
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'DONE',
        truncated_fields: ['content'],
        content: 'Command output: line1 <truncated 99999 bytes>',
      },
      {
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-neon-medium',
        content: 'All checks passed.',
      },
    ],
    [
      { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'SHOULD_NOT_BE_READ_FOR_GENERIC_ONLY' },
    ],
  );

  const probeSteps = loadTranscriptSteps({ conversationId: convGenericOnly, resolveFull: false });
  assert.equal(probeSteps.fullLoaded, false);
  const act = peekLiveActivity(convGenericOnly, { runState: 'RUN_STATE_IDLE' });
  assert.equal(act.lastSummary, 'All checks passed.');
  const mod = extractTranscriptModel(convGenericOnly);
  assert.equal(mod.modelSlug, 'gemini-4-neon-medium');
  const parsedGenericOnly = parseThreadTranscript(convGenericOnly);
  assert.ok(parsedGenericOnly.items.some((x) => x.kind === 'assistant' && x.text === 'All checks passed.'));
  assert.equal(
    getTranscriptCacheStats().fullTranscript,
    0,
    'peekLiveActivity, extractTranscriptModel, and GENERIC-only parseThreadTranscript must never load transcript_full.jsonl',
  );

  // 2. Thread with non-GENERIC (PLANNER_RESPONSE) truncation: lightweight probes STILL skip full, parseThreadTranscript recovers full
  const convPlannerTrunc = 'conv-trunc-pln-02';
  writeTranscriptPair(
    appDataDir,
    convPlannerTrunc,
    [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Write full report</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-hydrogen-high',
        truncated_fields: ['content'],
        content: 'Intro... <truncated 5000 bytes>',
      },
    ],
    [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Write full report</USER_REQUEST>' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-hydrogen-high',
        content: 'FULL_UNTRUNCATED_PLANNER_REPORT_BODY',
      },
    ],
  );

  peekLiveActivity(convPlannerTrunc, { runState: 'RUN_STATE_IDLE' });
  extractTranscriptModel(convPlannerTrunc);
  assert.equal(
    getTranscriptCacheStats().fullTranscript,
    0,
    'lightweight probes must NEVER load transcript_full.jsonl even when PLANNER_RESPONSE is truncated',
  );

  const parsedFull = parseThreadTranscript(convPlannerTrunc);
  assert.equal(getTranscriptCacheStats().fullTranscript, 1, 'parseThreadTranscript should load full for truncated PLANNER_RESPONSE');
  assert.ok(
    parsedFull.items.some((x) => x.kind === 'assistant' && x.text === 'FULL_UNTRUNCATED_PLANNER_REPORT_BODY'),
  );

  // 3. True LRU >= 256 verification: fill 256 entries, touch oldest hot key (idx 0), insert 5 more keys -> idx 0 survives, idx 1..5 evicted
  resetTranscriptCaches();
  const cap = TRANSCRIPT_CACHE_MAX_ENTRIES;
  const fixedTime = new Date(1700000000000);
  const createdPaths = [];
  for (let i = 0; i < cap + 5; i++) {
    const cid = `conv-lru-${String(i).padStart(4, '0')}`;
    const { txPath } = writeTranscriptPair(appDataDir, cid, [
      { step_index: 0, type: 'USER_INPUT', content: `<USER_REQUEST>LRU ${i}</USER_REQUEST>` },
      { step_index: 1, type: 'PLANNER_RESPONSE', model: `model-slug-${i}`, content: `Reply ${i}` },
    ]);
    utimesSync(txPath, fixedTime, fixedTime);
    createdPaths.push({ cid, txPath });
  }

  for (let i = 0; i < cap; i++) {
    const m = extractTranscriptModel(createdPaths[i].cid);
    assert.equal(m.modelSlug, `model-slug-${i}`);
  }
  assert.equal(getTranscriptCacheStats().model, cap);

  // Touch idx 0 so it becomes MRU (most recently used)
  assert.equal(extractTranscriptModel(createdPaths[0].cid).modelSlug, 'model-slug-0');

  // Insert 5 new keys (cap .. cap+4) -> should evict idx 1..5, NOT idx 0
  for (let i = cap; i < cap + 5; i++) {
    assert.equal(extractTranscriptModel(createdPaths[i].cid).modelSlug, `model-slug-${i}`);
  }
  assert.equal(getTranscriptCacheStats().model, cap, 'LRU cache must stay bounded at capacity');

  // Rewrite idx 0 and idx 1 files with equal-length mutated content and identical whole-second mtime:
  // cache HIT returns original cached modelSlug; cache MISS re-reads disk and returns mutated slug.
  const original0 = readFileSync(createdPaths[0].txPath, 'utf8');
  const original1 = readFileSync(createdPaths[1].txPath, 'utf8');
  const mod0 = original0.replace('model-slug-0', 'mutat-slug-0');
  const mod1 = original1.replace('model-slug-1', 'mutat-slug-1');
  assert.equal(Buffer.byteLength(mod0), Buffer.byteLength(original0));
  assert.equal(Buffer.byteLength(mod1), Buffer.byteLength(original1));

  writeFileSync(createdPaths[0].txPath, mod0, 'utf8');
  utimesSync(createdPaths[0].txPath, fixedTime, fixedTime);
  writeFileSync(createdPaths[1].txPath, mod1, 'utf8');
  utimesSync(createdPaths[1].txPath, fixedTime, fixedTime);
  assert.equal(statSync(createdPaths[0].txPath).mtimeMs, fixedTime.getTime());

  assert.equal(
    extractTranscriptModel(createdPaths[0].cid).modelSlug,
    'model-slug-0',
    'recently touched hot key (idx 0) must stay in LRU cache (hit)',
  );
  assert.equal(
    extractTranscriptModel(createdPaths[1].cid).modelSlug,
    'mutat-slug-1',
    'least-recently-used key (idx 1) must have been evicted (miss -> re-read disk)',
  );
});

test('Issue #14 P0-2 & P1-1: resolveRepoInfo() 30s TTL cache invalidates on .git/HEAD change, resolveScopedThreadTarget() stays fail-closed, and active getThreadMessages() degrades cleanly under slow LS', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-perf-repo-');
  const repoA = join(tempRoot, 'repo-a');
  const repoB = join(tempRoot, 'repo-b');
  const nonGitDir = join(tempRoot, 'plain-dir');
  initGitRepo(repoA, 'main');
  initGitRepo(repoB, 'main');
  mkdirSync(nonGitDir, { recursive: true });

  // 1. resolveRepoInfo caches within 30s TTL (0 extra git spawns)
  resetRepoInfoCache();
  const info1 = await resolveRepoInfo(repoA);
  assert.equal(info1.currentBranch, 'main');
  const spawnsAfterFirst = getStorePerfCounters().repoInfoGitSpawns;
  assert.ok(spawnsAfterFirst >= 1);

  for (let i = 0; i < 5; i++) {
    const cachedInfo = await resolveRepoInfo(repoA);
    assert.equal(cachedInfo.currentBranch, 'main');
    assert.equal(cachedInfo.repoRoot, info1.repoRoot);
  }
  assert.equal(
    getStorePerfCounters().repoInfoGitSpawns,
    spawnsAfterFirst,
    'repeated resolveRepoInfo calls within TTL must spawn 0 additional git processes',
  );

  // 2. Switching to same-length branch name ('main' -> 'feat') immediately invalidates via .git/HEAD probe
  execFileSync('git', ['checkout', '-b', 'feat'], { cwd: repoA });
  const infoAfterBranch = await resolveRepoInfo(repoA);
  assert.equal(infoAfterBranch.currentBranch, 'feat');
  assert.ok(getStorePerfCounters().repoInfoGitSpawns > spawnsAfterFirst);

  // 3. Non-git directory negative cache invalidates immediately once git init runs
  const nonGitBefore = await resolveRepoInfo(nonGitDir);
  assert.equal(nonGitBefore.repoRoot, '');
  initGitRepo(nonGitDir, 'dev');
  const nonGitAfter = await resolveRepoInfo(nonGitDir);
  assert.equal(nonGitAfter.currentBranch, 'dev');
  assert.ok(nonGitAfter.repoRoot.length > 0);

  // 4. resolveScopedThreadTarget fast path + strict cross-project fail-closed contract
  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);
  const reg = loadRegistry();
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'conv-coord-a-001',
    workspacePath: repoA,
    repoRoot: repoA,
    projectId: 'proj-a',
  };
  reg.coordinators[keyB] = {
    key: keyB,
    conversationId: 'conv-coord-b-001',
    workspacePath: repoB,
    repoRoot: repoB,
    projectId: 'proj-b',
  };
  reg.threads['thr-in-a'] = {
    threadId: 'thr-in-a',
    localId: 'thr-001',
    projectSeq: 1,
    conversationId: 'conv-thr-a-00001',
    coordinatorId: 'conv-coord-a-001',
    workspaceKey: keyA,
    workspacePath: repoA,
    repoRoot: repoA,
    projectId: 'proj-a',
    title: 'Active A',
    model: 'pro',
    modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
    createdAt: '2026-11-28T01:00:00Z',
    updatedAt: '2026-11-28T01:00:00Z',
  };
  reg.threads['thr-in-b'] = {
    threadId: 'thr-in-b',
    localId: 'thr-001',
    projectSeq: 1,
    conversationId: 'conv-thr-b-00001',
    coordinatorId: 'conv-coord-b-001',
    workspaceKey: keyB,
    workspacePath: repoB,
    repoRoot: repoB,
    projectId: 'proj-b',
    title: 'Active B',
    model: 'pro',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    createdAt: '2026-11-28T01:00:00Z',
    updatedAt: '2026-11-28T01:00:00Z',
  };
  saveRegistry(reg);

  resetRepoInfoCache();
  const fastHit = await resolveScopedThreadTarget({
    threadId: 'thr-in-a',
    workspacePath: repoA,
    workspaceKey: keyA,
    requireScope: true,
  });
  assert.equal(fastHit.thread.threadId, 'thr-in-a');
  assert.equal(getStorePerfCounters().repoInfoGitSpawns, 0, 'fast path must resolve known scope without spawning git');

  // Cross-project attempts MUST still fail closed even when workspaceKey is passed or spoofed
  await assert.rejects(
    () =>
      resolveScopedThreadTarget({
        threadId: 'thr-in-b',
        workspacePath: repoA,
        workspaceKey: keyA,
        requireScope: true,
      }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () =>
      resolveScopedThreadTarget({
        threadId: 'thr-in-b',
        workspacePath: repoA,
        workspaceKey: keyB, // spoofed key contradicting workspacePath repoA
        requireScope: true,
      }),
    /Cross-project access denied/,
  );

  // 5. Active thread getThreadMessages() degrades cleanly under a slow/stalled LS (3s delay -> <500ms response)
  writeTranscriptPair(appDataDir, 'conv-thr-a-00001', [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Slow LS test</USER_REQUEST>' },
    { step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-hydrogen-tiered-xhigh', content: 'Local fast response!' },
  ]);
  await startMockLs(t, { delayMs: 2500 });

  const startMs = performance.now();
  const fastActiveRes = await getThreadMessages({
    threadId: 'thr-in-a',
    workspacePath: repoA,
    workspaceKey: keyA,
    lsSoftTimeoutMs: 250,
  });
  const elapsedMs = performance.now() - startMs;
  assert.equal(fastActiveRes.ok, true);
  assert.equal(fastActiveRes.thread.modelDisplayName, 'Gemini 4 Hydrogen (XHigh)');
  assert.ok(fastActiveRes.items.some((x) => x.kind === 'assistant' && x.text === 'Local fast response!'));
  assert.ok(
    elapsedMs < 900,
    `slow LS must degrade via tight soft timeout instead of blocking 2500ms+ (got ${elapsedMs.toFixed(1)}ms)`,
  );
});

test('Issue #14 P2: parallelized inspectWorktreeGit() matches exact semantics across clean, dirty, unmerged, and cherry-picked worktrees', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-perf-wt-');
  const repoDir = join(tempRoot, 'wt-repo');
  initGitRepo(repoDir, 'main');
  const wtRoot = join(tempRoot, 'wts');
  mkdirSync(wtRoot, { recursive: true });

  const wtDirty = join(wtRoot, 'wt-dirty');
  execFileSync('git', ['worktree', 'add', '-b', 'thread/thr-001-dirty', wtDirty, 'main'], { cwd: repoDir });
  // Injected rules file must be ignored by dirtyCount, while normal untracked file must be counted
  mkdirSync(join(wtDirty, '.agents', 'rules'), { recursive: true });
  writeFileSync(join(wtDirty, '.agents', 'rules', 'worker-thread-context.md'), '# ctx\n', 'utf8');
  writeFileSync(join(wtDirty, 'change.txt'), 'wip\n', 'utf8');

  const dirtyInfo = await inspectWorktreeGit(wtDirty, { baseRef: 'main', repoRoot: repoDir });
  assert.equal(dirtyInfo.exists, true);
  assert.equal(dirtyInfo.branch, 'thread/thr-001-dirty');
  assert.equal(dirtyInfo.dirtyCount, 1);
  assert.equal(dirtyInfo.aheadCount, 0);
  assert.equal(dirtyInfo.merged, true);
  assert.match(dirtyInfo.lastCommit, /init$/);

  // Commit in worktree -> unmerged aheadCount=1 (distinct timestamps prevent identical-second SHA collision on cherry-pick)
  const commitDateEnv = (offsetSec) => {
    const iso = new Date(1700000000000 + offsetSec * 1000).toISOString();
    return { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
  };
  execFileSync('git', ['add', 'change.txt'], { cwd: wtDirty });
  execFileSync('git', ['commit', '-m', 'Add change'], { cwd: wtDirty, env: commitDateEnv(10) });
  const unmergedInfo = await inspectWorktreeGit(wtDirty, { baseRef: 'main' }); // omit repoRoot to exercise parallel --git-common-dir
  assert.equal(unmergedInfo.exists, true);
  assert.equal(unmergedInfo.dirtyCount, 0);
  assert.equal(unmergedInfo.aheadCount, 1);
  assert.equal(unmergedInfo.merged, false);
  assert.match(unmergedInfo.lastCommit, /Add change$/);

  // Cherry-pick onto main -> merged=true, mergeMethod='cherry-pick'
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wtDirty, encoding: 'utf8' }).trim();
  execFileSync('git', ['cherry-pick', sha], { cwd: repoDir, env: commitDateEnv(20) });
  const cherryInfo = await inspectWorktreeGit(wtDirty, { baseRef: 'main', repoRoot: repoDir });
  assert.equal(cherryInfo.exists, true);
  assert.equal(cherryInfo.dirtyCount, 0);
  assert.equal(cherryInfo.aheadCount, 1);
  assert.equal(cherryInfo.merged, true);
  assert.equal(cherryInfo.mergeMethod, 'cherry-pick');

  // Missing path returns null
  assert.equal(await inspectWorktreeGit(join(wtRoot, 'does-not-exist')), null);
});

function createMockDomElement(id = '') {
  const cls = new Set();
  const listeners = new Map();
  let html = '';
  const el = {
    id,
    hidden: false,
    disabled: false,
    textContent: '',
    scrollTop: 0,
    scrollHeight: 100,
    offsetWidth: 100,
    value: '',
    style: {},
    classList: {
      add: (...names) => names.forEach((n) => cls.add(n)),
      remove: (...names) => names.forEach((n) => cls.delete(n)),
      toggle: (name, force) => {
        if (force === undefined) {
          if (cls.has(name)) cls.delete(name);
          else cls.add(name);
        } else if (force) cls.add(name);
        else cls.delete(name);
      },
      contains: (name) => cls.has(name),
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    click() {
      for (const fn of listeners.get('click') || []) fn({ currentTarget: el });
    },
    focus() {},
    querySelector(sel) {
      if (sel === 'button[data-action="retry-thread-load"]' && html.includes('data-action="retry-thread-load"')) {
        if (!el._retryBtn) {
          el._retryBtn = createMockDomElement('retry-btn');
        }
        return el._retryBtn;
      }
      return null;
    },
    get innerHTML() {
      return html;
    },
    set innerHTML(v) {
      html = String(v || '');
      el._retryBtn = null;
    },
  };
  return el;
}

function loadPreviewDrawerHarness({ fetchImpl, locale = 'zh-CN' } = {}) {
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const constStart = appJs.indexOf('const BOARD_POLL_MS');
  const constEnd = appJs.indexOf('const params =', constStart);
  const i18nStart = appJs.indexOf('const I18N = {');
  const i18nEnd = appJs.indexOf('let curLocale =', i18nStart);
  const apiStart = appJs.indexOf('function createApiError(');
  const apiEnd = appJs.indexOf('// ---------- Rich Markdown', apiStart);
  const skelStart = appJs.indexOf('function renderSkeletonLoader()');
  const skelEnd = appJs.indexOf('function renderTraceToolInnerHtml(', skelStart);
  const drawerStart = appJs.indexOf('async function openThreadDrawer(');
  const drawerEnd = appJs.indexOf('async function sendChatFollowUp(', drawerStart);
  const boardStart = appJs.indexOf('async function refreshBoard(');
  const boardEnd = appJs.indexOf('function setDrawerOpen(', boardStart);

  for (const [name, idx] of [
    ['constStart', constStart],
    ['constEnd', constEnd],
    ['i18nStart', i18nStart],
    ['i18nEnd', i18nEnd],
    ['apiStart', apiStart],
    ['apiEnd', apiEnd],
    ['skelStart', skelStart],
    ['skelEnd', skelEnd],
    ['drawerStart', drawerStart],
    ['drawerEnd', drawerEnd],
    ['boardStart', boardStart],
    ['boardEnd', boardEnd],
  ]) {
    assert.notEqual(idx, -1, `Could not locate ${name} in sidecars/threads/app.js`);
  }

  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, createMockDomElement(id));
    return elements.get(id);
  };
  const postApiCalls = [];
  const renderedItemsLog = [];
  const boardRenderLog = [];

  const ctx = {
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
    fetch: fetchImpl,
    doFetch: fetchImpl,
    document: {
      hidden: false,
      getElementById: getEl,
      activeElement: null,
    },
    window: { innerWidth: 420, innerHeight: 800 },
    esc: (s) =>
      String(s ?? '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
      ),
    isPanelHidden: () => false,
    applyLocale: (loc) => {
      if (loc) ctx._setLocale(loc);
    },
    closeModelMenu: () => {},
    clearToast: () => {},
    optimisticallyMarkThreadIdle: () => {},
    renderThreadHeader: (th) => {
      ctx._setOpenThreadObj(th);
    },
    autoResizeInput: () => {},
    fmtWorkedDuration: (s) => `${s}s`,
    syncHostConversationScope: async () => false,
    getHostConvId: () => 'conv-coord-1',
    setLiveStatus: () => {},
    clearExpiredToastOnRecovery: () => {},
    loadSettingsData: () => {},
    loadMemory: () => {},
    closePtModal: () => {},
    setMemoryDirty: () => {},
    renderBoard: (data) => boardRenderLog.push(data),
    buildScopePayload: (extra = {}) => ({ workspace: '/demo/repo', workspaceKey: '/demo/repo', ...extra }),
    postApiCalls,
    renderedItemsLog,
    boardRenderLog,
  };

  vm.runInNewContext(
    `
    ${appJs.slice(constStart, constEnd)}
    ${appJs.slice(i18nStart, i18nEnd)}
    let curLocale = ${JSON.stringify(locale)};
    const L = () => I18N[curLocale] || I18N.en;
    this._setLocale = (loc) => { curLocale = loc; };

    let workspace = '/demo/repo';
    let hostProjectId = '';
    let activeScopeKey = '/demo/repo';
    let scopeEpoch = 0;
    let lastSnapScopeEpoch = 0;
    let lastHasGitRepo = true;
    let isLiveOk = true;
    let currentTab = 'threads';
    let sortMode = 'priority';
    let decisionsPanelCollapsed = false;
    let manualPopoutConvId = '';
    let lastCoordinatorTurnStamp = '';
    let loadedSettingsData = { scopeKey: '/demo/repo' };
    let settingsScreenOpen = false;
    let settingsDirtyByUser = false;
    let settingsNeedsRefresh = false;
    let lastSettingsAutoLoadAt = Date.now();
    let activeModalCtx = null;
    let cachedDecisions = [];
    let backendVersionMismatch = null;
    let serverCapabilities = new Set();
    let sidecarFetchSupportsSignal = null;
    let memoryActiveView = 'index';
    let memoryActiveTopicId = '';
    let memoryActiveTopicData = null;
    let memorySnapshot = null;
    let memoryImeComposing = false;
    let lastMemoryTopicsKey = '';
    const threadOpenState = new Map();
    const expandedCustomDecisionIds = new Set();
    const decisionCustomDrafts = new Map();
    const decisionImeComposingIds = new Set();
    let deferredDecisionsList = null;
    let lastDecisionsRenderKey = '';

    let lastBoardKey = '';
    let lastSnap = { scopeKey: '/demo/repo', threads: [] };
    let cachedThreads = [];
    let boardScrollTop = 0;
    let boardRefreshInFlight = false;
    let boardRefreshQueuedForce = false;
    let lastBoardRefreshAt = 0;

    let openThreadId = '';
    let openThreadObj = null;
    let lastThreadStamp = '';
    let lastRenderedItems = null;
    let threadRefreshInFlight = false;
    let openThreadReqSeq = 0;
    let openThreadAbortController = null;
    let openThreadEpochRetryCount = 0;
    const openTraceIds = new Set();
    const closedLiveTraceIds = new Set();
    const openSubDetailIds = new Set();
    let briefExpanded = false;
    this._setOpenThreadObj = (th) => { openThreadObj = th; };

    const elBoardScreen = document.getElementById('board-screen');
    const elThreadScreen = document.getElementById('thread-screen');
    const elSettingsScreen = document.getElementById('settings-screen');
    const elBoardBody = document.getElementById('board-body');
    const elChatStream = document.getElementById('chat-stream');
    const elChatInput = document.getElementById('chat-input');
    const elDrawer = document.getElementById('dispatch-drawer');

    function renderThreadItems(items, forceBottom) {
      lastRenderedItems = items;
      renderedItemsLog.push({ items, forceBottom, threadId: openThreadId });
      elChatStream.innerHTML = '<div class="rendered-items">' + items.map((x) => x.text || '').join('|') + '</div>';
    }

    ${appJs.slice(apiStart, apiEnd)}
    const _origPostApi = postApi;
    postApi = async (url, getUrl, body, opts) => {
      postApiCalls.push({ url, getUrl, body });
      return _origPostApi(url, getUrl, body, opts);
    };
    ${appJs.slice(skelStart, skelEnd)}
    ${appJs.slice(drawerStart, drawerEnd)}
    ${appJs.slice(boardStart, boardEnd)}

    this.api = {
      I18N,
      BOARD_POLL_WHILE_THREAD_OPEN_MS,
      openThreadDrawer,
      closeThreadDrawer,
      refreshOpenThread,
      refreshBoard,
      setFetch(fn) { doFetch = fn; fetch = fn; sidecarFetchSupportsSignal = null; },
      setCachedThreads(list) { cachedThreads = list; lastSnap = { scopeKey: '/demo/repo', threads: list }; },
      bumpScopeEpoch() { scopeEpoch += 1; },
      setLastBoardRefreshAt(ts) { lastBoardRefreshAt = ts; },
      overrideReadTimeout(ms) {
        const orig = fetchJsonWithTimeout;
        fetchJsonWithTimeout = (url, opts, cfg = {}) =>
          orig(url, opts, {
            ...cfg,
            timeoutMs: cfg.timeoutMs > 0 ? Math.min(cfg.timeoutMs, ms) : cfg.timeoutMs,
          });
      },
      getState() {
        return {
          openThreadId,
          lastThreadStamp,
          lastRenderedItems,
          threadRefreshInFlight,
          openThreadReqSeq,
          boardRefreshInFlight,
          chatHtml: elChatStream.innerHTML,
          retryBtn: elChatStream.querySelector('button[data-action="retry-thread-load"]'),
        };
      },
    };
    `,
    ctx,
  );

  return {
    api: ctx.api,
    getEl,
    postApiCalls,
    renderedItemsLog,
    boardRenderLog,
  };
}

test('Issue #14 P1-1 & P1-2: openThreadDrawer eliminates redundant POST /api/thread_mark_read, refreshOpenThread enforces inFlight + AbortController + error recovery retry, and scopeEpoch never leaves skeleton stuck', async () => {
  const fetchCalls = [];
  const abortedSignals = [];

  const { api, postApiCalls, renderedItemsLog } = loadPreviewDrawerHarness({
    locale: 'zh-CN',
    fetchImpl: async (url, opts = {}) => {
      fetchCalls.push({ url: String(url), method: opts.method || 'GET', signal: opts.signal || null });
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () =>
          JSON.stringify({
            ok: true,
            unchanged: false,
            locale: 'zh-CN',
            stamp: 'st-1',
            thread: { threadId: 'thr-wait', bucket: 'idle', runState: 'RUN_STATE_IDLE' },
            items: [{ id: 'm1', kind: 'assistant', text: 'Hello from waiting thread' }],
          }),
      };
    },
  });

  api.setCachedThreads([
    { threadId: 'thr-wait', bucket: 'waiting', runState: 'RUN_STATE_IDLE', title: 'Waiting' },
    { threadId: 'thr-next', bucket: 'idle', runState: 'RUN_STATE_IDLE', title: 'Next' },
  ]);

  // 1. Opening a waiting thread must ONLY call GET /api/thread_messages?...&markRead=1 (0 POST /api/thread_mark_read)
  await api.openThreadDrawer('thr-wait');
  assert.equal(postApiCalls.length, 0, 'openThreadDrawer must not send redundant POST /api/thread_mark_read');
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/api\/thread_messages\?/);
  assert.match(fetchCalls[0].url, /markRead=1/);
  assert.equal(api.getState().chatHtml.includes('skel-wrap'), false);
  assert.equal(api.getState().chatHtml.includes('Hello from waiting thread'), true);

  // 2. Timeout / network error on initial load exits skeleton and renders retryable error state across locales
  api.overrideReadTimeout(80);
  let shouldFail = true;
  api.setFetch(async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), method: opts.method || 'GET' });
    if (shouldFail) {
      // Simulate slow/hanging fetch that triggers timeout
      return new Promise((_resolve, reject) => {
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({
          ok: true,
          unchanged: false,
          locale: 'zh-CN',
          stamp: 'st-recovered',
          thread: { threadId: 'thr-next', bucket: 'idle', runState: 'RUN_STATE_IDLE' },
          items: [{ id: 'm2', kind: 'assistant', text: 'Recovered after retry' }],
        }),
    };
  });

  await api.openThreadDrawer('thr-next');
  const errState = api.getState();
  assert.equal(errState.chatHtml.includes('skel-wrap'), false, 'skeleton must exit on timeout');
  assert.equal(errState.chatHtml.includes('thread-load-err'), true, 'error recovery UI must render');
  assert.ok(errState.retryBtn, 'retry button must be rendered');

  // Click Retry after backend recovers -> renders real conversation
  shouldFail = false;
  errState.retryBtn.click();
  await new Promise((r) => setTimeout(r, 30));
  const recoveredState = api.getState();
  assert.equal(recoveredState.chatHtml.includes('skel-wrap'), false);
  assert.equal(recoveredState.chatHtml.includes('Recovered after retry'), true);

  // 3. inFlight deduplication + AbortController cancellation on thread switch / drawer close
  let resolveSlowA = null;
  let activeCalls = 0;
  api.overrideReadTimeout(5000);
  api.setFetch((url, opts = {}) => {
    activeCalls += 1;
    const callIdx = activeCalls;
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => abortedSignals.push({ callIdx, url: String(url) }));
    }
    if (String(url).includes('threadId=thr-wait')) {
      return new Promise((resolve) => {
        resolveSlowA = resolve;
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({
          ok: true,
          unchanged: false,
          stamp: 'st-next-2',
          thread: { threadId: 'thr-next', bucket: 'idle', runState: 'RUN_STATE_IDLE' },
          items: [{ id: 'm3', kind: 'assistant', text: 'Thread Next Content' }],
        }),
    });
  });

  const openWaitPromise = api.openThreadDrawer('thr-wait');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(api.getState().threadRefreshInFlight, true);
  const callsBeforePoll = activeCalls;
  // 1.2s poll while inFlight must be skipped cleanly
  await api.refreshOpenThread(false, false);
  assert.equal(activeCalls, callsBeforePoll, 'background poll must not stack while refreshOpenThread is in-flight');

  // Switch to thr-next immediately -> must abort slow thr-wait request
  await api.openThreadDrawer('thr-next');
  assert.ok(
    abortedSignals.some((s) => s.url.includes('threadId=thr-wait')),
    'switching threads must abort the previous in-flight AbortController',
  );
  // Even if old slow request resolves late, it must not overwrite thr-next
  if (resolveSlowA) {
    resolveSlowA({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({
          ok: true,
          unchanged: false,
          stamp: 'st-late',
          items: [{ id: 'late', kind: 'assistant', text: 'STALE_OVERWRITE' }],
        }),
    });
  }
  await openWaitPromise;
  assert.equal(api.getState().chatHtml.includes('STALE_OVERWRITE'), false);
  assert.equal(api.getState().chatHtml.includes('Thread Next Content'), true);

  // 4. Mid-flight scopeEpoch bump while drawer stays open on skeleton must resync instead of sticking
  let epochCalls = 0;
  api.setFetch(async () => {
    epochCalls += 1;
    if (epochCalls === 1) {
      // Simulate same-project conversation switch bumping scopeEpoch while first-paint request is in flight
      api.bumpScopeEpoch();
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () =>
        JSON.stringify({
          ok: true,
          unchanged: false,
          stamp: `st-ep-${epochCalls}`,
          thread: { threadId: 'thr-wait', bucket: 'idle', runState: 'RUN_STATE_IDLE' },
          items: [{ id: `ep-${epochCalls}`, kind: 'assistant', text: `Loaded on pass ${epochCalls}` }],
        }),
    };
  });

  await api.openThreadDrawer('thr-wait');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(epochCalls, 2, 'mid-flight scopeEpoch change on skeleton must trigger automatic resync');
  assert.equal(api.getState().chatHtml.includes('skel-wrap'), false);
  assert.equal(api.getState().chatHtml.includes('Loaded on pass 2'), true);

  // 5. Frontend refreshBoard() inFlight single-flight + throttling while thread drawer is open
  let stateCalls = 0;
  let resolveSlowState = null;
  api.setFetch((url) => {
    if (String(url).includes('/api/state')) {
      stateCalls += 1;
      if (stateCalls === 1) {
        return new Promise((resolve) => {
          resolveSlowState = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () =>
          JSON.stringify({
            scopeKey: '/demo/repo',
            threads: [{ threadId: 'thr-wait', bucket: 'idle', runState: 'RUN_STATE_IDLE' }],
            decisions: [],
          }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ ok: true, items: [] }),
    });
  });

  // First force refresh is in-flight; concurrent non-force poll must be dropped
  const b1 = api.refreshBoard(true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(api.getState().boardRefreshInFlight, true);
  await api.refreshBoard(false);
  assert.equal(stateCalls, 1, 'refreshBoard must drop overlapping poll while in-flight');
  resolveSlowState({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () =>
      JSON.stringify({
        scopeKey: '/demo/repo',
        threads: [{ threadId: 'thr-wait', bucket: 'idle', runState: 'RUN_STATE_IDLE' }],
        decisions: [],
      }),
  });
  await b1;

  // While openThreadId is open and lastBoardRefreshAt is fresh, non-force board poll is throttled
  await api.refreshBoard(false);
  assert.equal(stateCalls, 1, 'board poll must throttle while inline thread preview drawer is open');

  // Closing drawer immediately triggers force refresh
  api.closeThreadDrawer({ refresh: true });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stateCalls, 2, 'closing thread drawer must immediately restore board refresh');
  assert.ok(renderedItemsLog.length >= 3);

  // Verify 3-locale I18N keys for error recovery and zero middle dots
  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    assert.ok(api.I18N[loc].threadLoadErrTitle, `missing threadLoadErrTitle in ${loc}`);
    assert.ok(api.I18N[loc].threadLoadErrFallback, `missing threadLoadErrFallback in ${loc}`);
    assert.ok(api.I18N[loc].threadLoadRetryBtn, `missing threadLoadRetryBtn in ${loc}`);
  }
});

test('Issue #14 static hygiene: main.mjs single-flight, rev 8 / directive v18 preserved, zero middle dots, zero native dialogs, strict LF', () => {
  const mainMjs = readFileSync(join(REPO_ROOT, 'sidecars', 'threads', 'main.mjs'), 'utf8');
  const appJs = readFileSync(join(REPO_ROOT, 'sidecars', 'threads', 'app.js'), 'utf8');
  const hookMjs = readFileSync(join(REPO_ROOT, 'scripts', 'hook-handler.mjs'), 'utf8');

  assert.match(mainMjs, /SERVER_API_REVISION\s*=\s*8\b/);
  assert.match(mainMjs, /stateApiInFlight\s*=\s*new Map\(\)/);
  assert.match(mainMjs, /completionSyncInFlight/);
  assert.match(appJs, /EXPECTED_SERVER_API_REVISION\s*=\s*8\b/);
  assert.match(hookMjs, /DIRECTIVE_VERSION\s*=\s*18\b/);
  assert.equal(
    /\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appJs),
    false,
    'app.js must never call native confirm/alert/prompt',
  );

  for (const rel of [
    'lib/transcript.mjs',
    'lib/ls-client.mjs',
    'lib/store.mjs',
    'sidecars/threads/main.mjs',
    'tests/preview-perf-skeleton.test.mjs',
  ]) {
    const rawBytes = readFileSync(join(REPO_ROOT, rel));
    assert.ok(!rawBytes.includes(Buffer.from('\r')), `${rel} must use strict LF line endings`);
    const text = rawBytes.toString('utf8');
    assert.equal(text.includes('\u00B7'), false, `${rel} must never contain U+00B7 middle dot`);
  }
  assert.equal(appJs.includes('\u00B7'), false, 'sidecars/threads/app.js must never contain U+00B7 middle dot');
});

test('Issue #14 Review P0-1 & P2-1: tryFastResolveKnownScopeFromKey enforces fail-closed isolation for nested repos, sub-project subdirectories, and conflicting projectId', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-rev-p0-');
  const monorepo = join(tempRoot, 'monorepo');
  initGitRepo(monorepo, 'main');
  const validSubdir = join(monorepo, 'src', 'utils');
  mkdirSync(validSubdir, { recursive: true });

  // Sub-project 1: registered nested repo (via coordinator) + deep subdirectory
  const subRepoCoord = join(monorepo, 'packages', 'sub-coord');
  initGitRepo(subRepoCoord, 'main');
  const subRepoCoordSrc = join(subRepoCoord, 'src', 'nested');
  mkdirSync(subRepoCoordSrc, { recursive: true });

  // Sub-project 2: registered nested project (only in reg.threads, no coordinator) + subdirectory
  const subDirThreadOnly = join(monorepo, 'packages', 'sub-thread-only');
  mkdirSync(join(subDirThreadOnly, 'lib'), { recursive: true });
  initGitRepo(subDirThreadOnly, 'main');
  const subThreadSrc = join(subDirThreadOnly, 'lib');

  // Sub-project 3: brand-new unregistered nested Git repo
  const unregisteredNestedRepo = join(monorepo, 'packages', 'brand-new-repo');
  initGitRepo(unregisteredNestedRepo, 'main');
  const unregisteredNestedSrc = join(unregisteredNestedRepo, 'src');
  mkdirSync(unregisteredNestedSrc, { recursive: true });

  const parentKey = normalizeKey(monorepo);
  const subCoordKey = normalizeKey(subRepoCoord);
  const subThreadKey = normalizeKey(subDirThreadOnly);

  const reg = loadRegistry();
  reg.coordinators[parentKey] = {
    key: parentKey,
    conversationId: 'conv-mono-coord',
    workspacePath: monorepo,
    repoRoot: monorepo,
    projectId: 'proj-mono',
  };
  reg.coordinators[subCoordKey] = {
    key: subCoordKey,
    conversationId: 'conv-sub-coord',
    workspacePath: subRepoCoord,
    repoRoot: subRepoCoord,
    projectId: 'proj-sub',
  };
  reg.threads['thr-parent-1'] = {
    threadId: 'thr-parent-1',
    localId: 'thr-001',
    projectSeq: 1,
    conversationId: 'conv-parent-001',
    coordinatorId: 'conv-mono-coord',
    workspaceKey: parentKey,
    workspacePath: monorepo,
    repoRoot: monorepo,
    projectId: 'proj-mono',
    title: 'Parent thread',
    archived: false,
    createdAt: '2026-11-28T01:00:00Z',
  };
  reg.threads['thr-sub-only'] = {
    threadId: 'thr-sub-only',
    localId: 'thr-001',
    projectSeq: 1,
    conversationId: 'conv-subonly-001',
    workspaceKey: subThreadKey,
    workspacePath: subDirThreadOnly,
    repoRoot: subDirThreadOnly,
    title: 'Thread-only sub-project',
    archived: false,
    createdAt: '2026-11-28T01:00:00Z',
  };
  // Project-only scope without coordinator record
  reg.threads['thr-proj-a'] = {
    threadId: 'thr-proj-a',
    localId: 'thr-001',
    projectSeq: 1,
    conversationId: 'conv-proja-001',
    workspaceKey: 'project:proj-a',
    projectId: 'proj-a',
    title: 'Pure project A thread',
    archived: false,
    createdAt: '2026-11-28T01:00:00Z',
  };
  saveRegistry(reg);

  // 1. Legitimate non-Git subdirectory of parent monorepo still hits zero-git fast path
  resetRepoInfoCache();
  const legitHit = await resolveScopedThreadTarget({
    threadId: 'thr-parent-1',
    workspacePath: validSubdir,
    workspaceKey: parentKey,
    requireScope: true,
  });
  assert.equal(legitHit.thread.threadId, 'thr-parent-1');
  assert.equal(getStorePerfCounters().repoInfoGitSpawns, 0, 'legit parent subdir should stay on zero-git fast path');

  // 2. Registered sub-project subdirectory (via coordinator) carrying stale parent workspaceKey MUST fail closed
  await assert.rejects(
    () =>
      resolveScopedThreadTarget({
        threadId: 'thr-parent-1',
        workspacePath: subRepoCoordSrc,
        workspaceKey: parentKey,
        requireScope: true,
      }),
    /Cross-project access denied/,
  );

  // 3. Registered sub-project subdirectory (via reg.threads only) carrying stale parent workspaceKey MUST fail closed
  await assert.rejects(
    () =>
      resolveScopedThreadTarget({
        threadId: 'thr-parent-1',
        workspacePath: subThreadSrc,
        workspaceKey: parentKey,
        requireScope: true,
      }),
    /Cross-project access denied/,
  );

  // 4. Unregistered brand-new nested Git repo (both root and subdir) carrying parent workspaceKey MUST fail closed
  await assert.rejects(
    () =>
      resolveScopedThreadTarget({
        threadId: 'thr-parent-1',
        workspacePath: unregisteredNestedRepo,
        workspaceKey: parentKey,
        requireScope: true,
      }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () =>
      resolveScopedThreadTarget({
        threadId: 'thr-parent-1',
        workspacePath: unregisteredNestedSrc,
        workspaceKey: parentKey,
        requireScope: true,
      }),
    /Cross-project access denied/,
  );

  // 5. Coordinator-less project: scope with conflicting explicit projectId MUST fail closed
  await assert.rejects(
    () =>
      resolveScopedThreadTarget({
        threadId: 'thr-proj-a',
        workspaceKey: 'project:proj-a',
        projectId: 'proj-b',
        requireScope: true,
      }),
    /Cross-project access denied/,
  );

  // 6. P2-1: resolveRepoInfo invalidates immediately when a cached parent subdir gains a new nested .git repo
  //    AND empty git repo (currentBranch === 'HEAD') immediately picks up real branch after first commit
  resetRepoInfoCache();
  const cachedSubBefore = await resolveRepoInfo(validSubdir);
  assert.equal(normalizeKey(cachedSubBefore.repoRoot), parentKey);
  initGitRepo(validSubdir, 'nested-br');
  const subAfterGitInit = await resolveRepoInfo(validSubdir);
  assert.equal(normalizeKey(subAfterGitInit.repoRoot), normalizeKey(validSubdir));
  assert.equal(subAfterGitInit.currentBranch, 'nested-br');

  const emptyRepo = join(tempRoot, 'empty-repo');
  mkdirSync(emptyRepo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: emptyRepo });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: emptyRepo });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: emptyRepo });
  const beforeCommit = await resolveRepoInfo(emptyRepo);
  assert.equal(beforeCommit.currentBranch, 'HEAD');
  writeFileSync(join(emptyRepo, 'first.txt'), 'hello\n', 'utf8');
  execFileSync('git', ['add', 'first.txt'], { cwd: emptyRepo });
  execFileSync('git', ['commit', '-m', 'first'], { cwd: emptyRepo });
  const afterCommit = await resolveRepoInfo(emptyRepo);
  assert.equal(afterCommit.currentBranch, 'main');
});

test('Issue #14 Review P1-2: archiveThread() seals terminal snapshot with zero LS RPC/full reads and archived getThreadMessages() extracts missing usage & heals legacy records', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-rev-p12-');
  const repoDir = join(tempRoot, 'seal-repo');
  initGitRepo(repoDir, 'main');
  const scopeKey = normalizeKey(repoDir);
  const ls = await startMockLs(t);

  const convSeal = 'conv-seal-arch-0001';
  const convLegacy = 'conv-legacy-arch-002';

  for (const [cid, summary] of [
    [convSeal, 'Sealed final conclusion cleanly.'],
    [convLegacy, 'Legacy archived conclusion recovered.'],
  ]) {
    writeTranscriptPair(
      appDataDir,
      cid,
      [
        { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Investigate issue</USER_REQUEST>' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-neon-high',
          input_tokens: 12000,
          cache_read_tokens: 48000,
          output_tokens: 1500,
          tool_calls: [{ name: 'read_file', args: { Path: '/demo/index.js' } }],
        },
        {
          step_index: 2,
          type: 'GENERIC',
          status: 'DONE',
          truncated_fields: ['content'],
          content: 'Showing lines 1-50 <truncated 30000 bytes>',
        },
        {
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          model: 'gemini-4-neon-high',
          input_tokens: 3000,
          cache_read_tokens: 60000,
          output_tokens: 900,
          content: `### Thread Summary\n${summary}`,
        },
      ],
      [{ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'HUGE_GENERIC_FULL_OUTPUT' }],
    );
  }

  const reg = loadRegistry();
  reg.coordinators[scopeKey] = {
    key: scopeKey,
    conversationId: 'conv-coord-seal',
    workspacePath: repoDir,
    repoRoot: repoDir,
  };
  reg.threads['thr-seal'] = {
    threadId: 'thr-seal',
    localId: 'thr-001',
    projectSeq: 1,
    conversationId: convSeal,
    coordinatorId: 'conv-coord-seal',
    workspaceKey: scopeKey,
    workspacePath: repoDir,
    repoRoot: repoDir,
    title: 'Running thread archived immediately',
    model: 'pro',
    modelDisplayName: 'Gemini 4 Neon (High)',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    activeTool: 'read_file',
    activeToolObj: { category: 'read', target: 'index.js' },
    hasPendingBgTask: true,
    lastSummary: '',
    toolStepCount: 0,
    usage: null,
    archived: false,
    createdAt: '2026-11-28T01:00:00Z',
    updatedAt: '2026-11-28T01:00:00Z',
  };
  // Legacy already-archived thread with modelDisplayName present, but missing usage + stale running state
  reg.threads['thr-legacy-arch'] = {
    threadId: 'thr-legacy-arch',
    localId: 'thr-002',
    projectSeq: 2,
    conversationId: convLegacy,
    coordinatorId: 'conv-coord-seal',
    workspaceKey: scopeKey,
    workspacePath: repoDir,
    repoRoot: repoDir,
    title: 'Legacy incomplete archived thread',
    model: 'pro',
    modelDisplayName: 'Gemini 4 Neon (High)',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    activeTool: 'run_command',
    hasPendingBgTask: true,
    lastSummary: '',
    toolStepCount: 0,
    usage: null,
    archived: true,
    createdAt: '2026-11-27T01:00:00Z',
    updatedAt: '2026-11-27T01:00:00Z',
  };
  saveRegistry(reg);

  // 1. archiveThread() seals terminal snapshot locally with 0 GetConversation / 0 GeneratorMetadata / 0 full reads
  ls.resetCounts();
  resetTranscriptCaches();
  const archRes = await archiveThread('thr-seal', {
    workspacePath: repoDir,
    workspaceKey: scopeKey,
    removeWorktree: false,
  });
  assert.equal(archRes.ok, true);
  assert.equal(archRes.archived, true);
  assert.equal(ls.getTotals().totalGetConv, 0, 'archiveThread must not call GetConversation');
  assert.equal(ls.getTotals().totalGenMeta, 0, 'archiveThread must not call GeneratorMetadata');
  assert.equal(getTranscriptCacheStats().fullTranscript, 0, 'archiveThread must not read transcript_full.jsonl');

  const sealed = loadRegistry().threads['thr-seal'];
  assert.equal(sealed.archived, true);
  assert.equal(sealed.runState, 'RUN_STATE_IDLE');
  assert.equal(sealed.bucket, 'archived');
  assert.equal(sealed.activeTool, '');
  assert.equal(sealed.hasPendingBgTask, false);
  assert.match(sealed.lastSummary, /Sealed final conclusion cleanly/);
  assert.ok(sealed.toolStepCount >= 1);
  assert.equal(sealed.usage?.totalTokens, 12000 + 48000 + 1500 + 3000 + 60000 + 900);

  // 2. getThreadMessages() on legacy archived thread (which already has modelDisplayName) extracts missing usage & heals state
  ls.resetCounts();
  resetTranscriptCaches();
  const legacyMsg = await getThreadMessages({
    threadId: 'thr-legacy-arch',
    workspacePath: repoDir,
    workspaceKey: scopeKey,
  });
  assert.equal(legacyMsg.ok, true);
  assert.equal(ls.getTotals().totalGetConv, 0, 'archived getThreadMessages must make 0 GetConversation RPCs');
  assert.equal(ls.getTotals().totalGenMeta, 0, 'archived getThreadMessages must make 0 GeneratorMetadata RPCs');
  assert.equal(getTranscriptCacheStats().fullTranscript, 0, 'GENERIC-only archived preview must not read full');
  assert.equal(legacyMsg.thread.runState, 'RUN_STATE_IDLE');
  assert.equal(legacyMsg.thread.bucket, 'archived');
  assert.equal(legacyMsg.thread.activeTool, '');
  assert.equal(legacyMsg.thread.hasPendingBgTask, false);
  assert.match(legacyMsg.thread.lastSummary, /Legacy archived conclusion recovered/);
  assert.equal(legacyMsg.thread.usage?.totalTokens, 12000 + 48000 + 1500 + 3000 + 60000 + 900);

  const healedDisk = loadRegistry().threads['thr-legacy-arch'];
  assert.equal(healedDisk.runState, 'RUN_STATE_IDLE');
  assert.equal(healedDisk.bucket, 'archived');
  assert.equal(healedDisk.usage?.totalTokens, 125400);
});

test('Issue #14 Review P1-3: sendThreadMessage() automatically unarchives awakened archived threads so they re-enter active polling', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-rev-p13-');
  const repoDir = join(tempRoot, 'wake-repo');
  initGitRepo(repoDir, 'main');
  const scopeKey = normalizeKey(repoDir);

  const convWakePlain = 'conv-wake-plain-001';
  const convWakeModel = 'conv-wake-model-002';
  const ls = await startMockLs(t, {
    runStates: {
      [convWakePlain]: 'RUN_STATE_IDLE',
      [convWakeModel]: 'RUN_STATE_IDLE',
    },
  });

  const reg = loadRegistry();
  reg.coordinators[scopeKey] = {
    key: scopeKey,
    conversationId: 'conv-coord-wake',
    workspacePath: repoDir,
    repoRoot: repoDir,
  };
  reg.threads['thr-wake-1'] = {
    threadId: 'thr-wake-1',
    localId: 'thr-001',
    projectSeq: 1,
    conversationId: convWakePlain,
    coordinatorId: 'conv-coord-wake',
    workspaceKey: scopeKey,
    workspacePath: repoDir,
    repoRoot: repoDir,
    title: 'Archived thread awakened via follow-up',
    model: 'pro',
    modelDisplayName: 'Gemini 4 Neon (High)',
    runState: 'RUN_STATE_IDLE',
    bucket: 'archived',
    archived: true,
    createdAt: '2026-11-28T01:00:00Z',
    updatedAt: '2026-11-28T01:00:00Z',
  };
  reg.threads['thr-wake-2'] = {
    threadId: 'thr-wake-2',
    localId: 'thr-002',
    projectSeq: 2,
    conversationId: convWakeModel,
    coordinatorId: 'conv-coord-wake',
    workspaceKey: scopeKey,
    workspacePath: repoDir,
    repoRoot: repoDir,
    title: 'Archived thread awakened with model switch',
    model: 'pro',
    modelDisplayName: 'Gemini 4 Neon (High)',
    runState: 'RUN_STATE_IDLE',
    bucket: 'archived',
    archived: true,
    createdAt: '2026-11-28T01:01:00Z',
    updatedAt: '2026-11-28T01:01:00Z',
  };
  saveRegistry(reg);

  // 1. Plain follow-up message wakes archived thread and clears archived=false
  const resPlain = await sendThreadMessage({
    threadId: 'thr-wake-1',
    message: 'Please run one more check',
    workspacePath: repoDir,
    workspaceKey: scopeKey,
  });
  assert.equal(resPlain.ok, true);
  assert.equal(resPlain.thread.archived, false);
  assert.equal(resPlain.thread.runState, 'RUN_STATE_RUNNING');
  assert.equal(resPlain.thread.bucket, 'working');
  assert.equal(loadRegistry().threads['thr-wake-1'].archived, false);

  // 2. Follow-up message with explicit model override also clears archived=false
  const resModel = await sendThreadMessage({
    threadId: 'thr-wake-2',
    message: 'Re-check with flash',
    model: 'gemini-3.8-flash-high',
    modelEnum: 'MODEL_PLACEHOLDER_M318',
    modelDisplayName: 'Gemini 3.8 Flash (High)',
    workspacePath: repoDir,
    workspaceKey: scopeKey,
  });
  assert.equal(resModel.ok, true);
  assert.equal(resModel.thread.archived, false);
  assert.equal(resModel.thread.runState, 'RUN_STATE_RUNNING');
  assert.equal(loadRegistry().threads['thr-wake-2'].archived, false);

  // Wait briefly for fire-and-forget UpdateConversation({ archived: false }) calls
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(
    ls.updateConvCalls.some((c) => c.conversationId === convWakePlain && c.annotations?.archived === false),
    'LS UpdateConversation must unarchive awakened plain thread',
  );
  assert.ok(
    ls.updateConvCalls.some((c) => c.conversationId === convWakeModel && c.annotations?.archived === false),
    'LS UpdateConversation must unarchive awakened model-switch thread',
  );

  // 3. Subsequent syncThreads() actively polls the awakened threads and transitions them back to RUN_STATE_IDLE
  ls.resetCounts();
  const snapAfterWake = await syncThreads({ workspacePath: repoDir, includeArchived: false });
  assert.equal(snapAfterWake.threads.length, 2);
  assert.equal(ls.getConvCalls.get(convWakePlain), 1, 'awakened thread must re-enter active syncThreads polling');
  assert.equal(ls.getConvCalls.get(convWakeModel), 1);
  assert.equal(loadRegistry().threads['thr-wake-1'].runState, 'RUN_STATE_IDLE');
  assert.equal(loadRegistry().threads['thr-wake-2'].runState, 'RUN_STATE_IDLE');
});

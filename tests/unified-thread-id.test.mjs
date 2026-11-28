import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { resetModelConfigCache } from '../lib/ls-client.mjs';
import {
  addDecision,
  archiveThread,
  buildBoardDecisions,
  dismissDecision,
  dispatchThread,
  executeDecisionAction,
  formatLocalThreadId,
  getThreadDetail,
  getThreadDisplayId,
  listDecisions,
  loadRegistry,
  normalizeKey,
  resolveDecision,
  resolveScopedThreadTarget,
  saveRegistry,
  sendThreadMessage,
  syncCompletionToCoordinator,
  syncThreads,
} from '../lib/store.mjs';
import { parseThreadTranscript } from '../lib/transcript.mjs';
import { buildBatchStallAlertMessage, buildStallAlertMessage, patrolProjectScope } from '../lib/watchdog.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function createTempEnv(t, prefix = 'pt-unified-id-') {
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

function startMockLs(t, { conversations = {} } = {}) {
  const created = [];
  const updateCalls = [];
  const sendCalls = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/product.v1.ConversationService/CreateConversation') {
        const id = `conv-uni-${created.length + 1}`;
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
        const found = conversations[cid];
        res.end(
          JSON.stringify({
            conversation: found || {
              id: cid,
              state: { runState: 'RUN_STATE_IDLE' },
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
      const address = `127.0.0.1:${server.address().port}`;
      process.env.ANTIGRAVITY_LS_ADDRESS = address;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-unified-id';
      t.after(() => new Promise((r) => server.close(r)));
      resolveListen({ address, csrfToken: 'csrf-unified-id', created, updateCalls, sendCalls });
    });
  });
}

function runMcpStdio(env, requests) {
  return new Promise((resolveProc, rejectProc) => {
    const child = spawn(process.execPath, ['mcp/server.mjs'], {
      cwd: REPO_ROOT,
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
    child.on('close', (status) => resolveProc({ status, stdout, stderr }));
    child.stdin.end(`${requests.map((r) => JSON.stringify(r)).join('\n')}\n`);
  });
}

function extractFunctionSource(source, fnName) {
  const start = source.indexOf(`function ${fnName}(`);
  assert.notEqual(start, -1, `${fnName} must exist in sidecars/threads/app.js`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unclosed function ${fnName}`);
}

test('Issue #12 (dec-034): Two brand-new projects + non-Git project each start at thr-001 with 4-surface alignment and ZERO storage/decision/watchdog/claim collision', async (t) => {
  const { tempRoot, appDataDir, stateDir, geminiDir } = createTempEnv(t, 'pt-uni-dual-');
  const mockLs = await startMockLs(t);
  const sendLog = join(tempRoot, 'agentapi-sends.jsonl');
  process.env.ANTIGRAVITY_AGENTAPI_EXE = writeMockAgentApi(tempRoot, sendLog);

  const repoA = join(tempRoot, 'project-alpha');
  const repoB = join(tempRoot, 'project-beta');
  initGitRepo(repoA);
  initGitRepo(repoB);
  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);

  // Seed Coordinators for both repos and a workspace-less conv: project
  const initReg = loadRegistry();
  initReg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'coord-alpha',
    projectId: 'proj-alpha',
    workspacePath: repoA,
    repoRoot: repoA,
    defaultBranch: 'main',
    title: '[Coordinator] Alpha',
  };
  initReg.coordinators[keyB] = {
    key: keyB,
    conversationId: 'coord-beta',
    projectId: 'proj-beta',
    workspacePath: repoB,
    repoRoot: repoB,
    defaultBranch: 'main',
    title: '[Coordinator] Beta',
  };
  initReg.coordinators['conv:coord-nogit'] = {
    key: 'conv:coord-nogit',
    conversationId: 'coord-nogit',
    workspacePath: '',
    repoRoot: '',
    title: '[Coordinator] NoGit',
  };
  saveRegistry(initReg);

  // Interleave dispatches across Project A, Project B, and NoGit Project
  const a1 = await dispatchThread({
    workspacePath: repoA,
    coordinatorId: 'coord-alpha',
    title: 'Alpha auth fix',
    taskPrompt: 'Fix alpha auth flow.',
    createWorktree: true,
    model: 'pro',
  });
  const b1 = await dispatchThread({
    workspacePath: repoB,
    coordinatorId: 'coord-beta',
    title: 'Beta billing fix',
    taskPrompt: 'Fix beta billing flow.',
    createWorktree: true,
    model: 'pro',
  });
  const c1 = await dispatchThread({
    coordinatorId: 'coord-nogit',
    conversationId: 'coord-nogit',
    title: 'NoGit research',
    taskPrompt: 'Research architecture options.',
    createWorktree: false,
    model: 'pro',
  });
  const a2 = await dispatchThread({
    workspacePath: repoA,
    coordinatorId: 'coord-alpha',
    title: 'Alpha cache layer',
    taskPrompt: 'Add cache layer.',
    createWorktree: false,
    model: 'pro',
  });
  const b2 = await dispatchThread({
    workspacePath: repoB,
    coordinatorId: 'coord-beta',
    title: 'Beta invoice export',
    taskPrompt: 'Export PDF invoices.',
    createWorktree: false,
    model: 'pro',
  });

  // 1. Verify 4-surface thr-001 / thr-002 alignment & zero cross-project sequence jumping
  assert.equal(a1.localId, 'thr-001');
  assert.equal(a1.displayId, 'thr-001');
  assert.equal(a1.displayTitle, '[thr-001] Alpha auth fix');
  assert.match(a1.branch, /^thread\/thr-001-alpha-auth-fix$/);
  assert.match(basename(a1.worktreePath), /^thr-001-alpha-auth-fix$/);

  assert.equal(b1.localId, 'thr-001');
  assert.equal(b1.displayId, 'thr-001');
  assert.equal(b1.displayTitle, '[thr-001] Beta billing fix');
  assert.match(b1.branch, /^thread\/thr-001-beta-billing-fix$/);
  assert.match(basename(b1.worktreePath), /^thr-001-beta-billing-fix$/);

  assert.equal(c1.localId, 'thr-001');
  assert.equal(c1.displayTitle, '[thr-001] NoGit research');
  assert.equal(a2.localId, 'thr-002');
  assert.equal(b2.localId, 'thr-002');

  // Verify Antigravity native CreateConversation titles, prompts, and worker-thread-context.md
  const createA1 = mockLs.created.find((c) => c.id === a1.conversationId);
  const createB1 = mockLs.created.find((c) => c.id === b1.conversationId);
  assert.equal(createA1?.payload?.title, '[thr-001] Alpha auth fix');
  assert.equal(createB1?.payload?.title, '[thr-001] Beta billing fix');
  const promptA1 = createA1?.payload?.initialUserMessage || createA1?.payload?.promptText || '';
  const promptB1 = createB1?.payload?.initialUserMessage || createB1?.payload?.promptText || '';
  if (promptA1) assert.match(promptA1, /\[thr-001\] Alpha auth fix/);
  if (promptB1) assert.match(promptB1, /\[thr-001\] Beta billing fix/);

  const ctxA1 = readFileSync(join(a1.worktreePath, '.agents', 'rules', 'worker-thread-context.md'), 'utf8');
  const ctxB1 = readFileSync(join(b1.worktreePath, '.agents', 'rules', 'worker-thread-context.md'), 'utf8');
  assert.match(ctxA1, /Active Worker Thread Context \(thr-001\)/);
  assert.match(ctxA1, /\*\*Thread ID\*\*: `thr-001`/);
  assert.doesNotMatch(ctxA1, /\bpt-[a-f0-9]{8}-/);
  assert.match(ctxB1, /Active Worker Thread Context \(thr-001\)/);
  assert.match(ctxB1, /\*\*Thread ID\*\*: `thr-001`/);
  assert.doesNotMatch(ctxB1, /\bpt-[a-f0-9]{8}-/);

  // 2. Verify globally unique internal keys in registry.json (ZERO overwrite between Project A & B thr-001)
  assert.notEqual(a1.threadId, b1.threadId);
  assert.notEqual(a1.threadId, c1.threadId);
  assert.notEqual(b1.threadId, c1.threadId);
  const reg = loadRegistry();
  assert.equal(Object.keys(reg.threads).length, 5);
  assert.equal(reg.threads[a1.threadId].workspaceKey, keyA);
  assert.equal(reg.threads[b1.threadId].workspaceKey, keyB);

  // 3. Decisions isolation for dual thr-001
  const decA = addDecision({
    workspacePath: repoA,
    coordinatorId: 'coord-alpha',
    threadId: 'thr-001',
    title: 'Approve Alpha merge?',
  });
  const decB = addDecision({
    workspacePath: repoB,
    coordinatorId: 'coord-beta',
    threadId: 'thr-001',
    title: 'Approve Beta merge?',
  });
  assert.equal(decA.threadId, a1.threadId);
  assert.equal(decB.threadId, b1.threadId);
  assert.equal(decA.threadLocalId, 'thr-001');
  assert.equal(decB.threadLocalId, 'thr-001');
  assert.match(decA.options[0].message, /thr-001/);
  assert.doesNotMatch(decA.options[0].message, /\bpt-[a-f0-9]{8}-/);

  // Dismissing an auto decision on Project A's thr-001 must NEVER dismiss Project B's thr-001
  dismissDecision({
    threadId: a1.threadId,
    autoKind: 'worktree_archive_ready',
    lastCommit: '__no_commit__',
    workspaceKey: keyA,
  });
  const regAfterDismiss = loadRegistry();
  assert.ok(regAfterDismiss.dismissedAutoDecisions[`${a1.threadId}:worktree_archive_ready`]);
  assert.equal(regAfterDismiss.dismissedAutoDecisions[`${b1.threadId}:worktree_archive_ready`], undefined);

  // Executing decision on Project B's thr-001 sends [Decision thr-001] to coord-beta (zero pt-... leakage)
  const execB = await executeDecisionAction({
    decisionId: decB.id,
    optionId: decB.options[0].id,
    workspacePath: repoB,
    coordinatorId: 'coord-beta',
  });
  assert.equal(execB.ok, true);
  assert.equal(execB.coordinatorId, 'coord-beta');
  assert.equal(listDecisions({ workspacePath: repoA }).length, 1, 'Project A decision must stay pending');
  assert.equal(listDecisions({ workspacePath: repoB }).length, 0, 'Project B decision must resolve');

  // 4. Concurrent completion callbacks for BOTH thr-001 threads with IDENTICAL step_index & identical summary text -> ZERO .claim lock collision!
  const sharedSteps = [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>Work</USER_REQUEST>' },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'Done!\n\n### Thread Summary\n- Fixed root cause cleanly.',
    },
  ];
  writeTranscript(appDataDir, a1.conversationId, sharedSteps);
  writeTranscript(appDataDir, b1.conversationId, sharedSteps);

  const [syncA, syncB] = await Promise.all([
    syncCompletionToCoordinator({ threadId: a1.threadId, force: false, timeoutMs: 6000 }),
    syncCompletionToCoordinator({ threadId: b1.threadId, force: false, timeoutMs: 6000 }),
  ]);
  assert.equal(syncA.ok, true);
  assert.equal(syncA.synced, true);
  assert.equal(syncA.localId, 'thr-001');
  assert.equal(syncA.coordinatorId, 'coord-alpha');

  assert.equal(syncB.ok, true);
  assert.equal(syncB.synced, true);
  assert.equal(syncB.localId, 'thr-001');
  assert.equal(syncB.coordinatorId, 'coord-beta');

  // Inspect claim files: two distinct scope-hashed claim files, zero collision
  const claimsDir = join(stateDir, 'sync-claims');
  const claimFiles = readdirSync(claimsDir);
  assert.ok(claimFiles.some((f) => f.startsWith(`${a1.threadId}-step-3`)));
  assert.ok(claimFiles.some((f) => f.startsWith(`${b1.threadId}-step-3`)));

  // Inspect sent agentapi payloads: unified thr-001, zero middle dots, zero internal pt-... leakage
  const rawSends = readFileSync(sendLog, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(rawSends.length, 3, '1 decision + 2 completion callbacks');
  for (const argv of rawSends) {
    const joined = argv.join(' ');
    assert.equal(joined.includes('\u00b7'), false, 'AgentAPI callback/decision payload must contain zero middle dots');
    assert.doesNotMatch(joined, /\bpt-[a-f0-9]{8}-/, 'External payload must never expose internal scoped thread key');
  }
  const completionPayloads = rawSends.filter((a) => a.join(' ').includes('[THREAD_COMPLETION_SYNC]'));
  assert.equal(completionPayloads.length, 2);
  for (const argv of completionPayloads) {
    const joined = argv.join(' ');
    assert.match(joined, /Worker thread `thr-001` has finished/);
    assert.match(joined, /\[thr-001 Completed\]/);
    assert.match(joined, /\[thr-001\].*— Completed/);
  }

  // 5. Watchdog isolation for dual thr-001 + unified thr-001 alert output
  const t0 = Date.parse('2026-11-28T18:00:00.000Z');
  const wdReg = loadRegistry();
  wdReg.threads[a2.threadId].runState = 'RUN_STATE_RUNNING';
  wdReg.threads[a2.threadId].bucket = 'working';
  wdReg.threads[a2.threadId].createdAt = new Date(t0 - 20 * 60_000).toISOString();
  wdReg.threads[a2.threadId].updatedAt = new Date(t0 - 15 * 60_000).toISOString();
  wdReg.threads[b2.threadId].runState = 'RUN_STATE_RUNNING';
  wdReg.threads[b2.threadId].bucket = 'working';
  wdReg.threads[b2.threadId].createdAt = new Date(t0 - 20 * 60_000).toISOString();
  wdReg.threads[b2.threadId].updatedAt = new Date(t0 - 15 * 60_000).toISOString();
  saveRegistry(wdReg);
  writeTranscript(appDataDir, a2.conversationId, [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Stall A</USER_REQUEST>' },
  ]);
  writeTranscript(appDataDir, b2.conversationId, [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Stall B</USER_REQUEST>' },
  ]);

  const wdAlerts = [];
  const makeWdDeps = (coordId) => ({
    now: () => t0,
    getConversation: async (cid) => ({
      conversation: {
        id: cid,
        state:
          cid === coordId
            ? { runState: 'RUN_STATE_IDLE' }
            : { runState: 'RUN_STATE_RUNNING', updateTime: new Date(t0 - 15 * 60_000).toISOString() },
      },
    }),
    invokeAgentApiSend: async (args) => {
      wdAlerts.push(args);
      return { queued: true };
    },
  });

  const patA = await patrolProjectScope(keyA, { deps: makeWdDeps('coord-alpha') });
  const patB = await patrolProjectScope(keyB, { deps: makeWdDeps('coord-beta') });
  assert.equal(patA.alertedCount, 1);
  assert.equal(patB.alertedCount, 1);
  assert.equal(wdAlerts.length, 2);
  assert.equal(wdAlerts[0].conversationId, 'coord-alpha');
  assert.equal(wdAlerts[1].conversationId, 'coord-beta');
  for (const alert of wdAlerts) {
    assert.match(alert.title, /^\[Watchdog thr-002\]/);
    assert.match(alert.message, /`thr-002`/);
    assert.doesNotMatch(alert.message, /\bpt-[a-f0-9]{8}-/);
    assert.doesNotMatch(alert.message, /\(#2\)/);
    assert.equal(alert.message.includes('\u00b7'), false);
  }
  const latestReg = loadRegistry();
  assert.ok(latestReg.watchdogState[keyA].threads[a2.threadId]);
  assert.ok(latestReg.watchdogState[keyB].threads[b2.threadId]);
  assert.equal(latestReg.watchdogState[keyA].threads[b2.threadId], undefined);
  assert.equal(latestReg.watchdogState[keyB].threads[a2.threadId], undefined);

  // Verify PreInvocation fallback bullet uses unified thr-002 (never internal pt-...)
  latestReg.threads[a2.threadId].runState = 'RUN_STATE_IDLE';
  latestReg.threads[a2.threadId].lastCompletedAt = new Date(t0).toISOString();
  latestReg.threads[a2.threadId].lastSummary = 'Fallback ready';
  latestReg.coordinators[keyA].directiveVersion = 18;
  saveRegistry(latestReg);
  const hookRes = spawnSync(process.execPath, ['scripts/hook-handler.mjs', 'PreInvocation'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_APP_DATA_DIR: appDataDir,
    },
    input: JSON.stringify({
      hookEventName: 'PreInvocation',
      conversationId: 'coord-alpha',
      initialNumSteps: 5,
    }),
    encoding: 'utf8',
  });
  assert.equal(hookRes.status, 0);
  const hookJson = JSON.parse(hookRes.stdout.trim());
  const injectedAll = (hookJson.injectSteps || [])
    .map((s) => s?.systemMessage?.systemMessage || '')
    .join('\n');
  assert.match(injectedAll, /\[Project Threads Update\][\s\S]*\*\*`thr-002`\*\*/);
  assert.doesNotMatch(injectedAll, /\bpt-[a-f0-9]{8}-/);

  // 6. Cross-project fail-closed guards remain airtight
  await assert.rejects(
    () => resolveScopedThreadTarget({ threadId: a1.threadId, workspacePath: repoB }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () => resolveScopedThreadTarget({ threadId: a1.conversationId, workspacePath: repoB }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () => resolveScopedThreadTarget({ threadId: 'thr-001', requireScope: true }),
    /Project scope is required \(fail-closed\)/,
  );
  await assert.rejects(
    () => resolveScopedThreadTarget({ threadId: 'thr-001', workspacePath: repoA, projectId: 'proj-beta' }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () => resolveScopedThreadTarget({ threadId: 'thr-002', coordinatorId: 'coord-nogit' }),
    /Thread not found in project scope/,
  );
});

test('Issue #12: Existing legacy repo continues from max(projectSeqs, maxLegacyThrNum, count) + 1 without collision, and createGitWorktree disambiguates orphan branch/dir collisions', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-uni-legacy-');
  await startMockLs(t);

  const oldRepo = join(tempRoot, 'legacy-repo');
  const freshRepo = join(tempRoot, 'fresh-repo');
  initGitRepo(oldRepo);
  initGitRepo(freshRepo);
  const keyOld = normalizeKey(oldRepo);

  // Seed legacy repo with pre-Issue-#12 threads up to thr-094 (including archived & Issue-#4 #N records)
  const reg = loadRegistry();
  reg.seq = 94;
  reg.projectSeqs = { [keyOld]: 80 };
  reg.coordinators[keyOld] = {
    key: keyOld,
    conversationId: 'coord-old',
    workspacePath: oldRepo,
    repoRoot: oldRepo,
    defaultBranch: 'main',
    title: '[Coordinator] LegacyRepo',
  };
  reg.threads = {
    'thr-005': {
      threadId: 'thr-005',
      conversationId: 'conv-old-005',
      coordinatorId: 'coord-old',
      workspaceKey: keyOld,
      title: 'Old archived 5',
      archived: true,
      runState: 'RUN_STATE_IDLE',
      createdAt: '2026-10-01T00:00:00.000Z',
    },
    'thr-083': {
      threadId: 'thr-083',
      projectSeq: 71,
      localId: '#71',
      conversationId: 'conv-old-083',
      coordinatorId: 'coord-old',
      workspaceKey: keyOld,
      branch: 'thread/thr-083-legacy',
      title: 'Old Issue #4 thread 83',
      archived: false,
      runState: 'RUN_STATE_IDLE',
      createdAt: '2026-11-10T00:00:00.000Z',
    },
    'thr-094': {
      threadId: 'thr-094',
      projectSeq: 80,
      localId: '#80',
      conversationId: 'conv-old-094',
      coordinatorId: 'coord-old',
      workspaceKey: keyOld,
      branch: 'thread/thr-094-latest-legacy',
      title: 'Old Issue #4 thread 94',
      archived: true,
      runState: 'RUN_STATE_IDLE',
      createdAt: '2026-11-20T00:00:00.000Z',
    },
  };
  saveRegistry(reg);

  // 1. Existing legacy repo's next thread MUST start at thr-095 (never collides with thr-083 or thr-094!)
  const nextOld1 = await dispatchThread({
    workspacePath: oldRepo,
    coordinatorId: 'coord-old',
    title: 'Post upgrade feature',
    taskPrompt: 'Implement feature safely.',
    createWorktree: true,
    model: 'pro',
  });
  assert.equal(nextOld1.projectSeq, 95);
  assert.equal(nextOld1.localId, 'thr-095');
  assert.equal(nextOld1.displayTitle, '[thr-095] Post upgrade feature');
  assert.match(nextOld1.branch, /^thread\/thr-095-post-upgrade-feature$/);

  // 2. Brand-new repo dispatched right after STILL starts cleanly at thr-001!
  const fresh1 = await dispatchThread({
    workspacePath: freshRepo,
    coordinatorId: 'coord-fresh',
    title: 'Fresh start',
    taskPrompt: 'Start clean.',
    createWorktree: false,
    model: 'pro',
  });
  assert.equal(fresh1.projectSeq, 1);
  assert.equal(fresh1.localId, 'thr-001');
  assert.equal(fresh1.displayTitle, '[thr-001] Fresh start');

  // 3. Old repo's next thread continues linearly at thr-096 (immune to freshRepo's dispatch!)
  const nextOld2 = await dispatchThread({
    workspacePath: oldRepo,
    coordinatorId: 'coord-old',
    title: 'Follow-up feature',
    taskPrompt: 'Continue linearly.',
    createWorktree: false,
    model: 'pro',
  });
  assert.equal(nextOld2.projectSeq, 96);
  assert.equal(nextOld2.localId, 'thr-096');

  // 4. 4-digit rollover (>999) formats cleanly as thr-1000
  assert.equal(formatLocalThreadId(999), 'thr-999');
  assert.equal(formatLocalThreadId(1000), 'thr-1000');

  // 5. Branch & worktree anti-collision disambiguation (e.g. after local registry reset)
  const collideRepo = join(tempRoot, 'collide-repo');
  initGitRepo(collideRepo);
  // Pre-create orphan branch `thread/thr-001-collision-task` AND orphan dir `thr-001-collision-task-2`
  execFileSync('git', ['branch', 'thread/thr-001-collision-task'], { cwd: collideRepo });
  const orphanDir = join(tempRoot, '.worktrees', 'collide-repo', 'thr-001-collision-task-2');
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(join(orphanDir, 'keep.txt'), 'do not overwrite\n', 'utf8');

  const disamb = await dispatchThread({
    workspacePath: collideRepo,
    coordinatorId: 'coord-collide',
    title: 'Collision task',
    taskPrompt: 'Create disambiguated worktree.',
    createWorktree: true,
    model: 'pro',
  });
  assert.equal(disamb.localId, 'thr-001');
  assert.equal(disamb.branch, 'thread/thr-001-collision-task-3');
  assert.equal(basename(disamb.worktreePath), 'thr-001-collision-task-3');
  assert.equal(readFileSync(join(orphanDir, 'keep.txt'), 'utf8'), 'do not overwrite\n');

  // Explicit requested branch still reuses existing branch as expected
  execFileSync('git', ['branch', 'custom/reuse-branch'], { cwd: collideRepo });
  const explicitBr = await dispatchThread({
    workspacePath: collideRepo,
    coordinatorId: 'coord-collide',
    title: 'Reuse explicit',
    taskPrompt: 'Use explicit branch.',
    branch: 'custom/reuse-branch',
    createWorktree: true,
    model: 'pro',
  });
  assert.equal(explicitBr.branch, 'custom/reuse-branch');
});

test('Issue #12: All 4 lookup formats (thr-NNN, #N, global/internal threadId, conversationId) hit accurately across store & MCP, and transcript parser handles all formats', async (t) => {
  const { tempRoot, geminiDir, appDataDir } = createTempEnv(t, 'pt-uni-lookup-');
  const mockLs = await startMockLs(t);

  const repoA = join(tempRoot, 'lookup-alpha');
  const repoB = join(tempRoot, 'lookup-beta');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);

  const seed = loadRegistry();
  seed.seq = 83;
  seed.projectSeqs = { [keyA]: 71 };
  seed.coordinators[keyA] = {
    key: keyA,
    conversationId: 'coord-l-a',
    projectId: 'proj-l-a',
    workspacePath: repoA,
    repoRoot: repoA,
    title: '[Coordinator] LookupA',
  };
  seed.coordinators[keyB] = {
    key: keyB,
    conversationId: 'coord-l-b',
    projectId: 'proj-l-b',
    workspacePath: repoB,
    repoRoot: repoB,
    title: '[Coordinator] LookupB',
  };
  seed.threads = {
    'thr-083': {
      threadId: 'thr-083',
      projectSeq: 71,
      localId: '#71',
      conversationId: 'conv-legacy-083',
      coordinatorId: 'coord-l-a',
      workspaceKey: keyA,
      projectId: 'proj-l-a',
      title: 'Legacy 83',
      runState: 'RUN_STATE_IDLE',
      archived: false,
      createdAt: '2026-11-20T00:00:00.000Z',
    },
  };
  saveRegistry(seed);

  const newA = await dispatchThread({
    workspacePath: repoA,
    coordinatorId: 'coord-l-a',
    title: 'Unified A 84',
    taskPrompt: 'Test lookup A.',
    createWorktree: false,
    model: 'pro',
  });
  const newB = await dispatchThread({
    workspacePath: repoB,
    coordinatorId: 'coord-l-b',
    title: 'Unified B 1',
    taskPrompt: 'Test lookup B.',
    createWorktree: false,
    model: 'pro',
  });
  assert.equal(newA.localId, 'thr-084');
  assert.equal(newB.localId, 'thr-001');

  // 1. All 4 lookup formats for new unified thread in Project B
  for (const ref of ['thr-001', 'THR-001', 'thr-1', '#1', newB.threadId, newB.conversationId]) {
    const res = await resolveScopedThreadTarget({ threadId: ref, workspacePath: repoB });
    assert.equal(res.thread.threadId, newB.threadId, `Project B ref "${ref}" must resolve to newB`);
  }

  // 2. All 4 lookup formats for legacy thread in Project A
  for (const ref of ['thr-083', '#71', 'conv-legacy-083']) {
    const res = await resolveScopedThreadTarget({ threadId: ref, workspacePath: repoA });
    assert.equal(res.thread.threadId, 'thr-083', `Project A legacy ref "${ref}" must resolve to thr-083`);
  }
  // And for newA (thr-084 / #84)
  for (const ref of ['thr-084', '#84', newA.threadId, newA.conversationId]) {
    const res = await resolveScopedThreadTarget({ threadId: ref, workspacePath: repoA });
    assert.equal(res.thread.threadId, newA.threadId, `Project A unified ref "${ref}" must resolve to newA`);
  }

  // 3. MCP stdio server outputs clean unified thr-NNN (zero dual-track `#N (thr-xxx)`, zero `pt-...`)
  const mcpRes = await runMcpStdio(
    {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_APP_DATA_DIR: appDataDir,
      ANTIGRAVITY_LS_ADDRESS: mockLs.address,
      ANTIGRAVITY_CSRF_TOKEN: mockLs.csrfToken,
    },
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_threads', arguments: { workspacePath: repoB } },
      },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_thread_detail', arguments: { threadId: 'thr-001', workspacePath: repoB } },
      },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'send_thread_message',
          arguments: { threadId: 'thr-001', message: 'check status', workspacePath: repoB },
        },
      },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'manage_decisions',
          arguments: {
            action: 'add',
            workspacePath: repoB,
            coordinatorId: 'coord-l-b',
            threadId: 'thr-001',
            title: 'Ship Beta thr-001?',
          },
        },
      },
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'manage_decisions',
          arguments: { action: 'list', workspacePath: repoB, coordinatorId: 'coord-l-b' },
        },
      },
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'archive_thread', arguments: { threadId: 'thr-001', workspacePath: repoB } },
      },
      // Cross-project check via MCP: repoB cannot access repoA's thr-083
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'get_thread_detail', arguments: { threadId: 'thr-083', workspacePath: repoB } },
      },
    ],
  );
  assert.equal(mcpRes.status, 0, mcpRes.stderr);
  const msgs = mcpRes.stdout
    .trim()
    .split(/\r?\n/)
    .map((l) => JSON.parse(l));

  const listText = msgs.find((m) => m.id === 2)?.result?.content?.[0]?.text || '';
  assert.match(listText, /\| `thr-001` \|/);
  assert.doesNotMatch(listText, /\bpt-[a-f0-9]{8}-/);
  assert.doesNotMatch(listText, /`#1`/);

  const detailObj = msgs.find((m) => m.id === 3)?.result?.structuredContent;
  assert.equal(detailObj?.threadId, newB.threadId);
  assert.equal(detailObj?.localId, 'thr-001');

  const sendText = msgs.find((m) => m.id === 4)?.result?.content?.[0]?.text || '';
  assert.match(sendText, /\*\*`thr-001`\*\*/);
  assert.doesNotMatch(sendText, /\bpt-[a-f0-9]{8}-/);

  const decAddText = msgs.find((m) => m.id === 5)?.result?.content?.[0]?.text || '';
  assert.match(decAddText, /Linked Thread: `thr-001`/);
  assert.doesNotMatch(decAddText, /\bpt-[a-f0-9]{8}-/);

  const decListText = msgs.find((m) => m.id === 6)?.result?.content?.[0]?.text || '';
  assert.match(decListText, /\| `thr-001` \|/);
  assert.doesNotMatch(decListText, /\bpt-[a-f0-9]{8}-/);

  const archText = msgs.find((m) => m.id === 7)?.result?.content?.[0]?.text || '';
  assert.match(archText, /Archived thread `thr-001`/);
  assert.doesNotMatch(archText, /\bpt-[a-f0-9]{8}-/);

  const crossErr = msgs.find((m) => m.id === 8)?.result;
  assert.equal(crossErr?.isError, true);
  assert.match(crossErr?.content?.[0]?.text || '', /Cross-project access denied/);

  // 4. Transcript parser handles thr-NNN, thr-1000, and legacy #N callback formats seamlessly
  const coordConv = 'conv-tx-parse-coord';
  const nowIso = new Date().toISOString();
  writeTranscript(appDataDir, coordConv, [
    {
      step_index: 1,
      type: 'SYSTEM_MESSAGE',
      created_at: nowIso,
      content:
        '[Message] content=[THREAD_COMPLETION_SYNC] Worker thread `thr-001` has finished.\n- **Task Title**: Unified task',
    },
    {
      step_index: 2,
      type: 'SYSTEM_MESSAGE',
      created_at: nowIso,
      content:
        '[Message] content=[THREAD_COMPLETION_SYNC] Worker thread `#71` has finished.\n- **Task Title**: Legacy hash task',
    },
    {
      step_index: 3,
      type: 'SYSTEM_MESSAGE',
      created_at: nowIso,
      content:
        '[Message] content=[THREAD_COMPLETION_SYNC] Worker thread `thr-1000` has finished.\n- **Task Title**: Four digit task',
    },
  ]);
  const parsed = parseThreadTranscript(coordConv);
  const taskItems = parsed.items.filter((x) => x.kind === 'task_result');
  assert.equal(taskItems.length, 3);
  assert.equal(taskItems[0].taskId, 'thr-001');
  assert.equal(taskItems[0].title, '[thr-001 Completed] Unified task');
  assert.equal(taskItems[1].taskId, '#71');
  assert.equal(taskItems[1].title, '[#71 Completed] Legacy hash task');
  assert.equal(taskItems[2].taskId, 'thr-1000');
  assert.equal(taskItems[2].title, '[thr-1000 Completed] Four digit task');
});

test('Issue #12: Sidecar UI unified thr-NNN rendering, zero U+00B7 middle dots across all runtime/protocol files, rev 8 / directive v18, and strict LF endings', () => {
  const appSource = readFileSync(join(REPO_ROOT, 'sidecars/threads/app.js'), 'utf8');
  const mainSource = readFileSync(join(REPO_ROOT, 'sidecars/threads/main.mjs'), 'utf8');
  const hookSource = readFileSync(join(REPO_ROOT, 'scripts/hook-handler.mjs'), 'utf8');

  // 1. Version & capability alignment
  assert.match(hookSource, /const\s+DIRECTIVE_VERSION\s*=\s*18\s*;/);
  assert.match(mainSource, /const\s+SERVER_API_REVISION\s*=\s*8\s*;/);
  assert.match(mainSource, /['"]unified_local_thread_id['"]/);
  assert.match(mainSource, /['"]topic_memory['"]/);
  assert.match(mainSource, /['"]watchdog_patrol['"]/);
  assert.match(appSource, /const\s+EXPECTED_SERVER_API_REVISION\s*=\s*8\s*;/);

  // 2. Global ZERO U+00B7 middle-dot guard across all runtime source & protocol files
  const scanDirs = ['lib', 'mcp', 'scripts', 'sidecars/threads', 'skills', 'rules'];
  const collectFiles = (relDir) => {
    const absDir = join(REPO_ROOT, relDir);
    const out = [];
    for (const ent of readdirSync(absDir, { withFileTypes: true })) {
      const childRel = `${relDir}/${ent.name}`;
      if (ent.isDirectory()) out.push(...collectFiles(childRel));
      else if (/\.(?:mjs|js|md|html|css|json|sh|cmd)$/i.test(ent.name)) out.push(childRel);
    }
    return out;
  };
  const checkedFiles = scanDirs.flatMap(collectFiles);
  assert.ok(checkedFiles.length >= 15, 'must scan all runtime & protocol files');
  for (const relPath of checkedFiles) {
    const text = readFileSync(join(REPO_ROOT, relPath), 'utf8');
    assert.equal(
      text.includes('\u00b7'),
      false,
      `${relPath} must contain ZERO U+00B7 middle dot characters`,
    );
  }

  // 3. Sidecar UI renders unified thr-001 across all components (zero pt-... leakage, zero #1 (thr-xxx))
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
  const fns = [
    'renderSwarmRow',
    'getLocalizedDecisionDisplay',
    'renderDecisionsPanelHtml',
    'renderO2ThreadCard',
    'renderWorktreeCard',
    'renderThreadHeader',
    'openWorktreeModal',
  ]
    .map((n) => extractFunctionSource(appSource, n))
    .join('\n');

  const els = {
    'chat-tid': { textContent: '', title: '', dataset: {} },
    'chat-title-text': { textContent: '', title: '' },
    'chat-status-dot': { className: '' },
    'btn-archive-cur': { hidden: false },
    'btn-clean-wt-cur': { hidden: false, textContent: '', title: '' },
    'composer-meta': { innerHTML: '', dataset: {} },
  };
  const modalEls = {
    elModalRebindBox: { hidden: false },
    elModalTitle: { textContent: '' },
    elModalClose: { title: '', disabled: false },
    elModalCancel: { textContent: '', disabled: false, focus() {} },
    elModalThread: { textContent: '' },
    elModalWtInfo: { innerHTML: '' },
    elModalWarn: { hidden: false, textContent: '' },
    elModalRemoveRow: { hidden: false },
    elModalRemoveWt: { checked: false, disabled: false },
    elLblModalRemoveWt: { textContent: '' },
    elModalBranchRow: { hidden: false },
    elModalDelBranch: { checked: false, disabled: false },
    elLblModalDelBranch: { textContent: '' },
    elModalForceRow: { hidden: false },
    elModalForceWt: { checked: false, disabled: false },
    elLblModalForceWt: { textContent: '' },
    elModalConfirm: { textContent: '', className: '', disabled: false, focus() {} },
    elModalErr: { hidden: false, textContent: '' },
    elModalBackdrop: { hidden: true },
  };

  const ctx = { els, ...modalEls };
  vm.runInNewContext(
    `
    ${i18nCode};
    let curLocale = 'zh-CN';
    const L = () => I18N[curLocale] || I18N.en;
    const ICONS = { chevronDown:'', chevronRight:'', close:'', check:'', doneCheck:'', archCheck:'', rowSpinner:'', waitAlert:'', branch:'', folder:'', popout:'', plus:'' };
    const pendingDecisionIds = new Set();
    const pendingModelByThread = new Map();
    let openThreadObj = null;
    let modelMenuOpen = false;
    let activeModalCtx = null;
    const elLiveBar = { hidden: false };
    const document = { getElementById: (id) => els[id] || null };
    const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    const isThreadCardOpen = () => false;
    const getActiveMainWorkerConvId = () => '';
    const relTime = () => '1m';
    const renderSegmentedMbar = () => '';
    const cleanGoalSnippet = () => '';
    const computeInlineSubtitle = () => 'Ready';
    const formatModelDisplay = (m) => m || 'Pro';
    const renderThreadUsageRow = () => '';
    const updateCoordinatorControls = () => {};
    const syncSendButtonState = () => {};
    const renderModelMenu = () => {};
    const syncModalConfirmButton = () => {};
    ${fns}
    this.api = { renderSwarmRow, getLocalizedDecisionDisplay, renderDecisionsPanelHtml, renderO2ThreadCard, renderWorktreeCard, renderThreadHeader, openWorktreeModal };
    `,
    ctx,
  );

  const threadB1 = {
    threadId: 'pt-bbbb2222-thr-001',
    projectSeq: 1,
    localId: 'thr-001',
    displayId: 'thr-001',
    conversationId: 'conv-ui-b1',
    title: 'Beta unified thread',
    bucket: 'idle',
    runState: 'RUN_STATE_IDLE',
    branch: 'thread/thr-001-beta-unified-thread',
    worktreePath: '/tmp/wt/thr-001-beta-unified-thread',
    git: { exists: true, aheadCount: 0, dirtyCount: 0, merged: true },
  };

  const cardHtml = ctx.api.renderO2ThreadCard(threadB1);
  assert.match(cardHtml, /data-th-card="pt-bbbb2222-thr-001"/);
  assert.match(cardHtml, /<span class="o2-tid" title="thr-001" data-thread-id="pt-bbbb2222-thr-001">thr-001<\/span>/);
  assert.equal(cardHtml.includes('\u00b7'), false);

  const rowHtml = ctx.api.renderSwarmRow(threadB1);
  assert.match(rowHtml, /<span class="tid-pill" title="thr-001" data-thread-id="pt-bbbb2222-thr-001">thr-001<\/span>/);

  const wtHtml = ctx.api.renderWorktreeCard(threadB1);
  assert.match(wtHtml, /<span class="tid-pill" title="thr-001" data-thread-id="pt-bbbb2222-thr-001">thr-001<\/span>/);

  ctx.api.renderThreadHeader(threadB1);
  assert.equal(els['chat-tid'].textContent, 'thr-001');
  assert.equal(els['chat-tid'].title, 'thr-001');
  assert.equal(els['chat-tid'].dataset.threadId, 'pt-bbbb2222-thr-001');
  assert.equal(els['chat-title-text'].title, '[thr-001] Beta unified thread');

  const decHtml = ctx.api.renderDecisionsPanelHtml([
    {
      id: 'dec-010',
      source: 'explicit',
      threadId: 'pt-bbbb2222-thr-001',
      threadProjectSeq: 1,
      threadLocalId: 'thr-001',
      title: 'Merge Beta?',
      options: [{ id: 'ok', label: 'Merge', action: 'send_coordinator', style: 'primary' }],
    },
  ]);
  assert.match(decHtml, /data-dec-thread="pt-bbbb2222-thr-001"/);
  assert.match(decHtml, />thr-001<\/button>/);
  assert.doesNotMatch(decHtml, /title="[^"]*pt-bbbb2222/);

  ctx.api.openWorktreeModal({ mode: 'archive', thread: threadB1 });
  assert.equal(modalEls.elModalThread.textContent, '[thr-001] Beta unified thread');

  // P2-1: getLocalizedDecisionDisplay empty threadTitle fallback never leaks internal pt-<hash>- key
  const emptyTitleMerge = ctx.api.getLocalizedDecisionDisplay({
    source: 'auto',
    autoKind: 'worktree_merge_ready',
    threadId: 'pt-bbbb2222-thr-001',
    threadLocalId: 'thr-001',
    threadTitle: '',
    branch: 'thread/thr-001-x',
    aheadCount: 2,
    options: [],
  });
  assert.match(emptyTitleMerge.summary, /thr-001/);
  assert.doesNotMatch(emptyTitleMerge.summary, /pt-bbbb2222/);
  const emptyTitleArchive = ctx.api.getLocalizedDecisionDisplay({
    source: 'auto',
    autoKind: 'worktree_archive_ready',
    threadId: 'pt-bbbb2222-thr-001',
    threadProjectSeq: 1,
    threadTitle: '',
    branch: 'thread/thr-001-x',
    aheadCount: 0,
    options: [],
  });
  assert.match(emptyTitleArchive.summary, /thr-001/);
  assert.doesNotMatch(emptyTitleArchive.summary, /pt-bbbb2222/);

  // Also verify buildStallAlertMessage & buildBatchStallAlertMessage display unified thr-001
  const singleWd = buildStallAlertMessage(
    {
      threadId: 'pt-bbbb2222-thr-001',
      localId: 'thr-001',
      title: 'Beta unified thread',
      stallReason: 'no_progress_running',
      stalledDurationMs: 600_000,
    },
    'zh-CN',
  );
  assert.match(singleWd, /`thr-001`/);
  assert.doesNotMatch(singleWd, /pt-bbbb2222/);
  assert.equal(singleWd.includes('\u00b7'), false);

  const batchWd = buildBatchStallAlertMessage(
    [
      { threadId: 'pt-bbbb2222-thr-001', localId: 'thr-001', title: 'B1', stallReason: 'no_progress_running', stalledDurationMs: 600_000 },
      { threadId: 'pt-bbbb2222-thr-002', localId: 'thr-002', title: 'B2', stallReason: 'no_progress_running', stalledDurationMs: 600_000 },
    ],
    'en',
  );
  assert.match(batchWd, /`thr-001`, `thr-002`/);
  assert.doesNotMatch(batchWd, /pt-bbbb2222/);
  assert.equal(batchWd.includes('\u00b7'), false);

  // Verify getThreadDisplayId helper edge cases
  assert.equal(getThreadDisplayId({ threadId: 'pt-12345678-thr-001', projectSeq: 1, localId: 'thr-001' }), 'thr-001');
  assert.equal(getThreadDisplayId({ threadId: 'pt-12345678-thr-001', projectSeq: 1 }), 'thr-001');
  assert.equal(getThreadDisplayId({ threadId: 'thr-083', projectSeq: 71, localId: '#71' }), 'thr-083');
  assert.equal(getThreadDisplayId({ threadId: 'thr-012' }), 'thr-012');

  // 4. Strict LF check on all .mjs files
  const allMjs = [
    'lib/store.mjs',
    'lib/transcript.mjs',
    'lib/watchdog.mjs',
    'mcp/server.mjs',
    'scripts/hook-handler.mjs',
    'sidecars/threads/main.mjs',
    'tests/unified-thread-id.test.mjs',
  ];
  for (const rel of allMjs) {
    const buf = readFileSync(join(REPO_ROOT, rel));
    assert.ok(!buf.includes(Buffer.from('\r')), `${rel} must use strict LF line endings`);
  }
});

test('Issue #12 review (thr-101) mixed-topology regression: legacy global thr-001 + scoped pt-<hash>-thr-001 coexistence enforces strict isolation across MCP manage_decisions, executeDecisionAction, syncCompletionToCoordinator, Sidecar /api/thread_sync_coord, and saveRegistry', async (t) => {
  const { tempRoot, geminiDir, appDataDir } = createTempEnv(t, 'pt-uni-mixed-');
  const mockLs = await startMockLs(t);
  const sendLog = join(tempRoot, 'mixed-agentapi-sends.jsonl');
  process.env.ANTIGRAVITY_AGENTAPI_EXE = writeMockAgentApi(tempRoot, sendLog);

  const repoA = join(tempRoot, 'legacy-repo-a');
  const repoB = join(tempRoot, 'new-repo-b');
  const repoC = join(tempRoot, 'empty-repo-c');
  initGitRepo(repoA);
  initGitRepo(repoB);
  initGitRepo(repoC);
  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);
  const keyC = normalizeKey(repoC);

  // Create real worktree with 1 ahead commit for Legacy Project A's global thr-001
  const wtA = join(tempRoot, '.worktrees', 'legacy-repo-a', 'thr-001-legacy-a');
  mkdirSync(join(tempRoot, '.worktrees', 'legacy-repo-a'), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-b', 'thread/thr-001-legacy-a', wtA, 'main'], { cwd: repoA });
  writeFileSync(join(wtA, 'legacy-a.txt'), 'legacy work\n', 'utf8');
  execFileSync('git', ['add', 'legacy-a.txt'], { cwd: wtA });
  execFileSync('git', ['commit', '-m', 'legacy a commit'], { cwd: wtA });
  const commitA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wtA, encoding: 'utf8' }).trim();

  // Seed mixed topology: Legacy Project A global thr-001 & thr-083 (without localId) + Project B & C coordinators
  const seed = loadRegistry();
  seed.seq = 83;
  seed.projectSeqs = { [keyA]: 71 };
  seed.coordinators[keyA] = {
    key: keyA,
    conversationId: 'coord-legacy-a',
    projectId: 'proj-legacy-a',
    workspacePath: repoA,
    repoRoot: repoA,
    defaultBranch: 'main',
    title: '[Coordinator] LegacyA',
  };
  seed.coordinators[keyB] = {
    key: keyB,
    conversationId: 'coord-new-b',
    retiredCoordinatorIds: ['coord-b-retired'],
    projectId: 'proj-new-b',
    workspacePath: repoB,
    repoRoot: repoB,
    defaultBranch: 'main',
    title: '[Coordinator] NewB',
  };
  seed.coordinators[keyC] = {
    key: keyC,
    conversationId: 'coord-empty-c',
    projectId: 'proj-empty-c',
    workspacePath: repoC,
    repoRoot: repoC,
    defaultBranch: 'main',
    title: '[Coordinator] EmptyC',
  };
  seed.threads = {
    'thr-001': {
      threadId: 'thr-001',
      projectSeq: 1,
      localId: '#1',
      conversationId: 'conv-legacy-a1',
      coordinatorId: 'coord-legacy-a',
      workspaceKey: keyA,
      workspacePath: repoA,
      repoRoot: repoA,
      worktreePath: wtA,
      branch: 'thread/thr-001-legacy-a',
      projectId: 'proj-legacy-a',
      title: 'Legacy A global 001',
      runState: 'RUN_STATE_IDLE',
      bucket: 'idle',
      archived: false,
      createdAt: '2026-10-01T00:00:00.000Z',
      git: { exists: true, aheadCount: 1, dirtyCount: 0, merged: false, lastCommit: commitA },
    },
    'thr-083': {
      threadId: 'thr-083',
      projectSeq: 71,
      // Deliberately omit localId to simulate historical pre-Issue-#12 global record with offset projectSeq
      conversationId: 'conv-legacy-a83',
      coordinatorId: 'coord-legacy-a',
      workspaceKey: keyA,
      workspacePath: repoA,
      repoRoot: repoA,
      projectId: 'proj-legacy-a',
      title: 'Legacy A offset 83 without localId',
      runState: 'RUN_STATE_IDLE',
      bucket: 'idle',
      archived: false,
      createdAt: '2026-10-15T00:00:00.000Z',
    },
  };
  saveRegistry(seed);

  // Dispatch brand-new Project B thread -> internal key pt-<hashB>-thr-001, display localId thr-001
  const b1 = await dispatchThread({
    workspacePath: repoB,
    coordinatorId: 'coord-new-b',
    title: 'New B scoped 001',
    taskPrompt: 'Implement B1.',
    createWorktree: true,
    model: 'pro',
  });
  assert.match(b1.threadId, /^pt-[a-f0-9]{8}-thr-001$/);
  assert.equal(b1.localId, 'thr-001');

  // Make 1 ahead commit inside b1 worktree so Project B also has a worktree_merge_ready auto card
  writeFileSync(join(b1.worktreePath, 'new-b.txt'), 'new b work\n', 'utf8');
  execFileSync('git', ['add', 'new-b.txt'], { cwd: b1.worktreePath });
  execFileSync('git', ['commit', '-m', 'new b commit'], { cwd: b1.worktreePath });
  const commitB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: b1.worktreePath, encoding: 'utf8' }).trim();

  const prepReg = loadRegistry();
  prepReg.threads[b1.threadId].runState = 'RUN_STATE_IDLE';
  prepReg.threads[b1.threadId].bucket = 'idle';
  prepReg.threads[b1.threadId].git = {
    exists: true,
    aheadCount: 1,
    dirtyCount: 0,
    merged: false,
    lastCommit: commitB,
  };
  saveRegistry(prepReg);

  // 1. P1-3: saveRegistry() must NEVER backfill offset thr-071 onto legacy global thr-083 without localId,
  //    while still safely backfilling localId for internal scoped pt-<hash>- threads.
  const staleCopy = loadRegistry();
  delete staleCopy.threads['thr-083'].localId;
  delete staleCopy.threads[b1.threadId].localId;
  saveRegistry(staleCopy);
  const afterMergeReg = loadRegistry();
  assert.equal(
    afterMergeReg.threads['thr-083'].localId,
    undefined,
    'saveRegistry must not backfill offset thr-071 onto legacy global thr-083',
  );
  assert.equal(getThreadDisplayId(afterMergeReg.threads['thr-083']), 'thr-083');
  assert.equal(
    afterMergeReg.threads[b1.threadId].localId,
    'thr-001',
    'saveRegistry should preserve/backfill localId for pt-<hash>- scoped threads',
  );
  await assert.rejects(
    () => resolveScopedThreadTarget({ threadId: 'thr-071', workspacePath: repoA }),
    /Thread not found in project scope/,
  );

  // Seed unlinked explicit decisions in Project A & Project B (keeping thr-001 auto cards visible in both!)
  const decA = addDecision({
    workspacePath: repoA,
    coordinatorId: 'coord-legacy-a',
    title: 'Legacy A architecture call?',
  });
  const decB = addDecision({
    workspacePath: repoB,
    coordinatorId: 'coord-new-b',
    title: 'New B release call?',
  });

  // Verify both projects currently expose their own worktree_merge_ready auto card
  const boardABefore = buildBoardDecisions({ workspacePath: repoA });
  const boardBBefore = buildBoardDecisions({ workspacePath: repoB });
  assert.ok(boardABefore.some((d) => d.source === 'auto' && d.threadId === 'thr-001'));
  assert.ok(boardBBefore.some((d) => d.source === 'auto' && d.threadId === b1.threadId && d.threadLocalId === 'thr-001'));

  // 2. P0-1: MCP manage_decisions(dismiss / resolve) enforces strict project scope under mixed topology
  const mcpRes = await runMcpStdio(
    {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_APP_DATA_DIR: appDataDir,
      ANTIGRAVITY_LS_ADDRESS: mockLs.address,
      ANTIGRAVITY_CSRF_TOKEN: mockLs.csrfToken,
    },
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      // Dismiss Project B's thr-001 auto card via local ID `thr-001`
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'manage_decisions',
          arguments: { action: 'dismiss', workspacePath: repoB, coordinatorId: 'coord-new-b', threadId: 'thr-001' },
        },
      },
      // Cross-project dismiss of Project A's explicit decision from Project B -> MUST fail closed
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'manage_decisions',
          arguments: { action: 'dismiss', workspacePath: repoB, coordinatorId: 'coord-new-b', decisionId: decA.id },
        },
      },
      // Cross-project resolve of Project A's explicit decision from Project B -> MUST fail closed
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'manage_decisions',
          arguments: { action: 'resolve', workspacePath: repoB, coordinatorId: 'coord-new-b', decisionId: decA.id },
        },
      },
      // Retired coordinator calling resolve on Project B -> MUST fail closed
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'manage_decisions',
          arguments: { action: 'resolve', workspacePath: repoB, coordinatorId: 'coord-b-retired', decisionId: decB.id },
        },
      },
      // Empty Project C attempting to dismiss `thr-001` -> MUST reject (never touch Legacy A or write orphan key)
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'manage_decisions',
          arguments: { action: 'dismiss', workspacePath: repoC, coordinatorId: 'coord-empty-c', threadId: 'thr-001' },
        },
      },
      // Valid Project B resolve of decB -> MUST succeed
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'manage_decisions',
          arguments: {
            action: 'resolve',
            workspacePath: repoB,
            coordinatorId: 'coord-new-b',
            decisionId: decB.id,
            optionLabel: 'Ship it',
          },
        },
      },
    ],
  );
  assert.equal(mcpRes.status, 0, mcpRes.stderr);
  const mcpMsgs = mcpRes.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));

  const dismissBRes = mcpMsgs.find((m) => m.id === 2)?.result;
  assert.notEqual(dismissBRes?.isError, true, dismissBRes?.content?.[0]?.text);
  const dismissBText = dismissBRes?.content?.[0]?.text || '';
  assert.match(dismissBText, /`thr-001`/);
  assert.doesNotMatch(dismissBText, /\bpt-[a-f0-9]{8}-/);

  const regAfterMcpDismiss = loadRegistry();
  assert.ok(regAfterMcpDismiss.dismissedAutoDecisions[`${b1.threadId}:*`]);
  assert.equal(regAfterMcpDismiss.dismissedAutoDecisions['thr-001:*'], undefined);
  assert.ok(
    buildBoardDecisions({ workspacePath: repoA }).some((d) => d.source === 'auto' && d.threadId === 'thr-001'),
    'Legacy Project A auto decision for thr-001 must remain completely untouched',
  );
  assert.equal(
    buildBoardDecisions({ workspacePath: repoB }).some((d) => d.source === 'auto' && d.threadId === b1.threadId),
    false,
    'Project B auto decision must be dismissed',
  );

  const crossDismissErr = mcpMsgs.find((m) => m.id === 3)?.result;
  assert.equal(crossDismissErr?.isError, true);
  assert.match(crossDismissErr?.content?.[0]?.text || '', /Cross-project access denied/);

  const crossResolveErr = mcpMsgs.find((m) => m.id === 4)?.result;
  assert.equal(crossResolveErr?.isError, true);
  assert.match(crossResolveErr?.content?.[0]?.text || '', /Cross-project access denied/);

  const retiredResolveErr = mcpMsgs.find((m) => m.id === 5)?.result;
  assert.equal(retiredResolveErr?.isError, true);
  assert.match(retiredResolveErr?.content?.[0]?.text || '', /retired|Coordinator/i);

  const emptyCDismissErr = mcpMsgs.find((m) => m.id === 6)?.result;
  assert.equal(emptyCDismissErr?.isError, true);
  assert.match(emptyCDismissErr?.content?.[0]?.text || '', /Cross-project access denied/);

  const validResolveB = mcpMsgs.find((m) => m.id === 7)?.result;
  assert.notEqual(validResolveB?.isError, true);
  assert.equal(listDecisions({ workspacePath: repoA }).length, 1, 'decA must stay pending');
  assert.equal(listDecisions({ workspacePath: repoB }).length, 0, 'decB must be resolved');

  assert.throws(
    () => resolveDecision({ decisionId: decA.id, workspacePath: repoB }),
    /Cross-project access denied/,
  );

  // 3. P1-1 & P2-1: executeDecisionAction(auto:worktree_merge_ready:thr-001) targets Project B, never Legacy A
  // Make a new commit on b1 so the auto decision naturally re-triggers for commitB2
  writeFileSync(join(b1.worktreePath, 'new-b-2.txt'), 'new b commit 2\n', 'utf8');
  execFileSync('git', ['add', 'new-b-2.txt'], { cwd: b1.worktreePath });
  execFileSync('git', ['commit', '-m', 'new b commit 2'], { cwd: b1.worktreePath });
  const commitB2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: b1.worktreePath, encoding: 'utf8' }).trim();
  const rearmAutoReg = loadRegistry();
  rearmAutoReg.threads[b1.threadId].git = {
    exists: true,
    aheadCount: 2,
    dirtyCount: 0,
    merged: false,
    lastCommit: commitB2,
  };
  saveRegistry(rearmAutoReg);

  const execAutoB = await executeDecisionAction({
    decisionId: 'auto:worktree_merge_ready:thr-001',
    action: 'send_coordinator',
    workspacePath: repoB,
    coordinatorId: 'coord-new-b',
  });
  assert.equal(execAutoB.ok, true);
  assert.equal(execAutoB.coordinatorId, 'coord-new-b');
  assert.equal(execAutoB.threadId, b1.threadId);
  const regAfterExecAuto = loadRegistry();
  assert.ok(regAfterExecAuto.dismissedAutoDecisions[`${b1.threadId}:worktree_merge_ready`]);
  assert.equal(regAfterExecAuto.dismissedAutoDecisions['thr-001:worktree_merge_ready'], undefined);

  // P2-1: Duplicate auto decision claim conflict error must display `thr-001`, never internal `pt-<hash>-`
  const dupAutoB = await executeDecisionAction({
    decisionId: 'auto:worktree_merge_ready:thr-001',
    action: 'send_coordinator',
    workspacePath: repoB,
    coordinatorId: 'coord-new-b',
  });
  assert.equal(dupAutoB.ok, false);
  assert.equal(dupAutoB.alreadyResolved, true);
  assert.match(dupAutoB.error || '', /"thr-001"/);
  assert.doesNotMatch(dupAutoB.error || '', /\bpt-[a-f0-9]{8}-/);

  // Empty Project C must fail closed on auto:worktree_merge_ready:thr-001
  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: 'auto:worktree_merge_ready:thr-001',
        action: 'send_coordinator',
        workspacePath: repoC,
        coordinatorId: 'coord-empty-c',
      }),
    /Cross-project access denied/,
  );

  // 4. P0-2 & P1-2: syncCompletionToCoordinator scoped-first resolution & Sidecar /api/thread_sync_coord wiring
  writeTranscript(appDataDir, 'conv-legacy-a1', [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>A</USER_REQUEST>' },
    {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'Finished.\n\n### Thread Summary\n- LEGACY_A_ONLY_MARKER',
    },
  ]);
  writeTranscript(appDataDir, b1.conversationId, [
    { step_index: 0, type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>B</USER_REQUEST>' },
    {
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'Finished.\n\n### Thread Summary\n- SCOPED_B_ONLY_MARKER',
    },
  ]);

  const syncB = await syncCompletionToCoordinator({
    threadId: 'thr-001',
    workspacePath: repoB,
    coordinatorId: 'coord-new-b',
    force: true,
  });
  assert.equal(syncB.ok, true);
  assert.equal(syncB.synced, true);
  assert.equal(syncB.threadId, b1.threadId);
  assert.equal(syncB.localId, 'thr-001');
  assert.equal(syncB.coordinatorId, 'coord-new-b');

  // Inspect actual agentapi deliveries: BOTH auto decision & completion sync went exclusively to coord-new-b
  const sends = readFileSync(sendLog, 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(sends.length, 2, 'Expected 1 auto-decision send + 1 completion sync send');
  for (const argv of sends) {
    const joined = argv.join(' ');
    assert.ok(joined.includes('coord-new-b'), 'Delivery must target coord-new-b');
    assert.equal(joined.includes('coord-legacy-a'), false, 'Delivery must NEVER hit Legacy Project A coordinator');
    assert.doesNotMatch(joined, /\bpt-[a-f0-9]{8}-/, 'Delivery must never expose internal scoped key');
    assert.equal(joined.includes('\u00b7'), false, 'Delivery must contain zero middle dots');
  }
  const lastSyncPayload = sends[sends.length - 1].join(' ');
  assert.ok(lastSyncPayload.includes('SCOPED_B_ONLY_MARKER'), 'Must deliver Project B transcript');
  assert.equal(lastSyncPayload.includes('LEGACY_A_ONLY_MARKER'), false, 'Must NEVER deliver Legacy Project A transcript');

  // Retired coordinator & cross-project caller must be rejected on syncCompletionToCoordinator
  await assert.rejects(
    () =>
      syncCompletionToCoordinator({
        threadId: 'thr-001',
        workspacePath: repoB,
        coordinatorId: 'coord-b-retired',
        force: true,
      }),
    /retired|Coordinator/i,
  );
  await assert.rejects(
    () =>
      syncCompletionToCoordinator({
        threadId: 'thr-001',
        workspacePath: repoC,
        coordinatorId: 'coord-empty-c',
        force: true,
      }),
    /Cross-project access denied/,
  );

  // P1-2 static verification: Sidecar main.mjs forwards scope & app.js sends buildScopePayload + anti-replay opts
  const mainSource = readFileSync(join(REPO_ROOT, 'sidecars/threads/main.mjs'), 'utf8');
  const appSource = readFileSync(join(REPO_ROOT, 'sidecars/threads/app.js'), 'utf8');
  const syncHandlerMatch = mainSource.match(/async function handleThreadSyncCoord\([\s\S]*?\n\}/);
  assert.ok(syncHandlerMatch, 'handleThreadSyncCoord must exist in sidecars/threads/main.mjs');
  for (const field of ['workspacePath', 'workspaceKey', 'coordinatorId', 'conversationId', 'projectId']) {
    assert.ok(
      syncHandlerMatch[0].includes(field),
      `handleThreadSyncCoord must forward ${field} to syncCompletionToCoordinator`,
    );
  }
  const syncCalls = [...appSource.matchAll(/postApi\(\s*['"]\/api\/thread_sync_coord['"][\s\S]*?\);/g)];
  assert.equal(syncCalls.length, 2, 'sidecars/threads/app.js must have 2 /api/thread_sync_coord callers');
  for (const m of syncCalls) {
    assert.ok(m[0].includes('buildScopePayload('), '/api/thread_sync_coord caller must wrap payload with buildScopePayload');
    assert.ok(m[0].includes('timeoutMs: 0'), '/api/thread_sync_coord caller must set timeoutMs: 0');
    assert.ok(m[0].includes('allowGetFallback: false'), '/api/thread_sync_coord caller must set allowGetFallback: false');
  }
});

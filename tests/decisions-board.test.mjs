import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

import { resolveAgentApiShimTargetFile } from '../lib/ls-client.mjs';
import {
  addDecision,
  buildBoardDecisions,
  dismissDecision,
  executeDecisionAction,
  listDecisions,
  loadRegistry,
  normalizeKey,
  quoteWindowsCmdArg,
  resolveDecision,
  saveRegistry,
} from '../lib/store.mjs';

function createTempEnv(t, prefix = 'pt-dec-') {
  const tempRoot = mkdtempSync(join(tmpdir(), prefix));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  const stateDir = join(appDataDir, 'project-threads');
  mkdirSync(stateDir, { recursive: true });

  const envKeys = [
    'ANTIGRAVITY_GEMINI_DIR',
    'ANTIGRAVITY_APP_DATA_DIR',
    'ANTIGRAVITY_AGENTAPI_EXE',
    'ANTIGRAVITY_LS_ADDRESS',
    'ANTIGRAVITY_CSRF_TOKEN',
  ];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;
  delete process.env.ANTIGRAVITY_AGENTAPI_EXE;
  delete process.env.ANTIGRAVITY_LS_ADDRESS;
  delete process.env.ANTIGRAVITY_CSRF_TOKEN;

  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  return { tempRoot, geminiDir, appDataDir, stateDir };
}

function createFakeAgentApi(dir, { exitCode = 0, stderrText = '', delayMs = 0 } = {}) {
  const captureFile = join(dir, 'agentapi-capture.json');
  const countFile = join(dir, 'agentapi-calls.log');
  const runnerScript = join(dir, 'fake-agentapi.mjs');
  writeFileSync(
    runnerScript,
    [
      'import { appendFileSync, writeFileSync } from "node:fs";',
      `const capturePath = ${JSON.stringify(captureFile)};`,
      `const countPath = ${JSON.stringify(countFile)};`,
      `const delay = ${Math.max(0, Number(delayMs) || 0)};`,
      'const finish = () => {',
      '  const rec = { argv: process.argv.slice(2), env: { projectId: process.env.ANTIGRAVITY_PROJECT_ID || "" } };',
      '  writeFileSync(capturePath, JSON.stringify(rec, null, 2), "utf8");',
      '  appendFileSync(countPath, JSON.stringify(rec) + "\\n", "utf8");',
      stderrText ? `  process.stderr.write(${JSON.stringify(stderrText)});` : '',
      `  process.exit(${Number(exitCode) || 0});`,
      '};',
      'if (delay > 0) setTimeout(finish, delay); else finish();',
    ].join('\n'),
    'utf8',
  );

  let exePath;
  if (process.platform === 'win32') {
    exePath = join(dir, 'agentapi.cmd');
    writeFileSync(
      exePath,
      `@echo off\r\n"${process.execPath}" "${runnerScript}" %*\r\n`,
      'utf8',
    );
  } else {
    exePath = join(dir, 'agentapi');
    writeFileSync(
      exePath,
      `#!/usr/bin/env sh\nexec "${process.execPath}" "${runnerScript}" "$@"\n`,
      'utf8',
    );
    chmodSync(exePath, 0o755);
  }

  return { exePath, captureFile, countFile };
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
  throw new Error(`Could not find closing brace for ${fnName}`);
}

function loadUiDecisionHelpers() {
  const appSource = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const htmlSource = readFileSync(new URL('../sidecars/threads/index.html', import.meta.url), 'utf8');
  const cssSource = readFileSync(new URL('../sidecars/threads/theme.css', import.meta.url), 'utf8');

  const i18nStart = appSource.indexOf('const I18N = {');
  assert.notEqual(i18nStart, -1);
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

  const getLocalizedFn = extractFunctionSource(appSource, 'getLocalizedDecisionDisplay');
  const renderPanelFn = extractFunctionSource(appSource, 'renderDecisionsPanelHtml');
  const renderCardFn = extractFunctionSource(appSource, 'renderO2ThreadCard');

  const ctx = {};
  vm.runInNewContext(
    `
    ${i18nCode};
    let curLocale = 'zh-CN';
    const L = () => I18N[curLocale] || I18N.en;
    const ICONS = {
      chevronDown: '<svg class="ico ico-sm"></svg>',
      chevronRight: '<svg class="ico ico-sm"></svg>',
      close: '<svg class="ico ico-xs"></svg>',
      check: '<svg class="ico ico-sm"></svg>',
    };
    const pendingDecisionIds = new Set();
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const isThreadCardOpen = () => false;
    const getActiveMainWorkerConvId = () => '';
    const relTime = () => '2m';
    const renderSegmentedMbar = () => '';
    const cleanGoalSnippet = (th) => th.lastSummary || '';
    const computeInlineSubtitle = () => 'Ready';
    const formatModelDisplay = (m) => m || 'Pro';
    const renderThreadUsageRow = () => '';
    ${getLocalizedFn}
    ${renderPanelFn}
    ${renderCardFn}
    this.I18N = I18N;
    this.setLocale = (loc) => { curLocale = loc; };
    this.renderDecisionsPanelHtml = renderDecisionsPanelHtml;
    this.renderO2ThreadCard = renderO2ThreadCard;
    `,
    ctx,
  );

  return {
    appSource,
    htmlSource,
    cssSource,
    I18N: ctx.I18N,
    setLocale: ctx.setLocale,
    renderDecisionsPanelHtml: ctx.renderDecisionsPanelHtml,
    renderO2ThreadCard: ctx.renderO2ThreadCard,
  };
}

test('explicit decisions persist, enforce cross-project isolation, survive concurrent saveRegistry merges, and resolve/dismiss cleanly', (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-dec-persist-');
  const repoA = join(tempRoot, 'repo-alpha');
  const repoB = join(tempRoot, 'repo-beta');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });

  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);

  // Seed stale in-memory registry snapshot before decisions are added (simulates concurrent 3.5s poll)
  const staleReg = loadRegistry();
  staleReg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'conv-coord-a',
    workspacePath: repoA,
    repoRoot: repoA,
    title: '[Coordinator] Alpha',
  };
  staleReg.coordinators[keyB] = {
    key: keyB,
    conversationId: 'conv-coord-b',
    workspacePath: repoB,
    repoRoot: repoB,
    title: '[Coordinator] Beta',
  };
  saveRegistry(staleReg);
  const staleCopyBeforeAdd = loadRegistry();

  // Add decisions to Project A and Project B
  const decA1 = addDecision({
    workspacePath: repoA,
    coordinatorId: 'conv-coord-a',
    threadId: 'thr-001',
    title: '是否将 thr-001 合入 dev？',
    summary: '所有单元测试已通过，无未提交改动。',
    options: [
      { id: 'merge', label: '合入 dev', action: 'send_coordinator', message: '请合入 thr-001 至 dev', style: 'primary' },
      { id: 'archive', label: '仅归档', action: 'archive_thread', style: 'secondary' },
      { id: 'skip', label: '暂不处理', action: 'dismiss', style: 'secondary' },
      { id: 'extra-4th', label: '应被截断', action: 'dismiss' },
    ],
  });

  const decA2 = addDecision({
    workspaceKey: keyA,
    title: '发版方案选型',
    summary: '先发 rc.1 还是直接发稳定版？',
  });

  const decB1 = addDecision({
    workspacePath: repoB,
    coordinatorId: 'conv-coord-b',
    title: 'Beta 项目数据库迁移确认',
    options: [{ label: '确认迁移', action: 'send_coordinator', message: '执行 Beta 迁移' }],
  });

  assert.equal(decA1.id, 'dec-001');
  assert.equal(decA2.id, 'dec-002');
  assert.equal(decB1.id, 'dec-003');
  assert.equal(decA1.options.length, 3, 'options are capped at 3');
  assert.equal(decA2.options.length, 2, 'omitted options receive localized default Confirm + Dismiss');
  assert.equal(decA2.options[0].label, '确认执行');
  assert.equal(decA2.options[1].action, 'dismiss');

  // Strict cross-project isolation
  const listA = listDecisions({ workspacePath: repoA });
  const listB = listDecisions({ workspacePath: repoB });
  const listUnscoped = listDecisions({});
  assert.deepEqual(
    listA.map((d) => d.id).sort(),
    ['dec-001', 'dec-002'],
  );
  assert.deepEqual(
    listB.map((d) => d.id),
    ['dec-003'],
  );
  assert.deepEqual(listUnscoped, [], 'unscoped query fails closed');

  // Concurrent stale saveRegistry() must NOT wipe newly persisted decisions
  saveRegistry(staleCopyBeforeAdd);
  assert.equal(listDecisions({ workspacePath: repoA }).length, 2);
  assert.equal(listDecisions({ workspacePath: repoB }).length, 1);

  // Resolve dec-001 and dismiss dec-002; stale pending snapshot must NOT revert final statuses
  const pendingSnapshot = loadRegistry();
  const resolved = resolveDecision({ decisionId: 'dec-001', optionId: 'merge' });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolvedOptionLabel, '合入 dev');
  assert.ok(resolved.resolvedAt);

  const dismissed = dismissDecision('dec-002');
  assert.equal(dismissed.ok, true);
  assert.equal(dismissed.source, 'explicit');
  assert.equal(dismissed.decision.status, 'dismissed');

  // Re-save older pending snapshot -> final statuses on disk must win
  saveRegistry(pendingSnapshot);
  assert.equal(listDecisions({ workspacePath: repoA }).length, 0);
  const allA = listDecisions({ workspacePath: repoA, includeResolved: true });
  assert.equal(allA.length, 2);
  assert.equal(allA.find((d) => d.id === 'dec-001').status, 'resolved');
  assert.equal(allA.find((d) => d.id === 'dec-002').status, 'dismissed');
  assert.equal(listDecisions({ workspacePath: repoB }).length, 1);
});

test('buildBoardDecisions generates Worktree auto hints, deduplicates explicit decisions by threadId, and respects lastCommit dismiss/re-trigger', (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-dec-auto-');
  const repoA = join(tempRoot, 'repo-auto');
  mkdirSync(repoA, { recursive: true });
  const keyA = normalizeKey(repoA);

  const threads = [
    {
      threadId: 'thr-010',
      workspaceKey: keyA,
      title: '实现看板置顶区',
      branch: 'thread/thr-010-decisions',
      baseRef: 'dev',
      worktreePath: join(tempRoot, 'wt-010'),
      archived: false,
      runState: 'RUN_STATE_IDLE',
      bucket: 'idle',
      git: {
        exists: true,
        branch: 'thread/thr-010-decisions',
        aheadCount: 2,
        dirtyCount: 0,
        merged: false,
        mergeMethod: '',
        lastCommit: 'a1b2c3d feat: board panel',
      },
    },
    {
      threadId: 'thr-011',
      workspaceKey: keyA,
      title: '修复日志解析',
      branch: 'thread/thr-011-fix',
      baseRef: 'dev',
      worktreePath: join(tempRoot, 'wt-011'),
      archived: false,
      runState: 'RUN_STATE_IDLE',
      bucket: 'idle',
      git: {
        exists: true,
        branch: 'thread/thr-011-fix',
        aheadCount: 1,
        dirtyCount: 0,
        merged: true,
        mergeMethod: 'cherry-pick',
        lastCommit: 'b2c3d4e fix: transcript parser',
      },
    },
    {
      threadId: 'thr-012',
      workspaceKey: keyA,
      title: '常规合并完成线程',
      branch: 'thread/thr-012-merged',
      baseRef: 'dev',
      worktreePath: join(tempRoot, 'wt-012'),
      archived: false,
      runState: 'RUN_STATE_IDLE',
      bucket: 'idle',
      git: {
        exists: true,
        branch: 'thread/thr-012-merged',
        aheadCount: 0,
        dirtyCount: 0,
        merged: true,
        mergeMethod: '',
        lastCommit: 'c3d4e5f chore: merged',
      },
    },
    // Should be ignored: dirty worktree
    {
      threadId: 'thr-013',
      workspaceKey: keyA,
      title: '未提交草稿',
      worktreePath: join(tempRoot, 'wt-013'),
      archived: false,
      runState: 'RUN_STATE_IDLE',
      git: { exists: true, aheadCount: 1, dirtyCount: 2, merged: false, lastCommit: 'd4e5f6g wip' },
    },
    // Should be ignored: still running
    {
      threadId: 'thr-014',
      workspaceKey: keyA,
      title: '执行中线程',
      worktreePath: join(tempRoot, 'wt-014'),
      archived: false,
      runState: 'RUN_STATE_RUNNING',
      bucket: 'working',
      git: { exists: true, aheadCount: 1, dirtyCount: 0, merged: false, lastCommit: 'e5f6g7h run' },
    },
    // Should be ignored: read-only thread (no worktreePath)
    {
      threadId: 'thr-015',
      workspaceKey: keyA,
      title: '只读排查线程',
      worktreePath: '',
      archived: false,
      runState: 'RUN_STATE_IDLE',
      git: null,
    },
    // Should be ignored: archived
    {
      threadId: 'thr-016',
      workspaceKey: keyA,
      title: '已归档线程',
      worktreePath: join(tempRoot, 'wt-016'),
      archived: true,
      runState: 'RUN_STATE_IDLE',
      git: { exists: true, aheadCount: 0, dirtyCount: 0, merged: true, lastCommit: 'f6g7h8i old' },
    },
  ];

  const initialBoard = buildBoardDecisions({ workspaceKey: keyA }, threads, { locale: 'zh-CN' });
  assert.equal(initialBoard.length, 3);
  const mergeHint = initialBoard.find((d) => d.threadId === 'thr-010');
  const cherryHint = initialBoard.find((d) => d.threadId === 'thr-011');
  const ffMergeHint = initialBoard.find((d) => d.threadId === 'thr-012');

  assert.equal(mergeHint?.source, 'auto');
  assert.equal(mergeHint?.autoKind, 'worktree_merge_ready');
  assert.equal(mergeHint?.options[0]?.action, 'send_coordinator');
  assert.equal(mergeHint?.options[1]?.action, 'dismiss');

  assert.equal(cherryHint?.source, 'auto');
  assert.equal(cherryHint?.autoKind, 'worktree_archive_ready');
  assert.equal(cherryHint?.options[0]?.action, 'archive_thread');
  assert.match(cherryHint?.title || '', /cherry-pick/);

  assert.equal(ffMergeHint?.source, 'auto');
  assert.equal(ffMergeHint?.autoKind, 'worktree_archive_ready');
  assert.equal(ffMergeHint?.options[0]?.action, 'archive_thread');

  // Explicit decision for thr-010 deduplicates / suppresses its auto hint
  const explicitDec = addDecision({
    workspaceKey: keyA,
    threadId: 'thr-010',
    title: '请确认 thr-010 的视觉样式后再合入',
    options: [{ id: 'ok', label: '确认合入', action: 'send_coordinator', message: '合入 thr-010' }],
  });
  const deduped = buildBoardDecisions({ workspaceKey: keyA }, threads, { locale: 'zh-CN' });
  assert.equal(deduped.length, 3);
  assert.equal(deduped[0].id, explicitDec.id, 'explicit decision is pinned first');
  assert.equal(
    deduped.filter((d) => d.threadId === 'thr-010').length,
    1,
    'auto hint must not duplicate an explicit pending decision for the same threadId',
  );

  // Resolve explicit decision -> auto hint returns for thr-010
  resolveDecision({ decisionId: explicitDec.id, optionId: 'ok' });
  const afterResolve = buildBoardDecisions({ workspaceKey: keyA }, threads, { locale: 'zh-CN' });
  assert.equal(afterResolve.find((d) => d.threadId === 'thr-010')?.source, 'auto');

  // Dismiss thr-010 auto hint by threadId + lastCommit
  const staleBeforeDismiss = loadRegistry();
  dismissDecision('thr-010:a1b2c3d feat: board panel');
  // Stale saveRegistry must preserve dismissedAutoDecisions
  saveRegistry(staleBeforeDismiss);

  const afterDismiss = buildBoardDecisions({ workspaceKey: keyA }, threads, { locale: 'zh-CN' });
  assert.equal(
    afterDismiss.some((d) => d.threadId === 'thr-010'),
    false,
    'dismissed auto hint stays hidden for the same lastCommit',
  );

  // New commit on thr-010 re-triggers the auto hint!
  threads[0].git.lastCommit = '999aaaa fix: polish styling';
  const afterNewCommit = buildBoardDecisions({ workspaceKey: keyA }, threads, { locale: 'zh-CN' });
  assert.equal(
    afterNewCommit.some((d) => d.threadId === 'thr-010' && d.autoKind === 'worktree_merge_ready'),
    true,
    'auto hint re-triggers when thread produces a new commit',
  );
});

test('executeDecisionAction supports archive_thread, send_coordinator (with live coordinator resolution), and dismiss', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-dec-exec-');
  const repoA = join(tempRoot, 'repo-exec');
  mkdirSync(repoA, { recursive: true });
  const keyA = normalizeKey(repoA);

  const reg = loadRegistry();
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'conv-coord-live-999',
    workspacePath: repoA,
    repoRoot: repoA,
    projectId: 'proj-exec-001',
    title: '[Coordinator] ExecRepo',
  };
  reg.threads['thr-020'] = {
    threadId: 'thr-020',
    conversationId: 'conv-worker-020',
    workspaceKey: keyA,
    coordinatorId: 'conv-coord-live-999',
    projectId: 'proj-exec-001',
    title: '特性开发线程',
    branch: 'thread/thr-020-feat',
    worktreePath: '',
    archived: false,
    runState: 'RUN_STATE_IDLE',
  };
  saveRegistry(reg);

  // 1. send_coordinator failure must NOT resolve the decision
  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59999';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf';
  const failApi = createFakeAgentApi(tempRoot, { exitCode: 1, stderrText: 'LS offline' });
  process.env.ANTIGRAVITY_AGENTAPI_EXE = failApi.exePath;

  const decSend = addDecision({
    workspacePath: repoA,
    coordinatorId: 'conv-coord-live-999',
    threadId: 'thr-020',
    title: '是否合入 thr-020 到 dev？',
    options: [
      { id: 'merge', label: '合入 dev', action: 'send_coordinator', message: '请把 thr-020 cherry-pick 到 dev', style: 'primary' },
    ],
  });

  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: decSend.id,
        optionId: 'merge',
        workspacePath: repoA,
        conversationId: 'conv-worker-020', // even when triggered while viewing a worker conv, must target coordinator!
      }),
    /LS offline/,
  );
  assert.equal(listDecisions({ workspacePath: repoA }).length, 1, 'failed send keeps decision pending');

  // 2. send_coordinator success delivers to coordinatorId (NOT worker convId) and marks resolved
  const okApi = createFakeAgentApi(tempRoot, { exitCode: 0 });
  process.env.ANTIGRAVITY_AGENTAPI_EXE = okApi.exePath;

  const sendRes = await executeDecisionAction({
    decisionId: decSend.id,
    optionId: 'merge',
    workspacePath: repoA,
    conversationId: 'conv-worker-020',
  });
  assert.equal(sendRes.ok, true);
  assert.equal(sendRes.coordinatorId, 'conv-coord-live-999');
  assert.equal(sendRes.decision.status, 'resolved');
  assert.equal(listDecisions({ workspacePath: repoA }).length, 0);

  assert.equal(existsSync(okApi.captureFile), true);
  const captured = JSON.parse(readFileSync(okApi.captureFile, 'utf8'));
  assert.equal(captured.argv[0], 'send-message');
  assert.ok(captured.argv.includes('conv-coord-live-999'));
  assert.equal(captured.argv.includes('conv-worker-020'), false);
  const sentBody = captured.argv[captured.argv.length - 1];
  assert.match(sentBody, /thr-020/);
  assert.match(sentBody, /cherry-pick 到 dev/);

  // 3. archive_thread archives the thread and resolves the explicit decision
  const decArchive = addDecision({
    workspacePath: repoA,
    threadId: 'thr-020',
    title: '验收并归档 thr-020？',
    options: [{ id: 'arch', label: '验收归档', action: 'archive_thread', style: 'primary' }],
  });
  const archRes = await executeDecisionAction({
    decisionId: decArchive.id,
    optionId: 'arch',
    workspacePath: repoA,
  });
  assert.equal(archRes.ok, true);
  assert.equal(archRes.action, 'archive_thread');
  assert.equal(archRes.archiveResult.archived, true);
  assert.equal(archRes.decision.status, 'resolved');
  assert.equal(loadRegistry().threads['thr-020'].archived, true);
});

test('MCP server registers manage_decisions and handles add/list/resolve/dismiss + validation', (t) => {
  const { tempRoot, geminiDir, appDataDir } = createTempEnv(t, 'pt-dec-mcp-');
  const repoDir = join(tempRoot, 'mcp-repo');
  mkdirSync(repoDir, { recursive: true });
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'manage_decisions',
        arguments: {
          action: 'add',
          workspacePath: repoDir,
          coordinatorId: 'conv-mcp-coord',
          threadId: 'thr-044',
          title: '是否发布 v1.2.0-rc.1？',
          summary: '待决策面板与 MCP 工具已通过全部单测。',
          options: [
            { id: 'pub', label: '立即发布 rc.1', action: 'send_coordinator', message: '请发布 v1.2.0-rc.1', style: 'primary' },
            { id: 'wait', label: '暂缓', action: 'dismiss', style: 'secondary' },
          ],
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'manage_decisions',
        arguments: {
          action: 'list',
          workspacePath: repoDir,
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'manage_decisions',
        arguments: {
          action: 'resolve',
          decisionId: 'dec-001',
          optionId: 'pub',
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'manage_decisions',
        arguments: {
          action: 'add',
          workspacePath: repoDir,
          title: '待忽略决策',
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'manage_decisions',
        arguments: {
          action: 'dismiss',
          decisionId: 'dec-002',
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'manage_decisions',
        arguments: {
          action: 'add',
          workspacePath: repoDir,
        },
      },
    },
  ];

  const res = spawnSync(process.execPath, ['mcp/server.mjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_APP_DATA_DIR: appDataDir,
    },
    input: `${requests.map((r) => JSON.stringify(r)).join('\n')}\n`,
    encoding: 'utf8',
  });

  assert.equal(res.status, 0, res.stderr);
  const msgs = res.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));

  const tools = msgs.find((m) => m.id === 2)?.result?.tools || [];
  const decTool = tools.find((x) => x.name === 'manage_decisions');
  assert.ok(decTool, 'manage_decisions must be registered in tools/list');
  assert.deepEqual(decTool.inputSchema.properties.action.enum, ['add', 'list', 'resolve', 'dismiss']);

  const addOut = msgs.find((m) => m.id === 3)?.result;
  assert.equal(addOut?.isError, undefined);
  assert.equal(addOut?.structuredContent?.id, 'dec-001');
  assert.equal(addOut?.structuredContent?.threadId, 'thr-044');

  const listOut = msgs.find((m) => m.id === 4)?.result;
  assert.equal(listOut?.structuredContent?.decisions?.length, 1);
  assert.equal(listOut?.structuredContent?.decisions?.[0]?.id, 'dec-001');

  const resolveOut = msgs.find((m) => m.id === 5)?.result;
  assert.equal(resolveOut?.structuredContent?.status, 'resolved');
  assert.equal(resolveOut?.structuredContent?.resolvedOptionLabel, '立即发布 rc.1');

  const dismissOut = msgs.find((m) => m.id === 7)?.result;
  assert.equal(dismissOut?.structuredContent?.ok, true);
  assert.equal(dismissOut?.structuredContent?.decision?.status, 'dismissed');

  const errOut = msgs.find((m) => m.id === 8)?.result;
  assert.equal(errOut?.isError, true, 'add without title returns isError');
});

test('executeDecisionAction custom_reply supports explicit decisions, Worktree auto hints, empty-input rejection, cross-project fail-closed, and retired coordinator blocking', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-dec-custom-');
  const repoA = join(tempRoot, 'repo-custom-a');
  const repoB = join(tempRoot, 'repo-custom-b');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);

  const reg = loadRegistry();
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'conv-coord-a-active',
    retiredCoordinatorIds: ['conv-coord-a-retired'],
    workspacePath: repoA,
    repoRoot: repoA,
    projectId: 'proj-custom-a',
    title: '[Coordinator] CustomA',
  };
  reg.coordinators[keyB] = {
    key: keyB,
    conversationId: 'conv-coord-b-active',
    workspacePath: repoB,
    repoRoot: repoB,
    projectId: 'proj-custom-b',
    title: '[Coordinator] CustomB',
  };
  reg.threads['thr-060'] = {
    threadId: 'thr-060',
    conversationId: 'conv-worker-060',
    workspaceKey: keyA,
    coordinatorId: 'conv-coord-a-active',
    projectId: 'proj-custom-a',
    title: '实现决策自定义指令',
    branch: 'thread/thr-060-custom',
    baseRef: 'dev',
    worktreePath: join(tempRoot, 'wt-060'),
    archived: false,
    runState: 'RUN_STATE_IDLE',
    bucket: 'idle',
    git: {
      exists: true,
      branch: 'thread/thr-060-custom',
      aheadCount: 2,
      dirtyCount: 0,
      merged: false,
      mergeMethod: '',
      lastCommit: 'aa11bb2 feat: custom reply input',
    },
  };
  reg.threads['thr-061'] = {
    threadId: 'thr-061',
    conversationId: 'conv-worker-061',
    workspaceKey: keyA,
    coordinatorId: 'conv-coord-a-active',
    projectId: 'proj-custom-a',
    title: '已合入待归档线程',
    branch: 'thread/thr-061-merged',
    baseRef: 'dev',
    worktreePath: join(tempRoot, 'wt-061'),
    archived: false,
    runState: 'RUN_STATE_IDLE',
    bucket: 'idle',
    git: {
      exists: true,
      branch: 'thread/thr-061-merged',
      aheadCount: 0,
      dirtyCount: 0,
      merged: true,
      mergeMethod: 'cherry-pick',
      lastCommit: 'cc33dd4 fix: archive ready',
    },
  };
  saveRegistry(reg);

  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59999';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf-custom';

  const decExplicit = addDecision({
    workspacePath: repoA,
    coordinatorId: 'conv-coord-a-active',
    threadId: 'thr-060',
    title: '是否直接合入 dev？',
    summary: '全部测试已通过，可合入或补充修改。',
    options: [
      { id: 'merge', label: '直接合入', action: 'send_coordinator', message: '合入 dev', style: 'primary' },
      { id: 'skip', label: '暂缓', action: 'dismiss', style: 'secondary' },
    ],
  });

  // 1. Empty / whitespace customMessage is rejected before any send or state mutation
  mkdirSync(join(tempRoot, 'api-empty'), { recursive: true });
  const emptyApi = createFakeAgentApi(join(tempRoot, 'api-empty'), { exitCode: 0 });
  process.env.ANTIGRAVITY_AGENTAPI_EXE = emptyApi.exePath;

  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: decExplicit.id,
        action: 'custom_reply',
        customMessage: '   \t\n  ',
        workspacePath: repoA,
      }),
    /`customMessage` is required/,
  );
  assert.equal(existsSync(emptyApi.captureFile), false, 'empty input must never invoke agentapi');
  assert.equal(listDecisions({ workspacePath: repoA }).length, 1);

  // Unknown explicit decision ID fails closed without sending
  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: 'dec-999',
        action: 'custom_reply',
        customMessage: '不应发送',
        workspacePath: repoA,
      }),
    /Decision not found: dec-999/,
  );
  assert.equal(existsSync(emptyApi.captureFile), false);

  // 2. Cross-project access denied for both explicit decision and auto hint
  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: decExplicit.id,
        action: 'custom_reply',
        customMessage: '跨项目指令',
        workspacePath: repoB,
      }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: 'auto:worktree_archive_ready:thr-061',
        action: 'custom_reply',
        customMessage: '跨项目自动提示指令',
        threadId: 'thr-061',
        autoKind: 'worktree_archive_ready',
        lastCommit: 'cc33dd4 fix: archive ready',
        workspacePath: repoB,
      }),
    /Cross-project access denied/,
  );
  assert.equal(existsSync(emptyApi.captureFile), false, 'cross-project rejection must happen before send');

  // 3. Retired coordinator ID (via coordinatorId or conversationId) is rejected BEFORE send
  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: decExplicit.id,
        action: 'custom_reply',
        customMessage: '退场总控指令',
        workspacePath: repoA,
        coordinatorId: 'conv-coord-a-retired',
      }),
    /has been retired/,
  );
  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: decExplicit.id,
        action: 'custom_reply',
        customMessage: '退场会话指令',
        workspacePath: repoA,
        conversationId: 'conv-coord-a-retired',
      }),
    /has been retired/,
  );
  assert.equal(existsSync(emptyApi.captureFile), false, 'retired coordinator must be blocked before send');

  // 4. Send failure must keep explicit decision pending
  const failDir = join(tempRoot, 'api-fail');
  mkdirSync(failDir, { recursive: true });
  const failApi = createFakeAgentApi(failDir, { exitCode: 1, stderrText: 'Coordinator offline' });
  process.env.ANTIGRAVITY_AGENTAPI_EXE = failApi.exePath;

  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: decExplicit.id,
        action: 'custom_reply',
        customMessage: '先让 Opus 复查再合入',
        workspacePath: repoA,
        conversationId: 'conv-worker-060',
      }),
    /Coordinator offline/,
  );
  assert.equal(listDecisions({ workspacePath: repoA }).length, 1, 'failed custom_reply must keep decision pending');

  // 5. Explicit decision custom_reply success delivers full context to active coordinator & persists resolvedCustomMessage
  const okDir1 = join(tempRoot, 'api-ok-1');
  mkdirSync(okDir1, { recursive: true });
  const okApi1 = createFakeAgentApi(okDir1, { exitCode: 0 });
  process.env.ANTIGRAVITY_AGENTAPI_EXE = okApi1.exePath;

  const staleBeforeResolve = loadRegistry();
  const customRes = await executeDecisionAction({
    decisionId: decExplicit.id,
    action: 'custom_reply',
    customMessage: '合入前顺便把版本号改一下，先让 Opus 复查',
    workspacePath: repoA,
    conversationId: 'conv-worker-060',
  });
  assert.equal(customRes.ok, true);
  assert.equal(customRes.action, 'custom_reply');
  assert.equal(customRes.coordinatorId, 'conv-coord-a-active');
  assert.equal(customRes.customMessage, '合入前顺便把版本号改一下，先让 Opus 复查');
  assert.equal(customRes.decision.status, 'resolved');
  assert.equal(customRes.decision.resolvedOptionId, 'custom_reply');
  assert.equal(customRes.decision.resolvedCustomMessage, '合入前顺便把版本号改一下，先让 Opus 复查');
  assert.equal(listDecisions({ workspacePath: repoA }).length, 0);

  // Stale saveRegistry must NOT revert resolved explicit decision
  saveRegistry(staleBeforeResolve);
  const persistedDec = listDecisions({ workspacePath: repoA, includeResolved: true }).find(
    (d) => d.id === decExplicit.id,
  );
  assert.equal(persistedDec?.status, 'resolved');
  assert.equal(persistedDec?.resolvedCustomMessage, '合入前顺便把版本号改一下，先让 Opus 复查');

  const cap1 = JSON.parse(readFileSync(okApi1.captureFile, 'utf8'));
  assert.ok(cap1.argv.includes('conv-coord-a-active'));
  assert.equal(cap1.argv.includes('conv-worker-060'), false);
  const body1 = cap1.argv[cap1.argv.length - 1];
  assert.match(body1, /\[BOARD_DECISION_CUSTOM_REPLY\]/);
  assert.match(body1, /dec-001/);
  assert.match(body1, /thr-060/);
  assert.match(body1, /是否直接合入 dev？/);
  assert.match(body1, /全部测试已通过，可合入或补充修改。/);
  assert.match(body1, /合入前顺便把版本号改一下，先让 Opus 复查/);

  // 6. P1-2: resolving explicit decision suppresses worktree_merge_ready on the SAME lastCommit;
  //    a new commit re-triggers the auto hint, then test auto custom_reply failure/success/re-trigger
  const boardRightAfterExplicit = buildBoardDecisions({ workspacePath: repoA });
  assert.equal(
    boardRightAfterExplicit.some(
      (d) => d.threadId === 'thr-060' && d.autoKind === 'worktree_merge_ready',
    ),
    false,
    'resolving explicit decision must suppress same-commit worktree_merge_ready rebound',
  );
  assert.equal(
    boardRightAfterExplicit.some(
      (d) => d.threadId === 'thr-061' && d.autoKind === 'worktree_archive_ready',
    ),
    true,
  );

  // Produce a new commit on thr-060 -> worktree_merge_ready auto hint re-triggers cleanly
  const regNewCommit060 = loadRegistry();
  regNewCommit060.threads['thr-060'].git.lastCommit = 'bb22cc3 feat: follow-up commit';
  saveRegistry(regNewCommit060);
  const boardBeforeAuto = buildBoardDecisions({ workspacePath: repoA });
  assert.equal(
    boardBeforeAuto.some((d) => d.threadId === 'thr-060' && d.autoKind === 'worktree_merge_ready'),
    true,
  );

  process.env.ANTIGRAVITY_AGENTAPI_EXE = failApi.exePath;
  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: 'auto:worktree_merge_ready:thr-060',
        action: 'custom_reply',
        customMessage: '先补单测再合并',
        workspacePath: repoA,
      }),
    /Coordinator offline/,
  );
  assert.equal(
    buildBoardDecisions({ workspacePath: repoA }).some(
      (d) => d.threadId === 'thr-060' && d.autoKind === 'worktree_merge_ready',
    ),
    true,
    'failed auto custom_reply must NOT dismiss auto hint',
  );

  const okDir2 = join(tempRoot, 'api-ok-2');
  mkdirSync(okDir2, { recursive: true });
  const okApi2 = createFakeAgentApi(okDir2, { exitCode: 0 });
  process.env.ANTIGRAVITY_AGENTAPI_EXE = okApi2.exePath;

  const autoCustomRes = await executeDecisionAction({
    decisionId: 'auto:worktree_merge_ready:thr-060',
    action: 'custom_reply',
    customMessage: '先补一组边界测试，确认通过后再 cherry-pick',
    workspacePath: repoA,
  });
  assert.equal(autoCustomRes.ok, true);
  assert.equal(autoCustomRes.action, 'custom_reply');
  assert.equal(autoCustomRes.threadId, 'thr-060');
  assert.equal(autoCustomRes.coordinatorId, 'conv-coord-a-active');
  assert.equal(autoCustomRes.autoResult?.resolution, 'custom_reply');
  assert.equal(
    autoCustomRes.autoResult?.customMessage,
    '先补一组边界测试，确认通过后再 cherry-pick',
  );

  const cap2 = JSON.parse(readFileSync(okApi2.captureFile, 'utf8'));
  const body2 = cap2.argv[cap2.argv.length - 1];
  assert.match(body2, /\[BOARD_DECISION_CUSTOM_REPLY\]/);
  assert.match(body2, /thr-060/);
  assert.match(body2, /实现决策自定义指令/);
  assert.match(body2, /Topic:/);
  assert.match(body2, /Summary:/);
  assert.match(body2, /先补一组边界测试，确认通过后再 cherry-pick/);

  // Auto hint for thr-060 stays dismissed for the same lastCommit, while thr-061 remains visible
  const boardAfterAuto = buildBoardDecisions({ workspacePath: repoA });
  assert.equal(
    boardAfterAuto.some((d) => d.threadId === 'thr-060' && d.autoKind === 'worktree_merge_ready'),
    false,
    'handled auto hint stays hidden for same lastCommit',
  );
  assert.equal(
    boardAfterAuto.some((d) => d.threadId === 'thr-061' && d.autoKind === 'worktree_archive_ready'),
    true,
  );

  // New commit on thr-060 re-triggers the auto hint
  const regUpdate = loadRegistry();
  regUpdate.threads['thr-060'].git.lastCommit = 'ee55ff6 test: added edge cases';
  saveRegistry(regUpdate);
  assert.equal(
    buildBoardDecisions({ workspacePath: repoA }).some(
      (d) => d.threadId === 'thr-060' && d.autoKind === 'worktree_merge_ready',
    ),
    true,
    'new commit on thr-060 must re-trigger worktree auto hint',
  );
});

test('Opus P1-1/P1-2/P1-3 regressions: idempotent claim & rollback, merge_ready suppression after explicit resolve, cmd.exe injection immunity, 2000-char limit, newline isolation, and server autoFallback precedence', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-dec-opus-p1-');
  const repoA = join(tempRoot, 'repo-opus-a');
  mkdirSync(repoA, { recursive: true });
  const keyA = normalizeKey(repoA);

  const reg = loadRegistry();
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'conv-coord-opus-1',
    workspacePath: repoA,
    repoRoot: repoA,
    projectId: 'proj-opus-1',
    title: '[Coordinator] OpusP1',
  };
  reg.threads['thr-070'] = {
    threadId: 'thr-070',
    conversationId: 'conv-worker-070',
    workspaceKey: keyA,
    coordinatorId: 'conv-coord-opus-1',
    projectId: 'proj-opus-1',
    title: '功能分支 A',
    branch: 'thread/thr-070-feat',
    baseRef: 'dev',
    worktreePath: join(tempRoot, 'wt-070'),
    archived: false,
    runState: 'RUN_STATE_IDLE',
    bucket: 'idle',
    git: {
      exists: true,
      branch: 'thread/thr-070-feat',
      aheadCount: 1,
      dirtyCount: 0,
      merged: false,
      mergeMethod: '',
      lastCommit: '111aaaa feat: initial work',
    },
  };
  reg.threads['thr-071'] = {
    threadId: 'thr-071',
    conversationId: 'conv-worker-071',
    workspaceKey: keyA,
    coordinatorId: 'conv-coord-opus-1',
    projectId: 'proj-opus-1',
    title: '自动提示安全测试分支',
    branch: 'thread/thr-071-auto',
    baseRef: 'dev',
    worktreePath: join(tempRoot, 'wt-071'),
    archived: false,
    runState: 'RUN_STATE_IDLE',
    bucket: 'idle',
    git: {
      exists: true,
      branch: 'thread/thr-071-auto',
      aheadCount: 2,
      dirtyCount: 0,
      merged: false,
      mergeMethod: '',
      lastCommit: '222bbbb feat: auto ready',
    },
  };
  saveRegistry(reg);

  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59999';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf-opus';

  // --- P1-1: Atomic claim, concurrent double-click rejection, failure rollback, and already_resolved immutability ---
  const decConc = addDecision({
    workspacePath: repoA,
    coordinatorId: 'conv-coord-opus-1',
    threadId: 'thr-070',
    title: '是否将 thr-070 合入 dev？',
    summary: '已通过全部检查，待拍板。',
    options: [
      { id: 'merge', label: '确认合入', action: 'send_coordinator', message: '请合入 thr-070', style: 'primary' },
    ],
  });
  assert.equal(decConc.threadLastCommit, '111aaaa feat: initial work');

  // 1a. Failure rolls back sending claim -> pending so retry can succeed
  const failDir = join(tempRoot, 'p1-fail');
  mkdirSync(failDir, { recursive: true });
  const failApi = createFakeAgentApi(failDir, { exitCode: 1, stderrText: 'temporary failure' });
  process.env.ANTIGRAVITY_AGENTAPI_EXE = failApi.exePath;

  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: decConc.id,
        action: 'custom_reply',
        customMessage: '失败后重试指令',
        workspacePath: repoA,
      }),
    /temporary failure/,
  );
  assert.equal(loadRegistry().decisions[decConc.id].status, 'pending');
  assert.equal(loadRegistry().decisions[decConc.id].sendingClaimToken, '');

  // 1b. Concurrent double-click: only 1 succeeds, the other gets in_progress / already_resolved with 1 agentapi call total
  const slowDir = join(tempRoot, 'p1-slow');
  mkdirSync(slowDir, { recursive: true });
  const slowApi = createFakeAgentApi(slowDir, { exitCode: 0, delayMs: 220 });
  process.env.ANTIGRAVITY_AGENTAPI_EXE = slowApi.exePath;

  const [r1, r2] = await Promise.all([
    executeDecisionAction({
      decisionId: decConc.id,
      action: 'custom_reply',
      customMessage: '第一次并发自定义指令',
      workspacePath: repoA,
    }),
    executeDecisionAction({
      decisionId: decConc.id,
      action: 'custom_reply',
      customMessage: '第二次并发重复指令',
      workspacePath: repoA,
    }),
  ]);
  const winners = [r1, r2].filter((r) => r.ok === true);
  const losers = [r1, r2].filter((r) => r.ok === false);
  assert.equal(winners.length, 1, 'exactly one concurrent action must succeed');
  assert.equal(losers.length, 1, 'the duplicate concurrent action must be rejected');
  assert.ok(['in_progress', 'already_resolved'].includes(losers[0].reason));

  const callLines = readFileSync(slowApi.countFile, 'utf8').trim().split(/\r?\n/);
  assert.equal(callLines.length, 1, 'agentapi must be invoked strictly once under concurrency');

  const firstResolvedAt = winners[0].decision.resolvedAt;
  const firstCustomMsg = winners[0].decision.resolvedCustomMessage;

  // 1c. Re-executing or re-resolving an already resolved decision must fail cleanly without overwriting history or sending again
  const replayRes = await executeDecisionAction({
    decisionId: decConc.id,
    action: 'custom_reply',
    customMessage: '重复重放指令',
    workspacePath: repoA,
  });
  assert.equal(replayRes.ok, false);
  assert.equal(replayRes.alreadyResolved, true);
  assert.equal(replayRes.reason, 'already_resolved');
  assert.equal(
    readFileSync(slowApi.countFile, 'utf8').trim().split(/\r?\n/).length,
    1,
    'already_resolved decision must not invoke agentapi again',
  );
  assert.throws(
    () => resolveDecision({ decisionId: decConc.id, optionId: 'merge' }),
    (err) => err?.code === 'already_resolved' && /already resolved/i.test(err.message),
  );
  const afterReplayDec = loadRegistry().decisions[decConc.id];
  assert.equal(afterReplayDec.resolvedAt, firstResolvedAt);
  assert.equal(afterReplayDec.resolvedCustomMessage, firstCustomMsg);

  // --- P1-2: Resolving explicit decision suppresses worktree_merge_ready rebound on the SAME lastCommit ---
  const boardAfterExplicitResolve = buildBoardDecisions({ workspacePath: repoA });
  assert.equal(
    boardAfterExplicitResolve.some(
      (d) => d.threadId === 'thr-070' && d.autoKind === 'worktree_merge_ready',
    ),
    false,
    'worktree_merge_ready must stay suppressed for the same lastCommit right after explicit decision resolves',
  );

  // If the thread gets merged on the same commit, worktree_archive_ready MUST still surface!
  const regMergedSameCommit = loadRegistry();
  regMergedSameCommit.threads['thr-070'].git.merged = true;
  regMergedSameCommit.threads['thr-070'].git.mergeMethod = 'cherry-pick';
  saveRegistry(regMergedSameCommit);
  assert.equal(
    buildBoardDecisions({ workspacePath: repoA }).some(
      (d) => d.threadId === 'thr-070' && d.autoKind === 'worktree_archive_ready',
    ),
    true,
    'worktree_archive_ready must NOT be suppressed after explicit decision resolves',
  );

  // If the thread produces a NEW unmerged commit, worktree_merge_ready MUST re-trigger!
  const regNewCommit = loadRegistry();
  regNewCommit.threads['thr-070'].git.merged = false;
  regNewCommit.threads['thr-070'].git.mergeMethod = '';
  regNewCommit.threads['thr-070'].git.aheadCount = 2;
  regNewCommit.threads['thr-070'].git.lastCommit = '999ffff feat: follow-up fix';
  saveRegistry(regNewCommit);
  assert.equal(
    buildBoardDecisions({ workspacePath: repoA }).some(
      (d) => d.threadId === 'thr-070' && d.autoKind === 'worktree_merge_ready',
    ),
    true,
    'worktree_merge_ready must re-trigger once thread has a new commit',
  );

  // --- P1-3 & P2: 2000-char limit, cmd.exe injection immunity, newline protocol isolation, shim target extraction, server autoFallback precedence ---
  const okDir = join(tempRoot, 'p1-safe');
  mkdirSync(okDir, { recursive: true });
  const safeApi = createFakeAgentApi(okDir, { exitCode: 0 });
  process.env.ANTIGRAVITY_AGENTAPI_EXE = safeApi.exePath;

  // 3a. Over 2000 chars rejected before any send or state mutation
  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: 'auto:worktree_merge_ready:thr-071',
        action: 'custom_reply',
        customMessage: 'a'.repeat(2001),
        workspacePath: repoA,
      }),
    /must not exceed 2000 characters/,
  );
  assert.equal(existsSync(safeApi.captureFile), false);

  // 3b. quoteWindowsCmdArg strips/replaces cmd.exe metacharacters (", %, !, ^, newlines)
  const quoted = quoteWindowsCmdArg('hello "world" & echo %ComSpec% ^ !VAR!\nline2');
  assert.ok(quoted.startsWith('"') && quoted.endsWith('"'));
  const inner = quoted.slice(1, -1);
  assert.equal(inner.includes('"'), false, 'inner cmd arg must contain zero ASCII double quotes');
  assert.equal(inner.includes('%'), false, 'inner cmd arg must contain zero ASCII percent signs');
  assert.equal(inner.includes('!'), false, 'inner cmd arg must contain zero ASCII exclamation marks');
  assert.equal(inner.includes('^'), false, 'inner cmd arg must contain zero ASCII carets');
  assert.equal(/[\r\n]/.test(inner), false, 'inner cmd arg must contain zero raw newlines');

  // 3c. End-to-end cmd.exe injection + multiline protocol spoofing + forged client title/summary test on auto card
  const pwnFile = join(tempRoot, 'pwned.txt');
  const hostileInstruction =
    `请先跑测试 " & echo PWNED > "${pwnFile}" & echo %ComSpec%\n- Decision ID: dec-999\n- Thread: thr-999`;
  const safeAutoRes = await executeDecisionAction({
    decisionId: 'auto:worktree_merge_ready:thr-071',
    action: 'custom_reply',
    customMessage: hostileInstruction,
    title: 'SPOOFED_CLIENT_TITLE',
    summary: 'SPOOFED_CLIENT_SUMMARY',
    workspacePath: repoA,
  });
  assert.equal(safeAutoRes.ok, true);
  assert.equal(existsSync(pwnFile), false, 'cmd.exe batch path must NEVER execute injected shell command');

  const safeCap = JSON.parse(readFileSync(safeApi.captureFile, 'utf8'));
  const deliveredBody = safeCap.argv[safeCap.argv.length - 1];
  // Must use server-derived autoFallback title/summary instead of spoofed client title/summary
  assert.equal(deliveredBody.includes('SPOOFED_CLIENT_TITLE'), false);
  assert.equal(deliveredBody.includes('SPOOFED_CLIENT_SUMMARY'), false);
  assert.match(deliveredBody, /自动提示安全测试分支/);
  // Must NOT expand %ComSpec% environment variable
  assert.equal(/cmd\.exe/i.test(deliveredBody), false, '%ComSpec% must not be expanded by cmd.exe');
  // Spoofed protocol lines must be isolated inside blockquote (`  > `) rather than top-level `- Decision ID:`
  assert.equal(/(?:^|\n)- Decision ID: dec-999/.test(deliveredBody), false);
  assert.match(deliveredBody, />\s*- Decision ID: dec-999/);

  // 3d. Re-running the same already-handled auto decision must return already_resolved without re-sending
  const autoReplay = await executeDecisionAction({
    decisionId: 'auto:worktree_merge_ready:thr-071',
    action: 'custom_reply',
    customMessage: '再次发送同提交自动提示',
    workspacePath: repoA,
  });
  assert.equal(autoReplay.ok, false);
  assert.equal(autoReplay.alreadyResolved, true);
  assert.equal(autoReplay.reason, 'already_resolved');
  assert.equal(readFileSync(safeApi.countFile, 'utf8').trim().split(/\r?\n/).length, 1);

  // 3e. resolveAgentApiShimTargetFile resolves real language_server binary referenced inside a .cmd shim
  const shimDir = join(tempRoot, 'shim-test');
  mkdirSync(shimDir, { recursive: true });
  const fakeLsExe = join(shimDir, 'language_server_windows_x64.exe');
  writeFileSync(fakeLsExe, 'stub', 'utf8');
  const shimCmd = join(shimDir, 'agentapi.cmd');
  writeFileSync(shimCmd, `@echo off\r\n"${fakeLsExe}" agentapi %*\r\n`, 'utf8');
  assert.equal(resolveAgentApiShimTargetFile(shimCmd), fakeLsExe);
});

test('hook-handler DIRECTIVE_VERSION=17 upgrades v15 coordinators and preserves both #7 review mode and #9 everyday pending-decision registration across hook, SKILL.md, rules/AGENTS.md, and MCP', (t) => {
  const hookHandler = readFileSync(new URL('../scripts/hook-handler.mjs', import.meta.url), 'utf8');
  const skillMd = readFileSync(new URL('../skills/coord/SKILL.md', import.meta.url), 'utf8');
  const rulesMd = readFileSync(new URL('../rules/AGENTS.md', import.meta.url), 'utf8');
  const serverMjs = readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');

  assert.match(hookHandler, /const\s+DIRECTIVE_VERSION\s*=\s*17\s*;/);
  assert.match(hookHandler, /threadType:\s*"review"/);
  assert.match(skillMd, /threadType:\s*"review"/);
  assert.match(skillMd, /manage_decisions/);
  assert.match(skillMd, /Pending Decisions/i);
  assert.match(skillMd, /Not limited to Worker Thread completion callbacks/i);
  assert.match(skillMd, /everyday planning discussions/i);
  assert.match(rulesMd, /threadType:\s*"review"/);
  assert.match(rulesMd, /manage_decisions/);
  assert.match(rulesMd, /Pending Decisions/i);
  assert.match(rulesMd, /Not limited to Worker Thread callbacks/i);
  assert.match(rulesMd, /everyday planning discussions/i);
  assert.match(serverMjs, /Not limited to Worker Thread callbacks/i);

  const env = createTempEnv(t, 'pt-dec-hook-');
  const ws = join(env.tempRoot, 'hook-repo');
  const reg = loadRegistry();
  reg.coordinators['__v15_upgrade__'] = {
    key: '__v15_upgrade__',
    conversationId: 'conv-v15-coord',
    workspacePath: ws,
    repoRoot: ws,
    title: '[Coordinator] UpgradeV16',
    directiveVersion: 15,
  };
  saveRegistry(reg);

  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const res = spawnSync(process.execPath, ['scripts/hook-handler.mjs', 'PreInvocation'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: env.geminiDir,
      ANTIGRAVITY_APP_DATA_DIR: env.appDataDir,
    },
    input: JSON.stringify({
      hookEventName: 'PreInvocation',
      conversationId: 'conv-v15-coord',
      initialNumSteps: 8,
    }),
    encoding: 'utf8',
  });

  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout.trim());
  const injected = out?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
  assert.match(injected, /threadType:\s*"review"/);
  assert.match(injected, /manage_decisions/);
  assert.match(injected, /Pending Decisions/i);
  assert.match(injected, /Not limited to Worker Thread completion callbacks/i);
  assert.match(injected, /everyday planning discussions/i);
  assert.match(injected, /action:\s*"add"/);
  assert.match(injected, /action:\s*"resolve"/);
  assert.equal(loadRegistry().coordinators['__v15_upgrade__'].directiveVersion, 17);
});

test('Sidecar backend/frontend static and UI rendering checks for Pending Decisions panel, custom instruction input, API revision 6, capability gating, IME/draft guards, 3-locale I18N, no middle dot, no native dialogs, and LF endings', () => {
  const mainMjs = readFileSync(new URL('../sidecars/threads/main.mjs', import.meta.url), 'utf8');
  const {
    appSource,
    htmlSource,
    cssSource,
    I18N,
    setLocale,
    renderDecisionsPanelHtml,
    renderO2ThreadCard,
  } = loadUiDecisionHelpers();

  // Backend dual API registration, SERVER_API_REVISION=7, and review_model + decision_custom_reply + topic_memory + watchdog_patrol capabilities
  assert.match(mainMjs, /const\s+SERVER_API_REVISION\s*=\s*7\s*;/);
  assert.match(mainMjs, /['"]review_model['"]/);
  assert.match(mainMjs, /['"]decision_custom_reply['"]/);
  assert.match(mainMjs, /['"]topic_memory['"]/);
  assert.match(mainMjs, /['"]watchdog_patrol['"]/);
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/decision_action['"]/);
  assert.match(mainMjs, /executeDecisionAction/);
  assert.match(mainMjs, /customMessage:\s*data\.customMessage/);
  assert.match(mainMjs, /handleDecisionAction[\s\S]*?serverInfo:\s*buildServerInfo\(\)/);

  // Frontend API revision 7, capability gating, maxlength 2000, strict res.action check, no GET fallback & no short timeout
  assert.match(appSource, /const\s+EXPECTED_SERVER_API_REVISION\s*=\s*7\s*;/);
  assert.match(appSource, /const\s+MAX_DECISION_CUSTOM_MESSAGE_LEN\s*=\s*2000\s*;/);
  assert.match(appSource, /function\s+supportsDecisionCustomReply\s*\(/);
  assert.match(appSource, /serverCapabilities\.has\(['"]decision_custom_reply['"]\)/);
  assert.match(appSource, /res\.action\s*!==\s*['"]custom_reply['"]/);
  const decisionPostCalls = [...appSource.matchAll(/postApi\(\s*['"]\/api\/decision_action['"][\s\S]*?\}\s*\);/g)];
  assert.ok(decisionPostCalls.length >= 2, 'both quick action and custom reply must call /api/decision_action');
  for (const m of decisionPostCalls) {
    assert.match(m[0], /timeoutMs:\s*0/);
    assert.match(m[0], /allowGetFallback:\s*false/);
  }
  assert.match(appSource, /expandedCustomDecisionIds/);
  assert.match(appSource, /decisionCustomDrafts/);
  assert.match(appSource, /decisionImeComposingIds/);
  assert.match(appSource, /lastDecisionsRenderKey/);
  assert.match(appSource, /deferredDecisionsList/);
  assert.match(appSource, /e\.isComposing\s*\|\|\s*e\.keyCode\s*===\s*229/);
  assert.match(appSource, /e\.key\s*===\s*['"]Escape['"]/);
  assert.match(appSource, /setSelectionRange/);

  // HTML structure: #decisions-panel placed before #threads-cards inside #threads-pane
  const panelIdx = htmlSource.indexOf('id="decisions-panel"');
  const cardsIdx = htmlSource.indexOf('id="threads-cards"');
  assert.notEqual(panelIdx, -1, '#decisions-panel must exist in index.html');
  assert.ok(panelIdx < cardsIdx, '#decisions-panel must be positioned above #threads-cards (Running section)');

  // Zero native confirm/alert/prompt
  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appSource), false);

  // App invokes /api/decision_action and includes decisions in refreshBoard key
  assert.match(appSource, /\/api\/decision_action/);
  assert.match(appSource, /decisions:\s*data\.decisions\s*\|\|\s*\[\]/);

  // CSS rules for panel, cards, custom input row, thread linkage badge, and light theme support
  assert.match(cssSource, /\.decisions-panel\s*\{/);
  assert.match(cssSource, /\.decision-card\s*\{/);
  assert.match(cssSource, /\.dec-thread-badge\s*\{/);
  assert.match(cssSource, /\.dec-btn\.dec-btn-custom\s*\{/);
  assert.match(cssSource, /\.dec-custom-row\s*\{/);
  assert.match(cssSource, /\.dec-custom-input\s*\{/);
  assert.match(cssSource, /\.dec-custom-send\s*\{/);
  assert.match(cssSource, /\.o2-dec-badge\s*\{/);
  assert.match(cssSource, /:root\[data-theme="light"\]\s+\.decisions-panel\s*\{/);
  assert.match(cssSource, /:root\[data-theme="light"\]\s+\.dec-custom-input\s*\{/);

  // 3-locale I18N completeness and zero middle dot in decision strings
  const decisionI18nKeys = [
    'decisionsTitle',
    'decisionBadge',
    'decisionAutoTag',
    'decisionToggleTip',
    'decisionDismissTip',
    'decisionThreadTip',
    'decisionWorking',
    'decisionSentCoordToast',
    'decisionDismissedToast',
    'decisionActionErrToast',
    'decisionAutoMergeTitle',
    'decisionAutoMergeSummary',
    'decisionAutoMergeBtn',
    'decisionAutoArchiveTitle',
    'decisionAutoArchiveSummary',
    'decisionAutoArchiveBtn',
    'decisionDismissBtn',
    'decisionCustomBtn',
    'decisionCustomPlaceholder',
    'decisionCustomSendBtn',
    'decisionCustomEmptyToast',
    'decisionCustomSentToast',
    'decisionCustomInputTip',
    'decisionCustomUnsupportedErr',
    'decisionCustomTooLongToast',
    'decisionAlreadyResolvedToast',
  ];
  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    for (const k of decisionI18nKeys) {
      assert.ok(I18N[loc][k] !== undefined, `Missing ${k} in ${loc}`);
      if (typeof I18N[loc][k] === 'string') {
        assert.equal(I18N[loc][k].includes('·'), false, `${loc}.${k} must not use middle dot`);
      } else if (typeof I18N[loc][k] === 'function') {
        const sample = I18N[loc][k](2000, 'b', 1);
        assert.equal(String(sample).includes('·'), false, `${loc}.${k}() must not use middle dot`);
      }
    }
  }

  // Empty decisions render empty HTML (zero footprint)
  assert.equal(renderDecisionsPanelHtml([]), '');

  const sampleDecisions = [
    {
      id: 'dec-001',
      source: 'explicit',
      threadId: 'thr-044',
      title: '是否合入待决策面板？',
      summary: '全部测试通过，请拍板。',
      options: [
        { id: 'merge', label: '合入 dev', action: 'send_coordinator', style: 'primary' },
        { id: 'dismiss', label: '暂缓', action: 'dismiss', style: 'secondary' },
      ],
    },
    {
      id: 'auto:worktree_archive_ready:thr-045',
      source: 'auto',
      autoKind: 'worktree_archive_ready',
      threadId: 'thr-045',
      threadTitle: '优化样式',
      branch: 'thread/thr-045-ui',
      mergeMethod: 'cherry-pick',
      options: [
        { id: 'accept_archive', label: '验收归档', action: 'archive_thread', style: 'primary' },
        { id: 'dismiss', label: '忽略', action: 'dismiss', style: 'secondary' },
      ],
    },
  ];

  // P0-2 capability gating: when backend lacks decision_custom_reply, hide toggle button & input completely
  setLocale('zh-CN');
  const gatedOffHtml = renderDecisionsPanelHtml(sampleDecisions, {
    expandedIds: new Set(['dec-001']),
    drafts: new Map([['dec-001', 'draft']]),
    customReplyEnabled: false,
  });
  assert.equal(gatedOffHtml.includes('data-dec-custom-toggle='), false);
  assert.equal(gatedOffHtml.includes('data-dec-custom-input='), false);

  for (const [loc, expectedTitle, expectedBadge, expectedArchiveBtn, expectedCustomBtn, expectedSendBtn] of [
    ['zh-CN', '待决策', '待决策', '验收归档', '其他指令', '发送'],
    ['zh-TW', '待決策', '待決策', '驗收封存', '其他指令', '傳送'],
    ['en', 'Pending Decisions', 'Decision', 'Accept &amp; Archive', 'Other instruction', 'Send'],
  ]) {
    setLocale(loc);
    // Collapsed by default: toggle button rendered on both explicit and auto cards, input row hidden
    const panelHtml = renderDecisionsPanelHtml(sampleDecisions, { customReplyEnabled: true });
    assert.match(panelHtml, new RegExp(expectedTitle));
    assert.match(panelHtml, /data-dec-thread="thr-044"/);
    assert.match(panelHtml, /data-dec-dismiss="dec-001"/);
    assert.match(panelHtml, new RegExp(expectedArchiveBtn));
    assert.match(panelHtml, /data-dec-custom-toggle="dec-001"/);
    assert.match(panelHtml, /data-dec-custom-toggle="auto:worktree_archive_ready:thr-045"/);
    assert.match(panelHtml, new RegExp(expectedCustomBtn));
    assert.equal(panelHtml.includes('data-dec-custom-input='), false, 'custom input must stay collapsed by default');
    assert.equal(panelHtml.includes('·'), false, `${loc} decisions panel must never use middle dot`);

    // Expanded with per-decisionId draft preservation & maxlength="2000"
    const expandedPanelHtml = renderDecisionsPanelHtml(sampleDecisions, {
      expandedIds: new Set(['dec-001']),
      drafts: new Map([
        ['dec-001', '先改版本号再合入'],
        ['auto:worktree_archive_ready:thr-045', '保留分支待复查'],
      ]),
      customReplyEnabled: true,
    });
    assert.match(expandedPanelHtml, /data-dec-custom-input="dec-001"/);
    assert.match(expandedPanelHtml, /maxlength="2000"/);
    assert.match(expandedPanelHtml, /value="先改版本号再合入"/);
    assert.match(expandedPanelHtml, /data-dec-custom-send="dec-001"/);
    assert.match(expandedPanelHtml, new RegExp(expectedSendBtn));
    assert.match(expandedPanelHtml, /dec-btn-custom has-draft" data-dec-custom-toggle="auto:worktree_archive_ready:thr-045"/);
    assert.equal(expandedPanelHtml.includes('·'), false);

    // Expanded with empty draft keeps Send button disabled
    const emptyDraftHtml = renderDecisionsPanelHtml(sampleDecisions, {
      expandedIds: new Set(['auto:worktree_archive_ready:thr-045']),
      drafts: new Map([['auto:worktree_archive_ready:thr-045', '   ']]),
      customReplyEnabled: true,
    });
    assert.match(
      emptyDraftHtml,
      /data-dec-custom-send="auto:worktree_archive_ready:thr-045" disabled/,
    );

    const cardWithDec = renderO2ThreadCard(
      { threadId: 'thr-044', title: '待决策测试', bucket: 'idle', stepsProgress: { done: 2, total: 2 } },
      new Set(['thr-044']),
    );
    assert.match(cardWithDec, /has-decision/);
    assert.match(cardWithDec, new RegExp(`<span class="o2-dec-badge">${expectedBadge}</span>`));

    const cardWithoutDec = renderO2ThreadCard(
      { threadId: 'thr-099', title: '普通线程', bucket: 'idle', stepsProgress: { done: 2, total: 2 } },
      new Set(['thr-044']),
    );
    assert.equal(cardWithoutDec.includes('o2-dec-badge'), false);
  }

  // LF line endings check on all modified/added .mjs files
  for (const rel of [
    '../lib/ls-client.mjs',
    '../lib/store.mjs',
    '../mcp/server.mjs',
    '../scripts/hook-handler.mjs',
    '../sidecars/threads/main.mjs',
    '../tests/decisions-board.test.mjs',
    '../tests/coordinator-rebind.test.mjs',
    '../tests/project-scope-seq.test.mjs',
    '../tests/review-model.test.mjs',
    '../tests/settings-default-model.test.mjs',
    '../tests/worker-language.test.mjs',
  ]) {
    const raw = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!raw.includes(Buffer.from('\r')), `${rel} must use LF line endings`);
  }
});

test('Sidecar handleDecisionCustomSubmit enforces capability gate, 2000-char limit, strict res.action===custom_reply check, alreadyResolved cleanup, allowGetFallback:false with timeoutMs:0, and draft preservation', async () => {
  const appSource = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
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
  const getLocalizedFn = extractFunctionSource(appSource, 'getLocalizedDecisionDisplay');
  const supportsFn = extractFunctionSource(appSource, 'supportsDecisionCustomReply');
  const submitFn = extractFunctionSource(appSource, 'handleDecisionCustomSubmit');

  const ctx = {};
  vm.runInNewContext(
    `
    ${i18nCode};
    const MAX_DECISION_CUSTOM_MESSAGE_LEN = 2000;
    let curLocale = 'zh-CN';
    const L = () => I18N[curLocale] || I18N.en;
    let serverCapabilities = new Set();
    const pendingDecisionIds = new Set();
    const expandedCustomDecisionIds = new Set(['dec-1']);
    const decisionCustomDrafts = new Map([['dec-1', '先改版本号']]);
    const decisionImeComposingIds = new Set();
    let cachedDecisions = [{
      id: 'dec-1',
      source: 'explicit',
      threadId: 'thr-044',
      title: '是否合入 dev？',
      summary: '测试全通过。',
      coordinatorId: 'coord-old',
      options: [],
    }];
    let lastSnap = { coordinator: { conversationId: 'coord-live' } };
    let lastBoardKey = 'prev-key';
    const toasts = [];
    const postCalls = [];
    const renderCalls = [];
    let refreshCount = 0;
    let nextPostResp = { ok: false, error: 'backend busy' };
    const buildScopePayload = (extra) => ({ workspace: '/repo', conversationId: 'conv-host', projectId: 'proj-1', ...extra });
    const flashToast = (msg, kind) => toasts.push({ msg, kind });
    const renderDecisionsPanel = (list, opts) => renderCalls.push({ count: list.length, opts });
    const refreshBoard = () => { refreshCount++; };
    const postApi = async (postPath, getPath, payload, opts) => {
      postCalls.push({ postPath, getPath, payload, opts });
      return nextPostResp;
    };
    ${getLocalizedFn}
    ${supportsFn}
    ${submitFn}
    this.runTest = async () => {
      const dec = cachedDecisions[0];
      // 0. P0-2: Without decision_custom_reply capability, submit is blocked immediately without network call
      await handleDecisionCustomSubmit(dec, { value: '旧后端测试' }, null);
      if (postCalls.length !== 0) throw new Error('Missing capability must block submit before postApi');

      // Enable capability for remaining checks
      serverCapabilities = new Set(['decisions', 'decision_custom_reply']);

      // 1. Blank input blocked with toast, zero network calls
      let focused = 0;
      await handleDecisionCustomSubmit(dec, { value: '   ', focus: () => { focused++; } }, null);
      if (postCalls.length !== 0) throw new Error('Blank input should not call postApi');
      if (focused !== 1) throw new Error('Blank input should refocus input');

      // 1b. Over-2000-char input blocked before network call
      await handleDecisionCustomSubmit(dec, { value: 'x'.repeat(2001), focus: () => { focused++; } }, null);
      if (postCalls.length !== 0) throw new Error('Overlong input should not call postApi');
      if (focused !== 2) throw new Error('Overlong input should refocus input');

      // 2. P0-2: Old backend returning { ok: true, action: 'dismiss' } MUST be treated as failure and preserve draft!
      nextPostResp = { ok: true, action: 'dismiss', dismissed: true };
      await handleDecisionCustomSubmit(dec, { value: '先改版本号再合并' }, { textContent: '发送' });
      if (postCalls.length !== 1) throw new Error('Expected 1 postApi call');
      if (postCalls[0].opts.timeoutMs !== 0 || postCalls[0].opts.allowGetFallback !== false) {
        throw new Error('Write API must set timeoutMs:0 and allowGetFallback:false');
      }
      if (!expandedCustomDecisionIds.has('dec-1') || decisionCustomDrafts.get('dec-1') !== '先改版本号再合并') {
        throw new Error('Mismatched res.action (stale dismiss fallback) must preserve expanded state and draft');
      }
      if (cachedDecisions.length !== 1) {
        throw new Error('Mismatched res.action must NOT silently remove card as sent');
      }

      // 3. Backend error preserves expanded state & user draft
      nextPostResp = { ok: false, error: 'backend busy' };
      await handleDecisionCustomSubmit(dec, { value: '先改版本号再合并' }, { textContent: '发送' });
      if (postCalls[1].payload.coordinatorId !== 'coord-live') {
        throw new Error('Must prefer live coordinatorId from lastSnap');
      }
      if (!expandedCustomDecisionIds.has('dec-1') || decisionCustomDrafts.get('dec-1') !== '先改版本号再合并') {
        throw new Error('Failure must preserve expanded state and draft');
      }
      if (pendingDecisionIds.has('dec-1')) {
        throw new Error('Failure must clear busy state');
      }

      // 4. Backend success with res.action === 'custom_reply' clears expanded/draft/decision and refreshes board
      nextPostResp = { ok: true, action: 'custom_reply', decisionId: 'dec-1' };
      await handleDecisionCustomSubmit(dec, { value: '先改版本号再合并' }, { textContent: '发送' });
      if (expandedCustomDecisionIds.has('dec-1') || decisionCustomDrafts.has('dec-1')) {
        throw new Error('Success must clear expanded state and draft');
      }
      if (cachedDecisions.length !== 0 || lastBoardKey !== '' || refreshCount !== 1) {
        throw new Error('Success must remove decision and refresh board');
      }

      // 5. P1-1: alreadyResolved response removes stale card cleanly and refreshes board
      cachedDecisions = [dec];
      expandedCustomDecisionIds.add('dec-1');
      decisionCustomDrafts.set('dec-1', '重复提交');
      lastBoardKey = 'stale-key';
      nextPostResp = { ok: false, alreadyResolved: true, reason: 'already_resolved' };
      await handleDecisionCustomSubmit(dec, { value: '重复提交' }, { textContent: '发送' });
      if (cachedDecisions.length !== 0 || expandedCustomDecisionIds.has('dec-1') || refreshCount !== 2) {
        throw new Error('alreadyResolved must clear stale card and refresh board');
      }
      return { toasts, postCalls, renderCalls };
    };
    `,
    ctx,
  );

  const out = await ctx.runTest();
  assert.equal(out.toasts[0].kind, 'err'); // missing capability
  assert.equal(out.toasts[1].kind, 'err'); // blank
  assert.equal(out.toasts[2].kind, 'err'); // too long
  assert.equal(out.toasts[3].kind, 'err'); // mismatched action: dismiss
  assert.equal(out.toasts[4].kind, 'err'); // backend error
  assert.equal(out.toasts[5].kind, 'ok');  // custom_reply success
  assert.equal(out.toasts[6].kind, 'ok');  // alreadyResolved cleanup
  assert.equal(out.postCalls[2].payload.action, 'custom_reply');
  assert.equal(out.postCalls[2].payload.customMessage, '先改版本号再合并');
  assert.equal(out.postCalls[2].payload.title, '是否合入 dev？');
  assert.equal(out.postCalls[2].payload.summary, '测试全通过。');
});

test('Bug #11: executeDecisionAction accepts file:// URIs (encoded drive & localhost), Worktrees, and repo subdirs while staying fail-closed on cross-project URI or conflicting projectId', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-dec-bug11-');
  const repoA = join(tempRoot, 'proj-alpha');
  const repoASubdir = join(repoA, 'packages', 'core');
  const repoAWorktree = join(tempRoot, '.worktrees', 'proj-alpha', 'thr-083-fix');
  const repoB = join(tempRoot, 'proj-beta');
  mkdirSync(repoASubdir, { recursive: true });
  mkdirSync(repoAWorktree, { recursive: true });
  mkdirSync(repoB, { recursive: true });

  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);
  const fakeApi = createFakeAgentApi(tempRoot);
  process.env.ANTIGRAVITY_AGENTAPI_EXE = fakeApi.exePath;

  const reg = loadRegistry();
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'coord-bug11-a',
    workspacePath: repoA,
    repoRoot: repoA,
    projectId: 'proj-bug11-a',
    title: '[Coordinator] Alpha',
  };
  reg.coordinators[keyB] = {
    key: keyB,
    conversationId: 'coord-bug11-b',
    workspacePath: repoB,
    repoRoot: repoB,
    projectId: 'proj-bug11-b',
    title: '[Coordinator] Beta',
  };
  reg.threads['thr-083'] = {
    threadId: 'thr-083',
    conversationId: 'conv-bug11-083',
    coordinatorId: 'coord-bug11-a',
    workspaceKey: keyA,
    repoRoot: repoA,
    worktreePath: repoAWorktree,
    branch: 'thread/thr-083-fix',
    projectId: 'proj-bug11-a',
    title: 'Thread 083',
    archived: false,
    runState: 'RUN_STATE_IDLE',
    git: { exists: true, dirtyCount: 0, aheadCount: 1, merged: false, lastCommit: 'abc0831' },
  };
  reg.threads['thr-084'] = {
    threadId: 'thr-084',
    conversationId: 'conv-bug11-084',
    coordinatorId: 'coord-bug11-a',
    workspaceKey: keyA,
    repoRoot: repoA,
    worktreePath: '',
    branch: '',
    projectId: 'proj-bug11-a',
    title: 'Thread 084',
    archived: false,
    runState: 'RUN_STATE_IDLE',
  };
  saveRegistry(reg);

  const toEncodedFileUri = (fsPath) => {
    const base = pathToFileURL(fsPath).href;
    // Simulate Antigravity / VS Code encoded Windows drive colon (file:///c%3A/...)
    return base.replace(/^file:\/\/\/([A-Za-z]):/, (_, d) => `file:///${d.toLowerCase()}%3A`);
  };
  const toLocalhostFileUri = (fsPath) =>
    toEncodedFileUri(fsPath).replace(/^file:\/\/\//, 'file://localhost/');

  const repoAEncodedUri = toEncodedFileUri(repoA);
  const repoALocalhostUri = toLocalhostFileUri(repoA);
  const repoAWorktreeUri = toEncodedFileUri(repoAWorktree);
  const repoASubdirUri = toEncodedFileUri(repoASubdir);
  const repoBEncodedUri = toEncodedFileUri(repoB);

  // 1. Auto worktree_merge_ready decision via encoded file:/// URI -> send_coordinator succeeds
  const autoSendRes = await executeDecisionAction({
    decisionId: 'auto:worktree_merge_ready:thr-083',
    optionId: 'merge',
    action: 'send_coordinator',
    threadId: 'thr-083',
    autoKind: 'worktree_merge_ready',
    lastCommit: 'abc0831',
    label: '合入目标分支',
    workspacePath: repoAEncodedUri,
    coordinatorId: 'coord-bug11-a',
  });
  assert.equal(autoSendRes.ok, true);
  assert.equal(autoSendRes.action, 'send_coordinator');
  assert.equal(autoSendRes.coordinatorId, 'coord-bug11-a');

  // 2. Auto worktree_merge_ready decision via file://localhost/ URI -> dismiss succeeds
  const autoDismissRes = await executeDecisionAction({
    decisionId: 'auto:worktree_merge_ready:thr-083',
    action: 'dismiss',
    threadId: 'thr-083',
    autoKind: 'worktree_merge_ready',
    lastCommit: 'abc0832',
    workspacePath: repoALocalhostUri,
  });
  assert.equal(autoDismissRes.ok, true);
  assert.equal(autoDismissRes.dismissed, true);

  // 3. Explicit decision with threadId via Worktree URI -> custom_reply succeeds
  const decCustom = addDecision({
    workspacePath: repoAEncodedUri,
    threadId: 'thr-083',
    projectId: 'proj-bug11-a',
    title: 'Worktree URI custom reply test',
    options: [{ id: 'go', label: 'Proceed', action: 'send_coordinator', style: 'primary' }],
  });
  const customWtRes = await executeDecisionAction({
    decisionId: decCustom.id,
    action: 'custom_reply',
    customMessage: '先跑测试再合入',
    threadId: 'thr-083',
    workspacePath: repoAWorktreeUri,
  });
  assert.equal(customWtRes.ok, true);
  assert.equal(customWtRes.action, 'custom_reply');
  assert.equal(customWtRes.decision.status, 'resolved');

  // 4. Explicit decision with threadId via nested repo subdirectory URI & plain path -> dismiss + archive_thread succeed
  const decSubdir = addDecision({
    workspacePath: repoASubdir,
    threadId: 'thr-084',
    projectId: 'proj-bug11-a',
    title: 'Subdir dismiss test',
    options: [{ id: 'ok', label: 'OK', action: 'send_coordinator', style: 'primary' }],
  });
  const subdirDismissRes = await executeDecisionAction({
    decisionId: decSubdir.id,
    action: 'dismiss',
    threadId: 'thr-084',
    workspacePath: repoASubdirUri,
  });
  assert.equal(subdirDismissRes.ok, true);
  assert.equal(subdirDismissRes.dismissed, true);

  const decArch = addDecision({
    workspacePath: repoA,
    threadId: 'thr-084',
    projectId: 'proj-bug11-a',
    title: 'Subdir archive test',
    options: [{ id: 'arch', label: 'Archive', action: 'archive_thread', style: 'primary' }],
  });
  const archRes = await executeDecisionAction({
    decisionId: decArch.id,
    optionId: 'arch',
    action: 'archive_thread',
    threadId: 'thr-084',
    workspacePath: repoASubdir,
  });
  assert.equal(archRes.ok, true);
  assert.equal(archRes.action, 'archive_thread');
  assert.equal(loadRegistry().threads['thr-084'].archived, true);

  // 5. Cross-project fail-closed: foreign project file:// URI is strictly rejected
  const decProtected = addDecision({
    workspacePath: repoA,
    threadId: 'thr-083',
    projectId: 'proj-bug11-a',
    title: 'Protected cross-project decision',
    options: [{ id: 'ok', label: 'OK', action: 'send_coordinator', style: 'primary' }],
  });
  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: decProtected.id,
        action: 'dismiss',
        threadId: 'thr-083',
        workspacePath: repoBEncodedUri,
      }),
    /Cross-project access denied/,
  );

  // 6. Cross-project fail-closed: matching workspacePath URI + explicit conflicting projectId is strictly rejected
  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: decProtected.id,
        action: 'dismiss',
        threadId: 'thr-083',
        workspacePath: repoAEncodedUri,
        projectId: 'proj-bug11-b',
      }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () =>
      executeDecisionAction({
        decisionId: decProtected.id,
        action: 'custom_reply',
        customMessage: 'spoofed project',
        threadId: 'thr-083',
        workspacePath: repoAEncodedUri,
        projectId: 'proj-bug11-b',
      }),
    /Cross-project access denied/,
  );
  assert.equal(
    listDecisions({ workspacePath: repoA }).some((d) => d.id === decProtected.id),
    true,
    'Blocked cross-project attempts must leave decision pending',
  );
});

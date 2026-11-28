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
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  addDecision,
  buildBoardDecisions,
  dismissDecision,
  executeDecisionAction,
  listDecisions,
  loadRegistry,
  normalizeKey,
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

function createFakeAgentApi(dir, { exitCode = 0, stderrText = '' } = {}) {
  const captureFile = join(dir, 'agentapi-capture.json');
  const runnerScript = join(dir, 'fake-agentapi.mjs');
  writeFileSync(
    runnerScript,
    [
      'import { writeFileSync } from "node:fs";',
      `const capturePath = ${JSON.stringify(captureFile)};`,
      'writeFileSync(capturePath, JSON.stringify({ argv: process.argv.slice(2), env: { projectId: process.env.ANTIGRAVITY_PROJECT_ID || "" } }, null, 2), "utf8");',
      stderrText ? `process.stderr.write(${JSON.stringify(stderrText)});` : '',
      `process.exit(${Number(exitCode) || 0});`,
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

  return { exePath, captureFile };
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

  // 6. Auto Worktree hint custom_reply: failed send must NOT dismiss; success delivers full auto context and records threadId+autoKind+lastCommit dismissal
  const boardBeforeAuto = buildBoardDecisions({ workspacePath: repoA });
  assert.equal(
    boardBeforeAuto.some((d) => d.threadId === 'thr-060' && d.autoKind === 'worktree_merge_ready'),
    true,
  );
  assert.equal(
    boardBeforeAuto.some((d) => d.threadId === 'thr-061' && d.autoKind === 'worktree_archive_ready'),
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

test('hook-handler DIRECTIVE_VERSION=15 upgrades v14 coordinators and reinforces everyday pending-decision registration across hook, SKILL.md, rules/AGENTS.md, and MCP', (t) => {
  const hookHandler = readFileSync(new URL('../scripts/hook-handler.mjs', import.meta.url), 'utf8');
  const skillMd = readFileSync(new URL('../skills/coord/SKILL.md', import.meta.url), 'utf8');
  const rulesMd = readFileSync(new URL('../rules/AGENTS.md', import.meta.url), 'utf8');
  const serverMjs = readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');

  assert.match(hookHandler, /const\s+DIRECTIVE_VERSION\s*=\s*15\s*;/);
  assert.match(skillMd, /manage_decisions/);
  assert.match(skillMd, /Pending Decisions/i);
  assert.match(skillMd, /Not limited to Worker Thread completion callbacks/i);
  assert.match(skillMd, /everyday planning discussions/i);
  assert.match(rulesMd, /manage_decisions/);
  assert.match(rulesMd, /Pending Decisions/i);
  assert.match(rulesMd, /Not limited to Worker Thread callbacks/i);
  assert.match(rulesMd, /everyday planning discussions/i);
  assert.match(serverMjs, /Not limited to Worker Thread callbacks/i);

  const env = createTempEnv(t, 'pt-dec-hook-');
  const ws = join(env.tempRoot, 'hook-repo');
  const reg = loadRegistry();
  reg.coordinators['__v14_upgrade__'] = {
    key: '__v14_upgrade__',
    conversationId: 'conv-v14-coord',
    workspacePath: ws,
    repoRoot: ws,
    title: '[Coordinator] UpgradeV15',
    directiveVersion: 14,
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
      conversationId: 'conv-v14-coord',
      initialNumSteps: 8,
    }),
    encoding: 'utf8',
  });

  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout.trim());
  const injected = out?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
  assert.match(injected, /manage_decisions/);
  assert.match(injected, /Pending Decisions/i);
  assert.match(injected, /Not limited to Worker Thread completion callbacks/i);
  assert.match(injected, /everyday planning discussions/i);
  assert.match(injected, /action:\s*"add"/);
  assert.match(injected, /action:\s*"resolve"/);
  assert.equal(loadRegistry().coordinators['__v14_upgrade__'].directiveVersion, 15);
});

test('Sidecar backend/frontend static and UI rendering checks for Pending Decisions panel, custom instruction input, API revision 4, IME/draft guards, 3-locale I18N, no middle dot, no native dialogs, and LF endings', () => {
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

  // Backend dual API registration, SERVER_API_REVISION=4, and decision_custom_reply capability
  assert.match(mainMjs, /const\s+SERVER_API_REVISION\s*=\s*4\s*;/);
  assert.match(mainMjs, /['"]decision_custom_reply['"]/);
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/decision_action['"]/);
  assert.match(mainMjs, /executeDecisionAction/);
  assert.match(mainMjs, /customMessage:\s*data\.customMessage/);
  assert.match(mainMjs, /handleDecisionAction[\s\S]*?serverInfo:\s*buildServerInfo\(\)/);

  // Frontend API revision, no GET fallback & no short timeout on /api/decision_action, IME & draft/focus preservation
  assert.match(appSource, /const\s+EXPECTED_SERVER_API_REVISION\s*=\s*4\s*;/);
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
  ];
  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    for (const k of decisionI18nKeys) {
      assert.ok(I18N[loc][k] !== undefined, `Missing ${k} in ${loc}`);
      if (typeof I18N[loc][k] === 'string') {
        assert.equal(I18N[loc][k].includes('·'), false, `${loc}.${k} must not use middle dot`);
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

  for (const [loc, expectedTitle, expectedBadge, expectedArchiveBtn, expectedCustomBtn, expectedSendBtn] of [
    ['zh-CN', '待决策', '待决策', '验收归档', '其他指令', '发送'],
    ['zh-TW', '待決策', '待決策', '驗收封存', '其他指令', '傳送'],
    ['en', 'Pending Decisions', 'Decision', 'Accept &amp; Archive', 'Other instruction', 'Send'],
  ]) {
    setLocale(loc);
    // Collapsed by default: toggle button rendered on both explicit and auto cards, input row hidden
    const panelHtml = renderDecisionsPanelHtml(sampleDecisions);
    assert.match(panelHtml, new RegExp(expectedTitle));
    assert.match(panelHtml, /data-dec-thread="thr-044"/);
    assert.match(panelHtml, /data-dec-dismiss="dec-001"/);
    assert.match(panelHtml, new RegExp(expectedArchiveBtn));
    assert.match(panelHtml, /data-dec-custom-toggle="dec-001"/);
    assert.match(panelHtml, /data-dec-custom-toggle="auto:worktree_archive_ready:thr-045"/);
    assert.match(panelHtml, new RegExp(expectedCustomBtn));
    assert.equal(panelHtml.includes('data-dec-custom-input='), false, 'custom input must stay collapsed by default');
    assert.equal(panelHtml.includes('·'), false, `${loc} decisions panel must never use middle dot`);

    // Expanded with per-decisionId draft preservation (explicit expanded + draft, auto collapsed + draft)
    const expandedPanelHtml = renderDecisionsPanelHtml(sampleDecisions, {
      expandedIds: new Set(['dec-001']),
      drafts: new Map([
        ['dec-001', '先改版本号再合入'],
        ['auto:worktree_archive_ready:thr-045', '保留分支待复查'],
      ]),
    });
    assert.match(expandedPanelHtml, /data-dec-custom-input="dec-001"/);
    assert.match(expandedPanelHtml, /value="先改版本号再合入"/);
    assert.match(expandedPanelHtml, /data-dec-custom-send="dec-001"/);
    assert.match(expandedPanelHtml, new RegExp(expectedSendBtn));
    assert.match(expandedPanelHtml, /dec-btn-custom has-draft" data-dec-custom-toggle="auto:worktree_archive_ready:thr-045"/);
    assert.equal(expandedPanelHtml.includes('·'), false);

    // Expanded with empty draft keeps Send button disabled
    const emptyDraftHtml = renderDecisionsPanelHtml(sampleDecisions, {
      expandedIds: new Set(['auto:worktree_archive_ready:thr-045']),
      drafts: new Map([['auto:worktree_archive_ready:thr-045', '   ']]),
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
    '../lib/store.mjs',
    '../mcp/server.mjs',
    '../scripts/hook-handler.mjs',
    '../sidecars/threads/main.mjs',
    '../tests/decisions-board.test.mjs',
    '../tests/coordinator-rebind.test.mjs',
    '../tests/project-scope-seq.test.mjs',
    '../tests/settings-default-model.test.mjs',
    '../tests/worker-language.test.mjs',
  ]) {
    const raw = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!raw.includes(Buffer.from('\r')), `${rel} must use LF line endings`);
  }
});

test('Sidecar handleDecisionCustomSubmit enforces empty-input guard, sends allowGetFallback:false with timeoutMs:0, preserves draft on failure, and clears state on success', async () => {
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
  const submitFn = extractFunctionSource(appSource, 'handleDecisionCustomSubmit');

  const ctx = {};
  vm.runInNewContext(
    `
    ${i18nCode};
    let curLocale = 'zh-CN';
    const L = () => I18N[curLocale] || I18N.en;
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
    ${submitFn}
    this.runTest = async () => {
      const dec = cachedDecisions[0];
      // 1. Blank input blocked with toast, zero network calls
      let focused = 0;
      await handleDecisionCustomSubmit(dec, { value: '   ', focus: () => { focused++; } }, null);
      if (postCalls.length !== 0) throw new Error('Blank input should not call postApi');
      if (focused !== 1) throw new Error('Blank input should refocus input');

      // 2. Backend error preserves expanded state & user draft
      await handleDecisionCustomSubmit(dec, { value: '先改版本号再合并' }, { textContent: '发送' });
      if (postCalls.length !== 1) throw new Error('Expected 1 postApi call');
      if (postCalls[0].opts.timeoutMs !== 0 || postCalls[0].opts.allowGetFallback !== false) {
        throw new Error('Write API must set timeoutMs:0 and allowGetFallback:false');
      }
      if (postCalls[0].payload.coordinatorId !== 'coord-live') {
        throw new Error('Must prefer live coordinatorId from lastSnap');
      }
      if (!expandedCustomDecisionIds.has('dec-1') || decisionCustomDrafts.get('dec-1') !== '先改版本号再合并') {
        throw new Error('Failure must preserve expanded state and draft');
      }
      if (pendingDecisionIds.has('dec-1')) {
        throw new Error('Failure must clear busy state');
      }

      // 3. Backend success clears expanded/draft/decision and refreshes board
      nextPostResp = { ok: true, action: 'custom_reply', decisionId: 'dec-1' };
      await handleDecisionCustomSubmit(dec, { value: '先改版本号再合并' }, { textContent: '发送' });
      if (expandedCustomDecisionIds.has('dec-1') || decisionCustomDrafts.has('dec-1')) {
        throw new Error('Success must clear expanded state and draft');
      }
      if (cachedDecisions.length !== 0 || lastBoardKey !== '' || refreshCount !== 1) {
        throw new Error('Success must remove decision and refresh board');
      }
      return { toasts, postCalls, renderCalls };
    };
    `,
    ctx,
  );

  const out = await ctx.runTest();
  assert.equal(out.toasts[0].kind, 'err');
  assert.equal(out.toasts[1].kind, 'err');
  assert.equal(out.toasts[2].kind, 'ok');
  assert.equal(out.postCalls[1].payload.action, 'custom_reply');
  assert.equal(out.postCalls[1].payload.customMessage, '先改版本号再合并');
  assert.equal(out.postCalls[1].payload.title, '是否合入 dev？');
  assert.equal(out.postCalls[1].payload.summary, '测试全通过。');
});

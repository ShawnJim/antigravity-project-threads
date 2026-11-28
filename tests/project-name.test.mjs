import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  getGeminiDir,
  getProjectMetadata,
  resetProjectMetadataCache,
  resolveProjectName,
} from '../lib/ls-client.mjs';
import {
  getEffectiveSettings,
  initCoordinator,
  loadRegistry,
  resolveProjectScope,
  resolveScopeDisplayNames,
  syncThreads,
} from '../lib/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);

function setupIsolatedEnv(t, { lsAddress = '', csrfToken = '' } = {}) {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'pt-project-name-test-'));
  const geminiDir = join(tmpRoot, 'gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  mkdirSync(join(geminiDir, 'config', 'projects'), { recursive: true });
  mkdirSync(appDataDir, { recursive: true });

  const envKeys = [
    'ANTIGRAVITY_GEMINI_DIR',
    'ANTIGRAVITY_APP_DATA_DIR',
    'ANTIGRAVITY_LS_ADDRESS',
    'ANTIGRAVITY_CSRF_TOKEN',
  ];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;
  if (lsAddress) process.env.ANTIGRAVITY_LS_ADDRESS = lsAddress;
  else delete process.env.ANTIGRAVITY_LS_ADDRESS;
  if (csrfToken) process.env.ANTIGRAVITY_CSRF_TOKEN = csrfToken;
  else delete process.env.ANTIGRAVITY_CSRF_TOKEN;

  resetProjectMetadataCache();

  t.after(() => {
    resetProjectMetadataCache();
    for (const k of envKeys) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Ignore Windows temp cleanup locks
    }
  });

  return { tmpRoot, geminiDir, appDataDir };
}

function writeProjectConfig(geminiDir, projectId, payload) {
  const filePath = join(geminiDir, 'config', 'projects', `${projectId}.json`);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

async function startMockLsServer(t, { projects = {}, conversations = {}, failReadProject = false } = {}) {
  const counts = {
    readProject: 0,
    getConversation: 0,
    updateConversation: 0,
  };
  const readProjectIds = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      res.setHeader('Content-Type', 'application/json');

      if (req.url === '/exa.language_server_pb.LanguageServerService/ReadProject') {
        counts.readProject++;
        const id = String(body.id || '').trim();
        readProjectIds.push(id);
        if (failReadProject) {
          res.statusCode = 500;
          res.end(JSON.stringify({ code: 'internal', message: 'ReadProject failed' }));
          return;
        }
        if (Object.prototype.hasOwnProperty.call(projects, id)) {
          const entry = projects[id];
          res.statusCode = 200;
          res.end(JSON.stringify(entry));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ notFoundOnDisk: true }));
        return;
      }

      if (req.url === '/product.v1.ConversationService/GetConversation') {
        counts.getConversation++;
        const cid = String(body.conversationId || '').trim();
        if (Object.prototype.hasOwnProperty.call(conversations, cid)) {
          res.statusCode = 200;
          res.end(JSON.stringify(conversations[cid]));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      if (req.url === '/product.v1.ConversationService/UpdateConversation') {
        counts.updateConversation++;
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
        res.statusCode = 200;
        res.end(JSON.stringify({ clientModelConfigs: [] }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: `unhandled ${req.url}` }));
    });
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();

  t.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
  });

  return {
    address: `127.0.0.1:${port}`,
    csrfToken: 'test-csrf-token',
    counts,
    readProjectIds,
    projects,
    conversations,
  };
}

test('resolveProjectName reads real Antigravity project names via LS ReadProject with TTL caching', async (t) => {
  const pidZh = 'proj-zh-001';
  const pidMulti = 'proj-multi-002';
  const pidEmpty = 'proj-empty-003';

  const mockLs = await startMockLsServer(t, {
    projects: {
      [pidZh]: {
        project: {
          id: pidZh,
          name: '支付中台改造',
          projectResources: {
            resources: [
              { gitFolder: { folderUri: 'file:///c%3A/work/pay-core', defaultBranch: 'main' } },
            ],
          },
          isWorkspaceOnly: false,
        },
      },
      [pidMulti]: {
        project: {
          id: pidMulti,
          name: 'noopy+noopy-web',
          projectResources: {
            resources: [
              { gitFolder: { folderUri: 'file:///c%3A/work/noopy', defaultBranch: 'main' } },
              { gitFolder: { folderUri: 'file:///c%3A/work/noopy-web', defaultBranch: 'main' } },
            ],
          },
          isWorkspaceOnly: false,
        },
      },
      [pidEmpty]: {
        project: {
          id: pidEmpty,
          name: '   ',
          isWorkspaceOnly: false,
        },
      },
    },
  });

  setupIsolatedEnv(t, { lsAddress: mockLs.address, csrfToken: mockLs.csrfToken });

  // First call hits LS ReadProject
  const meta1 = await getProjectMetadata(pidZh);
  assert.equal(meta1.ok, true);
  assert.equal(meta1.source, 'ls');
  assert.equal(meta1.name, '支付中台改造');
  assert.deepEqual(meta1.folderUris, ['file:///c%3A/work/pay-core']);
  assert.equal(mockLs.counts.readProject, 1);

  // Second call hits in-memory TTL cache without calling LS again
  const nameCached = await resolveProjectName(pidZh);
  assert.equal(nameCached, '支付中台改造');
  assert.equal(mockLs.counts.readProject, 1);

  // Force refresh bypasses TTL cache
  mockLs.projects[pidZh].project.name = '支付中台 V2';
  const refreshed = await resolveProjectName(pidZh, { forceRefresh: true });
  assert.equal(refreshed, '支付中台 V2');
  assert.equal(mockLs.counts.readProject, 2);

  // Multi-workspace project returns real combined project name
  const multiMeta = await getProjectMetadata(pidMulti);
  assert.equal(multiMeta.ok, true);
  assert.equal(multiMeta.name, 'noopy+noopy-web');
  assert.equal(multiMeta.folderUris.length, 2);

  // Explicit empty project name returns '' safely
  const emptyName = await resolveProjectName(pidEmpty);
  assert.equal(emptyName, '');

  // 'outside-of-project' and empty ID never trigger ReadProject and always return ''
  const beforeCount = mockLs.counts.readProject;
  assert.equal(await resolveProjectName('outside-of-project'), '');
  assert.equal(await resolveProjectName(''), '');
  assert.equal(await resolveProjectName(null), '');
  assert.equal(mockLs.counts.readProject, beforeCount);
});

test('resolveProjectName falls back to local <geminiDir>/config/projects/<id>.json when LS is offline and invalidates on file mtime change', async (t) => {
  // No LS address configured -> offline mode
  const { geminiDir } = setupIsolatedEnv(t);
  assert.equal(getGeminiDir(), geminiDir);

  const pid = '6336716c-f8f6-40e0-b8a4-10b3c6d078fa';
  const cfgPath = writeProjectConfig(geminiDir, pid, {
    id: pid,
    name: '离线项目中文名',
    projectResources: {
      resources: [
        { gitFolder: { folderUri: 'file:///c%3A/repo/offline-app', defaultBranch: 'main' } },
      ],
    },
    isWorkspaceOnly: false,
  });

  const meta = await getProjectMetadata(pid);
  assert.equal(meta.ok, true);
  assert.equal(meta.source, 'disk');
  assert.equal(meta.name, '离线项目中文名');
  assert.deepEqual(meta.folderUris, ['file:///c%3A/repo/offline-app']);

  // Updating the project JSON file updates mtime/size and invalidates the cache immediately
  writeFileSync(
    cfgPath,
    JSON.stringify({ id: pid, name: '离线项目重命名后', isWorkspaceOnly: false }, null, 2),
    'utf8',
  );
  const futureTime = new Date(Date.now() + 5000);
  utimesSync(cfgPath, futureTime, futureTime);

  const renamed = await resolveProjectName(pid);
  assert.equal(renamed, '离线项目重命名后');

  // Corrupted JSON, missing file, and traversal-like IDs degrade safely without throwing
  const corruptId = 'corrupt-proj-id';
  writeFileSync(join(geminiDir, 'config', 'projects', `${corruptId}.json`), '{broken json', 'utf8');
  assert.equal(await resolveProjectName(corruptId), '');
  assert.equal(await resolveProjectName('missing-proj-id'), '');
  assert.equal(await resolveProjectName('../outside/escape'), '');
});

test('resolveProjectName falls back to local disk when LS ReadProject fails with HTTP error', async (t) => {
  const pid = 'ls-err-fallback-001';
  const mockLs = await startMockLsServer(t, { failReadProject: true });
  const { geminiDir } = setupIsolatedEnv(t, {
    lsAddress: mockLs.address,
    csrfToken: mockLs.csrfToken,
  });

  writeProjectConfig(geminiDir, pid, {
    id: pid,
    name: '磁盘兜底项目',
    isWorkspaceOnly: false,
  });

  const meta = await getProjectMetadata(pid);
  assert.equal(meta.ok, true);
  assert.equal(meta.source, 'disk');
  assert.equal(meta.name, '磁盘兜底项目');
  assert.equal(mockLs.counts.readProject, 1);
});

test('syncThreads, resolveProjectScope, initCoordinator, and getEffectiveSettings prioritize real project name and safely fall back', async (t) => {
  const pidCustom = 'proj-custom-zh-101';
  const pidNoWs = 'proj-no-ws-102';
  const pidEmpty = 'proj-empty-103';
  const convCoord = 'conv-coord-101';
  const convNoWs = 'conv-no-ws-102';
  const convEmptyProj = 'conv-empty-proj-103';
  const convOutside = 'conv-outside-104';

  const mockLs = await startMockLsServer(t, {
    projects: {
      [pidCustom]: {
        project: {
          id: pidCustom,
          name: '线程看板业务项目',
          isWorkspaceOnly: false,
        },
      },
      [pidNoWs]: {
        project: {
          id: pidNoWs,
          name: '无工作区架构调研',
          projectResources: {},
          isWorkspaceOnly: false,
        },
      },
      [pidEmpty]: {
        project: {
          id: pidEmpty,
          name: '',
          isWorkspaceOnly: false,
        },
      },
    },
    conversations: {
      [convCoord]: {
        id: convCoord,
        metadata: { projectId: pidCustom },
        annotations: { title: '[Coordinator] workspace-repo' },
      },
      [convNoWs]: {
        id: convNoWs,
        metadata: { projectId: pidNoWs },
        annotations: { title: '调研草稿会话' },
      },
      [convEmptyProj]: {
        id: convEmptyProj,
        metadata: { projectId: pidEmpty },
        annotations: { title: 'Empty Name Session' },
      },
      [convOutside]: {
        id: convOutside,
        metadata: { projectId: 'outside-of-project' },
        annotations: { title: 'Standalone Chat' },
      },
    },
  });

  const { tmpRoot } = setupIsolatedEnv(t, {
    lsAddress: mockLs.address,
    csrfToken: mockLs.csrfToken,
  });

  const wsDir = join(tmpRoot, 'workspace-repo');
  mkdirSync(wsDir, { recursive: true });

  // 1. Custom Chinese Antigravity Project name + workspace
  const coord = await initCoordinator({
    workspacePath: wsDir,
    conversationId: convCoord,
    projectId: pidCustom,
  });
  assert.equal(coord.projectId, pidCustom);
  assert.equal(coord.projectName, '线程看板业务项目');

  const snap = await syncThreads({
    workspacePath: wsDir,
    conversationId: convCoord,
    projectId: pidCustom,
  });
  assert.equal(snap.projectId, pidCustom);
  assert.equal(snap.projectName, '线程看板业务项目');
  assert.equal(snap.workspaceName, 'workspace-repo');
  assert.equal(snap.scopeTitle, '线程看板业务项目');
  assert.equal(snap.projectLabel, '线程看板业务项目');
  assert.equal(snap.coordinator?.projectName, '线程看板业务项目');

  const regAfter = loadRegistry();
  assert.equal(regAfter.coordinators[snap.scopeKey]?.projectName, '线程看板业务项目');

  // getEffectiveSettings also receives real projectName and scopeLabel
  const eff = await getEffectiveSettings({ workspaceKey: snap.scopeKey });
  assert.equal(eff.projectName, '线程看板业务项目');
  assert.equal(eff.scopeLabel, '线程看板业务项目');

  // 2. Workspace-less Antigravity Project displays real project name
  const snapNoWs = await syncThreads({
    conversationId: convNoWs,
    projectId: pidNoWs,
  });
  assert.equal(snapNoWs.hasWorkspace, false);
  assert.equal(snapNoWs.projectName, '无工作区架构调研');
  assert.equal(snapNoWs.workspaceName, '');
  assert.equal(snapNoWs.scopeTitle, '无工作区架构调研');
  assert.equal(snapNoWs.projectLabel, '无工作区架构调研');

  // 3. Empty project name falls back to workspace folder name
  const wsDirEmpty = join(tmpRoot, 'fallback-folder-name');
  mkdirSync(wsDirEmpty, { recursive: true });
  const snapEmptyName = await syncThreads({
    workspacePath: wsDirEmpty,
    conversationId: convEmptyProj,
    projectId: pidEmpty,
  });
  assert.equal(snapEmptyName.projectName, '');
  assert.equal(snapEmptyName.workspaceName, 'fallback-folder-name');
  assert.equal(snapEmptyName.scopeTitle, 'fallback-folder-name');
  assert.equal(snapEmptyName.projectLabel, 'fallback-folder-name');

  // 4. Outside-of-project with workspace falls back to workspace folder name
  const wsDirOutside = join(tmpRoot, 'standalone-repo');
  mkdirSync(wsDirOutside, { recursive: true });
  const snapOutsideWs = await syncThreads({
    workspacePath: wsDirOutside,
    conversationId: convOutside,
    projectId: 'outside-of-project',
  });
  assert.equal(snapOutsideWs.projectId, '');
  assert.equal(snapOutsideWs.projectName, '');
  assert.equal(snapOutsideWs.workspaceName, 'standalone-repo');
  assert.equal(snapOutsideWs.scopeTitle, 'standalone-repo');

  // 5. Outside-of-project without workspace falls back to session title / default fallback
  const scopeNoWsNoProj = await resolveProjectScope({
    conversationId: convOutside,
    projectId: 'outside-of-project',
  });
  assert.equal(scopeNoWsNoProj.projectName, '');
  assert.equal(scopeNoWsNoProj.workspaceName, '');
  assert.equal(scopeNoWsNoProj.scopeTitle, 'Standalone Chat');

  // 6. Pure display name helper precedence
  assert.deepEqual(
    resolveScopeDisplayNames({
      projectName: '真实项目名',
      workspaceName: 'repo-dir',
      fallbackLabel: 'Project',
    }),
    { projectName: '真实项目名', workspaceName: 'repo-dir', scopeTitle: '真实项目名' },
  );
  assert.deepEqual(
    resolveScopeDisplayNames({
      projectName: '',
      baseDir: join('C:', 'work', 'repo-dir'),
      fallbackLabel: 'Project',
    }),
    { projectName: '', workspaceName: 'repo-dir', scopeTitle: 'repo-dir' },
  );
  assert.deepEqual(
    resolveScopeDisplayNames({
      projectName: '',
      workspaceName: '',
      fallbackLabel: 'Project',
    }),
    { projectName: '', workspaceName: '', scopeTitle: 'Project' },
  );
});

test('sidecar app.js header title logic binds projectName with tooltip, falls back cleanly, and avoids native dialogs', () => {
  const appPath = join(REPO_ROOT, 'sidecars', 'threads', 'app.js');
  const mainPath = join(REPO_ROOT, 'sidecars', 'threads', 'main.mjs');
  const appSrc = readFileSync(appPath, 'utf8');
  const mainSrc = readFileSync(mainPath, 'utf8');

  // Static assertions: no native browser modal dialogs
  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appSrc), false);

  // Static assertions: board header & board cache key bind projectName/scopeTitle and tooltip
  assert.match(appSrc, /function\s+resolveBoardHeaderDisplay\s*\(\s*snap\s*\)/);
  assert.match(appSrc, /panelTitleEl\.textContent\s*=\s*headerMeta\.panelTitle/);
  assert.match(appSrc, /panelTitleEl\.title\s*=\s*headerMeta\.panelTooltip/);
  assert.match(appSrc, /projectName:\s*data\.projectName\s*\|\|\s*''/);
  assert.match(appSrc, /scopeTitle:\s*data\.scopeTitle\s*\|\|\s*''/);
  assert.match(mainSrc, /projectName:\s*effective\.projectName\s*\|\|\s*''/);

  // Verify all modified/new .mjs files keep LF line endings
  for (const rel of [
    join('lib', 'ls-client.mjs'),
    join('lib', 'store.mjs'),
    join('sidecars', 'threads', 'main.mjs'),
    join('tests', 'project-name.test.mjs'),
  ]) {
    const raw = readFileSync(join(REPO_ROOT, rel), 'utf8');
    assert.equal(raw.includes('\r\n'), false, `Expected LF line endings in ${rel}`);
  }

  // Extract stripCoordinatorPrefix + resolveBoardHeaderDisplay from app.js using balanced braces
  function extractFnSource(source, fnName) {
    const startIdx = source.indexOf(`function ${fnName}(`);
    assert.ok(startIdx >= 0, `Expected function ${fnName} in sidecars/threads/app.js`);
    const braceStart = source.indexOf('{', startIdx);
    assert.ok(braceStart > startIdx);
    let depth = 0;
    for (let i = braceStart; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return source.slice(startIdx, i + 1);
      }
    }
    throw new Error(`Unclosed function body for ${fnName}`);
  }

  const helperSrc = `${extractFnSource(appSrc, 'stripCoordinatorPrefix')}\n${extractFnSource(appSrc, 'resolveBoardHeaderDisplay')}`;

  const sandbox = {
    workspace: '',
    L: () => ({ panelTitle: '项目线程', defaultProjTitle: '当前项目' }),
  };
  vm.runInNewContext(`${helperSrc}\nthis.resolveBoardHeaderDisplay = resolveBoardHeaderDisplay;`, sandbox);
  const resolveHeader = sandbox.resolveBoardHeaderDisplay;

  // Case 1: Custom Chinese project name + bound coordinator in workspace -> header shows project name, card shows workspace folder without duplication
  const rCustom = resolveHeader({
    projectName: '自定义中文项目',
    workspaceName: 'antigravity-project-threads',
    workspacePath: 'C:\\Users\\demo\\antigravity-project-threads',
    scopeTitle: '自定义中文项目',
    coordinator: {
      conversationId: 'coord-1',
      title: '[Coordinator] antigravity-project-threads',
      repoRoot: 'C:\\Users\\demo\\antigravity-project-threads',
    },
  });
  assert.equal(rCustom.panelTitle, '自定义中文项目');
  assert.equal(rCustom.panelTooltip, '自定义中文项目 — C:\\Users\\demo\\antigravity-project-threads');
  assert.equal(rCustom.goalTitle, 'antigravity-project-threads');
  assert.equal(rCustom.goalTooltip, 'C:\\Users\\demo\\antigravity-project-threads');

  // Case 2: Multi-workspace project -> header shows combined project name, coordinator card shows primary repo
  const rMulti = resolveHeader({
    projectName: 'noopy+noopy-web',
    workspaceName: 'noopy',
    workspacePath: 'C:\\Users\\demo\\noopy',
    scopeTitle: 'noopy+noopy-web',
    coordinator: {
      conversationId: 'coord-2',
      title: '[Coordinator] noopy',
      repoRoot: 'C:\\Users\\demo\\noopy',
    },
  });
  assert.equal(rMulti.panelTitle, 'noopy+noopy-web');
  assert.equal(rMulti.goalTitle, 'noopy');

  // Case 3: Workspace-less project -> header & card display real project name
  const rNoWs = resolveHeader({
    projectName: '纯讨论无目录项目',
    workspaceName: '',
    workspacePath: '',
    scopeTitle: '纯讨论无目录项目',
    coordinator: null,
  });
  assert.equal(rNoWs.panelTitle, '纯讨论无目录项目');
  assert.equal(rNoWs.panelTooltip, '纯讨论无目录项目');
  assert.equal(rNoWs.goalTitle, '纯讨论无目录项目');

  // Case 4: No projectName (outside project / offline unavailable) -> falls back to workspace folder name
  const rFallbackWs = resolveHeader({
    projectName: '',
    workspaceName: 'local-only-repo',
    workspacePath: 'C:\\Users\\demo\\local-only-repo',
    scopeTitle: 'local-only-repo',
    coordinator: null,
  });
  assert.equal(rFallbackWs.panelTitle, 'local-only-repo');
  assert.equal(rFallbackWs.panelTooltip, 'C:\\Users\\demo\\local-only-repo');
  assert.equal(rFallbackWs.goalTitle, 'local-only-repo');

  // Case 5: No projectName & no workspace -> falls back to localized panel & card defaults
  const rEmpty = resolveHeader({
    projectName: '',
    workspaceName: '',
    workspacePath: '',
    scopeTitle: '',
    projectLabel: '',
    coordinator: null,
  });
  assert.equal(rEmpty.panelTitle, '项目线程');
  assert.equal(rEmpty.goalTitle, '当前项目');
});

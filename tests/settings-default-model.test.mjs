import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { resetModelConfigCache } from '../lib/ls-client.mjs';
import {
  buildModelFamilyGroups,
  formatModelDisplay,
  resolveModelFamilySelection,
} from '../lib/model-format.mjs';
import {
  canonicalizeModelForSettings,
  dispatchThread,
  getEffectiveSettings,
  loadRegistry,
  loadSettings,
  normalizeKey,
  resolveDefaultDispatchModel,
  resolveInheritedCoordinatorModel,
  saveRegistry,
  saveSettings,
} from '../lib/store.mjs';

function createTempEnv(t, prefix = 'pt-set-') {
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
  ];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;
  delete process.env.ANTIGRAVITY_LS_ADDRESS;
  delete process.env.ANTIGRAVITY_CSRF_TOKEN;
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

const SAMPLE_MODEL_CONFIG_DATA = {
  clientModelConfigs: [
    {
      label: 'Gemini 4 Hydrogen (XHigh)',
      modelId: 'gemini-4-hydrogen-xhigh',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M528' },
      quotaInfo: { remainingFraction: 0.9 },
    },
    {
      label: 'Gemini 4 Neon (High)',
      modelId: 'gemini-4-neon-high',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' },
      quotaInfo: { remainingFraction: 0.96 },
    },
    {
      label: 'Gemini 4 Neon (Low)',
      modelId: 'gemini-4-neon-low',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M534' },
      quotaInfo: { remainingFraction: 0.96 },
    },
    {
      label: 'Gemini 3.8 Flash (Medium)',
      modelId: 'gemini-3.8-flash-medium',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M319' },
      quotaInfo: { remainingFraction: 0.5 },
    },
  ],
  defaultOverrideModelConfig: {
    modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' },
  },
};

function startMockLs(
  t,
  { withCatalog = true, generatorMetadataByCascade = null } = {},
) {
  const createRequests = [];
  const cascadeSendPayloads = [];
  const genMetaByCascade = generatorMetadataByCascade || new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
        if (!withCatalog) {
          res.statusCode = 503;
          res.end(JSON.stringify({ message: 'catalog unavailable' }));
          return;
        }
        res.end(JSON.stringify(SAMPLE_MODEL_CONFIG_DATA));
        return;
      }
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
        const metaEntry = genMetaByCascade.get(payload.cascadeId);
        if (metaEntry && metaEntry.errorStatus) {
          res.statusCode = metaEntry.errorStatus;
          res.end(JSON.stringify({ message: metaEntry.message || 'metadata unavailable' }));
          return;
        }
        res.end(
          JSON.stringify({
            generatorMetadata: Array.isArray(metaEntry)
              ? metaEntry
              : Array.isArray(metaEntry?.generatorMetadata)
                ? metaEntry.generatorMetadata
                : [],
          }),
        );
        return;
      }
      if (req.url === '/product.v1.ConversationService/CreateConversation') {
        createRequests.push(payload);
        res.end(
          JSON.stringify({
            conversation: {
              id: `conv-set-${createRequests.length}`,
              state: { runState: 'RUN_STATE_RUNNING' },
            },
          }),
        );
        return;
      }
      if (req.url === '/product.v1.ConversationService/UpdateConversation') {
        res.end(JSON.stringify({}));
        return;
      }
      if (req.url === '/product.v1.ConversationService/GetConversation') {
        res.end(
          JSON.stringify({
            conversation: {
              id: payload.conversationId,
              state: { runState: 'RUN_STATE_RUNNING' },
            },
          }),
        );
        return;
      }
      if (req.url === '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage') {
        cascadeSendPayloads.push(payload);
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
      process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${port}`;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-settings-test';
      t.after(() => new Promise((r) => server.close(r)));
      resolveListen({ port, createRequests, cascadeSendPayloads, genMetaByCascade });
    });
  });
}

test('loadSettings / saveSettings persist global defaults, project overrides, inherit mode, corrupt fallbacks, and clears cleanly', (t) => {
  const { stateDir } = createTempEnv(t, 'pt-set-persist-');

  // 1. Missing settings.json falls back cleanly to inherit/inherit
  const initial = loadSettings();
  assert.deepEqual(initial.defaults, { worktreeModel: 'inherit', readOnlyModel: 'inherit' });
  assert.deepEqual(initial.projects, {});

  // 2. Corrupt settings.json falls back cleanly without throwing
  writeFileSync(join(stateDir, 'settings.json'), '{not-valid-json', 'utf8');
  const recovered = loadSettings();
  assert.deepEqual(recovered.defaults, { worktreeModel: 'inherit', readOnlyModel: 'inherit' });

  // 3. Save global defaults via patch (including 'inherit')
  const savedGlobal = saveSettings({
    defaults: {
      worktreeModel: 'gemini-4-hydrogen-xhigh',
      readOnlyModel: 'flash',
    },
  });
  assert.equal(savedGlobal.defaults.worktreeModel, 'gemini-4-hydrogen-xhigh');
  assert.equal(savedGlobal.defaults.readOnlyModel, 'flash');

  // Partial patch preserves sibling field
  const partialGlobal = saveSettings({
    defaults: { readOnlyModel: 'flash-lite' },
  });
  assert.equal(partialGlobal.defaults.worktreeModel, 'gemini-4-hydrogen-xhigh');
  assert.equal(partialGlobal.defaults.readOnlyModel, 'flash_lite');

  // 'inherit' is preserved as a first-class canonical value (distinct from "" and 'pro')
  const inheritGlobal = saveSettings({
    defaults: { worktreeModel: 'inherit', readOnlyModel: 'INHERIT' },
  });
  assert.equal(inheritGlobal.defaults.worktreeModel, 'inherit');
  assert.equal(inheritGlobal.defaults.readOnlyModel, 'inherit');
  assert.deepEqual(canonicalizeModelForSettings('inherit'), {
    value: 'inherit',
    label: 'Follow Coordinator (inherit)',
  });
  assert.deepEqual(canonicalizeModelForSettings(''), { value: '', label: '' });

  // 4. Per-project overrides merge, preserve 'inherit', & clear cleanly
  const wk = normalizeKey(join(stateDir, 'proj-a'));
  saveSettings({
    scope: 'project',
    workspaceKey: wk,
    worktreeModel: 'gemini-4-neon-high',
    readOnlyModel: '',
  });
  let loaded = loadSettings();
  assert.equal(loaded.projects[wk].worktreeModel, 'gemini-4-neon-high');
  assert.equal(loaded.projects[wk].readOnlyModel, '');

  // Project override 'inherit' stays persisted and distinct from "" (Follow Global Default)
  saveSettings({
    scope: 'project',
    workspaceKey: wk,
    worktreeModel: 'inherit',
    readOnlyModel: '',
  });
  loaded = loadSettings();
  assert.equal(loaded.projects[wk].worktreeModel, 'inherit');
  assert.equal(loaded.projects[wk].readOnlyModel, '');

  // Clearing single field back to "" when no other override remains removes empty project entry
  saveSettings({
    scope: 'project',
    workspaceKey: wk,
    worktreeModel: '',
  });
  loaded = loadSettings();
  assert.equal(loaded.projects[wk], undefined);

  // Scoped reset restores global defaults or clears project override
  saveSettings({
    scope: 'project',
    workspaceKey: wk,
    worktreeModel: 'flash',
    readOnlyModel: 'gemini-4-neon-low',
  });
  assert.equal(loadSettings().projects[wk].readOnlyModel, 'gemini-4-neon-low');
  saveSettings({ scope: 'project', workspaceKey: wk, reset: true });
  assert.equal(loadSettings().projects[wk], undefined);

  saveSettings({ scope: 'global', reset: true });
  assert.deepEqual(loadSettings().defaults, { worktreeModel: 'inherit', readOnlyModel: 'inherit' });

  // Backend still accepts and preserves legacy 'pro' / 'flash' / 'flash_lite' if stored directly
  const legacySaved = saveSettings({
    defaults: { worktreeModel: 'pro', readOnlyModel: 'flash-lite' },
  });
  assert.deepEqual(legacySaved.defaults, { worktreeModel: 'pro', readOnlyModel: 'flash_lite' });
});

test('getEffectiveSettings and resolveDefaultDispatchModel enforce project precedence, expose coordinator model, and resolve inherit', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-set-eff-');
  const genMetaByCascade = new Map();
  await startMockLs(t, { withCatalog: true, generatorMetadataByCascade: genMetaByCascade });

  const repoRoot = join(tempRoot, 'demo-repo');
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
  const wk = normalizeKey(repoRoot);

  const reg = loadRegistry();
  reg.coordinators[wk] = {
    key: wk,
    conversationId: 'conv-coord-eff',
    workspacePath: repoRoot,
    repoRoot,
    defaultBranch: 'main',
    title: '[Coordinator] demo',
  };
  reg.threads['thr-099'] = {
    threadId: 'thr-099',
    conversationId: 'conv-worker-eff',
    coordinatorId: 'conv-coord-eff',
    workspaceKey: wk,
    title: 'Popped-out worker',
    model: 'flash',
    archived: false,
  };
  saveRegistry(reg);

  genMetaByCascade.set('conv-coord-eff', [
    {
      stepIndices: [1, 2],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M528',
        responseModel: 'gemini-4-hydrogen-tiered-xhigh',
        modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
      },
    },
  ]);
  genMetaByCascade.set('conv-worker-eff', [
    {
      stepIndices: [1],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M319',
        responseModel: 'gemini-3.8-flash-medium',
        modelDisplayName: 'Gemini 3.8 Flash (Medium)',
      },
    },
  ]);

  saveSettings({
    defaults: {
      worktreeModel: 'gemini-4-hydrogen-xhigh',
      readOnlyModel: 'gemini-3.8-flash-medium',
    },
    projects: {
      [wk]: {
        worktreeModel: 'MODEL_PLACEHOLDER_M532',
        readOnlyModel: '',
      },
    },
  });

  const eff = await getEffectiveSettings({ workspacePath: repoRoot });
  assert.equal(eff.scopeKey, wk);
  assert.equal(eff.hasProjectOverride, true);
  assert.equal(eff.worktreeSource, 'project');
  assert.equal(eff.readOnlySource, 'global');
  assert.equal(eff.worktreeModel, 'gemini-4-neon-high');
  assert.equal(eff.worktreeModelLabel, 'Gemini 4 Neon (High)');
  assert.equal(eff.readOnlyModel, 'gemini-3.8-flash-medium');
  assert.equal(eff.readOnlyModelLabel, 'Gemini 3.8 Flash (Medium)');
  assert.equal(eff.coordinatorId, 'conv-coord-eff');
  assert.equal(eff.coordinatorModel, 'gemini-4-hydrogen-xhigh');
  assert.equal(eff.coordinatorModelDisplayName, 'Gemini 4 Hydrogen (XHigh)');

  // Even when Sidecar passes a popped-out worker's conversationId, coordinator resolution picks the bound Coordinator
  const effFromWorker = await getEffectiveSettings({
    workspacePath: repoRoot,
    conversationId: 'conv-worker-eff',
  });
  assert.equal(effFromWorker.coordinatorId, 'conv-coord-eff');
  assert.equal(effFromWorker.coordinatorModelDisplayName, 'Gemini 4 Hydrogen (XHigh)');

  assert.equal(
    await resolveDefaultDispatchModel({ createWorktree: true, workspacePath: repoRoot }),
    'gemini-4-neon-high',
  );
  assert.equal(
    await resolveDefaultDispatchModel({ createWorktree: false, workspacePath: repoRoot }),
    'gemini-3.8-flash-medium',
  );

  // When project sets 'inherit', effective keeps 'inherit' for UI while resolveDefaultDispatchModel resolves Coordinator's model
  saveSettings({ scope: 'project', workspaceKey: wk, worktreeModel: 'inherit' });
  const effInherit = await getEffectiveSettings({ workspacePath: repoRoot });
  assert.equal(effInherit.worktreeModel, 'inherit');
  assert.equal(effInherit.worktreeSource, 'project');
  assert.match(effInherit.worktreeModelLabel, /Gemini 4 Hydrogen \(XHigh\)/);
  assert.equal(
    await resolveDefaultDispatchModel({ createWorktree: true, workspacePath: repoRoot }),
    'gemini-4-hydrogen-xhigh',
  );

  // Clearing project worktreeModel reverts createWorktree: true back to global default
  saveSettings({ scope: 'project', workspaceKey: wk, worktreeModel: '' });
  assert.equal(
    await resolveDefaultDispatchModel({ createWorktree: true, workspacePath: repoRoot }),
    'gemini-4-hydrogen-xhigh',
  );

  // If Coordinator has no metadata yet, coordinatorModelDisplayName is empty and inherit resolves safely to 'pro'
  genMetaByCascade.delete('conv-coord-eff');
  saveSettings({ defaults: { worktreeModel: 'inherit', readOnlyModel: 'pro' } });
  const effNoCoordModel = await getEffectiveSettings({ workspacePath: repoRoot });
  assert.equal(effNoCoordModel.worktreeModel, 'inherit');
  assert.equal(effNoCoordModel.coordinatorModel, '');
  assert.equal(effNoCoordModel.coordinatorModelDisplayName, '');
  assert.equal(
    await resolveDefaultDispatchModel({ createWorktree: true, workspacePath: repoRoot }),
    'pro',
  );
});

test('dispatchThread honors Settings defaults for omitted/default/auto, separates modes, respects overrides, and never sends display labels', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-set-dispatch-');
  const ls = await startMockLs(t, { withCatalog: true });

  const repoRoot = join(tempRoot, 'dispatch-repo');
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), '# Test\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot });

  const reg = loadRegistry();
  const wk = normalizeKey(repoRoot);
  reg.coordinators[wk] = {
    key: wk,
    conversationId: 'conv-coord-set',
    workspacePath: repoRoot,
    repoRoot,
    defaultBranch: 'main',
    title: '[Coordinator] demo',
  };
  saveRegistry(reg);

  saveSettings({
    defaults: {
      worktreeModel: 'gemini-4-hydrogen-xhigh',
      readOnlyModel: 'gemini-4-neon-low',
    },
  });

  // 1. Omitted model with createWorktree: true uses worktreeModel
  const tWt = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: 'conv-coord-set',
    title: 'WT default test',
    taskPrompt: 'Edit file',
    createWorktree: true,
  });
  assert.equal(ls.createRequests.at(-1).model, 'gemini-4-hydrogen-xhigh');
  assert.equal(tWt.model, 'gemini-4-hydrogen-xhigh');
  assert.equal(tWt.modelDisplayName, 'Gemini 4 Hydrogen (XHigh)');

  // 2. Omitted / "default" / "auto" with createWorktree: false uses readOnlyModel
  for (const sentinel of [undefined, '', 'default', 'auto']) {
    const tRo = await dispatchThread({
      workspacePath: repoRoot,
      coordinatorId: 'conv-coord-set',
      title: `RO ${String(sentinel)}`,
      taskPrompt: 'Inspect code',
      ...(sentinel !== undefined ? { model: sentinel } : {}),
      createWorktree: false,
    });
    assert.equal(ls.createRequests.at(-1).model, 'gemini-4-neon-low');
    assert.equal(tRo.model, 'gemini-4-neon-low');
    assert.equal(tRo.modelDisplayName, 'Gemini 4 Neon (Low)');
    assert.notEqual(ls.createRequests.at(-1).model, 'auto');
    assert.notEqual(ls.createRequests.at(-1).model, 'default');
  }

  // 3. Explicit caller override beats Settings default
  const tExplicit = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: 'conv-coord-set',
    title: 'Explicit flash',
    taskPrompt: 'Quick check',
    model: 'flash',
    createWorktree: true,
  });
  assert.equal(ls.createRequests.at(-1).model, 'flash');
  assert.equal(tExplicit.model, 'flash');

  // 4. Display label in Settings or caller input is normalized to modelId when catalog is online
  const tHumanOnline = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: 'conv-coord-set',
    title: 'Human label online',
    taskPrompt: 'Normalize me',
    model: 'Gemini 4 Neon (High)',
    createWorktree: false,
  });
  assert.equal(ls.createRequests.at(-1).model, 'gemini-4-neon-high');
  assert.equal(tHumanOnline.modelDisplayName, 'Gemini 4 Neon (High)');

  // 5. Display label when catalog is offline NEVER leaks to CreateConversation (falls back to 'pro')
  resetModelConfigCache();
  const lsOffline = await startMockLs(t, { withCatalog: false });
  saveSettings({
    defaults: {
      worktreeModel: 'Gemini 4 Neon (High)',
      readOnlyModel: 'Gemini 4 Neon (Low)',
    },
  });
  const tHumanOffline = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: 'conv-coord-set',
    title: 'Human label offline',
    taskPrompt: 'Fallback cleanly',
    createWorktree: false,
  });
  assert.equal(lsOffline.createRequests.at(-1).model, 'pro');
  assert.equal(tHumanOffline.model, 'pro');
});

test('dispatchThread with inherit dynamically resolves Coordinator LS & transcript models and never sends literal inherit', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-set-inherit-');
  const genMetaByCascade = new Map();
  const ls = await startMockLs(t, { withCatalog: true, generatorMetadataByCascade: genMetaByCascade });

  const repoRoot = join(tempRoot, 'inherit-repo');
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), '# Inherit\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoRoot });

  const coordConvId = 'conv-coord-inh-001';
  const wk = normalizeKey(repoRoot);
  const reg = loadRegistry();
  reg.coordinators[wk] = {
    key: wk,
    conversationId: coordConvId,
    workspacePath: repoRoot,
    repoRoot,
    defaultBranch: 'main',
    title: '[Coordinator] InheritDemo',
  };
  saveRegistry(reg);

  // 1. No LS metadata & no transcript yet -> safely falls back to 'pro' (never sends 'inherit')
  saveSettings({
    defaults: {
      worktreeModel: 'inherit',
      readOnlyModel: 'flash',
    },
  });
  const tNoModel = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: coordConvId,
    title: 'Inherit empty fallback',
    taskPrompt: 'Check fallback',
    createWorktree: true,
  });
  assert.equal(ls.createRequests.at(-1).model, 'pro');
  assert.notEqual(ls.createRequests.at(-1).model, 'inherit');
  assert.equal(tNoModel.model, 'pro');

  // 2. Live Coordinator metadata resolves via catalog -> valid CreateConversation modelId
  genMetaByCascade.set(coordConvId, [
    {
      stepIndices: [1, 2],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M528',
        responseModel: 'gemini-4-hydrogen-tiered-xhigh',
        modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
      },
    },
  ]);
  const tFromSettings = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: coordConvId,
    title: 'Inherit from Settings',
    taskPrompt: 'Use coordinator Hydrogen',
    createWorktree: true,
  });
  assert.equal(ls.createRequests.at(-1).model, 'gemini-4-hydrogen-xhigh');
  assert.equal(tFromSettings.model, 'gemini-4-hydrogen-xhigh');
  assert.equal(tFromSettings.modelDisplayName, 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(tFromSettings.modelEnum, 'MODEL_PLACEHOLDER_M528');

  // 3. Coordinator switches model mid-session -> explicit model: 'inherit' picks up new model dynamically
  genMetaByCascade.set(coordConvId, [
    {
      stepIndices: [1, 2],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M528',
        responseModel: 'gemini-4-hydrogen-tiered-xhigh',
        modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
      },
    },
    {
      stepIndices: [3, 4],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M534',
        responseModel: 'gemini-4-neon-low',
        modelDisplayName: 'Gemini 4 Neon (Low)',
      },
    },
  ]);
  const tExplicitInherit = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: coordConvId,
    title: 'Explicit inherit override',
    taskPrompt: 'Override flash readOnly with inherit',
    model: 'inherit',
    createWorktree: false,
  });
  assert.equal(ls.createRequests.at(-1).model, 'gemini-4-neon-low');
  assert.equal(tExplicitInherit.model, 'gemini-4-neon-low');
  assert.equal(tExplicitInherit.modelDisplayName, 'Gemini 4 Neon (Low)');

  // 4. LS metadata unavailable -> fallback to transcript.jsonl PLANNER_RESPONSE.model
  genMetaByCascade.set(coordConvId, { errorStatus: 503, message: 'LS metadata busy' });
  const txDir = join(appDataDir, 'brain', coordConvId, '.system_generated', 'logs');
  mkdirSync(txDir, { recursive: true });
  const txPath = join(txDir, 'transcript.jsonl');
  writeFileSync(
    txPath,
    [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Hi</USER_REQUEST>' }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', content: 'ok' }),
    ].join('\n'),
    'utf8',
  );
  const tFromTxPlanner = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: coordConvId,
    title: 'Inherit transcript planner',
    taskPrompt: 'Read transcript fallback',
    model: 'inherit',
    createWorktree: false,
  });
  assert.equal(ls.createRequests.at(-1).model, 'gemini-4-neon-high');
  assert.equal(tFromTxPlanner.modelDisplayName, 'Gemini 4 Neon (High)');

  // 5. Transcript has <USER_SETTINGS_CHANGE> display label after PLANNER_RESPONSE:
  //    online catalog normalizes it to 'gemini-3.8-flash-medium'; offline catalog falls back to 'pro' (never sends label!)
  writeFileSync(
    txPath,
    [
      JSON.stringify({ step_index: 0, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-high', content: 'step 1' }),
      JSON.stringify({
        step_index: 1,
        type: 'USER_INPUT',
        content:
          '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 4 Neon (High) to Gemini 3.8 Flash (Medium).\n</USER_SETTINGS_CHANGE>\n<USER_REQUEST>Next</USER_REQUEST>',
      }),
    ].join('\n'),
    'utf8',
  );
  const tFromTxBannerOnline = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: coordConvId,
    title: 'Inherit transcript settings online',
    taskPrompt: 'Normalize display name via catalog',
    model: 'inherit',
    createWorktree: false,
  });
  assert.equal(ls.createRequests.at(-1).model, 'gemini-3.8-flash-medium');
  assert.equal(tFromTxBannerOnline.modelDisplayName, 'Gemini 3.8 Flash (Medium)');

  // Offline catalog with only <USER_SETTINGS_CHANGE> display label -> never leaks human label, falls back to 'pro'
  resetModelConfigCache();
  const lsOffline = await startMockLs(t, { withCatalog: false, generatorMetadataByCascade: genMetaByCascade });
  writeFileSync(
    txPath,
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      content:
        '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Neon (High).\n</USER_SETTINGS_CHANGE>\n<USER_REQUEST>Hi</USER_REQUEST>',
    }),
    'utf8',
  );
  const resolvedOffline = await resolveInheritedCoordinatorModel({
    workspacePath: repoRoot,
    coordinatorId: coordConvId,
    catalogModels: [],
  });
  assert.equal(resolvedOffline.model, 'pro');
  const tFromTxBannerOffline = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: coordConvId,
    title: 'Inherit transcript offline safe',
    taskPrompt: 'Never send display label',
    model: 'inherit',
    createWorktree: false,
  });
  assert.equal(lsOffline.createRequests.at(-1).model, 'pro');
  assert.notEqual(lsOffline.createRequests.at(-1).model, 'inherit');
  assert.notEqual(lsOffline.createRequests.at(-1).model, 'Gemini 4 Neon (High)');
  assert.equal(tFromTxBannerOffline.model, 'pro');
});

function loadUiModelHelpers() {
  const src = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const start = src.indexOf('function formatModelDisplay(');
  const endMarker = 'function normalizeActivityText(';
  const end = src.indexOf(endMarker, start);
  assert.notEqual(start, -1, 'formatModelDisplay must exist in app.js');
  assert.notEqual(end, -1, 'normalizeActivityText must follow model helpers in app.js');
  const code = src.slice(start, end);
  const ctx = {};
  vm.runInNewContext(
    `${code}
     this.formatModelDisplay = formatModelDisplay;
     this.isSameModelFamily = isSameModelFamily;
     this.buildModelFamilyGroups = buildModelFamilyGroups;
     this.resolveModelFamilySelection = resolveModelFamilySelection;`,
    ctx,
  );
  return ctx;
}

test('buildModelFamilyGroups and resolveModelFamilySelection group multi-tier models, single-variant models, special modes, and match UI identically', () => {
  const ui = loadUiModelHelpers();

  const richCatalog = [
    {
      id: 'gemini-4-neon-high',
      modelId: 'gemini-4-neon-high',
      modelEnum: 'MODEL_PLACEHOLDER_M532',
      label: 'Gemini 4 Neon (High)',
      familyId: 'gemini-4-neon',
      familyName: 'Gemini 4 Neon',
      thinkingLevel: 'High',
      isDefault: true,
    },
    {
      id: 'gemini-4-neon-low',
      modelId: 'gemini-4-neon-low',
      modelEnum: 'MODEL_PLACEHOLDER_M534',
      label: 'Gemini 4 Neon (Low)',
      familyId: 'gemini-4-neon',
      familyName: 'Gemini 4 Neon',
      thinkingLevel: 'Low',
      isDefault: false,
    },
    {
      id: 'gemini-4-hydrogen-xhigh',
      modelId: 'gemini-4-hydrogen-xhigh',
      modelEnum: 'MODEL_PLACEHOLDER_M528',
      label: 'Gemini 4 Hydrogen (XHigh)',
      isDefault: false,
    },
    {
      id: 'gemini-4-hydrogen-low',
      modelId: 'gemini-4-hydrogen-low',
      modelEnum: 'MODEL_PLACEHOLDER_M527',
      label: 'Gemini 4 Hydrogen (Low)',
      isDefault: false,
    },
    {
      id: 'gemini-4-hydrogen-high',
      modelId: 'gemini-4-hydrogen-high',
      modelEnum: 'MODEL_PLACEHOLDER_M529',
      label: 'Gemini 4 Hydrogen (High)',
      isDefault: false,
    },
    {
      id: 'gemini-4-hydrogen-medium',
      modelId: 'gemini-4-hydrogen-medium',
      modelEnum: 'MODEL_PLACEHOLDER_M530',
      label: 'Gemini 4 Hydrogen (Medium)',
      isDefault: false,
    },
    {
      id: 'claude-sonnet-4-6',
      modelId: 'claude-sonnet-4-6',
      modelEnum: 'MODEL_PLACEHOLDER_M34',
      label: 'Claude Sonnet 4.6',
      isDefault: false,
    },
    {
      id: 'claude-sonnet-4-6-thinking',
      modelId: 'claude-sonnet-4-6-thinking',
      modelEnum: 'MODEL_PLACEHOLDER_M35',
      label: 'Claude Sonnet 4.6 (Thinking)',
      isDefault: false,
    },
    {
      id: 'gpt-oss-120b-medium',
      modelId: 'gpt-oss-120b-medium',
      modelEnum: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM',
      label: 'GPT-OSS 120B (Medium)',
      isDefault: false,
    },
    {
      id: 'gemini-3.8-flash-medium',
      modelId: 'gemini-3.8-flash-medium',
      modelEnum: 'MODEL_PLACEHOLDER_M319',
      label: 'Gemini 3.8 Flash (Medium)',
      isDefault: false,
    },
  ];

  const groupOpts = {
    includeFollowGlobal: true,
    followGlobalLabel: 'Follow Global Default (Follow Coordinator · Gemini 4 Neon (High))',
    includeInherit: true,
    inheritLabel: 'Follow Coordinator (Gemini 4 Neon (High))',
  };

  const libGroups = buildModelFamilyGroups(richCatalog, groupOpts);
  const uiGroups = ui.buildModelFamilyGroups(richCatalog, groupOpts);
  assert.deepEqual(JSON.parse(JSON.stringify(uiGroups)), JSON.parse(JSON.stringify(libGroups)));

  // Verify special modes order at top and NO synthetic Auto Tier (__tier__) group exists
  assert.equal(libGroups.some((g) => g.kind === 'tier' || g.key === '__tier__'), false);
  assert.equal(libGroups[0].kind, 'follow_global');
  assert.equal(libGroups[0].hasTiers, false);
  assert.equal(libGroups[1].kind, 'inherit');
  assert.equal(libGroups[1].hasTiers, false);
  assert.equal(libGroups[2].kind, 'family');
  for (const g of libGroups) {
    for (const tierOpt of g.tiers || []) {
      assert.equal(
        /^(?:pro|flash|flash lite)$/i.test(tierOpt.label),
        false,
        `Tier dropdown must not show Pro/Flash/Flash Lite (${g.label} -> ${tierOpt.label})`,
      );
    }
  }

  // Multi-tier family grouping & Low -> Medium -> High -> XHigh ordering + defaultValue
  const neonGrp = libGroups.find((g) => g.label === 'Gemini 4 Neon');
  assert.ok(neonGrp);
  assert.equal(neonGrp.hasTiers, true);
  assert.deepEqual(
    neonGrp.tiers.map((x) => x.label),
    ['Low', 'High'],
  );
  assert.equal(neonGrp.defaultValue, 'gemini-4-neon-high');

  const hydroGrp = libGroups.find((g) => g.label === 'Gemini 4 Hydrogen');
  assert.ok(hydroGrp);
  assert.equal(hydroGrp.hasTiers, true);
  assert.deepEqual(
    hydroGrp.tiers.map((x) => x.label),
    ['Low', 'Medium', 'High', 'XHigh'],
  );
  assert.equal(hydroGrp.defaultValue, 'gemini-4-hydrogen-high');

  // Mixed bare + (Thinking) family grouping
  const claudeGrp = libGroups.find((g) => g.label === 'Claude Sonnet 4.6');
  assert.ok(claudeGrp);
  assert.equal(claudeGrp.hasTiers, true);
  assert.deepEqual(
    claudeGrp.tiers.map((x) => x.label),
    ['Standard', 'Thinking'],
  );

  // Single-variant models stay intact in Base Model with Tier disabled (hasTiers: false)
  const gptGrp = libGroups.find((g) => g.label === 'GPT-OSS 120B (Medium)');
  assert.ok(gptGrp);
  assert.equal(gptGrp.hasTiers, false);
  assert.equal(gptGrp.defaultValue, 'gpt-oss-120b-medium');

  const flash38Grp = libGroups.find((g) => g.label === 'Gemini 3.8 Flash (Medium)');
  assert.ok(flash38Grp);
  assert.equal(flash38Grp.hasTiers, false);

  // Reverse-lookup round-trip across stored variants (legacy pro/flash/flash-lite map to concrete models!)
  const roundTripCases = [
    ['', '__follow_global__', ''],
    ['inherit', '__inherit__', 'inherit'],
    ['pro', 'family:gemini 4 neon', 'gemini-4-neon-high'],
    ['flash', 'family:gemini 3.8 flash', 'gemini-3.8-flash-medium'],
    ['flash-lite', 'family:gemini 3.8 flash', 'gemini-3.8-flash-medium'],
    ['gemini-4-hydrogen-xhigh', 'family:gemini 4 hydrogen', 'gemini-4-hydrogen-xhigh'],
    ['gemini-4-hydrogen-tiered-xhigh', 'family:gemini 4 hydrogen', 'gemini-4-hydrogen-xhigh'],
    ['MODEL_PLACEHOLDER_M528', 'family:gemini 4 hydrogen', 'gemini-4-hydrogen-xhigh'],
    ['Gemini 4 Neon (Low)', 'family:gemini 4 neon', 'gemini-4-neon-low'],
    ['MODEL_OPENAI_GPT_OSS_120B_MEDIUM', 'family:gpt-oss 120b', 'gpt-oss-120b-medium'],
    ['claude-sonnet-4-6-thinking', 'family:claude sonnet 4.6', 'claude-sonnet-4-6-thinking'],
    ['gemini-5-alpha-high', 'custom:gemini-5-alpha-high', 'gemini-5-alpha-high'],
  ];

  for (const [input, expectedGroupKey, expectedValue] of roundTripCases) {
    const libSel = resolveModelFamilySelection(input, libGroups);
    const uiSel = ui.resolveModelFamilySelection(input, uiGroups);
    assert.equal(libSel.groupKey, expectedGroupKey, `groupKey for ${input}`);
    assert.equal(libSel.value, expectedValue, `value for ${input}`);
    assert.equal(uiSel.groupKey, libSel.groupKey, `UI parity groupKey for ${input}`);
    assert.equal(uiSel.value, libSel.value, `UI parity value for ${input}`);
  }

  // Legacy flash_lite prefers explicit Flash Lite catalog model when present
  const catalogWithLite = [
    ...richCatalog,
    {
      id: 'gemini-3.8-flash-lite',
      modelId: 'gemini-3.8-flash-lite',
      modelEnum: 'MODEL_PLACEHOLDER_M320',
      label: 'Gemini 3.8 Flash Lite (Standard)',
      isDefault: false,
    },
  ];
  const liteGroupsLib = buildModelFamilyGroups(catalogWithLite, groupOpts);
  const liteGroupsUi = ui.buildModelFamilyGroups(catalogWithLite, groupOpts);
  const liteSel = resolveModelFamilySelection('flash_lite', liteGroupsLib);
  assert.equal(liteSel.value, 'gemini-3.8-flash-lite');
  assert.equal(ui.resolveModelFamilySelection('flash_lite', liteGroupsUi).value, 'gemini-3.8-flash-lite');

  // Offline catalog (no concrete models): legacy aliases fall back cleanly to inherit / follow_global, NEVER custom:pro
  const offlineGlobalGroups = buildModelFamilyGroups([], {
    includeFollowGlobal: false,
    includeInherit: true,
  });
  const offlineProjectGroups = buildModelFamilyGroups([], {
    includeFollowGlobal: true,
    includeInherit: true,
  });
  for (const legacy of ['pro', 'flash', 'flash_lite']) {
    const offGlobalSel = resolveModelFamilySelection(legacy, offlineGlobalGroups, {
      fallbackValue: 'inherit',
    });
    assert.equal(offGlobalSel.groupKey, '__inherit__');
    assert.equal(offGlobalSel.value, 'inherit');
    assert.equal(
      ui.resolveModelFamilySelection(legacy, offlineGlobalGroups, { fallbackValue: 'inherit' }).value,
      'inherit',
    );
    const offProjSel = resolveModelFamilySelection(legacy, offlineProjectGroups, {
      fallbackValue: '',
    });
    assert.equal(offProjSel.groupKey, '__follow_global__');
    assert.equal(offProjSel.value, '');
  }

  // Verify + New Thread two-level (#f-model + #f-tier) dispatch modal groups & default fallback
  const dispatchGroups = buildModelFamilyGroups(richCatalog, {
    includeFollowGlobal: true,
    followGlobalLabel: 'Use Settings Default (Follow Coordinator · Gemini 4 Neon (High))',
    includeInherit: true,
    inheritLabel: 'Follow Coordinator (Gemini 4 Neon (High))',
  });
  assert.equal(dispatchGroups[0].label, 'Use Settings Default (Follow Coordinator · Gemini 4 Neon (High))');
  assert.equal(dispatchGroups[0].hasTiers, false);
  assert.equal(dispatchGroups[1].key, '__inherit__');
  assert.equal(dispatchGroups[2].kind, 'family');
  assert.equal(dispatchGroups.some((g) => g.key === '__tier__'), false);
  const dispatchDefaultSel = resolveModelFamilySelection('', dispatchGroups, { fallbackValue: '' });
  assert.equal(dispatchDefaultSel.groupKey, '__follow_global__');
  assert.equal(dispatchDefaultSel.value, '');
  const dispatchHydroSel = resolveModelFamilySelection('gemini-4-hydrogen-xhigh', dispatchGroups, { fallbackValue: '' });
  assert.equal(dispatchHydroSel.groupKey, 'family:gemini 4 hydrogen');
  assert.equal(dispatchHydroSel.value, 'gemini-4-hydrogen-xhigh');
  assert.equal(dispatchHydroSel.group?.hasTiers, true);
});

test('static and protocol checks: hook DIRECTIVE_VERSION=14, skill, MCP, Sidecar API/UI, I18N, and LF endings', (t) => {
  const hookHandler = readFileSync(new URL('../scripts/hook-handler.mjs', import.meta.url), 'utf8');
  const skillMd = readFileSync(new URL('../skills/coord/SKILL.md', import.meta.url), 'utf8');
  const serverMjs = readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');
  const mainMjs = readFileSync(new URL('../sidecars/threads/main.mjs', import.meta.url), 'utf8');
  const indexHtml = readFileSync(new URL('../sidecars/threads/index.html', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const themeCss = readFileSync(new URL('../sidecars/threads/theme.css', import.meta.url), 'utf8');

  // 1. Hook directive version bumped to 14 and no hardcoded model: "pro"
  assert.match(hookHandler, /const\s+DIRECTIVE_VERSION\s*=\s*14\s*;/);
  assert.equal(/model:\s*["']pro["']/.test(hookHandler), false);

  // 2. SKILL.md no longer hardcodes model: "pro"
  assert.equal(/model:\s*["']pro["']/.test(skillMd), false);

  // 3. MCP dispatch_thread no longer claims Defaults to "flash" and passes model only when provided
  assert.equal(/Defaults to "flash"/i.test(serverMjs), false);
  assert.match(serverMjs, /Settings/i);

  // 4. Sidecar backend routes and handleDispatch
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/settings['"]/);
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/settings_save['"]/);
  assert.match(mainMjs, /coordinatorModelDisplayName/);
  assert.match(mainMjs, /model:\s*data\.model\s*\|\|\s*''/);
  assert.equal(/model:\s*data\.model\s*\|\|\s*'pro'/.test(mainMjs), false);

  // 5. Sidecar UI structure: preview card removed, two-level Model+Tier controls & inherit mode wired, zero native dialogs, I18N across 3 locales
  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appJs), false);
  assert.match(indexHtml, /id="btn-settings"/);
  assert.match(indexHtml, /id="settings-screen"/);
  assert.match(indexHtml, /class="seg-group settings-seg"/);
  assert.match(indexHtml, /id="set-worktree-model"/);
  assert.match(indexHtml, /id="set-worktree-tier"/);
  assert.match(indexHtml, /id="set-readonly-model"/);
  assert.match(indexHtml, /id="set-readonly-tier"/);
  assert.match(indexHtml, /id="f-model"/);
  assert.match(indexHtml, /id="f-tier"/);
  assert.match(indexHtml, /<option value="">/);
  assert.match(indexHtml, /<option value="(?:__)?inherit(?:__)?">/);

  // Redundant effective-models preview card removed from HTML, JS, and CSS
  assert.equal(/settings-preview-card|val-preview-wt|val-preview-ro|src-preview-wt|src-preview-ro|settings-unsaved-badge/.test(indexHtml), false);
  assert.equal(/renderSettingsPreview|val-preview-|src-preview-|settings-unsaved-badge/.test(appJs), false);
  assert.equal(/\.settings-preview-|\.settings-src-pill|\.settings-unsaved-pill/.test(themeCss), false);

  assert.match(themeCss, /#settings-screen|\.settings-body/);
  assert.match(themeCss, /\.settings-model-row/);
  assert.match(themeCss, /@media\s*\(max-width:\s*320px\)/);

  // Auto Tier (__tier__ / 智能档位) completely removed from Settings/Dispatch UI & helpers
  assert.equal(/value=["']__tier__["']|Auto Tier|智能档位|智慧層級/.test(indexHtml), false);
  assert.equal(/settingsTierAutoGroup|modelGroupTiers|tierPro\b|tierFlash\b|tierFlashLite\b|__tier__|智能档位|Auto Tier|智慧層級/.test(appJs), false);

  for (const key of [
    'fTier',
    'modelBack',
    'settingsTip',
    'settingsTitle',
    'settingsScopeGlobal',
    'settingsScopeProject',
    'settingsWorktreeLabel',
    'settingsReadOnlyLabel',
    'settingsModelColLabel',
    'settingsTierColLabel',
    'settingsTierDefault',
    'settingsTierStandard',
    'settingsTierNone',
    'settingsInheritOption',
    'settingsInheritWithModel',
    'settingsInheritShort',
    'settingsFollowGlobal',
    'settingsSave',
    'settingsSavedToast',
    'settingsResetGlobal',
    'settingsResetProject',
    'useSettingsDefault',
  ]) {
    const matches = appJs.match(new RegExp(`\\b${key}:`, 'g')) || [];
    assert.equal(matches.length, 3, `${key} must be defined in en, zh-CN, and zh-TW`);
  }

  // 6. Verify MCP server tools/list reports updated dispatch_thread schema
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const rpcRes = spawnSync(
    process.execPath,
    ['mcp/server.mjs'],
    {
      cwd: repoRoot,
      input:
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n` +
        `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
      encoding: 'utf8',
    },
  );
  assert.equal(rpcRes.status, 0);
  const lines = rpcRes.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
  const toolsMsg = lines.find((m) => m.id === 2);
  const dispatchTool = toolsMsg?.result?.tools?.find((t) => t.name === 'dispatch_thread');
  assert.ok(dispatchTool);
  assert.match(dispatchTool.inputSchema.properties.model.description, /Settings/i);

  // 7. Verify hook-handler PreInvocation emits updated v14 directive without hardcoded model: "pro"
  const hookEnv = createTempEnv(t, 'pt-set-hook-');
  const hookWorkspace = join(hookEnv.tempRoot, 'hook-workspace');
  const hookReg = loadRegistry();
  hookReg.coordinators['__hook_test__'] = {
    key: '__hook_test__',
    conversationId: 'conv-hook-coord',
    workspacePath: hookWorkspace,
    repoRoot: hookWorkspace,
    title: '[Coordinator] HookTest',
    directiveVersion: 13,
  };
  saveRegistry(hookReg);

  const hookRes = spawnSync(
    process.execPath,
    ['scripts/hook-handler.mjs', 'PreInvocation'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ANTIGRAVITY_GEMINI_DIR: hookEnv.geminiDir,
        ANTIGRAVITY_APP_DATA_DIR: hookEnv.appDataDir,
      },
      input: JSON.stringify({
        hookEventName: 'PreInvocation',
        conversationId: 'conv-hook-coord',
        initialNumSteps: 4,
      }),
      encoding: 'utf8',
    },
  );
  assert.equal(hookRes.status, 0);
  const hookOut = JSON.parse(hookRes.stdout.trim());
  const injectedDirective = hookOut?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
  assert.ok(injectedDirective.includes('dispatch_thread'), 'upgraded v13 -> v14 coordinator receives new directive');
  assert.match(injectedDirective, /Read-only.*`createWorktree: false`.*autonomously decide.*`archive_thread`/i);
  assert.match(
    injectedDirective,
    /Worktree threads.*`createWorktree: true`.*NOT.*auto-archive before user acceptance.*once the user confirms acceptance.*automatically call `archive_thread`/i,
  );
  assert.match(injectedDirective, /manage_decisions/);
  assert.equal(/model:\s*["']pro["']/.test(injectedDirective), false);
  assert.equal(loadRegistry().coordinators['__hook_test__'].directiveVersion, 14);

  // 8. LF line endings on all modified/added .mjs files
  for (const rel of [
    '../lib/model-format.mjs',
    '../lib/store.mjs',
    '../scripts/hook-handler.mjs',
    '../mcp/server.mjs',
    '../sidecars/threads/main.mjs',
    '../tests/model-display.test.mjs',
    '../tests/settings-default-model.test.mjs',
  ]) {
    const raw = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!raw.includes(Buffer.from('\r')), `${rel} must use LF line endings`);
  }
});

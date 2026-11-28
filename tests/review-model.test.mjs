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
  buildFallbackEffectiveSettings,
  dispatchThread,
  getEffectiveSettings,
  loadRegistry,
  loadSettings,
  normalizeKey,
  normalizeThreadType,
  resolveDefaultDispatchModel,
  saveRegistry,
  saveSettings,
  saveSettingsWithFastResponse,
} from '../lib/store.mjs';

function createTempEnv(t, prefix = 'pt-review-') {
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

const REVIEW_SAMPLE_MODEL_CONFIG = {
  clientModelConfigs: [
    {
      label: 'Claude Opus 4.6 (Thinking)',
      modelId: 'claude-opus-4-6-thinking',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M40' },
      quotaInfo: { remainingFraction: 0.85 },
    },
    {
      label: 'Claude Opus 4.6',
      modelId: 'claude-opus-4-6',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M39' },
      quotaInfo: { remainingFraction: 0.9 },
    },
    {
      label: 'Gemini 4 Neon (XHigh)',
      modelId: 'gemini-4-neon-xhigh',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M531' },
      thinkingLevel: 'Extra High',
      quotaInfo: { remainingFraction: 0.95 },
    },
    {
      label: 'Gemini 4 Neon (Low)',
      modelId: 'gemini-4-neon-low',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M534' },
      quotaInfo: { remainingFraction: 0.98 },
    },
    {
      label: 'Gemini 3.8 Flash (Medium)',
      modelId: 'gemini-3.8-flash-medium',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M319' },
      quotaInfo: { remainingFraction: 0.8 },
    },
  ],
  defaultOverrideModelConfig: {
    modelOrAlias: { model: 'MODEL_PLACEHOLDER_M531' },
  },
};

function startMockLs(t, { withCatalog = true, generatorMetadataByCascade = null } = {}) {
  const createRequests = [];
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
        res.end(JSON.stringify(REVIEW_SAMPLE_MODEL_CONFIG));
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
              id: `conv-rev-${createRequests.length}`,
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
      res.statusCode = 404;
      res.end('{}');
    });
  });

  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${port}`;
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-review-test';
      t.after(() => new Promise((r) => server.close(r)));
      resolveListen({ port, createRequests, genMetaByCascade });
    });
  });
}

function initGitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# Review Test\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
}

test('Issue #7: reviewModel settings persistence, legacy migration, project inheritance, and Extra High / Thinking normalization', async (t) => {
  const { tempRoot, stateDir } = createTempEnv(t, 'pt-rev-set-');
  await startMockLs(t, { withCatalog: true });

  const repoRoot = join(tempRoot, 'legacy-repo');
  initGitRepo(repoRoot);
  const wk = normalizeKey(repoRoot);

  // 1. Legacy settings.json without reviewModel loads cleanly and defaults to inherit / ""
  writeFileSync(
    join(stateDir, 'settings.json'),
    JSON.stringify({
      version: 1,
      defaults: {
        worktreeModel: 'gemini-4-neon-low',
        readOnlyModel: 'gemini-3.8-flash-medium',
      },
      projects: {
        [wk]: {
          worktreeModel: 'gemini-4-neon-xhigh',
          readOnlyModel: '',
        },
      },
    }),
    'utf8',
  );

  const migrated = loadSettings();
  assert.deepEqual(migrated.defaults, {
    worktreeModel: 'gemini-4-neon-low',
    readOnlyModel: 'gemini-3.8-flash-medium',
    reviewModel: 'inherit',
  });
  assert.deepEqual(migrated.projects[wk], {
    worktreeModel: 'gemini-4-neon-xhigh',
    readOnlyModel: '',
    reviewModel: '',
  });

  // 2. Partial global save updates reviewModel while preserving sibling fields
  const afterGlobal = saveSettings({ scope: 'global', reviewModel: 'claude-opus-4-6-thinking' });
  assert.equal(afterGlobal.defaults.worktreeModel, 'gemini-4-neon-low');
  assert.equal(afterGlobal.defaults.readOnlyModel, 'gemini-3.8-flash-medium');
  assert.equal(afterGlobal.defaults.reviewModel, 'claude-opus-4-6-thinking');

  // 3. Project with ONLY reviewModel override is persisted and clears cleanly when emptied
  const wk2 = normalizeKey(join(tempRoot, 'review-only-proj'));
  saveSettings({ scope: 'project', workspaceKey: wk2, reviewModel: 'claude-opus-4-6' });
  let loaded = loadSettings();
  assert.deepEqual(loaded.projects[wk2], {
    worktreeModel: '',
    readOnlyModel: '',
    reviewModel: 'claude-opus-4-6',
  });

  const fallbackEff = buildFallbackEffectiveSettings(loaded, { scopeKey: wk2 });
  assert.equal(fallbackEff.hasProjectOverride, true);
  assert.equal(fallbackEff.reviewSource, 'project');
  assert.equal(fallbackEff.reviewModel, 'claude-opus-4-6');
  assert.equal(fallbackEff.worktreeSource, 'global');
  assert.equal(fallbackEff.readOnlySource, 'global');

  // Clearing project reviewModel when worktree/readOnly are empty removes empty project entry
  saveSettings({ scope: 'project', workspaceKey: wk2, reviewModel: '' });
  assert.equal(loadSettings().projects[wk2], undefined);

  // 4. saveSettingsWithFastResponse normalizes Extra High -> xhigh and separates Thinking vs non-Thinking
  const reg = loadRegistry();
  reg.coordinators[wk] = {
    key: wk,
    conversationId: 'conv-coord-rev-set',
    workspacePath: repoRoot,
    repoRoot,
    defaultBranch: 'main',
    title: '[Coordinator] RevSet',
  };
  saveRegistry(reg);

  const fastExtraHigh = await saveSettingsWithFastResponse({
    scope: 'global',
    workspaceKey: wk,
    reviewModel: 'Gemini 4 Neon (Extra High)',
  });
  assert.equal(fastExtraHigh.ok, true);
  assert.equal(fastExtraHigh.settings.defaults.reviewModel, 'gemini-4-neon-xhigh');
  assert.equal(fastExtraHigh.effective.global.reviewModel, 'gemini-4-neon-xhigh');

  const fastThinking = await saveSettingsWithFastResponse({
    scope: 'project',
    workspaceKey: wk,
    reviewModel: 'Claude Opus 4.6 (Thinking)',
  });
  assert.equal(fastThinking.ok, true);
  assert.equal(fastThinking.settings.projects[wk].reviewModel, 'claude-opus-4-6-thinking');
  assert.equal(fastThinking.effective.reviewModel, 'claude-opus-4-6-thinking');
  assert.equal(fastThinking.effective.reviewModelLabel, 'Claude Opus 4.6 (Thinking)');
  assert.equal(fastThinking.effective.reviewSource, 'project');

  const fastBare = await saveSettingsWithFastResponse({
    scope: 'project',
    workspaceKey: wk,
    reviewModel: 'Claude Opus 4.6',
  });
  assert.equal(fastBare.ok, true);
  assert.equal(fastBare.settings.projects[wk].reviewModel, 'claude-opus-4-6');
  assert.equal(fastBare.effective.reviewModel, 'claude-opus-4-6');
  assert.equal(fastBare.effective.reviewModelLabel, 'Claude Opus 4.6');
});

test('Issue #7: normalizeThreadType, resolveDefaultDispatchModel, and dispatchThread route threadType="review" cleanly', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-rev-dispatch-');
  const genMetaByCascade = new Map();
  const ls = await startMockLs(t, { withCatalog: true, generatorMetadataByCascade: genMetaByCascade });

  // Unit assertions on normalizeThreadType
  assert.equal(normalizeThreadType('review', true), 'review');
  assert.equal(normalizeThreadType('Code-Review', false), 'review');
  assert.equal(normalizeThreadType('readonly', true), 'readonly');
  assert.equal(normalizeThreadType('read-only', true), 'readonly');
  assert.equal(normalizeThreadType('worktree', false), 'worktree');
  assert.equal(normalizeThreadType('', true), 'worktree');
  assert.equal(normalizeThreadType('', false), 'readonly');
  assert.equal(normalizeThreadType(undefined, true), 'worktree');
  assert.equal(normalizeThreadType(undefined, false), 'readonly');

  const repoRoot = join(tempRoot, 'dispatch-rev-repo');
  initGitRepo(repoRoot);
  const wk = normalizeKey(repoRoot);
  const coordId = 'conv-coord-rev-dispatch';

  const reg = loadRegistry();
  reg.coordinators[wk] = {
    key: wk,
    conversationId: coordId,
    workspacePath: repoRoot,
    repoRoot,
    defaultBranch: 'main',
    title: '[Coordinator] RevDispatch',
  };
  saveRegistry(reg);

  genMetaByCascade.set(coordId, [
    {
      stepIndices: [1, 2],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M531',
        responseModel: 'gemini-4-neon-tiered-xhigh',
        modelDisplayName: 'Gemini 4 Neon (XHigh)',
      },
    },
  ]);

  saveSettings({
    defaults: {
      worktreeModel: 'gemini-4-neon-low',
      readOnlyModel: 'gemini-3.8-flash-medium',
      reviewModel: 'claude-opus-4-6-thinking',
    },
    projects: {
      [wk]: {
        worktreeModel: '',
        readOnlyModel: '',
        reviewModel: '',
      },
    },
  });

  // 1. Global reviewModel applies when project override is empty
  assert.equal(
    await resolveDefaultDispatchModel({ threadType: 'review', createWorktree: false, workspacePath: repoRoot }),
    'claude-opus-4-6-thinking',
  );
  assert.equal(
    await resolveDefaultDispatchModel({ createWorktree: false, workspacePath: repoRoot }),
    'gemini-3.8-flash-medium',
  );
  assert.equal(
    await resolveDefaultDispatchModel({ createWorktree: true, workspacePath: repoRoot }),
    'gemini-4-neon-low',
  );

  // 2. Project reviewModel overrides global reviewModel
  saveSettings({ scope: 'project', workspaceKey: wk, reviewModel: 'claude-opus-4-6' });
  const effProj = await getEffectiveSettings({ workspacePath: repoRoot });
  assert.equal(effProj.reviewModel, 'claude-opus-4-6');
  assert.equal(effProj.reviewSource, 'project');
  assert.equal(
    await resolveDefaultDispatchModel({ threadType: 'review', workspacePath: repoRoot }),
    'claude-opus-4-6',
  );

  // 3. dispatchThread with threadType="review" & createWorktree=false routes to reviewModel without worktree
  const tReview = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: coordId,
    title: 'Cross-model review PR #7',
    taskPrompt: 'Review all changes carefully.',
    threadType: 'review',
    createWorktree: false,
  });
  assert.equal(ls.createRequests.at(-1).model, 'claude-opus-4-6');
  assert.equal(tReview.model, 'claude-opus-4-6');
  assert.equal(tReview.modelDisplayName, 'Claude Opus 4.6');
  assert.equal(tReview.threadType, 'review');
  assert.equal(tReview.worktreePath, '');

  // 4. dispatchThread with threadType="review" and omitted createWorktree defaults createWorktree to false
  const tReviewOmittedWt = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: coordId,
    title: 'Review with omitted createWorktree',
    taskPrompt: 'Audit error handling.',
    threadType: 'review',
  });
  assert.equal(ls.createRequests.at(-1).model, 'claude-opus-4-6');
  assert.equal(tReviewOmittedWt.threadType, 'review');
  assert.equal(tReviewOmittedWt.worktreePath, '');

  // 5. Explicit model override beats reviewModel
  const tReviewOverride = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: coordId,
    title: 'Review with explicit flash',
    taskPrompt: 'Quick syntax audit.',
    threadType: 'review',
    createWorktree: false,
    model: 'gemini-3.8-flash-medium',
  });
  assert.equal(ls.createRequests.at(-1).model, 'gemini-3.8-flash-medium');
  assert.equal(tReviewOverride.threadType, 'review');

  // 6. Project reviewModel="inherit" dynamically resolves active Coordinator model (never sends literal "inherit")
  saveSettings({ scope: 'project', workspaceKey: wk, reviewModel: 'inherit' });
  const tReviewInherit = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: coordId,
    title: 'Review inheriting Coordinator',
    taskPrompt: 'Review with Coordinator model.',
    threadType: 'review',
    createWorktree: false,
  });
  assert.equal(ls.createRequests.at(-1).model, 'gemini-4-neon-xhigh');
  assert.notEqual(ls.createRequests.at(-1).model, 'inherit');
  assert.equal(tReviewInherit.modelDisplayName, 'Gemini 4 Neon (XHigh)');
  assert.equal(tReviewInherit.threadType, 'review');

  // 7. Clearing project reviewModel falls back to global reviewModel
  saveSettings({ scope: 'project', workspaceKey: wk, reviewModel: '' });
  const tReviewFallbackGlobal = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: coordId,
    title: 'Review fallback to global',
    taskPrompt: 'Review using global Opus Thinking.',
    threadType: 'review',
    createWorktree: false,
  });
  assert.equal(ls.createRequests.at(-1).model, 'claude-opus-4-6-thinking');
  assert.equal(tReviewFallbackGlobal.modelDisplayName, 'Claude Opus 4.6 (Thinking)');

  // 8. Omitting threadType keeps exact backward-compatible routing
  const tLegacyRo = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: coordId,
    title: 'Legacy read-only check',
    taskPrompt: 'Check config.',
    createWorktree: false,
  });
  assert.equal(ls.createRequests.at(-1).model, 'gemini-3.8-flash-medium');
  assert.equal(tLegacyRo.threadType, 'readonly');

  const tLegacyWt = await dispatchThread({
    workspacePath: repoRoot,
    coordinatorId: coordId,
    title: 'Legacy worktree task',
    taskPrompt: 'Edit README.',
    createWorktree: true,
  });
  assert.equal(ls.createRequests.at(-1).model, 'gemini-4-neon-low');
  assert.equal(tLegacyWt.threadType, 'worktree');
  assert.ok(tLegacyWt.worktreePath);
});

function makeMockSelectElement(id) {
  const cls = new Set();
  const attrs = new Map();
  let inner = '';
  const el = {
    id,
    hidden: false,
    disabled: false,
    title: '',
    value: '',
    selectedIndex: 0,
    options: [],
    classList: {
      add: (...n) => n.forEach((x) => cls.add(x)),
      remove: (...n) => n.forEach((x) => cls.delete(x)),
      toggle: (n, force) => {
        if (force === undefined) {
          if (cls.has(n)) cls.delete(n);
          else cls.add(n);
        } else if (force) cls.add(n);
        else cls.delete(n);
      },
      contains: (n) => cls.has(n),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => attrs.get(k) ?? null,
    get innerHTML() {
      return inner;
    },
    set innerHTML(html) {
      inner = String(html || '');
      const opts = [];
      const re = /<option value="([^"]*)">([\s\S]*?)<\/option>/g;
      let m;
      while ((m = re.exec(inner)) !== null) {
        opts.push({
          value: m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
          text: m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
        });
      }
      el.options = opts;
      if (opts.length > 0 && !opts.some((o) => o.value === el.value)) {
        el.value = opts[0].value;
        el.selectedIndex = 0;
      }
    },
  };
  return el;
}

function makeMockEl(id) {
  if (/-(?:model|tier)$/.test(id)) return makeMockSelectElement(id);
  const cls = new Set();
  const attrs = new Map();
  return {
    id,
    hidden: false,
    disabled: false,
    textContent: '',
    innerHTML: '',
    title: '',
    value: '',
    classList: {
      add: (...n) => n.forEach((x) => cls.add(x)),
      remove: (...n) => n.forEach((x) => cls.delete(x)),
      toggle: (n, force) => {
        if (force === undefined) {
          if (cls.has(n)) cls.delete(n);
          else cls.add(n);
        } else if (force) cls.add(n);
        else cls.delete(n);
      },
      contains: (n) => cls.has(n),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => attrs.get(k) ?? null,
  };
}

function loadSettingsAndDispatchUiHarness({ locale = 'zh-CN' } = {}) {
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const i18nStart = appJs.indexOf('const I18N = {');
  const i18nEnd = appJs.indexOf('let curLocale =', i18nStart);
  const fmtStart = appJs.indexOf('function formatModelDisplay(');
  const fmtEnd = appJs.indexOf('function normalizeActivityText(', fmtStart);
  const catStart = appJs.indexOf('function matchesLiveThreadModel(');
  const catEnd = appJs.indexOf('const MODEL_MENU_SUB_WIDTH', catStart);
  const setStart = appJs.indexOf('function getCurrentEffectiveSettings(');
  const setEnd = appJs.indexOf('async function loadSettingsData(', setStart);
  const saveStart = appJs.indexOf('async function submitSettingsSave(');
  const saveEnd = appJs.indexOf('async function loadSelectableModels(', saveStart);

  for (const [name, pos] of [
    ['i18nStart', i18nStart],
    ['i18nEnd', i18nEnd],
    ['fmtStart', fmtStart],
    ['fmtEnd', fmtEnd],
    ['catStart', catStart],
    ['catEnd', catEnd],
    ['setStart', setStart],
    ['setEnd', setEnd],
    ['saveStart', saveStart],
    ['saveEnd', saveEnd],
  ]) {
    assert.notEqual(pos, -1, `Expected marker ${name} in app.js`);
  }

  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeMockEl(id));
    return elements.get(id);
  };
  const postedPayloads = [];

  const ctx = {
    console,
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
    document: { getElementById: getEl, activeElement: null },
    esc: (s) =>
      String(s || '').replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
      ),
    flashToast: () => {},
    syncHostConversationScope: async () => false,
    buildScopePayload: (extra = {}) => ({ workspace: '/demo/repo', ...extra }),
    loadSettingsData: () => Promise.resolve(true),
    postApi: async (path, _getPath, payload) => {
      postedPayloads.push({ path, payload });
      return {
        ok: true,
        settings: {
          defaults: {
            worktreeModel: payload.worktreeModel || 'inherit',
            readOnlyModel: payload.readOnlyModel || 'inherit',
            reviewModel: payload.reviewModel || 'inherit',
          },
          projects: {},
        },
        effective: {
          scopeKey: '/demo/repo',
          hasProjectOverride: false,
          worktreeModel: payload.worktreeModel || 'inherit',
          readOnlyModel: payload.readOnlyModel || 'inherit',
          reviewModel: payload.reviewModel || 'inherit',
          global: {
            worktreeModel: payload.worktreeModel || 'inherit',
            readOnlyModel: payload.readOnlyModel || 'inherit',
            reviewModel: payload.reviewModel || 'inherit',
          },
          project: { worktreeModel: '', readOnlyModel: '', reviewModel: '' },
        },
      };
    },
  };

  vm.runInNewContext(
    `
    const API_WRITE_TIMEOUT_MS = 12000;
    ${appJs.slice(i18nStart, i18nEnd)}
    let curLocale = ${JSON.stringify(locale)};
    const L = () => I18N[curLocale] || I18N.en;

    let workspace = '/demo/repo';
    let activeScopeKey = '/demo/repo';
    let lastHasGitRepo = true;
    let lastSnap = { coordinator: { conversationId: 'conv-coord-ui' } };
    let selectableModels = [];
    const pendingModelByThread = new Map();
    let settingsScreenOpen = true;
    let settingsScope = 'global';
    let loadedSettingsData = null;
    let settingsSaving = false;
    let settingsDirtyByUser = false;
    let settingsWorktreeGroups = [];
    let settingsReadOnlyGroups = [];
    let settingsReviewGroups = [];
    let dispatchModelGroups = [];
    let dispatchThreadMode = 'worktree';

    const elSettingsScreen = document.getElementById('settings-screen');
    const elSettingsScopeToggle = document.getElementById('settings-scope-toggle');
    const elBtnScopeGlobal = document.getElementById('btn-scope-global');
    const elBtnScopeProject = document.getElementById('btn-scope-project');
    const elSetWorktree = document.getElementById('set-worktree-model');
    const elSetWorktreeTier = document.getElementById('set-worktree-tier');
    const elSetReadOnly = document.getElementById('set-readonly-model');
    const elSetReadOnlyTier = document.getElementById('set-readonly-tier');
    const elSetReview = document.getElementById('set-review-model');
    const elSetReviewTier = document.getElementById('set-review-tier');
    const elFModel = document.getElementById('f-model');
    const elFTier = document.getElementById('f-tier');
    const elFBranchField = document.getElementById('f-branch-field');
    const elFModeSeg = document.getElementById('f-mode-seg');
    const elBtnModeWorktree = document.getElementById('btn-mode-worktree');
    const elBtnModeReadOnly = document.getElementById('btn-mode-readonly');
    const elBtnModeReview = document.getElementById('btn-mode-review');
    const elLblFModeHint = document.getElementById('lbl-f-mode-hint');
    const elBtnSettingsSave = document.getElementById('btn-settings-save');
    const elBtnSettingsReset = document.getElementById('btn-settings-reset');
    const elBtnSettingsRefreshModels = document.getElementById('btn-settings-refresh-models');
    const elSettingsErr = document.getElementById('settings-err');
    const elSettingsInheritNote = document.getElementById('settings-inherit-note');

    ${appJs.slice(fmtStart, fmtEnd)}
    ${appJs.slice(catStart, catEnd)}
    ${appJs.slice(setStart, setEnd)}
    ${appJs.slice(saveStart, saveEnd)}

    this.ui = {
      I18N,
      setLocale: (loc) => { curLocale = loc; },
      setCatalog: (models) => { selectableModels = models; },
      setHasGit: (flag) => { lastHasGitRepo = flag; },
      setSettingsScope: (sc) => { settingsScope = sc; },
      setLoadedSettingsData: (d) => { loadedSettingsData = d; },
      renderSettingsScreen,
      submitSettingsSave,
      readSettingsSlotValue,
      isSettingsDraftDirty,
      setDispatchThreadMode,
      getDispatchThreadMode,
      populateDispatchModelSelect,
      syncDispatchModeUi,
    };
    `,
    ctx,
  );

  return { ui: ctx.ui, getEl, postedPayloads };
}

test('Issue #7: Sidecar Settings UI renders/saves reviewModel and "+ New Thread" Review mode dynamically links effective Review default model', async () => {
  const { ui, getEl, postedPayloads } = loadSettingsAndDispatchUiHarness({ locale: 'zh-CN' });
  ui.setCatalog([
    {
      id: 'claude-opus-4-6-thinking',
      modelId: 'claude-opus-4-6-thinking',
      modelEnum: 'MODEL_PLACEHOLDER_M40',
      label: 'Claude Opus 4.6 (Thinking)',
    },
    {
      id: 'claude-opus-4-6',
      modelId: 'claude-opus-4-6',
      modelEnum: 'MODEL_PLACEHOLDER_M39',
      label: 'Claude Opus 4.6',
    },
    {
      id: 'gemini-4-neon-xhigh',
      modelId: 'gemini-4-neon-xhigh',
      modelEnum: 'MODEL_PLACEHOLDER_M531',
      label: 'Gemini 4 Neon (XHigh)',
    },
    {
      id: 'gemini-4-neon-low',
      modelId: 'gemini-4-neon-low',
      modelEnum: 'MODEL_PLACEHOLDER_M534',
      label: 'Gemini 4 Neon (Low)',
    },
  ]);

  ui.setLoadedSettingsData({
    scopeKey: '/demo/repo',
    coordinatorModel: 'gemini-4-neon-xhigh',
    coordinatorModelDisplayName: 'Gemini 4 Neon (XHigh)',
    settings: {
      defaults: {
        worktreeModel: 'gemini-4-neon-low',
        readOnlyModel: 'inherit',
        reviewModel: 'claude-opus-4-6-thinking',
      },
      projects: {},
    },
    effective: {
      scopeKey: '/demo/repo',
      hasProjectOverride: false,
      coordinatorId: 'conv-coord-ui',
      coordinatorModel: 'gemini-4-neon-xhigh',
      coordinatorModelDisplayName: 'Gemini 4 Neon (XHigh)',
      worktreeModel: 'gemini-4-neon-low',
      worktreeModelLabel: 'Gemini 4 Neon (Low)',
      worktreeSource: 'global',
      readOnlyModel: 'inherit',
      readOnlyModelLabel: 'Follow Coordinator (Gemini 4 Neon (XHigh))',
      readOnlySource: 'global',
      reviewModel: 'claude-opus-4-6-thinking',
      reviewModelLabel: 'Claude Opus 4.6 (Thinking)',
      reviewSource: 'global',
      global: {
        worktreeModel: 'gemini-4-neon-low',
        worktreeModelLabel: 'Gemini 4 Neon (Low)',
        readOnlyModel: 'inherit',
        readOnlyModelLabel: 'Follow Coordinator (Gemini 4 Neon (XHigh))',
        reviewModel: 'claude-opus-4-6-thinking',
        reviewModelLabel: 'Claude Opus 4.6 (Thinking)',
      },
      project: {
        worktreeModel: '',
        readOnlyModel: '',
        reviewModel: '',
      },
    },
  });

  // 1. Settings global scope populates review selector to Claude Opus 4.6 (Thinking)
  ui.renderSettingsScreen(true);
  assert.equal(getEl('lbl-set-review').textContent, '代码审查 / Review 线程默认模型');
  assert.equal(ui.readSettingsSlotValue('review'), 'claude-opus-4-6-thinking');
  assert.equal(ui.isSettingsDraftDirty(), false);

  // Changing review tier to bare Claude Opus 4.6 marks draft dirty & submits reviewModel in payload
  getEl('set-review-tier').value = 'claude-opus-4-6';
  assert.equal(ui.readSettingsSlotValue('review'), 'claude-opus-4-6');
  assert.equal(ui.isSettingsDraftDirty(), true);

  await ui.submitSettingsSave(false);
  assert.equal(postedPayloads.length, 1);
  assert.equal(postedPayloads[0].payload.reviewModel, 'claude-opus-4-6');
  assert.equal(postedPayloads[0].payload.worktreeModel, 'gemini-4-neon-low');
  assert.equal(postedPayloads[0].payload.readOnlyModel, 'inherit');

  // 2. Project scope defaults review slot to Follow Global Default ("") and enables Reset only when overridden
  ui.setSettingsScope('project');
  ui.setLoadedSettingsData({
    scopeKey: '/demo/repo',
    coordinatorModel: 'gemini-4-neon-xhigh',
    coordinatorModelDisplayName: 'Gemini 4 Neon (XHigh)',
    settings: {
      defaults: {
        worktreeModel: 'gemini-4-neon-low',
        readOnlyModel: 'inherit',
        reviewModel: 'claude-opus-4-6-thinking',
      },
      projects: {},
    },
    effective: {
      scopeKey: '/demo/repo',
      hasProjectOverride: false,
      coordinatorId: 'conv-coord-ui',
      coordinatorModel: 'gemini-4-neon-xhigh',
      coordinatorModelDisplayName: 'Gemini 4 Neon (XHigh)',
      worktreeModel: 'gemini-4-neon-low',
      worktreeModelLabel: 'Gemini 4 Neon (Low)',
      readOnlyModel: 'inherit',
      readOnlyModelLabel: 'Follow Coordinator (Gemini 4 Neon (XHigh))',
      reviewModel: 'claude-opus-4-6-thinking',
      reviewModelLabel: 'Claude Opus 4.6 (Thinking)',
      global: {
        worktreeModel: 'gemini-4-neon-low',
        worktreeModelLabel: 'Gemini 4 Neon (Low)',
        readOnlyModel: 'inherit',
        readOnlyModelLabel: 'Follow Coordinator (Gemini 4 Neon (XHigh))',
        reviewModel: 'claude-opus-4-6-thinking',
        reviewModelLabel: 'Claude Opus 4.6 (Thinking)',
      },
      project: { worktreeModel: '', readOnlyModel: '', reviewModel: '' },
    },
  });
  ui.renderSettingsScreen(true);
  assert.equal(ui.readSettingsSlotValue('review'), '');
  assert.match(getEl('set-review-model').options[0].text, /Claude Opus 4\.6 \(Thinking\)/);
  assert.equal(getEl('btn-settings-reset').disabled, true);

  // 3. "+ New Thread" drawer mode switching updates model default option, branch field visibility, and hint text live
  ui.setDispatchThreadMode('worktree');
  assert.equal(ui.getDispatchThreadMode(), 'worktree');
  assert.equal(getEl('f-branch-field').hidden, false);
  assert.match(getEl('f-model').options[0].text, /Gemini 4 Neon \(Low\)/);
  assert.match(getEl('lbl-f-mode-hint').textContent, /Gemini 4 Neon \(Low\)/);

  ui.setDispatchThreadMode('review');
  assert.equal(ui.getDispatchThreadMode(), 'review');
  assert.equal(getEl('btn-mode-review').classList.contains('active'), true);
  assert.equal(getEl('btn-mode-review').getAttribute('aria-selected'), 'true');
  assert.equal(getEl('f-branch-field').hidden, true);
  assert.match(getEl('f-model').options[0].text, /Claude Opus 4\.6 \(Thinking\)/);
  assert.match(getEl('lbl-f-mode-hint').textContent, /Review 默认模型：Claude Opus 4\.6 \(Thinking\)/);

  ui.setDispatchThreadMode('readonly');
  assert.equal(ui.getDispatchThreadMode(), 'readonly');
  assert.equal(getEl('f-branch-field').hidden, true);
  assert.match(getEl('f-model').options[0].text, /Gemini 4 Neon \(XHigh\)/);

  // Non-Git project disables Worktree button while still allowing Review mode
  ui.setHasGit(false);
  ui.setDispatchThreadMode('worktree');
  assert.equal(ui.getDispatchThreadMode(), 'readonly');
  assert.equal(getEl('btn-mode-worktree').disabled, true);
  ui.setDispatchThreadMode('review');
  assert.equal(ui.getDispatchThreadMode(), 'review');
  assert.match(getEl('lbl-f-mode-hint').textContent, /Claude Opus 4\.6 \(Thinking\)/);
});

test('Issue #7: MCP schema, protocol docs, Sidecar capabilities/revision, 3-locale I18N (zero middle dots), and LF endings', () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const mainMjs = readFileSync(new URL('../sidecars/threads/main.mjs', import.meta.url), 'utf8');
  const indexHtml = readFileSync(new URL('../sidecars/threads/index.html', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const themeCss = readFileSync(new URL('../sidecars/threads/theme.css', import.meta.url), 'utf8');
  const skillMd = readFileSync(new URL('../skills/coord/SKILL.md', import.meta.url), 'utf8');
  const rulesMd = readFileSync(new URL('../rules/AGENTS.md', import.meta.url), 'utf8');
  const hookMjs = readFileSync(new URL('../scripts/hook-handler.mjs', import.meta.url), 'utf8');

  // 1. Revision & capability alignment
  assert.match(mainMjs, /const\s+SERVER_API_REVISION\s*=\s*6\s*;/);
  assert.match(mainMjs, /['"]review_model['"]/);
  assert.match(mainMjs, /['"]decision_custom_reply['"]/);
  assert.match(mainMjs, /['"]topic_memory['"]/);
  assert.match(mainMjs, /threadType:\s*data\.threadType\s*\|\|\s*''/);
  assert.match(appJs, /const\s+EXPECTED_SERVER_API_REVISION\s*=\s*6\s*;/);
  assert.match(hookMjs, /const\s+DIRECTIVE_VERSION\s*=\s*17\s*;/);
  assert.match(hookMjs, /threadType:\s*"review"/);
  assert.match(skillMd, /threadType:\s*"review"/);
  assert.match(rulesMd, /threadType:\s*"review"/);

  // 2. HTML & CSS hooks
  for (const id of [
    'set-review-model',
    'set-review-tier',
    'lbl-set-review',
    'desc-set-review',
    'f-mode-seg',
    'btn-mode-worktree',
    'btn-mode-readonly',
    'btn-mode-review',
    'lbl-f-mode-hint',
    'f-branch-field',
  ]) {
    assert.match(indexHtml, new RegExp(`id="${id}"`), `index.html must contain #${id}`);
  }
  assert.match(themeCss, /\.dispatch-mode-seg/);
  assert.match(themeCss, /\.dispatch-mode-hint/);
  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appJs), false);

  // 3. MCP tools/list exposes dispatch_thread.threadType enum
  const rpcRes = spawnSync(process.execPath, ['mcp/server.mjs'], {
    cwd: repoRoot,
    input:
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n` +
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
    encoding: 'utf8',
  });
  assert.equal(rpcRes.status, 0);
  const msgs = rpcRes.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
  const dispatchTool = msgs.find((m) => m.id === 2)?.result?.tools?.find((x) => x.name === 'dispatch_thread');
  assert.ok(dispatchTool);
  assert.deepEqual(dispatchTool.inputSchema.properties.threadType.enum, ['worktree', 'readonly', 'review']);
  assert.match(dispatchTool.inputSchema.properties.threadType.description, /review/i);

  // 4. 3-locale I18N completeness and zero middle dots in all new Issue #7 strings
  const { ui } = loadSettingsAndDispatchUiHarness({ locale: 'en' });
  const strKeys = [
    'roleReview',
    'settingsReviewLabel',
    'settingsReviewDesc',
    'fMode',
    'fModeWorktree',
    'fModeReadOnly',
    'fModeReview',
    'fModeHintNoGit',
  ];
  const fnKeys = [
    ['fModeHintWorktree', ['Gemini 4 Neon (Low)']],
    ['fModeHintReadOnly', ['Gemini 3.8 Flash (Medium)']],
    ['fModeHintReview', ['Claude Opus 4.6 (Thinking)']],
  ];
  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    for (const k of strKeys) {
      const val = ui.I18N[loc][k];
      assert.equal(typeof val, 'string', `Missing I18N.${loc}.${k}`);
      assert.ok(val.length > 0);
      assert.equal(val.includes('·'), false, `I18N.${loc}.${k} must not contain middle dot`);
    }
    for (const [k, args] of fnKeys) {
      const fn = ui.I18N[loc][k];
      assert.equal(typeof fn, 'function', `Missing I18N.${loc}.${k}`);
      const rendered = String(fn(...args));
      assert.ok(rendered.length > 0);
      assert.equal(rendered.includes('·'), false, `I18N.${loc}.${k} output must not contain middle dot`);
    }
  }

  // 5. Strict LF line endings on all modified/added .mjs files
  for (const rel of [
    '../lib/store.mjs',
    '../mcp/server.mjs',
    '../scripts/hook-handler.mjs',
    '../sidecars/threads/main.mjs',
    '../tests/review-model.test.mjs',
    '../tests/settings-default-model.test.mjs',
    '../tests/worker-language.test.mjs',
    '../tests/decisions-board.test.mjs',
    '../tests/project-scope-seq.test.mjs',
    '../tests/coordinator-rebind.test.mjs',
  ]) {
    const raw = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!raw.includes(Buffer.from('\r')), `${rel} must use LF line endings`);
  }
});

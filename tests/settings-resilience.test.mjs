import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  connectPost,
  resetModelConfigCache,
} from '../lib/ls-client.mjs';
import {
  buildModelFamilyGroups,
  isSameModelFamily,
  resolveModelFamilySelection,
} from '../lib/model-format.mjs';
import {
  buildFallbackEffectiveSettings,
  canonicalizeModelForSettings,
  loadRegistry,
  loadSettings,
  normalizeKey,
  resolveInheritedCoordinatorModel,
  saveRegistry,
  saveSettingsWithFastResponse,
  syncThreads,
} from '../lib/store.mjs';
import { extractModelFromSteps } from '../lib/transcript.mjs';

function createTempEnv(t, prefix = 'pt-resil-') {
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

function extractI18nObject(appJs) {
  const start = appJs.indexOf('const I18N = {');
  assert.notEqual(start, -1, 'I18N object must exist in app.js');
  let depth = 0;
  let inBrace = false;
  let end = -1;
  for (let i = start; i < appJs.length; i++) {
    const ch = appJs[i];
    if (ch === '{') {
      depth++;
      inBrace = true;
    } else if (ch === '}') {
      depth--;
      if (inBrace && depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.notEqual(end, -1, 'Closing brace of I18N must be found');
  const ctx = {};
  vm.runInNewContext(`${appJs.slice(start, end)}; this.I18N = I18N;`, ctx);
  return ctx.I18N;
}

function makeMockElement(id = '') {
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
    href: '',
    className: '',
    options: [],
    classList: {
      add: (...names) => names.forEach((n) => cls.add(n)),
      remove: (...names) => names.forEach((n) => cls.delete(n)),
      toggle: (name, force) => {
        if (force === undefined) {
          if (cls.has(name)) cls.delete(name);
          else cls.add(name);
        } else if (force) {
          cls.add(name);
        } else {
          cls.delete(name);
        }
      },
      contains: (name) => cls.has(name),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => attrs.get(k) ?? null,
    addEventListener: () => {},
  };
}

function loadUiApiAndUpdateHarness({ fetchImpl, locale = 'en' } = {}) {
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const i18nStart = appJs.indexOf('const I18N = {');
  const i18nEnd = appJs.indexOf('let curLocale =', i18nStart);
  const apiStart = appJs.indexOf('function createApiError(');
  const apiEnd = appJs.indexOf('// ---------- Rich Markdown', apiStart);
  const updStart = appJs.indexOf('// ---------- Plugin Version & Update Checker ----------');
  const updEnd = appJs.indexOf('function openPluginUpdateModal(', updStart);
  const saveStart = appJs.indexOf('async function submitSettingsSave(');
  const saveEnd = appJs.indexOf('async function loadSelectableModels(', saveStart);

  assert.notEqual(i18nStart, -1);
  assert.notEqual(i18nEnd, -1);
  assert.notEqual(apiStart, -1);
  assert.notEqual(apiEnd, -1);
  assert.notEqual(updStart, -1);
  assert.notEqual(updEnd, -1);
  assert.notEqual(saveStart, -1);
  assert.notEqual(saveEnd, -1);

  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeMockElement(id));
    return elements.get(id);
  };
  const flashToastCalls = [];

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
    Math,
    JSON,
    doFetch: fetchImpl,
    document: {
      getElementById: getEl,
    },
    flashToast: (...args) => flashToastCalls.push(args),
    applyLocale: () => {},
    esc: (s) => String(s ?? ''),
    relTimeAgo: () => 'just now',
    syncHostConversationScope: async () => false,
    buildScopePayload: (extra = {}) => ({ workspace: '/demo/repo', ...extra }),
    populateDispatchModelSelect: () => {},
    renderSettingsScreen: () => {},
    syncSettingsActionState: () => {},
    readSettingsSlotValue: () => 'inherit',
  };

  vm.runInNewContext(
    `
    const EXPECTED_SERVER_API_REVISION = 2;
    const REQUIRED_UPDATE_CAPABILITIES = ['update_status', 'update_check', 'update_apply'];
    const API_READ_TIMEOUT_MS = 10000;
    const API_WRITE_TIMEOUT_MS = 12000;
    const API_UPDATE_TIMEOUT_MS = 30000;
    ${appJs.slice(i18nStart, i18nEnd)}
    let curLocale = ${JSON.stringify(locale)};
    const L = () => I18N[curLocale] || I18N.en;

    let settingsScreenOpen = true;
    let settingsScope = 'global';
    let loadedSettingsData = null;
    let activeScopeKey = '/demo/repo';
    let settingsSaving = false;
    let settingsDirtyByUser = false;
    let pluginUpdateState = null;
    let pluginUpdateChecking = false;
    let pluginUpdateApplying = false;
    let pluginUpdateAppliedVersion = '';
    let pluginUpdatePollTimer = null;
    let backendVersionMismatch = null;
    let updateCardError = '';
    let updateStatusTimer = null;
    let updateStatusNotice = { text: '', tone: 'ok' };

    const elBtnSettings = document.getElementById('btn-settings');
    const elSettingsUpdateDot = document.getElementById('settings-update-dot');
    const elBtnSettingsSave = document.getElementById('btn-settings-save');
    const elBtnSettingsReset = document.getElementById('btn-settings-reset');
    const elSettingsToast = document.getElementById('settings-toast');
    const elSettingsErr = document.getElementById('settings-err');
    const elUpdateCard = document.getElementById('settings-update-card');
    const elUpdateBadge = document.getElementById('update-status-badge');
    const elBtnChannelStable = document.getElementById('btn-channel-stable');
    const elBtnChannelDev = document.getElementById('btn-channel-dev');
    const elBtnUpdateCheck = document.getElementById('btn-update-check');
    const elBtnUpdateApply = document.getElementById('btn-update-apply');
    const elBtnUpdateRelease = document.getElementById('btn-update-release');
    const elUpdateDirtyWarn = document.getElementById('update-dirty-warn');
    const elUpdateNonGitHint = document.getElementById('update-nongit-hint');
    const elUpdateReloadBanner = document.getElementById('update-reload-banner');
    const elUpdateErr = document.getElementById('update-err');
    const elUpdateStatusMsg = document.getElementById('update-status-msg');

    ${appJs.slice(apiStart, apiEnd)}
    ${appJs.slice(saveStart, saveEnd)}
    ${appJs.slice(updStart, updEnd)}

    this.api = {
      safeReadJson,
      fetchWithTimeout,
      postApi,
      inspectServerInfo,
      loadPluginUpdateStatus,
      runManualUpdateCheck,
      renderUpdateCard,
      submitSettingsSave,
      setFetch(fn) { doFetch = fn; },
      setTimeoutOverrides(ms) {
        this._origFetchWithTimeout = fetchWithTimeout;
        fetchWithTimeout = (url, opts) => this._origFetchWithTimeout(url, opts, ms);
      },
      getState() {
        return {
          settingsSaving,
          pluginUpdateState,
          backendVersionMismatch,
          updateCardError,
          updateStatusNotice,
        };
      },
    };
    `,
    ctx,
  );

  return { api: ctx.api, getEl, flashToastCalls };
}

test('Issue #1: safeReadJson and postApi turn 404 plain-text "Not found" into semantic reload error without SyntaxError', async () => {
  const requests = [];
  const { api } = loadUiApiAndUpdateHarness({
    fetchImpl: async (url, opts = {}) => {
      requests.push({ url: String(url), method: opts.method || 'GET' });
      return {
        ok: false,
        status: 404,
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/plain; charset=utf-8' : null) },
        text: async () => 'Not found',
      };
    },
  });

  await assert.rejects(
    () =>
      api.safeReadJson(
        {
          ok: false,
          status: 404,
          headers: { get: () => 'text/plain' },
          text: async () => 'Not found',
        },
        { url: '/api/update_status' },
      ),
    (err) => {
      assert.equal(err.code, 'sidecar_route_not_found');
      assert.equal(err.isBackendMismatch, true);
      assert.doesNotMatch(err.message, /Unexpected token/i);
      assert.match(err.message, /reload|outdated/i);
      return true;
    },
  );

  // postApi falls back POST 404 -> GET 404 and still throws clean semantic mismatch error
  await assert.rejects(
    () => api.postApi('/api/update_check', '/api/update_check_get', { force: true }),
    (err) => {
      assert.equal(err.code, 'sidecar_route_not_found');
      assert.equal(err.isBackendMismatch, true);
      assert.doesNotMatch(err.message, /Unexpected token/i);
      return true;
    },
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[1].method, 'GET');

  // HTTP 500 JSON error does NOT trigger duplicate GET fallback and preserves server error message
  requests.length = 0;
  api.setFetch(async (url, opts = {}) => {
    requests.push({ url: String(url), method: opts.method || 'GET' });
    return {
      ok: false,
      status: 500,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ error: 'Disk quota exceeded' }),
    };
  });
  await assert.rejects(
    () => api.postApi('/api/settings_save', '/api/settings_save_get', { scope: 'global' }),
    (err) => {
      assert.equal(err.message, 'Disk quota exceeded');
      return true;
    },
  );
  assert.equal(requests.length, 1, 'HTTP 500 must not trigger duplicate GET fallback');
});

test('Issue #1: Version & Updates card surfaces backend mismatch cleanly, avoids misleading Stable active state, and isolates errors from #settings-toast', async () => {
  const { api, getEl, flashToastCalls } = loadUiApiAndUpdateHarness({
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      headers: { get: () => 'text/plain; charset=utf-8' },
      text: async () => 'Not found',
    }),
  });

  // 1. Old sidecar missing /api/update_status must mark mismatch, NOT silently highlight Stable
  await api.loadPluginUpdateStatus({ bg: true });
  assert.equal(api.getState().backendVersionMismatch?.kind, 'stale_backend');
  assert.equal(getEl('btn-channel-stable').classList.contains('active'), false);
  assert.equal(getEl('btn-channel-dev').classList.contains('active'), false);
  assert.equal(getEl('btn-channel-stable').disabled, true);
  assert.equal(getEl('btn-channel-dev').disabled, true);
  assert.equal(getEl('update-reload-banner').hidden, false);
  assert.equal(getEl('update-reload-banner').classList.contains('warn'), true);
  assert.match(getEl('update-reload-banner').textContent, /reload|toggle/i);
  assert.equal(getEl('update-status-badge').textContent, 'Reload required');
  assert.equal(flashToastCalls.length, 0);

  // 2. Manual check hitting 404 or server failure stays inside update card and NEVER calls flashToast
  await api.runManualUpdateCheck();
  assert.equal(flashToastCalls.length, 0, 'Update check error must not pollute #settings-toast via flashToast');

  api.setFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () =>
      JSON.stringify({
        ok: false,
        error: 'Network unreachable',
        channel: 'dev',
        currentVersion: '1.1.0',
        isGitInstall: true,
        serverInfo: {
          startedVersion: '1.1.0',
          diskVersion: '1.1.0',
          apiRevision: 2,
          capabilities: ['update_status', 'update_check', 'update_apply'],
          versionDrifted: false,
        },
      }),
  }));
  await api.runManualUpdateCheck('dev');
  assert.equal(flashToastCalls.length, 0, 'Update check error must remain isolated to #update-err');
  assert.equal(getEl('update-err').hidden, false);
  assert.equal(getEl('update-err').textContent, 'Network unreachable');
  assert.equal(getEl('btn-channel-dev').classList.contains('active'), true);

  // 3. inspectServerInfo detects stale backend lacking serverInfo on /api/state and versionDrifted
  api.inspectServerInfo({ threads: [], scopeKey: '/demo' }, { fromState: true });
  assert.equal(api.getState().backendVersionMismatch?.kind, 'stale_backend');

  api.inspectServerInfo(
    {
      threads: [],
      serverInfo: {
        startedVersion: '1.1.0',
        diskVersion: '1.2.0',
        apiRevision: 2,
        capabilities: ['update_status', 'update_check', 'update_apply'],
        versionDrifted: true,
      },
    },
    { fromState: true },
  );
  assert.equal(api.getState().backendVersionMismatch?.kind, 'version_drifted');
  assert.match(getEl('update-reload-banner').textContent, /v1\.1\.0.*v1\.2\.0/);
});

test('Issue #2: connectPost enforces total hard timeout on slow trickle responses and rejects on premature socket drop', async (t) => {
  createTempEnv(t, 'pt-conn-');
  const openSockets = new Set();
  const server = http.createServer((req, res) => {
    openSockets.add(req.socket);
    req.socket.on('close', () => openSockets.delete(req.socket));
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      if (req.url === '/svc/Trickle') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{');
        const iv = setInterval(() => {
          if (res.destroyed || req.socket.destroyed) {
            clearInterval(iv);
            return;
          }
          res.write(' ');
        }, 30);
        req.socket.on('close', () => clearInterval(iv));
        return;
      }
      if (req.url === '/svc/DropMidBody') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '500' });
        res.write('{"partial":');
        setTimeout(() => req.socket.destroy(), 35);
        return;
      }
      if (req.url === '/svc/DropBeforeHeaders') {
        setTimeout(() => req.socket.destroy(), 25);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${port}`;
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-conn-test';
  t.after(async () => {
    for (const sock of openSockets) sock.destroy();
    await new Promise((r) => server.close(r));
  });

  // 1. Slow trickle bypasses socket inactivity timeout, but total hard timeout still rejects promptly
  const t0 = Date.now();
  await assert.rejects(() => connectPost('svc', 'Trickle', {}, 180), /timed out/i);
  const trickleElapsed = Date.now() - t0;
  assert.ok(trickleElapsed < 1200, `Expected hard timeout < 1200ms, got ${trickleElapsed}ms`);

  // 2. Mid-body TCP reset rejects immediately instead of hanging forever
  const t1 = Date.now();
  await assert.rejects(() => connectPost('svc', 'DropMidBody', {}, 5000), /closed|aborted|reset|socket/i);
  assert.ok(Date.now() - t1 < 1500);

  // 3. Drop before response headers rejects immediately
  const t2 = Date.now();
  await assert.rejects(() => connectPost('svc', 'DropBeforeHeaders', {}, 5000), /closed|hang up|reset|socket/i);
  assert.ok(Date.now() - t2 < 1500);

  // 4. Healthy endpoint still resolves normally
  const okRes = await connectPost('svc', 'Healthy', {}, 2000);
  assert.deepEqual(okRes, { ok: true });
});

test('Issue #2: saveSettingsWithFastResponse persists immediately without blocking on hung LS RPCs and falls back cleanly', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-fast-save-');
  const openSockets = new Set();
  const receivedUrls = [];
  // Intentionally hung LS server that never responds
  const hungLs = http.createServer((req) => {
    receivedUrls.push(req.url);
    openSockets.add(req.socket);
    req.socket.on('close', () => openSockets.delete(req.socket));
  });
  await new Promise((r) => hungLs.listen(0, '127.0.0.1', r));
  process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${hungLs.address().port}`;
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-hung';
  t.after(async () => {
    for (const sock of openSockets) sock.destroy();
    await new Promise((r) => hungLs.close(r));
  });

  const repoRoot = join(tempRoot, 'demo-proj');
  mkdirSync(repoRoot, { recursive: true });
  const wk = normalizeKey(repoRoot);
  const reg = loadRegistry();
  reg.coordinators[wk] = {
    key: wk,
    conversationId: 'conv-coord-hung',
    workspacePath: repoRoot,
    repoRoot,
    title: '[Coordinator] DemoProj',
  };
  saveRegistry(reg);

  // Global save must complete fast without invoking hung GetConversation / catalog RPCs
  const startMs = Date.now();
  const resGlobal = await saveSettingsWithFastResponse({
    scope: 'global',
    workspacePath: repoRoot,
    conversationId: 'conv-coord-hung',
    worktreeModel: 'gemini-4-neon-xhigh',
    readOnlyModel: 'inherit',
  });
  const elapsedMs = Date.now() - startMs;
  assert.equal(resGlobal.ok, true);
  assert.ok(elapsedMs < 1500, `Global save should not block on hung LS (took ${elapsedMs}ms)`);
  assert.equal(receivedUrls.length, 0, 'Global save fast path must not invoke blocking LS RPCs');
  assert.equal(loadSettings().defaults.worktreeModel, 'gemini-4-neon-xhigh');
  assert.equal(loadSettings().defaults.readOnlyModel, 'inherit');

  // Project save with explicit workspaceKey persists and returns immediately
  const projStart = Date.now();
  const resProj = await saveSettingsWithFastResponse({
    scope: 'project',
    workspaceKey: wk,
    workspacePath: repoRoot,
    worktreeModel: 'gemini-4-neon-low',
    readOnlyModel: '',
  });
  assert.equal(resProj.ok, true);
  assert.ok(Date.now() - projStart < 1500);
  assert.equal(loadSettings().projects[wk].worktreeModel, 'gemini-4-neon-low');

  // Fallback effective builder returns complete normalized settings shape synchronously
  const fallback = buildFallbackEffectiveSettings(loadSettings(), { scopeKey: wk, workspacePath: repoRoot });
  assert.equal(fallback.scopeKey, wk);
  assert.equal(fallback.worktreeModel, 'gemini-4-neon-low');
  assert.equal(fallback.readOnlyModel, 'inherit');
});

test('Issue #2: frontend submitSettingsSave aborts hung request via AbortController, never triggers duplicate GET, and restores Save button', async () => {
  let aborted = false;
  const calls = [];
  const { api, getEl } = loadUiApiAndUpdateHarness({
    fetchImpl: (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || 'GET' });
      return new Promise((_, reject) => {
        if (opts.signal) {
          opts.signal.addEventListener('abort', () => {
            aborted = true;
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    },
  });
  api.setTimeoutOverrides(120);

  await api.submitSettingsSave(false);
  assert.equal(aborted, true, 'Hung settings_save request must be aborted on timeout');
  assert.equal(calls.length, 1, 'Timed-out POST must NOT trigger duplicate GET fallback');
  assert.equal(api.getState().settingsSaving, false, 'finally must clear settingsSaving');
  assert.equal(getEl('btn-settings-save').disabled, false, 'Save button must recover from disabled state');
  assert.equal(getEl('btn-settings-save').textContent, 'Save', 'Save button must recover from Saving…');
  assert.equal(getEl('settings-err').hidden, false);
  assert.match(getEl('settings-err').textContent, /timed out/i);
});

test('Issue #3: Extra High <-> xhigh normalization works identically in lib, UI, transcript extraction, and inherit resolution', async (t) => {
  // 1. Direct family comparison (lib + UI mirror)
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const start = appJs.indexOf('function formatModelDisplay(');
  const end = appJs.indexOf('function normalizeActivityText(', start);
  const uiCtx = {};
  vm.runInNewContext(
    `${appJs.slice(start, end)}
     this.isSameModelFamily = isSameModelFamily;
     this.buildModelFamilyGroups = buildModelFamilyGroups;
     this.resolveModelFamilySelection = resolveModelFamilySelection;`,
    uiCtx,
  );

  const positivePairs = [
    ['Gemini 4 Neon (Extra High)', 'gemini-4-neon-xhigh'],
    ['Gemini 4 Neon Extra High', 'gemini-4-neon-tiered-xhigh'],
    ['Gemini 4 Neon (Extra High)', 'Gemini 4 Neon (XHigh)'],
    ['Gemini 4 Hydrogen (X-High)', 'gemini-4-hydrogen-xhigh'],
    ['Gemini 4 Neon (XHigh)', 'gemini-4-neon-xhigh'],
  ];
  for (const [a, b] of positivePairs) {
    assert.equal(isSameModelFamily(a, b), true, `lib isSameModelFamily(${a}, ${b})`);
    assert.equal(uiCtx.isSameModelFamily(a, b), true, `UI isSameModelFamily(${a}, ${b})`);
  }
  assert.equal(isSameModelFamily('Gemini 4 Neon (High)', 'gemini-4-neon-xhigh'), false);
  assert.equal(uiCtx.isSameModelFamily('Gemini 4 Neon (High)', 'gemini-4-neon-xhigh'), false);

  // 2. resolveModelFamilySelection matches Extra High label to XHigh catalog entry without fallback
  const catalog = [
    {
      id: 'gemini-4-neon-medium',
      modelId: 'gemini-4-neon-medium',
      modelEnum: 'MODEL_PLACEHOLDER_M533',
      label: 'Gemini 4 Neon (Medium)',
    },
    {
      id: 'gemini-4-neon-xhigh',
      modelId: 'gemini-4-neon-xhigh',
      modelEnum: 'MODEL_PLACEHOLDER_M531',
      label: 'Gemini 4 Neon (XHigh)',
      thinkingLevel: 'Extra High',
    },
  ];
  const groups = buildModelFamilyGroups(catalog, { includeInherit: true });
  const selLib = resolveModelFamilySelection('Gemini 4 Neon (Extra High)', groups);
  const selUi = uiCtx.resolveModelFamilySelection('Gemini 4 Neon (Extra High)', groups);
  assert.equal(selLib.value, 'gemini-4-neon-xhigh');
  assert.equal(selLib.isFallback, false);
  assert.equal(selUi.value, 'gemini-4-neon-xhigh');
  assert.equal(selUi.isFallback, false);

  // canonicalizeModelForSettings maps Extra High label to canonical slug
  assert.deepEqual(canonicalizeModelForSettings('Gemini 4 Neon Extra High', catalog), {
    value: 'gemini-4-neon-xhigh',
    label: 'Gemini 4 Neon (XHigh)',
  });

  // 3. extractModelFromSteps retains Extra High display name when planner slug is -xhigh
  const extracted = extractModelFromSteps([
    {
      type: 'USER_INPUT',
      content:
        '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 4 Neon (Medium) to Gemini 4 Neon (Extra High). No need to comment.\n</USER_SETTINGS_CHANGE>\n<USER_REQUEST>Run check</USER_REQUEST>',
    },
    { type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-tiered-xhigh', content: 'Done' },
  ]);
  assert.deepEqual(extracted, {
    displayName: 'Gemini 4 Neon (Extra High)',
    modelSlug: 'gemini-4-neon-tiered-xhigh',
  });

  // 4. resolveInheritedCoordinatorModel resolves Extra High transcript entry to concrete xhigh slug (not 'pro')
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-xhigh-inh-');
  const repoRoot = join(tempRoot, 'xhigh-repo');
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
  const wk = normalizeKey(repoRoot);
  const coordConvId = 'conv-coord-xhigh-001';
  const reg = loadRegistry();
  reg.coordinators[wk] = {
    key: wk,
    conversationId: coordConvId,
    workspacePath: repoRoot,
    repoRoot,
    title: '[Coordinator] XHigh',
  };
  saveRegistry(reg);

  const txDir = join(appDataDir, 'brain', coordConvId, '.system_generated', 'logs');
  mkdirSync(txDir, { recursive: true });
  const txPath = join(txDir, 'transcript.jsonl');
  writeFileSync(
    txPath,
    [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        content:
          '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 4 Neon (Medium) to Gemini 4 Neon (Extra High).\n</USER_SETTINGS_CHANGE>\n<USER_REQUEST>Hello</USER_REQUEST>',
      }),
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-xhigh', content: 'Hi' }),
    ].join('\n'),
    'utf8',
  );

  const inherited = await resolveInheritedCoordinatorModel({
    workspacePath: repoRoot,
    coordinatorId: coordConvId,
    catalogModels: catalog,
  });
  assert.equal(inherited.model, 'gemini-4-neon-xhigh');
  assert.equal(inherited.displayName, 'Gemini 4 Neon (XHigh)');

  // 5. syncThreads emits coordinatorTurnStamp that updates when coordinator transcript grows
  const snap1 = await syncThreads({ workspacePath: repoRoot });
  assert.ok(snap1.coordinatorTurnStamp.startsWith(`${coordConvId}|`));
  writeFileSync(
    txPath,
    `${readFileSync(txPath, 'utf8')}\n${JSON.stringify({ step_index: 2, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-xhigh', content: 'Turn 2' })}\n`,
    'utf8',
  );
  const snap2 = await syncThreads({ workspacePath: repoRoot });
  assert.notEqual(snap2.coordinatorTurnStamp, snap1.coordinatorTurnStamp);
});

test('Issue #1/#2/#3 static & I18N checks: serverInfo, refresh linkage, draft note, zero middle dots, zero native dialogs, and LF line endings', () => {
  const mainMjs = readFileSync(new URL('../sidecars/threads/main.mjs', import.meta.url), 'utf8');
  const indexHtml = readFileSync(new URL('../sidecars/threads/index.html', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const themeCss = readFileSync(new URL('../sidecars/threads/theme.css', import.meta.url), 'utf8');

  // Sidecar backend exposes startup version/capabilities and static headers
  assert.match(mainMjs, /X-PT-Server-Version/);
  assert.match(mainMjs, /X-PT-Api-Revision/);
  assert.match(mainMjs, /SERVER_CAPABILITIES/);
  assert.match(mainMjs, /serverInfo:\s*buildServerInfo\(\)/);
  assert.match(mainMjs, /saveSettingsWithFastResponse/);

  // Settings UI wires refresh button to both model catalog and /api/settings?refresh=1 + draft hint + isolated update status
  assert.match(indexHtml, /id="settings-inherit-note"/);
  assert.match(indexHtml, /id="update-status-msg"/);
  assert.match(themeCss, /\.settings-inherit-note/);
  assert.match(themeCss, /\.update-reload-banner\.warn/);
  assert.match(appJs, /elBtnSettingsRefreshModels\.addEventListener\('click'[\s\S]*?loadSelectableModels\(true\)[\s\S]*?loadSettingsData\(/);
  assert.match(appJs, /coordinatorTurnStamp/);
  assert.match(appJs, /syncSettingsInheritHint/);
  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appJs), false);

  // All new I18N keys present in en / zh-CN / zh-TW with zero middle dots
  const I18N = extractI18nObject(appJs);
  const strKeys = [
    'apiInvalidJsonErr',
    'sidecarMismatchErr',
    'updateBadgeReloadRequired',
    'updateChannelMismatchHint',
    'settingsInheritDraftOption',
    'settingsInheritDraftNote',
    'settingsRefreshModelsTip',
  ];
  const fnKeys = [
    ['apiTimeoutErr', [12]],
    ['apiHttpErr', [502]],
    ['updateBackendMismatchBanner', ['1.1.0', '1.2.0']],
    ['settingsInheritActiveNote', ['Gemini 4 Neon (XHigh)']],
  ];
  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    for (const k of strKeys) {
      const val = I18N[loc][k];
      assert.equal(typeof val, 'string', `Missing I18N.${loc}.${k}`);
      assert.ok(val.length > 0);
      assert.equal(val.includes('·'), false, `I18N.${loc}.${k} must not contain middle dot`);
    }
    for (const [k, args] of fnKeys) {
      const fn = I18N[loc][k];
      assert.equal(typeof fn, 'function', `Missing I18N.${loc}.${k}`);
      const out = String(fn(...args));
      assert.ok(out.length > 0);
      assert.equal(out.includes('·'), false, `Rendered I18N.${loc}.${k} must not contain middle dot`);
    }
  }

  // LF line endings on all modified/added .mjs files
  for (const rel of [
    '../lib/ls-client.mjs',
    '../lib/model-format.mjs',
    '../lib/store.mjs',
    '../sidecars/threads/main.mjs',
    '../tests/settings-resilience.test.mjs',
  ]) {
    const raw = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!raw.includes(Buffer.from('\r')), `${rel} must use LF line endings`);
  }
});

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
  isSameModelVariant,
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

function loadUiApiAndUpdateHarness({ fetchImpl, locale = 'en', nativeFetch = null } = {}) {
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const constStart = appJs.indexOf('const EXPECTED_SERVER_API_REVISION');
  const constEnd = appJs.indexOf('const params =', constStart);
  const i18nStart = appJs.indexOf('const I18N = {');
  const i18nEnd = appJs.indexOf('let curLocale =', i18nStart);
  const apiStart = appJs.indexOf('function createApiError(');
  const apiEnd = appJs.indexOf('// ---------- Rich Markdown', apiStart);
  const updStart = appJs.indexOf('// ---------- Plugin Version & Update Checker ----------');
  const updEnd = appJs.indexOf('function openPluginUpdateModal(', updStart);
  const saveStart = appJs.indexOf('async function submitSettingsSave(');
  const saveEnd = appJs.indexOf('async function loadSelectableModels(', saveStart);

  assert.notEqual(constStart, -1);
  assert.notEqual(constEnd, -1);
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
  const loadSettingsCalls = [];

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
    Math,
    JSON,
    fetch: nativeFetch || (() => { throw new Error('unexpected global fetch'); }),
    doFetch: fetchImpl,
    document: {
      getElementById: getEl,
      activeElement: null,
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
    loadSettingsData: (opts) => {
      loadSettingsCalls.push(opts);
      return Promise.resolve(true);
    },
  };

  vm.runInNewContext(
    `
    ${appJs.slice(constStart, constEnd)}
    ${appJs.slice(i18nStart, i18nEnd)}
    let curLocale = ${JSON.stringify(locale)};
    const L = () => I18N[curLocale] || I18N.en;

    let settingsScreenOpen = true;
    let settingsScope = 'global';
    let loadedSettingsData = null;
    let activeScopeKey = '/demo/repo';
    let settingsSaving = false;
    let settingsDirtyByUser = false;
    let sidecarFetchSupportsSignal = null;
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
      EXPECTED_SERVER_API_REVISION,
      REQUIRED_UPDATE_CAPABILITIES,
      safeReadJson,
      invokeFetch,
      fetchWithTimeout,
      fetchJsonWithTimeout,
      postApi,
      inspectServerInfo,
      loadPluginUpdateStatus,
      runManualUpdateCheck,
      renderUpdateCard,
      submitSettingsSave,
      setFetch(fn) { doFetch = fn; sidecarFetchSupportsSignal = null; },
      setLoadedSettingsData(val) { loadedSettingsData = val; },
      setSettingsScope(val) { settingsScope = val; },
      overrideJsonTimeout(ms) {
        const orig = fetchJsonWithTimeout;
        fetchJsonWithTimeout = (url, opts, cfg = {}) =>
          orig(url, opts, {
            ...cfg,
            timeoutMs: cfg.timeoutMs > 0 ? Math.min(cfg.timeoutMs, ms) : cfg.timeoutMs,
          });
      },
      getState() {
        return {
          settingsSaving,
          loadedSettingsData,
          sidecarFetchSupportsSignal,
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

  return { api: ctx.api, getEl, flashToastCalls, loadSettingsCalls };
}

test('Issue #1 + Opus P1-1: safeReadJson & postApi handle 404 "Not found", NEVER replay POST on 200-non-JSON / TypeError / 500, and reject empty 200 body', async () => {
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

  // Empty 200 body throws invalid_json (never silently returns {} that would wipe board)
  await assert.rejects(
    () =>
      api.safeReadJson(
        {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          text: async () => '',
        },
        { url: '/api/state' },
      ),
    (err) => {
      assert.equal(err.code, 'invalid_json');
      assert.equal(err.isBackendMismatch, false);
      return true;
    },
  );

  // 200 plain text (not "Not found") throws invalid_content_type without false backend mismatch banner
  await assert.rejects(
    () =>
      api.safeReadJson(
        {
          ok: true,
          status: 200,
          headers: { get: () => 'text/plain' },
          text: async () => 'Temporary gateway text',
        },
        { url: '/api/state' },
      ),
    (err) => {
      assert.equal(err.code, 'invalid_content_type');
      assert.equal(err.isBackendMismatch, false);
      return true;
    },
  );

  // Explicit 404 on POST downgrades to GET fallback once; 404 on GET surfaces semantic mismatch error
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

  // allowGetFallback: false does NOT fall back even on 404
  requests.length = 0;
  await assert.rejects(
    () => api.postApi('/api/update_apply', '/api/update_apply_get', { channel: 'dev' }, { allowGetFallback: false }),
    (err) => err.code === 'sidecar_route_not_found',
  );
  assert.equal(requests.length, 1);

  // Opus P1-1: POST returning 200 with non-JSON HTML error page MUST NOT replay via GET
  requests.length = 0;
  api.setFetch(async (url, opts = {}) => {
    requests.push({ url: String(url), method: opts.method || 'GET' });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      text: async () => '<html>Bad Gateway</html>',
    };
  });
  await assert.rejects(
    () => api.postApi('/api/dispatch', '/api/dispatch_get', { title: 'Test' }),
    (err) => err.code === 'invalid_content_type',
  );
  assert.equal(requests.length, 1, '200 non-JSON on POST must NEVER replay write via GET');

  // Opus P1-1: POST throwing network TypeError MUST NOT replay via GET
  requests.length = 0;
  api.setFetch(async (url, opts = {}) => {
    requests.push({ url: String(url), method: opts.method || 'GET' });
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(
    () => api.postApi('/api/thread_send', '/api/thread_send_get', { threadId: 'thr-1', message: 'hi' }),
    /Failed to fetch/,
  );
  assert.equal(requests.length, 1, 'Network TypeError on POST must NEVER replay write via GET');

  // HTTP 500 JSON error preserves server message and MUST NOT replay via GET
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
    (err) => err.message === 'Disk quota exceeded',
  );
  assert.equal(requests.length, 1, 'HTTP 500 must not trigger duplicate GET fallback');
});

test('Issue #1 + Opus P1-3: Version & Updates card handles mismatch without Stable flicker or mismatch reset when old backend lacks serverInfo', async () => {
  const { api, getEl, flashToastCalls } = loadUiApiAndUpdateHarness({
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      headers: { get: () => 'text/plain; charset=utf-8' },
      text: async () => 'Not found',
    }),
  });

  // 1. Old sidecar missing /api/update_status marks mismatch and never highlights Stable
  await api.loadPluginUpdateStatus({ bg: true });
  assert.equal(api.getState().backendVersionMismatch?.kind, 'stale_backend');
  assert.equal(getEl('btn-channel-stable').classList.contains('active'), false);
  assert.equal(getEl('btn-channel-dev').classList.contains('active'), false);
  assert.equal(getEl('btn-channel-stable').disabled, true);
  assert.equal(getEl('btn-channel-dev').disabled, true);
  assert.equal(getEl('update-reload-banner').hidden, false);
  assert.equal(getEl('update-reload-banner').classList.contains('warn'), true);
  assert.equal(getEl('update-status-badge').textContent, 'Reload required');
  assert.equal(flashToastCalls.length, 0);

  // 2. Opus P1-3: old dev backend HAS /api/update_status & /api/update_check but omits serverInfo
  //    -> backendVersionMismatch MUST stay stale_backend and NEVER flip back to null
  api.inspectServerInfo({ threads: [], scopeKey: '/demo' }, { fromState: true });
  assert.equal(api.getState().backendVersionMismatch?.kind, 'stale_backend');

  api.setFetch(async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () =>
      JSON.stringify({
        ok: true,
        channel: 'dev',
        currentVersion: '1.1.0',
        isGitInstall: true,
        hasUpdate: false,
        checkedAt: '2026-11-28T10:00:00Z',
      }),
  }));
  await api.loadPluginUpdateStatus({ bg: false });
  assert.equal(
    api.getState().backendVersionMismatch?.kind,
    'stale_backend',
    'update_status response without serverInfo must NOT clear stale_backend mismatch',
  );
  await api.runManualUpdateCheck('dev');
  assert.equal(
    api.getState().backendVersionMismatch?.kind,
    'stale_backend',
    'update_check response without serverInfo must NOT clear stale_backend mismatch',
  );
  assert.equal(flashToastCalls.length, 0, 'Update check must never call flashToast');

  // 3. Updated backend returning valid serverInfo clears mismatch and isolates errors to #update-err
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
          apiRevision: api.EXPECTED_SERVER_API_REVISION,
          capabilities: api.REQUIRED_UPDATE_CAPABILITIES,
          versionDrifted: false,
        },
      }),
  }));
  await api.runManualUpdateCheck('dev');
  assert.equal(api.getState().backendVersionMismatch, null);
  assert.equal(flashToastCalls.length, 0);
  assert.equal(getEl('update-err').hidden, false);
  assert.equal(getEl('update-err').textContent, 'Network unreachable');
  assert.equal(getEl('btn-channel-dev').classList.contains('active'), true);

  // 4. versionDrifted is reflected accurately in reload banner
  api.inspectServerInfo(
    {
      threads: [],
      serverInfo: {
        startedVersion: '1.1.0',
        diskVersion: '1.2.0',
        apiRevision: api.EXPECTED_SERVER_API_REVISION,
        capabilities: api.REQUIRED_UPDATE_CAPABILITIES,
        versionDrifted: true,
      },
    },
    { fromState: true },
  );
  assert.equal(api.getState().backendVersionMismatch?.kind, 'version_drifted');
  assert.match(getEl('update-reload-banner').textContent, /v1\.1\.0.*v1\.2\.0/);
});

test('Issue #2 + Opus P0-1 / P0-2 / P1-2: side-effect writes have no short default timeout, DataCloneError falls back without signal, and hanging body read still times out & recovers Save button', async () => {
  // 1. Opus P0-1: postApi defaults to timeoutMs=0 so slow side-effect writes (/api/dispatch) do NOT abort early
  const slowCalls = [];
  const { api, getEl } = loadUiApiAndUpdateHarness({
    fetchImpl: (url, opts = {}) => {
      slowCalls.push({ url: String(url), hasSignal: 'signal' in opts });
      return new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              ok: true,
              status: 200,
              headers: { get: () => 'application/json' },
              text: async () => JSON.stringify({ ok: true, thread: { threadId: 'thr-999' } }),
            }),
          180,
        );
      });
    },
  });
  api.overrideJsonTimeout(80); // Caps positive timeouts to 80ms, leaves timeoutMs=0 unbounded
  const dispatchRes = await api.postApi('/api/dispatch', '/api/dispatch_get', {
    title: 'Slow git worktree dispatch',
  });
  assert.equal(dispatchRes.ok, true);
  assert.equal(dispatchRes.thread.threadId, 'thr-999');
  assert.equal(slowCalls.length, 1);
  assert.equal(slowCalls[0].hasSignal, false, 'Unbounded postApi default must not attach AbortSignal');

  // 2. Opus P0-2: bridge window.sidecar.fetch throwing DataCloneError on AbortSignal degrades cleanly and caches capability
  const bridgeCalls = [];
  api.setFetch(async (url, opts = {}) => {
    bridgeCalls.push({ url: String(url), hasSignal: Boolean(opts.signal) });
    if (opts.signal) {
      const cloneErr = new Error('Failed to execute postMessage: AbortSignal could not be cloned.');
      cloneErr.name = 'DataCloneError';
      throw cloneErr;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ ok: true, clonedFallback: true }),
    };
  });
  const firstBridge = await api.fetchJsonWithTimeout('/api/state', { method: 'GET' }, { timeoutMs: 500 });
  assert.equal(firstBridge.data.clonedFallback, true);
  assert.equal(api.getState().sidecarFetchSupportsSignal, false);
  assert.deepEqual(
    bridgeCalls.map((c) => c.hasSignal),
    [true, false],
  );
  // Subsequent request skips signal directly without triggering another DataCloneError
  bridgeCalls.length = 0;
  await api.fetchJsonWithTimeout('/api/state', { method: 'GET' }, { timeoutMs: 500 });
  assert.deepEqual(
    bridgeCalls.map((c) => c.hasSignal),
    [false],
  );

  // 3. Opus P1-2: Response headers arrive immediately (200 OK), but body stream (res.text()) hangs forever
  //    -> fetchJsonWithTimeout + submitSettingsSave STILL abort/timeout cleanly and restore Save button!
  let bodyAborted = false;
  const bodyHangCalls = [];
  api.setFetch(async (url, opts = {}) => {
    bodyHangCalls.push({ url: String(url), method: opts.method || 'GET' });
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        bodyAborted = true;
      });
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: () => new Promise(() => {}), // headers arrived, body stalls forever
    };
  });
  api.overrideJsonTimeout(100);
  await api.submitSettingsSave(false);
  assert.equal(bodyAborted, true, 'AbortController must fire when body read stalls past timeout');
  assert.equal(bodyHangCalls.length, 1, 'Timed-out body read must NOT replay via GET');
  assert.equal(api.getState().settingsSaving, false, 'finally must clear settingsSaving');
  assert.equal(getEl('btn-settings-save').disabled, false, 'Save button must recover from disabled state');
  assert.equal(getEl('btn-settings-save').textContent, 'Save');
  assert.equal(getEl('settings-err').hidden, false);
  assert.match(getEl('settings-err').textContent, /timed out/i);
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

  const t0 = Date.now();
  await assert.rejects(() => connectPost('svc', 'Trickle', {}, 180), /timed out/i);
  assert.ok(Date.now() - t0 < 1200);

  const t1 = Date.now();
  await assert.rejects(() => connectPost('svc', 'DropMidBody', {}, 5000), /closed|aborted|reset|socket/i);
  assert.ok(Date.now() - t1 < 1500);

  const t2 = Date.now();
  await assert.rejects(() => connectPost('svc', 'DropBeforeHeaders', {}, 5000), /closed|hang up|reset|socket/i);
  assert.ok(Date.now() - t2 < 1500);

  const okRes = await connectPost('svc', 'Healthy', {}, 2000);
  assert.deepEqual(okRes, { ok: true });
});

test('Issue #2 + Opus P1-4: saveSettingsWithFastResponse avoids hung LS RPCs, normalizes worktree/subdir scopeKey to main repo root, and preserves frontend scopeKey on global save', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-fast-save-');
  const openSockets = new Set();
  const receivedUrls = [];
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
  const nestedSubdir = join(repoRoot, 'src', 'nested');
  const worktreeDir = join(tempRoot, '.worktrees', 'demo-proj', 'thr-048-feat');
  mkdirSync(nestedSubdir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });

  const mainKey = normalizeKey(repoRoot);
  const reg = loadRegistry();
  reg.coordinators[mainKey] = {
    key: mainKey,
    conversationId: 'conv-coord-hung',
    workspacePath: repoRoot,
    repoRoot,
    title: '[Coordinator] DemoProj',
  };
  reg.threads['thr-048'] = {
    threadId: 'thr-048',
    conversationId: 'conv-worker-wt',
    coordinatorId: 'conv-coord-hung',
    workspaceKey: mainKey,
    worktreePath: worktreeDir,
    title: 'Worktree feature',
    archived: false,
  };
  saveRegistry(reg);

  // 1. Global save from a worker's worktree path resolves to main repo key (NOT raw worktree path!)
  const startMs = Date.now();
  const resFromWt = await saveSettingsWithFastResponse({
    scope: 'global',
    workspacePath: worktreeDir,
    conversationId: 'conv-worker-wt',
    worktreeModel: 'gemini-4-neon-xhigh',
    readOnlyModel: 'inherit',
  });
  assert.equal(resFromWt.ok, true);
  assert.ok(Date.now() - startMs < 1500);
  assert.equal(receivedUrls.length, 0);
  assert.equal(resFromWt.scopeKey, mainKey, 'Worktree workspacePath must resolve to main repo scopeKey');
  assert.equal(loadSettings().defaults.worktreeModel, 'gemini-4-neon-xhigh');

  // 2. Project save from nested repo subdirectory without explicit workspaceKey also normalizes to main repo key
  const resFromSubdir = await saveSettingsWithFastResponse({
    scope: 'project',
    workspacePath: nestedSubdir,
    worktreeModel: 'gemini-4-neon-low',
    readOnlyModel: '',
  });
  assert.equal(resFromSubdir.ok, true);
  assert.equal(resFromSubdir.scopeKey, mainKey, 'Subdirectory must normalize to registered main repo scopeKey');
  assert.equal(loadSettings().projects[mainKey].worktreeModel, 'gemini-4-neon-low');
  assert.equal(loadSettings().projects[normalizeKey(nestedSubdir)], undefined);

  // 3. Unregistered standalone folder does NOT get falsely inferred as scopeKey on global save
  const strayDir = join(tempRoot, 'unregistered-dir');
  mkdirSync(strayDir, { recursive: true });
  const resStray = await saveSettingsWithFastResponse({
    scope: 'global',
    workspacePath: strayDir,
    worktreeModel: 'inherit',
  });
  assert.equal(resStray.ok, true);
  assert.equal(resStray.scopeKey, '', 'Unregistered path must not fabricate unnormalized scopeKey');

  // 4. Frontend submitSettingsSave preserves existing loadedSettingsData.scopeKey on global save and triggers refresh when degraded
  const sentPayloads = [];
  const { api, loadSettingsCalls } = loadUiApiAndUpdateHarness({
    fetchImpl: async (url, opts = {}) => {
      sentPayloads.push(JSON.parse(opts.body));
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () =>
          JSON.stringify({
            ok: true,
            degraded: true,
            scopeKey: '',
            settings: { defaults: { worktreeModel: 'inherit', readOnlyModel: 'inherit' }, projects: {} },
            effective: { scopeKey: '', worktreeModel: 'inherit', readOnlyModel: 'inherit' },
            serverInfo: {
              startedVersion: '1.1.0',
              diskVersion: '1.1.0',
              apiRevision: api.EXPECTED_SERVER_API_REVISION,
              capabilities: api.REQUIRED_UPDATE_CAPABILITIES,
              versionDrifted: false,
            },
          }),
      };
    },
  });
  api.setLoadedSettingsData({
    settings: { defaults: { worktreeModel: 'inherit', readOnlyModel: 'inherit' }, projects: {} },
    effective: { scopeKey: mainKey },
    scopeKey: mainKey,
    coordinatorModelDisplayName: 'Gemini 4 Neon (XHigh)',
    coordinatorModel: 'gemini-4-neon-xhigh',
  });
  api.setSettingsScope('global');
  await api.submitSettingsSave(false);
  assert.equal(sentPayloads[0].workspaceKey, mainKey, 'Global save should pass known workspaceKey');
  assert.equal(api.getState().loadedSettingsData.scopeKey, mainKey, 'Global save must never wipe existing scopeKey');
  assert.equal(loadSettingsCalls.length, 1, 'Degraded save response triggers background loadSettingsData refresh');

  // 5. Fallback builder produces complete effective object synchronously
  const fallback = buildFallbackEffectiveSettings(loadSettings(), { scopeKey: mainKey, workspacePath: repoRoot });
  assert.equal(fallback.scopeKey, mainKey);
  assert.equal(fallback.worktreeModel, 'gemini-4-neon-low');
});

test('Issue #3 + Opus P1-5 / P1-6: Extra High <-> xhigh normalization, strict Thinking variant separation, and stable turn-level coordinatorTurnStamp', async (t) => {
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const start1 = appJs.indexOf('function formatModelDisplay(');
  const end1 = appJs.indexOf('function normalizeActivityText(', start1);
  const start2 = appJs.indexOf('function matchesLiveThreadModel(');
  const end2 = appJs.indexOf('const MODEL_MENU_SUB_WIDTH', start2);
  const uiCtx = {
    selectableModels: [],
    pendingModelByThread: new Map(),
  };
  vm.runInNewContext(
    `${appJs.slice(start1, end1)}
     ${appJs.slice(start2, end2)}
     this.isSameModelFamily = isSameModelFamily;
     this.isSameModelVariant = isSameModelVariant;
     this.buildModelFamilyGroups = buildModelFamilyGroups;
     this.resolveModelFamilySelection = resolveModelFamilySelection;
     this.matchesLiveThreadModel = matchesLiveThreadModel;
     this.getModelByIdFromCatalog = getModelByIdFromCatalog;
     this.setCatalog = (m) => { selectableModels = m; };`,
    uiCtx,
  );

  // 1. Extra High <-> xhigh (including underscore boundaries like neon_extra_high)
  const positivePairs = [
    ['Gemini 4 Neon (Extra High)', 'gemini-4-neon-xhigh'],
    ['Gemini 4 Neon Extra High', 'gemini-4-neon-tiered-xhigh'],
    ['Gemini 4 Neon (Extra High)', 'Gemini 4 Neon (XHigh)'],
    ['Gemini 4 Hydrogen (X-High)', 'gemini-4-hydrogen-xhigh'],
    ['gemini_4_neon_extra_high', 'gemini-4-neon-xhigh'],
    ['gemini_4_neon_x_high', 'gemini-4-neon-xhigh'],
  ];
  for (const [a, b] of positivePairs) {
    assert.equal(isSameModelFamily(a, b), true, `lib isSameModelFamily(${a}, ${b})`);
    assert.equal(isSameModelVariant(a, b), true, `lib isSameModelVariant(${a}, ${b})`);
    assert.equal(uiCtx.isSameModelVariant(a, b), true, `UI isSameModelVariant(${a}, ${b})`);
  }
  assert.equal(isSameModelVariant('Gemini 4 Neon (High)', 'gemini-4-neon-xhigh'), false);

  // 2. Opus P1-6: Thinking vs non-Thinking variants NEVER alias in catalog / menu matching
  assert.equal(isSameModelFamily('Claude Sonnet 4.6 (Thinking)', 'claude-sonnet-4-6'), true);
  assert.equal(isSameModelVariant('Claude Sonnet 4.6 (Thinking)', 'claude-sonnet-4-6'), false);
  assert.equal(uiCtx.isSameModelVariant('Claude Sonnet 4.6 (Thinking)', 'claude-sonnet-4-6'), false);
  assert.equal(isSameModelVariant('Claude Sonnet 4.6 (Thinking)', 'claude-sonnet-4-6-thinking'), true);

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
    {
      id: 'claude-sonnet-4-6',
      modelId: 'claude-sonnet-4-6',
      modelEnum: 'MODEL_PLACEHOLDER_M34',
      label: 'Claude Sonnet 4.6',
    },
    {
      id: 'claude-sonnet-4-6-thinking',
      modelId: 'claude-sonnet-4-6-thinking',
      modelEnum: 'MODEL_PLACEHOLDER_M35',
      label: 'Claude Sonnet 4.6 (Thinking)',
    },
  ];
  uiCtx.setCatalog(catalog);

  // Thinking thread only checks the Thinking catalog item, NEVER the bare non-Thinking item
  const thinkingThread = { modelDisplayName: 'Claude Sonnet 4.6 (Thinking)' };
  assert.equal(uiCtx.matchesLiveThreadModel(catalog[2], thinkingThread), false);
  assert.equal(uiCtx.matchesLiveThreadModel(catalog[3], thinkingThread), true);

  // Bare thread only checks the bare item, NEVER the Thinking item
  const bareThread = { modelDisplayName: 'Claude Sonnet 4.6' };
  assert.equal(uiCtx.matchesLiveThreadModel(catalog[2], bareThread), true);
  assert.equal(uiCtx.matchesLiveThreadModel(catalog[3], bareThread), false);

  // Unlisted Thinking variant when only bare exists does NOT mis-match bare variant
  uiCtx.setCatalog([catalog[2]]);
  assert.equal(uiCtx.getModelByIdFromCatalog('Claude Sonnet 4.6 (Thinking)'), null);
  assert.deepEqual(canonicalizeModelForSettings('Claude Sonnet 4.6 (Thinking)', [catalog[2]]), {
    value: 'Claude Sonnet 4.6 (Thinking)',
    label: '',
  });
  uiCtx.setCatalog(catalog);

  // Extra High label still matches XHigh entry cleanly across lib, UI, and canonicalize
  const groups = buildModelFamilyGroups(catalog, { includeInherit: true });
  const selLib = resolveModelFamilySelection('Gemini 4 Neon (Extra High)', groups);
  const selUi = uiCtx.resolveModelFamilySelection('Gemini 4 Neon (Extra High)', groups);
  assert.equal(selLib.value, 'gemini-4-neon-xhigh');
  assert.equal(selLib.isFallback, false);
  assert.equal(selUi.value, 'gemini-4-neon-xhigh');
  assert.equal(selUi.isFallback, false);
  assert.deepEqual(canonicalizeModelForSettings('Gemini 4 Neon Extra High', catalog), {
    value: 'gemini-4-neon-xhigh',
    label: 'Gemini 4 Neon (XHigh)',
  });

  // 3. extractModelFromSteps retains Extra High display name with xhigh slug
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

  // 4. resolveInheritedCoordinatorModel & Opus P1-5 stable coordinatorTurnStamp
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
    lastStepCount: 1,
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

  // Opus P1-5: Adding intermediate tool steps without changing model or lastStepCount keeps coordinatorTurnStamp STABLE (no /api/settings storm!)
  const snap1 = await syncThreads({ workspacePath: repoRoot });
  writeFileSync(
    txPath,
    `${readFileSync(txPath, 'utf8')}\n${JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'tool output' })}\n`,
    'utf8',
  );
  const snapToolStep = await syncThreads({ workspacePath: repoRoot });
  assert.equal(
    snapToolStep.coordinatorTurnStamp,
    snap1.coordinatorTurnStamp,
    'Intermediate tool steps must NOT churn coordinatorTurnStamp',
  );

  // Switching model in a new turn DOES update coordinatorTurnStamp
  writeFileSync(
    txPath,
    `${readFileSync(txPath, 'utf8')}\n${JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-medium', content: 'Turn 2' })}\n`,
    'utf8',
  );
  const snapModelChange = await syncThreads({ workspacePath: repoRoot });
  assert.notEqual(snapModelChange.coordinatorTurnStamp, snap1.coordinatorTurnStamp);
});

test('Issue #1/#2/#3 static & I18N checks: serverInfo, refresh linkage, throttle/focus guard, draft note, zero middle dots, zero native dialogs, and LF line endings', () => {
  const mainMjs = readFileSync(new URL('../sidecars/threads/main.mjs', import.meta.url), 'utf8');
  const indexHtml = readFileSync(new URL('../sidecars/threads/index.html', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const themeCss = readFileSync(new URL('../sidecars/threads/theme.css', import.meta.url), 'utf8');

  // Sidecar backend exposes startup version/capabilities, non-blocking git sha, and static headers
  assert.match(mainMjs, /X-PT-Server-Version/);
  assert.match(mainMjs, /X-PT-Api-Revision/);
  assert.match(mainMjs, /SERVER_CAPABILITIES/);
  assert.match(mainMjs, /serverInfo:\s*buildServerInfo\(\)/);
  assert.match(mainMjs, /saveSettingsWithFastResponse/);
  assert.equal(/execFileSync/.test(mainMjs), false, 'main.mjs should not synchronously block startup on git');

  // Settings UI wires refresh button, throttle/in-flight dedup, focus guard, draft hint, and isolated update status
  assert.match(indexHtml, /id="settings-inherit-note"/);
  assert.match(indexHtml, /id="update-status-msg"/);
  assert.match(themeCss, /\.settings-inherit-note/);
  assert.match(themeCss, /\.update-reload-banner\.warn/);
  assert.match(appJs, /elBtnSettingsRefreshModels\.addEventListener\('click'[\s\S]*?loadSelectableModels\(true\)[\s\S]*?loadSettingsData\(/);
  assert.match(appJs, /settingsLoadInFlight/);
  assert.match(appJs, /SETTINGS_AUTO_REFRESH_MIN_MS/);
  assert.match(appJs, /isSelectElementFocused/);
  assert.match(appJs, /fetchJsonWithTimeout/);
  assert.match(appJs, /isSignalCloneError/);
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

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { resetLsEndpointCache, resetModelConfigCache } from '../lib/ls-client.mjs';
import {
  loadRegistry,
  normalizeKey,
  resetStorePerfCaches,
  saveRegistry,
  sendThreadMessage,
  syncThreads,
} from '../lib/store.mjs';
import { resetTranscriptCaches } from '../lib/transcript.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_JS_PATH = new URL('../sidecars/threads/app.js', import.meta.url);

function loadAppJsLf() {
  return readFileSync(APP_JS_PATH, 'utf8').replace(/\r\n/g, '\n');
}

function extractI18nSource(appJsLf) {
  const start = appJsLf.indexOf('const I18N = {');
  assert.ok(start > 0, 'Expected const I18N in app.js');
  const end = appJsLf.indexOf('\n  };\n', start);
  assert.ok(end > start, 'Expected closing of const I18N in app.js');
  return appJsLf.slice(start, end + 5);
}

function extractFunctionSource(appJsLf, fnName) {
  let start = appJsLf.indexOf(`async function ${fnName}(`);
  if (start === -1) start = appJsLf.indexOf(`function ${fnName}(`);
  assert.notEqual(start, -1, `Expected ${fnName} in app.js`);
  const bodyStart = appJsLf.indexOf('{', appJsLf.indexOf(')', start));
  assert.notEqual(bodyStart, -1, `Expected body of ${fnName}`);
  let depth = 0;
  for (let i = bodyStart; i < appJsLf.length; i++) {
    const ch = appJsLf[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return appJsLf.slice(start, i + 1);
    }
  }
  throw new Error(`Unclosed function ${fnName}`);
}

function createFakeDateClass(getNowMs) {
  return class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(getNowMs());
      else super(...args);
    }
    static now() {
      return getNowMs();
    }
  };
}

function formatLocalHms(isoStr) {
  const d = new Date(Date.parse(isoStr));
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function createTempEnv(t, prefix = 'pt-dec040-') {
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

function initGitRepo(repoDir) {
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.md'), '# Demo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });
}

function startMockLs(t, { updateDelayMs = 0, initialArchivedMap = {} } = {}) {
  const archivedByConv = new Map(Object.entries(initialArchivedMap));
  const updateConvCalls = [];
  const sendMsgCalls = [];

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
          res.end(
            JSON.stringify({
              conversation: {
                id: cid,
                state: {
                  runState: 'RUN_STATE_RUNNING',
                  updateTime: new Date().toISOString(),
                },
                annotations: { archived: Boolean(archivedByConv.get(cid)) },
              },
            }),
          );
          return;
        }
        if (req.url === '/product.v1.ConversationService/UpdateConversation') {
          const cid = String(payload.conversationId || '');
          if (typeof payload.annotations?.archived === 'boolean') {
            archivedByConv.set(cid, payload.annotations.archived);
          }
          updateConvCalls.push({ ...payload, completedAt: Date.now() });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.url === '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage') {
          sendMsgCalls.push(payload);
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
      };

      const d =
        req.url === '/product.v1.ConversationService/UpdateConversation'
          ? typeof updateDelayMs === 'function'
            ? updateDelayMs(payload)
            : updateDelayMs
          : 0;
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
      process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-dec-040';
      resetLsEndpointCache();
      t.after(() => new Promise((r) => server.close(r)));
      resolveListen({
        address,
        archivedByConv,
        updateConvCalls,
        sendMsgCalls,
      });
    });
  });
}

test('dec-040: relTime() and relTimeAgo() never produce 0m / 0m ago / 0 分钟前 across 0s..120s boundaries', () => {
  const appJsLf = loadAppJsLf();
  const baseMs = Date.parse('2026-11-29T00:20:00.000Z');
  let fakeNow = baseMs;

  const sandbox = {
    Date: createFakeDateClass(() => fakeNow),
    Math,
    Number,
    String,
  };
  vm.runInNewContext(
    `
    ${extractI18nSource(appJsLf)}
    let curLocale = 'en';
    const L = () => I18N[curLocale] || I18N.en;
    ${extractFunctionSource(appJsLf, 'relTime')}
    ${extractFunctionSource(appJsLf, 'relTimeAgo')}
    this.api = {
      I18N,
      setLocale: (loc) => { curLocale = loc; },
      relTime,
      relTimeAgo,
    };
  `,
    sandbox,
  );

  const forbiddenRe = /(?:^|\s)0(?:m\b|m ago| 分钟前| 分鐘前)/;
  const subMinuteDeltas = [-5, 0, 30, 45, 59];

  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    sandbox.api.setLocale(loc);
    const t = sandbox.api.I18N[loc];

    for (const deltaSec of subMinuteDeltas) {
      fakeNow = baseMs + deltaSec * 1000;
      const iso = new Date(baseMs).toISOString();
      const rt = sandbox.api.relTime(iso);
      const rta = sandbox.api.relTimeAgo(iso);
      assert.equal(rt, t.justNow, `${loc} relTime(${deltaSec}s) should return justNow`);
      assert.equal(rta, t.justNowAgo, `${loc} relTimeAgo(${deltaSec}s) should return justNowAgo`);
      assert.equal(forbiddenRe.test(rt), false, `${loc} relTime(${deltaSec}s) must not output 0m: ${rt}`);
      assert.equal(forbiddenRe.test(rta), false, `${loc} relTimeAgo(${deltaSec}s) must not output 0m ago: ${rta}`);
    }

    for (const [deltaSec, expectedMin] of [
      [60, 1],
      [119, 1],
      [120, 2],
    ]) {
      fakeNow = baseMs + deltaSec * 1000;
      const iso = new Date(baseMs).toISOString();
      const rt = sandbox.api.relTime(iso);
      const rta = sandbox.api.relTimeAgo(iso);
      assert.equal(rt, `${expectedMin}m`, `${loc} relTime(${deltaSec}s)`);
      assert.equal(rta, t.agoTime(expectedMin, 'm'), `${loc} relTimeAgo(${deltaSec}s)`);
      assert.equal(forbiddenRe.test(rt), false);
      assert.equal(forbiddenRe.test(rta), false);
    }

    fakeNow = baseMs + 3600 * 1000;
    assert.equal(sandbox.api.relTime(new Date(baseMs).toISOString()), '1h');
    assert.equal(sandbox.api.relTimeAgo(new Date(baseMs).toISOString()), t.agoTime(1, 'h'));

    fakeNow = baseMs + 86400 * 1000;
    assert.equal(sandbox.api.relTime(new Date(baseMs).toISOString()), '1d');
    assert.equal(sandbox.api.relTimeAgo(new Date(baseMs).toISOString()), t.agoTime(1, 'd'));
  }
});

test('dec-040: watchdog patrol tooltip & settings meta show HH:MM:SS, exact seconds, patrol interval, and live-refresh on mouseenter/focus', () => {
  const appJsLf = loadAppJsLf();
  const patrolIso = '2026-11-28T16:19:55.000Z';
  const patrolMs = Date.parse(patrolIso);
  const expectedClock = formatLocalHms(patrolIso);
  let fakeNow = patrolMs + 19_000;

  const elements = new Map();
  const makeEl = (id) => {
    const classes = new Set();
    const listeners = new Map();
    const el = {
      id,
      hidden: false,
      disabled: false,
      value: '',
      placeholder: '',
      textContent: '',
      title: '',
      className: '',
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
        contains: (c) => classes.has(c),
      },
      setAttribute: () => {},
      addEventListener: (ev, fn) => {
        const list = listeners.get(ev) || [];
        list.push(fn);
        listeners.set(ev, list);
      },
      dispatchEvent: (ev, payload = {}) => {
        for (const fn of listeners.get(ev) || []) fn(payload);
      },
      listenerNames: () => [...listeners.keys()],
    };
    elements.set(id, el);
    return el;
  };

  const doc = {
    activeElement: null,
    getElementById: (id) => elements.get(id) || makeEl(id),
  };

  const bindStart = appJsLf.indexOf('  if (elBtnWatchdogPatrol) {');
  const bindEnd = appJsLf.indexOf('\n  for (const [btn, val] of [', bindStart);
  assert.ok(bindStart > 0 && bindEnd > bindStart, 'Expected #btn-watchdog-patrol event binding block in app.js');

  const wdDefaultsStart = appJsLf.indexOf('  const WD_DEFAULT_VALS = {');
  const wdDefaultsEnd = appJsLf.indexOf('\n  };\n', wdDefaultsStart);
  assert.ok(wdDefaultsStart > 0 && wdDefaultsEnd > wdDefaultsStart);

  const sandbox = {
    document: doc,
    Date: createFakeDateClass(() => fakeNow),
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
  };

  vm.runInNewContext(
    `
    ${extractI18nSource(appJsLf)}
    let curLocale = 'zh-CN';
    const L = () => I18N[curLocale] || I18N.en;
    ${appJsLf.slice(wdDefaultsStart, wdDefaultsEnd + 5)}
    ${extractFunctionSource(appJsLf, 'formatWatchdogPatrolTime')}
    const elBtnWatchdogPatrol = document.getElementById('btn-watchdog-patrol');
    const elLblWdPatrol = document.getElementById('lbl-wd-patrol');
    const elWdCard = document.getElementById('settings-watchdog-card');
    const elWdStatusBadge = document.getElementById('wd-status-badge');
    const elBtnWdEnabledInherit = document.getElementById('btn-wd-enabled-inherit');
    const elBtnWdEnabledOn = document.getElementById('btn-wd-enabled-on');
    const elBtnWdEnabledOff = document.getElementById('btn-wd-enabled-off');
    const elSetWdInterval = document.getElementById('set-wd-interval');
    const elSetWdStall = document.getElementById('set-wd-stall');
    const elSetWdBgTask = document.getElementById('set-wd-bgtask');
    const elSetWdMismatch = document.getElementById('set-wd-mismatch');
    const elSetWdCooldown = document.getElementById('set-wd-cooldown');
    const elSetWdEscalated = document.getElementById('set-wd-escalated');
    const elWdUnsupportedHint = document.getElementById('wd-unsupported-hint');
    const elWdSettingsMeta = document.getElementById('wd-settings-meta');
    const elBtnWdSave = document.getElementById('btn-wd-save');
    const elBtnWdReset = document.getElementById('btn-wd-reset');
    const elBtnWdPatrolNow = document.getElementById('btn-wd-patrol-now');
    let serverCapabilities = new Set(['watchdog_patrol']);
    const supportsWatchdogPatrol = () => serverCapabilities.has('watchdog_patrol');
    let wdPatrolling = false;
    let wdSaving = false;
    let wdDirtyByUser = false;
    let wdDraftEnabled = 'true';
    let settingsScope = 'global';
    let activeScopeKey = '/repo';
    let lastSnap = null;
    let loadedSettingsData = {
      settings: { watchdog: { ...WD_DEFAULT_VALS, patrolIntervalSec: 30, stallThresholdMin: 10 } },
      effective: {
        watchdog: {
          ...WD_DEFAULT_VALS,
          patrolIntervalSec: 30,
          stallThresholdMin: 10,
          source: 'global',
          hasProjectOverride: false,
          global: { ...WD_DEFAULT_VALS, patrolIntervalSec: 30, stallThresholdMin: 10 },
          project: {},
        },
      },
    };
    const isWatchdogInputFocused = () => false;
    const runWatchdogManualPatrol = () => {};
    ${extractFunctionSource(appJsLf, 'refreshWatchdogPatrolTooltip')}
    ${extractFunctionSource(appJsLf, 'renderBoardWatchdogChip')}
    ${extractFunctionSource(appJsLf, 'getWatchdogEffectiveForSettings')}
    ${extractFunctionSource(appJsLf, 'syncWatchdogEnabledButtons')}
    ${extractFunctionSource(appJsLf, 'renderWatchdogSettingsCard')}
    ${appJsLf.slice(bindStart, bindEnd)}
    this.api = {
      I18N,
      setLocale: (loc) => { curLocale = loc; },
      setLastSnap: (s) => { lastSnap = s; },
      setPatrolInterval: (sec) => {
        loadedSettingsData.effective.watchdog.patrolIntervalSec = sec;
        loadedSettingsData.effective.watchdog.global.patrolIntervalSec = sec;
      },
      formatWatchdogPatrolTime,
      renderBoardWatchdogChip,
      renderWatchdogSettingsCard,
      refreshWatchdogPatrolTooltip,
    };
  `,
    sandbox,
  );

  const btn = doc.getElementById('btn-watchdog-patrol');
  const meta = doc.getElementById('wd-settings-meta');
  assert.ok(btn.listenerNames().includes('mouseenter'), '#btn-watchdog-patrol must listen to mouseenter');
  assert.ok(btn.listenerNames().includes('focus'), '#btn-watchdog-patrol must listen to focus');

  const snap = {
    coordinator: { conversationId: 'conv-coord-1' },
    watchdog: {
      enabled: true,
      patrolIntervalSec: 30,
      stallThresholdMin: 10,
      lastPatrolAt: patrolIso,
      stalledCount: 0,
    },
  };
  sandbox.api.setLastSnap(snap);

  // 1. Sub-minute (< 60s) exact HH:MM:SS + seconds + interval across all 3 locales
  const expect19 = {
    en: {
      time: `${expectedClock} (19s ago)`,
      tipParts: ['every 30s', 'threshold 10m', `${expectedClock} (19s ago)`],
      metaParts: ['Every 30s', `${expectedClock} (19s ago)`],
    },
    'zh-CN': {
      time: `${expectedClock}（19 秒前）`,
      tipParts: ['每 30 秒巡检', '停滞阈值 10 分钟', `${expectedClock}（19 秒前）`],
      metaParts: ['每 30 秒巡检', `${expectedClock}（19 秒前）`],
    },
    'zh-TW': {
      time: `${expectedClock}（19 秒前）`,
      tipParts: ['每 30 秒巡檢', '停滯閾值 10 分鐘', `${expectedClock}（19 秒前）`],
      metaParts: ['每 30 秒巡檢', `${expectedClock}（19 秒前）`],
    },
  };

  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    sandbox.api.setLocale(loc);
    fakeNow = patrolMs + 19_000;
    const formatted19 = sandbox.api.formatWatchdogPatrolTime(patrolIso, sandbox.api.I18N[loc]);
    assert.equal(formatted19, expect19[loc].time);

    sandbox.api.renderBoardWatchdogChip(snap);
    for (const part of expect19[loc].tipParts) {
      assert.ok(btn.title.includes(part), `${loc} tooltip "${btn.title}" should include "${part}"`);
    }
    assert.equal(btn.title.includes('\u00B7'), false, `${loc} tooltip must not contain middle dot`);

    sandbox.api.renderWatchdogSettingsCard(false);
    for (const part of expect19[loc].metaParts) {
      assert.ok(meta.textContent.includes(part), `${loc} settings meta "${meta.textContent}" should include "${part}"`);
    }
    assert.equal(meta.textContent.includes('\u00B7'), false, `${loc} meta must not contain middle dot`);

    // >= 60s transitions cleanly to minutes
    fakeNow = patrolMs + 125_000;
    const formatted2m = sandbox.api.formatWatchdogPatrolTime(patrolIso, sandbox.api.I18N[loc]);
    const expect2m =
      loc === 'en'
        ? `${expectedClock} (2m ago)`
        : loc === 'zh-CN'
          ? `${expectedClock}（2 分钟前）`
          : `${expectedClock}（2 分鐘前）`;
    assert.equal(formatted2m, expect2m, `${loc} >= 60s should format minutes`);
  }

  // 2. mouseenter and focus re-compute title on demand against live Date.now() without rerendering board
  sandbox.api.setLocale('zh-CN');
  fakeNow = patrolMs + 5_000;
  sandbox.api.renderBoardWatchdogChip(snap);
  assert.ok(btn.title.includes(`${expectedClock}（5 秒前）`), `initial title expected 5s ago, got: ${btn.title}`);

  fakeNow = patrolMs + 24_000;
  btn.dispatchEvent('mouseenter');
  assert.ok(btn.title.includes(`${expectedClock}（24 秒前）`), `mouseenter should refresh to 24s ago, got: ${btn.title}`);

  fakeNow = patrolMs + 51_000;
  btn.dispatchEvent('focus');
  assert.ok(btn.title.includes(`${expectedClock}（51 秒前）`), `focus should refresh to 51s ago, got: ${btn.title}`);

  // 3. Never-patrolled state remains safe on mouseenter & focus across locales
  const neverSnap = {
    coordinator: { conversationId: 'conv-coord-1' },
    watchdog: {
      enabled: true,
      patrolIntervalSec: 45,
      stallThresholdMin: 10,
      lastPatrolAt: '',
      stalledCount: 0,
    },
  };
  sandbox.api.setLastSnap(neverSnap);
  sandbox.api.setPatrolInterval(45);
  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    sandbox.api.setLocale(loc);
    btn.dispatchEvent('mouseenter');
    assert.ok(
      btn.title.includes(sandbox.api.I18N[loc].wdNeverPatrolled),
      `${loc} never-patrolled tooltip should show wdNeverPatrolled: ${btn.title}`,
    );
    assert.ok(btn.title.includes('45'), `${loc} never-patrolled tooltip should include custom 45s interval`);
    sandbox.api.renderWatchdogSettingsCard(false);
    assert.ok(meta.textContent.includes(sandbox.api.I18N[loc].wdNeverPatrolled));
    assert.ok(meta.textContent.includes('45'));
  }
});

test('v1.2.0 polish: thin index budget warning displays both line count and KB when byte budget is exceeded under 60 lines (en/zh-CN/zh-TW)', () => {
  const appJsLf = loadAppJsLf();
  const memStart = appJsLf.indexOf('  function isMemoryInputFocused() {');
  const memEnd = appJsLf.indexOf('  async function refreshBoard(', memStart);
  assert.ok(memStart > 0 && memEnd > memStart);

  const elements = new Map();
  const makeEl = (id) => {
    const classes = new Set();
    const el = {
      id,
      hidden: false,
      disabled: false,
      readOnly: false,
      value: '',
      textContent: '',
      innerHTML: '',
      title: '',
      placeholder: '',
      dataset: {},
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
        contains: (c) => classes.has(c),
      },
      focus: () => {},
      addEventListener: () => {},
      querySelectorAll: () => [],
    };
    elements.set(id, el);
    return el;
  };
  const doc = {
    activeElement: null,
    getElementById: (id) => elements.get(id) || makeEl(id),
  };

  const sandbox = {
    document: doc,
    URLSearchParams,
    console,
    curLocale: 'zh-CN',
    serverCapabilities: new Set(['topic_memory']),
    memoryActiveView: 'index',
    memoryActiveTopicId: '',
    memoryEditorDirty: false,
    memoryImeComposing: false,
    memorySnapshot: {
      ok: true,
      path: '/repo/.agents/rules/project-memory.md',
      content: '# Thin Index\n',
      topics: [{ id: 'ui', title: 'UI', keywords: ['app.js'], summary: 'UI notes', lineCount: 10, byteSize: 500 }],
      budget: {
        lineCount: 32,
        byteSize: 4301,
        softMaxLines: 60,
        softMaxBytes: 4096,
        overLines: false,
        overBytes: true,
        overBudget: true,
      },
      migration: { needsMigration: false, lineCount: 32, byteSize: 4301, suggestedLegacyTopicId: 'legacy' },
    },
    memoryActiveTopicData: null,
    lastMemoryTopicsKey: '',
    activeModalCtx: null,
    lastSnap: { coordinator: { title: '[Coordinator] Demo' } },
    API_READ_TIMEOUT_MS: 10000,
    esc: (s) => String(s || ''),
    syncHostConversationScope: async () => false,
    buildScopePayload: (extra = {}) => ({ workspace: '/repo', ...extra }),
    fetchJsonWithTimeout: async () => ({ data: { ok: true } }),
    applyLocale: () => false,
    inspectServerInfo: () => {},
    flashToast: () => {},
    syncModalConfirmButton: () => {},
  };

  vm.runInNewContext(
    `
    ${extractI18nSource(appJsLf)}
    const L = () => I18N[curLocale] || I18N.en;
    function supportsTopicMemory() { return serverCapabilities.has('topic_memory'); }
    const elMemMigrateBanner = document.getElementById('mem-migrate-banner');
    const elLblMemMigrateTitle = document.getElementById('lbl-mem-migrate-title');
    const elMemMigrateBadge = document.getElementById('mem-migrate-badge');
    const elLblMemMigrateDesc = document.getElementById('lbl-mem-migrate-desc');
    const elBtnMemSplitCoord = document.getElementById('btn-mem-split-coord');
    const elBtnMemArchiveLegacy = document.getElementById('btn-mem-archive-legacy');
    const elMemBudgetBadge = document.getElementById('mem-budget-badge');
    const elMemViewBar = document.getElementById('mem-view-bar');
    const elBtnMemBackIndex = document.getElementById('btn-mem-back-index');
    const elMemViewBadge = document.getElementById('mem-view-badge');
    const elBtnMemDelTopic = document.getElementById('btn-mem-del-topic');
    const elMemTopicMetaFields = document.getElementById('mem-topic-meta-fields');
    const elMemTopicId = document.getElementById('mem-topic-id');
    const elMemTopicTitle = document.getElementById('mem-topic-title');
    const elMemTopicKeywords = document.getElementById('mem-topic-keywords');
    const elMemTopicSummary = document.getElementById('mem-topic-summary');
    const elMemEditor = document.getElementById('mem-editor');
    const elMemBudgetWarn = document.getElementById('mem-budget-warn');
    const elMemErr = document.getElementById('mem-err');
    const elMemDirtyPill = document.getElementById('mem-dirty-pill');
    const elMemTopicsSection = document.getElementById('mem-topics-section');
    const elMemTopicsCount = document.getElementById('mem-topics-count');
    const elBtnMemNewTopic = document.getElementById('btn-mem-new-topic');
    const elMemTopicsList = document.getElementById('mem-topics-list');
    const elModalBackdrop = document.getElementById('pt-modal-backdrop');
    const elModalTitle = document.getElementById('pt-modal-title');
    const elModalClose = document.getElementById('pt-modal-close');
    const elModalThread = document.getElementById('pt-modal-thread');
    const elModalWtInfo = document.getElementById('pt-modal-wt-info');
    const elModalRebindBox = document.getElementById('pt-modal-rebind-box');
    const elModalWarn = document.getElementById('pt-modal-warn');
    const elModalRemoveRow = document.getElementById('pt-modal-remove-row');
    const elModalBranchRow = document.getElementById('pt-modal-branch-row');
    const elModalForceRow = document.getElementById('pt-modal-force-row');
    const elModalErr = document.getElementById('pt-modal-err');
    const elModalCancel = document.getElementById('pt-modal-cancel');
    const elModalConfirm = document.getElementById('pt-modal-confirm');
    ${appJsLf.slice(memStart, memEnd)}
    this.api = { I18N, renderMemoryUi };
  `,
    sandbox,
  );

  const warnEl = doc.getElementById('mem-budget-warn');
  const expectedSnippets = {
    en: ['32 lines / 4.2 KB', '<= 60 lines and <= 4 KB'],
    'zh-CN': ['32 行 / 4.2 KB', '<= 60 行且 <= 4 KB'],
    'zh-TW': ['32 行 / 4.2 KB', '<= 60 行且 <= 4 KB'],
  };

  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    sandbox.curLocale = loc;
    sandbox.api.renderMemoryUi({ syncInputs: false });
    assert.equal(warnEl.hidden, false, `${loc} #mem-budget-warn must be visible when over byte budget`);
    for (const part of expectedSnippets[loc]) {
      assert.ok(warnEl.textContent.includes(part), `${loc} budget warn "${warnEl.textContent}" should include "${part}"`);
    }
    assert.equal(warnEl.textContent.includes('\u00B7'), false);

    // Backwards-compatible 2-arg invocation stays clean (no NaN/undefined)
    const fallback = sandbox.api.I18N[loc].memBudgetWarnText(75, 'legacy');
    assert.equal(/NaN|undefined/.test(fallback), false, `${loc} fallback warn must not contain NaN/undefined: ${fallback}`);
  }
});

test('thr-106 P2-1: sendThreadMessage() bounds UpdateConversation({ archived: false }) with 800ms soft timeout and avoids race window', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-wake-bound-');
  const repoDir = join(tempRoot, 'demo-repo');
  initGitRepo(repoDir);
  const scopeKey = normalizeKey(repoDir);

  const convFastPlain = 'conv-wake-fast-plain';
  const convFastModel = 'conv-wake-fast-model';
  const convSlow = 'conv-wake-slow-ls';

  const ls = await startMockLs(t, {
    initialArchivedMap: {
      [convFastPlain]: true,
      [convFastModel]: true,
      [convSlow]: true,
    },
    updateDelayMs: (payload) => (payload.conversationId === convSlow ? 3500 : 60),
  });

  const reg = loadRegistry();
  reg.coordinators[scopeKey] = {
    key: scopeKey,
    conversationId: 'conv-coord-wake',
    workspacePath: repoDir,
    repoRoot: repoDir,
    title: '[Coordinator] Wake Bound',
  };
  for (const [threadId, conversationId] of [
    ['thr-001', convFastPlain],
    ['thr-002', convFastModel],
    ['thr-003', convSlow],
  ]) {
    reg.threads[threadId] = {
      threadId,
      conversationId,
      coordinatorId: 'conv-coord-wake',
      workspaceKey: scopeKey,
      workspacePath: repoDir,
      repoRoot: repoDir,
      title: `Archived ${threadId}`,
      model: 'pro',
      modelDisplayName: 'Gemini Pro',
      runState: 'RUN_STATE_IDLE',
      bucket: 'archived',
      archived: true,
      createdAt: '2026-11-28T01:00:00Z',
      updatedAt: '2026-11-28T01:00:00Z',
    };
  }
  saveRegistry(reg);

  // 1. Plain follow-up awaits UpdateConversation({ archived: false }) BEFORE returning (no sleep needed!)
  const resPlain = await sendThreadMessage({
    threadId: 'thr-001',
    message: 'Wake plain thread',
    workspacePath: repoDir,
    workspaceKey: scopeKey,
  });
  assert.equal(resPlain.ok, true);
  assert.equal(resPlain.thread.archived, false);
  assert.equal(
    ls.archivedByConv.get(convFastPlain),
    false,
    'LS annotations.archived must already be false before sendThreadMessage resolves',
  );

  // 2. Model-override follow-up also awaits UpdateConversation({ archived: false }) BEFORE returning
  const resModel = await sendThreadMessage({
    threadId: 'thr-002',
    message: 'Wake model-override thread',
    model: 'gemini-3.8-flash-high',
    modelEnum: 'MODEL_PLACEHOLDER_M318',
    modelDisplayName: 'Gemini 3.8 Flash (High)',
    workspacePath: repoDir,
    workspaceKey: scopeKey,
  });
  assert.equal(resModel.ok, true);
  assert.equal(resModel.thread.archived, false);
  assert.equal(
    ls.archivedByConv.get(convFastModel),
    false,
    'LS annotations.archived must already be false before model-override sendThreadMessage resolves',
  );

  // Immediate syncThreads() never bounces awakened threads back to archived=true
  const snap = await syncThreads({ workspacePath: repoDir, includeArchived: false });
  assert.equal(snap.threads.filter((x) => x.threadId === 'thr-001' || x.threadId === 'thr-002').length, 2);
  assert.equal(loadRegistry().threads['thr-001'].archived, false);
  assert.equal(loadRegistry().threads['thr-002'].archived, false);

  // 3. Stalled LS UpdateConversation (3500ms) is bounded by withSoftTimeout(..., 800, null) and never stalls sendThreadMessage
  const t0 = Date.now();
  const resSlow = await sendThreadMessage({
    threadId: 'thr-003',
    message: 'Wake thread with stalled LS',
    workspacePath: repoDir,
    workspaceKey: scopeKey,
  });
  const elapsedMs = Date.now() - t0;
  assert.equal(resSlow.ok, true);
  assert.equal(resSlow.thread.archived, false);
  assert.equal(loadRegistry().threads['thr-003'].archived, false);
  assert.ok(elapsedMs >= 700, `Expected bounded soft timeout (~800ms), completed too early in ${elapsedMs}ms`);
  assert.ok(elapsedMs < 2400, `Expected bounded soft timeout (~800ms) to prevent 3500ms stall, took ${elapsedMs}ms`);
});

test('v1.2.0 polish: trilingual READMEs align on thr-NNN and v18 while preserving v1.2.0--rc.1 badge and invariants', () => {
  const hookMjs = readFileSync(join(REPO_ROOT, 'scripts', 'hook-handler.mjs'), 'utf8');
  const mainMjs = readFileSync(join(REPO_ROOT, 'sidecars', 'threads', 'main.mjs'), 'utf8');
  const appJs = loadAppJsLf();
  const storeMjs = readFileSync(join(REPO_ROOT, 'lib', 'store.mjs'), 'utf8');

  assert.match(hookMjs, /const\s+DIRECTIVE_VERSION\s*=\s*18\s*;/);
  assert.match(mainMjs, /const\s+SERVER_API_REVISION\s*=\s*8\s*;/);
  assert.match(appJs, /const\s+EXPECTED_SERVER_API_REVISION\s*=\s*8\s*;/);
  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appJs), false);
  assert.match(
    storeMjs,
    /await\s+withSoftTimeout\(\s*updateConversation\(t\.conversationId,\s*\{\s*archived:\s*false\s*\}\)\.catch\(\(\)\s*=>\s*null\),\s*800,\s*null,?\s*\)/,
  );

  for (const name of ['README.md', 'README.zh-CN.md', 'README.zh-TW.md']) {
    const content = readFileSync(join(REPO_ROOT, name), 'utf8');
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const detailsIdx = lines.findIndex((l) => l.trim().startsWith('<details>'));
    assert.ok(detailsIdx > 0 && detailsIdx <= 70, `${name} above-the-fold must stay <= 70 lines (got ${detailsIdx})`);
    assert.ok(content.includes('version-v1.2.0--rc.1-'), `${name} must preserve v1.2.0--rc.1 version badge`);
    assert.equal(content.includes('v17'), false, `${name} must not have leftover v17 protocol references`);
    assert.equal(content.includes('thr-xxx'), false, `${name} must not have leftover thr-xxx references`);
    assert.ok(content.includes('thr-NNN'), `${name} must reference unified thr-NNN IDs`);
    assert.ok(content.includes('v18'), `${name} must reference v18 protocol`);
    assert.equal(content.includes('\u00B7'), false, `${name} must not contain U+00B7 middle dot`);
  }

  for (const rel of ['lib/store.mjs', 'tests/ui-time-and-polish.test.mjs']) {
    const raw = readFileSync(join(REPO_ROOT, rel));
    assert.equal(raw.includes(Buffer.from('\r')), false, `${rel} must use strict LF line endings`);
  }
});

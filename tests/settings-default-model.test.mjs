import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resetModelConfigCache } from '../lib/ls-client.mjs';
import {
  dispatchThread,
  getEffectiveSettings,
  loadRegistry,
  loadSettings,
  normalizeKey,
  resolveDefaultDispatchModel,
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

function startMockLs(t, { withCatalog = true } = {}) {
  const createRequests = [];
  const cascadeSendPayloads = [];
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
      resolveListen({ port, createRequests, cascadeSendPayloads });
    });
  });
}

test('loadSettings / saveSettings persist global defaults, project overrides, corrupt fallbacks, and clears cleanly', (t) => {
  const { stateDir } = createTempEnv(t, 'pt-set-persist-');

  // 1. Missing settings.json falls back cleanly to pro/pro
  const initial = loadSettings();
  assert.deepEqual(initial.defaults, { worktreeModel: 'pro', readOnlyModel: 'pro' });
  assert.deepEqual(initial.projects, {});

  // 2. Corrupt settings.json falls back cleanly without throwing
  writeFileSync(join(stateDir, 'settings.json'), '{not-valid-json', 'utf8');
  const recovered = loadSettings();
  assert.deepEqual(recovered.defaults, { worktreeModel: 'pro', readOnlyModel: 'pro' });

  // 3. Save global defaults via patch
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

  // 4. Per-project overrides merge & clear cleanly
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
  assert.deepEqual(loadSettings().defaults, { worktreeModel: 'pro', readOnlyModel: 'pro' });
});

test('getEffectiveSettings and resolveDefaultDispatchModel enforce project precedence and separate worktree vs readOnly', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-set-eff-');
  await startMockLs(t, { withCatalog: true });

  const repoRoot = join(tempRoot, 'demo-repo');
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
  const wk = normalizeKey(repoRoot);

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

  assert.equal(
    await resolveDefaultDispatchModel({ createWorktree: true, workspacePath: repoRoot }),
    'gemini-4-neon-high',
  );
  assert.equal(
    await resolveDefaultDispatchModel({ createWorktree: false, workspacePath: repoRoot }),
    'gemini-3.8-flash-medium',
  );

  // Clearing project worktreeModel reverts createWorktree: true back to global default
  saveSettings({ scope: 'project', workspaceKey: wk, worktreeModel: '' });
  assert.equal(
    await resolveDefaultDispatchModel({ createWorktree: true, workspacePath: repoRoot }),
    'gemini-4-hydrogen-xhigh',
  );
});

test('dispatchThread honors Settings defaults for omitted/default/auto/inherit, separates modes, respects overrides, and never sends display labels', async (t) => {
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

  // 2. Omitted / "default" / "auto" / "inherit" with createWorktree: false uses readOnlyModel
  for (const sentinel of [undefined, '', 'default', 'auto', 'inherit']) {
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
    assert.notEqual(ls.createRequests.at(-1).model, 'inherit');
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

test('static and protocol checks: hook DIRECTIVE_VERSION=8, skill, MCP, Sidecar API/UI, I18N, and LF endings', (t) => {
  const hookHandler = readFileSync(new URL('../scripts/hook-handler.mjs', import.meta.url), 'utf8');
  const skillMd = readFileSync(new URL('../skills/coord/SKILL.md', import.meta.url), 'utf8');
  const serverMjs = readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');
  const mainMjs = readFileSync(new URL('../sidecars/threads/main.mjs', import.meta.url), 'utf8');
  const indexHtml = readFileSync(new URL('../sidecars/threads/index.html', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const themeCss = readFileSync(new URL('../sidecars/threads/theme.css', import.meta.url), 'utf8');

  // 1. Hook directive version bumped to 8 and no hardcoded model: "pro"
  assert.match(hookHandler, /const\s+DIRECTIVE_VERSION\s*=\s*8\s*;/);
  assert.equal(/model:\s*["']pro["']/.test(hookHandler), false);

  // 2. SKILL.md no longer hardcodes model: "pro"
  assert.equal(/model:\s*["']pro["']/.test(skillMd), false);

  // 3. MCP dispatch_thread no longer claims Defaults to "flash" and passes model only when provided
  assert.equal(/Defaults to "flash"/i.test(serverMjs), false);
  assert.match(serverMjs, /Settings/i);

  // 4. Sidecar backend routes and handleDispatch
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/settings['"]/);
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/settings_save['"]/);
  assert.match(mainMjs, /model:\s*data\.model\s*\|\|\s*''/);
  assert.equal(/model:\s*data\.model\s*\|\|\s*'pro'/.test(mainMjs), false);

  // 5. Sidecar UI structure, zero native dialogs, I18N across 3 locales
  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appJs), false);
  assert.match(indexHtml, /id="btn-settings"/);
  assert.match(indexHtml, /id="settings-screen"/);
  assert.match(indexHtml, /class="seg-group settings-seg"/);
  assert.match(indexHtml, /id="set-worktree-model"/);
  assert.match(indexHtml, /id="set-readonly-model"/);
  assert.match(indexHtml, /<option value="">/);
  assert.match(themeCss, /#settings-screen|\.settings-body/);

  for (const key of [
    'settingsTip',
    'settingsTitle',
    'settingsScopeGlobal',
    'settingsScopeProject',
    'settingsWorktreeLabel',
    'settingsReadOnlyLabel',
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

  // 7. Verify hook-handler PreInvocation emits updated v8 directive without hardcoded model: "pro"
  const hookEnv = createTempEnv(t, 'pt-set-hook-');
  const hookReg = loadRegistry();
  hookReg.coordinators['__hook_test__'] = {
    key: '__hook_test__',
    conversationId: 'conv-hook-coord',
    workspacePath: repoRoot,
    repoRoot,
    title: '[Coordinator] HookTest',
    directiveVersion: 7,
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
  assert.ok(injectedDirective.includes('dispatch_thread'), 'upgraded v7 -> v8 coordinator receives new directive');
  assert.equal(/model:\s*["']pro["']/.test(injectedDirective), false);
  assert.equal(loadRegistry().coordinators['__hook_test__'].directiveVersion, 8);

  // 8. LF line endings on all modified/added .mjs files
  for (const rel of [
    '../lib/store.mjs',
    '../scripts/hook-handler.mjs',
    '../mcp/server.mjs',
    '../sidecars/threads/main.mjs',
    '../tests/settings-default-model.test.mjs',
  ]) {
    const raw = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!raw.includes(Buffer.from('\r')), `${rel} must use LF line endings`);
  }
});

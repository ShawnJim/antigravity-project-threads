import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  buildSendUserCascadeMessagePayload,
  extractSelectableModels,
  getCascadeModelCatalog,
  getSelectableModels,
  resetModelConfigCache,
  sendUserCascadeMessage,
} from '../lib/ls-client.mjs';
import {
  dispatchThread,
  getThreadMessages,
  loadRegistry,
  saveRegistry,
  sendThreadMessage,
  syncThreads,
} from '../lib/store.mjs';

function createTempEnv(t, prefix = 'pt-sw-') {
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
    rmSync(tempRoot, { recursive: true, force: true });
  });

  return { tempRoot, geminiDir, appDataDir, stateDir };
}

function writeMockAgentApiScript(dir, name, jsBody) {
  const jsPath = join(dir, `${name}.mjs`);
  writeFileSync(jsPath, jsBody, 'utf8');
  if (process.platform === 'win32') {
    const cmdPath = join(dir, `${name}.cmd`);
    writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${jsPath}" %*\r\n`, 'utf8');
    return cmdPath;
  }
  const shPath = join(dir, name);
  writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${jsPath}" "$@"\n`, 'utf8');
  chmodSync(shPath, 0o755);
  return shPath;
}

const SAMPLE_MODEL_CONFIG_DATA = {
  clientModelConfigs: [
    {
      label: 'Disabled Model',
      disabled: true,
      modelId: 'disabled-model',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_DISABLED' },
    },
    {
      label: 'Gemini 4 Hydrogen (Low)',
      modelId: 'gemini-4-hydrogen-low',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M527' },
      tagTitle: 'New',
      quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-27T12:00:00Z' },
    },
    {
      label: 'Gemini 4 Hydrogen (XHigh)',
      modelId: 'gemini-4-hydrogen-xhigh',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M528' },
      tagTitle: 'New',
      quotaInfo: { remainingFraction: 0.9, resetTime: '2026-11-27T12:00:00Z' },
    },
    {
      label: 'Gemini 4 Neon (High)',
      modelId: 'gemini-4-neon-high',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' },
      tagTitle: 'New',
      tagDescription: 'For deep reasoning',
      quotaInfo: { remainingFraction: 0.96, resetTime: '2026-11-27T12:10:00Z' },
    },
    {
      label: 'Gemini 4 Neon (Low)',
      modelId: 'gemini-4-neon-low',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M534' },
      tagTitle: 'New',
      quotaInfo: { remainingFraction: 0.96, resetTime: '2026-11-27T12:10:00Z' },
    },
    {
      label: 'Gemini 3.8 Flash (Medium)',
      modelId: 'gemini-3.8-flash-medium',
      modelOrAlias: { model: 'MODEL_PLACEHOLDER_M319' },
      tagTitle: 'Leaving Soon',
      quotaInfo: { remainingFraction: 0.5, resetTime: '2026-11-27T12:10:00Z' },
    },
    {
      label: 'GPT-OSS 120B (Medium)',
      modelId: 'gpt-oss-120b-medium',
      modelOrAlias: { model: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM' },
      tagTitle: 'Notice',
      quotaInfo: { remainingFraction: 1, resetTime: '2026-11-27T14:51:06Z' },
    },
  ],
  clientModelSorts: [
    {
      name: 'Recommended',
      groups: [
        {
          modelLabels: [
            'Gemini 4 Neon (High)',
            'Gemini 4 Neon (Low)',
            'Gemini 4 Hydrogen (XHigh)',
            'Gemini 4 Hydrogen (Low)',
            'Gemini 3.8 Flash (Medium)',
            'GPT-OSS 120B (Medium)',
          ],
        },
      ],
    },
  ],
  defaultOverrideModelConfig: {
    modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' },
  },
  groupedModels: {
    'gemini-4-neon': {
      displayName: 'Gemini 4 Neon',
      supportedThinkingLevels: [
        { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
        { thinkingSuffix: 'high', thinkingDisplayName: 'High' },
      ],
    },
    'gemini-4-hydrogen': {
      displayName: 'Gemini 4 Hydrogen',
      supportedThinkingLevels: [
        { thinkingSuffix: 'low', thinkingDisplayName: 'Low' },
        { thinkingSuffix: 'xhigh', thinkingDisplayName: 'Extra High' },
      ],
    },
  },
};

test('extractSelectableModels orders by clientModelSorts, filters disabled, preserves effort variants, tags, quota, and isDefault', () => {
  const models = extractSelectableModels(SAMPLE_MODEL_CONFIG_DATA);
  assert.equal(models.length, 6);
  assert.deepEqual(
    models.map((m) => m.label),
    [
      'Gemini 4 Neon (High)',
      'Gemini 4 Neon (Low)',
      'Gemini 4 Hydrogen (XHigh)',
      'Gemini 4 Hydrogen (Low)',
      'Gemini 3.8 Flash (Medium)',
      'GPT-OSS 120B (Medium)',
    ],
  );

  const neonHigh = models[0];
  assert.equal(neonHigh.id, 'gemini-4-neon-high');
  assert.equal(neonHigh.modelId, 'gemini-4-neon-high');
  assert.equal(neonHigh.modelEnum, 'MODEL_PLACEHOLDER_M532');
  assert.deepEqual(neonHigh.modelOrAlias, { model: 'MODEL_PLACEHOLDER_M532' });
  assert.equal(neonHigh.isDefault, true);
  assert.equal(neonHigh.tagTitle, 'New');
  assert.equal(neonHigh.quotaInfo?.remainingFraction, 0.96);
  assert.equal(neonHigh.familyId, 'gemini-4-neon');
  assert.equal(neonHigh.familyName, 'Gemini 4 Neon');

  const hydrogenXHigh = models[2];
  assert.equal(hydrogenXHigh.isDefault, false);
  assert.equal(hydrogenXHigh.thinkingLevel, 'Extra High');
  assert.equal(hydrogenXHigh.familyId, 'gemini-4-hydrogen');

  // When clientModelSorts is absent, groupedModels groups family variants cleanly
  const noSort = extractSelectableModels({
    clientModelConfigs: SAMPLE_MODEL_CONFIG_DATA.clientModelConfigs,
    groupedModels: SAMPLE_MODEL_CONFIG_DATA.groupedModels,
  });
  assert.deepEqual(
    noSort.map((m) => m.label),
    [
      'Gemini 4 Hydrogen (Low)',
      'Gemini 4 Hydrogen (XHigh)',
      'Gemini 4 Neon (Low)',
      'Gemini 4 Neon (High)',
      'Gemini 3.8 Flash (Medium)',
      'GPT-OSS 120B (Medium)',
    ],
  );
});

test('buildSendUserCascadeMessagePayload & sendUserCascadeMessage wire cascadeConfig.plannerConfig and resolve model slugs', async (t) => {
  const payloadDirect = buildSendUserCascadeMessagePayload('conv-123', 'Hello world', {
    modelEnum: 'MODEL_PLACEHOLDER_M532',
  });
  assert.deepEqual(payloadDirect, {
    cascadeId: 'conv-123',
    items: [{ text: 'Hello world' }],
    cascadeConfig: {
      plannerConfig: {
        planModel: 'MODEL_PLACEHOLDER_M532',
        requestedModel: { model: 'MODEL_PLACEHOLDER_M532' },
      },
    },
  });

  const payloadAlias = buildSendUserCascadeMessagePayload('conv-123', 'Use auto', {
    modelOrAlias: { alias: 'MODEL_ALIAS_AUTO' },
  });
  assert.deepEqual(payloadAlias, {
    cascadeId: 'conv-123',
    items: [{ text: 'Use auto' }],
    cascadeConfig: {
      plannerConfig: {
        requestedModel: { alias: 'MODEL_ALIAS_AUTO' },
      },
    },
  });

  createTempEnv(t, 'pt-sw-rpc-');
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      requests.push({
        url: req.url,
        headers: req.headers,
        body: body ? JSON.parse(body) : {},
      });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
        res.end(JSON.stringify(SAMPLE_MODEL_CONFIG_DATA));
        return;
      }
      if (req.url === '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage') {
        res.end(JSON.stringify({ queued: true }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${port}`;
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-abc';
  t.after(() => new Promise((r) => server.close(r)));

  const catalog = await getCascadeModelCatalog();
  assert.equal(catalog.ok, true);
  assert.equal(catalog.models.length, 6);
  assert.equal(catalog.defaultModel?.modelEnum, 'MODEL_PLACEHOLDER_M532');

  // Calling getSelectableModels again uses cache (only 1 GetCascadeModelConfigData call)
  const cachedModels = await getSelectableModels();
  assert.equal(cachedModels.length, 6);
  assert.equal(
    requests.filter((r) => r.url.endsWith('/GetCascadeModelConfigData')).length,
    1,
  );

  // Passing concrete modelId slug resolves via catalog to planModel + requestedModel
  await sendUserCascadeMessage('conv-abc', 'Switch to Hydrogen XHigh', {
    model: 'gemini-4-hydrogen-xhigh',
  });

  const sendReq = requests.find((r) => r.url.endsWith('/SendUserCascadeMessage'));
  assert.ok(sendReq);
  assert.equal(sendReq.headers['connect-protocol-version'], '1');
  assert.equal(sendReq.headers['x-codeium-csrf-token'], 'csrf-abc');
  assert.deepEqual(sendReq.body, {
    cascadeId: 'conv-abc',
    items: [{ text: 'Switch to Hydrogen XHigh' }],
    cascadeConfig: {
      plannerConfig: {
        planModel: 'MODEL_PLACEHOLDER_M528',
        requestedModel: { model: 'MODEL_PLACEHOLDER_M528' },
      },
    },
  });
});

test('sendThreadMessage routes model switches through SendUserCascadeMessage, survives polls, and falls back when un-overridden', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-sw-store-');

  let mockState = {
    runState: 'RUN_STATE_IDLE',
    updateTime: '2026-11-27T09:00:00Z',
    generatorMetadata: [
      {
        stepIndices: [1, 2],
        chatModel: {
          model: 'MODEL_PLACEHOLDER_M528',
          responseModel: 'gemini-4-hydrogen-tiered-xhigh',
          modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
        },
      },
    ],
    cascadeSendPayloads: [],
    createRequests: [],
    rejectCreateConcreteModel: false,
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
        res.end(JSON.stringify(SAMPLE_MODEL_CONFIG_DATA));
        return;
      }
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
        res.end(JSON.stringify({ generatorMetadata: mockState.generatorMetadata }));
        return;
      }
      if (req.url === '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage') {
        mockState.cascadeSendPayloads.push(payload);
        mockState.runState = 'RUN_STATE_RUNNING';
        mockState.updateTime = '2026-11-27T09:01:00Z';
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === '/product.v1.ConversationService/GetConversation') {
        res.end(
          JSON.stringify({
            conversation: {
              id: payload.conversationId,
              state: { runState: mockState.runState, updateTime: mockState.updateTime },
            },
          }),
        );
        return;
      }
      if (req.url === '/product.v1.ConversationService/CreateConversation') {
        mockState.createRequests.push(payload);
        if (mockState.rejectCreateConcreteModel && payload.model && payload.model !== 'pro') {
          res.statusCode = 400;
          res.end(JSON.stringify({ message: `invalid model: ${payload.model}` }));
          return;
        }
        res.end(
          JSON.stringify({
            conversation: {
              id: `conv-created-${mockState.createRequests.length}`,
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
      res.statusCode = 404;
      res.end('{}');
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${port}`;
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'csrf-store';
  t.after(() => new Promise((r) => server.close(r)));

  const agentSendLog = join(tempRoot, 'agentapi-sends.jsonl');
  const mockExe = writeMockAgentApiScript(
    tempRoot,
    'agentapi',
    `import { appendFileSync } from 'node:fs';
     appendFileSync(${JSON.stringify(agentSendLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
     process.stdout.write(JSON.stringify({ response: { sendMessage: { ok: true } } }));`,
  );
  process.env.ANTIGRAVITY_AGENTAPI_EXE = mockExe;

  const reg = loadRegistry();
  reg.coordinators['__swtest__'] = {
    key: '__swtest__',
    conversationId: 'conv-coord-sw',
    workspacePath: '',
    title: '[Coordinator] SwTest',
  };
  reg.threads['thr-101'] = {
    threadId: 'thr-101',
    conversationId: 'conv-thr-101',
    coordinatorId: 'conv-coord-sw',
    workspaceKey: '__swtest__',
    title: 'Switch test',
    model: 'pro',
    modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
    resolvedModel: 'gemini-4-hydrogen-tiered-xhigh',
    modelEnum: 'MODEL_PLACEHOLDER_M528',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    createdAt: '2026-11-27T09:00:00Z',
    updatedAt: '2026-11-27T09:00:00Z',
  };
  saveRegistry(reg);

  // 1. Send with model override uses SendUserCascadeMessage with planModel/requestedModel
  const swRes = await sendThreadMessage({
    threadId: 'thr-101',
    message: 'Continue with Neon High',
    model: 'gemini-4-neon-high',
    modelDisplayName: 'Gemini 4 Neon (High)',
  });
  assert.equal(swRes.ok, true);
  assert.equal(swRes.thread.modelDisplayName, 'Gemini 4 Neon (High)');
  assert.equal(swRes.thread.resolvedModel, 'gemini-4-neon-high');
  assert.equal(swRes.thread.modelEnum, 'MODEL_PLACEHOLDER_M532');
  assert.equal(swRes.thread.model, 'pro'); // preserves original dispatch field
  assert.equal(mockState.cascadeSendPayloads.length, 1);
  assert.deepEqual(mockState.cascadeSendPayloads[0].cascadeConfig, {
    plannerConfig: {
      planModel: 'MODEL_PLACEHOLDER_M532',
      requestedModel: { model: 'MODEL_PLACEHOLDER_M532' },
    },
  });

  // 2. Subsequent getThreadMessages() poll BEFORE new generatorMetadata arrives keeps switched model
  const pollBeforeGen = await getThreadMessages({ threadId: 'thr-101' });
  assert.equal(pollBeforeGen.thread.modelDisplayName, 'Gemini 4 Neon (High)');
  assert.equal(pollBeforeGen.thread.resolvedModel, 'gemini-4-neon-high');

  // 3. Once LS appends new generatorMetadata for turn 2, pendingModelSwitch clears and LS rules
  mockState.generatorMetadata.push({
    stepIndices: [3, 4],
    chatModel: {
      model: 'MODEL_PLACEHOLDER_M532',
      responseModel: 'gemini-4-neon-tiered-high',
      modelDisplayName: 'Gemini 4 Neon (High)',
    },
  });
  mockState.runState = 'RUN_STATE_IDLE';
  mockState.updateTime = '2026-11-27T09:01:30Z';
  const pollAfterGen = await getThreadMessages({ threadId: 'thr-101' });
  assert.equal(pollAfterGen.thread.modelDisplayName, 'Gemini 4 Neon (High)');
  assert.equal(pollAfterGen.thread.pendingModelSwitch, undefined);

  // 4. Tier alias rejected for mid-thread switch
  await assert.rejects(
    () => sendThreadMessage({ threadId: 'thr-101', message: 'Bad switch', model: 'flash' }),
    /tier alias/i,
  );

  // 5. Un-overridden send uses SendUserCascadeMessage when LS is live (no agentapi spawn)
  await sendThreadMessage({ threadId: 'thr-101', message: 'Normal follow-up' });
  assert.equal(mockState.cascadeSendPayloads.length, 2);
  assert.equal(mockState.cascadeSendPayloads[1].cascadeConfig, undefined);

  // 6. Un-overridden send falls back cleanly to invokeAgentApiSend when LS is offline
  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:1';
  const fallbackRes = await sendThreadMessage({ threadId: 'thr-101', message: 'Offline follow-up' });
  assert.equal(fallbackRes.ok, true);
  const agentCalls = readFileSync(agentSendLog, 'utf8').trim().split(/\r?\n/);
  assert.equal(agentCalls.length, 1);

  // 7. Restore LS and verify dispatchThread handles concrete modelId & modelEnum (with CreateConversation fallback)
  process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${port}`;
  resetModelConfigCache();
  await syncThreads({ allWorkspaces: true });

  const dispatchedConcrete = await dispatchThread({
    coordinatorId: 'conv-coord-sw',
    title: 'Concrete model dispatch',
    taskPrompt: 'Check something',
    model: 'MODEL_PLACEHOLDER_M528',
    createWorktree: false,
  });
  assert.equal(dispatchedConcrete.model, 'MODEL_PLACEHOLDER_M528');
  assert.equal(dispatchedConcrete.modelDisplayName, 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(dispatchedConcrete.resolvedModel, 'gemini-4-hydrogen-xhigh');
  assert.equal(dispatchedConcrete.modelEnum, 'MODEL_PLACEHOLDER_M528');
  assert.equal(mockState.createRequests.at(-1).model, 'gemini-4-hydrogen-xhigh');

  // Simulate LS rejecting concrete model on CreateConversation -> falls back to CreateConversation(pro, empty) + SendUserCascadeMessage
  mockState.rejectCreateConcreteModel = true;
  const dispatchedFallback = await dispatchThread({
    coordinatorId: 'conv-coord-sw',
    title: 'Fallback dispatch',
    taskPrompt: 'Run with Neon Low',
    model: 'gemini-4-neon-low',
    createWorktree: false,
  });
  assert.equal(dispatchedFallback.modelDisplayName, 'Gemini 4 Neon (Low)');
  assert.equal(dispatchedFallback.modelEnum, 'MODEL_PLACEHOLDER_M534');
  assert.equal(mockState.cascadeSendPayloads.at(-1).cascadeConfig?.plannerConfig?.planModel, 'MODEL_PLACEHOLDER_M534');
});

test('static checks: Sidecar UI wires #btn-comp-model, .pt-model-menu outside #composer-meta, /api/models, I18N, and LF endings', () => {
  const indexHtml = readFileSync(new URL('../sidecars/threads/index.html', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const themeCss = readFileSync(new URL('../sidecars/threads/theme.css', import.meta.url), 'utf8');
  const mainMjs = readFileSync(new URL('../sidecars/threads/main.mjs', import.meta.url), 'utf8');

  // Zero native dialogs
  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appJs), false);

  // #pt-model-menu sits inside .composer-wrap and outside #composer-meta / .composer-pill
  const wrapStart = indexHtml.indexOf('<div class="composer-wrap">');
  const menuPos = indexHtml.indexOf('id="pt-model-menu"');
  const pillPos = indexHtml.indexOf('<div class="composer-pill">');
  const metaPos = indexHtml.indexOf('id="composer-meta"');
  assert.ok(wrapStart !== -1 && menuPos > wrapStart && menuPos < pillPos && pillPos < metaPos);

  // Switchable button + chevron + pending state + popover + 2-level drill-down + /api/models + #f-model/#f-tier
  assert.match(appJs, /id="btn-comp-model"/);
  assert.match(appJs, /comp-model-chev/);
  assert.match(appJs, /pendingModelByThread/);
  assert.match(appJs, /modelMenuFamilyKey/);
  assert.match(appJs, /data-family-key/);
  assert.match(appJs, /pt-model-back/);
  assert.match(appJs, /pt-model-effort/);
  assert.match(appJs, /\/api\/models/);
  assert.match(appJs, /populateDispatchModelSelect/);
  assert.match(appJs, /id="f-model"|getElementById\(['"]f-model['"]\)/);
  assert.match(appJs, /getElementById\(['"]f-tier['"]\)/);
  assert.match(indexHtml, /id="f-model"/);
  assert.match(indexHtml, /id="f-tier"/);
  assert.match(appJs, /modelRunningHint/);
  assert.match(appJs, /Escape/);
  assert.match(themeCss, /\.pt-model-menu\b/);
  assert.match(themeCss, /\.pt-model-back\b/);
  assert.match(themeCss, /\.pt-model-effort\b/);
  assert.match(themeCss, /button\.comp-model-pill\b/);

  // All 3 locales define model switcher strings
  for (const key of ['modelSwitchTip', 'modelPendingTip', 'modelMenuTitle', 'modelBack', 'modelRunningHint', 'modelGroupModels', 'fTier']) {
    const matches = appJs.match(new RegExp(`\\b${key}:`, 'g')) || [];
    assert.equal(matches.length, 3, `${key} must be localized in en, zh-CN, and zh-TW`);
  }

  // Sidecar backend routes
  assert.match(mainMjs, /registerDualApi\('\/api\/models'/);
  assert.match(mainMjs, /getCascadeModelCatalog/);
  assert.match(mainMjs, /modelOrAlias/);
  assert.match(mainMjs, /modelDisplayName/);

  // LF line endings on all .mjs files
  for (const rel of [
    '../lib/ls-client.mjs',
    '../lib/model-format.mjs',
    '../lib/store.mjs',
    '../sidecars/threads/main.mjs',
    '../tests/model-display.test.mjs',
    '../tests/model-switcher.test.mjs',
  ]) {
    const raw = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!raw.includes(Buffer.from('\r')), `${rel} must use LF line endings`);
  }
});

function loadUiComposerMenuContext() {
  const src = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const start1 = src.indexOf('function formatModelDisplay(');
  const end1 = src.indexOf('function normalizeActivityText(', start1);
  const start2 = src.indexOf('function matchesLiveThreadModel(');
  const end2 = src.indexOf('function renderThreadHeader(', start2);
  assert.notEqual(start1, -1, 'formatModelDisplay must exist in app.js');
  assert.notEqual(end1, -1, 'normalizeActivityText must follow model helpers in app.js');
  assert.notEqual(start2, -1, 'matchesLiveThreadModel must exist in app.js');
  assert.notEqual(end2, -1, 'renderThreadHeader must follow model menu helpers in app.js');

  const ctx = {};
  vm.runInNewContext(
    `
    let curLocale = 'en';
    let selectableModels = [];
    let selectableModelsLoading = false;
    let selectableModelsLoadedAt = Date.now();
    let modelMenuOpen = false;
    let modelMenuFamilyKey = '';
    let openThreadId = '';
    let openThreadObj = null;
    const pendingModelByThread = new Map();
    const elModelMenu = {
      hidden: true,
      dataset: {},
      innerHTML: '',
      querySelector() {
        return null;
      },
    };
    const elChatInput = { focus() {} };
    const ICONS = {
      check: '<svg>check</svg>',
      chevronLeft: '<svg>left</svg>',
      chevronRight: '<svg>right</svg>',
    };
    const esc = (s) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    const L = () => ({
      modelMenuTitle: 'Model',
      modelBack: 'Back',
      modelRunningHint: 'Thread is running — new model applies on your next message',
      modelNextMsgHint: 'Applies on your next message',
      modelLoading: 'Loading models…',
      modelEmpty: 'Live model catalog unavailable',
      modelDefaultBadge: 'Default',
      settingsTierDefault: 'Default',
      settingsTierStandard: 'Standard',
    });
    function loadSelectableModels() {}
    function renderThreadHeader() {}

    ${src.slice(start1, end1)}
    ${src.slice(start2, end2)}

    this.api = {
      buildComposerModelMenuData,
      getModelByIdFromCatalog,
      openModelMenu,
      renderModelMenu,
      closeModelMenu,
      selectThreadModel,
      setState(patch = {}) {
        if ('selectableModels' in patch) {
          selectableModels = patch.selectableModels;
          selectableModelsLoadedAt = Date.now();
        }
        if ('selectableModelsLoading' in patch) {
          selectableModelsLoading = patch.selectableModelsLoading;
        }
        if ('openThreadId' in patch) openThreadId = patch.openThreadId;
        if ('openThreadObj' in patch) openThreadObj = patch.openThreadObj;
        if ('modelMenuOpen' in patch) modelMenuOpen = patch.modelMenuOpen;
        if ('modelMenuFamilyKey' in patch) modelMenuFamilyKey = patch.modelMenuFamilyKey;
      },
      getState() {
        return {
          modelMenuOpen,
          modelMenuFamilyKey,
          elModelMenu,
          pendingModelByThread,
        };
      },
    };
    `,
    ctx,
  );
  return ctx.api;
}

test('two-level composer .pt-model-menu groups families (Level 1) and efforts (Level 2) preserving catalog sort order', () => {
  const ui = loadUiComposerMenuContext();
  const catalog = extractSelectableModels(SAMPLE_MODEL_CONFIG_DATA);

  // Active model is Gemini 4 Hydrogen (XHigh)
  const rawFamilies = ui.buildComposerModelMenuData(catalog, {
    id: 'gemini-4-hydrogen-xhigh',
    modelId: 'gemini-4-hydrogen-xhigh',
    modelEnum: 'MODEL_PLACEHOLDER_M528',
    label: 'Gemini 4 Hydrogen (XHigh)',
  });
  const families = JSON.parse(JSON.stringify(rawFamilies));

  // 6 concrete variants collapse into 4 Level-1 families in clientModelSorts order
  assert.deepEqual(
    families.map((f) => f.label),
    [
      'Gemini 4 Neon',
      'Gemini 4 Hydrogen',
      'Gemini 3.8 Flash (Medium)',
      'GPT-OSS 120B (Medium)',
    ],
  );

  // Inactive multi-effort family shows its default effort ('High'), quota, tag, and hasTiers: true
  const neon = families[0];
  assert.equal(neon.hasTiers, true);
  assert.equal(neon.active, false);
  assert.equal(neon.activeEffortLabel, 'High');
  assert.equal(neon.tagTitle, 'New');
  assert.equal(neon.quotaInfo?.remainingFraction, 0.96);
  assert.deepEqual(
    neon.tiers.map((t) => t.label),
    ['Low', 'High'],
  );

  // Active multi-effort family shows active checkmark & active effort ('XHigh'), and marks Level-2 tier active
  const hydro = families[1];
  assert.equal(hydro.hasTiers, true);
  assert.equal(hydro.active, true);
  assert.equal(hydro.activeEffortLabel, 'XHigh');
  assert.deepEqual(
    hydro.tiers.map((t) => [t.label, t.active]),
    [
      ['Low', false],
      ['XHigh', true],
    ],
  );

  // Single-variant models pick directly without Level 2 drill-down
  const flash38 = families[2];
  assert.equal(flash38.hasTiers, false);
  assert.equal(flash38.activeEffortLabel, '');
  assert.equal(flash38.singleModelKey, 'gemini-3.8-flash-medium');
  assert.equal(flash38.tagTitle, 'Leaving Soon');

  const gpt = families[3];
  assert.equal(gpt.hasTiers, false);
  assert.equal(gpt.singleModelKey, 'gpt-oss-120b-medium');

  // Verify live renderModelMenu() Level 1 -> Level 2 drill-down -> 1.2s poll stability -> Reopen -> single-variant pick
  ui.setState({
    selectableModels: catalog,
    openThreadId: 'thr-1',
    openThreadObj: {
      threadId: 'thr-1',
      runState: 'RUN_STATE_RUNNING',
      archived: false,
      modelEnum: 'MODEL_PLACEHOLDER_M528',
      resolvedModel: 'gemini-4-hydrogen-xhigh',
      modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
    },
  });

  // 1. Open starts at Level 1 with family rows
  ui.openModelMenu();
  const state1 = ui.getState();
  assert.equal(state1.modelMenuOpen, true);
  assert.equal(state1.modelMenuFamilyKey, '');
  assert.equal(state1.elModelMenu.hidden, false);
  assert.equal(state1.elModelMenu.dataset.menuMode, 'level1');
  assert.match(state1.elModelMenu.innerHTML, /data-family-key="family:gemini 4 neon"/);
  assert.match(state1.elModelMenu.innerHTML, /data-family-key="family:gemini 4 hydrogen"/);
  assert.match(state1.elModelMenu.innerHTML, /data-model-key="gpt-oss-120b-medium"/);
  assert.match(state1.elModelMenu.innerHTML, /pt-model-effort">XHigh</);

  // 2. Drill into Level 2 for Gemini 4 Hydrogen -> sticky Back header + Low & XHigh effort rows
  ui.setState({ modelMenuFamilyKey: 'family:gemini 4 hydrogen' });
  ui.renderModelMenu();
  const state2 = ui.getState();
  assert.equal(state2.elModelMenu.dataset.menuMode, 'level2:family:gemini 4 hydrogen');
  assert.match(state2.elModelMenu.innerHTML, /class="pt-model-back"/);
  assert.match(state2.elModelMenu.innerHTML, /pt-model-menu-family[^>]*>Gemini 4 Hydrogen</);
  assert.match(state2.elModelMenu.innerHTML, /data-model-key="gemini-4-hydrogen-low"/);
  assert.match(state2.elModelMenu.innerHTML, /data-model-key="gemini-4-hydrogen-xhigh"/);

  // 3. Simulated 1.2s background poll calling renderModelMenu() preserves Level 2 intact (early no-op)
  state2.elModelMenu.innerHTML += '<!--sentinel-->';
  ui.renderModelMenu();
  assert.ok(ui.getState().elModelMenu.innerHTML.endsWith('<!--sentinel-->'));
  assert.equal(ui.getState().modelMenuFamilyKey, 'family:gemini 4 hydrogen');

  // 4. Selecting an effort row sets pendingModelByThread and closes menu cleanly
  const chosenLow = ui.getModelByIdFromCatalog('gemini-4-hydrogen-low');
  ui.selectThreadModel(chosenLow);
  assert.equal(ui.getState().modelMenuOpen, false);
  assert.equal(ui.getState().modelMenuFamilyKey, '');
  assert.equal(ui.getState().pendingModelByThread.get('thr-1')?.id, 'gemini-4-hydrogen-low');

  // 5. Reopening always starts at Level 1
  ui.openModelMenu();
  assert.equal(ui.getState().modelMenuFamilyKey, '');
  assert.equal(ui.getState().elModelMenu.dataset.menuMode, 'level1');

  // 6. Selecting single-variant model directly closes menu and updates pending selection
  const chosenGpt = ui.getModelByIdFromCatalog('gpt-oss-120b-medium');
  ui.selectThreadModel(chosenGpt);
  assert.equal(ui.getState().modelMenuOpen, false);
  assert.equal(ui.getState().pendingModelByThread.get('thr-1')?.id, 'gpt-oss-120b-medium');
});

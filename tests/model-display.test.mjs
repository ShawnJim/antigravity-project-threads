import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  buildModelConfigLookup,
  extractModelInfoFromGeneratorMetadata,
  getThreadGeneratorModel,
  resolveModelLabelFromLookup,
} from '../lib/ls-client.mjs';
import { formatModelDisplay, isSameModelFamily, isTierAlias } from '../lib/model-format.mjs';
import { getThreadMessages, loadRegistry, saveRegistry, syncThreads } from '../lib/store.mjs';
import { extractModelFromSteps, extractTranscriptModel } from '../lib/transcript.mjs';

function loadUiFormatModelDisplay() {
  const src = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const start = src.indexOf('function formatModelDisplay(');
  assert.notEqual(start, -1, 'formatModelDisplay must exist in sidecars/threads/app.js');
  let depth = 0;
  let end = -1;
  let inBrace = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
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
  assert.notEqual(end, -1, 'Could not find closing brace for formatModelDisplay');
  const fnCode = src.slice(start, end);
  const ctx = {};
  vm.runInNewContext(`${fnCode}; this.formatModelDisplay = formatModelDisplay;`, ctx);
  return { fn: ctx.formatModelDisplay, appSource: src };
}

test('formatModelDisplay handles concrete display names, slugs, enums, and tier aliases identically in lib and UI', () => {
  const { fn: uiFormatModelDisplay, appSource } = loadUiFormatModelDisplay();

  const cases = [
    ['', 'Gemini Pro'],
    ['pro', 'Gemini Pro'],
    ['flash', 'Gemini Flash'],
    ['flash_lite', 'Gemini Flash Lite'],
    ['flash-lite', 'Gemini Flash Lite'],
    ['auto', 'Gemini Pro'],
    ['inherit', 'Follow Coordinator (inherit)'],
    ['Gemini 4 Hydrogen (XHigh)', 'Gemini 4 Hydrogen (XHigh)'],
    ['Gemini 4 Neon (High)', 'Gemini 4 Neon (High)'],
    ['Gemini 4 Neon Low', 'Gemini 4 Neon Low'],
    ['Gemini 3.8 Flash (High)', 'Gemini 3.8 Flash (High)'],
    ['Claude Sonnet 4.6 (Thinking)', 'Claude Sonnet 4.6 (Thinking)'],
    ['Claude Opus 4.6 (Thinking)', 'Claude Opus 4.6 (Thinking)'],
    ['GPT-OSS 120B (Medium)', 'GPT-OSS 120B (Medium)'],
    ['gemini-4-hydrogen-tiered-xhigh', 'Gemini 4 Hydrogen (XHigh)'],
    ['gemini-4-hydrogen-high', 'Gemini 4 Hydrogen (High)'],
    ['gemini-4-neon-low', 'Gemini 4 Neon (Low)'],
    ['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'],
    ['gemini-4-carbon-disabled', 'Gemini 4 Carbon'],
    ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
    ['claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)'],
    ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'],
    ['MODEL_OPENAI_GPT_OSS_120B_MEDIUM', 'GPT-OSS 120B (Medium)'],
    ['MODEL_PLACEHOLDER_M531', 'Gemini Pro'],
    [{ model: 'pro', modelDisplayName: 'Gemini 4 Hydrogen (XHigh)' }, 'Gemini 4 Hydrogen (XHigh)'],
    [{ model: 'pro', resolvedModel: 'gemini-4-neon-low' }, 'Gemini 4 Neon (Low)'],
    [{ model: 'flash', modelDisplayName: '' }, 'Gemini Flash'],
  ];

  for (const [input, expected] of cases) {
    assert.equal(formatModelDisplay(input), expected, `lib formatModelDisplay(${JSON.stringify(input)})`);
    assert.equal(uiFormatModelDisplay(input), expected, `UI formatModelDisplay(${JSON.stringify(input)})`);
  }

  assert.equal(isTierAlias('pro'), true);
  assert.equal(isTierAlias('flash'), true);
  assert.equal(isTierAlias('flash_lite'), true);
  assert.equal(isTierAlias('gemini-4-hydrogen-xhigh'), false);

  assert.equal(isSameModelFamily('Gemini 4 Neon (Low)', 'gemini-4-neon-low'), true);
  assert.equal(isSameModelFamily('Gemini 4 Hydrogen (XHigh)', 'gemini-4-hydrogen-tiered-xhigh'), true);
  assert.equal(isSameModelFamily('Claude Sonnet 4.6 (Thinking)', 'claude-sonnet-4-6'), true);
  assert.equal(isSameModelFamily('Gemini 4 Hydrogen (High)', 'gemini-4-hydrogen-low'), false);

  // Verify UI templates wire modelDisplayName/resolvedModel and title tooltips
  assert.match(appSource, /th\.modelDisplayName\s*\|\|\s*th\.resolvedModel\s*\|\|\s*th\.model/);
  assert.match(appSource, /<span class="o2-wchip" title="\$\{esc\(modelLabel\)\}">/);
  assert.match(appSource, /<button type="button" id="btn-comp-model" class="\$\{modelBtnCls\}" title="\$\{esc\(modelTitle\)\}"/);
});

test('extractModelInfoFromGeneratorMetadata handles empty, single, trailing non-chat, and mid-thread switches', () => {
  assert.equal(extractModelInfoFromGeneratorMetadata({}), null);
  assert.equal(extractModelInfoFromGeneratorMetadata({ generatorMetadata: [] }), null);

  const single = extractModelInfoFromGeneratorMetadata({
    generatorMetadata: [
      {
        stepIndices: [1, 2],
        chatModel: {
          model: 'MODEL_PLACEHOLDER_M531',
          responseModel: 'gemini-4-hydrogen-tiered-xhigh',
          modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
        },
      },
    ],
  });
  assert.deepEqual(single, {
    displayName: 'Gemini 4 Hydrogen (XHigh)',
    responseModel: 'gemini-4-hydrogen-tiered-xhigh',
    modelEnum: 'MODEL_PLACEHOLDER_M531',
  });

  // Mid-thread switch + trailing non-chat entry
  const switched = extractModelInfoFromGeneratorMetadata({
    generatorMetadata: [
      {
        stepIndices: [1, 2],
        chatModel: {
          model: 'MODEL_PLACEHOLDER_M531',
          responseModel: 'gemini-4-hydrogen-tiered-xhigh',
          modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
        },
      },
      {
        stepIndices: [5, 6],
        chatModel: {
          model: 'MODEL_PLACEHOLDER_M35',
          responseModel: 'claude-sonnet-4-6',
          modelDisplayName: 'Claude Sonnet 4.6 (Thinking)',
        },
      },
      { stepIndices: [7] },
    ],
  });
  assert.deepEqual(switched, {
    displayName: 'Claude Sonnet 4.6 (Thinking)',
    responseModel: 'claude-sonnet-4-6',
    modelEnum: 'MODEL_PLACEHOLDER_M35',
  });
});

test('buildModelConfigLookup & resolveModelLabelFromLookup map enums and untiered/tiered slugs', () => {
  const lookup = buildModelConfigLookup({
    clientModelConfigs: [
      {
        label: 'Gemini 4 Hydrogen (XHigh)',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M528' },
        modelId: 'gemini-4-hydrogen-xhigh',
      },
      {
        label: 'Gemini 3.8 Flash (High)',
        modelOrAlias: { model: 'MODEL_PLACEHOLDER_M318' },
        modelId: 'gemini-3.8-flash-high',
      },
    ],
  });
  assert.equal(resolveModelLabelFromLookup('MODEL_PLACEHOLDER_M528', lookup), 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(resolveModelLabelFromLookup('gemini-4-hydrogen-tiered-xhigh', lookup), 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(resolveModelLabelFromLookup('gemini-3.8-flash-high', lookup), 'Gemini 3.8 Flash (High)');
  assert.equal(resolveModelLabelFromLookup('MODEL_PLACEHOLDER_M999', lookup), '');
});

test('extractModelFromSteps handles USER_SETTINGS_CHANGE, dots in model names, quoted tags, and mid-thread switches', () => {
  // 1. Ignores <USER_SETTINGS_CHANGE> inside <USER_REQUEST> and SYSTEM_MESSAGE
  const quotedOnly = extractModelFromSteps([
    {
      type: 'USER_INPUT',
      content:
        '<USER_REQUEST>Investigate <USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Fake Model (Low).\n</USER_SETTINGS_CHANGE></USER_REQUEST>',
    },
    {
      type: 'SYSTEM_MESSAGE',
      content:
        '[Message] content=[THREAD_COMPLETION_SYNC] <USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Neon (High).\n</USER_SETTINGS_CHANGE>',
    },
    { type: 'PLANNER_RESPONSE', model: 'gemini-4-hydrogen-tiered-xhigh', content: 'ok' },
  ]);
  assert.deepEqual(quotedOnly, {
    displayName: '',
    modelSlug: 'gemini-4-hydrogen-tiered-xhigh',
  });

  // 2. Preserves model names containing dots like "Gemini 3.8 Flash (High)"
  const dotted = extractModelFromSteps([
    {
      type: 'USER_INPUT',
      content:
        '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment on this change if the user doesn\'t ask about it.\n</USER_SETTINGS_CHANGE>\n<USER_REQUEST>Hi</USER_REQUEST>',
    },
    { type: 'PLANNER_RESPONSE', model: 'gemini-3.8-flash-high', content: 'Hello' },
  ]);
  assert.deepEqual(dotted, {
    displayName: 'Gemini 3.8 Flash (High)',
    modelSlug: 'gemini-3.8-flash-high',
  });

  // 3. Mid-thread model switch without new settings banner overrides stale settings display name
  const switchedPlanner = extractModelFromSteps([
    {
      type: 'USER_INPUT',
      content:
        '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Neon (Low). No need to comment.\n</USER_SETTINGS_CHANGE>',
    },
    { type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-low', content: 'step 1' },
    { type: 'PLANNER_RESPONSE', model: 'gemini-4-hydrogen-high', content: 'step 2' },
  ]);
  assert.deepEqual(switchedPlanner, {
    displayName: '',
    modelSlug: 'gemini-4-hydrogen-high',
  });

  // 4. Settings change after latest planner response wins
  const switchedSettingsAfter = extractModelFromSteps([
    { type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-low', content: 'step 1' },
    {
      type: 'USER_INPUT',
      content:
        '<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 4 Neon (Low) to Claude Opus 4.6 (Thinking). No need to comment.\n</USER_SETTINGS_CHANGE>',
    },
  ]);
  assert.deepEqual(switchedSettingsAfter, {
    displayName: 'Claude Opus 4.6 (Thinking)',
    modelSlug: 'gemini-4-neon-low',
  });
});

test('syncThreads and getThreadMessages resolve live models, mid-thread switches, and offline transcript fallback', async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'pt-thr004-'));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  const stateDir = join(appDataDir, 'project-threads');
  mkdirSync(stateDir, { recursive: true });

  const prevEnv = {
    ANTIGRAVITY_GEMINI_DIR: process.env.ANTIGRAVITY_GEMINI_DIR,
    ANTIGRAVITY_APP_DATA_DIR: process.env.ANTIGRAVITY_APP_DATA_DIR,
    ANTIGRAVITY_LS_ADDRESS: process.env.ANTIGRAVITY_LS_ADDRESS,
    ANTIGRAVITY_CSRF_TOKEN: process.env.ANTIGRAVITY_CSRF_TOKEN,
  };

  let mockState = {
    runState: 'RUN_STATE_RUNNING',
    updateTime: '2026-11-27T01:00:00Z',
    generatorMetadata: [],
    genMetaCalls: new Map(),
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/product.v1.ConversationService/GetConversation') {
        res.end(
          JSON.stringify({
            conversation: {
              id: payload.conversationId,
              state: {
                runState: mockState.runState,
                updateTime: mockState.updateTime,
              },
            },
          }),
        );
        return;
      }
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata') {
        const prev = mockState.genMetaCalls.get(payload.cascadeId) || 0;
        mockState.genMetaCalls.set(payload.cascadeId, prev + 1);
        res.end(JSON.stringify({ generatorMetadata: mockState.generatorMetadata }));
        return;
      }
      if (req.url === '/exa.language_server_pb.LanguageServerService/GetCascadeModelConfigData') {
        res.end(JSON.stringify({ clientModelConfigs: [] }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;

  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;
  process.env.ANTIGRAVITY_LS_ADDRESS = `127.0.0.1:${port}`;
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-token';

  t.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const convLiveId = 'conv-live-00000001';
  const convArchivedId = 'conv-arch-00000002';
  const convOfflineId = 'conv-offl-00000003';

  const reg = loadRegistry();
  reg.coordinators['__test__'] = {
    key: '__test__',
    conversationId: 'conv-coord-00000000',
    workspacePath: '',
    title: '[Coordinator] Test',
  };
  reg.threads['thr-001'] = {
    threadId: 'thr-001',
    conversationId: convLiveId,
    coordinatorId: 'conv-coord-00000000',
    workspaceKey: '__test__',
    title: 'Live thread',
    model: 'flash',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
    createdAt: '2026-11-27T01:00:00Z',
    updatedAt: '2026-11-27T01:00:00Z',
  };
  reg.threads['thr-002'] = {
    threadId: 'thr-002',
    conversationId: convArchivedId,
    coordinatorId: 'conv-coord-00000000',
    workspaceKey: '__test__',
    title: 'Archived thread',
    model: 'pro',
    modelDisplayName: 'Gemini 4 Neon (High)',
    runState: 'RUN_STATE_IDLE',
    archived: true,
    createdAt: '2026-11-26T01:00:00Z',
    updatedAt: '2026-11-26T01:00:00Z',
  };
  saveRegistry(reg);

  // Step 1: Before first generator step, fallback retains tier alias
  const snapBefore = await syncThreads({ allWorkspaces: true, includeArchived: true });
  const tBefore = snapBefore.threads.find((x) => x.threadId === 'thr-001');
  assert.equal(tBefore.model, 'flash');
  assert.equal(tBefore.modelDisplayName || '', '');
  assert.equal(formatModelDisplay(tBefore), 'Gemini Flash');
  // Archived thread with existing modelDisplayName must not be queried via LS
  assert.equal(mockState.genMetaCalls.get(convArchivedId) || 0, 0);

  // Step 2: Live RUNNING thread gets concrete modelDisplayName
  mockState.generatorMetadata = [
    {
      stepIndices: [1, 2],
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M531',
        responseModel: 'gemini-4-hydrogen-tiered-xhigh',
        modelDisplayName: 'Gemini 4 Hydrogen (XHigh)',
      },
    },
  ];
  mockState.updateTime = '2026-11-27T01:00:05Z';
  const snapLive = await syncThreads({ allWorkspaces: true });
  const tLive = snapLive.threads.find((x) => x.threadId === 'thr-001');
  assert.equal(tLive.modelDisplayName, 'Gemini 4 Hydrogen (XHigh)');
  assert.equal(tLive.resolvedModel, 'gemini-4-hydrogen-tiered-xhigh');
  assert.equal(formatModelDisplay(tLive), 'Gemini 4 Hydrogen (XHigh)');

  // Step 3: Mid-thread model switch while RUNNING updates via getThreadMessages() and persists
  mockState.generatorMetadata.push({
    stepIndices: [3, 4],
    chatModel: {
      model: 'MODEL_PLACEHOLDER_M536',
      responseModel: 'gemini-4-neon-low',
      modelDisplayName: 'Gemini 4 Neon (Low)',
    },
  });
  mockState.updateTime = '2026-11-27T01:00:10Z';
  const msgRes = await getThreadMessages({ threadId: 'thr-001' });
  assert.equal(msgRes.thread.modelDisplayName, 'Gemini 4 Neon (Low)');
  assert.match(msgRes.stamp, /\|m:Gemini 4 Neon \(Low\)\|/);

  // Step 4: Offline fallback via transcript.jsonl when LS is unreachable
  const txDir = join(appDataDir, 'brain', convOfflineId, '.system_generated', 'logs');
  mkdirSync(txDir, { recursive: true });
  writeFileSync(
    join(txDir, 'transcript.jsonl'),
    [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>Offline task</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        model: 'gemini-4-carbon-medium',
        content: 'Done offline',
      }),
    ].join('\n'),
    'utf8',
  );

  const reg2 = loadRegistry();
  reg2.threads['thr-003'] = {
    threadId: 'thr-003',
    conversationId: convOfflineId,
    coordinatorId: 'conv-coord-00000000',
    workspaceKey: '__test__',
    title: 'Offline thread',
    model: 'pro',
    runState: 'RUN_STATE_IDLE',
    archived: false,
    createdAt: '2026-11-27T01:01:00Z',
    updatedAt: '2026-11-27T01:01:00Z',
  };
  saveRegistry(reg2);

  // Simulate LS offline
  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:1';
  const offlineCheck = await getThreadGeneratorModel(convOfflineId, 400);
  assert.equal(offlineCheck.ok, false);
  assert.deepEqual(extractTranscriptModel(convOfflineId), {
    displayName: '',
    modelSlug: 'gemini-4-carbon-medium',
  });

  const snapOffline = await syncThreads({ allWorkspaces: true });
  const tOffline = snapOffline.threads.find((x) => x.threadId === 'thr-003');
  assert.equal(tOffline.modelDisplayName, 'Gemini 4 Carbon (Medium)');
  assert.equal(tOffline.resolvedModel, 'gemini-4-carbon-medium');
  assert.equal(formatModelDisplay(tOffline), 'Gemini 4 Carbon (Medium)');
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { extractUsageFromGeneratorMetadata } from '../lib/ls-client.mjs';
import { extractTranscriptUsage, extractUsageFromSteps } from '../lib/transcript.mjs';

function extractFunctionSource(source, fnName) {
  const start = source.indexOf(`function ${fnName}(`);
  assert.notEqual(start, -1, `${fnName} must exist in sidecars/threads/app.js`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  assert.notEqual(bodyStart, -1, `Could not find body brace for ${fnName}`);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`Could not find closing brace for ${fnName}`);
}

function loadUiTelemetryHelpers() {
  const appSource = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const cssSource = readFileSync(new URL('../sidecars/threads/theme.css', import.meta.url), 'utf8');

  const formatFnCode = extractFunctionSource(appSource, 'formatTokenCount');
  const renderFnCode = extractFunctionSource(appSource, 'renderThreadUsageRow');

  const i18nStart = appSource.indexOf('const I18N = {');
  assert.notEqual(i18nStart, -1, 'I18N object must exist');
  let depth = 0;
  let inBrace = false;
  let i18nEnd = -1;
  for (let i = i18nStart; i < appSource.length; i++) {
    const ch = appSource[i];
    if (ch === '{') {
      depth++;
      inBrace = true;
    } else if (ch === '}') {
      depth--;
      if (inBrace && depth === 0) {
        i18nEnd = i + 1;
        break;
      }
    }
  }
  assert.notEqual(i18nEnd, -1, 'Could not find closing brace for I18N');
  const i18nCode = appSource.slice(i18nStart, i18nEnd);

  const ctx = {};
  vm.runInNewContext(
    `
    ${i18nCode};
    let curLocale = 'zh-CN';
    const L = () => I18N[curLocale] || I18N.en;
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    ${formatFnCode}
    ${renderFnCode}
    this.I18N = I18N;
    this.setLocale = (loc) => { curLocale = loc; };
    this.formatTokenCount = formatTokenCount;
    this.renderThreadUsageRow = renderThreadUsageRow;
    `,
    ctx,
  );

  return {
    appSource,
    cssSource,
    I18N: ctx.I18N,
    setLocale: ctx.setLocale,
    formatTokenCount: ctx.formatTokenCount,
    renderThreadUsageRow: ctx.renderThreadUsageRow,
  };
}

test('formatTokenCount formats integers, K, M, and handles zero/invalid inputs safely', () => {
  const { formatTokenCount } = loadUiTelemetryHelpers();

  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(-42), '0');
  assert.equal(formatTokenCount(NaN), '0');
  assert.equal(formatTokenCount(Infinity), '0');
  assert.equal(formatTokenCount(null), '0');
  assert.equal(formatTokenCount(undefined), '0');

  assert.equal(formatTokenCount(850), '850');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1K');
  assert.equal(formatTokenCount(12400), '12.4K');
  assert.equal(formatTokenCount(114000), '114K');
  assert.equal(formatTokenCount(512000), '512K');
  assert.equal(formatTokenCount(820000), '0.82M');
  assert.equal(formatTokenCount(1250000), '1.25M');
  assert.equal(formatTokenCount(12500000), '12.5M');
  assert.equal(formatTokenCount(512000, { millionThreshold: 1_000_000 }), '512K');
  assert.equal(formatTokenCount(1000000, { millionThreshold: 1_000_000 }), '1M');
});

test('extractUsageFromGeneratorMetadata computes totals, context occupancy, compactPercent, and compactCount', () => {
  assert.equal(extractUsageFromGeneratorMetadata(null), null);
  assert.equal(extractUsageFromGeneratorMetadata({ generatorMetadata: [] }), null);
  assert.equal(
    extractUsageFromGeneratorMetadata({ generatorMetadata: [{ stepIndices: [1], chatModel: {} }] }),
    null,
  );

  const res = extractUsageFromGeneratorMetadata({
    generatorMetadata: [
      {
        stepIndices: [1],
        chatModel: {
          modelDisplayName: 'Gemini 4 Neon (Medium)',
          usage: { inputTokens: '50000', cacheReadTokens: '150000', outputTokens: '2000' },
          chatStartMetadata: {
            checkpointIndex: -1,
            contextWindowMetadata: { estimatedTokensUsed: 198000, maxContextTokens: 512000 },
          },
        },
      },
      {
        stepIndices: [2],
        chatModel: {
          modelDisplayName: 'Gemini 4 Neon (Medium)',
          usage: { inputTokens: '14000', cacheReadTokens: '100000', outputTokens: '1500' },
          chatStartMetadata: {
            checkpointIndex: 0,
            contextWindowMetadata: { estimatedTokensUsed: 120000, maxContextTokens: 512000 },
          },
        },
      },
    ],
  });

  assert.deepEqual(res, {
    totalTokens: 50000 + 150000 + 2000 + 14000 + 100000 + 1500,
    inputTokens: 64000,
    outputTokens: 3500,
    cacheReadTokens: 250000,
    contextTokens: 114000,
    compactLimit: 512000,
    compactPercent: 22,
    compactCount: 1,
    source: 'ls',
  });

  // Compaction detected purely from sharp context drop (when checkpointIndex stays -1)
  const dropOnly = extractUsageFromGeneratorMetadata({
    generatorMetadata: [
      {
        chatModel: {
          modelDisplayName: 'Gemini 4 Neon (High)',
          usage: { inputTokens: '10000', cacheReadTokens: '390000', outputTokens: '1000' },
          chatStartMetadata: {
            checkpointIndex: -1,
            contextWindowMetadata: { maxContextTokens: 512000 },
          },
        },
      },
      {
        chatModel: {
          modelDisplayName: 'Gemini 4 Neon (High)',
          usage: { inputTokens: '5000', cacheReadTokens: '110000', outputTokens: '800' },
          chatStartMetadata: {
            checkpointIndex: -1,
            contextWindowMetadata: { maxContextTokens: 512000 },
          },
        },
      },
    ],
  });
  assert.equal(dropOnly.compactCount, 1);
  assert.equal(dropOnly.contextTokens, 115000);
  assert.equal(dropOnly.compactPercent, 22);
});

test('extractUsageFromSteps and extractTranscriptUsage aggregate transcript.jsonl tokens and compactions', () => {
  assert.equal(extractUsageFromSteps([]), null);

  const steps = [
    { type: 'USER_INPUT', content: 'hello' },
    {
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-neon-medium',
      input_tokens: 40000,
      cache_read_tokens: 180000,
      output_tokens: 1200,
    },
    { type: 'CHECKPOINT', step_index: 5 },
    {
      type: 'PLANNER_RESPONSE',
      model: 'gemini-4-neon-medium',
      input_tokens: 10000,
      cache_read_tokens: 90000,
      output_tokens: 800,
    },
  ];
  const parsed = extractUsageFromSteps(steps);
  assert.deepEqual(parsed, {
    totalTokens: 322000,
    inputTokens: 50000,
    outputTokens: 2000,
    cacheReadTokens: 270000,
    contextTokens: 100000,
    compactLimit: 0,
    compactPercent: null,
    compactCount: 1,
    source: 'transcript',
  });

  const dir = mkdtempSync(join(tmpdir(), 'pt-usage-tx-'));
  try {
    const txFile = join(dir, 'transcript.jsonl');
    writeFileSync(txFile, steps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
    const fromFile = extractTranscriptUsage('conv-test-usage', txFile);
    assert.deepEqual(fromFile, parsed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Sidecar telemetry row renders compactly across en/zh-CN/zh-TW, color-codes progress, and avoids middle dot & native dialogs', () => {
  const { appSource, cssSource, I18N, setLocale, renderThreadUsageRow } = loadUiTelemetryHelpers();

  // Empty / missing usage renders nothing
  assert.equal(renderThreadUsageRow({}), '');
  assert.equal(renderThreadUsageRow({ usage: { totalTokens: 0, contextTokens: 0 } }), '');

  const sampleThread = {
    usage: {
      totalTokens: 820000,
      inputTokens: 120000,
      outputTokens: 20000,
      cacheReadTokens: 680000,
      contextTokens: 114000,
      compactLimit: 512000,
      compactPercent: 22,
      compactCount: 0,
    },
  };

  // zh-CN
  setLocale('zh-CN');
  const zhCnHtml = renderThreadUsageRow(sampleThread);
  assert.match(zhCnHtml, /o2-th-usage/);
  assert.match(zhCnHtml, /Tokens/);
  assert.match(zhCnHtml, /0\.82M/);
  assert.match(zhCnHtml, /压缩线/);
  assert.match(zhCnHtml, /114K \/ 512K \(22%\)/);
  assert.match(zhCnHtml, /0 次压缩/);
  assert.match(zhCnHtml, /class="ok" style="width:22%"/);
  assert.equal(zhCnHtml.includes('·'), false, 'Telemetry row must never use middle dot separator');

  // zh-TW + warn threshold (70-89%) + non-zero compacts
  setLocale('zh-TW');
  const zhTwHtml = renderThreadUsageRow({
    usage: { ...sampleThread.usage, contextTokens: 400000, compactPercent: 78, compactCount: 2 },
  });
  assert.match(zhTwHtml, /壓縮線/);
  assert.match(zhTwHtml, /2 次壓縮/);
  assert.match(zhTwHtml, /class="warn" style="width:78%"/);
  assert.match(zhTwHtml, /has-compacts/);
  assert.equal(zhTwHtml.includes('·'), false, 'zh-TW telemetry row must never use middle dot');

  // en + danger threshold (>=90%) + singular compact
  setLocale('en');
  const enHtml = renderThreadUsageRow({
    usage: { ...sampleThread.usage, contextTokens: 480000, compactPercent: 94, compactCount: 1 },
  });
  assert.match(enHtml, /Compact line/);
  assert.match(enHtml, /1 compact</);
  assert.match(enHtml, /class="danger" style="width:94%"/);
  assert.equal(enHtml.includes('·'), false, 'en telemetry row must never use middle dot');

  // Low non-zero percent keeps visible fill (no data-empty); 0% marks data-empty="true"
  setLocale('zh-CN');
  const lowPctHtml = renderThreadUsageRow({
    usage: { ...sampleThread.usage, totalTokens: 33500, contextTokens: 18600, compactPercent: 4, compactCount: 0 },
  });
  assert.match(lowPctHtml, /class="ok" style="width:4%">/);
  assert.equal(lowPctHtml.includes('data-empty'), false);
  const zeroPctHtml = renderThreadUsageRow({
    usage: { ...sampleThread.usage, totalTokens: 1200, contextTokens: 200, compactPercent: 0, compactCount: 0 },
  });
  assert.match(zeroPctHtml, /class="ok" style="width:0%" data-empty="true"/);

  // Static assertions for I18N keys, CSS rules, and no native confirm/alert/prompt
  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    assert.ok(I18N[loc].usageTokensLabel, `Missing usageTokensLabel in ${loc}`);
    assert.ok(I18N[loc].usageCompactLine, `Missing usageCompactLine in ${loc}`);
    assert.equal(typeof I18N[loc].usageCompacts, 'function', `Missing usageCompacts in ${loc}`);
    assert.equal(typeof I18N[loc].usageDetailTip, 'function', `Missing usageDetailTip in ${loc}`);
  }

  assert.match(appSource, /\$\{usageHtml\}\s*\n\s*<div class="o2-th-actions">/);
  assert.match(cssSource, /\.o2-th-usage\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;/s);
  assert.match(cssSource, /\.o2-usage-val\s*\{[^}]*font-weight:\s*500;/s);
  assert.match(cssSource, /\.o2-usage-bar\s*>\s*i\s*\{[^}]*min-width:\s*6px;/s);
  assert.match(cssSource, /\.o2-usage-bar\s*>\s*i\[data-empty="true"\][^}]*min-width:\s*0;/s);
  assert.match(cssSource, /\.o2-usage-bar\s*>\s*i\.ok\s*\{/);
  assert.match(cssSource, /\.o2-usage-bar\s*>\s*i\.warn\s*\{/);
  assert.match(cssSource, /\.o2-usage-bar\s*>\s*i\.danger\s*\{/);
  assert.match(cssSource, /\.o2-usage-pill\s*\{[^}]*border:\s*0;/s);
  assert.match(cssSource, /:root\[data-theme="light"\]\s+\.o2-usage-pill\s*\{/);
  assert.equal(
    /\bwindow\.(?:confirm|alert|prompt)\s*\(/.test(appSource),
    false,
    'Sidecar UI must never call native window.confirm/alert/prompt',
  );
});

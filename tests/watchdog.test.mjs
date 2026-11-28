import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// Import watchdog FIRST to also verify circular-safe ESM initialization order with store.mjs
import {
  WATCHDOG_DEFAULTS,
  WATCHDOG_LIMITS,
  buildStallAlertMessage,
  consumePendingWatchdogAlertsForPreInvocation,
  createWatchdogScheduler,
  evaluateThreadWatchdogState,
  getThreadWatchdogSummary,
  getWatchdogStatus,
  mergeWatchdogStateMaps,
  normalizeWatchdogConfig,
  patrolProjectScope,
  resolveEffectiveWatchdogConfig,
  snoozeWatchdogThread,
  triggerWatchdogPatrol,
} from '../lib/watchdog.mjs';
import {
  archiveThread,
  buildBoardDecisions,
  buildFallbackEffectiveSettings,
  dismissDecision,
  getEffectiveSettings,
  loadRegistry,
  loadSettings,
  mutateRegistry,
  normalizeKey,
  rebindCoordinator,
  saveRegistry,
  saveSettings,
  saveSettingsWithFastResponse,
  syncThreads,
} from '../lib/store.mjs';
import { resetModelConfigCache } from '../lib/ls-client.mjs';

function createTempEnv(t, prefix = 'pt-wd-') {
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

function makeTranscript(appDataDir, convId, lines, mtimeMs = null) {
  const dir = join(appDataDir, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'transcript.jsonl');
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  if (typeof mtimeMs === 'number' && Number.isFinite(mtimeMs)) {
    const dt = new Date(mtimeMs);
    utimesSync(file, dt, dt);
  }
  return file;
}

function seedProject(reg, { repoPath, coordConvId, projectId = '', retiredCoordinatorIds = [] }) {
  const wk = normalizeKey(repoPath);
  reg.coordinators[wk] = {
    key: wk,
    conversationId: coordConvId,
    workspacePath: repoPath,
    repoRoot: repoPath,
    projectId,
    title: `[Coordinator] ${repoPath.split(/[\\/]/).pop()}`,
    directiveVersion: 16,
    rebindSeq: retiredCoordinatorIds.length,
    ...(retiredCoordinatorIds.length ? { retiredCoordinatorIds } : {}),
  };
  return wk;
}

test('Issue #6: Watchdog config normalization clamps bounds, preserves global defaults + per-project overrides, and isolates section resets', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-wd-cfg-');
  const repoA = join(tempRoot, 'proj-a');
  mkdirSync(repoA, { recursive: true });
  const wkA = normalizeKey(repoA);

  // 1. Out-of-bounds clamping & relational invariants (bgTask >= stall, escalated >= cooldown)
  const clampedLow = normalizeWatchdogConfig({
    enabled: 'false',
    patrolIntervalSec: 1,
    stallThresholdMin: 30,
    bgTaskThresholdMin: 5,
    mismatchGraceMin: 0,
    startupGraceSec: 1,
    cooldownMin: 40,
    escalatedCooldownMin: 10,
    defaultSnoozeMin: 1,
  });
  assert.equal(clampedLow.enabled, false);
  assert.equal(clampedLow.patrolIntervalSec, WATCHDOG_LIMITS.patrolIntervalSec.min);
  assert.equal(clampedLow.stallThresholdMin, 30);
  assert.equal(clampedLow.bgTaskThresholdMin, 30, 'bgTaskThresholdMin must be >= stallThresholdMin');
  assert.equal(clampedLow.mismatchGraceMin, WATCHDOG_LIMITS.mismatchGraceMin.min);
  assert.equal(clampedLow.startupGraceSec, WATCHDOG_LIMITS.startupGraceSec.min);
  assert.equal(clampedLow.cooldownMin, 40);
  assert.equal(clampedLow.escalatedCooldownMin, 40, 'escalatedCooldownMin must be >= cooldownMin');
  assert.equal(clampedLow.defaultSnoozeMin, WATCHDOG_LIMITS.defaultSnoozeMin.min);

  const clampedHigh = normalizeWatchdogConfig({
    patrolIntervalSec: 9999,
    stallThresholdMin: 999,
    bgTaskThresholdMin: 999,
    mismatchGraceMin: 999,
    cooldownMin: 999,
    escalatedCooldownMin: 999,
  });
  assert.equal(clampedHigh.patrolIntervalSec, WATCHDOG_LIMITS.patrolIntervalSec.max);
  assert.equal(clampedHigh.stallThresholdMin, WATCHDOG_LIMITS.stallThresholdMin.max);
  assert.equal(clampedHigh.bgTaskThresholdMin, WATCHDOG_LIMITS.bgTaskThresholdMin.max);
  assert.equal(clampedHigh.mismatchGraceMin, WATCHDOG_LIMITS.mismatchGraceMin.max);
  assert.equal(clampedHigh.cooldownMin, WATCHDOG_LIMITS.cooldownMin.max);
  assert.equal(clampedHigh.escalatedCooldownMin, WATCHDOG_LIMITS.escalatedCooldownMin.max);

  // 2. Global + per-project persistence without interfering with model overrides
  saveSettings({
    scope: 'global',
    section: 'watchdog',
    watchdog: { enabled: true, patrolIntervalSec: 25, stallThresholdMin: 8 },
  });
  saveSettings({
    scope: 'project',
    workspaceKey: wkA,
    worktreeModel: 'gemini-4-neon-xhigh',
  });
  saveSettings({
    scope: 'project',
    section: 'watchdog',
    workspaceKey: wkA,
    watchdog: { enabled: false, stallThresholdMin: 15 },
  });

  const saved = loadSettings();
  assert.equal(saved.watchdog.patrolIntervalSec, 25);
  assert.equal(saved.watchdog.stallThresholdMin, 8);
  assert.equal(saved.projects[wkA].worktreeModel, 'gemini-4-neon-xhigh');
  assert.equal(saved.projects[wkA].watchdog.enabled, false);
  assert.equal(saved.projects[wkA].watchdog.stallThresholdMin, 15);
  assert.equal(saved.projects[wkA].watchdog.patrolIntervalSec, undefined);

  const effA = resolveEffectiveWatchdogConfig(saved, wkA, repoA);
  assert.equal(effA.source, 'project');
  assert.equal(effA.hasProjectOverride, true);
  assert.equal(effA.enabled, false);
  assert.equal(effA.stallThresholdMin, 15);
  assert.equal(effA.patrolIntervalSec, 25, 'non-overridden field inherits global');

  // 3. Resetting watchdog section preserves model override; resetting models preserves watchdog
  saveSettings({ scope: 'project', section: 'watchdog', workspaceKey: wkA, reset: true });
  let afterResetWd = loadSettings();
  assert.equal(afterResetWd.projects[wkA].worktreeModel, 'gemini-4-neon-xhigh');
  assert.equal(afterResetWd.projects[wkA].watchdog, undefined);

  // Fast response endpoint supports watchdog section cleanly
  const fastRes = await saveSettingsWithFastResponse({
    scope: 'project',
    section: 'watchdog',
    workspaceKey: wkA,
    watchdog: { stallThresholdMin: 12, cooldownMin: 6 },
  });
  assert.equal(fastRes.ok, true);
  assert.equal(fastRes.effective.watchdog.stallThresholdMin, 12);
  assert.equal(fastRes.effective.watchdog.cooldownMin, 6);
  assert.equal(fastRes.effective.watchdog.hasProjectOverride, true);

  // Clearing models leaves watchdog project entry intact; clearing watchdog afterwards removes empty project entry
  saveSettings({ scope: 'project', section: 'models', workspaceKey: wkA, reset: true });
  assert.ok(loadSettings().projects[wkA]?.watchdog);
  saveSettings({ scope: 'project', section: 'watchdog', workspaceKey: wkA, reset: true });
  assert.equal(loadSettings().projects[wkA], undefined);

  // Effective & fallback effective settings expose watchdog cleanly
  const fallbackEff = buildFallbackEffectiveSettings(loadSettings(), { scopeKey: wkA });
  assert.equal(fallbackEff.watchdog.patrolIntervalSec, 25);
  const fullEff = await getEffectiveSettings({ workspaceKey: wkA, fast: true, skipScopeResolve: true });
  assert.equal(fullEff.watchdog.stallThresholdMin, 8);
});

test('Issue #6: Zero-overhead skip on unbound / idle-only / disabled projects and zero false positives for grace period, progress, and long bg tasks', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-wd-zero-fp-');
  const repoA = join(tempRoot, 'proj-a');
  mkdirSync(repoA, { recursive: true });
  // Anchor relative to Date.now() so real peekLiveActivity() 45m bg-task TTL matches wall clock
  const baseMs = Date.now();

  let lsCalls = 0;
  let alertCalls = 0;
  const mockDeps = (nowRef, convStates = {}) => ({
    now: () => nowRef.ms,
    getConversation: async (convId) => {
      lsCalls++;
      return { conversation: { id: convId, state: convStates[convId] || { runState: 'RUN_STATE_IDLE' } } };
    },
    invokeAgentApiSend: async () => {
      alertCalls++;
      return { queued: true };
    },
  });

  // 1. Unbound scope -> skipped with zero RPCs
  const wkA = normalizeKey(repoA);
  const nowRef = { ms: baseMs };
  const unboundRes = await patrolProjectScope(wkA, { deps: mockDeps(nowRef) });
  assert.equal(unboundRes.skipped, true);
  assert.equal(unboundRes.reason, 'no_coordinator');
  assert.equal(lsCalls, 0);
  assert.equal(alertCalls, 0);

  // 2. Bound scope with ONLY IDLE + archived threads -> zero RPCs
  const reg = loadRegistry();
  seedProject(reg, { repoPath: repoA, coordConvId: 'conv-coord-a' });
  reg.threads['thr-001'] = {
    threadId: 'thr-001',
    conversationId: 'conv-thr-001',
    coordinatorId: 'conv-coord-a',
    workspaceKey: wkA,
    title: 'Completed task',
    runState: 'RUN_STATE_IDLE',
    bucket: 'idle',
    lastSummary: 'All done',
    archived: false,
    createdAt: new Date(baseMs - 3600_000).toISOString(),
    updatedAt: new Date(baseMs - 1800_000).toISOString(),
  };
  reg.threads['thr-002'] = {
    threadId: 'thr-002',
    conversationId: 'conv-thr-002',
    coordinatorId: 'conv-coord-a',
    workspaceKey: wkA,
    title: 'Archived running ghost',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    archived: true,
    createdAt: new Date(baseMs - 3600_000).toISOString(),
    updatedAt: new Date(baseMs - 3600_000).toISOString(),
  };
  saveRegistry(reg);

  const idleOnlyRes = await patrolProjectScope(wkA, { deps: mockDeps(nowRef) });
  assert.equal(idleOnlyRes.skipped, true);
  assert.equal(idleOnlyRes.reason, 'no_active_threads');
  assert.equal(lsCalls, 0);
  assert.equal(alertCalls, 0);

  // 3. Startup grace period (created 40s ago < 90s grace) -> zero false positive
  const freshThread = {
    threadId: 'thr-003',
    conversationId: 'conv-thr-003',
    coordinatorId: 'conv-coord-a',
    workspaceKey: wkA,
    title: 'Just started',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    archived: false,
    createdAt: new Date(baseMs - 40_000).toISOString(),
    updatedAt: new Date(baseMs - 40_000).toISOString(),
  };
  const graceEval = evaluateThreadWatchdogState({
    thread: freshThread,
    signals: {
      runState: 'RUN_STATE_RUNNING',
      bucket: 'working',
      toolStepCount: 0,
      liveHasPendingBgTask: false,
      transcriptStat: { exists: false, size: 0, mtimeMs: 0 },
    },
    config: { ...WATCHDOG_DEFAULTS, stallThresholdMin: 2, startupGraceSec: 90 },
    nowMs: baseMs,
  });
  assert.equal(graceEval.stalled, false);
  assert.equal(graceEval.skipReason, 'startup_grace');

  // 4. Verified long-running background task (12m elapsed, stallThreshold=10m, bgTaskThreshold=20m) -> EXEMPT!
  makeTranscript(
    appDataDir,
    'conv-thr-bg',
    [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Run full test suite</USER_REQUEST>', created_at: new Date(baseMs - 13 * 60_000).toISOString() },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test', toolSummary: 'Unit tests' } }],
        created_at: new Date(baseMs - 12 * 60_000).toISOString(),
      },
      {
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        content: 'Tool is running as a background task with task id: conv-thr-bg/task-1',
        created_at: new Date(baseMs - 12 * 60_000).toISOString(),
      },
    ],
    baseMs - 12 * 60_000,
  );

  mutateRegistry((r) => {
    r.threads['thr-bg'] = {
      threadId: 'thr-bg',
      conversationId: 'conv-thr-bg',
      coordinatorId: 'conv-coord-a',
      workspaceKey: wkA,
      title: 'Long build task',
      runState: 'RUN_STATE_IDLE',
      hasPendingBgTask: true,
      bucket: 'working',
      archived: false,
      createdAt: new Date(baseMs - 13 * 60_000).toISOString(),
      updatedAt: new Date(baseMs - 12 * 60_000).toISOString(),
    };
  });

  const bgExemptRes = await patrolProjectScope(wkA, {
    deps: mockDeps(nowRef, {
      'conv-thr-bg': { runState: 'RUN_STATE_IDLE', updateTime: new Date(baseMs - 12 * 60_000).toISOString() },
      'conv-coord-a': { runState: 'RUN_STATE_IDLE' },
    }),
  });
  assert.equal(bgExemptRes.stalledCount, 0, 'Verified bg task at 12m must NOT trigger 10m stall or 2m mismatch');
  assert.equal(alertCalls, 0);

  // Advance to 21m with zero bg task progress -> NOW triggers no_progress_bg_task!
  nowRef.ms = baseMs + 9 * 60_000;
  const bgStalledRes = await patrolProjectScope(wkA, {
    deps: mockDeps(nowRef, {
      'conv-thr-bg': { runState: 'RUN_STATE_IDLE', updateTime: new Date(baseMs - 12 * 60_000).toISOString() },
      'conv-coord-a': { runState: 'RUN_STATE_IDLE' },
    }),
  });
  assert.equal(bgStalledRes.stalledCount, 1);
  assert.equal(bgStalledRes.alertedCount, 1);
  assert.equal(bgStalledRes.results[0].stallReason, 'no_progress_bg_task');
  assert.equal(alertCalls, 1);

  // 5. Disabled per-project watchdog skips automatic patrol with zero RPCs
  saveSettings({ scope: 'project', section: 'watchdog', workspaceKey: wkA, watchdog: { enabled: false } });
  const beforeLs = lsCalls;
  const disabledRes = await patrolProjectScope(wkA, { deps: mockDeps(nowRef) });
  assert.equal(disabledRes.skipped, true);
  assert.equal(disabledRes.reason, 'disabled');
  assert.equal(lsCalls, beforeLs);
});

test('Issue #6: Real stall triggers alert, respects stepped cooldown (10m -> 30m), auto-resets on progress/recovery, and prevents tombstone resurrection', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-wd-lifecycle-');
  const repoA = join(tempRoot, 'proj-life');
  mkdirSync(repoA, { recursive: true });
  const wkA = normalizeKey(repoA);
  const t0 = Date.parse('2026-11-28T11:00:00.000Z');
  const nowRef = { ms: t0 };

  const reg = loadRegistry();
  seedProject(reg, { repoPath: repoA, coordConvId: 'conv-coord-life' });
  reg.threads['thr-stuck'] = {
    threadId: 'thr-stuck',
    projectSeq: 1,
    localId: '#1',
    conversationId: 'conv-thr-stuck',
    coordinatorId: 'conv-coord-life',
    workspaceKey: wkA,
    title: 'Fix database migration',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    archived: false,
    createdAt: new Date(t0 - 15 * 60_000).toISOString(),
    updatedAt: new Date(t0 - 12 * 60_000).toISOString(),
  };
  saveRegistry(reg);

  const txLines = [
    { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Fix migration</USER_REQUEST>', created_at: new Date(t0 - 15 * 60_000).toISOString() },
    { step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: { Path: '/a.sql' } }], created_at: new Date(t0 - 12 * 60_000).toISOString() },
    { step_index: 2, type: 'GENERIC', status: 'DONE', content: 'SELECT 1;', created_at: new Date(t0 - 12 * 60_000).toISOString() },
  ];
  makeTranscript(appDataDir, 'conv-thr-stuck', txLines, t0 - 12 * 60_000);

  const sentAlerts = [];
  const makeDeps = (threadRunState = 'RUN_STATE_RUNNING', threadUpdatedMs = t0 - 12 * 60_000) => ({
    now: () => nowRef.ms,
    getConversation: async (cid) => ({
      conversation: {
        id: cid,
        state:
          cid === 'conv-coord-life'
            ? { runState: 'RUN_STATE_IDLE' }
            : { runState: threadRunState, updateTime: new Date(threadUpdatedMs).toISOString() },
      },
    }),
    invokeAgentApiSend: async (args) => {
      sentAlerts.push({ ...args, at: nowRef.ms });
      return { queued: true };
    },
  });

  // 1. First patrol at 12m idle -> triggers alert #1 + surfaces board watchdog & Pending Decisions card
  const r1 = await patrolProjectScope(wkA, { deps: makeDeps() });
  assert.equal(r1.stalledCount, 1);
  assert.equal(r1.alertedCount, 1);
  assert.equal(r1.results[0].stallReason, 'no_progress_running');
  assert.equal(sentAlerts.length, 1);
  assert.equal(sentAlerts[0].conversationId, 'conv-coord-life');
  assert.match(sentAlerts[0].message, /\[THREAD_STALL_ALERT\]/);
  assert.match(sentAlerts[0].message, /thr-stuck/);

  const wdSum1 = getThreadWatchdogSummary(loadRegistry(), wkA, 'thr-stuck', nowRef.ms);
  assert.equal(wdSum1.stalled, true);
  assert.equal(wdSum1.alertCount, 1);

  const decisions1 = buildBoardDecisions({ workspaceKey: wkA });
  const stallDec = decisions1.find((d) => d.autoKind === 'watchdog_stalled' && d.threadId === 'thr-stuck');
  assert.ok(stallDec, 'Stalled thread must automatically surface in Pending Decisions');

  // 2. Patrol 5m later (within 10m cooldown) -> ZERO duplicate alerts
  nowRef.ms = t0 + 5 * 60_000;
  const r2 = await patrolProjectScope(wkA, { deps: makeDeps() });
  assert.equal(r2.stalledCount, 1);
  assert.equal(r2.alertedCount, 0, 'Must suppress duplicate alert during 10m cooldown');
  assert.equal(sentAlerts.length, 1);

  // 3. Patrol at +11m (past 10m cooldown) -> sends alert #2 & enters 30m escalated cooldown
  nowRef.ms = t0 + 11 * 60_000;
  const r3 = await patrolProjectScope(wkA, { deps: makeDeps() });
  assert.equal(r3.alertedCount, 1, 'Must send escalated alert #2 after 10m cooldown');
  assert.equal(sentAlerts.length, 2);

  // 4. Patrol at +30m (19m after alert #2 < 30m escalated cooldown) -> suppressed!
  nowRef.ms = t0 + 30 * 60_000;
  const r4 = await patrolProjectScope(wkA, { deps: makeDeps() });
  assert.equal(r4.alertedCount, 0, 'Must suppress duplicate alert during 30m escalated cooldown');
  assert.equal(sentAlerts.length, 2);

  // 5. Patrol at +42m (31m after alert #2 >= 30m escalated cooldown) -> sends alert #3!
  nowRef.ms = t0 + 42 * 60_000;
  const r5 = await patrolProjectScope(wkA, { deps: makeDeps() });
  assert.equal(r5.alertedCount, 1);
  assert.equal(sentAlerts.length, 3);

  // 6. Thread makes forward progress (new step + transcript growth) -> auto-resets stall & alertCount!
  nowRef.ms = t0 + 43 * 60_000;
  txLines.push(
    { step_index: 3, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'edit_file', args: { Path: '/a.sql' } }], created_at: new Date(nowRef.ms).toISOString() },
    { step_index: 4, type: 'GENERIC', status: 'DONE', content: 'Updated migration', created_at: new Date(nowRef.ms).toISOString() },
  );
  makeTranscript(appDataDir, 'conv-thr-stuck', txLines, nowRef.ms);
  const rRecover = await patrolProjectScope(wkA, {
    deps: makeDeps('RUN_STATE_RUNNING', nowRef.ms),
  });
  assert.equal(rRecover.stalledCount, 0);
  assert.equal(rRecover.recoveredCount, 1);
  assert.equal(getThreadWatchdogSummary(loadRegistry(), wkA, 'thr-stuck', nowRef.ms), null);
  const decisionsAfter = buildBoardDecisions({ workspaceKey: wkA });
  assert.equal(
    decisionsAfter.some((d) => d.autoKind === 'watchdog_stalled' && d.threadId === 'thr-stuck'),
    false,
    'Auto stall decision card must clear once thread recovers',
  );

  // 7. Tombstone merge invariant: stale disk stalled snapshot cannot resurrect newer cleared entry
  const staleDisk = {
    [wkA]: {
      scopeKey: wkA,
      coordinatorId: 'conv-coord-life',
      updatedAt: '2026-11-28T11:00:00.000Z',
      threads: {
        'thr-stuck': {
          state: 'stalled',
          stalled: true,
          stallReason: 'no_progress_running',
          updatedAt: '2026-11-28T11:00:00.000Z',
        },
      },
    },
  };
  const newerMem = {
    [wkA]: {
      scopeKey: wkA,
      coordinatorId: 'conv-coord-life',
      updatedAt: '2026-11-28T11:05:00.000Z',
      threads: {
        'thr-stuck': {
          state: 'cleared',
          stalled: false,
          stallReason: '',
          updatedAt: '2026-11-28T11:05:00.000Z',
        },
      },
    },
  };
  const merged = mergeWatchdogStateMaps(newerMem, staleDisk, Date.parse('2026-11-28T11:06:00.000Z'));
  assert.equal(merged[wkA].threads['thr-stuck'].state, 'cleared', 'Newer cleared tombstone must beat stale disk stalled state');
  assert.equal(merged[wkA].threads['thr-stuck'].stalled, false);
});

test('Issue #6: State mismatch (IDLE + working without bg task) and silent exit detection work cleanly', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-wd-mismatch-');
  const repoA = join(tempRoot, 'proj-mis');
  mkdirSync(repoA, { recursive: true });
  const wkA = normalizeKey(repoA);
  const t0 = Date.parse('2026-11-28T12:00:00.000Z');
  const nowRef = { ms: t0 };

  const reg = loadRegistry();
  seedProject(reg, { repoPath: repoA, coordConvId: 'conv-coord-mis' });
  reg.threads['thr-mis'] = {
    threadId: 'thr-mis',
    conversationId: 'conv-thr-mis',
    coordinatorId: 'conv-coord-mis',
    workspaceKey: wkA,
    title: 'Mismatch zombie thread',
    runState: 'RUN_STATE_IDLE',
    bucket: 'working',
    hasPendingBgTask: false,
    archived: false,
    createdAt: new Date(t0 - 10 * 60_000).toISOString(),
    updatedAt: new Date(t0 - 4 * 60_000).toISOString(),
  };
  saveRegistry(reg);

  const sent = [];
  const res = await patrolProjectScope(wkA, {
    deps: {
      now: () => nowRef.ms,
      getConversation: async (cid) => ({
        conversation: { id: cid, state: { runState: 'RUN_STATE_IDLE', updateTime: new Date(t0 - 4 * 60_000).toISOString() } },
      }),
      invokeAgentApiSend: async (args) => {
        sent.push(args);
        return { queued: true };
      },
    },
  });
  assert.equal(res.stalledCount, 1);
  assert.equal(res.alertedCount, 1);
  assert.equal(res.results[0].stallReason, 'state_mismatch_idle_working');
  assert.equal(sent.length, 1);

  // Silent exit: previously watching RUNNING thread drops to IDLE with no summary/callback past 2m grace
  const silentEval = evaluateThreadWatchdogState({
    thread: {
      threadId: 'thr-silent',
      conversationId: 'conv-thr-silent',
      runState: 'RUN_STATE_IDLE',
      bucket: 'idle',
      archived: false,
      lastSummary: '',
      createdAt: new Date(t0 - 10 * 60_000).toISOString(),
      updatedAt: new Date(t0 - 4 * 60_000).toISOString(),
    },
    signals: {
      runState: 'RUN_STATE_IDLE',
      bucket: 'idle',
      toolStepCount: 2,
      liveHasPendingBgTask: false,
      storedHasPendingBgTask: false,
      transcriptStat: { exists: true, size: 500, mtimeMs: t0 - 4 * 60_000 },
      completion: { stepIndex: -1, cardSummary: '', fullReport: '', waitingOnBackgroundTask: false },
    },
    prevEntry: {
      state: 'watching',
      lastProgressAt: new Date(t0 - 4 * 60_000).toISOString(),
      lastObservedStepCount: 2,
      lastObservedTranscriptSize: 500,
      lastObservedTranscriptMtimeMs: t0 - 4 * 60_000,
      mismatchSinceAt: new Date(t0 - 3 * 60_000).toISOString(),
    },
    config: WATCHDOG_DEFAULTS,
    nowMs: t0,
  });
  assert.equal(silentEval.stalled, true);
  assert.equal(silentEval.entry.stallReason, 'silent_exit_no_summary');
});

test('Issue #6: Coordinator RUN_STATE_RUNNING deferral never interrupts active turn; delivers on IDLE or via PreInvocation without duplicate', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-wd-defer-');
  const repoA = join(tempRoot, 'proj-defer');
  mkdirSync(repoA, { recursive: true });
  const wkA = normalizeKey(repoA);
  const t0 = Date.parse('2026-11-28T13:00:00.000Z');
  const nowRef = { ms: t0 };

  const reg = loadRegistry();
  seedProject(reg, { repoPath: repoA, coordConvId: 'conv-coord-busy' });
  reg.threads['thr-d1'] = {
    threadId: 'thr-d1',
    conversationId: 'conv-thr-d1',
    coordinatorId: 'conv-coord-busy',
    workspaceKey: wkA,
    title: 'Stuck while coordinator busy',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    archived: false,
    createdAt: new Date(t0 - 15 * 60_000).toISOString(),
    updatedAt: new Date(t0 - 12 * 60_000).toISOString(),
  };
  saveRegistry(reg);
  makeTranscript(
    appDataDir,
    'conv-thr-d1',
    [{ step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>Work</USER_REQUEST>' }],
    t0 - 12 * 60_000,
  );

  let coordState = 'RUN_STATE_RUNNING';
  const sent = [];
  const deps = {
    now: () => nowRef.ms,
    getConversation: async (cid) => ({
      conversation: {
        id: cid,
        state:
          cid === 'conv-coord-busy'
            ? { runState: coordState }
            : { runState: 'RUN_STATE_RUNNING', updateTime: new Date(t0 - 12 * 60_000).toISOString() },
      },
    }),
    invokeAgentApiSend: async (args) => {
      sent.push(args);
      return { queued: true };
    },
  };

  // 1. Coordinator is RUNNING -> ZERO send calls, immediate stalled + pendingDelivery=true on board
  const rBusy = await patrolProjectScope(wkA, { deps });
  assert.equal(rBusy.stalledCount, 1);
  assert.equal(rBusy.alertedCount, 0);
  assert.equal(rBusy.deferredCount, 1);
  assert.equal(rBusy.results[0].reason, 'coordinator_running');
  assert.equal(sent.length, 0, 'Must NEVER interrupt Coordinator while RUN_STATE_RUNNING');

  const wdDeferred = getThreadWatchdogSummary(loadRegistry(), wkA, 'thr-d1', nowRef.ms);
  assert.equal(wdDeferred.stalled, true);
  assert.equal(wdDeferred.pendingDelivery, true);
  assert.equal(wdDeferred.pendingDeliveryReason, 'coordinator_running');

  // 2. Path A: Coordinator turns IDLE -> next patrol immediately delivers queued alert
  coordState = 'RUN_STATE_IDLE';
  nowRef.ms = t0 + 30_000;
  const rIdle = await patrolProjectScope(wkA, { deps });
  assert.equal(rIdle.alertedCount, 1);
  assert.equal(rIdle.deferredCount, 0);
  assert.equal(sent.length, 1);
  assert.equal(getThreadWatchdogSummary(loadRegistry(), wkA, 'thr-d1', nowRef.ms).pendingDelivery, false);

  // 3. Path B: Deferral consumed via PreInvocation hook injection without double-send on subsequent patrol
  nowRef.ms = t0 + 12 * 60_000; // past 10m cooldown -> eligible for alert #2
  coordState = 'RUN_STATE_RUNNING';
  const rBusy2 = await patrolProjectScope(wkA, { deps });
  assert.equal(rBusy2.deferredCount, 1);
  assert.equal(sent.length, 1);

  const coordObj = loadRegistry().coordinators[wkA];
  const injected = consumePendingWatchdogAlertsForPreInvocation(coordObj, { nowMs: nowRef.ms + 5000 });
  assert.match(injected, /\[THREAD_STALL_ALERT\]/);
  assert.match(injected, /thr-d1/);

  // Next patrol sees it already delivered via PreInvocation -> zero duplicate send!
  coordState = 'RUN_STATE_IDLE';
  nowRef.ms = t0 + 13 * 60_000;
  const rAfterPre = await patrolProjectScope(wkA, { deps });
  assert.equal(rAfterPre.alertedCount, 0, 'PreInvocation delivery must arm cooldown and avoid duplicate send');
  assert.equal(sent.length, 1);
});

test('Issue #6: Cross-project isolation, Coordinator Rebind (#5), retiredCoordinatorIds guard, mid-delivery rebind safety, and Snooze', async (t) => {
  const { tempRoot, appDataDir } = createTempEnv(t, 'pt-wd-iso-');
  const repoA = join(tempRoot, 'proj-alpha');
  const repoB = join(tempRoot, 'proj-beta');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  const t0 = Date.parse('2026-11-28T14:00:00.000Z');
  const nowRef = { ms: t0 };

  const reg = loadRegistry();
  const wkA = seedProject(reg, {
    repoPath: repoA,
    coordConvId: 'conv-coord-a-new',
    retiredCoordinatorIds: ['conv-coord-a-old'],
  });
  const wkB = seedProject(reg, {
    repoPath: repoB,
    coordConvId: 'conv-coord-b',
  });
  // Thread A still carries stale old coordinatorId in its record (simulating legacy pre-rebind thread)
  reg.threads['thr-a1'] = {
    threadId: 'thr-a1',
    conversationId: 'conv-thr-a1',
    coordinatorId: 'conv-coord-a-old',
    workspaceKey: wkA,
    title: 'Alpha stalled task',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    archived: false,
    createdAt: new Date(t0 - 20 * 60_000).toISOString(),
    updatedAt: new Date(t0 - 15 * 60_000).toISOString(),
  };
  reg.threads['thr-b1'] = {
    threadId: 'thr-b1',
    conversationId: 'conv-thr-b1',
    coordinatorId: 'conv-coord-b',
    workspaceKey: wkB,
    title: 'Beta stalled task',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    archived: false,
    createdAt: new Date(t0 - 20 * 60_000).toISOString(),
    updatedAt: new Date(t0 - 15 * 60_000).toISOString(),
  };
  saveRegistry(reg);
  makeTranscript(appDataDir, 'conv-thr-a1', [{ step_index: 0, type: 'USER_INPUT', content: 'a' }], t0 - 15 * 60_000);
  makeTranscript(appDataDir, 'conv-thr-b1', [{ step_index: 0, type: 'USER_INPUT', content: 'b' }], t0 - 15 * 60_000);

  const sent = [];
  const deps = {
    now: () => nowRef.ms,
    getConversation: async (cid) => ({
      conversation: {
        id: cid,
        state: cid.startsWith('conv-coord')
          ? { runState: 'RUN_STATE_IDLE' }
          : { runState: 'RUN_STATE_RUNNING', updateTime: new Date(t0 - 15 * 60_000).toISOString() },
      },
    }),
    invokeAgentApiSend: async (args) => {
      sent.push(args);
      return { queued: true };
    },
  };

  // 1. Patrol Project A -> ONLY scans thr-a1, routes to conv-coord-a-new (NEVER old retired, NEVER Project B)
  const rA = await patrolProjectScope(wkA, { deps });
  assert.equal(rA.checkedCount, 1);
  assert.equal(rA.alertedCount, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].conversationId, 'conv-coord-a-new');
  assert.equal(getThreadWatchdogSummary(loadRegistry(), wkB, 'thr-b1', nowRef.ms), null, 'Project B must remain untouched');

  // 2. Retired Coordinator is rejected fail-closed on manual patrol and snooze
  await assert.rejects(
    () => triggerWatchdogPatrol({ workspaceKey: wkA, coordinatorId: 'conv-coord-a-old', deps }),
    /retired/i,
  );
  await assert.rejects(
    () => snoozeWatchdogThread({ threadId: 'thr-a1', workspaceKey: wkA, coordinatorId: 'conv-coord-a-old', deps }),
    /retired/i,
  );

  // 3. Cross-project snooze / wakeCheck is rejected fail-closed
  await assert.rejects(
    () => snoozeWatchdogThread({ threadId: 'thr-b1', workspaceKey: wkA, coordinatorId: 'conv-coord-a-new', deps }),
    /Cross-project access denied/i,
  );

  // 4. Snooze suppresses further alerts until expiry or unsnooze
  const snRes = await snoozeWatchdogThread({
    threadId: 'thr-a1',
    minutes: 30,
    workspaceKey: wkA,
    coordinatorId: 'conv-coord-a-new',
    deps,
  });
  assert.equal(snRes.ok, true);
  assert.equal(snRes.action, 'snooze');
  assert.equal(snRes.threadWatchdog.snoozed, true);
  assert.equal(snRes.threadWatchdog.stalled, false);

  nowRef.ms = t0 + 15 * 60_000;
  const rDuringSnooze = await patrolProjectScope(wkA, { deps });
  assert.equal(rDuringSnooze.stalledCount, 0);
  assert.equal(rDuringSnooze.alertedCount, 0);
  assert.equal(sent.length, 1);

  // Unsnooze resumes monitoring cleanly
  const unsnRes = await snoozeWatchdogThread({
    threadId: 'thr-a1',
    clear: true,
    workspaceKey: wkA,
    coordinatorId: 'conv-coord-a-new',
    deps,
  });
  assert.equal(unsnRes.ok, true);
  assert.equal(unsnRes.action, 'unsnooze');

  // 5. Mid-delivery Coordinator rebind does NOT consume cooldown on old Coordinator -> stays pendingDelivery for new Coordinator!
  let rebindTriggered = false;
  const rMidRebind = await patrolProjectScope(wkB, {
    deps: {
      ...deps,
      invokeAgentApiSend: async (args) => {
        sent.push(args);
        if (!rebindTriggered) {
          rebindTriggered = true;
          mutateRegistry((freshReg) => {
            freshReg.coordinators[wkB].conversationId = 'conv-coord-b-v2';
            freshReg.coordinators[wkB].retiredCoordinatorIds = ['conv-coord-b'];
            freshReg.coordinators[wkB].rebindSeq = 1;
            freshReg.coordinators[wkB].reboundAt = new Date(nowRef.ms + 1).toISOString();
          });
        }
        return { queued: true };
      },
    },
  });
  assert.equal(rMidRebind.alertedCount, 0);
  assert.equal(rMidRebind.deferredCount, 1);
  assert.equal(rMidRebind.results[0].reason, 'coordinator_rebound_during_delivery');

  // Next patrol immediately delivers to conv-coord-b-v2!
  const rAfterRebind = await patrolProjectScope(wkB, { deps });
  assert.equal(rAfterRebind.alertedCount, 1);
  assert.equal(sent[sent.length - 1].conversationId, 'conv-coord-b-v2');

  // 6. Archiving a stalled thread immediately clears its watchdog state
  await archiveThread('thr-b1', { removeWorktree: false, workspaceKey: wkB, coordinatorId: 'conv-coord-b-v2' });
  assert.equal(getThreadWatchdogSummary(loadRegistry(), wkB, 'thr-b1', nowRef.ms), null);
});

test('Issue #6: Per-project re-entrancy mutex prevents stacking while keeping sibling projects independent, and scheduler cleans up all timers', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-wd-sched-');
  const repoA = join(tempRoot, 'proj-r-a');
  const repoB = join(tempRoot, 'proj-r-b');
  mkdirSync(repoA, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  const t0 = Date.parse('2026-11-28T15:00:00.000Z');

  const reg = loadRegistry();
  const wkA = seedProject(reg, { repoPath: repoA, coordConvId: 'conv-ca' });
  const wkB = seedProject(reg, { repoPath: repoB, coordConvId: 'conv-cb' });
  reg.threads['thr-ra'] = {
    threadId: 'thr-ra',
    conversationId: 'conv-ra',
    coordinatorId: 'conv-ca',
    workspaceKey: wkA,
    title: 'Slow probe A',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    archived: false,
    createdAt: new Date(t0 - 120_000).toISOString(),
    updatedAt: new Date(t0 - 60_000).toISOString(),
  };
  reg.threads['thr-rb'] = {
    threadId: 'thr-rb',
    conversationId: 'conv-rb',
    coordinatorId: 'conv-cb',
    workspaceKey: wkB,
    title: 'Fast probe B',
    runState: 'RUN_STATE_RUNNING',
    bucket: 'working',
    archived: false,
    createdAt: new Date(t0 - 120_000).toISOString(),
    updatedAt: new Date(t0 - 60_000).toISOString(),
  };
  saveRegistry(reg);

  let releaseProbeA;
  const probeAGate = new Promise((r) => {
    releaseProbeA = r;
  });
  let probeACount = 0;

  const slowDepsA = {
    now: () => t0,
    getConversation: async () => {
      probeACount++;
      await probeAGate;
      return { conversation: { state: { runState: 'RUN_STATE_RUNNING', updateTime: new Date(t0 - 60_000).toISOString() } } };
    },
    invokeAgentApiSend: async () => ({ queued: true }),
  };

  // Start slow patrol on A; overlapping patrol on A skips immediately, while B completes freely!
  const pA1 = patrolProjectScope(wkA, { deps: slowDepsA });
  await new Promise((r) => setTimeout(r, 15));
  const pA2 = await patrolProjectScope(wkA, { deps: slowDepsA });
  assert.equal(pA2.skipped, true);
  assert.equal(pA2.reason, 'in_progress');
  assert.equal(probeACount, 1, 'Overlapping tick must not start a duplicate probe');

  const pB = await patrolProjectScope(wkB, {
    deps: {
      now: () => t0,
      getConversation: async () => ({
        conversation: { state: { runState: 'RUN_STATE_RUNNING', updateTime: new Date(t0 - 60_000).toISOString() } },
      }),
      invokeAgentApiSend: async () => ({ queued: true }),
    },
  });
  assert.equal(pB.skipped, false, 'Project B must run independently without waiting for Project A');

  releaseProbeA();
  const resA1 = await pA1;
  assert.equal(resA1.ok, true);

  // Scheduler starts per-project runners only for enabled bound scopes and cleans up on stop()
  saveSettings({ scope: 'project', section: 'watchdog', workspaceKey: wkB, watchdog: { enabled: false } });
  const scheduler = createWatchdogScheduler({
    reconcileIntervalMs: 60_000,
    deps: {
      now: () => t0,
      getConversation: async () => ({ conversation: { state: { runState: 'RUN_STATE_IDLE' } } }),
      invokeAgentApiSend: async () => ({ queued: true }),
    },
  });
  scheduler.start();
  assert.equal(scheduler.isRunning(), true);
  assert.deepEqual(scheduler.getActiveScopeKeys(), [wkA], 'Disabled Project B must not spawn a runner');

  // Re-enable Project B and reconcile -> runner joins cleanly
  saveSettings({ scope: 'project', section: 'watchdog', workspaceKey: wkB, watchdog: { enabled: true } });
  scheduler.reconcile();
  assert.deepEqual(scheduler.getActiveScopeKeys().sort(), [wkA, wkB].sort());

  scheduler.stop();
  assert.equal(scheduler.isRunning(), false);
  assert.deepEqual(scheduler.getActiveScopeKeys(), []);
});

test('Issue #6: Sidecar API rev 7, watchdog_patrol + topic_memory capabilities, write-API discipline, 3-locale I18N (zero middle dots), zero native dialogs, and LF line endings', () => {
  const mainMjs = readFileSync(new URL('../sidecars/threads/main.mjs', import.meta.url), 'utf8');
  const indexHtml = readFileSync(new URL('../sidecars/threads/index.html', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const themeCss = readFileSync(new URL('../sidecars/threads/theme.css', import.meta.url), 'utf8');
  const hookMjs = readFileSync(new URL('../scripts/hook-handler.mjs', import.meta.url), 'utf8');

  // 1. Backend routes, rev 7, capabilities union, lifecycle cleanup, and DIRECTIVE_VERSION=17 preserved
  assert.match(mainMjs, /const\s+SERVER_API_REVISION\s*=\s*7\s*;/);
  assert.match(mainMjs, /['"]topic_memory['"]/);
  assert.match(mainMjs, /['"]watchdog_patrol['"]/);
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/watchdog_status['"]/);
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/watchdog_patrol['"]/);
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/watchdog_snooze['"]/);
  assert.match(mainMjs, /handleWatchdogStatus[\s\S]*?serverInfo:\s*buildServerInfo\(\)/);
  assert.match(mainMjs, /handleWatchdogPatrol[\s\S]*?serverInfo:\s*buildServerInfo\(\)/);
  assert.match(mainMjs, /handleWatchdogSnooze[\s\S]*?serverInfo:\s*buildServerInfo\(\)/);
  assert.match(mainMjs, /watchdogScheduler\.start\(\)/);
  assert.match(mainMjs, /watchdogScheduler\.stop\(\)/);
  assert.match(hookMjs, /const\s+DIRECTIVE_VERSION\s*=\s*17\s*;/);
  assert.match(hookMjs, /consumePendingWatchdogAlertsForPreInvocation/);

  // 2. Frontend rev 7, capability gating, write-API safety (timeoutMs: 0, allowGetFallback: false, res.action verification)
  assert.match(appJs, /const\s+EXPECTED_SERVER_API_REVISION\s*=\s*7\s*;/);
  assert.match(appJs, /function\s+supportsWatchdogPatrol\s*\(/);
  assert.match(appJs, /serverCapabilities\.has\(['"]watchdog_patrol['"]\)/);
  assert.match(
    appJs,
    /postApi\(\s*['"]\/api\/watchdog_patrol['"][\s\S]*?timeoutMs:\s*0[\s\S]*?allowGetFallback:\s*false/,
  );
  assert.match(
    appJs,
    /postApi\(\s*['"]\/api\/watchdog_snooze['"][\s\S]*?timeoutMs:\s*0[\s\S]*?allowGetFallback:\s*false/,
  );
  assert.match(appJs, /res\.action\s*!==\s*expectedAction/);
  assert.match(appJs, /isWatchdogInputFocused/);
  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appJs), false);

  // 3. HTML & CSS hooks
  for (const id of [
    'btn-watchdog-patrol',
    'settings-watchdog-card',
    'wd-enabled-seg',
    'set-wd-interval',
    'set-wd-stall',
    'set-wd-bgtask',
    'set-wd-mismatch',
    'set-wd-cooldown',
    'set-wd-escalated',
    'btn-wd-save',
    'btn-wd-reset',
    'btn-wd-patrol-now',
  ]) {
    assert.match(indexHtml, new RegExp(`id="${id}"`), `index.html must include #${id}`);
  }
  assert.match(themeCss, /\.wd-patrol-chip\s*\{/);
  assert.match(themeCss, /\.o2-stall-badge\s*\{/);
  assert.match(themeCss, /\.o2-th-stall\s*\{/);
  assert.match(themeCss, /\.wd-grid\s*\{/);

  // 4. 3-locale I18N completeness and zero middle dot in all new Watchdog strings
  const i18nStart = appJs.indexOf('const I18N = {');
  let depth = 0;
  let inBrace = false;
  let i18nEnd = -1;
  for (let i = i18nStart; i < appJs.length; i++) {
    if (appJs[i] === '{') {
      depth++;
      inBrace = true;
    } else if (appJs[i] === '}') {
      depth--;
      if (inBrace && depth === 0) {
        i18nEnd = i + 1;
        break;
      }
    }
  }
  const i18nCtx = {};
  vm.runInNewContext(`${appJs.slice(i18nStart, i18nEnd)}; this.I18N = I18N;`, i18nCtx);
  const I18N = i18nCtx.I18N;

  const strKeys = [
    'decisionAutoStallTitle',
    'decisionAutoStallInspectBtn',
    'decisionAutoStallSnoozeBtn',
    'wdPatrolBtn',
    'wdPatrolOffBtn',
    'wdPatrolBusy',
    'wdPatrolSkippedToast',
    'wdPatrolErrToast',
    'wdStalledBadge',
    'wdSnoozedBadge',
    'wdWakeBtn',
    'wdWakingBtn',
    'wdUnsnoozeBtn',
    'wdWakeSentToast',
    'wdWakeDeferredToast',
    'wdWakeHealthyToast',
    'wdUnsnoozedToast',
    'wdSnoozeErrToast',
    'wdUnsupportedErr',
    'wdHdr',
    'wdBadgeOn',
    'wdBadgeOff',
    'wdBadgeReload',
    'wdEnabledLabel',
    'wdEnabledOn',
    'wdEnabledOff',
    'wdDescGlobal',
    'wdIntervalLabel',
    'wdStallLabel',
    'wdBgTaskLabel',
    'wdMismatchLabel',
    'wdCooldownLabel',
    'wdEscalatedLabel',
    'wdSaveBtn',
    'wdSavingBtn',
    'wdResetGlobalBtn',
    'wdResetProjectBtn',
    'wdPatrolNowBtn',
    'wdSavedToast',
    'wdResetToast',
    'wdClearedProjToast',
    'wdSaveErr',
    'wdSourceProject',
    'wdSourceGlobal',
    'wdNeverPatrolled',
  ];
  const fnKeys = [
    ['decisionAutoStallSummary', ['Fix build', '12m']],
    ['wdPatrolStalledBtn', [2]],
    ['wdPatrolTip', [true, '1m ago', 10]],
    ['wdPatrolOkToast', [3, 1]],
    ['wdStallDetail', ['12m', true]],
    ['wdSnoozeDetail', ['25m']],
    ['wdSnoozeBtn', [30]],
    ['wdSnoozedToast', [30]],
    ['wdEnabledFollow', ['Enabled']],
    ['wdDescProject', ['DemoProj']],
    ['wdMetaLine', ['Global defaults', '1m ago', 1]],
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
      const rendered = String(fn(...args));
      assert.ok(rendered.length > 0);
      assert.equal(rendered.includes('·'), false, `I18N.${loc}.${k} output must not contain middle dot`);
    }
  }

  // 5. Structured stall alert text also has zero middle dots across all 3 locales
  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    const msg = buildStallAlertMessage(
      {
        threadId: 'thr-084',
        localId: '#1',
        title: 'Watchdog check',
        conversationId: 'conv-084',
        coordinatorId: 'conv-coord',
        workspacePath: '/repo',
        stallReason: 'no_progress_running',
        stalledDurationMs: 720_000,
        lastProgressAt: '2026-11-28T10:00:00.000Z',
        runState: 'RUN_STATE_RUNNING',
        bucket: 'working',
        toolStepCount: 3,
        transcriptSize: 2048,
        hasPendingBgTask: false,
        alertNumber: 1,
      },
      loc,
    );
    assert.match(msg, /\[THREAD_STALL_ALERT\]/);
    assert.equal(msg.includes('·'), false, `buildStallAlertMessage(${loc}) must not contain middle dot`);
  }

  // 6. Strict LF line endings on all modified/added .mjs files
  for (const rel of [
    '../lib/watchdog.mjs',
    '../lib/store.mjs',
    '../scripts/hook-handler.mjs',
    '../sidecars/threads/main.mjs',
    '../tests/watchdog.test.mjs',
  ]) {
    const buf = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!buf.includes(Buffer.from('\r')), `${rel} must use LF line endings`);
  }
});

test('Issue #6: Sidecar UI capability gating renders stalled badge/actions only when watchdog_patrol capability is present', () => {
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const extractFn = (fnName) => {
    let start = appJs.indexOf(`async function ${fnName}(`);
    if (start === -1) start = appJs.indexOf(`function ${fnName}(`);
    assert.notEqual(start, -1, `Expected ${fnName} in app.js`);
    const bodyStart = appJs.indexOf('{', appJs.indexOf(')', start));
    let depth = 0;
    for (let i = bodyStart; i < appJs.length; i++) {
      if (appJs[i] === '{') depth++;
      else if (appJs[i] === '}') {
        depth--;
        if (depth === 0) return appJs.slice(start, i + 1);
      }
    }
    throw new Error(`Unclosed ${fnName}`);
  };
  const i18nStart = appJs.indexOf('const I18N = {');
  const i18nEnd = appJs.indexOf('let curLocale =', i18nStart);

  const ctx = {
    Date,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    esc: (s) => String(s ?? ''),
    relTime: () => '12m',
    renderSegmentedMbar: () => '',
    cleanGoalSnippet: () => 'Fix bug',
    computeInlineSubtitle: () => 'Working…',
    formatModelDisplay: () => 'Gemini Pro',
    renderThreadUsageRow: () => '',
    isThreadCardOpen: () => true,
    getActiveMainWorkerConvId: () => '',
    ICONS: { chevronRight: '>' },
  };
  vm.runInNewContext(
    `
    ${appJs.slice(i18nStart, i18nEnd)}
    let curLocale = 'zh-CN';
    const L = () => I18N[curLocale] || I18N.en;
    let serverCapabilities = new Set();
    let lastSnap = { watchdog: { defaultSnoozeMin: 30 } };
    const wdBusyThreadIds = new Set();
    ${extractFn('getLocalizedDecisionDisplay')}
    ${extractFn('renderO2ThreadCard')}
    this.setCaps = (arr) => { serverCapabilities = new Set(arr); };
    this.renderO2ThreadCard = renderO2ThreadCard;
    this.getLocalizedDecisionDisplay = getLocalizedDecisionDisplay;
    `,
    ctx,
  );

  const stalledThread = {
    threadId: 'thr-099',
    projectSeq: 3,
    localId: '#3',
    title: 'Stalled worker',
    bucket: 'working',
    runState: 'RUN_STATE_RUNNING',
    archived: false,
    watchdog: {
      state: 'stalled',
      stalled: true,
      snoozed: false,
      stallReason: 'no_progress_running',
      stalledDurationMs: 12 * 60_000,
      pendingDelivery: true,
    },
  };

  // Without watchdog_patrol capability: badge + detail still show, write buttons are gated off!
  ctx.setCaps([]);
  const htmlWithoutCap = ctx.renderO2ThreadCard(stalledThread);
  assert.match(htmlWithoutCap, /o2-stall-badge/);
  assert.match(htmlWithoutCap, /疑似停滞/);
  assert.doesNotMatch(htmlWithoutCap, /data-action="wd-wake"/);
  assert.doesNotMatch(htmlWithoutCap, /data-action="wd-snooze"/);

  // With watchdog_patrol capability: wake & snooze controls render cleanly!
  ctx.setCaps(['watchdog_patrol']);
  const htmlWithCap = ctx.renderO2ThreadCard(stalledThread);
  assert.match(htmlWithCap, /data-action="wd-wake"/);
  assert.match(htmlWithCap, /data-action="wd-snooze"/);
  assert.match(htmlWithCap, /立即唤醒检查/);
  assert.match(htmlWithCap, /暂缓 30m/);

  // Auto watchdog_stalled decision localizes cleanly with zero middle dots
  const locDec = ctx.getLocalizedDecisionDisplay({
    source: 'auto',
    autoKind: 'watchdog_stalled',
    threadTitle: 'Stalled worker',
    stalledDurationMs: 12 * 60_000,
    options: [
      { id: 'inspect_stalled', action: 'send_coordinator', label: 'Inspect' },
      { id: 'dismiss', action: 'dismiss', label: 'Snooze' },
    ],
  });
  assert.equal(locDec.title, '线程疑似停滞，待核查');
  assert.equal(locDec.options[0].label, '唤醒总控核查');
  assert.equal(locDec.options[1].label, '暂缓');
  assert.equal(locDec.summary.includes('·'), false);
});


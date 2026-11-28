import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { getConversation } from './ls-client.mjs';
import {
  assertNotRetiredCoordinator,
  findRetiredCoordinatorOwner,
  invokeAgentApiSend,
  loadRegistry,
  loadSettings,
  mutateRegistry,
  normalizeKey,
  resolveAppLocale,
  resolveProjectScope,
  resolveScopedThreadTarget,
} from './store.mjs';
import {
  extractThreadCompletion,
  getTranscriptPath,
  peekLiveActivity,
} from './transcript.mjs';

export const WATCHDOG_DEFAULTS = Object.freeze({
  enabled: true,
  patrolIntervalSec: 30,
  stallThresholdMin: 10,
  bgTaskThresholdMin: 20,
  mismatchGraceMin: 2,
  startupGraceSec: 90,
  cooldownMin: 10,
  escalatedCooldownMin: 30,
  defaultSnoozeMin: 30,
});

export const WATCHDOG_LIMITS = Object.freeze({
  patrolIntervalSec: Object.freeze({ min: 10, max: 300 }),
  stallThresholdMin: Object.freeze({ min: 2, max: 120 }),
  bgTaskThresholdMin: Object.freeze({ min: 5, max: 240 }),
  mismatchGraceMin: Object.freeze({ min: 1, max: 30 }),
  startupGraceSec: Object.freeze({ min: 15, max: 600 }),
  cooldownMin: Object.freeze({ min: 2, max: 120 }),
  escalatedCooldownMin: Object.freeze({ min: 5, max: 360 }),
  defaultSnoozeMin: Object.freeze({ min: 5, max: 240 }),
});

const WATCHDOG_NUMERIC_KEYS = Object.freeze([
  'patrolIntervalSec',
  'stallThresholdMin',
  'bgTaskThresholdMin',
  'mismatchGraceMin',
  'startupGraceSec',
  'cooldownMin',
  'escalatedCooldownMin',
  'defaultSnoozeMin',
]);

const WATCHDOG_CLEARED_PRUNE_MS = 24 * 60 * 60 * 1000;
const WATCHDOG_DELIVERY_FAILURE_RETRY_MS = 60_000;
const WATCHDOG_DELIVERY_CLAIM_TTL_MS = 30_000;
const WATCHDOG_LS_PROBE_TIMEOUT_MS = 3000;
const WATCHDOG_DELIVERY_TIMEOUT_MS = 8000;
const WATCHDOG_RECONCILE_INTERVAL_MS = 15_000;
const WATCHDOG_MAX_AUTO_ALERTS_PER_FINGERPRINT = 4;

const inFlightScopes = new Set();
const inFlightDeliveries = new Set();

function isDeliveryClaimActive(entry, nowMs = Date.now()) {
  if (!entry || entry.deliveryState !== 'delivering' || !entry.deliveryClaimToken) return false;
  const claimedMs = parseIsoMs(entry.deliveryClaimedAt);
  if (!claimedMs) return false;
  return nowMs - claimedMs < WATCHDOG_DELIVERY_CLAIM_TTL_MS;
}

function isFilesystemPathScopeKey(key) {
  const s = String(key || '').trim();
  if (!s || s.startsWith('project:') || s.startsWith('conv:') || s.startsWith('__')) return false;
  return /[\\/]/.test(s) || /^[A-Za-z]:/.test(s);
}

export function normalizeWatchdogScopeKey(raw) {
  const s = String(raw || '').trim();
  if (!s || s === '*') return '';
  return isFilesystemPathScopeKey(s) ? normalizeKey(s) : s;
}

function isSameScope(a, b) {
  const na = normalizeWatchdogScopeKey(a);
  const nb = normalizeWatchdogScopeKey(b);
  return Boolean(na && nb && na === nb);
}

function clampInt(raw, min, max, fallback = null) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function parseOptionalBool(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  if (!s || s === 'inherit' || s === 'default' || s === 'global') return undefined;
  if (s === 'true' || s === '1' || s === 'on' || s === 'enabled') return true;
  if (s === 'false' || s === '0' || s === 'off' || s === 'disabled') return false;
  return undefined;
}

function parseIsoMs(iso) {
  if (!iso) return 0;
  const ms = Date.parse(String(iso));
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * Normalizes and clamps watchdog configuration values to safe bounds.
 * When `isProjectOverride` is true, returns a partial object containing only explicitly
 * overridden fields (omitted / null / empty values inherit global defaults).
 */
export function normalizeWatchdogConfig(raw, { isProjectOverride = false } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  if (isProjectOverride) {
    const out = {};
    const parsedEnabled = parseOptionalBool(src.enabled);
    if (typeof parsedEnabled === 'boolean') {
      out.enabled = parsedEnabled;
    }
    for (const key of WATCHDOG_NUMERIC_KEYS) {
      if (!(key in src)) continue;
      const lim = WATCHDOG_LIMITS[key];
      const val = clampInt(src[key], lim.min, lim.max, null);
      if (val !== null) {
        out[key] = val;
      }
    }
    if (
      typeof out.stallThresholdMin === 'number' &&
      typeof out.bgTaskThresholdMin === 'number' &&
      out.bgTaskThresholdMin < out.stallThresholdMin
    ) {
      out.bgTaskThresholdMin = Math.min(WATCHDOG_LIMITS.bgTaskThresholdMin.max, out.stallThresholdMin);
    }
    if (
      typeof out.cooldownMin === 'number' &&
      typeof out.escalatedCooldownMin === 'number' &&
      out.escalatedCooldownMin < out.cooldownMin
    ) {
      out.escalatedCooldownMin = Math.min(WATCHDOG_LIMITS.escalatedCooldownMin.max, out.cooldownMin);
    }
    return out;
  }

  const parsedEnabled = parseOptionalBool(src.enabled);
  const out = {
    enabled: typeof parsedEnabled === 'boolean' ? parsedEnabled : WATCHDOG_DEFAULTS.enabled,
  };
  for (const key of WATCHDOG_NUMERIC_KEYS) {
    const lim = WATCHDOG_LIMITS[key];
    const val = clampInt(src[key], lim.min, lim.max, WATCHDOG_DEFAULTS[key]);
    out[key] = val === null ? WATCHDOG_DEFAULTS[key] : val;
  }
  if (out.bgTaskThresholdMin < out.stallThresholdMin) {
    out.bgTaskThresholdMin = Math.min(WATCHDOG_LIMITS.bgTaskThresholdMin.max, out.stallThresholdMin);
  }
  if (out.escalatedCooldownMin < out.cooldownMin) {
    out.escalatedCooldownMin = Math.min(WATCHDOG_LIMITS.escalatedCooldownMin.max, out.cooldownMin);
  }
  return out;
}

export function hasWatchdogOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return Object.keys(normalizeWatchdogConfig(raw, { isProjectOverride: true })).length > 0;
}

function lookupProjectWatchdogOverride(projectsMap, scopeKey = '', workspacePath = '') {
  if (!projectsMap || typeof projectsMap !== 'object') return {};
  const candidates = [scopeKey, workspacePath].filter(Boolean);
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(projectsMap, c) && projectsMap[c]?.watchdog) {
      return normalizeWatchdogConfig(projectsMap[c].watchdog, { isProjectOverride: true });
    }
  }
  const normalizedTargets = new Set(candidates.map((c) => normalizeWatchdogScopeKey(c)).filter(Boolean));
  for (const [k, v] of Object.entries(projectsMap)) {
    if (!v || typeof v !== 'object' || !v.watchdog) continue;
    const nk = normalizeWatchdogScopeKey(k);
    if (normalizedTargets.has(nk)) {
      return normalizeWatchdogConfig(v.watchdog, { isProjectOverride: true });
    }
  }
  return {};
}

export function resolveEffectiveWatchdogConfig(settings = null, scopeKey = '', workspacePath = '') {
  const doc = settings && typeof settings === 'object' ? settings : {};
  const globalCfg = normalizeWatchdogConfig(doc.watchdog, { isProjectOverride: false });
  const projectOverride =
    scopeKey || workspacePath
      ? lookupProjectWatchdogOverride(doc.projects, scopeKey, workspacePath)
      : {};
  const hasOverride = Object.keys(projectOverride).length > 0;
  const merged = normalizeWatchdogConfig({ ...globalCfg, ...projectOverride }, { isProjectOverride: false });

  return {
    ...merged,
    source: hasOverride ? 'project' : 'global',
    hasProjectOverride: hasOverride,
    global: globalCfg,
    project: projectOverride,
  };
}

/**
 * Merge-safe tombstone reconciliation for `registry.watchdogState` during `saveRegistry()`.
 * Newer `updatedAt` timestamps always win per `(scopeKey, threadId)`, ensuring explicit
 * `state: 'cleared'` tombstones can never be resurrected by stale disk snapshots.
 */
export function mergeWatchdogStateMaps(memMap, diskMap, nowMs = Date.now()) {
  const out = {};
  const mMap = memMap && typeof memMap === 'object' && !Array.isArray(memMap) ? memMap : {};
  const dMap = diskMap && typeof diskMap === 'object' && !Array.isArray(diskMap) ? diskMap : {};
  const allScopeKeys = new Set([...Object.keys(dMap), ...Object.keys(mMap)]);

  for (const rawKey of allScopeKeys) {
    const scopeKey = normalizeWatchdogScopeKey(rawKey) || String(rawKey || '').trim();
    if (!scopeKey) continue;
    const mScope = mMap[rawKey] || mMap[scopeKey] || null;
    const dScope = dMap[rawKey] || dMap[scopeKey] || null;
    const existing = out[scopeKey] || null;

    const scopes = [existing, dScope, mScope].filter((s) => s && typeof s === 'object' && !Array.isArray(s));
    if (!scopes.length) continue;

    // Pick newest scope header fields by updatedAt / lastPatrolAt
    let winner = scopes[0];
    let winnerTs = String(winner.updatedAt || winner.lastPatrolAt || '');
    for (let i = 1; i < scopes.length; i++) {
      const cand = scopes[i];
      const candTs = String(cand.updatedAt || cand.lastPatrolAt || '');
      if (candTs >= winnerTs) {
        winner = cand;
        winnerTs = candTs;
      }
    }

    const mergedThreads = {};
    for (const sc of scopes) {
      const thMap = sc.threads && typeof sc.threads === 'object' && !Array.isArray(sc.threads)
        ? sc.threads
        : {};
      for (const [tid, entry] of Object.entries(thMap)) {
        if (!tid || !entry || typeof entry !== 'object') continue;
        const prev = mergedThreads[tid];
        if (!prev) {
          mergedThreads[tid] = { ...entry };
          continue;
        }
        const prevTs = String(prev.updatedAt || prev.lastAlertAt || prev.lastProgressAt || '');
        const nextTs = String(entry.updatedAt || entry.lastAlertAt || entry.lastProgressAt || '');
        if (nextTs >= prevTs) {
          mergedThreads[tid] = { ...entry };
        }
      }
    }

    // Prune expired cleared tombstones (older than 24h) to keep registry.json compact
    for (const [tid, entry] of Object.entries(mergedThreads)) {
      if (entry.state === 'cleared') {
        const tsMs = parseIsoMs(entry.updatedAt);
        if (!tsMs || nowMs - tsMs > WATCHDOG_CLEARED_PRUNE_MS) {
          delete mergedThreads[tid];
        }
      }
    }

    out[scopeKey] = {
      scopeKey,
      coordinatorId: String(winner.coordinatorId || ''),
      lastPatrolAt: String(winner.lastPatrolAt || ''),
      lastPatrolSkippedReason: String(winner.lastPatrolSkippedReason || ''),
      lastActiveCount: Number(winner.lastActiveCount) || 0,
      lastStalledCount: Number(winner.lastStalledCount) || 0,
      updatedAt: String(winner.updatedAt || winner.lastPatrolAt || ''),
      threads: mergedThreads,
    };
  }

  return out;
}

export function buildClearedWatchdogEntry(nowIso = new Date().toISOString()) {
  return {
    state: 'cleared',
    stalled: false,
    stallReason: '',
    stallFingerprint: '',
    stalledSinceAt: '',
    stalledDurationMs: 0,
    mismatchSinceAt: '',
    alertCount: 0,
    lastAlertFingerprint: '',
    lastAlertAt: '',
    lastAlertCoordinatorId: '',
    nextAlertEligibleAt: '',
    pendingDelivery: false,
    pendingDeliveryReason: '',
    pendingDeliveryPayload: null,
    deliveryState: '',
    deliveryClaimToken: '',
    deliveryClaimedAt: '',
    deliveryClaimOwner: '',
    snoozedUntil: '',
    snoozedFingerprint: '',
    updatedAt: nowIso,
  };
}

export function clearThreadWatchdogInReg(reg, { workspaceKey = '', threadId = '', nowIso = new Date().toISOString() } = {}) {
  const tid = String(threadId || '').trim();
  const scopeKey = normalizeWatchdogScopeKey(workspaceKey);
  if (!reg || !tid || !scopeKey) return false;
  if (!reg.watchdogState || typeof reg.watchdogState !== 'object') return false;
  const scopeState = reg.watchdogState[scopeKey] || reg.watchdogState[workspaceKey];
  if (!scopeState?.threads?.[tid]) return false;
  const cur = scopeState.threads[tid];
  if (cur.state === 'cleared') return false;
  scopeState.threads[tid] = buildClearedWatchdogEntry(nowIso);
  scopeState.updatedAt = nowIso;
  return true;
}

export function resetThreadWatchdogOnMessageInReg(
  reg,
  { workspaceKey = '', threadId = '', nowIso = new Date().toISOString() } = {},
) {
  const tid = String(threadId || '').trim();
  const scopeKey = normalizeWatchdogScopeKey(workspaceKey);
  if (!reg || !tid || !scopeKey) return false;
  if (!reg.watchdogState || typeof reg.watchdogState !== 'object') return false;
  const scopeState = reg.watchdogState[scopeKey] || reg.watchdogState[workspaceKey];
  if (!scopeState?.threads?.[tid]) return false;
  scopeState.threads[tid] = {
    ...buildClearedWatchdogEntry(nowIso),
    state: 'watching',
    lastProgressAt: nowIso,
    lastObservedUpdatedAt: nowIso,
    updatedAt: nowIso,
  };
  scopeState.updatedAt = nowIso;
  return true;
}

export function snoozeThreadWatchdogInReg(
  reg,
  {
    workspaceKey = '',
    threadId = '',
    minutes = WATCHDOG_DEFAULTS.defaultSnoozeMin,
    clear = false,
    nowMs = Date.now(),
  } = {},
) {
  const tid = String(threadId || '').trim();
  const scopeKey = normalizeWatchdogScopeKey(workspaceKey);
  if (!reg || !tid || !scopeKey) return null;
  if (!reg.watchdogState || typeof reg.watchdogState !== 'object') {
    reg.watchdogState = {};
  }
  const existingScope = reg.watchdogState[scopeKey] || reg.watchdogState[workspaceKey] || {
    scopeKey,
    coordinatorId: String(reg.coordinators?.[scopeKey]?.conversationId || ''),
    lastPatrolAt: '',
    lastPatrolSkippedReason: '',
    lastActiveCount: 0,
    lastStalledCount: 0,
    updatedAt: '',
    threads: {},
  };
  if (!existingScope.threads || typeof existingScope.threads !== 'object') {
    existingScope.threads = {};
  }
  const nowIso = new Date(nowMs).toISOString();
  const prev = existingScope.threads[tid] || {};

  if (clear) {
    const nextEntry = {
      ...prev,
      state: 'watching',
      stalled: false,
      snoozedUntil: '',
      snoozedFingerprint: '',
      pendingDelivery: false,
      pendingDeliveryReason: '',
      pendingDeliveryPayload: null,
      deliveryState: '',
      deliveryClaimToken: '',
      deliveryClaimedAt: '',
      deliveryClaimOwner: '',
      updatedAt: nowIso,
    };
    existingScope.threads[tid] = nextEntry;
    existingScope.updatedAt = nowIso;
    reg.watchdogState[scopeKey] = existingScope;
    return nextEntry;
  }

  const clampedMin = clampInt(
    minutes,
    WATCHDOG_LIMITS.defaultSnoozeMin.min,
    WATCHDOG_LIMITS.defaultSnoozeMin.max,
    WATCHDOG_DEFAULTS.defaultSnoozeMin,
  );
  const snoozedUntil = new Date(nowMs + clampedMin * 60_000).toISOString();
  const nextEntry = {
    ...prev,
    state: 'snoozed',
    stalled: false,
    snoozedUntil,
    snoozedFingerprint: String(prev.stallFingerprint || ''),
    pendingDelivery: false,
    pendingDeliveryReason: '',
    pendingDeliveryPayload: null,
    deliveryState: '',
    deliveryClaimToken: '',
    deliveryClaimedAt: '',
    deliveryClaimOwner: '',
    updatedAt: nowIso,
  };
  existingScope.threads[tid] = nextEntry;
  existingScope.updatedAt = nowIso;
  reg.watchdogState[scopeKey] = existingScope;
  return nextEntry;
}

export function getThreadWatchdogSummary(reg, workspaceKey, threadId, nowMs = Date.now()) {
  const scopeKey = normalizeWatchdogScopeKey(workspaceKey);
  const tid = String(threadId || '').trim();
  if (!reg?.watchdogState || !scopeKey || !tid) return null;
  const scopeState = reg.watchdogState[scopeKey] || reg.watchdogState[workspaceKey];
  const entry = scopeState?.threads?.[tid];
  if (!entry || typeof entry !== 'object' || entry.state === 'cleared') return null;

  const snoozedUntilMs = parseIsoMs(entry.snoozedUntil);
  const isSnoozed = entry.state === 'snoozed' && snoozedUntilMs > nowMs;
  const isStalled = entry.state === 'stalled' && Boolean(entry.stalled) && !isSnoozed;
  if (!isStalled && !isSnoozed) return null;

  const stalledSinceMs = parseIsoMs(entry.stalledSinceAt);
  const lastProgressMs = parseIsoMs(entry.lastProgressAt);
  const liveDurationMs = isStalled
    ? Math.max(
        Number(entry.stalledDurationMs) || 0,
        lastProgressMs > 0 ? Math.max(0, nowMs - lastProgressMs) : stalledSinceMs > 0 ? Math.max(0, nowMs - stalledSinceMs) : 0,
      )
    : 0;

  return {
    state: isSnoozed ? 'snoozed' : 'stalled',
    stalled: isStalled,
    snoozed: isSnoozed,
    stallReason: isStalled ? String(entry.stallReason || '') : '',
    stallFingerprint: isStalled ? String(entry.stallFingerprint || '') : '',
    stalledSinceAt: isStalled ? String(entry.stalledSinceAt || '') : '',
    stalledDurationMs: liveDurationMs,
    lastProgressAt: String(entry.lastProgressAt || ''),
    alertCount: Number(entry.alertCount) || 0,
    lastAlertAt: String(entry.lastAlertAt || ''),
    pendingDelivery: Boolean(isStalled && entry.pendingDelivery),
    pendingDeliveryReason: isStalled ? String(entry.pendingDeliveryReason || '') : '',
    snoozedUntil: isSnoozed ? String(entry.snoozedUntil || '') : '',
  };
}

export function buildWatchdogBoardSummary(reg, settings, scopeKey = '', workspacePath = '', nowMs = Date.now()) {
  const normScope = normalizeWatchdogScopeKey(scopeKey);
  const effective = resolveEffectiveWatchdogConfig(settings, normScope, workspacePath);
  const scopeState = normScope
    ? reg?.watchdogState?.[normScope] || reg?.watchdogState?.[scopeKey] || null
    : null;
  const threadsMap = scopeState?.threads && typeof scopeState.threads === 'object' ? scopeState.threads : {};

  let stalledCount = 0;
  let snoozedCount = 0;
  let pendingDeliveryCount = 0;
  for (const [tid, entry] of Object.entries(threadsMap)) {
    const tRec = reg?.threads?.[tid];
    if (!tRec || tRec.archived) continue;
    if (normScope && tRec.workspaceKey && !isSameScope(tRec.workspaceKey, normScope)) continue;
    const sum = getThreadWatchdogSummary(reg, normScope, tid, nowMs);
    if (!sum) continue;
    if (sum.stalled) {
      stalledCount++;
      if (sum.pendingDelivery) pendingDeliveryCount++;
    } else if (sum.snoozed) {
      snoozedCount++;
    }
  }

  return {
    enabled: Boolean(effective.enabled),
    source: effective.source,
    hasProjectOverride: effective.hasProjectOverride,
    patrolIntervalSec: effective.patrolIntervalSec,
    stallThresholdMin: effective.stallThresholdMin,
    bgTaskThresholdMin: effective.bgTaskThresholdMin,
    mismatchGraceMin: effective.mismatchGraceMin,
    cooldownMin: effective.cooldownMin,
    escalatedCooldownMin: effective.escalatedCooldownMin,
    defaultSnoozeMin: effective.defaultSnoozeMin,
    lastPatrolAt: String(scopeState?.lastPatrolAt || ''),
    lastPatrolSkippedReason: String(scopeState?.lastPatrolSkippedReason || ''),
    inFlight: Boolean(normScope && inFlightScopes.has(normScope)),
    stalledCount,
    snoozedCount,
    pendingDeliveryCount,
  };
}

function defaultStatTranscript(conversationId) {
  const p = getTranscriptPath(conversationId);
  if (!p) return { exists: false, size: 0, mtimeMs: 0 };
  try {
    const st = statSync(p);
    return {
      exists: st.isFile(),
      size: Number(st.size) || 0,
      mtimeMs: Number(st.mtimeMs) || 0,
    };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0 };
  }
}

export function formatWatchdogDuration(ms, locale = 'en') {
  const totalSec = Math.max(1, Math.floor((Number(ms) || 0) / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (locale === 'zh-CN' || locale === 'zh-TW') {
    const hrUnit = locale === 'zh-TW' ? '小時' : '小时';
    const minUnit = locale === 'zh-TW' ? '分鐘' : '分钟';
    if (hrs > 0) return mins > 0 ? `${hrs}${hrUnit}${mins}${minUnit}` : `${hrs}${hrUnit}`;
    if (mins > 0) return `${mins}${minUnit}`;
    return `${secs}秒`;
  }
  if (hrs > 0) return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  if (mins > 0) return `${mins}m`;
  return `${secs}s`;
}

export function describeStallReason(reason, locale = 'en') {
  const loc = locale === 'zh-CN' || locale === 'zh-TW' ? locale : 'en';
  const map = {
    no_progress_running: {
      en: 'RUNNING with no new steps or transcript growth past threshold',
      'zh-CN': '线程处于 RUNNING 状态但超过阈值无新步骤或日志增长',
      'zh-TW': '執行緒處於 RUNNING 狀態但超過閾值無新步驟或日誌增長',
    },
    no_progress_bg_task: {
      en: 'Background task running with no output or progress past relaxed threshold',
      'zh-CN': '后台任务超过宽松阈值仍无任何日志或进度更新',
      'zh-TW': '背景任務超過寬鬆閾值仍無任何日誌或進度更新',
    },
    state_mismatch_idle_working: {
      en: 'State mismatch (RUN_STATE_IDLE while stuck in working state past grace period)',
      'zh-CN': '状态错配（会话已 IDLE 但仍卡在执行态超过宽限期）',
      'zh-TW': '狀態錯配（會話已 IDLE 但仍卡在執行態超過寬限期）',
    },
    silent_exit_no_summary: {
      en: 'Thread exited to IDLE without final summary or completion callback',
      'zh-CN': '线程静默退出至 IDLE 且无最终总结与完成回调',
      'zh-TW': '執行緒靜默退出至 IDLE 且無最終總結與完成回呼',
    },
  };
  return map[reason]?.[loc] || map.no_progress_running[loc];
}

export function buildStallAlertMessage(payload, locale = 'en') {
  const loc = locale === 'zh-CN' || locale === 'zh-TW' ? locale : 'en';
  const tid = String(payload?.threadId || '').trim();
  const localTag = payload?.localId ? ` (${payload.localId})` : '';
  const convId = String(payload?.conversationId || '').trim();
  const title = String(payload?.title || tid).trim();
  const reasonText = describeStallReason(payload?.stallReason || 'no_progress_running', loc);
  const durText = formatWatchdogDuration(payload?.stalledDurationMs || 0, loc);
  const lastProgressAt = String(payload?.lastProgressAt || '').trim() || 'unknown';
  const coordId = String(payload?.coordinatorId || '').trim();
  const wsPath = String(payload?.workspacePath || '').trim();
  const alertNum = Math.max(1, Number(payload?.alertNumber) || 1);
  const metrics = [
    `runState=\`${payload?.runState || 'UNKNOWN'}\``,
    `bucket=\`${payload?.bucket || 'unknown'}\``,
    `toolStepCount=${Number(payload?.toolStepCount) || 0}`,
    `transcriptBytes=${Number(payload?.transcriptSize) || 0}`,
    `hasPendingBgTask=${Boolean(payload?.hasPendingBgTask)}`,
    ...(payload?.activeTool ? [`activeTool=\`${String(payload.activeTool).slice(0, 80)}\``] : []),
  ].join(', ');

  if (loc === 'zh-CN') {
    return [
      `[THREAD_STALL_ALERT] 后台看门狗检测到工作线程 \`${tid}\`${localTag} 疑似卡死（第 ${alertNum} 次告警，请勿直接用 dispatch_thread 重复新建线程）：`,
      '',
      `- **线程 ID**: \`${tid}\`${localTag}${convId ? ` ([查看线程](conversation://${convId}))` : ''}`,
      `- **任务标题**: ${title}`,
      `- **停滞原因**: ${reasonText} (\`${payload?.stallReason || 'no_progress_running'}\`)`,
      `- **持续停滞**: 约 ${durText} | **最近活动**: \`${lastProgressAt}\``,
      `- **运行指标**: ${metrics}`,
      '',
      '### 建议总控处理步骤',
      `1. 调用 \`get_thread_detail\`（携带 \`threadId: "${tid}"\`${coordId ? `, coordinatorId: ${JSON.stringify(coordId)}` : ''}${wsPath ? `, workspacePath: ${JSON.stringify(wsPath)}` : ''}）核实最新状态与上下文。`,
      '2. 若线程确实停滞，优先调用 `send_thread_message` 发送轻量唤醒/催促指令；若已实际完成但未回调，核对产出并推进后续流程；若需人工介入或决策，调用 `manage_decisions` 登记到本项目右侧「待决策」看板。',
    ].join('\n');
  }

  if (loc === 'zh-TW') {
    return [
      `[THREAD_STALL_ALERT] 背景看門狗偵測到工作執行緒 \`${tid}\`${localTag} 疑似卡死（第 ${alertNum} 次告警，請勿直接用 dispatch_thread 重複建立執行緒）：`,
      '',
      `- **執行緒 ID**: \`${tid}\`${localTag}${convId ? ` ([查看執行緒](conversation://${convId}))` : ''}`,
      `- **任務標題**: ${title}`,
      `- **停滯原因**: ${reasonText} (\`${payload?.stallReason || 'no_progress_running'}\`)`,
      `- **持續停滯**: 約 ${durText} | **最近活動**: \`${lastProgressAt}\``,
      `- **執行指標**: ${metrics}`,
      '',
      '### 建議總控處理步驟',
      `1. 呼叫 \`get_thread_detail\`（攜帶 \`threadId: "${tid}"\`${coordId ? `, coordinatorId: ${JSON.stringify(coordId)}` : ''}${wsPath ? `, workspacePath: ${JSON.stringify(wsPath)}` : ''}）核實最新狀態與上下文。`,
      '2. 若執行緒確實停滯，優先呼叫 `send_thread_message` 傳送輕量喚醒指令；若需人工介入或決策，呼叫 `manage_decisions` 登記至本專案右側「待決策」看板。',
    ].join('\n');
  }

  return [
    `[THREAD_STALL_ALERT] Background Watchdog detected that worker thread \`${tid}\`${localTag} appears stalled (alert #${alertNum}; do NOT blindly spawn a duplicate thread via dispatch_thread):`,
    '',
    `- **Thread ID**: \`${tid}\`${localTag}${convId ? ` ([View Full Thread](conversation://${convId}))` : ''}`,
    `- **Task Title**: ${title}`,
    `- **Stall Reason**: ${reasonText} (\`${payload?.stallReason || 'no_progress_running'}\`)`,
    `- **Stalled For**: ~${durText} | **Last Progress**: \`${lastProgressAt}\``,
    `- **Live Metrics**: ${metrics}`,
    '',
    '### Suggested Coordinator Actions',
    `1. Call \`get_thread_detail\` (with \`threadId: "${tid}"\`${coordId ? `, coordinatorId: ${JSON.stringify(coordId)}` : ''}${wsPath ? `, workspacePath: ${JSON.stringify(wsPath)}` : ''}) to inspect live context.`,
    '2. If genuinely stuck, nudge via `send_thread_message`; if already finished without callback, verify output and continue; if user input is needed, register a card via `manage_decisions`.',
  ].join('\n');
}

/**
 * Formats one or more stall alert payloads into a single Coordinator message.
 * Batching guarantees a patrol cycle sends at most ONE message to a Coordinator,
 * preventing a second alert in the same cycle from interrupting a freshly woken Coordinator.
 */
export function buildBatchStallAlertMessage(payloads, locale = 'en') {
  const list = Array.isArray(payloads) ? payloads.filter(Boolean) : [];
  if (list.length === 0) return '';
  if (list.length === 1) return buildStallAlertMessage(list[0], locale);

  const loc = locale === 'zh-CN' || locale === 'zh-TW' ? locale : 'en';
  const idsText = list.map((p) => `\`${String(p.threadId || '').trim()}\``).join(', ');
  let header;
  if (loc === 'zh-CN') {
    header = `[THREAD_STALL_ALERT] 后台看门狗本轮巡检检测到 ${list.length} 个工作线程疑似卡死（${idsText}，已合并为单条告警以免打断运行中的总控，请勿直接用 dispatch_thread 重复新建线程）：`;
  } else if (loc === 'zh-TW') {
    header = `[THREAD_STALL_ALERT] 背景看門狗本輪巡檢偵測到 ${list.length} 個工作執行緒疑似卡死（${idsText}，已合併為單條告警以免打斷執行中的總控，請勿直接用 dispatch_thread 重複建立執行緒）：`;
  } else {
    header = `[THREAD_STALL_ALERT] Background Watchdog detected ${list.length} stalled worker threads in this patrol cycle (${idsText}; batched into a single message so the Coordinator is never interrupted mid-turn; do NOT spawn duplicate threads via dispatch_thread):`;
  }
  const sections = list.map((p) => buildStallAlertMessage(p, loc));
  return [header, '', ...sections.flatMap((s, idx) => (idx === 0 ? [s] : ['', '---', '', s]))].join('\n');
}

function computeNextCooldownMs(nextAlertCount, config) {
  const baseMin = Number(config?.cooldownMin) || WATCHDOG_DEFAULTS.cooldownMin;
  const escMin = Math.max(baseMin, Number(config?.escalatedCooldownMin) || WATCHDOG_DEFAULTS.escalatedCooldownMin);
  if (nextAlertCount <= 1) return baseMin * 60_000;
  if (nextAlertCount === 2) return escMin * 60_000;
  return Math.min(WATCHDOG_LIMITS.escalatedCooldownMin.max, escMin * 2) * 60_000;
}

/**
 * Pure stall-detection state machine for a single thread.
 * Zero side effects; deterministic given `nowMs`, `config`, `signals`, and `prevEntry`.
 */
export function evaluateThreadWatchdogState({
  thread,
  signals,
  prevEntry = null,
  config = WATCHDOG_DEFAULTS,
  nowMs = Date.now(),
}) {
  const nowIso = new Date(nowMs).toISOString();
  const prev = prevEntry && typeof prevEntry === 'object' ? prevEntry : null;
  const isPreviouslyActive = Boolean(prev && prev.state && prev.state !== 'cleared');

  // 1. Archived threads always clear immediately
  if (!thread || thread.archived) {
    return {
      entry: isPreviouslyActive ? buildClearedWatchdogEntry(nowIso) : null,
      stalled: false,
      shouldAlert: false,
      recovered: Boolean(prev?.stalled),
      skipReason: 'archived',
    };
  }

  const runState = String(signals?.runState || thread.runState || '').trim();
  const bucket = String(signals?.bucket || thread.bucket || '').trim();
  const needsUserAction = Boolean(signals?.needsUserAction);
  const liveHasPendingBg = Boolean(signals?.liveHasPendingBgTask);
  const storedHasPendingBg = Boolean(signals?.storedHasPendingBgTask);
  const transcriptExists = Boolean(signals?.transcriptStat?.exists);
  const transcriptSize = Number(signals?.transcriptStat?.size) || 0;
  const transcriptMtimeMs = Number(signals?.transcriptStat?.mtimeMs) || 0;
  const toolStepCount = Number(signals?.toolStepCount) || 0;
  const updatedAtIso = String(signals?.updatedAt || thread.updatedAt || '').trim();
  const updatedAtMs = parseIsoMs(updatedAtIso);
  const hasCompletionContent = Boolean(
    thread.lastSummary ||
      thread.pushedToCoordinatorAt ||
      thread.notifiedCoordinatorAt ||
      Number(signals?.completion?.stepIndex) >= 0 ||
      signals?.completion?.fullReport ||
      signals?.completion?.cardSummary,
  );

  // 2. Waiting on user input / confirmation (e.g. ask_question or bucket === 'waiting') -> never stall!
  if (needsUserAction || bucket === 'waiting') {
    return {
      entry: isPreviouslyActive ? buildClearedWatchdogEntry(nowIso) : null,
      stalled: false,
      shouldAlert: false,
      recovered: Boolean(prev?.stalled),
      skipReason: 'waiting_user_action',
    };
  }

  // Verified live background task (transcript exists and live parser confirms pending bg task)
  const hasVerifiedBgTask = transcriptExists && liveHasPendingBg;
  const isRunning = runState === 'RUN_STATE_RUNNING';
  const isIdle = runState === 'RUN_STATE_IDLE' || (!isRunning && runState !== '');
  const isIdleWorkingMismatch =
    isIdle &&
    !hasVerifiedBgTask &&
    (bucket === 'working' || storedHasPendingBg || (!transcriptExists && liveHasPendingBg));
  const isSilentExitCandidate =
    isIdle &&
    !hasVerifiedBgTask &&
    !isIdleWorkingMismatch &&
    !hasCompletionContent &&
    Boolean(prev && (prev.state === 'watching' || prev.state === 'stalled'));

  // 3. Normal IDLE / ready thread -> never stall, auto-clear prior state
  if (!isRunning && !hasVerifiedBgTask && !isIdleWorkingMismatch && !isSilentExitCandidate) {
    return {
      entry: isPreviouslyActive ? buildClearedWatchdogEntry(nowIso) : null,
      stalled: false,
      shouldAlert: false,
      recovered: Boolean(prev?.stalled),
      skipReason: 'idle',
    };
  }

  // 3. Check startup / follow-up resume grace period
  const createdMs = parseIsoMs(thread.createdAt);
  let latestPendingUserMs = 0;
  if (Array.isArray(thread.pendingUserMessages)) {
    for (const pm of thread.pendingUserMessages) {
      const pms = parseIsoMs(pm?.createdAt);
      if (pms > latestPendingUserMs) latestPendingUserMs = pms;
    }
  }
  const resumeAnchorMs = Math.max(createdMs, latestPendingUserMs);
  const startupGraceMs = (Number(config.startupGraceSec) || WATCHDOG_DEFAULTS.startupGraceSec) * 1000;

  // Determine latest observed signal timestamp (never exceeding nowMs)
  const rawSignalCandidates = [createdMs, latestPendingUserMs, updatedAtMs, transcriptMtimeMs].filter(
    (ms) => Number.isFinite(ms) && ms > 0 && ms <= nowMs + 5000,
  );
  const latestSignalMs = rawSignalCandidates.length
    ? Math.min(nowMs, Math.max(...rawSignalCandidates))
    : nowMs;

  // Detect forward progress compared to previous sample
  const prevSteps = Number(prev?.lastObservedStepCount) || 0;
  const prevSize = Number(prev?.lastObservedTranscriptSize) || 0;
  const prevMtimeMs = Number(prev?.lastObservedTranscriptMtimeMs) || 0;
  const prevUpdatedMs = parseIsoMs(prev?.lastObservedUpdatedAt);

  const hasProgress = Boolean(
    isPreviouslyActive &&
      (toolStepCount > prevSteps ||
        transcriptSize > prevSize ||
        (transcriptMtimeMs > 0 && prevMtimeMs > 0 && transcriptMtimeMs > prevMtimeMs + 500) ||
        (updatedAtMs > 0 && prevUpdatedMs > 0 && updatedAtMs > prevUpdatedMs + 1000)),
  );

  let lastProgressMs;
  if (!isPreviouslyActive) {
    lastProgressMs = latestSignalMs;
  } else if (hasProgress) {
    lastProgressMs = Math.max(latestSignalMs, nowMs);
  } else {
    const prevProgressMs = parseIsoMs(prev?.lastProgressAt);
    lastProgressMs = prevProgressMs > 0 ? Math.max(prevProgressMs, latestSignalMs) : latestSignalMs;
  }
  const lastProgressIso = new Date(lastProgressMs).toISOString();

  // If forward progress occurred, immediately recover / reset alerts & snooze
  if (hasProgress) {
    const wasStalled = Boolean(prev?.stalled);
    return {
      entry: {
        state: 'watching',
        lastProgressAt: lastProgressIso,
        lastObservedStepCount: toolStepCount,
        lastObservedTranscriptSize: transcriptSize,
        lastObservedTranscriptMtimeMs: transcriptMtimeMs,
        lastObservedUpdatedAt: updatedAtIso,
        mismatchSinceAt: '',
        stalled: false,
        stallReason: '',
        stallFingerprint: '',
        stalledSinceAt: '',
        stalledDurationMs: 0,
        alertCount: 0,
        lastAlertFingerprint: '',
        lastAlertAt: '',
        lastAlertCoordinatorId: '',
        nextAlertEligibleAt: '',
        pendingDelivery: false,
        pendingDeliveryReason: '',
        pendingDeliveryPayload: null,
        deliveryState: '',
        deliveryClaimToken: '',
        deliveryClaimedAt: '',
        deliveryClaimOwner: '',
        snoozedUntil: '',
        snoozedFingerprint: '',
        updatedAt: nowIso,
      },
      stalled: false,
      shouldAlert: false,
      recovered: wasStalled,
      skipReason: 'progress_observed',
    };
  }

  // Startup / resume grace period guard
  if (resumeAnchorMs > 0 && nowMs - resumeAnchorMs < startupGraceMs) {
    return {
      entry: {
        ...(prev || {}),
        state: 'watching',
        lastProgressAt: lastProgressIso,
        lastObservedStepCount: toolStepCount,
        lastObservedTranscriptSize: transcriptSize,
        lastObservedTranscriptMtimeMs: transcriptMtimeMs,
        lastObservedUpdatedAt: updatedAtIso,
        mismatchSinceAt: '',
        stalled: false,
        stallReason: '',
        stallFingerprint: '',
        stalledSinceAt: '',
        stalledDurationMs: 0,
        pendingDelivery: false,
        pendingDeliveryReason: '',
        pendingDeliveryPayload: null,
        deliveryState: '',
        deliveryClaimToken: '',
        deliveryClaimedAt: '',
        deliveryClaimOwner: '',
        updatedAt: nowIso,
      },
      stalled: false,
      shouldAlert: false,
      recovered: false,
      skipReason: 'startup_grace',
    };
  }

  // 4. Active snooze check
  const prevSnoozeUntilMs = parseIsoMs(prev?.snoozedUntil);
  if (prev?.state === 'snoozed' && prevSnoozeUntilMs > nowMs) {
    return {
      entry: {
        ...prev,
        state: 'snoozed',
        stalled: false,
        lastProgressAt: lastProgressIso,
        lastObservedStepCount: toolStepCount,
        lastObservedTranscriptSize: transcriptSize,
        lastObservedTranscriptMtimeMs: transcriptMtimeMs,
        lastObservedUpdatedAt: updatedAtIso,
        pendingDelivery: false,
        pendingDeliveryReason: '',
        pendingDeliveryPayload: null,
        deliveryState: '',
        deliveryClaimToken: '',
        deliveryClaimedAt: '',
        deliveryClaimOwner: '',
        updatedAt: nowIso,
      },
      stalled: false,
      shouldAlert: false,
      recovered: false,
      skipReason: 'snoozed',
    };
  }

  // 5. Evaluate stall condition and applicable threshold
  let stallReason = '';
  let stalledDurationMs = Math.max(0, nowMs - lastProgressMs);
  let mismatchSinceIso = '';

  if (isIdleWorkingMismatch || isSilentExitCandidate) {
    const mismatchGraceMs =
      (Number(config.mismatchGraceMin) || WATCHDOG_DEFAULTS.mismatchGraceMin) * 60_000;
    const prevMismatchMs = parseIsoMs(prev?.mismatchSinceAt);
    const mismatchStartMs =
      prevMismatchMs > 0
        ? prevMismatchMs
        : lastProgressMs > 0 && nowMs - lastProgressMs >= mismatchGraceMs
          ? lastProgressMs
          : nowMs;
    mismatchSinceIso = new Date(mismatchStartMs).toISOString();
    const mismatchAgeMs = Math.max(0, nowMs - mismatchStartMs);
    if (mismatchAgeMs >= mismatchGraceMs) {
      stallReason = isIdleWorkingMismatch ? 'state_mismatch_idle_working' : 'silent_exit_no_summary';
      stalledDurationMs = mismatchAgeMs;
    }
  } else if (hasVerifiedBgTask) {
    const bgThresholdMs =
      Math.max(
        Number(config.stallThresholdMin) || WATCHDOG_DEFAULTS.stallThresholdMin,
        Number(config.bgTaskThresholdMin) || WATCHDOG_DEFAULTS.bgTaskThresholdMin,
      ) * 60_000;
    if (stalledDurationMs >= bgThresholdMs) {
      stallReason = 'no_progress_bg_task';
    }
  } else if (isRunning) {
    const runThresholdMs =
      (Number(config.stallThresholdMin) || WATCHDOG_DEFAULTS.stallThresholdMin) * 60_000;
    if (stalledDurationMs >= runThresholdMs) {
      stallReason = 'no_progress_running';
    }
  }

  // Not stalled yet -> stay watching cleanly
  if (!stallReason) {
    return {
      entry: {
        state: 'watching',
        lastProgressAt: lastProgressIso,
        lastObservedStepCount: toolStepCount,
        lastObservedTranscriptSize: transcriptSize,
        lastObservedTranscriptMtimeMs: transcriptMtimeMs,
        lastObservedUpdatedAt: updatedAtIso,
        mismatchSinceAt: mismatchSinceIso,
        stalled: false,
        stallReason: '',
        stallFingerprint: '',
        stalledSinceAt: '',
        stalledDurationMs: 0,
        alertCount: 0,
        lastAlertFingerprint: '',
        lastAlertAt: '',
        lastAlertCoordinatorId: '',
        nextAlertEligibleAt: '',
        pendingDelivery: false,
        pendingDeliveryReason: '',
        pendingDeliveryPayload: null,
        deliveryState: '',
        deliveryClaimToken: '',
        deliveryClaimedAt: '',
        deliveryClaimOwner: '',
        snoozedUntil: '',
        snoozedFingerprint: '',
        updatedAt: nowIso,
      },
      stalled: false,
      shouldAlert: false,
      recovered: Boolean(prev?.stalled),
      skipReason: 'within_threshold',
    };
  }

  // 6. Stalled -> compute deterministic fingerprint & check cooldown / escalation eligibility
  const stallFingerprint = `${stallReason}|s:${toolStepCount}|b:${transcriptSize}|rs:${runState}|bg:${hasVerifiedBgTask ? 1 : 0}`;
  const sameFingerprint = Boolean(prev?.lastAlertFingerprint && prev.lastAlertFingerprint === stallFingerprint);
  const prevAlertCount = sameFingerprint ? Number(prev?.alertCount) || 0 : 0;
  const nextEligibleMs = sameFingerprint ? parseIsoMs(prev?.nextAlertEligibleAt) : 0;
  const stalledSinceIso =
    prev?.stalled && prev?.stalledSinceAt && prev?.stallReason === stallReason
      ? prev.stalledSinceAt
      : nowIso;
  const samePendingFp = Boolean(prev?.stallFingerprint === stallFingerprint);
  const activeDeliveringClaim = samePendingFp && isDeliveryClaimActive(prev, nowMs);
  const expiredDeliveringClaim =
    samePendingFp && prev?.deliveryState === 'delivering' && !activeDeliveringClaim;

  let shouldAlert = false;
  if (activeDeliveringClaim) {
    // Delivery is actively claimed and in flight -> never trigger a duplicate alert
    shouldAlert = false;
  } else if (expiredDeliveringClaim) {
    // Previous sender crashed / claim expired -> reclaim and retry delivery
    shouldAlert = true;
  } else if (prev?.pendingDelivery && samePendingFp) {
    // Deferred due to Coordinator RUN_STATE_RUNNING, unknown state, or mid-delivery rebind -> deliver as soon as IDLE;
    // deferred due to delivery_failed -> respect short failure retry backoff.
    if (prev.pendingDeliveryReason === 'delivery_failed') {
      const retryAfterMs = parseIsoMs(prev?.nextAlertEligibleAt);
      shouldAlert = !retryAfterMs || nowMs >= retryAfterMs;
    } else {
      shouldAlert = true;
    }
  } else if (prevAlertCount === 0) {
    shouldAlert = true;
  } else if (
    prevAlertCount < WATCHDOG_MAX_AUTO_ALERTS_PER_FINGERPRINT &&
    (!nextEligibleMs || nowMs >= nextEligibleMs)
  ) {
    shouldAlert = true;
  }

  const preservePending = Boolean(
    activeDeliveringClaim || expiredDeliveringClaim || (prev?.pendingDelivery && samePendingFp),
  );
  const nextDeliveryState = activeDeliveringClaim
    ? 'delivering'
    : preservePending
      ? 'pending'
      : '';

  return {
    entry: {
      state: 'stalled',
      lastProgressAt: lastProgressIso,
      lastObservedStepCount: toolStepCount,
      lastObservedTranscriptSize: transcriptSize,
      lastObservedTranscriptMtimeMs: transcriptMtimeMs,
      lastObservedUpdatedAt: updatedAtIso,
      mismatchSinceAt: mismatchSinceIso,
      stalled: true,
      stallReason,
      stallFingerprint,
      stalledSinceAt: stalledSinceIso,
      stalledDurationMs,
      alertCount: prevAlertCount,
      lastAlertFingerprint: sameFingerprint ? String(prev?.lastAlertFingerprint || '') : '',
      lastAlertAt: sameFingerprint ? String(prev?.lastAlertAt || '') : '',
      lastAlertCoordinatorId: sameFingerprint ? String(prev?.lastAlertCoordinatorId || '') : '',
      nextAlertEligibleAt: sameFingerprint ? String(prev?.nextAlertEligibleAt || '') : '',
      pendingDelivery: preservePending,
      pendingDeliveryReason: activeDeliveringClaim
        ? String(prev?.pendingDeliveryReason || 'delivering')
        : expiredDeliveringClaim
          ? 'delivery_claim_expired'
          : preservePending
            ? String(prev?.pendingDeliveryReason || '')
            : '',
      pendingDeliveryPayload: preservePending ? prev?.pendingDeliveryPayload || null : null,
      deliveryState: nextDeliveryState,
      deliveryClaimToken: activeDeliveringClaim ? String(prev?.deliveryClaimToken || '') : '',
      deliveryClaimedAt: activeDeliveringClaim ? String(prev?.deliveryClaimedAt || '') : '',
      deliveryClaimOwner: activeDeliveringClaim ? String(prev?.deliveryClaimOwner || '') : '',
      snoozedUntil: '',
      snoozedFingerprint: '',
      updatedAt: nowIso,
    },
    stalled: true,
    shouldAlert,
    nextAlertNumber: prevAlertCount + 1,
    recovered: false,
    skipReason: activeDeliveringClaim ? 'delivery_in_flight' : '',
  };
}

function resolveLiveActiveCoordinatorForScope(reg, scopeKey) {
  const normScope = normalizeWatchdogScopeKey(scopeKey);
  if (!normScope || !reg?.coordinators) return null;
  let coord = reg.coordinators[normScope] || reg.coordinators[scopeKey] || null;
  if (!coord) {
    for (const [ck, c] of Object.entries(reg.coordinators)) {
      if (isSameScope(ck, normScope)) {
        coord = c;
        break;
      }
    }
  }
  if (!coord || !coord.conversationId) return null;
  const cid = String(coord.conversationId).trim();
  if (!cid) return null;
  // Never deliver to a retired Coordinator or a Worker Thread
  if (findRetiredCoordinatorOwner(reg, cid)) return null;
  if (Array.isArray(coord.retiredCoordinatorIds) && coord.retiredCoordinatorIds.includes(cid)) {
    return null;
  }
  const isWorker = Object.values(reg.threads || {}).some((t) => t && t.conversationId === cid);
  if (isWorker) return null;
  return coord;
}

function defaultDeps(overrides = {}) {
  return {
    now: () => Date.now(),
    getConversation,
    invokeAgentApiSend,
    peekLiveActivity,
    extractThreadCompletion,
    statTranscript: defaultStatTranscript,
    loadRegistry,
    mutateRegistry,
    loadSettings,
    resolveAppLocale,
    ...overrides,
  };
}

/**
 * Inspects a single project scope (`scopeKey`) strictly isolated from all other projects.
 * - Zero-overhead skip if disabled, unbound, or no active/watching threads exist (ZERO LS RPCs).
 * - Per-scope re-entrancy guard prevents overlapping timers from stacking.
 * - Never interrupts a Coordinator in `RUN_STATE_RUNNING` (defers delivery to IDLE / PreInvocation).
 * - Never sends to retired Coordinators (`retiredCoordinatorIds` / `assertNotRetiredCoordinator`).
 */
export async function patrolProjectScope(
  rawScopeKey,
  {
    manual = false,
    targetThreadId = '',
    forceWake = false,
    deps: depsOverrides = {},
  } = {},
) {
  const scopeKey = normalizeWatchdogScopeKey(rawScopeKey);
  if (!scopeKey) {
    return {
      ok: false,
      skipped: true,
      reason: 'missing_scope',
      scopeKey: '',
      checkedCount: 0,
      stalledCount: 0,
      alertedCount: 0,
      deferredCount: 0,
      recoveredCount: 0,
      results: [],
    };
  }

  if (inFlightScopes.has(scopeKey)) {
    return {
      ok: true,
      skipped: true,
      reason: 'in_progress',
      scopeKey,
      checkedCount: 0,
      stalledCount: 0,
      alertedCount: 0,
      deferredCount: 0,
      recoveredCount: 0,
      results: [],
    };
  }

  const d = defaultDeps(depsOverrides);
  const nowMs = d.now();
  const nowIso = new Date(nowMs).toISOString();

  inFlightScopes.add(scopeKey);
  try {
    const reg = d.loadRegistry();
    const coord = resolveLiveActiveCoordinatorForScope(reg, scopeKey);
    if (!coord) {
      return {
        ok: true,
        skipped: true,
        reason: 'no_coordinator',
        scopeKey,
        checkedCount: 0,
        stalledCount: 0,
        alertedCount: 0,
        deferredCount: 0,
        recoveredCount: 0,
        results: [],
      };
    }

    const settings = d.loadSettings();
    const config = resolveEffectiveWatchdogConfig(
      settings,
      scopeKey,
      coord.repoRoot || coord.workspacePath || '',
    );
    if (!config.enabled && !manual) {
      return {
        ok: true,
        skipped: true,
        reason: 'disabled',
        scopeKey,
        checkedCount: 0,
        stalledCount: 0,
        alertedCount: 0,
        deferredCount: 0,
        recoveredCount: 0,
        results: [],
      };
    }

    const prevScopeState = reg.watchdogState?.[scopeKey] || reg.watchdogState?.[rawScopeKey] || null;
    const prevThreadsMap =
      prevScopeState?.threads && typeof prevScopeState.threads === 'object'
        ? prevScopeState.threads
        : {};

    // Strictly filter threads belonging ONLY to this project scope
    const scopeThreads = Object.values(reg.threads || {}).filter(
      (t) => t && t.threadId && isSameScope(t.workspaceKey, scopeKey),
    );

    const candidateThreads = scopeThreads.filter((t) => {
      if (targetThreadId && t.threadId !== targetThreadId) return false;
      const prev = prevThreadsMap[t.threadId];
      const hasPrevActive = Boolean(prev && prev.state && prev.state !== 'cleared');
      if (t.archived) return hasPrevActive;
      if (targetThreadId && t.threadId === targetThreadId) return true;
      return (
        t.runState === 'RUN_STATE_RUNNING' ||
        t.bucket === 'working' ||
        Boolean(t.hasPendingBgTask) ||
        hasPrevActive
      );
    });

    // Zero-overhead fast skip when no active or tracked threads exist in this scope (ZERO LS RPCs!)
    if (candidateThreads.length === 0) {
      if (manual) {
        d.mutateRegistry((freshReg) => {
          if (!freshReg.watchdogState || typeof freshReg.watchdogState !== 'object') {
            freshReg.watchdogState = {};
          }
          const existing = freshReg.watchdogState[scopeKey] || {
            scopeKey,
            threads: {},
          };
          freshReg.watchdogState[scopeKey] = {
            ...existing,
            scopeKey,
            coordinatorId: coord.conversationId,
            lastPatrolAt: nowIso,
            lastPatrolSkippedReason: 'no_active_threads',
            lastActiveCount: 0,
            lastStalledCount: 0,
            updatedAt: nowIso,
            threads: existing.threads || {},
          };
        });
      }
      return {
        ok: true,
        skipped: true,
        reason: 'no_active_threads',
        scopeKey,
        checkedCount: 0,
        stalledCount: 0,
        alertedCount: 0,
        deferredCount: 0,
        recoveredCount: 0,
        results: [],
      };
    }

    // Probe candidate threads non-blockingly with hard per-RPC timeout
    const evaluated = [];
    for (const t of candidateThreads) {
      let liveRunState = t.runState || '';
      let liveUpdatedAt = t.updatedAt || '';
      let liveArchived = Boolean(t.archived);

      if (!liveArchived && t.conversationId) {
        try {
          const live = await d.getConversation(t.conversationId, WATCHDOG_LS_PROBE_TIMEOUT_MS);
          const conv = live?.conversation || live;
          if (conv?.state?.runState) liveRunState = conv.state.runState;
          if (conv?.state?.updateTime) liveUpdatedAt = conv.state.updateTime;
          if (typeof conv?.annotations?.archived === 'boolean') liveArchived = conv.annotations.archived;
        } catch {
          // Transient LS unavailability falls back gracefully to registry + local transcript signals
        }
      }

      const transcriptStat = !liveArchived && t.conversationId
        ? d.statTranscript(t.conversationId)
        : { exists: false, size: 0, mtimeMs: 0 };
      const liveAct = !liveArchived && t.conversationId
        ? d.peekLiveActivity(t.conversationId, { runState: liveRunState })
        : { toolStepCount: 0, hasPendingBgTask: false, needsUserAction: false, activeTool: '', lastStepIndex: -1 };
      const completion =
        !liveArchived && liveRunState === 'RUN_STATE_IDLE' && t.conversationId
          ? d.extractThreadCompletion(t.conversationId)
          : null;

      let effectivePrev = prevThreadsMap[t.threadId] || null;
      if (forceWake && targetThreadId && t.threadId === targetThreadId && effectivePrev?.state === 'snoozed') {
        effectivePrev = { ...effectivePrev, state: 'watching', snoozedUntil: '', snoozedFingerprint: '' };
      }

      const evalOut = evaluateThreadWatchdogState({
        thread: { ...t, archived: liveArchived },
        signals: {
          runState: liveRunState,
          updatedAt: liveUpdatedAt,
          bucket: t.bucket || '',
          toolStepCount: liveAct?.toolStepCount || 0,
          liveHasPendingBgTask: Boolean(liveAct?.hasPendingBgTask),
          storedHasPendingBgTask: Boolean(t.hasPendingBgTask),
          needsUserAction: Boolean(liveAct?.needsUserAction),
          activeTool: liveAct?.activeTool || t.activeTool || '',
          transcriptStat,
          completion,
        },
        prevEntry: effectivePrev,
        config,
        nowMs,
      });

      const alertRequired = Boolean(
        evalOut.stalled && (evalOut.shouldAlert || (forceWake && targetThreadId === t.threadId)),
      );
      evaluated.push({
        thread: t,
        liveRunState,
        liveArchived,
        transcriptStat,
        liveAct,
        evalOut,
        alertRequired,
      });
    }

    const stalledItems = evaluated.filter((x) => x.evalOut.stalled);
    const recoveredCount = evaluated.filter((x) => x.evalOut.recovered).length;
    const activeCount = evaluated.filter(
      (x) =>
        !x.liveArchived &&
        x.evalOut.skipReason !== 'waiting_user_action' &&
        (x.liveRunState === 'RUN_STATE_RUNNING' || x.liveAct?.hasPendingBgTask || x.thread.bucket === 'working'),
    ).length;

    // 1. Immediately persist stall / watching / cleared state so Board & Pending Decisions update right away
    d.mutateRegistry((freshReg) => {
      if (!freshReg.watchdogState || typeof freshReg.watchdogState !== 'object') {
        freshReg.watchdogState = {};
      }
      const existingScope = freshReg.watchdogState[scopeKey] || {
        scopeKey,
        coordinatorId: coord.conversationId,
        lastPatrolAt: '',
        lastPatrolSkippedReason: '',
        lastActiveCount: 0,
        lastStalledCount: 0,
        updatedAt: '',
        threads: {},
      };
      if (!existingScope.threads || typeof existingScope.threads !== 'object') {
        existingScope.threads = {};
      }

      const persistNowMs = d.now();
      for (const item of evaluated) {
        if (!item.evalOut.entry) continue;
        const tid = item.thread.threadId;
        const currentDiskEntry = existingScope.threads[tid];
        // Respect any concurrent newer snooze written while probes were running
        if (
          !forceWake &&
          currentDiskEntry?.state === 'snoozed' &&
          parseIsoMs(currentDiskEntry.snoozedUntil) > persistNowMs &&
          String(currentDiskEntry.updatedAt || '') > String(prevThreadsMap[tid]?.updatedAt || '')
        ) {
          item.alertRequired = false;
          continue;
        }
        // Respect any concurrent active `delivering` claim written while probes were running
        if (
          item.evalOut.stalled &&
          currentDiskEntry?.state === 'stalled' &&
          currentDiskEntry.stallFingerprint === item.evalOut.entry.stallFingerprint &&
          isDeliveryClaimActive(currentDiskEntry, persistNowMs)
        ) {
          item.alertRequired = false;
          continue;
        }
        // Respect any concurrent delivery (e.g. PreInvocation) that advanced alertCount while probes ran
        if (
          !forceWake &&
          item.evalOut.stalled &&
          currentDiskEntry?.state === 'stalled' &&
          currentDiskEntry.stallFingerprint === item.evalOut.entry.stallFingerprint &&
          !currentDiskEntry.pendingDelivery &&
          (Number(currentDiskEntry.alertCount) || 0) > (Number(item.evalOut.entry.alertCount) || 0)
        ) {
          item.alertRequired = false;
          continue;
        }
        existingScope.threads[tid] = item.evalOut.entry;
      }

      existingScope.scopeKey = scopeKey;
      existingScope.coordinatorId = coord.conversationId;
      existingScope.lastPatrolAt = nowIso;
      existingScope.lastPatrolSkippedReason = '';
      existingScope.lastActiveCount = activeCount;
      existingScope.lastStalledCount = stalledItems.length;
      existingScope.updatedAt = nowIso;
      freshReg.watchdogState[scopeKey] = existingScope;
    });

    // 2. Deliver [THREAD_STALL_ALERT] for eligible stalled threads:
    //    - Fail-closed Coordinator runState check (only explicit RUN_STATE_IDLE delivers; RUNNING or probe error defers)
    //    - Atomic claim inside mutateRegistry (`deliveryState: 'delivering'` + unique token) before sending
    //    - Batch all alerts in this patrol cycle into ONE message so sending never interrupts a freshly woken Coordinator
    const itemsToAlert = evaluated.filter((x) => x.alertRequired);
    let alertedCount = 0;
    let deferredCount = 0;
    const results = [];

    if (itemsToAlert.length > 0) {
      if (inFlightDeliveries.has(scopeKey)) {
        for (const item of itemsToAlert) {
          deferredCount++;
          results.push({
            threadId: item.thread.threadId,
            stalled: true,
            delivered: false,
            deferred: true,
            reason: 'delivery_in_flight',
            stallReason: item.evalOut.entry.stallReason,
          });
        }
      } else {
        inFlightDeliveries.add(scopeKey);
        try {
          // Live re-read of registry right before Coordinator check & delivery (honors #5 Rebind immediately)
          const latestReg = d.loadRegistry();
          const liveCoord = resolveLiveActiveCoordinatorForScope(latestReg, scopeKey);
          if (liveCoord) {
            assertNotRetiredCoordinator(latestReg, { coordinatorId: liveCoord.conversationId });
            const probedCoordId = liveCoord.conversationId;
            let coordRunState = '';
            let coordProbeFailed = false;
            try {
              const coordLive = await d.getConversation(probedCoordId, WATCHDOG_LS_PROBE_TIMEOUT_MS);
              const conv = coordLive?.conversation || coordLive;
              coordRunState = String(conv?.state?.runState || '').trim();
            } catch {
              coordProbeFailed = true;
            }

            const locale = d.resolveAppLocale();
            const wsPath = liveCoord.repoRoot || liveCoord.workspacePath || '';
            const buildPayloadForItem = (item, coordinatorId, curAlertCount = null) => {
              const tid = item.thread.threadId;
              const entry = item.evalOut.entry;
              const baseCount =
                curAlertCount !== null ? Number(curAlertCount) || 0 : Number(entry.alertCount) || 0;
              const alertNumber = Math.max(
                1,
                curAlertCount !== null ? baseCount + 1 : Number(item.evalOut.nextAlertNumber) || baseCount + 1,
              );
              return {
                threadId: tid,
                localId: item.thread.localId || (item.thread.projectSeq ? `#${item.thread.projectSeq}` : ''),
                title: item.thread.title || tid,
                conversationId: item.thread.conversationId || '',
                coordinatorId,
                workspacePath: wsPath,
                stallReason: entry.stallReason,
                stallFingerprint: entry.stallFingerprint,
                stalledDurationMs: entry.stalledDurationMs,
                lastProgressAt: entry.lastProgressAt,
                runState: item.liveRunState,
                bucket: item.thread.bucket || '',
                toolStepCount: item.liveAct?.toolStepCount || 0,
                transcriptSize: item.transcriptStat?.size || 0,
                hasPendingBgTask: Boolean(item.liveAct?.hasPendingBgTask),
                activeTool: item.liveAct?.activeTool || '',
                alertNumber,
              };
            };

            // CRITICAL NON-BLOCKING + FAIL-CLOSED RULE:
            // Only explicit RUN_STATE_IDLE may deliver! RUNNING or failed/unknown probe MUST defer.
            if (coordProbeFailed || coordRunState !== 'RUN_STATE_IDLE') {
              const deferReason =
                coordRunState === 'RUN_STATE_RUNNING'
                  ? 'coordinator_running'
                  : 'coordinator_state_unknown';
              const deferNowMs = d.now();
              const deferNowIso = new Date(deferNowMs).toISOString();
              const deferredList = d.mutateRegistry((freshReg) => {
                const sc = freshReg.watchdogState?.[scopeKey];
                const out = [];
                if (!sc?.threads) return out;
                for (const item of itemsToAlert) {
                  const tid = item.thread.threadId;
                  const cur = sc.threads[tid];
                  if (!cur || cur.state !== 'stalled') continue;
                  if (isDeliveryClaimActive(cur, deferNowMs)) {
                    out.push({ tid, stallReason: item.evalOut.entry.stallReason, reason: 'delivery_in_flight' });
                    continue;
                  }
                  const payload = buildPayloadForItem(item, probedCoordId, cur.alertCount);
                  cur.pendingDelivery = true;
                  cur.pendingDeliveryReason = deferReason;
                  cur.pendingDeliveryPayload = payload;
                  cur.deliveryState = 'pending';
                  cur.deliveryClaimToken = '';
                  cur.deliveryClaimedAt = '';
                  cur.deliveryClaimOwner = '';
                  cur.updatedAt = deferNowIso;
                  out.push({ tid, stallReason: item.evalOut.entry.stallReason, reason: deferReason });
                }
                if (out.length > 0) sc.updatedAt = deferNowIso;
                return out;
              });
              for (const rec of deferredList || []) {
                deferredCount++;
                results.push({
                  threadId: rec.tid,
                  stalled: true,
                  delivered: false,
                  deferred: true,
                  reason: rec.reason,
                  stallReason: rec.stallReason,
                });
              }
            } else {
              // Step 2a: Atomically claim all eligible alerts inside mutateRegistry BEFORE sending
              const claimToken = randomUUID();
              const claimNowMs = d.now();
              const claimNowIso = new Date(claimNowMs).toISOString();
              const claimOutcome = d.mutateRegistry((freshReg) => {
                const freshCoord = resolveLiveActiveCoordinatorForScope(freshReg, scopeKey);
                if (!freshCoord) {
                  return { ok: false, reason: 'no_coordinator', claimed: [], skipped: [] };
                }
                assertNotRetiredCoordinator(freshReg, { coordinatorId: freshCoord.conversationId });
                const sc = freshReg.watchdogState?.[scopeKey];
                if (!sc?.threads) {
                  return { ok: false, reason: 'no_scope_state', claimed: [], skipped: [] };
                }

                // If Coordinator was rebound between probe and claim, defer so next cycle probes the new Coordinator
                if (freshCoord.conversationId !== probedCoordId) {
                  const reboundSkipped = [];
                  for (const item of itemsToAlert) {
                    const tid = item.thread.threadId;
                    const cur = sc.threads[tid];
                    if (!cur || cur.state !== 'stalled' || isDeliveryClaimActive(cur, claimNowMs)) continue;
                    const payload = buildPayloadForItem(item, freshCoord.conversationId, cur.alertCount);
                    cur.pendingDelivery = true;
                    cur.pendingDeliveryReason = 'coordinator_rebound_during_delivery';
                    cur.pendingDeliveryPayload = payload;
                    cur.deliveryState = 'pending';
                    cur.deliveryClaimToken = '';
                    cur.deliveryClaimedAt = '';
                    cur.deliveryClaimOwner = '';
                    cur.updatedAt = claimNowIso;
                    reboundSkipped.push({
                      threadId: tid,
                      stalled: true,
                      delivered: false,
                      deferred: true,
                      reason: 'coordinator_rebound_during_delivery',
                      stallReason: item.evalOut.entry.stallReason,
                    });
                  }
                  if (reboundSkipped.length > 0) sc.updatedAt = claimNowIso;
                  return {
                    ok: false,
                    reason: 'coordinator_rebound_during_delivery',
                    claimed: [],
                    skipped: reboundSkipped,
                  };
                }

                const claimed = [];
                const skipped = [];
                for (const item of itemsToAlert) {
                  const tid = item.thread.threadId;
                  const entry = item.evalOut.entry;
                  const cur = sc.threads[tid];
                  if (!cur || cur.state !== 'stalled' || !cur.stalled) {
                    continue;
                  }
                  if (parseIsoMs(cur.snoozedUntil) > claimNowMs) {
                    continue;
                  }
                  if (isDeliveryClaimActive(cur, claimNowMs)) {
                    skipped.push({
                      threadId: tid,
                      stalled: true,
                      delivered: false,
                      deferred: true,
                      reason: 'delivery_in_flight',
                      stallReason: entry.stallReason,
                    });
                    continue;
                  }
                  const alreadyDeliveredForFp =
                    !forceWake &&
                    !cur.pendingDelivery &&
                    cur.lastAlertFingerprint === entry.stallFingerprint &&
                    (parseIsoMs(cur.nextAlertEligibleAt) > claimNowMs ||
                      (Number(cur.alertCount) || 0) >= WATCHDOG_MAX_AUTO_ALERTS_PER_FINGERPRINT);
                  if (alreadyDeliveredForFp) {
                    skipped.push({
                      threadId: tid,
                      stalled: true,
                      delivered: false,
                      deferred: false,
                      reason: 'already_delivered',
                      stallReason: entry.stallReason,
                    });
                    continue;
                  }

                  const payload = buildPayloadForItem(item, freshCoord.conversationId, cur.alertCount);
                  cur.deliveryState = 'delivering';
                  cur.deliveryClaimToken = claimToken;
                  cur.deliveryClaimedAt = claimNowIso;
                  cur.deliveryClaimOwner = 'patrol';
                  cur.pendingDelivery = true;
                  cur.pendingDeliveryReason = 'delivering';
                  cur.pendingDeliveryPayload = payload;
                  cur.updatedAt = claimNowIso;
                  claimed.push({ item, payload });
                }
                if (claimed.length > 0) {
                  sc.updatedAt = claimNowIso;
                }
                return {
                  ok: true,
                  targetCoordId: freshCoord.conversationId,
                  targetProjId: freshCoord.projectId || itemsToAlert[0]?.thread?.projectId || '',
                  claimToken,
                  claimed,
                  skipped,
                };
              });

              for (const sk of claimOutcome?.skipped || []) {
                if (sk.deferred) deferredCount++;
                results.push(sk);
              }

              const claimed = claimOutcome?.claimed || [];
              if (claimOutcome?.ok && claimed.length > 0) {
                const targetCoordId = claimOutcome.targetCoordId;
                const targetProjId = claimOutcome.targetProjId;
                const alertMessage = buildBatchStallAlertMessage(
                  claimed.map((c) => c.payload),
                  locale,
                );
                const alertTitle =
                  claimed.length === 1
                    ? `[Watchdog ${claimed[0].payload.threadId}] ${claimed[0].payload.title || claimed[0].payload.threadId}`
                    : `[Watchdog ${claimed.length} threads] ${claimed.map((c) => c.payload.threadId).join(', ')}`;

                let claimFinalized = false;
                try {
                  let sentOk = false;
                  try {
                    await d.invokeAgentApiSend({
                      conversationId: targetCoordId,
                      message: alertMessage,
                      title: alertTitle,
                      projectId: targetProjId,
                      timeoutMs: WATCHDOG_DELIVERY_TIMEOUT_MS,
                    });
                    sentOk = true;
                  } catch (err) {
                    if (targetProjId && !err?.isTimeout && err?.code !== 'ENOENT') {
                      try {
                        await d.invokeAgentApiSend({
                          conversationId: targetCoordId,
                          message: alertMessage,
                          title: alertTitle,
                          projectId: '',
                          timeoutMs: Math.max(2000, WATCHDOG_DELIVERY_TIMEOUT_MS - 1500),
                        });
                        sentOk = true;
                      } catch {
                        sentOk = false;
                      }
                    }
                  }

                  const postNowMs = d.now();
                  const postNowIso = new Date(postNowMs).toISOString();

                  if (sentOk) {
                    const persistOut = d.mutateRegistry((freshReg) => {
                      const freshCoord = resolveLiveActiveCoordinatorForScope(freshReg, scopeKey);
                      const retiredDuringSend = Boolean(
                        !freshCoord || freshCoord.conversationId !== targetCoordId,
                      );
                      const sc = freshReg.watchdogState?.[scopeKey];
                      const outcomes = [];
                      if (!sc?.threads) return { retiredDuringSend, outcomes };
                      let mutated = false;
                      for (const { item, payload } of claimed) {
                        const tid = item.thread.threadId;
                        const entry = item.evalOut.entry;
                        const cur = sc.threads[tid];
                        // STRICT TOKEN MATCH: only commit/count if our atomic claim token still owns this entry
                        if (!cur || cur.state !== 'stalled' || cur.deliveryClaimToken !== claimToken) {
                          outcomes.push({
                            tid,
                            stallReason: entry.stallReason,
                            status: 'claim_lost',
                          });
                          continue;
                        }
                        mutated = true;
                        if (retiredDuringSend) {
                          cur.pendingDelivery = true;
                          cur.pendingDeliveryReason = 'coordinator_rebound_during_delivery';
                          cur.pendingDeliveryPayload = {
                            ...payload,
                            coordinatorId: freshCoord?.conversationId || '',
                          };
                          cur.deliveryState = 'pending';
                          cur.deliveryClaimToken = '';
                          cur.deliveryClaimedAt = '';
                          cur.deliveryClaimOwner = '';
                          cur.updatedAt = postNowIso;
                          outcomes.push({
                            tid,
                            stallReason: entry.stallReason,
                            status: 'rebound',
                          });
                        } else {
                          const nextCount = Math.max(1, (Number(cur.alertCount) || 0) + 1);
                          const cooldownMs = computeNextCooldownMs(nextCount, config);
                          cur.alertCount = nextCount;
                          cur.lastAlertFingerprint = entry.stallFingerprint;
                          cur.lastAlertAt = postNowIso;
                          cur.lastAlertCoordinatorId = targetCoordId;
                          cur.nextAlertEligibleAt = new Date(postNowMs + cooldownMs).toISOString();
                          cur.pendingDelivery = false;
                          cur.pendingDeliveryReason = '';
                          cur.pendingDeliveryPayload = null;
                          cur.deliveryState = '';
                          cur.deliveryClaimToken = '';
                          cur.deliveryClaimedAt = '';
                          cur.deliveryClaimOwner = '';
                          cur.updatedAt = postNowIso;
                          outcomes.push({
                            tid,
                            stallReason: entry.stallReason,
                            status: 'delivered',
                          });
                        }
                      }
                      if (mutated) sc.updatedAt = postNowIso;
                      return { retiredDuringSend, outcomes };
                    });
                    claimFinalized = true;

                    for (const out of persistOut?.outcomes || []) {
                      if (out.status === 'delivered') {
                        alertedCount++;
                        results.push({
                          threadId: out.tid,
                          stalled: true,
                          delivered: true,
                          deferred: false,
                          batched: claimed.length > 1,
                          coordinatorId: targetCoordId,
                          stallReason: out.stallReason,
                        });
                      } else if (out.status === 'rebound') {
                        deferredCount++;
                        results.push({
                          threadId: out.tid,
                          stalled: true,
                          delivered: false,
                          deferred: true,
                          reason: 'coordinator_rebound_during_delivery',
                          stallReason: out.stallReason,
                        });
                      } else {
                        results.push({
                          threadId: out.tid,
                          stalled: true,
                          delivered: false,
                          deferred: false,
                          reason: 'claim_superseded',
                          stallReason: out.stallReason,
                        });
                      }
                    }
                  } else {
                    // Delivery failed or timed out -> roll back atomic claim to pending with short backoff
                    d.mutateRegistry((freshReg) => {
                      const sc = freshReg.watchdogState?.[scopeKey];
                      if (!sc?.threads) return;
                      let mutated = false;
                      for (const { item, payload } of claimed) {
                        const tid = item.thread.threadId;
                        const cur = sc.threads[tid];
                        if (!cur || cur.state !== 'stalled' || cur.deliveryClaimToken !== claimToken) {
                          continue;
                        }
                        mutated = true;
                        cur.pendingDelivery = true;
                        cur.pendingDeliveryReason = 'delivery_failed';
                        cur.pendingDeliveryPayload = payload;
                        cur.deliveryState = 'pending';
                        cur.deliveryClaimToken = '';
                        cur.deliveryClaimedAt = '';
                        cur.deliveryClaimOwner = '';
                        cur.nextAlertEligibleAt = new Date(
                          postNowMs + WATCHDOG_DELIVERY_FAILURE_RETRY_MS,
                        ).toISOString();
                        cur.updatedAt = postNowIso;
                      }
                      if (mutated) sc.updatedAt = postNowIso;
                    });
                    claimFinalized = true;

                    for (const { item } of claimed) {
                      deferredCount++;
                      results.push({
                        threadId: item.thread.threadId,
                        stalled: true,
                        delivered: false,
                        deferred: true,
                        reason: 'delivery_failed',
                        stallReason: item.evalOut.entry.stallReason,
                      });
                    }
                  }
                } finally {
                  if (!claimFinalized) {
                    // Safety net: if an unexpected error interrupted send/commit, release our token back to pending
                    try {
                      const rbNowMs = d.now();
                      const rbNowIso = new Date(rbNowMs).toISOString();
                      d.mutateRegistry((freshReg) => {
                        const sc = freshReg.watchdogState?.[scopeKey];
                        if (!sc?.threads) return;
                        let mutated = false;
                        for (const { item, payload } of claimed) {
                          const tid = item.thread.threadId;
                          const cur = sc.threads[tid];
                          if (!cur || cur.deliveryClaimToken !== claimToken) continue;
                          mutated = true;
                          cur.pendingDelivery = true;
                          cur.pendingDeliveryReason = 'delivery_failed';
                          cur.pendingDeliveryPayload = payload;
                          cur.deliveryState = 'pending';
                          cur.deliveryClaimToken = '';
                          cur.deliveryClaimedAt = '';
                          cur.deliveryClaimOwner = '';
                          cur.nextAlertEligibleAt = new Date(
                            rbNowMs + WATCHDOG_DELIVERY_FAILURE_RETRY_MS,
                          ).toISOString();
                          cur.updatedAt = rbNowIso;
                        }
                        if (mutated) sc.updatedAt = rbNowIso;
                      });
                    } catch {
                      // Best-effort rollback
                    }
                  }
                }
              }
            }
          }
        } finally {
          inFlightDeliveries.delete(scopeKey);
        }
      }
    }

    return {
      ok: true,
      skipped: false,
      reason: '',
      scopeKey,
      coordinatorId: coord.conversationId,
      checkedCount: evaluated.length,
      activeCount,
      stalledCount: stalledItems.length,
      alertedCount,
      deferredCount,
      recoveredCount,
      results,
    };
  } finally {
    inFlightScopes.delete(scopeKey);
  }
}

/**
 * Atomically claims deferred (`pendingDelivery: true`) stall alerts for an active Coordinator
 * inside `mutateRegistry()`, skipping any entries currently being delivered by background patrol
 * (`deliveryState === 'delivering'`), and formats alert text ONLY for entries claimed in the lock.
 */
export function consumePendingWatchdogAlertsForPreInvocation(
  coord,
  { nowMs = Date.now(), deps: depsOverrides = {} } = {},
) {
  if (!coord || !coord.key || !coord.conversationId) return '';
  const d = defaultDeps(depsOverrides);
  const scopeKey = normalizeWatchdogScopeKey(coord.key);
  if (!scopeKey) return '';

  // Fast read-only pre-check to avoid acquiring registry lock on normal turns with zero pending alerts
  const reg = d.loadRegistry();
  const activeCoord = resolveLiveActiveCoordinatorForScope(reg, scopeKey);
  if (!activeCoord || activeCoord.conversationId !== coord.conversationId) return '';

  const scopeState = reg.watchdogState?.[scopeKey] || reg.watchdogState?.[coord.key];
  if (!scopeState?.threads) return '';

  let hasCandidate = false;
  for (const [tid, entry] of Object.entries(scopeState.threads)) {
    if (!entry || entry.state !== 'stalled' || !entry.stalled || !entry.pendingDelivery) continue;
    if (isDeliveryClaimActive(entry, nowMs)) continue;
    const tRec = reg.threads?.[tid];
    if (!tRec || tRec.archived || !isSameScope(tRec.workspaceKey, scopeKey)) continue;
    if (parseIsoMs(entry.snoozedUntil) > nowMs) continue;
    hasCandidate = true;
    break;
  }
  if (!hasCandidate) return '';

  const settings = d.loadSettings();
  const config = resolveEffectiveWatchdogConfig(
    settings,
    scopeKey,
    activeCoord.repoRoot || activeCoord.workspacePath || '',
  );
  const locale = d.resolveAppLocale();
  const nowIso = new Date(nowMs).toISOString();

  // Atomically claim & record delivery inside mutateRegistry so patrol & PreInvocation NEVER double-deliver
  const claimedPayloads = d.mutateRegistry((freshReg) => {
    const freshCoord = resolveLiveActiveCoordinatorForScope(freshReg, scopeKey);
    if (!freshCoord || freshCoord.conversationId !== coord.conversationId) return [];
    const sc = freshReg.watchdogState?.[scopeKey] || freshReg.watchdogState?.[coord.key];
    if (!sc?.threads) return [];

    const claimed = [];
    for (const [tid, cur] of Object.entries(sc.threads)) {
      if (!cur || cur.state !== 'stalled' || !cur.stalled || !cur.pendingDelivery) continue;
      // CRITICAL: skip entries actively claimed by patrol (`deliveryState === 'delivering'`)
      if (isDeliveryClaimActive(cur, nowMs)) continue;
      const tRec = freshReg.threads?.[tid];
      if (!tRec || tRec.archived || !isSameScope(tRec.workspaceKey, scopeKey)) continue;
      if (parseIsoMs(cur.snoozedUntil) > nowMs) continue;

      const nextCount = Math.max(1, (Number(cur.alertCount) || 0) + 1);
      const cooldownMs = computeNextCooldownMs(nextCount, config);
      const basePayload = cur.pendingDeliveryPayload || {
        threadId: tid,
        localId: tRec.localId || (tRec.projectSeq ? `#${tRec.projectSeq}` : ''),
        title: tRec.title || tid,
        conversationId: tRec.conversationId || '',
        coordinatorId: freshCoord.conversationId,
        workspacePath: freshCoord.repoRoot || freshCoord.workspacePath || '',
        stallReason: cur.stallReason || 'no_progress_running',
        stallFingerprint: cur.stallFingerprint || '',
        stalledDurationMs: cur.stalledDurationMs || 0,
        lastProgressAt: cur.lastProgressAt || '',
        runState: tRec.runState || '',
        bucket: tRec.bucket || '',
        toolStepCount: tRec.toolStepCount || 0,
        transcriptSize: cur.lastObservedTranscriptSize || 0,
        hasPendingBgTask: Boolean(tRec.hasPendingBgTask),
        activeTool: tRec.activeTool || '',
      };
      const claimedPayload = {
        ...basePayload,
        coordinatorId: freshCoord.conversationId,
        alertNumber: nextCount,
      };

      cur.alertCount = nextCount;
      cur.lastAlertFingerprint = cur.stallFingerprint || '';
      cur.lastAlertAt = nowIso;
      cur.lastAlertCoordinatorId = freshCoord.conversationId;
      cur.nextAlertEligibleAt = new Date(nowMs + cooldownMs).toISOString();
      cur.pendingDelivery = false;
      cur.pendingDeliveryReason = '';
      cur.pendingDeliveryPayload = null;
      cur.deliveryState = '';
      cur.deliveryClaimToken = '';
      cur.deliveryClaimedAt = '';
      cur.deliveryClaimOwner = '';
      cur.updatedAt = nowIso;
      claimed.push(claimedPayload);
    }

    if (claimed.length > 0) {
      sc.updatedAt = nowIso;
    }
    return claimed;
  });

  if (!Array.isArray(claimedPayloads) || claimedPayloads.length === 0) return '';
  return buildBatchStallAlertMessage(claimedPayloads, locale);
}

/**
 * Scope-resolved status query for Sidecar `/api/watchdog_status`.
 */
export async function getWatchdogStatus({
  workspacePath = '',
  workspace = '',
  workspaceKey = '',
  coordinatorId = '',
  conversationId = '',
  projectId = '',
} = {}) {
  const reg = loadRegistry();
  const settings = loadSettings();
  let scopeKey = normalizeWatchdogScopeKey(workspaceKey);
  let resolvedWsPath = String(workspacePath || workspace || '').trim();

  if (!scopeKey && (resolvedWsPath || coordinatorId || conversationId || projectId)) {
    const scope = await resolveProjectScope({
      workspacePath: resolvedWsPath,
      conversationId: conversationId || coordinatorId,
      coordinatorId,
      projectId,
      reg,
    });
    scopeKey = normalizeWatchdogScopeKey(scope.scopeKey);
    if (!resolvedWsPath && scope.baseDir) resolvedWsPath = scope.baseDir;
  }

  const effective = resolveEffectiveWatchdogConfig(settings, scopeKey, resolvedWsPath);
  const summary = buildWatchdogBoardSummary(reg, settings, scopeKey, resolvedWsPath);
  return {
    ok: true,
    scopeKey,
    effective,
    watchdog: summary,
  };
}

/**
 * Scope-validated manual patrol / single-thread wake-check for Sidecar `/api/watchdog_patrol`.
 */
export async function triggerWatchdogPatrol({
  workspacePath = '',
  workspace = '',
  workspaceKey = '',
  coordinatorId = '',
  conversationId = '',
  projectId = '',
  threadId = '',
  wakeCheck = false,
  deps = {},
} = {}) {
  const d = defaultDeps(deps);
  const reg = d.loadRegistry();
  assertNotRetiredCoordinator(reg, { coordinatorId, conversationId });

  const cleanThreadId = String(threadId || '').trim();
  let scopeKey = normalizeWatchdogScopeKey(workspaceKey);
  let targetTid = '';

  if (cleanThreadId) {
    const resolved = await resolveScopedThreadTarget({
      threadId: cleanThreadId,
      workspacePath: workspacePath || workspace,
      workspaceKey: scopeKey,
      coordinatorId,
      conversationId,
      projectId,
      requireScope: true,
      reg,
    });
    targetTid = resolved.thread.threadId;
    scopeKey = normalizeWatchdogScopeKey(resolved.thread.workspaceKey || resolved.scope?.scopeKey || scopeKey);
  } else if (!scopeKey) {
    const scope = await resolveProjectScope({
      workspacePath: workspacePath || workspace,
      conversationId: conversationId || coordinatorId,
      coordinatorId,
      projectId,
      reg,
    });
    scopeKey = normalizeWatchdogScopeKey(scope.scopeKey);
  }

  if (!scopeKey) {
    throw new Error('Unable to resolve project scope for watchdog patrol (fail-closed).');
  }

  const res = await patrolProjectScope(scopeKey, {
    manual: true,
    targetThreadId: targetTid,
    forceWake: Boolean(wakeCheck && targetTid),
    deps: d,
  });

  const latestReg = d.loadRegistry();
  const latestSettings = d.loadSettings();
  const watchdog = buildWatchdogBoardSummary(latestReg, latestSettings, scopeKey, workspacePath || workspace);

  return {
    ...res,
    action: wakeCheck && targetTid ? 'wake_check' : 'patrol',
    ...(targetTid ? { threadId: targetTid } : {}),
    watchdog,
  };
}

/**
 * Scope-validated single-thread Snooze / Unsnooze for Sidecar `/api/watchdog_snooze`.
 */
export async function snoozeWatchdogThread({
  threadId = '',
  minutes = undefined,
  clear = false,
  workspacePath = '',
  workspace = '',
  workspaceKey = '',
  coordinatorId = '',
  conversationId = '',
  projectId = '',
  deps = {},
} = {}) {
  const cleanTid = String(threadId || '').trim();
  if (!cleanTid) {
    throw new Error('`threadId` is required.');
  }
  const d = defaultDeps(deps);
  const reg = d.loadRegistry();
  assertNotRetiredCoordinator(reg, { coordinatorId, conversationId });

  const { thread: t } = await resolveScopedThreadTarget({
    threadId: cleanTid,
    workspacePath: workspacePath || workspace,
    workspaceKey,
    coordinatorId,
    conversationId,
    projectId,
    requireScope: true,
    reg,
  });

  const scopeKey = normalizeWatchdogScopeKey(t.workspaceKey || workspaceKey);
  const settings = d.loadSettings();
  const effCfg = resolveEffectiveWatchdogConfig(settings, scopeKey, t.repoRoot || t.workspacePath || '');
  const snoozeMin =
    minutes !== undefined && minutes !== null && minutes !== ''
      ? clampInt(
          minutes,
          WATCHDOG_LIMITS.defaultSnoozeMin.min,
          WATCHDOG_LIMITS.defaultSnoozeMin.max,
          effCfg.defaultSnoozeMin,
        )
      : effCfg.defaultSnoozeMin;
  const nowMs = d.now();

  const updatedEntry = d.mutateRegistry((freshReg) => {
    const entry = snoozeThreadWatchdogInReg(freshReg, {
      workspaceKey: scopeKey,
      threadId: t.threadId,
      minutes: snoozeMin,
      clear: Boolean(clear),
      nowMs,
    });
    // Also dismiss any matching auto watchdog_stalled decision card when snoozing
    if (!clear && entry) {
      if (!freshReg.dismissedAutoDecisions || typeof freshReg.dismissedAutoDecisions !== 'object') {
        freshReg.dismissedAutoDecisions = {};
      }
      const fp = String(entry.snoozedFingerprint || '__no_commit__');
      freshReg.dismissedAutoDecisions[`${t.threadId}:watchdog_stalled`] = {
        key: `${t.threadId}:watchdog_stalled`,
        workspaceKey: scopeKey,
        threadId: t.threadId,
        autoKind: 'watchdog_stalled',
        lastCommit: fp,
        dismissedAt: new Date(nowMs).toISOString(),
        resolution: 'snooze',
      };
    }
    return entry;
  });

  const latestReg = d.loadRegistry();
  return {
    ok: true,
    action: clear ? 'unsnooze' : 'snooze',
    threadId: t.threadId,
    scopeKey,
    snoozedUntil: updatedEntry?.snoozedUntil || '',
    minutes: clear ? 0 : snoozeMin,
    threadWatchdog: getThreadWatchdogSummary(latestReg, scopeKey, t.threadId, nowMs),
  };
}

/**
 * Per-project independent non-blocking background patrol scheduler.
 * Each bound project scope runs on its own independent timer at its configured interval,
 * with re-entrancy locking, live Settings reconciliation, and leak-free shutdown.
 */
export function createWatchdogScheduler({
  reconcileIntervalMs = WATCHDOG_RECONCILE_INTERVAL_MS,
  deps: depsOverrides = {},
  onPatrolResult = null,
} = {}) {
  const d = defaultDeps(depsOverrides);
  const runners = new Map(); // scopeKey -> { timer, intervalMs, stopped }
  let reconcileTimer = null;
  let running = false;

  function stopScopeRunner(scopeKey) {
    const runner = runners.get(scopeKey);
    if (!runner) return;
    runner.stopped = true;
    if (runner.timer) {
      clearTimeout(runner.timer);
      runner.timer = null;
    }
    runners.delete(scopeKey);
  }

  function scheduleScopeTick(scopeKey, runner, delayMs) {
    if (!running || runner.stopped) return;
    if (runner.timer) {
      clearTimeout(runner.timer);
      runner.timer = null;
    }
    const waitMs = Math.max(50, Number(delayMs) || runner.intervalMs);
    runner.timer = setTimeout(async () => {
      runner.timer = null;
      if (!running || runner.stopped) return;
      try {
        const res = await patrolProjectScope(scopeKey, { manual: false, deps: d });
        if (typeof onPatrolResult === 'function') {
          try {
            onPatrolResult(scopeKey, res);
          } catch {
            // Never let observer callback crash scheduler
          }
        }
      } catch {
        // Non-fatal: background patrol must never crash host process
      } finally {
        if (running && !runner.stopped) {
          scheduleScopeTick(scopeKey, runner, runner.intervalMs);
        }
      }
    }, waitMs);
    runner.timer.unref?.();
  }

  function reconcile() {
    if (!running) return;
    let reg;
    let settings;
    try {
      reg = d.loadRegistry();
      settings = d.loadSettings();
    } catch {
      return;
    }

    const activeScopes = new Map(); // normScope -> intervalMs
    for (const [rawKey, coord] of Object.entries(reg.coordinators || {})) {
      const scopeKey = normalizeWatchdogScopeKey(rawKey);
      if (!scopeKey || !coord?.conversationId) continue;
      const liveCoord = resolveLiveActiveCoordinatorForScope(reg, scopeKey);
      if (!liveCoord) continue;
      const cfg = resolveEffectiveWatchdogConfig(
        settings,
        scopeKey,
        liveCoord.repoRoot || liveCoord.workspacePath || '',
      );
      if (!cfg.enabled) continue;
      const intervalMs = Math.max(
        WATCHDOG_LIMITS.patrolIntervalSec.min * 1000,
        (Number(cfg.patrolIntervalSec) || WATCHDOG_DEFAULTS.patrolIntervalSec) * 1000,
      );
      activeScopes.set(scopeKey, intervalMs);
    }

    // Stop runners for unbound or disabled projects
    for (const existingKey of [...runners.keys()]) {
      if (!activeScopes.has(existingKey)) {
        stopScopeRunner(existingKey);
      }
    }

    // Start new runners or adjust intervals for updated configs
    for (const [scopeKey, intervalMs] of activeScopes.entries()) {
      const existing = runners.get(scopeKey);
      if (!existing) {
        const runner = { timer: null, intervalMs, stopped: false };
        runners.set(scopeKey, runner);
        // Small staggered initial delay (1.5s–3.5s) to avoid startup burst across many projects
        const jitter = Math.min(intervalMs, 1500 + (runners.size % 5) * 400);
        scheduleScopeTick(scopeKey, runner, jitter);
      } else if (existing.intervalMs !== intervalMs) {
        existing.intervalMs = intervalMs;
        scheduleScopeTick(scopeKey, existing, intervalMs);
      }
    }
  }

  function start() {
    if (running) return;
    running = true;
    reconcile();
    const recMs = Math.max(1000, Number(reconcileIntervalMs) || WATCHDOG_RECONCILE_INTERVAL_MS);
    reconcileTimer = setInterval(() => {
      reconcile();
    }, recMs);
    reconcileTimer.unref?.();
  }

  function stop() {
    running = false;
    if (reconcileTimer) {
      clearInterval(reconcileTimer);
      reconcileTimer = null;
    }
    for (const scopeKey of [...runners.keys()]) {
      stopScopeRunner(scopeKey);
    }
  }

  function getActiveScopeKeys() {
    return [...runners.keys()];
  }

  function isRunning() {
    return running;
  }

  return {
    start,
    stop,
    reconcile,
    getActiveScopeKeys,
    isRunning,
  };
}

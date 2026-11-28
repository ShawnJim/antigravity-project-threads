import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import {
  createConversation,
  getCascadeModelCatalog,
  getConversation,
  getModelConfigLookup,
  getSelectableModels,
  getStateDir,
  getThreadGeneratorModel,
  listConversations,
  resolveAgentApiExe,
  resolveAgentApiShimTargetFile,
  resolveLsEndpoint,
  resolveModelLabelFromLookup,
  resolveProjectName,
  sendUserCascadeMessage,
  updateConversation,
} from './ls-client.mjs';
import {
  formatModelDisplay,
  isSameModelFamily,
  isSameModelVariant,
  isTierAlias,
} from './model-format.mjs';
import {
  archiveMemoryToLegacyTopic,
  buildDefaultMergeConventionsSection,
  buildInitialProjectMemory,
  buildLegacyV1MergeConventionsSection,
  deleteMemoryTopic,
  ensureGitExcludeSync,
  ensureProjectMemoryFile,
  evaluateIndexBudget,
  getMemoryFilePath,
  getMemoryTopicsDir,
  getTopicFilePath,
  getTopicRelativePath,
  hasMergeConventionsSection,
  inspectMemoryMigrationStatus,
  listMemoryTopics,
  MERGE_CONVENTIONS_HEADING_RE,
  MERGE_CONVENTIONS_MARKER,
  MERGE_HYGIENE_END_MARKER,
  MERGE_HYGIENE_START_MARKER,
  MERGE_HYGIENE_VERSION,
  normalizeKeywords,
  parseTopicDocument,
  parseTopicIndexTable,
  readMemoryTopic,
  readProjectMemory,
  recommendTopicsForTask,
  refreshExistingProjectMemoryHygiene,
  REPO_MEMORY_EXCLUDE_PATTERNS,
  resolveNextLegacyTopicId,
  syncMemoryFilesToWorktree,
  syncTopicIndexInThinMemory,
  THIN_INDEX_SOFT_MAX_BYTES,
  THIN_INDEX_SOFT_MAX_LINES,
  TOPIC_INDEX_END_MARKER,
  TOPIC_INDEX_START_MARKER,
  upgradeManagedMergeConventions,
  upsertTopicIndexSection,
  validateTopicId,
  withMemoryLock,
  WORKTREE_MEMORY_EXCLUDE_PATTERNS,
  writeMemoryFileAtomic,
  writeMemoryTopic,
} from './memory.mjs';
import {
  extractLatestAssistantText,
  extractThreadCompletion,
  extractTranscriptModel,
  extractTranscriptUsage,
  parseThreadTranscript,
  peekLiveActivity,
} from './transcript.mjs';
import {
  buildWatchdogBoardSummary,
  clearThreadWatchdogInReg,
  describeStallReason,
  formatWatchdogDuration,
  getThreadWatchdogSummary,
  hasWatchdogOverrides,
  mergeWatchdogStateMaps,
  normalizeWatchdogConfig,
  resetThreadWatchdogOnMessageInReg,
  resolveEffectiveWatchdogConfig,
  snoozeThreadWatchdogInReg,
} from './watchdog.mjs';

export {
  archiveMemoryToLegacyTopic,
  buildDefaultMergeConventionsSection,
  buildLegacyV1MergeConventionsSection,
  deleteMemoryTopic,
  ensureGitExcludeSync,
  ensureProjectMemoryFile,
  evaluateIndexBudget,
  getMemoryFilePath,
  getMemoryTopicsDir,
  getTopicFilePath,
  getTopicRelativePath,
  hasMergeConventionsSection,
  inspectMemoryMigrationStatus,
  listMemoryTopics,
  MERGE_CONVENTIONS_MARKER,
  MERGE_HYGIENE_END_MARKER,
  MERGE_HYGIENE_START_MARKER,
  MERGE_HYGIENE_VERSION,
  normalizeKeywords,
  parseTopicDocument,
  parseTopicIndexTable,
  readMemoryTopic,
  readProjectMemory,
  recommendTopicsForTask,
  refreshExistingProjectMemoryHygiene,
  REPO_MEMORY_EXCLUDE_PATTERNS,
  resolveNextLegacyTopicId,
  syncMemoryFilesToWorktree,
  syncTopicIndexInThinMemory,
  THIN_INDEX_SOFT_MAX_BYTES,
  THIN_INDEX_SOFT_MAX_LINES,
  TOPIC_INDEX_END_MARKER,
  TOPIC_INDEX_START_MARKER,
  upgradeManagedMergeConventions,
  upsertTopicIndexSection,
  validateTopicId,
  WORKTREE_MEMORY_EXCLUDE_PATTERNS,
  writeMemoryTopic,
};

const PROCESS_BOOT_ISO = new Date().toISOString();
const seenRunningThreadIds = new Set();
const autoCleanupInFlight = new Set();
const autoSyncInFlight = new Set();
const syncThreadsInFlight = new Map(); // syncSig -> Promise

const WORKTREE_ADD_TIMEOUT_MS = 120_000;

let localeCache = { key: '', locale: 'en' };

function normalizeLocaleTag(raw) {
  const s = String(raw || '').trim();
  if (!s || /unspecified|auto|default/i.test(s)) return '';
  const cleaned = s.replace(/^(?:language|locale)[-_]/i, '');
  if (/^zh[-_](tw|hk|mo|hant)|traditional\s*chinese|繁體|繁体/i.test(cleaned)) return 'zh-TW';
  if (/^zh|simplified\s*chinese|简体/i.test(cleaned)) return 'zh-CN';
  if (/^en|english/i.test(cleaned)) return 'en';
  return '';
}

function safeFileStamp(p) {
  try {
    const st = statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

export function resolveAppLocale() {
  const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
  const appDataDir = process.env.ANTIGRAVITY_APP_DATA_DIR || join(geminiDir, 'antigravity');
  const appConfigPath = join(geminiDir, 'config', 'config.json');
  const ptSettingsPath = join(appDataDir, 'plugin_data', 'agy-powertools', 'settings.json');

  const stamp = `${safeFileStamp(appConfigPath)}|${safeFileStamp(ptSettingsPath)}`;
  if (localeCache.key === stamp) return localeCache.locale;

  let powertoolsPluginEnabled = true;
  let detected = '';

  if (existsSync(appConfigPath)) {
    try {
      const raw = readFileSync(appConfigPath, 'utf8');
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (parsed) {
        const appLang =
          parsed?.userSettings?.language ||
          parsed?.userSettings?.locale ||
          parsed?.userSettings?.displayLanguage ||
          parsed?.language ||
          parsed?.locale ||
          '';
        detected = normalizeLocaleTag(appLang);
        if (parsed?.plugins?.['agy-powertools']?.enabled === false) {
          powertoolsPluginEnabled = false;
        }
      } else {
        const m = raw.match(/"(?:language|locale)"\s*:\s*"([^"]+)"/);
        if (m) detected = normalizeLocaleTag(m[1]);
      }
    } catch {
      // Ignore read errors
    }
  }

  if (!detected && powertoolsPluginEnabled && existsSync(ptSettingsPath)) {
    try {
      const pt = JSON.parse(readFileSync(ptSettingsPath, 'utf8'));
      if (pt?.enabled !== false && pt?.language) {
        detected = normalizeLocaleTag(pt.language);
      }
    } catch {
      // Ignore read errors
    }
  }

  const finalLocale = detected || 'en';
  localeCache = { key: stamp, locale: finalLocale };
  return finalLocale;
}

const REGISTRY_FILE = () => join(getStateDir(), 'registry.json');
const SETTINGS_FILE = () => join(getStateDir(), 'settings.json');
const REGISTRY_LOCK_FILE = () => `${REGISTRY_FILE()}.lock`;
const REGISTRY_LOCK_STALE_MS = 10_000;
const REGISTRY_LOCK_DEAD_PID_MIN_AGE_MS = 1000;
const REGISTRY_LOCK_WAIT_MS = 4000;

function writeJsonFileAtomic(file, data) {
  const parent = dirname(file);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const payload = JSON.stringify(data, null, 2);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // Ignore tmp cleanup errors
    }
    writeFileSync(file, payload, 'utf8');
  }
}

let registryLockDepth = 0;
const sleepLockBuf =
  typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null;

function sleepSync(ms) {
  const waitMs = Math.max(1, Math.floor(Number(ms) || 1));
  if (sleepLockBuf) {
    try {
      Atomics.wait(sleepLockBuf, 0, 0, waitMs);
      return;
    } catch {
      // Fallback to bounded busy-wait if Atomics.wait is disallowed on this thread
    }
  }
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    // Busy-wait fallback
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function withRegistryLock(fn, maxWaitMs = REGISTRY_LOCK_WAIT_MS) {
  if (registryLockDepth > 0) {
    registryLockDepth++;
    try {
      return fn();
    } finally {
      registryLockDepth--;
    }
  }

  const lockPath = REGISTRY_LOCK_FILE();
  const payload = `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`;
  const deadline = Date.now() + Math.max(100, Number(maxWaitMs) || REGISTRY_LOCK_WAIT_MS);
  let acquired = false;

  let waitAttempts = 0;

  while (!acquired) {
    try {
      writeFileSync(lockPath, payload, { flag: 'wx' });
      acquired = true;
      break;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        break;
      }
    }

    let reclaimed = false;
    try {
      const st = statSync(lockPath);
      const ageMs = Date.now() - st.mtimeMs;
      let isStale = ageMs > REGISTRY_LOCK_STALE_MS;
      if (!isStale && ageMs > REGISTRY_LOCK_DEAD_PID_MIN_AGE_MS) {
        try {
          const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
          const ownerPid = Number(parsed?.pid);
          if (
            Number.isInteger(ownerPid) &&
            ownerPid > 0 &&
            ownerPid !== process.pid &&
            !isProcessAlive(ownerPid)
          ) {
            isStale = true;
          }
        } catch {
          // Ignore partial/legacy lock file within TTL
        }
      }
      if (isStale) {
        try {
          unlinkSync(lockPath);
          reclaimed = true;
        } catch {
          // Another process reclaimed or released it concurrently
        }
      }
    } catch (statErr) {
      if (statErr?.code === 'ENOENT') reclaimed = true;
    }

    if (reclaimed) continue;
    if (Date.now() >= deadline) break;
    waitAttempts += 1;
    const sleepMs =
      waitAttempts <= 8
        ? 5 + Math.floor(Math.random() * 8)
        : 15 + Math.floor(Math.random() * 15);
    sleepSync(sleepMs);
  }

  registryLockDepth++;
  try {
    return fn();
  } finally {
    registryLockDepth--;
    if (acquired) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Ignore lock cleanup errors
      }
    }
  }
}

export function mutateRegistry(mutator) {
  return withRegistryLock(() => {
    const reg = loadRegistry();
    const result = mutator(reg);
    saveRegistry(reg);
    return result;
  });
}

function emptyRegistry() {
  return {
    version: 1,
    seq: 0,
    decisionSeq: 0,
    projectSeqs: {},
    coordinators: {},
    threads: {},
    decisions: {},
    dismissedAutoDecisions: {},
    watchdogState: {},
  };
}

const UNIFIED_LOCAL_ID_RE = /^thr-(\d+)$/i;
const INTERNAL_SCOPED_THREAD_ID_RE = /^pt-[a-f0-9]+-/i;

function parsePositiveSeq(val) {
  const n = Number(val);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function formatLocalThreadId(projectSeq) {
  const n = parsePositiveSeq(projectSeq);
  return n > 0 ? `thr-${String(n).padStart(3, '0')}` : '';
}

export function parseUnifiedLocalThreadSeq(raw) {
  const m = UNIFIED_LOCAL_ID_RE.exec(String(raw || '').trim());
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function isUnifiedLocalThreadId(raw) {
  return parseUnifiedLocalThreadSeq(raw) > 0;
}

export function getThreadDisplayId(t) {
  if (!t || typeof t !== 'object') return '';
  const rawLocal = String(t.localId || '').trim();
  const localNum = parseUnifiedLocalThreadSeq(rawLocal);
  if (localNum > 0) {
    return formatLocalThreadId(localNum);
  }
  const rawDisplay = String(t.displayId || '').trim();
  const displayNum = parseUnifiedLocalThreadSeq(rawDisplay);
  if (displayNum > 0) {
    return formatLocalThreadId(displayNum);
  }
  const rawTid = String(t.threadId || '').trim();
  if (rawTid && !INTERNAL_SCOPED_THREAD_ID_RE.test(rawTid)) {
    return rawTid;
  }
  const seq = parsePositiveSeq(t.projectSeq);
  if (seq > 0) {
    return formatLocalThreadId(seq);
  }
  return rawLocal || rawDisplay || rawTid;
}

function normalizeProjectSeqsMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const normKey = normalizeScopeKeyForMatch(k);
    const seq = parsePositiveSeq(v);
    if (!normKey || seq <= 0) continue;
    if (!out[normKey] || seq > out[normKey]) {
      out[normKey] = seq;
    }
  }
  return out;
}

function extractThreadNumericId(threadId) {
  const m = /^thr-(\d+)$/i.exec(String(threadId || '').trim());
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function computeScopeProjectSeqMap(reg, workspaceKey) {
  const seqByThreadId = new Map();
  const normScope = normalizeScopeKeyForMatch(workspaceKey);
  if (!normScope || !reg?.threads || typeof reg.threads !== 'object') {
    return { seqByThreadId, maxSeq: 0 };
  }

  const scopeThreads = Object.values(reg.threads).filter(
    (t) => t && typeof t === 'object' && t.threadId && isSameScopeKey(t.workspaceKey, normScope),
  );
  if (!scopeThreads.length) {
    return { seqByThreadId, maxSeq: 0 };
  }

  const used = new Set();
  let maxSeq = 0;
  const missing = [];

  for (const t of scopeThreads) {
    const explicit = parsePositiveSeq(t.projectSeq);
    if (explicit > 0) {
      seqByThreadId.set(t.threadId, explicit);
      used.add(explicit);
      if (explicit > maxSeq) maxSeq = explicit;
    } else {
      missing.push(t);
    }
  }

  if (missing.length > 0) {
    missing.sort((a, b) => {
      const ta = String(a.createdAt || '');
      const tb = String(b.createdAt || '');
      if (ta !== tb) return ta.localeCompare(tb);
      const na = extractThreadNumericId(a.threadId);
      const nb = extractThreadNumericId(b.threadId);
      if (na !== nb) return na - nb;
      return String(a.threadId || '').localeCompare(String(b.threadId || ''));
    });
    let nextCand = 1;
    for (const t of missing) {
      while (used.has(nextCand)) nextCand++;
      seqByThreadId.set(t.threadId, nextCand);
      used.add(nextCand);
      if (nextCand > maxSeq) maxSeq = nextCand;
      nextCand++;
    }
  }

  return { seqByThreadId, maxSeq };
}

function getEffectiveThreadProjectSeq(t, reg, scopeMapCache = null) {
  if (!t || typeof t !== 'object') return 0;
  const explicit = parsePositiveSeq(t.projectSeq);
  if (explicit > 0) return explicit;
  const normScope = normalizeScopeKeyForMatch(t.workspaceKey);
  if (!normScope || !reg) return 0;
  let computed = scopeMapCache?.get(normScope);
  if (!computed) {
    computed = computeScopeProjectSeqMap(reg, normScope);
    scopeMapCache?.set(normScope, computed);
  }
  return computed.seqByThreadId.get(t.threadId) || 0;
}

function decorateThreadRecord(t, reg, scopeMapCache = null) {
  if (!t || typeof t !== 'object') return t;
  const seq = getEffectiveThreadProjectSeq(t, reg, scopeMapCache);
  const explicit = parsePositiveSeq(t.projectSeq);
  const effectiveSeq = seq > 0 ? seq : explicit;
  const probeRecord =
    effectiveSeq > 0 && !explicit ? { ...t, projectSeq: effectiveSeq } : t;
  const displayId = getThreadDisplayId(probeRecord);
  if (effectiveSeq > 0) {
    const resolvedDisplayId = displayId || formatLocalThreadId(effectiveSeq);
    return {
      ...t,
      projectSeq: effectiveSeq,
      localId: resolvedDisplayId,
      displayId: resolvedDisplayId,
    };
  }
  return displayId ? { ...t, localId: displayId, displayId } : { ...t };
}

function computeScopeMaxUsedThreadNum(reg, workspaceKey) {
  const normScope = normalizeScopeKeyForMatch(workspaceKey);
  if (!normScope || !reg?.threads || typeof reg.threads !== 'object') {
    return { maxUsedNum: 0, threadCount: 0 };
  }
  const scopeThreads = Object.values(reg.threads).filter(
    (t) => t && typeof t === 'object' && t.threadId && isSameScopeKey(t.workspaceKey, normScope),
  );
  let maxUsedNum = 0;
  for (const t of scopeThreads) {
    const seq = parsePositiveSeq(t.projectSeq);
    if (seq > maxUsedNum) maxUsedNum = seq;
    const localNum = parseUnifiedLocalThreadSeq(t.localId);
    if (localNum > 0) {
      if (localNum > maxUsedNum) maxUsedNum = localNum;
    } else {
      // Legacy thread (pre-Issue-#12, no unified thr-NNN localId): never collide with its historical thr-NNN
      const legacyNum = parseUnifiedLocalThreadSeq(t.threadId);
      if (legacyNum > maxUsedNum) maxUsedNum = legacyNum;
    }
  }
  return { maxUsedNum, threadCount: scopeThreads.length };
}

function allocateNextProjectSeqInReg(reg, workspaceKey) {
  const normScope = normalizeScopeKeyForMatch(workspaceKey);
  if (!normScope) return 0;
  if (!reg.projectSeqs || typeof reg.projectSeqs !== 'object' || Array.isArray(reg.projectSeqs)) {
    reg.projectSeqs = {};
  }
  const normalized = normalizeProjectSeqsMap(reg.projectSeqs);
  const storedVal = normalized[normScope] || 0;
  const { maxSeq } = computeScopeProjectSeqMap(reg, normScope);
  const { maxUsedNum, threadCount } = computeScopeMaxUsedThreadNum(reg, normScope);
  const nextSeq = Math.max(storedVal, maxSeq, maxUsedNum, threadCount) + 1;
  normalized[normScope] = nextSeq;
  reg.projectSeqs = normalized;
  return nextSeq;
}

function allocateInternalThreadKeyInReg(reg, workspaceKey, localId, reservedSeq) {
  const normScope = normalizeScopeKeyForMatch(workspaceKey) || '__global__';
  const scopeHash = createHash('sha1').update(normScope).digest('hex').slice(0, 8);
  const idPart = localId || `thr-${String(reservedSeq || 1).padStart(3, '0')}`;
  const base = `pt-${scopeHash}-${idPart}`;
  if (!reg?.threads || !reg.threads[base]) return base;
  let suffix = Math.max(2, Number(reservedSeq) || 2);
  while (reg.threads[`${base}-${suffix}`]) suffix++;
  return `${base}-${suffix}`;
}

function inferMaxDecisionSeq(decisionsMap) {
  let maxSeq = 0;
  if (!decisionsMap || typeof decisionsMap !== 'object') return 0;
  for (const key of Object.keys(decisionsMap)) {
    const m = /^dec-(\d+)$/i.exec(String(key || '').trim());
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
    }
  }
  return maxSeq;
}

function isFinalDecisionStatus(status) {
  return status === 'resolved' || status === 'dismissed';
}

function getDecisionTimestamp(d) {
  if (!d || typeof d !== 'object') return '';
  return String(d.updatedAt || d.resolvedAt || d.createdAt || '');
}

const POLLUTED_PLUGIN_RE = /\.gemini[\\/]+config[\\/]+plugins[\\/]+project-threads/i;

function isPollutedCoordinatorEntry(key, coord) {
  const k = String(key || '');
  if (POLLUTED_PLUGIN_RE.test(k)) return true;
  if (coord && typeof coord === 'object') {
    if (POLLUTED_PLUGIN_RE.test(String(coord.key || ''))) return true;
    if (POLLUTED_PLUGIN_RE.test(String(coord.workspacePath || ''))) return true;
    if (POLLUTED_PLUGIN_RE.test(String(coord.repoRoot || ''))) return true;
    if (POLLUTED_PLUGIN_RE.test(String(coord.memoryPath || ''))) return true;
  }
  return false;
}

export function loadRegistry() {
  const file = REGISTRY_FILE();
  if (!existsSync(file)) return emptyRegistry();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const rawCoordinators = parsed.coordinators && typeof parsed.coordinators === 'object'
      ? parsed.coordinators
      : {};
    const coordinators = {};
    let healed = false;
    for (const [k, v] of Object.entries(rawCoordinators)) {
      if (isPollutedCoordinatorEntry(k, v)) {
        healed = true;
        continue;
      }
      coordinators[k] = v;
    }
    const decisions =
      parsed.decisions && typeof parsed.decisions === 'object' && !Array.isArray(parsed.decisions)
        ? parsed.decisions
        : {};
    const dismissedAutoDecisions =
      parsed.dismissedAutoDecisions &&
      typeof parsed.dismissedAutoDecisions === 'object' &&
      !Array.isArray(parsed.dismissedAutoDecisions)
        ? parsed.dismissedAutoDecisions
        : {};
    const inFlightAutoDecisions =
      parsed.inFlightAutoDecisions &&
      typeof parsed.inFlightAutoDecisions === 'object' &&
      !Array.isArray(parsed.inFlightAutoDecisions)
        ? parsed.inFlightAutoDecisions
        : {};
    const watchdogState =
      parsed.watchdogState &&
      typeof parsed.watchdogState === 'object' &&
      !Array.isArray(parsed.watchdogState)
        ? parsed.watchdogState
        : {};
    const inferredDecSeq = inferMaxDecisionSeq(decisions);
    const projectSeqs = normalizeProjectSeqsMap(parsed.projectSeqs);
    const reg = {
      version: 1,
      seq: Number(parsed.seq) || 0,
      decisionSeq: Math.max(Number(parsed.decisionSeq) || 0, inferredDecSeq),
      projectSeqs,
      coordinators,
      threads: parsed.threads || {},
      decisions,
      dismissedAutoDecisions,
      inFlightAutoDecisions,
      watchdogState,
    };
    if (healed) {
      try {
        saveRegistry(reg);
      } catch {
        // Ignore heal write race
      }
    }
    return reg;
  } catch {
    return emptyRegistry();
  }
}

const MAX_RETIRED_COORDINATOR_IDS = 50;
const STALE_IDLE_REBIND_GRACE_MS = 120_000;

function normalizeRetiredCoordinatorIds(list, activeConvId = '') {
  const active = String(activeConvId || '').trim();
  const out = [];
  const seen = new Set();
  const items = Array.isArray(list) ? list : [];
  // Walk backwards so we keep the most recent entries when capping length
  for (let i = items.length - 1; i >= 0; i--) {
    const id = String(items[i] || '').trim();
    if (!id || id === active || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_RETIRED_COORDINATOR_IDS) break;
  }
  out.reverse();
  return out;
}

export function findRetiredCoordinatorOwner(reg, convId) {
  const cid = String(convId || '').trim();
  if (!cid || !reg?.coordinators) return null;
  const isActiveSomewhere = Object.values(reg.coordinators).some(
    (c) => c && c.conversationId === cid,
  );
  if (isActiveSomewhere) return null;
  const matches = Object.values(reg.coordinators).filter(
    (c) =>
      c &&
      c.conversationId &&
      c.conversationId !== cid &&
      Array.isArray(c.retiredCoordinatorIds) &&
      c.retiredCoordinatorIds.includes(cid),
  );
  if (!matches.length) return null;
  matches.sort((a, b) => {
    const seqDiff = (Number(b.rebindSeq) || 0) - (Number(a.rebindSeq) || 0);
    if (seqDiff !== 0) return seqDiff;
    return String(b.reboundAt || b.updatedAt || '').localeCompare(
      String(a.reboundAt || a.updatedAt || ''),
    );
  });
  return matches[0];
}

export function assertNotRetiredCoordinator(reg, { coordinatorId = '', conversationId = '' } = {}) {
  const activeReg = reg || loadRegistry();
  for (const rawId of [coordinatorId, conversationId]) {
    const cid = String(rawId || '').trim();
    if (!cid) continue;
    const owner = findRetiredCoordinatorOwner(activeReg, cid);
    if (owner) {
      throw new Error(
        `Coordinator session "${cid}" has been retired for scope "${owner.key}". Active Coordinator is now "${owner.conversationId}" (conversation://${owner.conversationId}). Write operations from retired Coordinator sessions are rejected.`,
      );
    }
  }
}

function mergeRetiredCoordinatorIds(listA, listB, activeConvId = '') {
  return normalizeRetiredCoordinatorIds(
    [...(Array.isArray(listA) ? listA : []), ...(Array.isArray(listB) ? listB : [])],
    activeConvId,
  );
}

function mergeRetiredNotifiedMap(mapA, mapB, activeConvId = '') {
  const active = String(activeConvId || '').trim();
  const out = {};
  const entriesA = mapA && typeof mapA === 'object' && !Array.isArray(mapA) ? Object.entries(mapA) : [];
  const entriesB = mapB && typeof mapB === 'object' && !Array.isArray(mapB) ? Object.entries(mapB) : [];
  for (const [rawId, val] of [...entriesA, ...entriesB]) {
    const id = String(rawId || '').trim();
    if (!id || id === active || !val || typeof val !== 'object') continue;
    const prev = out[id];
    if (!prev) {
      out[id] = { ...val };
      continue;
    }
    const prevSeq = Number(prev.rebindSeq) || 0;
    const nextSeq = Number(val.rebindSeq) || 0;
    const prevAt = String(prev.notifiedAt || '');
    const nextAt = String(val.notifiedAt || '');
    if (
      nextSeq > prevSeq ||
      (nextSeq === prevSeq && nextAt > prevAt) ||
      (nextSeq === prevSeq && nextAt === prevAt && (Number(val.lastStepCount) || 0) > (Number(prev.lastStepCount) || 0))
    ) {
      out[id] = { ...val };
    }
  }
  return out;
}

export function saveRegistry(reg) {
  withRegistryLock(() => {
    const file = REGISTRY_FILE();
    if (reg && typeof reg === 'object') {
      if (!reg.coordinators || typeof reg.coordinators !== 'object') reg.coordinators = {};
      if (!reg.threads || typeof reg.threads !== 'object') reg.threads = {};
      reg.projectSeqs = normalizeProjectSeqsMap(reg.projectSeqs);
      if (!reg.decisions || typeof reg.decisions !== 'object' || Array.isArray(reg.decisions)) {
        reg.decisions = {};
      }
      if (
        !reg.dismissedAutoDecisions ||
        typeof reg.dismissedAutoDecisions !== 'object' ||
        Array.isArray(reg.dismissedAutoDecisions)
      ) {
        reg.dismissedAutoDecisions = {};
      }
      if (
        !reg.inFlightAutoDecisions ||
        typeof reg.inFlightAutoDecisions !== 'object' ||
        Array.isArray(reg.inFlightAutoDecisions)
      ) {
        reg.inFlightAutoDecisions = {};
      }
      if (
        !reg.watchdogState ||
        typeof reg.watchdogState !== 'object' ||
        Array.isArray(reg.watchdogState)
      ) {
        reg.watchdogState = {};
      }
      reg.decisionSeq = Math.max(
        Number(reg.decisionSeq) || 0,
        inferMaxDecisionSeq(reg.decisions),
      );
    }
    if (existsSync(file) && reg && typeof reg === 'object' && reg.threads) {
      try {
        const disk = JSON.parse(readFileSync(file, 'utf8'));
        if (disk && typeof disk === 'object') {
          if (Number(disk.seq) > Number(reg.seq || 0)) {
            reg.seq = Number(disk.seq);
          }
          const diskProjectSeqs = normalizeProjectSeqsMap(disk.projectSeqs);
          for (const [pk, pSeq] of Object.entries(diskProjectSeqs)) {
            if (!reg.projectSeqs[pk] || pSeq > reg.projectSeqs[pk]) {
              reg.projectSeqs[pk] = pSeq;
            }
          }
          const diskDecSeq = Math.max(
            Number(disk.decisionSeq) || 0,
            inferMaxDecisionSeq(disk.decisions),
          );
          if (diskDecSeq > Number(reg.decisionSeq || 0)) {
            reg.decisionSeq = diskDecSeq;
          }
          if (disk.coordinators && typeof disk.coordinators === 'object') {
            for (const [ck, diskC] of Object.entries(disk.coordinators)) {
              if (!diskC || isPollutedCoordinatorEntry(ck, diskC)) continue;
              const memC = reg.coordinators[ck];
              if (!memC) {
                reg.coordinators[ck] = diskC;
                continue;
              }
              const diskSeq = Number(diskC.rebindSeq) || 0;
              const memSeq = Number(memC.rebindSeq) || 0;
              const diskReboundAt = String(diskC.reboundAt || diskC.updatedAt || '');
              const memReboundAt = String(memC.reboundAt || memC.updatedAt || '');
              if (diskC.conversationId !== memC.conversationId) {
                const diskWins =
                  (Boolean(diskC.conversationId) && !memC.conversationId) ||
                  diskSeq > memSeq ||
                  (diskSeq === memSeq && diskReboundAt > memReboundAt);
                if (diskWins) {
                  const mergedRetired = mergeRetiredCoordinatorIds(
                    diskC.retiredCoordinatorIds,
                    memC.retiredCoordinatorIds,
                    diskC.conversationId,
                  );
                  const mergedNotified = mergeRetiredNotifiedMap(
                    diskC.retiredNotified,
                    memC.retiredNotified,
                    diskC.conversationId,
                  );
                  reg.coordinators[ck] = {
                    ...diskC,
                    ...(mergedRetired.length ? { retiredCoordinatorIds: mergedRetired } : {}),
                    ...(Object.keys(mergedNotified).length ? { retiredNotified: mergedNotified } : {}),
                  };
                  continue;
                }
                const mergedRetired = mergeRetiredCoordinatorIds(
                  diskC.retiredCoordinatorIds,
                  memC.retiredCoordinatorIds,
                  memC.conversationId,
                );
                if (mergedRetired.length) memC.retiredCoordinatorIds = mergedRetired;
                continue;
              }
              const maxDirVer = Math.max(
                Number(diskC.directiveVersion) || 0,
                Number(memC.directiveVersion) || 0,
              );
              if (maxDirVer > 0) memC.directiveVersion = maxDirVer;
              const maxSteps = Math.max(
                Number(diskC.lastStepCount) || 0,
                Number(memC.lastStepCount) || 0,
              );
              if (maxSteps > 0) memC.lastStepCount = maxSteps;
              const maxRebindSeq = Math.max(diskSeq, memSeq);
              if (maxRebindSeq > 0) memC.rebindSeq = maxRebindSeq;
              const newerReboundAt =
                String(diskC.reboundAt || '') > String(memC.reboundAt || '')
                  ? String(diskC.reboundAt || '')
                  : String(memC.reboundAt || '');
              if (newerReboundAt) memC.reboundAt = newerReboundAt;
              const mergedRetired = mergeRetiredCoordinatorIds(
                diskC.retiredCoordinatorIds,
                memC.retiredCoordinatorIds,
                memC.conversationId,
              );
              if (mergedRetired.length) memC.retiredCoordinatorIds = mergedRetired;
              const mergedNotified = mergeRetiredNotifiedMap(
                diskC.retiredNotified,
                memC.retiredNotified,
                memC.conversationId,
              );
              if (Object.keys(mergedNotified).length) memC.retiredNotified = mergedNotified;
              if (!memC.projectName && diskC.projectName && diskC.projectId === memC.projectId) {
                memC.projectName = diskC.projectName;
              }
            }
          }
          if (disk.threads && typeof disk.threads === 'object') {
            for (const [tid, diskT] of Object.entries(disk.threads)) {
              if (!diskT) continue;
              const memT = reg.threads[tid];
              if (!memT) {
                reg.threads[tid] = diskT;
                continue;
              }

              const diskCoordSeq = Number(diskT.coordinatorRebindSeq) || 0;
              const memCoordSeq = Number(memT.coordinatorRebindSeq) || 0;
              const diskCoordAt = String(diskT.coordinatorReboundAt || '');
              const memCoordAt = String(memT.coordinatorReboundAt || '');
              const scopeCoord =
                memT.workspaceKey && reg.coordinators?.[memT.workspaceKey]
                  ? reg.coordinators[memT.workspaceKey]
                  : null;
              const memCoordRetiredOnScope = Boolean(
                !memT.archived &&
                  !diskT.archived &&
                  scopeCoord?.conversationId &&
                  diskT.coordinatorId === scopeCoord.conversationId &&
                  memT.coordinatorId !== diskT.coordinatorId &&
                  Array.isArray(scopeCoord.retiredCoordinatorIds) &&
                  scopeCoord.retiredCoordinatorIds.includes(memT.coordinatorId),
              );
              if (
                diskT.coordinatorId &&
                (diskCoordSeq > memCoordSeq ||
                  (diskCoordSeq === memCoordSeq && diskCoordAt > memCoordAt) ||
                  memCoordRetiredOnScope)
              ) {
                memT.coordinatorId = diskT.coordinatorId;
                if (diskCoordSeq > 0) memT.coordinatorRebindSeq = diskCoordSeq;
                if (diskCoordAt) memT.coordinatorReboundAt = diskCoordAt;
              }

              const diskSynced = Number.isInteger(diskT.lastSyncedStepIndex)
                ? diskT.lastSyncedStepIndex
                : -1;
              const memSynced = Number.isInteger(memT.lastSyncedStepIndex)
                ? memT.lastSyncedStepIndex
                : -1;
              const maxSynced = Math.max(diskSynced, memSynced);
              if (maxSynced >= 0) {
                memT.lastSyncedStepIndex = maxSynced;
              }

              const diskAck = Number.isInteger(diskT.acknowledgedStepIndex)
                ? diskT.acknowledgedStepIndex
                : -2;
              const memAck = Number.isInteger(memT.acknowledgedStepIndex)
                ? memT.acknowledgedStepIndex
                : -2;
              const maxAck = Math.max(diskAck, memAck);
              if (maxAck >= -1) {
                memT.acknowledgedStepIndex = maxAck;
              }

              const diskBaseline = Number.isInteger(diskT.reboundBaselineStepIndex)
                ? diskT.reboundBaselineStepIndex
                : -1;
              const memBaseline = Number.isInteger(memT.reboundBaselineStepIndex)
                ? memT.reboundBaselineStepIndex
                : -1;
              const maxBaseline = Math.max(diskBaseline, memBaseline);
              if (maxBaseline >= 0) {
                memT.reboundBaselineStepIndex = maxBaseline;
              }

              for (const isoKey of [
                'pushedToCoordinatorAt',
                'notifiedCoordinatorAt',
                'viewedAt',
                'reboundBaselineAt',
              ]) {
                const a = String(diskT[isoKey] || '');
                const b = String(memT[isoKey] || '');
                const newer = a > b ? a : b;
                if (newer) memT[isoKey] = newer;
              }

              if (!memT.modelDisplayName && diskT.modelDisplayName) {
                memT.modelDisplayName = diskT.modelDisplayName;
              }
              if (!memT.resolvedModel && diskT.resolvedModel) {
                memT.resolvedModel = diskT.resolvedModel;
              }
              if (!memT.modelEnum && diskT.modelEnum) {
                memT.modelEnum = diskT.modelEnum;
              }
              if (!memT.usage && diskT.usage) {
                memT.usage = diskT.usage;
              }
              const diskProjSeq = parsePositiveSeq(diskT.projectSeq);
              const memProjSeq = parsePositiveSeq(memT.projectSeq);
              if (!memProjSeq && diskProjSeq > 0) {
                memT.projectSeq = diskProjSeq;
              }
              const finalProjSeq = parsePositiveSeq(memT.projectSeq);
              if (!isUnifiedLocalThreadId(memT.localId) && isUnifiedLocalThreadId(diskT.localId)) {
                memT.localId = diskT.localId;
              } else if (!memT.localId && diskT.localId) {
                memT.localId = diskT.localId;
              } else if (
                finalProjSeq > 0 &&
                !memT.localId &&
                INTERNAL_SCOPED_THREAD_ID_RE.test(String(memT.threadId || ''))
              ) {
                memT.localId = formatLocalThreadId(finalProjSeq);
              }
              if (!memT.displayId && diskT.displayId) {
                memT.displayId = diskT.displayId;
              }
            }
          }
          if (disk.decisions && typeof disk.decisions === 'object' && !Array.isArray(disk.decisions)) {
            for (const [did, diskD] of Object.entries(disk.decisions)) {
              if (!diskD || typeof diskD !== 'object') continue;
              const memD = reg.decisions[did];
              if (!memD) {
                reg.decisions[did] = diskD;
                continue;
              }
              const diskFinal = isFinalDecisionStatus(diskD.status);
              const memFinal = isFinalDecisionStatus(memD.status);
              const diskTs = getDecisionTimestamp(diskD);
              const memTs = getDecisionTimestamp(memD);
              if (diskFinal && !memFinal) {
                reg.decisions[did] = diskD;
              } else if (diskFinal === memFinal && diskTs > memTs) {
                reg.decisions[did] = diskD;
              }
            }
          }
          if (
            disk.dismissedAutoDecisions &&
            typeof disk.dismissedAutoDecisions === 'object' &&
            !Array.isArray(disk.dismissedAutoDecisions)
          ) {
            for (const [ak, diskEntry] of Object.entries(disk.dismissedAutoDecisions)) {
              if (!diskEntry || typeof diskEntry !== 'object') continue;
              const memEntry = reg.dismissedAutoDecisions[ak];
              if (!memEntry) {
                reg.dismissedAutoDecisions[ak] = diskEntry;
                continue;
              }
              const diskAt = String(diskEntry.dismissedAt || '');
              const memAt = String(memEntry.dismissedAt || '');
              if (diskAt > memAt) {
                reg.dismissedAutoDecisions[ak] = diskEntry;
              }
            }
          }
          if (
            disk.inFlightAutoDecisions &&
            typeof disk.inFlightAutoDecisions === 'object' &&
            !Array.isArray(disk.inFlightAutoDecisions)
          ) {
            for (const [fk, diskClaim] of Object.entries(disk.inFlightAutoDecisions)) {
              if (!diskClaim || typeof diskClaim !== 'object') continue;
              const diskUpdated = String(diskClaim.updatedAt || diskClaim.claimedAt || '');
              const memClaim = reg.inFlightAutoDecisions[fk];
              if (!memClaim) {
                if (diskClaim.state === 'sending' && isDecisionClaimFresh(diskClaim.claimedAt)) {
                  reg.inFlightAutoDecisions[fk] = diskClaim;
                }
                continue;
              }
              const memUpdated = String(memClaim.updatedAt || memClaim.claimedAt || '');
              if (diskUpdated > memUpdated) {
                reg.inFlightAutoDecisions[fk] = diskClaim;
              }
            }
          }
          // Prune stale in-flight auto decision markers to keep registry compact
          for (const [fk, entry] of Object.entries(reg.inFlightAutoDecisions || {})) {
            if (!entry || typeof entry !== 'object') {
              delete reg.inFlightAutoDecisions[fk];
              continue;
            }
            const refTs = entry.updatedAt || entry.claimedAt || '';
            if (!isDecisionClaimFresh(refTs)) {
              delete reg.inFlightAutoDecisions[fk];
            }
          }
          // Merge per-project watchdog state using updatedAt tombstones so cleared states never resurrect
          reg.watchdogState = mergeWatchdogStateMaps(reg.watchdogState, disk.watchdogState);
        }
      } catch {
        // Ignore transient parse errors during merge-safe save
      }
    }
    writeJsonFileAtomic(file, reg);
  });
}

function isInheritModel(raw) {
  return String(raw || '').trim().toLowerCase() === 'inherit';
}

function isOmittedOrDefaultModel(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return !s || s === 'default' || s === 'auto';
}

function canonicalizeTierAlias(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'default' || s === 'auto' || s === 'inherit') return '';
  if (s === 'pro' || s === 'gemini pro' || s === 'gemini-pro') return 'pro';
  if (s === 'flash' || s === 'gemini flash' || s === 'gemini-flash') return 'flash';
  if (
    s === 'flash_lite' ||
    s === 'flash-lite' ||
    s === 'lite' ||
    s === 'gemini flash lite' ||
    s === 'gemini-flash-lite'
  ) {
    return 'flash_lite';
  }
  return '';
}

function isHumanDisplayLabel(raw) {
  const s = String(raw || '').trim();
  if (!s || isTierAlias(s)) return false;
  if (/^MODEL_[A-Z0-9_]+$/i.test(s)) return false;
  return /\s/.test(s) || /[A-Z]/.test(s);
}

function normalizeStoredModelValue(raw, fallback = '') {
  const s = String(raw || '').trim();
  if (isInheritModel(s)) return 'inherit';
  if (isOmittedOrDefaultModel(s)) return fallback;
  const tier = canonicalizeTierAlias(s);
  if (tier) return tier;
  return s;
}

function isFilesystemPathKey(key) {
  const s = String(key || '').trim();
  if (!s || s.startsWith('project:') || s.startsWith('conv:') || s.startsWith('__')) return false;
  return /[\\/]/.test(s) || /^[A-Za-z]:/.test(s);
}

function lookupProjectSettingsEntry(projectsMap, scopeKey, workspacePath = '') {
  if (!projectsMap || typeof projectsMap !== 'object') return null;
  const candidates = [scopeKey, workspacePath].filter(Boolean);
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(projectsMap, c) && projectsMap[c]) {
      return projectsMap[c];
    }
  }
  const normalizedTargets = new Set(
    candidates.map((c) => (isFilesystemPathKey(c) ? normalizeKey(c) : String(c).trim())),
  );
  for (const [k, v] of Object.entries(projectsMap)) {
    if (!v || typeof v !== 'object') continue;
    const normK = isFilesystemPathKey(k) ? normalizeKey(k) : String(k).trim();
    if (normalizedTargets.has(normK)) return v;
  }
  return null;
}

function deleteProjectSettingsEntry(projectsMap, targetKey) {
  if (!projectsMap || typeof projectsMap !== 'object' || !targetKey) return;
  delete projectsMap[targetKey];
  if (!isFilesystemPathKey(targetKey)) return;
  const normTarget = normalizeKey(targetKey);
  for (const existingKey of Object.keys(projectsMap)) {
    if (isFilesystemPathKey(existingKey) && normalizeKey(existingKey) === normTarget) {
      delete projectsMap[existingKey];
    }
  }
}

function upsertProjectSettingsEntry(projectsMap, key, wt, ro, rev = '', watchdogRaw = null) {
  const wd =
    watchdogRaw && typeof watchdogRaw === 'object'
      ? normalizeWatchdogConfig(watchdogRaw, { isProjectOverride: true })
      : {};
  const hasWd = hasWatchdogOverrides(wd);
  if (wt || ro || rev || hasWd) {
    projectsMap[key] = {
      worktreeModel: wt,
      readOnlyModel: ro,
      reviewModel: rev,
      ...(hasWd ? { watchdog: wd } : {}),
    };
  } else {
    deleteProjectSettingsEntry(projectsMap, key);
  }
}

function normalizeUpdateChannel(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'stable' || s === 'dev') return s;
  return '';
}

function emptySettings() {
  return {
    version: 1,
    defaults: {
      worktreeModel: 'inherit',
      readOnlyModel: 'inherit',
      reviewModel: 'inherit',
    },
    watchdog: normalizeWatchdogConfig({}, { isProjectOverride: false }),
    projects: {},
  };
}

function normalizeSettingsDoc(parsed) {
  const base = emptySettings();
  if (!parsed || typeof parsed !== 'object') return base;
  const rawDefaults = parsed.defaults && typeof parsed.defaults === 'object' ? parsed.defaults : {};
  base.defaults = {
    worktreeModel: normalizeStoredModelValue(rawDefaults.worktreeModel, 'inherit'),
    readOnlyModel: normalizeStoredModelValue(rawDefaults.readOnlyModel, 'inherit'),
    reviewModel: normalizeStoredModelValue(rawDefaults.reviewModel, 'inherit'),
  };
  base.watchdog = normalizeWatchdogConfig(parsed.watchdog, { isProjectOverride: false });
  const rawProjects = parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {};
  for (const [k, entry] of Object.entries(rawProjects)) {
    const key = String(k || '').trim();
    if (!key || !entry || typeof entry !== 'object') continue;
    const wt = normalizeStoredModelValue(entry.worktreeModel, '');
    const ro = normalizeStoredModelValue(entry.readOnlyModel, '');
    const rev = normalizeStoredModelValue(entry.reviewModel, '');
    const wd = entry.watchdog
      ? normalizeWatchdogConfig(entry.watchdog, { isProjectOverride: true })
      : {};
    const hasWd = hasWatchdogOverrides(wd);
    if (wt || ro || rev || hasWd) {
      base.projects[key] = {
        worktreeModel: wt,
        readOnlyModel: ro,
        reviewModel: rev,
        ...(hasWd ? { watchdog: wd } : {}),
      };
    }
  }
  if (parsed.labels && typeof parsed.labels === 'object') {
    const cleanLabels = {};
    for (const [mk, mv] of Object.entries(parsed.labels)) {
      const kStr = String(mk || '').trim();
      const vStr = String(mv || '').trim();
      if (kStr && vStr) cleanLabels[kStr] = vStr;
    }
    if (Object.keys(cleanLabels).length > 0) base.labels = cleanLabels;
  }
  const updateChannel = normalizeUpdateChannel(parsed.updateChannel);
  if (updateChannel) base.updateChannel = updateChannel;
  if (parsed.updatedAt) base.updatedAt = String(parsed.updatedAt);
  return base;
}

export function loadSettings() {
  const file = SETTINGS_FILE();
  if (!existsSync(file)) return emptySettings();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return normalizeSettingsDoc(parsed);
  } catch {
    return emptySettings();
  }
}

export function saveSettings(patchOrFull = {}) {
  const current = loadSettings();
  const input = patchOrFull && typeof patchOrFull === 'object' ? patchOrFull : {};
  let next;

  if (input.scope === 'global' || input.scope === 'project') {
    next = normalizeSettingsDoc(current);
    const isReset = Boolean(input.reset);
    const section = String(input.section || '').trim().toLowerCase();
    if (input.scope === 'global') {
      if (isReset) {
        if (section === 'watchdog') {
          next.watchdog = normalizeWatchdogConfig({}, { isProjectOverride: false });
        } else if (section === 'all') {
          next.defaults = { worktreeModel: 'inherit', readOnlyModel: 'inherit', reviewModel: 'inherit' };
          next.watchdog = normalizeWatchdogConfig({}, { isProjectOverride: false });
        } else {
          // Default ('' or 'models'): reset ONLY model defaults so legacy callers never wipe watchdog config
          next.defaults = { worktreeModel: 'inherit', readOnlyModel: 'inherit', reviewModel: 'inherit' };
        }
      } else {
        if ('worktreeModel' in input) {
          next.defaults.worktreeModel = normalizeStoredModelValue(input.worktreeModel, 'inherit');
        }
        if ('readOnlyModel' in input) {
          next.defaults.readOnlyModel = normalizeStoredModelValue(input.readOnlyModel, 'inherit');
        }
        if ('reviewModel' in input) {
          next.defaults.reviewModel = normalizeStoredModelValue(input.reviewModel, 'inherit');
        }
        if ('watchdog' in input && input.watchdog && typeof input.watchdog === 'object') {
          next.watchdog = normalizeWatchdogConfig(
            { ...(next.watchdog || {}), ...input.watchdog },
            { isProjectOverride: false },
          );
        }
      }
    } else {
      const wk = String(input.workspaceKey || '').trim();
      if (!wk) {
        throw new Error('`workspaceKey` is required to save project-scoped settings.');
      }
      const existingProj =
        lookupProjectSettingsEntry(next.projects, wk) || {
          worktreeModel: '',
          readOnlyModel: '',
          reviewModel: '',
        };
      if (isReset) {
        if (section === 'watchdog') {
          upsertProjectSettingsEntry(
            next.projects,
            wk,
            existingProj.worktreeModel || '',
            existingProj.readOnlyModel || '',
            existingProj.reviewModel || '',
            null,
          );
        } else if (section === 'all') {
          deleteProjectSettingsEntry(next.projects, wk);
        } else {
          // Default ('' or 'models'): clear ONLY model overrides while preserving any project watchdog override
          upsertProjectSettingsEntry(next.projects, wk, '', '', '', existingProj.watchdog || null);
        }
      } else {
        const wt =
          'worktreeModel' in input
            ? normalizeStoredModelValue(input.worktreeModel, '')
            : existingProj.worktreeModel || '';
        const ro =
          'readOnlyModel' in input
            ? normalizeStoredModelValue(input.readOnlyModel, '')
            : existingProj.readOnlyModel || '';
        const rev =
          'reviewModel' in input
            ? normalizeStoredModelValue(input.reviewModel, '')
            : existingProj.reviewModel || '';
        const wd =
          'watchdog' in input
            ? input.watchdog === null
              ? null
              : normalizeWatchdogConfig(
                  { ...(existingProj.watchdog || {}), ...(input.watchdog || {}) },
                  { isProjectOverride: true },
                )
            : existingProj.watchdog || null;
        upsertProjectSettingsEntry(next.projects, wk, wt, ro, rev, wd);
      }
    }
  } else if (
    input.version !== undefined &&
    input.defaults &&
    typeof input.defaults === 'object' &&
    input.projects &&
    typeof input.projects === 'object'
  ) {
    next = normalizeSettingsDoc(input);
  } else {
    next = normalizeSettingsDoc(current);
    if (input.reset === true) {
      const section = String(input.section || '').trim().toLowerCase();
      if (section === 'watchdog') {
        next.watchdog = normalizeWatchdogConfig({}, { isProjectOverride: false });
      } else if (section === 'all') {
        next.defaults = { worktreeModel: 'inherit', readOnlyModel: 'inherit', reviewModel: 'inherit' };
        next.watchdog = normalizeWatchdogConfig({}, { isProjectOverride: false });
        next.projects = {};
      } else {
        // Default ('' or 'models'): reset model defaults and project model overrides while preserving watchdog config
        next.defaults = { worktreeModel: 'inherit', readOnlyModel: 'inherit', reviewModel: 'inherit' };
        for (const [k, proj] of Object.entries({ ...next.projects })) {
          if (proj?.watchdog && hasWatchdogOverrides(proj.watchdog)) {
            upsertProjectSettingsEntry(next.projects, k, '', '', '', proj.watchdog);
          } else {
            deleteProjectSettingsEntry(next.projects, k);
          }
        }
      }
    }
    if (input.defaults && typeof input.defaults === 'object') {
      if ('worktreeModel' in input.defaults) {
        next.defaults.worktreeModel = normalizeStoredModelValue(input.defaults.worktreeModel, 'inherit');
      }
      if ('readOnlyModel' in input.defaults) {
        next.defaults.readOnlyModel = normalizeStoredModelValue(input.defaults.readOnlyModel, 'inherit');
      }
      if ('reviewModel' in input.defaults) {
        next.defaults.reviewModel = normalizeStoredModelValue(input.defaults.reviewModel, 'inherit');
      }
    }
    if ('watchdog' in input && input.watchdog && typeof input.watchdog === 'object' && !input.scope) {
      next.watchdog = normalizeWatchdogConfig(
        { ...(next.watchdog || {}), ...input.watchdog },
        { isProjectOverride: false },
      );
    }
    if ('worktreeModel' in input && !input.scope) {
      next.defaults.worktreeModel = normalizeStoredModelValue(input.worktreeModel, 'inherit');
    }
    if ('readOnlyModel' in input && !input.scope) {
      next.defaults.readOnlyModel = normalizeStoredModelValue(input.readOnlyModel, 'inherit');
    }
    if ('reviewModel' in input && !input.scope) {
      next.defaults.reviewModel = normalizeStoredModelValue(input.reviewModel, 'inherit');
    }
    if (input.projects && typeof input.projects === 'object') {
      for (const [rawKey, projPatch] of Object.entries(input.projects)) {
        const key = String(rawKey || '').trim();
        if (!key) continue;
        if (!projPatch || typeof projPatch !== 'object') {
          deleteProjectSettingsEntry(next.projects, key);
          continue;
        }
        const existingProj =
          lookupProjectSettingsEntry(next.projects, key) || {
            worktreeModel: '',
            readOnlyModel: '',
            reviewModel: '',
          };
        const wt =
          'worktreeModel' in projPatch
            ? normalizeStoredModelValue(projPatch.worktreeModel, '')
            : existingProj.worktreeModel || '';
        const ro =
          'readOnlyModel' in projPatch
            ? normalizeStoredModelValue(projPatch.readOnlyModel, '')
            : existingProj.readOnlyModel || '';
        const rev =
          'reviewModel' in projPatch
            ? normalizeStoredModelValue(projPatch.reviewModel, '')
            : existingProj.reviewModel || '';
        const wd =
          'watchdog' in projPatch
            ? projPatch.watchdog === null
              ? null
              : normalizeWatchdogConfig(
                  { ...(existingProj.watchdog || {}), ...(projPatch.watchdog || {}) },
                  { isProjectOverride: true },
                )
            : existingProj.watchdog || null;
        upsertProjectSettingsEntry(next.projects, key, wt, ro, rev, wd);
      }
    }
  }

  if (input.labels && typeof input.labels === 'object') {
    const mergedLabels = { ...(next.labels || {}) };
    for (const [mk, mv] of Object.entries(input.labels)) {
      const kStr = String(mk || '').trim();
      const vStr = String(mv || '').trim();
      if (kStr && vStr) mergedLabels[kStr] = vStr;
    }
    if (Object.keys(mergedLabels).length > 0) next.labels = mergedLabels;
  }

  if ('updateChannel' in input) {
    const ch = normalizeUpdateChannel(input.updateChannel);
    if (ch) next.updateChannel = ch;
    else delete next.updateChannel;
  } else if (!next.updateChannel && current.updateChannel) {
    const ch = normalizeUpdateChannel(current.updateChannel);
    if (ch) next.updateChannel = ch;
  }

  next.updatedAt = new Date().toISOString();
  writeJsonFileAtomic(SETTINGS_FILE(), next);
  return next;
}

export function normalizeKey(p) {
  if (!p) return '__global__';
  const raw = uriToPath(p);
  if (!raw) return '__global__';
  const clean = resolve(raw);
  return process.platform === 'win32' ? clean.toLowerCase() : clean;
}

export function uriToPath(uriOrPath) {
  if (!uriOrPath) return '';
  const s = String(uriOrPath).trim();
  if (!/^file:/i.test(s)) return s;
  let stripped = s;
  if (/^file:\/\/localhost(?=\/|$)/i.test(stripped)) {
    stripped = stripped.replace(/^file:\/\/localhost/i, '');
  } else if (/^file:\/\//i.test(stripped)) {
    stripped = stripped.replace(/^file:\/\//i, '');
  } else {
    stripped = stripped.replace(/^file:/i, '');
  }
  if (!stripped) return '';
  let p = stripped;
  try {
    p = decodeURIComponent(stripped);
  } catch {
    p = stripped.replace(/(?:%[0-9A-Fa-f]{2})+/g, (seq) => {
      try {
        return decodeURIComponent(seq);
      } catch {
        return seq;
      }
    });
  }
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return normalize(p);
}

const INJECTED_RULE_UNTRACKED_RE =
  /^\?\?\s+\.agents\/(?:rules\/(?:worker-thread-context\.md|project-memory\.md)|memory(?:\/.*)?)$/;
const WORKTREE_LOCK_ERR_RE =
  /EBUSY|EPERM|EACCES|Permission denied|Resource busy|Device or resource busy|being used by another process|failed to delete|unable to unlink|Directory not empty/i;

function runGitResult(args, cwd, timeout = 12000) {
  return new Promise((resolveOut) => {
    execFile(
      'git',
      args,
      { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const rawOut = String(stdout || '');
        const rawErr = String(stderr || '');
        if (err) {
          const code = typeof err.code === 'number' ? err.code : 1;
          resolveOut({
            ok: false,
            code,
            stdout: rawOut,
            stderr: rawErr,
            error: (rawErr || rawOut || err.message || 'git command failed').trim(),
          });
        } else {
          resolveOut({
            ok: true,
            code: 0,
            stdout: rawOut,
            stderr: rawErr,
            error: '',
          });
        }
      },
    );
  });
}

async function runGit(args, cwd, timeout = 12000) {
  const res = await runGitResult(args, cwd, timeout);
  if (!res.ok) throw new Error(res.error);
  return res.stdout.trim();
}

const CONV_META_TTL_MS = 60_000;
const convMetaCache = new Map(); // convId -> { expiresAt, meta }
const THREAD_MODEL_RUNNING_TTL_MS = 3500;
const THREAD_MODEL_OPEN_DEBOUNCE_MS = 1500;
const THREAD_MODEL_OFFLINE_RETRY_MS = 15000;
const THREAD_MODEL_EMPTY_RETRY_MS = 10000;
const THREAD_PENDING_MODEL_IDLE_GRACE_MS = 15000;
const THREAD_MODEL_CACHE_MAX = 512;
const threadModelCache = new Map(); // convId -> { checkedAt, updatedAt, runState, modelDisplayName, resolvedModel, modelEnum, usage, genMetaCount, fromLs, archivedResolved }

const REPO_INFO_TTL_MS = 30_000;
const REPO_INFO_NEGATIVE_TTL_MS = 5_000;
const REPO_INFO_CACHE_MAX = 256;
const repoInfoCache = new Map(); // normPath -> { expiresAt, dirStamp, gitHeadPath, gitHeadStamp, gitHeadContent, worktreeDotGitPath, info }
let repoInfoGitSpawnCount = 0;

function storeLruGet(map, key) {
  if (!map.has(key)) return undefined;
  const val = map.get(key);
  map.delete(key);
  map.set(key, val);
  return val;
}

function storeLruSet(map, key, val, maxEntries) {
  if (map.has(key)) {
    map.delete(key);
  }
  map.set(key, val);
  while (map.size > maxEntries) {
    map.delete(map.keys().next().value);
  }
}

export function resetRepoInfoCache() {
  repoInfoCache.clear();
  repoInfoGitSpawnCount = 0;
}

export function resetStorePerfCaches() {
  repoInfoCache.clear();
  threadModelCache.clear();
  convMetaCache.clear();
  repoInfoGitSpawnCount = 0;
}

export function getStorePerfCounters() {
  return {
    repoInfoGitSpawns: repoInfoGitSpawnCount,
    repoInfoCacheSize: repoInfoCache.size,
    threadModelCacheSize: threadModelCache.size,
  };
}

async function mapWithConcurrency(items, limit, worker) {
  if (!items.length) return;
  const cap = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const runners = Array.from({ length: cap }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

async function resolveNonTierModelDisplay(rawModel, { allowCachedOnly = false } = {}) {
  const raw = String(rawModel || '').trim();
  if (!raw || isTierAlias(raw)) return '';
  if (!/^MODEL_[A-Z0-9_]+$/i.test(raw) && (/\s/.test(raw) || /[A-Z]/.test(raw))) {
    return raw;
  }
  const lookup = await getModelConfigLookup({ timeoutMs: 2500, allowCachedOnly });
  const mapped = resolveModelLabelFromLookup(raw, lookup);
  if (mapped) return mapped;
  return /^MODEL_PLACEHOLDER_/i.test(raw) ? '' : formatModelDisplay(raw);
}

function matchSelectableModelInList(rawInput, models) {
  const raw = String(rawInput || '').trim();
  if (!raw || isTierAlias(raw) || !Array.isArray(models) || !models.length) return null;
  const lower = raw.toLowerCase();
  const untiered = lower.replace(/-tiered-/g, '-');
  const exact =
    models.find(
      (m) =>
        m.id === raw ||
        m.modelId === raw ||
        m.modelEnum === raw ||
        m.modelAlias === raw ||
        m.label === raw,
    ) ||
    models.find(
      (m) =>
        (m.id && m.id.toLowerCase() === lower) ||
        (m.modelId && m.modelId.toLowerCase() === lower) ||
        (m.modelId && m.modelId.toLowerCase().replace(/-tiered-/g, '-') === untiered) ||
        (m.label && m.label.toLowerCase() === lower),
    ) ||
    null;
  if (exact) return exact;
  if (!/^MODEL_PLACEHOLDER_/i.test(raw)) {
    const variantMatches = models.filter(
      (m) =>
        isSameModelVariant(raw, m.modelId || m.id || m.label) ||
        (m.label && isSameModelVariant(raw, m.label)),
    );
    if (variantMatches.length === 1) return variantMatches[0];
  }
  return null;
}

async function findSelectableModelMatch(rawInput, { allowCachedOnly = false } = {}) {
  const raw = String(rawInput || '').trim();
  if (!raw || isTierAlias(raw)) return null;
  const models = await getSelectableModels({ timeoutMs: 2500, allowCachedOnly });
  return matchSelectableModelInList(raw, models);
}

function lookupCoordinatorForScope(
  reg,
  { scopeKey = '', workspacePath = '', projectId = '', conversationId = '' } = {},
) {
  const coords = reg?.coordinators && typeof reg.coordinators === 'object' ? reg.coordinators : {};
  if (scopeKey && coords[scopeKey]) return coords[scopeKey];
  const candidates = [scopeKey, workspacePath].filter(Boolean);
  for (const cand of candidates) {
    if (!isFilesystemPathKey(cand)) continue;
    const normCand = normalizeKey(cand);
    for (const [ck, c] of Object.entries(coords)) {
      if (isFilesystemPathKey(ck) && normalizeKey(ck) === normCand) return c;
    }
  }
  if (projectId) {
    const byProj = Object.values(coords).find((c) => c?.projectId === projectId);
    if (byProj) return byProj;
  }
  if (conversationId) {
    const byConv = Object.values(coords).find((c) => c?.conversationId === conversationId);
    if (byConv) return byConv;
  }
  return null;
}

function resolveTargetCoordinatorId({
  coordinatorId = '',
  conversationId = '',
  scopeKey = '',
  workspacePath = '',
  projectId = '',
  reg = null,
} = {}) {
  const activeReg = reg || loadRegistry();
  const threads = Object.values(activeReg.threads || {});
  const explicitCoordId = String(coordinatorId || '').trim();
  const explicitConvId = String(conversationId || '').trim();

  const isWorkerConv = (id) => Boolean(id && threads.some((t) => t?.conversationId === id));
  const coordRecord = lookupCoordinatorForScope(activeReg, {
    scopeKey,
    workspacePath,
    projectId,
    conversationId: explicitCoordId || explicitConvId,
  });

  const retiredExplicitOwner = explicitCoordId
    ? findRetiredCoordinatorOwner(activeReg, explicitCoordId)
    : null;
  const isRetiredExplicitCoord = Boolean(
    retiredExplicitOwner ||
      (explicitCoordId &&
        coordRecord?.conversationId &&
        coordRecord.conversationId !== explicitCoordId &&
        Array.isArray(coordRecord.retiredCoordinatorIds) &&
        coordRecord.retiredCoordinatorIds.includes(explicitCoordId)),
  );

  if (explicitCoordId && !isWorkerConv(explicitCoordId) && !isRetiredExplicitCoord) {
    return explicitCoordId;
  }
  if (coordRecord?.conversationId) {
    return String(coordRecord.conversationId).trim();
  }
  if (retiredExplicitOwner?.conversationId) {
    return String(retiredExplicitOwner.conversationId).trim();
  }
  if (explicitConvId) {
    const workerMatch = threads.find((t) => t?.conversationId === explicitConvId);
    if (workerMatch) {
      return String(
        activeReg.coordinators?.[workerMatch.workspaceKey]?.conversationId ||
          workerMatch.coordinatorId ||
          '',
      ).trim();
    }
    const retiredOwner = findRetiredCoordinatorOwner(activeReg, explicitConvId);
    if (retiredOwner?.conversationId) {
      return String(retiredOwner.conversationId).trim();
    }
    return explicitConvId;
  }
  return '';
}

/**
 * Dynamically resolves the active Coordinator conversation's live model (via LS generator metadata,
 * falling back to transcript.jsonl) and normalizes it into a CreateConversation-compatible modelId
 * slug, MODEL_* enum, or safe 'pro' fallback. Never returns literal 'inherit' or human labels.
 */
export async function resolveInheritedCoordinatorModel({
  coordinatorId = '',
  conversationId = '',
  workspacePath = '',
  workspaceKey = '',
  projectId = '',
  reg = null,
  catalogModels = null,
  settingsLabels = null,
  allowCachedOnly = false,
  lsTimeoutMs = 2500,
} = {}) {
  const activeReg = reg || loadRegistry();
  let effectiveScopeKey = String(workspaceKey || '').trim();
  let effectiveWorkspacePath = String(workspacePath || '').trim();
  let effectiveProjectId = String(projectId || '').trim();

  if (
    !allowCachedOnly &&
    !effectiveScopeKey &&
    (effectiveWorkspacePath || coordinatorId || conversationId || effectiveProjectId)
  ) {
    const scope = await resolveProjectScope({
      workspacePath: effectiveWorkspacePath,
      conversationId: conversationId || coordinatorId,
      coordinatorId,
      projectId: effectiveProjectId,
      reg: activeReg,
    });
    effectiveScopeKey = scope.scopeKey || '';
    effectiveProjectId = effectiveProjectId || scope.projectId || '';
    if (!effectiveWorkspacePath && scope.baseDir) effectiveWorkspacePath = scope.baseDir;
  }

  const targetCoordId = resolveTargetCoordinatorId({
    coordinatorId,
    conversationId,
    scopeKey: effectiveScopeKey,
    workspacePath: effectiveWorkspacePath,
    projectId: effectiveProjectId,
    reg: activeReg,
  });

  if (!targetCoordId) {
    return {
      coordinatorId: '',
      model: 'pro',
      displayName: '',
      modelEnum: '',
      matched: null,
      source: 'fallback',
    };
  }

  let models = Array.isArray(catalogModels) ? catalogModels : null;
  if (!models) {
    try {
      models = await getSelectableModels({
        timeoutMs: Math.max(200, Number(lsTimeoutMs) || 2500),
        allowCachedOnly,
      });
    } catch {
      models = [];
    }
  }
  const labelsMap = settingsLabels || loadSettings().labels || {};

  let genRes = { ok: false, info: null, count: 0 };
  if (allowCachedOnly) {
    const cachedCoord = threadModelCache.get(targetCoordId);
    if (
      cachedCoord &&
      (cachedCoord.modelDisplayName || cachedCoord.resolvedModel || cachedCoord.modelEnum)
    ) {
      genRes = {
        ok: true,
        info: {
          displayName: cachedCoord.modelDisplayName || '',
          responseModel: cachedCoord.resolvedModel || '',
          modelEnum: cachedCoord.modelEnum || '',
        },
        count: cachedCoord.genMetaCount || 0,
      };
    }
  } else {
    try {
      genRes = await getThreadGeneratorModel(targetCoordId, Math.max(200, Number(lsTimeoutMs) || 2500));
    } catch {
      genRes = { ok: false, info: null, count: 0 };
    }
    if (genRes.ok && genRes.info) {
      const prevCached = threadModelCache.get(targetCoordId) || {};
      threadModelCache.set(targetCoordId, {
        ...prevCached,
        checkedAt: Date.now(),
        modelDisplayName: genRes.info.displayName || prevCached.modelDisplayName || '',
        resolvedModel: genRes.info.responseModel || genRes.info.modelEnum || prevCached.resolvedModel || '',
        modelEnum: genRes.info.modelEnum || prevCached.modelEnum || '',
        genMetaCount: Number.isInteger(genRes.count) ? genRes.count : prevCached.genMetaCount || 0,
        fromLs: true,
      });
    } else if (genRes.ok && !genRes.info) {
      threadModelCache.delete(targetCoordId);
    }
  }

  let txModel = { displayName: '', modelSlug: '' };
  if (!genRes.ok || !genRes.info || (!genRes.info.responseModel && !genRes.info.modelEnum)) {
    txModel = extractTranscriptModel(targetCoordId);
  }

  const rawCandidates = [];
  if (genRes.info) {
    if (genRes.info.modelEnum) rawCandidates.push(genRes.info.modelEnum);
    if (genRes.info.responseModel) rawCandidates.push(genRes.info.responseModel);
    if (genRes.info.displayName) rawCandidates.push(genRes.info.displayName);
  }
  // When transcript has a displayName (either newer <USER_SETTINGS_CHANGE> or matching family), prefer it first
  if (txModel.displayName) rawCandidates.push(txModel.displayName);
  if (txModel.modelSlug) rawCandidates.push(txModel.modelSlug);

  const knownDisplayName = String(genRes.info?.displayName || txModel.displayName || '').trim();

  if (models.length > 0) {
    for (const cand of rawCandidates) {
      const hit = matchSelectableModelInList(cand, models);
      if (hit) {
        const resolvedModel = hit.modelId || hit.modelEnum || '';
        if (resolvedModel && !isInheritModel(resolvedModel) && !isOmittedOrDefaultModel(resolvedModel)) {
          return {
            coordinatorId: targetCoordId,
            model: resolvedModel,
            displayName: hit.label || knownDisplayName || formatModelDisplay(resolvedModel),
            modelEnum: hit.modelEnum || genRes.info?.modelEnum || '',
            matched: hit,
            source: genRes.ok && genRes.info ? 'ls' : 'transcript',
          };
        }
      }
    }
  }

  const txSlugValid =
    txModel.modelSlug &&
    (!txModel.displayName || isSameModelFamily(txModel.displayName, txModel.modelSlug))
      ? txModel.modelSlug
      : '';
  const slugCand = String(genRes.info?.responseModel || txSlugValid || '').trim();
  const enumCand = String(genRes.info?.modelEnum || '').trim();
  const safeSlug =
    slugCand &&
    !isInheritModel(slugCand) &&
    !isOmittedOrDefaultModel(slugCand) &&
    !isHumanDisplayLabel(slugCand)
      ? slugCand
      : '';
  const safeEnum =
    enumCand &&
    !isInheritModel(enumCand) &&
    !isOmittedOrDefaultModel(enumCand) &&
    /^MODEL_(?!ALIAS_)/i.test(enumCand)
      ? enumCand
      : '';

  if (safeSlug || safeEnum) {
    const fallbackModel = safeSlug || safeEnum;
    const fallbackLabel =
      knownDisplayName ||
      labelsMap[fallbackModel] ||
      (safeEnum && labelsMap[safeEnum]) ||
      (!/^MODEL_PLACEHOLDER_/i.test(fallbackModel) ? formatModelDisplay(fallbackModel) : '');
    return {
      coordinatorId: targetCoordId,
      model: fallbackModel,
      displayName: fallbackLabel,
      modelEnum: safeEnum,
      matched: null,
      source: genRes.ok && genRes.info ? 'ls' : 'transcript',
    };
  }

  return {
    coordinatorId: targetCoordId,
    model: 'pro',
    displayName: knownDisplayName,
    modelEnum: '',
    matched: null,
    source: knownDisplayName ? (genRes.ok && genRes.info ? 'ls' : 'transcript') : 'fallback',
  };
}

function resolveModelEntryFromCatalog(
  rawInput,
  catalogModels = [],
  labelsMap = {},
  coordInfo = null,
) {
  const raw = String(rawInput || '').trim();
  if (isOmittedOrDefaultModel(raw)) {
    return {
      raw: '',
      canonical: '',
      createModelArg: '',
      label: '',
      modelId: '',
      modelEnum: '',
      matched: null,
      isTier: false,
      isInherit: false,
    };
  }
  if (isInheritModel(raw)) {
    const coordDisplay = coordInfo?.displayName || '';
    return {
      raw,
      canonical: 'inherit',
      createModelArg: 'inherit',
      label: coordDisplay ? `Follow Coordinator (${coordDisplay})` : formatModelDisplay('inherit'),
      modelId: coordInfo?.model || '',
      modelEnum: coordInfo?.modelEnum || '',
      matched: coordInfo?.matched || null,
      isTier: false,
      isInherit: true,
    };
  }
  const tier = canonicalizeTierAlias(raw);
  if (tier) {
    return {
      raw,
      canonical: tier,
      createModelArg: tier,
      label: formatModelDisplay(tier),
      modelId: '',
      modelEnum: '',
      matched: null,
      isTier: true,
      isInherit: false,
    };
  }
  const matched = matchSelectableModelInList(raw, catalogModels);
  if (matched) {
    const createModelArg = matched.modelId || matched.modelEnum || 'pro';
    const canonical = isHumanDisplayLabel(raw) ? createModelArg : raw;
    return {
      raw,
      canonical,
      createModelArg,
      label: matched.label || formatModelDisplay(createModelArg),
      modelId: matched.modelId || '',
      modelEnum: matched.modelEnum || '',
      matched,
      isTier: false,
      isInherit: false,
    };
  }
  if (isHumanDisplayLabel(raw)) {
    return {
      raw,
      canonical: 'pro',
      createModelArg: 'pro',
      label: formatModelDisplay('pro'),
      modelId: '',
      modelEnum: '',
      matched: null,
      isTier: true,
      isInherit: false,
    };
  }
  const cachedLabel = labelsMap?.[raw] || '';
  const fallbackLabel =
    cachedLabel || (/^MODEL_PLACEHOLDER_/i.test(raw) ? '' : formatModelDisplay(raw));
  return {
    raw,
    canonical: raw,
    createModelArg: raw,
    label: fallbackLabel || raw,
    modelId: /^MODEL_/i.test(raw) ? '' : raw,
    modelEnum: /^MODEL_(?!ALIAS_)/i.test(raw) ? raw : '',
    matched: null,
    isTier: false,
    isInherit: false,
  };
}

export function canonicalizeModelForSettings(rawInput, catalogModels = []) {
  const s = String(rawInput || '').trim();
  if (isInheritModel(s)) return { value: 'inherit', label: formatModelDisplay('inherit') };
  if (isOmittedOrDefaultModel(s)) return { value: '', label: '' };
  const tier = canonicalizeTierAlias(s);
  if (tier) return { value: tier, label: formatModelDisplay(tier) };
  const matched = matchSelectableModelInList(s, catalogModels);
  if (matched) {
    const value = matched.modelId || matched.modelEnum || s;
    return { value, label: matched.label || '' };
  }
  return { value: s, label: '' };
}

function parseBoolLike(val, defaultVal = false) {
  if (val === undefined || val === null || val === '') return defaultVal;
  if (typeof val === 'boolean') return val;
  const s = String(val).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return defaultVal;
}

function withSoftTimeout(promise, timeoutMs, fallbackVal = null) {
  const ms = Math.max(50, Number(timeoutMs) || 1500);
  const guarded = Promise.resolve(promise).catch(() => fallbackVal);
  return new Promise((resolveOut) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveOut(fallbackVal);
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    guarded.then((val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOut(val);
    });
  });
}

function isNormalizedPathEqualOrDescendant(childNorm, parentNorm) {
  if (!childNorm || !parentNorm) return false;
  if (childNorm === parentNorm) return true;
  const sep = process.platform === 'win32' ? '\\' : '/';
  const prefix = parentNorm.endsWith(sep) ? parentNorm : `${parentNorm}${sep}`;
  return childNorm.startsWith(prefix);
}

function inferScopeKeyFromRegistry(
  { workspacePath = '', conversationId = '', coordinatorId = '', projectId = '' } = {},
  reg = null,
) {
  const activeReg = reg || loadRegistry();
  const coords = activeReg?.coordinators && typeof activeReg.coordinators === 'object' ? activeReg.coordinators : {};
  const threads = activeReg?.threads && typeof activeReg.threads === 'object' ? activeReg.threads : {};

  // 1. Conversation ID -> registered Worker Thread or Coordinator (including retired IDs) takes highest priority
  const convId = String(conversationId || coordinatorId || '').trim();
  if (convId) {
    const thrHit = Object.values(threads).find((t) => t?.conversationId === convId && t?.workspaceKey);
    if (thrHit?.workspaceKey) return String(thrHit.workspaceKey);
    const coordHit = Object.values(coords).find((c) => c?.conversationId === convId && c?.key);
    if (coordHit?.key) return String(coordHit.key);
    const retiredHit = Object.values(coords).find(
      (c) =>
        c?.key &&
        Array.isArray(c.retiredCoordinatorIds) &&
        c.retiredCoordinatorIds.includes(convId),
    );
    if (retiredHit?.key) return String(retiredHit.key);
  }

  // 2. Workspace path -> match known thread worktreePath or registered coordinator root/ancestor (never bare existsSync)
  const cleanWs = uriToPath(workspacePath);
  if (cleanWs) {
    const normWs = normalizeKey(cleanWs);
    const wtHit = Object.values(threads).find(
      (t) =>
        t?.worktreePath &&
        t?.workspaceKey &&
        isNormalizedPathEqualOrDescendant(normWs, normalizeKey(t.worktreePath)),
    );
    if (wtHit?.workspaceKey) return String(wtHit.workspaceKey);

    if (coords[normWs]) return normWs;
    for (const [ck, c] of Object.entries(coords)) {
      if (isFilesystemPathKey(ck) && normalizeKey(ck) === normWs) return ck;
      const roots = [c?.repoRoot, c?.workspacePath].filter(Boolean);
      if (roots.some((r) => normalizeKey(r) === normWs)) return ck;
    }

    let bestAncestorKey = '';
    let bestAncestorLen = 0;
    for (const [ck, c] of Object.entries(coords)) {
      const roots = [
        ...(isFilesystemPathKey(ck) ? [ck] : []),
        c?.repoRoot,
        c?.workspacePath,
      ].filter(Boolean);
      for (const r of roots) {
        const normRoot = normalizeKey(r);
        if (
          isNormalizedPathEqualOrDescendant(normWs, normRoot) &&
          normRoot.length > bestAncestorLen
        ) {
          bestAncestorLen = normRoot.length;
          bestAncestorKey = ck;
        }
      }
    }
    if (bestAncestorKey) return bestAncestorKey;
  }

  // 3. Explicit projectId -> registered coordinator or project:<id>
  const cleanProj =
    projectId && projectId !== 'outside-of-project' ? String(projectId).trim() : '';
  if (cleanProj) {
    const projCoord = Object.values(coords).find((c) => c?.projectId === cleanProj && c?.key);
    if (projCoord?.key) return String(projCoord.key);
    return `project:${cleanProj}`;
  }
  return '';
}

export function buildFallbackEffectiveSettings(
  settingsInput = null,
  { scopeKey = '', workspacePath = '', reg = null, catalogModels = [] } = {},
) {
  const settings = normalizeSettingsDoc(settingsInput || loadSettings());
  const activeReg = reg || loadRegistry();
  const cleanScopeKey = String(scopeKey || '').trim();
  const coord = cleanScopeKey ? activeReg.coordinators?.[cleanScopeKey] || null : null;
  const scopeKind = !cleanScopeKey
    ? 'unscoped'
    : cleanScopeKey.startsWith('project:')
      ? 'project'
      : cleanScopeKey.startsWith('conv:')
        ? 'conversation'
        : 'workspace';
  const scopeProjectName = String(coord?.projectName || '').trim();
  let scopeLabel = scopeProjectName;
  if (!scopeLabel && coord?.title) {
    scopeLabel = String(coord.title).replace(/^(?:\[Coordinator\]\s*)+/i, '').trim();
  } else if (!scopeLabel && cleanScopeKey && isFilesystemPathKey(cleanScopeKey)) {
    scopeLabel = basename(cleanScopeKey);
  }

  const cachedCoord = coord?.conversationId ? threadModelCache.get(coord.conversationId) : null;
  const coordDisplay = String(cachedCoord?.modelDisplayName || '').trim();
  const coordModel = String(cachedCoord?.resolvedModel || cachedCoord?.modelEnum || '').trim();
  const coordCtx = coordDisplay || coordModel
    ? {
        coordinatorId: coord?.conversationId || '',
        model: coordModel || 'pro',
        displayName: coordDisplay || (coordModel ? formatModelDisplay(coordModel) : ''),
        modelEnum: cachedCoord?.modelEnum || '',
        matched: null,
      }
    : null;

  const globalWorktreeRaw = normalizeStoredModelValue(settings.defaults?.worktreeModel, 'inherit');
  const globalReadOnlyRaw = normalizeStoredModelValue(settings.defaults?.readOnlyModel, 'inherit');
  const globalReviewRaw = normalizeStoredModelValue(settings.defaults?.reviewModel, 'inherit');
  const projEntry = cleanScopeKey
    ? lookupProjectSettingsEntry(settings.projects, cleanScopeKey, workspacePath)
    : null;
  const projWorktreeRaw = normalizeStoredModelValue(projEntry?.worktreeModel, '');
  const projReadOnlyRaw = normalizeStoredModelValue(projEntry?.readOnlyModel, '');
  const projReviewRaw = normalizeStoredModelValue(projEntry?.reviewModel, '');

  const globalWt = resolveModelEntryFromCatalog(globalWorktreeRaw, catalogModels, settings.labels, coordCtx);
  const globalRo = resolveModelEntryFromCatalog(globalReadOnlyRaw, catalogModels, settings.labels, coordCtx);
  const globalRev = resolveModelEntryFromCatalog(globalReviewRaw, catalogModels, settings.labels, coordCtx);
  const projWt = resolveModelEntryFromCatalog(projWorktreeRaw, catalogModels, settings.labels, coordCtx);
  const projRo = resolveModelEntryFromCatalog(projReadOnlyRaw, catalogModels, settings.labels, coordCtx);
  const projRev = resolveModelEntryFromCatalog(projReviewRaw, catalogModels, settings.labels, coordCtx);
  const effWt = projWorktreeRaw ? projWt : globalWt;
  const effRo = projReadOnlyRaw ? projRo : globalRo;
  const effRev = projReviewRaw ? projRev : globalRev;
  const effectiveWatchdog = resolveEffectiveWatchdogConfig(settings, cleanScopeKey, workspacePath);

  return {
    scopeKey: cleanScopeKey,
    scopeKind,
    projectName: scopeProjectName,
    scopeLabel,
    hasProjectOverride: Boolean(projWorktreeRaw || projReadOnlyRaw || projReviewRaw),
    hasWatchdogProjectOverride: effectiveWatchdog.hasProjectOverride,
    watchdog: effectiveWatchdog,
    coordinatorId: coord?.conversationId || '',
    coordinatorModel: coordCtx ? coordCtx.model : '',
    coordinatorModelDisplayName: coordCtx ? coordCtx.displayName : '',
    worktreeModel: effWt.createModelArg || 'inherit',
    readOnlyModel: effRo.createModelArg || 'inherit',
    reviewModel: effRev.createModelArg || 'inherit',
    worktreeModelLabel: effWt.label || formatModelDisplay(effWt.createModelArg || 'inherit'),
    readOnlyModelLabel: effRo.label || formatModelDisplay(effRo.createModelArg || 'inherit'),
    reviewModelLabel: effRev.label || formatModelDisplay(effRev.createModelArg || 'inherit'),
    worktreeSource: projWorktreeRaw ? 'project' : 'global',
    readOnlySource: projReadOnlyRaw ? 'project' : 'global',
    reviewSource: projReviewRaw ? 'project' : 'global',
    global: {
      worktreeModel: globalWt.createModelArg || 'inherit',
      readOnlyModel: globalRo.createModelArg || 'inherit',
      reviewModel: globalRev.createModelArg || 'inherit',
      worktreeModelLabel: globalWt.label || formatModelDisplay(globalWt.createModelArg || 'inherit'),
      readOnlyModelLabel: globalRo.label || formatModelDisplay(globalRo.createModelArg || 'inherit'),
      reviewModelLabel: globalRev.label || formatModelDisplay(globalRev.createModelArg || 'inherit'),
    },
    project: {
      worktreeModel: projWt.createModelArg || '',
      readOnlyModel: projRo.createModelArg || '',
      reviewModel: projRev.createModelArg || '',
      worktreeModelLabel: projWt.label || '',
      readOnlyModelLabel: projRo.label || '',
      reviewModelLabel: projRev.label || '',
    },
  };
}

export async function getEffectiveSettings({
  workspacePath = '',
  workspaceKey = '',
  coordinatorId = '',
  conversationId = '',
  projectId = '',
  fast = false,
  forceRefresh = false,
  lsTimeoutMs = 2500,
  skipScopeResolve = false,
} = {}) {
  const settings = loadSettings();
  const reg = loadRegistry();
  let scopeKey = String(workspaceKey || '').trim();
  let scopeKind = '';
  let scopeLabel = '';
  let scopeProjectName = '';
  let scopeProjId =
    projectId && projectId !== 'outside-of-project' ? String(projectId).trim() : '';
  let scopeBaseDir = '';

  if (
    !skipScopeResolve &&
    !scopeKey &&
    (workspacePath || coordinatorId || conversationId || scopeProjId)
  ) {
    const scope = await resolveProjectScope({
      workspacePath,
      conversationId: conversationId || coordinatorId,
      coordinatorId,
      projectId: scopeProjId,
      reg,
    });
    scopeKey = scope.scopeKey || '';
    scopeKind = scope.scopeKind || '';
    scopeProjectName = scope.projectName || '';
    scopeLabel = scope.label || '';
    scopeProjId = scopeProjId || scope.projectId || '';
    scopeBaseDir = scope.baseDir || '';
  } else if (scopeKey) {
    const coord = reg.coordinators?.[scopeKey] || null;
    if (!scopeProjId && coord?.projectId && coord.projectId !== 'outside-of-project') {
      scopeProjId = coord.projectId;
    }
    if (!scopeProjId && scopeKey.startsWith('project:')) {
      const fromKey = scopeKey.slice('project:'.length).trim();
      if (fromKey && fromKey !== 'outside-of-project') {
        scopeProjId = fromKey;
      }
    }
    if (scopeProjId) {
      scopeProjectName = await resolveProjectName(scopeProjId, {
        allowCachedOnly: fast,
        timeoutMs: Math.max(200, Number(lsTimeoutMs) || 2500),
      });
      if (!scopeProjectName && coord?.projectName) {
        scopeProjectName = String(coord.projectName).trim();
      }
    }
    if (scopeProjectName) {
      scopeLabel = scopeProjectName;
    } else if (coord?.title) {
      scopeLabel = String(coord.title).replace(/^(?:\[Coordinator\]\s*)+/i, '').trim();
    } else if (isFilesystemPathKey(scopeKey)) {
      scopeLabel = basename(scopeKey);
    }
    scopeKind = scopeKey.startsWith('project:')
      ? 'project'
      : scopeKey.startsWith('conv:')
        ? 'conversation'
        : 'workspace';
  }

  const catalog = await getCascadeModelCatalog({
    timeoutMs: Math.max(200, Number(lsTimeoutMs) || 2500),
    allowCachedOnly: fast && !forceRefresh,
    forceRefresh: Boolean(forceRefresh),
  });
  const catalogModels = Array.isArray(catalog?.models) ? catalog.models : [];

  const coordResolved = await resolveInheritedCoordinatorModel({
    coordinatorId,
    conversationId,
    workspacePath: workspacePath || scopeBaseDir,
    workspaceKey: scopeKey,
    projectId: scopeProjId,
    reg,
    catalogModels,
    settingsLabels: settings.labels,
    allowCachedOnly: fast && !forceRefresh,
    lsTimeoutMs: Math.max(200, Number(lsTimeoutMs) || 2500),
  });
  const hasResolvedCoordModel = coordResolved.source !== 'fallback';
  const coordinatorModelDisplayName = hasResolvedCoordModel
    ? coordResolved.displayName || formatModelDisplay(coordResolved.model)
    : '';
  const coordinatorModel = hasResolvedCoordModel ? coordResolved.model : '';
  const coordDisplayContext = hasResolvedCoordModel
    ? { ...coordResolved, displayName: coordinatorModelDisplayName }
    : null;

  const globalWorktreeRaw = normalizeStoredModelValue(settings.defaults?.worktreeModel, 'inherit');
  const globalReadOnlyRaw = normalizeStoredModelValue(settings.defaults?.readOnlyModel, 'inherit');
  const globalReviewRaw = normalizeStoredModelValue(settings.defaults?.reviewModel, 'inherit');
  const projEntry = scopeKey
    ? lookupProjectSettingsEntry(settings.projects, scopeKey, workspacePath)
    : null;
  const projWorktreeRaw = normalizeStoredModelValue(projEntry?.worktreeModel, '');
  const projReadOnlyRaw = normalizeStoredModelValue(projEntry?.readOnlyModel, '');
  const projReviewRaw = normalizeStoredModelValue(projEntry?.reviewModel, '');

  const globalWt = resolveModelEntryFromCatalog(
    globalWorktreeRaw,
    catalogModels,
    settings.labels,
    coordDisplayContext,
  );
  const globalRo = resolveModelEntryFromCatalog(
    globalReadOnlyRaw,
    catalogModels,
    settings.labels,
    coordDisplayContext,
  );
  const globalRev = resolveModelEntryFromCatalog(
    globalReviewRaw,
    catalogModels,
    settings.labels,
    coordDisplayContext,
  );
  const projWt = resolveModelEntryFromCatalog(
    projWorktreeRaw,
    catalogModels,
    settings.labels,
    coordDisplayContext,
  );
  const projRo = resolveModelEntryFromCatalog(
    projReadOnlyRaw,
    catalogModels,
    settings.labels,
    coordDisplayContext,
  );
  const projRev = resolveModelEntryFromCatalog(
    projReviewRaw,
    catalogModels,
    settings.labels,
    coordDisplayContext,
  );
  const effWt = projWorktreeRaw ? projWt : globalWt;
  const effRo = projReadOnlyRaw ? projRo : globalRo;
  const effRev = projReviewRaw ? projRev : globalRev;
  const effectiveWatchdog = resolveEffectiveWatchdogConfig(settings, scopeKey, workspacePath || scopeBaseDir);

  return {
    scopeKey,
    scopeKind,
    projectName: scopeProjectName,
    scopeLabel,
    hasProjectOverride: Boolean(projWorktreeRaw || projReadOnlyRaw || projReviewRaw),
    hasWatchdogProjectOverride: effectiveWatchdog.hasProjectOverride,
    watchdog: effectiveWatchdog,
    coordinatorId: coordResolved.coordinatorId || '',
    coordinatorModel,
    coordinatorModelDisplayName,
    worktreeModel: effWt.createModelArg || 'inherit',
    readOnlyModel: effRo.createModelArg || 'inherit',
    reviewModel: effRev.createModelArg || 'inherit',
    worktreeModelLabel: effWt.label || formatModelDisplay(effWt.createModelArg || 'inherit'),
    readOnlyModelLabel: effRo.label || formatModelDisplay(effRo.createModelArg || 'inherit'),
    reviewModelLabel: effRev.label || formatModelDisplay(effRev.createModelArg || 'inherit'),
    worktreeSource: projWorktreeRaw ? 'project' : 'global',
    readOnlySource: projReadOnlyRaw ? 'project' : 'global',
    reviewSource: projReviewRaw ? 'project' : 'global',
    global: {
      worktreeModel: globalWt.createModelArg || 'inherit',
      readOnlyModel: globalRo.createModelArg || 'inherit',
      reviewModel: globalRev.createModelArg || 'inherit',
      worktreeModelLabel: globalWt.label || formatModelDisplay(globalWt.createModelArg || 'inherit'),
      readOnlyModelLabel: globalRo.label || formatModelDisplay(globalRo.createModelArg || 'inherit'),
      reviewModelLabel: globalRev.label || formatModelDisplay(globalRev.createModelArg || 'inherit'),
    },
    project: {
      worktreeModel: projWt.createModelArg || '',
      readOnlyModel: projRo.createModelArg || '',
      reviewModel: projRev.createModelArg || '',
      worktreeModelLabel: projWt.label || '',
      readOnlyModelLabel: projRo.label || '',
      reviewModelLabel: projRev.label || '',
    },
  };
}

/**
 * Fast, timeout-bounded Settings write handler for Sidecar `/api/settings_save`.
 * Avoids blocking global saves on Git/LS RPCs, persists atomically first, and degrades cleanly
 * to cached/fallback effective metadata if LS is slow or offline.
 */
export async function saveSettingsWithFastResponse(
  data = {},
  {
    resolveScopeTimeoutMs = 1500,
    catalogTimeoutMs = 800,
    effectiveTimeoutMs = 1500,
  } = {},
) {
  const scope = data.scope === 'project' ? 'project' : 'global';
  const reset = parseBoolLike(data.reset, false);
  const scopeOpts = {
    workspacePath: data.workspacePath || data.workspace || '',
    conversationId: data.conversationId || '',
    coordinatorId: data.coordinatorId || '',
    projectId: data.projectId || '',
  };
  const explicitKey = String(data.workspaceKey || '').trim();
  const reg = loadRegistry();

  let scopeKey = explicitKey;
  if (!scopeKey) {
    if (scope === 'global') {
      // Never spawn git subprocesses or block on LS GetConversation just to save global defaults
      scopeKey = inferScopeKeyFromRegistry(scopeOpts, reg);
    } else {
      const inferred = inferScopeKeyFromRegistry(scopeOpts, reg);
      if (inferred) {
        scopeKey = inferred;
      } else {
        const resolved = await withSoftTimeout(
          resolveProjectScope({ ...scopeOpts, reg }),
          resolveScopeTimeoutMs,
          null,
        );
        scopeKey = resolved?.scopeKey || '';
      }
    }
  }

  if (scope === 'project' && !scopeKey) {
    return {
      ok: false,
      error: 'No active project scope to save project override.',
      locale: resolveAppLocale(),
    };
  }

  let models = await getSelectableModels({ allowCachedOnly: true });
  const needsLiveCatalog =
    !reset &&
    models.length === 0 &&
    ['worktreeModel', 'readOnlyModel', 'reviewModel'].some(
      (f) => f in data && isHumanDisplayLabel(data[f]),
    );
  if (needsLiveCatalog) {
    const fetched = await withSoftTimeout(
      getSelectableModels({ timeoutMs: catalogTimeoutMs }),
      catalogTimeoutMs + 150,
      [],
    );
    if (Array.isArray(fetched) && fetched.length > 0) models = fetched;
  }

  const section = String(data.section || '').trim().toLowerCase();
  const labels = {};
  const patch = {
    scope,
    reset,
    ...(section ? { section } : {}),
    ...(scope === 'project' ? { workspaceKey: scopeKey } : {}),
  };

  if (!reset) {
    for (const field of ['worktreeModel', 'readOnlyModel', 'reviewModel']) {
      if (!(field in data)) continue;
      const { value, label } = canonicalizeModelForSettings(data[field], models);
      patch[field] = value;
      if (value && value !== 'inherit' && label) labels[value] = label;
    }
    if (Object.keys(labels).length > 0) {
      patch.labels = labels;
    }
    if ('watchdog' in data) {
      let parsedWd = data.watchdog;
      if (typeof parsedWd === 'string') {
        try {
          parsedWd = JSON.parse(parsedWd);
        } catch {
          parsedWd = null;
        }
      }
      if (parsedWd === null || (parsedWd && typeof parsedWd === 'object')) {
        patch.watchdog = parsedWd;
      }
    }
  }

  const settings = saveSettings(patch);
  const fastEffective = await withSoftTimeout(
    getEffectiveSettings({
      ...scopeOpts,
      workspaceKey: scopeKey,
      fast: true,
      skipScopeResolve: true,
      lsTimeoutMs: Math.min(1000, effectiveTimeoutMs),
    }),
    effectiveTimeoutMs,
    null,
  );
  const degraded = !fastEffective;
  const effective =
    fastEffective ||
    buildFallbackEffectiveSettings(settings, {
      scopeKey,
      workspacePath: scopeOpts.workspacePath,
      reg,
      catalogModels: models,
    });

  return {
    ok: true,
    locale: resolveAppLocale(),
    settings,
    effective,
    scopeKey: effective.scopeKey || scopeKey || '',
    projectName: effective.projectName || '',
    scopeLabel: effective.scopeLabel || '',
    coordinatorModelDisplayName: effective.coordinatorModelDisplayName || '',
    coordinatorModel: effective.coordinatorModel || '',
    ...(degraded ? { degraded: true } : {}),
  };
}

export function normalizeThreadType(rawType, createWorktree = true) {
  const s = String(rawType || '').trim().toLowerCase();
  if (s === 'review' || s === 'code-review' || s === 'code_review') return 'review';
  if (s === 'readonly' || s === 'read-only' || s === 'read_only') return 'readonly';
  if (s === 'worktree') return 'worktree';
  return createWorktree ? 'worktree' : 'readonly';
}

export async function resolveDefaultDispatchModel({
  threadType = '',
  createWorktree = true,
  workspacePath = '',
  workspaceKey = '',
  coordinatorId = '',
  conversationId = '',
  projectId = '',
} = {}) {
  const effective = await getEffectiveSettings({
    workspacePath,
    workspaceKey,
    coordinatorId,
    conversationId,
    projectId,
  });
  const resolvedType = normalizeThreadType(threadType, createWorktree);
  const configured =
    (resolvedType === 'review'
      ? effective.reviewModel
      : resolvedType === 'readonly'
        ? effective.readOnlyModel
        : effective.worktreeModel) || 'inherit';
  if (isInheritModel(configured)) {
    return effective.coordinatorModel || 'pro';
  }
  return configured;
}

function isSameUsage(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.totalTokens === b.totalTokens &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.contextTokens === b.contextTokens &&
    a.compactLimit === b.compactLimit &&
    a.compactPercent === b.compactPercent &&
    a.compactCount === b.compactCount &&
    a.source === b.source
  );
}

function mergeFallbackUsage(txUsage, prevUsage) {
  if (!txUsage) return prevUsage || null;
  const compactLimit =
    txUsage.compactLimit > 0
      ? txUsage.compactLimit
      : prevUsage?.compactLimit > 0
        ? prevUsage.compactLimit
        : 0;
  const compactPercent =
    compactLimit > 0
      ? Math.min(100, Math.max(0, Math.round((txUsage.contextTokens / compactLimit) * 100)))
      : null;
  const compactCount = Math.max(
    Number(txUsage.compactCount) || 0,
    Number(prevUsage?.compactCount) || 0,
  );
  return {
    ...txUsage,
    compactLimit,
    compactPercent,
    compactCount,
  };
}

/**
 * Resolves and refreshes a thread's concrete `modelDisplayName`, `resolvedModel`, and token `usage`
 * using GetCascadeTrajectoryGeneratorMetadata (live, including mid-thread switches), falling back
 * to GetCascadeModelConfigData and transcript.jsonl when LS metadata is unavailable.
 */
export async function resolveThreadModelInfo(
  t,
  {
    forceLsCheck = false,
    bypassDebounce = false,
    convUpdatedAt = '',
    convRunState = '',
    lsTimeoutMs = 3500,
  } = {},
) {
  const convId = String(t?.conversationId || '').trim();
  if (!convId) return false;

  const nowMs = Date.now();
  const cached = storeLruGet(threadModelCache, convId);
  const effectiveRunState = convRunState || t.runState || '';
  const effectiveUpdatedAt = convUpdatedAt || t.updatedAt || '';
  const isRunning = effectiveRunState === 'RUN_STATE_RUNNING';

  // Archived threads are static snapshots: never hit LS RPC and never re-parse transcript repeatedly.
  if (t.archived) {
    let nextDisplayName = t.modelDisplayName || cached?.modelDisplayName || '';
    let nextResolvedModel = t.resolvedModel || cached?.resolvedModel || '';
    let nextModelEnum = t.modelEnum || cached?.modelEnum || '';
    let nextUsage = t.usage || cached?.usage || null;

    if (!cached?.archivedResolved) {
      if (!nextDisplayName) {
        const txModel = extractTranscriptModel(convId);
        if (txModel.displayName) {
          nextDisplayName = txModel.displayName;
          nextResolvedModel = txModel.modelSlug || nextResolvedModel;
        } else if (txModel.modelSlug) {
          nextResolvedModel = txModel.modelSlug;
          nextDisplayName = await resolveNonTierModelDisplay(txModel.modelSlug, {
            allowCachedOnly: true,
          });
        }
      }
      if (!nextUsage) {
        const txUsage = extractTranscriptUsage(convId);
        nextUsage = mergeFallbackUsage(txUsage, t.usage || cached?.usage || null);
      }
      if (!nextDisplayName && t.model && !isTierAlias(t.model)) {
        nextDisplayName = await resolveNonTierModelDisplay(t.model, {
          allowCachedOnly: true,
        });
        if (nextDisplayName && !nextResolvedModel) {
          nextResolvedModel = t.model;
        }
      }
      storeLruSet(
        threadModelCache,
        convId,
        {
          checkedAt: nowMs,
          updatedAt: effectiveUpdatedAt,
          runState: effectiveRunState,
          modelDisplayName: nextDisplayName,
          resolvedModel: nextResolvedModel,
          modelEnum: nextModelEnum,
          usage: nextUsage,
          genMetaCount: Number.isInteger(cached?.genMetaCount) ? cached.genMetaCount : 0,
          fromLs: Boolean(cached?.fromLs),
          archivedResolved: true,
        },
        THREAD_MODEL_CACHE_MAX,
      );
    }

    let changed = false;
    if (nextDisplayName && nextDisplayName !== (t.modelDisplayName || '')) {
      t.modelDisplayName = nextDisplayName;
      changed = true;
    }
    if (nextResolvedModel && nextResolvedModel !== (t.resolvedModel || '')) {
      t.resolvedModel = nextResolvedModel;
      changed = true;
    }
    if (nextModelEnum && nextModelEnum !== (t.modelEnum || '')) {
      t.modelEnum = nextModelEnum;
      changed = true;
    }
    if (nextUsage && !isSameUsage(nextUsage, t.usage || null)) {
      t.usage = nextUsage;
      changed = true;
    }
    return changed;
  }

  let shouldQueryLs = false;
  if (forceLsCheck) {
    if (bypassDebounce || !cached) {
      shouldQueryLs = true;
    } else if (!cached.fromLs) {
      shouldQueryLs = nowMs - cached.checkedAt >= 5000;
    } else if (
      effectiveUpdatedAt !== cached.updatedAt ||
      effectiveRunState !== cached.runState ||
      !t.modelDisplayName ||
      !t.usage ||
      Boolean(t.pendingModelSwitch)
    ) {
      shouldQueryLs = true;
    } else if (isRunning) {
      shouldQueryLs = nowMs - cached.checkedAt >= THREAD_MODEL_OPEN_DEBOUNCE_MS;
    }
  } else if (!cached) {
    shouldQueryLs = true;
  } else if (isRunning && nowMs - cached.checkedAt >= THREAD_MODEL_RUNNING_TTL_MS) {
    shouldQueryLs = true;
  } else if (
    effectiveUpdatedAt !== cached.updatedAt ||
    effectiveRunState !== cached.runState ||
    Boolean(t.pendingModelSwitch)
  ) {
    shouldQueryLs = true;
  } else if (!cached.fromLs && nowMs - cached.checkedAt >= THREAD_MODEL_OFFLINE_RETRY_MS) {
    shouldQueryLs = true;
  } else if ((!t.modelDisplayName || !t.usage) && nowMs - cached.checkedAt >= THREAD_MODEL_EMPTY_RETRY_MS) {
    shouldQueryLs = true;
  }

  let nextDisplayName = '';
  let nextResolvedModel = '';
  let nextModelEnum = '';
  let nextUsage = null;
  let fromLs = cached?.fromLs || false;
  let genMetaCount = Number.isInteger(cached?.genMetaCount) ? cached.genMetaCount : 0;
  let clearedPendingSwitch = false;
  let keepPendingSwitch = false;
  const effectiveLsTimeout = Math.max(80, Number(lsTimeoutMs) || 3500);

  if (shouldQueryLs) {
    const genRes = await getThreadGeneratorModel(convId, effectiveLsTimeout);
    fromLs = genRes.ok;
    if (genRes.ok) {
      genMetaCount = Number.isInteger(genRes.count) ? genRes.count : 0;
      if (genRes.usage) {
        nextUsage = genRes.usage;
      }
    }
    if (t.pendingModelSwitch) {
      const baseline = Number.isInteger(t.pendingModelSwitch.baselineGenMetaCount)
        ? t.pendingModelSwitch.baselineGenMetaCount
        : -1;
      const reqMs = Date.parse(t.pendingModelSwitch.requestedAt || '');
      const expiredIdle =
        !isRunning && Number.isFinite(reqMs) && nowMs - reqMs > THREAD_PENDING_MODEL_IDLE_GRACE_MS;
      if ((genRes.ok && genMetaCount > baseline) || expiredIdle) {
        delete t.pendingModelSwitch;
        clearedPendingSwitch = true;
      } else {
        keepPendingSwitch = true;
      }
    }
    if (!keepPendingSwitch && genRes.ok && genRes.info) {
      nextResolvedModel = genRes.info.responseModel || genRes.info.modelEnum || '';
      nextModelEnum = genRes.info.modelEnum || '';
      if (genRes.info.displayName) {
        nextDisplayName = genRes.info.displayName;
      } else if (nextResolvedModel) {
        const lookup = await getModelConfigLookup({
          timeoutMs: Math.min(2500, effectiveLsTimeout),
        });
        const mapped =
          resolveModelLabelFromLookup(nextResolvedModel, lookup) ||
          resolveModelLabelFromLookup(genRes.info.modelEnum, lookup);
        nextDisplayName =
          mapped ||
          (!/^MODEL_PLACEHOLDER_/i.test(nextResolvedModel)
            ? formatModelDisplay(nextResolvedModel)
            : '');
      }
    }
  } else if (cached) {
    nextDisplayName = cached.modelDisplayName || t.modelDisplayName || '';
    nextResolvedModel = cached.resolvedModel || t.resolvedModel || '';
    nextModelEnum = cached.modelEnum || t.modelEnum || '';
    nextUsage = cached.usage || t.usage || null;
    if (t.pendingModelSwitch) {
      keepPendingSwitch = true;
    }
  }

  if (keepPendingSwitch && t.pendingModelSwitch) {
    nextDisplayName = t.pendingModelSwitch.modelDisplayName || t.modelDisplayName || '';
    nextResolvedModel = t.pendingModelSwitch.resolvedModel || t.resolvedModel || '';
    nextModelEnum = t.pendingModelSwitch.modelEnum || t.modelEnum || '';
  }

  if (!keepPendingSwitch && (!nextDisplayName || !fromLs)) {
    const txModel = extractTranscriptModel(convId);
    if (txModel.displayName) {
      nextDisplayName = txModel.displayName;
      nextResolvedModel = txModel.modelSlug || nextResolvedModel;
    } else if (txModel.modelSlug) {
      nextResolvedModel = txModel.modelSlug;
      nextDisplayName = await resolveNonTierModelDisplay(txModel.modelSlug, {
        allowCachedOnly: !fromLs,
      });
    }
  }

  if (!nextUsage) {
    const txUsage = extractTranscriptUsage(convId);
    nextUsage = mergeFallbackUsage(txUsage, t.usage || cached?.usage || null);
  }

  if (!nextDisplayName && t.modelDisplayName) {
    nextDisplayName = t.modelDisplayName;
    nextResolvedModel = nextResolvedModel || t.resolvedModel || '';
  }

  if (!nextDisplayName && t.model && !isTierAlias(t.model)) {
    nextDisplayName = await resolveNonTierModelDisplay(t.model, {
      allowCachedOnly: shouldQueryLs && !fromLs,
    });
    if (nextDisplayName && !nextResolvedModel) {
      nextResolvedModel = t.model;
    }
  }

  storeLruSet(
    threadModelCache,
    convId,
    {
      checkedAt: shouldQueryLs ? nowMs : cached?.checkedAt || nowMs,
      updatedAt: effectiveUpdatedAt,
      runState: effectiveRunState,
      modelDisplayName: nextDisplayName,
      resolvedModel: nextResolvedModel,
      modelEnum: nextModelEnum,
      usage: nextUsage,
      genMetaCount,
      fromLs,
      archivedResolved: false,
    },
    THREAD_MODEL_CACHE_MAX,
  );

  let changed = clearedPendingSwitch;
  if (nextDisplayName !== (t.modelDisplayName || '')) {
    t.modelDisplayName = nextDisplayName;
    changed = true;
  }
  if (nextResolvedModel && nextResolvedModel !== (t.resolvedModel || '')) {
    t.resolvedModel = nextResolvedModel;
    changed = true;
  }
  if (nextModelEnum && nextModelEnum !== (t.modelEnum || '')) {
    t.modelEnum = nextModelEnum;
    changed = true;
  }
  if (nextUsage && !isSameUsage(nextUsage, t.usage || null)) {
    t.usage = nextUsage;
    changed = true;
  }
  return changed;
}

export async function getConversationMetaCached(conversationId) {
  const id = String(conversationId || '').trim();
  if (!id) {
    return { projectId: '', environmentId: '', title: '' };
  }
  const nowMs = Date.now();
  const cached = convMetaCache.get(id);
  if (cached && cached.expiresAt > nowMs) {
    return cached.meta;
  }
  try {
    const res = await getConversation(id);
    const conv = res?.conversation || res;
    const meta = conv?.metadata || {};
    const rawProjId = meta.projectId || meta.project_id || conv?.projectId || '';
    const projectId =
      rawProjId && rawProjId !== 'outside-of-project' ? String(rawProjId).trim() : '';
    const rawEnvId = meta.environmentId || meta.environment_id || conv?.environmentId || '';
    const environmentId = rawEnvId ? String(rawEnvId).trim() : '';
    const title = String(
      conv?.annotations?.title || conv?.title || conv?.state?.summary || '',
    ).trim();
    const resolvedMeta = { projectId, environmentId, title };
    convMetaCache.set(id, { expiresAt: nowMs + CONV_META_TTL_MS, meta: resolvedMeta });
    if (convMetaCache.size > 120) {
      convMetaCache.delete(convMetaCache.keys().next().value);
    }
    return resolvedMeta;
  } catch {
    return { projectId: '', environmentId: '', title: '' };
  }
}

function readDirIdentityStamp(dirPath) {
  try {
    const st = statSync(dirPath);
    return `${st.isDirectory() ? 'd' : 'f'}:${st.ino || 0}:${st.ctimeMs}:${st.mtimeMs}`;
  } catch {
    return '';
  }
}

function readGitHeadProbe(headPath) {
  if (!headPath) return { stamp: '', content: '' };
  try {
    const st = statSync(headPath);
    const stamp = `${st.mtimeMs}:${st.size}`;
    const content = st.size <= 256 ? readFileSync(headPath, 'utf8').trim() : '';
    return { stamp, content };
  } catch {
    return { stamp: '', content: '' };
  }
}

function hasDotGitInAncestors(dirPath) {
  let cur = resolve(dirPath);
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(cur, '.git'))) return true;
    const parent = dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
  }
  return false;
}

function hasNestedDotGitBeforeRoot(childPath, ancestorNormPath) {
  const cleanChild = uriToPath(childPath);
  if (!cleanChild || !ancestorNormPath) return false;
  let cur = resolve(cleanChild);
  let curNorm = normalizeKey(cur);
  if (isSameScopeKey(curNorm, ancestorNormPath)) return false;
  for (let i = 0; i < 64; i++) {
    if (isSameScopeKey(curNorm, ancestorNormPath)) return false;
    if (existsSync(join(cur, '.git'))) return true;
    const parent = dirname(cur);
    if (!parent || parent === cur) break;
    cur = parent;
    curNorm = normalizeKey(cur);
  }
  return false;
}

export async function resolveRepoInfo(workspacePath) {
  const candidate = uriToPath(workspacePath);
  if (!candidate) {
    return { workspacePath: '', repoRoot: '', mainRepoRoot: '', currentBranch: '' };
  }
  const dirStamp = readDirIdentityStamp(candidate);
  const cacheKey = normalizeKey(candidate);
  if (!dirStamp) {
    repoInfoCache.delete(cacheKey);
    return { workspacePath: candidate, repoRoot: '', mainRepoRoot: '', currentBranch: '' };
  }

  const nowMs = Date.now();
  const cached = storeLruGet(repoInfoCache, cacheKey);
  if (cached && cached.expiresAt > nowMs) {
    if (cached.info.repoRoot) {
      const headProbe = readGitHeadProbe(cached.gitHeadPath);
      const wtProbe = cached.worktreeDotGitPath
        ? readGitHeadProbe(cached.worktreeDotGitPath)
        : null;
      const wtOk =
        !cached.worktreeDotGitPath ||
        Boolean(
          wtProbe?.stamp &&
            wtProbe.stamp === cached.worktreeDotGitStamp &&
            wtProbe.content === cached.worktreeDotGitContent,
        );
      const noNestedGit = !hasNestedDotGitBeforeRoot(candidate, normalizeKey(cached.info.repoRoot));
      if (
        wtOk &&
        noNestedGit &&
        headProbe.stamp &&
        headProbe.stamp === cached.gitHeadStamp &&
        headProbe.content === cached.gitHeadContent
      ) {
        return { ...cached.info, workspacePath: candidate };
      }
    } else if (cached.dirStamp === dirStamp && !hasDotGitInAncestors(candidate)) {
      return { ...cached.info, workspacePath: candidate };
    }
    repoInfoCache.delete(cacheKey);
  }

  try {
    repoInfoGitSpawnCount += 1;
    const top = await runGit(['rev-parse', '--show-toplevel'], candidate);
    const repoRoot = normalize(top);
    let mainRepoRoot = repoRoot;
    let isStandardDotGitDir = false;
    try {
      isStandardDotGitDir = statSync(join(repoRoot, '.git')).isDirectory();
    } catch {
      isStandardDotGitDir = false;
    }
    if (!isStandardDotGitDir) {
      try {
        repoInfoGitSpawnCount += 1;
        const commonDir = await runGit(['rev-parse', '--git-common-dir'], repoRoot);
        if (commonDir) {
          const commonPath = resolve(repoRoot, commonDir);
          if (basename(commonPath).toLowerCase() === '.git') {
            mainRepoRoot = normalize(dirname(commonPath));
          }
        }
      } catch {
        mainRepoRoot = repoRoot;
      }
    }
    let currentBranch = 'HEAD';
    try {
      repoInfoGitSpawnCount += 1;
      currentBranch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], mainRepoRoot || repoRoot);
    } catch {
      // Empty repo without commits yet
    }
    const info = { workspacePath: candidate, repoRoot, mainRepoRoot, currentBranch };
    const gitHeadPath = join(mainRepoRoot || repoRoot, '.git', 'HEAD');
    const headProbe = readGitHeadProbe(gitHeadPath);
    const worktreeDotGitPath = repoRoot !== mainRepoRoot ? join(repoRoot, '.git') : '';
    const wtProbe = worktreeDotGitPath ? readGitHeadProbe(worktreeDotGitPath) : null;
    // Skip caching empty/detached HEAD so initial commit immediately reflects the real branch name
    if (headProbe.stamp && currentBranch && currentBranch !== 'HEAD') {
      storeLruSet(
        repoInfoCache,
        cacheKey,
        {
          expiresAt: Date.now() + REPO_INFO_TTL_MS,
          dirStamp,
          gitHeadPath,
          gitHeadStamp: headProbe.stamp,
          gitHeadContent: headProbe.content,
          worktreeDotGitPath,
          worktreeDotGitStamp: wtProbe?.stamp || '',
          worktreeDotGitContent: wtProbe?.content || '',
          info,
        },
        REPO_INFO_CACHE_MAX,
      );
    }
    return { ...info };
  } catch {
    const emptyInfo = { workspacePath: candidate, repoRoot: '', mainRepoRoot: '', currentBranch: '' };
    storeLruSet(
      repoInfoCache,
      cacheKey,
      {
        expiresAt: Date.now() + REPO_INFO_NEGATIVE_TTL_MS,
        dirStamp,
        gitHeadPath: '',
        gitHeadStamp: '',
        gitHeadContent: '',
        worktreeDotGitPath: '',
        worktreeDotGitStamp: '',
        worktreeDotGitContent: '',
        info: emptyInfo,
      },
      REPO_INFO_CACHE_MAX,
    );
    return { ...emptyInfo };
  }
}

function stripCoordinatorTitlePrefix(raw) {
  return String(raw || '').replace(/^(?:\[Coordinator\]\s*)+/i, '').trim();
}

export function resolveScopeDisplayNames({
  projectName = '',
  workspaceName = '',
  baseDir = '',
  fallbackLabel = '',
} = {}) {
  const cleanProjectName = String(projectName || '').trim();
  const cleanWorkspaceName = String(workspaceName || (baseDir ? basename(baseDir) : '')).trim();
  const cleanFallback = String(fallbackLabel || '').trim();
  const scopeTitle = cleanProjectName || cleanWorkspaceName || cleanFallback;
  return {
    projectName: cleanProjectName,
    workspaceName: cleanWorkspaceName,
    scopeTitle,
  };
}

export async function resolveProjectScope({
  workspacePath = '',
  conversationId = '',
  coordinatorId = '',
  projectId = '',
  reg = null,
} = {}) {
  const activeReg = reg || loadRegistry();
  const cleanConvArg = String(conversationId || '').trim();
  const cleanCoordArg = String(coordinatorId || '').trim();
  const convId = cleanConvArg || cleanCoordArg;
  const convCandidates = [...new Set([cleanConvArg, cleanCoordArg].filter(Boolean))];
  const cleanProjArg =
    projectId && projectId !== 'outside-of-project' ? String(projectId).trim() : '';
  const convMeta = convId
    ? await getConversationMetaCached(convId)
    : { projectId: '', environmentId: '', title: '' };

  let effectiveProjId = cleanProjArg || convMeta.projectId || '';
  let effectiveEnvId = convMeta.environmentId || '';
  const emptyInfo = { workspacePath: '', repoRoot: '', mainRepoRoot: '', currentBranch: '' };

  // a) Explicit workspacePath provided
  if (String(workspacePath || '').trim()) {
    let info = await resolveRepoInfo(workspacePath);
    let baseDir = info.mainRepoRoot || info.repoRoot || info.workspacePath;
    let scopeKey = baseDir ? normalizeKey(baseDir) : '';
    // If workspacePath points to a deleted worktree or missing nested path, fall back to registry mapping
    if (!info.mainRepoRoot && !info.repoRoot && info.workspacePath) {
      const inferredKey = inferScopeKeyFromRegistry(
        { workspacePath: info.workspacePath },
        activeReg,
      );
      if (inferredKey && !inferredKey.startsWith('project:') && !inferredKey.startsWith('conv:')) {
        scopeKey = normalizeScopeKeyForMatch(inferredKey);
        const inferredCoord = lookupCoordinatorForScope(activeReg, { scopeKey });
        const inferredThread = !inferredCoord
          ? Object.values(activeReg.threads || {}).find(
              (t) =>
                t?.workspaceKey &&
                isSameScopeKey(t.workspaceKey, scopeKey) &&
                (t.repoRoot || t.workspacePath),
            )
          : null;
        const fallbackDir =
          inferredCoord?.repoRoot ||
          inferredCoord?.workspacePath ||
          inferredThread?.repoRoot ||
          inferredThread?.workspacePath ||
          '';
        if (fallbackDir) {
          const fallbackInfo = await resolveRepoInfo(fallbackDir);
          info = {
            ...fallbackInfo,
            workspacePath: info.workspacePath,
          };
          baseDir = fallbackInfo.mainRepoRoot || fallbackInfo.repoRoot || fallbackDir;
        } else if (isFilesystemPathKey(inferredKey)) {
          baseDir = inferredKey;
        }
      }
    }
    if (baseDir) {
      if (!scopeKey) scopeKey = normalizeKey(baseDir);
      const existingCoord =
        activeReg.coordinators[scopeKey] ||
        lookupCoordinatorForScope(activeReg, { scopeKey, workspacePath: baseDir });
      const coordProjId =
        existingCoord?.projectId && existingCoord.projectId !== 'outside-of-project'
          ? String(existingCoord.projectId).trim()
          : '';
      const convOwnerScope = convId
        ? inferScopeKeyFromRegistry({ conversationId: convId }, activeReg)
        : '';
      const isForeignConv = Boolean(
        convOwnerScope && !isSameScopeKey(convOwnerScope, scopeKey),
      );
      // Explicit caller projectId wins (preserving fail-closed mismatch checks),
      // otherwise prefer registered workspace coordinator's projectId over an unrelated session's convMeta.projectId.
      const scopeProjId =
        cleanProjArg || coordProjId || (isForeignConv ? '' : convMeta.projectId || '');
      const scopeEnvId =
        existingCoord?.environmentId || (isForeignConv ? '' : effectiveEnvId || '');
      const resolvedProjName = scopeProjId ? await resolveProjectName(scopeProjId) : '';
      const display = resolveScopeDisplayNames({
        projectName: resolvedProjName,
        baseDir,
      });
      return {
        scopeKey,
        scopeKind: 'workspace',
        baseDir,
        projectId: scopeProjId,
        projectName: display.projectName,
        workspaceName: display.workspaceName,
        scopeTitle: display.scopeTitle,
        environmentId: scopeEnvId,
        label: display.scopeTitle,
        info,
      };
    }
  }

  // b) & c) Match an existing Worker Thread or Coordinator (conversationId first, then coordinatorId)
  for (const candConvId of convCandidates) {
    const matchedThread = Object.values(activeReg.threads).find((t) => t.conversationId === candConvId);
    if (matchedThread && matchedThread.workspaceKey) {
      const scopeKey = matchedThread.workspaceKey;
      const rawBase = matchedThread.repoRoot || matchedThread.workspacePath || '';
      const info = rawBase ? await resolveRepoInfo(rawBase) : emptyInfo;
      const baseDir = info.mainRepoRoot || info.repoRoot || rawBase;
      const scopeKind = baseDir
        ? 'workspace'
        : scopeKey.startsWith('project:')
          ? 'project'
          : 'conversation';
      const resolvedProjId =
        effectiveProjId ||
        (matchedThread.projectId && matchedThread.projectId !== 'outside-of-project'
          ? matchedThread.projectId
          : '') ||
        '';
      const resolvedEnvId = effectiveEnvId || matchedThread.environmentId || '';
      const coord = activeReg.coordinators[scopeKey];
      const resolvedProjName = resolvedProjId ? await resolveProjectName(resolvedProjId) : '';
      const fallbackLabel = coord?.title
        ? stripCoordinatorTitlePrefix(coord.title)
        : stripCoordinatorTitlePrefix(convMeta.title) || 'Project';
      const display = resolveScopeDisplayNames({
        projectName: resolvedProjName,
        baseDir,
        fallbackLabel,
      });
      return {
        scopeKey,
        scopeKind,
        baseDir,
        projectId: resolvedProjId,
        projectName: display.projectName,
        workspaceName: display.workspaceName,
        scopeTitle: display.scopeTitle,
        environmentId: resolvedEnvId,
        label: display.scopeTitle,
        info,
      };
    }

    // c) candConvId matches an existing Coordinator
    const matchedCoord = Object.values(activeReg.coordinators).find((c) => c.conversationId === candConvId);
    if (matchedCoord && matchedCoord.key) {
      const scopeKey = matchedCoord.key;
      const rawBase = matchedCoord.repoRoot || matchedCoord.workspacePath || '';
      const info = rawBase ? await resolveRepoInfo(rawBase) : emptyInfo;
      const baseDir = info.mainRepoRoot || info.repoRoot || rawBase;
      const scopeKind = baseDir
        ? 'workspace'
        : scopeKey.startsWith('project:')
          ? 'project'
          : 'conversation';
      const resolvedProjId =
        effectiveProjId ||
        (matchedCoord.projectId && matchedCoord.projectId !== 'outside-of-project'
          ? matchedCoord.projectId
          : '') ||
        '';
      const resolvedEnvId = effectiveEnvId || matchedCoord.environmentId || '';
      const resolvedProjName = resolvedProjId ? await resolveProjectName(resolvedProjId) : '';
      const fallbackLabel = matchedCoord.title
        ? stripCoordinatorTitlePrefix(matchedCoord.title)
        : stripCoordinatorTitlePrefix(convMeta.title) || 'Project';
      const display = resolveScopeDisplayNames({
        projectName: resolvedProjName,
        baseDir,
        fallbackLabel,
      });
      return {
        scopeKey,
        scopeKind,
        baseDir,
        projectId: resolvedProjId,
        projectName: display.projectName,
        workspaceName: display.workspaceName,
        scopeTitle: display.scopeTitle,
        environmentId: resolvedEnvId,
        label: display.scopeTitle,
        info,
      };
    }
  }

  // d) effectiveProjId is non-empty
  if (effectiveProjId) {
    const resolvedProjName = await resolveProjectName(effectiveProjId);
    const projCoord = Object.values(activeReg.coordinators).find(
      (c) => c.projectId === effectiveProjId,
    );
    if (projCoord && projCoord.key) {
      const scopeKey = projCoord.key;
      const rawBase = projCoord.repoRoot || projCoord.workspacePath || '';
      const info = rawBase ? await resolveRepoInfo(rawBase) : emptyInfo;
      const baseDir = info.mainRepoRoot || info.repoRoot || rawBase;
      const scopeKind = baseDir
        ? 'workspace'
        : scopeKey.startsWith('project:')
          ? 'project'
          : 'conversation';
      const resolvedEnvId = effectiveEnvId || projCoord.environmentId || '';
      const fallbackLabel = projCoord.title
        ? stripCoordinatorTitlePrefix(projCoord.title)
        : stripCoordinatorTitlePrefix(convMeta.title) || 'Project';
      const display = resolveScopeDisplayNames({
        projectName: resolvedProjName,
        baseDir,
        fallbackLabel,
      });
      return {
        scopeKey,
        scopeKind,
        baseDir,
        projectId: effectiveProjId,
        projectName: display.projectName,
        workspaceName: display.workspaceName,
        scopeTitle: display.scopeTitle,
        environmentId: resolvedEnvId,
        label: display.scopeTitle,
        info,
      };
    }

    const display = resolveScopeDisplayNames({
      projectName: resolvedProjName,
      fallbackLabel: stripCoordinatorTitlePrefix(convMeta.title) || 'Project',
    });
    return {
      scopeKey: `project:${effectiveProjId}`,
      scopeKind: 'project',
      baseDir: '',
      projectId: effectiveProjId,
      projectName: display.projectName,
      workspaceName: '',
      scopeTitle: display.scopeTitle,
      environmentId: effectiveEnvId,
      label: display.scopeTitle,
      info: emptyInfo,
    };
  }

  // e) Standalone conversation outside any project & without workspace
  if (convId) {
    const label = convMeta.title || 'Session';
    return {
      scopeKey: `conv:${convId}`,
      scopeKind: 'conversation',
      baseDir: '',
      projectId: '',
      projectName: '',
      workspaceName: '',
      scopeTitle: label,
      environmentId: effectiveEnvId,
      label,
      info: emptyInfo,
    };
  }

  // f) Unscoped (fail-closed)
  return {
    scopeKey: '',
    scopeKind: 'unscoped',
    baseDir: '',
    projectId: '',
    projectName: '',
    workspaceName: '',
    scopeTitle: '',
    environmentId: '',
    label: '',
    info: emptyInfo,
  };
}

function slugify(input) {
  const ascii = String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return ascii || 'task';
}

async function appendWorktreeExclude(worktreePath, patterns) {
  ensureGitExcludeSync(worktreePath, patterns);
  try {
    const excludeRel = await runGit(['rev-parse', '--git-path', 'info/exclude'], worktreePath);
    const excludePath = resolve(worktreePath, excludeRel);
    mkdirSync(dirname(excludePath), { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    const existingSet = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const linesToAdd = patterns.filter((p) => !existingSet.has(p));
    if (linesToAdd.length > 0) {
      const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
      writeFileSync(excludePath, `${existing}${prefix}${linesToAdd.join('\n')}\n`, 'utf8');
    }
  } catch {
    // Non-fatal if git info/exclude cannot be resolved
  }
}

function syncRulesIntoWorktree({ repoRoot, scopeKey = '', worktreePath, thread }) {
  if (!worktreePath || !existsSync(worktreePath)) return;
  const rulesDir = join(worktreePath, '.agents', 'rules');
  mkdirSync(rulesDir, { recursive: true });

  syncMemoryFilesToWorktree({
    repoRoot,
    scopeKey: scopeKey || thread?.workspaceKey || '',
    worktreePath,
  });

  if (thread) {
    const displayId = getThreadDisplayId(thread);
    const lang = detectPromptLanguage(thread.title, '');
    const brief =
      lang === 'zh'
        ? [
            `# 当前子线程上下文 (${displayId})`,
            '',
            `- **线程 ID**: \`${displayId}\``,
            `- **任务标题**: ${thread.title}`,
            `- **隔离 Worktree**: \`${worktreePath}\``,
            `- **分配的 Git 分支**: \`${thread.branch}\``,
            thread.coordinatorId ? `- **总控会话**: [Coordinator](conversation://${thread.coordinatorId})` : '',
            '',
            '## 严格隔离与语言规范',
            `1. 所有文件读取、编辑、写入及 Shell 命令都必须在 \`${worktreePath}\` 内执行。`,
            repoRoot ? `2. **禁止**修改主工作区（\`${repoRoot}\`）中的任何文件。` : '',
            `3. 请使用与任务指令相同的语言撰写分析与回复；如任务要求提交，请在分支 \`${thread.branch}\` 上干净提交，并在最终回复末尾以 \`### 线程总结\`（或 \`### Thread Summary\`）概括改动、提交记录及可复用的架构约定。`,
            '',
          ]
            .filter(Boolean)
            .join('\n')
        : [
            `# Active Worker Thread Context (${displayId})`,
            '',
            `- **Thread ID**: \`${displayId}\``,
            `- **Title**: ${thread.title}`,
            `- **Isolated Worktree**: \`${worktreePath}\``,
            `- **Assigned Git Branch**: \`${thread.branch}\``,
            thread.coordinatorId ? `- **Coordinator Session**: [Coordinator](conversation://${thread.coordinatorId})` : '',
            '',
            '## Strict Isolation Rules',
            `1. Perform **all** file reads, edits, writes, and shell commands inside \`${worktreePath}\`.`,
            repoRoot ? `2. **Never** modify files in the main workspace (\`${repoRoot}\`).` : '',
            `3. Write your analysis and final summary in the same language as the task instructions. Keep work committed cleanly on branch \`${thread.branch}\` when requested, and conclude your final reply with a concise summary (\`### Thread Summary\`) of changes, commits, and any new shared architectural notes.`,
            '',
          ]
            .filter(Boolean)
            .join('\n');
    writeFileSync(join(rulesDir, 'worker-thread-context.md'), brief, 'utf8');
  }
}

async function localBranchExists(repoRoot, branchName) {
  if (!repoRoot || !branchName) return false;
  try {
    await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

async function createGitWorktree({ repoRoot, threadId, localId = '', title, requestedBranch, baseRef }) {
  const cleanLocalId = parseUnifiedLocalThreadSeq(localId) > 0
    ? formatLocalThreadId(parseUnifiedLocalThreadSeq(localId))
    : '';
  const idPrefix = cleanLocalId || threadId;
  const baseSlug = `${idPrefix}-${slugify(title)}`;
  const startRef = baseRef || 'HEAD';
  const worktreesRoot = join(dirname(repoRoot), '.worktrees', basename(repoRoot));
  mkdirSync(worktreesRoot, { recursive: true });

  let slug = baseSlug;
  let branch = requestedBranch || `thread/${slug}`;
  let worktreePath = join(worktreesRoot, slug);

  // Anti-collision guard for auto-generated branches/directories (e.g., after local registry reset)
  if (!requestedBranch) {
    let conflict = existsSync(worktreePath) || (await localBranchExists(repoRoot, branch));
    if (conflict) {
      let resolved = false;
      for (let attempt = 2; attempt <= 50; attempt++) {
        const candSlug = `${baseSlug}-${attempt}`;
        const candBranch = `thread/${candSlug}`;
        const candPath = join(worktreesRoot, candSlug);
        if (!existsSync(candPath) && !(await localBranchExists(repoRoot, candBranch))) {
          slug = candSlug;
          branch = candBranch;
          worktreePath = candPath;
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        const suffix = randomUUID().slice(0, 6);
        slug = `${baseSlug}-${suffix}`;
        branch = `thread/${slug}`;
        worktreePath = join(worktreesRoot, slug);
      }
    }
  }

  if (!existsSync(worktreePath)) {
    const branchExists = await localBranchExists(repoRoot, branch);

    if (branchExists) {
      await runGit(['worktree', 'add', worktreePath, branch], repoRoot, WORKTREE_ADD_TIMEOUT_MS);
    } else {
      await runGit(
        ['worktree', 'add', '-b', branch, worktreePath, startRef],
        repoRoot,
        WORKTREE_ADD_TIMEOUT_MS,
      );
    }
  }

  await appendWorktreeExclude(worktreePath, WORKTREE_MEMORY_EXCLUDE_PATTERNS);

  return { worktreePath, branch, baseRef: startRef };
}

function resolveThreadCoordDefaultBranch(t, reg) {
  if (!t || !reg) return '';
  const coord =
    (t.workspaceKey && reg.coordinators?.[t.workspaceKey]) ||
    (t.coordinatorId &&
      Object.values(reg.coordinators || {}).find((c) => c.conversationId === t.coordinatorId)) ||
    null;
  const def = String(coord?.defaultBranch || '').trim();
  return def && def !== 'HEAD' ? def : '';
}

async function resolveBaseBranchRef(
  gitCwd,
  { preferredRef = '', defaultBranch = '', excludeBranch = '' } = {},
) {
  if (!gitCwd || !existsSync(gitCwd)) return '';
  const candidates = [];
  const pushCandidate = (ref, allowIfExcluded = false) => {
    const clean = String(ref || '').trim();
    if (!clean) return;
    if (!allowIfExcluded && excludeBranch && clean === excludeBranch) return;
    if (!candidates.includes(clean)) candidates.push(clean);
  };

  const pref = String(preferredRef || '').trim();
  if (pref && pref !== 'HEAD') pushCandidate(pref, true);

  const defBranch = String(defaultBranch || '').trim();
  if (defBranch && defBranch !== 'HEAD') pushCandidate(defBranch, false);

  pushCandidate('main', false);
  pushCandidate('master', false);
  pushCandidate('HEAD', true);

  if (candidates.length === 0) return '';
  // Fast check on highest-priority candidate first (usually matches in 1 git call)
  const firstRes = await runGitResult(
    ['rev-parse', '--verify', '--quiet', `${candidates[0]}^{commit}`],
    gitCwd,
    5000,
  );
  if (firstRes.ok) return candidates[0];
  if (candidates.length === 1) return '';

  // Probe remaining fallback candidates in parallel while preserving deterministic priority order
  const rest = candidates.slice(1);
  const restResults = await Promise.all(
    rest.map((ref) =>
      runGitResult(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], gitCwd, 5000),
    ),
  );
  for (let i = 0; i < rest.length; i++) {
    if (restResults[i]?.ok) return rest[i];
  }
  return '';
}

async function checkCherryPickMerged(repoRoot, baseRef, targetRef) {
  const cherryRes = await runGitResult(['cherry', baseRef, targetRef], repoRoot, 8000);
  if (!cherryRes.ok) {
    return { ok: false, cherryMerged: false, error: cherryRes.error || '' };
  }
  const lines = cherryRes.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const cherryMerged = lines.length > 0 && lines.every((l) => l.startsWith('-'));
  return { ok: true, cherryMerged, error: '' };
}

export async function inspectWorktreeGit(worktreePath, baseRefOrOpts = '', extraOpts = {}) {
  if (!worktreePath || !existsSync(worktreePath)) return null;
  const opts =
    baseRefOrOpts && typeof baseRefOrOpts === 'object'
      ? { ...baseRefOrOpts, ...extraOpts }
      : { baseRef: baseRefOrOpts || '', ...extraOpts };
  const preferredRef = String(opts.baseRef || '').trim();
  const defaultBranch = String(opts.defaultBranch || '').trim();
  const passedRepoRoot = String(opts.repoRoot || '').trim();
  const initialRepoCwd = passedRepoRoot && existsSync(passedRepoRoot) ? passedRepoRoot : '';

  try {
    const [porcelainRes, logRes, branchRes, headShaRes, commonRes] = await Promise.all([
      runGitResult(['--no-optional-locks', 'status', '--porcelain', '-uall'], worktreePath, 5000),
      runGitResult(['log', '-1', '--pretty=format:%h %s'], worktreePath, 5000),
      runGitResult(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath, 5000),
      runGitResult(['rev-parse', 'HEAD'], worktreePath, 5000),
      initialRepoCwd
        ? Promise.resolve(null)
        : runGitResult(['rev-parse', '--git-common-dir'], worktreePath, 5000),
    ]);

    const porcelain = porcelainRes.ok ? porcelainRes.stdout : '';
    const dirtyLines = porcelain
      ? porcelain
          .split(/\r?\n/)
          .filter((l) => l.trim() && !INJECTED_RULE_UNTRACKED_RE.test(l))
      : [];
    const lastCommit = logRes.ok ? logRes.stdout.trim() : '';
    const branch = branchRes.ok ? branchRes.stdout.trim() : '';
    const wtHeadSha = headShaRes.ok ? headShaRes.stdout.trim() : '';

    let repoCwd = initialRepoCwd;
    if (!repoCwd && commonRes?.ok && commonRes.stdout.trim()) {
      const commonPath = resolve(worktreePath, commonRes.stdout.trim());
      if (basename(commonPath).toLowerCase() === '.git') {
        repoCwd = normalize(dirname(commonPath));
      }
    }
    const baseGitCwd = repoCwd || worktreePath;

    let aheadCount = 0;
    let merged = true;
    let mergeMethod = '';
    const countRef = await resolveBaseBranchRef(baseGitCwd, {
      preferredRef,
      defaultBranch,
      excludeBranch: branch && branch !== 'HEAD' ? branch : '',
    });

    if (countRef && wtHeadSha) {
      const cntRes = await runGitResult(
        ['rev-list', '--count', `${countRef}..${wtHeadSha}`],
        baseGitCwd,
        5000,
      );
      aheadCount = cntRes.ok ? Number(cntRes.stdout.trim()) || 0 : 0;
      if (aheadCount > 0) {
        const targetRef = branch && branch !== 'HEAD' ? `refs/heads/${branch}` : wtHeadSha;
        const cherryCheck = await checkCherryPickMerged(baseGitCwd, countRef, targetRef);
        if (cherryCheck.ok && cherryCheck.cherryMerged) {
          merged = true;
          mergeMethod = 'cherry-pick';
        } else {
          merged = false;
        }
      } else {
        merged = true;
      }
    } else if (!countRef) {
      merged = false;
    }

    return {
      exists: true,
      branch,
      dirtyCount: dirtyLines.length,
      aheadCount,
      merged,
      mergeMethod,
      lastCommit,
    };
  } catch {
    return {
      exists: false,
      branch: '',
      dirtyCount: 0,
      aheadCount: 0,
      merged: false,
      mergeMethod: '',
      lastCommit: '',
    };
  }
}

function hasActiveSyncClaimForThread(threadId) {
  const tid = String(threadId || '').trim();
  if (!tid) return false;
  const claimsDir = join(getStateDir(), 'sync-claims');
  if (!existsSync(claimsDir)) return false;
  try {
    const prefix = `${tid}-`;
    return readdirSync(claimsDir).some((name) => name.startsWith(prefix) && name.endsWith('.claim'));
  } catch {
    return false;
  }
}

function isHistoricalIdleThreadForBaseline(t, nowMs = Date.now()) {
  if (!t || t.archived) return false;
  if (t.runState === 'RUN_STATE_RUNNING' || Boolean(t.hasPendingBgTask)) return false;
  if (hasActiveSyncClaimForThread(t.threadId)) return false;
  const completedMs = Date.parse(t.lastCompletedAt || t.updatedAt || t.createdAt || '');
  if (!Number.isFinite(completedMs)) return false;
  // Preserve recently completed threads (within grace window, e.g. 8s poll window or Stop-hook retry)
  return nowMs - completedMs >= STALE_IDLE_REBIND_GRACE_MS;
}

function snapshotThreadCompletionsForScope(reg, scopeKey, { prevCoordId = '', nowMs = Date.now() } = {}) {
  const map = new Map();
  if (!scopeKey || !reg?.threads) return map;
  for (const t of Object.values(reg.threads)) {
    if (!t || t.archived) continue;
    const inScope =
      isSameScopeKey(t.workspaceKey, scopeKey) ||
      (!t.workspaceKey && prevCoordId && t.coordinatorId === prevCoordId);
    if (!inScope) continue;
    if (!isHistoricalIdleThreadForBaseline(t, nowMs)) continue;
    try {
      map.set(t.threadId, extractThreadCompletion(t.conversationId));
    } catch {
      // Non-fatal if transcript is absent or unreadable
    }
  }
  return map;
}

function assertValidConversationIdFormat(rawId, label = 'conversationId') {
  const cid = String(rawId || '').trim();
  if (!cid) {
    throw new Error(`\`${label}\` is required.`);
  }
  if (cid.length > 200 || /[\r\n\t\s]/.test(cid)) {
    throw new Error(`Invalid \`${label}\` format.`);
  }
  return cid;
}

async function validateRebindTargetWithLs({
  targetConvId,
  expectedProjectId = '',
}) {
  const ep = resolveLsEndpoint();
  if (!ep) {
    return { checked: false, meta: { projectId: '', environmentId: '', title: '' } };
  }
  try {
    const res = await getConversation(targetConvId);
    const conv = res?.conversation || res;
    if (!conv || typeof conv !== 'object' || !conv.id) {
      throw new Error(`Target conversation "${targetConvId}" was not found.`);
    }
    if (conv?.annotations?.archived === true) {
      throw new Error(
        `Cannot bind archived conversation "${targetConvId}" as the Project Coordinator.`,
      );
    }
    const tags = Array.isArray(conv?.annotations?.tags) ? conv.annotations.tags : [];
    if (tags.includes('project-thread')) {
      throw new Error(
        `Cannot bind Worker Thread conversation "${targetConvId}" as the Project Coordinator.`,
      );
    }
    const rawProjId =
      conv?.metadata?.projectId || conv?.metadata?.project_id || conv?.projectId || '';
    const targetProjId =
      rawProjId && rawProjId !== 'outside-of-project' ? String(rawProjId).trim() : '';
    const cleanExpectedProj =
      expectedProjectId && expectedProjectId !== 'outside-of-project'
        ? String(expectedProjectId).trim()
        : '';
    if (cleanExpectedProj && targetProjId && targetProjId !== cleanExpectedProj) {
      throw new Error(
        `Target conversation "${targetConvId}" belongs to a different project (${targetProjId}), expected "${cleanExpectedProj}".`,
      );
    }
    const rawEnvId =
      conv?.metadata?.environmentId || conv?.metadata?.environment_id || conv?.environmentId || '';
    const title = String(
      conv?.annotations?.title || conv?.title || conv?.state?.summary || '',
    ).trim();
    return {
      checked: true,
      meta: {
        projectId: targetProjId,
        environmentId: rawEnvId ? String(rawEnvId).trim() : '',
        title,
      },
    };
  } catch (err) {
    const msg = String(err?.message || '');
    const isDeterministicValidation =
      /Cannot bind|belongs to a different project|was not found|HTTP 40[0134]|not.?found|invalid.?argument|does not exist/i.test(
        msg,
      );
    if (isDeterministicValidation) {
      if (/Cannot bind|belongs to a different project|was not found/i.test(msg)) {
        throw err;
      }
      throw new Error(`Target conversation "${targetConvId}" does not exist or is inaccessible (${msg}).`);
    }
    // Transient network / LS offline / 5xx -> fall back to cached metadata without blocking offline workflows
    const fallbackMeta = await getConversationMetaCached(targetConvId);
    return { checked: false, meta: fallbackMeta };
  }
}

function assertEligibleCoordinatorConversation(reg, targetConvId, targetScopeKey = '') {
  const cid = String(targetConvId || '').trim();
  if (!cid) return;
  const workerMatch = Object.values(reg?.threads || {}).find(
    (t) => t && t.conversationId === cid,
  );
  if (workerMatch) {
    throw new Error(
      `Cannot bind Worker Thread "${workerMatch.threadId}" (${cid}) as the Project Coordinator.`,
    );
  }
  const otherCoord = Object.values(reg?.coordinators || {}).find(
    (c) =>
      c &&
      c.conversationId === cid &&
      (!targetScopeKey || !isSameScopeKey(c.key, targetScopeKey)),
  );
  if (otherCoord) {
    throw new Error(
      `Conversation "${cid}" is already bound as the Coordinator for another project (${otherCoord.key}).`,
    );
  }
}

function applyCoordinatorRebindInRegistry(
  freshReg,
  {
    scopeKey,
    targetCoordId = '',
    projectId = '',
    projectName = '',
    environmentId = '',
    workspacePath = '',
    repoRoot = '',
    defaultBranch = '',
    groupId = '',
    title = '',
    memoryPath = '',
    now = new Date().toISOString(),
    migrateActiveThreads = true,
    allowReactivateRetired = true,
    precomputedCompletions = new Map(),
    fallbackExisting = null,
  },
) {
  const freshExisting = freshReg.coordinators[scopeKey] || fallbackExisting || null;
  const prevCoordId = String(freshExisting?.conversationId || '').trim();
  const nextCoordId = String(targetCoordId || prevCoordId || '').trim();
  const nowMs = Date.parse(now) || Date.now();

  if (nextCoordId) {
    assertEligibleCoordinatorConversation(freshReg, nextCoordId, scopeKey);
    if (!allowReactivateRetired) {
      const retiredOwner = findRetiredCoordinatorOwner(freshReg, nextCoordId);
      if (retiredOwner) {
        throw new Error(
          `Coordinator session "${nextCoordId}" has been retired for scope "${retiredOwner.key}". Active Coordinator is now "${retiredOwner.conversationId}" (conversation://${retiredOwner.conversationId}). Use Switch Coordinator to explicitly rebind.`,
        );
      }
    }
  }

  const isSameConv = Boolean(freshExisting && (!nextCoordId || nextCoordId === prevCoordId));
  const switchedConv = Boolean(nextCoordId && prevCoordId && nextCoordId !== prevCoordId);

  const prevRebindSeq = Number(freshExisting?.rebindSeq) || 0;
  const nextRebindSeq = switchedConv || (!freshExisting && nextCoordId)
    ? prevRebindSeq + 1
    : prevRebindSeq;

  const retiredBase = Array.isArray(freshExisting?.retiredCoordinatorIds)
    ? freshExisting.retiredCoordinatorIds
    : [];
  const nextRetiredIds = normalizeRetiredCoordinatorIds(
    switchedConv ? [...retiredBase, prevCoordId] : retiredBase,
    nextCoordId,
  );

  const nextRetiredNotified =
    freshExisting?.retiredNotified &&
    typeof freshExisting.retiredNotified === 'object' &&
    !Array.isArray(freshExisting.retiredNotified)
      ? { ...freshExisting.retiredNotified }
      : {};
  if (nextCoordId) delete nextRetiredNotified[nextCoordId];
  if (switchedConv && prevCoordId) delete nextRetiredNotified[prevCoordId];

  // Ensure nextCoordId and newly retired prevCoordId are not duplicated in other scopes' retired lists
  for (const [otherKey, otherCoord] of Object.entries(freshReg.coordinators || {})) {
    if (!otherCoord || isSameScopeKey(otherKey, scopeKey)) continue;
    if (Array.isArray(otherCoord.retiredCoordinatorIds)) {
      const filtered = otherCoord.retiredCoordinatorIds.filter(
        (id) => id !== nextCoordId && (!switchedConv || id !== prevCoordId),
      );
      if (filtered.length !== otherCoord.retiredCoordinatorIds.length) {
        if (filtered.length) otherCoord.retiredCoordinatorIds = filtered;
        else delete otherCoord.retiredCoordinatorIds;
      }
    }
  }

  const nextCoord = {
    ...(isSameConv && freshExisting?.directiveVersion
      ? { directiveVersion: freshExisting.directiveVersion }
      : {}),
    ...(isSameConv && freshExisting?.lastStepCount
      ? { lastStepCount: freshExisting.lastStepCount }
      : {}),
    key: scopeKey,
    conversationId: nextCoordId,
    projectId: projectId || freshExisting?.projectId || '',
    projectName: projectName || freshExisting?.projectName || '',
    environmentId: environmentId || freshExisting?.environmentId || '',
    workspacePath: workspacePath || freshExisting?.workspacePath || '',
    repoRoot: repoRoot || freshExisting?.repoRoot || '',
    defaultBranch: defaultBranch || freshExisting?.defaultBranch || 'HEAD',
    groupId: freshExisting?.groupId || groupId || `proj-grp-${randomUUID().slice(0, 8)}`,
    title: title || freshExisting?.title || '[Coordinator] Project Hub',
    memoryPath: memoryPath || freshExisting?.memoryPath || '',
    ...(nextRetiredIds.length ? { retiredCoordinatorIds: nextRetiredIds } : {}),
    ...(Object.keys(nextRetiredNotified).length ? { retiredNotified: nextRetiredNotified } : {}),
    ...(nextRebindSeq > 0 ? { rebindSeq: nextRebindSeq } : {}),
    ...(switchedConv
      ? { reboundAt: now }
      : freshExisting?.reboundAt
        ? { reboundAt: freshExisting.reboundAt }
        : {}),
    createdAt: freshExisting?.createdAt || now,
    updatedAt: now,
  };
  freshReg.coordinators[scopeKey] = nextCoord;

  const migratedThreadIds = [];
  const suppressedAvalancheThreadIds = [];
  const migratedWorktreeThreads = [];

  if (migrateActiveThreads && nextCoordId) {
    for (const t of Object.values(freshReg.threads || {})) {
      if (!t || t.archived) continue;
      const inScope =
        isSameScopeKey(t.workspaceKey, scopeKey) ||
        (!t.workspaceKey && prevCoordId && t.coordinatorId === prevCoordId);
      if (!inScope) continue;
      if (t.coordinatorId === nextCoordId) continue;

      const preComp = precomputedCompletions.get(t.threadId) || null;
      const isActivelyWorking =
        t.runState === 'RUN_STATE_RUNNING' ||
        Boolean(t.hasPendingBgTask) ||
        Boolean(preComp?.waitingOnBackgroundTask);
      const isStaleHistoricalIdle =
        !isActivelyWorking && isHistoricalIdleThreadForBaseline(t, nowMs);

      t.coordinatorId = nextCoordId;
      t.coordinatorRebindSeq = Math.max(nextRebindSeq, (Number(t.coordinatorRebindSeq) || 0) + 1);
      t.coordinatorReboundAt = now;
      t.updatedAt = now;
      migratedThreadIds.push(t.threadId);
      if (t.worktreePath) {
        migratedWorktreeThreads.push({ ...t });
      }

      // Independent baseline anti-avalanche (P0-1 invariant):
      // NEVER mutate `lastSyncedStepIndex`, `notifiedCoordinatorAt`, or `pushedToCoordinatorAt` here.
      // Only record independent `reboundBaseline*` fields for genuinely stale historical IDLE threads
      // (older than grace window and with no active sync claim), so recent/pending deliveries are never dropped.
      if (isStaleHistoricalIdle) {
        seenRunningThreadIds.delete(t.threadId);
        t.reboundBaselineAt = now;
        if (preComp && Number.isInteger(preComp.stepIndex) && preComp.stepIndex >= 0) {
          t.reboundBaselineStepIndex = Math.max(
            Number.isInteger(t.reboundBaselineStepIndex) ? t.reboundBaselineStepIndex : -1,
            preComp.stepIndex,
          );
        }
        suppressedAvalancheThreadIds.push(t.threadId);
      }
    }

    // Keep pending explicit decisions in the same project aligned to the new Coordinator
    for (const d of Object.values(freshReg.decisions || {})) {
      if (!d || d.status !== 'pending' || !isSameScopeKey(d.workspaceKey, scopeKey)) continue;
      if (d.coordinatorId !== nextCoordId) {
        d.coordinatorId = nextCoordId;
        d.updatedAt = now;
      }
    }

    // Keep per-project watchdog state aligned to the new active Coordinator
    const normWdScope = normalizeScopeKeyForMatch(scopeKey);
    const wdScope =
      (normWdScope && freshReg.watchdogState?.[normWdScope]) ||
      freshReg.watchdogState?.[scopeKey] ||
      null;
    if (wdScope && typeof wdScope === 'object') {
      wdScope.coordinatorId = nextCoordId;
      wdScope.updatedAt = now;
      for (const entry of Object.values(wdScope.threads || {})) {
        if (entry?.pendingDeliveryPayload && typeof entry.pendingDeliveryPayload === 'object') {
          entry.pendingDeliveryPayload.coordinatorId = nextCoordId;
        }
      }
    }
  }

  return {
    coordRecord: nextCoord,
    previousCoordinatorId: prevCoordId,
    previousCoordinatorTitle: String(freshExisting?.title || '').trim(),
    isSameConv,
    switchedConv,
    migratedThreadIds,
    suppressedAvalancheThreadIds,
    migratedWorktreeThreads,
  };
}

async function syncCoordinatorConversationAnnotations({
  newCoordId = '',
  coordTitle = '',
  groupId = '',
  previousCoordinatorId = '',
  previousCoordinatorTitle = '',
  projectLabel = '',
}) {
  if (newCoordId) {
    try {
      await updateConversation(newCoordId, {
        title: coordTitle,
        pinned: true,
        tags: ['project-coordinator', `group:${groupId}`],
        conversationGroupId: groupId,
      });
    } catch {
      // Non-fatal if conversation metadata update is unavailable
    }
  }
  if (previousCoordinatorId && previousCoordinatorId !== newCoordId) {
    const baseName =
      stripCoordinatorTitlePrefix(previousCoordinatorTitle) ||
      stripCoordinatorTitlePrefix(projectLabel) ||
      'Project Hub';
    const retiredTitle = `[Retired Coordinator] ${baseName}`;
    try {
      await updateConversation(previousCoordinatorId, {
        title: retiredTitle,
        pinned: false,
        tags: ['project-coordinator-retired', `group:${groupId}`],
        conversationGroupId: groupId,
      });
    } catch {
      // Non-fatal if demoting old conversation metadata is unavailable
    }
  }
}

export async function initCoordinator({
  workspacePath = '',
  conversationId = '',
  coordinatorId = '',
  projectId = '',
  title = '',
  injectMergeConventions = true,
} = {}) {
  const reg = loadRegistry();
  let resolvedConvId = String(conversationId || coordinatorId || '').trim();
  if (!resolvedConvId) {
    try {
      const listed = await listConversations({});
      const convs = Array.isArray(listed?.conversations) ? listed.conversations : [];
      const knownWorkerIds = new Set(
        Object.values(reg.threads || {})
          .map((t) => t?.conversationId)
          .filter(Boolean),
      );
      const running = convs.filter(
        (c) =>
          c?.id &&
          !knownWorkerIds.has(c.id) &&
          c?.state?.runState === 'RUN_STATE_RUNNING',
      );
      if (running.length === 1) {
        resolvedConvId = String(running[0].id).trim();
      }
    } catch {
      // Non-fatal if ListConversations is unavailable
    }
  }
  if (resolvedConvId) {
    assertValidConversationIdFormat(resolvedConvId, 'conversationId');
    const workerMatch = Object.values(reg.threads || {}).find(
      (t) => t && t.conversationId === resolvedConvId,
    );
    if (workerMatch) {
      throw new Error(
        `Cannot bind Worker Thread "${workerMatch.threadId}" (${resolvedConvId}) as the Project Coordinator.`,
      );
    }
  }

  const scope = await resolveProjectScope({
    workspacePath,
    conversationId: resolvedConvId,
    projectId,
    reg,
  });
  if (!scope.scopeKey) {
    throw new Error('Provide workspacePath or conversationId to initialize a Project Coordinator.');
  }

  const key = scope.scopeKey;
  if (resolvedConvId) {
    assertEligibleCoordinatorConversation(reg, resolvedConvId, key);
    const retiredOwner = findRetiredCoordinatorOwner(reg, resolvedConvId);
    if (retiredOwner) {
      throw new Error(
        `Coordinator session "${resolvedConvId}" has been retired for scope "${retiredOwner.key}". Active Coordinator is now "${retiredOwner.conversationId}" (conversation://${retiredOwner.conversationId}). Use Switch Coordinator to explicitly rebind.`,
      );
    }
  }
  const existing = reg.coordinators[key];
  const groupId = existing?.groupId || `proj-grp-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const repoRoot = scope.info.mainRepoRoot || scope.info.repoRoot || '';
  const rawLabel = scope.label || (scope.baseDir ? basename(scope.baseDir) : 'Project Hub');
  const projectLabel =
    String(rawLabel).replace(/^(?:\[Coordinator\]\s*)+/i, '').trim() || 'Project Hub';
  const cleanCustomTitle = String(title || '').replace(/^(?:\[Coordinator\]\s*)+/i, '').trim();
  const coordTitle = cleanCustomTitle
    ? `[Coordinator] ${cleanCustomTitle}`
    : `[Coordinator] ${projectLabel}`;

  const memoryPath = ensureProjectMemoryFile(scope.baseDir, projectLabel, key, {
    injectMergeConventions: injectMergeConventions !== false,
  });
  if (memoryPath) {
    const broadcastRepoRoot = repoRoot || scope.baseDir;
    for (const t of Object.values(reg.threads || {})) {
      if (!t.archived && t.workspaceKey === key && t.worktreePath) {
        syncRulesIntoWorktree({
          repoRoot: broadcastRepoRoot,
          scopeKey: key,
          worktreePath: t.worktreePath,
          thread: t,
        });
      }
    }
  }

  const resolvedProjId =
    scope.projectId ||
    (existing?.projectId && existing.projectId !== 'outside-of-project' ? existing.projectId : '') ||
    '';
  const resolvedProjName = resolvedProjId
    ? resolvedProjId === scope.projectId
      ? scope.projectName || ''
      : await resolveProjectName(resolvedProjId)
    : '';
  const resolvedEnvId = scope.environmentId || existing?.environmentId || '';
  const willSwitchOrBind = Boolean(
    resolvedConvId && (!existing || existing.conversationId !== resolvedConvId),
  );
  const precomputedCompletions = willSwitchOrBind
    ? snapshotThreadCompletionsForScope(reg, key, {
        prevCoordId: existing?.conversationId || '',
      })
    : new Map();

  const rebindOut = mutateRegistry((freshReg) =>
    applyCoordinatorRebindInRegistry(freshReg, {
      scopeKey: key,
      targetCoordId: resolvedConvId,
      projectId: resolvedProjId,
      projectName: resolvedProjName,
      environmentId: resolvedEnvId,
      workspacePath: scope.info.workspacePath || scope.baseDir || existing?.workspacePath || '',
      repoRoot: repoRoot || existing?.repoRoot || '',
      defaultBranch: scope.info.currentBranch || existing?.defaultBranch || 'HEAD',
      groupId,
      title: coordTitle,
      memoryPath,
      now,
      migrateActiveThreads: true,
      allowReactivateRetired: false,
      precomputedCompletions,
      fallbackExisting: existing,
    }),
  );

  // Update conversation titles/pins ONLY AFTER atomic lock validation and persistence succeed
  await syncCoordinatorConversationAnnotations({
    newCoordId: resolvedConvId,
    coordTitle,
    groupId: rebindOut.coordRecord.groupId || groupId,
    previousCoordinatorId: rebindOut.switchedConv ? rebindOut.previousCoordinatorId : '',
    previousCoordinatorTitle: rebindOut.previousCoordinatorTitle,
    projectLabel,
  });

  if (rebindOut.migratedWorktreeThreads.length > 0) {
    const broadcastRepoRoot = rebindOut.coordRecord.repoRoot || scope.baseDir || '';
    for (const t of rebindOut.migratedWorktreeThreads) {
      try {
        syncRulesIntoWorktree({
          repoRoot: broadcastRepoRoot,
          scopeKey: key,
          worktreePath: t.worktreePath,
          thread: t,
        });
      } catch {
        // Non-fatal if worktree directory is temporarily inaccessible
      }
    }
  }

  return rebindOut.coordRecord;
}

export async function rebindCoordinator({
  workspacePath = '',
  workspaceKey = '',
  projectId = '',
  coordinatorId = '',
  conversationId = '',
  newCoordinatorId = '',
  title = '',
  migrateActiveThreads = true,
} = {}) {
  const reg = loadRegistry();
  const targetNewCoordId = assertValidConversationIdFormat(
    newCoordinatorId || conversationId || '',
    'newCoordinatorId',
  );

  const explicitOldCoordId = String(coordinatorId || '').trim();
  const explicitScopeKey = String(workspaceKey || '').trim();
  const cleanProjId =
    projectId && projectId !== 'outside-of-project' ? String(projectId).trim() : '';

  // Fail fast if targetNewCoordId is a registered Worker Thread
  const workerMatch = Object.values(reg.threads || {}).find(
    (t) => t && t.conversationId === targetNewCoordId,
  );
  if (workerMatch) {
    throw new Error(
      `Cannot bind Worker Thread "${workerMatch.threadId}" (${targetNewCoordId}) as the Project Coordinator.`,
    );
  }

  // Resolve the current project scope stably (preserving workspace-less `conv:` keys)
  let existing = null;
  let key = '';
  let scope = null;

  if (explicitScopeKey) {
    const normExplicit = normalizeScopeKeyForMatch(explicitScopeKey);
    existing = lookupCoordinatorForScope(reg, {
      scopeKey: normExplicit,
      workspacePath,
      projectId: cleanProjId,
      conversationId: explicitOldCoordId,
    });
    key = existing?.key || normExplicit;
  }

  if (!key && explicitOldCoordId && !workspacePath) {
    const byOldCoord = Object.values(reg.coordinators || {}).find(
      (c) => c && c.conversationId === explicitOldCoordId,
    );
    if (byOldCoord?.key) {
      existing = byOldCoord;
      key = byOldCoord.key;
    }
  }

  if (!key) {
    scope = await resolveProjectScope({
      workspacePath,
      projectId: cleanProjId,
      coordinatorId: explicitOldCoordId,
      conversationId: explicitOldCoordId || targetNewCoordId,
      reg,
    });
    key = scope.scopeKey || '';
    if (key) {
      existing = reg.coordinators[key] || lookupCoordinatorForScope(reg, {
        scopeKey: key,
        workspacePath,
        projectId: cleanProjId || scope.projectId,
        conversationId: explicitOldCoordId,
      });
      if (existing?.key) key = existing.key;
    }
  }

  if (!key) {
    throw new Error('Unable to resolve project scope; provide workspacePath, workspaceKey, projectId, or coordinatorId.');
  }

  assertEligibleCoordinatorConversation(reg, targetNewCoordId, key);

  if (!scope) {
    const rawWs = workspacePath || existing?.repoRoot || existing?.workspacePath || '';
    scope = await resolveProjectScope({
      workspacePath: rawWs,
      projectId: cleanProjId || existing?.projectId || '',
      coordinatorId: existing?.conversationId || explicitOldCoordId,
      conversationId: existing?.conversationId || explicitOldCoordId || targetNewCoordId,
      reg,
    });
  }

  const expectedProjectId =
    cleanProjId ||
    (existing?.projectId && existing.projectId !== 'outside-of-project' ? existing.projectId : '') ||
    (scope?.projectId && scope.projectId !== 'outside-of-project' ? scope.projectId : '') ||
    '';
  const targetValidation = await validateRebindTargetWithLs({
    targetConvId: targetNewCoordId,
    expectedProjectId,
  });
  const newMeta = targetValidation.meta;

  const now = new Date().toISOString();
  const baseDir = scope?.baseDir || existing?.repoRoot || existing?.workspacePath || '';
  const repoRoot =
    scope?.info?.mainRepoRoot || scope?.info?.repoRoot || existing?.repoRoot || '';
  const groupId = existing?.groupId || `proj-grp-${randomUUID().slice(0, 8)}`;

  const resolvedProjId =
    expectedProjectId ||
    (newMeta.projectId && newMeta.projectId !== 'outside-of-project' ? newMeta.projectId : '') ||
    '';
  const resolvedProjName = resolvedProjId
    ? resolvedProjId === scope?.projectId && scope?.projectName
      ? scope.projectName
      : await resolveProjectName(resolvedProjId)
    : existing?.projectName || '';
  const resolvedEnvId =
    newMeta.environmentId || existing?.environmentId || scope?.environmentId || '';

  const rawLabel =
    resolvedProjName ||
    (existing?.title ? stripCoordinatorTitlePrefix(existing.title) : '') ||
    scope?.label ||
    (baseDir ? basename(baseDir) : 'Project Hub');
  const projectLabel = stripCoordinatorTitlePrefix(rawLabel) || 'Project Hub';
  const cleanCustomTitle = stripCoordinatorTitlePrefix(title);
  const coordTitle = cleanCustomTitle
    ? `[Coordinator] ${cleanCustomTitle}`
    : existing?.title || `[Coordinator] ${projectLabel}`;

  const memoryPath =
    existing?.memoryPath && existsSync(existing.memoryPath)
      ? existing.memoryPath
      : ensureProjectMemoryFile(baseDir, projectLabel, key);

  const precomputedCompletions =
    migrateActiveThreads !== false
      ? snapshotThreadCompletionsForScope(reg, key, {
          prevCoordId: existing?.conversationId || explicitOldCoordId || '',
        })
      : new Map();

  const rebindOut = mutateRegistry((freshReg) =>
    applyCoordinatorRebindInRegistry(freshReg, {
      scopeKey: key,
      targetCoordId: targetNewCoordId,
      projectId: resolvedProjId,
      projectName: resolvedProjName,
      environmentId: resolvedEnvId,
      workspacePath: scope?.info?.workspacePath || baseDir || existing?.workspacePath || '',
      repoRoot: repoRoot || existing?.repoRoot || '',
      defaultBranch: scope?.info?.currentBranch || existing?.defaultBranch || 'HEAD',
      groupId,
      title: coordTitle,
      memoryPath,
      now,
      migrateActiveThreads: migrateActiveThreads !== false,
      allowReactivateRetired: true,
      precomputedCompletions,
      fallbackExisting: existing,
    }),
  );

  // Promote new Coordinator & demote retired Coordinator ONLY AFTER atomic persistence succeeds
  await syncCoordinatorConversationAnnotations({
    newCoordId: targetNewCoordId,
    coordTitle,
    groupId: rebindOut.coordRecord.groupId || groupId,
    previousCoordinatorId: rebindOut.switchedConv ? rebindOut.previousCoordinatorId : '',
    previousCoordinatorTitle: rebindOut.previousCoordinatorTitle,
    projectLabel,
  });

  if (rebindOut.migratedWorktreeThreads.length > 0) {
    const broadcastRepoRoot = rebindOut.coordRecord.repoRoot || baseDir || '';
    for (const t of rebindOut.migratedWorktreeThreads) {
      try {
        syncRulesIntoWorktree({
          repoRoot: broadcastRepoRoot,
          scopeKey: key,
          worktreePath: t.worktreePath,
          thread: t,
        });
      } catch {
        // Non-fatal if worktree directory is temporarily inaccessible
      }
    }
  }

  return {
    ok: true,
    unchanged: rebindOut.isSameConv && rebindOut.migratedThreadIds.length === 0,
    scopeKey: key,
    previousCoordinatorId: rebindOut.previousCoordinatorId,
    coordinatorId: rebindOut.coordRecord.conversationId,
    coordinator: rebindOut.coordRecord,
    retiredCoordinatorIds: rebindOut.coordRecord.retiredCoordinatorIds || [],
    migratedThreadIds: rebindOut.migratedThreadIds,
    migratedCount: rebindOut.migratedThreadIds.length,
    suppressedAvalancheThreadIds: rebindOut.suppressedAvalancheThreadIds,
  };
}

export async function listCoordinatorCandidates({
  workspacePath = '',
  workspaceKey = '',
  projectId = '',
  coordinatorId = '',
  conversationId = '',
} = {}) {
  const reg = loadRegistry();
  const cleanProjId =
    projectId && projectId !== 'outside-of-project' ? String(projectId).trim() : '';
  const explicitKey = String(workspaceKey || '').trim();
  let effectiveKey = explicitKey ? normalizeScopeKeyForMatch(explicitKey) : '';
  let scopeProjectId = cleanProjId;

  if (!effectiveKey) {
    const scope = await resolveProjectScope({
      workspacePath,
      projectId: cleanProjId,
      coordinatorId,
      conversationId: coordinatorId || conversationId,
      reg,
    });
    effectiveKey = scope.scopeKey || '';
    scopeProjectId = scopeProjectId || scope.projectId || '';
  }

  const coord = effectiveKey
    ? lookupCoordinatorForScope(reg, {
        scopeKey: effectiveKey,
        workspacePath,
        projectId: scopeProjectId,
        conversationId: coordinatorId,
      })
    : null;
  if (coord?.key) effectiveKey = coord.key;

  const currentCoordinatorId = String(coord?.conversationId || '').trim();
  const effectiveProjectId = String(
    cleanProjId ||
      scopeProjectId ||
      (coord?.projectId && coord.projectId !== 'outside-of-project' ? coord.projectId : '') ||
      '',
  ).trim();

  const activeThreads = effectiveKey
    ? Object.values(reg.threads || {}).filter(
        (t) => t && !t.archived && isSameScopeKey(t.workspaceKey, effectiveKey),
      )
    : [];
  const knownWorkerIds = new Set(
    Object.values(reg.threads || {})
      .map((t) => t?.conversationId)
      .filter(Boolean),
  );
  const otherScopeCoordIds = new Set(
    Object.values(reg.coordinators || {})
      .filter((c) => c?.conversationId && (!effectiveKey || !isSameScopeKey(c.key, effectiveKey)))
      .map((c) => c.conversationId),
  );
  const retiredSet = new Set(
    Array.isArray(coord?.retiredCoordinatorIds) ? coord.retiredCoordinatorIds : [],
  );
  const hostConvId = String(conversationId || '').trim();
  const candidates = [];
  const seen = new Set();

  const tryPush = (item) => {
    const id = String(item?.id || '').trim();
    if (!id || seen.has(id) || id === currentCoordinatorId) return;
    if (knownWorkerIds.has(id) || otherScopeCoordIds.has(id)) return;
    seen.add(id);
    candidates.push({
      id,
      title: String(item.title || '').trim(),
      runState: String(item.runState || '').trim(),
      updatedAt: String(item.updatedAt || '').trim(),
      isCurrentHost: Boolean(hostConvId && id === hostConvId),
      isRetired: retiredSet.has(id),
    });
  };

  if (
    hostConvId &&
    hostConvId !== currentCoordinatorId &&
    !knownWorkerIds.has(hostConvId) &&
    !otherScopeCoordIds.has(hostConvId)
  ) {
    const hostMeta = await getConversationMetaCached(hostConvId);
    tryPush({
      id: hostConvId,
      title: hostMeta.title || '',
      runState: '',
      updatedAt: '',
    });
  }

  try {
    const listed = await listConversations(
      effectiveProjectId ? { projectId: effectiveProjectId } : {},
    );
    const convs = Array.isArray(listed?.conversations) ? listed.conversations : [];
    for (const c of convs) {
      const cid = String(c?.id || '').trim();
      if (!cid || c?.annotations?.archived) continue;
      const cProjId = String(c?.metadata?.projectId || c?.metadata?.project_id || '').trim();
      if (
        effectiveProjectId &&
        cProjId &&
        cProjId !== 'outside-of-project' &&
        cProjId !== effectiveProjectId
      ) {
        continue;
      }
      const tags = Array.isArray(c?.annotations?.tags) ? c.annotations.tags : [];
      if (tags.includes('project-thread')) continue;
      tryPush({
        id: cid,
        title: c?.annotations?.title || c?.title || c?.state?.summary || '',
        runState: c?.state?.runState || '',
        updatedAt: c?.state?.updateTime || c?.state?.createTime || '',
      });
    }
  } catch {
    // Non-fatal if ListConversations is unavailable
  }

  candidates.sort((a, b) => {
    if (a.isCurrentHost !== b.isCurrentHost) return a.isCurrentHost ? -1 : 1;
    if (a.isRetired !== b.isRetired) return a.isRetired ? 1 : -1;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });

  return {
    ok: true,
    scopeKey: effectiveKey,
    currentCoordinatorId,
    currentCoordinatorTitle: coord?.title || '',
    activeThreadCount: activeThreads.length,
    candidates: candidates.slice(0, 20),
  };
}

const HAN_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const KANA_OR_HANGUL_RE = /[\u3040-\u30ff\uac00-\ud7af]/;

export function detectPromptLanguage(title = '', taskPrompt = '') {
  const sample = `${String(title || '')}\n${String(taskPrompt || '')}`;
  if (HAN_CHAR_RE.test(sample) && !KANA_OR_HANGUL_RE.test(sample)) {
    return 'zh';
  }
  return 'en';
}

export function buildWorkerPrompt({
  threadId,
  localId = '',
  title,
  taskPrompt,
  worktreePath,
  repoRoot,
  branch,
  baseRef,
  memoryText,
  recommendedTopics = [],
}) {
  const displayId =
    parseUnifiedLocalThreadSeq(localId) > 0
      ? formatLocalThreadId(parseUnifiedLocalThreadSeq(localId))
      : String(localId || threadId || '').trim();
  const lang = detectPromptLanguage(title, taskPrompt);
  const recList = Array.isArray(recommendedTopics) ? recommendedTopics.filter(Boolean) : [];
  const formatTopicRef = (topic) => {
    const rel = String(topic.relativePath || `.agents/memory/${topic.id}.md`);
    const absInTarget =
      worktreePath && rel.startsWith('.agents/')
        ? join(worktreePath, rel)
        : repoRoot && rel.startsWith('.agents/')
          ? join(repoRoot, rel)
          : topic.path || rel;
    const summaryPart = topic.summary ? ` — ${topic.summary}` : '';
    const kwPart =
      Array.isArray(topic.matchedKeywords) && topic.matchedKeywords.length > 0
        ? lang === 'zh'
          ? `（匹配: ${topic.matchedKeywords.slice(0, 4).join(', ')}）`
          : ` (matched: ${topic.matchedKeywords.slice(0, 4).join(', ')})`
        : '';
    return `- **${topic.title || topic.id}** (\`${topic.id}\`): \`${absInTarget}\` (\`${rel}\`)${summaryPart}${kwPart}`;
  };

  if (lang === 'zh') {
    const sections = [
      `# 子线程任务分配: [${displayId}] ${title}`,
      '',
    ];

    if (worktreePath) {
      sections.push(
        '## 隔离工作区与 Git 分支',
        `- **分配的 Worktree 路径**: \`${worktreePath}\``,
        `- **分配的 Git 分支**: \`${branch}\`（基于 \`${baseRef}\`）`,
        repoRoot ? `- **主仓库根目录（禁止直接修改）**: \`${repoRoot}\`` : '',
        '- **关键约束**: 所有 Shell 命令（请先 `cd` 进入该 Worktree 路径）以及全部 `read_file`、`edit_file`、`write_file` 操作必须严格在上方 **分配的 Worktree 路径** 内执行。',
        '',
      );
    } else if (repoRoot) {
      sections.push(
        '## 工作区上下文（只读 / 共享检出）',
        `- **仓库路径**: \`${repoRoot}\``,
        '- **重要提示**: 本线程未创建隔离 Git Worktree。请在上方仓库路径内进行只读代码排查与分析；除非用户在本线程中明确要求，否则不要修改或覆盖受跟踪的文件。',
        '',
      );
    }

    if (memoryText && memoryText.trim()) {
      sections.push(
        '## 继承的项目共享记忆',
        memoryText.trim(),
        '',
      );
    }

    if (recList.length > 0) {
      sections.push(
        '## 推荐按需查阅的专题知识',
        worktreePath
          ? '以下专题与本次任务高度相关（已同步至你的隔离 Worktree 内），请按需使用 `read_file` 查阅详情；未命中的专题无需加载：'
          : '以下专题与本次任务高度相关，请按需使用 `read_file` 查阅详情；未命中的专题无需加载：',
        ...recList.map(formatTopicRef),
        '',
      );
    }

    sections.push(
      '## 任务指令',
      String(taskPrompt || '').trim(),
      '',
      '## 完成与汇报规范',
      '执行与汇报本次任务（或遇到需要总控决策的阻塞问题）时：',
      '1. 请全程使用与上方任务指令相同的语言撰写分析过程、说明与最终总结。',
      '2. 除纯单步简单问答外，凡涉及多阶段排查、审查、开发或验证的任务，务必在首轮工具调用时并行调用内置 `update_steps` 工具列出 3–5 个清晰阶段，并在阶段推进与最终收尾时同步更新状态，方便总控与右侧看板实时跟踪进度。',
      '3. 若分配了隔离 Worktree，请确保改动整洁、结构清晰（如任务要求提交，请在分配分支上干净提交）。',
      '4. 在最终回复末尾使用 `### 线程总结`（或 `### Thread Summary`）输出简洁的结构化总结，列出：关键改动/排查结论、修改的文件或提交哈希，以及可沉淀到项目共享记忆的通用架构约定。',
    );

    return sections.filter((s) => s !== undefined).join('\n');
  }

  const sections = [
    `# Worker Thread Assignment: [${displayId}] ${title}`,
    '',
  ];

  if (worktreePath) {
    sections.push(
      '## Isolated Workspace & Git Branch',
      `- **Assigned Worktree Path**: \`${worktreePath}\``,
      `- **Assigned Git Branch**: \`${branch}\` (based on \`${baseRef}\`)`,
      repoRoot ? `- **Main Repo Root (DO NOT MODIFY DIRECTLY)**: \`${repoRoot}\`` : '',
      '- **CRITICAL**: Execute all shell commands (`cd` into the worktree path) and perform all `read_file`, `edit_file`, and `write_file` operations strictly inside the **Assigned Worktree Path** above.',
      '',
    );
  } else if (repoRoot) {
    sections.push(
      '## Workspace Context (Read-Only / Shared Checkout)',
      `- **Repository Path**: \`${repoRoot}\``,
      '- **IMPORTANT**: No isolated Git worktree was created for this thread. Perform read-only code inspection and analysis inside the Repository Path above; do NOT edit or overwrite tracked files unless the user explicitly instructs you inside this thread.',
      '',
    );
  }

  if (memoryText && memoryText.trim()) {
    sections.push(
      '## Inherited Project Memory',
      memoryText.trim(),
      '',
    );
  }

  if (recList.length > 0) {
    sections.push(
      '## Recommended On-Demand Topic Files',
      worktreePath
        ? 'The following topic files match this task (synced into your isolated worktree). Read them on demand with `read_file` if needed; unrelated topics are omitted:'
        : 'The following topic files match this task. Read them on demand with `read_file` if needed; unrelated topics are omitted:',
      ...recList.map(formatTopicRef),
      '',
    );
  }

  sections.push(
    '## Task Instructions',
    String(taskPrompt || '').trim(),
    '',
    '## Completion & Handback Protocol',
    'While executing and handing back this task (or if you hit a blocker needing Coordinator decision):',
    '1. Write your analysis, explanations, and final summary in the same language as the Task Instructions above.',
    '2. Except for trivial single-step Q&A, for any multi-stage investigation, review, implementation, or verification task, call the built-in `update_steps` tool in parallel during your first tool-call turn to list 3–5 clear stages, and update step statuses as each stage advances and finishes so the Coordinator and sidebar board can track progress live.',
    '3. Ensure your changes in the worktree are clean and well-structured (commit to your assigned branch if requested in the task).',
    '4. End your final message with a concise structured summary (`### Thread Summary`) listing: key changes/findings, modified files or commit hash, and any new project-wide learnings for Shared Memory.',
  );

  return sections.filter((s) => s !== undefined).join('\n');
}

export async function dispatchThread({
  workspacePath = '',
  coordinatorId = '',
  conversationId = '',
  projectId = '',
  title,
  taskPrompt,
  branch = '',
  baseRef = '',
  worktreePath = '',
  model = '',
  threadType = '',
  createWorktree,
}) {
  if (!title || !taskPrompt) {
    throw new Error('Both `title` and `taskPrompt` are required to dispatch a thread.');
  }

  const rawThreadType = String(threadType || '').trim();
  const hasExplicitCreateWorktree =
    createWorktree !== undefined && createWorktree !== null && createWorktree !== '';
  const inferredCreateWorktree =
    rawThreadType &&
    ['review', 'readonly'].includes(normalizeThreadType(rawThreadType, true))
      ? false
      : true;
  const effectiveCreateWorktree = hasExplicitCreateWorktree
    ? Boolean(createWorktree)
    : inferredCreateWorktree;
  const resolvedThreadType = normalizeThreadType(rawThreadType, effectiveCreateWorktree);

  const reg = loadRegistry();
  assertNotRetiredCoordinator(reg, { coordinatorId, conversationId });
  const callerConvId = String(coordinatorId || conversationId || '').trim();
  const scope = await resolveProjectScope({
    workspacePath,
    conversationId: callerConvId,
    coordinatorId,
    projectId,
    reg,
  });
  if (!scope.scopeKey) {
    throw new Error('Provide workspacePath or conversationId/coordinatorId to dispatch a thread.');
  }

  const key = scope.scopeKey;
  const coord = reg.coordinators[key] || null;
  if (coord?.conversationId) {
    const coordMeta = await getConversationMetaCached(coord.conversationId);
    if (coordMeta.projectId && coordMeta.projectId !== coord.projectId) {
      coord.projectId = coordMeta.projectId;
    }
    if (coordMeta.environmentId && coordMeta.environmentId !== coord.environmentId) {
      coord.environmentId = coordMeta.environmentId;
    }
  }

  const resolvedProjId =
    scope.projectId ||
    (coord?.projectId && coord.projectId !== 'outside-of-project' ? coord.projectId : '') ||
    '';
  const resolvedCoordId =
    resolveTargetCoordinatorId({
      coordinatorId,
      conversationId,
      scopeKey: key,
      workspacePath,
      projectId: resolvedProjId,
      reg,
    }) || String(coordinatorId || coord?.conversationId || conversationId || '').trim();
  const resolvedEnvId = scope.environmentId || coord?.environmentId || '';
  const groupId = coord?.groupId || `proj-grp-${randomUUID().slice(0, 8)}`;

  const { reservedSeq, reservedProjectSeq, reservedLocalId, reservedThreadId } = mutateRegistry(
    (freshReg) => {
      freshReg.seq = (Number(freshReg.seq) || 0) + 1;
      const nextProjectSeq = allocateNextProjectSeqInReg(freshReg, key);
      const nextLocalId = formatLocalThreadId(nextProjectSeq);
      const nextThreadId = allocateInternalThreadKeyInReg(freshReg, key, nextLocalId, freshReg.seq);
      return {
        reservedSeq: freshReg.seq,
        reservedProjectSeq: nextProjectSeq,
        reservedLocalId: nextLocalId,
        reservedThreadId: nextThreadId,
      };
    },
  );
  const threadId = reservedThreadId;
  const projectSeq = reservedProjectSeq;
  const localId = reservedLocalId || formatLocalThreadId(projectSeq);
  const displayId = localId || threadId;

  let effectiveRepoRoot = scope.info.mainRepoRoot || scope.info.repoRoot || '';
  const projectLabel = scope.label || (scope.baseDir ? basename(scope.baseDir) : 'Project');
  ensureProjectMemoryFile(scope.baseDir, projectLabel, key);
  const memorySnap = readProjectMemory(scope.baseDir, key);
  const memoryText = memorySnap.content;
  const recommendedTopics = recommendTopicsForTask({
    title,
    taskPrompt,
    topics: memorySnap.topics,
    indexMarkdown: memoryText,
    maxTopics: 2,
  });

  const rawRequestedWt = uriToPath(worktreePath);
  const requestedWorktreePath = rawRequestedWt
    ? effectiveRepoRoot
      ? resolve(effectiveRepoRoot, rawRequestedWt)
      : resolve(rawRequestedWt)
    : '';
  if (
    requestedWorktreePath &&
    effectiveRepoRoot &&
    normalizeKey(requestedWorktreePath) === normalizeKey(effectiveRepoRoot)
  ) {
    throw new Error('worktreePath must point to an isolated Git worktree, not the main repository root.');
  }

  let finalWorktreePath = '';
  let resolvedBranch = branch || '';
  const coordDefaultBranch =
    coord?.defaultBranch && coord.defaultBranch !== 'HEAD' ? String(coord.defaultBranch).trim() : '';
  const infoBranch =
    scope.info.currentBranch && scope.info.currentBranch !== 'HEAD' ? scope.info.currentBranch : '';
  const startRef = baseRef || infoBranch || coordDefaultBranch || 'HEAD';
  let initialGit = null;

  if (effectiveCreateWorktree && effectiveRepoRoot && !requestedWorktreePath) {
    const wt = await createGitWorktree({
      repoRoot: effectiveRepoRoot,
      threadId,
      localId: displayId,
      title,
      requestedBranch: branch,
      baseRef: startRef,
    });
    finalWorktreePath = wt.worktreePath;
    resolvedBranch = wt.branch;
    initialGit = {
      exists: true,
      branch: resolvedBranch,
      dirtyCount: 0,
      aheadCount: 0,
      merged: true,
      mergeMethod: '',
      lastCommit: '',
    };
  } else if (requestedWorktreePath) {
    finalWorktreePath = requestedWorktreePath;
    if (existsSync(finalWorktreePath)) {
      if (!effectiveRepoRoot) {
        const wtRepoInfo = await resolveRepoInfo(finalWorktreePath);
        if (wtRepoInfo.mainRepoRoot || wtRepoInfo.repoRoot) {
          effectiveRepoRoot = wtRepoInfo.mainRepoRoot || wtRepoInfo.repoRoot;
        }
      }
      if (
        effectiveRepoRoot &&
        normalizeKey(finalWorktreePath) === normalizeKey(effectiveRepoRoot)
      ) {
        throw new Error('worktreePath must point to an isolated Git worktree, not the main repository root.');
      }
      await appendWorktreeExclude(finalWorktreePath, WORKTREE_MEMORY_EXCLUDE_PATTERNS);
      initialGit = await inspectWorktreeGit(finalWorktreePath, {
        baseRef: startRef,
        defaultBranch: coordDefaultBranch,
        repoRoot: effectiveRepoRoot,
      });
      if (!resolvedBranch && initialGit?.branch && initialGit.branch !== 'HEAD') {
        resolvedBranch = initialGit.branch;
      }
    }
    if (!initialGit) {
      initialGit = {
        exists: existsSync(finalWorktreePath),
        branch: resolvedBranch,
        dirtyCount: 0,
        aheadCount: 0,
        merged: true,
        mergeMethod: '',
        lastCommit: '',
      };
    }
  }

  const fullPrompt = buildWorkerPrompt({
    threadId,
    localId: displayId,
    title,
    taskPrompt,
    worktreePath: finalWorktreePath,
    repoRoot: effectiveRepoRoot || scope.baseDir,
    branch: resolvedBranch,
    baseRef: startRef,
    memoryText,
    recommendedTopics,
  });

  let catalogModels = [];
  try {
    catalogModels = await getSelectableModels({ timeoutMs: 2500 });
  } catch {
    catalogModels = [];
  }
  const settingsLabels = loadSettings().labels || {};

  const rawCallerModel = String(model || '').trim();
  let selectedModelInput = rawCallerModel;
  let inheritedInfo = null;
  if (isOmittedOrDefaultModel(rawCallerModel)) {
    const effective = await getEffectiveSettings({
      workspacePath,
      workspaceKey: key,
      coordinatorId: resolvedCoordId,
      conversationId: callerConvId,
      projectId: resolvedProjId,
    });
    selectedModelInput =
      (resolvedThreadType === 'review'
        ? effective.reviewModel
        : resolvedThreadType === 'readonly'
          ? effective.readOnlyModel
          : effective.worktreeModel) || 'inherit';
  }

  if (isInheritModel(selectedModelInput)) {
    inheritedInfo = await resolveInheritedCoordinatorModel({
      coordinatorId: resolvedCoordId,
      conversationId: callerConvId,
      workspacePath,
      workspaceKey: key,
      projectId: resolvedProjId,
      reg,
      catalogModels,
      settingsLabels,
    });
    selectedModelInput = inheritedInfo.model || 'pro';
  }

  const resolvedDispatchModel = resolveModelEntryFromCatalog(
    selectedModelInput,
    catalogModels,
    settingsLabels,
  );
  const rawNormalizedModel = resolvedDispatchModel.canonical || 'pro';
  const rawCreateModelArg = resolvedDispatchModel.createModelArg || 'pro';
  const normalizedModel =
    isInheritModel(rawNormalizedModel) || isOmittedOrDefaultModel(rawNormalizedModel)
      ? 'pro'
      : rawNormalizedModel;
  const createModelArg =
    isInheritModel(rawCreateModelArg) || isOmittedOrDefaultModel(rawCreateModelArg)
      ? 'pro'
      : rawCreateModelArg;
  const matchedCatalogModel = resolvedDispatchModel.matched || inheritedInfo?.matched || null;
  const resolvedFallbackEnum =
    matchedCatalogModel?.modelEnum ||
    inheritedInfo?.modelEnum ||
    (/^MODEL_(?!ALIAS_)/i.test(normalizedModel) ? normalizedModel : '');

  const tags = ['project-thread', `thread:${threadId}`, `local:${displayId}`, `group:${groupId}`];
  if (resolvedCoordId) tags.push(`coord:${resolvedCoordId}`);

  const displayTitle = `[${displayId}] ${title}`;
  let conv = null;
  let usedCascadePromptFallback = false;
  try {
    conv = await createConversation({
      projectId: resolvedProjId,
      environmentId: resolvedEnvId,
      title: displayTitle,
      model: createModelArg,
      tags,
      promptText: fullPrompt,
    });
  } catch (createErr) {
    const canFallbackToCascade =
      !isTierAlias(normalizedModel) &&
      Boolean(matchedCatalogModel?.modelOrAlias || resolvedFallbackEnum) &&
      /(?:HTTP 400|invalid|unsupported|unknown).*model|model.*(?:invalid|unsupported|unknown|not found)/i.test(
        String(createErr?.message || ''),
      );
    if (!canFallbackToCascade) {
      throw createErr;
    }
    conv = await createConversation({
      projectId: resolvedProjId,
      environmentId: resolvedEnvId,
      title: displayTitle,
      model: 'pro',
      tags,
      promptText: '',
    });
    usedCascadePromptFallback = true;
  }

  const spawnedId = conv?.id || '';
  if (!spawnedId) {
    throw new Error('ConversationService/CreateConversation returned no conversation ID.');
  }

  if (usedCascadePromptFallback) {
    await sendUserCascadeMessage(spawnedId, fullPrompt, {
      modelOrAlias: matchedCatalogModel?.modelOrAlias,
      modelEnum: resolvedFallbackEnum,
      model: matchedCatalogModel?.modelId || normalizedModel,
    });
  }

  try {
    await updateConversation(spawnedId, {
      title: displayTitle,
      tags,
      conversationGroupId: groupId,
    });
  } catch {
    // Optional group annotation
  }

  const now = new Date().toISOString();
  const inheritedDisplayName =
    inheritedInfo && inheritedInfo.model === normalizedModel ? inheritedInfo.displayName : '';
  const initialDisplayName = isTierAlias(normalizedModel)
    ? ''
    : matchedCatalogModel?.label ||
      settingsLabels[normalizedModel] ||
      inheritedDisplayName ||
      (await resolveNonTierModelDisplay(normalizedModel));
  const initialResolvedModel =
    initialDisplayName && !isTierAlias(normalizedModel)
      ? matchedCatalogModel?.modelId || createModelArg || normalizedModel
      : '';
  const initialModelEnum = resolvedFallbackEnum;
  const threadRecord = {
    threadId,
    ...(projectSeq > 0 ? { projectSeq, localId } : {}),
    displayId,
    conversationId: spawnedId,
    coordinatorId: resolvedCoordId,
    workspaceKey: key,
    projectId: resolvedProjId,
    environmentId: resolvedEnvId,
    groupId,
    workspacePath: scope.info.workspacePath || scope.baseDir || '',
    repoRoot: effectiveRepoRoot,
    worktreePath: finalWorktreePath,
    branch: resolvedBranch,
    baseRef: startRef,
    threadType: resolvedThreadType,
    title,
    displayTitle,
    taskPrompt,
    model: normalizedModel,
    modelDisplayName: initialDisplayName,
    resolvedModel: initialResolvedModel,
    ...(initialModelEnum ? { modelEnum: initialModelEnum } : {}),
    runState: conv?.state?.runState || 'RUN_STATE_RUNNING',
    archived: false,
    git: initialGit,
    lastSummary: '',
    lastCompletedAt: '',
    notifiedCoordinatorAt: '',
    createdAt: now,
    updatedAt: now,
  };

  if (finalWorktreePath && existsSync(finalWorktreePath)) {
    syncRulesIntoWorktree({
      repoRoot: effectiveRepoRoot,
      scopeKey: key,
      worktreePath: finalWorktreePath,
      thread: threadRecord,
    });
  }

  mutateRegistry((freshReg) => {
    if (reservedSeq > (Number(freshReg.seq) || 0)) {
      freshReg.seq = reservedSeq;
    }
    const normProjectKey = normalizeScopeKeyForMatch(key);
    if (normProjectKey && projectSeq > 0) {
      freshReg.projectSeqs = normalizeProjectSeqsMap(freshReg.projectSeqs);
      if (!freshReg.projectSeqs[normProjectKey] || projectSeq > freshReg.projectSeqs[normProjectKey]) {
        freshReg.projectSeqs[normProjectKey] = projectSeq;
      }
    }
    const freshCoord = freshReg.coordinators?.[key];
    if (freshCoord && coord?.conversationId && freshCoord.conversationId === coord.conversationId) {
      if (coord.projectId && coord.projectId !== freshCoord.projectId) {
        freshCoord.projectId = coord.projectId;
      }
      if (coord.environmentId && coord.environmentId !== freshCoord.environmentId) {
        freshCoord.environmentId = coord.environmentId;
      }
    }
    freshReg.threads[threadId] = threadRecord;
  });
  return threadRecord;
}

export function parseLocalThreadSeqRef(raw) {
  const s = String(raw || '').trim();
  const m = /^#(\d+)$/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function findThreadByLocalSeqInScope(reg, scopeKey, targetSeq) {
  const seq = parsePositiveSeq(targetSeq);
  const normScope = normalizeScopeKeyForMatch(scopeKey);
  if (!seq || !normScope || !reg?.threads) return null;
  const { seqByThreadId } = computeScopeProjectSeqMap(reg, normScope);
  for (const [tid, assignedSeq] of seqByThreadId.entries()) {
    if (assignedSeq === seq && reg.threads[tid]) {
      return reg.threads[tid];
    }
  }
  return null;
}

function findThreadByLocalIdInScope(reg, scopeKey, rawRef) {
  const normScope = normalizeScopeKeyForMatch(scopeKey);
  const targetSeq = parseUnifiedLocalThreadSeq(rawRef);
  if (!normScope || !targetSeq || !reg?.threads) return null;
  const targetLocalId = formatLocalThreadId(targetSeq).toLowerCase();
  const scopeThreads = Object.values(reg.threads).filter(
    (t) => t && typeof t === 'object' && t.threadId && isSameScopeKey(t.workspaceKey, normScope),
  );
  // 1. Prefer exact unified thr-NNN localId match inside the current project scope
  for (const t of scopeThreads) {
    const tLocalSeq = parseUnifiedLocalThreadSeq(t.localId);
    if (tLocalSeq > 0 && tLocalSeq === targetSeq) {
      return t;
    }
  }
  // 2. Fallback to historical global thr-NNN threads belonging to this same project scope
  for (const t of scopeThreads) {
    const displayId = getThreadDisplayId(t);
    if (displayId && displayId.toLowerCase() === targetLocalId) {
      return t;
    }
    if (parseUnifiedLocalThreadSeq(t.threadId) === targetSeq && !isUnifiedLocalThreadId(t.localId)) {
      return t;
    }
  }
  return null;
}

function doesThreadMatchResolvedScope(
  t,
  scope,
  { explicitProjectId = '', hasExplicitPathOrKey = false } = {},
) {
  if (!t || !scope?.scopeKey) return false;
  const threadProjId =
    t.projectId && t.projectId !== 'outside-of-project' ? String(t.projectId).trim() : '';
  if (explicitProjectId && threadProjId && threadProjId !== explicitProjectId) {
    return false;
  }
  if (t.workspaceKey && isSameScopeKey(t.workspaceKey, scope.scopeKey)) {
    return true;
  }
  if (
    !hasExplicitPathOrKey &&
    scope.scopeKind === 'project' &&
    scope.projectId &&
    threadProjId &&
    threadProjId === scope.projectId
  ) {
    return true;
  }
  return false;
}

function tryFastResolveKnownScopeFromKey({
  cleanWsKey = '',
  cleanWsPath = '',
  cleanCoordId = '',
  cleanConvId = '',
  cleanProjId = '',
  reg = null,
} = {}) {
  if (!cleanWsKey || !reg) return null;
  const normKey = normalizeScopeKeyForMatch(cleanWsKey);
  if (!normKey) return null;

  const knownCoord = lookupCoordinatorForScope(reg, { scopeKey: normKey });
  const scopeThreads = Object.values(reg.threads || {}).filter(
    (t) => t && t.workspaceKey && isSameScopeKey(t.workspaceKey, normKey),
  );
  if (!knownCoord && scopeThreads.length === 0) {
    return null;
  }

  // If workspacePath is supplied, require it to unambiguously match the same known scope without spawning git
  if (cleanWsPath) {
    const normWs = normalizeKey(cleanWsPath);
    if (!normWs || normWs === '__global__') return null;
    const knownPaths = new Set();
    if (isFilesystemPathKey(normKey)) knownPaths.add(normKey);
    for (const p of [knownCoord?.repoRoot, knownCoord?.workspacePath]) {
      if (p) knownPaths.add(normalizeKey(p));
    }
    for (const t of scopeThreads) {
      if (t.repoRoot) knownPaths.add(normalizeKey(t.repoRoot));
      if (t.workspacePath) knownPaths.add(normalizeKey(t.workspacePath));
      if (t.worktreePath) knownPaths.add(normalizeKey(t.worktreePath));
    }
    const matchedKnownPaths = [...knownPaths]
      .filter((kp) => kp && (isSameScopeKey(normWs, kp) || isNormalizedPathEqualOrDescendant(normWs, kp)))
      .sort((a, b) => b.length - a.length);
    if (matchedKnownPaths.length === 0) return null;
    const deepestMatchedRoot = matchedKnownPaths[0];

    // Fail-closed: if a nested independent .git boundary exists between cleanWsPath and matched root, fall back to full resolve
    if (hasNestedDotGitBeforeRoot(cleanWsPath, deepestMatchedRoot)) {
      return null;
    }

    // Fail-closed: if any other distinct project scope (coordinator or thread) claims a matching/ancestor path, fall back to full resolve
    for (const c of Object.values(reg.coordinators || {})) {
      if (!c?.key || isSameScopeKey(c.key, normKey)) continue;
      const otherNormKey = normalizeScopeKeyForMatch(c.key);
      const otherPaths = [
        isFilesystemPathKey(otherNormKey) ? otherNormKey : '',
        c.repoRoot ? normalizeKey(c.repoRoot) : '',
        c.workspacePath ? normalizeKey(c.workspacePath) : '',
      ];
      for (const otherP of otherPaths) {
        if (otherP && isNormalizedPathEqualOrDescendant(normWs, otherP)) return null;
      }
    }
    for (const otherT of Object.values(reg.threads || {})) {
      if (!otherT?.workspaceKey || isSameScopeKey(otherT.workspaceKey, normKey)) continue;
      const otherNormKey = normalizeScopeKeyForMatch(otherT.workspaceKey);
      const otherPaths = [
        isFilesystemPathKey(otherNormKey) ? otherNormKey : '',
        otherT.repoRoot ? normalizeKey(otherT.repoRoot) : '',
        otherT.workspacePath ? normalizeKey(otherT.workspacePath) : '',
        otherT.worktreePath ? normalizeKey(otherT.worktreePath) : '',
      ];
      for (const otherP of otherPaths) {
        if (otherP && isNormalizedPathEqualOrDescendant(normWs, otherP)) return null;
      }
    }
  } else if (cleanCoordId || cleanConvId) {
    const inferredConvScope = inferScopeKeyFromRegistry(
      { conversationId: cleanConvId || cleanCoordId, coordinatorId: cleanCoordId },
      reg,
    );
    if (!inferredConvScope || !isSameScopeKey(inferredConvScope, normKey)) {
      return null;
    }
  }

  if (cleanProjId) {
    if (
      normKey.startsWith('project:') &&
      normKey !== normalizeScopeKeyForMatch(`project:${cleanProjId}`)
    ) {
      return null;
    }
    if (
      knownCoord?.projectId &&
      knownCoord.projectId !== 'outside-of-project' &&
      String(knownCoord.projectId).trim() !== cleanProjId
    ) {
      return null;
    }
    const hasConflictingThreadProj = scopeThreads.some(
      (t) =>
        t.projectId &&
        t.projectId !== 'outside-of-project' &&
        String(t.projectId).trim() !== cleanProjId,
    );
    if (hasConflictingThreadProj) {
      return null;
    }
  }

  const baseDir =
    knownCoord?.repoRoot ||
    knownCoord?.workspacePath ||
    scopeThreads.find((t) => t.repoRoot || t.workspacePath)?.repoRoot ||
    scopeThreads.find((t) => t.workspacePath)?.workspacePath ||
    (isFilesystemPathKey(normKey) ? uriToPath(cleanWsKey) : '');

  return {
    scopeKey: normKey,
    scopeKind: normKey.startsWith('project:')
      ? 'project'
      : normKey.startsWith('conv:')
        ? 'conversation'
        : 'workspace',
    baseDir,
    projectId:
      cleanProjId ||
      (knownCoord?.projectId && knownCoord.projectId !== 'outside-of-project'
        ? String(knownCoord.projectId).trim()
        : ''),
    projectName: knownCoord?.projectName || '',
    workspaceName: baseDir ? basename(baseDir) : '',
    scopeTitle: knownCoord?.projectName || (baseDir ? basename(baseDir) : ''),
    environmentId: knownCoord?.environmentId || '',
    label: knownCoord?.projectName || (baseDir ? basename(baseDir) : ''),
    info: {
      workspacePath: cleanWsPath ? uriToPath(cleanWsPath) : baseDir,
      repoRoot: knownCoord?.repoRoot || '',
      mainRepoRoot: knownCoord?.repoRoot || '',
      currentBranch: knownCoord?.defaultBranch || '',
    },
  };
}

/**
 * Resolves a single thread by global threadId ("thr-001"), conversationId UUID, or project-local
 * sequence ("#1"), enforcing fail-closed project scope isolation whenever scope parameters
 * are provided (or when requireScope is true / for local #N lookup).
 */
export async function resolveScopedThreadTarget({
  threadId = '',
  workspacePath = '',
  workspaceKey = '',
  coordinatorId = '',
  conversationId = '',
  projectId = '',
  requireScope = false,
  reg = null,
} = {}) {
  const rawRef = String(threadId || '').trim();
  if (!rawRef) {
    throw new Error('`threadId` is required.');
  }

  const activeReg = reg || loadRegistry();
  const cleanWsKey = String(workspaceKey || '').trim();
  const cleanWsPath = String(workspacePath || '').trim();
  const cleanCoordId = String(coordinatorId || '').trim();
  const cleanConvId = String(conversationId || '').trim();
  const rawProjId = String(projectId || '').trim();
  const cleanProjId = rawProjId && rawProjId !== 'outside-of-project' ? rawProjId : '';
  const hasScope = Boolean(
    cleanWsKey || cleanWsPath || cleanCoordId || cleanConvId || rawProjId,
  );

  if (requireScope && !hasScope) {
    throw new Error(
      `Project scope is required (fail-closed) for thread "${rawRef}": provide workspacePath, coordinatorId, conversationId, or projectId (or explicitly pass scope: "*" for unscoped global threadId access).`,
    );
  }

  let scope = null;
  if (hasScope) {
    if (cleanWsKey) {
      scope = tryFastResolveKnownScopeFromKey({
        cleanWsKey,
        cleanWsPath,
        cleanCoordId,
        cleanConvId,
        cleanProjId,
        reg: activeReg,
      });
    }
    if (!scope && (cleanWsPath || cleanCoordId || cleanConvId || cleanProjId)) {
      scope = await resolveProjectScope({
        workspacePath: cleanWsPath,
        conversationId: cleanConvId || cleanCoordId,
        coordinatorId: cleanCoordId,
        projectId: cleanProjId,
        reg: activeReg,
      });
    }
    if ((!scope || !scope.scopeKey) && cleanWsKey) {
      const normKey = normalizeScopeKeyForMatch(cleanWsKey);
      scope = {
        scopeKey: normKey,
        scopeKind: normKey.startsWith('project:')
          ? 'project'
          : normKey.startsWith('conv:')
            ? 'conversation'
            : 'workspace',
        baseDir: isFilesystemPathKey(normKey) ? cleanWsKey : '',
        projectId: cleanProjId,
        projectName: '',
        workspaceName: '',
        scopeTitle: '',
        environmentId: '',
        label: '',
        info: { workspacePath: '', repoRoot: '', mainRepoRoot: '', currentBranch: '' },
      };
    }
    if (!scope?.scopeKey) {
      throw new Error(
        `Unable to resolve project scope for thread "${rawRef}" (fail-closed).`,
      );
    }
  }

  const localSeq = parseLocalThreadSeqRef(rawRef);
  if (localSeq > 0) {
    if (!hasScope || !scope?.scopeKey) {
      throw new Error(
        `Project scope (workspacePath, coordinatorId, projectId, or conversationId) is required when referencing a thread by project-local sequence "${rawRef}".`,
      );
    }
    let matched = findThreadByLocalSeqInScope(activeReg, scope.scopeKey, localSeq);
    if (!matched && scope.scopeKind === 'project' && scope.projectId && !cleanWsPath && !cleanWsKey) {
      const projScopeKeys = new Set(
        Object.values(activeReg.threads || {})
          .filter((x) => x && x.projectId === scope.projectId && x.workspaceKey)
          .map((x) => normalizeScopeKeyForMatch(x.workspaceKey))
          .filter(Boolean),
      );
      if (projScopeKeys.size === 1) {
        matched = findThreadByLocalSeqInScope(activeReg, [...projScopeKeys][0], localSeq);
      }
    }
    if (!matched) {
      throw new Error(`Thread not found in project scope "${scope.scopeKey}": ${rawRef}`);
    }
    if (
      !doesThreadMatchResolvedScope(matched, scope, {
        explicitProjectId: cleanProjId,
        hasExplicitPathOrKey: Boolean(cleanWsPath || cleanWsKey),
      })
    ) {
      throw new Error(
        `Cross-project access denied: thread "${matched.threadId}" belongs to a different project scope than "${scope.scopeKey}".`,
      );
    }
    return { thread: matched, scope, reg: activeReg, resolvedBy: 'localSeq' };
  }

  // Project-local thr-NNN lookup (prioritizes current scope's localId/displayId before global fallback)
  if (hasScope && scope?.scopeKey && isUnifiedLocalThreadId(rawRef)) {
    let matchedLocal = findThreadByLocalIdInScope(activeReg, scope.scopeKey, rawRef);
    if (
      !matchedLocal &&
      scope.scopeKind === 'project' &&
      scope.projectId &&
      !cleanWsPath &&
      !cleanWsKey
    ) {
      const projScopeKeys = new Set(
        Object.values(activeReg.threads || {})
          .filter((x) => x && x.projectId === scope.projectId && x.workspaceKey)
          .map((x) => normalizeScopeKeyForMatch(x.workspaceKey))
          .filter(Boolean),
      );
      if (projScopeKeys.size === 1) {
        matchedLocal = findThreadByLocalIdInScope(activeReg, [...projScopeKeys][0], rawRef);
      }
    }
    if (matchedLocal) {
      if (
        !doesThreadMatchResolvedScope(matchedLocal, scope, {
          explicitProjectId: cleanProjId,
          hasExplicitPathOrKey: Boolean(cleanWsPath || cleanWsKey),
        })
      ) {
        throw new Error(
          `Cross-project access denied: thread "${matchedLocal.threadId}" belongs to a different project scope than "${scope.scopeKey}".`,
        );
      }
      return { thread: matchedLocal, scope, reg: activeReg, resolvedBy: 'localId' };
    }
  }

  const t = findThreadInRegistry(activeReg, rawRef);
  if (!t) {
    if (!hasScope && isUnifiedLocalThreadId(rawRef)) {
      const targetSeq = parseUnifiedLocalThreadSeq(rawRef);
      const existsAsScopedLocal = Object.values(activeReg.threads || {}).some(
        (x) => x && parseUnifiedLocalThreadSeq(x.localId) === targetSeq,
      );
      if (existsAsScopedLocal) {
        throw new Error(
          `Project scope (workspacePath, coordinatorId, projectId, or conversationId) is required when referencing a thread by project-local ID "${rawRef}".`,
        );
      }
    }
    if (hasScope && scope?.scopeKey && isUnifiedLocalThreadId(rawRef)) {
      throw new Error(`Thread not found in project scope "${scope.scopeKey}": ${rawRef}`);
    }
    throw new Error(`Thread not found: ${rawRef}`);
  }

  if (hasScope) {
    if (
      !doesThreadMatchResolvedScope(t, scope, {
        explicitProjectId: cleanProjId,
        hasExplicitPathOrKey: Boolean(cleanWsPath || cleanWsKey),
      })
    ) {
      throw new Error(
        `Cross-project access denied: thread "${t.threadId}" belongs to a different project scope than "${scope.scopeKey}".`,
      );
    }
  }

  return {
    thread: t,
    scope,
    reg: activeReg,
    resolvedBy: activeReg.threads?.[rawRef] ? 'threadId' : 'conversationId',
  };
}

async function syncSingleThreadRecord(
  t,
  reg,
  { coordinator = null, becameArchivedIds = null, pendingAutoSyncIds = null } = {},
) {
  let dirty = false;
  const wasRunning = t.runState === 'RUN_STATE_RUNNING' || seenRunningThreadIds.has(t.threadId);
  if (t.runState === 'RUN_STATE_RUNNING') {
    seenRunningThreadIds.add(t.threadId);
  }

  try {
    const live = await getConversation(t.conversationId);
    const conv = live?.conversation || live;
    if (conv?.state?.runState && conv.state.runState !== t.runState) {
      if (conv.state.runState === 'RUN_STATE_RUNNING') {
        seenRunningThreadIds.add(t.threadId);
      }
      t.runState = conv.state.runState;
      if (conv.state.runState === 'RUN_STATE_IDLE') {
        t.lastCompletedAt = new Date().toISOString();
      }
      dirty = true;
    }
    if (conv?.state?.summary && !t.lastSummary) {
      t.lastSummary = conv.state.summary;
      dirty = true;
    }
    const prevArchived = Boolean(t.archived);
    if (typeof conv?.annotations?.archived === 'boolean' && conv.annotations.archived !== t.archived) {
      t.archived = conv.annotations.archived;
      dirty = true;
      if (!prevArchived && t.archived === true && t.worktreePath && becameArchivedIds) {
        becameArchivedIds.add(t.threadId);
      }
    }
    if (!t.projectId && conv?.metadata?.projectId && conv.metadata.projectId !== 'outside-of-project') {
      t.projectId = conv.metadata.projectId;
      dirty = true;
    }
    if (conv?.state?.updateTime) {
      t.updatedAt = conv.state.updateTime;
    }
  } catch {
    // Conversation may have been deleted externally or LS temporarily busy
  }

  if (t.worktreePath) {
    const gitInfo = await inspectWorktreeGit(t.worktreePath, {
      baseRef: t.baseRef,
      defaultBranch: resolveThreadCoordDefaultBranch(t, reg),
      repoRoot: t.repoRoot || coordinator?.repoRoot || '',
    });
    if (JSON.stringify(gitInfo) !== JSON.stringify(t.git)) {
      t.git = gitInfo;
      dirty = true;
    }
  }

  const liveAct = peekLiveActivity(t.conversationId, { runState: t.runState });
  const prevHasPendingBgTask = Boolean(t.hasPendingBgTask);
  const prevActiveTool = t.activeTool || '';
  const prevBucket = t.bucket || '';
  const prevStepsKey = JSON.stringify([t.stepsProgress || null, t.stepsList || null]);
  const wasWorking = wasRunning || prevHasPendingBgTask || prevBucket === 'working';
  const isActivelyWorking =
    !t.archived && (t.runState === 'RUN_STATE_RUNNING' || Boolean(liveAct.hasPendingBgTask));
  if (isActivelyWorking) {
    seenRunningThreadIds.add(t.threadId);
  }
  t.hasPendingBgTask = Boolean(liveAct.hasPendingBgTask);
  t.activeTool = isActivelyWorking ? liveAct.activeTool || '' : '';
  t.activeToolObj = isActivelyWorking ? liveAct.activeToolObj || null : null;
  t.stepsProgress = liveAct.stepsProgress || null;
  t.stepsList = liveAct.stepsList || null;
  t.toolStepCount = liveAct.toolStepCount || 0;
  const nextStepsKey = JSON.stringify([t.stepsProgress, t.stepsList]);

  if (liveAct.lastSummary && !isActivelyWorking) {
    if (
      (!t.lastSummary || t.lastSyncedStepIndex !== liveAct.lastStepIndex) &&
      t.lastSummary !== liveAct.lastSummary
    ) {
      t.lastSummary = liveAct.lastSummary;
      dirty = true;
    }
  }

  // Compute attention-first 3-state triage bucket: 'working' | 'waiting' | 'idle'
  const { bucket, waitingReason } = computeThreadBucket(t, liveAct);
  t.bucket = bucket;
  t.waitingReason = waitingReason;

  if (
    prevHasPendingBgTask !== t.hasPendingBgTask ||
    prevActiveTool !== t.activeTool ||
    prevBucket !== t.bucket ||
    prevStepsKey !== nextStepsKey
  ) {
    dirty = true;
  }

  // Backup auto-sync reconciler if a running thread finished after boot and Stop hook hasn't pushed yet
  const suppressedByRebindBaseline =
    Number.isInteger(t.reboundBaselineStepIndex) &&
    liveAct.lastStepIndex <= t.reboundBaselineStepIndex;
  if (
    pendingAutoSyncIds &&
    !t.archived &&
    t.runState === 'RUN_STATE_IDLE' &&
    !liveAct.hasPendingBgTask &&
    liveAct.lastStepIndex >= 0 &&
    !suppressedByRebindBaseline &&
    t.lastSyncedStepIndex !== liveAct.lastStepIndex &&
    (wasWorking || (t.createdAt && t.createdAt >= PROCESS_BOOT_ISO))
  ) {
    const finishedMs = Date.parse(t.lastCompletedAt || t.updatedAt || '') || Date.now();
    if (Date.now() - finishedMs >= 8000) {
      pendingAutoSyncIds.push(t.threadId);
    }
  } else if (
    t.runState === 'RUN_STATE_IDLE' &&
    !liveAct.hasPendingBgTask &&
    t.lastSyncedStepIndex === liveAct.lastStepIndex
  ) {
    seenRunningThreadIds.delete(t.threadId);
  }

  return dirty;
}

function applySyncedThreadFieldsToFresh(freshT, syncedT, initialPendingAt) {
  const freshPendingAt = freshT.pendingModelSwitch?.requestedAt || '';
  const hasConcurrentNewSwitch = Boolean(freshPendingAt && freshPendingAt !== initialPendingAt);
  if (initialPendingAt && !syncedT.pendingModelSwitch && freshPendingAt === initialPendingAt) {
    delete freshT.pendingModelSwitch;
  }
  if (!hasConcurrentNewSwitch) {
    freshT.runState = syncedT.runState;
  }
  if (
    syncedT.lastCompletedAt &&
    (!freshT.lastCompletedAt || syncedT.lastCompletedAt > freshT.lastCompletedAt)
  ) {
    freshT.lastCompletedAt = syncedT.lastCompletedAt;
  }
  if (syncedT.lastSummary) freshT.lastSummary = syncedT.lastSummary;
  freshT.archived = syncedT.archived;
  if (syncedT.projectId && !freshT.projectId) freshT.projectId = syncedT.projectId;
  if (syncedT.updatedAt && (!freshT.updatedAt || syncedT.updatedAt > freshT.updatedAt)) {
    freshT.updatedAt = syncedT.updatedAt;
  }
  if (freshT.worktreePath && freshT.worktreePath === syncedT.worktreePath) {
    freshT.git = syncedT.git;
  }
  freshT.hasPendingBgTask = syncedT.hasPendingBgTask;
  freshT.activeTool = syncedT.activeTool;
  freshT.activeToolObj = syncedT.activeToolObj;
  freshT.stepsProgress = syncedT.stepsProgress;
  freshT.stepsList = syncedT.stepsList;
  freshT.toolStepCount = syncedT.toolStepCount;
  freshT.bucket = syncedT.bucket;
  freshT.waitingReason = syncedT.waitingReason;
  if (!hasConcurrentNewSwitch) {
    if (syncedT.modelDisplayName) freshT.modelDisplayName = syncedT.modelDisplayName;
    if (syncedT.resolvedModel) freshT.resolvedModel = syncedT.resolvedModel;
    if (syncedT.modelEnum) freshT.modelEnum = syncedT.modelEnum;
  }
  if (syncedT.usage) {
    freshT.usage = syncedT.usage;
  }
}

/**
 * Targeted single-thread detail lookup with fail-closed project scope validation and localized
 * refresh (only inspects the target thread without triggering a machine-wide syncThreads scan).
 */
export async function getThreadDetail(threadIdOrOpts, optsArg = {}) {
  let opts = {};
  if (threadIdOrOpts && typeof threadIdOrOpts === 'object') {
    opts = { ...threadIdOrOpts, ...(optsArg && typeof optsArg === 'object' ? optsArg : {}) };
  } else {
    opts = {
      threadId: threadIdOrOpts,
      ...(optsArg && typeof optsArg === 'object' ? optsArg : {}),
    };
  }

  const reg = loadRegistry();
  const { thread: t } = await resolveScopedThreadTarget({
    threadId: opts.threadId || '',
    workspacePath: opts.workspacePath || opts.workspace || '',
    workspaceKey: opts.workspaceKey || '',
    coordinatorId: opts.coordinatorId || '',
    conversationId: opts.conversationId || '',
    projectId: opts.projectId || '',
    requireScope: Boolean(opts.requireScope),
    reg,
  });

  const coordinator = t.workspaceKey ? reg.coordinators?.[t.workspaceKey] || null : null;
  const initialPendingAt = t.pendingModelSwitch?.requestedAt || '';
  const becameArchivedIds = new Set();

  let dirty = await syncSingleThreadRecord(t, reg, {
    coordinator,
    becameArchivedIds,
  });
  const modelChanged = await resolveThreadModelInfo(t, {
    convUpdatedAt: t.updatedAt || '',
    convRunState: t.runState || '',
  });
  if (modelChanged) dirty = true;

  let shouldAutoCleanup = false;
  if (dirty) {
    mutateRegistry((freshReg) => {
      const freshT = freshReg.threads?.[t.threadId];
      if (!freshT) return;
      const wasArchivedOnDisk = Boolean(freshT.archived);
      applySyncedThreadFieldsToFresh(freshT, t, initialPendingAt);
      if (
        becameArchivedIds.has(t.threadId) &&
        !wasArchivedOnDisk &&
        t.archived === true &&
        freshT.worktreePath &&
        !autoCleanupInFlight.has(t.threadId)
      ) {
        shouldAutoCleanup = true;
      }
    });
  }

  if (shouldAutoCleanup && !autoCleanupInFlight.has(t.threadId)) {
    autoCleanupInFlight.add(t.threadId);
    try {
      const cleanRes = await cleanupThreadWorktree(t.threadId, {
        forceWorktree: false,
        deleteBranch: true,
      });
      if (cleanRes?.thread) {
        t.worktreePath = cleanRes.thread.worktreePath;
        t.git = cleanRes.thread.git;
        if (cleanRes.thread.updatedAt) t.updatedAt = cleanRes.thread.updatedAt;
      }
    } catch {
      // Non-fatal: cleanup errors must not break detail inspection
    } finally {
      autoCleanupInFlight.delete(t.threadId);
    }
  }

  const latestReg = dirty || shouldAutoCleanup ? loadRegistry() : reg;
  const finalRecord = latestReg.threads?.[t.threadId] || t;
  return decorateThreadRecord({ ...t, ...finalRecord }, latestReg);
}

export function syncThreads({
  workspacePath = '',
  conversationId = '',
  coordinatorId = '',
  projectId = '',
  includeArchived = false,
  allWorkspaces = false,
  backgroundSideEffects = false,
} = {}) {
  const syncSig = JSON.stringify([
    getStateDir(),
    Boolean(allWorkspaces),
    Boolean(includeArchived),
    workspacePath ? normalizeKey(workspacePath) : '',
    String(conversationId || '').trim(),
    String(coordinatorId || '').trim(),
    String(projectId || '').trim(),
    Boolean(backgroundSideEffects),
  ]);
  const existingFlight = syncThreadsInFlight.get(syncSig);
  if (existingFlight) {
    return existingFlight;
  }

  const flight = syncThreadsImpl({
    workspacePath,
    conversationId,
    coordinatorId,
    projectId,
    includeArchived,
    allWorkspaces,
    backgroundSideEffects,
  }).finally(() => {
    if (syncThreadsInFlight.get(syncSig) === flight) {
      syncThreadsInFlight.delete(syncSig);
    }
  });
  syncThreadsInFlight.set(syncSig, flight);
  return flight;
}

async function syncThreadsImpl({
  workspacePath = '',
  conversationId = '',
  coordinatorId = '',
  projectId = '',
  includeArchived = false,
  allWorkspaces = false,
  backgroundSideEffects = false,
} = {}) {
  const reg = loadRegistry();
  let dirty = false;
  let scope = null;
  let coordinator = null;
  let effectiveProjectId = '';
  let resolvedProjectName = '';
  let list = [];

  if (allWorkspaces) {
    list = Object.values(reg.threads).filter((t) => includeArchived || !t.archived);
  } else {
    scope = await resolveProjectScope({
      workspacePath,
      conversationId,
      coordinatorId,
      projectId,
      reg,
    });
    coordinator = scope.scopeKey ? reg.coordinators[scope.scopeKey] || null : null;

    if (coordinator?.conversationId) {
      const coordMeta = await getConversationMetaCached(coordinator.conversationId);
      if (coordMeta.projectId && coordMeta.projectId !== coordinator.projectId) {
        coordinator.projectId = coordMeta.projectId;
        dirty = true;
      }
      if (coordMeta.environmentId && coordMeta.environmentId !== coordinator.environmentId) {
        coordinator.environmentId = coordMeta.environmentId;
        dirty = true;
      }
    }

    effectiveProjectId = scope.projectId || coordinator?.projectId || '';
    resolvedProjectName = effectiveProjectId
      ? effectiveProjectId === scope.projectId
        ? scope.projectName || ''
        : await resolveProjectName(effectiveProjectId)
      : '';
    if (coordinator) {
      if (resolvedProjectName && coordinator.projectName !== resolvedProjectName) {
        coordinator.projectName = resolvedProjectName;
        dirty = true;
      } else if (!resolvedProjectName && coordinator.projectName) {
        coordinator.projectName = '';
        dirty = true;
      }
    }

    // Strict fail-closed filter: never return threads from other projects or unscoped sessions
    if (!scope.scopeKey) {
      list = [];
    } else {
      list = Object.values(reg.threads).filter((t) => {
        if (!includeArchived && t.archived) return false;
        if (t.workspaceKey === scope.scopeKey) return true;
        if (
          coordinator?.conversationId &&
          t.coordinatorId === coordinator.conversationId &&
          t.workspaceKey === scope.scopeKey
        ) {
          return true;
        }
        return false;
      });
    }
  }

  // Archived threads are static persisted snapshots: skip LS GetConversation RPC,
  // Git inspectWorktreeGit, transcript hot scans, and model re-parsing during polling.
  const activeList = list.filter((t) => !t.archived);
  const pendingAutoSyncIds = [];
  const initialPendingSwitchAtById = new Map(
    activeList.map((t) => [t.threadId, t.pendingModelSwitch?.requestedAt || '']),
  );
  const becameArchivedIds = new Set();

  await mapWithConcurrency(activeList, 6, async (t) => {
    const threadDirty = await syncSingleThreadRecord(t, reg, {
      coordinator,
      becameArchivedIds,
      pendingAutoSyncIds,
    });
    if (threadDirty) dirty = true;
  });

  // Resolve concrete model display names for active threads only (bounded concurrency & LRU cache)
  await mapWithConcurrency(activeList, 5, async (t) => {
    const modelChanged = await resolveThreadModelInfo(t, {
      convUpdatedAt: t.updatedAt || '',
      convRunState: t.runState || '',
    });
    if (modelChanged) dirty = true;
  });

  const pendingAutoCleanupIds = [];
  if (dirty) {
    mutateRegistry((freshReg) => {
      if (coordinator && scope?.scopeKey) {
        const freshCoord = freshReg.coordinators?.[scope.scopeKey];
        if (freshCoord && freshCoord.conversationId === coordinator.conversationId) {
          if (coordinator.projectId && coordinator.projectId !== freshCoord.projectId) {
            freshCoord.projectId = coordinator.projectId;
          }
          if (coordinator.projectName !== undefined && coordinator.projectName !== freshCoord.projectName) {
            freshCoord.projectName = coordinator.projectName;
          }
          if (coordinator.environmentId && coordinator.environmentId !== freshCoord.environmentId) {
            freshCoord.environmentId = coordinator.environmentId;
          }
        }
      }
      for (const t of activeList) {
        const freshT = freshReg.threads?.[t.threadId];
        if (!freshT) continue;
        const wasArchivedOnDisk = Boolean(freshT.archived);
        const initialPendingAt = initialPendingSwitchAtById.get(t.threadId) || '';
        applySyncedThreadFieldsToFresh(freshT, t, initialPendingAt);
        if (
          becameArchivedIds.has(t.threadId) &&
          !wasArchivedOnDisk &&
          t.archived === true &&
          freshT.worktreePath &&
          !autoCleanupInFlight.has(t.threadId)
        ) {
          pendingAutoCleanupIds.push(t.threadId);
        }
      }
    });
  }

  const runSideEffects = async () => {
    for (const tid of pendingAutoCleanupIds) {
      if (autoCleanupInFlight.has(tid)) continue;
      autoCleanupInFlight.add(tid);
      try {
        const cleanRes = await cleanupThreadWorktree(tid, {
          forceWorktree: false,
          deleteBranch: true,
        });
        const listItem = list.find((x) => x.threadId === tid);
        if (listItem && cleanRes?.thread) {
          listItem.worktreePath = cleanRes.thread.worktreePath;
          listItem.git = cleanRes.thread.git;
          if (cleanRes.thread.updatedAt) listItem.updatedAt = cleanRes.thread.updatedAt;
        }
      } catch {
        // Non-fatal: safe auto-cleanup failure must never block syncThreads
      } finally {
        autoCleanupInFlight.delete(tid);
      }
    }

    for (const tid of pendingAutoSyncIds) {
      if (autoSyncInFlight.has(tid)) continue;
      autoSyncInFlight.add(tid);
      try {
        const syncRes = await syncCompletionToCoordinator({ threadId: tid, force: false });
        if (syncRes?.ok) {
          seenRunningThreadIds.delete(tid);
        }
      } catch {
        // Non-fatal; next poll or PreInvocation can retry
      } finally {
        autoSyncInFlight.delete(tid);
      }
    }
  };

  if (pendingAutoCleanupIds.length > 0 || pendingAutoSyncIds.length > 0) {
    if (backgroundSideEffects) {
      runSideEffects().catch(() => {});
    } else {
      await runSideEffects();
    }
  }

  list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  // Unconditionally reload fresh registry from disk before building decisions (prevents dismissed decision flicker)
  const latestReg = loadRegistry();
  const scopeSeqCache = new Map();
  const decoratedList = list.map((item) => {
    const decorated = decorateThreadRecord(item, latestReg, scopeSeqCache);
    if (!decorated.archived && decorated.workspaceKey) {
      const wd = getThreadWatchdogSummary(latestReg, decorated.workspaceKey, decorated.threadId);
      if (wd) decorated.watchdog = wd;
    }
    return decorated;
  });

  if (allWorkspaces) {
    return {
      locale: resolveAppLocale(),
      scopeKey: '*',
      scopeKind: 'all',
      projectId: '',
      projectName: '',
      workspaceName: '',
      workspacePath: '',
      scopeTitle: 'All Projects',
      hasWorkspace: false,
      hasGitRepo: false,
      projectLabel: 'All Projects',
      coordinator: null,
      threads: decoratedList,
      decisions: [],
      memory: { path: '', content: '' },
      updatedAt: new Date().toISOString(),
    };
  }

  if (scope.scopeKey) {
    const hygiene = refreshExistingProjectMemoryHygiene(scope.baseDir, scope.scopeKey);
    if (hygiene.upgraded || hygiene.excluded) {
      const broadcastRepoRoot =
        scope.info?.mainRepoRoot || scope.info?.repoRoot || coordinator?.repoRoot || scope.baseDir;
      for (const t of Object.values(latestReg.threads || {})) {
        if (!t.archived && t.workspaceKey === scope.scopeKey && t.worktreePath) {
          syncRulesIntoWorktree({
            repoRoot: broadcastRepoRoot,
            scopeKey: scope.scopeKey,
            worktreePath: t.worktreePath,
            thread: t,
          });
        }
      }
    }
  }
  const memory = scope.scopeKey
    ? readProjectMemory(scope.baseDir, scope.scopeKey)
    : { path: '', content: '', topics: [], budget: evaluateIndexBudget(''), migration: null };
  const hasGitRepo = Boolean(
    scope.info?.mainRepoRoot || scope.info?.repoRoot || coordinator?.repoRoot,
  );
  const workspacePathResolved =
    scope.baseDir || coordinator?.repoRoot || coordinator?.workspacePath || '';
  const workspaceName =
    scope.workspaceName || (workspacePathResolved ? basename(workspacePathResolved) : '');
  const fallbackLabel =
    workspaceName ||
    scope.label ||
    (coordinator?.title ? stripCoordinatorTitlePrefix(coordinator.title) : '');
  const display = resolveScopeDisplayNames({
    projectName: resolvedProjectName,
    workspaceName,
    fallbackLabel,
  });
  const scopeTitle = display.scopeTitle;
  const projectLabel = scopeTitle;
  const appLocale = resolveAppLocale();
  const decisions = scope.scopeKey
    ? buildBoardDecisions(
        {
          scopeKey: scope.scopeKey,
          projectId: effectiveProjectId,
          coordinatorId: coordinator?.conversationId || '',
        },
        decoratedList,
        { reg: latestReg, locale: appLocale },
      )
    : [];

  let coordinatorTurnStamp = '';
  if (coordinator?.conversationId) {
    const txModel = extractTranscriptModel(coordinator.conversationId);
    coordinatorTurnStamp = [
      coordinator.conversationId,
      Number(coordinator.lastStepCount) || 0,
      txModel.displayName || '',
      txModel.modelSlug || '',
    ].join('|');
  }

  const watchdogSummary = scope.scopeKey
    ? buildWatchdogBoardSummary(latestReg, loadSettings(), scope.scopeKey, workspacePathResolved)
    : null;

  return {
    locale: appLocale,
    scopeKey: scope.scopeKey,
    scopeKind: scope.scopeKind,
    projectId: effectiveProjectId,
    projectName: display.projectName,
    workspaceName: display.workspaceName,
    workspacePath: workspacePathResolved,
    scopeTitle,
    hasWorkspace: Boolean(scope.baseDir),
    hasGitRepo,
    projectLabel,
    coordinator,
    coordinatorTurnStamp,
    threads: decoratedList,
    decisions,
    watchdog: watchdogSummary,
    memory,
    updatedAt: new Date().toISOString(),
  };
}

function assertCoordinatorScopeForMemoryWrite(reg, scopeKey, { coordinatorId = '', conversationId = '' } = {}) {
  assertNotRetiredCoordinator(reg, { coordinatorId, conversationId });
  const callerIds = [coordinatorId, conversationId]
    .map((x) => String(x || '').trim())
    .filter(Boolean);
  if (!callerIds.length || !scopeKey) return;
  for (const c of Object.values(reg.coordinators || {})) {
    if (!c || !c.conversationId) continue;
    if (callerIds.includes(c.conversationId)) {
      if (c.key && !isSameScopeKey(c.key, scopeKey)) {
        throw new Error(
          `Cross-project access denied: coordinator "${c.conversationId}" belongs to a different project scope than "${scopeKey}".`,
        );
      }
    }
  }
}

function broadcastMemoryToActiveWorktrees(reg, scope) {
  const repoRoot = scope.info?.mainRepoRoot || scope.info?.repoRoot || scope.baseDir || '';
  for (const t of Object.values(reg.threads || {})) {
    if (!t.archived && t.workspaceKey === scope.scopeKey && t.worktreePath) {
      try {
        syncRulesIntoWorktree({
          repoRoot,
          scopeKey: scope.scopeKey,
          worktreePath: t.worktreePath,
          thread: t,
        });
      } catch {
        // Isolate per-worktree transient lock/permission errors so other worktrees still sync
      }
    }
  }
}

export async function updateProjectMemory({
  workspacePath = '',
  workspaceKey = '',
  conversationId = '',
  coordinatorId = '',
  projectId = '',
  content = '',
  mode = 'append',
  section = 'Active Decisions & Constraints',
  topic = '',
  title = '',
  summary = '',
  keywords,
  createOnly = false,
} = {}) {
  const reg = loadRegistry();
  const rawTopic = String(topic || '').trim();
  const rawMode = String(mode || 'append').trim().toLowerCase();
  const effectiveCreateOnly = Boolean(createOnly) || rawMode === 'create';
  const normalizedMode =
    rawMode === 'write' || rawMode === 'upsert' || rawMode === 'create'
      ? 'replace'
      : rawMode === 'remove'
        ? 'delete'
        : rawMode;

  if (!['read', 'list', 'append', 'replace', 'delete'].includes(normalizedMode)) {
    throw new Error(
      `Unsupported memory mode "${mode}". Expected one of: read, list, append, replace, delete.`,
    );
  }

  let scope = await resolveProjectScope({
    workspacePath,
    conversationId: conversationId || coordinatorId,
    coordinatorId,
    projectId,
    reg,
  });
  if (!scope.scopeKey && workspaceKey) {
    const matchedCoord =
      reg.coordinators?.[workspaceKey] ||
      Object.values(reg.coordinators || {}).find((c) => isSameScopeKey(c?.key, workspaceKey)) ||
      null;
    if (matchedCoord) {
      scope = await resolveProjectScope({
        workspacePath: matchedCoord.repoRoot || matchedCoord.workspacePath || '',
        coordinatorId: matchedCoord.conversationId || '',
        projectId: matchedCoord.projectId || '',
        reg,
      });
    }
  }

  if (!scope.scopeKey) {
    if (normalizedMode === 'read' || normalizedMode === 'list') {
      return {
        path: '',
        content: '',
        topics: [],
        budget: evaluateIndexBudget(''),
        budgetWarning: '',
        migration: null,
      };
    }
    throw new Error('Provide workspacePath or conversationId to update project memory.');
  }

  if (normalizedMode === 'read' || normalizedMode === 'list') {
    refreshExistingProjectMemoryHygiene(scope.baseDir, scope.scopeKey);
    if (normalizedMode === 'list') {
      const mem = readProjectMemory(scope.baseDir, scope.scopeKey);
      return { ...mem, action: 'list' };
    }
    if (rawTopic) {
      const topicRec = readMemoryTopic(scope.baseDir, scope.scopeKey, rawTopic);
      const mem = readProjectMemory(scope.baseDir, scope.scopeKey);
      return {
        action: 'read_topic',
        topic: topicRec,
        path: topicRec.path,
        content: topicRec.content,
        topics: mem.topics,
        budget: mem.budget,
        budgetWarning: mem.budgetWarning,
        migration: mem.migration,
      };
    }
    return readProjectMemory(scope.baseDir, scope.scopeKey);
  }

  assertCoordinatorScopeForMemoryWrite(reg, scope.scopeKey, { coordinatorId, conversationId });
  const projectLabel = scope.label || (scope.baseDir ? basename(scope.baseDir) : 'Project');

  if (normalizedMode === 'delete') {
    if (!rawTopic) {
      throw new Error('`topic` is required when mode="delete".');
    }
    const delRes = deleteMemoryTopic({
      baseDir: scope.baseDir,
      scopeKey: scope.scopeKey,
      projectName: projectLabel,
      topic: rawTopic,
    });
    broadcastMemoryToActiveWorktrees(reg, scope);
    return {
      action: 'delete_topic',
      ...delRes,
    };
  }

  if (rawTopic) {
    const saved = writeMemoryTopic({
      baseDir: scope.baseDir,
      scopeKey: scope.scopeKey,
      projectName: projectLabel,
      topic: rawTopic,
      title,
      summary,
      keywords,
      content,
      mode: normalizedMode,
      section: section === 'Active Decisions & Constraints' ? '' : section,
      createOnly: effectiveCreateOnly,
    });
    broadcastMemoryToActiveWorktrees(reg, scope);
    return {
      action: 'save_topic',
      ...saved,
    };
  }

  const memPath = ensureProjectMemoryFile(scope.baseDir, projectLabel, scope.scopeKey);

  withMemoryLock(memPath, () => {
    if (normalizedMode === 'replace') {
      writeMemoryFileAtomic(memPath, content);
      // If topic files exist on disk and the caller omitted the topic table, keep existing topics synced
      const diskTopics = listMemoryTopics(scope.baseDir, scope.scopeKey, { indexMarkdown: content });
      if (diskTopics.length > 0 && !parseTopicIndexTable(content).hasTable) {
        syncTopicIndexInThinMemory(scope.baseDir, scope.scopeKey, projectLabel);
      }
    } else if (content && content.trim()) {
      const current = readFileSync(memPath, 'utf8');
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const bullet = content.trim().startsWith('-') ? content.trim() : `- [${stamp}] ${content.trim()}`;
      const header = `## ${section}`;
      let next;
      if (current.includes(header)) {
        next = current.replace(header, `${header}\n${bullet}`);
      } else {
        next = `${current.trimEnd()}\n\n${header}\n${bullet}\n`;
      }
      writeMemoryFileAtomic(memPath, next);
    }
  });

  if (scope.baseDir) {
    ensureGitExcludeSync(scope.baseDir, REPO_MEMORY_EXCLUDE_PATTERNS);
  }
  broadcastMemoryToActiveWorktrees(reg, scope);

  const finalMem = readProjectMemory(scope.baseDir, scope.scopeKey);
  return {
    action: 'save_index',
    ...finalMem,
  };
}

export async function migrateProjectMemory({
  workspacePath = '',
  workspaceKey = '',
  conversationId = '',
  coordinatorId = '',
  projectId = '',
  action = '',
} = {}) {
  const normAction = String(action || '').trim().toLowerCase();
  if (!['archive_legacy', 'request_coordinator_split'].includes(normAction)) {
    throw new Error(
      `Unsupported memory migration action "${action}". Expected "archive_legacy" or "request_coordinator_split".`,
    );
  }

  const reg = loadRegistry();
  assertNotRetiredCoordinator(reg, { coordinatorId, conversationId });

  let scope = await resolveProjectScope({
    workspacePath,
    conversationId: conversationId || coordinatorId,
    coordinatorId,
    projectId,
    reg,
  });
  if (!scope.scopeKey && workspaceKey) {
    const matchedCoord =
      reg.coordinators?.[workspaceKey] ||
      Object.values(reg.coordinators || {}).find((c) => isSameScopeKey(c?.key, workspaceKey)) ||
      null;
    if (matchedCoord) {
      scope = await resolveProjectScope({
        workspacePath: matchedCoord.repoRoot || matchedCoord.workspacePath || '',
        coordinatorId: matchedCoord.conversationId || '',
        projectId: matchedCoord.projectId || '',
        reg,
      });
    }
  }
  if (!scope.scopeKey) {
    throw new Error('Unable to resolve project scope for memory migration (fail-closed).');
  }

  assertCoordinatorScopeForMemoryWrite(reg, scope.scopeKey, { coordinatorId, conversationId });
  const projectLabel = scope.label || (scope.baseDir ? basename(scope.baseDir) : 'Project');

  if (normAction === 'archive_legacy') {
    const res = archiveMemoryToLegacyTopic({
      baseDir: scope.baseDir,
      scopeKey: scope.scopeKey,
      projectName: projectLabel,
    });
    broadcastMemoryToActiveWorktrees(reg, scope);
    return {
      ok: true,
      action: 'archive_legacy',
      scopeKey: scope.scopeKey,
      ...res,
    };
  }

  // normAction === 'request_coordinator_split'
  // Strict scope-bound lookup: NEVER fall back to an unregistered caller conversationId.
  const coordRecord = lookupCoordinatorForScope(reg, {
    scopeKey: scope.scopeKey,
    workspacePath: workspacePath || scope.baseDir || '',
    projectId: projectId || scope.projectId || '',
  });
  const registeredCoordId = String(coordRecord?.conversationId || '').trim();
  if (
    !coordRecord ||
    !registeredCoordId ||
    (coordRecord.key && !isSameScopeKey(coordRecord.key, scope.scopeKey))
  ) {
    throw new Error(
      'No registered active Coordinator conversation found for this project scope. Bind a Coordinator first.',
    );
  }
  const explicitCallerCoordId = String(coordinatorId || '').trim();
  if (explicitCallerCoordId && explicitCallerCoordId !== registeredCoordId) {
    throw new Error(
      `Target coordinator "${explicitCallerCoordId}" does not match the active Coordinator for this project scope.`,
    );
  }
  const isWorkerTarget = Object.values(reg.threads || {}).some(
    (t) => t?.conversationId === registeredCoordId,
  );
  if (isWorkerTarget) {
    throw new Error('Cannot send memory split request to a Worker Thread conversation.');
  }
  assertNotRetiredCoordinator(reg, { coordinatorId: registeredCoordId });

  const targetCoordId = registeredCoordId;
  const targetProjectId = coordRecord?.projectId || scope.projectId || '';
  const mem = readProjectMemory(scope.baseDir, scope.scopeKey);
  const locale = resolveAppLocale();
  const repoDisplay = scope.baseDir || coordRecord?.repoRoot || coordRecord?.workspacePath || '';
  const lines =
    locale === 'en'
      ? [
          '[MEMORY_MIGRATION_REQUEST] The user requested semantic refactoring of the oversized flat project-memory.md into the two-tier "thin index + on-demand topic knowledge" layout:',
          repoDisplay ? `- Workspace: \`${repoDisplay}\`` : '',
          `- Coordinator ID: \`${targetCoordId}\``,
          mem.path ? `- Source Memory File: \`${mem.path}\` (${mem.budget.lineCount} lines, ${mem.budget.byteSize} bytes)` : '',
          '- Instructions:',
          '  1. Call `update_project_memory(mode="read")` to inspect the full current `project-memory.md`.',
          '  2. Group module-specific contracts, invariants, and notes into semantic topics (e.g. `ls-rpc`, `sidecar-ui`, `registry-concurrency`) and write each via `update_project_memory(topic="<id>", title="...", keywords=[...], summary="...", mode="replace", content="...")` without losing important rules.',
          '  3. Rewrite `.agents/rules/project-memory.md` via `update_project_memory(mode="replace", content="...")` into a concise thin index (`<= 60` lines) keeping global hard guardrails, Worktree merge conventions, and the auto-maintained Topic Knowledge Index.',
          '  4. Report the created topics and thin-index reduction summary back to the user.',
        ].filter(Boolean)
      : [
          '[MEMORY_MIGRATION_REQUEST] 用户在右侧知识库看板触发了「智能拆分共享记忆」请求，请将当前超长的扁平 `project-memory.md` 无损重构为「薄索引 + 按需专题知识库」双层架构：',
          repoDisplay ? `- 项目工作区: \`${repoDisplay}\`` : '',
          `- 总控会话 ID: \`${targetCoordId}\``,
          mem.path ? `- 当前记忆文件: \`${mem.path}\`（共 ${mem.budget.lineCount} 行 / ${mem.budget.byteSize} 字节）` : '',
          '- 执行步骤：',
          '  1. 先调用 `update_project_memory(mode="read")` 读取当前完整 `project-memory.md`。',
          '  2. 按模块与领域语义将详细契约、并发不变量与排错笔记拆分为若干专题，逐篇调用 `update_project_memory(topic="<kebab-id>", title="...", keywords=[...], summary="...", mode="replace", content="...")` 无损沉淀至 `.agents/memory/<topic>.md`。',
          '  3. 调用 `update_project_memory(mode="replace", content="...")` 将 `.agents/rules/project-memory.md` 精简为 ≤ 60 行的常驻薄索引（仅保留全局硬红线、Worktree 合入规范与自动维护的专题索引表）。',
          '  4. 完成后向用户简洁汇报新建专题清单与薄索引精简前后的行数变化。',
        ].filter(Boolean);

  const fullMessage = lines.join('\n');
  const sendTitle =
    locale === 'en' ? '[Memory] Split project-memory into topics' : '[记忆升级] 语义拆分共享项目记忆';

  try {
    await invokeAgentApiSend({
      conversationId: targetCoordId,
      message: fullMessage,
      title: sendTitle,
      projectId: targetProjectId,
      timeoutMs: 12000,
    });
  } catch (err) {
    if (targetProjectId && !err.isTimeout && err.code !== 'ENOENT') {
      await invokeAgentApiSend({
        conversationId: targetCoordId,
        message: fullMessage,
        title: sendTitle,
        projectId: '',
        timeoutMs: 10000,
      });
    } else {
      throw err;
    }
  }

  return {
    ok: true,
    action: 'request_coordinator_split',
    scopeKey: scope.scopeKey,
    coordinatorId: targetCoordId,
    sentAt: new Date().toISOString(),
  };
}

async function resolveThreadRepoRoot(t, reg) {
  const candidates = [
    t.repoRoot,
    t.workspaceKey ? reg?.coordinators?.[t.workspaceKey]?.repoRoot : '',
    t.workspacePath,
  ].filter(Boolean);
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    const info = await resolveRepoInfo(c);
    if (info.mainRepoRoot || info.repoRoot) {
      return info.mainRepoRoot || info.repoRoot;
    }
  }
  if (t.worktreePath && existsSync(t.worktreePath)) {
    const info = await resolveRepoInfo(t.worktreePath);
    if (info.mainRepoRoot || info.repoRoot) {
      return info.mainRepoRoot || info.repoRoot;
    }
  }
  return '';
}

async function resolveCleanupBaseRef(repoRoot, preferredRefOrOpts = '') {
  const opts =
    preferredRefOrOpts && typeof preferredRefOrOpts === 'object'
      ? preferredRefOrOpts
      : { preferredRef: preferredRefOrOpts };
  return resolveBaseBranchRef(repoRoot, opts);
}

async function getCheckedOutWorktreeBranches(repoRoot) {
  const branches = new Set();
  const res = await runGitResult(['worktree', 'list', '--porcelain'], repoRoot, 8000);
  if (res.ok) {
    for (const line of res.stdout.split(/\r?\n/)) {
      const m = line.match(/^branch\s+refs\/heads\/(.+)$/);
      if (m) branches.add(m[1].trim());
    }
  }
  const headRes = await runGitResult(['symbolic-ref', '--quiet', 'HEAD'], repoRoot, 5000);
  if (headRes.ok) {
    const m = headRes.stdout.trim().match(/^refs\/heads\/(.+)$/);
    if (m) branches.add(m[1].trim());
  }
  return branches;
}

async function checkBranchMerged(repoRoot, { targetBranch, headSha, baseRef }) {
  if (!baseRef) {
    return {
      ok: false,
      merged: false,
      mergeMethod: '',
      error: 'Could not resolve base branch or HEAD for merge check.',
    };
  }
  const refsToCheck = [];
  if (targetBranch) {
    const existsRes = await runGitResult(
      ['show-ref', '--verify', `refs/heads/${targetBranch}`],
      repoRoot,
      5000,
    );
    if (existsRes.ok) {
      refsToCheck.push({ label: targetBranch, ref: `refs/heads/${targetBranch}`, sha: existsRes.stdout.trim() });
    }
  }
  if (headSha && !refsToCheck.some((r) => r.sha === headSha)) {
    refsToCheck.push({ label: headSha.slice(0, 7), ref: headSha, sha: headSha });
  }
  let usedCherryPick = false;
  for (const item of refsToCheck) {
    const ancRes = await runGitResult(
      ['merge-base', '--is-ancestor', item.ref, baseRef],
      repoRoot,
      8000,
    );
    if (ancRes.ok) continue;
    if (ancRes.code === 1) {
      const cherryCheck = await checkCherryPickMerged(repoRoot, baseRef, item.ref);
      if (cherryCheck.ok && cherryCheck.cherryMerged) {
        usedCherryPick = true;
        continue;
      }
      if (!cherryCheck.ok && cherryCheck.error) {
        return {
          ok: false,
          merged: false,
          mergeMethod: '',
          error: cherryCheck.error,
        };
      }
      return {
        ok: true,
        merged: false,
        mergeMethod: '',
        error: `Branch "${item.label}" has unmerged commit(s) not in "${baseRef}".`,
      };
    }
    return {
      ok: false,
      merged: false,
      mergeMethod: '',
      error: ancRes.error || `Failed to verify merge status of "${item.label}" against "${baseRef}".`,
    };
  }
  return {
    ok: true,
    merged: true,
    mergeMethod: usedCherryPick ? 'cherry-pick' : 'merge',
    error: '',
  };
}

async function tryDeleteThreadBranch({
  repoRoot,
  branch,
  baseRef,
  forceWorktree,
  forceDeleteBranch = false,
}) {
  if (!repoRoot || !branch || !existsSync(repoRoot)) {
    return { deleted: false, error: '' };
  }
  if (branch === baseRef || branch === 'HEAD') {
    return { deleted: false, error: '' };
  }
  const existsRes = await runGitResult(
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    repoRoot,
    5000,
  );
  if (!existsRes.ok) {
    return { deleted: false, error: '' };
  }
  const checkedOut = await getCheckedOutWorktreeBranches(repoRoot);
  if (checkedOut.has(branch)) {
    return { deleted: false, error: '' };
  }
  const delFlag = forceWorktree || forceDeleteBranch ? '-D' : '-d';
  const delRes = await runGitResult(['branch', delFlag, branch], repoRoot, 8000);
  if (delRes.ok) {
    return { deleted: true, error: '' };
  }
  return { deleted: false, error: delRes.error || `Failed to delete branch ${branch}` };
}

function clearThreadWorktreeFields(threadId, convId) {
  return mutateRegistry((freshReg) => {
    const freshT =
      freshReg.threads[threadId] ||
      Object.values(freshReg.threads).find((x) => x.conversationId === convId);
    if (freshT) {
      freshT.worktreePath = '';
      freshT.git = null;
      freshT.updatedAt = new Date().toISOString();
      return freshT;
    }
    return null;
  });
}

function makeCleanupResult(t, overrides = {}) {
  return {
    ok: true,
    threadId: t.threadId,
    worktreeRemoved: false,
    branchDeleted: false,
    pruned: false,
    skippedReason: '',
    worktreeError: '',
    removedWorktreePath: '',
    deletedBranch: '',
    thread: t,
    ...overrides,
  };
}

function makeRemoveFailureResult(t, rawError) {
  const errText = rawError || 'git worktree remove failed';
  const isLock = WORKTREE_LOCK_ERR_RE.test(errText);
  return makeCleanupResult(t, {
    ok: false,
    skippedReason: isLock ? 'file_locked' : 'remove_failed',
    worktreeError: isLock
      ? `Worktree directory is locked or in use by another process (close terminals or editors inside it and retry): ${errText}`
      : errText,
  });
}

async function finalizeWorktreeRemoval({
  t,
  repoRoot,
  branch,
  baseRef,
  forceWorktree,
  forceDeleteBranch = false,
  deleteBranch,
  worktreePath,
}) {
  await runGitResult(['worktree', 'prune'], repoRoot, 10000);
  let branchDeleted = false;
  let branchError = '';
  if (deleteBranch && branch) {
    const brRes = await tryDeleteThreadBranch({
      repoRoot,
      branch,
      baseRef,
      forceWorktree,
      forceDeleteBranch,
    });
    branchDeleted = brRes.deleted;
    branchError = brRes.error;
  }
  const updated = clearThreadWorktreeFields(t.threadId, t.conversationId) || {
    ...t,
    worktreePath: '',
    git: null,
  };
  return makeCleanupResult(updated, {
    worktreeRemoved: true,
    branchDeleted,
    worktreeError: branchError,
    removedWorktreePath: worktreePath,
    deletedBranch: branchDeleted ? branch : '',
  });
}

export async function cleanupThreadWorktree(threadIdOrOpts, optsArg = {}) {
  let threadId = threadIdOrOpts;
  let opts = optsArg;
  if (threadIdOrOpts && typeof threadIdOrOpts === 'object') {
    threadId = threadIdOrOpts.threadId;
    opts = { ...threadIdOrOpts, ...optsArg };
  }
  const {
    forceWorktree = false,
    deleteBranch = true,
    workspacePath = '',
    workspace = '',
    workspaceKey = '',
    coordinatorId = '',
    conversationId = '',
    projectId = '',
    requireScope = false,
  } = opts || {};

  if (!threadId) {
    throw new Error('`threadId` is required.');
  }

  const reg = loadRegistry();
  assertNotRetiredCoordinator(reg, {
    coordinatorId: coordinatorId || opts?.coordinatorId || '',
    conversationId: conversationId || opts?.conversationId || '',
  });
  const { thread: t } = await resolveScopedThreadTarget({
    threadId,
    workspacePath: workspacePath || workspace,
    workspaceKey,
    coordinatorId,
    conversationId,
    projectId,
    requireScope: Boolean(requireScope),
    reg,
  });

  const worktreePath = t.worktreePath || '';
  const storedBranch = t.branch || t.git?.branch || '';

  if (!worktreePath) {
    const updated = t.git !== null ? clearThreadWorktreeFields(t.threadId, t.conversationId) || t : t;
    return makeCleanupResult(updated);
  }

  const repoRoot = await resolveThreadRepoRoot(t, reg);
  const coordDefaultBranch = resolveThreadCoordDefaultBranch(t, reg);

  // Already-missing directory: prune stale Git worktree metadata and clear registry
  if (!existsSync(worktreePath)) {
    let branchDeleted = false;
    let branchError = '';
    if (repoRoot && existsSync(repoRoot)) {
      await runGitResult(['worktree', 'prune'], repoRoot, 10000);
      if (deleteBranch && storedBranch) {
        const resolvedBase = await resolveCleanupBaseRef(repoRoot, {
          preferredRef: t.baseRef,
          defaultBranch: coordDefaultBranch,
          excludeBranch: storedBranch,
        });
        const mergeCheck = forceWorktree
          ? { ok: true, merged: true, mergeMethod: '' }
          : await checkBranchMerged(repoRoot, {
              targetBranch: storedBranch,
              headSha: '',
              baseRef: resolvedBase,
            });
        if (mergeCheck.ok && mergeCheck.merged) {
          const brRes = await tryDeleteThreadBranch({
            repoRoot,
            branch: storedBranch,
            baseRef: resolvedBase,
            forceWorktree,
            forceDeleteBranch: mergeCheck.mergeMethod === 'cherry-pick',
          });
          branchDeleted = brRes.deleted;
          branchError = brRes.error;
        }
      }
    }
    const updated = clearThreadWorktreeFields(t.threadId, t.conversationId) || {
      ...t,
      worktreePath: '',
      git: null,
    };
    return makeCleanupResult(updated, {
      branchDeleted,
      pruned: true,
      skippedReason: 'already_missing',
      worktreeError: branchError,
      removedWorktreePath: worktreePath,
      deletedBranch: branchDeleted ? storedBranch : '',
    });
  }

  if (!repoRoot || !existsSync(repoRoot)) {
    return makeCleanupResult(t, {
      ok: false,
      skippedReason: 'missing_repo_root',
      worktreeError: 'Could not locate Git repository root for worktree.',
    });
  }

  // If a prior interrupted/locked removal already removed .git inside worktreePath, clean up the leftover folder safely
  if (!existsSync(join(worktreePath, '.git'))) {
    const resolvedBase = await resolveCleanupBaseRef(repoRoot, {
      preferredRef: t.baseRef,
      defaultBranch: coordDefaultBranch,
      excludeBranch: storedBranch,
    });
    let entries = [];
    try {
      entries = readdirSync(worktreePath);
    } catch {
      entries = [];
    }
    if (entries.length > 0 && !forceWorktree) {
      return makeCleanupResult(t, {
        ok: false,
        skippedReason: 'not_a_worktree',
        worktreeError:
          'Worktree directory is missing .git metadata and is not empty (use forceWorktree=true to delete).',
      });
    }
    let mergeMethod = '';
    if (!forceWorktree && storedBranch) {
      const mergeCheck = await checkBranchMerged(repoRoot, {
        targetBranch: storedBranch,
        headSha: '',
        baseRef: resolvedBase,
      });
      if (!mergeCheck.ok) {
        return makeCleanupResult(t, {
          ok: false,
          skippedReason: 'merge_check_failed',
          worktreeError: mergeCheck.error,
        });
      }
      if (!mergeCheck.merged) {
        return makeCleanupResult(t, {
          skippedReason: 'unmerged_commits',
          worktreeError: mergeCheck.error,
        });
      }
      mergeMethod = mergeCheck.mergeMethod || '';
    }
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch (rmErr) {
      return makeRemoveFailureResult(t, rmErr?.message || 'Failed to remove leftover worktree directory');
    }
    return finalizeWorktreeRemoval({
      t,
      repoRoot,
      branch: storedBranch,
      baseRef: resolvedBase,
      forceWorktree,
      forceDeleteBranch: mergeMethod === 'cherry-pick',
      deleteBranch,
      worktreePath,
    });
  }

  const headBranchRes = await runGitResult(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath, 5000);
  const headShaRes = await runGitResult(['rev-parse', 'HEAD'], worktreePath, 5000);
  const checkedBranch = headBranchRes.ok ? headBranchRes.stdout.trim() : '';
  const targetBranch = checkedBranch && checkedBranch !== 'HEAD' ? checkedBranch : storedBranch;
  const wtHeadSha = headShaRes.ok ? headShaRes.stdout.trim() : '';
  const resolvedBase = await resolveCleanupBaseRef(repoRoot, {
    preferredRef: t.baseRef,
    defaultBranch: coordDefaultBranch,
    excludeBranch: targetBranch,
  });

  let hadOnlyInjectedUntracked = false;
  let mergeMethod = '';
  if (!forceWorktree) {
    const statusRes = await runGitResult(['status', '--porcelain', '-uall'], worktreePath, 8000);
    if (!statusRes.ok) {
      return makeCleanupResult(t, {
        ok: false,
        skippedReason: 'status_failed',
        worktreeError: statusRes.error || 'Failed to inspect worktree cleanliness.',
      });
    }
    const rawLines = statusRes.stdout.split(/\r?\n/).filter((l) => l.trim());
    const dirtyLines = rawLines.filter((l) => !INJECTED_RULE_UNTRACKED_RE.test(l));
    if (dirtyLines.length > 0) {
      return makeCleanupResult(t, {
        skippedReason: 'uncommitted_changes',
        worktreeError: `Worktree has ${dirtyLines.length} uncommitted change(s).`,
      });
    }
    hadOnlyInjectedUntracked = rawLines.length > 0;

    const mergeCheck = await checkBranchMerged(repoRoot, {
      targetBranch,
      headSha: wtHeadSha,
      baseRef: resolvedBase,
    });
    if (!mergeCheck.ok) {
      return makeCleanupResult(t, {
        ok: false,
        skippedReason: 'merge_check_failed',
        worktreeError: mergeCheck.error,
      });
    }
    if (!mergeCheck.merged) {
      return makeCleanupResult(t, {
        skippedReason: 'unmerged_commits',
        worktreeError: mergeCheck.error,
      });
    }
    mergeMethod = mergeCheck.mergeMethod || '';
  }

  if (hadOnlyInjectedUntracked) {
    await appendWorktreeExclude(worktreePath, WORKTREE_MEMORY_EXCLUDE_PATTERNS);
  }

  const removeArgs = forceWorktree
    ? ['worktree', 'remove', '--force', worktreePath]
    : ['worktree', 'remove', worktreePath];
  const removeRes = await runGitResult(removeArgs, repoRoot, 20000);

  if (!removeRes.ok && existsSync(worktreePath)) {
    return makeRemoveFailureResult(t, removeRes.error);
  }

  return finalizeWorktreeRemoval({
    t,
    repoRoot,
    branch: targetBranch,
    baseRef: resolvedBase,
    forceWorktree,
    forceDeleteBranch: mergeMethod === 'cherry-pick',
    deleteBranch,
    worktreePath,
  });
}

export async function archiveThread(threadIdOrOpts, optsArg = {}) {
  let threadId = threadIdOrOpts;
  let opts = optsArg;
  if (threadIdOrOpts && typeof threadIdOrOpts === 'object') {
    threadId = threadIdOrOpts.threadId;
    opts = { ...threadIdOrOpts, ...optsArg };
  }
  const {
    removeWorktree = true,
    forceWorktree = false,
    deleteBranch = true,
    workspacePath = '',
    workspace = '',
    workspaceKey = '',
    coordinatorId = '',
    conversationId = '',
    projectId = '',
    requireScope = false,
  } = opts || {};

  if (!threadId) {
    throw new Error('`threadId` is required.');
  }

  const reg = loadRegistry();
  assertNotRetiredCoordinator(reg, {
    coordinatorId: coordinatorId || opts?.coordinatorId || '',
    conversationId: conversationId || opts?.conversationId || '',
  });
  const { thread: t } = await resolveScopedThreadTarget({
    threadId,
    workspacePath: workspacePath || workspace,
    workspaceKey,
    coordinatorId,
    conversationId,
    projectId,
    requireScope: Boolean(requireScope),
    reg,
  });

  try {
    await updateConversation(t.conversationId, { archived: true });
  } catch {
    // Ignore if already archived/deleted
  }

  const archivedAt = new Date().toISOString();
  t.archived = true;
  t.updatedAt = archivedAt;
  if (t.runState === 'RUN_STATE_RUNNING') {
    t.runState = 'RUN_STATE_IDLE';
    if (!t.lastCompletedAt) t.lastCompletedAt = archivedAt;
  }
  // Seal terminal snapshot locally (zero LS RPC, zero Git, zero transcript_full reads)
  // because syncThreads() skips archived threads during hot polling.
  const archivedLiveAct = peekLiveActivity(t.conversationId, { runState: 'RUN_STATE_IDLE' });
  try {
    await resolveThreadModelInfo(t, {
      forceLsCheck: false,
      convUpdatedAt: archivedAt,
      convRunState: t.runState || 'RUN_STATE_IDLE',
    });
  } catch {
    // Non-fatal: archiving must succeed even if offline transcript metadata is unreadable
  }

  seenRunningThreadIds.delete(t.threadId);
  mutateRegistry((freshReg) => {
    const freshT =
      freshReg.threads[t.threadId] ||
      Object.values(freshReg.threads).find((x) => x.conversationId === t.conversationId);
    if (freshT) {
      freshT.archived = true;
      freshT.updatedAt = archivedAt;
      if (freshT.runState === 'RUN_STATE_RUNNING') {
        freshT.runState = 'RUN_STATE_IDLE';
        if (!freshT.lastCompletedAt) freshT.lastCompletedAt = archivedAt;
      }
      freshT.hasPendingBgTask = false;
      freshT.activeTool = '';
      freshT.activeToolObj = null;
      freshT.bucket = 'archived';
      freshT.waitingReason = '';
      if (archivedLiveAct.lastSummary && !freshT.lastSummary) {
        freshT.lastSummary = archivedLiveAct.lastSummary;
      }
      if (archivedLiveAct.toolStepCount > 0 && !(Number(freshT.toolStepCount) > 0)) {
        freshT.toolStepCount = archivedLiveAct.toolStepCount;
      }
      if (archivedLiveAct.stepsProgress && !freshT.stepsProgress) {
        freshT.stepsProgress = archivedLiveAct.stepsProgress;
      }
      if (archivedLiveAct.stepsList && !freshT.stepsList) {
        freshT.stepsList = archivedLiveAct.stepsList;
      }
      if (t.modelDisplayName && !freshT.modelDisplayName) {
        freshT.modelDisplayName = t.modelDisplayName;
      }
      if (t.resolvedModel && !freshT.resolvedModel) {
        freshT.resolvedModel = t.resolvedModel;
      }
      if (t.modelEnum && !freshT.modelEnum) {
        freshT.modelEnum = t.modelEnum;
      }
      if (t.usage && !freshT.usage) {
        freshT.usage = t.usage;
      }
      clearThreadWatchdogInReg(freshReg, {
        workspaceKey: freshT.workspaceKey,
        threadId: freshT.threadId,
        nowIso: archivedAt,
      });
    }
  });
  t.hasPendingBgTask = false;
  t.activeTool = '';
  t.activeToolObj = null;
  t.bucket = 'archived';
  t.waitingReason = '';
  if (archivedLiveAct.lastSummary && !t.lastSummary) t.lastSummary = archivedLiveAct.lastSummary;
  if (archivedLiveAct.toolStepCount > 0 && !(Number(t.toolStepCount) > 0)) {
    t.toolStepCount = archivedLiveAct.toolStepCount;
  }

  let cleanup = {
    ok: true,
    threadId: t.threadId,
    worktreeRemoved: false,
    branchDeleted: false,
    pruned: false,
    skippedReason: '',
    worktreeError: '',
    removedWorktreePath: '',
    deletedBranch: '',
    thread: t,
  };

  if (removeWorktree && t.worktreePath) {
    cleanup = await cleanupThreadWorktree(t.threadId, { forceWorktree, deleteBranch });
  }

  const finalThread =
    mutateRegistry((freshReg) => {
      const rec =
        freshReg.threads[t.threadId] ||
        Object.values(freshReg.threads).find((x) => x.conversationId === t.conversationId);
      if (!rec) return null;
      if (!rec.archived) {
        rec.archived = true;
        rec.updatedAt = new Date().toISOString();
      }
      return { ...rec };
    }) ||
    cleanup.thread ||
    t;

  const decoratedThread = decorateThreadRecord(finalThread, loadRegistry());
  return {
    ok: true,
    threadId: decoratedThread.threadId,
    ...(decoratedThread.projectSeq ? { projectSeq: decoratedThread.projectSeq } : {}),
    ...(decoratedThread.localId ? { localId: decoratedThread.localId } : {}),
    archived: true,
    worktreeRemoved: Boolean(cleanup.worktreeRemoved),
    branchDeleted: Boolean(cleanup.branchDeleted),
    pruned: Boolean(cleanup.pruned),
    skippedReason: cleanup.skippedReason || '',
    worktreeError: cleanup.worktreeError || '',
    removedWorktreePath: cleanup.removedWorktreePath || '',
    deletedBranch: cleanup.deletedBranch || '',
    thread: decoratedThread,
  };
}

function sanitizeWindowsCmdArg(val) {
  return String(val ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r?\n/g, ' ')
    .replace(/"/g, '＂')
    .replace(/%/g, '％')
    .replace(/!/g, '！')
    .replace(/\^/g, '＾');
}

function quoteWindowsCmdExePath(exePath) {
  const s = String(exePath ?? '').replace(/[\r\n\u0000"]/g, '');
  return `"${s}"`;
}

export function quoteWindowsCmdArg(val) {
  return `"${sanitizeWindowsCmdArg(val)}"`;
}

export function invokeAgentApiSend({
  conversationId,
  message,
  title,
  projectId,
  timeoutMs = 12000,
}) {
  let exe = resolveAgentApiExe();
  const ep = resolveLsEndpoint();
  let isWinBatch = process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(exe);
  if (isWinBatch) {
    // Prefer invoking the underlying real language_server binary directly to bypass cmd.exe completely
    const directTarget = resolveAgentApiShimTargetFile(exe);
    if (directTarget) {
      exe = directTarget;
      isWinBatch = /\.(?:bat|cmd)$/i.test(exe);
    }
  }
  const exeBase = basename(exe).toLowerCase();
  const isDirectAgentApi =
    exeBase === 'agentapi' ||
    exeBase === 'agentapi.exe' ||
    exeBase === 'agentapi.cmd' ||
    exeBase === 'agentapi.bat';
  const args = isDirectAgentApi ? ['send-message'] : ['agentapi', 'send-message'];
  if (title) args.push(`--title=${title}`);
  args.push(conversationId, message);

  // Sanitize child env so agentapi never inherits static daemon project/conversation env vars
  const env = { ...process.env };
  delete env.ANTIGRAVITY_CONVERSATION_ID;
  if (ep?.address && !env.ANTIGRAVITY_LS_ADDRESS) env.ANTIGRAVITY_LS_ADDRESS = ep.address;
  if (ep?.csrfToken && !env.ANTIGRAVITY_CSRF_TOKEN) env.ANTIGRAVITY_CSRF_TOKEN = ep.csrfToken;
  if (projectId && projectId !== 'outside-of-project') {
    env.ANTIGRAVITY_PROJECT_ID = projectId;
  } else {
    delete env.ANTIGRAVITY_PROJECT_ID;
  }

  const spawnExe = isWinBatch ? process.env.ComSpec || 'cmd.exe' : exe;
  const spawnArgs = isWinBatch
    ? ['/d', '/s', '/c', `"${quoteWindowsCmdExePath(exe)} ${args.map(quoteWindowsCmdArg).join(' ')}"`]
    : args;
  const execOpts = {
    env,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    ...(isWinBatch ? { windowsVerbatimArguments: true } : {}),
  };

  return new Promise((resolveSend, rejectSend) => {
    let settled = false;
    let child = null;

    const fail = (errObj) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      rejectSend(errObj);
    };

    const hardTimer = setTimeout(() => {
      if (settled) return;
      try {
        child?.kill?.('SIGKILL');
      } catch {
        // Ignore kill error
      }
      const timeoutErr = new Error(`agentapi send-message timed out after ${timeoutMs}ms`);
      timeoutErr.code = 'ETIMEDOUT';
      timeoutErr.killed = true;
      timeoutErr.isTimeout = true;
      fail(timeoutErr);
    }, timeoutMs + 250);
    hardTimer.unref?.();

    child = execFile(spawnExe, spawnArgs, execOpts, (err, stdout, stderr) => {
      if (settled) return;
      const out = String(stdout || '').trim();
      const errText = String(stderr || '').trim();
      if (err) {
        const msg = errText || out || err.message || 'agentapi send-message failed';
        const sendErr = new Error(msg);
        sendErr.code = err.code;
        sendErr.killed = Boolean(err.killed);
        sendErr.isTimeout = Boolean(err.killed && err.signal);
        fail(sendErr);
        return;
      }
      if (out.startsWith('{')) {
        try {
          const parsed = JSON.parse(out);
          if (parsed?.error) {
            fail(new Error(String(parsed.error)));
            return;
          }
        } catch {
          // Non-JSON stdout; treat exit 0 as success
        }
      }
      settled = true;
      clearTimeout(hardTimer);
      resolveSend({ queued: true, output: out });
    });
  });
}

async function resolveModelOverrideForSend({
  model = '',
  modelEnum = '',
  modelOrAlias = null,
  modelDisplayName = '',
} = {}) {
  const rawModel = String(model || '').trim();
  const rawOrAlias = modelOrAlias && typeof modelOrAlias === 'object' ? modelOrAlias : null;
  const rawEnum = String(modelEnum || rawOrAlias?.model || '').trim();
  const rawAlias = String(rawOrAlias?.alias || '').trim();
  const rawDisplay = String(modelDisplayName || '').trim();

  const hasOverride = Boolean(rawModel || rawEnum || rawAlias);
  if (!hasOverride) {
    return { hasOverride: false };
  }

  if (rawModel && isTierAlias(rawModel) && !rawEnum && !rawAlias) {
    throw new Error(
      `Model tier alias "${rawModel}" cannot switch an existing thread; select a concrete model.`,
    );
  }

  const catalogMatch =
    (rawEnum ? await findSelectableModelMatch(rawEnum) : null) ||
    (rawModel ? await findSelectableModelMatch(rawModel) : null) ||
    (rawAlias ? await findSelectableModelMatch(rawAlias) : null);

  const effectiveEnum =
    catalogMatch?.modelEnum ||
    rawEnum ||
    (/^MODEL_(?!ALIAS_)/i.test(rawModel) ? rawModel : '');
  const effectiveAlias =
    catalogMatch?.modelAlias ||
    rawAlias ||
    (/^MODEL_ALIAS_/i.test(rawModel) ? rawModel : '');
  const effectiveOrAlias =
    catalogMatch?.modelOrAlias ||
    (effectiveEnum ? { model: effectiveEnum } : effectiveAlias ? { alias: effectiveAlias } : null);

  if (!effectiveEnum && !effectiveOrAlias) {
    throw new Error(`Could not resolve concrete model identifier for "${rawModel || rawEnum}".`);
  }

  const effectiveModelId =
    catalogMatch?.modelId ||
    catalogMatch?.id ||
    (!/^MODEL_/i.test(rawModel) ? rawModel : '') ||
    effectiveEnum;
  const effectiveDisplayName =
    rawDisplay ||
    catalogMatch?.label ||
    (await resolveNonTierModelDisplay(effectiveModelId || effectiveEnum, {
      allowCachedOnly: true,
    })) ||
    formatModelDisplay(effectiveModelId || effectiveEnum);

  return {
    hasOverride: true,
    modelId: effectiveModelId,
    modelEnum: effectiveEnum,
    modelOrAlias: effectiveOrAlias,
    modelDisplayName: effectiveDisplayName,
  };
}

export async function sendThreadMessage({
  threadId,
  message,
  title = '',
  model = '',
  modelEnum = '',
  modelOrAlias = null,
  modelDisplayName = '',
  workspacePath = '',
  workspace = '',
  workspaceKey = '',
  coordinatorId = '',
  conversationId = '',
  projectId = '',
  requireScope = false,
}) {
  const text = String(message || '').trim();
  if (!threadId || !text) {
    throw new Error('Both `threadId` and `message` are required.');
  }

  const reg = loadRegistry();
  assertNotRetiredCoordinator(reg, { coordinatorId, conversationId });
  const { thread: t } = await resolveScopedThreadTarget({
    threadId,
    workspacePath: workspacePath || workspace,
    workspaceKey,
    coordinatorId,
    conversationId,
    projectId,
    requireScope: Boolean(requireScope),
    reg,
  });

  const override = await resolveModelOverrideForSend({
    model,
    modelEnum,
    modelOrAlias,
    modelDisplayName,
  });

  if (override.hasOverride) {
    let baselineGenMetaCount = threadModelCache.get(t.conversationId)?.genMetaCount;
    if (!Number.isInteger(baselineGenMetaCount)) {
      const preGen = await getThreadGeneratorModel(t.conversationId, 1500);
      baselineGenMetaCount = preGen.ok && Number.isInteger(preGen.count) ? preGen.count : -1;
    }

    await sendUserCascadeMessage(t.conversationId, text, {
      model: override.modelId,
      modelEnum: override.modelEnum,
      modelOrAlias: override.modelOrAlias,
    });

    const now = new Date().toISOString();
    const wasArchivedBefore = Boolean(t.archived);
    if (wasArchivedBefore) {
      await withSoftTimeout(
        updateConversation(t.conversationId, { archived: false }).catch(() => null),
        800,
        null,
      );
    }
    let unarchivedInMutate = false;
    seenRunningThreadIds.add(t.threadId);
    const updatedThread = mutateRegistry((freshReg) => {
      const freshT =
        freshReg.threads[t.threadId] ||
        Object.values(freshReg.threads).find((x) => x.conversationId === t.conversationId);
      if (!freshT) return t;
      const pending = Array.isArray(freshT.pendingUserMessages) ? freshT.pendingUserMessages : [];
      pending.push({ id: `pm-${Date.now()}`, text, createdAt: now });
      freshT.pendingUserMessages = pending.slice(-8);
      if (override.modelDisplayName) freshT.modelDisplayName = override.modelDisplayName;
      if (override.modelId || override.modelEnum) {
        freshT.resolvedModel = override.modelId || override.modelEnum;
      }
      if (override.modelEnum) freshT.modelEnum = override.modelEnum;
      freshT.pendingModelSwitch = {
        modelDisplayName: freshT.modelDisplayName || override.modelDisplayName,
        resolvedModel: freshT.resolvedModel || override.modelId || override.modelEnum,
        modelEnum: override.modelEnum || '',
        baselineGenMetaCount,
        requestedAt: now,
      };
      if (freshT.archived) {
        unarchivedInMutate = true;
        freshT.archived = false;
      }
      freshT.stepsProgress = null;
      freshT.stepsList = null;
      freshT.activeTool = '';
      freshT.activeToolObj = null;
      freshT.toolStepCount = 0;
      freshT.runState = 'RUN_STATE_RUNNING';
      freshT.bucket = 'working';
      freshT.waitingReason = '';
      freshT.updatedAt = now;
      resetThreadWatchdogOnMessageInReg(freshReg, {
        workspaceKey: freshT.workspaceKey,
        threadId: freshT.threadId,
        nowIso: now,
      });
      return freshT;
    });
    if (unarchivedInMutate && !wasArchivedBefore) {
      await withSoftTimeout(
        updateConversation(t.conversationId, { archived: false }).catch(() => null),
        800,
        null,
      );
    }
    seenRunningThreadIds.add(updatedThread.threadId);
    storeLruSet(
      threadModelCache,
      updatedThread.conversationId,
      {
        checkedAt: Date.now(),
        updatedAt: now,
        runState: 'RUN_STATE_RUNNING',
        modelDisplayName: updatedThread.modelDisplayName || '',
        resolvedModel: updatedThread.resolvedModel || '',
        modelEnum: updatedThread.modelEnum || '',
        usage: updatedThread.usage || null,
        genMetaCount: baselineGenMetaCount,
        fromLs: true,
        archivedResolved: false,
      },
      THREAD_MODEL_CACHE_MAX,
    );
    return { ok: true, thread: decorateThreadRecord(updatedThread, loadRegistry()) };
  }

  let delivered = false;
  if (resolveLsEndpoint()) {
    try {
      await sendUserCascadeMessage(t.conversationId, text, {});
      delivered = true;
    } catch {
      // Fall back to agentapi send-message when LS ConnectRPC send is unavailable/rejected
    }
  }

  if (!delivered) {
    const displayId = getThreadDisplayId(t);
    try {
      await invokeAgentApiSend({
        conversationId: t.conversationId,
        message: text,
        title: title || `Follow-up [${displayId}]`,
        projectId: t.projectId,
      });
    } catch (err) {
      if (t.projectId) {
        await invokeAgentApiSend({
          conversationId: t.conversationId,
          message: text,
          title: title || `Follow-up [${displayId}]`,
          projectId: '',
        });
      } else {
        throw err;
      }
    }
  }

  const now = new Date().toISOString();
  const wasArchivedBefore = Boolean(t.archived);
  if (wasArchivedBefore) {
    await withSoftTimeout(
      updateConversation(t.conversationId, { archived: false }).catch(() => null),
      800,
      null,
    );
  }
  let unarchivedInMutate = false;
  seenRunningThreadIds.add(t.threadId);
  const updatedThread = mutateRegistry((freshReg) => {
    const freshT =
      freshReg.threads[t.threadId] ||
      Object.values(freshReg.threads).find((x) => x.conversationId === t.conversationId);
    if (!freshT) return t;
    const pending = Array.isArray(freshT.pendingUserMessages) ? freshT.pendingUserMessages : [];
    pending.push({ id: `pm-${Date.now()}`, text, createdAt: now });
    freshT.pendingUserMessages = pending.slice(-8);
    if (freshT.archived) {
      unarchivedInMutate = true;
      freshT.archived = false;
    }
    freshT.stepsProgress = null;
    freshT.stepsList = null;
    freshT.activeTool = '';
    freshT.activeToolObj = null;
    freshT.toolStepCount = 0;
    freshT.runState = 'RUN_STATE_RUNNING';
    freshT.bucket = 'working';
    freshT.waitingReason = '';
    freshT.updatedAt = now;
    resetThreadWatchdogOnMessageInReg(freshReg, {
      workspaceKey: freshT.workspaceKey,
      threadId: freshT.threadId,
      nowIso: now,
    });
    return freshT;
  });
  if (wasArchivedBefore || unarchivedInMutate) {
    threadModelCache.delete(updatedThread.conversationId);
    if (unarchivedInMutate && !wasArchivedBefore) {
      await withSoftTimeout(
        updateConversation(t.conversationId, { archived: false }).catch(() => null),
        800,
        null,
      );
    }
  }

  return { ok: true, thread: decorateThreadRecord(updatedThread, loadRegistry()) };
}

const CLAIM_STALE_MS = 30_000;
const CLAIM_DEAD_PID_MIN_AGE_MS = 2000;

function tryAcquireClaimLock({ claimPath, nowIso, threadId, stepIndex }) {
  const payload = `${JSON.stringify({ pid: process.pid, at: nowIso })}\n`;
  try {
    writeFileSync(claimPath, payload, { flag: 'wx' });
    return { acquired: true, alreadySynced: false };
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
  }

  // If the holder already completed delivery and persisted lastSyncedStepIndex, treat as already_synced
  if (stepIndex >= 0) {
    const latestReg = loadRegistry();
    const latestT = latestReg.threads[threadId];
    if (latestT?.lastSyncedStepIndex === stepIndex) {
      return { acquired: false, alreadySynced: true };
    }
  }

  // Reclaim stale/abandoned claim locks left behind by crashed or hook-killed processes
  let isStale = false;
  try {
    const st = statSync(claimPath);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs > CLAIM_STALE_MS) {
      isStale = true;
    } else if (ageMs > CLAIM_DEAD_PID_MIN_AGE_MS) {
      try {
        const parsed = JSON.parse(readFileSync(claimPath, 'utf8'));
        const ownerPid = Number(parsed?.pid);
        if (
          Number.isInteger(ownerPid) &&
          ownerPid > 0 &&
          ownerPid !== process.pid &&
          !isProcessAlive(ownerPid)
        ) {
          isStale = true;
        }
      } catch {
        // Legacy or non-JSON claim within TTL; keep waiting
      }
    }
  } catch (statErr) {
    if (statErr?.code === 'ENOENT') isStale = true;
  }

  if (isStale) {
    try {
      unlinkSync(claimPath);
    } catch {
      // Ignore unlink race
    }
    try {
      writeFileSync(claimPath, payload, { flag: 'wx' });
      return { acquired: true, alreadySynced: false };
    } catch (retryErr) {
      if (retryErr && retryErr.code === 'EEXIST') {
        return { acquired: false, alreadySynced: false };
      }
      throw retryErr;
    }
  }

  return { acquired: false, alreadySynced: false };
}

function releaseClaims(claimPaths) {
  for (const cp of claimPaths) {
    try {
      unlinkSync(cp);
    } catch {
      // Ignore cleanup errors
    }
  }
}

function isSuppressedByRebindBaseline(t, completion) {
  if (!t) return false;
  if (
    Number.isInteger(t.reboundBaselineStepIndex) &&
    completion &&
    Number.isInteger(completion.stepIndex) &&
    completion.stepIndex >= 0 &&
    completion.stepIndex <= t.reboundBaselineStepIndex
  ) {
    return true;
  }
  if (
    t.reboundBaselineAt &&
    (!completion || !Number.isInteger(completion.stepIndex) || completion.stepIndex < 0) &&
    t.lastCompletedAt &&
    t.lastCompletedAt <= t.reboundBaselineAt
  ) {
    return true;
  }
  return false;
}

export async function syncCompletionToCoordinator({
  threadId,
  transcriptPath = '',
  force = false,
  timeoutMs = 12000,
  workspacePath = '',
  workspace = '',
  workspaceKey = '',
  coordinatorId = '',
  conversationId = '',
  projectId = '',
}) {
  const reg = loadRegistry();
  assertNotRetiredCoordinator(reg, { coordinatorId, conversationId });
  const cleanWsPath = String(workspacePath || workspace || '').trim();
  const cleanWsKey = String(workspaceKey || '').trim();
  const cleanCoordId = String(coordinatorId || '').trim();
  const cleanConvId = String(conversationId || '').trim();
  const cleanProjId = String(projectId || '').trim();
  const hasScopeParams = Boolean(
    cleanWsPath || cleanWsKey || cleanCoordId || cleanConvId || cleanProjId,
  );
  let t = null;
  if (hasScopeParams) {
    const resolved = await resolveScopedThreadTarget({
      threadId,
      workspacePath: cleanWsPath,
      workspaceKey: cleanWsKey,
      coordinatorId: cleanCoordId,
      conversationId: cleanConvId,
      projectId: cleanProjId,
      requireScope: false,
      reg,
    });
    t = resolved.thread;
  } else {
    t =
      reg.threads[threadId] ||
      Object.values(reg.threads).find((x) => x.conversationId === threadId) ||
      null;
  }
  if (!t) throw new Error(`Thread not found: ${threadId}`);
  const displayId = getThreadDisplayId(t);

  const coord =
    (t.workspaceKey && reg.coordinators[t.workspaceKey]) ||
    Object.values(reg.coordinators).find((c) => c.conversationId === t.coordinatorId) ||
    null;
  const targetCoordId = t.coordinatorId || coord?.conversationId || '';
  if (!targetCoordId || targetCoordId === t.conversationId) {
    return { ok: false, synced: false, reason: 'no_coordinator_bound' };
  }

  let completion = extractThreadCompletion(t.conversationId, transcriptPath);
  if (completion.waitingOnBackgroundTask && !force) {
    return {
      ok: false,
      synced: false,
      reason: 'waiting_on_background_task',
      pendingTaskIds: completion.pendingTaskIds || [],
    };
  }
  if (force && !completion.fullReport && completion.waitingOnBackgroundTask) {
    completion = extractLatestAssistantText(t.conversationId, transcriptPath);
  }

  if (!completion.fullReport && !t.lastSummary) {
    return { ok: false, synced: false, reason: 'no_completion_content' };
  }

  if (
    !force &&
    completion.stepIndex >= 0 &&
    t.lastSyncedStepIndex === completion.stepIndex
  ) {
    return { ok: true, synced: false, reason: 'already_synced', stepIndex: completion.stepIndex };
  }
  if (!force && isSuppressedByRebindBaseline(t, completion)) {
    return {
      ok: true,
      synced: false,
      reason: 'suppressed_by_rebind_baseline',
      stepIndex: completion.stepIndex,
    };
  }

  const reportBody = completion.fullReport || t.lastSummary || '(无正文)';
  const bodyHash = createHash('sha1')
    .update(String(reportBody || '').trim())
    .digest('hex')
    .slice(0, 12);
  const now = new Date().toISOString();

  // Kernel-atomic exclusive .claim locks prevent concurrent Stop hook + background watcher double-sends
  const acquiredClaims = [];
  if (!force) {
    const claimsDir = join(getStateDir(), 'sync-claims');
    if (!existsSync(claimsDir)) mkdirSync(claimsDir, { recursive: true });
    const claimPaths = [];
    if (completion.stepIndex >= 0) {
      claimPaths.push(join(claimsDir, `${t.threadId}-step-${completion.stepIndex}.claim`));
    }
    claimPaths.push(join(claimsDir, `${t.threadId}-hash-${bodyHash}.claim`));

    for (const cp of claimPaths) {
      const claimRes = tryAcquireClaimLock({
        claimPath: cp,
        nowIso: now,
        threadId: t.threadId,
        stepIndex: completion.stepIndex,
      });
      if (claimRes.acquired) {
        acquiredClaims.push(cp);
      } else {
        releaseClaims(acquiredClaims);
        return {
          ok: true,
          synced: false,
          reason: claimRes.alreadySynced ? 'already_synced' : 'already_claimed',
          stepIndex: completion.stepIndex,
        };
      }
    }
  }

  const nextGit = t.worktreePath
    ? await inspectWorktreeGit(t.worktreePath, {
        baseRef: t.baseRef,
        defaultBranch: coord?.defaultBranch || '',
        repoRoot: t.repoRoot || coord?.repoRoot || '',
      })
    : t.git;

  const gitMeta = t.branch
    ? `Isolated branch \`${t.branch}\`` +
      (nextGit?.lastCommit ? ` | Latest commit: \`${nextGit.lastCommit}\`` : '') +
      (nextGit?.dirtyCount ? ` | Uncommitted files: ${nextGit.dirtyCount}` : '')
    : 'Read-only shared workspace inspection';

  const callbackMsg = [
    `[THREAD_COMPLETION_SYNC] Worker thread \`${displayId}\` has finished execution (automated plugin callback — do NOT call dispatch_thread to spawn a duplicate thread for this callback):`,
    '',
    `- **Thread ID**: \`${displayId}\` ([View Full Thread](conversation://${t.conversationId}))`,
    `- **Task Title**: ${t.title}`,
    `- **Mode / Branch**: ${gitMeta}`,
    '',
    '### Worker Thread Final Report',
    reportBody,
    '',
    '---',
    '### Coordinator Segmented Card Output Format (Required)',
    'To keep consecutive worker callbacks visually separated like distinct conversation segments, reply in the user\'s language using this exact card structure (if this conclusion duplicates an already-reported result, give only a one-line acknowledgment without exposing internal dedup metadata):',
    `1. Start with a blockquote banner: \`> **✅ [${displayId}] ${t.title} — Completed** ([View Thread](conversation://${t.conversationId}))\` (localize "Completed" / "View Thread" to match the user's conversation language).`,
    '2. Below the banner, list **only 3–5 concise takeaway bullets** (root cause / key findings or changes / any decision needed from the user; leave verbose logs and large tables inside the worker thread).',
    '3. End with a horizontal rule `---` so adjacent thread callbacks have a clean visual boundary (and call `update_project_memory` if reusable project-wide constraints emerged).',
  ].join('\n');

  // Live re-read of latest registry.json right before delivery so mid-flight coordinator rebinds take effect immediately
  const latestReg = loadRegistry();
  const latestT =
    latestReg.threads[t.threadId] ||
    Object.values(latestReg.threads).find((x) => x.conversationId === t.conversationId) ||
    t;
  if (!force && completion.stepIndex >= 0 && latestT.lastSyncedStepIndex === completion.stepIndex) {
    releaseClaims(acquiredClaims);
    return { ok: true, synced: false, reason: 'already_synced', stepIndex: completion.stepIndex };
  }
  if (!force && isSuppressedByRebindBaseline(latestT, completion)) {
    releaseClaims(acquiredClaims);
    return {
      ok: true,
      synced: false,
      reason: 'suppressed_by_rebind_baseline',
      stepIndex: completion.stepIndex,
    };
  }
  const latestScopeCoord =
    (latestT.workspaceKey && latestReg.coordinators?.[latestT.workspaceKey]) ||
    Object.values(latestReg.coordinators || {}).find((c) => c.conversationId === latestT.coordinatorId) ||
    null;
  const threadCoordRetired = Boolean(
    !latestT.archived &&
      latestScopeCoord?.conversationId &&
      latestT.coordinatorId &&
      latestT.coordinatorId !== latestScopeCoord.conversationId &&
      Array.isArray(latestScopeCoord.retiredCoordinatorIds) &&
      latestScopeCoord.retiredCoordinatorIds.includes(latestT.coordinatorId),
  );
  const liveTargetCoordId = String(
    threadCoordRetired
      ? latestScopeCoord.conversationId
      : latestT.coordinatorId || latestScopeCoord?.conversationId || targetCoordId || '',
  ).trim();
  if (!liveTargetCoordId || liveTargetCoordId === t.conversationId) {
    releaseClaims(acquiredClaims);
    return { ok: false, synced: false, reason: 'no_coordinator_bound' };
  }

  const coordProjId = latestScopeCoord?.projectId || latestT.projectId || coord?.projectId || t.projectId || '';
  const msgTitle = `[${displayId} Completed] ${t.title}`;
  const deadlineMs = Date.now() + timeoutMs;

  try {
    try {
      await invokeAgentApiSend({
        conversationId: liveTargetCoordId,
        message: callbackMsg,
        title: msgTitle,
        projectId: coordProjId,
        timeoutMs: Math.max(1000, deadlineMs - Date.now()),
      });
    } catch (err) {
      const remainingMs = deadlineMs - Date.now();
      if (coordProjId && !err.isTimeout && err.code !== 'ENOENT' && remainingMs >= 1500) {
        await invokeAgentApiSend({
          conversationId: liveTargetCoordId,
          message: callbackMsg,
          title: msgTitle,
          projectId: '',
          timeoutMs: Math.max(1000, remainingMs),
        });
      } else {
        throw err;
      }
    }
  } catch (sendErr) {
    releaseClaims(acquiredClaims);
    throw sendErr;
  }

  // Persist completion & sync deduplication markers atomically ONLY AFTER delivery actually succeeded
  // AND ONLY IF the target Coordinator was not retired while delivery was in flight (P1-1).
  const completedAt = new Date().toISOString();
  const persistOut = mutateRegistry((freshReg) => {
    const freshT =
      freshReg.threads[t.threadId] ||
      Object.values(freshReg.threads).find((x) => x.conversationId === t.conversationId);
    if (!freshT) return { targetRetiredDuringSend: false, currentCoordId: liveTargetCoordId };
    if (nextGit) freshT.git = nextGit;
    if (completion.cardSummary) freshT.lastSummary = completion.cardSummary;
    freshT.runState = 'RUN_STATE_IDLE';
    freshT.hasPendingBgTask = false;
    freshT.activeTool = '';
    freshT.activeToolObj = null;
    freshT.lastCompletedAt = completedAt;
    freshT.updatedAt = completedAt;

    const freshScopeCoord =
      (freshT.workspaceKey && freshReg.coordinators?.[freshT.workspaceKey]) || null;
    const targetRetiredDuringSend = Boolean(
      !freshT.archived &&
        ((freshT.coordinatorId && freshT.coordinatorId !== liveTargetCoordId) ||
          (freshScopeCoord?.conversationId &&
            freshScopeCoord.conversationId !== liveTargetCoordId &&
            Array.isArray(freshScopeCoord.retiredCoordinatorIds) &&
            freshScopeCoord.retiredCoordinatorIds.includes(liveTargetCoordId))),
    );
    const currentCoordId = String(
      freshT.coordinatorId || freshScopeCoord?.conversationId || liveTargetCoordId,
    ).trim();

    if (!targetRetiredDuringSend) {
      freshT.notifiedCoordinatorAt = completedAt;
      freshT.pushedToCoordinatorAt = completedAt;
      if (completion.stepIndex >= 0) {
        freshT.lastSyncedStepIndex = completion.stepIndex;
      }
    }
    const { bucket, waitingReason } = computeThreadBucket(freshT, {
      lastStepIndex: completion.stepIndex,
      hasPendingBgTask: false,
    });
    freshT.bucket = bucket;
    freshT.waitingReason = waitingReason;
    return { targetRetiredDuringSend, currentCoordId };
  });

  if (persistOut?.targetRetiredDuringSend) {
    // Release claim locks so the next sync / PreInvocation delivers to the newly active Coordinator
    releaseClaims(acquiredClaims);
    return {
      ok: false,
      synced: false,
      reason: 'coordinator_rebound_during_delivery',
      threadId: t.threadId,
      localId: displayId,
      deliveredCoordinatorId: liveTargetCoordId,
      coordinatorId: persistOut.currentCoordId,
    };
  }

  return { ok: true, synced: true, threadId: t.threadId, localId: displayId, coordinatorId: liveTargetCoordId };
}

function computeThreadBucket(t, liveAct = {}) {
  if (t.archived) {
    return { bucket: 'archived', waitingReason: '' };
  }
  if (t.runState === 'RUN_STATE_RUNNING' || Boolean(liveAct.hasPendingBgTask)) {
    return { bucket: 'working', waitingReason: '' };
  }
  const hasUnreviewedPrompt =
    (Boolean(liveAct.needsUserAction) ||
      /^\[待确认/.test(t.lastSummary || '') ||
      /^\[待查/.test(t.lastSummary || '')) &&
    t.acknowledgedStepIndex !== liveAct.lastStepIndex;
  const hasUnreadNewRun =
    Boolean(t.lastCompletedAt) &&
    (!t.viewedAt || t.lastCompletedAt > t.viewedAt);
  const bucket = hasUnreviewedPrompt || hasUnreadNewRun ? 'waiting' : 'idle';
  const waitingReason = hasUnreviewedPrompt ? 'confirm' : hasUnreadNewRun ? 'review' : '';
  return { bucket, waitingReason };
}

function applyMarkThreadReadOnRecord(t, liveAct) {
  const now = new Date().toISOString();
  const effectiveViewedAt = t.lastCompletedAt && t.lastCompletedAt > now ? t.lastCompletedAt : now;
  let changed = false;
  if (t.viewedAt !== effectiveViewedAt) {
    t.viewedAt = effectiveViewedAt;
    changed = true;
  }
  if (t.acknowledgedStepIndex !== liveAct.lastStepIndex) {
    t.acknowledgedStepIndex = liveAct.lastStepIndex;
    changed = true;
  }
  const { bucket, waitingReason } = computeThreadBucket(t, liveAct);
  t.bucket = bucket;
  t.waitingReason = waitingReason;
  return changed;
}

export async function markThreadRead({
  threadId,
  workspacePath = '',
  workspace = '',
  workspaceKey = '',
  coordinatorId = '',
  conversationId = '',
  projectId = '',
  requireScope = false,
}) {
  if (!threadId) {
    throw new Error('`threadId` is required.');
  }

  const reg = loadRegistry();
  const { thread: t } = await resolveScopedThreadTarget({
    threadId,
    workspacePath: workspacePath || workspace,
    workspaceKey,
    coordinatorId,
    conversationId,
    projectId,
    requireScope: Boolean(requireScope),
    reg,
  });

  const initialRunState = t.runState || '';
  const initialUpdatedAt = t.updatedAt || '';
  let liveRunStateUpdated = false;
  let dirty = false;
  if (t.runState === 'RUN_STATE_RUNNING') {
    try {
      const live = await getConversation(t.conversationId);
      const conv = live?.conversation || live;
      if (conv?.state?.runState && conv.state.runState !== t.runState) {
        t.runState = conv.state.runState;
        liveRunStateUpdated = true;
        if (conv.state.runState === 'RUN_STATE_IDLE' && !t.lastCompletedAt) {
          t.lastCompletedAt = new Date().toISOString();
        }
        dirty = true;
      }
    } catch {
      // Ignore transient LS errors
    }
  }

  const liveAct = peekLiveActivity(t.conversationId, { runState: t.runState });
  const isActivelyWorking =
    !t.archived && (t.runState === 'RUN_STATE_RUNNING' || Boolean(liveAct.hasPendingBgTask));
  if (Boolean(t.hasPendingBgTask) !== Boolean(liveAct.hasPendingBgTask)) {
    t.hasPendingBgTask = Boolean(liveAct.hasPendingBgTask);
    dirty = true;
  }
  if (!isActivelyWorking && (t.activeTool || t.activeToolObj)) {
    t.activeTool = '';
    t.activeToolObj = null;
    dirty = true;
  }
  if (!isActivelyWorking) {
    if (applyMarkThreadReadOnRecord(t, liveAct)) {
      dirty = true;
    }
  } else {
    const { bucket, waitingReason } = computeThreadBucket(t, liveAct);
    t.bucket = bucket;
    t.waitingReason = waitingReason;
  }

  let finalThread = t;
  if (dirty) {
    finalThread =
      mutateRegistry((freshReg) => {
        const freshT =
          freshReg.threads[t.threadId] ||
          Object.values(freshReg.threads).find((x) => x.conversationId === t.conversationId);
        if (!freshT) return null;
        const concurrentlyRestarted = Boolean(
          freshT.runState === 'RUN_STATE_RUNNING' &&
            (initialRunState !== 'RUN_STATE_RUNNING' ||
              (freshT.updatedAt && initialUpdatedAt && freshT.updatedAt > initialUpdatedAt)),
        );
        if (
          liveRunStateUpdated &&
          !concurrentlyRestarted &&
          !freshT.pendingModelSwitch &&
          freshT.runState === initialRunState
        ) {
          freshT.runState = t.runState;
        }
        if (t.lastCompletedAt && (!freshT.lastCompletedAt || t.lastCompletedAt > freshT.lastCompletedAt)) {
          freshT.lastCompletedAt = t.lastCompletedAt;
        }
        if (!concurrentlyRestarted) {
          freshT.hasPendingBgTask = t.hasPendingBgTask;
          if (!isActivelyWorking) {
            freshT.activeTool = '';
            freshT.activeToolObj = null;
          }
        }
        if (!isActivelyWorking) {
          if (t.viewedAt && (!freshT.viewedAt || t.viewedAt > freshT.viewedAt)) {
            freshT.viewedAt = t.viewedAt;
          }
          if (
            Number.isInteger(t.acknowledgedStepIndex) &&
            (!Number.isInteger(freshT.acknowledgedStepIndex) ||
              t.acknowledgedStepIndex > freshT.acknowledgedStepIndex)
          ) {
            freshT.acknowledgedStepIndex = t.acknowledgedStepIndex;
          }
        }
        const nextState = computeThreadBucket(freshT, liveAct);
        freshT.bucket = nextState.bucket;
        freshT.waitingReason = nextState.waitingReason;
        return { ...freshT };
      }) || t;
  }

  const decoratedThread = decorateThreadRecord(finalThread, dirty ? loadRegistry() : reg);
  return {
    ok: true,
    locale: resolveAppLocale(),
    threadId: decoratedThread.threadId,
    bucket: decoratedThread.bucket,
    waitingReason: decoratedThread.waitingReason,
    viewedAt: decoratedThread.viewedAt || '',
    thread: decoratedThread,
  };
}

export async function getThreadMessages({
  threadId,
  clientStamp = '',
  markRead = false,
  workspacePath = '',
  workspace = '',
  workspaceKey = '',
  coordinatorId = '',
  conversationId = '',
  projectId = '',
  requireScope = false,
  lsSoftTimeoutMs = 0,
}) {
  const reg = loadRegistry();
  const { thread: t } = await resolveScopedThreadTarget({
    threadId,
    workspacePath: workspacePath || workspace,
    workspaceKey,
    coordinatorId,
    conversationId,
    projectId,
    requireScope: Boolean(requireScope),
    reg,
  });

  const initialPendingAt = t.pendingModelSwitch?.requestedAt || '';
  const initialPendingIds = new Set((t.pendingUserMessages || []).map((p) => p.id));
  const initialRunState = t.runState || '';
  const initialUpdatedAt = t.updatedAt || '';
  let dirty = false;
  let liveRunStateUpdated = false;
  let convUpdatedAt = t.updatedAt || '';

  if (t.archived) {
    // Zero-LS-RPC fast path for archived threads: serve directly from local transcript + persisted metadata,
    // while healing legacy/incomplete archived snapshots (missing usage, summary, or stale RUN_STATE_RUNNING).
    if (t.runState === 'RUN_STATE_RUNNING') {
      t.runState = 'RUN_STATE_IDLE';
      liveRunStateUpdated = true;
      if (!t.lastCompletedAt) {
        t.lastCompletedAt = t.updatedAt || new Date().toISOString();
      }
      dirty = true;
    }
    if (!t.modelDisplayName || !t.usage) {
      const modelChanged = await resolveThreadModelInfo(t, {
        forceLsCheck: false,
        convUpdatedAt,
        convRunState: t.runState || 'RUN_STATE_IDLE',
      });
      if (modelChanged) dirty = true;
    }
  } else {
    // Active threads: race GetConversation & resolveThreadModelInfo in parallel under a tight soft timeout
    // so slow/busy LS never stalls first-paint rendering (falls back seamlessly to persisted/cached values).
    const isFirstPaint = !String(clientStamp || '').trim();
    const explicitSoftMs = Number(lsSoftTimeoutMs);
    const effectiveLsTimeoutMs =
      Number.isFinite(explicitSoftMs) && explicitSoftMs > 0
        ? Math.max(50, explicitSoftMs)
        : isFirstPaint
          ? 350
          : 1200;

    const modelSnapshot = {
      ...t,
      ...(t.pendingModelSwitch ? { pendingModelSwitch: { ...t.pendingModelSwitch } } : {}),
    };
    const [liveRes, modelRes] = await Promise.all([
      withSoftTimeout(
        getConversation(t.conversationId, effectiveLsTimeoutMs),
        effectiveLsTimeoutMs,
        null,
      ),
      withSoftTimeout(
        resolveThreadModelInfo(modelSnapshot, {
          forceLsCheck: true,
          bypassDebounce: isFirstPaint,
          convUpdatedAt,
          convRunState: t.runState || '',
          lsTimeoutMs: effectiveLsTimeoutMs,
        }).then((changed) => ({ changed, snapshot: modelSnapshot })),
        effectiveLsTimeoutMs,
        null,
      ),
    ]);

    if (liveRes) {
      const conv = liveRes?.conversation || liveRes;
      if (conv?.state?.updateTime) {
        convUpdatedAt = conv.state.updateTime;
        t.updatedAt = convUpdatedAt;
      }
      if (conv?.state?.runState && conv.state.runState !== t.runState) {
        t.runState = conv.state.runState;
        liveRunStateUpdated = true;
        if (conv.state.runState === 'RUN_STATE_IDLE' && !t.lastCompletedAt) {
          t.lastCompletedAt = new Date().toISOString();
        }
        dirty = true;
      }
    }

    if (modelRes && modelRes.snapshot) {
      const snap = modelRes.snapshot;
      if (t.pendingModelSwitch && !snap.pendingModelSwitch) {
        delete t.pendingModelSwitch;
        dirty = true;
      }
      if (snap.modelDisplayName && snap.modelDisplayName !== (t.modelDisplayName || '')) {
        t.modelDisplayName = snap.modelDisplayName;
        dirty = true;
      }
      if (snap.resolvedModel && snap.resolvedModel !== (t.resolvedModel || '')) {
        t.resolvedModel = snap.resolvedModel;
        dirty = true;
      }
      if (snap.modelEnum && snap.modelEnum !== (t.modelEnum || '')) {
        t.modelEnum = snap.modelEnum;
        dirty = true;
      }
      if (snap.usage && !isSameUsage(snap.usage, t.usage || null)) {
        t.usage = snap.usage;
        dirty = true;
      }
      if (modelRes.changed) dirty = true;
    }
  }

  const parsed = parseThreadTranscript(t.conversationId, t.pendingUserMessages || []);
  let pendingMsgsUpdated = false;
  if (Array.isArray(t.pendingUserMessages) && t.pendingUserMessages.length > 0) {
    const stillPending = parsed.items.filter((it) => it.pending).map((it) => ({
      id: it.id,
      text: it.text,
      createdAt: it.createdAt,
    }));
    if (stillPending.length !== t.pendingUserMessages.length) {
      t.pendingUserMessages = stillPending;
      pendingMsgsUpdated = true;
      dirty = true;
    }
  }

  const liveAct = peekLiveActivity(t.conversationId, { runState: t.runState });
  const isActivelyWorking =
    !t.archived && (t.runState === 'RUN_STATE_RUNNING' || Boolean(liveAct.hasPendingBgTask));
  const effectiveHasPendingBgTask = t.archived ? false : Boolean(liveAct.hasPendingBgTask);
  if (Boolean(t.hasPendingBgTask) !== effectiveHasPendingBgTask) {
    t.hasPendingBgTask = effectiveHasPendingBgTask;
    dirty = true;
  }
  if (!isActivelyWorking && (t.activeTool || t.activeToolObj)) {
    t.activeTool = '';
    t.activeToolObj = null;
    dirty = true;
  }
  if (t.archived) {
    if (liveAct.lastSummary && !t.lastSummary) {
      t.lastSummary = liveAct.lastSummary;
      dirty = true;
    }
    if (liveAct.toolStepCount > 0 && !(Number(t.toolStepCount) > 0)) {
      t.toolStepCount = liveAct.toolStepCount;
      dirty = true;
    }
    if (t.bucket !== 'archived' || t.waitingReason) {
      t.bucket = 'archived';
      t.waitingReason = '';
      dirty = true;
    }
  }
  if (markRead && !isActivelyWorking) {
    if (applyMarkThreadReadOnRecord(t, liveAct)) {
      dirty = true;
    }
  } else {
    const { bucket, waitingReason } = computeThreadBucket(t, liveAct);
    t.bucket = bucket;
    t.waitingReason = waitingReason;
  }

  let persistedT = t;
  if (dirty) {
    persistedT =
      mutateRegistry((freshReg) => {
        const freshT =
          freshReg.threads[t.threadId] ||
          Object.values(freshReg.threads).find((x) => x.conversationId === t.conversationId);
        if (!freshT) return null;
        const freshPendingAt = freshT.pendingModelSwitch?.requestedAt || '';
        const hasConcurrentNewSwitch = Boolean(freshPendingAt && freshPendingAt !== initialPendingAt);
        const concurrentlyRestarted = Boolean(
          !freshT.archived &&
            freshT.runState === 'RUN_STATE_RUNNING' &&
            (initialRunState !== 'RUN_STATE_RUNNING' ||
              (freshT.updatedAt && initialUpdatedAt && freshT.updatedAt > initialUpdatedAt)),
        );
        if (initialPendingAt && !t.pendingModelSwitch && freshPendingAt === initialPendingAt) {
          delete freshT.pendingModelSwitch;
        }
        if (!hasConcurrentNewSwitch) {
          if (liveRunStateUpdated && !concurrentlyRestarted && freshT.runState === initialRunState) {
            freshT.runState = t.runState;
          }
          if (t.modelDisplayName) freshT.modelDisplayName = t.modelDisplayName;
          if (t.resolvedModel) freshT.resolvedModel = t.resolvedModel;
          if (t.modelEnum) freshT.modelEnum = t.modelEnum;
        }
        if (t.usage) freshT.usage = t.usage;
        if (freshT.archived) {
          if (freshT.runState === 'RUN_STATE_RUNNING') {
            freshT.runState = 'RUN_STATE_IDLE';
          }
          if (t.lastSummary && !freshT.lastSummary) {
            freshT.lastSummary = t.lastSummary;
          }
          if (Number(t.toolStepCount) > 0 && !(Number(freshT.toolStepCount) > 0)) {
            freshT.toolStepCount = t.toolStepCount;
          }
        }
        if (t.updatedAt && (!freshT.updatedAt || t.updatedAt > freshT.updatedAt)) {
          freshT.updatedAt = t.updatedAt;
        }
        if (t.lastCompletedAt && (!freshT.lastCompletedAt || t.lastCompletedAt > freshT.lastCompletedAt)) {
          freshT.lastCompletedAt = t.lastCompletedAt;
        }
        if (pendingMsgsUpdated) {
          const currentPending = Array.isArray(freshT.pendingUserMessages)
            ? freshT.pendingUserMessages
            : [];
          const stillIds = new Set((t.pendingUserMessages || []).map((p) => p.id));
          const newestRemovedAt = t.updatedAt || '';
          freshT.pendingUserMessages = currentPending.filter(
            (p) =>
              stillIds.has(p.id) ||
              !initialPendingIds.has(p.id) ||
              (p.createdAt && newestRemovedAt && p.createdAt > newestRemovedAt),
          );
        }
        if (!concurrentlyRestarted) {
          freshT.hasPendingBgTask = freshT.archived ? false : t.hasPendingBgTask;
          if (!isActivelyWorking) {
            freshT.activeTool = '';
            freshT.activeToolObj = null;
          }
        }
        if (!isActivelyWorking && markRead) {
          if (t.viewedAt && (!freshT.viewedAt || t.viewedAt > freshT.viewedAt)) {
            freshT.viewedAt = t.viewedAt;
          }
          if (
            Number.isInteger(t.acknowledgedStepIndex) &&
            (!Number.isInteger(freshT.acknowledgedStepIndex) ||
              t.acknowledgedStepIndex > freshT.acknowledgedStepIndex)
          ) {
            freshT.acknowledgedStepIndex = t.acknowledgedStepIndex;
          }
        }
        const nextState = computeThreadBucket(freshT, liveAct);
        freshT.bucket = nextState.bucket;
        freshT.waitingReason = nextState.waitingReason;
        return { ...freshT };
      }) || t;
  }

  const locale = resolveAppLocale();
  const decoratedThread = decorateThreadRecord(persistedT, dirty ? loadRegistry() : reg);
  const modelStamp = decoratedThread.modelDisplayName || decoratedThread.resolvedModel || decoratedThread.model || '';
  const viewHasPendingBgTask = !decoratedThread.archived && Boolean(liveAct.hasPendingBgTask);
  const fullStamp = `${parsed.stamp}|rs:${decoratedThread.runState}|bg:${viewHasPendingBgTask ? 1 : 0}|b:${decoratedThread.bucket}|m:${modelStamp}|loc:${locale}`;
  const hasUnflushedPendingUser = Boolean(
    isActivelyWorking && Array.isArray(t.pendingUserMessages) && t.pendingUserMessages.length > 0,
  );
  const threadView = {
    ...decoratedThread,
    hasPendingBgTask: viewHasPendingBgTask,
    activeTool: hasUnflushedPendingUser
      ? ''
      : isActivelyWorking
        ? liveAct.activeTool || parsed.activeActivity || ''
        : '',
    activeToolObj: hasUnflushedPendingUser
      ? null
      : isActivelyWorking
        ? liveAct.activeToolObj || null
        : null,
    stepsProgress: hasUnflushedPendingUser ? null : liveAct.stepsProgress || null,
    stepsList: hasUnflushedPendingUser ? null : liveAct.stepsList || null,
    toolStepCount: hasUnflushedPendingUser ? 0 : liveAct.toolStepCount || 0,
  };

  if (clientStamp && clientStamp === fullStamp) {
    return {
      ok: true,
      unchanged: true,
      locale,
      stamp: fullStamp,
      thread: threadView,
    };
  }

  return {
    ok: true,
    unchanged: false,
    locale,
    stamp: fullStamp,
    thread: threadView,
    items: parsed.items,
  };
}

// ==================== Pending Decisions & Auto Worktree Hints ====================

const VALID_DECISION_ACTIONS = new Set(['send_coordinator', 'archive_thread', 'dismiss']);
const VALID_EXECUTE_DECISION_ACTIONS = new Set([
  'send_coordinator',
  'custom_reply',
  'archive_thread',
  'dismiss',
]);
const VALID_DECISION_STYLES = new Set(['primary', 'secondary', 'danger']);
const VALID_AUTO_KINDS = new Set([
  'worktree_merge_ready',
  'worktree_archive_ready',
  'watchdog_stalled',
]);
const DECISION_CLAIM_STALE_MS = 60_000;
const MAX_DECISION_CUSTOM_MESSAGE_LENGTH = 2000;

function isActiveDecisionStatus(status) {
  return status === 'pending' || status === 'sending';
}

function isDecisionClaimFresh(claimedAtIso) {
  if (!claimedAtIso) return false;
  const ts = Date.parse(String(claimedAtIso));
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < DECISION_CLAIM_STALE_MS;
}

function cloneDecisionRecord(record) {
  if (!record || typeof record !== 'object') return null;
  return {
    ...record,
    source: 'explicit',
    options: Array.isArray(record.options) ? record.options.map((o) => ({ ...o })) : [],
  };
}

function sanitizeSingleLineProtocolField(val, maxLen = 400) {
  return String(val ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function formatQuotedCustomInstruction(text) {
  const cleaned = String(text ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!cleaned) return '';
  return cleaned
    .split('\n')
    .map((line) => `  > ${line}`)
    .join('\n');
}

function normalizeScopeKeyForMatch(raw) {
  const s = String(raw || '').trim();
  if (!s || s === '*') return '';
  return isFilesystemPathKey(s) ? normalizeKey(s) : s;
}

function isSameScopeKey(a, b) {
  const na = normalizeScopeKeyForMatch(a);
  const nb = normalizeScopeKeyForMatch(b);
  return Boolean(na && nb && na === nb);
}

function findThreadInRegistry(reg, threadId) {
  const tid = String(threadId || '').trim();
  if (!tid || !reg?.threads) return null;
  return (
    reg.threads[tid] ||
    Object.values(reg.threads).find((x) => x && x.conversationId === tid) ||
    null
  );
}

function resolveDecisionScopeSync(scopeInput = {}, existingReg = null) {
  const reg = existingReg || loadRegistry();
  const input =
    typeof scopeInput === 'string'
      ? { workspaceKey: scopeInput }
      : scopeInput && typeof scopeInput === 'object'
        ? scopeInput
        : {};

  const rawScopeKey = String(input.scopeKey || input.workspaceKey || '').trim();
  const rawWorkspacePath = String(input.workspacePath || input.workspace || '').trim();
  const rawProjectId =
    input.projectId && input.projectId !== 'outside-of-project'
      ? String(input.projectId).trim()
      : '';
  const rawCoordId = String(input.coordinatorId || '').trim();
  const rawConvId = String(input.conversationId || '').trim();
  const rawThreadId = String(input.threadId || '').trim();

  const hasExplicitScope = Boolean(
    (rawScopeKey && rawScopeKey !== '*') ||
      rawWorkspacePath ||
      rawCoordId ||
      rawConvId ||
      rawProjectId,
  );
  const matchedThread = rawThreadId ? findThreadInRegistry(reg, rawThreadId) : null;
  let scopeKey = '';
  let projectId = rawProjectId || '';
  let coordinatorId = rawCoordId || '';

  if (rawScopeKey && rawScopeKey !== '*') {
    scopeKey = normalizeScopeKeyForMatch(rawScopeKey);
  }

  if (!scopeKey && rawWorkspacePath) {
    const cleanWs = uriToPath(rawWorkspacePath);
    const inferredWsScope = cleanWs
      ? inferScopeKeyFromRegistry({ workspacePath: cleanWs }, reg)
      : '';
    if (inferredWsScope) {
      scopeKey = normalizeScopeKeyForMatch(inferredWsScope);
    } else if (cleanWs) {
      scopeKey = normalizeKey(cleanWs);
    }
    if (scopeKey) {
      const matchedCoord = lookupCoordinatorForScope(reg, {
        scopeKey,
        workspacePath: cleanWs,
      });
      if (matchedCoord) {
        if (!projectId && matchedCoord.projectId && matchedCoord.projectId !== 'outside-of-project') {
          projectId = matchedCoord.projectId;
        }
        if (!coordinatorId && matchedCoord.conversationId) {
          coordinatorId = matchedCoord.conversationId;
        }
      }
    }
  }

  if (!scopeKey && (rawConvId || rawCoordId)) {
    // Align precedence with resolveProjectScope(): check conversationId first, then coordinatorId
    const convCandidates = [...new Set([rawConvId, rawCoordId].filter(Boolean))];
    for (const cid of convCandidates) {
      const byThread = Object.values(reg.threads || {}).find((t) => t?.conversationId === cid);
      if (byThread?.workspaceKey) {
        scopeKey = normalizeScopeKeyForMatch(byThread.workspaceKey);
        if (!projectId && byThread.projectId && byThread.projectId !== 'outside-of-project') {
          projectId = byThread.projectId;
        }
        if (!coordinatorId && byThread.coordinatorId) {
          coordinatorId = byThread.coordinatorId;
        }
        break;
      }
      const byCoord = Object.values(reg.coordinators || {}).find((c) => c?.conversationId === cid);
      if (byCoord?.key) {
        scopeKey = normalizeScopeKeyForMatch(byCoord.key);
        if (!projectId && byCoord.projectId && byCoord.projectId !== 'outside-of-project') {
          projectId = byCoord.projectId;
        }
        if (!coordinatorId) coordinatorId = byCoord.conversationId || '';
        break;
      }
    }
  }

  if (!scopeKey && projectId) {
    const byProj = Object.values(reg.coordinators || {}).find((c) => c?.projectId === projectId);
    if (byProj?.key) {
      scopeKey = normalizeScopeKeyForMatch(byProj.key);
      if (!coordinatorId && byProj.conversationId) coordinatorId = byProj.conversationId;
    } else {
      scopeKey = `project:${projectId}`;
    }
  }

  // Only infer scope from threadId when the caller did NOT specify an explicit project scope
  if (!scopeKey && !hasExplicitScope && matchedThread?.workspaceKey) {
    scopeKey = normalizeScopeKeyForMatch(matchedThread.workspaceKey);
    if (!projectId && matchedThread.projectId && matchedThread.projectId !== 'outside-of-project') {
      projectId = matchedThread.projectId;
    }
    if (!coordinatorId && matchedThread.coordinatorId) {
      coordinatorId = matchedThread.coordinatorId;
    }
  }

  if (scopeKey) {
    const coord = lookupCoordinatorForScope(reg, {
      scopeKey,
      workspacePath: rawWorkspacePath,
      projectId,
      conversationId: coordinatorId || rawConvId,
    });
    if (coord) {
      if (!projectId && coord.projectId && coord.projectId !== 'outside-of-project') {
        projectId = coord.projectId;
      }
      if (!coordinatorId && coord.conversationId) {
        coordinatorId = coord.conversationId;
      }
    }
  }

  let resolvedThread = null;
  let crossProjectThreadId = '';
  let unresolvedLocalSeqRef = '';
  if (rawThreadId) {
    const localSeq = parseLocalThreadSeqRef(rawThreadId);
    if (localSeq > 0) {
      if (scopeKey) {
        resolvedThread = findThreadByLocalSeqInScope(reg, scopeKey, localSeq);
        if (!resolvedThread) {
          unresolvedLocalSeqRef = rawThreadId;
        }
      } else {
        unresolvedLocalSeqRef = rawThreadId;
      }
    } else if (scopeKey && isUnifiedLocalThreadId(rawThreadId)) {
      const localMatched = findThreadByLocalIdInScope(reg, scopeKey, rawThreadId);
      if (localMatched) {
        resolvedThread = localMatched;
      } else if (matchedThread) {
        if (matchedThread.workspaceKey && !isSameScopeKey(matchedThread.workspaceKey, scopeKey)) {
          crossProjectThreadId = matchedThread.threadId;
        } else {
          resolvedThread = matchedThread;
        }
      }
    } else if (matchedThread) {
      if (scopeKey && matchedThread.workspaceKey && !isSameScopeKey(matchedThread.workspaceKey, scopeKey)) {
        crossProjectThreadId = matchedThread.threadId;
      } else {
        resolvedThread = matchedThread;
      }
    }
    if (resolvedThread) {
      if (!projectId && resolvedThread.projectId && resolvedThread.projectId !== 'outside-of-project') {
        projectId = resolvedThread.projectId;
      }
      if (!coordinatorId && resolvedThread.coordinatorId) {
        coordinatorId = resolvedThread.coordinatorId;
      }
    }
  }

  return {
    scopeKey,
    projectId: projectId && projectId !== 'outside-of-project' ? projectId : '',
    coordinatorId,
    threadId: crossProjectThreadId ? '' : resolvedThread?.threadId || rawThreadId,
    crossProjectThreadId,
    unresolvedLocalSeqRef,
  };
}

function normalizeDecisionOptions(rawOptions, { threadId = '', title = '', summary = '' } = {}) {
  const isZh = detectPromptLanguage(title, summary) === 'zh';
  const inputList = Array.isArray(rawOptions) ? rawOptions : [];
  const normalized = [];
  const usedIds = new Set();

  for (let i = 0; i < inputList.length && normalized.length < 3; i++) {
    const item = inputList[i];
    if (!item || typeof item !== 'object') continue;
    const label = String(item.label || item.title || '').trim().slice(0, 60);
    if (!label) continue;

    let action = String(item.action || 'send_coordinator').trim();
    if (!VALID_DECISION_ACTIONS.has(action)) action = 'send_coordinator';

    let style = String(item.style || '').trim().toLowerCase();
    if (!VALID_DECISION_STYLES.has(style)) {
      style = action === 'dismiss' ? 'secondary' : normalized.length === 0 ? 'primary' : 'secondary';
    }

    let id = String(item.id || `opt-${normalized.length + 1}`).trim().slice(0, 48);
    if (!id || usedIds.has(id)) {
      id = `opt-${normalized.length + 1}`;
    }
    usedIds.add(id);

    const rawMsg = String(item.message || '').trim();
    const message =
      action === 'send_coordinator'
        ? rawMsg ||
          (isZh
            ? `请按「${label}」处理${threadId ? `（关联线程 ${threadId}）` : ''}：${title}`
            : `Proceed with "${label}"${threadId ? ` (thread ${threadId})` : ''}: ${title}`)
        : rawMsg;

    normalized.push({ id, label, action, message, style });
  }

  if (normalized.length === 0) {
    normalized.push(
      {
        id: 'opt-1',
        label: isZh ? '确认执行' : 'Confirm',
        action: 'send_coordinator',
        message: isZh
          ? `用户已确认处理决策「${title}」${threadId ? `（关联线程 ${threadId}）` : ''}，请继续执行。`
          : `User confirmed decision "${title}"${threadId ? ` (thread ${threadId})` : ''}. Please proceed.`,
        style: 'primary',
      },
      {
        id: 'opt-2',
        label: isZh ? '忽略' : 'Dismiss',
        action: 'dismiss',
        message: '',
        style: 'secondary',
      },
    );
  }

  return normalized;
}

export function listDecisions(scope = {}, existingReg = null) {
  const reg = existingReg || loadRegistry();
  const opts =
    typeof scope === 'string'
      ? { workspaceKey: scope }
      : scope && typeof scope === 'object'
        ? scope
        : {};
  const includeResolved = Boolean(opts.includeResolved);
  const allWorkspaces = Boolean(opts.allWorkspaces);
  const decisions = Object.values(reg.decisions || {}).filter(
    (d) => d && typeof d === 'object' && d.id,
  );

  let filtered;
  if (allWorkspaces) {
    filtered = decisions.filter((d) => includeResolved || isActiveDecisionStatus(d.status));
  } else {
    const resolved = resolveDecisionScopeSync(opts, reg);
    if (!resolved.scopeKey) return [];
    filtered = decisions.filter((d) => {
      if (!includeResolved && !isActiveDecisionStatus(d.status)) return false;
      return isSameScopeKey(d.workspaceKey, resolved.scopeKey);
    });
  }

  filtered.sort((a, b) => {
    const cmp = String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    return cmp !== 0 ? cmp : String(b.id || '').localeCompare(String(a.id || ''));
  });

  const scopeSeqCache = new Map();
  return filtered.map((d) => {
    const linkedThread = d.threadId ? findThreadInRegistry(reg, d.threadId) : null;
    const threadProjectSeq = linkedThread
      ? getEffectiveThreadProjectSeq(linkedThread, reg, scopeSeqCache)
      : 0;
    const threadLocalId = linkedThread
      ? getThreadDisplayId(
          threadProjectSeq > 0 && !parsePositiveSeq(linkedThread.projectSeq)
            ? { ...linkedThread, projectSeq: threadProjectSeq }
            : linkedThread,
        )
      : '';
    return {
      ...d,
      ...(threadProjectSeq > 0 ? { threadProjectSeq } : {}),
      ...(threadLocalId ? { threadLocalId } : {}),
      source: 'explicit',
      options: Array.isArray(d.options) ? d.options.map((o) => ({ ...o })) : [],
    };
  });
}

export function addDecision(params = {}) {
  const title = String(params?.title || '').trim();
  if (!title) {
    throw new Error('`title` is required to add a decision.');
  }
  const summary = String(params?.summary || '').trim().slice(0, 400);

  return mutateRegistry((reg) => {
    assertNotRetiredCoordinator(reg, {
      coordinatorId: params?.coordinatorId || '',
      conversationId: params?.conversationId || '',
    });
    const resolved = resolveDecisionScopeSync(params, reg);
    if (resolved.crossProjectThreadId) {
      throw new Error(
        `Cross-project access denied: thread "${resolved.crossProjectThreadId}" belongs to a different project scope than "${resolved.scopeKey}".`,
      );
    }
    if (resolved.unresolvedLocalSeqRef) {
      throw new Error(
        resolved.scopeKey
          ? `Thread not found in project scope "${resolved.scopeKey}": ${resolved.unresolvedLocalSeqRef}`
          : `Project scope is required when referencing a thread by project-local sequence "${resolved.unresolvedLocalSeqRef}".`,
      );
    }
    if (!resolved.scopeKey) {
      throw new Error(
        'Unable to resolve project scope for decision; provide workspacePath, workspaceKey, coordinatorId, projectId, or threadId.',
      );
    }

    const nextSeq =
      Math.max(Number(reg.decisionSeq) || 0, inferMaxDecisionSeq(reg.decisions)) + 1;
    reg.decisionSeq = nextSeq;
    const id = `dec-${String(nextSeq).padStart(3, '0')}`;
    const now = new Date().toISOString();
    const threadId = resolved.threadId || '';
    const linkedThread = threadId ? findThreadInRegistry(reg, threadId) : null;
    const threadProjectSeq = linkedThread ? getEffectiveThreadProjectSeq(linkedThread, reg) : 0;
    const threadLocalId = linkedThread
      ? getThreadDisplayId(
          threadProjectSeq > 0 && !parsePositiveSeq(linkedThread.projectSeq)
            ? { ...linkedThread, projectSeq: threadProjectSeq }
            : linkedThread,
        )
      : '';
    const threadLastCommit = String(linkedThread?.git?.lastCommit || '').trim();
    const options = normalizeDecisionOptions(params?.options, {
      threadId: threadLocalId || threadId,
      title,
      summary,
    });

    const record = {
      id,
      source: 'explicit',
      workspaceKey: resolved.scopeKey,
      projectId: resolved.projectId || '',
      coordinatorId: resolved.coordinatorId || '',
      threadId,
      threadLastCommit,
      resolvedThreadLastCommit: '',
      title: title.slice(0, 140),
      summary,
      options,
      status: 'pending',
      sendingClaimToken: '',
      sendingClaimedAt: '',
      createdAt: now,
      updatedAt: now,
      resolvedAt: '',
      resolvedOptionId: '',
      resolvedOptionLabel: '',
      resolvedCustomMessage: '',
    };

    if (!reg.decisions || typeof reg.decisions !== 'object') reg.decisions = {};
    reg.decisions[id] = record;
    return {
      ...record,
      ...(threadProjectSeq > 0 ? { threadProjectSeq } : {}),
      ...(threadLocalId ? { threadLocalId } : {}),
      options: record.options.map((o) => ({ ...o })),
    };
  });
}

function claimExplicitDecision(
  decisionId,
  claimToken,
  { coordinatorId = '', conversationId = '', expectedScopeKey = '' } = {},
) {
  return mutateRegistry((reg) => {
    assertNotRetiredCoordinator(reg, { coordinatorId, conversationId });
    const existing = reg.decisions?.[decisionId];
    if (!existing) {
      throw new Error(`Decision not found: ${decisionId}`);
    }
    if (
      expectedScopeKey &&
      existing.workspaceKey &&
      !isSameScopeKey(existing.workspaceKey, expectedScopeKey)
    ) {
      throw new Error(
        `Cross-project access denied: decision "${existing.id}" belongs to a different project scope than "${expectedScopeKey}".`,
      );
    }
    if (existing.status === 'resolved' || existing.status === 'dismissed') {
      return {
        claimed: false,
        reason: 'already_resolved',
        decision: cloneDecisionRecord(existing),
      };
    }
    if (
      existing.status === 'sending' &&
      existing.sendingClaimToken &&
      existing.sendingClaimToken !== claimToken &&
      isDecisionClaimFresh(existing.sendingClaimedAt)
    ) {
      return {
        claimed: false,
        reason: 'in_progress',
        decision: cloneDecisionRecord(existing),
      };
    }
    const now = new Date().toISOString();
    existing.status = 'sending';
    existing.sendingClaimToken = claimToken;
    existing.sendingClaimedAt = now;
    existing.updatedAt = now;
    return {
      claimed: true,
      decision: cloneDecisionRecord(existing),
    };
  });
}

function releaseExplicitDecisionClaim(decisionId, claimToken) {
  if (!decisionId || !claimToken) return;
  try {
    mutateRegistry((reg) => {
      const existing = reg.decisions?.[decisionId];
      if (!existing) return;
      if (existing.status === 'sending' && existing.sendingClaimToken === claimToken) {
        existing.status = 'pending';
        existing.sendingClaimToken = '';
        existing.sendingClaimedAt = '';
        existing.updatedAt = new Date().toISOString();
      }
    });
  } catch {
    // Non-fatal rollback error
  }
}

function claimAutoDecision(
  autoClaimKey,
  claimToken,
  { threadId = '', autoKind = '', lastCommit = '', coordinatorId = '', conversationId = '' } = {},
) {
  return mutateRegistry((reg) => {
    assertNotRetiredCoordinator(reg, { coordinatorId, conversationId });
    if (
      threadId &&
      isAutoDecisionDismissed(reg, {
        threadId,
        autoKind,
        lastCommit,
      })
    ) {
      return { claimed: false, reason: 'already_resolved' };
    }
    if (!reg.inFlightAutoDecisions || typeof reg.inFlightAutoDecisions !== 'object') {
      reg.inFlightAutoDecisions = {};
    }
    const cur = reg.inFlightAutoDecisions[autoClaimKey];
    if (
      cur &&
      cur.state === 'sending' &&
      cur.token &&
      cur.token !== claimToken &&
      isDecisionClaimFresh(cur.claimedAt)
    ) {
      return { claimed: false, reason: 'in_progress' };
    }
    const now = new Date().toISOString();
    reg.inFlightAutoDecisions[autoClaimKey] = {
      state: 'sending',
      token: claimToken,
      claimedAt: now,
      updatedAt: now,
    };
    return { claimed: true };
  });
}

function releaseAutoDecisionClaim(autoClaimKey, claimToken) {
  if (!autoClaimKey || !claimToken) return;
  try {
    mutateRegistry((reg) => {
      const cur = reg.inFlightAutoDecisions?.[autoClaimKey];
      if (cur && cur.state === 'sending' && cur.token === claimToken) {
        const now = new Date().toISOString();
        reg.inFlightAutoDecisions[autoClaimKey] = {
          state: 'released',
          token: '',
          claimedAt: '',
          updatedAt: now,
        };
      }
    });
  } catch {
    // Non-fatal rollback error
  }
}

export function resolveDecision(idOrParams, extra = {}) {
  const opts =
    typeof idOrParams === 'string'
      ? { decisionId: idOrParams, ...(extra && typeof extra === 'object' ? extra : {}) }
      : idOrParams && typeof idOrParams === 'object'
        ? { ...idOrParams, ...(extra && typeof extra === 'object' ? extra : {}) }
        : {};
  const decisionId = String(opts.decisionId || opts.id || '').trim();
  if (!decisionId) {
    throw new Error('`decisionId` is required to resolve a decision.');
  }

  return mutateRegistry((reg) => {
    assertNotRetiredCoordinator(reg, {
      coordinatorId: opts.coordinatorId || '',
      conversationId: opts.conversationId || '',
    });
    const existing = reg.decisions?.[decisionId];
    if (!existing) {
      throw new Error(`Decision not found: ${decisionId}`);
    }
    const rawExpectedScope = String(opts.expectedScopeKey || opts.workspaceKey || '').trim();
    const rawResolveWsPath = String(opts.workspacePath || opts.workspace || '').trim();
    const rawResolveProjId =
      opts.projectId && opts.projectId !== 'outside-of-project'
        ? String(opts.projectId).trim()
        : '';
    const hasResolveScope = Boolean(
      (rawExpectedScope && rawExpectedScope !== '*') ||
        rawResolveWsPath ||
        String(opts.coordinatorId || '').trim() ||
        String(opts.conversationId || '').trim() ||
        rawResolveProjId,
    );
    if (hasResolveScope) {
      const resolvedScope = resolveDecisionScopeSync(
        {
          workspaceKey: rawExpectedScope,
          workspacePath: rawResolveWsPath,
          coordinatorId: opts.coordinatorId || '',
          conversationId: opts.conversationId || '',
          projectId: rawResolveProjId,
        },
        reg,
      );
      const effectiveScopeKey = normalizeScopeKeyForMatch(
        (rawExpectedScope && rawExpectedScope !== '*' ? rawExpectedScope : '') ||
          resolvedScope.scopeKey,
      );
      if (!effectiveScopeKey && !rawResolveProjId) {
        throw new Error('Unable to resolve project scope for decision (fail-closed).');
      }
      if (
        effectiveScopeKey &&
        existing.workspaceKey &&
        !isSameScopeKey(existing.workspaceKey, effectiveScopeKey)
      ) {
        throw new Error(
          `Cross-project access denied: decision "${existing.id}" belongs to a different project scope than "${effectiveScopeKey}".`,
        );
      }
      const existingProjId =
        existing.projectId && existing.projectId !== 'outside-of-project'
          ? String(existing.projectId).trim()
          : '';
      if (rawResolveProjId && existingProjId && rawResolveProjId !== existingProjId) {
        throw new Error(
          `Cross-project access denied: decision "${existing.id}" belongs to a different project than "${rawResolveProjId}".`,
        );
      }
    }
    const claimToken = String(opts.claimToken || '').trim();
    if (existing.status === 'resolved' || existing.status === 'dismissed') {
      const err = new Error(`Decision "${decisionId}" is already ${existing.status}.`);
      err.code = 'already_resolved';
      throw err;
    }
    if (existing.status === 'sending') {
      if (
        existing.sendingClaimToken &&
        existing.sendingClaimToken !== claimToken &&
        isDecisionClaimFresh(existing.sendingClaimedAt)
      ) {
        const err = new Error(`Decision "${decisionId}" is currently in progress.`);
        err.code = 'in_progress';
        throw err;
      }
    }

    const now = new Date().toISOString();
    const optionId = String(opts.optionId || '').trim();
    const matchedOpt = optionId
      ? (existing.options || []).find((o) => o && o.id === optionId)
      : null;
    const optionLabel = String(opts.optionLabel || matchedOpt?.label || '').trim();
    const customMessage = String(opts.customMessage ?? opts.customReply ?? '')
      .trim()
      .slice(0, MAX_DECISION_CUSTOM_MESSAGE_LENGTH);

    const nextStatus = opts.status === 'dismissed' ? 'dismissed' : 'resolved';
    existing.status = nextStatus;
    existing.sendingClaimToken = '';
    existing.sendingClaimedAt = '';
    existing.resolvedAt = now;
    existing.updatedAt = now;
    if (optionId) existing.resolvedOptionId = optionId;
    if (optionLabel) existing.resolvedOptionLabel = optionLabel;
    if (customMessage) existing.resolvedCustomMessage = customMessage;
    if (nextStatus === 'resolved' && existing.threadId) {
      const linkedThread = findThreadInRegistry(reg, existing.threadId);
      const effectiveCommit = String(
        opts.threadLastCommit ||
          linkedThread?.git?.lastCommit ||
          existing.threadLastCommit ||
          '',
      ).trim();
      if (effectiveCommit) {
        existing.resolvedThreadLastCommit = effectiveCommit;
        if (!existing.threadLastCommit) existing.threadLastCommit = effectiveCommit;
      }
    }

    return cloneDecisionRecord(existing);
  });
}

function parseAutoDismissTarget(decisionIdOrAutoKey, opts = {}, reg = null) {
  const extra = opts && typeof opts === 'object' ? opts : {};
  const objInput =
    decisionIdOrAutoKey && typeof decisionIdOrAutoKey === 'object' ? decisionIdOrAutoKey : null;
  let rawKey = '';
  let threadId = String(extra.threadId || '').trim();
  let autoKind = String(extra.autoKind || '').trim();
  let lastCommit = String(extra.lastCommit || '').trim();
  let workspaceKey = String(extra.expectedScopeKey || extra.workspaceKey || '').trim();
  const workspacePath = String(
    extra.workspacePath ||
      extra.workspace ||
      objInput?.workspacePath ||
      objInput?.workspace ||
      '',
  ).trim();
  const coordinatorId = String(extra.coordinatorId || objInput?.coordinatorId || '').trim();
  const conversationId = String(extra.conversationId || objInput?.conversationId || '').trim();
  const rawProjectId = String(extra.projectId || objInput?.projectId || '').trim();
  const projectId =
    rawProjectId && rawProjectId !== 'outside-of-project' ? rawProjectId : '';

  if (objInput) {
    rawKey = String(objInput.decisionId || objInput.autoKey || objInput.id || '').trim();
    if (!threadId) threadId = String(objInput.threadId || '').trim();
    if (!autoKind) autoKind = String(objInput.autoKind || '').trim();
    if (!lastCommit) lastCommit = String(objInput.lastCommit || '').trim();
    if (!workspaceKey) workspaceKey = String(objInput.expectedScopeKey || objInput.workspaceKey || '').trim();
  } else {
    rawKey = String(decisionIdOrAutoKey || '').trim();
  }

  if (rawKey.startsWith('auto:')) {
    const parts = rawKey.split(':');
    // auto:<autoKind>:<threadId>[:<lastCommit...>]
    if (parts.length >= 3) {
      if (!autoKind && VALID_AUTO_KINDS.has(parts[1])) autoKind = parts[1];
      if (!threadId) threadId = parts[2];
      if (!lastCommit && parts.length >= 4) lastCommit = parts.slice(3).join(':');
    }
  } else if (rawKey && !threadId && rawKey.includes(':')) {
    const firstColon = rawKey.indexOf(':');
    const candThread = rawKey.slice(0, firstColon).trim();
    const rest = rawKey.slice(firstColon + 1).trim();
    if (candThread) {
      threadId = candThread;
      const secondColon = rest.indexOf(':');
      if (secondColon !== -1 && VALID_AUTO_KINDS.has(rest.slice(0, secondColon))) {
        if (!autoKind) autoKind = rest.slice(0, secondColon);
        if (!lastCommit) lastCommit = rest.slice(secondColon + 1).trim();
      } else if (!lastCommit) {
        lastCommit = rest;
      }
    }
  }

  const hasExplicitCallerScope = Boolean(
    (workspaceKey && workspaceKey !== '*') ||
      workspacePath ||
      coordinatorId ||
      conversationId ||
      projectId,
  );
  let callerScopeKey = normalizeScopeKeyForMatch(workspaceKey);
  if (!callerScopeKey && hasExplicitCallerScope && reg) {
    const resolvedScope = resolveDecisionScopeSync(
      {
        workspaceKey,
        workspacePath,
        coordinatorId,
        conversationId,
        projectId,
      },
      reg,
    );
    callerScopeKey = normalizeScopeKeyForMatch(resolvedScope.scopeKey);
  }
  if (callerScopeKey && !workspaceKey) {
    workspaceKey = callerScopeKey;
  }

  let threadRec = null;
  let crossProjectThreadId = '';
  let crossProjectDisplayId = '';
  let unresolvedLocalRef = '';
  const unresolvedCallerScope = Boolean(hasExplicitCallerScope && !callerScopeKey && !projectId);
  if (threadId && reg) {
    const localSeq = parseLocalThreadSeqRef(threadId);
    if (unresolvedCallerScope) {
      unresolvedLocalRef = threadId;
    } else if (localSeq > 0) {
      if (callerScopeKey) {
        threadRec = findThreadByLocalSeqInScope(reg, callerScopeKey, localSeq);
        if (!threadRec) unresolvedLocalRef = threadId;
      } else {
        unresolvedLocalRef = threadId;
      }
    } else if (callerScopeKey && isUnifiedLocalThreadId(threadId)) {
      // Strictly resolve project-local thr-NNN inside caller's scope FIRST before inspecting global keys
      threadRec = findThreadByLocalIdInScope(reg, callerScopeKey, threadId);
      if (!threadRec) {
        const globalHit = findThreadInRegistry(reg, threadId);
        if (globalHit && globalHit.workspaceKey && !isSameScopeKey(globalHit.workspaceKey, callerScopeKey)) {
          crossProjectThreadId = globalHit.threadId;
          crossProjectDisplayId = getThreadDisplayId(globalHit) || globalHit.threadId;
        } else {
          unresolvedLocalRef = threadId;
        }
      }
    } else {
      const found = findThreadInRegistry(reg, threadId);
      if (found) {
        if (callerScopeKey && found.workspaceKey && !isSameScopeKey(found.workspaceKey, callerScopeKey)) {
          crossProjectThreadId = found.threadId;
          crossProjectDisplayId = getThreadDisplayId(found) || found.threadId;
        } else {
          threadRec = found;
        }
      }
    }
  }
  if (threadRec) {
    threadId = threadRec.threadId;
    if (!lastCommit && threadRec.git?.lastCommit) {
      lastCommit = String(threadRec.git.lastCommit).trim();
    }
    if (!workspaceKey && threadRec.workspaceKey) {
      workspaceKey = threadRec.workspaceKey;
    }
  }

  const normalizedKind = VALID_AUTO_KINDS.has(autoKind) ? autoKind : '*';
  const commitStamp = lastCommit || '__no_commit__';
  return {
    rawKey,
    threadId,
    threadLocalId: threadRec ? getThreadDisplayId(threadRec) : '',
    autoKind: normalizedKind,
    lastCommit: commitStamp,
    workspaceKey: normalizeScopeKeyForMatch(workspaceKey),
    callerScopeKey,
    crossProjectThreadId,
    crossProjectDisplayId,
    unresolvedLocalRef,
  };
}

export function dismissDecision(decisionIdOrAutoKey, opts = {}) {
  const objInput =
    decisionIdOrAutoKey && typeof decisionIdOrAutoKey === 'object' ? decisionIdOrAutoKey : null;
  const explicitCandidateId =
    typeof decisionIdOrAutoKey === 'string'
      ? decisionIdOrAutoKey.trim()
      : String(objInput?.decisionId || objInput?.id || '').trim();

  const callerCoordId = String(objInput?.coordinatorId || opts?.coordinatorId || '').trim();
  const callerConvId = String(objInput?.conversationId || opts?.conversationId || '').trim();
  const callerWsKey = String(
    objInput?.expectedScopeKey ||
      objInput?.workspaceKey ||
      opts?.expectedScopeKey ||
      opts?.workspaceKey ||
      '',
  ).trim();
  const callerWsPath = String(
    objInput?.workspacePath ||
      objInput?.workspace ||
      opts?.workspacePath ||
      opts?.workspace ||
      '',
  ).trim();
  const rawCallerProjId = String(objInput?.projectId || opts?.projectId || '').trim();
  const callerProjId =
    rawCallerProjId && rawCallerProjId !== 'outside-of-project' ? rawCallerProjId : '';

  return mutateRegistry((reg) => {
    assertNotRetiredCoordinator(reg, {
      coordinatorId: callerCoordId,
      conversationId: callerConvId,
    });

    const hasExplicitScope = Boolean(
      (callerWsKey && callerWsKey !== '*') ||
        callerWsPath ||
        callerCoordId ||
        callerConvId ||
        callerProjId,
    );
    let callerScopeKey = normalizeScopeKeyForMatch(callerWsKey);
    if (!callerScopeKey && hasExplicitScope) {
      const resolvedScope = resolveDecisionScopeSync(
        {
          workspaceKey: callerWsKey,
          workspacePath: callerWsPath,
          coordinatorId: callerCoordId,
          conversationId: callerConvId,
          projectId: callerProjId,
        },
        reg,
      );
      callerScopeKey = normalizeScopeKeyForMatch(resolvedScope.scopeKey);
    }
    if (hasExplicitScope && !callerScopeKey && !callerProjId) {
      throw new Error('Unable to resolve project scope for decision (fail-closed).');
    }

    if (explicitCandidateId && reg.decisions?.[explicitCandidateId]) {
      const existing = reg.decisions[explicitCandidateId];
      if (
        callerScopeKey &&
        existing.workspaceKey &&
        !isSameScopeKey(existing.workspaceKey, callerScopeKey)
      ) {
        throw new Error(
          `Cross-project access denied: decision "${existing.id}" belongs to a different project scope than "${callerScopeKey}".`,
        );
      }
      const existingProjId =
        existing.projectId && existing.projectId !== 'outside-of-project'
          ? String(existing.projectId).trim()
          : '';
      if (callerProjId && existingProjId && callerProjId !== existingProjId) {
        throw new Error(
          `Cross-project access denied: decision "${existing.id}" belongs to a different project than "${callerProjId}".`,
        );
      }
      if (existing.status === 'resolved' || existing.status === 'dismissed') {
        return {
          ok: true,
          alreadyResolved: true,
          reason: 'already_resolved',
          source: 'explicit',
          decisionId: explicitCandidateId,
          decision: cloneDecisionRecord(existing),
        };
      }
      if (existing.status === 'sending' && isDecisionClaimFresh(existing.sendingClaimedAt)) {
        const err = new Error(`Decision "${explicitCandidateId}" is currently in progress.`);
        err.code = 'in_progress';
        throw err;
      }
      const now = new Date().toISOString();
      existing.status = 'dismissed';
      existing.sendingClaimToken = '';
      existing.sendingClaimedAt = '';
      existing.resolvedAt = now;
      existing.updatedAt = now;
      return {
        ok: true,
        source: 'explicit',
        decisionId: explicitCandidateId,
        decision: cloneDecisionRecord(existing),
      };
    }

    if (explicitCandidateId && /^dec-\d+$/i.test(explicitCandidateId)) {
      throw new Error(`Decision not found: ${explicitCandidateId}`);
    }

    const parsed = parseAutoDismissTarget(
      decisionIdOrAutoKey,
      {
        ...(opts && typeof opts === 'object' ? opts : {}),
        ...(callerScopeKey ? { workspaceKey: callerScopeKey } : {}),
        ...(callerWsPath ? { workspacePath: callerWsPath } : {}),
        ...(callerCoordId ? { coordinatorId: callerCoordId } : {}),
        ...(callerConvId ? { conversationId: callerConvId } : {}),
        ...(callerProjId ? { projectId: callerProjId } : {}),
      },
      reg,
    );
    if (parsed.crossProjectThreadId) {
      throw new Error(
        `Cross-project access denied: thread "${parsed.crossProjectDisplayId || parsed.crossProjectThreadId}" belongs to a different project scope than "${callerScopeKey || parsed.callerScopeKey}".`,
      );
    }
    if (parsed.unresolvedLocalRef) {
      throw new Error(
        callerScopeKey || parsed.callerScopeKey
          ? `Thread not found in project scope "${callerScopeKey || parsed.callerScopeKey}": ${parsed.unresolvedLocalRef}`
          : `Project scope is required when referencing a thread by project-local ID "${parsed.unresolvedLocalRef}".`,
      );
    }
    if (
      callerScopeKey &&
      parsed.workspaceKey &&
      !isSameScopeKey(parsed.workspaceKey, callerScopeKey)
    ) {
      throw new Error(
        `Cross-project access denied: auto decision "${explicitCandidateId || parsed.threadLocalId || parsed.threadId}" belongs to a different project scope than "${callerScopeKey}".`,
      );
    }
    if (!parsed.threadId) {
      throw new Error('`decisionId` or valid auto-decision key (`threadId:lastCommit`) is required.');
    }

    const storeKey = `${parsed.threadId}:${parsed.autoKind}`;
    const now = new Date().toISOString();
    const resolution = String(
      (objInput ? objInput.resolution : '') ||
        opts?.resolution ||
        '',
    ).trim();
    const customMessage = String(
      (objInput ? objInput.customMessage ?? objInput.customReply : '') ||
        opts?.customMessage ||
        opts?.customReply ||
        '',
    )
      .trim()
      .slice(0, 2000);
    const entry = {
      key: storeKey,
      workspaceKey: parsed.workspaceKey,
      threadId: parsed.threadId,
      autoKind: parsed.autoKind,
      lastCommit: parsed.lastCommit,
      dismissedAt: now,
      ...(resolution ? { resolution } : {}),
      ...(customMessage ? { customMessage } : {}),
    };
    if (!reg.dismissedAutoDecisions || typeof reg.dismissedAutoDecisions !== 'object') {
      reg.dismissedAutoDecisions = {};
    }
    reg.dismissedAutoDecisions[storeKey] = entry;
    if (!resolution && parsed.autoKind === 'watchdog_stalled' && parsed.workspaceKey && parsed.threadId) {
      snoozeThreadWatchdogInReg(reg, {
        workspaceKey: parsed.workspaceKey,
        threadId: parsed.threadId,
      });
    }
    return {
      ok: true,
      source: 'auto',
      ...entry,
      ...(parsed.threadLocalId ? { threadLocalId: parsed.threadLocalId } : {}),
    };
  });
}

function isAutoDecisionDismissed(reg, { threadId, autoKind, lastCommit }) {
  const map = reg?.dismissedAutoDecisions;
  if (!map || typeof map !== 'object' || !threadId) return false;
  const commitStamp = String(lastCommit || '').trim() || '__no_commit__';
  const keysToCheck = [
    `${threadId}:${autoKind}`,
    `${threadId}:*`,
    `${threadId}:${commitStamp}`,
  ];
  for (const k of keysToCheck) {
    const entry = map[k];
    if (entry && String(entry.lastCommit || '__no_commit__') === commitStamp) {
      return true;
    }
  }
  return false;
}

function buildAutoWatchdogDecisionItem(t, wd, { scopeKey, projectId, locale }) {
  const loc = locale === 'zh-CN' || locale === 'zh-TW' ? locale : 'en';
  const threadProjectSeq = parsePositiveSeq(t.projectSeq);
  const threadLocalId = getThreadDisplayId(t) || formatLocalThreadId(threadProjectSeq);
  const displayTid = threadLocalId || t.threadId;
  const fp = String(wd?.stallFingerprint || '').trim() || '__no_commit__';
  const durText = formatWatchdogDuration(wd?.stalledDurationMs || 0, loc);
  const reasonText = describeStallReason(wd?.stallReason || 'no_progress_running', loc);

  const title =
    loc === 'zh-CN'
      ? '线程疑似停滞，待核查'
      : loc === 'zh-TW'
        ? '執行緒疑似停滯，待核查'
        : 'Thread appears stalled';
  const summary =
    loc === 'zh-CN'
      ? `${t.title}（已停滞约 ${durText}，${reasonText}）`
      : loc === 'zh-TW'
        ? `${t.title}（已停滯約 ${durText}，${reasonText}）`
        : `${t.title} (stalled ~${durText} - ${reasonText})`;
  const inspectLabel =
    loc === 'zh-CN' ? '唤醒总控核查' : loc === 'zh-TW' ? '喚醒總控核查' : 'Ask Coordinator to Inspect';
  const dismissLabel = loc === 'en' ? 'Snooze' : loc === 'zh-TW' ? '暫緩' : '暂缓';
  const inspectMessage =
    loc === 'zh-CN'
      ? `后台看门狗检测到工作线程 \`${displayTid}\`（${t.title}）疑似停滞约 ${durText}（原因：${reasonText}）。请调用 \`get_thread_detail\` 核实状态，并按需通过 \`send_thread_message\` 唤醒跟进或汇报处理建议。`
      : loc === 'zh-TW'
        ? `背景看門狗偵測到工作執行緒 \`${displayTid}\`（${t.title}）疑似停滯約 ${durText}（原因：${reasonText}）。請呼叫 \`get_thread_detail\` 核實狀態，並按需透過 \`send_thread_message\` 喚醒跟進或回報處理建議。`
        : `Background Watchdog detected that worker thread \`${displayTid}\` (${t.title}) appears stalled for ~${durText} (${reasonText}). Please call \`get_thread_detail\` to inspect its live state and follow up via \`send_thread_message\` or advise next steps.`;

  return {
    id: `auto:watchdog_stalled:${t.threadId}`,
    source: 'auto',
    autoKind: 'watchdog_stalled',
    autoKey: `${t.threadId}:watchdog_stalled:${fp}`,
    lastCommit: fp,
    workspaceKey: t.workspaceKey || scopeKey || '',
    projectId: t.projectId || projectId || '',
    coordinatorId: t.coordinatorId || '',
    threadId: t.threadId,
    ...(threadProjectSeq > 0 ? { threadProjectSeq } : {}),
    ...(threadLocalId ? { threadLocalId } : {}),
    threadTitle: t.title || '',
    stallReason: String(wd?.stallReason || ''),
    stalledDurationMs: Number(wd?.stalledDurationMs) || 0,
    pendingDelivery: Boolean(wd?.pendingDelivery),
    title,
    summary,
    options: [
      {
        id: 'inspect_stalled',
        label: inspectLabel,
        action: 'send_coordinator',
        message: inspectMessage,
        style: 'primary',
      },
      {
        id: 'dismiss',
        label: dismissLabel,
        action: 'dismiss',
        message: '',
        style: 'secondary',
      },
    ],
    status: 'pending',
    createdAt: wd?.stalledSinceAt || t.updatedAt || t.createdAt || '',
  };
}

function buildAutoWorktreeDecisionItem(t, { autoKind, scopeKey, projectId, locale }) {
  const branch = String(t.git?.branch || t.branch || '').trim();
  const baseRef = String(t.baseRef || '').trim();
  const aheadCount = Number(t.git?.aheadCount) || 0;
  const mergeMethod = String(t.git?.mergeMethod || '').trim();
  const isCherry = mergeMethod === 'cherry-pick';
  const commitStamp = String(t.git?.lastCommit || '').trim() || '__no_commit__';
  const loc = locale === 'zh-CN' || locale === 'zh-TW' ? locale : 'en';

  const threadProjectSeq = parsePositiveSeq(t.projectSeq);
  const threadLocalId = getThreadDisplayId(t) || formatLocalThreadId(threadProjectSeq);
  const displayTid = threadLocalId || t.threadId;

  if (autoKind === 'worktree_merge_ready') {
    const title =
      loc === 'zh-CN'
        ? '分支已就绪，待合入'
        : loc === 'zh-TW'
          ? '分支已就緒，待合併'
          : 'Worktree ready to merge';
    const summary =
      loc === 'zh-CN'
        ? `${t.title}${branch ? `（${branch}，+${aheadCount} 次提交）` : `（+${aheadCount} 次提交）`}`
        : loc === 'zh-TW'
          ? `${t.title}${branch ? `（${branch}，+${aheadCount} 次提交）` : `（+${aheadCount} 次提交）`}`
          : `${t.title}${branch ? ` (${branch}, +${aheadCount} commit${aheadCount === 1 ? '' : 's'})` : ` (+${aheadCount} commit${aheadCount === 1 ? '' : 's'})`}`;
    const mergeLabel =
      loc === 'zh-CN' ? '合入目标分支' : loc === 'zh-TW' ? '合併至目標分支' : 'Merge to target';
    const dismissLabel = loc === 'en' ? 'Dismiss' : '忽略';
    const mergeMessage =
      loc === 'zh-CN'
        ? `请将工作线程 \`${displayTid}\`（${t.title}${branch ? `，分支 \`${branch}\`` : ''}${baseRef ? `，目标基准 \`${baseRef}\`` : ''}）的已提交改动安全合入目标分支，并在完成后汇报。`
        : loc === 'zh-TW'
          ? `請將工作執行緒 \`${displayTid}\`（${t.title}${branch ? `，分支 \`${branch}\`` : ''}${baseRef ? `，目標基準 \`${baseRef}\`` : ''}）的已提交改動安全合併至目標分支，並在完成後回報。`
          : `Please merge the committed changes from worker thread \`${displayTid}\` (${t.title}${branch ? `, branch \`${branch}\`` : ''}${baseRef ? `, base \`${baseRef}\`` : ''}) into the target branch and report back.`;

    return {
      id: `auto:${autoKind}:${t.threadId}`,
      source: 'auto',
      autoKind,
      autoKey: `${t.threadId}:${autoKind}:${commitStamp}`,
      lastCommit: commitStamp,
      workspaceKey: t.workspaceKey || scopeKey || '',
      projectId: t.projectId || projectId || '',
      coordinatorId: t.coordinatorId || '',
      threadId: t.threadId,
      ...(threadProjectSeq > 0 ? { threadProjectSeq } : {}),
      ...(threadLocalId ? { threadLocalId } : {}),
      threadTitle: t.title || '',
      branch,
      baseRef,
      aheadCount,
      mergeMethod,
      title,
      summary,
      options: [
        {
          id: 'merge_to_target',
          label: mergeLabel,
          action: 'send_coordinator',
          message: mergeMessage,
          style: 'primary',
        },
        {
          id: 'dismiss',
          label: dismissLabel,
          action: 'dismiss',
          message: '',
          style: 'secondary',
        },
      ],
      status: 'pending',
      createdAt: t.lastCompletedAt || t.updatedAt || t.createdAt || '',
    };
  }

  // worktree_archive_ready
  const title =
    loc === 'zh-CN'
      ? isCherry
        ? '已 cherry-pick 合入，待验收归档'
        : '已合入，待验收归档'
      : loc === 'zh-TW'
        ? isCherry
          ? '已 cherry-pick 合併，待驗收封存'
          : '已合併，待驗收封存'
        : isCherry
          ? 'Cherry-picked, ready to archive'
          : 'Merged, ready to archive';
  const summary =
    loc === 'zh-CN'
      ? `${t.title}${branch ? `（${branch}）` : ''}`
      : loc === 'zh-TW'
        ? `${t.title}${branch ? `（${branch}）` : ''}`
        : `${t.title}${branch ? ` (${branch})` : ''}`;
  const archiveLabel =
    loc === 'zh-CN' ? '验收归档' : loc === 'zh-TW' ? '驗收封存' : 'Accept & Archive';
  const dismissLabel = loc === 'en' ? 'Dismiss' : '忽略';

  return {
    id: `auto:${autoKind}:${t.threadId}`,
    source: 'auto',
    autoKind,
    autoKey: `${t.threadId}:${autoKind}:${commitStamp}`,
    lastCommit: commitStamp,
    workspaceKey: t.workspaceKey || scopeKey || '',
    projectId: t.projectId || projectId || '',
    coordinatorId: t.coordinatorId || '',
    threadId: t.threadId,
    ...(threadProjectSeq > 0 ? { threadProjectSeq } : {}),
    ...(threadLocalId ? { threadLocalId } : {}),
    threadTitle: t.title || '',
    branch,
    baseRef,
    aheadCount,
    mergeMethod,
    title,
    summary,
    options: [
      {
        id: 'accept_archive',
        label: archiveLabel,
        action: 'archive_thread',
        message: '',
        style: 'primary',
      },
      {
        id: 'dismiss',
        label: dismissLabel,
        action: 'dismiss',
        message: '',
        style: 'secondary',
      },
    ],
    status: 'pending',
    createdAt: t.lastCompletedAt || t.updatedAt || t.createdAt || '',
  };
}

function hasResolvedExplicitDecisionForCommit(reg, { scopeKey = '', threadId = '', lastCommit = '' }) {
  const tid = String(threadId || '').trim();
  const commitStamp = String(lastCommit || '').trim();
  if (!tid || !commitStamp || commitStamp === '__no_commit__') return false;
  for (const d of Object.values(reg?.decisions || {})) {
    if (!d || typeof d !== 'object') continue;
    if (d.status !== 'resolved') continue;
    if (String(d.threadId || '').trim() !== tid) continue;
    if (scopeKey && d.workspaceKey && !isSameScopeKey(d.workspaceKey, scopeKey)) continue;
    const decCommit = String(d.resolvedThreadLastCommit || d.threadLastCommit || '').trim();
    if (decCommit && decCommit === commitStamp) {
      return true;
    }
  }
  return false;
}

export function buildBoardDecisions(scope = {}, threads = null, opts = {}) {
  const reg = opts?.reg || loadRegistry();
  const locale = opts?.locale || resolveAppLocale();
  const scopeObj =
    typeof scope === 'string'
      ? { workspaceKey: scope }
      : scope && typeof scope === 'object'
        ? scope
        : {};
  const resolved = resolveDecisionScopeSync(scopeObj, reg);

  const explicitList = listDecisions(
    { ...scopeObj, scopeKey: resolved.scopeKey, includeResolved: false },
    reg,
  );
  const explicitThreadIds = new Set(
    explicitList.map((d) => String(d.threadId || '').trim()).filter(Boolean),
  );

  let threadList;
  if (Array.isArray(threads)) {
    threadList = threads;
  } else if (resolved.scopeKey) {
    const scopeSeqCache = new Map();
    threadList = Object.values(reg.threads || {})
      .filter((t) => t && !t.archived && isSameScopeKey(t.workspaceKey, resolved.scopeKey))
      .map((t) => decorateThreadRecord(t, reg, scopeSeqCache));
  } else {
    threadList = [];
  }

  const autoList = [];
  for (const t of threadList) {
    if (!t || t.archived) continue;
    if (resolved.scopeKey && t.workspaceKey && !isSameScopeKey(t.workspaceKey, resolved.scopeKey)) {
      continue;
    }
    if (explicitThreadIds.has(t.threadId)) continue;

    // Auto watchdog stalled alert card (immediate board visibility even while Coordinator is busy)
    const wdSum = getThreadWatchdogSummary(reg, resolved.scopeKey || t.workspaceKey || '', t.threadId);
    if (wdSum && wdSum.stalled) {
      const fpStamp = String(wdSum.stallFingerprint || '').trim() || '__no_commit__';
      if (
        !isAutoDecisionDismissed(reg, {
          threadId: t.threadId,
          autoKind: 'watchdog_stalled',
          lastCommit: fpStamp,
        })
      ) {
        autoList.push(
          buildAutoWatchdogDecisionItem(t, wdSum, {
            scopeKey: resolved.scopeKey,
            projectId: resolved.projectId,
            locale,
          }),
        );
      }
      continue;
    }

    if (!t.worktreePath) continue;
    if (!t.git || t.git.exists === false) continue;
    if (t.runState !== 'RUN_STATE_IDLE' || Boolean(t.hasPendingBgTask) || t.bucket === 'working') {
      continue;
    }

    const aheadCount = Number(t.git.aheadCount) || 0;
    const dirtyCount = Number(t.git.dirtyCount) || 0;
    const merged = Boolean(t.git.merged);

    let autoKind = '';
    if (aheadCount > 0 && !merged && dirtyCount === 0) {
      autoKind = 'worktree_merge_ready';
    } else if (merged === true) {
      autoKind = 'worktree_archive_ready';
    }
    if (!autoKind) continue;

    const commitStamp = String(t.git.lastCommit || '').trim() || '__no_commit__';
    if (isAutoDecisionDismissed(reg, { threadId: t.threadId, autoKind, lastCommit: commitStamp })) {
      continue;
    }
    if (
      autoKind === 'worktree_merge_ready' &&
      hasResolvedExplicitDecisionForCommit(reg, {
        scopeKey: resolved.scopeKey || t.workspaceKey || '',
        threadId: t.threadId,
        lastCommit: commitStamp,
      })
    ) {
      continue;
    }

    autoList.push(
      buildAutoWorktreeDecisionItem(t, {
        autoKind,
        scopeKey: resolved.scopeKey,
        projectId: resolved.projectId,
        locale,
      }),
    );
  }

  autoList.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return [...explicitList, ...autoList];
}

export async function executeDecisionAction(params = {}) {
  const decisionId = String(params.decisionId || '').trim();
  const optionId = String(params.optionId || '').trim();
  const requestedAction = String(params.action || '').trim();
  const requestedThreadId = String(params.threadId || '').trim();
  const requestedAutoKind = String(params.autoKind || '').trim();
  const requestedLastCommit = String(params.lastCommit || '').trim();
  const requestedMessage = String(params.message || '').trim();
  const requestedCustomMessage = String(params.customMessage ?? params.customReply ?? '').trim();
  const requestedLabel = String(params.label || '').trim();
  const requestedSummary = String(params.summary || '').trim();

  const callerWsPath = String(params.workspacePath || params.workspace || '').trim();
  const callerWsKey = String(params.workspaceKey || '').trim();
  const callerCoordId = String(params.coordinatorId || '').trim();
  const callerConvId = String(params.conversationId || '').trim();
  const rawCallerProjId = String(params.projectId || '').trim();
  const callerProjId =
    rawCallerProjId && rawCallerProjId !== 'outside-of-project' ? rawCallerProjId : '';
  const hasCallerScope = Boolean(
    callerWsPath || callerWsKey || callerCoordId || callerConvId || rawCallerProjId,
  );

  const reg = loadRegistry();
  assertNotRetiredCoordinator(reg, {
    coordinatorId: callerCoordId,
    conversationId: callerConvId,
  });

  const explicitDec = decisionId && reg.decisions?.[decisionId] ? reg.decisions[decisionId] : null;
  if (decisionId && /^dec-\d+$/i.test(decisionId) && !explicitDec) {
    throw new Error(`Decision not found: ${decisionId}`);
  }
  const matchedOption =
    explicitDec && optionId
      ? (explicitDec.options || []).find((o) => o && o.id === optionId) || null
      : null;

  const effectiveAction =
    VALID_EXECUTE_DECISION_ACTIONS.has(requestedAction)
      ? requestedAction
      : requestedCustomMessage
        ? 'custom_reply'
        : matchedOption?.action || (decisionId && !explicitDec && !optionId ? 'dismiss' : '');

  if (!VALID_EXECUTE_DECISION_ACTIONS.has(effectiveAction)) {
    throw new Error(`Unsupported or missing decision action: ${effectiveAction || '(empty)'}`);
  }

  const isCustomReply =
    effectiveAction === 'custom_reply' ||
    (effectiveAction === 'send_coordinator' && Boolean(requestedCustomMessage));
  const customInstructionText = isCustomReply ? requestedCustomMessage || requestedMessage : '';
  if (effectiveAction === 'custom_reply' && !customInstructionText) {
    throw new Error('`customMessage` is required for custom_reply decision action.');
  }
  if (isCustomReply && customInstructionText.length > MAX_DECISION_CUSTOM_MESSAGE_LENGTH) {
    throw new Error(
      `\`customMessage\` must not exceed ${MAX_DECISION_CUSTOM_MESSAGE_LENGTH} characters.`,
    );
  }

  // P1-1: Resolve canonical caller project scope FIRST (handling file:// URIs, worktrees,
  // and repo subdirs) before parsing threadId or auto-decision keys so project-local
  // `thr-NNN` / `#N` targets always bind inside the caller's scope before global lookup.
  let syncScope = null;
  let callerScope = null;
  if (hasCallerScope) {
    if (callerWsPath || callerCoordId || callerConvId || callerProjId) {
      callerScope = await resolveProjectScope({
        workspacePath: callerWsPath,
        conversationId: callerConvId || callerCoordId,
        coordinatorId: callerCoordId,
        projectId: callerProjId,
        reg,
      });
    }
    syncScope = resolveDecisionScopeSync(
      {
        workspacePath: callerWsPath,
        workspaceKey: callerScope?.scopeKey || callerWsKey,
        coordinatorId: callerCoordId,
        conversationId: callerConvId,
        projectId: callerProjId,
        threadId: requestedThreadId,
      },
      reg,
    );
    if (syncScope.crossProjectThreadId) {
      throw new Error(
        `Cross-project access denied: thread "${syncScope.crossProjectThreadId}" belongs to a different project scope than "${syncScope.scopeKey}".`,
      );
    }
    if (syncScope.unresolvedLocalSeqRef) {
      throw new Error(
        syncScope.scopeKey
          ? `Thread not found in project scope "${syncScope.scopeKey}": ${syncScope.unresolvedLocalSeqRef}`
          : `Project scope is required when referencing a thread by project-local sequence "${syncScope.unresolvedLocalSeqRef}".`,
      );
    }
    if ((!callerScope || !callerScope.scopeKey) && (callerWsKey || syncScope?.scopeKey)) {
      const normCallerKey = normalizeScopeKeyForMatch(callerWsKey || syncScope?.scopeKey);
      callerScope = { scopeKey: normCallerKey, projectId: callerProjId || syncScope?.projectId || '' };
    }
    if (!callerScope?.scopeKey) {
      throw new Error('Unable to resolve project scope for decision action (fail-closed).');
    }
  }

  const resolvedCallerScopeKey = callerScope?.scopeKey || callerWsKey || syncScope?.scopeKey || '';
  const parsedAuto = !explicitDec
    ? parseAutoDismissTarget(
        {
          decisionId,
          threadId: requestedThreadId,
          autoKind: requestedAutoKind,
          lastCommit: requestedLastCommit,
          workspaceKey: resolvedCallerScopeKey,
          workspacePath: callerWsPath,
          coordinatorId: callerCoordId,
          conversationId: callerConvId,
          projectId: callerProjId,
        },
        {},
        reg,
      )
    : null;
  if (parsedAuto?.crossProjectThreadId) {
    throw new Error(
      `Cross-project access denied: thread "${parsedAuto.crossProjectDisplayId || parsedAuto.crossProjectThreadId}" belongs to a different project scope than "${resolvedCallerScopeKey || parsedAuto.callerScopeKey}".`,
    );
  }
  if (parsedAuto?.unresolvedLocalRef) {
    throw new Error(
      resolvedCallerScopeKey
        ? `Thread not found in project scope "${resolvedCallerScopeKey}": ${parsedAuto.unresolvedLocalRef}`
        : `Project scope is required when referencing a thread by project-local ID "${parsedAuto.unresolvedLocalRef}".`,
    );
  }

  const targetThreadId =
    explicitDec?.threadId || syncScope?.threadId || parsedAuto?.threadId || requestedThreadId || '';
  const effectiveLabel = requestedLabel || matchedOption?.label || '';
  const targetThreadRec = targetThreadId ? findThreadInRegistry(reg, targetThreadId) : null;

  if (hasCallerScope) {
    if (explicitDec?.workspaceKey && !isSameScopeKey(explicitDec.workspaceKey, callerScope.scopeKey)) {
      throw new Error(
        `Cross-project access denied: decision "${explicitDec.id}" belongs to a different project scope than "${callerScope.scopeKey}".`,
      );
    }
    if (
      targetThreadRec?.workspaceKey &&
      !isSameScopeKey(targetThreadRec.workspaceKey, callerScope.scopeKey)
    ) {
      throw new Error(
        `Cross-project access denied: thread "${getThreadDisplayId(targetThreadRec) || targetThreadRec.threadId}" belongs to a different project scope than "${callerScope.scopeKey}".`,
      );
    }
    if (
      !explicitDec &&
      parsedAuto?.workspaceKey &&
      !isSameScopeKey(parsedAuto.workspaceKey, callerScope.scopeKey)
    ) {
      throw new Error(
        `Cross-project access denied: auto decision "${decisionId || parsedAuto.threadLocalId || parsedAuto.threadId}" belongs to a different project scope than "${callerScope.scopeKey}".`,
      );
    }
    // Fail-closed on explicit conflicting projectId even when workspacePath matches
    if (callerProjId) {
      const decProjId =
        explicitDec?.projectId && explicitDec.projectId !== 'outside-of-project'
          ? String(explicitDec.projectId).trim()
          : '';
      if (decProjId && decProjId !== callerProjId) {
        throw new Error(
          `Cross-project access denied: decision "${explicitDec.id}" belongs to a different project than "${callerProjId}".`,
        );
      }
      const thrProjId =
        targetThreadRec?.projectId && targetThreadRec.projectId !== 'outside-of-project'
          ? String(targetThreadRec.projectId).trim()
          : '';
      if (thrProjId && thrProjId !== callerProjId) {
        throw new Error(
          `Cross-project access denied: thread "${getThreadDisplayId(targetThreadRec) || targetThreadRec.threadId}" belongs to a different project than "${callerProjId}".`,
        );
      }
      const targetScopeKey =
        explicitDec?.workspaceKey || targetThreadRec?.workspaceKey || parsedAuto?.workspaceKey || '';
      const targetScopeCoord = targetScopeKey
        ? lookupCoordinatorForScope(reg, { scopeKey: targetScopeKey })
        : null;
      const coordProjId =
        targetScopeCoord?.projectId && targetScopeCoord.projectId !== 'outside-of-project'
          ? String(targetScopeCoord.projectId).trim()
          : '';
      if (coordProjId && coordProjId !== callerProjId) {
        throw new Error(
          `Cross-project access denied: decision "${explicitDec?.id || decisionId || targetThreadId}" belongs to a different project than "${callerProjId}".`,
        );
      }
    }
  }

  if (effectiveAction === 'dismiss') {
    if (explicitDec && (explicitDec.status === 'resolved' || explicitDec.status === 'dismissed')) {
      return {
        ok: false,
        alreadyResolved: true,
        reason: 'already_resolved',
        error: `Decision "${explicitDec.id}" has already been ${explicitDec.status}.`,
        action: 'dismiss',
        decisionId: explicitDec.id,
        decision: cloneDecisionRecord(explicitDec),
      };
    }
    const dismissTarget = explicitDec
      ? explicitDec.id
      : {
          decisionId,
          threadId: targetThreadId,
          autoKind: requestedAutoKind || parsedAuto?.autoKind || '*',
          lastCommit: requestedLastCommit || parsedAuto?.lastCommit || '',
          workspaceKey: explicitDec?.workspaceKey || resolvedCallerScopeKey || parsedAuto?.workspaceKey || '',
        };
    const res = dismissDecision(dismissTarget, {
      ...(resolvedCallerScopeKey ? { expectedScopeKey: resolvedCallerScopeKey } : {}),
      ...(callerCoordId ? { coordinatorId: callerCoordId } : {}),
      ...(callerConvId ? { conversationId: callerConvId } : {}),
      ...(callerProjId ? { projectId: callerProjId } : {}),
    });
    if (res?.alreadyResolved) {
      return {
        ok: false,
        alreadyResolved: true,
        reason: 'already_resolved',
        error: `Decision "${explicitDec?.id || decisionId}" has already been handled.`,
        action: 'dismiss',
        decisionId: explicitDec?.id || decisionId,
        decision: res.decision || null,
      };
    }
    return {
      ok: true,
      action: 'dismiss',
      decisionId: decisionId || res.key || '',
      dismissed: true,
      result: res,
    };
  }

  if (effectiveAction === 'archive_thread') {
    if (!targetThreadId) {
      throw new Error('`threadId` is required for archive_thread decision action.');
    }
    const claimToken = randomUUID();
    let explicitClaimed = false;
    if (explicitDec) {
      const claimRes = claimExplicitDecision(explicitDec.id, claimToken, {
        coordinatorId: callerCoordId,
        conversationId: callerConvId,
        expectedScopeKey: callerScope?.scopeKey || '',
      });
      if (!claimRes.claimed) {
        return {
          ok: false,
          ...(claimRes.reason === 'already_resolved' ? { alreadyResolved: true } : { inProgress: true }),
          reason: claimRes.reason,
          error:
            claimRes.reason === 'already_resolved'
              ? `Decision "${explicitDec.id}" has already been handled.`
              : `Decision "${explicitDec.id}" is already in progress.`,
          action: 'archive_thread',
          decisionId: explicitDec.id,
          decision: claimRes.decision,
        };
      }
      explicitClaimed = true;
    }

    const archiveScopeOpts = hasCallerScope
      ? {
          workspacePath: callerWsPath,
          workspaceKey: callerWsKey || callerScope?.scopeKey || '',
          coordinatorId: callerCoordId,
          conversationId: callerConvId,
          projectId: rawCallerProjId,
        }
      : explicitDec?.workspaceKey || parsedAuto?.workspaceKey
        ? { workspaceKey: explicitDec?.workspaceKey || parsedAuto?.workspaceKey }
        : {};
    let archiveResult;
    try {
      archiveResult = await archiveThread(targetThreadId, {
        removeWorktree: true,
        forceWorktree: false,
        deleteBranch: true,
        ...archiveScopeOpts,
      });
    } catch (err) {
      if (explicitClaimed) releaseExplicitDecisionClaim(explicitDec.id, claimToken);
      throw err;
    }
    let resolvedDecision = null;
    if (explicitDec) {
      resolvedDecision = resolveDecision({
        decisionId: explicitDec.id,
        optionId: optionId || matchedOption?.id || '',
        optionLabel: effectiveLabel,
        claimToken,
        threadLastCommit: targetThreadRec?.git?.lastCommit || '',
      });
    }
    return {
      ok: true,
      action: 'archive_thread',
      decisionId: explicitDec?.id || decisionId,
      threadId: archiveResult.threadId || targetThreadId,
      archiveResult,
      decision: resolvedDecision,
    };
  }

  // effectiveAction === 'send_coordinator' || effectiveAction === 'custom_reply'
  const threadRec = targetThreadRec;
  const scope = await resolveProjectScope({
    workspacePath: callerWsPath,
    conversationId: callerConvId,
    coordinatorId: callerCoordId || explicitDec?.coordinatorId || threadRec?.coordinatorId || '',
    projectId: callerProjId || explicitDec?.projectId || threadRec?.projectId || '',
    reg,
  });

  const effectiveScopeKey =
    explicitDec?.workspaceKey ||
    threadRec?.workspaceKey ||
    parsedAuto?.workspaceKey ||
    callerScope?.scopeKey ||
    scope.scopeKey ||
    '';
  if (isCustomReply && !effectiveScopeKey) {
    throw new Error('Unable to resolve project scope for custom_reply decision action (fail-closed).');
  }
  const targetCoordId = resolveTargetCoordinatorId({
    coordinatorId:
      callerCoordId ||
      explicitDec?.coordinatorId ||
      threadRec?.coordinatorId ||
      '',
    conversationId: callerConvId,
    scopeKey: effectiveScopeKey,
    workspacePath: callerWsPath || scope.baseDir || '',
    projectId: callerProjId || explicitDec?.projectId || threadRec?.projectId || scope.projectId || '',
    reg,
  });

  if (!targetCoordId) {
    throw new Error('No active Coordinator conversation found for this project.');
  }

  const locale = resolveAppLocale();
  const coordRecord = lookupCoordinatorForScope(reg, {
    scopeKey: effectiveScopeKey,
    workspacePath: callerWsPath || scope.baseDir || '',
    projectId: callerProjId || explicitDec?.projectId || scope.projectId || '',
    conversationId: targetCoordId,
  });
  const targetProjectId =
    coordRecord?.projectId ||
    explicitDec?.projectId ||
    threadRec?.projectId ||
    scope.projectId ||
    '';

  const resolvedAutoKind =
    requestedAutoKind ||
    (parsedAuto?.autoKind && parsedAuto.autoKind !== '*' ? parsedAuto.autoKind : '') ||
    (threadRec?.git?.merged === true ? 'worktree_archive_ready' : 'worktree_merge_ready');
  const effectiveAutoCommit = String(
    requestedLastCommit || parsedAuto?.lastCommit || threadRec?.git?.lastCommit || '',
  ).trim();
  const autoFallback =
    !explicitDec && threadRec && VALID_AUTO_KINDS.has(resolvedAutoKind)
      ? resolvedAutoKind === 'watchdog_stalled'
        ? buildAutoWatchdogDecisionItem(
            threadRec,
            getThreadWatchdogSummary(reg, effectiveScopeKey || threadRec.workspaceKey || '', threadRec.threadId) || {
              stallFingerprint: effectiveAutoCommit,
              stallReason: 'no_progress_running',
              stalledDurationMs: 0,
            },
            {
              scopeKey: effectiveScopeKey,
              projectId: targetProjectId,
              locale,
            },
          )
        : buildAutoWorktreeDecisionItem(threadRec, {
            autoKind: resolvedAutoKind,
            scopeKey: effectiveScopeKey,
            projectId: targetProjectId,
            locale,
          })
      : null;

  const decisionTitle = sanitizeSingleLineProtocolField(
    explicitDec?.title || autoFallback?.title || String(params.title || '').trim() || '',
    180,
  );
  const decisionSummary = sanitizeSingleLineProtocolField(
    explicitDec?.summary || autoFallback?.summary || requestedSummary || '',
    400,
  );
  const safeEffectiveLabel = sanitizeSingleLineProtocolField(effectiveLabel, 80);
  const actionInstruction = isCustomReply
    ? customInstructionText
    : requestedMessage ||
      matchedOption?.message ||
      (locale === 'en'
        ? `User selected "${safeEffectiveLabel || 'Confirm'}"${decisionTitle ? ` for "${decisionTitle}"` : ''}.`
        : `用户选择了「${safeEffectiveLabel || '确认'}」${decisionTitle ? `（${decisionTitle}）` : ''}，请按此执行。`);

  const headerLine = isCustomReply
    ? locale === 'en'
      ? `[BOARD_DECISION_CUSTOM_REPLY] User submitted a custom instruction for a pending decision on the Project Threads board:`
      : locale === 'zh-TW'
        ? `[BOARD_DECISION_CUSTOM_REPLY] 使用者在右側專案執行緒看板「待決策」區針對該決策提交了自訂指令：`
        : `[BOARD_DECISION_CUSTOM_REPLY] 用户在右侧项目线程看板「待决策」区针对该决策提交了自定义指令：`
    : locale === 'en'
      ? `[BOARD_DECISION] User acted on a pending decision from the Project Threads board:`
      : `[BOARD_DECISION] 用户在右侧项目线程看板「待决策」区触发了快捷决策：`;
  const lines = [headerLine];
  if (explicitDec?.id) {
    lines.push(`- Decision ID: \`${explicitDec.id}\``);
  } else if (isCustomReply && (decisionId || autoFallback?.id)) {
    lines.push(`- Decision ID: \`${sanitizeSingleLineProtocolField(decisionId || autoFallback.id, 120)}\``);
  }
  const displayTargetTid = targetThreadRec ? getThreadDisplayId(targetThreadRec) : targetThreadId;
  if (targetThreadId) {
    const safeThreadTitle = sanitizeSingleLineProtocolField(threadRec?.title || '', 120);
    const safeThreadBranch = sanitizeSingleLineProtocolField(threadRec?.branch || '', 120);
    lines.push(
      `- Thread: \`${displayTargetTid}\`${safeThreadTitle ? ` (${safeThreadTitle})` : ''}${safeThreadBranch ? ` | Branch: \`${safeThreadBranch}\`` : ''}`,
    );
  }
  if (decisionTitle) lines.push(`- Topic: ${decisionTitle}`);
  if (decisionSummary && isCustomReply) lines.push(`- Summary: ${decisionSummary}`);
  if (!isCustomReply && safeEffectiveLabel) lines.push(`- Selected Option: **${safeEffectiveLabel}**`);
  if (isCustomReply) {
    lines.push('- Custom Instruction:');
    lines.push(formatQuotedCustomInstruction(actionInstruction));
  } else {
    lines.push(`- Instruction: ${actionInstruction}`);
  }
  const fullMessage = lines.join('\n');
  const customLabel =
    locale === 'en' ? 'Custom Instruction' : locale === 'zh-TW' ? '自訂指令' : '自定义指令';
  const sendTitle = isCustomReply
    ? displayTargetTid
      ? `[Decision ${displayTargetTid}] ${customLabel}`
      : `[Decision] ${customLabel}`
    : displayTargetTid
      ? `[Decision ${displayTargetTid}] ${safeEffectiveLabel || decisionTitle || 'Action'}`
      : `[Decision] ${safeEffectiveLabel || decisionTitle || 'Action'}`;

  // Atomic idempotent claim BEFORE sending to Coordinator (prevents double-click / concurrent duplicate delivery)
  const claimToken = randomUUID();
  let explicitClaimed = false;
  let autoClaimKey = '';
  if (explicitDec) {
    const claimRes = claimExplicitDecision(explicitDec.id, claimToken, {
      coordinatorId: callerCoordId,
      conversationId: callerConvId,
      expectedScopeKey: callerScope?.scopeKey || '',
    });
    if (!claimRes.claimed) {
      return {
        ok: false,
        ...(claimRes.reason === 'already_resolved' ? { alreadyResolved: true } : { inProgress: true }),
        reason: claimRes.reason,
        error:
          claimRes.reason === 'already_resolved'
            ? `Decision "${explicitDec.id}" has already been handled.`
            : `Decision "${explicitDec.id}" is already in progress.`,
        action: isCustomReply ? 'custom_reply' : 'send_coordinator',
        decisionId: explicitDec.id,
        decision: claimRes.decision,
      };
    }
    explicitClaimed = true;
  } else if (targetThreadId) {
    const commitKey = effectiveAutoCommit || '__no_commit__';
    autoClaimKey = `${targetThreadId}:${resolvedAutoKind}:${commitKey}`;
    const autoClaimRes = claimAutoDecision(autoClaimKey, claimToken, {
      threadId: targetThreadId,
      autoKind: resolvedAutoKind,
      lastCommit: commitKey,
      coordinatorId: callerCoordId,
      conversationId: callerConvId,
    });
    if (!autoClaimRes.claimed) {
      return {
        ok: false,
        ...(autoClaimRes.reason === 'already_resolved'
          ? { alreadyResolved: true }
          : { inProgress: true }),
        reason: autoClaimRes.reason,
        error:
          autoClaimRes.reason === 'already_resolved'
            ? `Auto decision hint for "${displayTargetTid || targetThreadId}" has already been handled.`
            : `Auto decision hint for "${displayTargetTid || targetThreadId}" is already in progress.`,
        action: isCustomReply ? 'custom_reply' : 'send_coordinator',
        decisionId: decisionId || autoFallback?.id || '',
        threadId: targetThreadId,
      };
    }
  }

  try {
    await invokeAgentApiSend({
      conversationId: targetCoordId,
      message: fullMessage,
      title: sendTitle,
      projectId: targetProjectId,
      timeoutMs: 12000,
    });
  } catch (err) {
    if (targetProjectId && !err.isTimeout && err.code !== 'ENOENT') {
      try {
        await invokeAgentApiSend({
          conversationId: targetCoordId,
          message: fullMessage,
          title: sendTitle,
          projectId: '',
          timeoutMs: 10000,
        });
      } catch (retryErr) {
        if (explicitClaimed) releaseExplicitDecisionClaim(explicitDec.id, claimToken);
        if (autoClaimKey) releaseAutoDecisionClaim(autoClaimKey, claimToken);
        throw retryErr;
      }
    } else {
      if (explicitClaimed) releaseExplicitDecisionClaim(explicitDec.id, claimToken);
      if (autoClaimKey) releaseAutoDecisionClaim(autoClaimKey, claimToken);
      throw err;
    }
  }

  let resolvedDecision = null;
  let autoResult = null;
  if (explicitDec) {
    resolvedDecision = resolveDecision({
      decisionId: explicitDec.id,
      optionId: isCustomReply ? 'custom_reply' : optionId || matchedOption?.id || '',
      optionLabel: isCustomReply ? customLabel : safeEffectiveLabel,
      claimToken,
      threadLastCommit: threadRec?.git?.lastCommit || '',
      ...(isCustomReply ? { customMessage: customInstructionText } : {}),
    });
  } else if (targetThreadId) {
    autoResult = dismissDecision({
      threadId: targetThreadId,
      autoKind: resolvedAutoKind,
      lastCommit: effectiveAutoCommit,
      workspaceKey: effectiveScopeKey,
      resolution: isCustomReply ? 'custom_reply' : 'send_coordinator',
      ...(isCustomReply ? { customMessage: customInstructionText } : {}),
    });
    if (autoClaimKey) releaseAutoDecisionClaim(autoClaimKey, claimToken);
  }

  return {
    ok: true,
    action: isCustomReply ? 'custom_reply' : 'send_coordinator',
    decisionId: explicitDec?.id || decisionId,
    coordinatorId: targetCoordId,
    threadId: targetThreadId,
    ...(isCustomReply ? { customMessage: customInstructionText } : {}),
    decision: resolvedDecision,
    ...(autoResult ? { autoResult } : {}),
  };
}

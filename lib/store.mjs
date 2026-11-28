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
  resolveLsEndpoint,
  resolveModelLabelFromLookup,
  resolveProjectName,
  sendUserCascadeMessage,
  updateConversation,
} from './ls-client.mjs';
import { formatModelDisplay, isSameModelFamily, isTierAlias } from './model-format.mjs';
import {
  extractLatestAssistantText,
  extractThreadCompletion,
  extractTranscriptModel,
  extractTranscriptUsage,
  getTranscriptPath,
  parseThreadTranscript,
  peekLiveActivity,
} from './transcript.mjs';

const PROCESS_BOOT_ISO = new Date().toISOString();
const seenRunningThreadIds = new Set();
const autoCleanupInFlight = new Set();

const WORKTREE_ADD_TIMEOUT_MS = 120_000;
const MERGE_CONVENTIONS_MARKER = '<!-- project-threads:merge-conventions -->';
const MERGE_CONVENTIONS_HEADING_RE =
  /^#{1,6}\s+.*(?:worktree\s+merge|merge\s*(?:&|and|\/)?\s*(?:archive|cleanup)?\s*(?:conventions?|rules?|policy|workflow|guidelines?)|(?:merge|cherry[- ]?pick)\s+(?:conventions?|rules?|policy|workflow)|合并规范|合入规范|合并与归档|合入与归档|分支合并|工作树合并)/im;

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
    sleepSync(15 + Math.floor(Math.random() * 20));
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
    coordinators: {},
    threads: {},
    decisions: {},
    dismissedAutoDecisions: {},
  };
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
    const inferredDecSeq = inferMaxDecisionSeq(decisions);
    const reg = {
      version: 1,
      seq: Number(parsed.seq) || 0,
      decisionSeq: Math.max(Number(parsed.decisionSeq) || 0, inferredDecSeq),
      coordinators,
      threads: parsed.threads || {},
      decisions,
      dismissedAutoDecisions,
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

export function saveRegistry(reg) {
  withRegistryLock(() => {
    const file = REGISTRY_FILE();
    if (reg && typeof reg === 'object') {
      if (!reg.coordinators || typeof reg.coordinators !== 'object') reg.coordinators = {};
      if (!reg.threads || typeof reg.threads !== 'object') reg.threads = {};
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
              if (diskC.conversationId !== memC.conversationId) continue;
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

              for (const isoKey of ['pushedToCoordinatorAt', 'notifiedCoordinatorAt', 'viewedAt']) {
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

function upsertProjectSettingsEntry(projectsMap, key, wt, ro) {
  if (wt || ro) {
    projectsMap[key] = { worktreeModel: wt, readOnlyModel: ro };
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
    },
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
  };
  const rawProjects = parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {};
  for (const [k, entry] of Object.entries(rawProjects)) {
    const key = String(k || '').trim();
    if (!key || !entry || typeof entry !== 'object') continue;
    const wt = normalizeStoredModelValue(entry.worktreeModel, '');
    const ro = normalizeStoredModelValue(entry.readOnlyModel, '');
    if (wt || ro) {
      base.projects[key] = {
        worktreeModel: wt,
        readOnlyModel: ro,
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
    if (input.scope === 'global') {
      if (isReset) {
        next.defaults = { worktreeModel: 'inherit', readOnlyModel: 'inherit' };
      } else {
        if ('worktreeModel' in input) {
          next.defaults.worktreeModel = normalizeStoredModelValue(input.worktreeModel, 'inherit');
        }
        if ('readOnlyModel' in input) {
          next.defaults.readOnlyModel = normalizeStoredModelValue(input.readOnlyModel, 'inherit');
        }
      }
    } else {
      const wk = String(input.workspaceKey || '').trim();
      if (!wk) {
        throw new Error('`workspaceKey` is required to save project-scoped settings.');
      }
      if (isReset) {
        deleteProjectSettingsEntry(next.projects, wk);
      } else {
        const existingProj =
          lookupProjectSettingsEntry(next.projects, wk) || { worktreeModel: '', readOnlyModel: '' };
        const wt =
          'worktreeModel' in input
            ? normalizeStoredModelValue(input.worktreeModel, '')
            : existingProj.worktreeModel || '';
        const ro =
          'readOnlyModel' in input
            ? normalizeStoredModelValue(input.readOnlyModel, '')
            : existingProj.readOnlyModel || '';
        upsertProjectSettingsEntry(next.projects, wk, wt, ro);
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
      next.defaults = { worktreeModel: 'inherit', readOnlyModel: 'inherit' };
      next.projects = {};
    }
    if (input.defaults && typeof input.defaults === 'object') {
      if ('worktreeModel' in input.defaults) {
        next.defaults.worktreeModel = normalizeStoredModelValue(input.defaults.worktreeModel, 'inherit');
      }
      if ('readOnlyModel' in input.defaults) {
        next.defaults.readOnlyModel = normalizeStoredModelValue(input.defaults.readOnlyModel, 'inherit');
      }
    }
    if ('worktreeModel' in input && !input.scope) {
      next.defaults.worktreeModel = normalizeStoredModelValue(input.worktreeModel, 'inherit');
    }
    if ('readOnlyModel' in input && !input.scope) {
      next.defaults.readOnlyModel = normalizeStoredModelValue(input.readOnlyModel, 'inherit');
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
          lookupProjectSettingsEntry(next.projects, key) || { worktreeModel: '', readOnlyModel: '' };
        const wt =
          'worktreeModel' in projPatch
            ? normalizeStoredModelValue(projPatch.worktreeModel, '')
            : existingProj.worktreeModel || '';
        const ro =
          'readOnlyModel' in projPatch
            ? normalizeStoredModelValue(projPatch.readOnlyModel, '')
            : existingProj.readOnlyModel || '';
        upsertProjectSettingsEntry(next.projects, key, wt, ro);
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
  const clean = resolve(String(p).trim());
  return process.platform === 'win32' ? clean.toLowerCase() : clean;
}

export function uriToPath(uriOrPath) {
  if (!uriOrPath) return '';
  const s = String(uriOrPath).trim();
  if (!s.startsWith('file:')) return s;
  let p = decodeURIComponent(s.replace(/^file:\/\//, ''));
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  return normalize(p);
}

const INJECTED_RULE_UNTRACKED_RE =
  /^\?\?\s+\.agents\/rules\/(?:worker-thread-context\.md|project-memory\.md)$/;
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
const threadModelCache = new Map(); // convId -> { checkedAt, updatedAt, runState, modelDisplayName, resolvedModel, modelEnum, genMetaCount, fromLs }

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
    return (
      models.find(
        (m) =>
          isSameModelFamily(raw, m.modelId || m.id || m.label) ||
          (m.label && isSameModelFamily(raw, m.label)),
      ) || null
    );
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

  if (explicitCoordId && !isWorkerConv(explicitCoordId)) {
    return explicitCoordId;
  }
  if (coordRecord?.conversationId) {
    return String(coordRecord.conversationId).trim();
  }
  if (explicitConvId) {
    const workerMatch = threads.find((t) => t?.conversationId === explicitConvId);
    if (workerMatch) {
      return String(
        workerMatch.coordinatorId ||
          activeReg.coordinators?.[workerMatch.workspaceKey]?.conversationId ||
          '',
      ).trim();
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
      const hit =
        matchSelectableModelInList(cand, models) ||
        (isHumanDisplayLabel(cand)
          ? models.find((m) => isSameModelFamily(cand, m.modelId || m.label)) || null
          : null);
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

function inferScopeKeyFromRegistry(
  { workspacePath = '', conversationId = '', coordinatorId = '', projectId = '' } = {},
  reg = null,
) {
  const activeReg = reg || loadRegistry();
  const coords = activeReg?.coordinators && typeof activeReg.coordinators === 'object' ? activeReg.coordinators : {};
  const threads = activeReg?.threads && typeof activeReg.threads === 'object' ? activeReg.threads : {};
  const cleanWs = uriToPath(workspacePath);
  if (cleanWs) {
    const normWs = normalizeKey(cleanWs);
    if (coords[normWs]) return normWs;
    for (const ck of Object.keys(coords)) {
      if (isFilesystemPathKey(ck) && normalizeKey(ck) === normWs) return ck;
    }
    if (existsSync(cleanWs)) return normWs;
  }
  const convId = String(conversationId || coordinatorId || '').trim();
  if (convId) {
    const thrHit = Object.values(threads).find((t) => t?.conversationId === convId && t?.workspaceKey);
    if (thrHit?.workspaceKey) return String(thrHit.workspaceKey);
    const coordHit = Object.values(coords).find((c) => c?.conversationId === convId && c?.key);
    if (coordHit?.key) return String(coordHit.key);
  }
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
  const projEntry = cleanScopeKey
    ? lookupProjectSettingsEntry(settings.projects, cleanScopeKey, workspacePath)
    : null;
  const projWorktreeRaw = normalizeStoredModelValue(projEntry?.worktreeModel, '');
  const projReadOnlyRaw = normalizeStoredModelValue(projEntry?.readOnlyModel, '');

  const globalWt = resolveModelEntryFromCatalog(globalWorktreeRaw, catalogModels, settings.labels, coordCtx);
  const globalRo = resolveModelEntryFromCatalog(globalReadOnlyRaw, catalogModels, settings.labels, coordCtx);
  const projWt = resolveModelEntryFromCatalog(projWorktreeRaw, catalogModels, settings.labels, coordCtx);
  const projRo = resolveModelEntryFromCatalog(projReadOnlyRaw, catalogModels, settings.labels, coordCtx);
  const effWt = projWorktreeRaw ? projWt : globalWt;
  const effRo = projReadOnlyRaw ? projRo : globalRo;

  return {
    scopeKey: cleanScopeKey,
    scopeKind,
    projectName: scopeProjectName,
    scopeLabel,
    hasProjectOverride: Boolean(projWorktreeRaw || projReadOnlyRaw),
    coordinatorId: coord?.conversationId || '',
    coordinatorModel: coordCtx ? coordCtx.model : '',
    coordinatorModelDisplayName: coordCtx ? coordCtx.displayName : '',
    worktreeModel: effWt.createModelArg || 'inherit',
    readOnlyModel: effRo.createModelArg || 'inherit',
    worktreeModelLabel: effWt.label || formatModelDisplay(effWt.createModelArg || 'inherit'),
    readOnlyModelLabel: effRo.label || formatModelDisplay(effRo.createModelArg || 'inherit'),
    worktreeSource: projWorktreeRaw ? 'project' : 'global',
    readOnlySource: projReadOnlyRaw ? 'project' : 'global',
    global: {
      worktreeModel: globalWt.createModelArg || 'inherit',
      readOnlyModel: globalRo.createModelArg || 'inherit',
      worktreeModelLabel: globalWt.label || formatModelDisplay(globalWt.createModelArg || 'inherit'),
      readOnlyModelLabel: globalRo.label || formatModelDisplay(globalRo.createModelArg || 'inherit'),
    },
    project: {
      worktreeModel: projWt.createModelArg || '',
      readOnlyModel: projRo.createModelArg || '',
      worktreeModelLabel: projWt.label || '',
      readOnlyModelLabel: projRo.label || '',
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
  const projEntry = scopeKey
    ? lookupProjectSettingsEntry(settings.projects, scopeKey, workspacePath)
    : null;
  const projWorktreeRaw = normalizeStoredModelValue(projEntry?.worktreeModel, '');
  const projReadOnlyRaw = normalizeStoredModelValue(projEntry?.readOnlyModel, '');

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
  const effWt = projWorktreeRaw ? projWt : globalWt;
  const effRo = projReadOnlyRaw ? projRo : globalRo;

  return {
    scopeKey,
    scopeKind,
    projectName: scopeProjectName,
    scopeLabel,
    hasProjectOverride: Boolean(projWorktreeRaw || projReadOnlyRaw),
    coordinatorId: coordResolved.coordinatorId || '',
    coordinatorModel,
    coordinatorModelDisplayName,
    worktreeModel: effWt.createModelArg || 'inherit',
    readOnlyModel: effRo.createModelArg || 'inherit',
    worktreeModelLabel: effWt.label || formatModelDisplay(effWt.createModelArg || 'inherit'),
    readOnlyModelLabel: effRo.label || formatModelDisplay(effRo.createModelArg || 'inherit'),
    worktreeSource: projWorktreeRaw ? 'project' : 'global',
    readOnlySource: projReadOnlyRaw ? 'project' : 'global',
    global: {
      worktreeModel: globalWt.createModelArg || 'inherit',
      readOnlyModel: globalRo.createModelArg || 'inherit',
      worktreeModelLabel: globalWt.label || formatModelDisplay(globalWt.createModelArg || 'inherit'),
      readOnlyModelLabel: globalRo.label || formatModelDisplay(globalRo.createModelArg || 'inherit'),
    },
    project: {
      worktreeModel: projWt.createModelArg || '',
      readOnlyModel: projRo.createModelArg || '',
      worktreeModelLabel: projWt.label || '',
      readOnlyModelLabel: projRo.label || '',
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
    ['worktreeModel', 'readOnlyModel'].some(
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

  const labels = {};
  const patch = {
    scope,
    reset,
    ...(scope === 'project' ? { workspaceKey: scopeKey } : {}),
  };

  if (!reset) {
    for (const field of ['worktreeModel', 'readOnlyModel']) {
      if (!(field in data)) continue;
      const { value, label } = canonicalizeModelForSettings(data[field], models);
      patch[field] = value;
      if (value && value !== 'inherit' && label) labels[value] = label;
    }
    if (Object.keys(labels).length > 0) {
      patch.labels = labels;
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

export async function resolveDefaultDispatchModel({
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
  const configured = (createWorktree ? effective.worktreeModel : effective.readOnlyModel) || 'inherit';
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
  { forceLsCheck = false, convUpdatedAt = '', convRunState = '' } = {},
) {
  const convId = String(t?.conversationId || '').trim();
  if (!convId) return false;

  const nowMs = Date.now();
  const cached = threadModelCache.get(convId);
  const effectiveRunState = convRunState || t.runState || '';
  const effectiveUpdatedAt = convUpdatedAt || t.updatedAt || '';
  const isRunning = effectiveRunState === 'RUN_STATE_RUNNING';

  let shouldQueryLs = false;
  if (forceLsCheck) {
    if (!cached) {
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
  } else if (t.archived) {
    shouldQueryLs = !t.modelDisplayName && !cached;
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

  if (shouldQueryLs) {
    const genRes = await getThreadGeneratorModel(convId, 3500);
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
        const lookup = await getModelConfigLookup({ timeoutMs: 2500 });
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

  threadModelCache.set(convId, {
    checkedAt: shouldQueryLs ? nowMs : cached?.checkedAt || nowMs,
    updatedAt: effectiveUpdatedAt,
    runState: effectiveRunState,
    modelDisplayName: nextDisplayName,
    resolvedModel: nextResolvedModel,
    modelEnum: nextModelEnum,
    usage: nextUsage,
    genMetaCount,
    fromLs,
  });
  if (threadModelCache.size > 200) {
    threadModelCache.delete(threadModelCache.keys().next().value);
  }

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

export async function resolveRepoInfo(workspacePath) {
  const candidate = uriToPath(workspacePath);
  if (!candidate) {
    return { workspacePath: '', repoRoot: '', mainRepoRoot: '', currentBranch: '' };
  }
  if (!existsSync(candidate)) {
    return { workspacePath: candidate, repoRoot: '', mainRepoRoot: '', currentBranch: '' };
  }
  try {
    const top = await runGit(['rev-parse', '--show-toplevel'], candidate);
    const repoRoot = normalize(top);
    let mainRepoRoot = repoRoot;
    try {
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
    let currentBranch = 'HEAD';
    try {
      currentBranch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], mainRepoRoot || repoRoot);
    } catch {
      // Empty repo without commits yet
    }
    return { workspacePath: candidate, repoRoot, mainRepoRoot, currentBranch };
  } catch {
    return { workspacePath: candidate, repoRoot: '', mainRepoRoot: '', currentBranch: '' };
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
  const convId = String(conversationId || coordinatorId || '').trim();
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
    const info = await resolveRepoInfo(workspacePath);
    const baseDir = info.mainRepoRoot || info.repoRoot || info.workspacePath;
    if (baseDir) {
      const scopeKey = normalizeKey(baseDir);
      const existingCoord = activeReg.coordinators[scopeKey];
      if (!effectiveProjId && existingCoord?.projectId && existingCoord.projectId !== 'outside-of-project') {
        effectiveProjId = existingCoord.projectId;
      }
      if (!effectiveEnvId && existingCoord?.environmentId) {
        effectiveEnvId = existingCoord.environmentId;
      }
      const resolvedProjName = effectiveProjId ? await resolveProjectName(effectiveProjId) : '';
      const display = resolveScopeDisplayNames({
        projectName: resolvedProjName,
        baseDir,
      });
      return {
        scopeKey,
        scopeKind: 'workspace',
        baseDir,
        projectId: effectiveProjId,
        projectName: display.projectName,
        workspaceName: display.workspaceName,
        scopeTitle: display.scopeTitle,
        environmentId: effectiveEnvId,
        label: display.scopeTitle,
        info,
      };
    }
  }

  // b) convId matches an existing Worker Thread
  if (convId) {
    const matchedThread = Object.values(activeReg.threads).find((t) => t.conversationId === convId);
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

    // c) convId matches an existing Coordinator
    const matchedCoord = Object.values(activeReg.coordinators).find((c) => c.conversationId === convId);
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

export function getMemoryFilePath(baseDir, scopeKey = '') {
  if (baseDir) {
    return join(baseDir, '.agents', 'rules', 'project-memory.md');
  }
  if (scopeKey) {
    const safeName = `${String(scopeKey).replace(/[^a-z0-9_-]+/gi, '_')}.md`;
    return join(getStateDir(), 'memories', safeName);
  }
  return '';
}

function buildDefaultMergeConventionsSection() {
  return [
    '## Worktree Merge & Archive Conventions',
    MERGE_CONVENTIONS_MARKER,
    '- **Worktree Isolation**: Perform all edits, checks, and commits strictly inside the assigned worktree directory and branch (`thread/<id>-<slug>`). Never edit files directly in the main repository checkout.',
    '- **Pre-Merge Verification**: Before integrating changes into the base branch, verify `git status` is clean inside the worktree and commit only scoped changes (do not `git push` unless explicitly instructed).',
    '- **Merge / Cherry-Pick Workflow**: Integrate committed worktree changes into the target branch from the main checkout according to project preference — either `git cherry-pick <commit>` (recommended for linear history) or `git merge --no-ff <thread-branch>` (or fast-forward merge).',
    '- **Archive & Auto-Cleanup**: After changes are merged or cherry-picked into the target branch, archive the thread via `archive_thread` (or the Project Threads Archive action). Cleanup automatically recognizes both ancestor merges and `cherry-pick` equivalent commits (`git cherry`) and safely removes the clean worktree and source branch (dirty or unmerged worktrees are preserved unless forced).',
  ].join('\n');
}

function hasMergeConventionsSection(markdownText) {
  const text = String(markdownText || '');
  if (!text) return false;
  return (
    text.includes(MERGE_CONVENTIONS_MARKER) ||
    MERGE_CONVENTIONS_HEADING_RE.test(text)
  );
}

function buildInitialProjectMemory(projectName = 'Project', { injectMergeConventions = true } = {}) {
  const parts = [
    `# ${projectName} Shared Memory`,
    '',
    '> Auto-shared across the Project Coordinator and all Worker Threads.',
    '',
    '## Architecture & Conventions',
    "- Keep changes scoped to each thread's assigned module and branch.",
    '',
    '## Active Decisions & Constraints',
    '- (Record cross-cutting decisions here via `update_project_memory`.)',
  ];
  if (injectMergeConventions) {
    parts.push('', buildDefaultMergeConventionsSection());
  }
  return `${parts.join('\n')}\n`;
}

export function ensureProjectMemoryFile(
  baseDir,
  projectName = 'Project',
  scopeKey = '',
  { injectMergeConventions = true } = {},
) {
  const memPath = getMemoryFilePath(baseDir, scopeKey);
  if (!memPath) return '';
  const parent = dirname(memPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (!existsSync(memPath)) {
    writeFileSync(
      memPath,
      buildInitialProjectMemory(projectName, { injectMergeConventions }),
      'utf8',
    );
    return memPath;
  }
  if (injectMergeConventions) {
    const existing = readFileSync(memPath, 'utf8');
    if (!existing.trim()) {
      writeFileSync(
        memPath,
        buildInitialProjectMemory(projectName, { injectMergeConventions: true }),
        'utf8',
      );
    } else if (!hasMergeConventionsSection(existing)) {
      const eol = existing.includes('\r\n') ? '\r\n' : '\n';
      const mergeBlock = buildDefaultMergeConventionsSection().replace(/\n/g, eol);
      writeFileSync(memPath, `${existing.trimEnd()}${eol}${eol}${mergeBlock}${eol}`, 'utf8');
    }
  }
  return memPath;
}

export function readProjectMemory(baseDir, scopeKey = '') {
  const memPath = getMemoryFilePath(baseDir, scopeKey);
  if (!memPath || !existsSync(memPath)) return { path: memPath || '', content: '' };
  return { path: memPath, content: readFileSync(memPath, 'utf8') };
}

async function appendWorktreeExclude(worktreePath, patterns) {
  try {
    const excludeRel = await runGit(['rev-parse', '--git-path', 'info/exclude'], worktreePath);
    const excludePath = resolve(worktreePath, excludeRel);
    mkdirSync(dirname(excludePath), { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    const linesToAdd = patterns.filter((p) => !existing.split(/\r?\n/).includes(p));
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

  const srcMem = getMemoryFilePath(repoRoot, scopeKey || thread?.workspaceKey || '');
  if (srcMem && existsSync(srcMem)) {
    copyFileSync(srcMem, join(rulesDir, 'project-memory.md'));
  }

  if (thread) {
    const lang = detectPromptLanguage(thread.title, '');
    const brief =
      lang === 'zh'
        ? [
            `# 当前子线程上下文 (${thread.threadId})`,
            '',
            `- **线程 ID**: \`${thread.threadId}\``,
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
            `# Active Worker Thread Context (${thread.threadId})`,
            '',
            `- **Thread ID**: \`${thread.threadId}\``,
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

async function createGitWorktree({ repoRoot, threadId, title, requestedBranch, baseRef }) {
  const slug = `${threadId}-${slugify(title)}`;
  const branch = requestedBranch || `thread/${slug}`;
  const startRef = baseRef || 'HEAD';
  const worktreesRoot = join(dirname(repoRoot), '.worktrees', basename(repoRoot));
  mkdirSync(worktreesRoot, { recursive: true });
  const worktreePath = join(worktreesRoot, slug);

  if (!existsSync(worktreePath)) {
    let branchExists = false;
    try {
      await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot);
      branchExists = true;
    } catch {
      branchExists = false;
    }

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

  await appendWorktreeExclude(worktreePath, [
    '.agents/rules/worker-thread-context.md',
    '.agents/rules/project-memory.md',
  ]);

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

  for (const ref of candidates) {
    const res = await runGitResult(
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      gitCwd,
      5000,
    );
    if (res.ok) return ref;
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

  try {
    const porcelainRes = await runGitResult(['status', '--porcelain', '-uall'], worktreePath, 5000);
    const porcelain = porcelainRes.ok ? porcelainRes.stdout : '';
    const dirtyLines = porcelain
      ? porcelain
          .split(/\r?\n/)
          .filter((l) => l.trim() && !INJECTED_RULE_UNTRACKED_RE.test(l))
      : [];
    let lastCommit = '';
    try {
      lastCommit = await runGit(['log', '-1', '--pretty=format:%h %s'], worktreePath, 5000);
    } catch {
      lastCommit = '';
    }
    let branch = '';
    try {
      branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath, 5000);
    } catch {
      branch = '';
    }
    let wtHeadSha = '';
    const headShaRes = await runGitResult(['rev-parse', 'HEAD'], worktreePath, 5000);
    if (headShaRes.ok) {
      wtHeadSha = headShaRes.stdout.trim();
    }

    let repoCwd = passedRepoRoot && existsSync(passedRepoRoot) ? passedRepoRoot : '';
    if (!repoCwd) {
      const commonRes = await runGitResult(['rev-parse', '--git-common-dir'], worktreePath, 5000);
      if (commonRes.ok && commonRes.stdout.trim()) {
        const commonPath = resolve(worktreePath, commonRes.stdout.trim());
        if (basename(commonPath).toLowerCase() === '.git') {
          repoCwd = normalize(dirname(commonPath));
        }
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

  const memPathBefore = getMemoryFilePath(scope.baseDir, key);
  const prevMemContent =
    memPathBefore && existsSync(memPathBefore) ? readFileSync(memPathBefore, 'utf8') : '';
  const memoryPath = ensureProjectMemoryFile(scope.baseDir, projectLabel, key, {
    injectMergeConventions: injectMergeConventions !== false,
  });
  const nextMemContent =
    memoryPath && existsSync(memoryPath) ? readFileSync(memoryPath, 'utf8') : '';
  if (memoryPath && nextMemContent !== prevMemContent) {
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

  if (resolvedConvId) {
    try {
      await updateConversation(resolvedConvId, {
        title: coordTitle,
        pinned: true,
        tags: ['project-coordinator', `group:${groupId}`],
        conversationGroupId: groupId,
      });
    } catch {
      // Non-fatal if conversation metadata update is unavailable
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
  const coordRecord = mutateRegistry((freshReg) => {
    const freshExisting = freshReg.coordinators[key] || existing;
    const isSameConv = Boolean(
      freshExisting && (!resolvedConvId || resolvedConvId === freshExisting.conversationId),
    );
    const nextCoord = {
      ...(isSameConv && freshExisting?.directiveVersion
        ? { directiveVersion: freshExisting.directiveVersion }
        : {}),
      ...(isSameConv && freshExisting?.lastStepCount
        ? { lastStepCount: freshExisting.lastStepCount }
        : {}),
      key,
      conversationId: resolvedConvId || freshExisting?.conversationId || '',
      projectId: resolvedProjId,
      projectName: resolvedProjName,
      environmentId: resolvedEnvId,
      workspacePath: scope.info.workspacePath || scope.baseDir || freshExisting?.workspacePath || '',
      repoRoot: repoRoot || freshExisting?.repoRoot || '',
      defaultBranch: scope.info.currentBranch || freshExisting?.defaultBranch || 'HEAD',
      groupId: freshExisting?.groupId || groupId,
      title: coordTitle,
      memoryPath,
      createdAt: freshExisting?.createdAt || now,
      updatedAt: now,
    };
    freshReg.coordinators[key] = nextCoord;
    return nextCoord;
  });
  return coordRecord;
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
  title,
  taskPrompt,
  worktreePath,
  repoRoot,
  branch,
  baseRef,
  memoryText,
}) {
  const lang = detectPromptLanguage(title, taskPrompt);
  if (lang === 'zh') {
    const sections = [
      `# 子线程任务分配: [${threadId}] ${title}`,
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

    sections.push(
      '## 任务指令',
      String(taskPrompt || '').trim(),
      '',
      '## 完成与汇报规范',
      '当你完成本次任务（或遇到需要总控决策的阻塞问题）时：',
      '1. 请全程使用与上方任务指令相同的语言撰写分析过程、说明与最终总结。',
      '2. 若分配了隔离 Worktree，请确保改动整洁、结构清晰（如任务要求提交，请在分配分支上干净提交）。',
      '3. 在最终回复末尾使用 `### 线程总结`（或 `### Thread Summary`）输出简洁的结构化总结，列出：关键改动/排查结论、修改的文件或提交哈希，以及可沉淀到项目共享记忆的通用架构约定。',
    );

    return sections.filter((s) => s !== undefined).join('\n');
  }

  const sections = [
    `# Worker Thread Assignment: [${threadId}] ${title}`,
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

  sections.push(
    '## Task Instructions',
    String(taskPrompt || '').trim(),
    '',
    '## Completion & Handback Protocol',
    'When you complete this task (or if you hit a blocker needing Coordinator decision):',
    '1. Write your analysis, explanations, and final summary in the same language as the Task Instructions above.',
    '2. Ensure your changes in the worktree are clean and well-structured (commit to your assigned branch if requested in the task).',
    '3. End your final message with a concise structured summary (`### Thread Summary`) listing: key changes/findings, modified files or commit hash, and any new project-wide learnings for Shared Memory.',
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
  createWorktree = true,
}) {
  if (!title || !taskPrompt) {
    throw new Error('Both `title` and `taskPrompt` are required to dispatch a thread.');
  }

  const reg = loadRegistry();
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

  const reservedSeq = mutateRegistry((freshReg) => {
    freshReg.seq = (Number(freshReg.seq) || 0) + 1;
    return freshReg.seq;
  });
  const threadId = `thr-${String(reservedSeq).padStart(3, '0')}`;

  let effectiveRepoRoot = scope.info.mainRepoRoot || scope.info.repoRoot || '';
  const projectLabel = scope.label || (scope.baseDir ? basename(scope.baseDir) : 'Project');
  ensureProjectMemoryFile(scope.baseDir, projectLabel, key);
  const { content: memoryText } = readProjectMemory(scope.baseDir, key);

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

  if (createWorktree && effectiveRepoRoot && !requestedWorktreePath) {
    const wt = await createGitWorktree({
      repoRoot: effectiveRepoRoot,
      threadId,
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
      await appendWorktreeExclude(finalWorktreePath, [
        '.agents/rules/worker-thread-context.md',
        '.agents/rules/project-memory.md',
      ]);
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
    title,
    taskPrompt,
    worktreePath: finalWorktreePath,
    repoRoot: effectiveRepoRoot || scope.baseDir,
    branch: resolvedBranch,
    baseRef: startRef,
    memoryText,
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
      (createWorktree ? effective.worktreeModel : effective.readOnlyModel) || 'inherit';
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

  const tags = ['project-thread', `thread:${threadId}`, `group:${groupId}`];
  if (resolvedCoordId) tags.push(`coord:${resolvedCoordId}`);

  const displayTitle = `[${threadId}] ${title}`;
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

export async function syncThreads({
  workspacePath = '',
  conversationId = '',
  coordinatorId = '',
  projectId = '',
  includeArchived = false,
  allWorkspaces = false,
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

  const pendingAutoSyncIds = [];
  const initialPendingSwitchAtById = new Map(
    list.map((t) => [t.threadId, t.pendingModelSwitch?.requestedAt || '']),
  );
  const becameArchivedIds = new Set();

  await Promise.all(
    list.map(async (t) => {
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
          if (!prevArchived && t.archived === true && t.worktreePath) {
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

      if (liveAct.lastSummary && !isActivelyWorking) {
        if (
          (!t.lastSummary || t.lastSyncedStepIndex !== liveAct.lastStepIndex) &&
          t.lastSummary !== liveAct.lastSummary
        ) {
          t.lastSummary = liveAct.lastSummary;
          dirty = true;
        }
      }

      // Compute Claude Projects 3-state triage bucket: 'working' | 'waiting' | 'idle'
      const { bucket, waitingReason } = computeThreadBucket(t, liveAct);
      t.bucket = bucket;
      t.waitingReason = waitingReason;

      if (
        prevHasPendingBgTask !== t.hasPendingBgTask ||
        prevActiveTool !== t.activeTool ||
        prevBucket !== t.bucket
      ) {
        dirty = true;
      }

      // Backup auto-sync reconciler if a running thread finished after boot and Stop hook hasn't pushed yet
      if (
        !t.archived &&
        t.runState === 'RUN_STATE_IDLE' &&
        !liveAct.hasPendingBgTask &&
        liveAct.lastStepIndex >= 0 &&
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
    }),
  );

  // Resolve concrete model display names with bounded concurrency & smart caching
  await mapWithConcurrency(list, 5, async (t) => {
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
      for (const t of list) {
        const freshT = freshReg.threads?.[t.threadId];
        if (!freshT) continue;
        const wasArchivedOnDisk = Boolean(freshT.archived);
        const initialPendingAt = initialPendingSwitchAtById.get(t.threadId) || '';
        const freshPendingAt = freshT.pendingModelSwitch?.requestedAt || '';
        const hasConcurrentNewSwitch = Boolean(freshPendingAt && freshPendingAt !== initialPendingAt);
        if (initialPendingAt && !t.pendingModelSwitch && freshPendingAt === initialPendingAt) {
          delete freshT.pendingModelSwitch;
        }
        if (!hasConcurrentNewSwitch) {
          freshT.runState = t.runState;
        }
        if (t.lastCompletedAt && (!freshT.lastCompletedAt || t.lastCompletedAt > freshT.lastCompletedAt)) {
          freshT.lastCompletedAt = t.lastCompletedAt;
        }
        if (t.lastSummary) freshT.lastSummary = t.lastSummary;
        freshT.archived = t.archived;
        if (t.projectId && !freshT.projectId) freshT.projectId = t.projectId;
        if (t.updatedAt && (!freshT.updatedAt || t.updatedAt > freshT.updatedAt)) {
          freshT.updatedAt = t.updatedAt;
        }
        if (freshT.worktreePath && freshT.worktreePath === t.worktreePath) {
          freshT.git = t.git;
        }
        freshT.hasPendingBgTask = t.hasPendingBgTask;
        freshT.activeTool = t.activeTool;
        freshT.activeToolObj = t.activeToolObj;
        freshT.stepsProgress = t.stepsProgress;
        freshT.stepsList = t.stepsList;
        freshT.toolStepCount = t.toolStepCount;
        freshT.bucket = t.bucket;
        freshT.waitingReason = t.waitingReason;
        if (!hasConcurrentNewSwitch) {
          if (t.modelDisplayName) freshT.modelDisplayName = t.modelDisplayName;
          if (t.resolvedModel) freshT.resolvedModel = t.resolvedModel;
          if (t.modelEnum) freshT.modelEnum = t.modelEnum;
        }
        if (t.usage) {
          freshT.usage = t.usage;
        }
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
    try {
      const syncRes = await syncCompletionToCoordinator({ threadId: tid, force: false });
      if (syncRes?.ok) {
        seenRunningThreadIds.delete(tid);
      }
    } catch {
      // Non-fatal; next poll or PreInvocation can retry
    }
  }

  list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

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
      threads: list,
      decisions: [],
      memory: { path: '', content: '' },
      updatedAt: new Date().toISOString(),
    };
  }

  const memory = scope.scopeKey
    ? readProjectMemory(scope.baseDir, scope.scopeKey)
    : { path: '', content: '' };
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
        list,
        { reg: loadRegistry(), locale: appLocale },
      )
    : [];

  let coordinatorTurnStamp = '';
  if (coordinator?.conversationId) {
    let txStamp = '';
    try {
      const txPath = getTranscriptPath(coordinator.conversationId);
      if (txPath && existsSync(txPath)) {
        const st = statSync(txPath);
        txStamp = `${Math.round(st.mtimeMs)}:${st.size}`;
      }
    } catch {
      txStamp = '';
    }
    coordinatorTurnStamp = `${coordinator.conversationId}|${Number(coordinator.lastStepCount) || 0}|${txStamp}`;
  }

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
    threads: list,
    decisions,
    memory,
    updatedAt: new Date().toISOString(),
  };
}

export async function updateProjectMemory({
  workspacePath = '',
  conversationId = '',
  coordinatorId = '',
  projectId = '',
  content = '',
  mode = 'append',
  section = 'Active Decisions & Constraints',
} = {}) {
  const reg = loadRegistry();
  const scope = await resolveProjectScope({
    workspacePath,
    conversationId: conversationId || coordinatorId,
    coordinatorId,
    projectId,
    reg,
  });

  if (!scope.scopeKey) {
    if (mode === 'read') return { path: '', content: '' };
    throw new Error('Provide workspacePath or conversationId to update project memory.');
  }

  if (mode === 'read') {
    return readProjectMemory(scope.baseDir, scope.scopeKey);
  }

  const projectLabel = scope.label || (scope.baseDir ? basename(scope.baseDir) : 'Project');
  const memPath = ensureProjectMemoryFile(scope.baseDir, projectLabel, scope.scopeKey);

  if (mode === 'replace') {
    writeFileSync(memPath, content, 'utf8');
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
    writeFileSync(memPath, next, 'utf8');
  }

  // Broadcast updated memory to all active worktrees in this project scope
  const repoRoot = scope.info.mainRepoRoot || scope.info.repoRoot || scope.baseDir;
  for (const t of Object.values(reg.threads)) {
    if (!t.archived && t.workspaceKey === scope.scopeKey && t.worktreePath) {
      syncRulesIntoWorktree({
        repoRoot,
        scopeKey: scope.scopeKey,
        worktreePath: t.worktreePath,
        thread: t,
      });
    }
  }

  return readProjectMemory(scope.baseDir, scope.scopeKey);
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
  const { forceWorktree = false, deleteBranch = true } = opts || {};

  if (!threadId) {
    throw new Error('`threadId` is required.');
  }

  const reg = loadRegistry();
  const t =
    reg.threads[threadId] ||
    Object.values(reg.threads).find((x) => x.conversationId === threadId);
  if (!t) throw new Error(`Thread not found: ${threadId}`);

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
    await appendWorktreeExclude(worktreePath, [
      '.agents/rules/worker-thread-context.md',
      '.agents/rules/project-memory.md',
    ]);
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
  } = opts || {};

  if (!threadId) {
    throw new Error('`threadId` is required.');
  }

  const reg = loadRegistry();
  const t =
    reg.threads[threadId] ||
    Object.values(reg.threads).find((x) => x.conversationId === threadId);
  if (!t) throw new Error(`Thread not found: ${threadId}`);

  try {
    await updateConversation(t.conversationId, { archived: true });
  } catch {
    // Ignore if already archived/deleted
  }

  t.archived = true;
  t.updatedAt = new Date().toISOString();
  saveRegistry(reg);

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

  const freshReg = loadRegistry();
  const freshT =
    freshReg.threads[t.threadId] ||
    Object.values(freshReg.threads).find((x) => x.conversationId === t.conversationId) ||
    cleanup.thread ||
    t;
  if (!freshT.archived) {
    freshT.archived = true;
    freshT.updatedAt = new Date().toISOString();
    saveRegistry(freshReg);
  }

  return {
    ok: true,
    threadId: freshT.threadId,
    archived: true,
    worktreeRemoved: Boolean(cleanup.worktreeRemoved),
    branchDeleted: Boolean(cleanup.branchDeleted),
    pruned: Boolean(cleanup.pruned),
    skippedReason: cleanup.skippedReason || '',
    worktreeError: cleanup.worktreeError || '',
    removedWorktreePath: cleanup.removedWorktreePath || '',
    deletedBranch: cleanup.deletedBranch || '',
    thread: freshT,
  };
}

function quoteWindowsCmdArg(val) {
  const s = String(val ?? '').replace(/\r?\n/g, ' ');
  return `"${s.replace(/"/g, '\\"')}"`;
}

export function invokeAgentApiSend({
  conversationId,
  message,
  title,
  projectId,
  timeoutMs = 12000,
}) {
  const exe = resolveAgentApiExe();
  const ep = resolveLsEndpoint();
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

  const isWinBatch = process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(exe);
  const spawnExe = isWinBatch ? process.env.ComSpec || 'cmd.exe' : exe;
  const spawnArgs = isWinBatch
    ? ['/d', '/s', '/c', `"${quoteWindowsCmdArg(exe)} ${args.map(quoteWindowsCmdArg).join(' ')}"`]
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
}) {
  const text = String(message || '').trim();
  if (!threadId || !text) {
    throw new Error('Both `threadId` and `message` are required.');
  }

  const reg = loadRegistry();
  const t = reg.threads[threadId] || Object.values(reg.threads).find((x) => x.conversationId === threadId);
  if (!t) throw new Error(`Thread not found: ${threadId}`);

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
      freshT.runState = 'RUN_STATE_RUNNING';
      freshT.updatedAt = now;
      return freshT;
    });
    seenRunningThreadIds.add(updatedThread.threadId);
    threadModelCache.set(updatedThread.conversationId, {
      checkedAt: Date.now(),
      updatedAt: now,
      runState: 'RUN_STATE_RUNNING',
      modelDisplayName: updatedThread.modelDisplayName || '',
      resolvedModel: updatedThread.resolvedModel || '',
      modelEnum: updatedThread.modelEnum || '',
      genMetaCount: baselineGenMetaCount,
      fromLs: true,
    });
    return { ok: true, thread: updatedThread };
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
    try {
      await invokeAgentApiSend({
        conversationId: t.conversationId,
        message: text,
        title: title || `Follow-up [${t.threadId}]`,
        projectId: t.projectId,
      });
    } catch (err) {
      if (t.projectId) {
        await invokeAgentApiSend({
          conversationId: t.conversationId,
          message: text,
          title: title || `Follow-up [${t.threadId}]`,
          projectId: '',
        });
      } else {
        throw err;
      }
    }
  }

  const now = new Date().toISOString();
  seenRunningThreadIds.add(t.threadId);
  const updatedThread = mutateRegistry((freshReg) => {
    const freshT =
      freshReg.threads[t.threadId] ||
      Object.values(freshReg.threads).find((x) => x.conversationId === t.conversationId);
    if (!freshT) return t;
    const pending = Array.isArray(freshT.pendingUserMessages) ? freshT.pendingUserMessages : [];
    pending.push({ id: `pm-${Date.now()}`, text, createdAt: now });
    freshT.pendingUserMessages = pending.slice(-8);
    freshT.runState = 'RUN_STATE_RUNNING';
    freshT.updatedAt = now;
    return freshT;
  });

  return { ok: true, thread: updatedThread };
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

export async function syncCompletionToCoordinator({
  threadId,
  transcriptPath = '',
  force = false,
  timeoutMs = 12000,
}) {
  const reg = loadRegistry();
  const t = reg.threads[threadId] || Object.values(reg.threads).find((x) => x.conversationId === threadId);
  if (!t) throw new Error(`Thread not found: ${threadId}`);

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
    `[THREAD_COMPLETION_SYNC] Worker thread \`${t.threadId}\` has finished execution (automated plugin callback — do NOT call dispatch_thread to spawn a duplicate thread for this callback):`,
    '',
    `- **Thread ID**: \`${t.threadId}\` ([View Full Thread](conversation://${t.conversationId}))`,
    `- **Task Title**: ${t.title}`,
    `- **Mode / Branch**: ${gitMeta}`,
    '',
    '### Worker Thread Final Report',
    reportBody,
    '',
    '---',
    '### Coordinator Segmented Card Output Format (Required)',
    'To keep consecutive worker callbacks visually separated like distinct conversation segments, reply in the user\'s language using this exact card structure (if this conclusion duplicates an already-reported result, give only a one-line acknowledgment without exposing internal dedup metadata):',
    `1. Start with a blockquote banner: \`> **✅ [${t.threadId}] ${t.title} · Completed** ([View Thread](conversation://${t.conversationId}))\` (localize "Completed" / "View Thread" to match the user's conversation language).`,
    '2. Below the banner, list **only 3–5 concise takeaway bullets** (root cause / key findings or changes / any decision needed from the user; leave verbose logs and large tables inside the worker thread).',
    '3. End with a horizontal rule `---` so adjacent thread callbacks have a clean visual boundary (and call `update_project_memory` if reusable project-wide constraints emerged).',
  ].join('\n');

  const coordProjId = coord?.projectId || t.projectId || '';
  const msgTitle = `[${t.threadId} Completed] ${t.title}`;
  const deadlineMs = Date.now() + timeoutMs;

  try {
    try {
      await invokeAgentApiSend({
        conversationId: targetCoordId,
        message: callbackMsg,
        title: msgTitle,
        projectId: coordProjId,
        timeoutMs: Math.max(1000, deadlineMs - Date.now()),
      });
    } catch (err) {
      const remainingMs = deadlineMs - Date.now();
      if (coordProjId && !err.isTimeout && err.code !== 'ENOENT' && remainingMs >= 1500) {
        await invokeAgentApiSend({
          conversationId: targetCoordId,
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

  // Persist completion & sync deduplication markers ONLY AFTER delivery actually succeeded
  const completedAt = new Date().toISOString();
  const freshReg = loadRegistry();
  const freshT =
    freshReg.threads[t.threadId] ||
    Object.values(freshReg.threads).find((x) => x.conversationId === t.conversationId);
  if (freshT) {
    if (nextGit) freshT.git = nextGit;
    if (completion.cardSummary) freshT.lastSummary = completion.cardSummary;
    freshT.runState = 'RUN_STATE_IDLE';
    freshT.hasPendingBgTask = false;
    freshT.activeTool = '';
    freshT.activeToolObj = null;
    freshT.lastCompletedAt = completedAt;
    freshT.updatedAt = completedAt;
    freshT.notifiedCoordinatorAt = completedAt;
    freshT.pushedToCoordinatorAt = completedAt;
    if (completion.stepIndex >= 0) {
      freshT.lastSyncedStepIndex = completion.stepIndex;
    }
    const { bucket, waitingReason } = computeThreadBucket(freshT, {
      lastStepIndex: completion.stepIndex,
      hasPendingBgTask: false,
    });
    freshT.bucket = bucket;
    freshT.waitingReason = waitingReason;
    saveRegistry(freshReg);
  }

  return { ok: true, synced: true, threadId: t.threadId, coordinatorId: targetCoordId };
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

export async function markThreadRead({ threadId }) {
  if (!threadId) {
    throw new Error('`threadId` is required.');
  }

  const reg = loadRegistry();
  const t = reg.threads[threadId] || Object.values(reg.threads).find((x) => x.conversationId === threadId);
  if (!t) throw new Error(`Thread not found: ${threadId}`);

  let dirty = false;
  if (t.runState === 'RUN_STATE_RUNNING') {
    try {
      const live = await getConversation(t.conversationId);
      const conv = live?.conversation || live;
      if (conv?.state?.runState && conv.state.runState !== t.runState) {
        t.runState = conv.state.runState;
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

  if (dirty) saveRegistry(reg);

  return {
    ok: true,
    locale: resolveAppLocale(),
    threadId: t.threadId,
    bucket: t.bucket,
    waitingReason: t.waitingReason,
    viewedAt: t.viewedAt || '',
    thread: t,
  };
}

export async function getThreadMessages({ threadId, clientStamp = '', markRead = false }) {
  const reg = loadRegistry();
  const t = reg.threads[threadId] || Object.values(reg.threads).find((x) => x.conversationId === threadId);
  if (!t) throw new Error(`Thread not found: ${threadId}`);

  let dirty = false;
  let convUpdatedAt = t.updatedAt || '';
  try {
    const live = await getConversation(t.conversationId);
    const conv = live?.conversation || live;
    if (conv?.state?.updateTime) {
      convUpdatedAt = conv.state.updateTime;
      t.updatedAt = convUpdatedAt;
    }
    if (conv?.state?.runState && conv.state.runState !== t.runState) {
      t.runState = conv.state.runState;
      if (conv.state.runState === 'RUN_STATE_IDLE' && !t.lastCompletedAt) {
        t.lastCompletedAt = new Date().toISOString();
      }
      dirty = true;
    }
  } catch {
    // Ignore transient LS errors
  }

  const modelChanged = await resolveThreadModelInfo(t, {
    forceLsCheck: true,
    convUpdatedAt,
    convRunState: t.runState || '',
  });
  if (modelChanged) dirty = true;

  const parsed = parseThreadTranscript(t.conversationId, t.pendingUserMessages || []);
  if (Array.isArray(t.pendingUserMessages) && t.pendingUserMessages.length > 0) {
    const stillPending = parsed.items.filter((it) => it.pending).map((it) => ({
      id: it.id,
      text: it.text,
      createdAt: it.createdAt,
    }));
    if (stillPending.length !== t.pendingUserMessages.length) {
      t.pendingUserMessages = stillPending;
      dirty = true;
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
  if (markRead && !isActivelyWorking) {
    if (applyMarkThreadReadOnRecord(t, liveAct)) {
      dirty = true;
    }
  } else {
    const { bucket, waitingReason } = computeThreadBucket(t, liveAct);
    t.bucket = bucket;
    t.waitingReason = waitingReason;
  }

  if (dirty) saveRegistry(reg);

  const locale = resolveAppLocale();
  const modelStamp = t.modelDisplayName || t.resolvedModel || t.model || '';
  const fullStamp = `${parsed.stamp}|rs:${t.runState}|bg:${liveAct.hasPendingBgTask ? 1 : 0}|b:${t.bucket}|m:${modelStamp}|loc:${locale}`;
  const threadView = {
    ...t,
    hasPendingBgTask: Boolean(liveAct.hasPendingBgTask),
    activeTool: isActivelyWorking ? liveAct.activeTool || parsed.activeActivity || '' : '',
    activeToolObj: isActivelyWorking ? liveAct.activeToolObj || null : null,
    stepsProgress: liveAct.stepsProgress || null,
    stepsList: liveAct.stepsList || null,
    toolStepCount: liveAct.toolStepCount || 0,
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
const VALID_DECISION_STYLES = new Set(['primary', 'secondary', 'danger']);
const VALID_AUTO_KINDS = new Set(['worktree_merge_ready', 'worktree_archive_ready']);

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

  const matchedThread = rawThreadId ? findThreadInRegistry(reg, rawThreadId) : null;
  let scopeKey = '';
  let projectId = rawProjectId || matchedThread?.projectId || '';
  let coordinatorId = rawCoordId || matchedThread?.coordinatorId || '';

  if (rawScopeKey && rawScopeKey !== '*') {
    scopeKey = normalizeScopeKeyForMatch(rawScopeKey);
  }

  if (!scopeKey && rawWorkspacePath) {
    const normWs = normalizeKey(rawWorkspacePath);
    const matchedCoord = Object.entries(reg.coordinators || {}).find(([ck, c]) => {
      if (isFilesystemPathKey(ck) && normalizeKey(ck) === normWs) return true;
      if (c?.repoRoot && normalizeKey(c.repoRoot) === normWs) return true;
      if (c?.workspacePath && normalizeKey(c.workspacePath) === normWs) return true;
      return false;
    });
    if (matchedCoord) {
      scopeKey = matchedCoord[0];
      if (!projectId && matchedCoord[1]?.projectId && matchedCoord[1].projectId !== 'outside-of-project') {
        projectId = matchedCoord[1].projectId;
      }
      if (!coordinatorId && matchedCoord[1]?.conversationId) {
        coordinatorId = matchedCoord[1].conversationId;
      }
    } else {
      scopeKey = normWs;
    }
  }

  if (!scopeKey && matchedThread?.workspaceKey) {
    scopeKey = normalizeScopeKeyForMatch(matchedThread.workspaceKey);
  }

  if (!scopeKey && (rawCoordId || rawConvId)) {
    const cid = rawCoordId || rawConvId;
    const byCoord = Object.values(reg.coordinators || {}).find((c) => c?.conversationId === cid);
    if (byCoord?.key) {
      scopeKey = normalizeScopeKeyForMatch(byCoord.key);
      if (!projectId && byCoord.projectId && byCoord.projectId !== 'outside-of-project') {
        projectId = byCoord.projectId;
      }
      if (!coordinatorId) coordinatorId = byCoord.conversationId || '';
    } else {
      const byThread = Object.values(reg.threads || {}).find((t) => t?.conversationId === cid);
      if (byThread?.workspaceKey) {
        scopeKey = normalizeScopeKeyForMatch(byThread.workspaceKey);
        if (!projectId && byThread.projectId && byThread.projectId !== 'outside-of-project') {
          projectId = byThread.projectId;
        }
        if (!coordinatorId && byThread.coordinatorId) {
          coordinatorId = byThread.coordinatorId;
        }
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

  return {
    scopeKey,
    projectId: projectId && projectId !== 'outside-of-project' ? projectId : '',
    coordinatorId,
    threadId: matchedThread?.threadId || rawThreadId,
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
    filtered = decisions.filter((d) => includeResolved || d.status === 'pending');
  } else {
    const resolved = resolveDecisionScopeSync(opts, reg);
    if (!resolved.scopeKey) return [];
    filtered = decisions.filter((d) => {
      if (!includeResolved && d.status !== 'pending') return false;
      return isSameScopeKey(d.workspaceKey, resolved.scopeKey);
    });
  }

  filtered.sort((a, b) => {
    const cmp = String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    return cmp !== 0 ? cmp : String(b.id || '').localeCompare(String(a.id || ''));
  });

  return filtered.map((d) => ({
    ...d,
    source: 'explicit',
    options: Array.isArray(d.options) ? d.options.map((o) => ({ ...o })) : [],
  }));
}

export function addDecision(params = {}) {
  const title = String(params?.title || '').trim();
  if (!title) {
    throw new Error('`title` is required to add a decision.');
  }
  const summary = String(params?.summary || '').trim().slice(0, 400);

  return mutateRegistry((reg) => {
    const resolved = resolveDecisionScopeSync(params, reg);
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
    const options = normalizeDecisionOptions(params?.options, { threadId, title, summary });

    const record = {
      id,
      source: 'explicit',
      workspaceKey: resolved.scopeKey,
      projectId: resolved.projectId || '',
      coordinatorId: resolved.coordinatorId || '',
      threadId,
      title: title.slice(0, 140),
      summary,
      options,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      resolvedAt: '',
      resolvedOptionId: '',
      resolvedOptionLabel: '',
    };

    if (!reg.decisions || typeof reg.decisions !== 'object') reg.decisions = {};
    reg.decisions[id] = record;
    return { ...record, options: record.options.map((o) => ({ ...o })) };
  });
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
    const existing = reg.decisions?.[decisionId];
    if (!existing) {
      throw new Error(`Decision not found: ${decisionId}`);
    }
    const now = new Date().toISOString();
    const optionId = String(opts.optionId || '').trim();
    const matchedOpt = optionId
      ? (existing.options || []).find((o) => o && o.id === optionId)
      : null;
    const optionLabel = String(opts.optionLabel || matchedOpt?.label || '').trim();

    existing.status = opts.status === 'dismissed' ? 'dismissed' : 'resolved';
    existing.resolvedAt = now;
    existing.updatedAt = now;
    if (optionId) existing.resolvedOptionId = optionId;
    if (optionLabel) existing.resolvedOptionLabel = optionLabel;

    return {
      ...existing,
      source: 'explicit',
      options: Array.isArray(existing.options) ? existing.options.map((o) => ({ ...o })) : [],
    };
  });
}

function parseAutoDismissTarget(decisionIdOrAutoKey, opts = {}, reg = null) {
  const extra = opts && typeof opts === 'object' ? opts : {};
  let rawKey = '';
  let threadId = String(extra.threadId || '').trim();
  let autoKind = String(extra.autoKind || '').trim();
  let lastCommit = String(extra.lastCommit || '').trim();
  let workspaceKey = String(extra.workspaceKey || '').trim();

  if (decisionIdOrAutoKey && typeof decisionIdOrAutoKey === 'object') {
    rawKey = String(decisionIdOrAutoKey.decisionId || decisionIdOrAutoKey.autoKey || decisionIdOrAutoKey.id || '').trim();
    if (!threadId) threadId = String(decisionIdOrAutoKey.threadId || '').trim();
    if (!autoKind) autoKind = String(decisionIdOrAutoKey.autoKind || '').trim();
    if (!lastCommit) lastCommit = String(decisionIdOrAutoKey.lastCommit || '').trim();
    if (!workspaceKey) workspaceKey = String(decisionIdOrAutoKey.workspaceKey || '').trim();
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

  const threadRec = threadId && reg ? findThreadInRegistry(reg, threadId) : null;
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
    autoKind: normalizedKind,
    lastCommit: commitStamp,
    workspaceKey: normalizeScopeKeyForMatch(workspaceKey),
  };
}

export function dismissDecision(decisionIdOrAutoKey, opts = {}) {
  const explicitCandidateId =
    typeof decisionIdOrAutoKey === 'string'
      ? decisionIdOrAutoKey.trim()
      : String(decisionIdOrAutoKey?.decisionId || decisionIdOrAutoKey?.id || '').trim();

  return mutateRegistry((reg) => {
    if (explicitCandidateId && reg.decisions?.[explicitCandidateId]) {
      const existing = reg.decisions[explicitCandidateId];
      const now = new Date().toISOString();
      existing.status = 'dismissed';
      existing.resolvedAt = now;
      existing.updatedAt = now;
      return {
        ok: true,
        source: 'explicit',
        decisionId: explicitCandidateId,
        decision: {
          ...existing,
          source: 'explicit',
          options: Array.isArray(existing.options) ? existing.options.map((o) => ({ ...o })) : [],
        },
      };
    }

    if (explicitCandidateId && /^dec-\d+$/i.test(explicitCandidateId)) {
      throw new Error(`Decision not found: ${explicitCandidateId}`);
    }

    const parsed = parseAutoDismissTarget(decisionIdOrAutoKey, opts, reg);
    if (!parsed.threadId) {
      throw new Error('`decisionId` or valid auto-decision key (`threadId:lastCommit`) is required.');
    }

    const storeKey = `${parsed.threadId}:${parsed.autoKind}`;
    const now = new Date().toISOString();
    const entry = {
      key: storeKey,
      workspaceKey: parsed.workspaceKey,
      threadId: parsed.threadId,
      autoKind: parsed.autoKind,
      lastCommit: parsed.lastCommit,
      dismissedAt: now,
    };
    if (!reg.dismissedAutoDecisions || typeof reg.dismissedAutoDecisions !== 'object') {
      reg.dismissedAutoDecisions = {};
    }
    reg.dismissedAutoDecisions[storeKey] = entry;
    return {
      ok: true,
      source: 'auto',
      ...entry,
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

function buildAutoWorktreeDecisionItem(t, { autoKind, scopeKey, projectId, locale }) {
  const branch = String(t.git?.branch || t.branch || '').trim();
  const baseRef = String(t.baseRef || '').trim();
  const aheadCount = Number(t.git?.aheadCount) || 0;
  const mergeMethod = String(t.git?.mergeMethod || '').trim();
  const isCherry = mergeMethod === 'cherry-pick';
  const commitStamp = String(t.git?.lastCommit || '').trim() || '__no_commit__';
  const loc = locale === 'zh-CN' || locale === 'zh-TW' ? locale : 'en';

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
        ? `请将工作线程 \`${t.threadId}\`（${t.title}${branch ? `，分支 \`${branch}\`` : ''}${baseRef ? `，目标基准 \`${baseRef}\`` : ''}）的已提交改动安全合入目标分支，并在完成后汇报。`
        : loc === 'zh-TW'
          ? `請將工作執行緒 \`${t.threadId}\`（${t.title}${branch ? `，分支 \`${branch}\`` : ''}${baseRef ? `，目標基準 \`${baseRef}\`` : ''}）的已提交改動安全合併至目標分支，並在完成後回報。`
          : `Please merge the committed changes from worker thread \`${t.threadId}\` (${t.title}${branch ? `, branch \`${branch}\`` : ''}${baseRef ? `, base \`${baseRef}\`` : ''}) into the target branch and report back.`;

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
    threadList = Object.values(reg.threads || {}).filter(
      (t) => t && !t.archived && isSameScopeKey(t.workspaceKey, resolved.scopeKey),
    );
  } else {
    threadList = [];
  }

  const autoList = [];
  for (const t of threadList) {
    if (!t || t.archived) continue;
    if (resolved.scopeKey && t.workspaceKey && !isSameScopeKey(t.workspaceKey, resolved.scopeKey)) {
      continue;
    }
    if (!t.worktreePath) continue;
    if (!t.git || t.git.exists === false) continue;
    if (t.runState !== 'RUN_STATE_IDLE' || Boolean(t.hasPendingBgTask) || t.bucket === 'working') {
      continue;
    }
    if (explicitThreadIds.has(t.threadId)) continue;

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
  const requestedLabel = String(params.label || '').trim();

  const reg = loadRegistry();
  const explicitDec = decisionId && reg.decisions?.[decisionId] ? reg.decisions[decisionId] : null;
  const matchedOption =
    explicitDec && optionId
      ? (explicitDec.options || []).find((o) => o && o.id === optionId) || null
      : null;

  const effectiveAction =
    VALID_DECISION_ACTIONS.has(requestedAction)
      ? requestedAction
      : matchedOption?.action || (decisionId && !explicitDec && !optionId ? 'dismiss' : '');

  if (!VALID_DECISION_ACTIONS.has(effectiveAction)) {
    throw new Error(`Unsupported or missing decision action: ${effectiveAction || '(empty)'}`);
  }

  const parsedAuto = !explicitDec
    ? parseAutoDismissTarget(
        {
          decisionId,
          threadId: requestedThreadId,
          autoKind: requestedAutoKind,
          lastCommit: requestedLastCommit,
        },
        {},
        reg,
      )
    : null;
  const targetThreadId = explicitDec?.threadId || requestedThreadId || parsedAuto?.threadId || '';
  const effectiveLabel = requestedLabel || matchedOption?.label || '';

  if (effectiveAction === 'dismiss') {
    const dismissTarget = explicitDec
      ? explicitDec.id
      : {
          decisionId,
          threadId: targetThreadId,
          autoKind: requestedAutoKind || parsedAuto?.autoKind || '*',
          lastCommit: requestedLastCommit || parsedAuto?.lastCommit || '',
          workspaceKey: explicitDec?.workspaceKey || parsedAuto?.workspaceKey || '',
        };
    const res = dismissDecision(dismissTarget);
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
    const archiveResult = await archiveThread(targetThreadId, {
      removeWorktree: true,
      forceWorktree: false,
      deleteBranch: true,
    });
    let resolvedDecision = null;
    if (explicitDec) {
      resolvedDecision = resolveDecision({
        decisionId: explicitDec.id,
        optionId: optionId || matchedOption?.id || '',
        optionLabel: effectiveLabel,
      });
    }
    return {
      ok: true,
      action: 'archive_thread',
      decisionId: explicitDec?.id || decisionId,
      threadId: targetThreadId,
      archiveResult,
      decision: resolvedDecision,
    };
  }

  // effectiveAction === 'send_coordinator'
  const threadRec = targetThreadId ? findThreadInRegistry(reg, targetThreadId) : null;
  const scope = await resolveProjectScope({
    workspacePath: params.workspacePath || params.workspace || '',
    conversationId: params.conversationId || '',
    coordinatorId: params.coordinatorId || explicitDec?.coordinatorId || threadRec?.coordinatorId || '',
    projectId: params.projectId || explicitDec?.projectId || threadRec?.projectId || '',
    reg,
  });

  const effectiveScopeKey =
    explicitDec?.workspaceKey || threadRec?.workspaceKey || scope.scopeKey || '';
  const targetCoordId = resolveTargetCoordinatorId({
    coordinatorId:
      params.coordinatorId ||
      explicitDec?.coordinatorId ||
      threadRec?.coordinatorId ||
      '',
    conversationId: params.conversationId || '',
    scopeKey: effectiveScopeKey,
    workspacePath: params.workspacePath || params.workspace || scope.baseDir || '',
    projectId: params.projectId || explicitDec?.projectId || threadRec?.projectId || scope.projectId || '',
    reg,
  });

  if (!targetCoordId) {
    throw new Error('No active Coordinator conversation found for this project.');
  }

  const locale = resolveAppLocale();
  const coordRecord = lookupCoordinatorForScope(reg, {
    scopeKey: effectiveScopeKey,
    workspacePath: params.workspacePath || params.workspace || scope.baseDir || '',
    projectId: params.projectId || explicitDec?.projectId || scope.projectId || '',
    conversationId: targetCoordId,
  });
  const targetProjectId =
    coordRecord?.projectId ||
    explicitDec?.projectId ||
    threadRec?.projectId ||
    scope.projectId ||
    '';

  const decisionTitle = explicitDec?.title || params.title || '';
  const actionInstruction =
    requestedMessage ||
    matchedOption?.message ||
    (locale === 'en'
      ? `User selected "${effectiveLabel || 'Confirm'}"${decisionTitle ? ` for "${decisionTitle}"` : ''}.`
      : `用户选择了「${effectiveLabel || '确认'}」${decisionTitle ? `（${decisionTitle}）` : ''}，请按此执行。`);

  const headerLine =
    locale === 'en'
      ? `[BOARD_DECISION] User acted on a pending decision from the Project Threads board:`
      : `[BOARD_DECISION] 用户在右侧项目线程看板「待决策」区触发了快捷决策：`;
  const lines = [headerLine];
  if (explicitDec?.id) lines.push(`- Decision ID: \`${explicitDec.id}\``);
  if (targetThreadId) {
    lines.push(
      `- Thread: \`${targetThreadId}\`${threadRec?.title ? ` (${threadRec.title})` : ''}${threadRec?.branch ? ` | Branch: \`${threadRec.branch}\`` : ''}`,
    );
  }
  if (decisionTitle) lines.push(`- Topic: ${decisionTitle}`);
  if (effectiveLabel) lines.push(`- Selected Option: **${effectiveLabel}**`);
  lines.push(`- Instruction: ${actionInstruction}`);
  const fullMessage = lines.join('\n');
  const sendTitle =
    targetThreadId
      ? `[Decision ${targetThreadId}] ${effectiveLabel || decisionTitle || 'Action'}`
      : `[Decision] ${effectiveLabel || decisionTitle || 'Action'}`;

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

  let resolvedDecision = null;
  if (explicitDec) {
    resolvedDecision = resolveDecision({
      decisionId: explicitDec.id,
      optionId: optionId || matchedOption?.id || '',
      optionLabel: effectiveLabel,
    });
  } else if (targetThreadId) {
    dismissDecision({
      threadId: targetThreadId,
      autoKind: requestedAutoKind || parsedAuto?.autoKind || 'worktree_merge_ready',
      lastCommit: requestedLastCommit || parsedAuto?.lastCommit || threadRec?.git?.lastCommit || '',
      workspaceKey: effectiveScopeKey,
    });
  }

  return {
    ok: true,
    action: 'send_coordinator',
    decisionId: explicitDec?.id || decisionId,
    coordinatorId: targetCoordId,
    threadId: targetThreadId,
    decision: resolvedDecision,
  };
}

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
  getConversation,
  getModelConfigLookup,
  getStateDir,
  getThreadGeneratorModel,
  listConversations,
  resolveAgentApiExe,
  resolveLsEndpoint,
  resolveModelLabelFromLookup,
  updateConversation,
} from './ls-client.mjs';
import { formatModelDisplay, isTierAlias } from './model-format.mjs';
import {
  extractLatestAssistantText,
  extractThreadCompletion,
  extractTranscriptModel,
  parseThreadTranscript,
  peekLiveActivity,
} from './transcript.mjs';

const PROCESS_BOOT_ISO = new Date().toISOString();
const seenRunningThreadIds = new Set();

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
const REGISTRY_LOCK_FILE = () => `${REGISTRY_FILE()}.lock`;
const REGISTRY_LOCK_STALE_MS = 10_000;
const REGISTRY_LOCK_DEAD_PID_MIN_AGE_MS = 1000;
const REGISTRY_LOCK_WAIT_MS = 4000;

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
  return { version: 1, seq: 0, coordinators: {}, threads: {} };
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
    const reg = {
      version: 1,
      seq: Number(parsed.seq) || 0,
      coordinators,
      threads: parsed.threads || {},
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
    }
    if (existsSync(file) && reg && typeof reg === 'object' && reg.threads) {
      try {
        const disk = JSON.parse(readFileSync(file, 'utf8'));
        if (disk && typeof disk === 'object') {
          if (Number(disk.seq) > Number(reg.seq || 0)) {
            reg.seq = Number(disk.seq);
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
            }
          }
        }
      } catch {
        // Ignore transient parse errors during merge-safe save
      }
    }
    const payload = JSON.stringify(reg, null, 2);
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
  });
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
const threadModelCache = new Map(); // convId -> { checkedAt, updatedAt, runState, modelDisplayName, resolvedModel, fromLs }

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

/**
 * Resolves and refreshes a thread's concrete `modelDisplayName` and `resolvedModel` using
 * GetCascadeTrajectoryGeneratorMetadata (live, including mid-thread switches), falling back
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
      !t.modelDisplayName
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
    effectiveRunState !== cached.runState
  ) {
    shouldQueryLs = true;
  } else if (!cached.fromLs && nowMs - cached.checkedAt >= THREAD_MODEL_OFFLINE_RETRY_MS) {
    shouldQueryLs = true;
  } else if (!t.modelDisplayName && nowMs - cached.checkedAt >= THREAD_MODEL_EMPTY_RETRY_MS) {
    shouldQueryLs = true;
  }

  let nextDisplayName = '';
  let nextResolvedModel = '';
  let fromLs = cached?.fromLs || false;

  if (shouldQueryLs) {
    const genRes = await getThreadGeneratorModel(convId, 3500);
    fromLs = genRes.ok;
    if (genRes.ok && genRes.info) {
      nextResolvedModel = genRes.info.responseModel || genRes.info.modelEnum || '';
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
  }

  if (!nextDisplayName || !fromLs) {
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
    fromLs,
  });
  if (threadModelCache.size > 200) {
    threadModelCache.delete(threadModelCache.keys().next().value);
  }

  let changed = false;
  if (nextDisplayName !== (t.modelDisplayName || '')) {
    t.modelDisplayName = nextDisplayName;
    changed = true;
  }
  if (nextResolvedModel && nextResolvedModel !== (t.resolvedModel || '')) {
    t.resolvedModel = nextResolvedModel;
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
      return {
        scopeKey,
        scopeKind: 'workspace',
        baseDir,
        projectId: effectiveProjId,
        environmentId: effectiveEnvId,
        label: basename(baseDir),
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
      const label = baseDir
        ? basename(baseDir)
        : (coord?.title
            ? coord.title.replace(/^(?:\[Coordinator\]\s*)+/i, '').trim()
            : String(convMeta.title || '').replace(/^(?:\[Coordinator\]\s*)+/i, '').trim() || 'Project');
      return {
        scopeKey,
        scopeKind,
        baseDir,
        projectId: resolvedProjId,
        environmentId: resolvedEnvId,
        label,
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
      const label = baseDir
        ? basename(baseDir)
        : (matchedCoord.title
            ? matchedCoord.title.replace(/^(?:\[Coordinator\]\s*)+/i, '').trim()
            : String(convMeta.title || '').replace(/^(?:\[Coordinator\]\s*)+/i, '').trim() || 'Project');
      return {
        scopeKey,
        scopeKind,
        baseDir,
        projectId: resolvedProjId,
        environmentId: resolvedEnvId,
        label,
        info,
      };
    }
  }

  // d) effectiveProjId is non-empty
  if (effectiveProjId) {
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
      const label = baseDir
        ? basename(baseDir)
        : (projCoord.title
            ? projCoord.title.replace(/^(?:\[Coordinator\]\s*)+/i, '').trim()
            : String(convMeta.title || '').replace(/^(?:\[Coordinator\]\s*)+/i, '').trim() || 'Project');
      return {
        scopeKey,
        scopeKind,
        baseDir,
        projectId: effectiveProjId,
        environmentId: resolvedEnvId,
        label,
        info,
      };
    }

    return {
      scopeKey: `project:${effectiveProjId}`,
      scopeKind: 'project',
      baseDir: '',
      projectId: effectiveProjId,
      environmentId: effectiveEnvId,
      label: convMeta.title || 'Project',
      info: emptyInfo,
    };
  }

  // e) Standalone conversation outside any project & without workspace
  if (convId) {
    return {
      scopeKey: `conv:${convId}`,
      scopeKind: 'conversation',
      baseDir: '',
      projectId: '',
      environmentId: effectiveEnvId,
      label: convMeta.title || 'Session',
      info: emptyInfo,
    };
  }

  // f) Unscoped (fail-closed)
  return {
    scopeKey: '',
    scopeKind: 'unscoped',
    baseDir: '',
    projectId: '',
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

export function ensureProjectMemoryFile(baseDir, projectName = 'Project', scopeKey = '') {
  const memPath = getMemoryFilePath(baseDir, scopeKey);
  if (!memPath) return '';
  const parent = dirname(memPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (!existsSync(memPath)) {
    const initial = [
      `# ${projectName} Shared Memory`,
      '',
      '> Auto-shared across the Project Coordinator and all Worker Threads.',
      '',
      '## Architecture & Conventions',
      '- Keep changes scoped to each thread\'s assigned module and branch.',
      '',
      '## Active Decisions & Constraints',
      '- (Record cross-cutting decisions here via `update_project_memory`.)',
      '',
    ].join('\n');
    writeFileSync(memPath, initial, 'utf8');
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
    const brief = [
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
      `3. Keep work committed cleanly on branch \`${thread.branch}\` when requested, and conclude your final reply with a concise summary of changes, commits, and any new shared architectural notes.`,
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
      await runGit(['worktree', 'add', worktreePath, branch], repoRoot, 25000);
    } else {
      await runGit(['worktree', 'add', '-b', branch, worktreePath, startRef], repoRoot, 25000);
    }
  }

  await appendWorktreeExclude(worktreePath, [
    '.agents/rules/worker-thread-context.md',
    '.agents/rules/project-memory.md',
  ]);

  return { worktreePath, branch, baseRef: startRef };
}

export async function inspectWorktreeGit(worktreePath, baseRef = '') {
  if (!worktreePath || !existsSync(worktreePath)) return null;
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
    let aheadCount = 0;
    let countRef = '';
    if (baseRef && baseRef !== 'HEAD') {
      const refCheck = await runGitResult(
        ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`],
        worktreePath,
        5000,
      );
      if (refCheck.ok) countRef = baseRef;
    }
    if (!countRef && branch !== 'main') {
      const mainCheck = await runGitResult(
        ['rev-parse', '--verify', '--quiet', 'main^{commit}'],
        worktreePath,
        5000,
      );
      if (mainCheck.ok) countRef = 'main';
    }
    if (countRef) {
      try {
        const cnt = await runGit(['rev-list', '--count', `${countRef}..HEAD`], worktreePath, 5000);
        aheadCount = Number(cnt) || 0;
      } catch {
        aheadCount = 0;
      }
    }
    return {
      exists: true,
      branch,
      dirtyCount: dirtyLines.length,
      aheadCount,
      lastCommit,
    };
  } catch {
    return { exists: false, branch: '', dirtyCount: 0, aheadCount: 0, lastCommit: '' };
  }
}

export async function initCoordinator({
  workspacePath = '',
  conversationId = '',
  coordinatorId = '',
  projectId = '',
  title = '',
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

  const memoryPath = ensureProjectMemoryFile(scope.baseDir, projectLabel, key);

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

function buildWorkerPrompt({ threadId, title, taskPrompt, worktreePath, repoRoot, branch, baseRef, memoryText }) {
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
    taskPrompt.trim(),
    '',
    '## Completion & Handback Protocol',
    'When you complete this task (or if you hit a blocker needing Coordinator decision):',
    '1. Ensure your changes in the worktree are clean and well-structured (commit to your assigned branch if requested in the task).',
    '2. End your final message with a concise structured summary (`### Thread Summary`) listing: key changes/findings, modified files or commit hash, and any new project-wide learnings for Shared Memory.',
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
  model = 'flash',
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

  const resolvedCoordId = String(coordinatorId || coord?.conversationId || conversationId || '').trim();
  const resolvedProjId =
    scope.projectId ||
    (coord?.projectId && coord.projectId !== 'outside-of-project' ? coord.projectId : '') ||
    '';
  const resolvedEnvId = scope.environmentId || coord?.environmentId || '';
  const groupId = coord?.groupId || `proj-grp-${randomUUID().slice(0, 8)}`;

  const reservedSeq = mutateRegistry((freshReg) => {
    freshReg.seq = (Number(freshReg.seq) || 0) + 1;
    return freshReg.seq;
  });
  const threadId = `thr-${String(reservedSeq).padStart(3, '0')}`;

  const effectiveRepoRoot = scope.info.mainRepoRoot || scope.info.repoRoot || '';
  const projectLabel = scope.label || (scope.baseDir ? basename(scope.baseDir) : 'Project');
  ensureProjectMemoryFile(scope.baseDir, projectLabel, key);
  const { content: memoryText } = readProjectMemory(scope.baseDir, key);

  let worktreePath = '';
  let resolvedBranch = branch || '';
  const startRef = baseRef || scope.info.currentBranch || coord?.defaultBranch || 'HEAD';

  if (createWorktree && effectiveRepoRoot) {
    const wt = await createGitWorktree({
      repoRoot: effectiveRepoRoot,
      threadId,
      title,
      requestedBranch: branch,
      baseRef: startRef,
    });
    worktreePath = wt.worktreePath;
    resolvedBranch = wt.branch;
  }

  const fullPrompt = buildWorkerPrompt({
    threadId,
    title,
    taskPrompt,
    worktreePath,
    repoRoot: effectiveRepoRoot || scope.baseDir,
    branch: resolvedBranch,
    baseRef: startRef,
    memoryText,
  });

  const normalizedModel =
    !model || model === 'inherit' || model === 'auto' ? 'pro' : model;

  const tags = ['project-thread', `thread:${threadId}`, `group:${groupId}`];
  if (resolvedCoordId) tags.push(`coord:${resolvedCoordId}`);

  const displayTitle = `[${threadId}] ${title}`;
  const conv = await createConversation({
    projectId: resolvedProjId,
    environmentId: resolvedEnvId,
    title: displayTitle,
    model: normalizedModel,
    tags,
    promptText: fullPrompt,
  });

  const spawnedId = conv?.id || '';
  if (!spawnedId) {
    throw new Error('ConversationService/CreateConversation returned no conversation ID.');
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
  const initialDisplayName = await resolveNonTierModelDisplay(normalizedModel);
  const initialResolvedModel = initialDisplayName && !isTierAlias(normalizedModel) ? normalizedModel : '';
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
    worktreePath,
    branch: resolvedBranch,
    baseRef: startRef,
    title,
    displayTitle,
    taskPrompt,
    model: normalizedModel,
    modelDisplayName: initialDisplayName,
    resolvedModel: initialResolvedModel,
    runState: conv?.state?.runState || 'RUN_STATE_RUNNING',
    archived: false,
    git: worktreePath ? { exists: true, branch: resolvedBranch, dirtyCount: 0, aheadCount: 0, lastCommit: '' } : null,
    lastSummary: '',
    lastCompletedAt: '',
    notifiedCoordinatorAt: '',
    createdAt: now,
    updatedAt: now,
  };

  if (worktreePath) {
    syncRulesIntoWorktree({
      repoRoot: effectiveRepoRoot,
      scopeKey: key,
      worktreePath,
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
        if (typeof conv?.annotations?.archived === 'boolean' && conv.annotations.archived !== t.archived) {
          t.archived = conv.annotations.archived;
          dirty = true;
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
        const gitInfo = await inspectWorktreeGit(t.worktreePath, t.baseRef);
        if (JSON.stringify(gitInfo) !== JSON.stringify(t.git)) {
          t.git = gitInfo;
          dirty = true;
        }
      }

      const liveAct = peekLiveActivity(t.conversationId);
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

      // Backup auto-sync reconciler if a running thread finished after boot and Stop hook hasn't pushed yet
      if (
        !t.archived &&
        t.runState === 'RUN_STATE_IDLE' &&
        !liveAct.hasPendingBgTask &&
        liveAct.lastStepIndex >= 0 &&
        t.lastSyncedStepIndex !== liveAct.lastStepIndex &&
        (wasRunning || (t.createdAt && t.createdAt >= PROCESS_BOOT_ISO))
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

  if (dirty) {
    mutateRegistry((freshReg) => {
      if (coordinator && scope?.scopeKey) {
        const freshCoord = freshReg.coordinators?.[scope.scopeKey];
        if (freshCoord && freshCoord.conversationId === coordinator.conversationId) {
          if (coordinator.projectId && coordinator.projectId !== freshCoord.projectId) {
            freshCoord.projectId = coordinator.projectId;
          }
          if (coordinator.environmentId && coordinator.environmentId !== freshCoord.environmentId) {
            freshCoord.environmentId = coordinator.environmentId;
          }
        }
      }
      for (const t of list) {
        const freshT = freshReg.threads?.[t.threadId];
        if (!freshT) continue;
        freshT.runState = t.runState;
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
        if (t.modelDisplayName) freshT.modelDisplayName = t.modelDisplayName;
        if (t.resolvedModel) freshT.resolvedModel = t.resolvedModel;
      }
    });
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
      hasWorkspace: false,
      hasGitRepo: false,
      projectLabel: 'All Projects',
      coordinator: null,
      threads: list,
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
  const effectiveProjectId = scope.projectId || coordinator?.projectId || '';
  const projectLabel =
    scope.label ||
    (coordinator?.title ? coordinator.title.replace(/^\[Coordinator\]\s*/i, '') : '');

  return {
    locale: resolveAppLocale(),
    scopeKey: scope.scopeKey,
    scopeKind: scope.scopeKind,
    projectId: effectiveProjectId,
    hasWorkspace: Boolean(scope.baseDir),
    hasGitRepo,
    projectLabel,
    coordinator,
    threads: list,
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

async function resolveCleanupBaseRef(repoRoot, preferredRef = '') {
  const candidates = [];
  const pref = String(preferredRef || '').trim();
  if (pref && pref !== 'HEAD') candidates.push(pref);
  if (!candidates.includes('main')) candidates.push('main');
  candidates.push('HEAD');

  for (const ref of candidates) {
    const res = await runGitResult(
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      repoRoot,
      5000,
    );
    if (res.ok) return ref;
  }
  return '';
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
    return { ok: false, merged: false, error: 'Could not resolve base branch or HEAD for merge check.' };
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
  for (const item of refsToCheck) {
    const ancRes = await runGitResult(
      ['merge-base', '--is-ancestor', item.ref, baseRef],
      repoRoot,
      8000,
    );
    if (ancRes.ok) continue;
    if (ancRes.code === 1) {
      return {
        ok: true,
        merged: false,
        error: `Branch "${item.label}" has unmerged commit(s) not in "${baseRef}".`,
      };
    }
    return {
      ok: false,
      merged: false,
      error: ancRes.error || `Failed to verify merge status of "${item.label}" against "${baseRef}".`,
    };
  }
  return { ok: true, merged: true, error: '' };
}

async function tryDeleteThreadBranch({ repoRoot, branch, baseRef, forceWorktree }) {
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
  const delFlag = forceWorktree ? '-D' : '-d';
  const delRes = await runGitResult(['branch', delFlag, branch], repoRoot, 8000);
  if (delRes.ok) {
    return { deleted: true, error: '' };
  }
  return { deleted: false, error: delRes.error || `Failed to delete branch ${branch}` };
}

function clearThreadWorktreeFields(threadId, convId) {
  const freshReg = loadRegistry();
  const freshT =
    freshReg.threads[threadId] ||
    Object.values(freshReg.threads).find((x) => x.conversationId === convId);
  if (freshT) {
    freshT.worktreePath = '';
    freshT.git = null;
    freshT.updatedAt = new Date().toISOString();
    saveRegistry(freshReg);
    return freshT;
  }
  return null;
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

  // Already-missing directory: prune stale Git worktree metadata and clear registry
  if (!existsSync(worktreePath)) {
    let branchDeleted = false;
    let branchError = '';
    if (repoRoot && existsSync(repoRoot)) {
      await runGitResult(['worktree', 'prune'], repoRoot, 10000);
      if (deleteBranch && storedBranch) {
        const resolvedBase = await resolveCleanupBaseRef(repoRoot, t.baseRef);
        const mergeCheck = forceWorktree
          ? { ok: true, merged: true }
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

  const resolvedBase = await resolveCleanupBaseRef(repoRoot, t.baseRef);

  // If a prior interrupted/locked removal already removed .git inside worktreePath, clean up the leftover folder safely
  if (!existsSync(join(worktreePath, '.git'))) {
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
      deleteBranch,
      worktreePath,
    });
  }

  const headBranchRes = await runGitResult(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath, 5000);
  const headShaRes = await runGitResult(['rev-parse', 'HEAD'], worktreePath, 5000);
  const checkedBranch = headBranchRes.ok ? headBranchRes.stdout.trim() : '';
  const targetBranch = checkedBranch && checkedBranch !== 'HEAD' ? checkedBranch : storedBranch;
  const wtHeadSha = headShaRes.ok ? headShaRes.stdout.trim() : '';

  let hadOnlyInjectedUntracked = false;
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

export async function sendThreadMessage({ threadId, message, title = '' }) {
  const text = String(message || '').trim();
  if (!threadId || !text) {
    throw new Error('Both `threadId` and `message` are required.');
  }

  const reg = loadRegistry();
  const t = reg.threads[threadId] || Object.values(reg.threads).find((x) => x.conversationId === threadId);
  if (!t) throw new Error(`Thread not found: ${threadId}`);

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
    ? await inspectWorktreeGit(t.worktreePath, t.baseRef)
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
    freshT.lastCompletedAt = completedAt;
    freshT.updatedAt = completedAt;
    freshT.notifiedCoordinatorAt = completedAt;
    freshT.pushedToCoordinatorAt = completedAt;
    if (completion.stepIndex >= 0) {
      freshT.lastSyncedStepIndex = completion.stepIndex;
    }
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

  const liveAct = peekLiveActivity(t.conversationId);
  const isActivelyWorking =
    !t.archived && (t.runState === 'RUN_STATE_RUNNING' || Boolean(liveAct.hasPendingBgTask));
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

  const liveAct = peekLiveActivity(t.conversationId);
  const isActivelyWorking =
    !t.archived && (t.runState === 'RUN_STATE_RUNNING' || Boolean(liveAct.hasPendingBgTask));
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

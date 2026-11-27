import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
  const file = REGISTRY_FILE();
  if (existsSync(file) && reg && typeof reg === 'object' && reg.threads) {
    try {
      const disk = JSON.parse(readFileSync(file, 'utf8'));
      if (disk && typeof disk === 'object') {
        if (Number(disk.seq) > Number(reg.seq || 0)) {
          reg.seq = Number(disk.seq);
        }
        if (disk.coordinators && typeof disk.coordinators === 'object' && reg.coordinators) {
          for (const [ck, memC] of Object.entries(reg.coordinators)) {
            const diskC = disk.coordinators[ck];
            if (!diskC || !memC || diskC.conversationId !== memC.conversationId) continue;
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
          for (const [tid, memT] of Object.entries(reg.threads)) {
            const diskT = disk.threads[tid];
            if (!diskT || !memT) continue;

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

function runGit(args, cwd, timeout = 12000) {
  return new Promise((resolveOut, rejectOut) => {
    execFile(
      'git',
      args,
      { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          rejectOut(new Error((stderr || stdout || err.message).trim()));
        } else {
          resolveOut(stdout.trim());
        }
      },
    );
  });
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
    const porcelain = await runGit(['status', '--porcelain'], worktreePath, 5000);
    const dirtyLines = porcelain
      ? porcelain
          .split(/\r?\n/)
          .filter((l) => l.trim() && !l.includes('worker-thread-context.md'))
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
    if (baseRef && baseRef !== 'HEAD') {
      try {
        const cnt = await runGit(['rev-list', '--count', `${baseRef}..HEAD`], worktreePath, 5000);
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
  const sameConv = Boolean(existing && (!resolvedConvId || resolvedConvId === existing.conversationId));

  reg.coordinators[key] = {
    ...(sameConv && existing?.directiveVersion ? { directiveVersion: existing.directiveVersion } : {}),
    ...(sameConv && existing?.lastStepCount ? { lastStepCount: existing.lastStepCount } : {}),
    key,
    conversationId: resolvedConvId || existing?.conversationId || '',
    projectId: resolvedProjId,
    environmentId: resolvedEnvId,
    workspacePath: scope.info.workspacePath || scope.baseDir || existing?.workspacePath || '',
    repoRoot: repoRoot || existing?.repoRoot || '',
    defaultBranch: scope.info.currentBranch || existing?.defaultBranch || 'HEAD',
    groupId,
    title: coordTitle,
    memoryPath,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  saveRegistry(reg);
  return reg.coordinators[key];
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

  reg.seq = (reg.seq || 0) + 1;
  const threadId = `thr-${String(reg.seq).padStart(3, '0')}`;

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

  reg.threads[threadId] = threadRecord;
  saveRegistry(reg);
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
        if (!t.lastSummary || t.lastSyncedStepIndex !== liveAct.lastStepIndex) {
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
          seenRunningThreadIds.delete(t.threadId);
          pendingAutoSyncIds.push(t.threadId);
        }
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

  if (dirty) saveRegistry(reg);

  for (const tid of pendingAutoSyncIds) {
    try {
      await syncCompletionToCoordinator({ threadId: tid, force: false });
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

export async function archiveThread({ threadId, removeWorktree = false }) {
  const reg = loadRegistry();
  const t = reg.threads[threadId] || Object.values(reg.threads).find((x) => x.conversationId === threadId);
  if (!t) throw new Error(`Thread not found: ${threadId}`);

  try {
    await updateConversation(t.conversationId, { archived: true });
  } catch {
    // Ignore if already archived/deleted
  }

  let worktreeRemoved = false;
  let worktreeError = '';
  if (removeWorktree && t.worktreePath && t.repoRoot && existsSync(t.worktreePath)) {
    try {
      await runGit(['worktree', 'remove', t.worktreePath], t.repoRoot, 15000);
      worktreeRemoved = true;
    } catch (err) {
      worktreeError = err.message;
    }
  }

  t.archived = true;
  t.updatedAt = new Date().toISOString();
  saveRegistry(reg);
  return { thread: t, worktreeRemoved, worktreeError };
}

function invokeAgentApiSend({ conversationId, message, title, projectId }) {
  const exe = resolveAgentApiExe();
  const ep = resolveLsEndpoint();
  const args = exe === 'agentapi' ? ['send-message'] : ['agentapi', 'send-message'];
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

  return new Promise((resolveSend, rejectSend) => {
    let settled = false;
    const child = execFile(
      exe,
      args,
      { env, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(fastTimer);
        if (err) {
          rejectSend(new Error((stderr || stdout || err.message).trim()));
        } else {
          resolveSend({ queued: true, output: stdout.trim() });
        }
      },
    );

    // Resolve promptly once the CLI process starts cleanly so UI polling is never blocked
    const fastTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.unref?.();
        resolveSend({ queued: true, background: true });
      }
    }, 650);
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
  const pending = Array.isArray(t.pendingUserMessages) ? t.pendingUserMessages : [];
  pending.push({ id: `pm-${Date.now()}`, text, createdAt: now });
  t.pendingUserMessages = pending.slice(-8);
  t.runState = 'RUN_STATE_RUNNING';
  t.updatedAt = now;
  seenRunningThreadIds.add(t.threadId);
  saveRegistry(reg);

  return { ok: true, thread: t };
}

export async function syncCompletionToCoordinator({
  threadId,
  transcriptPath = '',
  force = false,
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

    let alreadyClaimed = false;
    for (const cp of claimPaths) {
      try {
        writeFileSync(cp, `${now}\n`, { flag: 'wx' });
        acquiredClaims.push(cp);
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          alreadyClaimed = true;
          break;
        }
        throw err;
      }
    }

    if (alreadyClaimed) {
      if (completion.stepIndex >= 0) {
        t.lastSyncedStepIndex = Math.max(
          Number.isInteger(t.lastSyncedStepIndex) ? t.lastSyncedStepIndex : -1,
          completion.stepIndex,
        );
      }
      if (!t.notifiedCoordinatorAt) t.notifiedCoordinatorAt = now;
      if (!t.pushedToCoordinatorAt) t.pushedToCoordinatorAt = now;
      saveRegistry(reg);
      return { ok: true, synced: false, reason: 'already_claimed', stepIndex: completion.stepIndex };
    }
  }

  if (t.worktreePath) {
    t.git = await inspectWorktreeGit(t.worktreePath, t.baseRef);
  }

  if (completion.cardSummary) t.lastSummary = completion.cardSummary;
  t.runState = 'RUN_STATE_IDLE';
  t.lastCompletedAt = now;
  t.updatedAt = now;
  t.notifiedCoordinatorAt = now;
  t.pushedToCoordinatorAt = now;
  if (completion.stepIndex >= 0) {
    t.lastSyncedStepIndex = completion.stepIndex;
  }
  // Persist deduplication stamp BEFORE calling agentapi so concurrent watchers never double-fire
  saveRegistry(reg);

  const gitMeta = t.branch
    ? `Isolated branch \`${t.branch}\`` +
      (t.git?.lastCommit ? ` | Latest commit: \`${t.git.lastCommit}\`` : '') +
      (t.git?.dirtyCount ? ` | Uncommitted files: ${t.git.dirtyCount}` : '')
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

  try {
    try {
      await invokeAgentApiSend({
        conversationId: targetCoordId,
        message: callbackMsg,
        title: msgTitle,
        projectId: coordProjId,
      });
    } catch (err) {
      if (coordProjId) {
        await invokeAgentApiSend({
          conversationId: targetCoordId,
          message: callbackMsg,
          title: msgTitle,
          projectId: '',
        });
      } else {
        throw err;
      }
    }
  } catch (sendErr) {
    for (const cp of acquiredClaims) {
      try {
        unlinkSync(cp);
      } catch {
        // Ignore cleanup errors
      }
    }
    throw sendErr;
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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { getCascadeModelCatalog, resolveLsEndpoint } from '../../lib/ls-client.mjs';
import {
  applyPluginUpdate,
  checkPluginUpdate,
  getPluginUpdateStatus,
} from '../../lib/updater.mjs';
import {
  archiveThread,
  cleanupThreadWorktree,
  dispatchThread,
  executeDecisionAction,
  getEffectiveSettings,
  getThreadMessages,
  initCoordinator,
  loadSettings,
  markThreadRead,
  readProjectMemory,
  resolveAppLocale,
  resolveProjectScope,
  saveSettingsWithFastResponse,
  sendThreadMessage,
  syncCompletionToCoordinator,
  syncThreads,
  updateProjectMemory,
} from '../../lib/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..', '..');
const SERVER_API_REVISION = 2;
const SERVER_CAPABILITIES = [
  'settings',
  'settings_save_fast',
  'update_status',
  'update_check',
  'update_apply',
  'decisions',
];
const app = new SidecarApp();

resolveLsEndpoint();

function readPluginManifestVersion() {
  try {
    const raw = readFileSync(join(PLUGIN_ROOT, 'plugin.json'), 'utf8');
    return String(JSON.parse(raw)?.version || '').trim();
  } catch {
    return '';
  }
}

function readStartupGitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: PLUGIN_ROOT,
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const STARTED_VERSION = readPluginManifestVersion();
const STARTED_GIT_SHA = readStartupGitSha();
const STARTED_AT = new Date().toISOString();

function buildServerInfo() {
  const diskVersion = readPluginManifestVersion();
  return {
    startedVersion: STARTED_VERSION,
    diskVersion: diskVersion || STARTED_VERSION,
    startedGitSha: STARTED_GIT_SHA,
    startedAt: STARTED_AT,
    apiRevision: SERVER_API_REVISION,
    capabilities: SERVER_CAPABILITIES,
    versionDrifted: Boolean(STARTED_VERSION && diskVersion && diskVersion !== STARTED_VERSION),
  };
}

function buildStaticHeaders() {
  return {
    'Cache-Control': 'no-store',
    'X-PT-Server-Version': STARTED_VERSION || 'unknown',
    'X-PT-Api-Revision': String(SERVER_API_REVISION),
  };
}

function readStaticAsset(filename, fallback = '') {
  const target = join(HERE, filename);
  if (!existsSync(target)) return fallback;
  try {
    return readFileSync(target, 'utf8');
  } catch {
    return fallback;
  }
}

function registerDualApi(basePath, handler) {
  app.api(basePath, handler, 'POST');
  app.api(basePath, handler, 'GET');
  app.api(`${basePath}_get`, handler, 'GET');
}

app.page('/', () =>
  new Response(readStaticAsset('index.html', '<!doctype html><title>Project Threads</title>'), {
    contentType: 'text/html; charset=utf-8',
    headers: buildStaticHeaders(),
  }),
);

app.page('/theme.css', () =>
  new Response(readStaticAsset('theme.css', '/* loading */'), {
    contentType: 'text/css; charset=utf-8',
    headers: buildStaticHeaders(),
  }),
);

app.page('/app.js', () =>
  new Response(readStaticAsset('app.js', '// loading'), {
    contentType: 'application/javascript; charset=utf-8',
    headers: buildStaticHeaders(),
  }),
);

app.api(
  '/api/state',
  async (data = {}) => {
    try {
      resolveLsEndpoint();
      const workspacePath = data.workspace || '';
      const conversationId = data.conversationId || '';
      const coordinatorId = data.coordinatorId || '';
      const projectId = data.projectId || '';
      const includeArchived = data.includeArchived === '1' || data.includeArchived === 'true';
      const allWorkspaces = data.allWorkspaces === '1' || data.allWorkspaces === 'true';
      const snap = await syncThreads({
        workspacePath,
        conversationId,
        coordinatorId,
        projectId,
        includeArchived,
        allWorkspaces,
      });
      return { ...snap, serverInfo: buildServerInfo() };
    } catch (err) {
      return {
        error: 'sync_failed',
        message: err.message,
        locale: resolveAppLocale(),
        serverInfo: buildServerInfo(),
      };
    }
  },
  'GET',
);

app.api(
  '/api/thread_messages',
  async (data = {}) => {
    try {
      return await getThreadMessages({
        threadId: data.threadId || '',
        clientStamp: data.stamp || '',
        markRead: data.markRead === '1' || data.markRead === 'true' || data.markRead === true,
      });
    } catch (err) {
      return { ok: false, error: err.message, locale: resolveAppLocale() };
    }
  },
  'GET',
);

async function handleModels(data = {}) {
  try {
    const forceRefresh = parseBool(data.refresh, false);
    const catalog = await getCascadeModelCatalog({ forceRefresh });
    return {
      ok: catalog.ok,
      models: catalog.models,
      defaultModelId: catalog.defaultModel?.id || '',
      defaultModelEnum: catalog.defaultModel?.modelEnum || '',
      error: catalog.error || '',
      locale: resolveAppLocale(),
    };
  } catch (err) {
    return {
      ok: false,
      models: [],
      defaultModelId: '',
      defaultModelEnum: '',
      error: err.message,
      locale: resolveAppLocale(),
    };
  }
}
registerDualApi('/api/models', handleModels);

async function handleThreadSend(data = {}) {
  try {
    let parsedModelOrAlias = data.modelOrAlias || null;
    if (typeof parsedModelOrAlias === 'string') {
      try {
        parsedModelOrAlias = JSON.parse(parsedModelOrAlias);
      } catch {
        parsedModelOrAlias = null;
      }
    }
    const res = await sendThreadMessage({
      threadId: data.threadId || '',
      message: data.message || '',
      model: data.model || '',
      modelEnum: data.modelEnum || '',
      modelOrAlias: parsedModelOrAlias,
      modelDisplayName: data.modelDisplayName || '',
    });
    return { ...res, locale: resolveAppLocale() };
  } catch (err) {
    return { ok: false, error: err.message, locale: resolveAppLocale() };
  }
}
registerDualApi('/api/thread_send', handleThreadSend);

async function handleThreadSyncCoord(data = {}) {
  try {
    const res = await syncCompletionToCoordinator({
      threadId: data.threadId || '',
      force: true,
    });
    return { ...res, locale: resolveAppLocale() };
  } catch (err) {
    return { ok: false, error: err.message, locale: resolveAppLocale() };
  }
}
registerDualApi('/api/thread_sync_coord', handleThreadSyncCoord);

async function handleThreadMarkRead(data = {}) {
  try {
    return await markThreadRead({
      threadId: data.threadId || '',
    });
  } catch (err) {
    return { ok: false, error: err.message, locale: resolveAppLocale() };
  }
}
registerDualApi('/api/thread_mark_read', handleThreadMarkRead);

async function handleInit(data = {}) {
  try {
    const coord = await initCoordinator({
      workspacePath: data.workspace || '',
      conversationId: data.conversationId || '',
      coordinatorId: data.coordinatorId || '',
      projectId: data.projectId || '',
      title: data.title || '',
    });
    return { ok: true, locale: resolveAppLocale(), coordinator: coord };
  } catch (err) {
    return { ok: false, error: err.message, locale: resolveAppLocale() };
  }
}
registerDualApi('/api/init', handleInit);

async function handleDispatch(data = {}) {
  try {
    const thread = await dispatchThread({
      workspacePath: data.workspace || '',
      coordinatorId: data.coordinatorId || data.conversationId || '',
      conversationId: data.conversationId || '',
      projectId: data.projectId || '',
      title: data.title || '',
      taskPrompt: data.taskPrompt || '',
      branch: data.branch || '',
      baseRef: data.baseRef || '',
      worktreePath: data.worktreePath || '',
      model: data.model || '',
      createWorktree: data.createWorktree !== false && data.createWorktree !== 'false' && data.createWorktree !== '0',
    });
    return { ok: true, locale: resolveAppLocale(), thread };
  } catch (err) {
    return { ok: false, error: err.message, locale: resolveAppLocale() };
  }
}
registerDualApi('/api/dispatch', handleDispatch);

function parseBool(val, defaultVal = false) {
  if (val === undefined || val === null || val === '') return defaultVal;
  if (typeof val === 'boolean') return val;
  const s = String(val).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return defaultVal;
}

async function handleArchive(data = {}) {
  try {
    const res = await archiveThread(data.threadId || '', {
      removeWorktree: parseBool(data.removeWorktree, true),
      forceWorktree: parseBool(data.forceWorktree, false),
      deleteBranch: parseBool(data.deleteBranch, true),
    });
    return { ok: true, locale: resolveAppLocale(), ...res };
  } catch (err) {
    return { ok: false, error: err.message, locale: resolveAppLocale() };
  }
}
registerDualApi('/api/archive', handleArchive);

async function handleCleanupWorktree(data = {}) {
  try {
    const res = await cleanupThreadWorktree(data.threadId || '', {
      forceWorktree: parseBool(data.forceWorktree, false),
      deleteBranch: parseBool(data.deleteBranch, true),
    });
    return { locale: resolveAppLocale(), ...res };
  } catch (err) {
    return { ok: false, error: err.message, locale: resolveAppLocale() };
  }
}
registerDualApi('/api/cleanup_worktree', handleCleanupWorktree);

async function handleDecisionAction(data = {}) {
  try {
    const res = await executeDecisionAction({
      decisionId: data.decisionId || '',
      optionId: data.optionId || '',
      action: data.action || '',
      threadId: data.threadId || '',
      autoKind: data.autoKind || '',
      lastCommit: data.lastCommit || '',
      message: data.message || '',
      label: data.label || '',
      title: data.title || '',
      workspacePath: data.workspacePath || data.workspace || '',
      conversationId: data.conversationId || '',
      coordinatorId: data.coordinatorId || '',
      projectId: data.projectId || '',
    });
    return { ...res, locale: resolveAppLocale() };
  } catch (err) {
    return { ok: false, error: err.message, locale: resolveAppLocale() };
  }
}
registerDualApi('/api/decision_action', handleDecisionAction);

app.api(
  '/api/memory',
  async (data = {}) => {
    try {
      const scope = await resolveProjectScope({
        workspacePath: data.workspace || '',
        conversationId: data.conversationId || '',
        coordinatorId: data.coordinatorId || '',
        projectId: data.projectId || '',
      });
      const mem = scope.scopeKey
        ? readProjectMemory(scope.baseDir, scope.scopeKey)
        : { path: '', content: '' };
      return {
        ok: true,
        locale: resolveAppLocale(),
        scopeKey: scope.scopeKey,
        ...mem,
      };
    } catch (err) {
      return { ok: false, error: err.message, locale: resolveAppLocale() };
    }
  },
  'GET',
);

async function handleSaveMemory(data = {}) {
  try {
    const res = await updateProjectMemory({
      workspacePath: data.workspace || '',
      conversationId: data.conversationId || '',
      coordinatorId: data.coordinatorId || '',
      projectId: data.projectId || '',
      content: data.content || '',
      mode: data.mode || 'replace',
      section: data.section || 'Active Decisions & Constraints',
    });
    return { ok: true, locale: resolveAppLocale(), ...res };
  } catch (err) {
    return { ok: false, error: err.message, locale: resolveAppLocale() };
  }
}
registerDualApi('/api/memory_save', handleSaveMemory);

function buildSettingsScopeOpts(data = {}) {
  return {
    workspacePath: data.workspacePath || data.workspace || '',
    conversationId: data.conversationId || '',
    coordinatorId: data.coordinatorId || '',
    projectId: data.projectId || '',
  };
}

async function resolveSettingsScopeKey(data = {}) {
  const explicitKey = String(data.workspaceKey || '').trim();
  if (explicitKey) return explicitKey;
  const scope = await resolveProjectScope(buildSettingsScopeOpts(data));
  return scope.scopeKey || '';
}

async function handleSettings(data = {}) {
  try {
    const scopeOpts = buildSettingsScopeOpts(data);
    const scopeKey = await resolveSettingsScopeKey(data);
    const forceRefresh = parseBool(data.refresh, false);
    const settings = loadSettings();
    const effective = await getEffectiveSettings({
      ...scopeOpts,
      workspaceKey: scopeKey,
      forceRefresh,
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
      serverInfo: buildServerInfo(),
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      locale: resolveAppLocale(),
      serverInfo: buildServerInfo(),
    };
  }
}
registerDualApi('/api/settings', handleSettings);

async function handleSaveSettings(data = {}) {
  try {
    const res = await saveSettingsWithFastResponse(data);
    return { ...res, serverInfo: buildServerInfo() };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      locale: resolveAppLocale(),
      serverInfo: buildServerInfo(),
    };
  }
}
registerDualApi('/api/settings_save', handleSaveSettings);

async function handleUpdateStatus(data = {}) {
  try {
    const status = await getPluginUpdateStatus({
      channel: data.channel || '',
      backgroundRefresh: parseBool(data.bg, true),
    });
    return { ...status, locale: resolveAppLocale(), serverInfo: buildServerInfo() };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      locale: resolveAppLocale(),
      serverInfo: buildServerInfo(),
    };
  }
}
registerDualApi('/api/update_status', handleUpdateStatus);

async function handleUpdateCheck(data = {}) {
  try {
    const status = await checkPluginUpdate({
      channel: data.channel || '',
      force: parseBool(data.force, true),
      persistChannel: parseBool(data.persistChannel, true),
    });
    return { ...status, locale: resolveAppLocale(), serverInfo: buildServerInfo() };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      locale: resolveAppLocale(),
      serverInfo: buildServerInfo(),
    };
  }
}
registerDualApi('/api/update_check', handleUpdateCheck);

async function handleUpdateApply(data = {}) {
  try {
    const res = await applyPluginUpdate({
      channel: data.channel || '',
      persistChannel: parseBool(data.persistChannel, true),
    });
    return { ...res, locale: resolveAppLocale(), serverInfo: buildServerInfo() };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      locale: resolveAppLocale(),
      serverInfo: buildServerInfo(),
    };
  }
}
registerDualApi('/api/update_apply', handleUpdateApply);

// Background watcher: ensures thread completions sync back to Coordinator even when side panel is collapsed
setInterval(() => {
  syncThreads({ allWorkspaces: true }).catch(() => {});
}, 3500);

app.run();

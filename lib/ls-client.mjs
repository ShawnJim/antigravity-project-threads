import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function getStateDir() {
  const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
  const dir = join(geminiDir, 'antigravity', 'project-threads');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const ENDPOINT_CACHE_PATH = () => join(getStateDir(), 'ls-endpoint.json');

export function resolveLsEndpoint() {
  const envAddr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const envCsrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  const envAgentApi = (process.env.ANTIGRAVITY_AGENTAPI_EXE || '').trim();

  let cached = null;
  try {
    cached = JSON.parse(readFileSync(ENDPOINT_CACHE_PATH(), 'utf8'));
  } catch {
    cached = null;
  }

  const agentApiExe = envAgentApi || cached?.agentApiExe || '';
  if (envAddr && envCsrf) {
    try {
      writeFileSync(
        ENDPOINT_CACHE_PATH(),
        JSON.stringify({
          address: envAddr,
          csrfToken: envCsrf,
          agentApiExe,
          updatedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
    } catch {
      // Ignore cache write errors
    }
    return { address: envAddr, csrfToken: envCsrf, agentApiExe };
  }

  if (cached?.address && cached?.csrfToken) {
    return {
      address: cached.address,
      csrfToken: cached.csrfToken,
      agentApiExe: cached.agentApiExe || '',
    };
  }
  return null;
}

function parseAgentApiShimTarget() {
  const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
  const binDir = join(geminiDir, 'antigravity', 'bin');
  const shimCandidates =
    process.platform === 'win32'
      ? [join(binDir, 'agentapi.bat'), join(binDir, 'agentapi.cmd')]
      : [join(binDir, 'agentapi')];
  for (const shim of shimCandidates) {
    if (!existsSync(shim)) continue;
    try {
      const content = readFileSync(shim, 'utf8');
      const quoted = content.match(/"([^"]+language_server(?:\.exe)?)"/i);
      if (quoted?.[1] && existsSync(quoted[1])) return quoted[1];
      const bare = content.match(/([^\s"']+language_server(?:\.exe)?)/i);
      if (bare?.[1] && existsSync(bare[1])) return bare[1];
    } catch {
      // Ignore shim read errors
    }
  }
  return '';
}

export function resolveAgentApiExe() {
  const envExe = (process.env.ANTIGRAVITY_AGENTAPI_EXE || '').trim();
  if (envExe && existsSync(envExe)) return envExe;
  const ep = resolveLsEndpoint();
  if (ep?.agentApiExe && existsSync(ep.agentApiExe)) return ep.agentApiExe;

  const fromShim = parseAgentApiShimTarget();
  if (fromShim) return fromShim;

  // When running under Antigravity's bundled agy-node (ELECTRON_RUN_AS_NODE=1 Antigravity.exe),
  // language_server lives right inside <installDir>/resources/bin/ regardless of install drive.
  if (process.execPath) {
    const execDir = dirname(process.execPath);
    const bundledCandidates =
      process.platform === 'win32'
        ? [join(execDir, 'resources', 'bin', 'language_server.exe')]
        : process.platform === 'darwin'
          ? [
              join(execDir, '..', 'Resources', 'bin', 'language_server'),
              join(execDir, 'resources', 'bin', 'language_server'),
            ]
          : [join(execDir, 'resources', 'bin', 'language_server')];
    for (const c of bundledCandidates) {
      if (existsSync(c)) return c;
    }
  }

  if (process.platform === 'win32') {
    const winCandidates = [
      join(
        process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
        'Programs',
        'antigravity',
        'resources',
        'bin',
        'language_server.exe',
      ),
      process.env.ProgramFiles
        ? join(process.env.ProgramFiles, 'Antigravity', 'resources', 'bin', 'language_server.exe')
        : '',
    ].filter(Boolean);
    for (const c of winCandidates) {
      if (existsSync(c)) return c;
    }
  }
  return 'agentapi';
}

export function connectPost(service, method, body = {}, timeoutMs = 8000) {
  const ep = resolveLsEndpoint();
  if (!ep) {
    return Promise.reject(
      new Error('ANTIGRAVITY_LS_ADDRESS / ANTIGRAVITY_CSRF_TOKEN not available yet. Run inside an active Antigravity session.'),
    );
  }
  const urlStr = ep.address.startsWith('http') ? ep.address : `http://${ep.address}`;
  const base = new URL(urlStr);
  const payload = JSON.stringify(body);
  const transport = base.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: base.hostname,
        port: base.port,
        path: `/${service}/${method}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-antigravity-csrf-token': ep.csrfToken,
          'x-codeium-csrf-token': ep.csrfToken,
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
        rejectUnauthorized: false,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`${service}/${method} failed (HTTP ${res.statusCode}): ${text.slice(0, 300)}`));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (err) {
            reject(new Error(`${service}/${method} invalid JSON: ${err.message}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${service}/${method} timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(payload);
  });
}

const CONV_SVC = 'product.v1.ConversationService';
const LS_SVC = 'exa.language_server_pb.LanguageServerService';
const MODEL_CONFIG_TTL_MS = 5 * 60_000;
const MODEL_CONFIG_FAIL_TTL_MS = 15_000;

let modelConfigCache = { expiresAt: 0, lookup: null };

export async function createConversation({ projectId, environmentId, title, model, tags, promptText }) {
  const buildBody = (includeProject) => {
    const body = {};
    if (includeProject && projectId && projectId !== 'outside-of-project') {
      body.projectId = projectId;
      if (environmentId) body.environmentId = environmentId;
    }
    if (title) body.title = title;
    if (model) body.model = model;
    if (Array.isArray(tags) && tags.length > 0) body.tags = tags;
    if (promptText) body.prompt = [{ text: promptText }];
    return body;
  };

  try {
    const res = await connectPost(CONV_SVC, 'CreateConversation', buildBody(true), 15000);
    return res.conversation || res;
  } catch (err) {
    if (projectId && projectId !== 'outside-of-project') {
      const retryRes = await connectPost(CONV_SVC, 'CreateConversation', buildBody(false), 15000);
      return retryRes.conversation || retryRes;
    }
    throw err;
  }
}

export async function getConversation(conversationId) {
  return connectPost(CONV_SVC, 'GetConversation', { conversationId }, 6000);
}

export async function listConversations(params = {}) {
  return connectPost(CONV_SVC, 'ListConversations', params, 8000);
}

export async function updateConversation(conversationId, annotations) {
  return connectPost(CONV_SVC, 'UpdateConversation', { conversationId, annotations }, 6000);
}

export async function deleteConversation(conversationId) {
  return connectPost(CONV_SVC, 'DeleteConversation', { conversationId }, 6000);
}

/**
 * Extracts the latest concrete model metadata from GetCascadeTrajectoryGeneratorMetadata output.
 * Walks backwards so mid-thread model switches win while non-chat generator entries are skipped.
 */
export function extractModelInfoFromGeneratorMetadata(res) {
  const list = Array.isArray(res?.generatorMetadata) ? res.generatorMetadata : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const chat = list[i]?.chatModel;
    if (!chat || typeof chat !== 'object') continue;
    const displayName = String(chat.modelDisplayName || '').trim();
    const responseModel = String(chat.responseModel || '').trim();
    const modelEnum = String(
      chat.model || chat.usage?.model || chat.customMetadata?.model_enum || '',
    ).trim();
    if (displayName || responseModel || modelEnum) {
      return { displayName, responseModel, modelEnum };
    }
  }
  return null;
}

export async function getCascadeTrajectoryGeneratorMetadata(cascadeId, timeoutMs = 4000) {
  if (!cascadeId) return { generatorMetadata: [] };
  return connectPost(
    LS_SVC,
    'GetCascadeTrajectoryGeneratorMetadata',
    { cascadeId },
    timeoutMs,
  );
}

/**
 * Safely fetches the latest generator model metadata for a conversation without throwing on
 * offline/busy LS instances. Distinguishes `{ ok: true }` from `{ ok: false }` for caching.
 */
export async function getThreadGeneratorModel(cascadeId, timeoutMs = 4000) {
  if (!cascadeId) return { ok: false, info: null };
  try {
    const res = await getCascadeTrajectoryGeneratorMetadata(cascadeId, timeoutMs);
    return { ok: true, info: extractModelInfoFromGeneratorMetadata(res) };
  } catch {
    return { ok: false, info: null };
  }
}

/** Builds an enum/modelId -> label lookup from GetCascadeModelConfigData output. */
export function buildModelConfigLookup(data) {
  const byEnum = new Map();
  const byId = new Map();
  const configs = Array.isArray(data?.clientModelConfigs) ? data.clientModelConfigs : [];
  for (const cfg of configs) {
    const label = String(cfg?.label || '').trim();
    if (!label) continue;
    const modelEnum = String(cfg?.modelOrAlias?.model || '').trim();
    if (modelEnum) byEnum.set(modelEnum, label);
    const modelId = String(cfg?.modelId || '').trim().toLowerCase();
    if (modelId) {
      byId.set(modelId, label);
      byId.set(modelId.replace(/-tiered-/g, '-'), label);
    }
  }
  return { byEnum, byId };
}

/** Resolves a model enum or slug against a prebuilt GetCascadeModelConfigData lookup. */
export function resolveModelLabelFromLookup(rawModel, lookup) {
  const raw = String(rawModel || '').trim();
  if (!raw || !lookup) return '';
  if (lookup.byEnum?.has(raw)) return lookup.byEnum.get(raw);
  const lower = raw.toLowerCase();
  if (lookup.byId?.has(lower)) return lookup.byId.get(lower);
  const untiered = lower.replace(/-tiered-/g, '-');
  if (lookup.byId?.has(untiered)) return lookup.byId.get(untiered);
  return '';
}

export async function getModelConfigLookup({ timeoutMs = 3000, allowCachedOnly = false } = {}) {
  const nowMs = Date.now();
  if (modelConfigCache.lookup && modelConfigCache.expiresAt > nowMs) {
    return modelConfigCache.lookup;
  }
  if (allowCachedOnly) return modelConfigCache.lookup || null;
  try {
    const res = await connectPost(LS_SVC, 'GetCascadeModelConfigData', {}, timeoutMs);
    const lookup = buildModelConfigLookup(res);
    modelConfigCache = { expiresAt: nowMs + MODEL_CONFIG_TTL_MS, lookup };
    return lookup;
  } catch {
    const empty = modelConfigCache.lookup || { byEnum: new Map(), byId: new Map() };
    modelConfigCache = { expiresAt: nowMs + MODEL_CONFIG_FAIL_TTL_MS, lookup: empty };
    return empty;
  }
}

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

function getAppDataDir(env = process.env, homeDir = homedir()) {
  const geminiDir = (env.ANTIGRAVITY_GEMINI_DIR || '').trim();
  const appDataEnv = (env.ANTIGRAVITY_APP_DATA_DIR || '').trim();
  if (geminiDir) {
    const derived = join(geminiDir, 'antigravity');
    if (appDataEnv && appDataEnv.startsWith(geminiDir)) return appDataEnv;
    return derived;
  }
  return appDataEnv || join(homeDir, '.gemini', 'antigravity');
}

export function getStateDir() {
  const dir = join(getAppDataDir(), 'project-threads');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const ENDPOINT_CACHE_PATH = () => join(getStateDir(), 'ls-endpoint.json');

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function extractPortFromAddress(address) {
  const m = String(address || '').match(/:(\d+)(?:\/|$)/);
  return m ? Number(m[1]) : 0;
}

function discoverDaemonHubEndpoints(appDataDir = getAppDataDir()) {
  const daemonDir = join(appDataDir, 'daemon');
  if (!existsSync(daemonDir)) return [];
  let entries;
  try {
    entries = readdirSync(daemonDir);
  } catch {
    return [];
  }

  const hubs = [];
  for (const name of entries) {
    if (!/^hub_.*\.json$/i.test(name)) continue;
    const fullPath = join(daemonDir, name);
    try {
      const st = statSync(fullPath);
      if (!st.isFile()) continue;
      const parsed = JSON.parse(readFileSync(fullPath, 'utf8'));
      const csrfToken = String(parsed?.csrfToken || '').trim();
      const httpPort = Number(parsed?.httpPort) || 0;
      const httpsPort = Number(parsed?.httpsPort) || 0;
      if (!csrfToken || (!httpPort && !httpsPort)) continue;

      const pid = Number(parsed?.pid);
      const alive = Number.isInteger(pid) && pid > 0 ? isProcessAlive(pid) : null;
      const address = httpPort ? `127.0.0.1:${httpPort}` : `https://127.0.0.1:${httpsPort}`;
      const ports = [httpPort, httpsPort].filter(Boolean);
      hubs.push({
        file: fullPath,
        address,
        csrfToken,
        httpPort,
        httpsPort,
        ports,
        pid: Number.isInteger(pid) ? pid : 0,
        alive,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      // Ignore unreadable or malformed hub JSON files
    }
  }

  hubs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return hubs;
}

export function resolveLsEndpoint() {
  const envAddr = (process.env.ANTIGRAVITY_LS_ADDRESS || '').trim();
  const envCsrf = (process.env.ANTIGRAVITY_CSRF_TOKEN || '').trim();
  const envAgentApi = (process.env.ANTIGRAVITY_AGENTAPI_EXE || '').trim();

  const cachePath = ENDPOINT_CACHE_PATH();
  let cached = null;
  let cachedStatMtimeMs = 0;
  try {
    cachedStatMtimeMs = statSync(cachePath).mtimeMs;
    cached = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch {
    cached = null;
  }

  const agentApiExe = envAgentApi || cached?.agentApiExe || '';
  if (envAddr && envCsrf) {
    try {
      writeFileSync(
        cachePath,
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

  const hubs = discoverDaemonHubEndpoints();
  const liveHubs = hubs.filter((h) => h.alive === true);
  const unknownPidHubs = hubs.filter((h) => h.alive === null);
  const bestHub = liveHubs[0] || unknownPidHubs[0] || null;
  const fallbackExe =
    envAgentApi || (cached?.agentApiExe && existsSync(cached.agentApiExe) ? cached.agentApiExe : '');

  if (cached?.address && cached?.csrfToken) {
    const cachedPort = extractPortFromAddress(cached.address);
    const cachedUpdatedMs = Date.parse(cached.updatedAt || '');
    const cachedTimeMs = Number.isFinite(cachedUpdatedMs) ? cachedUpdatedMs : cachedStatMtimeMs;

    const cachedMatchesLive =
      cachedPort > 0 &&
      (liveHubs.some((h) => h.ports.includes(cachedPort)) ||
        unknownPidHubs.some((h) => h.ports.includes(cachedPort)));
    const cachedMatchesDead =
      cachedPort > 0 &&
      !cachedMatchesLive &&
      hubs.some((h) => h.alive === false && h.ports.includes(cachedPort));
    const supersededByNewerLive =
      Boolean(bestHub) &&
      !cachedMatchesLive &&
      bestHub.mtimeMs > cachedTimeMs;

    if (cachedMatchesDead || supersededByNewerLive) {
      if (bestHub) {
        return {
          address: bestHub.address,
          csrfToken: bestHub.csrfToken,
          agentApiExe: fallbackExe,
        };
      }
      return null;
    }

    return {
      address: cached.address,
      csrfToken: cached.csrfToken,
      agentApiExe: envAgentApi || cached.agentApiExe || '',
    };
  }

  if (bestHub) {
    return {
      address: bestHub.address,
      csrfToken: bestHub.csrfToken,
      agentApiExe: fallbackExe,
    };
  }

  return null;
}

function isRegularFile(filePath) {
  if (!filePath || !existsSync(filePath)) return false;
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getShimCandidates(binDir, platform) {
  if (platform === 'win32') {
    return [
      join(binDir, 'agentapi.exe'),
      join(binDir, 'agentapi.cmd'),
      join(binDir, 'agentapi.bat'),
      join(binDir, 'agentapi'),
    ];
  }
  return [join(binDir, 'agentapi')];
}

function parseAgentApiShimTarget(binDir, platform = process.platform) {
  for (const shim of getShimCandidates(binDir, platform)) {
    if (!isRegularFile(shim) || /\.exe$/i.test(shim)) continue;
    try {
      const content = readFileSync(shim, 'utf8');
      const patterns = [
        /"([^"\r\n]*language_server(?:[._-][a-z0-9_-]+)?(?:\.exe)?)"/i,
        /'([^'\r\n]*language_server(?:[._-][a-z0-9_-]+)?(?:\.exe)?)'/i,
        /([^\s"'`]*language_server(?:[._-][a-z0-9_-]+)?(?:\.exe)?)/i,
      ];
      for (const re of patterns) {
        const m = content.match(re);
        if (m?.[1] && isRegularFile(m[1])) return m[1];
      }
    } catch {
      // Ignore shim read errors
    }
  }
  return '';
}

function getPreferredLanguageServerNames(platform, arch) {
  if (platform === 'win32') {
    if (arch === 'arm64') {
      return [
        'language_server_windows_arm64.exe',
        'language_server_win32_arm64.exe',
        'language_server-arm64.exe',
        'language_server.exe',
        'language_server_windows_x64.exe',
        'language_server_win32_x64.exe',
      ];
    }
    return [
      'language_server.exe',
      'language_server_windows_x64.exe',
      'language_server_win32_x64.exe',
      'language_server-x64.exe',
      'language_server_windows_arm64.exe',
    ];
  }

  if (platform === 'darwin') {
    if (arch === 'arm64') {
      return [
        'language_server_macos_arm',
        'language_server_macos_arm64',
        'language_server_darwin_arm64',
        'language_server-darwin-arm64',
        'language_server',
        'language_server_macos_x64',
        'language_server_darwin_x64',
      ];
    }
    return [
      'language_server_macos_x64',
      'language_server_darwin_x64',
      'language_server-darwin-x64',
      'language_server',
      'language_server_macos_arm',
      'language_server_macos_arm64',
    ];
  }

  if (arch === 'arm64') {
    return [
      'language_server_linux_arm64',
      'language_server_linux_arm',
      'language_server-linux-arm64',
      'language_server',
      'language_server_linux_x64',
    ];
  }
  return [
    'language_server_linux_x64',
    'language_server-linux-x64',
    'language_server',
    'language_server_linux_arm64',
  ];
}

function findLanguageServerInDir(binDir, { platform = process.platform, arch = process.arch } = {}) {
  if (!binDir || !existsSync(binDir)) return '';
  for (const name of getPreferredLanguageServerNames(platform, arch)) {
    const candidate = join(binDir, name);
    if (isRegularFile(candidate)) return candidate;
  }
  try {
    const entries = readdirSync(binDir);
    const matches = entries
      .filter(
        (name) =>
          /^language_server(?:[._-][a-z0-9_-]+)?(?:\.exe)?$/i.test(name) &&
          !/\.(?:pdb|map|sig|txt|json|md)$/i.test(name) &&
          (platform !== 'win32' || /\.exe$/i.test(name)),
      )
      .sort();
    for (const name of matches) {
      const candidate = join(binDir, name);
      if (isRegularFile(candidate)) return candidate;
    }
  } catch {
    // Ignore directory read errors
  }
  return '';
}

function getStandardInstallBinDirs({ platform, env, homeDir }) {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || join(homeDir, 'AppData', 'Local');
    return [
      join(localAppData, 'Programs', 'antigravity', 'resources', 'bin'),
      join(localAppData, 'Programs', 'Antigravity', 'resources', 'bin'),
      env.ProgramFiles ? join(env.ProgramFiles, 'Antigravity', 'resources', 'bin') : '',
      env['ProgramFiles(x86)']
        ? join(env['ProgramFiles(x86)'], 'Antigravity', 'resources', 'bin')
        : '',
    ].filter(Boolean);
  }

  if (platform === 'darwin') {
    return [
      '/Applications/Antigravity.app/Contents/Resources/bin',
      join(homeDir, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'bin'),
    ];
  }

  return [
    '/usr/share/antigravity/resources/bin',
    '/usr/lib/antigravity/resources/bin',
    '/opt/antigravity/resources/bin',
    '/opt/Antigravity/resources/bin',
    join(homeDir, '.local', 'share', 'antigravity', 'resources', 'bin'),
    join(homeDir, '.local', 'share', 'Antigravity', 'resources', 'bin'),
    '/snap/antigravity/current/usr/share/antigravity/resources/bin',
  ];
}

export function resolveAgentApiExe(options = {}) {
  const {
    platform = process.platform,
    arch = process.arch,
    execPath = process.execPath,
    env = process.env,
    homeDir = homedir(),
    appDataDir = getAppDataDir(env, homeDir),
    installDirs = null,
  } = options;

  const envExe = (env.ANTIGRAVITY_AGENTAPI_EXE || '').trim();
  if (envExe && isRegularFile(envExe)) return envExe;

  const usingDefaultEnv = env === process.env && !options.appDataDir && !options.geminiDir;
  if (usingDefaultEnv) {
    const ep = resolveLsEndpoint();
    if (ep?.agentApiExe && isRegularFile(ep.agentApiExe)) return ep.agentApiExe;
  }

  const binDir = join(appDataDir, 'bin');
  const fromShimTarget = parseAgentApiShimTarget(binDir, platform);
  if (fromShimTarget) return fromShimTarget;

  for (const shim of getShimCandidates(binDir, platform)) {
    if (isRegularFile(shim)) return shim;
  }

  // When running under Antigravity's bundled agy-node (ELECTRON_RUN_AS_NODE=1 Antigravity),
  // language_server lives right inside <installDir>/resources/bin/ regardless of install drive.
  if (execPath) {
    const execDir = dirname(execPath);
    const bundledDirs =
      platform === 'darwin'
        ? [join(execDir, '..', 'Resources', 'bin'), join(execDir, 'resources', 'bin')]
        : [join(execDir, 'resources', 'bin')];
    for (const dir of bundledDirs) {
      const found = findLanguageServerInDir(dir, { platform, arch });
      if (found) return found;
    }
  }

  const candidateDirs = Array.isArray(installDirs)
    ? installDirs
    : getStandardInstallBinDirs({ platform, env, homeDir });
  for (const dir of candidateDirs) {
    const found = findLanguageServerInDir(dir, { platform, arch });
    if (found) return found;
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

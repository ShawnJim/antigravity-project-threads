import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export function getGeminiDir(env = process.env, homeDir = homedir()) {
  const geminiDir = (env.ANTIGRAVITY_GEMINI_DIR || '').trim();
  if (geminiDir) return geminiDir;
  const appDataEnv = (env.ANTIGRAVITY_APP_DATA_DIR || '').trim();
  if (appDataEnv) {
    const base = basename(appDataEnv).toLowerCase();
    if (base === 'antigravity') return dirname(appDataEnv);
    return appDataEnv;
  }
  return join(homeDir, '.gemini');
}

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
const LS_ENDPOINT_MEM_TTL_MS = 2000;
let lsEndpointMemCache = {
  sig: '',
  expiresAt: 0,
  writtenEnvSig: '',
  endpoint: null,
};

export function resetLsEndpointCache() {
  lsEndpointMemCache = {
    sig: '',
    expiresAt: 0,
    writtenEnvSig: '',
    endpoint: null,
  };
}

function safeEndpointFileStamp(p) {
  try {
    const st = statSync(p);
    return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

function safeDaemonDirStamp(daemonDir) {
  try {
    const st = statSync(daemonDir);
    if (!st.isDirectory()) return '-';
    return `${st.mtimeMs}:${st.ctimeMs}`;
  } catch {
    return '-';
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
  const appDataDir = getAppDataDir();
  const cachePath = ENDPOINT_CACHE_PATH();
  const daemonDir = join(appDataDir, 'daemon');
  const nowMs = Date.now();
  const cacheStamp = safeEndpointFileStamp(cachePath);
  const daemonStamp = envAddr && envCsrf ? '-' : safeDaemonDirStamp(daemonDir);
  const memSig = `${appDataDir}|${envAddr}|${envCsrf}|${envAgentApi}|${cacheStamp}|${daemonStamp}`;

  if (lsEndpointMemCache.sig === memSig && lsEndpointMemCache.expiresAt > nowMs) {
    return lsEndpointMemCache.endpoint ? { ...lsEndpointMemCache.endpoint } : null;
  }

  const storeMemCache = (endpoint, writtenEnvSig = lsEndpointMemCache.writtenEnvSig) => {
    const refreshedCacheStamp = safeEndpointFileStamp(cachePath);
    const refreshedDaemonStamp = envAddr && envCsrf ? '-' : safeDaemonDirStamp(daemonDir);
    const finalSig = `${appDataDir}|${envAddr}|${envCsrf}|${envAgentApi}|${refreshedCacheStamp}|${refreshedDaemonStamp}`;
    lsEndpointMemCache = {
      sig: finalSig,
      expiresAt: Date.now() + LS_ENDPOINT_MEM_TTL_MS,
      writtenEnvSig,
      endpoint: endpoint ? { ...endpoint } : null,
    };
    return endpoint ? { ...endpoint } : null;
  };

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
    const envWriteSig = `${cachePath}|${envAddr}|${envCsrf}|${agentApiExe}`;
    if (lsEndpointMemCache.writtenEnvSig !== envWriteSig || cacheStamp === '-') {
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
    }
    return storeMemCache({ address: envAddr, csrfToken: envCsrf, agentApiExe }, envWriteSig);
  }

  const hubs = discoverDaemonHubEndpoints(appDataDir);
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
        return storeMemCache({
          address: bestHub.address,
          csrfToken: bestHub.csrfToken,
          agentApiExe: fallbackExe,
        });
      }
      return storeMemCache(null);
    }

    return storeMemCache({
      address: cached.address,
      csrfToken: cached.csrfToken,
      agentApiExe: envAgentApi || cached.agentApiExe || '',
    });
  }

  if (bestHub) {
    return storeMemCache({
      address: bestHub.address,
      csrfToken: bestHub.csrfToken,
      agentApiExe: fallbackExe,
    });
  }

  return storeMemCache(null);
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

export function resolveAgentApiShimTargetFile(shimPath) {
  const filePath = String(shimPath || '').trim();
  if (!filePath || !isRegularFile(filePath) || /\.exe$/i.test(filePath)) return '';
  try {
    const content = readFileSync(filePath, 'utf8');
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
  return '';
}

function parseAgentApiShimTarget(binDir, platform = process.platform) {
  for (const shim of getShimCandidates(binDir, platform)) {
    const target = resolveAgentApiShimTargetFile(shim);
    if (target) return target;
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
  const effectiveTimeoutMs = Math.max(50, Number(timeoutMs) || 8000);

  return new Promise((resolve, reject) => {
    let settled = false;
    let gotResponse = false;
    let hardTimer = null;

    const clearHardTimer = () => {
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
    };
    const finishResolve = (val) => {
      if (settled) return;
      settled = true;
      clearHardTimer();
      resolve(val);
    };
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      clearHardTimer();
      reject(err instanceof Error ? err : new Error(String(err || `${service}/${method} failed`)));
    };

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
        timeout: effectiveTimeoutMs,
        rejectUnauthorized: false,
      },
      (res) => {
        gotResponse = true;
        let ended = false;
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          ended = true;
          if (res.statusCode < 200 || res.statusCode >= 300) {
            finishReject(new Error(`${service}/${method} failed (HTTP ${res.statusCode}): ${text.slice(0, 300)}`));
            return;
          }
          try {
            finishResolve(text ? JSON.parse(text) : {});
          } catch (err) {
            finishReject(new Error(`${service}/${method} invalid JSON: ${err.message}`));
          }
        });
        res.on('error', (err) => {
          finishReject(err || new Error(`${service}/${method} response stream error`));
        });
        res.on('aborted', () => {
          if (!ended) {
            const err = new Error(`${service}/${method} response aborted prematurely`);
            err.code = 'ECONNRESET';
            finishReject(err);
          }
        });
        res.on('close', () => {
          if (!ended && !res.complete) {
            const err = new Error(`${service}/${method} connection closed before response ended`);
            err.code = 'ECONNRESET';
            finishReject(err);
          }
        });
      },
    );

    const triggerTimeout = () => {
      const err = new Error(`${service}/${method} timed out after ${effectiveTimeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      finishReject(err);
      try {
        req.destroy(err);
      } catch {
        // Ignore destroy errors
      }
    };

    hardTimer = setTimeout(triggerTimeout, effectiveTimeoutMs);
    if (typeof hardTimer.unref === 'function') hardTimer.unref();

    req.on('timeout', triggerTimeout);
    req.on('error', finishReject);
    req.on('close', () => {
      if (!gotResponse && !settled) {
        const err = new Error(`${service}/${method} connection closed before response`);
        err.code = 'ECONNRESET';
        finishReject(err);
      }
    });
    req.end(payload);
  });
}

const CONV_SVC = 'product.v1.ConversationService';
const LS_SVC = 'exa.language_server_pb.LanguageServerService';
const MODEL_CONFIG_TTL_MS = 5 * 60_000;
const MODEL_CONFIG_FAIL_TTL_MS = 15_000;
const PROJECT_META_TTL_MS = 60_000;
const PROJECT_META_FAIL_TTL_MS = 15_000;
const PROJECT_META_MAX_ENTRIES = 120;

let modelConfigCache = { endpoint: '', expiresAt: 0, data: null, lookup: null, models: null };
const projectMetaCache = new Map(); // cacheKey -> { expiresAt, diskStamp, meta }

export function resetModelConfigCache() {
  modelConfigCache = { endpoint: '', expiresAt: 0, data: null, lookup: null, models: null };
}

export function resetProjectMetadataCache() {
  projectMetaCache.clear();
}

function normalizeProjectId(raw) {
  const id = String(raw || '').trim();
  if (!id || id.toLowerCase() === 'outside-of-project') return '';
  return id;
}

function isSafeProjectFileId(id) {
  return Boolean(id && /^[A-Za-z0-9._-]+$/.test(id) && !id.includes('..'));
}

function extractProjectNameFromRecord(projectObj, expectedId = '') {
  if (!projectObj || typeof projectObj !== 'object') return '';
  const recId = String(projectObj.id || expectedId || '').trim().toLowerCase();
  if (recId === 'outside-of-project') return '';
  const rawName = String(
    projectObj.name ?? projectObj.displayName ?? projectObj.title ?? '',
  ).trim();
  if (!rawName || rawName.toLowerCase() === 'outside-of-project') return '';
  return rawName;
}

function extractProjectFolderUris(projectObj) {
  const resources = Array.isArray(projectObj?.projectResources?.resources)
    ? projectObj.projectResources.resources
    : [];
  const uris = [];
  const seen = new Set();
  for (const r of resources) {
    const uri = String(
      r?.gitFolder?.folderUri || r?.folder?.folderUri || r?.folderUri || '',
    ).trim();
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      uris.push(uri);
    }
  }
  return uris;
}

function getProjectConfigFilePath(projectId, env = process.env, homeDir = homedir()) {
  if (!isSafeProjectFileId(projectId)) return '';
  return join(getGeminiDir(env, homeDir), 'config', 'projects', `${projectId}.json`);
}

function readProjectDiskStamp(filePath) {
  if (!filePath) return '-';
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return '-';
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

function readProjectFromDisk(filePath) {
  if (!filePath || !existsSync(filePath)) return { found: false, project: null };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { found: false, project: null };
    return { found: true, project: parsed };
  } catch {
    return { found: false, project: null };
  }
}

function setProjectMetaCacheEntry(cacheKey, entry) {
  if (!projectMetaCache.has(cacheKey) && projectMetaCache.size >= PROJECT_META_MAX_ENTRIES) {
    projectMetaCache.delete(projectMetaCache.keys().next().value);
  }
  projectMetaCache.set(cacheKey, entry);
}

export async function readProject(projectId, timeoutMs = 3000) {
  const id = normalizeProjectId(projectId);
  if (!id) return { notFoundOnDisk: true };
  return connectPost(LS_SVC, 'ReadProject', { id }, timeoutMs);
}

/**
 * Resolves Antigravity Project metadata for `projectId` with lightweight TTL caching.
 * Primary source: `exa.language_server_pb.LanguageServerService/ReadProject` (`{ id }`).
 * Offline fallback: `<geminiDir>/config/projects/<projectId>.json`.
 * Never throws; returns empty `name` when outside a project or metadata is unavailable.
 */
export async function getProjectMetadata(projectId, options = {}) {
  const {
    timeoutMs = 2500,
    forceRefresh = false,
    allowCachedOnly = false,
    allowDiskFallback = true,
    env = process.env,
    homeDir = homedir(),
  } = options || {};

  const id = normalizeProjectId(projectId);
  const emptyMeta = {
    ok: false,
    id: '',
    name: '',
    source: '',
    found: false,
    notFound: false,
    isWorkspaceOnly: false,
    folderUris: [],
  };
  if (!id) return emptyMeta;

  const nowMs = Date.now();
  const usingDefaultEnv = env === process.env && homeDir === homedir();
  const ep = usingDefaultEnv ? resolveLsEndpoint() : null;
  const endpointKey = ep?.address || '';
  const geminiDir = getGeminiDir(env, homeDir);
  const cacheKey = `${endpointKey}|${geminiDir}|${id}`;
  const diskPath = allowDiskFallback ? getProjectConfigFilePath(id, env, homeDir) : '';
  const diskStamp = diskPath ? readProjectDiskStamp(diskPath) : '-';

  const cached = projectMetaCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > nowMs && cached.diskStamp === diskStamp) {
    return cached.meta;
  }
  if (allowCachedOnly) {
    return cached ? cached.meta : { ...emptyMeta, id };
  }

  let lsNotFound = false;
  if (ep) {
    try {
      const res = await readProject(id, timeoutMs);
      if (!res?.notFoundOnDisk && res?.project && typeof res.project === 'object') {
        const name = extractProjectNameFromRecord(res.project, id);
        const meta = {
          ok: Boolean(name),
          id,
          name,
          source: 'ls',
          found: true,
          notFound: false,
          isWorkspaceOnly: Boolean(res.project.isWorkspaceOnly),
          folderUris: extractProjectFolderUris(res.project),
        };
        setProjectMetaCacheEntry(cacheKey, {
          expiresAt: nowMs + (name ? PROJECT_META_TTL_MS : PROJECT_META_FAIL_TTL_MS),
          diskStamp,
          meta,
        });
        return meta;
      }
      if (res?.notFoundOnDisk) {
        lsNotFound = true;
      }
    } catch {
      // LS offline, busy, or ReadProject unsupported; fall through to local disk metadata
    }
  }

  if (allowDiskFallback && diskPath) {
    const disk = readProjectFromDisk(diskPath);
    if (disk.found && disk.project) {
      const name = extractProjectNameFromRecord(disk.project, id);
      const meta = {
        ok: Boolean(name),
        id,
        name,
        source: 'disk',
        found: true,
        notFound: false,
        isWorkspaceOnly: Boolean(disk.project.isWorkspaceOnly),
        folderUris: extractProjectFolderUris(disk.project),
      };
      setProjectMetaCacheEntry(cacheKey, {
        expiresAt: nowMs + (name ? PROJECT_META_TTL_MS : PROJECT_META_FAIL_TTL_MS),
        diskStamp,
        meta,
      });
      return meta;
    }
  }

  const missMeta = {
    ok: false,
    id,
    name: '',
    source: '',
    found: false,
    notFound: lsNotFound,
    isWorkspaceOnly: false,
    folderUris: [],
  };
  setProjectMetaCacheEntry(cacheKey, {
    expiresAt: nowMs + PROJECT_META_FAIL_TTL_MS,
    diskStamp,
    meta: missMeta,
  });
  return missMeta;
}

export async function resolveProjectName(projectId, options = {}) {
  const meta = await getProjectMetadata(projectId, options);
  return meta?.name || '';
}

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

export async function getConversation(conversationId, timeoutMs = 6000) {
  return connectPost(CONV_SVC, 'GetConversation', { conversationId }, timeoutMs);
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

function toNonNegInt(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round(num);
}

function normalizeUsageModelKey(chat) {
  const raw = String(chat?.modelDisplayName || chat?.responseModel || chat?.model || '').trim();
  if (!raw) return '_default';
  return raw.replace(/\s*\([^)]*\)\s*/g, ' ').trim().toLowerCase() || '_default';
}

/**
 * Extracts cumulative token usage, current context window occupancy, compact limit,
 * and compaction count from GetCascadeTrajectoryGeneratorMetadata output.
 */
export function extractUsageFromGeneratorMetadata(res) {
  const list = Array.isArray(res?.generatorMetadata) ? res.generatorMetadata : [];
  if (list.length === 0) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let contextTokens = 0;
  let compactLimit = 0;
  let dropCompacts = 0;
  const checkpointIndices = new Set();
  const prevUsedByModel = new Map();

  for (let i = 0; i < list.length; i++) {
    const chat = list[i]?.chatModel;
    if (!chat || typeof chat !== 'object') continue;

    const usage = chat.usage && typeof chat.usage === 'object' ? chat.usage : {};
    const inp = toNonNegInt(usage.inputTokens);
    const out = toNonNegInt(usage.outputTokens);
    const cache = toNonNegInt(usage.cacheReadTokens);

    inputTokens += inp;
    outputTokens += out;
    cacheReadTokens += cache;

    const startMeta =
      chat.chatStartMetadata && typeof chat.chatStartMetadata === 'object'
        ? chat.chatStartMetadata
        : null;
    const cpRaw = startMeta?.checkpointIndex;
    const cpIdx = cpRaw !== undefined && cpRaw !== null && cpRaw !== '' ? Number(cpRaw) : -1;
    if (Number.isInteger(cpIdx) && cpIdx >= 0) {
      checkpointIndices.add(cpIdx);
    }

    const ctxMeta =
      startMeta?.contextWindowMetadata && typeof startMeta.contextWindowMetadata === 'object'
        ? startMeta.contextWindowMetadata
        : null;
    const reportedMax = toNonNegInt(ctxMeta?.maxContextTokens);
    if (reportedMax > 0) {
      compactLimit = reportedMax;
    }

    const providerInput = inp + cache;
    const estimatedUsed = toNonNegInt(ctxMeta?.estimatedTokensUsed);
    const used = providerInput > 0 ? providerInput : estimatedUsed;
    if (used > 0) {
      const modelKey = normalizeUsageModelKey(chat);
      const prevUsed = prevUsedByModel.get(modelKey) || 0;
      if (prevUsed > 0 && used < prevUsed * 0.72 && prevUsed - used > 30000) {
        dropCompacts++;
      }
      prevUsedByModel.set(modelKey, used);
      contextTokens = used;
    }
  }

  const totalTokens = inputTokens + cacheReadTokens + outputTokens;
  if (totalTokens <= 0 && contextTokens <= 0) {
    return null;
  }

  const compactCount = Math.max(checkpointIndices.size, dropCompacts);
  const compactPercent =
    compactLimit > 0
      ? Math.min(100, Math.max(0, Math.round((contextTokens / compactLimit) * 100)))
      : null;

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    contextTokens,
    compactLimit,
    compactPercent,
    compactCount,
    source: 'ls',
  };
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
 * Safely fetches the latest generator model & usage metadata for a conversation without throwing on
 * offline/busy LS instances. Distinguishes `{ ok: true }` from `{ ok: false }` for caching.
 */
export async function getThreadGeneratorModel(cascadeId, timeoutMs = 4000) {
  if (!cascadeId) return { ok: false, info: null, usage: null, count: 0 };
  try {
    const res = await getCascadeTrajectoryGeneratorMetadata(cascadeId, timeoutMs);
    const list = Array.isArray(res?.generatorMetadata) ? res.generatorMetadata : [];
    return {
      ok: true,
      info: extractModelInfoFromGeneratorMetadata(res),
      usage: extractUsageFromGeneratorMetadata(res),
      count: list.length,
    };
  } catch {
    return { ok: false, info: null, usage: null, count: 0 };
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

function matchGroupedModelMeta(modelId, label, groupedEntries) {
  if (!groupedEntries.length) {
    return { familyId: '', familyName: '', thinkingSuffix: '', thinkingDisplayName: '', rank: -1 };
  }
  const lowerId = String(modelId || '').trim().toLowerCase();
  const lowerLabel = String(label || '').trim().toLowerCase();

  let matched = null;
  if (lowerId) {
    for (const entry of groupedEntries) {
      if (lowerId === entry.familyKeyLower || lowerId.startsWith(`${entry.familyKeyLower}-`)) {
        if (!matched || entry.familyKeyLower.length > matched.familyKeyLower.length) {
          matched = entry;
        }
      }
    }
  }
  if (!matched && lowerLabel) {
    for (const entry of groupedEntries) {
      if (!entry.displayNameLower) continue;
      if (
        lowerLabel === entry.displayNameLower ||
        lowerLabel.startsWith(`${entry.displayNameLower} (`) ||
        lowerLabel.startsWith(`${entry.displayNameLower} `)
      ) {
        if (!matched || entry.displayNameLower.length > matched.displayNameLower.length) {
          matched = entry;
        }
      }
    }
  }
  if (!matched) {
    return { familyId: '', familyName: '', thinkingSuffix: '', thinkingDisplayName: '', rank: -1 };
  }

  let suffix = '';
  if (lowerId && lowerId.startsWith(`${matched.familyKeyLower}-`)) {
    suffix = lowerId.slice(matched.familyKeyLower.length + 1);
  }
  const levelIdx = matched.levels.findIndex(
    (lv) => lv.suffix === suffix || (lv.displayLower && lowerLabel.includes(`(${lv.displayLower})`)),
  );
  const matchedLevel = levelIdx >= 0 ? matched.levels[levelIdx] : null;
  return {
    familyId: matched.familyKey,
    familyName: matched.displayName,
    thinkingSuffix: matchedLevel?.suffix || suffix,
    thinkingDisplayName: matchedLevel?.displayName || '',
    rank: levelIdx,
  };
}

/**
 * Parses and orders selectable concrete models from a GetCascadeModelConfigData response,
 * honoring `clientModelSorts`, `groupedModels`, and `defaultOverrideModelConfig`.
 */
export function extractSelectableModels(data) {
  const configs = Array.isArray(data?.clientModelConfigs) ? data.clientModelConfigs : [];
  if (!configs.length) return [];

  const groupedRaw = data?.groupedModels && typeof data.groupedModels === 'object' ? data.groupedModels : {};
  const groupedEntries = Object.entries(groupedRaw).map(([familyKey, meta]) => {
    const displayName = String(meta?.displayName || '').trim();
    const levelsRaw = Array.isArray(meta?.supportedThinkingLevels) ? meta.supportedThinkingLevels : [];
    const levels = levelsRaw.map((lv) => ({
      suffix: String(lv?.thinkingSuffix || '').trim().toLowerCase(),
      displayName: String(lv?.thinkingDisplayName || '').trim(),
      displayLower: String(lv?.thinkingDisplayName || '').trim().toLowerCase(),
    }));
    return {
      familyKey,
      familyKeyLower: familyKey.toLowerCase(),
      displayName,
      displayNameLower: displayName.toLowerCase(),
      levels,
    };
  });

  const defCfg = data?.defaultOverrideModelConfig?.modelOrAlias || null;
  const defaultEnum = String(defCfg?.model || '').trim();
  const defaultAlias = String(defCfg?.alias || '').trim();

  const items = [];
  const seenKeys = new Set();
  const byLabelExact = new Map();
  const byLabelLower = new Map();

  for (const cfg of configs) {
    if (!cfg || cfg.disabled) continue;
    const label = String(cfg.label || '').trim();
    if (!label) continue;

    const modelEnum = String(cfg?.modelOrAlias?.model || '').trim();
    const modelAlias = String(cfg?.modelOrAlias?.alias || '').trim();
    const modelId = String(cfg?.modelId || '').trim();
    const id = modelId || modelEnum || modelAlias || label;
    const dedupKey = modelEnum || modelAlias || modelId.toLowerCase() || label.toLowerCase();
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);

    const modelOrAlias = modelEnum
      ? { model: modelEnum }
      : modelAlias
        ? { alias: modelAlias }
        : null;

    let quotaInfo = null;
    if (cfg.quotaInfo && typeof cfg.quotaInfo === 'object') {
      const rawFrac = Number(cfg.quotaInfo.remainingFraction);
      quotaInfo = {
        remainingFraction: Number.isFinite(rawFrac) ? Math.max(0, Math.min(1, rawFrac)) : null,
        resetTime: String(cfg.quotaInfo.resetTime || '').trim(),
      };
    }

    const groupMeta = matchGroupedModelMeta(modelId, label, groupedEntries);
    const isDefault = Boolean(
      (defaultEnum && modelEnum && modelEnum === defaultEnum) ||
      (defaultAlias && modelAlias && modelAlias === defaultAlias),
    );

    const item = {
      id,
      modelId,
      modelEnum,
      modelAlias,
      modelOrAlias,
      label,
      familyId: groupMeta.familyId,
      familyName: groupMeta.familyName,
      thinkingLevel: groupMeta.thinkingDisplayName || groupMeta.thinkingSuffix || '',
      tagTitle: String(cfg.tagTitle || '').trim(),
      tagDescription: String(cfg.tagDescription || '').trim(),
      description: String(cfg.description || '').trim(),
      quotaInfo,
      isDefault,
      isRecommended: Boolean(cfg.isRecommended),
      supportsImages: Boolean(cfg.supportsImages),
      groupName: '',
      _thinkingRank: groupMeta.rank,
    };

    items.push(item);
    if (!byLabelExact.has(label)) byLabelExact.set(label, item);
    const lowerLbl = label.toLowerCase();
    if (!byLabelLower.has(lowerLbl)) byLabelLower.set(lowerLbl, item);
  }

  const sorts = Array.isArray(data?.clientModelSorts) ? data.clientModelSorts : [];
  const preferredSort =
    sorts.find((s) => /^recommended$/i.test(String(s?.name || '').trim())) || sorts[0] || null;
  const sortGroups = Array.isArray(preferredSort?.groups) ? preferredSort.groups : [];

  let ordered;
  const hasSortLabels = sortGroups.some(
    (g) => Array.isArray(g?.modelLabels) && g.modelLabels.length > 0,
  );

  if (hasSortLabels) {
    ordered = [];
    const placed = new Set();
    for (const grp of sortGroups) {
      const groupName = String(grp?.groupName || '').trim();
      const labels = Array.isArray(grp?.modelLabels) ? grp.modelLabels : [];
      for (const rawLbl of labels) {
        const lbl = String(rawLbl || '').trim();
        if (!lbl) continue;
        const hit = byLabelExact.get(lbl) || byLabelLower.get(lbl.toLowerCase()) || null;
        if (hit && !placed.has(hit)) {
          placed.add(hit);
          if (groupName) hit.groupName = groupName;
          ordered.push(hit);
        }
      }
    }
    for (const item of items) {
      if (!placed.has(item)) ordered.push(item);
    }
  } else if (groupedEntries.length > 0) {
    ordered = [];
    const placed = new Set();
    for (const item of items) {
      if (placed.has(item)) continue;
      if (!item.familyId) {
        placed.add(item);
        ordered.push(item);
        continue;
      }
      const familyPeers = items.filter((p) => p.familyId === item.familyId && !placed.has(p));
      familyPeers.sort((a, b) => {
        const ar = a._thinkingRank >= 0 ? a._thinkingRank : Number.MAX_SAFE_INTEGER;
        const br = b._thinkingRank >= 0 ? b._thinkingRank : Number.MAX_SAFE_INTEGER;
        return ar - br;
      });
      for (const peer of familyPeers) {
        placed.add(peer);
        ordered.push(peer);
      }
    }
  } else {
    ordered = items;
  }

  return ordered.map(({ _thinkingRank, ...cleanItem }) => cleanItem);
}

async function getModelConfigDataCached({
  timeoutMs = 3000,
  allowCachedOnly = false,
  forceRefresh = false,
} = {}) {
  const nowMs = Date.now();
  const ep = resolveLsEndpoint();
  const endpointKey = ep?.address || '';
  const sameEndpoint = modelConfigCache.endpoint === endpointKey;

  if (!forceRefresh && sameEndpoint && modelConfigCache.expiresAt > nowMs && modelConfigCache.lookup) {
    return {
      ok: Boolean(modelConfigCache.data),
      data: modelConfigCache.data,
      lookup: modelConfigCache.lookup,
      models: modelConfigCache.models || [],
      error: '',
    };
  }
  if (allowCachedOnly) {
    if (sameEndpoint && modelConfigCache.lookup) {
      return {
        ok: Boolean(modelConfigCache.data),
        data: modelConfigCache.data,
        lookup: modelConfigCache.lookup,
        models: modelConfigCache.models || [],
        error: '',
      };
    }
    return {
      ok: false,
      data: null,
      lookup: { byEnum: new Map(), byId: new Map() },
      models: [],
      error: 'No cached model catalog',
    };
  }

  try {
    const res = await connectPost(LS_SVC, 'GetCascadeModelConfigData', {}, timeoutMs);
    const lookup = buildModelConfigLookup(res);
    const models = extractSelectableModels(res);
    modelConfigCache = {
      endpoint: endpointKey,
      expiresAt: nowMs + MODEL_CONFIG_TTL_MS,
      data: res,
      lookup,
      models,
    };
    return { ok: true, data: res, lookup, models, error: '' };
  } catch (err) {
    const preserved = sameEndpoint && modelConfigCache.data ? modelConfigCache : null;
    const lookup = preserved?.lookup || { byEnum: new Map(), byId: new Map() };
    const models = preserved?.models || [];
    modelConfigCache = {
      endpoint: endpointKey,
      expiresAt: nowMs + MODEL_CONFIG_FAIL_TTL_MS,
      data: preserved?.data || null,
      lookup,
      models,
    };
    return {
      ok: false,
      data: preserved?.data || null,
      lookup,
      models,
      error: err?.message || 'Failed to fetch model config data',
    };
  }
}

export async function getModelConfigLookup({ timeoutMs = 3000, allowCachedOnly = false } = {}) {
  const cached = await getModelConfigDataCached({ timeoutMs, allowCachedOnly });
  return cached.lookup;
}

export async function getCascadeModelCatalog({
  timeoutMs = 3000,
  allowCachedOnly = false,
  forceRefresh = false,
} = {}) {
  const res = await getModelConfigDataCached({ timeoutMs, allowCachedOnly, forceRefresh });
  const models = Array.isArray(res.models) ? res.models : [];
  const defaultModel = models.find((m) => m.isDefault) || models[0] || null;
  return {
    ok: res.ok,
    models,
    defaultModel,
    lookup: res.lookup,
    error: res.error || '',
  };
}

export async function getSelectableModels({
  timeoutMs = 3000,
  allowCachedOnly = false,
  forceRefresh = false,
} = {}) {
  const catalog = await getCascadeModelCatalog({ timeoutMs, allowCachedOnly, forceRefresh });
  return catalog.models;
}

/**
 * Constructs a protobuf-JSON payload for `LanguageServerService/SendUserCascadeMessage`.
 * Sets `cascadeConfig.plannerConfig.planModel` and `requestedModel` when a concrete model
 * enum or alias is provided.
 */
export function buildSendUserCascadeMessagePayload(conversationId, message, options = {}) {
  const cascadeId = String(conversationId || '').trim();
  const text = String(message ?? '').trim();
  if (!cascadeId) throw new Error('conversationId is required for SendUserCascadeMessage.');
  if (!text) throw new Error('message is required for SendUserCascadeMessage.');

  const body = {
    cascadeId,
    items: [{ text }],
  };

  if (options.metadata && typeof options.metadata === 'object') {
    body.metadata = options.metadata;
  }

  const rawOrAlias =
    options.modelOrAlias && typeof options.modelOrAlias === 'object' ? options.modelOrAlias : null;
  let modelEnum = String(options.modelEnum || rawOrAlias?.model || '').trim();
  let modelAlias = String(options.modelAlias || rawOrAlias?.alias || '').trim();
  const rawModel = String(options.model || options.modelId || '').trim();

  if (!modelEnum && !modelAlias && rawModel) {
    if (/^MODEL_ALIAS_/i.test(rawModel)) {
      modelAlias = rawModel;
    } else if (/^MODEL_/i.test(rawModel)) {
      modelEnum = rawModel;
    }
  }

  let requestedModel = null;
  if (modelEnum) {
    requestedModel = { model: modelEnum };
  } else if (modelAlias) {
    requestedModel = { alias: modelAlias };
  }

  const hasCustomCascadeConfig =
    options.cascadeConfig && typeof options.cascadeConfig === 'object';

  if (modelEnum || requestedModel || hasCustomCascadeConfig) {
    const baseCascadeConfig = hasCustomCascadeConfig ? { ...options.cascadeConfig } : {};
    const basePlanner =
      baseCascadeConfig.plannerConfig && typeof baseCascadeConfig.plannerConfig === 'object'
        ? { ...baseCascadeConfig.plannerConfig }
        : {};
    if (modelEnum) basePlanner.planModel = modelEnum;
    if (requestedModel) basePlanner.requestedModel = requestedModel;
    if (Object.keys(basePlanner).length > 0) {
      baseCascadeConfig.plannerConfig = basePlanner;
    }
    body.cascadeConfig = baseCascadeConfig;
  }

  return body;
}

/**
 * Sends a user message via `exa.language_server_pb.LanguageServerService/SendUserCascadeMessage`,
 * optionally switching the conversation's model via `cascadeConfig.plannerConfig`.
 */
export async function sendUserCascadeMessage(conversationId, message, options = {}) {
  const resolvedOpts = { ...options };
  const hasExplicitEnumOrAlias = Boolean(
    resolvedOpts.modelEnum ||
      resolvedOpts.modelAlias ||
      resolvedOpts.modelOrAlias?.model ||
      resolvedOpts.modelOrAlias?.alias,
  );
  const rawModel = String(resolvedOpts.model || resolvedOpts.modelId || '').trim();

  if (!hasExplicitEnumOrAlias && rawModel && !/^MODEL_/i.test(rawModel)) {
    const models = await getSelectableModels({ timeoutMs: 2500 });
    const lower = rawModel.toLowerCase();
    const matched =
      models.find(
        (m) =>
          m.id === rawModel ||
          m.modelId === rawModel ||
          m.modelEnum === rawModel ||
          m.label === rawModel,
      ) ||
      models.find(
        (m) =>
          m.id.toLowerCase() === lower ||
          m.modelId.toLowerCase() === lower ||
          m.label.toLowerCase() === lower,
      ) ||
      null;
    if (matched) {
      if (matched.modelEnum) resolvedOpts.modelEnum = matched.modelEnum;
      if (matched.modelOrAlias) resolvedOpts.modelOrAlias = matched.modelOrAlias;
    }
  }

  const payload = buildSendUserCascadeMessagePayload(conversationId, message, resolvedOpts);
  return connectPost(
    LS_SVC,
    'SendUserCascadeMessage',
    payload,
    resolvedOpts.timeoutMs || 10000,
  );
}

const CASCADE_NOT_RUNNING_ERR_RE =
  /cascade\s+not\s+found|run\s+state\s+not\s+found|not\s+running|already\s+idle|no\s+active\s+(?:cascade|invocation|run)/i;
const TRANSPORT_OR_AUTH_ERR_RE =
  /not\s+available\s+yet|timed\s+out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|invalid_argument|unauthenticated|permission_denied|unimplemented|404\s+page\s+not\s+found|\bHTTP\s+(?:401|403|501|502|503|504)\b/i;

/**
 * Classifies whether an error returned by CancelCascadeInvocation indicates the target
 * cascade has already finished / has no active run state rather than a transport, auth,
 * validation, or generic 5xx server failure.
 */
export function isCascadeNotRunningError(err) {
  if (!err) return false;
  const code = String(err.code || '').trim().toUpperCase();
  if (
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EHOSTUNREACH'
  ) {
    return false;
  }
  const msg = String(err.message || err || '');
  if (!msg || TRANSPORT_OR_AUTH_ERR_RE.test(msg)) {
    return false;
  }
  return CASCADE_NOT_RUNNING_ERR_RE.test(msg);
}

/**
 * Cancels an active cascade invocation via `exa.language_server_pb.LanguageServerService/CancelCascadeInvocation`.
 * Request payload strictly uses `{ cascadeId, killBackgroundTasks, notifyParent? }`.
 * Propagates transport/auth/5xx errors without swallowing them.
 */
export async function cancelCascadeInvocation(
  conversationId,
  { killBackgroundTasks = true, notifyParent, timeoutMs = 8000 } = {},
) {
  const cascadeId = String(conversationId || '').trim();
  if (!cascadeId) {
    throw new Error('conversationId is required for CancelCascadeInvocation.');
  }
  const payload = {
    cascadeId,
    killBackgroundTasks: Boolean(killBackgroundTasks),
  };
  if (notifyParent !== undefined && notifyParent !== null) {
    payload.notifyParent = Boolean(notifyParent);
  }
  return connectPost(LS_SVC, 'CancelCascadeInvocation', payload, timeoutMs);
}

/**
 * Force-stops an entire conversation and nested subagent cascade tree via
 * `exa.language_server_pb.LanguageServerService/ForceStopCascadeTree`.
 * Request payload strictly uses `{ conversationId }`.
 */
export async function forceStopCascadeTree(conversationId, { timeoutMs = 8000 } = {}) {
  const convId = String(conversationId || '').trim();
  if (!convId) {
    throw new Error('conversationId is required for ForceStopCascadeTree.');
  }
  return connectPost(LS_SVC, 'ForceStopCascadeTree', { conversationId: convId }, timeoutMs);
}

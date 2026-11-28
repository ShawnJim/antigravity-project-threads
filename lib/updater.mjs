import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStateDir } from './ls-client.mjs';
import { loadSettings, saveSettings } from './store.mjs';

const DEFAULT_PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPO_SLUG = 'ShawnJim/antigravity-project-threads';
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_GIT_TIMEOUT_MS = 20_000;
const DEFAULT_HTTP_TIMEOUT_MS = 8_000;

const inMemoryCache = new Map(); // `${stateDir}::${pluginKey}::${channel}` -> entry
const inFlightChecks = new Map(); // `${stateDir}::${pluginKey}::${channel}` -> Promise

export function resetUpdateCache() {
  inMemoryCache.clear();
  inFlightChecks.clear();
}

export function normalizeUpdateChannel(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (s === 'stable' || s === 'dev') return s;
  return '';
}

export function inferChannelFromBranch(branch) {
  return String(branch || '').trim().toLowerCase() === 'dev' ? 'dev' : 'stable';
}

export function parseSemver(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.').filter(Boolean) : [],
    raw: s,
  };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;

  const aPre = pa.prerelease;
  const bPre = pb.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1;
  if (bPre.length === 0) return -1;

  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i++) {
    if (i >= aPre.length) return -1;
    if (i >= bPre.length) return 1;
    const ai = aPre[i];
    const bi = bPre[i];
    if (ai === bi) continue;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) return Number(ai) - Number(bi);
    if (aNum) return -1;
    if (bNum) return 1;
    return ai < bi ? -1 : 1;
  }
  return 0;
}

function stripLeadingV(v) {
  return String(v || '').trim().replace(/^v/i, '');
}

function normalizeFsPath(p) {
  if (!p) return '';
  let resolved = resolve(String(p));
  try {
    resolved = realpathSync(resolved);
  } catch {
    // Keep resolved path when target cannot be realpathed
  }
  const cleaned = resolved.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
}

function isSameFsPath(a, b) {
  if (!a || !b) return false;
  return normalizeFsPath(a) === normalizeFsPath(b);
}

function parseGithubRepoSlug(rawUrl) {
  const s = String(rawUrl || '').trim();
  const m = s.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i);
  if (!m) return '';
  return `${m[1]}/${m[2].replace(/\.git$/i, '')}`;
}

function readPluginManifest(pluginDir) {
  const manifestPath = join(pluginDir, 'plugin.json');
  let parsed = null;
  if (existsSync(manifestPath)) {
    try {
      parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch {
      parsed = null;
    }
  }
  const repoRaw =
    typeof parsed?.repository === 'string'
      ? parsed.repository
      : typeof parsed?.repository?.url === 'string'
        ? parsed.repository.url
        : typeof parsed?.homepage === 'string'
          ? parsed.homepage
          : '';
  const repoSlug = parseGithubRepoSlug(repoRaw) || DEFAULT_REPO_SLUG;
  return {
    name: String(parsed?.name || 'project-threads').trim(),
    displayName: String(parsed?.displayName || 'Project Threads').trim(),
    version: String(parsed?.version || '0.0.0').trim(),
    repository: repoRaw || `https://github.com/${repoSlug}`,
    repoSlug,
    releasesPageUrl: `https://github.com/${repoSlug}/releases`,
    releasesApiUrl: `https://api.github.com/repos/${repoSlug}/releases?per_page=20`,
  };
}

function runGitResult(args, cwd, timeoutMs = DEFAULT_GIT_TIMEOUT_MS) {
  return new Promise((resolveOut) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
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

async function inspectLocalGit(pluginDir, remoteName = 'origin') {
  const empty = {
    isGitInstall: false,
    branch: '',
    detached: false,
    headSha: '',
    shortSha: '',
    isDirty: false,
    dirtyCount: 0,
    dirtyFiles: [],
    hasOrigin: false,
    remoteUrl: '',
    currentTag: '',
  };

  if (!pluginDir || !existsSync(pluginDir)) return empty;

  const topRes = await runGitResult(['rev-parse', '--show-toplevel'], pluginDir, 5000);
  if (!topRes.ok || !isSameFsPath(topRes.stdout.trim(), pluginDir)) {
    return empty;
  }

  const [branchRes, headRes, shortRes, statusRes, remoteRes, tagRes] = await Promise.all([
    runGitResult(['symbolic-ref', '--short', 'HEAD'], pluginDir, 5000),
    runGitResult(['rev-parse', 'HEAD'], pluginDir, 5000),
    runGitResult(['rev-parse', '--short', 'HEAD'], pluginDir, 5000),
    runGitResult(['status', '--porcelain'], pluginDir, 5000),
    runGitResult(['remote', 'get-url', remoteName], pluginDir, 5000),
    runGitResult(['describe', '--tags', '--exact-match', 'HEAD'], pluginDir, 5000),
  ]);

  const dirtyLines = statusRes.ok
    ? statusRes.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0)
    : [];

  return {
    isGitInstall: true,
    branch: branchRes.ok ? branchRes.stdout.trim() : '',
    detached: !branchRes.ok,
    headSha: headRes.ok ? headRes.stdout.trim() : '',
    shortSha: shortRes.ok ? shortRes.stdout.trim() : '',
    isDirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
    dirtyFiles: dirtyLines.slice(0, 20),
    hasOrigin: remoteRes.ok && Boolean(remoteRes.stdout.trim()),
    remoteUrl: remoteRes.ok ? remoteRes.stdout.trim() : '',
    currentTag: tagRes.ok ? tagRes.stdout.trim() : '',
  };
}

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

function getCacheFilePath(stateDir) {
  return join(stateDir, 'update-cache.json');
}

function makeCacheEntryKey(pluginDir, channel) {
  return `${normalizeFsPath(pluginDir)}::${channel}`;
}

function readCachedEntry(stateDir, pluginDir, channel) {
  const entryKey = makeCacheEntryKey(pluginDir, channel);
  const memKey = `${stateDir}::${entryKey}`;
  if (inMemoryCache.has(memKey)) {
    return inMemoryCache.get(memKey);
  }
  const cacheFile = getCacheFilePath(stateDir);
  if (!existsSync(cacheFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'));
    const entry = parsed?.entries?.[entryKey] || null;
    if (entry) inMemoryCache.set(memKey, entry);
    return entry;
  } catch {
    return null;
  }
}

function writeCachedEntry(stateDir, pluginDir, channel, entry) {
  const entryKey = makeCacheEntryKey(pluginDir, channel);
  const memKey = `${stateDir}::${entryKey}`;
  inMemoryCache.set(memKey, entry);

  const cacheFile = getCacheFilePath(stateDir);
  let doc = { version: 1, entries: {} };
  if (existsSync(cacheFile)) {
    try {
      const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        doc = { version: 1, entries: { ...parsed.entries } };
      }
    } catch {
      doc = { version: 1, entries: {} };
    }
  }
  doc.entries[entryKey] = entry;
  try {
    writeJsonFileAtomic(cacheFile, doc);
  } catch {
    // Cache persistence failure should never break update checks
  }
}

function isCacheEntryValidForLocal(entry, manifest, localGit, cacheTtlMs) {
  if (!entry || !entry.checkedAt || !entry.result) return false;
  const ageMs = Date.now() - Date.parse(entry.checkedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= cacheTtlMs) return false;
  if (String(entry.localVersion || '') !== String(manifest.version || '')) return false;
  if (Boolean(entry.isGitInstall) !== Boolean(localGit.isGitInstall)) return false;
  if (localGit.isGitInstall) {
    if (String(entry.localHeadSha || '') !== String(localGit.headSha || '')) return false;
    if (String(entry.localBranch || '') !== String(localGit.branch || '')) return false;
  }
  return true;
}

function resolveChannelChoice(requestedChannel, localGit) {
  const explicit = normalizeUpdateChannel(requestedChannel);
  if (explicit) return { channel: explicit, channelSource: 'explicit' };
  const settings = loadSettings();
  const saved = normalizeUpdateChannel(settings?.updateChannel);
  if (saved) return { channel: saved, channelSource: 'saved' };
  return {
    channel: inferChannelFromBranch(localGit.branch),
    channelSource: 'inferred',
  };
}

function buildBaseStatus(manifest, localGit, channel, channelSource) {
  return {
    ok: true,
    pluginName: manifest.name,
    displayName: manifest.displayName,
    installType: localGit.isGitInstall ? 'git' : 'release',
    isGitInstall: localGit.isGitInstall,
    channel,
    channelSource,
    currentVersion: manifest.version,
    currentBranch: localGit.branch,
    detached: localGit.detached,
    currentSha: localGit.headSha,
    currentShortSha: localGit.shortSha,
    currentTag: localGit.currentTag,
    isDirty: localGit.isDirty,
    dirtyCount: localGit.dirtyCount,
    dirtyFiles: localGit.dirtyFiles,
    targetChannel: channel,
    targetBranch: channel === 'dev' ? 'dev' : 'main',
    targetRef: '',
    targetVersion: '',
    targetSha: '',
    targetShortSha: '',
    latestTag: '',
    behindCount: 0,
    aheadCount: 0,
    channelMismatch: false,
    hasUpdate: false,
    canApplyUpdate: false,
    summary: '',
    recentCommits: [],
    latestCommitDate: '',
    releaseUrl: manifest.releasesPageUrl,
    checkedAt: '',
    fromCache: false,
    cacheFresh: false,
    checking: false,
    offline: false,
    errorCode: '',
    error: '',
  };
}

function extractReleaseSummary(release) {
  const body = String(release?.body || '');
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').trim())
    .filter((line) => line && !/^[-*_]{3,}$/.test(line) && !/^<!--/.test(line));
  const picked = lines[0] || String(release?.name || release?.tag_name || '').trim();
  return picked.length > 180 ? `${picked.slice(0, 179)}…` : picked;
}

async function resolveGitTargetRef(pluginDir, channel, remoteName) {
  if (channel === 'dev') {
    const devRef = `${remoteName}/dev`;
    const devCheck = await runGitResult(['rev-parse', '--verify', `${devRef}^{commit}`], pluginDir, 5000);
    if (!devCheck.ok) {
      return {
        ok: false,
        errorCode: 'target_branch_missing',
        error: `Remote branch "${devRef}" was not found.`,
      };
    }
    const sha = devCheck.stdout.trim();
    const tagRes = await runGitResult(['describe', '--tags', '--abbrev=0', sha], pluginDir, 5000);
    return {
      ok: true,
      targetBranch: 'dev',
      targetRef: devRef,
      targetSha: sha,
      latestTag: tagRes.ok ? tagRes.stdout.trim() : '',
    };
  }

  // Stable channel: origin/main (fallback origin/master), plus latest formal vX.Y.Z / stable tags
  let targetBranch = '';
  let targetRef = '';
  let targetSha = '';

  for (const cand of ['main', 'master']) {
    const ref = `${remoteName}/${cand}`;
    const res = await runGitResult(['rev-parse', '--verify', `${ref}^{commit}`], pluginDir, 5000);
    if (res.ok) {
      targetBranch = cand;
      targetRef = ref;
      targetSha = res.stdout.trim();
      break;
    }
  }

  const [stableTagRes, tagListRes] = await Promise.all([
    runGitResult(['rev-parse', '--verify', 'refs/tags/stable^{commit}'], pluginDir, 5000),
    runGitResult(['tag', '-l', 'v*'], pluginDir, 5000),
  ]);

  const stableSemverTags = tagListRes.ok
    ? tagListRes.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
        .sort((a, b) => compareSemver(b, a))
    : [];

  const highestStableTag = stableSemverTags[0] || '';
  const stableTagSha = stableTagRes.ok ? stableTagRes.stdout.trim() : '';

  if (!targetSha && stableTagSha) {
    targetRef = 'refs/tags/stable';
    targetSha = stableTagSha;
  }
  if (!targetSha && highestStableTag) {
    const tShaRes = await runGitResult(
      ['rev-parse', '--verify', `refs/tags/${highestStableTag}^{commit}`],
      pluginDir,
      5000,
    );
    if (tShaRes.ok) {
      targetRef = `refs/tags/${highestStableTag}`;
      targetSha = tShaRes.stdout.trim();
    }
  }

  if (!targetSha) {
    return {
      ok: false,
      errorCode: 'target_branch_missing',
      error: `Remote stable branch "${remoteName}/main" was not found.`,
    };
  }

  let latestTag = '';
  if (highestStableTag) {
    const tShaRes = await runGitResult(
      ['rev-parse', '--verify', `refs/tags/${highestStableTag}^{commit}`],
      pluginDir,
      5000,
    );
    const highestTagSha = tShaRes.ok ? tShaRes.stdout.trim() : '';
    if (highestTagSha === targetSha || !targetBranch) {
      latestTag = highestStableTag;
    } else if (stableTagSha && stableTagSha === targetSha) {
      latestTag = highestStableTag || 'stable';
    } else {
      const exactTagRes = await runGitResult(
        ['describe', '--tags', '--exact-match', targetSha],
        pluginDir,
        5000,
      );
      latestTag = exactTagRes.ok ? exactTagRes.stdout.trim() : highestStableTag;
    }
  } else if (stableTagSha && stableTagSha === targetSha) {
    latestTag = 'stable';
  }

  return {
    ok: true,
    targetBranch,
    targetRef,
    targetSha,
    latestTag,
  };
}

async function readVersionAtGitCommit(pluginDir, commitSha) {
  const res = await runGitResult(['show', `${commitSha}:plugin.json`], pluginDir, 5000);
  if (!res.ok) return '';
  try {
    const parsed = JSON.parse(res.stdout);
    return String(parsed?.version || '').trim();
  } catch {
    return '';
  }
}

async function runGitUpdateCheck({
  pluginDir,
  manifest,
  localGit,
  channel,
  channelSource,
  remoteName,
  timeoutMs,
  skipFetch = false,
}) {
  const base = buildBaseStatus(manifest, localGit, channel, channelSource);

  if (!localGit.hasOrigin) {
    return {
      ...base,
      ok: false,
      offline: false,
      errorCode: 'no_remote',
      error: `Git remote "${remoteName}" is not configured.`,
      checkedAt: new Date().toISOString(),
    };
  }

  if (!skipFetch) {
    const fetchRes = await runGitResult(
      ['fetch', remoteName, '--tags', '--force'],
      pluginDir,
      timeoutMs,
    );
    if (!fetchRes.ok) {
      return {
        ...base,
        ok: false,
        offline: true,
        errorCode: 'fetch_failed',
        error: fetchRes.error || `git fetch ${remoteName} failed`,
        checkedAt: new Date().toISOString(),
      };
    }
  }

  const target = await resolveGitTargetRef(pluginDir, channel, remoteName);
  if (!target.ok) {
    return {
      ...base,
      ok: false,
      errorCode: target.errorCode,
      error: target.error,
      checkedAt: new Date().toISOString(),
    };
  }

  const [shortRes, countRes, logRes, remoteManifestVersion] = await Promise.all([
    runGitResult(['rev-parse', '--short', target.targetSha], pluginDir, 5000),
    runGitResult(['rev-list', '--left-right', '--count', `HEAD...${target.targetSha}`], pluginDir, 5000),
    runGitResult(['log', '-1', '--pretty=format:%s%n%cI', target.targetSha], pluginDir, 5000),
    readVersionAtGitCommit(pluginDir, target.targetSha),
  ]);

  let aheadCount = 0;
  let behindCount = 0;
  if (countRes.ok) {
    const parts = countRes.stdout.trim().split(/\s+/);
    aheadCount = Number(parts[0]) || 0;
    behindCount = Number(parts[1]) || 0;
  }

  let recentCommits = [];
  if (behindCount > 0) {
    const recentRes = await runGitResult(
      ['log', '--no-decorate', '--pretty=format:%h %s', '-n', '5', `HEAD..${target.targetSha}`],
      pluginDir,
      5000,
    );
    if (recentRes.ok) {
      recentCommits = recentRes.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  const logLines = logRes.ok ? logRes.stdout.split(/\r?\n/) : [];
  const latestCommitSubject = String(logLines[0] || '').trim();
  const latestCommitDate = String(logLines[1] || '').trim();

  let targetVersion = remoteManifestVersion || '';
  if (target.latestTag && /^v\d+\.\d+\.\d+/.test(target.latestTag)) {
    const tagVer = stripLeadingV(target.latestTag);
    if (!targetVersion || (channel === 'stable' && compareSemver(tagVer, targetVersion) > 0)) {
      targetVersion = tagVer;
    }
  }
  if (!targetVersion) targetVersion = manifest.version;

  const channelMismatch = Boolean(target.targetBranch && localGit.branch !== target.targetBranch);
  const versionNewer = Boolean(
    targetVersion && manifest.version && compareSemver(targetVersion, manifest.version) > 0,
  );
  const hasUpdate = Boolean(behindCount > 0 || versionNewer);
  const canApplyUpdate = Boolean(hasUpdate || channelMismatch);

  const releaseUrl =
    target.latestTag && /^v\d+\.\d+\.\d+/i.test(target.latestTag)
      ? `https://github.com/${manifest.repoSlug}/releases/tag/${encodeURIComponent(target.latestTag)}`
      : manifest.releasesPageUrl;

  return {
    ...base,
    ok: true,
    targetBranch: target.targetBranch,
    targetRef: target.targetRef,
    targetVersion,
    targetSha: target.targetSha,
    targetShortSha: shortRes.ok ? shortRes.stdout.trim() : target.targetSha.slice(0, 7),
    latestTag: target.latestTag,
    behindCount,
    aheadCount,
    channelMismatch,
    hasUpdate,
    canApplyUpdate,
    summary: latestCommitSubject,
    recentCommits,
    latestCommitDate,
    releaseUrl,
    checkedAt: new Date().toISOString(),
  };
}

async function runGithubReleaseCheck({
  manifest,
  localGit,
  channel,
  channelSource,
  fetchFn = globalThis.fetch,
  githubApiUrl = '',
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
}) {
  const base = buildBaseStatus(manifest, localGit, channel, channelSource);
  const apiUrl = githubApiUrl || manifest.releasesApiUrl;

  if (typeof fetchFn !== 'function') {
    return {
      ...base,
      ok: false,
      offline: true,
      errorCode: 'fetch_unavailable',
      error: 'Fetch API is unavailable in this runtime.',
      checkedAt: new Date().toISOString(),
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_HTTP_TIMEOUT_MS));

  let response;
  try {
    response = await fetchFn(apiUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `${manifest.name || 'project-threads'}-updater`,
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      ...base,
      ok: false,
      offline: true,
      errorCode: err?.name === 'AbortError' ? 'github_timeout' : 'github_fetch_failed',
      error:
        err?.name === 'AbortError'
          ? 'Timed out while reaching GitHub Releases API.'
          : err?.message || 'Unable to reach GitHub Releases API.',
      checkedAt: new Date().toISOString(),
    };
  }
  clearTimeout(timer);

  if (!response?.ok) {
    return {
      ...base,
      ok: false,
      offline: false,
      errorCode: 'github_http_error',
      error: `GitHub Releases API returned HTTP ${response?.status || 'error'}.`,
      checkedAt: new Date().toISOString(),
    };
  }

  let releases;
  try {
    releases = await response.json();
  } catch {
    return {
      ...base,
      ok: false,
      offline: false,
      errorCode: 'github_parse_error',
      error: 'Invalid JSON response from GitHub Releases API.',
      checkedAt: new Date().toISOString(),
    };
  }

  const list = Array.isArray(releases) ? releases.filter((r) => r && !r.draft) : [];
  const candidates =
    channel === 'dev'
      ? list
      : list.filter((r) => !r.prerelease && !/-[0-9A-Za-z.-]+$/.test(String(r.tag_name || '')));

  if (!candidates.length) {
    return {
      ...base,
      ok: true,
      targetVersion: manifest.version,
      hasUpdate: false,
      canApplyUpdate: false,
      summary: '',
      releaseUrl: manifest.releasesPageUrl,
      checkedAt: new Date().toISOString(),
    };
  }

  const sorted = [...candidates].sort((a, b) => {
    const cmp = compareSemver(b.tag_name || b.name, a.tag_name || a.name);
    if (cmp !== 0) return cmp;
    return String(b.published_at || '').localeCompare(String(a.published_at || ''));
  });
  const chosen = sorted[0];
  const latestTag = String(chosen.tag_name || '').trim();
  const targetVersion = stripLeadingV(latestTag) || manifest.version;
  const hasUpdate = Boolean(
    targetVersion && manifest.version && compareSemver(targetVersion, manifest.version) > 0,
  );

  return {
    ...base,
    ok: true,
    targetRef: latestTag,
    targetVersion,
    latestTag,
    hasUpdate,
    canApplyUpdate: false,
    summary: extractReleaseSummary(chosen),
    latestCommitDate: String(chosen.published_at || '').trim(),
    releaseUrl: String(chosen.html_url || manifest.releasesPageUrl).trim(),
    checkedAt: new Date().toISOString(),
  };
}

export async function checkPluginUpdate({
  channel = '',
  force = true,
  persistChannel = true,
  pluginDir = DEFAULT_PLUGIN_DIR,
  stateDir = '',
  remoteName = 'origin',
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  httpTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  fetchFn = globalThis.fetch,
  githubApiUrl = '',
  skipFetch = false,
} = {}) {
  const resolvedPluginDir = resolve(pluginDir || DEFAULT_PLUGIN_DIR);
  const resolvedStateDir = stateDir || getStateDir();
  const manifest = readPluginManifest(resolvedPluginDir);
  const localGit = await inspectLocalGit(resolvedPluginDir, remoteName);
  const { channel: effectiveChannel, channelSource } = resolveChannelChoice(channel, localGit);

  if (persistChannel && normalizeUpdateChannel(channel)) {
    try {
      saveSettings({ updateChannel: effectiveChannel });
    } catch {
      // Ignore non-fatal settings persistence failure
    }
  }

  const cached = readCachedEntry(resolvedStateDir, resolvedPluginDir, effectiveChannel);
  if (!force && isCacheEntryValidForLocal(cached, manifest, localGit, cacheTtlMs)) {
    return {
      ...cached.result,
      channel: effectiveChannel,
      channelSource,
      isDirty: localGit.isDirty,
      dirtyCount: localGit.dirtyCount,
      dirtyFiles: localGit.dirtyFiles,
      fromCache: true,
      cacheFresh: true,
      checking: false,
    };
  }

  const flightKey = `${resolvedStateDir}::${makeCacheEntryKey(resolvedPluginDir, effectiveChannel)}`;
  if (!skipFetch && inFlightChecks.has(flightKey)) {
    return inFlightChecks.get(flightKey);
  }

  const runPromise = (async () => {
    const result = localGit.isGitInstall
      ? await runGitUpdateCheck({
          pluginDir: resolvedPluginDir,
          manifest,
          localGit,
          channel: effectiveChannel,
          channelSource,
          remoteName,
          timeoutMs,
          skipFetch,
        })
      : await runGithubReleaseCheck({
          manifest,
          localGit,
          channel: effectiveChannel,
          channelSource,
          fetchFn,
          githubApiUrl,
          timeoutMs: httpTimeoutMs,
        });

    if (result.ok) {
      writeCachedEntry(resolvedStateDir, resolvedPluginDir, effectiveChannel, {
        checkedAt: result.checkedAt,
        isGitInstall: localGit.isGitInstall,
        localVersion: manifest.version,
        localHeadSha: localGit.headSha,
        localBranch: localGit.branch,
        result,
      });
    }

    return {
      ...result,
      fromCache: false,
      cacheFresh: result.ok,
      checking: false,
    };
  })();

  if (!skipFetch) {
    inFlightChecks.set(flightKey, runPromise);
  }
  try {
    return await runPromise;
  } finally {
    if (!skipFetch && inFlightChecks.get(flightKey) === runPromise) {
      inFlightChecks.delete(flightKey);
    }
  }
}

export async function getPluginUpdateStatus({
  channel = '',
  backgroundRefresh = false,
  pluginDir = DEFAULT_PLUGIN_DIR,
  stateDir = '',
  remoteName = 'origin',
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  httpTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  fetchFn = globalThis.fetch,
  githubApiUrl = '',
} = {}) {
  const resolvedPluginDir = resolve(pluginDir || DEFAULT_PLUGIN_DIR);
  const resolvedStateDir = stateDir || getStateDir();
  const manifest = readPluginManifest(resolvedPluginDir);
  const localGit = await inspectLocalGit(resolvedPluginDir, remoteName);
  const { channel: effectiveChannel, channelSource } = resolveChannelChoice(channel, localGit);

  const flightKey = `${resolvedStateDir}::${makeCacheEntryKey(resolvedPluginDir, effectiveChannel)}`;
  const cached = readCachedEntry(resolvedStateDir, resolvedPluginDir, effectiveChannel);
  const cacheFresh = isCacheEntryValidForLocal(cached, manifest, localGit, cacheTtlMs);

  let status;
  if (cacheFresh && cached?.result) {
    status = {
      ...cached.result,
      channel: effectiveChannel,
      channelSource,
      currentVersion: manifest.version,
      currentBranch: localGit.branch,
      currentSha: localGit.headSha,
      currentShortSha: localGit.shortSha,
      isDirty: localGit.isDirty,
      dirtyCount: localGit.dirtyCount,
      dirtyFiles: localGit.dirtyFiles,
      fromCache: true,
      cacheFresh: true,
      checking: inFlightChecks.has(flightKey),
    };
  } else {
    const base = buildBaseStatus(manifest, localGit, effectiveChannel, channelSource);
    const sameLocal =
      cached?.result &&
      String(cached.localVersion || '') === String(manifest.version || '') &&
      Boolean(cached.isGitInstall) === Boolean(localGit.isGitInstall) &&
      (!localGit.isGitInstall ||
        (String(cached.localHeadSha || '') === String(localGit.headSha || '') &&
          String(cached.localBranch || '') === String(localGit.branch || '')));

    status = sameLocal
      ? {
          ...cached.result,
          channel: effectiveChannel,
          channelSource,
          isDirty: localGit.isDirty,
          dirtyCount: localGit.dirtyCount,
          dirtyFiles: localGit.dirtyFiles,
          fromCache: true,
          cacheFresh: false,
          checking: inFlightChecks.has(flightKey),
        }
      : {
          ...base,
          channelMismatch: Boolean(
            localGit.isGitInstall && localGit.branch && localGit.branch !== base.targetBranch,
          ),
          canApplyUpdate: Boolean(
            localGit.isGitInstall && localGit.branch && localGit.branch !== base.targetBranch,
          ),
          fromCache: false,
          cacheFresh: false,
          checking: inFlightChecks.has(flightKey),
        };

    if (backgroundRefresh && !inFlightChecks.has(flightKey)) {
      status.checking = true;
      checkPluginUpdate({
        channel: effectiveChannel,
        force: true,
        persistChannel: false,
        pluginDir: resolvedPluginDir,
        stateDir: resolvedStateDir,
        remoteName,
        cacheTtlMs,
        timeoutMs,
        httpTimeoutMs,
        fetchFn,
        githubApiUrl,
      }).catch(() => {});
    }
  }

  return status;
}

export async function applyPluginUpdate({
  channel = '',
  persistChannel = true,
  pluginDir = DEFAULT_PLUGIN_DIR,
  stateDir = '',
  remoteName = 'origin',
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
} = {}) {
  const resolvedPluginDir = resolve(pluginDir || DEFAULT_PLUGIN_DIR);
  const resolvedStateDir = stateDir || getStateDir();
  const manifest = readPluginManifest(resolvedPluginDir);
  const localGit = await inspectLocalGit(resolvedPluginDir, remoteName);
  const { channel: effectiveChannel } = resolveChannelChoice(channel, localGit);

  if (!localGit.isGitInstall) {
    return {
      ok: false,
      errorCode: 'not_git_install',
      error:
        'Local one-click update is only available for Git-installed plugins. Please download the latest release from GitHub.',
      isGitInstall: false,
      channel: effectiveChannel,
      currentVersion: manifest.version,
      releaseUrl: manifest.releasesPageUrl,
    };
  }

  if (localGit.isDirty) {
    return {
      ok: false,
      errorCode: 'dirty_worktree',
      error: `Refused to update: local plugin directory has ${localGit.dirtyCount} uncommitted change(s). Please commit, stash, or discard local edits before updating.`,
      isGitInstall: true,
      channel: effectiveChannel,
      currentVersion: manifest.version,
      currentBranch: localGit.branch,
      currentShortSha: localGit.shortSha,
      isDirty: true,
      dirtyCount: localGit.dirtyCount,
      dirtyFiles: localGit.dirtyFiles,
    };
  }

  if (!localGit.hasOrigin) {
    return {
      ok: false,
      errorCode: 'no_remote',
      error: `Git remote "${remoteName}" is not configured.`,
      isGitInstall: true,
      channel: effectiveChannel,
      currentVersion: manifest.version,
    };
  }

  const fetchRes = await runGitResult(
    ['fetch', remoteName, '--tags', '--force'],
    resolvedPluginDir,
    timeoutMs,
  );
  if (!fetchRes.ok) {
    return {
      ok: false,
      errorCode: 'fetch_failed',
      error: fetchRes.error || `git fetch ${remoteName} failed`,
      isGitInstall: true,
      channel: effectiveChannel,
      currentVersion: manifest.version,
    };
  }

  const target = await resolveGitTargetRef(resolvedPluginDir, effectiveChannel, remoteName);
  if (!target.ok || !target.targetBranch) {
    return {
      ok: false,
      errorCode: target.errorCode || 'target_branch_missing',
      error: target.error || `Target branch for channel "${effectiveChannel}" is unavailable.`,
      isGitInstall: true,
      channel: effectiveChannel,
      currentVersion: manifest.version,
    };
  }

  if (persistChannel) {
    try {
      saveSettings({ updateChannel: effectiveChannel });
    } catch {
      // Ignore non-fatal settings save failure
    }
  }

  // Re-verify clean working tree immediately prior to mutating checkout/merge
  const recheckStatus = await runGitResult(['status', '--porcelain'], resolvedPluginDir, 5000);
  const recheckDirty = recheckStatus.ok
    ? recheckStatus.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0)
    : [];
  if (recheckDirty.length > 0) {
    return {
      ok: false,
      errorCode: 'dirty_worktree',
      error: `Refused to update: local plugin directory has ${recheckDirty.length} uncommitted change(s).`,
      isGitInstall: true,
      channel: effectiveChannel,
      isDirty: true,
      dirtyCount: recheckDirty.length,
      dirtyFiles: recheckDirty.slice(0, 20),
    };
  }

  const previousVersion = manifest.version;
  const previousBranch = localGit.branch;
  const previousSha = localGit.headSha;
  const previousShortSha = localGit.shortSha;

  if (localGit.branch !== target.targetBranch) {
    const localBranchCheck = await runGitResult(
      ['show-ref', '--verify', '--quiet', `refs/heads/${target.targetBranch}`],
      resolvedPluginDir,
      5000,
    );
    if (localBranchCheck.ok) {
      const checkoutRes = await runGitResult(['checkout', target.targetBranch], resolvedPluginDir, timeoutMs);
      if (!checkoutRes.ok) {
        return {
          ok: false,
          errorCode: 'checkout_failed',
          error: checkoutRes.error || `Failed to switch to branch "${target.targetBranch}".`,
          isGitInstall: true,
          channel: effectiveChannel,
        };
      }
      const mergeRes = await runGitResult(
        ['merge', '--ff-only', target.targetRef],
        resolvedPluginDir,
        timeoutMs,
      );
      if (!mergeRes.ok) {
        return {
          ok: false,
          errorCode: 'ff_failed',
          error:
            mergeRes.error ||
            `Fast-forward update failed because local "${target.targetBranch}" has diverged from "${target.targetRef}".`,
          isGitInstall: true,
          channel: effectiveChannel,
        };
      }
    } else {
      const checkoutNewRes = await runGitResult(
        ['checkout', '-b', target.targetBranch, '--track', target.targetRef],
        resolvedPluginDir,
        timeoutMs,
      );
      if (!checkoutNewRes.ok) {
        return {
          ok: false,
          errorCode: 'checkout_failed',
          error: checkoutNewRes.error || `Failed to create tracking branch "${target.targetBranch}".`,
          isGitInstall: true,
          channel: effectiveChannel,
        };
      }
    }
  } else {
    const mergeRes = await runGitResult(
      ['merge', '--ff-only', target.targetRef],
      resolvedPluginDir,
      timeoutMs,
    );
    if (!mergeRes.ok) {
      return {
        ok: false,
        errorCode: 'ff_failed',
        error:
          mergeRes.error ||
          `Fast-forward update failed because local "${target.targetBranch}" has diverged from "${target.targetRef}".`,
        isGitInstall: true,
        channel: effectiveChannel,
      };
    }
  }

  const freshStatus = await checkPluginUpdate({
    channel: effectiveChannel,
    force: true,
    persistChannel: false,
    pluginDir: resolvedPluginDir,
    stateDir: resolvedStateDir,
    remoteName,
    timeoutMs,
    skipFetch: true,
  });

  const changed =
    freshStatus.currentSha !== previousSha || freshStatus.currentBranch !== previousBranch;

  return {
    ok: true,
    updated: changed,
    needsReload: changed,
    channel: effectiveChannel,
    previousVersion,
    previousBranch,
    previousSha,
    previousShortSha,
    currentVersion: freshStatus.currentVersion,
    currentBranch: freshStatus.currentBranch,
    currentSha: freshStatus.currentSha,
    currentShortSha: freshStatus.currentShortSha,
    targetBranch: target.targetBranch,
    status: freshStatus,
  };
}

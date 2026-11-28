import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { loadSettings, saveSettings } from '../lib/store.mjs';
import {
  applyPluginUpdate,
  checkPluginUpdate,
  compareSemver,
  getPluginUpdateStatus,
  resetUpdateCache,
} from '../lib/updater.mjs';

function createTempEnv(t, prefix = 'pt-upd-') {
  const tempRoot = mkdtempSync(join(tmpdir(), prefix));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  const stateDir = join(appDataDir, 'project-threads');
  mkdirSync(stateDir, { recursive: true });

  const envKeys = ['ANTIGRAVITY_GEMINI_DIR', 'ANTIGRAVITY_APP_DATA_DIR'];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;
  resetUpdateCache();

  t.after(() => {
    resetUpdateCache();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  return { tempRoot, geminiDir, appDataDir, stateDir };
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeManifest(dir, version, extra = {}) {
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify(
      {
        name: 'project-threads',
        displayName: 'Project Threads',
        version,
        repository: 'https://github.com/ShawnJim/antigravity-project-threads',
        ...extra,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

function createGitFixture(tempRoot) {
  const bareRepo = join(tempRoot, 'origin.git');
  const upstreamWork = join(tempRoot, 'upstream-work');
  const pluginClone = join(tempRoot, 'plugin-clone');

  mkdirSync(bareRepo, { recursive: true });
  git(['init', '--bare', '-b', 'main'], bareRepo);

  mkdirSync(upstreamWork, { recursive: true });
  git(['init', '-b', 'main'], upstreamWork);
  git(['config', 'user.email', 'test@example.com'], upstreamWork);
  git(['config', 'user.name', 'Test Author'], upstreamWork);
  git(['remote', 'add', 'origin', bareRepo], upstreamWork);

  writeManifest(upstreamWork, '1.1.0');
  writeFileSync(join(upstreamWork, 'README.md'), '# Project Threads v1.1.0\n', 'utf8');
  git(['add', '.'], upstreamWork);
  git(['commit', '-m', 'chore(release): v1.1.0'], upstreamWork);
  git(['tag', 'v1.1.0'], upstreamWork);
  git(['tag', 'stable'], upstreamWork);
  git(['push', '-u', 'origin', 'main', '--tags'], upstreamWork);

  // Create dev branch at same base initially, then push ahead commit
  git(['checkout', '-b', 'dev'], upstreamWork);
  writeManifest(upstreamWork, '1.2.0-rc.1');
  writeFileSync(join(upstreamWork, 'DEV_NOTES.md'), 'Preview notes\n', 'utf8');
  git(['add', '.'], upstreamWork);
  git(['commit', '-m', 'feat(dev): preview v1.2.0-rc.1'], upstreamWork);
  git(['tag', 'v1.2.0-rc.1'], upstreamWork);
  git(['push', '-u', 'origin', 'dev', '--tags'], upstreamWork);

  // Clone plugin on main
  git(['clone', '--branch', 'main', bareRepo, pluginClone], tempRoot);
  git(['config', 'user.email', 'local@example.com'], pluginClone);
  git(['config', 'user.name', 'Local User'], pluginClone);

  return { bareRepo, upstreamWork, pluginClone };
}

test('compareSemver handles stable, prerelease, v-prefixes, and settings.json updateChannel persistence', (t) => {
  createTempEnv(t, 'pt-upd-semver-');

  assert.equal(compareSemver('1.2.0', '1.1.0') > 0, true);
  assert.equal(compareSemver('v1.2.0', '1.2.0-rc.1') > 0, true);
  assert.equal(compareSemver('1.2.0-rc.2', '1.2.0-rc.1') > 0, true);
  assert.equal(compareSemver('1.2.0-rc.10', '1.2.0-rc.2') > 0, true);
  assert.equal(compareSemver('v1.1.0', '1.1.0'), 0);
  assert.equal(compareSemver('1.0.9', '1.1.0') < 0, true);

  // Saving updateChannel preserves existing defaults and project overrides
  saveSettings({
    defaults: { worktreeModel: 'gemini-4-neon-high', readOnlyModel: 'flash' },
    projects: { '/demo/repo': { worktreeModel: 'pro', readOnlyModel: '' } },
  });
  const savedDev = saveSettings({ updateChannel: 'dev' });
  assert.equal(savedDev.updateChannel, 'dev');
  assert.equal(savedDev.defaults.worktreeModel, 'gemini-4-neon-high');
  assert.equal(savedDev.defaults.readOnlyModel, 'flash');
  assert.equal(savedDev.projects['/demo/repo'].worktreeModel, 'pro');

  // Subsequent scoped model saves preserve updateChannel
  saveSettings({ scope: 'global', worktreeModel: 'inherit' });
  const reloaded = loadSettings();
  assert.equal(reloaded.updateChannel, 'dev');
  assert.equal(reloaded.defaults.worktreeModel, 'inherit');

  // Invalid channel clears updateChannel cleanly
  const cleared = saveSettings({ updateChannel: '' });
  assert.equal(cleared.updateChannel, undefined);
});

test('Git install: checks stable & dev channels, handles floating stable tag, caches status, and fast-forwards/switches channels safely', async (t) => {
  const { tempRoot, stateDir } = createTempEnv(t, 'pt-upd-git-');
  const { upstreamWork, pluginClone } = createGitFixture(tempRoot);

  // 1. Initial status infers stable from main branch and reports no update yet
  const initialCheck = await checkPluginUpdate({
    pluginDir: pluginClone,
    stateDir,
    force: true,
    persistChannel: false,
  });
  assert.equal(initialCheck.ok, true);
  assert.equal(initialCheck.isGitInstall, true);
  assert.equal(initialCheck.channel, 'stable');
  assert.equal(initialCheck.channelSource, 'inferred');
  assert.equal(initialCheck.currentVersion, '1.1.0');
  assert.equal(initialCheck.targetVersion, '1.1.0');
  assert.equal(initialCheck.behindCount, 0);
  assert.equal(initialCheck.hasUpdate, false);
  assert.equal(initialCheck.canApplyUpdate, false);

  // 2. Push two new commits to upstream main + v1.2.0 + advance floating `stable` tag
  git(['checkout', 'main'], upstreamWork);
  writeFileSync(join(upstreamWork, 'CHANGELOG.md'), '## 1.2.0\n- New updater\n', 'utf8');
  git(['add', 'CHANGELOG.md'], upstreamWork);
  git(['commit', '-m', 'feat(updater): add changelog'], upstreamWork);
  writeManifest(upstreamWork, '1.2.0');
  git(['add', 'plugin.json'], upstreamWork);
  git(['commit', '-m', 'chore(release): v1.2.0'], upstreamWork);
  git(['tag', 'v1.2.0'], upstreamWork);
  git(['tag', '-f', 'stable'], upstreamWork);
  git(['push', 'origin', 'main'], upstreamWork);
  git(['push', 'origin', 'v1.2.0'], upstreamWork);
  git(['push', 'origin', '--force', 'refs/tags/stable'], upstreamWork);

  // Cached getPluginUpdateStatus within TTL returns cached state without network fetch
  const cachedStatus = await getPluginUpdateStatus({
    pluginDir: pluginClone,
    stateDir,
    backgroundRefresh: false,
  });
  assert.equal(cachedStatus.fromCache, true);
  assert.equal(cachedStatus.cacheFresh, true);
  assert.equal(cachedStatus.hasUpdate, false);

  // Manual force check fetches origin/main + moved floating stable tag cleanly
  const stableCheck = await checkPluginUpdate({
    pluginDir: pluginClone,
    stateDir,
    channel: 'stable',
    force: true,
    persistChannel: true,
  });
  assert.equal(stableCheck.ok, true);
  assert.equal(stableCheck.hasUpdate, true);
  assert.equal(stableCheck.canApplyUpdate, true);
  assert.equal(stableCheck.currentVersion, '1.1.0');
  assert.equal(stableCheck.targetVersion, '1.2.0');
  assert.equal(stableCheck.latestTag, 'v1.2.0');
  assert.equal(stableCheck.behindCount, 2);
  assert.equal(stableCheck.recentCommits.length, 2);
  assert.match(stableCheck.summary, /v1\.2\.0/);
  assert.equal(loadSettings().updateChannel, 'stable');

  // 3. Apply safe fast-forward update on stable
  const applyStable = await applyPluginUpdate({
    pluginDir: pluginClone,
    stateDir,
    channel: 'stable',
  });
  assert.equal(applyStable.ok, true);
  assert.equal(applyStable.updated, true);
  assert.equal(applyStable.needsReload, true);
  assert.equal(applyStable.previousVersion, '1.1.0');
  assert.equal(applyStable.currentVersion, '1.2.0');
  assert.equal(applyStable.currentBranch, 'main');
  assert.equal(applyStable.status.hasUpdate, false);
  assert.equal(applyStable.status.behindCount, 0);
  assert.equal(JSON.parse(readFileSync(join(pluginClone, 'plugin.json'), 'utf8')).version, '1.2.0');

  // 4. Check dev channel from main -> detects channelMismatch & origin/dev commit
  const devCheck = await checkPluginUpdate({
    pluginDir: pluginClone,
    stateDir,
    channel: 'dev',
    force: true,
    persistChannel: true,
  });
  assert.equal(devCheck.ok, true);
  assert.equal(devCheck.channel, 'dev');
  assert.equal(devCheck.targetBranch, 'dev');
  assert.equal(devCheck.targetVersion, '1.2.0-rc.1');
  assert.equal(devCheck.channelMismatch, true);
  assert.equal(devCheck.behindCount, 1);
  assert.equal(devCheck.hasUpdate, true);
  assert.equal(devCheck.canApplyUpdate, true);
  assert.equal(loadSettings().updateChannel, 'dev');

  // Apply channel switch main -> dev
  const applyDev = await applyPluginUpdate({
    pluginDir: pluginClone,
    stateDir,
    channel: 'dev',
  });
  assert.equal(applyDev.ok, true);
  assert.equal(applyDev.currentBranch, 'dev');
  assert.equal(applyDev.currentVersion, '1.2.0-rc.1');
  assert.equal(applyDev.status.channelMismatch, false);
  assert.equal(applyDev.status.hasUpdate, false);

  // Clearing persisted channel while on `dev` auto-infers `dev`
  saveSettings({ updateChannel: '' });
  resetUpdateCache();
  const inferredDev = await getPluginUpdateStatus({
    pluginDir: pluginClone,
    stateDir,
    backgroundRefresh: false,
  });
  assert.equal(inferredDev.channel, 'dev');
  assert.equal(inferredDev.channelSource, 'inferred');

  // Switch back from dev -> stable (existing local main)
  const backToStable = await applyPluginUpdate({
    pluginDir: pluginClone,
    stateDir,
    channel: 'stable',
  });
  assert.equal(backToStable.ok, true);
  assert.equal(backToStable.currentBranch, 'main');
  assert.equal(backToStable.currentVersion, '1.2.0');
  assert.equal(loadSettings().updateChannel, 'stable');
});

test('Git install safety: refuses dirty working tree and diverged branches without ever resetting local edits', async (t) => {
  const { tempRoot, stateDir } = createTempEnv(t, 'pt-upd-dirty-');
  const { upstreamWork, pluginClone } = createGitFixture(tempRoot);

  // Push a newer commit on upstream main
  git(['checkout', 'main'], upstreamWork);
  writeManifest(upstreamWork, '1.2.0');
  git(['add', 'plugin.json'], upstreamWork);
  git(['commit', '-m', 'chore(release): v1.2.0'], upstreamWork);
  git(['push', 'origin', 'main'], upstreamWork);

  const headBefore = git(['rev-parse', 'HEAD'], pluginClone);

  // 1. Dirty tracked edit blocks applyPluginUpdate and leaves file untouched
  const customContent = '# Local custom edit that must not be overwritten\n';
  writeFileSync(join(pluginClone, 'README.md'), customContent, 'utf8');

  const dirtyRes = await applyPluginUpdate({
    pluginDir: pluginClone,
    stateDir,
    channel: 'stable',
  });
  assert.equal(dirtyRes.ok, false);
  assert.equal(dirtyRes.errorCode, 'dirty_worktree');
  assert.equal(dirtyRes.isDirty, true);
  assert.ok(dirtyRes.dirtyCount >= 1);
  assert.equal(readFileSync(join(pluginClone, 'README.md'), 'utf8'), customContent);
  assert.equal(git(['rev-parse', 'HEAD'], pluginClone), headBefore);

  // Restore tracked file, test untracked file also blocks applyPluginUpdate
  git(['checkout', '--', 'README.md'], pluginClone);
  const untrackedPath = join(pluginClone, 'local-notes.txt');
  writeFileSync(untrackedPath, 'keep me\n', 'utf8');
  const untrackedRes = await applyPluginUpdate({
    pluginDir: pluginClone,
    stateDir,
    channel: 'stable',
  });
  assert.equal(untrackedRes.ok, false);
  assert.equal(untrackedRes.errorCode, 'dirty_worktree');
  assert.equal(readFileSync(untrackedPath, 'utf8'), 'keep me\n');
  rmSync(untrackedPath);

  // 2. Diverged local commit fails fast-forward cleanly without losing commit
  writeFileSync(join(pluginClone, 'LOCAL_ONLY.md'), 'local commit\n', 'utf8');
  git(['add', 'LOCAL_ONLY.md'], pluginClone);
  git(['commit', '-m', 'local: diverged commit'], pluginClone);
  const divergedHead = git(['rev-parse', 'HEAD'], pluginClone);

  const ffRes = await applyPluginUpdate({
    pluginDir: pluginClone,
    stateDir,
    channel: 'stable',
  });
  assert.equal(ffRes.ok, false);
  assert.equal(ffRes.errorCode, 'ff_failed');
  assert.equal(git(['rev-parse', 'HEAD'], pluginClone), divergedHead);
  assert.equal(readFileSync(join(pluginClone, 'LOCAL_ONLY.md'), 'utf8'), 'local commit\n');
});

test('Non-Git install: queries GitHub Releases API for stable/dev, handles offline errors gracefully, and never modifies local files', async (t) => {
  const { tempRoot, stateDir } = createTempEnv(t, 'pt-upd-nongit-');
  const plainPluginDir = join(tempRoot, 'plain-plugin');
  mkdirSync(plainPluginDir, { recursive: true });
  writeManifest(plainPluginDir, '1.1.0');

  const sampleReleases = [
    {
      tag_name: 'v1.4.0-draft',
      name: 'Draft release',
      draft: true,
      prerelease: true,
      body: 'Should be ignored',
      html_url: 'https://github.com/ShawnJim/antigravity-project-threads/releases/tag/v1.4.0-draft',
      published_at: '2026-11-28T10:00:00Z',
    },
    {
      tag_name: 'v1.3.0-rc.1',
      name: 'v1.3.0-rc.1 Preview',
      draft: false,
      prerelease: true,
      body: '## Highlights\n- One-click updater preview\n',
      html_url: 'https://github.com/ShawnJim/antigravity-project-threads/releases/tag/v1.3.0-rc.1',
      published_at: '2026-11-27T10:00:00Z',
    },
    {
      tag_name: 'v1.2.0',
      name: 'v1.2.0 Stable',
      draft: false,
      prerelease: false,
      body: '## What is new\n- Stable updater release\n',
      html_url: 'https://github.com/ShawnJim/antigravity-project-threads/releases/tag/v1.2.0',
      published_at: '2026-11-26T10:00:00Z',
    },
  ];

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => sampleReleases,
  });

  // Stable channel selects v1.2.0 (ignores draft & prerelease)
  const stableRes = await checkPluginUpdate({
    pluginDir: plainPluginDir,
    stateDir,
    channel: 'stable',
    force: true,
    fetchFn: mockFetch,
  });
  assert.equal(stableRes.ok, true);
  assert.equal(stableRes.isGitInstall, false);
  assert.equal(stableRes.targetVersion, '1.2.0');
  assert.equal(stableRes.latestTag, 'v1.2.0');
  assert.equal(stableRes.hasUpdate, true);
  assert.equal(stableRes.canApplyUpdate, false);
  assert.equal(
    stableRes.releaseUrl,
    'https://github.com/ShawnJim/antigravity-project-threads/releases/tag/v1.2.0',
  );
  assert.ok(stableRes.summary.length > 0);

  // Dev channel selects v1.3.0-rc.1 (still ignores draft)
  const devRes = await checkPluginUpdate({
    pluginDir: plainPluginDir,
    stateDir,
    channel: 'dev',
    force: true,
    fetchFn: mockFetch,
  });
  assert.equal(devRes.ok, true);
  assert.equal(devRes.targetVersion, '1.3.0-rc.1');
  assert.equal(devRes.hasUpdate, true);
  assert.equal(devRes.canApplyUpdate, false);

  // Offline / network error degrades gracefully and keeps releaseUrl
  const offlineRes = await checkPluginUpdate({
    pluginDir: plainPluginDir,
    stateDir,
    channel: 'stable',
    force: true,
    fetchFn: async () => {
      throw new Error('ECONNREFUSED offline');
    },
  });
  assert.equal(offlineRes.ok, false);
  assert.equal(offlineRes.offline, true);
  assert.equal(offlineRes.errorCode, 'github_fetch_failed');
  assert.equal(
    offlineRes.releaseUrl,
    'https://github.com/ShawnJim/antigravity-project-threads/releases',
  );

  // applyPluginUpdate refuses non-Git installation without touching files
  const applyNonGit = await applyPluginUpdate({
    pluginDir: plainPluginDir,
    stateDir,
    channel: 'stable',
  });
  assert.equal(applyNonGit.ok, false);
  assert.equal(applyNonGit.errorCode, 'not_git_install');
  assert.equal(
    JSON.parse(readFileSync(join(plainPluginDir, 'plugin.json'), 'utf8')).version,
    '1.1.0',
  );
});

test('Static & UI checks: updater card, red dot, routes, 3-locale I18N, zero middle dots, zero native dialogs, zero reset --hard, and LF endings', () => {
  const updaterMjs = readFileSync(new URL('../lib/updater.mjs', import.meta.url), 'utf8');
  const mainMjs = readFileSync(new URL('../sidecars/threads/main.mjs', import.meta.url), 'utf8');
  const indexHtml = readFileSync(new URL('../sidecars/threads/index.html', import.meta.url), 'utf8');
  const themeCss = readFileSync(new URL('../sidecars/threads/theme.css', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');

  // Safety: never call git reset --hard anywhere in updater
  assert.equal(/reset['",\s]+--hard|reset\s+--hard/i.test(updaterMjs), false);

  // Sidecar routes registered via registerDualApi
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/update_status['"]/);
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/update_check['"]/);
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/update_apply['"]/);

  // HTML structure: red dot on #btn-settings and update card in #settings-screen
  assert.match(
    indexHtml,
    /<button[^>]*id="btn-settings"[^>]*>(?:(?!<\/button>)[\s\S])*?id="settings-update-dot"(?:(?!<\/button>)[\s\S])*?<\/button>/,
  );
  assert.match(indexHtml, /id="settings-update-card"/);
  assert.match(indexHtml, /id="btn-channel-stable"/);
  assert.match(indexHtml, /id="btn-channel-dev"/);
  assert.match(indexHtml, /id="btn-update-check"/);
  assert.match(indexHtml, /id="btn-update-apply"/);
  assert.match(indexHtml, /id="btn-update-release"/);
  assert.match(indexHtml, /id="update-reload-banner"/);

  // CSS rules for dot and update card
  assert.match(themeCss, /\.settings-update-dot\s*\{/);
  assert.match(themeCss, /\.update-badge\.avail\s*\{/);
  assert.match(themeCss, /\.update-reload-banner\s*\{/);

  // Zero native window.confirm/alert/prompt in app.js
  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appJs), false);

  // flashToast still updates #settings-toast
  assert.match(appJs, /\[elToast,\s*elSettingsToast\]/);

  // Extract I18N object and validate all updater keys across en / zh-CN / zh-TW with zero middle dots
  const i18nStart = appJs.indexOf('const I18N = {');
  assert.notEqual(i18nStart, -1);
  let depth = 0;
  let inBrace = false;
  let i18nEnd = -1;
  for (let i = i18nStart; i < appJs.length; i++) {
    const ch = appJs[i];
    if (ch === '{') {
      depth++;
      inBrace = true;
    } else if (ch === '}') {
      depth--;
      if (inBrace && depth === 0) {
        i18nEnd = i + 1;
        break;
      }
    }
  }
  assert.notEqual(i18nEnd, -1);
  const ctx = {};
  vm.runInNewContext(`${appJs.slice(i18nStart, i18nEnd)}; this.I18N = I18N;`, ctx);
  const { I18N } = ctx;

  const stringKeys = [
    'updateHdr',
    'updateInstallGit',
    'updateInstallRelease',
    'updateChannelLabel',
    'updateChannelStable',
    'updateChannelDev',
    'updateChannelHintStable',
    'updateChannelHintDev',
    'updateCurrentLabel',
    'updateTargetLabel',
    'updateBranchDetached',
    'updateBadgeChecking',
    'updateBadgeAvailable',
    'updateBadgeSwitch',
    'updateBadgeUpToDate',
    'updateBadgeDirty',
    'updateBadgeOffline',
    'updateBadgeUnchecked',
    'updateNotCheckedYet',
    'updateCheckBtn',
    'updateCheckingBtn',
    'updateApplyBtn',
    'updateSwitchApplyBtn',
    'updateApplyingBtn',
    'updateReleaseBtn',
    'updateNonGitHint',
    'updateModalTitle',
    'updateModalConfirm',
    'updateModalNote',
    'updateToastUpToDate',
    'updateToastApplied',
    'updateToastCheckErr',
    'updateToastApplyErr',
  ];
  const fnKeys = [
    ['settingsTipWithUpdate', ['1.2.0']],
    ['updateBehindCommits', [3]],
    ['updateAheadCommits', [2]],
    ['updateSwitchBranchHint', ['main', 'dev']],
    ['updateCheckedAgo', ['2m ago']],
    ['updateDirtyWarn', [2]],
    ['updateReloadBanner', ['1.2.0']],
    ['updateToastAvailable', ['1.2.0']],
  ];

  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    for (const key of stringKeys) {
      const val = I18N[loc][key];
      assert.equal(typeof val, 'string', `Missing string I18N.${loc}.${key}`);
      assert.ok(val.length > 0, `Empty I18N.${loc}.${key}`);
      assert.equal(val.includes('·'), false, `I18N.${loc}.${key} must not contain middle dot`);
    }
    for (const [key, sampleArgs] of fnKeys) {
      const fn = I18N[loc][key];
      assert.equal(typeof fn, 'function', `Missing fn I18N.${loc}.${key}`);
      const rendered = String(fn(...sampleArgs));
      assert.ok(rendered.length > 0, `Empty rendered I18N.${loc}.${key}`);
      assert.equal(rendered.includes('·'), false, `Rendered I18N.${loc}.${key} must not contain middle dot`);
    }
  }

  // Verify the updater section of app.js itself never introduces a middle dot separator
  const updSectionStart = appJs.indexOf('// ---------- Plugin Version & Update Checker ----------');
  const updSectionEnd = appJs.indexOf('// ---------- Boot & Reactive Polling ----------', updSectionStart);
  assert.notEqual(updSectionStart, -1);
  assert.notEqual(updSectionEnd, -1);
  assert.equal(
    appJs.slice(updSectionStart, updSectionEnd).includes('·'),
    false,
    'Updater UI code must never use middle dot separator',
  );

  // LF line endings on all new/modified .mjs files
  for (const rel of [
    '../lib/updater.mjs',
    '../lib/store.mjs',
    '../sidecars/threads/main.mjs',
    '../tests/plugin-updater.test.mjs',
  ]) {
    const raw = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!raw.includes(Buffer.from('\r')), `${rel} must use LF line endings`);
  }
});

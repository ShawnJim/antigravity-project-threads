import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  archiveThread,
  cleanupThreadWorktree,
  ensureProjectMemoryFile,
  inspectWorktreeGit,
  loadRegistry,
  saveRegistry,
} from '../lib/store.mjs';

function createTempGitAndStateEnv(t, prefix = 'pt-arch-') {
  const tempRoot = mkdtempSync(join(tmpdir(), prefix));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  const stateDir = join(appDataDir, 'project-threads');
  mkdirSync(stateDir, { recursive: true });

  const envKeys = [
    'ANTIGRAVITY_GEMINI_DIR',
    'ANTIGRAVITY_APP_DATA_DIR',
    'ANTIGRAVITY_LS_ADDRESS',
    'ANTIGRAVITY_CSRF_TOKEN',
  ];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;
  delete process.env.ANTIGRAVITY_LS_ADDRESS;
  delete process.env.ANTIGRAVITY_CSRF_TOKEN;

  const repoRoot = join(tempRoot, 'repo');
  mkdirSync(repoRoot, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoRoot });
  writeFileSync(join(repoRoot, 'README.md'), '# Repo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoRoot });

  const worktreesBase = join(tempRoot, '.worktrees', 'repo');
  mkdirSync(worktreesBase, { recursive: true });

  const cleanups = [];
  t.after(async () => {
    for (const fn of cleanups) {
      try {
        await fn();
      } catch {
        // Ignore cleanup errors
      }
    }
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  return { tempRoot, repoRoot, worktreesBase, cleanups };
}

function createWorktreeForThread({
  repoRoot,
  worktreesBase,
  threadId,
  branch,
  baseRef = 'main',
  excludeRules = true,
}) {
  const wtPath = join(worktreesBase, threadId);
  execFileSync('git', ['worktree', 'add', '-b', branch, wtPath, baseRef], { cwd: repoRoot });

  const rulesDir = join(wtPath, '.agents', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, 'project-memory.md'), '# Shared Memory\n', 'utf8');
  writeFileSync(join(rulesDir, 'worker-thread-context.md'), `# Context ${threadId}\n`, 'utf8');

  if (excludeRules) {
    const excludeRel = execFileSync(
      'git',
      ['rev-parse', '--git-path', 'info/exclude'],
      { cwd: wtPath, encoding: 'utf8' },
    ).trim();
    const excludePath = resolve(wtPath, excludeRel);
    mkdirSync(dirname(excludePath), { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    const patterns = ['.agents/rules/worker-thread-context.md', '.agents/rules/project-memory.md'];
    const additions = patterns.filter((p) => !existing.split(/\r?\n/).includes(p));
    if (additions.length) {
      const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
      writeFileSync(excludePath, `${existing}${prefix}${additions.join('\n')}\n`, 'utf8');
    }
  }

  return wtPath;
}

function branchExists(repoRoot, branch) {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: repoRoot,
    });
    return true;
  } catch {
    return false;
  }
}

function listGitWorktrees(repoRoot) {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim());
}

test('default archiveThread() removes clean merged worktree with excluded .agents/rules files, prunes, deletes branch, and clears registry', async (t) => {
  const { repoRoot, worktreesBase } = createTempGitAndStateEnv(t, 'pt-arch-clean-');

  // Case A: clean worktree at baseRef with excluded .agents/rules/*
  const wtClean = createWorktreeForThread({
    repoRoot,
    worktreesBase,
    threadId: 'thr-001',
    branch: 'thread/thr-001-clean',
    excludeRules: true,
  });

  // Case B: worktree with a real commit that was merged back into main
  const wtMerged = createWorktreeForThread({
    repoRoot,
    worktreesBase,
    threadId: 'thr-002',
    branch: 'thread/thr-002-merged',
    excludeRules: true,
  });
  writeFileSync(join(wtMerged, 'feature.txt'), 'merged feature\n', 'utf8');
  execFileSync('git', ['add', 'feature.txt'], { cwd: wtMerged });
  execFileSync('git', ['commit', '-m', 'Add feature'], { cwd: wtMerged });
  execFileSync('git', ['merge', '--no-ff', 'thread/thr-002-merged', '-m', 'Merge thr-002'], {
    cwd: repoRoot,
  });

  // Case C: clean worktree where .agents/rules/* were NOT yet in info/exclude
  const wtUnexcludedRules = createWorktreeForThread({
    repoRoot,
    worktreesBase,
    threadId: 'thr-003',
    branch: 'thread/thr-003-rules',
    excludeRules: false,
  });

  const reg = loadRegistry();
  reg.threads['thr-001'] = {
    threadId: 'thr-001',
    conversationId: 'conv-arch-001',
    workspaceKey: repoRoot,
    repoRoot,
    worktreePath: wtClean,
    branch: 'thread/thr-001-clean',
    baseRef: 'main',
    title: 'Clean task',
    archived: false,
    git: { exists: true, branch: 'thread/thr-001-clean', dirtyCount: 0, aheadCount: 0 },
  };
  reg.threads['thr-002'] = {
    threadId: 'thr-002',
    conversationId: 'conv-arch-002',
    workspaceKey: repoRoot,
    repoRoot,
    worktreePath: wtMerged,
    branch: 'thread/thr-002-merged',
    baseRef: 'main',
    title: 'Merged task',
    archived: false,
    git: { exists: true, branch: 'thread/thr-002-merged', dirtyCount: 0, aheadCount: 0 },
  };
  reg.threads['thr-003'] = {
    threadId: 'thr-003',
    conversationId: 'conv-arch-003',
    workspaceKey: repoRoot,
    repoRoot,
    worktreePath: wtUnexcludedRules,
    branch: 'thread/thr-003-rules',
    baseRef: 'main',
    title: 'Rules task',
    archived: false,
    git: { exists: true, branch: 'thread/thr-003-rules', dirtyCount: 0, aheadCount: 0 },
  };
  saveRegistry(reg);

  const res1 = await archiveThread('thr-001');
  assert.equal(res1.ok, true);
  assert.equal(res1.threadId, 'thr-001');
  assert.equal(res1.archived, true);
  assert.equal(res1.worktreeRemoved, true);
  assert.equal(res1.branchDeleted, true);
  assert.equal(res1.skippedReason, '');
  assert.equal(res1.worktreeError, '');
  assert.equal(existsSync(wtClean), false);
  assert.equal(branchExists(repoRoot, 'thread/thr-001-clean'), false);

  // Also verify object-parameter signature defaults removeWorktree=true
  const res2 = await archiveThread({ threadId: 'thr-002' });
  assert.equal(res2.ok, true);
  assert.equal(res2.archived, true);
  assert.equal(res2.worktreeRemoved, true);
  assert.equal(res2.branchDeleted, true);
  assert.equal(res2.skippedReason, '');
  assert.equal(existsSync(wtMerged), false);
  assert.equal(branchExists(repoRoot, 'thread/thr-002-merged'), false);

  const res3 = await archiveThread('thr-003');
  assert.equal(res3.ok, true);
  assert.equal(res3.worktreeRemoved, true);
  assert.equal(res3.branchDeleted, true);
  assert.equal(existsSync(wtUnexcludedRules), false);

  const afterReg = loadRegistry();
  for (const tid of ['thr-001', 'thr-002', 'thr-003']) {
    assert.equal(afterReg.threads[tid].archived, true);
    assert.equal(afterReg.threads[tid].worktreePath, '');
    assert.equal(afterReg.threads[tid].git, null);
  }

  const remainingWorktrees = listGitWorktrees(repoRoot);
  assert.equal(remainingWorktrees.length, 1, 'only main repo checkout should remain in git worktree list');
});

test('default archiveThread() preserves dirty or unmerged worktrees with accurate skippedReason while archiving conversation', async (t) => {
  const { repoRoot, worktreesBase } = createTempGitAndStateEnv(t, 'pt-arch-skip-');

  // Dirty tracked + untracked worktree
  const wtDirty = createWorktreeForThread({
    repoRoot,
    worktreesBase,
    threadId: 'thr-010',
    branch: 'thread/thr-010-dirty',
  });
  writeFileSync(join(wtDirty, 'uncommitted.txt'), 'wip\n', 'utf8');

  // Clean worktree with unmerged commit
  const wtUnmerged = createWorktreeForThread({
    repoRoot,
    worktreesBase,
    threadId: 'thr-011',
    branch: 'thread/thr-011-unmerged',
  });
  writeFileSync(join(wtUnmerged, 'committed.txt'), 'unmerged commit\n', 'utf8');
  execFileSync('git', ['add', 'committed.txt'], { cwd: wtUnmerged });
  execFileSync('git', ['commit', '-m', 'Unmerged change'], { cwd: wtUnmerged });

  // Unmerged commit where baseRef was recorded as 'HEAD' (must fall back to main in repoRoot)
  const wtHeadBase = createWorktreeForThread({
    repoRoot,
    worktreesBase,
    threadId: 'thr-012',
    branch: 'thread/thr-012-headref',
  });
  writeFileSync(join(wtHeadBase, 'headref.txt'), 'unmerged under HEAD baseRef\n', 'utf8');
  execFileSync('git', ['add', 'headref.txt'], { cwd: wtHeadBase });
  execFileSync('git', ['commit', '-m', 'Unmerged with HEAD baseRef'], { cwd: wtHeadBase });

  const reg = loadRegistry();
  reg.threads['thr-010'] = {
    threadId: 'thr-010',
    conversationId: 'conv-skip-010',
    workspaceKey: repoRoot,
    repoRoot,
    worktreePath: wtDirty,
    branch: 'thread/thr-010-dirty',
    baseRef: 'main',
    title: 'Dirty task',
    archived: false,
    git: { exists: true, branch: 'thread/thr-010-dirty', dirtyCount: 1, aheadCount: 0 },
  };
  reg.threads['thr-011'] = {
    threadId: 'thr-011',
    conversationId: 'conv-skip-011',
    workspaceKey: repoRoot,
    repoRoot,
    worktreePath: wtUnmerged,
    branch: 'thread/thr-011-unmerged',
    baseRef: 'main',
    title: 'Unmerged task',
    archived: false,
    git: { exists: true, branch: 'thread/thr-011-unmerged', dirtyCount: 0, aheadCount: 1 },
  };
  reg.threads['thr-012'] = {
    threadId: 'thr-012',
    conversationId: 'conv-skip-012',
    workspaceKey: repoRoot,
    repoRoot,
    worktreePath: wtHeadBase,
    branch: 'thread/thr-012-headref',
    baseRef: 'HEAD',
    title: 'HEAD baseRef task',
    archived: false,
    git: { exists: true, branch: 'thread/thr-012-headref', dirtyCount: 0, aheadCount: 1 },
  };
  saveRegistry(reg);

  const resDirty = await archiveThread('thr-010');
  assert.equal(resDirty.ok, true);
  assert.equal(resDirty.archived, true);
  assert.equal(resDirty.worktreeRemoved, false);
  assert.equal(resDirty.branchDeleted, false);
  assert.equal(resDirty.skippedReason, 'uncommitted_changes');
  assert.ok(resDirty.worktreeError.length > 0);
  assert.equal(existsSync(wtDirty), true);
  assert.equal(branchExists(repoRoot, 'thread/thr-010-dirty'), true);

  const resUnmerged = await archiveThread('thr-011');
  assert.equal(resUnmerged.ok, true);
  assert.equal(resUnmerged.archived, true);
  assert.equal(resUnmerged.worktreeRemoved, false);
  assert.equal(resUnmerged.branchDeleted, false);
  assert.equal(resUnmerged.skippedReason, 'unmerged_commits');
  assert.ok(resUnmerged.worktreeError.length > 0);
  assert.equal(existsSync(wtUnmerged), true);
  assert.equal(branchExists(repoRoot, 'thread/thr-011-unmerged'), true);

  const resHeadBase = await archiveThread('thr-012');
  assert.equal(resHeadBase.ok, true);
  assert.equal(resHeadBase.archived, true);
  assert.equal(resHeadBase.worktreeRemoved, false);
  assert.equal(resHeadBase.skippedReason, 'unmerged_commits');
  assert.equal(existsSync(wtHeadBase), true);

  const afterReg = loadRegistry();
  assert.equal(afterReg.threads['thr-010'].archived, true);
  assert.equal(afterReg.threads['thr-010'].worktreePath, wtDirty);
  assert.equal(afterReg.threads['thr-011'].archived, true);
  assert.equal(afterReg.threads['thr-011'].worktreePath, wtUnmerged);
  assert.equal(afterReg.threads['thr-012'].archived, true);
  assert.equal(afterReg.threads['thr-012'].worktreePath, wtHeadBase);
});

test('cleanupThreadWorktree() supports forceWorktree, deleteBranch=false, already-missing paths, and Windows lock errors', async (t) => {
  const { repoRoot, worktreesBase, cleanups } = createTempGitAndStateEnv(t, 'pt-cleanup-');

  const wtDirty = createWorktreeForThread({
    repoRoot,
    worktreesBase,
    threadId: 'thr-020',
    branch: 'thread/thr-020-force-dirty',
  });
  writeFileSync(join(wtDirty, 'scratch.txt'), 'dirty\n', 'utf8');

  const wtUnmergedKeepBranch = createWorktreeForThread({
    repoRoot,
    worktreesBase,
    threadId: 'thr-021',
    branch: 'thread/thr-021-keep-branch',
  });
  writeFileSync(join(wtUnmergedKeepBranch, 'keep.txt'), 'keep branch\n', 'utf8');
  execFileSync('git', ['add', 'keep.txt'], { cwd: wtUnmergedKeepBranch });
  execFileSync('git', ['commit', '-m', 'Unmerged commit'], { cwd: wtUnmergedKeepBranch });

  const wtMissing = createWorktreeForThread({
    repoRoot,
    worktreesBase,
    threadId: 'thr-022',
    branch: 'thread/thr-022-missing',
  });
  // Delete folder manually on disk to simulate stale worktree entry
  rmSync(wtMissing, { recursive: true, force: true });

  const wtLocked = createWorktreeForThread({
    repoRoot,
    worktreesBase,
    threadId: 'thr-023',
    branch: 'thread/thr-023-locked',
  });

  const reg = loadRegistry();
  reg.threads['thr-020'] = {
    threadId: 'thr-020',
    conversationId: 'conv-clean-020',
    workspaceKey: repoRoot,
    repoRoot,
    worktreePath: wtDirty,
    branch: 'thread/thr-020-force-dirty',
    baseRef: 'main',
    archived: true,
    git: { exists: true, branch: 'thread/thr-020-force-dirty', dirtyCount: 1, aheadCount: 0 },
  };
  reg.threads['thr-021'] = {
    threadId: 'thr-021',
    conversationId: 'conv-clean-021',
    workspaceKey: repoRoot,
    repoRoot,
    worktreePath: wtUnmergedKeepBranch,
    branch: 'thread/thr-021-keep-branch',
    baseRef: 'main',
    archived: true,
    git: { exists: true, branch: 'thread/thr-021-keep-branch', dirtyCount: 0, aheadCount: 1 },
  };
  reg.threads['thr-022'] = {
    threadId: 'thr-022',
    conversationId: 'conv-clean-022',
    workspaceKey: repoRoot,
    repoRoot,
    worktreePath: wtMissing,
    branch: 'thread/thr-022-missing',
    baseRef: 'main',
    archived: true,
    git: { exists: true, branch: 'thread/thr-022-missing', dirtyCount: 0, aheadCount: 0 },
  };
  reg.threads['thr-023'] = {
    threadId: 'thr-023',
    conversationId: 'conv-clean-023',
    workspaceKey: repoRoot,
    repoRoot,
    worktreePath: wtLocked,
    branch: 'thread/thr-023-locked',
    baseRef: 'main',
    archived: true,
    git: { exists: true, branch: 'thread/thr-023-locked', dirtyCount: 0, aheadCount: 0 },
  };
  saveRegistry(reg);

  // 1. Force remove dirty worktree & branch
  const forceRes = await cleanupThreadWorktree('thr-020', { forceWorktree: true });
  assert.equal(forceRes.ok, true);
  assert.equal(forceRes.worktreeRemoved, true);
  assert.equal(forceRes.branchDeleted, true);
  assert.equal(existsSync(wtDirty), false);
  assert.equal(branchExists(repoRoot, 'thread/thr-020-force-dirty'), false);

  // 2. Force remove unmerged worktree while keeping branch when deleteBranch: false
  const keepBrRes = await cleanupThreadWorktree('thr-021', {
    forceWorktree: true,
    deleteBranch: false,
  });
  assert.equal(keepBrRes.ok, true);
  assert.equal(keepBrRes.worktreeRemoved, true);
  assert.equal(keepBrRes.branchDeleted, false);
  assert.equal(existsSync(wtUnmergedKeepBranch), false);
  assert.equal(branchExists(repoRoot, 'thread/thr-021-keep-branch'), true);

  // 3. Already-missing worktree path prunes cleanly and clears stale registry fields
  const missingRes = await cleanupThreadWorktree('thr-022');
  assert.equal(missingRes.ok, true);
  assert.equal(missingRes.pruned, true);
  assert.equal(missingRes.worktreeError, '');
  assert.equal(branchExists(repoRoot, 'thread/thr-022-missing'), false);

  const afterMissingReg = loadRegistry();
  for (const tid of ['thr-020', 'thr-021', 'thr-022']) {
    assert.equal(afterMissingReg.threads[tid].worktreePath, '');
    assert.equal(afterMissingReg.threads[tid].git, null);
  }

  // 4. Windows directory lock surfaces clean worktreeError without crashing
  if (process.platform === 'win32') {
    const locker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      cwd: wtLocked,
      stdio: 'ignore',
    });
    cleanups.push(
      () =>
        new Promise((resolveKill) => {
          if (locker.exitCode !== null || locker.killed) {
            resolveKill();
            return;
          }
          locker.once('exit', () => resolveKill());
          locker.kill();
        }),
    );

    // Give the child process a brief moment to acquire its cwd handle
    await new Promise((r) => setTimeout(r, 150));

    const lockedRes = await cleanupThreadWorktree('thr-023', { forceWorktree: true });
    assert.equal(lockedRes.ok, false);
    assert.equal(lockedRes.worktreeRemoved, false);
    assert.ok(lockedRes.worktreeError.length > 0);
    assert.equal(existsSync(wtLocked), true);
    assert.equal(loadRegistry().threads['thr-023'].worktreePath, wtLocked);

    await new Promise((resolveExit) => {
      if (locker.exitCode !== null) {
        resolveExit();
        return;
      }
      locker.once('exit', () => resolveExit());
      locker.kill();
    });

    const unlockedRes = await cleanupThreadWorktree('thr-023', { forceWorktree: true });
    assert.equal(unlockedRes.ok, true);
    assert.equal(unlockedRes.worktreeRemoved, true);
    assert.equal(loadRegistry().threads['thr-023'].worktreePath, '');
    assert.equal(loadRegistry().threads['thr-023'].git, null);
  }
});

test('archiveThread() and inspectWorktreeGit() recognize cherry-picked commits and delete source branch via -D', async (t) => {
  const { repoRoot, worktreesBase } = createTempGitAndStateEnv(t, 'pt-arch-cherry-');

  const wtCherry = createWorktreeForThread({
    repoRoot,
    worktreesBase,
    threadId: 'thr-030',
    branch: 'thread/thr-030-cherry',
  });
  writeFileSync(join(wtCherry, 'cherry.txt'), 'cherry picked change\n', 'utf8');
  execFileSync('git', ['add', 'cherry.txt'], { cwd: wtCherry });
  execFileSync('git', ['commit', '-m', 'Cherry feature'], { cwd: wtCherry });
  const cherrySha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: wtCherry,
    encoding: 'utf8',
  }).trim();

  const beforeGit = await inspectWorktreeGit(wtCherry, { baseRef: 'main', repoRoot });
  assert.equal(beforeGit.aheadCount, 1);
  assert.equal(beforeGit.merged, false);

  execFileSync('git', ['cherry-pick', cherrySha], { cwd: repoRoot });

  const afterPickGit = await inspectWorktreeGit(wtCherry, { baseRef: 'main', repoRoot });
  assert.equal(afterPickGit.aheadCount, 1);
  assert.equal(afterPickGit.dirtyCount, 0);
  assert.equal(afterPickGit.merged, true);
  assert.equal(afterPickGit.mergeMethod, 'cherry-pick');

  const wtPartial = createWorktreeForThread({
    repoRoot,
    worktreesBase,
    threadId: 'thr-031',
    branch: 'thread/thr-031-partial',
  });
  writeFileSync(join(wtPartial, 'part1.txt'), 'picked part\n', 'utf8');
  execFileSync('git', ['add', 'part1.txt'], { cwd: wtPartial });
  execFileSync('git', ['commit', '-m', 'Part 1'], { cwd: wtPartial });
  const part1Sha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: wtPartial,
    encoding: 'utf8',
  }).trim();
  writeFileSync(join(wtPartial, 'part2.txt'), 'unpicked part\n', 'utf8');
  execFileSync('git', ['add', 'part2.txt'], { cwd: wtPartial });
  execFileSync('git', ['commit', '-m', 'Part 2'], { cwd: wtPartial });
  execFileSync('git', ['cherry-pick', part1Sha], { cwd: repoRoot });

  const partialGit = await inspectWorktreeGit(wtPartial, { baseRef: 'main', repoRoot });
  assert.equal(partialGit.aheadCount, 2);
  assert.equal(partialGit.merged, false);

  const reg = loadRegistry();
  reg.threads['thr-030'] = {
    threadId: 'thr-030',
    conversationId: 'conv-cherry-030',
    workspaceKey: repoRoot,
    repoRoot,
    worktreePath: wtCherry,
    branch: 'thread/thr-030-cherry',
    baseRef: 'main',
    archived: false,
    git: afterPickGit,
  };
  reg.threads['thr-031'] = {
    threadId: 'thr-031',
    conversationId: 'conv-cherry-031',
    workspaceKey: repoRoot,
    repoRoot,
    worktreePath: wtPartial,
    branch: 'thread/thr-031-partial',
    baseRef: 'main',
    archived: false,
    git: partialGit,
  };
  saveRegistry(reg);

  const resCherry = await archiveThread('thr-030');
  assert.equal(resCherry.ok, true);
  assert.equal(resCherry.worktreeRemoved, true);
  assert.equal(resCherry.branchDeleted, true);
  assert.equal(resCherry.skippedReason, '');
  assert.equal(existsSync(wtCherry), false);
  assert.equal(branchExists(repoRoot, 'thread/thr-030-cherry'), false);

  const resPartial = await archiveThread('thr-031');
  assert.equal(resPartial.ok, true);
  assert.equal(resPartial.worktreeRemoved, false);
  assert.equal(resPartial.branchDeleted, false);
  assert.equal(resPartial.skippedReason, 'unmerged_commits');
  assert.equal(existsSync(wtPartial), true);
  assert.equal(branchExists(repoRoot, 'thread/thr-031-partial'), true);
});

test('inspectWorktreeGit() and cleanupThreadWorktree() unify baseRef fallback through coordinator defaultBranch', async (t) => {
  const { repoRoot, worktreesBase } = createTempGitAndStateEnv(t, 'pt-arch-baseref-');

  execFileSync('git', ['checkout', '-b', 'feature-v2'], { cwd: repoRoot });
  execFileSync('git', ['branch', '-D', 'main'], { cwd: repoRoot });

  const wt = createWorktreeForThread({
    repoRoot,
    worktreesBase,
    threadId: 'thr-040',
    branch: 'thread/thr-040-feat',
    baseRef: 'feature-v2',
  });
  writeFileSync(join(wt, 'feat.txt'), 'feat work\n', 'utf8');
  execFileSync('git', ['add', 'feat.txt'], { cwd: wt });
  execFileSync('git', ['commit', '-m', 'Feature work'], { cwd: wt });
  const featSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: wt,
    encoding: 'utf8',
  }).trim();

  const reg = loadRegistry();
  reg.coordinators[repoRoot] = {
    key: repoRoot,
    conversationId: 'coord-040',
    repoRoot,
    defaultBranch: 'feature-v2',
  };
  reg.threads['thr-040'] = {
    threadId: 'thr-040',
    conversationId: 'conv-feat-040',
    coordinatorId: 'coord-040',
    workspaceKey: repoRoot,
    repoRoot,
    worktreePath: wt,
    branch: 'thread/thr-040-feat',
    baseRef: 'HEAD',
    archived: false,
    git: null,
  };
  saveRegistry(reg);

  const unmergedGit = await inspectWorktreeGit(wt, {
    baseRef: 'HEAD',
    defaultBranch: 'feature-v2',
    repoRoot,
  });
  assert.equal(unmergedGit.aheadCount, 1);
  assert.equal(unmergedGit.merged, false);

  const skipRes = await cleanupThreadWorktree('thr-040');
  assert.equal(skipRes.worktreeRemoved, false);
  assert.equal(skipRes.skippedReason, 'unmerged_commits');

  execFileSync('git', ['cherry-pick', featSha], { cwd: repoRoot });
  const mergedGit = await inspectWorktreeGit(wt, {
    baseRef: 'HEAD',
    defaultBranch: 'feature-v2',
    repoRoot,
  });
  assert.equal(mergedGit.merged, true);
  assert.equal(mergedGit.mergeMethod, 'cherry-pick');

  const okRes = await archiveThread('thr-040');
  assert.equal(okRes.worktreeRemoved, true);
  assert.equal(okRes.branchDeleted, true);
  assert.equal(existsSync(wt), false);
});

test('ensureProjectMemoryFile() injects default merge conventions idempotently without overwriting custom rules', (t) => {
  const { tempRoot } = createTempGitAndStateEnv(t, 'pt-mem-');

  const dirNew = join(tempRoot, 'proj-new');
  const memNew = ensureProjectMemoryFile(dirNew, 'DemoNew');
  const contentNew = readFileSync(memNew, 'utf8');
  assert.match(contentNew, /## Worktree Merge & Archive Conventions/);
  assert.match(contentNew, /project-threads:merge-conventions/);
  assert.match(contentNew, /git cherry-pick/);

  const dirExisting = join(tempRoot, 'proj-existing');
  mkdirSync(join(dirExisting, '.agents', 'rules'), { recursive: true });
  const existingPath = join(dirExisting, '.agents', 'rules', 'project-memory.md');
  const legacyBody = '# Legacy\n\n## Active Decisions & Constraints\n- Keep custom note.\n';
  writeFileSync(existingPath, legacyBody, 'utf8');

  ensureProjectMemoryFile(dirExisting, 'DemoExisting');
  const upgraded = readFileSync(existingPath, 'utf8');
  assert.match(upgraded, /- Keep custom note\./);
  assert.match(upgraded, /## Worktree Merge & Archive Conventions/);

  // Idempotent second call must not duplicate
  ensureProjectMemoryFile(dirExisting, 'DemoExisting');
  const upgradedTwice = readFileSync(existingPath, 'utf8');
  assert.equal(upgradedTwice, upgraded);

  // Custom Chinese merge conventions section must never be overwritten or duplicated
  const dirCustom = join(tempRoot, 'proj-custom');
  mkdirSync(join(dirCustom, '.agents', 'rules'), { recursive: true });
  const customPath = join(dirCustom, '.agents', 'rules', 'project-memory.md');
  const customBody = '# Custom\n\n## 合并规范\n- 一律使用 cherry-pick 合入主仓。\n';
  writeFileSync(customPath, customBody, 'utf8');
  ensureProjectMemoryFile(dirCustom, 'DemoCustom');
  assert.equal(readFileSync(customPath, 'utf8'), customBody);
});

test('static checks: sidecar UI uses zero native dialogs and wires in-DOM modal, cleanup route, and LF line endings', () => {
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const indexHtml = readFileSync(new URL('../sidecars/threads/index.html', import.meta.url), 'utf8');
  const mainMjs = readFileSync(new URL('../sidecars/threads/main.mjs', import.meta.url), 'utf8');
  const serverMjs = readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');
  const storeMjs = readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8');

  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appJs), false, 'app.js must not call native confirm/alert/prompt');
  assert.match(indexHtml, /id="pt-modal-backdrop"/);
  assert.match(appJs, /pt-modal-backdrop/);
  assert.match(appJs, /\/api\/cleanup_worktree/);
  assert.match(appJs, /data-action="clean-wt"/);
  assert.match(appJs, /res\.skippedReason/);
  assert.match(appJs, /res\.worktreeError/);
  assert.match(appJs, /thread\.git\?\.merged/);

  assert.match(mainMjs, /registerDualApi\('\/api\/cleanup_worktree'/);
  assert.match(mainMjs, /parseBool\(data\.removeWorktree,\s*true\)/);

  assert.match(serverMjs, /forceWorktree/);
  assert.match(serverMjs, /deleteBranch/);
  assert.match(serverMjs, /removeWorktree !== undefined \? Boolean\(args\.removeWorktree\) : true/);
  assert.match(serverMjs, /worktreePath/);

  assert.match(storeMjs, /WORKTREE_ADD_TIMEOUT_MS\s*=\s*120_000/);
  assert.match(storeMjs, /cleanupThreadWorktree\(tid/);

  for (const rel of [
    '../lib/store.mjs',
    '../mcp/server.mjs',
    '../sidecars/threads/main.mjs',
    '../tests/archive-worktree.test.mjs',
  ]) {
    const rawBytes = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!rawBytes.includes(Buffer.from('\r')), `${rel} must use LF line endings`);
  }
});

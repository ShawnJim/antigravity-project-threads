import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  archiveMemoryToLegacyTopic,
  buildDefaultMergeConventionsSection,
  buildLegacyV1MergeConventionsSection,
  deleteMemoryTopic,
  ensureProjectMemoryFile,
  evaluateIndexBudget,
  inspectMemoryMigrationStatus,
  listMemoryTopics,
  MERGE_HYGIENE_END_MARKER,
  MERGE_HYGIENE_START_MARKER,
  parseTopicIndexTable,
  readMemoryTopic,
  readProjectMemory,
  recommendTopicsForTask,
  refreshExistingProjectMemoryHygiene,
  THIN_INDEX_SOFT_MAX_BYTES,
  THIN_INDEX_SOFT_MAX_LINES,
  TOPIC_INDEX_END_MARKER,
  TOPIC_INDEX_START_MARKER,
  upgradeManagedMergeConventions,
  validateTopicId,
  writeMemoryTopic,
} from '../lib/memory.mjs';
import {
  buildWorkerPrompt,
  inspectWorktreeGit,
  loadRegistry,
  migrateProjectMemory,
  normalizeKey,
  saveRegistry,
  updateProjectMemory,
} from '../lib/store.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function createTempEnv(t, prefix = 'pt-topic-mem-') {
  const tempRoot = mkdtempSync(join(tmpdir(), prefix));
  const geminiDir = join(tempRoot, 'gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  mkdirSync(appDataDir, { recursive: true });

  const envKeys = [
    'ANTIGRAVITY_GEMINI_DIR',
    'ANTIGRAVITY_APP_DATA_DIR',
    'ANTIGRAVITY_LS_ADDRESS',
    'ANTIGRAVITY_CSRF_TOKEN',
    'ANTIGRAVITY_AGENTAPI_EXE',
  ];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;
  delete process.env.ANTIGRAVITY_LS_ADDRESS;
  delete process.env.ANTIGRAVITY_CSRF_TOKEN;
  delete process.env.ANTIGRAVITY_AGENTAPI_EXE;

  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Ignore Windows transient cleanup lock
    }
  });

  return { tempRoot, geminiDir, appDataDir };
}

function initTempGitRepo(repoDir) {
  mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-b', 'dev'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  writeFileSync(join(repoDir, 'README.md'), '# Demo Repo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
}

function buildOversizedLegacyMemory(lineCount = 75) {
  const lines = [
    '# LegacyProject Shared Memory',
    '',
    '## Architecture & Conventions',
    '- Legacy monolith memory without topic files.',
    '',
    '## Active Decisions & Constraints',
  ];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(`- Rule #${i}: keep module-${i} strictly backwards compatible with invariant-${i}.`);
  }
  lines.push('', buildLegacyV1MergeConventionsSection(), '');
  return lines.join('\n');
}

test('A1-A3 default merge conventions template and Layer 1 lossless in-place upgrade', (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-mem-l1-');

  // 1. Default template verifies A1 (acceptance before archive), A2 (git fetch + full test/build), A3 (re-increment monotonic version), and compact bullet count
  const v2Section = buildDefaultMergeConventionsSection();
  assert.ok(v2Section.includes(MERGE_HYGIENE_START_MARKER));
  assert.ok(v2Section.includes(MERGE_HYGIENE_END_MARKER));
  assert.ok(v2Section.includes('<!-- project-threads:merge-conventions -->'));
  assert.match(v2Section, /until the user confirms acceptance or requests archiving/i);
  assert.match(v2Section, /git fetch/i);
  assert.match(v2Section, /full test\/build suite/i);
  assert.match(v2Section, /monotonic version or migration sequence/i);
  const bulletLines = v2Section.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(bulletLines.length, 4, 'A1-A3 must stay within 4 concise bullets (+0 net bullets)');

  // 2. Legacy repo with unmarked v1 default merge section + user custom notes upgrades in-place without touching custom content
  const repoLegacy = join(tempRoot, 'legacy-repo');
  initTempGitRepo(repoLegacy);
  const rulesDir = join(repoLegacy, '.agents', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  const memPath = join(rulesDir, 'project-memory.md');
  const customSection = [
    '# LegacyRepo Shared Memory',
    '',
    '## Active Decisions & Constraints',
    '- Custom rule alpha: preserve exact user wording.',
    '- Custom rule beta: never drop this line.',
    '',
    buildLegacyV1MergeConventionsSection(),
    '',
  ].join('\n');
  writeFileSync(memPath, customSection, 'utf8');

  ensureProjectMemoryFile(repoLegacy, 'LegacyRepo');
  const upgraded = readFileSync(memPath, 'utf8');
  assert.ok(upgraded.includes(MERGE_HYGIENE_START_MARKER), 'unmodified legacy v1 section must upgrade to v2');
  assert.match(upgraded, /until the user confirms acceptance or requests archiving/i);
  assert.match(upgraded, /Custom rule alpha: preserve exact user wording\./);
  assert.match(upgraded, /Custom rule beta: never drop this line\./);

  // Layer 1 automatically creates .agents/memory/ and updates .git/info/exclude so git status remains clean
  assert.equal(existsSync(join(repoLegacy, '.agents', 'memory')), true);
  const excludeText = readFileSync(join(repoLegacy, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(excludeText.includes('.agents/rules/project-memory.md'));
  assert.ok(excludeText.includes('.agents/memory/'));
  const gitStatus = execFileSync('git', ['status', '--porcelain'], {
    cwd: repoLegacy,
    encoding: 'utf8',
  }).trim();
  assert.equal(gitStatus, '', 'git status must stay clean after Layer 1 upgrade');

  // 3. User-customized merge section MUST NEVER be overwritten
  const repoCustom = join(tempRoot, 'custom-repo');
  initTempGitRepo(repoCustom);
  mkdirSync(join(repoCustom, '.agents', 'rules'), { recursive: true });
  const customMergeBody = [
    '# CustomRepo Shared Memory',
    '',
    '## Worktree Merge & Archive Conventions',
    '<!-- project-threads:merge-conventions -->',
    '- **Worktree Isolation**: Custom team rule that must NOT be overwritten.',
    '- **Archive & Auto-Cleanup**: Custom archiving policy.',
    '',
  ].join('\n');
  const customMemPath = join(repoCustom, '.agents', 'rules', 'project-memory.md');
  writeFileSync(customMemPath, customMergeBody, 'utf8');

  const check = upgradeManagedMergeConventions(customMergeBody);
  assert.equal(check.changed, false);
  assert.equal(check.status, 'customized');

  ensureProjectMemoryFile(repoCustom, 'CustomRepo');
  assert.equal(readFileSync(customMemPath, 'utf8'), customMergeBody);
  const hy = refreshExistingProjectMemoryHygiene(repoCustom);
  assert.equal(hy.upgraded, false);
  assert.equal(readFileSync(customMemPath, 'utf8'), customMergeBody);
});

test('validateTopicId blocks path traversal, illegal characters, and reserved names', () => {
  assert.equal(validateTopicId('ls-rpc'), 'ls-rpc');
  assert.equal(validateTopicId('Sidecar-UI-2'), 'sidecar-ui-2');
  assert.equal(validateTopicId('legacy'), 'legacy');
  assert.equal(validateTopicId('legacy-2'), 'legacy-2');

  const badIds = [
    '',
    '   ',
    '../secret',
    '..\\secret',
    'a/b',
    'a\\b',
    '..',
    '.hidden',
    'topic.md',
    'has space',
    'foo--bar',
    '-leading',
    'trailing-',
    'con',
    'nul',
    'com1',
    'index',
    'project-memory',
    'a'.repeat(65),
  ];
  for (const bad of badIds) {
    assert.throws(() => validateTopicId(bad), /Invalid topic ID|Topic ID is required/, `must reject "${bad}"`);
  }
});

test('two-tier topic CRUD keeps thin index table synced, warns on budget overflow, and stays backward-compatible without topic', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-mem-crud-');
  const repoDir = join(tempRoot, 'demo-repo');
  initTempGitRepo(repoDir);

  ensureProjectMemoryFile(repoDir, 'DemoRepo');

  // Create two topics
  const res1 = writeMemoryTopic({
    baseDir: repoDir,
    projectName: 'DemoRepo',
    topic: 'ls-rpc',
    title: 'LS RPC & Model Catalog',
    keywords: ['ls-client', 'agentapi', 'CreateConversation'],
    summary: 'Endpoint discovery, model enum switching, and RPC headers.',
    content: '# LS RPC & Model Catalog\n\n- Always send Connect-Protocol-Version: 1.\n',
  });
  assert.equal(res1.topic.id, 'ls-rpc');
  assert.equal(res1.topics.length, 1);
  assert.ok(existsSync(join(repoDir, '.agents', 'memory', 'ls-rpc.md')));

  const res2 = writeMemoryTopic({
    baseDir: repoDir,
    projectName: 'DemoRepo',
    topic: 'sidecar-ui',
    title: 'Sidecar UI Constraints',
    keywords: ['sidecars/threads/', 'app.js', 'DOM'],
    summary: 'No native dialogs; isolate poll redraws from editor drafts.',
    content: '# Sidecar UI Constraints\n\n- Never use window.confirm.\n',
  });
  assert.equal(res2.topics.length, 2);

  // Verify thin index table contains both topics cleanly
  const mem = readProjectMemory(repoDir);
  assert.ok(mem.content.includes(TOPIC_INDEX_START_MARKER));
  assert.ok(mem.content.includes(TOPIC_INDEX_END_MARKER));
  const parsedTable = parseTopicIndexTable(mem.content);
  assert.equal(parsedTable.hasTable, true);
  assert.deepEqual(
    parsedTable.entries.map((e) => e.id),
    ['ls-rpc', 'sidecar-ui'],
  );

  // Append to topic preserves metadata & appends content
  const appended = writeMemoryTopic({
    baseDir: repoDir,
    projectName: 'DemoRepo',
    topic: 'sidecar-ui',
    mode: 'append',
    content: 'Use in-DOM #pt-modal for destructive actions.',
  });
  assert.match(appended.topic.content, /Never use window\.confirm\./);
  assert.match(appended.topic.content, /Use in-DOM #pt-modal/);
  assert.equal(appended.topic.title, 'Sidecar UI Constraints');
  assert.deepEqual(appended.topic.keywords, ['sidecars/threads/', 'app.js', 'DOM']);

  // Delete one topic updates disk and thin index table
  const del = deleteMemoryTopic({
    baseDir: repoDir,
    projectName: 'DemoRepo',
    topic: 'ls-rpc',
  });
  assert.equal(del.deleted, true);
  assert.equal(existsSync(join(repoDir, '.agents', 'memory', 'ls-rpc.md')), false);
  const afterDelTable = parseTopicIndexTable(readProjectMemory(repoDir).content);
  assert.deepEqual(
    afterDelTable.entries.map((e) => e.id),
    ['sidecar-ui'],
  );

  // Legacy mode (no topic param) via updateProjectMemory remains 100% compatible and reports budget warning when oversized
  const appendedThin = await updateProjectMemory({
    workspacePath: repoDir,
    mode: 'append',
    content: 'Keep global guardrails concise.',
  });
  assert.equal(appendedThin.action, 'save_index');
  assert.match(appendedThin.content, /Keep global guardrails concise\./);

  const hugeText = Array.from({ length: THIN_INDEX_SOFT_MAX_LINES + 10 }, (_, i) => `- Line ${i + 1}`).join('\n');
  const budgetRes = evaluateIndexBudget(hugeText);
  assert.equal(budgetRes.overBudget, true);
  assert.equal(budgetRes.overLines, true);
  assert.ok(budgetRes.budgetWarning.includes(String(THIN_INDEX_SOFT_MAX_LINES)));

  const replacedOversized = await updateProjectMemory({
    workspacePath: repoDir,
    mode: 'replace',
    content: `# Huge\n${hugeText}\n`,
  });
  assert.equal(replacedOversized.budget.overBudget, true);
  assert.ok(replacedOversized.budgetWarning.length > 0);
  // Existing disk topic index is preserved even when replacing thin index without manual table
  assert.equal(parseTopicIndexTable(replacedOversized.content).entries.length, 1);

  // Delete last topic removes managed index block cleanly
  deleteMemoryTopic({ baseDir: repoDir, projectName: 'DemoRepo', topic: 'sidecar-ui' });
  assert.equal(listMemoryTopics(repoDir).length, 0);
  assert.equal(readProjectMemory(repoDir).content.includes(TOPIC_INDEX_START_MARKER), false);
});

test('worktree broadcast syncs thin index + topics + deletions and keeps git status clean', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-mem-wt-');
  const repoDir = join(tempRoot, 'main-repo');
  initTempGitRepo(repoDir);
  const wtDir = join(tempRoot, 'wt-thr-001');
  execFileSync('git', ['worktree', 'add', '-b', 'thread/thr-001-demo', wtDir, 'dev'], {
    cwd: repoDir,
    stdio: 'ignore',
  });

  const key = normalizeKey(repoDir);
  const reg = loadRegistry();
  reg.coordinators[key] = {
    key,
    conversationId: 'coord-wt-1',
    workspacePath: repoDir,
    repoRoot: repoDir,
    defaultBranch: 'dev',
    title: '[Coordinator] MainRepo',
  };
  reg.threads['thr-001'] = {
    threadId: 'thr-001',
    conversationId: 'conv-wt-1',
    coordinatorId: 'coord-wt-1',
    workspaceKey: key,
    repoRoot: repoDir,
    worktreePath: wtDir,
    branch: 'thread/thr-001-demo',
    baseRef: 'dev',
    title: 'Test Worktree Sync',
    archived: false,
  };
  saveRegistry(reg);

  await updateProjectMemory({
    workspacePath: repoDir,
    coordinatorId: 'coord-wt-1',
    topic: 'registry-concurrency',
    title: 'Registry Concurrency',
    keywords: ['store.mjs', 'mutateRegistry'],
    summary: 'Always use mutateRegistry for registry writes.',
    mode: 'replace',
    content: '# Registry Concurrency\n\n- Use mutateRegistry.\n',
  });

  // Worktree must have both thin index and topic file
  const wtIndexPath = join(wtDir, '.agents', 'rules', 'project-memory.md');
  const wtTopicPath = join(wtDir, '.agents', 'memory', 'registry-concurrency.md');
  assert.equal(existsSync(wtIndexPath), true);
  assert.equal(existsSync(wtTopicPath), true);
  assert.match(readFileSync(wtTopicPath, 'utf8'), /Use mutateRegistry/);

  // Both main repo and worktree must have zero dirty/untracked pollution
  const wtPorcelain = execFileSync('git', ['status', '--porcelain'], {
    cwd: wtDir,
    encoding: 'utf8',
  }).trim();
  assert.equal(wtPorcelain, '', 'worktree git status must ignore .agents/memory/ and .agents/rules/');
  const wtGit = await inspectWorktreeGit(wtDir, { baseRef: 'dev', defaultBranch: 'dev', repoRoot: repoDir });
  assert.equal(wtGit.dirtyCount, 0);

  // Deleting topic removes it from the active worktree as well
  await updateProjectMemory({
    workspacePath: repoDir,
    coordinatorId: 'coord-wt-1',
    topic: 'registry-concurrency',
    mode: 'delete',
  });
  assert.equal(existsSync(wtTopicPath), false, 'deleted topic must be cleaned from active worktree');
});

test('recommendTopicsForTask and buildWorkerPrompt inject only top 1-2 matched topic paths with zero unrelated leakage', () => {
  const topics = [
    {
      id: 'ls-rpc',
      title: 'LS RPC & Model Catalog',
      keywords: ['ls-client', 'agentapi', 'CreateConversation'],
      summary: 'LS discovery and model switching.',
      relativePath: '.agents/memory/ls-rpc.md',
    },
    {
      id: 'registry-concurrency',
      title: 'Registry Concurrency',
      keywords: ['store.mjs', 'mutateRegistry', 'syncThreads'],
      summary: 'Locking and tombstone invariants.',
      relativePath: '.agents/memory/registry-concurrency.md',
    },
    {
      id: 'sidecar-ui',
      title: 'Sidecar UI Constraints',
      keywords: ['sidecars/threads/', 'app.js', 'DOM', 'toast'],
      summary: 'In-DOM modal and poll redraw isolation.',
      relativePath: '.agents/memory/sidecar-ui.md',
    },
    {
      id: 'git-worktree-release',
      title: 'Git Worktree & Release',
      keywords: ['worktree', 'cherry-pick', 'stable', 'release'],
      summary: 'Dual-branch release and Windows worktree cleanup.',
      relativePath: '.agents/memory/git-worktree-release.md',
    },
  ];

  // 1. Matches sidecar-ui strongly via path + keyword; unrelated topics are excluded
  const recUi = recommendTopicsForTask({
    title: '优化 sidecars/threads/app.js 弹窗与 toast 体验',
    taskPrompt: '请调整 DOM 弹窗交互并补齐单测。',
    topics,
    maxTopics: 2,
  });
  assert.equal(recUi.length, 1);
  assert.equal(recUi[0].id, 'sidecar-ui');

  // 2. Cap strictly at maxTopics=2 even if 3 topics match
  const recMulti = recommendTopicsForTask({
    title: 'Fix store.mjs mutateRegistry and sidecars/threads/app.js worktree modal',
    taskPrompt: 'Also inspect ls-client CreateConversation.',
    topics,
    maxTopics: 2,
  });
  assert.equal(recMulti.length, 2);

  // 3. Unrelated task produces zero recommended topics
  const recNone = recommendTopicsForTask({
    title: 'Update README badge colors',
    taskPrompt: 'Polish documentation wording only.',
    topics,
    maxTopics: 2,
  });
  assert.equal(recNone.length, 0);

  // 4. buildWorkerPrompt injects recommended path in worktree without dumping topic body or unrelated topics
  const zhPrompt = buildWorkerPrompt({
    threadId: 'thr-083',
    title: '修复 app.js 弹窗',
    taskPrompt: '请修复 sidecars/threads/app.js 中的 DOM 交互。',
    worktreePath: '/tmp/wt/thr-083',
    repoRoot: '/tmp/repo',
    branch: 'thread/thr-083-fix',
    baseRef: 'dev',
    memoryText: '# Thin Index\n- Keep concise.',
    recommendedTopics: recUi,
  });
  assert.match(zhPrompt, /## 推荐按需查阅的专题知识/);
  assert.match(zhPrompt, /\.agents\/memory\/sidecar-ui\.md/);
  assert.match(zhPrompt, /read_file/);
  assert.doesNotMatch(zhPrompt, /ls-rpc\.md/);
  assert.doesNotMatch(zhPrompt, /registry-concurrency\.md/);

  const enPromptNoRec = buildWorkerPrompt({
    threadId: 'thr-084',
    title: 'Polish README',
    taskPrompt: 'Fix typo in README.',
    repoRoot: '/tmp/repo',
    memoryText: '# Thin Index\n- Keep concise.',
    recommendedTopics: [],
  });
  assert.doesNotMatch(enPromptNoRec, /Recommended On-Demand Topic Files/);
});

test('Layer 2 migration diagnostics, lossless archive to legacy (with collision protection), and fail-closed scope/retired guards', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-mem-l2-');
  const repoA = join(tempRoot, 'repo-a');
  const repoB = join(tempRoot, 'repo-b');
  initTempGitRepo(repoA);
  initTempGitRepo(repoB);

  const keyA = normalizeKey(repoA);
  const keyB = normalizeKey(repoB);
  const wtA = join(tempRoot, 'wt-a-1');
  execFileSync('git', ['worktree', 'add', '-b', 'thread/thr-010-a', wtA, 'dev'], {
    cwd: repoA,
    stdio: 'ignore',
  });

  // Oversized flat memory in repoA
  mkdirSync(join(repoA, '.agents', 'rules'), { recursive: true });
  const oversizedText = buildOversizedLegacyMemory(72);
  writeFileSync(join(repoA, '.agents', 'rules', 'project-memory.md'), oversizedText, 'utf8');

  const diagBefore = inspectMemoryMigrationStatus(repoA);
  assert.equal(diagBefore.needsMigration, true);
  assert.equal(diagBefore.reason, 'flat_oversized_memory');
  assert.ok(diagBefore.lineCount > THIN_INDEX_SOFT_MAX_LINES);
  assert.equal(diagBefore.suggestedLegacyTopicId, 'legacy');

  // Register coordinators for A (with one retired coordinator) and B
  const reg = loadRegistry();
  reg.coordinators[keyA] = {
    key: keyA,
    conversationId: 'coord-a-active',
    retiredCoordinatorIds: ['coord-a-retired'],
    workspacePath: repoA,
    repoRoot: repoA,
    defaultBranch: 'dev',
    title: '[Coordinator] RepoA',
  };
  reg.coordinators[keyB] = {
    key: keyB,
    conversationId: 'coord-b-active',
    workspacePath: repoB,
    repoRoot: repoB,
    defaultBranch: 'dev',
    title: '[Coordinator] RepoB',
  };
  reg.threads['thr-010'] = {
    threadId: 'thr-010',
    conversationId: 'conv-wt-a1',
    coordinatorId: 'coord-a-active',
    workspaceKey: keyA,
    repoRoot: repoA,
    worktreePath: wtA,
    branch: 'thread/thr-010-a',
    baseRef: 'dev',
    title: 'Active WT A',
    archived: false,
  };
  saveRegistry(reg);

  // 1. Fail-closed checks: retired coordinator, cross-project coordinator, and missing scope are rejected
  await assert.rejects(
    () =>
      migrateProjectMemory({
        workspacePath: repoA,
        coordinatorId: 'coord-a-retired',
        action: 'archive_legacy',
      }),
    /has been retired/,
  );
  await assert.rejects(
    () =>
      migrateProjectMemory({
        workspacePath: repoA,
        coordinatorId: 'coord-b-active',
        action: 'archive_legacy',
      }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () =>
      updateProjectMemory({
        workspacePath: repoA,
        coordinatorId: 'coord-b-active',
        topic: 'evil',
        mode: 'replace',
        content: 'should fail',
      }),
    /Cross-project access denied/,
  );
  await assert.rejects(
    () => migrateProjectMemory({ action: 'archive_legacy' }),
    /Unable to resolve project scope/,
  );

  // 2. Lossless archive to legacy.md succeeds, preserves 100% original text, resets thin index, and syncs worktree
  const archRes = await migrateProjectMemory({
    workspacePath: repoA,
    coordinatorId: 'coord-a-active',
    action: 'archive_legacy',
  });
  assert.equal(archRes.ok, true);
  assert.equal(archRes.action, 'archive_legacy');
  assert.equal(archRes.legacyTopic.id, 'legacy');
  assert.equal(archRes.legacyTopic.content.trim(), oversizedText.trim());
  assert.ok(archRes.budget.lineCount <= THIN_INDEX_SOFT_MAX_LINES);
  assert.equal(archRes.migration.needsMigration, false);
  assert.ok(existsSync(join(wtA, '.agents', 'memory', 'legacy.md')), 'legacy topic must broadcast to worktree');

  // 3. Collision protection: pre-existing legacy.md is NEVER overwritten; second archive creates legacy-2.md
  const secondOversized = buildOversizedLegacyMemory(68);
  writeFileSync(join(repoA, '.agents', 'rules', 'project-memory.md'), secondOversized, 'utf8');
  const legacy1Before = readFileSync(join(repoA, '.agents', 'memory', 'legacy.md'), 'utf8');

  const archRes2 = archiveMemoryToLegacyTopic({
    baseDir: repoA,
    projectName: 'RepoA',
  });
  assert.equal(archRes2.legacyTopic.id, 'legacy-2');
  assert.equal(readFileSync(join(repoA, '.agents', 'memory', 'legacy.md'), 'utf8'), legacy1Before);
  assert.equal(readMemoryTopic(repoA, '', 'legacy-2').content.trim(), secondOversized.trim());

  // 4. request_coordinator_split sends structured instruction via agentapi shim and rejects retired/cross-project callers
  const captureFile = join(tempRoot, 'agentapi-capture.json');
  const fakeScript = join(tempRoot, 'fake-agentapi.mjs');
  writeFileSync(
    fakeScript,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(captureFile)}, JSON.stringify(process.argv.slice(2)), 'utf8');\n`,
    'utf8',
  );
  const shimPath =
    process.platform === 'win32'
      ? join(tempRoot, 'agentapi.cmd')
      : join(tempRoot, 'agentapi.sh');
  if (process.platform === 'win32') {
    writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`, 'utf8');
  } else {
    writeFileSync(shimPath, `#!/usr/bin/env sh\n"${process.execPath}" "${fakeScript}" "$@"\n`, {
      mode: 0o755,
    });
  }
  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59999';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf-token';
  process.env.ANTIGRAVITY_AGENTAPI_EXE = shimPath;

  await assert.rejects(
    () =>
      migrateProjectMemory({
        workspacePath: repoA,
        coordinatorId: 'coord-a-retired',
        action: 'request_coordinator_split',
      }),
    /has been retired/,
  );

  const splitRes = await migrateProjectMemory({
    workspacePath: repoA,
    coordinatorId: 'coord-a-active',
    action: 'request_coordinator_split',
  });
  assert.equal(splitRes.ok, true);
  assert.equal(splitRes.action, 'request_coordinator_split');
  assert.equal(splitRes.coordinatorId, 'coord-a-active');
  assert.equal(existsSync(captureFile), true);
  const capturedArgs = JSON.parse(readFileSync(captureFile, 'utf8'));
  const joinedArgs = capturedArgs.join(' ');
  assert.match(joinedArgs, /coord-a-active/);
  assert.match(joinedArgs, /MEMORY_MIGRATION_REQUEST/);
});

test('MCP stdio server supports update_project_memory topic CRUD, budget notices, legacy mode, and traversal blocking', async (t) => {
  const { tempRoot, geminiDir, appDataDir } = createTempEnv(t, 'pt-mem-mcp-');
  const repoDir = join(tempRoot, 'mcp-repo');
  initTempGitRepo(repoDir);

  const child = spawn(process.execPath, ['mcp/server.mjs'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: geminiDir,
      ANTIGRAVITY_APP_DATA_DIR: appDataDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    try {
      child.kill();
    } catch {
      // Ignore
    }
  });

  let stdoutBuf = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const resolveFn = pending.get(msg.id);
        pending.delete(msg.id);
        resolveFn(msg);
      }
    }
  });

  let rpcId = 1;
  const callRpc = (method, params = {}) =>
    new Promise((resolveFn, rejectFn) => {
      const id = rpcId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectFn(new Error(`RPC timeout for ${method}`));
      }, 8000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolveFn(msg);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  await callRpc('initialize', { protocolVersion: '2024-11-05' });
  const toolsList = await callRpc('tools/list');
  const memTool = toolsList.result.tools.find((x) => x.name === 'update_project_memory');
  assert.ok(memTool);
  assert.match(memTool.description, /mode="read"[\s\S]*mode="replace"/i);
  assert.ok(memTool.inputSchema.properties.topic);
  assert.deepEqual(memTool.inputSchema.properties.mode.enum, ['read', 'append', 'replace', 'list', 'delete']);

  // Create topic via MCP
  const createRes = await callRpc('tools/call', {
    name: 'update_project_memory',
    arguments: {
      workspacePath: repoDir,
      topic: 'api-auth',
      title: 'API Auth',
      keywords: ['oauth', 'jwt'],
      summary: 'Token refresh rules.',
      mode: 'replace',
      content: '# API Auth\n\n- Rotate refresh tokens safely.\n',
    },
  });
  assert.equal(createRes.result.isError, undefined);
  assert.equal(createRes.result.structuredContent.topic.id, 'api-auth');

  // List topics via MCP
  const listRes = await callRpc('tools/call', {
    name: 'update_project_memory',
    arguments: {
      workspacePath: repoDir,
      mode: 'list',
    },
  });
  assert.match(listRes.result.content[0].text, /api-auth/);
  assert.equal(listRes.result.structuredContent.topics.length, 1);

  // Read topic via MCP
  const readRes = await callRpc('tools/call', {
    name: 'update_project_memory',
    arguments: {
      workspacePath: repoDir,
      topic: 'api-auth',
      mode: 'read',
    },
  });
  assert.match(readRes.result.content[0].text, /Rotate refresh tokens safely/);

  // Path traversal blocked cleanly with isError: true
  const evilRes = await callRpc('tools/call', {
    name: 'update_project_memory',
    arguments: {
      workspacePath: repoDir,
      topic: '../escape',
      mode: 'replace',
      content: 'hack',
    },
  });
  assert.equal(evilRes.result.isError, true);
  assert.match(evilRes.result.content[0].text, /Invalid topic ID/);

  // Delete topic via MCP
  const delRes = await callRpc('tools/call', {
    name: 'update_project_memory',
    arguments: {
      workspacePath: repoDir,
      topic: 'api-auth',
      mode: 'delete',
    },
  });
  assert.equal(delRes.result.structuredContent.deleted, true);
  assert.equal(delRes.result.structuredContent.topics.length, 0);
});

test('static checks: protocol v17, API rev 7, topic_memory gating, dec-022 wording cleanup, zero native dialogs, zero middle dots, and LF endings', (t) => {
  const hookMjs = readFileSync(new URL('../scripts/hook-handler.mjs', import.meta.url), 'utf8');
  const skillMd = readFileSync(new URL('../skills/coord/SKILL.md', import.meta.url), 'utf8');
  const rulesMd = readFileSync(new URL('../rules/AGENTS.md', import.meta.url), 'utf8');
  const serverMjs = readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');
  const storeMjs = readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8');
  const sidecarJson = readFileSync(new URL('../sidecars/threads/sidecar.json', import.meta.url), 'utf8');
  const mainMjs = readFileSync(new URL('../sidecars/threads/main.mjs', import.meta.url), 'utf8');
  const indexHtml = readFileSync(new URL('../sidecars/threads/index.html', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8');
  const themeCss = readFileSync(new URL('../sidecars/threads/theme.css', import.meta.url), 'utf8');

  // 1. Version & capability alignment
  assert.match(hookMjs, /const\s+DIRECTIVE_VERSION\s*=\s*17\s*;/);
  assert.match(mainMjs, /const\s+SERVER_API_REVISION\s*=\s*7\s*;/);
  assert.match(mainMjs, /['"]topic_memory['"]/);
  assert.match(mainMjs, /['"]watchdog_patrol['"]/);
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/memory_save['"]/);
  assert.match(mainMjs, /registerDualApi\(['"]\/api\/memory_migrate['"]/);
  assert.match(mainMjs, /handleSaveMemory[\s\S]*?serverInfo:\s*buildServerInfo\(\)/);
  assert.match(mainMjs, /handleMigrateMemory[\s\S]*?serverInfo:\s*buildServerInfo\(\)/);
  assert.match(appJs, /const\s+EXPECTED_SERVER_API_REVISION\s*=\s*7\s*;/);
  assert.match(appJs, /function\s+supportsTopicMemory\s*\(/);
  assert.match(appJs, /serverCapabilities\.has\(['"]topic_memory['"]\)/);

  // 2. dec-022 brand positioning cleanup (4 residual locations removed; model names in model-format.mjs intact)
  assert.doesNotMatch(sidecarJson, /Claude Projects/i);
  assert.doesNotMatch(skillMd, /Claude\s+(?:Code\s+)?Projects/i);
  assert.doesNotMatch(serverMjs, /Claude\s+(?:Code\s+)?Projects/i);
  assert.doesNotMatch(storeMjs, /Claude\s+(?:Code\s+)?Projects/i);
  assert.match(sidecarJson, /Attention-first parallel engineering workspace/i);
  assert.match(skillMd, /attention-first parallel engineering workspace/i);
  assert.match(serverMjs, /attention-first parallel engineering workspace/i);

  // 3. Anti-bloat memory governance guidance present across SKILL.md, MCP, hook-handler, and rules/AGENTS.md
  assert.match(skillMd, /mode="read"[\s\S]*mode="replace"/i);
  assert.match(rulesMd, /Two-Tier Shared Project Memory/i);
  assert.match(hookMjs, /update_project_memory[\s\S]*mode:\s*"read"[\s\S]*mode:\s*"replace"/i);

  // 4. Sidecar UI structure, modal safety, write-API safety, draft/IME guards
  assert.equal(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/.test(appJs), false);
  for (const id of [
    'mem-migrate-banner',
    'btn-mem-split-coord',
    'btn-mem-archive-legacy',
    'mem-budget-badge',
    'mem-view-bar',
    'mem-topic-meta-fields',
    'mem-topics-section',
    'mem-topics-list',
    'btn-mem-new-topic',
  ]) {
    assert.ok(indexHtml.includes(`id="${id}"`), `index.html missing #${id}`);
  }
  assert.match(themeCss, /\.mem-migrate-banner\s*\{/);
  assert.match(themeCss, /\.mem-topic-card\s*\{/);
  assert.match(themeCss, /:root\[data-theme="light"\]\s+\.mem-migrate-banner\s*\{/);

  const memWriteCalls = [
    ...appJs.matchAll(/postApi\(\s*['"]\/api\/memory_(?:save|migrate)['"][\s\S]*?\}\s*\);/g),
  ];
  assert.ok(memWriteCalls.length >= 4, 'all memory save/delete/migrate calls must use postApi');
  for (const m of memWriteCalls) {
    assert.match(m[0], /timeoutMs:\s*0/);
    assert.match(m[0], /allowGetFallback:\s*false/);
    assert.match(m[0], /expectServerInfo:\s*true/);
  }
  assert.match(appJs, /res\.action\s*!==\s*['"]delete_topic['"]/);
  assert.match(appJs, /res\.action\s*!==\s*['"]archive_legacy['"]/);
  assert.match(appJs, /res\.action\s*!==\s*['"]request_coordinator_split['"]/);
  assert.match(appJs, /memoryEditorDirty/);
  assert.match(appJs, /memoryImeComposing/);
  assert.match(appJs, /isMemoryInputFocused/);

  // 5. Evaluate I18N across en, zh-CN, zh-TW for all new memory keys & zero middle dot
  const appJsLf = appJs.replace(/\r\n/g, '\n');
  const i18nStart = appJsLf.indexOf('const I18N = {');
  const i18nEnd = appJsLf.indexOf('\n  };\n', i18nStart);
  assert.ok(i18nStart > 0 && i18nEnd > i18nStart);
  const ctx = {};
  vm.runInNewContext(`${appJsLf.slice(i18nStart, i18nEnd + 5)}\nthis.I18N = I18N;`, ctx);
  const memKeys = [
    'memThinIndexTitle',
    'memTopicsTitle',
    'memNewTopicBtn',
    'memBackIndexBtn',
    'memDeleteTopicBtn',
    'memSaveTopicBtn',
    'memMigrateTitle',
    'memMigrateDesc',
    'memMigrateSplitBtn',
    'memMigrateArchiveBtn',
    'memModalDelTitle',
    'memModalDelWarn',
    'memModalArchiveTitle',
    'memModalArchiveWarn',
    'memModalSplitTitle',
    'memModalSplitWarn',
    'memSizeTag',
    'memBudgetWarnText',
    'memTopicExistsErr',
  ];
  assert.match(mainMjs, /createOnly:\s*parseBool\(data\.createOnly,\s*false\)/);
  assert.match(appJs, /createOnly:\s*memoryActiveView\s*===\s*['"]new_topic['"]/);
  assert.match(appJs, /memTopicExistsErr/);
  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    for (const k of memKeys) {
      const val = ctx.I18N[loc][k];
      assert.ok(val !== undefined, `Missing I18N.${loc}.${k}`);
      const rendered = typeof val === 'function' ? val(75, 'legacy') : String(val);
      assert.equal(rendered.includes('\u00B7'), false, `I18N.${loc}.${k} must not contain middle dot`);
    }
  }

  // 6. Strict LF line endings on all .mjs files we added/modified
  for (const rel of [
    '../lib/memory.mjs',
    '../lib/store.mjs',
    '../mcp/server.mjs',
    '../scripts/hook-handler.mjs',
    '../sidecars/threads/main.mjs',
    '../tests/topic-memory.test.mjs',
  ]) {
    const raw = readFileSync(new URL(rel, import.meta.url));
    assert.equal(raw.includes(Buffer.from('\r')), false, `${rel} must use strict LF line endings`);
  }

  // 7. Quick hook-handler v17 upgrade check
  const env = createTempEnv(t, 'pt-v17-hook-');
  const reg = loadRegistry();
  reg.coordinators['__v17_check__'] = {
    key: '__v17_check__',
    conversationId: 'conv-v17-test',
    workspacePath: join(env.tempRoot, 'repo'),
    repoRoot: join(env.tempRoot, 'repo'),
    title: '[Coordinator] V17',
    directiveVersion: 16,
  };
  saveRegistry(reg);
  const hookOut = spawnSync(process.execPath, ['scripts/hook-handler.mjs', 'PreInvocation'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ANTIGRAVITY_GEMINI_DIR: env.geminiDir,
      ANTIGRAVITY_APP_DATA_DIR: env.appDataDir,
    },
    input: JSON.stringify({
      hookEventName: 'PreInvocation',
      conversationId: 'conv-v17-test',
      initialNumSteps: 10,
    }),
    encoding: 'utf8',
  });
  assert.equal(hookOut.status, 0);
  const parsedHook = JSON.parse(hookOut.stdout.trim());
  assert.match(parsedHook.injectSteps[0].systemMessage.systemMessage, /project-memory\.md/);
  assert.equal(loadRegistry().coordinators['__v17_check__'].directiveVersion, 17);
});

test('Sidecar UI behavior: topic_memory capability gating, migration banner, topic list rendering, and draft/IME preservation across refreshes', async () => {
  const appJsLf = readFileSync(new URL('../sidecars/threads/app.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const i18nStart = appJsLf.indexOf('const I18N = {');
  const i18nEnd = appJsLf.indexOf('\n  };\n', i18nStart);
  const memStart = appJsLf.indexOf('  function isMemoryInputFocused() {');
  const memEnd = appJsLf.indexOf('  async function refreshBoard(', memStart);
  assert.ok(i18nStart > 0 && i18nEnd > i18nStart && memStart > 0 && memEnd > memStart);

  const elements = new Map();
  const makeEl = (id) => {
    const classes = new Set();
    const listeners = {};
    const el = {
      id,
      hidden: false,
      disabled: false,
      readOnly: false,
      value: '',
      textContent: '',
      innerHTML: '',
      title: '',
      placeholder: '',
      dataset: {},
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, force) => (force ? classes.add(c) : classes.delete(c)),
        contains: (c) => classes.has(c),
      },
      focus: () => {
        doc.activeElement = el;
      },
      addEventListener: (ev, fn) => {
        listeners[ev] = fn;
      },
      querySelectorAll: () => [],
    };
    elements.set(id, el);
    return el;
  };
  const doc = {
    activeElement: null,
    getElementById: (id) => elements.get(id) || makeEl(id),
  };

  let mockApiResponse = {
    ok: true,
    path: '/repo/.agents/rules/project-memory.md',
    content: '# Thin Index\n- Line 1\n',
    topics: [
      {
        id: 'sidecar-ui',
        title: 'Sidecar UI',
        keywords: ['app.js', 'DOM'],
        summary: 'No native dialogs.',
        lineCount: 18,
        byteSize: 640,
      },
    ],
    budget: { lineCount: 12, byteSize: 400, softMaxLines: 60, softMaxBytes: 2048, overBudget: false },
    migration: { needsMigration: false, lineCount: 12, byteSize: 400, suggestedLegacyTopicId: 'legacy' },
  };

  const sandbox = {
    document: doc,
    URLSearchParams,
    console,
    curLocale: 'zh-CN',
    serverCapabilities: new Set(),
    memoryActiveView: 'index',
    memoryActiveTopicId: '',
    memoryEditorDirty: false,
    memoryImeComposing: false,
    memorySnapshot: null,
    memoryActiveTopicData: null,
    lastMemoryTopicsKey: '',
    activeModalCtx: null,
    lastSnap: { coordinator: { title: '[Coordinator] Demo' } },
    API_READ_TIMEOUT_MS: 10000,
    esc: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    syncHostConversationScope: async () => false,
    buildScopePayload: (extra = {}) => ({ workspace: '/repo', ...extra }),
    fetchJsonWithTimeout: async () => ({ data: mockApiResponse }),
    applyLocale: () => false,
    inspectServerInfo: () => {},
    flashToast: () => {},
    syncModalConfirmButton: () => {},
  };

  const harness = `
    ${appJsLf.slice(i18nStart, i18nEnd + 5)}
    const L = () => I18N[curLocale] || I18N.en;
    function supportsTopicMemory() { return serverCapabilities.has('topic_memory'); }
    const elMemMigrateBanner = document.getElementById('mem-migrate-banner');
    const elLblMemMigrateTitle = document.getElementById('lbl-mem-migrate-title');
    const elMemMigrateBadge = document.getElementById('mem-migrate-badge');
    const elLblMemMigrateDesc = document.getElementById('lbl-mem-migrate-desc');
    const elBtnMemSplitCoord = document.getElementById('btn-mem-split-coord');
    const elBtnMemArchiveLegacy = document.getElementById('btn-mem-archive-legacy');
    const elMemBudgetBadge = document.getElementById('mem-budget-badge');
    const elMemViewBar = document.getElementById('mem-view-bar');
    const elBtnMemBackIndex = document.getElementById('btn-mem-back-index');
    const elMemViewBadge = document.getElementById('mem-view-badge');
    const elBtnMemDelTopic = document.getElementById('btn-mem-del-topic');
    const elMemTopicMetaFields = document.getElementById('mem-topic-meta-fields');
    const elMemTopicId = document.getElementById('mem-topic-id');
    const elMemTopicTitle = document.getElementById('mem-topic-title');
    const elMemTopicKeywords = document.getElementById('mem-topic-keywords');
    const elMemTopicSummary = document.getElementById('mem-topic-summary');
    const elMemEditor = document.getElementById('mem-editor');
    const elMemBudgetWarn = document.getElementById('mem-budget-warn');
    const elMemErr = document.getElementById('mem-err');
    const elMemDirtyPill = document.getElementById('mem-dirty-pill');
    const elMemTopicsSection = document.getElementById('mem-topics-section');
    const elMemTopicsCount = document.getElementById('mem-topics-count');
    const elBtnMemNewTopic = document.getElementById('btn-mem-new-topic');
    const elMemTopicsList = document.getElementById('mem-topics-list');
    const elModalBackdrop = document.getElementById('pt-modal-backdrop');
    const elModalTitle = document.getElementById('pt-modal-title');
    const elModalClose = document.getElementById('pt-modal-close');
    const elModalThread = document.getElementById('pt-modal-thread');
    const elModalWtInfo = document.getElementById('pt-modal-wt-info');
    const elModalRebindBox = document.getElementById('pt-modal-rebind-box');
    const elModalWarn = document.getElementById('pt-modal-warn');
    const elModalRemoveRow = document.getElementById('pt-modal-remove-row');
    const elModalBranchRow = document.getElementById('pt-modal-branch-row');
    const elModalForceRow = document.getElementById('pt-modal-force-row');
    const elModalErr = document.getElementById('pt-modal-err');
    const elModalCancel = document.getElementById('pt-modal-cancel');
    const elModalConfirm = document.getElementById('pt-modal-confirm');
    ${appJsLf.slice(memStart, memEnd)}
    this.api = {
      loadMemory,
      renderMemoryUi,
      setMemoryDirty,
      openNewMemoryTopic,
      openMemoryActionModal,
      setCaps: (arr) => { serverCapabilities = new Set(arr); },
      setIme: (v) => { memoryImeComposing = Boolean(v); },
    };
  `;
  vm.runInNewContext(harness, sandbox);

  // 1. Without topic_memory capability: graceful single-file fallback (topics & migration banner hidden)
  await sandbox.api.loadMemory();
  assert.equal(doc.getElementById('mem-topics-section').hidden, true);
  assert.equal(doc.getElementById('mem-migrate-banner').hidden, true);
  assert.equal(doc.getElementById('mem-editor').value, '# Thin Index\n- Line 1\n');

  // 2. With topic_memory capability: topics card list renders topic ID, title, keywords, and size
  sandbox.api.setCaps(['topic_memory']);
  await sandbox.api.loadMemory();
  assert.equal(doc.getElementById('mem-topics-section').hidden, false);
  assert.match(doc.getElementById('mem-topics-list').innerHTML, /sidecar-ui/);
  assert.match(doc.getElementById('mem-topics-list').innerHTML, /app\.js/);

  // 3. Oversized legacy memory triggers migration banner when capability is present
  mockApiResponse = {
    ...mockApiResponse,
    content: '# Old Oversized Content\n',
    topics: [],
    budget: { lineCount: 88, byteSize: 4200, softMaxLines: 60, softMaxBytes: 2048, overBudget: true },
    migration: { needsMigration: true, lineCount: 88, byteSize: 4200, suggestedLegacyTopicId: 'legacy' },
  };
  await sandbox.api.loadMemory();
  assert.equal(doc.getElementById('mem-migrate-banner').hidden, false);
  assert.match(doc.getElementById('lbl-mem-migrate-desc').textContent, /88/);
  assert.match(doc.getElementById('btn-mem-archive-legacy').textContent, /legacy/);

  // 4. Draft protection & IME guard: background loadMemory MUST NOT overwrite user's unsaved draft or IME text
  doc.getElementById('mem-editor').value = 'User unsaved edit in progress';
  sandbox.api.setMemoryDirty(true);
  mockApiResponse = { ...mockApiResponse, content: '# Server newer snapshot\n' };
  await sandbox.api.loadMemory();
  assert.equal(doc.getElementById('mem-editor').value, 'User unsaved edit in progress');

  // Even when not marked dirty, active IME composition protects editor value
  sandbox.api.setMemoryDirty(false);
  sandbox.api.setIme(true);
  await sandbox.api.loadMemory();
  assert.equal(doc.getElementById('mem-editor').value, 'User unsaved edit in progress');

  // Explicit forceSyncEditor (e.g. clicking Reload) refreshes editor
  sandbox.api.setIme(false);
  await sandbox.api.loadMemory({ forceSyncEditor: true });
  assert.equal(doc.getElementById('mem-editor').value, '# Server newer snapshot\n');
});

test('Opus review P1-1: CRLF oversized memory archives losslessly, and verification failure rolls back legacy file without orphans', (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-mem-p1-1-');
  const repoDir = join(tempRoot, 'crlf-repo');
  initTempGitRepo(repoDir);

  // Build >250 lines with Windows CRLF so CRLF->LF drops >250 bytes (exceeding metadata comment size)
  const crlfLines = [
    '# Windows CRLF Project Shared Memory',
    '',
    '## Active Decisions & Constraints',
    ...Array.from({ length: 260 }, (_, i) => `- CRLF invariant #${i + 1}: preserve line verbatim across archive.`),
    '',
    buildLegacyV1MergeConventionsSection(),
  ];
  const crlfBody = `${crlfLines.join('\r\n')}\r\n`;
  mkdirSync(join(repoDir, '.agents', 'rules'), { recursive: true });
  const memPath = join(repoDir, '.agents', 'rules', 'project-memory.md');
  writeFileSync(memPath, crlfBody, 'utf8');

  // 1. Simulated verification failure MUST roll back the newly written legacy.md and leave zero orphans
  assert.throws(
    () =>
      archiveMemoryToLegacyTopic({
        baseDir: repoDir,
        projectName: 'CrlfRepo',
        _verifyPersisted: () => false,
      }),
    /verification failed/i,
  );
  assert.equal(
    existsSync(join(repoDir, '.agents', 'memory', 'legacy.md')),
    false,
    'failed verification must delete the newly written legacy.md orphan',
  );
  assert.equal(readFileSync(memPath, 'utf8'), crlfBody, 'source project-memory.md must remain untouched on rollback');
  const diagAfterFail = inspectMemoryMigrationStatus(repoDir);
  assert.equal(diagAfterFail.needsMigration, true);
  assert.equal(diagAfterFail.topicCount, 0);
  assert.equal(diagAfterFail.suggestedLegacyTopicId, 'legacy');

  // 2. Real archive succeeds on 260+ line CRLF file and preserves 100% normalized content
  const okRes = archiveMemoryToLegacyTopic({
    baseDir: repoDir,
    projectName: 'CrlfRepo',
  });
  assert.equal(okRes.legacyTopic.id, 'legacy');
  assert.equal(okRes.legacyTopic.content, crlfBody.replace(/\r\n/g, '\n'));
  assert.equal(okRes.migration.needsMigration, false);
  assert.equal(okRes.budget.overBudget, false);
  assert.ok(okRes.budget.lineCount <= THIN_INDEX_SOFT_MAX_LINES);
});

test('Opus review P1-2: createOnly / mode="create" rejects duplicate topic IDs instead of silently overwriting', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-mem-p1-2-');
  const repoDir = join(tempRoot, 'dup-topic-repo');
  initTempGitRepo(repoDir);

  // Create initial topic with createOnly: true
  const first = writeMemoryTopic({
    baseDir: repoDir,
    projectName: 'DupRepo',
    topic: 'sidecar-ui',
    title: 'Sidecar UI',
    keywords: ['app.js'],
    summary: 'Original rules.',
    content: '# Sidecar UI\n\n- Original priceless content.\n',
    createOnly: true,
  });
  assert.equal(first.topic.id, 'sidecar-ui');

  // Duplicate create via writeMemoryTopic(createOnly: true) MUST reject and preserve original content
  assert.throws(
    () =>
      writeMemoryTopic({
        baseDir: repoDir,
        projectName: 'DupRepo',
        topic: 'Sidecar-UI',
        title: 'Clobber Attempt',
        content: '# Clobbered\n',
        createOnly: true,
      }),
    (err) => err?.code === 'TOPIC_ALREADY_EXISTS' && /already exists/i.test(err.message),
  );
  assert.match(readMemoryTopic(repoDir, '', 'sidecar-ui').content, /Original priceless content/);

  // Duplicate create via updateProjectMemory({ createOnly: true }) and mode="create" MUST also reject
  await assert.rejects(
    () =>
      updateProjectMemory({
        workspacePath: repoDir,
        topic: 'sidecar-ui',
        mode: 'replace',
        createOnly: true,
        content: '# Overwrite attempt\n',
      }),
    /already exists/i,
  );
  await assert.rejects(
    () =>
      updateProjectMemory({
        workspacePath: repoDir,
        topic: 'sidecar-ui',
        mode: 'create',
        content: '# Overwrite via create mode\n',
      }),
    /already exists/i,
  );
  assert.match(readMemoryTopic(repoDir, '', 'sidecar-ui').content, /Original priceless content/);

  // Explicit edit (createOnly: false) still updates existing topic cleanly
  const edited = await updateProjectMemory({
    workspacePath: repoDir,
    topic: 'sidecar-ui',
    mode: 'replace',
    createOnly: false,
    content: '# Sidecar UI\n\n- Updated intentionally.\n',
  });
  assert.equal(edited.action, 'save_topic');
  assert.match(readMemoryTopic(repoDir, '', 'sidecar-ui').content, /Updated intentionally/);
});

test('Opus review P1-3: initial default template + several topics stay comfortably within soft budget (<=60 lines / 4KB)', (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-mem-p1-3-');
  const repoDir = join(tempRoot, 'budget-repo');
  initTempGitRepo(repoDir);

  assert.equal(THIN_INDEX_SOFT_MAX_LINES, 60);
  assert.equal(THIN_INDEX_SOFT_MAX_BYTES, 4096);

  ensureProjectMemoryFile(repoDir, 'BudgetRepo');
  const initialMem = readProjectMemory(repoDir);
  assert.equal(initialMem.budget.overBudget, false, 'default template must not trigger overBudget');
  assert.equal(initialMem.budgetWarning, '');
  assert.ok(
    initialMem.budget.byteSize < THIN_INDEX_SOFT_MAX_BYTES * 0.65,
    `default template (${initialMem.budget.byteSize}B) should leave ample headroom below ${THIN_INDEX_SOFT_MAX_BYTES}B`,
  );

  for (const [id, title, kws, sum] of [
    ['ls-rpc', 'LS RPC', ['ls-client', 'agentapi'], 'Endpoint discovery and model catalog.'],
    ['sidecar-ui', 'Sidecar UI', ['app.js', 'DOM'], 'In-DOM modal and draft guards.'],
    ['git-release', 'Git Release', ['worktree', 'dev', 'main'], 'Dual-branch release workflow.'],
  ]) {
    const res = writeMemoryTopic({
      baseDir: repoDir,
      projectName: 'BudgetRepo',
      topic: id,
      title,
      keywords: kws,
      summary: sum,
      content: `# ${title}\n\n- Notes for ${id}.\n`,
    });
    assert.equal(res.budget.overBudget, false, `adding topic ${id} should not immediately trip budget`);
    assert.equal(res.budgetWarning, '');
  }

  // Exceeding 4KB bytes still accurately triggers budgetWarning even under 60 lines
  const longBytes = `# Heavy\n${Array.from({ length: 25 }, (_, i) => `- ${'x'.repeat(180)} #${i}`).join('\n')}\n`;
  const overByteEval = evaluateIndexBudget(longBytes);
  assert.equal(overByteEval.overLines, false);
  assert.equal(overByteEval.overBytes, true);
  assert.equal(overByteEval.overBudget, true);
  assert.ok(overByteEval.budgetWarning.includes('4096'));
});

test('Opus review P1-4: request_coordinator_split only delivers to the registered active Coordinator for the project scope', async (t) => {
  const { tempRoot } = createTempEnv(t, 'pt-mem-p1-4-');
  const repoUnbound = join(tempRoot, 'unbound-repo');
  const repoBound = join(tempRoot, 'bound-repo');
  initTempGitRepo(repoUnbound);
  initTempGitRepo(repoBound);

  mkdirSync(join(repoUnbound, '.agents', 'rules'), { recursive: true });
  writeFileSync(join(repoUnbound, '.agents', 'rules', 'project-memory.md'), buildOversizedLegacyMemory(70), 'utf8');
  mkdirSync(join(repoBound, '.agents', 'rules'), { recursive: true });
  writeFileSync(join(repoBound, '.agents', 'rules', 'project-memory.md'), buildOversizedLegacyMemory(70), 'utf8');

  // Wire mock agentapi to verify NO message is sent on rejected cases and exact target on valid case
  const captureFile = join(tempRoot, 'p1-4-agentapi-capture.json');
  const fakeScript = join(tempRoot, 'p1-4-fake-agentapi.mjs');
  writeFileSync(
    fakeScript,
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(captureFile)}, JSON.stringify(process.argv.slice(2)), 'utf8');\n`,
    'utf8',
  );
  const shimPath =
    process.platform === 'win32'
      ? join(tempRoot, 'p1-4-agentapi.cmd')
      : join(tempRoot, 'p1-4-agentapi.sh');
  if (process.platform === 'win32') {
    writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`, 'utf8');
  } else {
    writeFileSync(shimPath, `#!/usr/bin/env sh\n"${process.execPath}" "${fakeScript}" "$@"\n`, {
      mode: 0o755,
    });
  }
  process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59999';
  process.env.ANTIGRAVITY_CSRF_TOKEN = 'test-csrf-p1-4';
  process.env.ANTIGRAVITY_AGENTAPI_EXE = shimPath;

  // 1. Unbound project (no registered coordinator): MUST reject even when caller supplies a regular conversationId or coordinatorId
  await assert.rejects(
    () =>
      migrateProjectMemory({
        workspacePath: repoUnbound,
        conversationId: 'conv-regular-unregistered',
        action: 'request_coordinator_split',
      }),
    /No registered active Coordinator/i,
  );
  await assert.rejects(
    () =>
      migrateProjectMemory({
        workspacePath: repoUnbound,
        coordinatorId: 'conv-regular-unregistered',
        action: 'request_coordinator_split',
      }),
    /No registered active Coordinator/i,
  );
  assert.equal(existsSync(captureFile), false, 'must never invoke agentapi when no Coordinator is registered');

  // 2. Bound project: mismatched explicit coordinatorId MUST be rejected
  const keyBound = normalizeKey(repoBound);
  const reg = loadRegistry();
  reg.coordinators[keyBound] = {
    key: keyBound,
    conversationId: 'coord-bound-active',
    workspacePath: repoBound,
    repoRoot: repoBound,
    defaultBranch: 'dev',
    title: '[Coordinator] BoundRepo',
  };
  saveRegistry(reg);

  await assert.rejects(
    () =>
      migrateProjectMemory({
        workspacePath: repoBound,
        coordinatorId: 'conv-some-other-chat',
        action: 'request_coordinator_split',
      }),
    /does not match the active Coordinator/i,
  );
  assert.equal(existsSync(captureFile), false, 'must never deliver to mismatched explicit coordinatorId');

  // 3. Bound project triggered from a regular host conversation (no explicit coordinatorId) routes strictly to registered active Coordinator
  const splitOk = await migrateProjectMemory({
    workspacePath: repoBound,
    conversationId: 'conv-regular-host-chat',
    action: 'request_coordinator_split',
  });
  assert.equal(splitOk.ok, true);
  assert.equal(splitOk.action, 'request_coordinator_split');
  assert.equal(splitOk.coordinatorId, 'coord-bound-active');
  assert.equal(existsSync(captureFile), true);
  const sentArgs = JSON.parse(readFileSync(captureFile, 'utf8')).join(' ');
  assert.match(sentArgs, /coord-bound-active/);
  assert.doesNotMatch(sentArgs, /conv-regular-host-chat/);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildWorkerPrompt,
  detectPromptLanguage,
  loadRegistry,
  saveRegistry,
} from '../lib/store.mjs';
import {
  extractLatestAssistantText,
  extractThreadCompletion,
  FINAL_SUMMARY_HEADING_RE,
  parseThreadTranscript,
  scanPendingBackgroundTasks,
} from '../lib/transcript.mjs';

function createTempEnv(t, prefix = 'pt-lang-') {
  const tempRoot = mkdtempSync(join(tmpdir(), prefix));
  const geminiDir = join(tempRoot, '.gemini');
  const appDataDir = join(geminiDir, 'antigravity');
  const stateDir = join(appDataDir, 'project-threads');
  mkdirSync(stateDir, { recursive: true });

  const envKeys = ['ANTIGRAVITY_GEMINI_DIR', 'ANTIGRAVITY_APP_DATA_DIR'];
  const prevEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));

  process.env.ANTIGRAVITY_GEMINI_DIR = geminiDir;
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDataDir;

  t.after(() => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  });

  return { tempRoot, geminiDir, appDataDir, stateDir };
}

function writeTranscript(appDataDir, convId, steps) {
  const txDir = join(appDataDir, 'brain', convId, '.system_generated', 'logs');
  mkdirSync(txDir, { recursive: true });
  const txPath = join(txDir, 'transcript.jsonl');
  writeFileSync(txPath, `${steps.map((s) => JSON.stringify(s)).join('\n')}\n`, 'utf8');
  return txPath;
}

test('hook-handler v16 directive, SKILL.md, rules/AGENTS.md, and MCP schema enforce user-language matching and mode-based archiving policy', (t) => {
  const hookHandler = readFileSync(new URL('../scripts/hook-handler.mjs', import.meta.url), 'utf8');
  const skillMd = readFileSync(new URL('../skills/coord/SKILL.md', import.meta.url), 'utf8');
  const rulesMd = readFileSync(new URL('../rules/AGENTS.md', import.meta.url), 'utf8');
  const serverMjs = readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');

  assert.match(hookHandler, /const\s+DIRECTIVE_VERSION\s*=\s*16\s*;/);
  assert.match(skillMd, /Follow the User's Language/i);
  assert.match(skillMd, /title.*taskPrompt.*active conversation language/i);
  assert.match(skillMd, /Read-only.*`createWorktree:\s*false`.*autonomously decide.*`archive_thread`.*without asking the user/i);
  assert.match(
    skillMd,
    /Worktree threads.*`createWorktree:\s*true`.*NOT.*auto-archive before user acceptance.*once the user confirms acceptance.*automatically call `archive_thread`/i,
  );
  assert.doesNotMatch(skillMd, /NEVER auto-archive/i);
  assert.doesNotMatch(skillMd, /archive Worktree code threads once confirmed merged/i);
  assert.match(rulesMd, /title.*taskPrompt.*active conversation language/i);
  assert.match(rulesMd, /read-only.*`createWorktree:\s*false`.*autonomously decide.*`archive_thread`.*without asking the user/i);
  assert.match(
    rulesMd,
    /Worktree threads.*`createWorktree:\s*true`.*NOT.*auto-archive before user acceptance.*once the user confirms acceptance.*automatically call `archive_thread`/i,
  );
  assert.doesNotMatch(rulesMd, /NEVER auto-archive/i);
  assert.doesNotMatch(rulesMd, /archive Worktree code threads once confirmed merged/i);
  assert.match(rulesMd, /### Thread Summary.*### 线程总结/);
  assert.match(serverMjs, /user\\'s active language|user's active language/i);

  const env = createTempEnv(t, 'pt-lang-hook-');
  const ws = join(env.tempRoot, 'repo');
  const reg = loadRegistry();
  reg.coordinators['__lang_hook__'] = {
    key: '__lang_hook__',
    conversationId: 'conv-lang-coord-001',
    workspacePath: ws,
    repoRoot: ws,
    title: '[Coordinator] LangTest',
    directiveVersion: 15,
  };
  saveRegistry(reg);

  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const res = spawnSync(
    process.execPath,
    ['scripts/hook-handler.mjs', 'PreInvocation'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ANTIGRAVITY_GEMINI_DIR: env.geminiDir,
        ANTIGRAVITY_APP_DATA_DIR: env.appDataDir,
      },
      input: JSON.stringify({
        hookEventName: 'PreInvocation',
        conversationId: 'conv-lang-coord-001',
        initialNumSteps: 6,
      }),
      encoding: 'utf8',
    },
  );

  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout.trim());
  const directive = out?.injectSteps?.[0]?.systemMessage?.systemMessage || '';
  assert.match(directive, /Match the user's language/i);
  assert.match(directive, /`title` and `taskPrompt`/);
  assert.match(directive, /same language/i);
  assert.match(directive, /Read-only.*`createWorktree: false`.*autonomously decide.*`archive_thread`.*without asking the user/i);
  assert.match(
    directive,
    /Worktree threads.*`createWorktree: true`.*NOT.*auto-archive before user acceptance.*once the user confirms acceptance.*automatically call `archive_thread`/i,
  );
  assert.doesNotMatch(directive, /NEVER auto-archive/i);
  assert.doesNotMatch(directive, /archive Worktree code threads once confirmed merged/i);
  assert.equal(loadRegistry().coordinators['__lang_hook__'].directiveVersion, 16);
});

test('detectPromptLanguage and buildWorkerPrompt localize Chinese tasks and preserve English templates', () => {
  assert.equal(detectPromptLanguage('修复 OAuth 刷新竞态', '请排查 lib/auth.mjs'), 'zh');
  assert.equal(detectPromptLanguage('Fix OAuth race', '请在 worktree 中修复并提交'), 'zh');
  assert.equal(detectPromptLanguage('Fix OAuth race', 'Inspect lib/auth.mjs and add unit tests.'), 'en');
  assert.equal(detectPromptLanguage('バグ修正', 'テストを追加してください'), 'en');

  const zhWorktreePrompt = buildWorkerPrompt({
    threadId: 'thr-020',
    title: '固化子线程语言跟随',
    taskPrompt: '请更新提示模板并补充单元测试。',
    worktreePath: 'C:\\worktrees\\repo\\thr-020',
    repoRoot: 'C:\\repo',
    branch: 'thread/thr-020',
    baseRef: 'main',
    memoryText: '- 共享约定 A',
  });
  assert.match(zhWorktreePrompt, /^# 子线程任务分配: \[thr-020\] 固化子线程语言跟随/);
  assert.match(zhWorktreePrompt, /## 隔离工作区与 Git 分支/);
  assert.match(zhWorktreePrompt, /## 继承的项目共享记忆/);
  assert.match(zhWorktreePrompt, /## 任务指令\n请更新提示模板并补充单元测试。/);
  assert.match(zhWorktreePrompt, /## 完成与汇报规范/);
  assert.match(zhWorktreePrompt, /与上方任务指令相同的语言/);
  assert.match(zhWorktreePrompt, /3 个及以上独立阶段.*`update_steps`.*3–6 步简明实时步骤清单.*简单 1–2 步任务可跳过/);
  assert.match(zhWorktreePrompt, /### 线程总结/);

  const zhReadOnlyPrompt = buildWorkerPrompt({
    threadId: 'thr-021',
    title: '排查定时任务阻塞',
    taskPrompt: '只读检查调度器为什么没有触发。',
    worktreePath: '',
    repoRoot: 'C:\\repo',
    branch: '',
    baseRef: 'main',
    memoryText: '',
  });
  assert.match(zhReadOnlyPrompt, /^# 子线程任务分配: \[thr-021\] 排查定时任务阻塞/);
  assert.match(zhReadOnlyPrompt, /## 工作区上下文（只读 \/ 共享检出）/);
  assert.doesNotMatch(zhReadOnlyPrompt, /## 隔离工作区与 Git 分支/);
  assert.match(zhReadOnlyPrompt, /`update_steps`.*3–6 步简明实时步骤清单/);

  const enWorktreePrompt = buildWorkerPrompt({
    threadId: 'thr-022',
    title: 'Fix OAuth refresh race',
    taskPrompt: 'Fix token refresh locking and add unit tests.',
    worktreePath: 'C:\\worktrees\\repo\\thr-022',
    repoRoot: 'C:\\repo',
    branch: 'thread/thr-022',
    baseRef: 'main',
    memoryText: '- Shared rule A',
  });
  assert.match(enWorktreePrompt, /^# Worker Thread Assignment: \[thr-022\] Fix OAuth refresh race/);
  assert.match(enWorktreePrompt, /## Isolated Workspace & Git Branch/);
  assert.match(enWorktreePrompt, /## Inherited Project Memory/);
  assert.match(enWorktreePrompt, /## Task Instructions\nFix token refresh locking and add unit tests\./);
  assert.match(enWorktreePrompt, /## Completion & Handback Protocol/);
  assert.match(enWorktreePrompt, /same language as the Task Instructions above/);
  assert.match(
    enWorktreePrompt,
    /3 or more distinct stages, use the built-in `update_steps` tool.*3–6 steps.*skip it for trivial 1–2 step tasks/,
  );
  assert.match(enWorktreePrompt, /### Thread Summary/);

  const enReadOnlyPrompt = buildWorkerPrompt({
    threadId: 'thr-023',
    title: 'Inspect scheduler stall',
    taskPrompt: 'Inspect why the scheduler does not trigger.',
    worktreePath: '',
    repoRoot: 'C:\\repo',
    branch: '',
    baseRef: 'main',
    memoryText: '',
  });
  assert.match(enReadOnlyPrompt, /^# Worker Thread Assignment: \[thr-023\] Inspect scheduler stall/);
  assert.match(enReadOnlyPrompt, /## Workspace Context \(Read-Only \/ Shared Checkout\)/);
  assert.match(enReadOnlyPrompt, /use the built-in `update_steps` tool/);
});

test('transcript parser splits Chinese & English worker briefs and extracts summaries without breaking clearOnFinalSummary', (t) => {
  const { appDataDir } = createTempEnv(t, 'pt-lang-tx-');
  const nowIso = new Date().toISOString();

  // 1. Verify FINAL_SUMMARY_HEADING_RE matches English, Simplified Chinese, and Traditional Chinese headings
  for (const heading of [
    '### Thread Summary',
    '### 线程总结',
    '### 線程總結',
    '### 任务总结',
    '### 核心结论',
    '## 总结',
  ]) {
    assert.equal(FINAL_SUMMARY_HEADING_RE.test(heading), true, `should match ${heading}`);
  }

  // 2. Chinese worker prompt + orphaned bg task + ### 线程总结
  const zhConvId = 'conv-lang-zh-12345678';
  const zhPrompt = buildWorkerPrompt({
    threadId: 'thr-030',
    title: '中文任务测试',
    taskPrompt: '分析日志并修复解析问题。',
    worktreePath: 'C:\\worktrees\\repo\\thr-030',
    repoRoot: 'C:\\repo',
    branch: 'thread/thr-030',
    baseRef: 'main',
    memoryText: '- 共享记忆内容',
  });
  const zhSteps = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: nowIso,
      content: `<USER_REQUEST>\n${zhPrompt}\n</USER_REQUEST>`,
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: nowIso,
      tool_calls: [
        { name: 'run_command', args: { CommandLine: '"node --test"', toolSummary: '"Run tests"' } },
      ],
    },
    {
      step_index: 2,
      type: 'GENERIC',
      status: 'RUNNING',
      created_at: nowIso,
      content: `Tool is running as a background task with task id: ${zhConvId}/task-1`,
    },
    {
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: nowIso,
      content: '已完成全部排查。\n\n### 线程总结\n- **根因**：中文模板未被拆分识别\n- **修改文件**：`lib/transcript.mjs`',
    },
  ];
  const zhTxPath = writeTranscript(appDataDir, zhConvId, zhSteps);

  const zhTimeline = parseThreadTranscript(zhConvId);
  assert.equal(zhTimeline.items[0]?.kind, 'task_brief');
  assert.equal(zhTimeline.items[0]?.taskText, '分析日志并修复解析问题。');
  assert.match(zhTimeline.items[0]?.contextText || '', /# 子线程任务分配: \[thr-030\] 中文任务测试/);
  const zhFinalAssistant = zhTimeline.items.find((it) => it.kind === 'assistant');
  assert.equal(zhFinalAssistant?.isFinalReply, true);

  assert.equal(
    scanPendingBackgroundTasks(zhSteps, 45 * 60 * 1000, {
      conversationId: zhConvId,
      clearOnFinalSummary: true,
    }).length,
    0,
  );
  const zhComp = extractThreadCompletion(zhConvId, zhTxPath);
  assert.equal(zhComp.waitingOnBackgroundTask, false);
  assert.match(zhComp.cardSummary, /中文模板未被拆分识别/);
  assert.doesNotMatch(zhComp.cardSummary, /已完成全部排查/);

  const zhLatest = extractLatestAssistantText(zhConvId, zhTxPath);
  assert.match(zhLatest.cardSummary, /中文模板未被拆分识别/);

  // 3. English worker prompt + ### Thread Summary regression check
  const enConvId = 'conv-lang-en-12345678';
  const enPrompt = buildWorkerPrompt({
    threadId: 'thr-031',
    title: 'English task test',
    taskPrompt: 'Analyze logs and fix parser.',
    worktreePath: 'C:\\worktrees\\repo\\thr-031',
    repoRoot: 'C:\\repo',
    branch: 'thread/thr-031',
    baseRef: 'main',
    memoryText: '- Shared note',
  });
  const enSteps = [
    {
      step_index: 0,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: nowIso,
      content: `<USER_REQUEST>\n${enPrompt}\n</USER_REQUEST>`,
    },
    {
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: nowIso,
      content: 'All checks passed.\n\n### Thread Summary\n- Fixed parser edge case in lib/transcript.mjs.',
    },
  ];
  const enTxPath = writeTranscript(appDataDir, enConvId, enSteps);

  const enTimeline = parseThreadTranscript(enConvId);
  assert.equal(enTimeline.items[0]?.kind, 'task_brief');
  assert.equal(enTimeline.items[0]?.taskText, 'Analyze logs and fix parser.');
  assert.match(enTimeline.items[0]?.contextText || '', /# Worker Thread Assignment: \[thr-031\] English task test/);

  const enComp = extractThreadCompletion(enConvId, enTxPath);
  assert.equal(enComp.waitingOnBackgroundTask, false);
  assert.match(enComp.cardSummary, /Fixed parser edge case/);
  assert.doesNotMatch(enComp.cardSummary, /All checks passed/);

  // 4. LF line endings check for all modified/added .mjs files
  for (const rel of [
    '../scripts/hook-handler.mjs',
    '../lib/store.mjs',
    '../lib/transcript.mjs',
    '../mcp/server.mjs',
    '../tests/worker-language.test.mjs',
    '../tests/settings-default-model.test.mjs',
  ]) {
    const raw = readFileSync(new URL(rel, import.meta.url));
    assert.ok(!raw.includes(Buffer.from('\r')), `${rel} must use LF line endings`);
  }
});

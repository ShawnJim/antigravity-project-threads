(() => {
  'use strict';

  const BOARD_POLL_MS = 2200;
  const CHAT_POLL_MS = 1200;
  const EXPECTED_SERVER_API_REVISION = 2;
  const REQUIRED_UPDATE_CAPABILITIES = ['update_status', 'update_check', 'update_apply'];
  const API_READ_TIMEOUT_MS = 10_000;
  const API_WRITE_TIMEOUT_MS = 12_000;
  const API_UPDATE_TIMEOUT_MS = 30_000;
  const HOST_META_TIMEOUT_MS = 2000;
  const params = new URLSearchParams(location.search);
  const getHostConvId = () =>
    (window.sidecar && window.sidecar.conversationId) ||
    params.get('conversationId') ||
    '';
  const doFetch = (window.sidecar && window.sidecar.fetch) || fetch;

  // ---------- Global App-Controlled Localization (en / zh-CN / zh-TW) ----------
  const I18N = {
    en: {
      panelTitle: 'Project Threads',
      liveOk: 'Live',
      liveStale: 'Reconnecting',
      liveTipOk: 'Updates automatically',
      liveTipStale: 'Reconnecting to sidecar…',
      tabThreads: 'Threads',
      tabLibrary: 'Library',
      tabArchived: 'Archived',
      newBtn: 'New',
      drawerTitle: 'New background thread',
      closeTip: 'Close',
      bindBtn: 'Bind Coordinator',
      boundToast: 'Coordinator bound',
      coordCalmBtn: 'Coordinator',
      coordJumpBtn: '← Coordinator',
      coordJumpTip: 'Switch main window back to Coordinator session',
      coordCardOpen: 'Open Coordinator ↗',
      coordCardBack: '← Back to Coordinator',
      switchedCoordToast: 'Switched to Coordinator',
      kickerCoord: 'COORDINATOR',
      kickerProject: 'PROJECT',
      defaultProjTitle: 'Current Project',
      triageSummary: (w, r, i) => {
        const parts = [];
        if (w > 0) parts.push(`${w} waiting on you`);
        if (r > 0) parts.push(`${r} running`);
        if (i > 0) parts.push(`${i} ready`);
        return parts.length ? parts.join(' · ') : 'No active threads yet';
      },
      sortPriority: 'Status',
      sortRecent: 'Recent',
      cardRunning: 'Running',
      secThreads: 'Threads',
      stRunning: 'running',
      stConfirm: 'needs input',
      stReview: 'review',
      stReady: 'ready',
      nowLabel: 'Now',
      waitLabel: 'Waiting',
      statusLabel: 'Status',
      foldTip: 'Expand or collapse steps',
      tasksHdrHtml: (done, total) =>
        `<b>${done} of ${total}</b> ${total === 1 ? 'thread' : 'threads'} ready`,
      waitingChip: (n) => `${n} waiting`,
      subheadWaiting: (n) => `WAITING ON YOU · ${n}`,
      subheadCompleted: (n) => `COMPLETED · ${n}`,
      subheadRecent: (n) => `RECENT · ${n}`,
      subheadArchived: (n) => `ARCHIVED · ${n}`,
      subWaitingConfirm: 'Needs your confirmation',
      subWaitingReview: 'Completed · ready for your review',
      subWorkingDefault: 'Working on task…',
      subSyncedCoord: 'Synced to coordinator',
      subIdleReady: 'Ready',
      subCommits: (n) => `+${n} commit${n === 1 ? '' : 's'}`,
      subDirty: (n) => `${n} modified`,
      toolVerb: {
        read: 'Reading',
        edit: 'Editing',
        cmd: 'Running',
        search: 'Searching',
        mcp: 'Calling',
        focus: '',
        other: 'Using',
      },
      traceVerb: {
        analyzing: 'Analyzing',
        analyzed: 'Analyzed',
        editing: 'Editing',
        edited: 'Edited',
        runningCmd: 'Running',
        ranCmd: 'Ran',
        searching: 'Searching',
        searched: 'Searched',
        calling: 'Calling',
        called: 'Called',
        using: 'Using',
        used: 'Used',
      },
      fmtDuration: (m, s) => (m > 0 ? (s > 0 ? `${m}m ${s}s` : `${m}m`) : `${s}s`),
      workedFor: (dur) => `Worked for ${dur}`,
      thoughtFor: (dur) => `Thought for ${dur}`,
      stepsUnit: (n) => `${n} step${n === 1 ? '' : 's'}`,
      actMarkReadTip: 'Mark as reviewed',
      markedReadToast: 'Marked as reviewed',
      actOpenNative: 'Open',
      actPopoutMain: 'Open ↗',
      actPreview: 'Preview',
      actFolder: 'Folder',
      actCopyPath: 'Copy path',
      actOpenThread: 'Open',
      actArchive: 'Archive',
      actCleanWt: 'Clean worktree',
      actCleanWtTip: 'Remove leftover Git worktree & merged branch',
      copiedPath: 'Path copied',
      copiedCode: 'Copied',
      copyBtn: 'Copy',
      archivedToast: 'Archived',
      archivedWtAndBranchToast: 'Archived · worktree & branch removed',
      archivedWtToast: 'Archived · worktree removed',
      archivedPrunedToast: 'Archived · stale worktree pruned',
      archivedKeptDirtyToast: 'Archived · kept worktree (uncommitted changes)',
      archivedKeptUnmergedToast: 'Archived · kept worktree (unmerged commits)',
      archivedWtErrToast: (e) => `Archived · worktree kept (${e})`,
      archiveErrToast: 'Archive failed',
      cleanedWtAndBranchToast: 'Worktree & branch removed',
      cleanedWtToast: 'Worktree removed',
      cleanedPrunedToast: 'Stale worktree entry pruned',
      keptDirtyToast: 'Kept worktree: uncommitted changes present',
      keptUnmergedToast: 'Kept worktree: unmerged commits present',
      cleanupErrToast: 'Worktree cleanup failed',
      modalArchiveTitle: 'Archive thread',
      modalCleanTitle: 'Clean Git worktree',
      modalArchiveConfirm: 'Archive',
      modalArchiveForceConfirm: 'Force archive & delete',
      modalCleanConfirm: 'Clean worktree',
      modalCleanForceConfirm: 'Force remove',
      modalWorking: 'Working…',
      modalRemoveWtOpt: 'Also remove Git worktree & merged branch',
      modalDelBranchOpt: 'Also delete thread branch',
      modalForceWtOpt:
        'Force remove dirty/unmerged worktree (discards uncommitted changes & unmerged branch)',
      modalStatusClean: 'Clean & merged',
      modalStatusCherryPicked: 'Clean · cherry-picked',
      modalStatusMissing: 'Directory missing (will prune stale entry)',
      modalWarnDirtyUnmerged: (dirtyCount, aheadCount) => {
        const parts = [];
        if (dirtyCount > 0) {
          parts.push(`${dirtyCount} uncommitted change${dirtyCount === 1 ? '' : 's'}`);
        }
        if (aheadCount > 0) {
          parts.push(`${aheadCount} unmerged commit${aheadCount === 1 ? '' : 's'}`);
        }
        return `Detected ${parts.join(' and ')}. Safe cleanup preserves this worktree unless Force is checked.`;
      },
      emptyThreadsTitle: 'No active threads in this project',
      emptyThreadsBody:
        'Ask the Coordinator in the main chat to dispatch tasks in parallel, or click "+ New" above.',
      emptyArchived: 'No archived threads.',
      emptyWt: 'No isolated Git worktrees active.',
      fTitle: 'Thread title',
      fTitlePh: 'e.g., Fix OAuth token refresh race',
      fBranch: 'Git branch (optional)',
      fModel: 'Model',
      fTier: 'Effort',
      fWt: 'Create isolated Git worktree branch (uncheck for fast read-only checks)',
      fWtDisabled: 'Git worktree unavailable (no Git repository in this project)',
      fPrompt: 'Task instructions',
      fPromptPh: 'Describe the goal, bug, or check to run in the background…',
      fSubmit: 'Start thread',
      fCreating: 'Starting…',
      fCancel: 'Cancel',
      fErrReq: 'Title and instructions are required.',
      libMem: 'Shared Project Memory',
      libSave: 'Save & Broadcast',
      libSaving: 'Saving…',
      libReload: 'Reload',
      libSaved: 'Saved & broadcast to worktrees',
      libWt: 'Active Git Worktrees',
      wtClean: 'Clean',
      wtCherryPicked: 'Cherry-picked',
      backThreads: 'Threads',
      syncCoord: 'Sync',
      syncTip: 'Push conclusion to Coordinator',
      syncing: 'Syncing…',
      syncedOk: 'Synced ✓',
      syncNone: 'Up to date',
      syncErr: 'Sync failed',
      popoutTip: 'Open native conversation tab',
      sendTip: 'Send message (Enter)',
      runningStateTip: 'Thread is running — type a message to send follow-up',
      briefTitle: 'Task Brief',
      briefExpand: 'Show all',
      briefCollapse: 'Show less',
      briefCtx: 'Inherited project memory & branch rules',
      userExpand: (n) => `Show all (${n} lines) ▾`,
      userCollapse: 'Show less ▴',
      pendingSend: 'Queued in background…',
      sending: 'Sending…',
      waking: 'Waking background thread…',
      thinkingOnly: 'Thinking',
      thinkingLive: 'Thinking…',
      traceSummary: (total, parts) =>
        `${total} step${total === 1 ? '' : 's'} (${parts.join(' · ')})`,
      traceCat: {
        read: 'read',
        search: 'search',
        edit: 'edit',
        cmd: 'cmd',
        mcp: 'mcp',
        tool: 'tool',
      },
      composerPh: 'Ask anything, @ to mention, / for actions',
      modelSwitchTip: 'Switch model for next message',
      modelPendingTip: 'Pending — applies on next message',
      modelMenuTitle: 'Model',
      modelEffortTitle: 'Thinking Effort',
      modelBack: 'Back',
      modelRunningHint: 'Thread is running — new model applies on your next message',
      modelNextMsgHint: 'Applies on your next message',
      modelLoading: 'Loading models…',
      modelEmpty: 'Live model catalog unavailable',
      modelDefaultBadge: 'Default',
      modelGroupModels: 'Available Models',
      roleWorker: 'Worker',
      roleReadOnly: 'Read-only',
      readOnlyMode: 'Shared session',
      justNow: 'now',
      justNowAgo: 'just now',
      agoTime: (val, unit) => `${val}${unit} ago`,
      loadingChat: 'Loading conversation…',
      emptyChat: 'Waiting for first response…',
      settingsTip: 'Settings',
      settingsTitle: 'Settings',
      settingsTipWithUpdate: (ver) =>
        ver ? `Settings — Update available (v${ver})` : 'Settings — Update available',
      updateHdr: 'Version & Updates',
      updateInstallGit: 'Git Install',
      updateInstallRelease: 'Release Package',
      updateChannelLabel: 'Update Channel',
      updateChannelStable: 'Stable',
      updateChannelDev: 'Dev / Pre-release',
      updateChannelHintStable: 'Tracks origin/main and formal vX.Y.Z / stable releases.',
      updateChannelHintDev: 'Tracks origin/dev for early previews and latest improvements.',
      updateCurrentLabel: 'Current',
      updateTargetLabel: 'Target',
      updateBranchDetached: 'detached',
      updateBadgeChecking: 'Checking…',
      updateBadgeAvailable: 'Update available',
      updateBadgeSwitch: 'Switch channel',
      updateBadgeUpToDate: 'Up to date',
      updateBadgeDirty: 'Uncommitted edits',
      updateBadgeOffline: 'Offline',
      updateBadgeUnchecked: 'Not checked',
      updateBehindCommits: (n) => `${n} commit${n === 1 ? '' : 's'} behind`,
      updateAheadCommits: (n) => `${n} commit${n === 1 ? '' : 's'} ahead`,
      updateSwitchBranchHint: (cur, tgt) => `Switch ${cur || 'detached HEAD'} -> ${tgt}`,
      updateCheckedAgo: (ago) => `Last checked ${ago}`,
      updateNotCheckedYet: 'Click "Check for Updates" to query the latest version.',
      updateCheckBtn: 'Check for Updates',
      updateCheckingBtn: 'Checking…',
      updateApplyBtn: 'One-Click Update',
      updateSwitchApplyBtn: 'Switch & Update',
      updateApplyingBtn: 'Updating…',
      updateReleaseBtn: 'Open GitHub Releases ↗',
      updateDirtyWarn: (n) =>
        `Local plugin directory has ${n} uncommitted change${n === 1 ? '' : 's'}. One-click update is blocked to protect local edits (git reset --hard is never used).`,
      updateNonGitHint:
        'Non-Git installation detected. Local files will not be modified automatically; open GitHub Releases to download the latest version.',
      updateReloadBanner: (ver) =>
        `Updated to v${ver}. Toggle "project-threads" off and back on in the plugin manager, or reload the Antigravity window to take effect.`,
      updateModalTitle: 'Confirm Plugin Update',
      updateModalConfirm: 'Update Now',
      updateModalNote:
        'Runs a safe fast-forward Git update only when the working tree is clean. After updating, toggle project-threads or reload the Antigravity window to take effect.',
      updateToastUpToDate: 'Already up to date',
      updateToastAvailable: (ver) => `Update available (v${ver})`,
      updateToastApplied: 'Updated — toggle plugin or reload window',
      updateToastCheckErr: 'Update check failed',
      updateToastApplyErr: 'Plugin update failed',
      apiTimeoutErr: (sec) => `Request timed out after ${sec}s. Please try again.`,
      apiHttpErr: (status) => `Sidecar request failed (HTTP ${status})`,
      apiInvalidJsonErr: 'Received an unexpected non-JSON response from the sidecar backend.',
      sidecarMismatchErr:
        'Sidecar backend process is outdated (missing new API routes). Toggle "project-threads" off and back on in the plugin manager, or reload the Antigravity window.',
      updateBadgeReloadRequired: 'Reload required',
      updateChannelMismatchHint:
        'Channel status is unavailable until the outdated sidecar backend process is reloaded.',
      updateBackendMismatchBanner: (startedVer, diskVer) =>
        startedVer && diskVer && startedVer !== diskVer
          ? `Sidecar backend process (v${startedVer}) lags behind installed plugin files (v${diskVer}). Toggle "project-threads" off and back on in the plugin manager, or reload the Antigravity window.`
          : 'Sidecar backend process is behind the current UI version. Toggle "project-threads" off and back on in the plugin manager, or reload the Antigravity window.',
      settingsBack: 'Back',
      settingsScopeGlobal: 'Global',
      settingsScopeProject: 'This Project',
      settingsScopeKickerGlobal: 'GLOBAL DEFAULTS',
      settingsScopeKickerProject: 'PROJECT OVERRIDE',
      settingsGlobalHint:
        'Applies to all projects unless overridden per project. Coordinator and "+ New" threads use these defaults when no model is explicitly specified.',
      settingsProjectHint: (proj) =>
        `Overrides global defaults for "${proj}" only. Choose "Follow Global Default" to inherit global settings.`,
      settingsModelsHdr: 'Default Worker Thread Models',
      settingsWorktreeLabel: 'Code-Editing / Worktree Threads',
      settingsWorktreeDesc: 'Used when creating isolated Git worktree branches (createWorktree: true).',
      settingsReadOnlyLabel: 'Read-Only / Investigation Threads',
      settingsReadOnlyDesc: 'Used for fast read-only checks or non-Git workspaces (createWorktree: false).',
      settingsFollowGlobal: (lbl) => `Follow Global Default (${lbl})`,
      settingsSave: 'Save',
      settingsSaving: 'Saving…',
      settingsSavedToast: 'Settings saved',
      settingsSaveErr: 'Failed to save settings',
      settingsResetGlobal: 'Reset to Defaults',
      settingsResetProject: 'Clear Project Override',
      settingsResetToast: 'Settings reset to defaults',
      settingsClearedProjectToast: 'Cleared project overrides',
      settingsModelColLabel: 'Model',
      settingsTierColLabel: 'Effort',
      settingsTierDefault: 'Default',
      settingsTierStandard: 'Standard',
      settingsTierNone: '—',
      settingsInheritOption: 'Follow Coordinator (inherit)',
      settingsInheritDraftOption: 'Follow Coordinator (no turn yet)',
      settingsInheritWithModel: (lbl) => `Follow Coordinator (${lbl})`,
      settingsInheritShort: 'Follow Coordinator',
      settingsInheritActiveNote: (model) =>
        `Follow Coordinator tracks the model from the Coordinator's last executed turn (current: ${model}). After switching the model in the main composer, send one message for it to take effect.`,
      settingsInheritDraftNote:
        'Follow Coordinator tracks the model from the Coordinator\'s last executed turn. No executed turn has been recorded yet (draft state) — send a message in the Coordinator session to sync its model; until then, new threads fall back safely to Gemini Pro.',
      settingsRefreshModelsTip: 'Refresh live model catalog & Coordinator model',
      useSettingsDefault: (lbl) => `Use Settings Default (${lbl})`,
      usageTokensLabel: 'Tokens',
      usageCompactLine: 'Compact line',
      usageCompacts: (n) => `${n} ${n === 1 ? 'compact' : 'compacts'}`,
      usageDetailTip: (inp, out, cache) => `Input ${inp} | Output ${out} | Cache ${cache}`,
      decisionsTitle: 'Pending Decisions',
      decisionBadge: 'Decision',
      decisionAutoTag: 'Auto hint',
      decisionToggleTip: 'Expand or collapse pending decisions',
      decisionDismissTip: 'Dismiss',
      decisionThreadTip: (tid) => `Locate thread ${tid}`,
      decisionWorking: 'Working…',
      decisionSentCoordToast: 'Decision sent to Coordinator',
      decisionDismissedToast: 'Decision dismissed',
      decisionActionErrToast: 'Decision action failed',
      decisionAutoMergeTitle: 'Worktree ready to merge',
      decisionAutoMergeSummary: (title, branch, commits) =>
        `${title}${branch ? ` (${branch}, +${commits} commit${commits === 1 ? '' : 's'})` : ` (+${commits} commit${commits === 1 ? '' : 's'})`}`,
      decisionAutoMergeBtn: 'Merge to target',
      decisionAutoArchiveTitle: (isCherry) =>
        isCherry ? 'Cherry-picked, ready to archive' : 'Merged, ready to archive',
      decisionAutoArchiveSummary: (title, branch) => `${title}${branch ? ` (${branch})` : ''}`,
      decisionAutoArchiveBtn: 'Accept & Archive',
      decisionDismissBtn: 'Dismiss',
    },

    'zh-CN': {
      panelTitle: '项目线程',
      liveOk: '实时',
      liveStale: '重连中',
      liveTipOk: '自动实时同步',
      liveTipStale: '正在重新连接侧边栏服务…',
      tabThreads: '线程',
      tabLibrary: '知识库',
      tabArchived: '已归档',
      newBtn: '新建',
      drawerTitle: '新建后台工作线程',
      closeTip: '关闭',
      bindBtn: '绑定总控',
      boundToast: '已绑定总控会话',
      coordCalmBtn: '总控会话',
      coordJumpBtn: '← 回到总控',
      coordJumpTip: '将左侧主窗口切回总控会话',
      coordCardOpen: '打开总控 ↗',
      coordCardBack: '← 切回总控',
      switchedCoordToast: '已切回总控会话',
      kickerCoord: '总控会话',
      kickerProject: '当前项目',
      defaultProjTitle: '当前项目',
      triageSummary: (w, r, i) => {
        const parts = [];
        if (w > 0) parts.push(`${w} 个待你确认`);
        if (r > 0) parts.push(`${r} 个执行中`);
        if (i > 0) parts.push(`${i} 个已就绪`);
        return parts.length ? parts.join(' · ') : '当前暂无活跃线程';
      },
      sortPriority: '按状态',
      sortRecent: '按最新',
      cardRunning: '执行中',
      secThreads: '工作线程',
      stRunning: '执行中',
      stConfirm: '待确认',
      stReview: '待审阅',
      stReady: '已就绪',
      nowLabel: '当前',
      waitLabel: '待办',
      statusLabel: '状态',
      foldTip: '展开或收起步骤详情',
      tasksHdrHtml: (done, total) => `<b>${done} / ${total}</b> 个线程已就绪`,
      waitingChip: (n) => `${n} 待确认`,
      subheadWaiting: (n) => `待你确认 · ${n}`,
      subheadCompleted: (n) => `已完成 / 空闲 · ${n}`,
      subheadRecent: (n) => `最近活跃 · ${n}`,
      subheadArchived: (n) => `已归档 · ${n}`,
      subWaitingConfirm: '等待你确认方案或结果',
      subWaitingReview: '已完成 · 待你审阅',
      subWorkingDefault: '正在分析与处理…',
      subSyncedCoord: '已同步至总控',
      subIdleReady: '已就绪',
      subCommits: (n) => `+${n} 次提交`,
      subDirty: (n) => `${n} 处修改`,
      toolVerb: {
        read: '读取',
        edit: '修改',
        cmd: '执行',
        search: '搜索',
        mcp: '调用',
        focus: '',
        other: '运行',
      },
      traceVerb: {
        analyzing: '正在分析',
        analyzed: '已分析',
        editing: '正在修改',
        edited: '已修改',
        runningCmd: '正在执行',
        ranCmd: '已执行',
        searching: '正在搜索',
        searched: '已搜索',
        calling: '正在调用',
        called: '已调用',
        using: '正在使用',
        used: '已使用',
      },
      fmtDuration: (m, s) => (m > 0 ? (s > 0 ? `${m}分${s}秒` : `${m}分`) : `${s}秒`),
      workedFor: (dur) => `已执行 ${dur}`,
      thoughtFor: (dur) => `已思考 ${dur}`,
      stepsUnit: (n) => `${n} 步`,
      actMarkReadTip: '标记为已审阅',
      markedReadToast: '已标记为已阅',
      actOpenNative: '打开会话',
      actPopoutMain: '主窗打开 ↗',
      actPreview: '内联预览',
      actFolder: '目录',
      actCopyPath: '复制路径',
      actOpenThread: '打开会话',
      actArchive: '归档',
      actCleanWt: '清理 Worktree',
      actCleanWtTip: '移除残留的 Git Worktree 目录与已合并分支',
      copiedPath: '已复制路径',
      copiedCode: '已复制',
      copyBtn: '复制',
      archivedToast: '已归档',
      archivedWtAndBranchToast: '已归档 · 已清理 Worktree 及分支',
      archivedWtToast: '已归档 · 已清理 Worktree',
      archivedPrunedToast: '已归档 · 已清理失效 Worktree 记录',
      archivedKeptDirtyToast: '已归档 · 保留 Worktree（存在未提交修改）',
      archivedKeptUnmergedToast: '已归档 · 保留 Worktree（存在未合并提交）',
      archivedWtErrToast: (e) => `已归档 · Worktree 未移除（${e}）`,
      archiveErrToast: '归档失败',
      cleanedWtAndBranchToast: '已清理 Worktree 及分支',
      cleanedWtToast: '已清理 Worktree',
      cleanedPrunedToast: '已清理失效 Worktree 记录',
      keptDirtyToast: '未移除：Worktree 存在未提交修改',
      keptUnmergedToast: '未移除：分支存在未合并提交',
      cleanupErrToast: '清理 Worktree 失败',
      modalArchiveTitle: '归档工作线程',
      modalCleanTitle: '清理 Git Worktree',
      modalArchiveConfirm: '确认归档',
      modalArchiveForceConfirm: '强制归档并删除',
      modalCleanConfirm: '清理 Worktree',
      modalCleanForceConfirm: '强制移除',
      modalWorking: '处理中…',
      modalRemoveWtOpt: '同时移除 Git Worktree 目录并清理已合并分支',
      modalDelBranchOpt: '同时删除关联的线程 Git 分支',
      modalForceWtOpt: '强制删除未提交或未合并的 Worktree（将丢弃未提交改动与未合并分支）',
      modalStatusClean: '干净且已合并',
      modalStatusCherryPicked: '干净 · 已 cherry-pick 合入',
      modalStatusMissing: '目录已不存在（将自动清理残留记录）',
      modalWarnDirtyUnmerged: (dirtyCount, aheadCount) => {
        const parts = [];
        if (dirtyCount > 0) parts.push(`${dirtyCount} 处未提交修改`);
        if (aheadCount > 0) parts.push(`${aheadCount} 个未合并提交`);
        return `检测到 ${parts.join('和')}。默认会保留该 Worktree 目录以防丢失改动；如需强制删除请勾选下方选项。`;
      },
      emptyThreadsTitle: '当前项目暂无活跃线程',
      emptyThreadsBody:
        '在中央总控会话直接派发并行任务，或点击右上角「+ 新建」手动创建。',
      emptyArchived: '暂无已归档线程。',
      emptyWt: '当前暂无独立 Git Worktree 目录。',
      fTitle: '线程标题',
      fTitlePh: '例如：排查提前建单未触发自动清关的前置条件',
      fBranch: 'Git 分支名（可选）',
      fModel: '模型',
      fTier: '档位',
      fWt: '创建独立 Git Worktree 隔离副本（纯只读代码排查可取消勾选）',
      fWtDisabled: '当前项目未关联 Git 仓库（仅支持无 Worktree 后台会话）',
      fPrompt: '任务说明',
      fPromptPh: '输入排查目标、报错堆栈或修改要求…',
      fSubmit: '启动线程',
      fCreating: '正在启动…',
      fCancel: '取消',
      fErrReq: '请填写标题与任务说明',
      libMem: '共享项目记忆 (Project Memory)',
      libSave: '保存并广播至 Worktree',
      libSaving: '保存中…',
      libReload: '重新读取',
      libSaved: '已保存并同步至活跃分支',
      libWt: '活跃 Git Worktree 分支',
      wtClean: '干净',
      wtCherryPicked: '已 cherry-pick',
      backThreads: '线程',
      syncCoord: '同步总控',
      syncTip: '将当前线程结论推送至总控会话',
      syncing: '同步中…',
      syncedOk: '✓ 已同步',
      syncNone: '已是最新',
      syncErr: '同步失败',
      popoutTip: '打开原生侧边会话标签页',
      sendTip: '发送追问 (Enter)',
      runningStateTip: '线程正在后台执行（输入内容可继续追问）',
      briefTitle: '初始任务书',
      briefExpand: '展开全部',
      briefCollapse: '收起',
      briefCtx: '查看继承的项目记忆与分支规则',
      userExpand: (n) => `展开全部 (${n} 行) ▾`,
      userCollapse: '收起长文本 ▴',
      pendingSend: '已投递至后台线程…',
      sending: '正在投递…',
      waking: '正在唤醒后台线程…',
      thinkingOnly: '思考过程',
      thinkingLive: '正在思考…',
      traceSummary: (total, parts) => `已执行 ${total} 步（${parts.join(' · ')}）`,
      traceCat: {
        read: '读取',
        search: '搜索',
        edit: '修改',
        cmd: '命令',
        mcp: '服务',
        tool: '工具',
      },
      composerPh: '输入追问或补充指令（Enter 发送）…',
      modelSwitchTip: '切换下条消息使用的模型',
      modelPendingTip: '已选待生效 — 将在下条消息应用',
      modelMenuTitle: '模型',
      modelEffortTitle: '思考深度',
      modelBack: '返回',
      modelRunningHint: '线程正在运行 — 新模型将在下条消息生效',
      modelNextMsgHint: '将在下条消息生效',
      modelLoading: '正在加载模型列表…',
      modelEmpty: '暂无法获取实时模型列表',
      modelDefaultBadge: '默认',
      modelGroupModels: '可选模型',
      roleWorker: '工作线程',
      roleReadOnly: '只读排查',
      readOnlyMode: '共享会话',
      justNow: '刚刚',
      justNowAgo: '刚刚',
      agoTime: (val, unit) => {
        const u = unit === 'm' ? ' 分钟前' : unit === 'h' ? ' 小时前' : ' 天前';
        return `${val}${u}`;
      },
      loadingChat: '正在读取会话记录…',
      emptyChat: '正在等待线程响应…',
      settingsTip: '设置',
      settingsTitle: '设置',
      settingsTipWithUpdate: (ver) =>
        ver ? `设置 — 有新版本可用 (v${ver})` : '设置 — 有新版本可用',
      updateHdr: '版本与更新',
      updateInstallGit: 'Git 安装',
      updateInstallRelease: '发行版安装',
      updateChannelLabel: '跟踪渠道',
      updateChannelStable: '稳定版 (stable)',
      updateChannelDev: '先行版 (dev)',
      updateChannelHintStable: '跟踪 origin/main 分支与最新正式版（vX.Y.Z / stable）。',
      updateChannelHintDev: '跟踪 origin/dev 分支，抢先体验先行版与最新改进。',
      updateCurrentLabel: '当前版本',
      updateTargetLabel: '目标版本',
      updateBranchDetached: '游离 HEAD',
      updateBadgeChecking: '检查中…',
      updateBadgeAvailable: '有新版本',
      updateBadgeSwitch: '待切换渠道',
      updateBadgeUpToDate: '已是最新',
      updateBadgeDirty: '工作区未提交',
      updateBadgeOffline: '离线',
      updateBadgeUnchecked: '未检查',
      updateBehindCommits: (n) => `落后 ${n} 个提交`,
      updateAheadCommits: (n) => `领先 ${n} 个提交`,
      updateSwitchBranchHint: (cur, tgt) => `将从 ${cur || '游离 HEAD'} 切换至 ${tgt}`,
      updateCheckedAgo: (ago) => `上次检查：${ago}`,
      updateNotCheckedYet: '点击「检查更新」检测最新版本。',
      updateCheckBtn: '检查更新',
      updateCheckingBtn: '检查中…',
      updateApplyBtn: '一键更新',
      updateSwitchApplyBtn: '切换渠道并更新',
      updateApplyingBtn: '更新中…',
      updateReleaseBtn: '前往 GitHub Release ↗',
      updateDirtyWarn: (n) =>
        `检测到本地插件目录存在 ${n} 处未提交修改。为防止覆盖本地改动，已禁用一键更新（绝不执行 git reset --hard）。请先提交或清理改动后重试。`,
      updateNonGitHint:
        '当前为非 Git 方式安装，不会修改本地文件；请前往 GitHub Release 下载最新版本。',
      updateReloadBanner: (ver) =>
        `已更新至 v${ver}，请在插件管理器中关闭再开启 project-threads 或重载 Antigravity 窗口生效。`,
      updateModalTitle: '确认更新插件',
      updateModalConfirm: '确认更新',
      updateModalNote:
        '仅在本地工作区干净时安全执行快进拉取（fast-forward），绝不强制重置改动。更新完成后请在插件管理器中关闭再开启 project-threads 或重载 Antigravity 窗口生效。',
      updateToastUpToDate: '已是最新版本',
      updateToastAvailable: (ver) => `发现新版本 v${ver}`,
      updateToastApplied: '已更新至新版本，请重载插件或窗口生效',
      updateToastCheckErr: '检查更新失败',
      updateToastApplyErr: '插件更新失败',
      apiTimeoutErr: (sec) => `请求超时（超过 ${sec} 秒），请稍后重试。`,
      apiHttpErr: (status) => `侧边栏服务请求失败（HTTP ${status}）`,
      apiInvalidJsonErr: '侧边栏后端返回了非 JSON 响应，请稍后重试或重载插件。',
      sidecarMismatchErr:
        '检测到插件后端进程版本滞后（缺少新接口路由）。请在插件管理器中关闭再开启 project-threads，或重载 Antigravity 窗口生效。',
      updateBadgeReloadRequired: '需重载插件',
      updateChannelMismatchHint:
        '后端进程版本滞后，重载插件或窗口前暂无法确认当前渠道状态。',
      updateBackendMismatchBanner: (startedVer, diskVer) =>
        startedVer && diskVer && startedVer !== diskVer
          ? `当前常驻后端进程（v${startedVer}）落后于磁盘插件版本（v${diskVer}）。请在插件管理器中关闭再开启 project-threads，或重载 Antigravity 窗口生效。`
          : '检测到常驻 Sidecar 后端进程版本滞后于当前页面。请在插件管理器中关闭再开启 project-threads，或重载 Antigravity 窗口生效。',
      settingsBack: '返回',
      settingsScopeGlobal: '全局默认',
      settingsScopeProject: '当前项目',
      settingsScopeKickerGlobal: '全局默认配置',
      settingsScopeKickerProject: '当前项目覆盖',
      settingsGlobalHint:
        '适用于所有项目（除非单个项目另有覆盖）。总控派发与「新建」线程未指定模型时将使用此默认配置。',
      settingsProjectHint: (proj) =>
        `仅对当前项目「${proj}」生效；选择「跟随全局默认」即可继承全局配置。`,
      settingsModelsHdr: '默认工作线程模型',
      settingsWorktreeLabel: '代码编辑 / Worktree 线程默认模型',
      settingsWorktreeDesc: '用于创建独立 Git Worktree 分支并修改代码的任务（createWorktree: true）。',
      settingsReadOnlyLabel: '只读排查 / 无 Worktree 线程默认模型',
      settingsReadOnlyDesc: '用于快速只读排查或非 Git 项目任务（createWorktree: false）。',
      settingsFollowGlobal: (lbl) => `跟随全局默认 (${lbl})`,
      settingsSave: '保存设置',
      settingsSaving: '保存中…',
      settingsSavedToast: '设置已保存',
      settingsSaveErr: '保存设置失败',
      settingsResetGlobal: '恢复默认',
      settingsResetProject: '清除项目覆盖',
      settingsResetToast: '已恢复默认设置',
      settingsClearedProjectToast: '已清除当前项目覆盖',
      settingsModelColLabel: '模型',
      settingsTierColLabel: '档位',
      settingsTierDefault: '默认',
      settingsTierStandard: '标准',
      settingsTierNone: '—',
      settingsInheritOption: '跟随主会话模型 (inherit)',
      settingsInheritDraftOption: '跟随主会话模型 (尚无回合记录)',
      settingsInheritWithModel: (lbl) => `跟随主会话模型 (${lbl})`,
      settingsInheritShort: '跟随主会话模型',
      settingsInheritActiveNote: (model) =>
        `「跟随主会话模型」读取总控最近一次已执行回合的模型（当前：${model}）。在主窗口切换模型后，发送一条消息即可同步生效。`,
      settingsInheritDraftNote:
        '「跟随主会话模型」读取总控最近一次已执行回合的模型。当前尚无已执行回合记录（草稿态），在总控会话发送一条消息后即可同步；在此之前新建线程将安全回退至 Gemini Pro。',
      settingsRefreshModelsTip: '刷新模型列表与主会话模型',
      useSettingsDefault: (lbl) => `使用设置默认 (${lbl})`,
      usageTokensLabel: 'Tokens',
      usageCompactLine: '压缩线',
      usageCompacts: (n) => `${n} 次压缩`,
      usageDetailTip: (inp, out, cache) => `输入 ${inp} | 输出 ${out} | 缓存 ${cache}`,
      decisionsTitle: '待决策',
      decisionBadge: '待决策',
      decisionAutoTag: '自动提示',
      decisionToggleTip: '展开或收起待决策区',
      decisionDismissTip: '忽略此提醒',
      decisionThreadTip: (tid) => `定位到线程 ${tid}`,
      decisionWorking: '处理中…',
      decisionSentCoordToast: '已将决策发送给总控执行',
      decisionDismissedToast: '已忽略该待决策项',
      decisionActionErrToast: '执行决策操作失败',
      decisionAutoMergeTitle: '分支已就绪，待合入',
      decisionAutoMergeSummary: (title, branch, commits) =>
        `${title}${branch ? `（${branch}，+${commits} 次提交）` : `（+${commits} 次提交）`}`,
      decisionAutoMergeBtn: '合入目标分支',
      decisionAutoArchiveTitle: (isCherry) =>
        isCherry ? '已 cherry-pick 合入，待验收归档' : '已合入，待验收归档',
      decisionAutoArchiveSummary: (title, branch) => `${title}${branch ? `（${branch}）` : ''}`,
      decisionAutoArchiveBtn: '验收归档',
      decisionDismissBtn: '忽略',
    },

    'zh-TW': {
      panelTitle: '專案執行緒',
      liveOk: '即時',
      liveStale: '重新連線',
      liveTipOk: '自動即時同步',
      liveTipStale: '正在重新連線側邊欄服務…',
      tabThreads: '執行緒',
      tabLibrary: '知識庫',
      tabArchived: '已封存',
      newBtn: '新增',
      drawerTitle: '新增背景工作執行緒',
      closeTip: '關閉',
      bindBtn: '綁定總控',
      boundToast: '已綁定總控會話',
      coordCalmBtn: '總控會話',
      coordJumpBtn: '← 回到總控',
      coordJumpTip: '將左側主視窗切回總控會話',
      coordCardOpen: '開啟總控 ↗',
      coordCardBack: '← 切回總控',
      switchedCoordToast: '已切回總控會話',
      kickerCoord: '總控會話',
      kickerProject: '目前專案',
      defaultProjTitle: '目前專案',
      triageSummary: (w, r, i) => {
        const parts = [];
        if (w > 0) parts.push(`${w} 個待你確認`);
        if (r > 0) parts.push(`${r} 個執行中`);
        if (i > 0) parts.push(`${i} 個已就緒`);
        return parts.length ? parts.join(' · ') : '目前尚無活躍執行緒';
      },
      sortPriority: '依狀態',
      sortRecent: '依最新',
      cardRunning: '執行中',
      secThreads: '工作執行緒',
      stRunning: '執行中',
      stConfirm: '待確認',
      stReview: '待審閱',
      stReady: '已就緒',
      nowLabel: '目前',
      waitLabel: '待辦',
      statusLabel: '狀態',
      foldTip: '展開或收起步驟詳情',
      tasksHdrHtml: (done, total) => `<b>${done} / ${total}</b> 個執行緒已就緒`,
      waitingChip: (n) => `${n} 待確認`,
      subheadWaiting: (n) => `待你確認 · ${n}`,
      subheadCompleted: (n) => `已完成 / 閒置 · ${n}`,
      subheadRecent: (n) => `最近活躍 · ${n}`,
      subheadArchived: (n) => `已封存 · ${n}`,
      subWaitingConfirm: '等待你確認方案或結果',
      subWaitingReview: '已完成 · 待你審閱',
      subWorkingDefault: '正在分析與處理…',
      subSyncedCoord: '已同步至總控',
      subIdleReady: '已就緒',
      subCommits: (n) => `+${n} 次提交`,
      subDirty: (n) => `${n} 處修改`,
      toolVerb: {
        read: '讀取',
        edit: '修改',
        cmd: '執行',
        search: '搜尋',
        mcp: '呼叫',
        focus: '',
        other: '執行',
      },
      traceVerb: {
        analyzing: '正在分析',
        analyzed: '已分析',
        editing: '正在修改',
        edited: '已修改',
        runningCmd: '正在執行',
        ranCmd: '已執行',
        searching: '正在搜尋',
        searched: '已搜尋',
        calling: '正在呼叫',
        called: '已呼叫',
        using: '正在使用',
        used: '已使用',
      },
      fmtDuration: (m, s) => (m > 0 ? (s > 0 ? `${m}分${s}秒` : `${m}分`) : `${s}秒`),
      workedFor: (dur) => `已執行 ${dur}`,
      thoughtFor: (dur) => `已思考 ${dur}`,
      stepsUnit: (n) => `${n} 步`,
      actMarkReadTip: '標記為已審閱',
      markedReadToast: '已標記為已閱',
      actOpenNative: '開啟會話',
      actPopoutMain: '主視窗開啟 ↗',
      actPreview: '內嵌預覽',
      actFolder: '目錄',
      actCopyPath: '複製路徑',
      actOpenThread: '開啟會話',
      actArchive: '封存',
      actCleanWt: '清理 Worktree',
      actCleanWtTip: '移除殘留的 Git Worktree 目錄與已合併分支',
      copiedPath: '已複製路徑',
      copiedCode: '已複製',
      copyBtn: '複製',
      archivedToast: '已封存',
      archivedWtAndBranchToast: '已封存 · 已清理 Worktree 及分支',
      archivedWtToast: '已封存 · 已清理 Worktree',
      archivedPrunedToast: '已封存 · 已清理失效 Worktree 記錄',
      archivedKeptDirtyToast: '已封存 · 保留 Worktree（存在未提交修改）',
      archivedKeptUnmergedToast: '已封存 · 保留 Worktree（存在未合併提交）',
      archivedWtErrToast: (e) => `已封存 · Worktree 未移除（${e}）`,
      archiveErrToast: '封存失敗',
      cleanedWtAndBranchToast: '已清理 Worktree 及分支',
      cleanedWtToast: '已清理 Worktree',
      cleanedPrunedToast: '已清理失效 Worktree 記錄',
      keptDirtyToast: '未移除：Worktree 存在未提交修改',
      keptUnmergedToast: '未移除：分支存在未合併提交',
      cleanupErrToast: '清理 Worktree 失敗',
      modalArchiveTitle: '封存工作執行緒',
      modalCleanTitle: '清理 Git Worktree',
      modalArchiveConfirm: '確認封存',
      modalArchiveForceConfirm: '強制封存並刪除',
      modalCleanConfirm: '清理 Worktree',
      modalCleanForceConfirm: '強制移除',
      modalWorking: '處理中…',
      modalRemoveWtOpt: '同時移除 Git Worktree 目錄並清理已合併分支',
      modalDelBranchOpt: '同時刪除關聯的執行緒 Git 分支',
      modalForceWtOpt: '強制刪除未提交或未合併的 Worktree（將捨棄未提交改動與未合併分支）',
      modalStatusClean: '乾淨且已合併',
      modalStatusCherryPicked: '乾淨 · 已 cherry-pick 合併',
      modalStatusMissing: '目錄已不存在（將自動清理殘留記錄）',
      modalWarnDirtyUnmerged: (dirtyCount, aheadCount) => {
        const parts = [];
        if (dirtyCount > 0) parts.push(`${dirtyCount} 處未提交修改`);
        if (aheadCount > 0) parts.push(`${aheadCount} 個未合併提交`);
        return `偵測到 ${parts.join('與')}。預設會保留此 Worktree 目錄以免遺失改動；如需強制刪除請勾選下方選項。`;
      },
      emptyThreadsTitle: '目前專案暫無活躍執行緒',
      emptyThreadsBody:
        '在中央總控會話直接派發平行任務，或點擊右上角「+ 新增」手動建立。',
      emptyArchived: '尚無已封存執行緒。',
      emptyWt: '目前尚無獨立 Git Worktree 目錄。',
      fTitle: '執行緒標題',
      fTitlePh: '例如：排查提前建單未觸發自動清關的前置條件',
      fBranch: 'Git 分支名（選填）',
      fModel: '模型',
      fTier: '檔位',
      fWt: '建立獨立 Git Worktree 隔離副本（純唯讀程式碼排查可取消勾選）',
      fWtDisabled: '目前專案未關聯 Git 儲存庫（僅支援無 Worktree 背景會話）',
      fPrompt: '任務說明',
      fPromptPh: '輸入排查目標、錯誤堆疊或修改要求…',
      fSubmit: '啟動執行緒',
      fCreating: '正在啟動…',
      fCancel: '取消',
      fErrReq: '請填寫標題與任務說明',
      libMem: '共享專案記憶 (Project Memory)',
      libSave: '儲存並廣播至 Worktree',
      libSaving: '儲存中…',
      libReload: '重新讀取',
      libSaved: '已儲存並同步至活躍分支',
      libWt: '活躍 Git Worktree 分支',
      wtClean: '乾淨',
      wtCherryPicked: '已 cherry-pick',
      backThreads: '執行緒',
      syncCoord: '同步總控',
      syncTip: '將目前執行緒結論推送至總控會話',
      syncing: '同步中…',
      syncedOk: '✓ 已同步',
      syncNone: '已是最新',
      syncErr: '同步失敗',
      popoutTip: '開啟原生側邊會話分頁',
      sendTip: '傳送追問 (Enter)',
      runningStateTip: '執行緒正在背景執行（輸入內容可繼續追問）',
      briefTitle: '初始任務書',
      briefExpand: '展開全部',
      briefCollapse: '收起',
      briefCtx: '查看繼承的專案記憶與分支規則',
      userExpand: (n) => `展開全部 (${n} 行) ▾`,
      userCollapse: '收起長文字 ▴',
      pendingSend: '已投遞至背景執行緒…',
      sending: '正在投遞…',
      waking: '正在喚醒背景執行緒…',
      thinkingOnly: '思考過程',
      thinkingLive: '正在思考…',
      traceSummary: (total, parts) => `已執行 ${total} 步（${parts.join(' · ')}）`,
      traceCat: {
        read: '讀取',
        search: '搜尋',
        edit: '修改',
        cmd: '命令',
        mcp: '服務',
        tool: '工具',
      },
      composerPh: '輸入追問或補充指令（Enter 傳送）…',
      modelSwitchTip: '切換下則訊息使用的模型',
      modelPendingTip: '已選待生效 — 將在下則訊息套用',
      modelMenuTitle: '模型',
      modelEffortTitle: '思考深度',
      modelBack: '返回',
      modelRunningHint: '執行緒正在執行 — 新模型將在下則訊息生效',
      modelNextMsgHint: '將在下則訊息生效',
      modelLoading: '正在載入模型清單…',
      modelEmpty: '暫無法取得即時模型清單',
      modelDefaultBadge: '預設',
      modelGroupModels: '可用模型',
      roleWorker: '工作執行緒',
      roleReadOnly: '唯讀排查',
      readOnlyMode: '共享會話',
      justNow: '剛剛',
      justNowAgo: '剛剛',
      agoTime: (val, unit) => {
        const u = unit === 'm' ? ' 分鐘前' : unit === 'h' ? ' 小時前' : ' 天前';
        return `${val}${u}`;
      },
      loadingChat: '正在讀取會話記錄…',
      emptyChat: '正在等待執行緒回應…',
      settingsTip: '設定',
      settingsTitle: '設定',
      settingsTipWithUpdate: (ver) =>
        ver ? `設定 — 有新版本可用 (v${ver})` : '設定 — 有新版本可用',
      updateHdr: '版本與更新',
      updateInstallGit: 'Git 安裝',
      updateInstallRelease: '發行版安裝',
      updateChannelLabel: '追蹤渠道',
      updateChannelStable: '穩定版 (stable)',
      updateChannelDev: '先行版 (dev)',
      updateChannelHintStable: '追蹤 origin/main 分支與最新正式版（vX.Y.Z / stable）。',
      updateChannelHintDev: '追蹤 origin/dev 分支，搶先體驗先行版與最新改進。',
      updateCurrentLabel: '目前版本',
      updateTargetLabel: '目標版本',
      updateBranchDetached: '游離 HEAD',
      updateBadgeChecking: '檢查中…',
      updateBadgeAvailable: '有新版本',
      updateBadgeSwitch: '待切換渠道',
      updateBadgeUpToDate: '已是最新',
      updateBadgeDirty: '工作區未提交',
      updateBadgeOffline: '離線',
      updateBadgeUnchecked: '未檢查',
      updateBehindCommits: (n) => `落後 ${n} 個提交`,
      updateAheadCommits: (n) => `領先 ${n} 個提交`,
      updateSwitchBranchHint: (cur, tgt) => `將從 ${cur || '游離 HEAD'} 切換至 ${tgt}`,
      updateCheckedAgo: (ago) => `上次檢查：${ago}`,
      updateNotCheckedYet: '點擊「檢查更新」偵測最新版本。',
      updateCheckBtn: '檢查更新',
      updateCheckingBtn: '檢查中…',
      updateApplyBtn: '一鍵更新',
      updateSwitchApplyBtn: '切換渠道並更新',
      updateApplyingBtn: '更新中…',
      updateReleaseBtn: '前往 GitHub Release ↗',
      updateDirtyWarn: (n) =>
        `偵測到本地外掛目錄存在 ${n} 處未提交修改。為防止覆寫本地改動，已停用一鍵更新（絕不執行 git reset --hard）。請先提交或清理改動後重試。`,
      updateNonGitHint:
        '目前為非 Git 方式安裝，不會修改本地檔案；請前往 GitHub Release 下載最新版本。',
      updateReloadBanner: (ver) =>
        `已更新至 v${ver}，請在外掛管理器中關閉再開啟 project-threads 或重新載入 Antigravity 視窗生效。`,
      updateModalTitle: '確認更新外掛',
      updateModalConfirm: '確認更新',
      updateModalNote:
        '僅在本地工作區乾淨時安全執行快進拉取（fast-forward），絕不強制重設改動。更新完成後請在外掛管理器中關閉再開啟 project-threads 或重新載入 Antigravity 視窗生效。',
      updateToastUpToDate: '已是最新版本',
      updateToastAvailable: (ver) => `發現新版本 v${ver}`,
      updateToastApplied: '已更新至新版本，請重新載入外掛或視窗生效',
      updateToastCheckErr: '檢查更新失敗',
      updateToastApplyErr: '外掛更新失敗',
      apiTimeoutErr: (sec) => `請求逾時（超過 ${sec} 秒），請稍後重試。`,
      apiHttpErr: (status) => `側邊欄服務請求失敗（HTTP ${status}）`,
      apiInvalidJsonErr: '側邊欄後端回傳了非 JSON 回應，請稍後重試或重新載入外掛。',
      sidecarMismatchErr:
        '偵測到外掛後端程序版本滯後（缺少新介面路由）。請在外掛管理器中關閉再開啟 project-threads，或重新載入 Antigravity 視窗生效。',
      updateBadgeReloadRequired: '需重新載入',
      updateChannelMismatchHint:
        '後端程序版本滯後，重新載入外掛或視窗前暫無法確認目前渠道狀態。',
      updateBackendMismatchBanner: (startedVer, diskVer) =>
        startedVer && diskVer && startedVer !== diskVer
          ? `目前常駐後端程序（v${startedVer}）落後於磁碟外掛版本（v${diskVer}）。請在外掛管理器中關閉再開啟 project-threads，或重新載入 Antigravity 視窗生效。`
          : '偵測到常駐 Sidecar 後端程序版本滯後於目前頁面。請在外掛管理器中關閉再開啟 project-threads，或重新載入 Antigravity 視窗生效。',
      settingsBack: '返回',
      settingsScopeGlobal: '全域預設',
      settingsScopeProject: '目前專案',
      settingsScopeKickerGlobal: '全域預設設定',
      settingsScopeKickerProject: '目前專案覆寫',
      settingsGlobalHint:
        '適用於所有專案（除非個別專案另有覆寫）。總控派發與「新增」執行緒未指定模型時將套用此預設設定。',
      settingsProjectHint: (proj) =>
        `僅對目前專案「${proj}」生效；選擇「跟隨全域預設」即可繼承全域設定。`,
      settingsModelsHdr: '預設工作執行緒模型',
      settingsWorktreeLabel: '程式碼編輯 / Worktree 執行緒預設模型',
      settingsWorktreeDesc: '用於建立獨立 Git Worktree 分支並修改程式碼的任務（createWorktree: true）。',
      settingsReadOnlyLabel: '唯讀排查 / 無 Worktree 執行緒預設模型',
      settingsReadOnlyDesc: '用於快速唯讀排查或非 Git 專案任務（createWorktree: false）。',
      settingsFollowGlobal: (lbl) => `跟隨全域預設 (${lbl})`,
      settingsSave: '儲存設定',
      settingsSaving: '儲存中…',
      settingsSavedToast: '設定已儲存',
      settingsSaveErr: '儲存設定失敗',
      settingsResetGlobal: '恢復預設',
      settingsResetProject: '清除專案覆寫',
      settingsResetToast: '已恢復預設設定',
      settingsClearedProjectToast: '已清除目前專案覆寫',
      settingsModelColLabel: '模型',
      settingsTierColLabel: '檔位',
      settingsTierDefault: '預設',
      settingsTierStandard: '標準',
      settingsTierNone: '—',
      settingsInheritOption: '跟隨主會話模型 (inherit)',
      settingsInheritDraftOption: '跟隨主會話模型 (尚無回合記錄)',
      settingsInheritWithModel: (lbl) => `跟隨主會話模型 (${lbl})`,
      settingsInheritShort: '跟隨主會話模型',
      settingsInheritActiveNote: (model) =>
        `「跟隨主會話模型」讀取總控最近一次已執行回合的模型（目前：${model}）。在主視窗切換模型後，傳送一則訊息即可同步生效。`,
      settingsInheritDraftNote:
        '「跟隨主會話模型」讀取總控最近一次已執行回合的模型。目前尚無已執行回合記錄（草稿態），在總控會話傳送一則訊息後即可同步；在此之前新增執行緒將安全回退至 Gemini Pro。',
      settingsRefreshModelsTip: '重新整理模型清單與主會話模型',
      useSettingsDefault: (lbl) => `使用設定預設 (${lbl})`,
      usageTokensLabel: 'Tokens',
      usageCompactLine: '壓縮線',
      usageCompacts: (n) => `${n} 次壓縮`,
      usageDetailTip: (inp, out, cache) => `輸入 ${inp} | 輸出 ${out} | 快取 ${cache}`,
      decisionsTitle: '待決策',
      decisionBadge: '待決策',
      decisionAutoTag: '自動提示',
      decisionToggleTip: '展開或收起待決策區',
      decisionDismissTip: '忽略此提醒',
      decisionThreadTip: (tid) => `定位至執行緒 ${tid}`,
      decisionWorking: '處理中…',
      decisionSentCoordToast: '已將決策傳送給總控執行',
      decisionDismissedToast: '已忽略該待決策項',
      decisionActionErrToast: '執行決策操作失敗',
      decisionAutoMergeTitle: '分支已就緒，待合併',
      decisionAutoMergeSummary: (title, branch, commits) =>
        `${title}${branch ? `（${branch}，+${commits} 次提交）` : `（+${commits} 次提交）`}`,
      decisionAutoMergeBtn: '合併至目標分支',
      decisionAutoArchiveTitle: (isCherry) =>
        isCherry ? '已 cherry-pick 合併，待驗收封存' : '已合併，待驗收封存',
      decisionAutoArchiveSummary: (title, branch) => `${title}${branch ? `（${branch}）` : ''}`,
      decisionAutoArchiveBtn: '驗收封存',
      decisionDismissBtn: '忽略',
    },
  };

  let curLocale = 'en';
  const L = () => I18N[curLocale] || I18N.en;

  // ---------- Crisp Monochrome & Swarm Status SVG Icons ----------
  const ICONS = {
    chevronUp: '<svg class="ico ico-sm" viewBox="0 0 24 24"><polyline points="18 15 12 9 6 15"/></svg>',
    chevronDown: '<svg class="ico ico-sm" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>',
    chevronRight: '<svg class="ico ico-sm" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>',
    chevronLeft: '<svg class="ico ico-sm" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>',
    check: '<svg class="ico ico-sm" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>',
    plus: '<svg class="ico ico-sm" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    arrowUp:
      '<svg class="ico" viewBox="0 0 24 24"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
    copy: '<svg class="ico ico-xs" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    rowSpinner:
      '<svg class="row-spinner" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-opacity=".22" stroke-width="2" fill="none"/><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-dasharray="12 38" stroke-linecap="round" fill="none"/></svg>',
    doneCheck:
      '<span class="done-check-ico" aria-hidden="true"><svg viewBox="0 0 16 16"><polyline points="3.5 8.5 6.5 11.5 12.5 4.5"/></svg></span>',
    waitAlert: '<span class="wait-ico" aria-hidden="true">!</span>',
    archCheck:
      '<span class="arch-ico" aria-hidden="true"><svg viewBox="0 0 16 16"><polyline points="3.5 8.5 6.5 11.5 12.5 4.5"/></svg></span>',
    branch: '<svg class="ico ico-xs" viewBox="0 0 24 24"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
    folder: '<svg class="ico ico-xs" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    popout:
      '<svg class="ico ico-xs" viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    eye: '<svg class="ico ico-xs" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    close: '<svg class="ico ico-xs" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  };

  // ---------- Application State ----------
  let workspace = '';
  let lastHostConvId = '';
  let manualPopoutConvId = '';
  let hostProjectId = '';
  let activeScopeKey = null;
  let lastHasGitRepo = null;
  let isLiveOk = true;
  let currentTab = 'threads';
  let sortMode = 'priority'; // 'priority' | 'recent'
  let tasksCardCollapsed = true; // Compact 1-line summary bar by default (like Swarm o2-prog)
  let decisionsPanelCollapsed = false;
  const pendingDecisionIds = new Set();
  const threadOpenState = new Map(); // threadId -> boolean
  let lastBoardKey = '';
  let lastSnap = null;
  let cachedThreads = [];
  let cachedDecisions = [];
  let boardScrollTop = 0;

  let openThreadId = '';
  let openThreadObj = null;
  let lastThreadStamp = '';
  let lastRenderedItems = null;
  const openTraceIds = new Set();
  const closedLiveTraceIds = new Set();
  const openSubDetailIds = new Set();
  const expandedUserMsgIds = new Set();
  let briefExpanded = false;
  let isImeComposing = false;
  let toastTimer = null;
  let activeModalCtx = null;
  let selectableModels = [];
  let selectableModelsLoadedAt = 0;
  let selectableModelsLoading = false;
  let selectableModelsPromise = null;
  let modelMenuOpen = false;
  let modelMenuFamilyKey = '';
  const pendingModelByThread = new Map(); // threadId -> selected model object
  let settingsScreenOpen = false;
  let settingsScope = 'global'; // 'global' | 'project'
  let loadedSettingsData = null; // { settings, effective, scopeKey, coordinatorModelDisplayName, coordinatorModel }
  let settingsSaving = false;
  let settingsRefreshing = false;
  let settingsDirtyByUser = false;
  let lastCoordinatorTurnStamp = '';
  let settingsWorktreeGroups = [];
  let settingsReadOnlyGroups = [];
  let dispatchModelGroups = [];
  let pluginUpdateState = null;
  let pluginUpdateChecking = false;
  let pluginUpdateApplying = false;
  let pluginUpdateAppliedVersion = '';
  let pluginUpdatePollTimer = null;
  let backendVersionMismatch = null;
  let updateCardError = '';
  let updateStatusTimer = null;
  let updateStatusNotice = { text: '', tone: 'ok' };

  // ---------- DOM References ----------
  const elBoardScreen = document.getElementById('board-screen');
  const elThreadScreen = document.getElementById('thread-screen');
  const elSettingsScreen = document.getElementById('settings-screen');
  const elBtnSettings = document.getElementById('btn-settings');
  const elSettingsUpdateDot = document.getElementById('settings-update-dot');
  const elBtnSettingsBack = document.getElementById('btn-settings-back');
  const elSettingsScopeToggle = document.getElementById('settings-scope-toggle');
  const elBtnScopeGlobal = document.getElementById('btn-scope-global');
  const elBtnScopeProject = document.getElementById('btn-scope-project');
  const elSetWorktree = document.getElementById('set-worktree-model');
  const elSetWorktreeTier = document.getElementById('set-worktree-tier');
  const elSetReadOnly = document.getElementById('set-readonly-model');
  const elSetReadOnlyTier = document.getElementById('set-readonly-tier');
  const elFModel = document.getElementById('f-model');
  const elFTier = document.getElementById('f-tier');
  const elBtnSettingsSave = document.getElementById('btn-settings-save');
  const elBtnSettingsReset = document.getElementById('btn-settings-reset');
  const elBtnSettingsRefreshModels = document.getElementById('btn-settings-refresh-models');
  const elSettingsToast = document.getElementById('settings-toast');
  const elSettingsErr = document.getElementById('settings-err');
  const elSettingsInheritNote = document.getElementById('settings-inherit-note');
  const elUpdateCard = document.getElementById('settings-update-card');
  const elUpdateBadge = document.getElementById('update-status-badge');
  const elBtnChannelStable = document.getElementById('btn-channel-stable');
  const elBtnChannelDev = document.getElementById('btn-channel-dev');
  const elBtnUpdateCheck = document.getElementById('btn-update-check');
  const elBtnUpdateApply = document.getElementById('btn-update-apply');
  const elBtnUpdateRelease = document.getElementById('btn-update-release');
  const elUpdateDirtyWarn = document.getElementById('update-dirty-warn');
  const elUpdateNonGitHint = document.getElementById('update-nongit-hint');
  const elUpdateReloadBanner = document.getElementById('update-reload-banner');
  const elUpdateErr = document.getElementById('update-err');
  const elUpdateStatusMsg = document.getElementById('update-status-msg');
  const elBoardBody = document.getElementById('board-body');
  const elLivePill = document.getElementById('live-pill');
  const elLiveLabel = document.getElementById('live-label');
  const elDrawer = document.getElementById('dispatch-drawer');
  const elNewBtn = document.getElementById('btn-new');
  const elToast = document.getElementById('toast');
  const elGoalCard = document.getElementById('goal-card');
  const elDecisionsPanel = document.getElementById('decisions-panel');
  const elBtnOpenCoord = document.getElementById('btn-open-coord');
  const elBtnCardCoord = document.getElementById('btn-card-coord');
  const elBtnChatCoord = document.getElementById('btn-chat-coord');
  const elChatStream = document.getElementById('chat-stream');
  const elChatInput = document.getElementById('chat-input');
  const elSendBtn = document.getElementById('btn-send');
  const elLiveBar = document.getElementById('live-bar');
  const elModelMenu = document.getElementById('pt-model-menu');
  const elModalBackdrop = document.getElementById('pt-modal-backdrop');
  const elModalTitle = document.getElementById('pt-modal-title');
  const elModalClose = document.getElementById('pt-modal-close');
  const elModalThread = document.getElementById('pt-modal-thread');
  const elModalWtInfo = document.getElementById('pt-modal-wt-info');
  const elModalWarn = document.getElementById('pt-modal-warn');
  const elModalRemoveRow = document.getElementById('pt-modal-remove-row');
  const elModalRemoveWt = document.getElementById('pt-modal-remove-wt');
  const elLblModalRemoveWt = document.getElementById('lbl-modal-remove-wt');
  const elModalBranchRow = document.getElementById('pt-modal-branch-row');
  const elModalDelBranch = document.getElementById('pt-modal-del-branch');
  const elLblModalDelBranch = document.getElementById('lbl-modal-del-branch');
  const elModalForceRow = document.getElementById('pt-modal-force-row');
  const elModalForceWt = document.getElementById('pt-modal-force-wt');
  const elLblModalForceWt = document.getElementById('lbl-modal-force-wt');
  const elModalErr = document.getElementById('pt-modal-err');
  const elModalCancel = document.getElementById('pt-modal-cancel');
  const elModalConfirm = document.getElementById('pt-modal-confirm');

  const esc = (s) =>
    String(s || '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );

  const lowerFirst = (s) => {
    const str = String(s || '');
    if (!str) return '';
    return /^[A-Z][a-z]/.test(str) ? str[0].toLowerCase() + str.slice(1) : str;
  };

  const isPanelHidden = () =>
    document.hidden || window.innerWidth === 0 || window.innerHeight === 0;

  async function syncHostConversationScope() {
    const convId = getHostConvId();
    if (convId === lastHostConvId) {
      return false;
    }
    lastHostConvId = convId;
    manualPopoutConvId = '';
    hostProjectId = '';
    lastBoardKey = '';
    if (convId && window.sidecar?.agent?.getConversationMetadata) {
      let metaTimer = null;
      try {
        const meta = await Promise.race([
          Promise.resolve(window.sidecar.agent.getConversationMetadata(convId)),
          new Promise((_, reject) => {
            metaTimer = setTimeout(() => reject(new Error('host_meta_timeout')), HOST_META_TIMEOUT_MS);
          }),
        ]);
        const nestedMeta =
          meta?.response?.conversationMetadata?.metadata ||
          meta?.response?.conversation_metadata?.metadata ||
          meta?.conversation?.metadata ||
          meta?.metadata ||
          meta;
        const rawPid = nestedMeta?.projectId || nestedMeta?.project_id || '';
        if (getHostConvId() === convId) {
          hostProjectId =
            rawPid && rawPid !== 'outside-of-project' ? String(rawPid).trim() : '';
        }
      } catch {
        // Backend also resolves authoritative projectId via LS GetConversation
      } finally {
        if (metaTimer) clearTimeout(metaTimer);
      }
    }
    return true;
  }

  function buildScopePayload(extra = {}) {
    return {
      workspace,
      conversationId: getHostConvId(),
      projectId: hostProjectId,
      ...extra,
    };
  }

  // ---------- Host Theme Sync (Dark / Light, matching Swarm probe) ----------
  function syncThemeScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background,#131416)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const target = lum > 0.5 ? 'light' : 'dark';
    if (document.documentElement.dataset.theme !== target) {
      document.documentElement.dataset.theme = target;
    }
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'theme-change') {
      setTimeout(syncThemeScheme, 10);
    }
  });
  new MutationObserver(syncThemeScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
  syncThemeScheme();

  function setLiveStatus(ok) {
    isLiveOk = ok;
    const t = L();
    elLivePill.classList.toggle('stale', !ok);
    elLiveLabel.textContent = ok ? t.liveOk : t.liveStale;
    elLivePill.title = ok ? t.liveTipOk : t.liveTipStale;
  }

  function getActiveMainWorkerConvId() {
    const coordConvId = lastSnap?.coordinator?.conversationId || '';
    const allThreads = lastSnap?.threads || cachedThreads || [];
    if (manualPopoutConvId && manualPopoutConvId !== coordConvId) {
      return manualPopoutConvId;
    }
    const hostId = getHostConvId();
    if (
      hostId &&
      hostId !== coordConvId &&
      allThreads.some((x) => x.conversationId === hostId)
    ) {
      return hostId;
    }
    return '';
  }

  function isAwayFromCoordinator(coordConvId) {
    if (!coordConvId) return false;
    return Boolean(getActiveMainWorkerConvId());
  }

  function updateCoordinatorControls() {
    const coordConvId = lastSnap?.coordinator?.conversationId || '';
    const hasCoord = Boolean(coordConvId);
    const away = isAwayFromCoordinator(coordConvId);
    const t = L();

    if (elBtnOpenCoord) {
      elBtnOpenCoord.hidden = !hasCoord;
      elBtnOpenCoord.classList.toggle('away', away);
      elBtnOpenCoord.textContent = away ? t.coordJumpBtn : t.coordCalmBtn;
      elBtnOpenCoord.title = t.coordJumpTip;
    }

    if (elGoalCard) {
      elGoalCard.classList.toggle('clickable', hasCoord);
    }

    if (elBtnCardCoord) {
      elBtnCardCoord.hidden = !hasCoord;
      elBtnCardCoord.classList.toggle('away', away);
      elBtnCardCoord.textContent = away ? t.coordCardBack : t.coordCardOpen;
      elBtnCardCoord.title = t.coordJumpTip;
    }

    if (elBtnChatCoord) {
      elBtnChatCoord.hidden = !hasCoord;
      elBtnChatCoord.classList.toggle('away', away);
      elBtnChatCoord.textContent = away ? t.coordJumpBtn : t.coordCalmBtn;
      elBtnChatCoord.title = t.coordJumpTip;
    }
  }

  function syncSendButtonState() {
    const hasText = elChatInput.value.trim().length > 0;
    const isRunning = Boolean(
      openThreadObj && !openThreadObj.archived && openThreadObj.runState === 'RUN_STATE_RUNNING',
    );
    const t = L();
    if (isRunning && !hasText) {
      elSendBtn.classList.remove('ready');
      elSendBtn.classList.add('running-stop');
      if (!elSendBtn.querySelector('.stop-sq')) {
        elSendBtn.innerHTML = '<span class="stop-sq" aria-hidden="true"></span>';
      }
      elSendBtn.title = t.runningStateTip;
    } else {
      elSendBtn.classList.remove('running-stop');
      elSendBtn.classList.toggle('ready', hasText);
      if (elSendBtn.querySelector('.stop-sq') || !elSendBtn.querySelector('svg')) {
        elSendBtn.innerHTML = ICONS.arrowUp;
      }
      elSendBtn.title = t.sendTip;
    }
  }

  // ---------- Live Global Locale Application ----------
  function applyLocale(nextLocale) {
    const target = I18N[nextLocale] ? nextLocale : 'en';
    const changed = target !== curLocale;
    curLocale = target;
    document.documentElement.lang = curLocale;
    const t = L();

    document.getElementById('lbl-tab-threads').textContent = t.tabThreads;
    document.getElementById('lbl-tab-library').textContent = t.tabLibrary;
    document.getElementById('lbl-tab-archived').textContent = t.tabArchived;
    setLiveStatus(isLiveOk);
    document.getElementById('lbl-new').textContent = t.newBtn;
    syncSettingsUpdateDot();
    document.getElementById('btn-bind').textContent = t.bindBtn;
    document.getElementById('lbl-sort').textContent =
      sortMode === 'priority' ? t.sortPriority : t.sortRecent;

    if (!lastSnap) {
      const panelTitleEl = document.getElementById('panel-title');
      panelTitleEl.textContent = t.panelTitle;
      panelTitleEl.title = t.panelTitle;
      document.getElementById('goal-kicker-text').textContent = t.kickerProject;
      const goalTitleEl = document.getElementById('goal-title');
      goalTitleEl.textContent = t.defaultProjTitle;
      goalTitleEl.title = '';
    }

    document.getElementById('lbl-drawer-title').textContent = t.drawerTitle;
    document.getElementById('btn-close-drawer').title = t.closeTip;
    document.getElementById('lbl-f-title').textContent = t.fTitle;
    document.getElementById('f-title').placeholder = t.fTitlePh;
    document.getElementById('lbl-f-branch').textContent = t.fBranch;
    document.getElementById('lbl-f-model').textContent = t.fModel;
    const lblFTier = document.getElementById('lbl-f-tier');
    if (lblFTier) lblFTier.textContent = t.fTier;
    const wtChk = document.getElementById('f-wt');
    document.getElementById('lbl-f-wt').textContent = wtChk.disabled ? t.fWtDisabled : t.fWt;
    document.getElementById('lbl-f-prompt').textContent = t.fPrompt;
    document.getElementById('f-prompt').placeholder = t.fPromptPh;
    const submitBtn = document.getElementById('btn-submit-dispatch');
    if (!submitBtn.disabled) submitBtn.textContent = t.fSubmit;
    document.getElementById('btn-cancel-dispatch').textContent = t.fCancel;

    document.getElementById('lbl-lib-mem').textContent = t.libMem;
    const saveMemBtn = document.getElementById('btn-save-mem');
    if (!saveMemBtn.disabled) saveMemBtn.textContent = t.libSave;
    document.getElementById('btn-reload-mem').textContent = t.libReload;
    document.getElementById('lbl-lib-wt').textContent = t.libWt;

    document.getElementById('lbl-back').textContent = t.backThreads;
    const syncBtn = document.getElementById('btn-sync-coord');
    if (!syncBtn.disabled) syncBtn.textContent = t.syncCoord;
    syncBtn.title = t.syncTip;
    document.getElementById('btn-archive-cur').textContent = t.actArchive;
    document.getElementById('btn-popout-cur').title = t.popoutTip;
    elChatInput.placeholder = t.composerPh;

    updateCoordinatorControls();
    syncSendButtonState();
    populateDispatchModelSelect();
    if (settingsScreenOpen && elSettingsScreen) {
      renderSettingsScreen(false);
      renderUpdateCard();
    }

    if (changed) {
      if (lastSnap) renderBoard(lastSnap);
      if (openThreadObj) renderThreadHeader(openThreadObj);
      if (modelMenuOpen) renderModelMenu();
      if (openThreadId && Array.isArray(lastRenderedItems)) {
        renderThreadItems(lastRenderedItems, false);
      }
    }
    return changed;
  }

  function flashToast(msg, tone = 'ok', durationMs = 2400) {
    if (toastTimer) clearTimeout(toastTimer);
    const text = String(msg || '');
    const cls = tone === 'err' ? 'toast err' : tone === 'warn' ? 'toast warn' : 'toast';
    for (const target of [elToast, elSettingsToast]) {
      if (!target) continue;
      target.className = cls;
      target.textContent = text;
      target.title = text;
    }
    toastTimer = setTimeout(() => {
      for (const target of [elToast, elSettingsToast]) {
        if (!target) continue;
        target.textContent = '';
        target.title = '';
        target.className = 'toast';
      }
    }, durationMs);
  }

  function showArchiveResultToast(res) {
    const t = L();
    if (!res || !res.ok) {
      flashToast(res?.error || t.archiveErrToast, 'err', 4200);
      return;
    }
    if (res.worktreeRemoved && res.branchDeleted) {
      flashToast(t.archivedWtAndBranchToast, 'ok', 2800);
    } else if (res.worktreeRemoved) {
      flashToast(t.archivedWtToast, 'ok', 2800);
    } else if (res.pruned) {
      flashToast(t.archivedPrunedToast, 'ok', 2800);
    } else if (res.skippedReason === 'uncommitted_changes') {
      flashToast(t.archivedKeptDirtyToast, 'warn', 4200);
    } else if (res.skippedReason === 'unmerged_commits') {
      flashToast(t.archivedKeptUnmergedToast, 'warn', 4200);
    } else if (res.worktreeError) {
      flashToast(t.archivedWtErrToast(res.worktreeError), 'warn', 4800);
    } else {
      flashToast(t.archivedToast, 'ok', 2200);
    }
  }

  function showCleanupResultToast(res) {
    const t = L();
    if (!res) {
      flashToast(t.cleanupErrToast, 'err', 4200);
      return;
    }
    if (res.worktreeRemoved && res.branchDeleted) {
      flashToast(t.cleanedWtAndBranchToast, 'ok', 2800);
    } else if (res.worktreeRemoved) {
      flashToast(t.cleanedWtToast, 'ok', 2800);
    } else if (res.pruned) {
      flashToast(t.cleanedPrunedToast, 'ok', 2800);
    } else if (res.skippedReason === 'uncommitted_changes') {
      flashToast(t.keptDirtyToast, 'warn', 4200);
    } else if (res.skippedReason === 'unmerged_commits') {
      flashToast(t.keptUnmergedToast, 'warn', 4200);
    } else if (!res.ok || res.worktreeError || res.error) {
      flashToast(res.worktreeError || res.error || t.cleanupErrToast, 'err', 4800);
    } else {
      flashToast(t.cleanedWtToast, 'ok', 2400);
    }
  }

  function syncModalConfirmButton() {
    if (!activeModalCtx) return;
    const t = L();
    if (activeModalCtx.mode === 'plugin_update') {
      elModalConfirm.className = 'btn-solid';
      elModalConfirm.textContent = activeModalCtx.busy ? t.updateApplyingBtn : t.updateModalConfirm;
      return;
    }
    const isForce = !elModalForceRow.hidden && elModalForceWt.checked;
    elModalConfirm.className = isForce ? 'btn-danger' : 'btn-solid';
    if (activeModalCtx.busy) {
      elModalConfirm.textContent = t.modalWorking;
      return;
    }
    if (activeModalCtx.mode === 'cleanup') {
      elModalConfirm.textContent = isForce ? t.modalCleanForceConfirm : t.modalCleanConfirm;
    } else {
      elModalConfirm.textContent = isForce ? t.modalArchiveForceConfirm : t.modalArchiveConfirm;
    }
  }

  function closePtModal(force = false) {
    if (!activeModalCtx) return;
    if (activeModalCtx.busy && !force) return;
    if (activeModalCtx.triggerBtn) {
      activeModalCtx.triggerBtn.disabled = false;
    }
    activeModalCtx = null;
    elModalBackdrop.hidden = true;
    elModalErr.hidden = true;
    elModalErr.textContent = '';
  }

  function openWorktreeModal({ mode, thread, triggerBtn = null, onDone = null }) {
    const t = L();
    const dirtyCount = Number(thread.git?.dirtyCount) || 0;
    const aheadCount = Number(thread.git?.aheadCount) || 0;
    const wtExists = thread.git ? thread.git.exists !== false : true;
    const isCherryPicked = Boolean(thread.git?.merged && thread.git?.mergeMethod === 'cherry-pick');
    const isMerged =
      typeof thread.git?.merged === 'boolean' ? thread.git.merged : aheadCount === 0;
    const unmergedAheadCount = isMerged ? 0 : aheadCount;
    const isDirtyOrUnmerged = wtExists && (dirtyCount > 0 || unmergedAheadCount > 0);
    const branchName = thread.git?.branch || thread.branch || '';

    activeModalCtx = {
      mode,
      thread,
      triggerBtn,
      busy: false,
      onDone,
    };

    elModalTitle.textContent = mode === 'cleanup' ? t.modalCleanTitle : t.modalArchiveTitle;
    elModalClose.title = t.closeTip;
    elModalCancel.textContent = t.fCancel;
    elModalThread.textContent = thread.threadId
      ? `[${thread.threadId}] ${thread.title || ''}`
      : thread.title || '';

    const pills = [];
    if (branchName) {
      pills.push(`<span class="branch-pill">${ICONS.branch} <span>${esc(branchName)}</span></span>`);
    }
    if (!wtExists) {
      pills.push(`<span class="wt-pill">${esc(t.modalStatusMissing)}</span>`);
    } else if (isDirtyOrUnmerged) {
      if (unmergedAheadCount > 0) {
        pills.push(`<span class="commit-pill">${esc(t.subCommits(unmergedAheadCount))}</span>`);
      } else if (isCherryPicked) {
        pills.push(`<span class="wt-pill">${esc(t.wtCherryPicked)}</span>`);
      }
      if (dirtyCount > 0) pills.push(`<span class="dirty-pill">${esc(t.subDirty(dirtyCount))}</span>`);
    } else if (isCherryPicked) {
      pills.push(`<span class="wt-pill">${esc(t.modalStatusCherryPicked)}</span>`);
    } else {
      pills.push(`<span class="wt-pill">${esc(t.modalStatusClean)}</span>`);
    }
    if (thread.worktreePath) {
      pills.push(`<span class="pt-modal-path" title="${esc(thread.worktreePath)}">${esc(thread.worktreePath)}</span>`);
    }
    elModalWtInfo.innerHTML = pills.join('');

    if (isDirtyOrUnmerged) {
      elModalWarn.hidden = false;
      elModalWarn.textContent = t.modalWarnDirtyUnmerged(dirtyCount, unmergedAheadCount);
    } else {
      elModalWarn.hidden = true;
      elModalWarn.textContent = '';
    }

    if (mode === 'archive') {
      elModalRemoveRow.hidden = false;
      elModalRemoveWt.checked = !isDirtyOrUnmerged;
      elLblModalRemoveWt.textContent = t.modalRemoveWtOpt;
      elModalBranchRow.hidden = true;
    } else {
      elModalRemoveRow.hidden = true;
      elModalRemoveWt.checked = true;
      elModalBranchRow.hidden = !branchName;
      elModalDelBranch.checked = true;
      elLblModalDelBranch.textContent = t.modalDelBranchOpt;
    }

    if (isDirtyOrUnmerged) {
      elModalForceRow.hidden = false;
      elModalForceWt.checked = false;
      elLblModalForceWt.textContent = t.modalForceWtOpt;
    } else {
      elModalForceRow.hidden = true;
      elModalForceWt.checked = false;
    }

    elModalErr.hidden = true;
    elModalErr.textContent = '';
    elModalConfirm.disabled = false;
    elModalCancel.disabled = false;
    elModalClose.disabled = false;
    elModalRemoveWt.disabled = false;
    elModalDelBranch.disabled = false;
    elModalForceWt.disabled = false;

    syncModalConfirmButton();
    elModalBackdrop.hidden = false;
    (isDirtyOrUnmerged ? elModalCancel : elModalConfirm).focus();
  }

  async function requestArchiveThread(th, { triggerBtn = null, onArchived = null } = {}) {
    if (!th || !th.threadId) return;
    if (!th.worktreePath) {
      if (triggerBtn) triggerBtn.disabled = true;
      try {
        const res = await postApi('/api/archive', '/api/archive_get', {
          threadId: th.threadId,
          removeWorktree: false,
        });
        lastBoardKey = '';
        if (res?.ok && typeof onArchived === 'function') await onArchived(res);
        await refreshBoard(true);
        showArchiveResultToast(res);
      } catch (err) {
        flashToast(err?.message || L().archiveErrToast, 'err', 4200);
      } finally {
        if (triggerBtn) triggerBtn.disabled = false;
      }
      return;
    }
    openWorktreeModal({
      mode: 'archive',
      thread: th,
      triggerBtn,
      onDone: onArchived,
    });
  }

  function requestCleanWorktree(th, { triggerBtn = null, onCleaned = null } = {}) {
    if (!th || !th.threadId || !th.worktreePath) return;
    openWorktreeModal({
      mode: 'cleanup',
      thread: th,
      triggerBtn,
      onDone: onCleaned,
    });
  }

  function relTime(isoStr) {
    if (!isoStr) return '';
    const ms = Date.now() - Date.parse(isoStr);
    if (!Number.isFinite(ms) || ms < 0) return L().justNow;
    const sec = Math.floor(ms / 1000);
    if (sec < 45) return L().justNow;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    return `${Math.floor(hr / 24)}d`;
  }

  function relTimeAgo(isoStr) {
    if (!isoStr) return '';
    const t = L();
    const ms = Date.now() - Date.parse(isoStr);
    if (!Number.isFinite(ms) || ms < 0) return t.justNowAgo;
    const sec = Math.floor(ms / 1000);
    if (sec < 45) return t.justNowAgo;
    const min = Math.floor(sec / 60);
    if (min < 60) return t.agoTime(min, 'm');
    const hr = Math.floor(min / 60);
    if (hr < 24) return t.agoTime(hr, 'h');
    return t.agoTime(Math.floor(hr / 24), 'd');
  }

  function fmtWorkedDuration(sec) {
    const s = Math.max(1, Math.round(Number(sec) || 1));
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return L().fmtDuration(m, rem);
  }

  function formatModelDisplay(input) {
    const raw =
      input && typeof input === 'object'
        ? String(input.modelDisplayName || input.resolvedModel || input.model || '').trim()
        : String(input || '').trim();
    if (!raw) return 'Gemini Pro';

    const lower = raw.toLowerCase();
    const tierLabels = {
      pro: 'Gemini Pro',
      'gemini pro': 'Gemini Pro',
      'gemini-pro': 'Gemini Pro',
      auto: 'Gemini Pro',
      inherit: 'Follow Coordinator (inherit)',
      flash: 'Gemini Flash',
      'gemini flash': 'Gemini Flash',
      'gemini-flash': 'Gemini Flash',
      flash_lite: 'Gemini Flash Lite',
      'flash-lite': 'Gemini Flash Lite',
      lite: 'Gemini Flash Lite',
      'gemini flash lite': 'Gemini Flash Lite',
      'gemini-flash-lite': 'Gemini Flash Lite',
    };
    if (tierLabels[lower]) return tierLabels[lower];
    if (/^MODEL_PLACEHOLDER_/i.test(raw)) return 'Gemini Pro';

    if (!/^MODEL_[A-Z0-9_]+$/i.test(raw) && (/\s/.test(raw) || /[A-Z]/.test(raw))) {
      return raw;
    }

    let slug = raw.replace(/^MODEL_(?:GOOGLE_|ANTHROPIC_|OPENAI_)?/i, '');
    slug = slug.replace(/-tiered-/gi, '-').replace(/[-_](?:tiered|disabled)$/gi, '');

    const tokens = slug.split(/[-_]+/).filter(Boolean);
    if (!tokens.length) return 'Gemini Pro';

    const effortLabels = {
      xhigh: 'XHigh',
      high: 'High',
      medium: 'Medium',
      low: 'Low',
      thinking: 'Thinking',
    };
    let effortSuffix = '';
    const lastTok = tokens[tokens.length - 1].toLowerCase();
    if (tokens.length > 1 && effortLabels[lastTok]) {
      effortSuffix = effortLabels[lastTok];
      tokens.pop();
    }

    const words = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const tokLow = tok.toLowerCase();
      if (/^\d{1,2}$/.test(tok) && i + 1 < tokens.length && /^\d{1,2}$/.test(tokens[i + 1])) {
        words.push(`${tok}.${tokens[i + 1]}`);
        i++;
        continue;
      }
      if (tokLow === 'gpt' && i + 1 < tokens.length && tokens[i + 1].toLowerCase() === 'oss') {
        words.push('GPT-OSS');
        i++;
        continue;
      }
      if (tokLow === 'gpt') words.push('GPT');
      else if (tokLow === 'oss') words.push('OSS');
      else if (tokLow === 'xhigh') words.push('XHigh');
      else if (/^\d+[bkmt]$/i.test(tok)) words.push(tok.toUpperCase());
      else if (/^\d+(?:\.\d+)*$/.test(tok)) words.push(tok);
      else words.push(tok[0].toUpperCase() + tok.slice(1).toLowerCase());
    }

    const baseName = words.join(' ').trim();
    if (!baseName) return 'Gemini Pro';
    return effortSuffix ? `${baseName} (${effortSuffix})` : baseName;
  }

  function normalizeComparableTokens(str) {
    return String(str || '')
      .toLowerCase()
      .replace(/\bextra[\s_-]*high\b/g, ' xhigh ')
      .replace(/\bx[\s_-]+high\b/g, ' xhigh ')
      .replace(/\(thinking\)|[-_]thinking\b/g, ' ')
      .replace(/\btiered\b|\bdisabled\b/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  function isSameModelFamily(displayName, slug) {
    const a = normalizeComparableTokens(displayName);
    const b = normalizeComparableTokens(slug);
    if (!a.length || a.length !== b.length) return false;
    return a.every((tok, idx) => tok === b[idx]);
  }

  const TIER_SORT_RANK = {
    minimal: 10,
    low: 20,
    standard: 25,
    default: 25,
    none: 25,
    medium: 30,
    high: 40,
    xhigh: 50,
    'extra high': 50,
    max: 60,
    thinking: 70,
  };

  function canonicalizeTierAliasKey(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'pro' || s === 'gemini pro' || s === 'gemini-pro') return 'pro';
    if (s === 'flash' || s === 'gemini flash' || s === 'gemini-flash') return 'flash';
    if (
      s === 'flash_lite' ||
      s === 'flash-lite' ||
      s === 'lite' ||
      s === 'gemini flash lite' ||
      s === 'gemini-flash-lite'
    ) {
      return 'flash_lite';
    }
    return '';
  }

  function buildModelFamilyGroups(catalogModels = [], options = {}) {
    const {
      includeFollowGlobal = false,
      followGlobalLabel = 'Follow Global Default',
      followGlobalTierLabel = '—',
      includeInherit = true,
      inheritLabel = 'Follow Coordinator (inherit)',
      inheritTierLabel = '—',
      defaultTierLabel = 'Default',
      standardTierLabel = 'Standard',
    } = options || {};

    const groups = [];

    if (includeFollowGlobal) {
      groups.push({
        key: '__follow_global__',
        label: followGlobalLabel,
        kind: 'follow_global',
        hasTiers: false,
        defaultValue: '',
        tiers: [
          {
            value: '',
            label: followGlobalTierLabel,
            rawLabel: followGlobalLabel,
            modelId: '',
            modelEnum: '',
            modelAlias: '',
            isDefault: false,
          },
        ],
      });
    }

    if (includeInherit) {
      groups.push({
        key: '__inherit__',
        label: inheritLabel,
        kind: 'inherit',
        hasTiers: false,
        defaultValue: 'inherit',
        tiers: [
          {
            value: 'inherit',
            label: inheritTierLabel,
            rawLabel: inheritLabel,
            modelId: '',
            modelEnum: '',
            modelAlias: '',
            isDefault: false,
          },
        ],
      });
    }

    const buckets = [];
    const bucketByKey = new Map();

    for (const m of Array.isArray(catalogModels) ? catalogModels : []) {
      if (!m || typeof m !== 'object') continue;
      const val = String(m.id || m.modelId || m.modelEnum || m.modelAlias || '').trim();
      if (!val) continue;
      const rawLabel = String(m.label || formatModelDisplay(val)).trim();
      const parenMatch = rawLabel.match(/^(.+?)\s*\(([^()]+)\)\s*$/);
      const famName = String(m.familyName || '').trim();

      let baseName = '';
      let tierCandidate = '';
      if (famName) {
        baseName = famName;
        if (parenMatch && parenMatch[1].trim().toLowerCase() === famName.toLowerCase()) {
          tierCandidate = parenMatch[2].trim();
        } else if (m.thinkingLevel) {
          tierCandidate = String(m.thinkingLevel).trim();
        } else if (parenMatch) {
          tierCandidate = parenMatch[2].trim();
        }
      } else if (parenMatch) {
        baseName = parenMatch[1].trim();
        tierCandidate = parenMatch[2].trim();
      } else {
        baseName = rawLabel;
        tierCandidate = '';
      }

      const bucketKey = `family:${baseName.toLowerCase()}`;
      let bucket = bucketByKey.get(bucketKey);
      if (!bucket) {
        bucket = {
          key: bucketKey,
          baseName,
          items: [],
        };
        bucketByKey.set(bucketKey, bucket);
        buckets.push(bucket);
      }
      bucket.items.push({
        value: val,
        tierCandidate,
        rawLabel,
        modelId: String(m.modelId || '').trim(),
        modelEnum: String(m.modelEnum || '').trim(),
        modelAlias: String(m.modelAlias || '').trim(),
        isDefault: Boolean(m.isDefault),
        tagTitle: String(m.tagTitle || '').trim(),
        tagDescription: String(m.tagDescription || '').trim(),
        description: String(m.description || '').trim(),
        quotaInfo: m.quotaInfo && typeof m.quotaInfo === 'object' ? m.quotaInfo : null,
        idx: bucket.items.length,
      });
    }

    for (const bucket of buckets) {
      if (bucket.items.length === 1) {
        const only = bucket.items[0];
        groups.push({
          key: bucket.key,
          label: only.rawLabel,
          kind: 'family',
          hasTiers: false,
          defaultValue: only.value,
          tiers: [
            {
              value: only.value,
              label: defaultTierLabel,
              rawLabel: only.rawLabel,
              modelId: only.modelId,
              modelEnum: only.modelEnum,
              modelAlias: only.modelAlias,
              isDefault: only.isDefault,
              tagTitle: only.tagTitle,
              tagDescription: only.tagDescription,
              description: only.description,
              quotaInfo: only.quotaInfo,
            },
          ],
        });
        continue;
      }

      const sorted = [...bucket.items].sort((a, b) => {
        const ak = (a.tierCandidate || 'standard').toLowerCase();
        const bk = (b.tierCandidate || 'standard').toLowerCase();
        const ar = TIER_SORT_RANK[ak] ?? 100 + a.idx;
        const br = TIER_SORT_RANK[bk] ?? 100 + b.idx;
        return ar !== br ? ar - br : a.idx - b.idx;
      });
      const tiers = sorted.map((it) => ({
        value: it.value,
        label: it.tierCandidate || standardTierLabel,
        rawLabel: it.rawLabel,
        modelId: it.modelId,
        modelEnum: it.modelEnum,
        modelAlias: it.modelAlias,
        isDefault: it.isDefault,
        tagTitle: it.tagTitle,
        tagDescription: it.tagDescription,
        description: it.description,
        quotaInfo: it.quotaInfo,
      }));
      const defaultValue =
        tiers.find((t) => t.isDefault)?.value ||
        tiers.find((t) => /^high$/i.test(t.label))?.value ||
        tiers.find((t) => /^medium$/i.test(t.label))?.value ||
        tiers[0].value;
      groups.push({
        key: bucket.key,
        label: bucket.baseName,
        kind: 'family',
        hasTiers: true,
        defaultValue,
        tiers,
      });
    }

    return groups;
  }

  function pickPreferredTierForLegacyAlias(group, matchedTier = null) {
    const tiers = Array.isArray(group?.tiers) ? group.tiers : [];
    return (
      tiers.find((t) => t.isDefault) ||
      tiers.find((t) => t.value === group?.defaultValue) ||
      matchedTier ||
      tiers[0] ||
      null
    );
  }

  function findConcreteModelForLegacyAlias(tierKey, familyGroups = []) {
    const list = Array.isArray(familyGroups) ? familyGroups : [];
    if (!list.length) return null;

    const pickMatch = (predicate) => {
      for (const g of list) {
        for (const t of g.tiers || []) {
          const text = `${g.label || ''} ${t.rawLabel || ''} ${t.modelId || ''} ${t.value || ''}`.toLowerCase();
          if (predicate(g, t, text)) {
            const tier = pickPreferredTierForLegacyAlias(g, t);
            if (tier) return { group: g, tier };
          }
        }
      }
      return null;
    };

    if (tierKey === 'flash_lite') {
      const lite = pickMatch((_g, _t, text) => /\bflash[-_\s]*lite\b|\blite\b/.test(text));
      if (lite) return lite;
    }
    if (tierKey === 'flash_lite' || tierKey === 'flash') {
      const flash = pickMatch(
        (_g, _t, text) => /\bflash\b/.test(text) && !/\b(?:flash[-_\s]*lite|lite)\b/.test(text),
      );
      if (flash) return flash;
    }

    const catalogDefault = pickMatch((_g, t) => Boolean(t.isDefault));
    if (catalogDefault) return catalogDefault;
    const geminiConcrete = pickMatch(
      (g, _t, text) => /\bgemini\b/.test(String(g.label || text).toLowerCase()) && !/\b(?:flash|lite)\b/.test(text),
    );
    if (geminiConcrete) return geminiConcrete;
    const namedPro = pickMatch((_g, _t, text) => /\bpro\b/.test(text));
    if (namedPro) return namedPro;

    const firstGroup = list[0];
    const firstTier = pickPreferredTierForLegacyAlias(firstGroup, firstGroup?.tiers?.[0] || null);
    return firstGroup && firstTier ? { group: firstGroup, tier: firstTier } : null;
  }

  function resolveModelFamilySelection(rawValue, groups = [], options = {}) {
    const { savedLabels = {}, defaultTierLabel = 'Default', fallbackValue = 'inherit' } = options || {};
    const list = Array.isArray(groups) ? groups : [];
    const raw = String(rawValue || '').trim();
    const low = raw.toLowerCase();

    if (!raw || low === 'default' || low === 'auto') {
      const followGlobalGroup = list.find((g) => g.kind === 'follow_global');
      if (followGlobalGroup) {
        return {
          groups: list,
          groupKey: followGlobalGroup.key,
          value: '',
          group: followGlobalGroup,
          tier: followGlobalGroup.tiers[0] || null,
          isFallback: false,
        };
      }
      if (fallbackValue && fallbackValue !== raw) {
        return resolveModelFamilySelection(fallbackValue, list, options);
      }
    }

    if (low === 'inherit') {
      const inheritGroup = list.find((g) => g.kind === 'inherit');
      if (inheritGroup) {
        return {
          groups: list,
          groupKey: inheritGroup.key,
          value: 'inherit',
          group: inheritGroup,
          tier: inheritGroup.tiers[0] || null,
          isFallback: false,
        };
      }
    }

    const familyGroups = list.filter((g) => g.kind === 'family');
    const tierKey = canonicalizeTierAliasKey(raw);
    if (tierKey) {
      const concreteMatch = findConcreteModelForLegacyAlias(tierKey, familyGroups);
      if (concreteMatch) {
        return {
          groups: list,
          groupKey: concreteMatch.group.key,
          value: concreteMatch.tier.value,
          group: concreteMatch.group,
          tier: concreteMatch.tier,
          isFallback: false,
        };
      }
      if (fallbackValue === '') {
        const followGlobalGroup = list.find((g) => g.kind === 'follow_global');
        if (followGlobalGroup) {
          return {
            groups: list,
            groupKey: followGlobalGroup.key,
            value: '',
            group: followGlobalGroup,
            tier: followGlobalGroup.tiers[0] || null,
            isFallback: true,
          };
        }
      }
      const inheritGroup = list.find((g) => g.kind === 'inherit');
      if (inheritGroup) {
        return {
          groups: list,
          groupKey: inheritGroup.key,
          value: 'inherit',
          group: inheritGroup,
          tier: inheritGroup.tiers[0] || null,
          isFallback: true,
        };
      }
      const firstGroup = list[0] || null;
      const firstTier = firstGroup?.tiers?.[0] || null;
      return {
        groups: list,
        groupKey: firstGroup?.key || '',
        value: firstGroup?.defaultValue ?? firstTier?.value ?? '',
        group: firstGroup,
        tier: firstTier,
        isFallback: true,
      };
    }

    if (raw) {
      for (const g of familyGroups) {
        for (const t of g.tiers || []) {
          if (
            t.value === raw ||
            (t.modelId && t.modelId === raw) ||
            (t.modelEnum && t.modelEnum === raw) ||
            (t.modelAlias && t.modelAlias === raw) ||
            (t.rawLabel && t.rawLabel === raw)
          ) {
            return { groups: list, groupKey: g.key, value: t.value, group: g, tier: t, isFallback: false };
          }
        }
      }

      const untiered = low.replace(/-tiered-/g, '-');
      for (const g of familyGroups) {
        for (const t of g.tiers || []) {
          const valLow = String(t.value || '').toLowerCase();
          const idLow = String(t.modelId || '').toLowerCase();
          const lblLow = String(t.rawLabel || '').toLowerCase();
          if (
            valLow === low ||
            idLow === low ||
            (idLow && idLow.replace(/-tiered-/g, '-') === untiered) ||
            (valLow && valLow.replace(/-tiered-/g, '-') === untiered) ||
            lblLow === low
          ) {
            return { groups: list, groupKey: g.key, value: t.value, group: g, tier: t, isFallback: false };
          }
        }
      }

      if (!/^MODEL_PLACEHOLDER_/i.test(raw)) {
        for (const g of familyGroups) {
          for (const t of g.tiers || []) {
            if (
              isSameModelFamily(raw, t.modelId || t.value || t.rawLabel) ||
              (t.rawLabel && isSameModelFamily(raw, t.rawLabel))
            ) {
              return { groups: list, groupKey: g.key, value: t.value, group: g, tier: t, isFallback: false };
            }
          }
        }
      }
    }

    if (raw) {
      const customLabel =
        (savedLabels && savedLabels[raw]) ||
        (/^MODEL_PLACEHOLDER_/i.test(raw) ? raw : formatModelDisplay(raw));
      const customGroup = {
        key: `custom:${raw}`,
        label: customLabel,
        kind: 'family',
        hasTiers: false,
        defaultValue: raw,
        tiers: [
          {
            value: raw,
            label: defaultTierLabel,
            rawLabel: customLabel,
            modelId: /^MODEL_/i.test(raw) ? '' : raw,
            modelEnum: /^MODEL_(?!ALIAS_)/i.test(raw) ? raw : '',
            modelAlias: '',
            isDefault: false,
          },
        ],
      };
      return {
        groups: [...list, customGroup],
        groupKey: customGroup.key,
        value: raw,
        group: customGroup,
        tier: customGroup.tiers[0],
        isFallback: true,
      };
    }

    const firstGroup = list[0] || null;
    const firstTier = firstGroup?.tiers?.[0] || null;
    return {
      groups: list,
      groupKey: firstGroup?.key || '',
      value: firstGroup?.defaultValue ?? firstTier?.value ?? '',
      group: firstGroup,
      tier: firstTier,
      isFallback: true,
    };
  }

  function buildComposerModelMenuData(catalogModels = [], activeMatch = null, options = {}) {
    const {
      defaultTierLabel = 'Default',
      standardTierLabel = 'Standard',
    } = options || {};

    const groups = buildModelFamilyGroups(catalogModels, {
      includeFollowGlobal: false,
      includeInherit: false,
      defaultTierLabel,
      standardTierLabel,
    });

    const isTierMatch = (tier) => {
      if (!activeMatch || !tier) return false;
      if (typeof activeMatch === 'function') return Boolean(activeMatch(tier));
      if (activeMatch.modelEnum && tier.modelEnum && tier.modelEnum === activeMatch.modelEnum) {
        return true;
      }
      if (activeMatch.id && tier.value === activeMatch.id) return true;
      if (activeMatch.modelId && tier.modelId && tier.modelId === activeMatch.modelId) return true;
      return Boolean(activeMatch.label && tier.rawLabel === activeMatch.label);
    };

    return groups.map((g) => {
      const tiers = (g.tiers || []).map((tier) => ({
        ...tier,
        active: isTierMatch(tier),
      }));
      const activeTier = tiers.find((x) => x.active) || null;
      const defaultTier =
        tiers.find((x) => x.value === g.defaultValue) ||
        tiers.find((x) => x.isDefault) ||
        tiers[0] ||
        null;
      const repTier = activeTier || defaultTier;
      const firstTagged = tiers.find((x) => x.tagTitle) || null;
      const firstQuota = tiers.find(
        (x) => x.quotaInfo && typeof x.quotaInfo.remainingFraction === 'number',
      );
      const tagTitle = repTier?.tagTitle || firstTagged?.tagTitle || '';
      const quotaInfo = repTier?.quotaInfo || firstQuota?.quotaInfo || null;
      const tipParts = [
        g.label,
        repTier?.tagDescription || repTier?.description || '',
      ].filter(Boolean);

      return {
        key: g.key,
        label: g.label,
        hasTiers: Boolean(g.hasTiers && tiers.length > 1),
        active: Boolean(activeTier),
        activeEffortLabel: g.hasTiers ? (activeTier || defaultTier)?.label || '' : '',
        defaultValue: g.defaultValue,
        singleModelKey: !g.hasTiers ? tiers[0]?.value || '' : '',
        tagTitle,
        hasDefaultBadge: !tagTitle && tiers.some((x) => x.isDefault),
        quotaInfo,
        title: tipParts.join(' — '),
        tiers,
      };
    });
  }

  function normalizeActivityText(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (s === '正在思考…' || s === 'Thinking...' || s === 'Thinking…') {
      return L().thinkingLive;
    }
    return s;
  }

  function localizeActiveTraceHeader(raw) {
    const norm = normalizeActivityText(raw);
    if (!norm) return '';
    if (curLocale !== 'en' && norm.startsWith('Running ')) {
      return `${L().traceVerb.runningCmd} ${norm.slice(8)}`;
    }
    return norm;
  }

  function formatToolLabel(cat, target) {
    const cleanTarget = normalizeActivityText(target);
    const verb = L().toolVerb[cat] || '';
    return verb ? `${verb} ${cleanTarget}` : cleanTarget;
  }

  function cleanGoalSnippet(th) {
    const raw = String(th.taskPrompt || '').trim();
    if (raw) {
      const cleaned = raw
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*>\s?/gm, '')
        .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/[*_`~]+/g, '')
        .replace(/\r?\n+/g, ' ')
        .replace(/^(?:任务目标|任務目標|Task\s+Objective|Objective|Goal)\s*[:：\-—]?\s*/i, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (cleaned) {
        return cleaned.length > 92 ? `${cleaned.slice(0, 91)}…` : cleaned;
      }
    }
    return th.branch || '';
  }

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    if (label) flashToast(label);
  }

  function popoutToMainCanvas(targetConvId) {
    if (!targetConvId) return;
    const coordConvId = lastSnap?.coordinator?.conversationId || '';
    manualPopoutConvId =
      targetConvId && targetConvId !== coordConvId ? targetConvId : '';
    if (window.sidecar?.ui?.toggleConversation) {
      window.sidecar.ui.toggleConversation(targetConvId);
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage(
        { type: 'toggle-conversation', payload: { conversationId: targetConvId } },
        '*',
      );
    }
    lastBoardKey = '';
    if (lastSnap) {
      renderBoard(lastSnap);
    } else {
      updateCoordinatorControls();
    }
  }

  function popoutThreadToMain(threadId) {
    if (!threadId) return;
    const th = cachedThreads.find((x) => x.threadId === threadId);
    if (!th) return;
    if (th.bucket === 'waiting') {
      optimisticallyMarkThreadIdle(threadId);
      postApi('/api/thread_mark_read', '/api/thread_mark_read_get', { threadId }).catch(() => {});
    }
    if (th.conversationId) {
      popoutToMainCanvas(th.conversationId);
    } else {
      openThreadDrawer(threadId);
    }
  }

  function jumpToCoordinator() {
    const coordConvId = lastSnap?.coordinator?.conversationId || '';
    if (!coordConvId) return;
    manualPopoutConvId = '';
    popoutToMainCanvas(coordConvId);
    flashToast(L().switchedCoordToast);
  }

  function createApiError(
    message,
    { code = '', status = 0, url = '', bodySnippet = '', isBackendMismatch = false } = {},
  ) {
    const err = new Error(message);
    err.code = code;
    err.status = status;
    err.url = url;
    err.bodySnippet = bodySnippet;
    err.isBackendMismatch = Boolean(isBackendMismatch);
    return err;
  }

  async function safeReadJson(res, { url = '' } = {}) {
    const t = L();
    const status = Number(res?.status) || 0;
    const ok = Boolean(res?.ok);
    const contentType = String(res?.headers?.get?.('content-type') || '').toLowerCase();
    let rawText = '';
    if (typeof res?.text === 'function') {
      rawText = await res.text();
    } else if (typeof res?.json === 'function') {
      rawText = JSON.stringify(await res.json());
    }
    const trimmed = String(rawText || '').trim();
    const looksNotFound = status === 404 || /^not found$/i.test(trimmed);
    const looksJsonContentType = /\bjson\b/i.test(contentType);
    const looksJsonBody = trimmed.startsWith('{') || trimmed.startsWith('[');

    if (!ok) {
      if (looksNotFound) {
        throw createApiError(t.sidecarMismatchErr, {
          code: 'sidecar_route_not_found',
          status: status || 404,
          url,
          bodySnippet: trimmed.slice(0, 120),
          isBackendMismatch: true,
        });
      }
      if (looksJsonBody) {
        try {
          const parsedErr = JSON.parse(trimmed);
          const serverMsg = String(parsedErr?.error || parsedErr?.message || '').trim();
          if (serverMsg) {
            throw createApiError(serverMsg, {
              code: 'http_error',
              status,
              url,
              bodySnippet: trimmed.slice(0, 120),
            });
          }
        } catch (inner) {
          if (inner?.code === 'http_error') throw inner;
        }
      }
      throw createApiError(t.apiHttpErr(status || 500), {
        code: 'http_error',
        status,
        url,
        bodySnippet: trimmed.slice(0, 120),
      });
    }

    if (!trimmed) return {};

    if (contentType && !looksJsonContentType && !looksJsonBody) {
      throw createApiError(looksNotFound ? t.sidecarMismatchErr : t.apiInvalidJsonErr, {
        code: 'invalid_content_type',
        status,
        url,
        bodySnippet: trimmed.slice(0, 120),
        isBackendMismatch: looksNotFound || /^text\/plain/i.test(contentType),
      });
    }

    try {
      return JSON.parse(trimmed);
    } catch {
      throw createApiError(looksNotFound ? t.sidecarMismatchErr : t.apiInvalidJsonErr, {
        code: 'invalid_json',
        status,
        url,
        bodySnippet: trimmed.slice(0, 120),
        isBackendMismatch: looksNotFound || (Boolean(contentType) && !looksJsonContentType),
      });
    }
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = API_READ_TIMEOUT_MS) {
    const ms = Math.max(200, Number(timeoutMs) || API_READ_TIMEOUT_MS);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    let timedOut = false;
    const fetchPromise = Promise.resolve().then(() =>
      doFetch(url, {
        ...options,
        ...(controller ? { signal: controller.signal } : {}),
      }),
    );
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        if (controller) {
          try {
            controller.abort();
          } catch {
            // Ignore abort errors
          }
        }
        reject(
          createApiError(L().apiTimeoutErr(Math.max(1, Math.round(ms / 1000))), {
            code: 'timeout',
            url,
          }),
        );
      }, ms);
    });
    try {
      return await Promise.race([fetchPromise, timeoutPromise]);
    } catch (err) {
      if (timedOut || err?.name === 'AbortError' || err?.code === 'timeout') {
        throw createApiError(L().apiTimeoutErr(Math.max(1, Math.round(ms / 1000))), {
          code: 'timeout',
          url,
        });
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function inspectServerInfo(data, { fromState = false } = {}) {
    if (!data || typeof data !== 'object') return;
    const info = data.serverInfo && typeof data.serverInfo === 'object' ? data.serverInfo : null;
    const prevKey = backendVersionMismatch
      ? `${backendVersionMismatch.kind}|${backendVersionMismatch.startedVersion}|${backendVersionMismatch.diskVersion}`
      : '';

    if (info) {
      const caps = Array.isArray(info.capabilities) ? info.capabilities : [];
      const rev = Number(info.apiRevision) || 0;
      const missingCaps = REQUIRED_UPDATE_CAPABILITIES.some((c) => !caps.includes(c));
      if (rev < EXPECTED_SERVER_API_REVISION || missingCaps) {
        backendVersionMismatch = {
          kind: 'stale_backend',
          startedVersion: String(info.startedVersion || ''),
          diskVersion: String(info.diskVersion || ''),
          reason: 'missing_capabilities',
        };
      } else if (info.versionDrifted) {
        backendVersionMismatch = {
          kind: 'version_drifted',
          startedVersion: String(info.startedVersion || ''),
          diskVersion: String(info.diskVersion || ''),
          reason: 'version_drifted',
        };
      } else {
        backendVersionMismatch = null;
      }
    } else if (fromState && !data.error && 'threads' in data) {
      backendVersionMismatch = {
        kind: 'stale_backend',
        startedVersion: '',
        diskVersion: '',
        reason: 'missing_server_info',
      };
    }

    const nextKey = backendVersionMismatch
      ? `${backendVersionMismatch.kind}|${backendVersionMismatch.startedVersion}|${backendVersionMismatch.diskVersion}`
      : '';
    if (nextKey !== prevKey && settingsScreenOpen) {
      renderUpdateCard();
    }
  }

  async function postApi(postPath, getFallbackPath, payload = {}, options = {}) {
    const {
      timeoutMs = API_WRITE_TIMEOUT_MS,
      allowGetFallback = true,
    } = options || {};
    let shouldFallbackToGet = false;
    try {
      const res = await fetchWithTimeout(
        postPath,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        timeoutMs,
      );
      if (res.ok) {
        const json = await safeReadJson(res, { url: postPath });
        if (json?.locale) applyLocale(json.locale);
        inspectServerInfo(json);
        return json;
      }
      if ((res.status === 404 || res.status === 405) && allowGetFallback && getFallbackPath) {
        shouldFallbackToGet = true;
      } else {
        const errJson = await safeReadJson(res, { url: postPath });
        if (errJson?.locale) applyLocale(errJson.locale);
        return errJson;
      }
    } catch (err) {
      if (err?.code === 'timeout' || !allowGetFallback || !getFallbackPath) {
        throw err;
      }
      if (err?.code === 'http_error' && err.status !== 404 && err.status !== 405) {
        throw err;
      }
      shouldFallbackToGet = true;
    }

    if (!shouldFallbackToGet) {
      throw createApiError(L().apiInvalidJsonErr, { code: 'invalid_json', url: postPath });
    }

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(payload || {})) {
      if (v !== undefined && v !== null) {
        qs.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
    }
    const fallbackUrl = `${getFallbackPath}?${qs}`;
    const res2 = await fetchWithTimeout(fallbackUrl, { method: 'GET' }, timeoutMs);
    const json2 = await safeReadJson(res2, { url: fallbackUrl });
    if (json2?.locale) applyLocale(json2.locale);
    inspectServerInfo(json2);
    return json2;
  }

  // ---------- Rich Markdown, File Pills & Code Block Renderer ----------
  function extractFileExtBadge(label, uri) {
    const cleanRef = String(label || uri || '')
      .replace(/#L\d+(?:-L?\d+)?$/i, '')
      .split(/[\\/]/)
      .pop();
    const m = cleanRef && cleanRef.match(/\.([a-z0-9]{1,4})$/i);
    return m ? m[1].toUpperCase() : '';
  }

  function renderFilePillHtml(shortLabel, fileUri) {
    const ext = extractFileExtBadge(shortLabel, fileUri);
    return `<button type="button" class="file-pill" data-file-uri="${esc(fileUri)}" title="${esc(fileUri)}"><span class="file-pill-ext">${esc(ext)}</span><span>${esc(shortLabel)}</span></button>`;
  }

  function renderInlineMd(text) {
    let s = esc(text);
    s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
    s = s.replace(/\[([^\]]+)\]\((file:\/\/\/[^\s)]+)\)/g, (_, label, uri) => {
      const ext = extractFileExtBadge(label, uri);
      return `<button type="button" class="file-pill" data-file-uri="${uri}" title="${uri}"><span class="file-pill-ext">${ext}</span><span>${label}</span></button>`;
    });
    return s;
  }

  let codeBlockSeq = 0;
  function renderMarkdown(md) {
    if (!md) return '';
    const t = L();
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    let html = '';
    let inCode = false;
    let codeLang = '';
    let codeBuf = [];
    let listType = '';
    let tableRows = [];

    const flushList = () => {
      if (listType) {
        html += `</${listType}>`;
        listType = '';
      }
    };
    const flushTable = () => {
      if (!tableRows.length) return;
      const parsed = tableRows.map((r) =>
        r
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim()),
      );
      if (parsed.length >= 2 && parsed[1].every((c) => /^[-:\s]+$/.test(c))) {
        const head = parsed[0].map((c) => `<th>${renderInlineMd(c)}</th>`).join('');
        const body = parsed
          .slice(2)
          .map((row) => `<tr>${row.map((c) => `<td>${renderInlineMd(c)}</td>`).join('')}</tr>`)
          .join('');
        html += `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
      } else {
        html += parsed.map((r) => `<p>${renderInlineMd(r.join(' | '))}</p>`).join('');
      }
      tableRows = [];
    };

    for (const line of lines) {
      const fenceMatch = line.trim().match(/^```([\w+-]*)/);
      if (fenceMatch) {
        flushList();
        flushTable();
        if (!inCode) {
          inCode = true;
          codeLang = fenceMatch[1] || 'code';
          codeBuf = [];
        } else {
          const rawCode = codeBuf.join('\n');
          const cid = `cb-${++codeBlockSeq}`;
          html += `<div class="code-block"><div class="code-hdr"><span>${esc(codeLang)}</span><button type="button" class="code-copy" data-target="${cid}">${esc(t.copyBtn)}</button></div><pre><code id="${cid}">${esc(rawCode)}</code></pre></div>`;
          inCode = false;
          codeLang = '';
        }
        continue;
      }
      if (inCode) {
        codeBuf.push(line);
        continue;
      }
      if (/^\|.+\|$/.test(line.trim())) {
        flushList();
        tableRows.push(line.trim());
        continue;
      } else {
        flushTable();
      }
      const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
      if (hMatch) {
        flushList();
        html += `<h${hMatch[1].length}>${renderInlineMd(hMatch[2])}</h${hMatch[1].length}>`;
        continue;
      }
      if (line.startsWith('> ')) {
        flushList();
        html += `<blockquote>${renderInlineMd(line.slice(2))}</blockquote>`;
        continue;
      }
      const ulMatch = line.match(/^\s*[-*]\s+(.+)$/);
      if (ulMatch) {
        if (listType !== 'ul') {
          flushList();
          listType = 'ul';
          html += '<ul>';
        }
        html += `<li>${renderInlineMd(ulMatch[1])}</li>`;
        continue;
      }
      const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
      if (olMatch) {
        if (listType !== 'ol') {
          flushList();
          listType = 'ol';
          html += '<ol>';
        }
        html += `<li>${renderInlineMd(olMatch[1])}</li>`;
        continue;
      }
      flushList();
      if (line.trim() === '---' || line.trim() === '***') {
        html += '<hr>';
      } else if (line.trim()) {
        html += `<p>${renderInlineMd(line)}</p>`;
      }
    }

    if (inCode) {
      const rawCode = codeBuf.join('\n');
      const cid = `cb-${++codeBlockSeq}`;
      html += `<div class="code-block"><div class="code-hdr"><span>${esc(codeLang || 'code')}</span><button type="button" class="code-copy" data-target="${cid}">${esc(t.copyBtn)}</button></div><pre><code id="${cid}">${esc(rawCode)}</code></pre></div>`;
    }
    flushList();
    flushTable();
    return html;
  }

  function bindStreamInteractiveElements(container) {
    container.querySelectorAll('.code-copy').forEach((btn) => {
      btn.addEventListener('click', () => {
        const codeEl = document.getElementById(btn.dataset.target);
        if (!codeEl) return;
        copyText(codeEl.textContent || '');
        const t = L();
        btn.textContent = `✓ ${t.copiedCode}`;
        setTimeout(() => {
          btn.textContent = L().copyBtn;
        }, 1400);
      });
    });

    container.querySelectorAll('.file-pill').forEach((pill) => {
      pill.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const uri = pill.dataset.fileUri || '';
        if (!uri) return;
        if (window.sidecar?.ui?.toggleAuxPane) {
          try {
            window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri });
            return;
          } catch {
            // Fallback to clipboard copy
          }
        }
        copyText(uri, L().copiedPath);
      });
    });

    container.querySelectorAll('[data-copy-msg]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const msgId = btn.dataset.copyMsg;
        const item = (lastRenderedItems || []).find((x) => x.id === msgId);
        if (!item?.text) return;
        copyText(item.text, L().copiedCode);
        btn.innerHTML = ICONS.check;
        setTimeout(() => {
          btn.innerHTML = ICONS.copy;
        }, 1200);
      });
    });
  }

  // ---------- Swarm-Style Overview Cards, .o2-th Cards & Dual Navigation ----------
  function optimisticallyMarkThreadIdle(threadId) {
    if (!lastSnap || !Array.isArray(lastSnap.threads)) return;
    const item = lastSnap.threads.find((x) => x.threadId === threadId);
    if (item && item.bucket === 'waiting') {
      item.bucket = 'idle';
      item.waitingReason = '';
      item.viewedAt = new Date().toISOString();
      renderBoard(lastSnap);
    }
  }

  function openThreadPrimary(threadId) {
    if (!threadId) return;
    openThreadDrawer(threadId);
  }

  function computeInlineSubtitle(th) {
    const t = L();
    if (th.bucket === 'working') {
      if (th.stepsProgress?.currentTitle) return th.stepsProgress.currentTitle;
      if (th.activeToolObj) {
        return formatToolLabel(th.activeToolObj.category, th.activeToolObj.target);
      }
      if (th.activeTool) return normalizeActivityText(th.activeTool);
      return t.subWorkingDefault;
    }
    if (th.bucket === 'waiting') {
      return th.waitingReason === 'confirm' ? t.subWaitingConfirm : t.subWaitingReview;
    }
    const synced = Boolean(th.pushedToCoordinatorAt || th.notifiedCoordinatorAt);
    const isCherryPicked = Boolean(th.git?.merged && th.git?.mergeMethod === 'cherry-pick');
    const isMerged =
      typeof th.git?.merged === 'boolean' ? th.git.merged : (Number(th.git?.aheadCount) || 0) === 0;
    const unmergedCommits = isMerged ? 0 : Number(th.git?.aheadCount) || 0;
    if (unmergedCommits > 0 && th.git?.dirtyCount > 0) {
      return `${t.subCommits(unmergedCommits)} · ${t.subDirty(th.git.dirtyCount)}`;
    }
    if (unmergedCommits > 0) {
      return th.branch
        ? `${t.subCommits(unmergedCommits)} · ${th.branch}`
        : t.subCommits(unmergedCommits);
    }
    if (isCherryPicked && th.git?.dirtyCount > 0) {
      return `${t.wtCherryPicked} · ${t.subDirty(th.git.dirtyCount)}`;
    }
    if (th.git?.dirtyCount > 0) {
      return th.branch
        ? `${t.subDirty(th.git.dirtyCount)} · ${th.branch}`
        : t.subDirty(th.git.dirtyCount);
    }
    if (isCherryPicked) {
      return th.branch ? `${t.wtCherryPicked} · ${th.branch}` : t.wtCherryPicked;
    }
    if (synced && th.branch) return `${th.branch} · ${t.subSyncedCoord}`;
    if (synced) return t.subSyncedCoord;
    if (th.branch) return th.branch;
    return t.subIdleReady;
  }

  function renderTasksProgressRingSvg(doneCount, waitCount, runCount, totalCount) {
    const C = 37.7; // 2 * pi * 6
    const safeTotal = Math.max(1, totalCount);
    const doneLen = (doneCount / safeTotal) * C;
    const waitLen = (waitCount / safeTotal) * C;
    const runLen = (runCount / safeTotal) * C;

    let segs = '';
    if (doneLen > 0.2) {
      segs += `<circle class="seg" cx="8" cy="8" r="6" stroke-width="2" stroke-dasharray="${doneLen.toFixed(2)} ${C}"/>`;
    }
    if (waitLen > 0.2) {
      segs += `<circle class="seg warn" cx="8" cy="8" r="6" stroke-width="2" stroke-dasharray="${waitLen.toFixed(2)} ${C}" stroke-dashoffset="${(-doneLen).toFixed(2)}"/>`;
    }
    if (runLen > 0.2) {
      segs += `<circle class="seg run" cx="8" cy="8" r="6" stroke-width="2" stroke-dasharray="${runLen.toFixed(2)} ${C}" stroke-dashoffset="${(-(doneLen + waitLen)).toFixed(2)}"/>`;
    }

    return `
      <svg class="tasks-ring" viewBox="0 0 16 16" aria-hidden="true">
        <circle class="trk" cx="8" cy="8" r="6" stroke-width="2"/>
        ${segs}
      </svg>
    `;
  }

  function renderSwarmRow(th) {
    const t = L();
    const isWorking = th.bucket === 'working';
    const isWaiting = th.bucket === 'waiting';
    const isArchived = Boolean(th.archived);
    const activeWorkerId = getActiveMainWorkerConvId();
    const isActiveMain = Boolean(
      activeWorkerId && th.conversationId && th.conversationId === activeWorkerId,
    );
    const sub = computeInlineSubtitle(th);
    const ago = relTime(th.updatedAt || th.createdAt);

    let leftIco = ICONS.doneCheck;
    if (isArchived) leftIco = ICONS.archCheck;
    else if (isWorking) leftIco = ICONS.rowSpinner;
    else if (isWaiting) leftIco = ICONS.waitAlert;

    let restRight = '';
    if (isWorking) {
      const sp = th.stepsProgress;
      if (sp && sp.total > 0) {
        restRight = `<span class="step-pill">${sp.done}/${sp.total}</span><span class="tid-pill">${esc(th.threadId)}</span>`;
      } else if (th.toolStepCount > 0) {
        restRight = `<span class="step-pill">${esc(t.stepsUnit(th.toolStepCount))}</span><span class="tid-pill">${esc(th.threadId)}</span>`;
      } else {
        restRight = `<span class="tid-pill">${esc(th.threadId)}</span>`;
      }
    } else {
      restRight = `<span class="tid-pill">${esc(th.threadId)}</span>${
        ago ? `<span class="time-lbl">${esc(ago)}</span>` : ''
      }`;
    }

    const acts = [];
    if (isWaiting && !isArchived) {
      acts.push(
        `<button type="button" class="row-act act-mark-read" data-action="mark-read" data-id="${esc(th.threadId)}" title="${esc(t.actMarkReadTip)}">${ICONS.check}</button>`,
      );
    }
    acts.push(
      `<button type="button" class="row-act" data-action="preview" data-id="${esc(th.threadId)}">${esc(t.actPreview)}</button>`,
    );
    if (th.conversationId) {
      acts.push(
        `<button type="button" class="row-act" data-action="popout" data-id="${esc(th.threadId)}" title="${esc(t.popoutTip)}">${ICONS.popout}</button>`,
      );
    }
    if (th.worktreePath) {
      acts.push(
        `<button type="button" class="row-act" data-action="copy-wt" data-wt="${esc(th.worktreePath)}">${esc(t.actFolder)}</button>`,
      );
    }
    if (!isArchived) {
      acts.push(
        `<button type="button" class="row-act" data-action="archive" data-id="${esc(th.threadId)}" data-wt="${th.worktreePath ? '1' : '0'}">${esc(t.actArchive)}</button>`,
      );
    } else if (th.worktreePath) {
      acts.push(
        `<button type="button" class="row-act act-clean-wt" data-action="clean-wt" data-id="${esc(th.threadId)}" title="${esc(t.actCleanWtTip)}">${esc(t.actCleanWt)}</button>`,
      );
    }

    const subCls = isWorking ? 'qrow-sub animate-shimmer-text' : 'qrow-sub';
    const rowCls = `qrow two-line${isActiveMain ? ' active-main' : ''}${isArchived && th.worktreePath ? ' arch-has-wt' : ''}`;

    return `
      <div class="${rowCls}" data-tid="${esc(th.threadId)}" title="${esc(th.displayTitle || th.title)}">
        <div class="qrow-left">
          ${leftIco}
          <div class="qrow-main">
            <span class="qrow-title">${esc(th.title)}</span>
            <span class="${subCls}">${esc(sub)}</span>
          </div>
        </div>
        <div class="qrow-right">
          <div class="qrow-rest">${restRight}</div>
          <div class="qrow-acts">${acts.join('')}</div>
        </div>
      </div>
    `;
  }

  function renderRunningCard(working) {
    if (!working.length) return '';
    const t = L();
    return `
      <div class="pt-card running-card">
        <div class="running-hdr">
          <span class="run-dot" aria-hidden="true"></span>
          <span class="running-title">${esc(t.cardRunning)}</span>
          <span class="running-count">${working.length}</span>
        </div>
        <div class="running-list">
          ${working.map(renderSwarmRow).join('')}
        </div>
      </div>
    `;
  }

  function renderTasksCard(waiting, idle, workingCount, totalCount) {
    const t = L();
    const nonRunningCount = waiting.length + idle.length;
    if (totalCount === 0) return '';

    const ringSvg = renderTasksProgressRingSvg(
      idle.length,
      waiting.length,
      workingCount,
      totalCount,
    );
    const waitChipHtml =
      waiting.length > 0
        ? `<span class="tasks-chip warn"><i></i><span>${esc(t.waitingChip(waiting.length))}</span></span>`
        : '';

    const canFold = nonRunningCount > 0;
    const isCollapsed = canFold && tasksCardCollapsed;

    let bodyHtml = '';
    if (nonRunningCount > 0) {
      if (sortMode === 'recent') {
        const merged = [...waiting, ...idle].sort((a, b) =>
          String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)),
        );
        bodyHtml = `
          <div class="tasks-body">
            <div class="tasks-subsec">
              <div class="tasks-subhead">${esc(t.subheadRecent(merged.length))}</div>
              ${merged.map(renderSwarmRow).join('')}
            </div>
          </div>
        `;
      } else {
        const subsecs = [];
        if (waiting.length > 0) {
          subsecs.push(`
            <div class="tasks-subsec">
              <div class="tasks-subhead warn">${esc(t.subheadWaiting(waiting.length))}</div>
              ${waiting.map(renderSwarmRow).join('')}
            </div>
          `);
        }
        if (idle.length > 0) {
          subsecs.push(`
            <div class="tasks-subsec">
              <div class="tasks-subhead">${esc(t.subheadCompleted(idle.length))}</div>
              ${idle.map(renderSwarmRow).join('')}
            </div>
          `);
        }
        bodyHtml = `<div class="tasks-body">${subsecs.join('')}</div>`;
      }
    }

    return `
      <div class="tasks-card${isCollapsed ? ' collapsed' : ''}" id="tasks-progress-card">
        <button type="button" class="tasks-hdr" data-action="toggle-tasks"${canFold ? '' : ' disabled'}>
          ${ringSvg}
          <span class="tasks-hdr-title">${t.tasksHdrHtml(idle.length, totalCount)}</span>
          <span class="tasks-hdr-right">
            ${waitChipHtml}
            ${canFold ? `<span class="tasks-chev">${ICONS.chevronUp}</span>` : ''}
          </span>
        </button>
        ${bodyHtml}
      </div>
    `;
  }

  function isThreadCardOpen(th) {
    if (threadOpenState.has(th.threadId)) {
      return Boolean(threadOpenState.get(th.threadId));
    }
    return th.bucket === 'working' || th.bucket === 'waiting';
  }

  function renderSegmentedMbar(th, isWorking) {
    const steps = Array.isArray(th.stepsList) ? th.stepsList : null;
    if (steps && steps.length > 0) {
      const bars = steps
        .map((s) => {
          const st = String(s.status || '');
          const cls =
            st === 'done' || st === 'skipped'
              ? 'done'
              : st === 'in_progress'
                ? 'running'
                : st === 'failed'
                  ? 'blocked'
                  : 'queued';
          return `<i class="${cls}"></i>`;
        })
        .join('');
      return `<span class="o2-mbar" aria-hidden="true">${bars}</span>`;
    }
    const sp = th.stepsProgress;
    if (sp && sp.total > 0) {
      const segs = [];
      const total = Math.min(sp.total, 12);
      const done = Math.min(sp.done, total);
      for (let i = 0; i < total; i++) {
        if (i < done) segs.push('<i class="done"></i>');
        else if (i === done && isWorking) segs.push('<i class="running"></i>');
        else segs.push('<i class="queued"></i>');
      }
      return `<span class="o2-mbar" aria-hidden="true">${segs.join('')}</span>`;
    }
    return '';
  }

  function formatTokenCount(raw, { millionThreshold = 700_000 } = {}) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return '0';
    if (n < 1000) return String(Math.round(n));
    if (n < millionThreshold) {
      if (n < 100_000) {
        const k = n / 1000;
        const formatted = k.toFixed(1).replace(/\.0$/, '');
        return `${formatted}K`;
      }
      return `${Math.round(n / 1000)}K`;
    }
    const m = n / 1_000_000;
    const formatted =
      m >= 100
        ? String(Math.round(m))
        : m >= 10
          ? m.toFixed(1).replace(/\.0$/, '')
          : m.toFixed(2).replace(/0$/, '').replace(/\.0$/, '');
    return `${formatted}M`;
  }

  function renderThreadUsageRow(th) {
    const u = th?.usage;
    if (!u || typeof u !== 'object') return '';
    const totalTokens = Number(u.totalTokens) || 0;
    const contextTokens = Number(u.contextTokens) || 0;
    if (totalTokens <= 0 && contextTokens <= 0) return '';

    const t = L();
    const inputTokens = Number(u.inputTokens) || 0;
    const outputTokens = Number(u.outputTokens) || 0;
    const cacheReadTokens = Number(u.cacheReadTokens) || 0;
    const compactLimit = Number(u.compactLimit) || 0;
    const compactCount = Math.max(0, Math.floor(Number(u.compactCount) || 0));

    let compactPercent = null;
    if (compactLimit > 0) {
      const rawPct =
        u.compactPercent !== null && u.compactPercent !== undefined && Number.isFinite(Number(u.compactPercent))
          ? Number(u.compactPercent)
          : Math.round((contextTokens / compactLimit) * 100);
      compactPercent = Math.min(100, Math.max(0, Math.round(rawPct)));
    }

    const totalText = formatTokenCount(totalTokens);
    const detailTip = t.usageDetailTip(
      formatTokenCount(inputTokens, { millionThreshold: 1_000_000 }),
      formatTokenCount(outputTokens, { millionThreshold: 1_000_000 }),
      formatTokenCount(cacheReadTokens, { millionThreshold: 1_000_000 }),
    );

    const parts = [];
    if (totalTokens > 0) {
      parts.push(
        `<span class="o2-usage-item o2-usage-tokens" title="${esc(detailTip)}"><span class="o2-usage-lbl">${esc(t.usageTokensLabel)}</span><b class="o2-usage-val tabular">${esc(totalText)}</b></span>`,
      );
    }

    if (contextTokens > 0) {
      const ctxText = formatTokenCount(contextTokens, { millionThreshold: 1_000_000 });
      if (compactLimit > 0 && compactPercent !== null) {
        const limitText = formatTokenCount(compactLimit, { millionThreshold: 1_000_000 });
        const toneCls = compactPercent >= 90 ? 'danger' : compactPercent >= 70 ? 'warn' : 'ok';
        const emptyAttr = compactPercent === 0 ? ' data-empty="true"' : '';
        parts.push(
          `<span class="o2-usage-item o2-usage-compact"><span class="o2-usage-lbl">${esc(t.usageCompactLine)}</span><span class="o2-usage-bar" aria-hidden="true"><i class="${toneCls}" style="width:${compactPercent}%"${emptyAttr}></i></span><span class="o2-usage-val tabular">${esc(ctxText)} / ${esc(limitText)} (${compactPercent}%)</span></span>`,
        );
      } else {
        parts.push(
          `<span class="o2-usage-item o2-usage-compact"><span class="o2-usage-lbl">${esc(t.usageCompactLine)}</span><span class="o2-usage-val tabular">${esc(ctxText)}</span></span>`,
        );
      }
    }

    parts.push(
      `<span class="o2-usage-pill${compactCount > 0 ? ' has-compacts' : ''} tabular">${esc(t.usageCompacts(compactCount))}</span>`,
    );

    return `<div class="o2-th-usage">${parts.join('')}</div>`;
  }

  function getLocalizedDecisionDisplay(dec) {
    const t = L();
    if (!dec || dec.source !== 'auto') {
      return {
        title: String(dec?.title || ''),
        summary: String(dec?.summary || ''),
        options: Array.isArray(dec?.options) ? dec.options : [],
      };
    }
    const baseOpts = Array.isArray(dec.options) ? dec.options : [];
    const thTitle = dec.threadTitle || dec.threadId || '';
    if (dec.autoKind === 'worktree_merge_ready') {
      return {
        title: t.decisionAutoMergeTitle,
        summary: t.decisionAutoMergeSummary(thTitle, dec.branch || '', Number(dec.aheadCount) || 0),
        options: baseOpts.map((o) =>
          o.action === 'dismiss'
            ? { ...o, label: t.decisionDismissBtn }
            : { ...o, label: t.decisionAutoMergeBtn },
        ),
      };
    }
    if (dec.autoKind === 'worktree_archive_ready') {
      const isCherry = dec.mergeMethod === 'cherry-pick';
      return {
        title: t.decisionAutoArchiveTitle(isCherry),
        summary: t.decisionAutoArchiveSummary(thTitle, dec.branch || ''),
        options: baseOpts.map((o) =>
          o.action === 'dismiss'
            ? { ...o, label: t.decisionDismissBtn }
            : { ...o, label: t.decisionAutoArchiveBtn },
        ),
      };
    }
    return {
      title: String(dec.title || ''),
      summary: String(dec.summary || ''),
      options: baseOpts,
    };
  }

  function renderDecisionsPanelHtml(decisions, { collapsed = false, busyIds = null } = {}) {
    if (!Array.isArray(decisions) || decisions.length === 0) return '';
    const t = L();
    const busySet =
      busyIds && typeof busyIds.has === 'function' ? busyIds : pendingDecisionIds;

    const cardsHtml = decisions
      .map((dec) => {
        const isAuto = dec.source === 'auto';
        const isBusy = busySet.has(dec.id);
        const view = getLocalizedDecisionDisplay(dec);
        const hasMetaRow = Boolean(dec.threadId || isAuto);
        const dismissBtnHtml = `
          <button type="button" class="dec-dismiss-btn" data-dec-dismiss="${esc(dec.id)}" title="${esc(t.decisionDismissTip)}" aria-label="${esc(t.decisionDismissTip)}"${isBusy ? ' disabled' : ''}>
            ${ICONS.close}
          </button>
        `;
        const topHtml = hasMetaRow
          ? `
            <div class="decision-top">
              ${
                dec.threadId
                  ? `<button type="button" class="dec-thread-badge" data-dec-thread="${esc(dec.threadId)}" title="${esc(t.decisionThreadTip(dec.threadId))}">${esc(dec.threadId)}</button>`
                  : ''
              }
              ${isAuto ? `<span class="dec-auto-tag">${esc(t.decisionAutoTag)}</span>` : ''}
              ${dismissBtnHtml}
            </div>
            <div class="decision-title">${esc(view.title)}</div>
          `
          : `
            <div class="decision-top">
              <div class="decision-title">${esc(view.title)}</div>
              ${dismissBtnHtml}
            </div>
          `;
        const summaryHtml = view.summary
          ? `<div class="decision-summary" title="${esc(view.summary)}">${esc(view.summary)}</div>`
          : '';
        const opts = (view.options || []).slice(0, 3);
        const actionsHtml = opts.length
          ? `<div class="decision-actions">${opts
              .map((opt) => {
                const styleCls =
                  opt.style === 'primary'
                    ? 'dec-btn-primary'
                    : opt.style === 'danger'
                      ? 'dec-btn-danger'
                      : 'dec-btn-secondary';
                return `<button type="button" class="dec-btn ${styleCls}" data-dec-id="${esc(dec.id)}" data-opt-id="${esc(opt.id)}" data-opt-action="${esc(opt.action || 'send_coordinator')}"${isBusy ? ' disabled' : ''}>${esc(isBusy ? t.decisionWorking : opt.label)}</button>`;
              })
              .join('')}</div>`
          : '';
        return `
          <div class="decision-card${isAuto ? ' is-auto' : ''}${isBusy ? ' is-busy' : ''}" data-decision-id="${esc(dec.id)}">
            ${topHtml}
            ${summaryHtml}
            ${actionsHtml}
          </div>
        `;
      })
      .join('');

    return `
      <button type="button" class="decisions-hdr" data-action="toggle-decisions" aria-expanded="${collapsed ? 'false' : 'true'}" title="${esc(t.decisionToggleTip)}">
        <span class="dec-dot" aria-hidden="true"></span>
        <span class="decisions-title">${esc(t.decisionsTitle)}</span>
        <span class="decisions-count tabular">${decisions.length}</span>
        <span class="decisions-chev" aria-hidden="true">${ICONS.chevronDown}</span>
      </button>
      <div class="decisions-list">
        ${cardsHtml}
      </div>
    `;
  }

  function focusOrPreviewDecisionThread(threadId) {
    if (!threadId) return;
    let targetCard = null;
    document.querySelectorAll('.o2-th[data-th-card]').forEach((node) => {
      if (!targetCard && node.dataset.thCard === threadId) targetCard = node;
    });
    if (targetCard) {
      threadOpenState.set(threadId, true);
      targetCard.classList.add('open');
      const foldBtn = targetCard.querySelector('.o2-fold-btn');
      if (foldBtn) foldBtn.setAttribute('aria-expanded', 'true');
      targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetCard.classList.remove('dec-highlight');
      void targetCard.offsetWidth;
      targetCard.classList.add('dec-highlight');
      setTimeout(() => {
        targetCard.classList.remove('dec-highlight');
      }, 1900);
      return;
    }
    openThreadDrawer(threadId);
  }

  async function handleDecisionActionTrigger(dec, opt, triggerBtn) {
    if (!dec || !dec.id || pendingDecisionIds.has(dec.id)) return;
    const t = L();
    pendingDecisionIds.add(dec.id);

    const cardEl = triggerBtn?.closest?.('.decision-card');
    if (cardEl) {
      cardEl.classList.add('is-busy');
      cardEl.querySelectorAll('button').forEach((b) => {
        b.disabled = true;
      });
    }
    if (triggerBtn && triggerBtn.classList.contains('dec-btn')) {
      triggerBtn.textContent = t.decisionWorking;
    }

    const action = opt?.action || 'dismiss';
    const payload = buildScopePayload({
      decisionId: dec.id,
      optionId: opt?.id || '',
      action,
      threadId: dec.threadId || '',
      autoKind: dec.autoKind || '',
      lastCommit: dec.lastCommit || '',
      message: opt?.message || '',
      label: opt?.label || '',
      title: dec.title || '',
      coordinatorId: dec.coordinatorId || lastSnap?.coordinator?.conversationId || '',
    });

    try {
      const res = await postApi('/api/decision_action', '/api/decision_action_get', payload);
      pendingDecisionIds.delete(dec.id);
      if (!res || res.ok === false) {
        flashToast(res?.error || t.decisionActionErrToast, 'err', 3600);
        renderDecisionsPanel(cachedDecisions);
        return;
      }

      if (res.action === 'archive_thread') {
        showArchiveResultToast(res.archiveResult || { ok: true, archived: true });
      } else if (res.action === 'send_coordinator') {
        flashToast(t.decisionSentCoordToast, 'ok', 2800);
      } else {
        flashToast(t.decisionDismissedToast, 'ok', 2200);
      }

      cachedDecisions = cachedDecisions.filter((x) => x.id !== dec.id);
      renderDecisionsPanel(cachedDecisions);
      lastBoardKey = '';
      refreshBoard(true);
    } catch (err) {
      pendingDecisionIds.delete(dec.id);
      flashToast(err?.message || t.decisionActionErrToast, 'err', 3600);
      renderDecisionsPanel(cachedDecisions);
    }
  }

  function renderDecisionsPanel(decisions) {
    if (!elDecisionsPanel) return;
    const list = Array.isArray(decisions) ? decisions : [];
    cachedDecisions = list;
    if (!list.length) {
      elDecisionsPanel.hidden = true;
      elDecisionsPanel.classList.remove('collapsed');
      elDecisionsPanel.innerHTML = '';
      return;
    }
    elDecisionsPanel.hidden = false;
    elDecisionsPanel.classList.toggle('collapsed', decisionsPanelCollapsed);
    elDecisionsPanel.innerHTML = renderDecisionsPanelHtml(list, {
      collapsed: decisionsPanelCollapsed,
      busyIds: pendingDecisionIds,
    });

    const toggleBtn = elDecisionsPanel.querySelector('button[data-action="toggle-decisions"]');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        decisionsPanelCollapsed = !decisionsPanelCollapsed;
        elDecisionsPanel.classList.toggle('collapsed', decisionsPanelCollapsed);
        toggleBtn.setAttribute('aria-expanded', decisionsPanelCollapsed ? 'false' : 'true');
      });
    }

    elDecisionsPanel.querySelectorAll('button[data-dec-thread]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        focusOrPreviewDecisionThread(btn.dataset.decThread);
      });
    });

    elDecisionsPanel.querySelectorAll('button[data-dec-dismiss]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const did = btn.dataset.decDismiss;
        const dec = cachedDecisions.find((x) => x.id === did);
        if (dec) {
          handleDecisionActionTrigger(dec, { id: 'dismiss', action: 'dismiss', label: L().decisionDismissBtn }, btn);
        }
      });
    });

    elDecisionsPanel.querySelectorAll('button[data-dec-id][data-opt-id]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const did = btn.dataset.decId;
        const oid = btn.dataset.optId;
        const dec = cachedDecisions.find((x) => x.id === did);
        if (!dec) return;
        const view = getLocalizedDecisionDisplay(dec);
        const opt = (view.options || []).find((o) => o.id === oid) || {
          id: oid,
          action: btn.dataset.optAction || 'send_coordinator',
          label: btn.textContent || '',
        };
        handleDecisionActionTrigger(dec, opt, btn);
      });
    });
  }

  function renderO2ThreadCard(th, decisionThreadIds = null) {
    const t = L();
    const isWorking = th.bucket === 'working';
    const isWaiting = th.bucket === 'waiting';
    const stateCls = isWorking ? 'running' : isWaiting ? 'waiting' : 'done';
    const isOpen = isThreadCardOpen(th);
    const activeWorkerId = getActiveMainWorkerConvId();
    const isActiveMain = Boolean(
      activeWorkerId && th.conversationId && th.conversationId === activeWorkerId,
    );
    const hasPendingDecision = Boolean(
      decisionThreadIds &&
        typeof decisionThreadIds.has === 'function' &&
        decisionThreadIds.has(th.threadId),
    );

    const statusWord = isWorking
      ? t.stRunning
      : isWaiting
        ? th.waitingReason === 'confirm'
          ? t.stConfirm
          : t.stReview
        : t.stReady;

    const sp = th.stepsProgress;
    const ago = relTime(th.updatedAt || th.createdAt);
    const mbarHtml = renderSegmentedMbar(th, isWorking);
    let rightMetaHtml = '';
    if (sp && sp.total > 0) {
      rightMetaHtml = `${mbarHtml}<span>${sp.done}/${sp.total}</span>`;
    } else {
      rightMetaHtml = `<span>${esc(th.threadId)}</span>${ago ? `<span>· ${esc(ago)}</span>` : ''}`;
    }

    const goalLine = cleanGoalSnippet(th);
    const sub = computeInlineSubtitle(th);
    let nowHtml = '';
    if (isWorking) {
      nowHtml = `<div class="o2-thn"><span>${esc(t.nowLabel)}</span><span class="animate-shimmer-text">${esc(sub)}</span></div>`;
    } else if (isWaiting) {
      nowHtml = `<div class="o2-thn"><span>${esc(t.waitLabel)}</span><span>${esc(sub)}</span></div>`;
    } else if (
      th.branch ||
      th.pushedToCoordinatorAt ||
      th.notifiedCoordinatorAt ||
      th.git?.aheadCount > 0
    ) {
      nowHtml = `<div class="o2-thn"><span>${esc(t.statusLabel)}</span><span>${esc(sub)}</span></div>`;
    }

    const steps = Array.isArray(th.stepsList) ? th.stepsList : [];
    const tasksHtml = steps.length
      ? `<ul class="o2-tasks">${steps
          .map((st) => {
            const isDone = st.status === 'done' || st.status === 'skipped';
            const tiCls = isDone
              ? 'done'
              : st.status === 'in_progress'
                ? 'running'
                : st.status === 'failed'
                  ? 'blocked'
                  : 'queued';
            const checkSvg = isDone
              ? '<svg viewBox="0 0 16 16"><polyline points="3.5 8.5 6.5 11.5 12.5 4.5"/></svg>'
              : '';
            return `<li class="${isDone ? 'done' : ''}"><span class="o2-ti ${tiCls}">${checkSvg}</span><span class="o2-tt">${esc(st.title)}</span></li>`;
          })
          .join('')}</ul>`
      : '';

    const actions = [
      `<button type="button" class="row-act act-primary" data-action="preview" data-id="${esc(th.threadId)}">${esc(t.actPreview)}</button>`,
    ];
    if (th.conversationId) {
      actions.push(
        `<button type="button" class="row-act" data-action="popout" data-id="${esc(th.threadId)}" title="${esc(t.popoutTip)}">${esc(t.actPopoutMain)}</button>`,
      );
    }
    if (isWaiting) {
      actions.push(
        `<button type="button" class="row-act act-mark-read" data-action="mark-read" data-id="${esc(th.threadId)}" title="${esc(t.actMarkReadTip)}">${ICONS.check}</button>`,
      );
    }
    actions.push(
      `<button type="button" class="row-act" data-action="sync-th" data-id="${esc(th.threadId)}" title="${esc(t.syncTip)}">${esc(t.syncCoord)}</button>`,
    );
    if (th.worktreePath) {
      actions.push(
        `<button type="button" class="row-act" data-action="copy-wt" data-wt="${esc(th.worktreePath)}">${esc(t.actFolder)}</button>`,
      );
    }
    actions.push(
      `<button type="button" class="row-act" data-action="archive" data-id="${esc(th.threadId)}" data-wt="${th.worktreePath ? '1' : '0'}">${esc(t.actArchive)}</button>`,
    );

    const modelLabel = formatModelDisplay(th.modelDisplayName || th.resolvedModel || th.model);
    const modelChip = `<span class="o2-wchips"><span class="o2-wchip" title="${esc(modelLabel)}">${esc(modelLabel)}</span></span>`;
    const usageHtml = renderThreadUsageRow(th);
    const decisionBadgeHtml = hasPendingDecision
      ? `<span class="o2-dec-badge">${esc(t.decisionBadge)}</span>`
      : '';
    const cardCls = `o2-th ${stateCls}${isOpen ? ' open' : ''}${isActiveMain ? ' active-main' : ''}${hasPendingDecision ? ' has-decision' : ''}`;

    return `
      <div class="${cardCls}" data-th-card="${esc(th.threadId)}">
        <div class="o2-thh">
          <span class="o2-thd ${stateCls}" aria-hidden="true"></span>
          <button type="button" class="o2-tht" data-action="open-primary" data-id="${esc(th.threadId)}" title="${esc(th.displayTitle || th.title)}">
            <b>${esc(th.title)}</b>
            <em>${esc(statusWord)}</em>
            ${decisionBadgeHtml}
          </button>
          <span class="o2-thc">${rightMetaHtml}</span>
          <button type="button" class="o2-fold-btn" data-action="fold-th" data-id="${esc(th.threadId)}" aria-expanded="${isOpen ? 'true' : 'false'}" title="${esc(t.foldTip)}">
            <span class="o2-chev">${ICONS.chevronRight}</span>
          </button>
        </div>
        ${goalLine ? `<div class="o2-thg" data-action="open-primary" data-id="${esc(th.threadId)}">${esc(goalLine)}</div>` : ''}
        ${nowHtml}
        ${tasksHtml}
        ${usageHtml}
        <div class="o2-th-actions">
          ${actions.join('')}
          <span class="spacer"></span>
          ${modelChip}
        </div>
      </div>
    `;
  }

  function renderO2ThreadsSection(waiting, working, idle, active, decisionThreadIds = null) {
    if (!active.length) return '';
    const t = L();
    const ordered =
      sortMode === 'recent'
        ? [...active].sort((a, b) =>
            String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)),
          )
        : [...waiting, ...working, ...idle];

    return `
      <section class="o2-threads">
        <h3 class="o2-h">
          <span>${esc(t.secThreads)}</span>
          <em>${active.length}</em>
        </h3>
        ${ordered.map((th) => renderO2ThreadCard(th, decisionThreadIds)).join('')}
      </section>
    `;
  }

  function bindOverviewEvents(container) {
    const toggleHdr = container.querySelector('button[data-action="toggle-tasks"]');
    if (toggleHdr) {
      toggleHdr.addEventListener('click', () => {
        tasksCardCollapsed = !tasksCardCollapsed;
        const card = container.querySelector('#tasks-progress-card');
        card?.classList.toggle('collapsed', tasksCardCollapsed);
      });
    }

    container.querySelectorAll('.qrow').forEach((row) => {
      row.addEventListener('click', () => openThreadDrawer(row.dataset.tid));
    });

    container.querySelectorAll('.o2-th').forEach((card) => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.o2-fold-btn') || e.target.closest('.o2-th-actions')) return;
        openThreadDrawer(card.dataset.thCard);
      });
    });

    container.querySelectorAll('[data-action="open-primary"]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openThreadDrawer(el.dataset.id);
      });
    });

    container.querySelectorAll('button[data-action="preview"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openThreadDrawer(btn.dataset.id);
      });
    });

    container.querySelectorAll('button[data-action="popout"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        popoutThreadToMain(btn.dataset.id);
      });
    });

    container.querySelectorAll('button[data-action="fold-th"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tid = btn.dataset.id;
        const card = btn.closest('.o2-th');
        if (!card || !tid) return;
        const nextOpen = !card.classList.contains('open');
        threadOpenState.set(tid, nextOpen);
        card.classList.toggle('open', nextOpen);
        btn.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
      });
    });

    container.querySelectorAll('button[data-action="sync-th"]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tid = btn.dataset.id;
        if (!tid) return;
        btn.disabled = true;
        btn.textContent = L().syncing;
        try {
          const res = await postApi('/api/thread_sync_coord', '/api/thread_sync_coord_get', {
            threadId: tid,
          });
          btn.textContent = res.ok && res.synced ? L().syncedOk : L().syncNone;
        } catch {
          btn.textContent = L().syncErr;
        }
        setTimeout(() => {
          btn.textContent = L().syncCoord;
          btn.disabled = false;
        }, 1600);
      });
    });

    container.querySelectorAll('button[data-action="mark-read"]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tid = btn.dataset.id;
        btn.disabled = true;
        optimisticallyMarkThreadIdle(tid);
        flashToast(L().markedReadToast);
        await postApi('/api/thread_mark_read', '/api/thread_mark_read_get', { threadId: tid });
        lastBoardKey = '';
        refreshBoard(true);
      });
    });

    container.querySelectorAll('button[data-action="copy-wt"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyText(btn.dataset.wt, L().copiedPath);
      });
    });

    container.querySelectorAll('button[data-action="archive"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tid = btn.dataset.id;
        const th =
          cachedThreads.find((x) => x.threadId === tid) || {
            threadId: tid,
            title: tid,
            worktreePath: btn.dataset.wt === '1' ? 'worktree' : '',
          };
        requestArchiveThread(th, { triggerBtn: btn });
      });
    });

    container.querySelectorAll('button[data-action="clean-wt"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const tid = btn.dataset.id;
        const th = cachedThreads.find((x) => x.threadId === tid);
        if (th && th.worktreePath) {
          requestCleanWorktree(th, { triggerBtn: btn });
        }
      });
    });
  }

  function renderWorktreeCard(th) {
    const t = L();
    const branchText = th.git?.branch || th.branch || 'worktree';
    const pills = [
      `<span class="branch-pill">${ICONS.branch} <span>${esc(branchText)}</span></span>`,
    ];
    const isCherryPicked = Boolean(th.git?.merged && th.git?.mergeMethod === 'cherry-pick');
    const isMerged =
      typeof th.git?.merged === 'boolean' ? th.git.merged : (Number(th.git?.aheadCount) || 0) === 0;
    if (th.git?.aheadCount > 0) {
      if (isCherryPicked) {
        pills.push(`<span class="wt-pill">${esc(t.wtCherryPicked)}</span>`);
      } else if (!isMerged) {
        pills.push(`<span class="commit-pill">${esc(t.subCommits(th.git.aheadCount))}</span>`);
      }
    }
    if (th.git?.dirtyCount > 0) {
      pills.push(`<span class="dirty-pill">${esc(t.subDirty(th.git.dirtyCount))}</span>`);
    } else if (th.git && isMerged && !isCherryPicked) {
      pills.push(`<span class="wt-pill">${esc(t.wtClean)}</span>`);
    }
    if (th.git?.lastCommit) {
      pills.push(
        `<span class="wt-pill" title="${esc(th.git.lastCommit)}">${esc(th.git.lastCommit.slice(0, 34))}</span>`,
      );
    }

    return `
      <div class="wt-card">
        <div class="wt-card-main">
          <div class="wt-card-title" title="${esc(th.title)}">${esc(th.title)}</div>
          <div class="wt-card-meta">${pills.join('')}</div>
        </div>
        <div class="chat-hdr-right">
          <button type="button" class="row-act" data-action="copy-wt" data-wt="${esc(th.worktreePath)}" title="${esc(th.worktreePath)}">
            ${ICONS.folder}
            <span>${esc(t.actCopyPath)}</span>
          </button>
          ${
            th.conversationId
              ? `<button type="button" class="row-act" data-action="popout" data-id="${esc(th.threadId)}" title="${esc(t.popoutTip)}">
                  <span>${esc(t.actPopoutMain)}</span>
                </button>`
              : ''
          }
          <button type="button" class="row-act act-primary" data-action="open-wt" data-id="${esc(th.threadId)}">
            <span>${esc(t.actOpenThread)}</span>
          </button>
        </div>
      </div>
    `;
  }

  function stripCoordinatorPrefix(raw) {
    return String(raw || '').replace(/^(?:\[Coordinator\]\s*)+/i, '').trim();
  }

  function resolveBoardHeaderDisplay(snap) {
    const t = L();
    const c = snap?.coordinator || null;
    const hasCoord = Boolean(c && c.conversationId);
    const projectName = String(snap?.projectName || c?.projectName || '').trim();
    const fullPath = String(
      snap?.workspacePath || c?.repoRoot || c?.workspacePath || workspace || '',
    ).trim();
    const workspaceName =
      String(snap?.workspaceName || '').trim() ||
      (fullPath ? fullPath.split(/[\\/]/).filter(Boolean).pop() : '');
    const coordLabel = stripCoordinatorPrefix(c?.title || '');
    const scopeTitle =
      projectName ||
      String(snap?.scopeTitle || '').trim() ||
      workspaceName ||
      String(snap?.projectLabel || '').trim();

    const panelTitle = projectName || workspaceName || scopeTitle || t.panelTitle;
    const panelTooltip =
      projectName && fullPath
        ? `${projectName} — ${fullPath}`
        : fullPath || projectName || panelTitle;

    const goalTitle = hasCoord
      ? workspaceName || coordLabel || scopeTitle || t.defaultProjTitle
      : scopeTitle || t.defaultProjTitle;
    const goalTooltip = fullPath || goalTitle;

    return {
      projectName,
      workspaceName,
      fullPath,
      scopeTitle,
      panelTitle,
      panelTooltip,
      goalTitle,
      goalTooltip,
    };
  }

  function renderBoard(snap) {
    lastSnap = snap;
    const t = L();
    const c = snap.coordinator;
    const bindBtn = document.getElementById('btn-bind');
    const hasCoord = Boolean(c && c.conversationId);
    bindBtn.hidden = hasCoord;
    updateCoordinatorControls();

    const headerMeta = resolveBoardHeaderDisplay(snap);

    // Sync worktree checkbox availability based on snap.hasGitRepo
    const wtChk = document.getElementById('f-wt');
    const branchIn = document.getElementById('f-branch');
    const hasGit = snap.hasGitRepo !== false;
    if (!hasGit) {
      wtChk.checked = false;
      wtChk.disabled = true;
      branchIn.value = '';
      branchIn.disabled = true;
    } else {
      wtChk.disabled = false;
      branchIn.disabled = false;
      if (lastHasGitRepo !== true) {
        wtChk.checked = true;
      }
    }
    lastHasGitRepo = hasGit;
    document.getElementById('lbl-f-wt').textContent = hasGit ? t.fWt : t.fWtDisabled;
    populateDispatchModelSelect();

    const allThreads = snap.threads || [];
    cachedThreads = allThreads;

    const active = allThreads.filter((x) => !x.archived);
    const archived = allThreads.filter((x) => x.archived);
    const waiting = active.filter((x) => x.bucket === 'waiting');
    const working = active.filter((x) => x.bucket === 'working');
    const idle = active.filter((x) => x.bucket === 'idle');
    const wtThreads = active.filter((x) => x.worktreePath);

    // Header title & Underline tab counts/badges
    const panelTitleEl = document.getElementById('panel-title');
    panelTitleEl.textContent = headerMeta.panelTitle;
    panelTitleEl.title = headerMeta.panelTooltip;
    document.getElementById('badge-waiting').textContent =
      waiting.length > 0 ? String(waiting.length) : '';
    document.getElementById('cnt-threads').textContent =
      active.length > 0 ? String(active.length) : '';
    document.getElementById('cnt-library').textContent =
      wtThreads.length > 0 ? String(wtThreads.length) : '';
    document.getElementById('cnt-archived').textContent =
      archived.length > 0 ? String(archived.length) : '';

    // Card A: Project / Coordinator Goal Summary Card
    document.getElementById('goal-kicker-text').textContent = hasCoord
      ? t.kickerCoord
      : t.kickerProject;
    const goalTitleEl = document.getElementById('goal-title');
    goalTitleEl.textContent = headerMeta.goalTitle;
    goalTitleEl.title = headerMeta.goalTooltip;
    document.getElementById('goal-sub').textContent = t.triageSummary(
      waiting.length,
      working.length,
      idle.length,
    );

    const sortBtn = document.getElementById('btn-sort');
    sortBtn.hidden = active.length < 2;
    document.getElementById('lbl-sort').textContent =
      sortMode === 'priority' ? t.sortPriority : t.sortRecent;

    // Other-running count pill in inline chat header
    const otherRunning = working.filter((x) => x.threadId !== openThreadId).length;
    const badgeEl = document.getElementById('other-running-badge');
    if (badgeEl) badgeEl.textContent = otherRunning > 0 ? `${otherRunning}` : '';

    // 0. Pinned Pending Decisions panel (above Running section; zero footprint when empty)
    const decisions = Array.isArray(snap.decisions) ? snap.decisions : [];
    const decisionThreadIds = new Set(
      decisions.map((d) => String(d?.threadId || '').trim()).filter(Boolean),
    );
    renderDecisionsPanel(decisions);

    // 1. Threads Pane (Card B Running + Card C Compact Progress + Section D Swarm .o2-th Cards)
    const cardsEl = document.getElementById('threads-cards');
    if (!active.length) {
      cardsEl.innerHTML = `
        <div class="empty">
          <div class="empty-title">${esc(t.emptyThreadsTitle)}</div>
          <p class="empty-body">${esc(t.emptyThreadsBody)}</p>
        </div>
      `;
    } else {
      cardsEl.innerHTML = [
        renderRunningCard(working),
        renderTasksCard(waiting, idle, working.length, active.length),
        renderO2ThreadsSection(waiting, working, idle, active, decisionThreadIds),
      ].join('');
      bindOverviewEvents(cardsEl);
    }

    // 2. Archived Pane
    const archEl = document.getElementById('archived-list');
    if (!archived.length) {
      archEl.innerHTML = `<div class="empty">${esc(t.emptyArchived)}</div>`;
    } else {
      archEl.innerHTML = `
        <div class="pt-card">
          <div class="tasks-subhead">${esc(t.subheadArchived(archived.length))}</div>
          <div class="running-list">${archived.map(renderSwarmRow).join('')}</div>
        </div>
      `;
      bindOverviewEvents(archEl);
    }

    // 3. Library Active Git Worktree Cards
    const wtCountEl = document.getElementById('wt-count');
    if (wtCountEl) wtCountEl.textContent = wtThreads.length > 0 ? String(wtThreads.length) : '';

    const wtEl = document.getElementById('lib-wt-list');
    if (!wtThreads.length) {
      wtEl.innerHTML = `<div class="empty">${esc(t.emptyWt)}</div>`;
    } else {
      wtEl.innerHTML = `<div class="wt-grid">${wtThreads.map(renderWorktreeCard).join('')}</div>`;
      wtEl.querySelectorAll('button[data-action="copy-wt"]').forEach((btn) => {
        btn.addEventListener('click', () => copyText(btn.dataset.wt, L().copiedPath));
      });
      wtEl.querySelectorAll('button[data-action="popout"]').forEach((btn) => {
        btn.addEventListener('click', () => popoutThreadToMain(btn.dataset.id));
      });
      wtEl.querySelectorAll('button[data-action="open-wt"]').forEach((btn) => {
        btn.addEventListener('click', () => openThreadDrawer(btn.dataset.id));
      });
    }
  }

  // ---------- 1:1 Native Main Chat Matched Inline Thread Screen ----------
  function renderSkeletonLoader() {
    return `
      <div class="skel-wrap" aria-busy="true">
        <div class="shimmer-skeleton skel-card"></div>
        <div class="shimmer-skeleton skel-bubble"></div>
        <div class="shimmer-skeleton skel-line w-80"></div>
        <div class="shimmer-skeleton skel-line w-65"></div>
        <div class="shimmer-skeleton skel-line w-45"></div>
      </div>
    `;
  }

  function renderTraceToolInnerHtml(e) {
    const t = L();
    const cat = e.category || 'other';
    const raw = normalizeActivityText(e.rawTarget || e.target || e.label || '');

    if (cat === 'read') {
      const verb = e.running ? t.traceVerb.analyzing : t.traceVerb.analyzed;
      if (e.fileUri && e.shortFile) {
        const pill = renderFilePillHtml(e.shortFile, e.fileUri);
        const range = e.lineRange ? ` <span class="trace-dur">${esc(e.lineRange)}</span>` : '';
        return `${esc(verb)} ${pill}${range}`;
      }
      return `${esc(verb)} ${esc(raw)}`;
    }

    if (cat === 'edit') {
      const verb = e.running ? t.traceVerb.editing : t.traceVerb.edited;
      if (e.fileUri && e.shortFile) {
        const pill = renderFilePillHtml(e.shortFile, e.fileUri);
        return `${esc(verb)} ${pill}`;
      }
      return `${esc(verb)} ${esc(raw)}`;
    }

    if (cat === 'cmd') {
      const verb = e.running ? t.traceVerb.runningCmd : t.traceVerb.ranCmd;
      return `${esc(verb)} ${esc(lowerFirst(raw))}`;
    }

    if (cat === 'search') {
      const verb = e.running ? t.traceVerb.searching : t.traceVerb.searched;
      return `${esc(verb)} ${esc(raw)}`;
    }

    if (cat === 'mcp') {
      const verb = e.running ? t.traceVerb.calling : t.traceVerb.called;
      return `${esc(verb)} ${esc(raw)}`;
    }

    const verb = e.running ? t.traceVerb.using : t.traceVerb.used;
    return `${esc(verb)} ${esc(raw)}`;
  }

  function renderTraceEntriesHtml(it) {
    const t = L();
    const entries =
      Array.isArray(it.entries) && it.entries.length > 0
        ? it.entries
        : [
            ...(it.thinking ? [{ kind: 'thought', durationSec: 1, text: it.thinking }] : []),
            ...(Array.isArray(it.calls) ? it.calls.map((c) => ({ ...c, kind: 'tool' })) : []),
          ];

    return entries
      .map((e, eIdx) => {
        if (e.kind === 'thought') {
          const detId = `${it.id}-th-${eIdx}`;
          const subOpen = openSubDetailIds.has(detId) ? ' open' : '';
          return `
            <details class="trace-thought" data-det-id="${esc(detId)}"${subOpen}>
              <summary>
                <span>${esc(t.thoughtFor(fmtWorkedDuration(e.durationSec || 1)))}</span>
                <span class="trace-chev">${ICONS.chevronRight}</span>
              </summary>
              <div class="trace-think">${esc(e.text || '')}</div>
            </details>
          `;
        }

        if (e.kind === 'note') {
          return `<div class="trace-think">${renderInlineMd(e.text || '')}</div>`;
        }

        const innerHtml = renderTraceToolInnerHtml(e);
        if (e.outputPreview) {
          const detId = `${it.id}-tl-${eIdx}`;
          const subOpen = openSubDetailIds.has(detId) ? ' open' : '';
          return `
            <details class="trace-step" data-det-id="${esc(detId)}"${subOpen}>
              <summary>
                <span>${innerHtml}</span>
                <span class="trace-chev">${ICONS.chevronRight}</span>
              </summary>
              <pre>${esc(e.outputPreview)}</pre>
            </details>
          `;
        }
        return `<div class="trace-step"><div class="trace-step-line"><span>${innerHtml}</span></div></div>`;
      })
      .join('');
  }

  function getCurrentEffectiveSettings() {
    if (loadedSettingsData?.effective) return loadedSettingsData.effective;
    const scopeKey = loadedSettingsData?.scopeKey || activeScopeKey || '';
    return {
      scopeKey,
      scopeKind: scopeKey ? 'workspace' : 'unscoped',
      projectName: '',
      scopeLabel: '',
      hasProjectOverride: false,
      coordinatorId: '',
      coordinatorModel: '',
      coordinatorModelDisplayName: '',
      worktreeModel: 'inherit',
      readOnlyModel: 'inherit',
      worktreeModelLabel: L().settingsInheritOption,
      readOnlyModelLabel: L().settingsInheritOption,
      worktreeSource: 'global',
      readOnlySource: 'global',
      global: {
        worktreeModel: 'inherit',
        readOnlyModel: 'inherit',
        worktreeModelLabel: L().settingsInheritOption,
        readOnlyModelLabel: L().settingsInheritOption,
      },
      project: {
        worktreeModel: '',
        readOnlyModel: '',
        worktreeModelLabel: '',
        readOnlyModelLabel: '',
      },
    };
  }

  function getCoordinatorModelDisplayName() {
    return String(
      loadedSettingsData?.coordinatorModelDisplayName ||
        loadedSettingsData?.effective?.coordinatorModelDisplayName ||
        '',
    ).trim();
  }

  function hasBoundCoordinatorSession() {
    return Boolean(
      lastSnap?.coordinator?.conversationId ||
        loadedSettingsData?.effective?.coordinatorId ||
        getHostConvId(),
    );
  }

  function getSettingsInheritOptionLabel() {
    const t = L();
    const coordName = getCoordinatorModelDisplayName();
    if (coordName) return t.settingsInheritWithModel(coordName);
    if (hasBoundCoordinatorSession()) return t.settingsInheritDraftOption;
    return t.settingsInheritOption;
  }

  function resolveSettingsOptionValue(rawVal) {
    const val = String(rawVal || '').trim();
    if (!val) return '';
    const low = val.toLowerCase();
    if (low === 'inherit') return 'inherit';
    if (low === 'pro' || low === 'flash' || low === 'flash_lite') return low;
    if (low === 'flash-lite' || low === 'lite') return 'flash_lite';
    if (low === 'default' || low === 'auto') return '';
    const matched = getModelByIdFromCatalog(val);
    if (matched) return matched.id || matched.modelId || matched.modelEnum || val;
    return val;
  }

  function resolveSettingsModelDisplay(rawVal, { compactInherit = false } = {}) {
    const val = String(rawVal || '').trim();
    if (!val || val.toLowerCase() === 'inherit') {
      const t = L();
      const coordName = getCoordinatorModelDisplayName();
      if (compactInherit) {
        return coordName ? `${t.settingsInheritShort}: ${coordName}` : t.settingsInheritShort;
      }
      return getSettingsInheritOptionLabel();
    }
    const matched = getModelByIdFromCatalog(val);
    if (matched?.label) return matched.label;
    const savedLabels = loadedSettingsData?.settings?.labels;
    if (savedLabels && savedLabels[val]) return savedLabels[val];
    return formatModelDisplay(val);
  }

  function readDispatchModelValue() {
    if (!elFModel) return '';
    if (elFModel.value === '__follow_global__') return '';
    if (elFModel.value === '__inherit__' || elFModel.value === 'inherit') return 'inherit';
    if (elFTier && elFTier.options.length > 0) return elFTier.value;
    return resolveSettingsOptionValue(elFModel.value);
  }

  function resetDispatchModelSelect() {
    if (!elFModel) return;
    if ([...elFModel.options].some((o) => o.value === '__follow_global__')) {
      elFModel.value = '__follow_global__';
    } else if (elFModel.options[0]) {
      elFModel.selectedIndex = 0;
    }
    const grp = dispatchModelGroups.find((g) => g.key === elFModel.value) || null;
    if (elFTier) {
      if (grp) {
        populateSettingsTierSelect(elFTier, grp, grp.defaultValue ?? '');
      } else {
        elFTier.innerHTML = `<option value="">${esc(L().settingsTierNone)}</option>`;
        elFTier.value = '';
        elFTier.disabled = true;
      }
    }
  }

  function populateDispatchModelSelect() {
    if (!elFModel) return;
    const t = L();
    const prevVal = elFModel.options.length ? readDispatchModelValue() : '';
    const wtChk = document.getElementById('f-wt');
    const isWt = wtChk ? !wtChk.disabled && wtChk.checked : true;
    const eff = getCurrentEffectiveSettings();
    const effModelId = isWt ? eff.worktreeModel : eff.readOnlyModel;
    const effLabel =
      String(effModelId || '').toLowerCase() === 'inherit'
        ? resolveSettingsModelDisplay('inherit', { compactInherit: true })
        : isWt
          ? eff.worktreeModelLabel || resolveSettingsModelDisplay(effModelId)
          : eff.readOnlyModelLabel || resolveSettingsModelDisplay(effModelId);

    const inheritLabel = getSettingsInheritOptionLabel();
    const baseGroups = buildModelFamilyGroups(selectableModels, {
      includeFollowGlobal: true,
      followGlobalLabel: t.useSettingsDefault(effLabel || t.settingsInheritShort),
      followGlobalTierLabel: t.settingsTierNone,
      includeInherit: true,
      inheritLabel,
      inheritTierLabel: t.settingsTierNone,
      defaultTierLabel: t.settingsTierDefault,
      standardTierLabel: t.settingsTierStandard,
    });

    dispatchModelGroups = populateSettingsModelPair(
      elFModel,
      elFTier,
      baseGroups,
      prevVal,
      '',
    );
  }

  function buildSettingsSlotGroups(scope, followGlobalLabel = '') {
    const t = L();
    const inheritLabel = getSettingsInheritOptionLabel();
    return buildModelFamilyGroups(selectableModels, {
      includeFollowGlobal: scope === 'project',
      followGlobalLabel,
      followGlobalTierLabel: t.settingsTierNone,
      includeInherit: true,
      inheritLabel,
      inheritTierLabel: t.settingsTierNone,
      defaultTierLabel: t.settingsTierDefault,
      standardTierLabel: t.settingsTierStandard,
    });
  }

  function populateSettingsTierSelect(elTier, group, targetValue = '') {
    if (!elTier) return;
    const tiers = Array.isArray(group?.tiers) ? group.tiers : [];
    elTier.innerHTML = tiers
      .map((tier) => `<option value="${esc(tier.value)}">${esc(tier.label)}</option>`)
      .join('');
    const hasMatch = tiers.some((tier) => tier.value === targetValue);
    if (hasMatch) {
      elTier.value = targetValue;
    } else if (tiers.some((tier) => tier.value === group?.defaultValue)) {
      elTier.value = group.defaultValue;
    } else if (tiers[0]) {
      elTier.value = tiers[0].value;
    }
    elTier.disabled = !group || !group.hasTiers || tiers.length <= 1;
  }

  function populateSettingsModelPair(
    elModel,
    elTier,
    groups,
    targetValue = '',
    fallbackValue = settingsScope === 'project' ? '' : 'inherit',
  ) {
    if (!elModel) return groups;
    const t = L();
    const sel = resolveModelFamilySelection(targetValue, groups, {
      savedLabels: loadedSettingsData?.settings?.labels,
      defaultTierLabel: t.settingsTierDefault,
      fallbackValue,
    });
    const nextGroups = sel.groups;
    elModel.innerHTML = nextGroups
      .map((g) => `<option value="${esc(g.key)}">${esc(g.label)}</option>`)
      .join('');
    elModel.value = sel.groupKey;
    populateSettingsTierSelect(elTier, sel.group, sel.value);
    return nextGroups;
  }

  function readSettingsSlotValue(kind) {
    const elModel = kind === 'worktree' ? elSetWorktree : elSetReadOnly;
    const elTier = kind === 'worktree' ? elSetWorktreeTier : elSetReadOnlyTier;
    if (!elModel) return settingsScope === 'project' ? '' : 'inherit';
    if (elModel.value === '__follow_global__') return '';
    if (elModel.value === '__inherit__') return 'inherit';
    if (elTier && elTier.options.length > 0) return elTier.value;
    return settingsScope === 'project' ? '' : 'inherit';
  }

  function getSavedSettingForScope(kind, scope) {
    const settings = loadedSettingsData?.settings || {};
    const eff = getCurrentEffectiveSettings();
    const scopeKey = loadedSettingsData?.scopeKey || eff.scopeKey || activeScopeKey || '';
    if (scope === 'project') {
      const projEntry = (scopeKey && settings.projects?.[scopeKey]) || eff.project || {};
      const raw = kind === 'worktree' ? projEntry.worktreeModel : projEntry.readOnlyModel;
      return resolveSettingsOptionValue(raw || '');
    }
    const defs = settings.defaults || eff.global || {};
    const raw = kind === 'worktree' ? defs.worktreeModel : defs.readOnlyModel;
    return resolveSettingsOptionValue(raw || 'inherit') || 'inherit';
  }

  function isSettingsDraftDirty() {
    if (!settingsScreenOpen) return false;
    const savedWtScope = getSavedSettingForScope('worktree', settingsScope);
    const savedRoScope = getSavedSettingForScope('readOnly', settingsScope);
    return (
      readSettingsSlotValue('worktree') !== savedWtScope ||
      readSettingsSlotValue('readOnly') !== savedRoScope
    );
  }

  function isSettingsSlotFollowingCoordinator(kind) {
    const val = readSettingsSlotValue(kind);
    if (String(val || '').toLowerCase() === 'inherit') return true;
    if (settingsScope === 'project' && !val) {
      const eff = getCurrentEffectiveSettings();
      const globalRaw = kind === 'worktree' ? eff.global?.worktreeModel : eff.global?.readOnlyModel;
      return !globalRaw || String(globalRaw).toLowerCase() === 'inherit';
    }
    return false;
  }

  function syncSettingsInheritHint() {
    if (!elSettingsScreen) return;
    const t = L();
    const coordName = getCoordinatorModelDisplayName();
    const wtFollows = isSettingsSlotFollowingCoordinator('worktree');
    const roFollows = isSettingsSlotFollowingCoordinator('readOnly');
    const anyFollows = wtFollows || roFollows;
    const noteText = coordName ? t.settingsInheritActiveNote(coordName) : t.settingsInheritDraftNote;

    if (elSetWorktree) {
      elSetWorktree.title = wtFollows ? noteText : '';
    }
    if (elSetReadOnly) {
      elSetReadOnly.title = roFollows ? noteText : '';
    }
    if (elSettingsInheritNote) {
      elSettingsInheritNote.hidden = !anyFollows;
      elSettingsInheritNote.classList.toggle('is-draft', anyFollows && !coordName);
      elSettingsInheritNote.textContent = anyFollows ? noteText : '';
    }
  }

  function syncSettingsActionState() {
    if (!elSettingsScreen) return;
    const t = L();
    const eff = getCurrentEffectiveSettings();
    const draftWt = readSettingsSlotValue('worktree');
    const draftRo = readSettingsSlotValue('readOnly');
    if (elBtnSettingsReset && !settingsSaving) {
      elBtnSettingsReset.textContent =
        settingsScope === 'project' ? t.settingsResetProject : t.settingsResetGlobal;
      elBtnSettingsReset.disabled =
        settingsScope === 'project' && !eff.hasProjectOverride && !draftWt && !draftRo;
    }
    syncSettingsInheritHint();
  }

  function renderSettingsScreen(syncInputs = false) {
    if (!elSettingsScreen) return;
    const t = L();
    const eff = getCurrentEffectiveSettings();
    const scopeKey = loadedSettingsData?.scopeKey || eff.scopeKey || activeScopeKey || '';
    const hasScope = Boolean(scopeKey);
    if (!hasScope && settingsScope === 'project') {
      settingsScope = 'global';
    }

    document.getElementById('lbl-settings-back').textContent = t.settingsBack;
    document.getElementById('settings-title').textContent = t.settingsTitle;
    if (elSettingsScopeToggle) {
      elSettingsScopeToggle.hidden = !hasScope;
    }
    if (elBtnScopeGlobal && elBtnScopeProject) {
      const isGlobal = settingsScope !== 'project';
      elBtnScopeGlobal.textContent = t.settingsScopeGlobal;
      elBtnScopeProject.textContent = t.settingsScopeProject;
      elBtnScopeGlobal.classList.toggle('active', isGlobal);
      elBtnScopeProject.classList.toggle('active', !isGlobal);
      elBtnScopeGlobal.setAttribute('aria-selected', isGlobal ? 'true' : 'false');
      elBtnScopeProject.setAttribute('aria-selected', isGlobal ? 'false' : 'true');
    }

    const projLabel =
      eff.projectName ||
      lastSnap?.projectName ||
      eff.scopeLabel ||
      lastSnap?.scopeTitle ||
      lastSnap?.projectLabel ||
      (workspace ? workspace.split(/[\\/]/).filter(Boolean).pop() : '') ||
      scopeKey;
    document.getElementById('lbl-settings-scope-kicker').textContent =
      settingsScope === 'project' ? t.settingsScopeKickerProject : t.settingsScopeKickerGlobal;
    const scopePill = document.getElementById('settings-scope-pill');
    if (scopePill) {
      scopePill.hidden = settingsScope !== 'project' || !projLabel;
      scopePill.textContent = projLabel;
      scopePill.title = scopeKey && scopeKey !== projLabel ? `${projLabel} — ${scopeKey}` : scopeKey || projLabel;
    }
    document.getElementById('lbl-settings-scope-desc').textContent =
      settingsScope === 'project' ? t.settingsProjectHint(projLabel) : t.settingsGlobalHint;

    document.getElementById('lbl-settings-models-hdr').textContent = t.settingsModelsHdr;
    if (elBtnSettingsRefreshModels) {
      elBtnSettingsRefreshModels.title = t.settingsRefreshModelsTip;
      elBtnSettingsRefreshModels.setAttribute('aria-label', t.settingsRefreshModelsTip);
    }
    document.getElementById('lbl-set-worktree').textContent = t.settingsWorktreeLabel;
    document.getElementById('desc-set-worktree').textContent = t.settingsWorktreeDesc;
    document.getElementById('lbl-set-readonly').textContent = t.settingsReadOnlyLabel;
    document.getElementById('desc-set-readonly').textContent = t.settingsReadOnlyDesc;
    document.getElementById('lbl-set-worktree-model').textContent = t.settingsModelColLabel;
    document.getElementById('lbl-set-worktree-tier').textContent = t.settingsTierColLabel;
    document.getElementById('lbl-set-readonly-model').textContent = t.settingsModelColLabel;
    document.getElementById('lbl-set-readonly-tier').textContent = t.settingsTierColLabel;

    if (elBtnSettingsSave && !settingsSaving) {
      elBtnSettingsSave.textContent = t.settingsSave;
    }

    const globalWtRaw = eff.global?.worktreeModel || 'inherit';
    const globalRoRaw = eff.global?.readOnlyModel || 'inherit';
    const globalWtLabel =
      String(globalWtRaw).toLowerCase() === 'inherit'
        ? resolveSettingsModelDisplay('inherit', { compactInherit: true })
        : eff.global?.worktreeModelLabel || resolveSettingsModelDisplay(globalWtRaw);
    const globalRoLabel =
      String(globalRoRaw).toLowerCase() === 'inherit'
        ? resolveSettingsModelDisplay('inherit', { compactInherit: true })
        : eff.global?.readOnlyModelLabel || resolveSettingsModelDisplay(globalRoRaw);

    const wtTarget = syncInputs
      ? getSavedSettingForScope('worktree', settingsScope)
      : elSetWorktree?.options?.length
        ? readSettingsSlotValue('worktree')
        : getSavedSettingForScope('worktree', settingsScope);
    const roTarget = syncInputs
      ? getSavedSettingForScope('readOnly', settingsScope)
      : elSetReadOnly?.options?.length
        ? readSettingsSlotValue('readOnly')
        : getSavedSettingForScope('readOnly', settingsScope);

    const wtBaseGroups = buildSettingsSlotGroups(
      settingsScope,
      settingsScope === 'project' ? t.settingsFollowGlobal(globalWtLabel) : '',
    );
    const roBaseGroups = buildSettingsSlotGroups(
      settingsScope,
      settingsScope === 'project' ? t.settingsFollowGlobal(globalRoLabel) : '',
    );

    settingsWorktreeGroups = populateSettingsModelPair(
      elSetWorktree,
      elSetWorktreeTier,
      wtBaseGroups,
      wtTarget,
    );
    settingsReadOnlyGroups = populateSettingsModelPair(
      elSetReadOnly,
      elSetReadOnlyTier,
      roBaseGroups,
      roTarget,
    );

    syncSettingsActionState();
  }

  async function loadSettingsData({ syncInputs = false, forceRefresh = false } = {}) {
    try {
      await syncHostConversationScope();
      const qs = new URLSearchParams(
        buildScopePayload(forceRefresh ? { refresh: '1' } : {}),
      );
      const url = `/api/settings?${qs}`;
      const res = await fetchWithTimeout(url, { method: 'GET' }, API_READ_TIMEOUT_MS);
      const data = await safeReadJson(res, { url });
      if (data?.locale) applyLocale(data.locale);
      inspectServerInfo(data);
      if (data?.ok) {
        loadedSettingsData = {
          settings: data.settings,
          effective: data.effective,
          scopeKey: data.scopeKey || data.effective?.scopeKey || '',
          coordinatorModelDisplayName:
            data.coordinatorModelDisplayName || data.effective?.coordinatorModelDisplayName || '',
          coordinatorModel: data.coordinatorModel || data.effective?.coordinatorModel || '',
        };
        populateDispatchModelSelect();
        if (settingsScreenOpen) {
          renderSettingsScreen(syncInputs);
        }
        return true;
      }
    } catch {
      // Keep cached/default settings if endpoint is temporarily busy
    }
    return false;
  }

  function openSettingsScreen() {
    if (!elSettingsScreen) return;
    closeModelMenu({ restoreHeader: false });
    boardScrollTop = elBoardBody.scrollTop;
    settingsScreenOpen = true;
    settingsDirtyByUser = false;
    if (elSettingsErr) {
      elSettingsErr.hidden = true;
      elSettingsErr.textContent = '';
    }
    clearUpdateCardNotice();
    elBoardScreen.hidden = true;
    elThreadScreen.hidden = true;
    elSettingsScreen.classList.remove('screen-slide');
    elSettingsScreen.hidden = false;
    void elSettingsScreen.offsetWidth;
    elSettingsScreen.classList.add('screen-slide');

    renderSettingsScreen(true);
    renderUpdateCard();
    loadSelectableModels(false);
    loadSettingsData({ syncInputs: true });
    loadPluginUpdateStatus({ bg: true });
  }

  function closeSettingsScreen() {
    if (!elSettingsScreen) return;
    settingsScreenOpen = false;
    elSettingsScreen.hidden = true;
    elBoardScreen.hidden = false;
    elBoardBody.scrollTop = boardScrollTop;
    populateDispatchModelSelect();
    refreshBoard(true);
  }

  async function submitSettingsSave(reset = false) {
    if (settingsSaving) return;
    const t = L();
    const scopeKey =
      loadedSettingsData?.scopeKey || loadedSettingsData?.effective?.scopeKey || activeScopeKey || '';
    const activeScope = settingsScope === 'project' && scopeKey ? 'project' : 'global';
    settingsSaving = true;
    if (elSettingsErr) {
      elSettingsErr.hidden = true;
      elSettingsErr.textContent = '';
    }
    elBtnSettingsSave.disabled = true;
    elBtnSettingsReset.disabled = true;
    if (!reset) elBtnSettingsSave.textContent = t.settingsSaving;

    try {
      await syncHostConversationScope();
      const payload = buildScopePayload({
        scope: activeScope,
        ...(activeScope === 'project' ? { workspaceKey: scopeKey } : {}),
        reset,
      });
      if (!reset) {
        payload.worktreeModel = readSettingsSlotValue('worktree');
        payload.readOnlyModel = readSettingsSlotValue('readOnly');
      }
      const res = await postApi(
        '/api/settings_save',
        '/api/settings_save_get',
        payload,
        { timeoutMs: API_WRITE_TIMEOUT_MS },
      );
      if (!res?.ok) {
        const msg = res?.error || t.settingsSaveErr;
        if (elSettingsErr) {
          elSettingsErr.hidden = false;
          elSettingsErr.textContent = msg;
        }
        flashToast(msg, 'err', 3600);
        return;
      }
      loadedSettingsData = {
        settings: res.settings,
        effective: res.effective,
        scopeKey: res.scopeKey || res.effective?.scopeKey || scopeKey,
        coordinatorModelDisplayName:
          res.coordinatorModelDisplayName || res.effective?.coordinatorModelDisplayName || '',
        coordinatorModel: res.coordinatorModel || res.effective?.coordinatorModel || '',
      };
      settingsDirtyByUser = false;
      populateDispatchModelSelect();
      renderSettingsScreen(true);
      flashToast(
        reset
          ? activeScope === 'project'
            ? t.settingsClearedProjectToast
            : t.settingsResetToast
          : t.settingsSavedToast,
      );
    } catch (err) {
      const msg = err?.message || t.settingsSaveErr;
      if (elSettingsErr) {
        elSettingsErr.hidden = false;
        elSettingsErr.textContent = msg;
      }
      flashToast(msg, 'err', 3600);
    } finally {
      settingsSaving = false;
      elBtnSettingsSave.disabled = false;
      elBtnSettingsSave.textContent = L().settingsSave;
      syncSettingsActionState();
    }
  }

  async function loadSelectableModels(force = false) {
    const now = Date.now();
    if (!force && selectableModels.length > 0 && now - selectableModelsLoadedAt < 45_000) {
      return selectableModels;
    }
    if (selectableModelsPromise && !force) return selectableModelsPromise;
    selectableModelsLoading = true;
    if (modelMenuOpen) renderModelMenu();

    const req = (async () => {
      try {
        const qs = force ? '?refresh=1' : '';
        const url = `/api/models${qs}`;
        const res = await fetchWithTimeout(url, { method: 'GET' }, API_READ_TIMEOUT_MS);
        const data = await safeReadJson(res, { url });
        if (data?.locale) applyLocale(data.locale);
        if (Array.isArray(data?.models)) {
          selectableModels = data.models;
          selectableModelsLoadedAt = Date.now();
          populateDispatchModelSelect();
          if (settingsScreenOpen) renderSettingsScreen(!settingsDirtyByUser);
        }
      } catch {
        // Keep fallback options if /api/models is temporarily unavailable
      } finally {
        selectableModelsLoading = false;
        selectableModelsPromise = null;
        if (modelMenuOpen) renderModelMenu();
      }
      return selectableModels;
    })();
    selectableModelsPromise = req;
    return req;
  }

  function matchesLiveThreadModel(m, th) {
    if (!m || !th) return false;
    if (th.modelEnum && m.modelEnum && m.modelEnum === th.modelEnum) return true;
    if (th.resolvedModel) {
      const resLow = String(th.resolvedModel).toLowerCase();
      const resUntiered = resLow.replace(/-tiered-/g, '-');
      if (
        m.modelId &&
        (m.modelId.toLowerCase() === resLow || m.modelId.toLowerCase() === resUntiered)
      ) {
        return true;
      }
      if (m.modelEnum && m.modelEnum === th.resolvedModel) return true;
    }
    const liveLabel = formatModelDisplay(th.modelDisplayName || th.resolvedModel || th.model);
    if (!liveLabel) return false;
    if (m.label === liveLabel) return true;
    return Boolean(
      isSameModelFamily(liveLabel, m.modelId || m.id || m.label) ||
        (m.label && isSameModelFamily(liveLabel, m.label)),
    );
  }

  function isModelActiveForThread(m, th) {
    if (!m || !th) return false;
    const pending = pendingModelByThread.get(th.threadId);
    if (pending) {
      if (pending.modelEnum && m.modelEnum) return m.modelEnum === pending.modelEnum;
      return (pending.id && m.id === pending.id) || (pending.label && m.label === pending.label);
    }
    return matchesLiveThreadModel(m, th);
  }

  function getModelByIdFromCatalog(modelKey) {
    const raw = String(modelKey || '').trim();
    if (!raw) return null;
    const low = raw.toLowerCase();
    const untiered = low.replace(/-tiered-/g, '-');
    const exact =
      selectableModels.find(
        (m) =>
          m.id === raw ||
          m.modelId === raw ||
          m.modelEnum === raw ||
          m.label === raw,
      ) ||
      selectableModels.find(
        (m) =>
          (m.id && m.id.toLowerCase() === low) ||
          (m.modelId && m.modelId.toLowerCase() === low) ||
          (m.modelId && m.modelId.toLowerCase().replace(/-tiered-/g, '-') === untiered) ||
          (m.label && m.label.toLowerCase() === low),
      ) ||
      null;
    if (exact) return exact;
    if (!/^MODEL_PLACEHOLDER_/i.test(raw)) {
      return (
        selectableModels.find(
          (m) =>
            isSameModelFamily(raw, m.modelId || m.id || m.label) ||
            (m.label && isSameModelFamily(raw, m.label)),
        ) || null
      );
    }
    return null;
  }

  const MODEL_MENU_SUB_WIDTH = 152;
  const MODEL_MENU_SUB_MIN_WIDTH = 132;
  const MODEL_MENU_SUB_GAP = 6;
  const MODEL_MENU_EDGE_PAD = 8;
  const MODEL_MENU_FLYOUT_MIN_VW = 372;

  let modelMenuHoverFamilyKey = '';
  let modelMenuLastFamilies = [];
  let modelMenuCloseTimer = null;
  let modelMenuSwitchTimer = null;

  function formatEffortDisplayLabel(label, thinkingLevel = '') {
    const raw = String(thinkingLevel || label || '').trim();
    if (!raw) return '';
    if (/^x[-_\s]?high$/i.test(raw)) return 'Extra High';
    return raw;
  }

  function clearModelSubmenuTimers() {
    if (modelMenuCloseTimer) {
      clearTimeout(modelMenuCloseTimer);
      modelMenuCloseTimer = null;
    }
    if (modelMenuSwitchTimer) {
      clearTimeout(modelMenuSwitchTimer);
      modelMenuSwitchTimer = null;
    }
  }

  function canUseModelMenuFlyout(
    viewportWidth = typeof window !== 'undefined' && Number.isFinite(window.innerWidth)
      ? window.innerWidth
      : 0,
  ) {
    return Number.isFinite(viewportWidth) && viewportWidth >= MODEL_MENU_FLYOUT_MIN_VW;
  }

  function computeModelSubmenuLayout({
    viewportWidth,
    viewportHeight,
    mainRect,
    rowRect,
    subWidth = MODEL_MENU_SUB_WIDTH,
    subMinWidth = MODEL_MENU_SUB_MIN_WIDTH,
    subHeight = 160,
    gap = MODEL_MENU_SUB_GAP,
    edge = MODEL_MENU_EDGE_PAD,
  } = {}) {
    const vw = Number(viewportWidth) || 0;
    const vh = Number(viewportHeight) || 0;
    if (!canUseModelMenuFlyout(vw) || !mainRect || !Number.isFinite(mainRect.width)) {
      return { mode: 'drilldown', side: 'right', top: 0, maxWidth: subWidth, shiftMainX: 0 };
    }

    const spaceRight = vw - mainRect.right - edge;
    const spaceLeft = mainRect.left - edge;
    const idealNeeded = subWidth + gap;
    const minNeeded = subMinWidth + gap;

    let side = 'right';
    let shiftMainX = 0;
    let avail = spaceRight;

    if (spaceRight >= idealNeeded) {
      side = 'right';
      avail = spaceRight;
    } else if (spaceLeft >= idealNeeded) {
      side = 'left';
      avail = spaceLeft;
    } else if (spaceRight >= minNeeded || spaceLeft >= minNeeded) {
      if (spaceRight >= spaceLeft) {
        side = 'right';
        avail = spaceRight;
      } else {
        side = 'left';
        avail = spaceLeft;
      }
    } else {
      const totalMinNeeded = mainRect.width + gap + subMinWidth + edge * 2;
      if (vw >= totalMinNeeded) {
        const desiredW = Math.min(subWidth, Math.max(subMinWidth, vw - mainRect.width - gap - edge * 2));
        if (spaceRight >= spaceLeft) {
          side = 'right';
          const targetMainLeft = Math.max(edge, vw - edge - desiredW - gap - mainRect.width);
          shiftMainX = Math.round(targetMainLeft - mainRect.left);
          avail = vw - (mainRect.right + shiftMainX) - edge;
        } else {
          side = 'left';
          const targetMainLeft = Math.min(vw - edge - mainRect.width, edge + desiredW + gap);
          shiftMainX = Math.round(targetMainLeft - mainRect.left);
          avail = mainRect.left + shiftMainX - edge;
        }
      } else {
        return { mode: 'drilldown', side: 'right', top: 0, maxWidth: subWidth, shiftMainX: 0 };
      }
    }

    const maxWidth = Math.max(subMinWidth, Math.min(subWidth, Math.floor(avail - gap)));
    const rawRelTop = rowRect ? Math.round(rowRect.top - mainRect.top - 28) : 0;
    let top = rawRelTop;
    if (vh > 0) {
      const absTop = mainRect.top + top;
      const absBottom = absTop + subHeight;
      if (absBottom > vh - edge) {
        top -= absBottom - (vh - edge);
      }
      if (mainRect.top + top < edge) {
        top = Math.round(edge - mainRect.top);
      }
    }
    return { mode: 'flyout', side, top: Math.round(top), maxWidth, shiftMainX };
  }

  function resetModelMenuMainShift() {
    if (elModelMenu && elModelMenu.style) {
      elModelMenu.style.transform = '';
    }
  }

  function syncModelMenuFamilyRowStates() {
    if (!elModelMenu || typeof elModelMenu.querySelectorAll !== 'function') return;
    elModelMenu.querySelectorAll('.pt-model-opt[data-family-key]').forEach((row) => {
      const isOpen = Boolean(modelMenuHoverFamilyKey && row.dataset.familyKey === modelMenuHoverFamilyKey);
      row.classList.toggle('submenu-open', isOpen);
      row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
  }

  function closeModelSubmenu() {
    clearModelSubmenuTimers();
    modelMenuHoverFamilyKey = '';
    resetModelMenuMainShift();
    const subEl = elModelMenu && typeof elModelMenu.querySelector === 'function'
      ? elModelMenu.querySelector('.pt-model-submenu')
      : null;
    if (subEl) {
      subEl.hidden = true;
      subEl.innerHTML = '';
      delete subEl.dataset.familyKey;
      delete subEl.dataset.side;
      if (subEl.style) {
        subEl.style.top = '';
        subEl.style.width = '';
      }
    }
    syncModelMenuFamilyRowStates();
  }

  function scheduleCloseModelSubmenu(delayMs = 160) {
    if (modelMenuSwitchTimer) {
      clearTimeout(modelMenuSwitchTimer);
      modelMenuSwitchTimer = null;
    }
    if (modelMenuCloseTimer) clearTimeout(modelMenuCloseTimer);
    modelMenuCloseTimer = setTimeout(() => {
      modelMenuCloseTimer = null;
      closeModelSubmenu();
    }, delayMs);
  }

  function renderModelSubmenuMarkup(fam, t) {
    const effortTitle = t.modelEffortTitle || 'Thinking Effort';
    const itemsHtml = (fam.tiers || [])
      .map((tier) => {
        const tierDisplay = formatEffortDisplayLabel(tier.label);
        const quotaPct =
          tier.quotaInfo && typeof tier.quotaInfo.remainingFraction === 'number'
            ? Math.max(0, Math.min(100, Math.round(tier.quotaInfo.remainingFraction * 100)))
            : null;
        const tipParts = [
          tier.rawLabel,
          tier.tagDescription || tier.description || '',
          quotaPct !== null ? `${quotaPct}%` : '',
        ].filter(Boolean);
        return `<button type="button" class="pt-model-opt pt-model-sub-opt${tier.active ? ' active' : ''}" role="option" aria-selected="${tier.active ? 'true' : 'false'}" data-model-key="${esc(tier.value)}" title="${esc(tipParts.join(' — '))}"><span class="pt-model-main"><span class="pt-model-name">${esc(tierDisplay)}</span></span>${tier.active ? `<span class="pt-model-trail"><span class="pt-model-chk" aria-hidden="true">${ICONS.check}</span></span>` : ''}</button>`;
      })
      .join('');
    return `
      <div class="pt-model-submenu-hdr">
        <span class="pt-model-submenu-title">${esc(effortTitle)}</span>
      </div>
      <div class="pt-model-submenu-list">${itemsHtml}</div>
    `;
  }

  function positionModelSubmenu(subEl, anchorRow) {
    if (!subEl || !elModelMenu) return { mode: 'drilldown' };
    resetModelMenuMainShift();
    const cardEl =
      typeof elModelMenu.querySelector === 'function'
        ? elModelMenu.querySelector('.pt-model-menu-card')
        : null;
    const vw =
      typeof window !== 'undefined' && Number.isFinite(window.innerWidth)
        ? window.innerWidth
        : 0;
    const vh =
      typeof window !== 'undefined' && Number.isFinite(window.innerHeight)
        ? window.innerHeight
        : 0;
    const mainRect =
      cardEl && typeof cardEl.getBoundingClientRect === 'function'
        ? cardEl.getBoundingClientRect()
        : typeof elModelMenu.getBoundingClientRect === 'function'
          ? elModelMenu.getBoundingClientRect()
          : null;
    if (!mainRect || !mainRect.width) {
      return { mode: canUseModelMenuFlyout(vw) ? 'flyout' : 'drilldown', side: 'right', top: 0, maxWidth: MODEL_MENU_SUB_WIDTH, shiftMainX: 0 };
    }
    const rowRect =
      anchorRow && typeof anchorRow.getBoundingClientRect === 'function'
        ? anchorRow.getBoundingClientRect()
        : null;
    const measuredSubH =
      typeof subEl.getBoundingClientRect === 'function'
        ? Math.max(subEl.getBoundingClientRect().height || 0, 120)
        : 160;
    const layout = computeModelSubmenuLayout({
      viewportWidth: vw,
      viewportHeight: vh,
      mainRect,
      rowRect,
      subHeight: measuredSubH,
    });
    if (layout.mode !== 'flyout') {
      return layout;
    }
    if (layout.shiftMainX && elModelMenu.style) {
      elModelMenu.style.transform = `translateX(${layout.shiftMainX}px)`;
    }
    subEl.dataset.side = layout.side;
    if (subEl.style) {
      subEl.style.top = `${layout.top}px`;
      subEl.style.width = `${layout.maxWidth}px`;
    }
    return layout;
  }

  function openModelSubmenu(famKey, anchorRow = null, { focusFirst = false } = {}) {
    if (!elModelMenu || !modelMenuOpen || modelMenuFamilyKey) return false;
    clearModelSubmenuTimers();
    const fam = modelMenuLastFamilies.find((f) => f.key === famKey && f.hasTiers) || null;
    if (!fam) {
      closeModelSubmenu();
      return false;
    }
    const subEl =
      typeof elModelMenu.querySelector === 'function'
        ? elModelMenu.querySelector('.pt-model-submenu')
        : null;
    if (!subEl) return false;

    const row =
      anchorRow ||
      (typeof elModelMenu.querySelectorAll === 'function'
        ? [...elModelMenu.querySelectorAll('.pt-model-opt[data-family-key]')].find(
            (el) => el.dataset.familyKey === famKey,
          )
        : null);

    const t = L();
    subEl.innerHTML = renderModelSubmenuMarkup(fam, t);
    subEl.dataset.familyKey = famKey;
    subEl.hidden = false;

    const layout = positionModelSubmenu(subEl, row);
    if (layout.mode !== 'flyout') {
      subEl.hidden = true;
      subEl.innerHTML = '';
      delete subEl.dataset.familyKey;
      modelMenuHoverFamilyKey = '';
      syncModelMenuFamilyRowStates();
      return false;
    }

    modelMenuHoverFamilyKey = famKey;
    syncModelMenuFamilyRowStates();

    if (focusFirst && typeof subEl.querySelector === 'function') {
      const target =
        subEl.querySelector('.pt-model-sub-opt.active') ||
        subEl.querySelector('.pt-model-sub-opt');
      if (target && typeof target.focus === 'function') target.focus();
    }
    return true;
  }

  function repositionModelSubmenu() {
    if (!modelMenuOpen || !modelMenuHoverFamilyKey || modelMenuFamilyKey || !elModelMenu) return;
    const subEl =
      typeof elModelMenu.querySelector === 'function'
        ? elModelMenu.querySelector('.pt-model-submenu')
        : null;
    if (!subEl || subEl.hidden) return;
    const row =
      typeof elModelMenu.querySelectorAll === 'function'
        ? [...elModelMenu.querySelectorAll('.pt-model-opt[data-family-key]')].find(
            (el) => el.dataset.familyKey === modelMenuHoverFamilyKey,
          )
        : null;
    const layout = positionModelSubmenu(subEl, row);
    if (layout.mode !== 'flyout') {
      const fallbackKey = modelMenuHoverFamilyKey;
      closeModelSubmenu();
      modelMenuFamilyKey = fallbackKey;
      renderModelMenu();
    }
  }

  function closeModelMenu({ restoreHeader = true } = {}) {
    if (!modelMenuOpen) return;
    clearModelSubmenuTimers();
    modelMenuOpen = false;
    modelMenuFamilyKey = '';
    modelMenuHoverFamilyKey = '';
    resetModelMenuMainShift();
    if (elModelMenu) {
      elModelMenu.hidden = true;
      delete elModelMenu.dataset.renderKey;
      delete elModelMenu.dataset.menuMode;
    }
    if (restoreHeader && openThreadObj) renderThreadHeader(openThreadObj);
  }

  function renderModelTagHtml(tagTitle, isDefault, defaultBadgeText) {
    if (tagTitle) {
      const warnTag = /leaving|notice|deprecat/i.test(tagTitle);
      return `<span class="pt-model-tag${warnTag ? ' warn' : ''}">${esc(tagTitle)}</span>`;
    }
    if (isDefault) {
      return `<span class="pt-model-tag">${esc(defaultBadgeText)}</span>`;
    }
    return '';
  }

  function renderLowQuotaHtml(quotaInfo) {
    if (quotaInfo && typeof quotaInfo.remainingFraction === 'number') {
      const pct = Math.max(0, Math.min(100, Math.round(quotaInfo.remainingFraction * 100)));
      if (pct <= 20) {
        return `<span class="pt-model-quota low">${pct}%</span>`;
      }
    }
    return '';
  }

  function renderModelMenu() {
    if (!elModelMenu || !modelMenuOpen || !openThreadObj) return;
    const t = L();
    const effortTitle = t.modelEffortTitle || 'Thinking Effort';
    const th = openThreadObj;
    const isRunning = !th.archived && th.runState === 'RUN_STATE_RUNNING';
    const pending = pendingModelByThread.get(th.threadId) || null;
    const activeKey = pending
      ? pending.modelEnum || pending.id || pending.label
      : th.modelEnum || th.resolvedModel || th.modelDisplayName || th.model || '';
    const families =
      selectableModels.length > 0
        ? buildComposerModelMenuData(
            selectableModels,
            (tier) => {
              const catModel = getModelByIdFromCatalog(tier.value);
              return catModel ? isModelActiveForThread(catModel, th) : false;
            },
            {
              defaultTierLabel: t.settingsTierDefault,
              standardTierLabel: t.settingsTierStandard,
            },
          )
        : [];
    modelMenuLastFamilies = families;

    const activeFamily = modelMenuFamilyKey
      ? families.find((f) => f.key === modelMenuFamilyKey && f.hasTiers) || null
      : null;
    if (modelMenuFamilyKey && !activeFamily && !selectableModelsLoading) {
      modelMenuFamilyKey = '';
    }
    if (
      modelMenuHoverFamilyKey &&
      !families.some((f) => f.key === modelMenuHoverFamilyKey && f.hasTiers) &&
      !selectableModelsLoading
    ) {
      modelMenuHoverFamilyKey = '';
    }

    const renderKey = [
      curLocale,
      th.threadId,
      isRunning ? 'run' : 'idle',
      activeKey,
      activeFamily ? activeFamily.key : '',
      selectableModelsLoading ? 'loading' : 'ready',
      selectableModels.map((m) => `${m.id}:${m.quotaInfo?.remainingFraction ?? ''}`).join(','),
    ].join('|');

    if (elModelMenu.dataset.renderKey === renderKey && !elModelMenu.hidden) {
      return;
    }
    const prevMode = elModelMenu.dataset.menuMode || '';
    const nextMode = activeFamily ? `level2:${activeFamily.key}` : 'level1';
    const prevList =
      typeof elModelMenu.querySelector === 'function'
        ? elModelMenu.querySelector('.pt-model-menu-list')
        : null;
    const prevScroll = prevList && prevMode === nextMode ? prevList.scrollTop : 0;

    let hdrCls = 'pt-model-menu-hdr';
    let hdrInnerHtml = '';
    let bodyHtml = '';
    const runningHintHtml = isRunning
      ? `<span class="pt-model-menu-hint running">${esc(t.modelRunningHint)}</span>`
      : '';

    if (selectableModelsLoading && selectableModels.length === 0) {
      hdrInnerHtml = `
        <span class="pt-model-menu-title">${esc(t.modelMenuTitle)}</span>
        ${runningHintHtml}
      `;
      bodyHtml = `<div class="pt-model-menu-empty">${esc(t.modelLoading)}</div>`;
    } else if (!selectableModels.length) {
      hdrInnerHtml = `
        <span class="pt-model-menu-title">${esc(t.modelMenuTitle)}</span>
        ${runningHintHtml}
      `;
      bodyHtml = `<div class="pt-model-menu-empty">${esc(t.modelEmpty)}</div>`;
    } else if (activeFamily) {
      hdrCls = 'pt-model-menu-hdr pt-model-menu-hdr-drill';
      const famTagHtml = activeFamily.tagTitle
        ? `<span class="pt-model-tag${/leaving|notice|deprecat/i.test(activeFamily.tagTitle) ? ' warn' : ''}">${esc(activeFamily.tagTitle)}</span>`
        : '';
      hdrInnerHtml = `
        <div class="pt-model-menu-nav">
          <button type="button" class="pt-model-back" title="${esc(t.modelBack)}">${ICONS.chevronLeft}<span>${esc(t.modelBack)}</span></button>
          <span class="pt-model-menu-family" title="${esc(activeFamily.label)}">${esc(activeFamily.label)}</span>
          ${famTagHtml}
        </div>
        <span class="pt-model-menu-sublabel">${esc(effortTitle)}</span>
        ${runningHintHtml}
      `;
      bodyHtml = `<div class="pt-model-menu-list">${activeFamily.tiers
        .map((tier) => {
          const tierDisplay = formatEffortDisplayLabel(tier.label);
          const tagHtml = renderModelTagHtml(tier.tagTitle, tier.isDefault, t.modelDefaultBadge);
          const lowQuotaHtml = renderLowQuotaHtml(tier.quotaInfo);
          const tipParts = [tier.rawLabel, tier.tagDescription || tier.description || ''].filter(Boolean);
          const trailHtml =
            lowQuotaHtml || tier.active
              ? `<span class="pt-model-trail">${lowQuotaHtml}${tier.active ? `<span class="pt-model-chk" aria-hidden="true">${ICONS.check}</span>` : ''}</span>`
              : '';
          return `<button type="button" class="pt-model-opt${tier.active ? ' active' : ''}" role="option" aria-selected="${tier.active ? 'true' : 'false'}" data-model-key="${esc(tier.value)}" title="${esc(tipParts.join(' — '))}"><span class="pt-model-main"><span class="pt-model-name">${esc(tierDisplay)}</span>${tagHtml}</span>${trailHtml}</button>`;
        })
        .join('')}</div>`;
    } else {
      hdrInnerHtml = `
        <span class="pt-model-menu-title">${esc(t.modelMenuTitle)}</span>
        ${runningHintHtml}
      `;
      bodyHtml = `<div class="pt-model-menu-list">${families
        .map((fam) => {
          const tagHtml = renderModelTagHtml(
            fam.tagTitle,
            !fam.hasTiers && fam.hasDefaultBadge,
            t.modelDefaultBadge,
          );
          const lowQuotaHtml = renderLowQuotaHtml(fam.quotaInfo);
          const quotaPct =
            fam.quotaInfo && typeof fam.quotaInfo.remainingFraction === 'number'
              ? Math.max(0, Math.min(100, Math.round(fam.quotaInfo.remainingFraction * 100)))
              : null;
          const famTip = quotaPct !== null ? `${fam.title} (${quotaPct}%)` : fam.title;
          if (fam.hasTiers) {
            const effortDisplay = formatEffortDisplayLabel(fam.activeEffortLabel);
            const effortHtml = effortDisplay
              ? `<span class="pt-model-effort">${esc(effortDisplay)}</span>`
              : '';
            const isSubOpen = Boolean(modelMenuHoverFamilyKey && modelMenuHoverFamilyKey === fam.key);
            return `<button type="button" class="pt-model-opt${fam.active ? ' active' : ''}${isSubOpen ? ' submenu-open' : ''}" role="option" aria-selected="${fam.active ? 'true' : 'false'}" aria-haspopup="menu" aria-expanded="${isSubOpen ? 'true' : 'false'}" data-family-key="${esc(fam.key)}" title="${esc(famTip)}"><span class="pt-model-main"><span class="pt-model-name">${esc(fam.label)}</span>${effortHtml}${tagHtml}</span><span class="pt-model-trail">${lowQuotaHtml}${fam.active ? `<span class="pt-model-chk" aria-hidden="true">${ICONS.check}</span>` : ''}<span class="pt-model-chev" aria-hidden="true">${ICONS.chevronRight}</span></span></button>`;
          }
          const trailHtml =
            lowQuotaHtml || fam.active
              ? `<span class="pt-model-trail">${lowQuotaHtml}${fam.active ? `<span class="pt-model-chk" aria-hidden="true">${ICONS.check}</span>` : ''}</span>`
              : '';
          return `<button type="button" class="pt-model-opt${fam.active ? ' active' : ''}" role="option" aria-selected="${fam.active ? 'true' : 'false'}" data-model-key="${esc(fam.singleModelKey)}" title="${esc(famTip)}"><span class="pt-model-main"><span class="pt-model-name">${esc(fam.label)}</span>${tagHtml}</span>${trailHtml}</button>`;
        })
        .join('')}</div>`;
    }

    elModelMenu.innerHTML = `
      <div class="pt-model-menu-card">
        <div class="${hdrCls}">
          ${hdrInnerHtml}
        </div>
        ${bodyHtml}
      </div>
      <div class="pt-model-submenu" role="listbox" aria-label="${esc(effortTitle)}" hidden></div>
    `;
    elModelMenu.dataset.renderKey = renderKey;
    elModelMenu.dataset.menuMode = nextMode;
    elModelMenu.hidden = false;

    const nextList =
      typeof elModelMenu.querySelector === 'function'
        ? elModelMenu.querySelector('.pt-model-menu-list')
        : null;
    if (nextList) {
      if (prevScroll > 0) nextList.scrollTop = prevScroll;
      if (typeof nextList.addEventListener === 'function') {
        nextList.addEventListener('scroll', () => {
          if (modelMenuHoverFamilyKey && !modelMenuFamilyKey) {
            repositionModelSubmenu();
          }
        });
      }
    }

    if (!activeFamily && modelMenuHoverFamilyKey && canUseModelMenuFlyout()) {
      openModelSubmenu(modelMenuHoverFamilyKey);
    } else if (activeFamily) {
      modelMenuHoverFamilyKey = '';
      resetModelMenuMainShift();
    }
  }

  function openModelMenu() {
    if (!openThreadObj || openThreadObj.archived) return;
    clearModelSubmenuTimers();
    modelMenuOpen = true;
    modelMenuFamilyKey = '';
    modelMenuHoverFamilyKey = '';
    resetModelMenuMainShift();
    renderThreadHeader(openThreadObj);
    renderModelMenu();
    if (!selectableModels.length || Date.now() - selectableModelsLoadedAt > 30_000) {
      loadSelectableModels(!selectableModels.length);
    }
    const activeOpt =
      elModelMenu?.querySelector('.pt-model-opt.active') ||
      elModelMenu?.querySelector('.pt-model-opt');
    if (activeOpt && typeof activeOpt.scrollIntoView === 'function') {
      activeOpt.scrollIntoView({ block: 'nearest' });
    }
  }

  function toggleModelMenu() {
    if (modelMenuOpen) closeModelMenu();
    else openModelMenu();
  }

  function selectThreadModel(modelItem) {
    if (!openThreadId || !openThreadObj || !modelItem) return;
    if (matchesLiveThreadModel(modelItem, openThreadObj)) {
      pendingModelByThread.delete(openThreadId);
    } else {
      pendingModelByThread.set(openThreadId, modelItem);
    }
    closeModelMenu({ restoreHeader: false });
    renderThreadHeader(openThreadObj);
    elChatInput.focus();
  }

  function renderThreadHeader(th) {
    const t = L();
    openThreadObj = th;
    document.getElementById('chat-tid').textContent = th.threadId || '';
    const titleEl = document.getElementById('chat-title-text');
    titleEl.textContent = th.title || '';
    titleEl.title = th.title || '';

    const isRunning = !th.archived && th.runState === 'RUN_STATE_RUNNING';
    const isWaiting = !th.archived && th.bucket === 'waiting';
    document.getElementById('chat-status-dot').className = `sdot ${
      th.archived ? '' : isRunning ? 'run' : isWaiting ? 'warn' : 'ok'
    }`;

    const archBtn = document.getElementById('btn-archive-cur');
    archBtn.hidden = Boolean(th.archived);
    const cleanWtCurBtn = document.getElementById('btn-clean-wt-cur');
    if (cleanWtCurBtn) {
      cleanWtCurBtn.hidden = !(th.archived && th.worktreePath);
      cleanWtCurBtn.textContent = t.actCleanWt;
      cleanWtCurBtn.title = t.actCleanWtTip;
    }
    updateCoordinatorControls();

    const compMeta = document.getElementById('composer-meta');
    const liveModelLabel = formatModelDisplay(th.modelDisplayName || th.resolvedModel || th.model);
    const pendingModel = th.threadId ? pendingModelByThread.get(th.threadId) || null : null;
    const modelLabel = pendingModel
      ? pendingModel.label || formatModelDisplay(pendingModel)
      : liveModelLabel;
    const switchHint = pendingModel ? t.modelPendingTip : t.modelSwitchTip;
    const modelTitle = th.archived ? modelLabel : `${modelLabel} — ${switchHint}`;
    const roleLabel = th.worktreePath || th.branch ? t.roleWorker : t.roleReadOnly;
    const stepsHtml =
      th.toolStepCount > 0
        ? `<span class="comp-steps-pill">◌ ${esc(t.stepsUnit(th.toolStepCount))}</span>`
        : '';
    const wtBtn = th.worktreePath
      ? `<button type="button" id="btn-comp-wt" class="ghost" title="${esc(th.worktreePath)}">${ICONS.folder} <span>${esc(t.actFolder)}</span></button>`
      : '';
    const modelBtnCls = `comp-model-pill${pendingModel ? ' pending' : ''}${modelMenuOpen ? ' open' : ''}`;
    const modelBtnHtml = `<button type="button" id="btn-comp-model" class="${modelBtnCls}" title="${esc(modelTitle)}" aria-haspopup="listbox" aria-expanded="${modelMenuOpen ? 'true' : 'false'}"${th.archived ? ' disabled' : ''}><span class="comp-model-lbl">${esc(modelLabel)}</span><span class="comp-model-chev" aria-hidden="true">${ICONS.chevronDown}</span></button>`;

    const nextMetaHtml = `<span class="comp-plus-ico" aria-hidden="true">${ICONS.plus}</span><span class="comp-role-lbl">${esc(roleLabel)}</span>${modelBtnHtml}${stepsHtml}${wtBtn}`;
    if (compMeta.dataset.renderedHtml !== nextMetaHtml) {
      compMeta.innerHTML = nextMetaHtml;
      compMeta.dataset.renderedHtml = nextMetaHtml;
    }

    if (modelMenuOpen) {
      renderModelMenu();
    }

    // Active running trace renders inline at the bottom of #chat-stream matching Native Chat
    elLiveBar.hidden = true;
    syncSendButtonState();
  }

  function renderThreadItems(items, scrollForceBottom = false) {
    lastRenderedItems = items;
    const t = L();
    const wasNearBottom =
      scrollForceBottom ||
      elChatStream.scrollHeight - elChatStream.scrollTop - elChatStream.clientHeight < 76;
    const prevScrollTop = elChatStream.scrollTop;

    if (!items || !items.length) {
      elChatStream.innerHTML = `<div class="empty">${esc(t.emptyChat)}</div>`;
      return;
    }

    const isThreadRunning = Boolean(
      openThreadObj && !openThreadObj.archived && openThreadObj.runState === 'RUN_STATE_RUNNING',
    );

    elChatStream.innerHTML = items
      .map((it, idx) => {
        if (it.kind === 'task_brief') {
          const rawTask = it.taskText || '';
          const isLongBrief = rawTask.length > 260 || rawTask.split('\n').length > 6;
          const clampCls = isLongBrief && !briefExpanded ? ' clamped' : '';
          const ctxId = `ctx-${it.id}`;
          const ctxOpen = openSubDetailIds.has(ctxId) ? ' open' : '';
          return `
            <div class="brief-card">
              <div class="brief-head">
                <span>${esc(t.briefTitle)}</span>
                ${
                  isLongBrief
                    ? `<button type="button" id="btn-toggle-brief" class="expand-link">${esc(
                        briefExpanded ? t.briefCollapse : t.briefExpand,
                      )}</button>`
                    : ''
                }
              </div>
              <div id="brief-body" class="msg-assistant brief-body${clampCls}">${renderMarkdown(rawTask)}</div>
              ${
                it.contextText
                  ? `<details class="brief-ctx" data-det-id="${esc(ctxId)}"${ctxOpen}>
                      <summary>${ICONS.chevronRight} <span>${esc(t.briefCtx)}</span></summary>
                      <pre>${esc(it.contextText)}</pre>
                    </details>`
                  : ''
              }
            </div>
          `;
        }

        if (it.kind === 'user') {
          const txt = it.text || '';
          const lineCount = txt.split('\n').length;
          const isLongUser = lineCount > 20 || txt.length > 1000;
          const isExpanded = expandedUserMsgIds.has(it.id);
          const clampCls = isLongUser && !isExpanded ? ' clamped' : '';
          return `
            <div class="user-wrap">
              <div class="msg-user${clampCls}" data-uid="${esc(it.id)}">${esc(txt)}</div>
              ${
                isLongUser
                  ? `<button type="button" class="user-toggle" data-uid="${esc(it.id)}" data-lines="${lineCount}">${esc(
                      isExpanded ? t.userCollapse : t.userExpand(lineCount),
                    )}</button>`
                  : ''
              }
              ${it.pending ? `<div class="msg-pending">${esc(t.pendingSend)}</div>` : ''}
            </div>
          `;
        }

        if (it.kind === 'task_result') {
          const detId = `banner-${it.id}`;
          const isOpen = openSubDetailIds.has(detId) ? ' open' : '';
          return `
            <details class="task-banner" data-det-id="${esc(detId)}"${isOpen}>
              <summary>
                <span>${esc(it.title || '')}</span>
                <span class="trace-chev">${ICONS.chevronRight}</span>
              </summary>
              ${it.output ? `<pre>${esc(it.output)}</pre>` : ''}
            </details>
          `;
        }

        if (it.kind === 'steps_card') {
          const steps = Array.isArray(it.steps) ? it.steps : [];
          if (!steps.length) return '';
          const rowsHtml = steps
            .map((s) => {
              const st = String(s.status || 'pending');
              let rowCls = 'pending';
              let icoHtml = '<span class="step-ico pending" aria-hidden="true"></span>';
              if (st === 'in_progress' || st === 'active') {
                rowCls = 'active';
                icoHtml = '<span class="step-ico active" aria-hidden="true">⠿</span>';
              } else if (st === 'done') {
                rowCls = 'done';
                icoHtml = '<span class="step-ico done" aria-hidden="true">✓</span>';
              } else if (st === 'failed') {
                rowCls = 'failed';
                icoHtml = '<span class="step-ico failed" aria-hidden="true">!</span>';
              } else if (st === 'skipped') {
                rowCls = 'skipped';
                icoHtml = '<span class="step-ico skipped" aria-hidden="true">–</span>';
              }
              return `<div class="steps-row ${rowCls}">${icoHtml}<span>${esc(s.title)}</span></div>`;
            })
            .join('');
          return `<div class="steps-card">${rowsHtml}</div>`;
        }

        if (it.kind === 'trace') {
          const isLiveTail = isThreadRunning && idx === items.length - 1;
          const shouldOpen = isLiveTail
            ? !closedLiveTraceIds.has(it.id)
            : openTraceIds.has(it.id);

          let durSec = Math.max(1, Number(it.durationSec) || 1);
          if (isLiveTail && it.startedAt) {
            const elapsed = Math.round((Date.now() - Date.parse(it.startedAt)) / 1000);
            if (Number.isFinite(elapsed) && elapsed > durSec) {
              durSec = Math.min(86400, elapsed);
            }
          }

          const summaryInner = isLiveTail
            ? `<span class="animate-shimmer-text">${esc(
                localizeActiveTraceHeader(it.activeHeader) || t.thinkingLive,
              )}</span><span class="trace-dur">${esc(fmtWorkedDuration(durSec))}</span><span class="trace-chev">${ICONS.chevronRight}</span>`
            : `<span>${esc(t.workedFor(fmtWorkedDuration(durSec)))}</span><span class="trace-chev">${ICONS.chevronRight}</span>`;

          return `
            <details class="trace-box${isLiveTail ? ' live-open' : ''}" data-trace-id="${esc(it.id)}" data-live-tail="${isLiveTail ? '1' : '0'}"${shouldOpen ? ' open' : ''}>
              <summary>${summaryInner}</summary>
              <div class="trace-body">
                ${renderTraceEntriesHtml(it)}
              </div>
            </details>
          `;
        }

        if (it.kind === 'assistant') {
          if (it.isProgress) {
            return `<div class="msg-progress">${renderInlineMd(it.text)}</div>`;
          }
          const showFoot = Boolean(it.showFooter);
          const turnAgo = showFoot ? relTimeAgo(it.createdAt) : '';
          const footHtml = showFoot
            ? `<div class="msg-foot">
                <button type="button" class="msg-copy-ico" data-copy-msg="${esc(it.id)}" title="${esc(t.copyBtn)}">${ICONS.copy}</button>
                ${turnAgo ? `<span class="msg-foot-time">${esc(turnAgo)}</span>` : ''}
              </div>`
            : '';
          return `
            <div class="assistant-wrap">
              <div class="msg-assistant">${renderMarkdown(it.text)}</div>
              ${footHtml}
            </div>
          `;
        }

        if (it.kind === 'error') {
          return `<div class="msg-err">${esc(it.text)}</div>`;
        }
        return '';
      })
      .join('');

    bindStreamInteractiveElements(elChatStream);

    const briefBtn = document.getElementById('btn-toggle-brief');
    if (briefBtn) {
      briefBtn.addEventListener('click', () => {
        briefExpanded = !briefExpanded;
        const bodyEl = document.getElementById('brief-body');
        if (bodyEl) bodyEl.classList.toggle('clamped', !briefExpanded);
        briefBtn.textContent = briefExpanded ? L().briefCollapse : L().briefExpand;
      });
    }

    elChatStream.querySelectorAll('.user-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const uid = btn.dataset.uid;
        const box = elChatStream.querySelector(`.msg-user[data-uid="${CSS.escape(uid)}"]`);
        if (expandedUserMsgIds.has(uid)) {
          expandedUserMsgIds.delete(uid);
          if (box) box.classList.add('clamped');
          btn.textContent = L().userExpand(btn.dataset.lines);
        } else {
          expandedUserMsgIds.add(uid);
          if (box) box.classList.remove('clamped');
          btn.textContent = L().userCollapse;
        }
      });
    });

    elChatStream.querySelectorAll('details.trace-box').forEach((det) => {
      det.addEventListener('toggle', () => {
        const id = det.dataset.traceId;
        if (!id) return;
        if (det.dataset.liveTail === '1') {
          if (det.open) closedLiveTraceIds.delete(id);
          else closedLiveTraceIds.add(id);
        } else {
          if (det.open) openTraceIds.add(id);
          else openTraceIds.delete(id);
        }
      });
    });

    elChatStream.querySelectorAll('details[data-det-id]').forEach((det) => {
      det.addEventListener('toggle', () => {
        const id = det.dataset.detId;
        if (!id) return;
        if (det.open) openSubDetailIds.add(id);
        else openSubDetailIds.delete(id);
      });
    });

    if (wasNearBottom) {
      elChatStream.scrollTop = elChatStream.scrollHeight;
    } else {
      elChatStream.scrollTop = prevScrollTop;
    }
  }

  function autoResizeInput() {
    elChatInput.style.height = 'auto';
    elChatInput.style.height = `${Math.min(elChatInput.scrollHeight, 132)}px`;
    syncSendButtonState();
  }

  async function openThreadDrawer(threadId) {
    if (!threadId) return;
    closeModelMenu({ restoreHeader: false });
    settingsScreenOpen = false;
    if (elSettingsScreen) elSettingsScreen.hidden = true;
    boardScrollTop = elBoardBody.scrollTop;
    openThreadId = threadId;
    lastThreadStamp = '';
    lastRenderedItems = null;
    openTraceIds.clear();
    closedLiveTraceIds.clear();
    openSubDetailIds.clear();
    briefExpanded = false;

    const preview = cachedThreads.find((x) => x.threadId === threadId);
    const wasWaiting = preview && preview.bucket === 'waiting';
    if (wasWaiting) {
      optimisticallyMarkThreadIdle(threadId);
    }
    if (preview) renderThreadHeader(preview);

    if (lastSnap && Array.isArray(lastSnap.threads)) {
      const otherRunning = lastSnap.threads.filter(
        (x) => !x.archived && x.bucket === 'working' && x.threadId !== threadId,
      ).length;
      document.getElementById('other-running-badge').textContent =
        otherRunning > 0 ? `${otherRunning}` : '';
    }

    elBoardScreen.hidden = true;
    elThreadScreen.classList.remove('screen-slide');
    elThreadScreen.hidden = false;
    void elThreadScreen.offsetWidth;
    elThreadScreen.classList.add('screen-slide');

    elChatStream.innerHTML = renderSkeletonLoader();
    if (wasWaiting) {
      postApi('/api/thread_mark_read', '/api/thread_mark_read_get', { threadId }).catch(() => {});
    }
    await refreshOpenThread(true, true);
    autoResizeInput();
    elChatInput.focus();
  }

  function closeThreadDrawer() {
    closeModelMenu({ restoreHeader: false });
    openThreadId = '';
    openThreadObj = null;
    lastThreadStamp = '';
    lastRenderedItems = null;
    openTraceIds.clear();
    closedLiveTraceIds.clear();
    openSubDetailIds.clear();
    lastBoardKey = '';
    elThreadScreen.hidden = true;
    elBoardScreen.hidden = false;
    elBoardBody.scrollTop = boardScrollTop;
    refreshBoard(true);
  }

  async function refreshOpenThread(forceBottom = false, markRead = false) {
    if (!openThreadId || (isPanelHidden() && !forceBottom)) return;
    try {
      const qs = new URLSearchParams({
        threadId: openThreadId,
        stamp: forceBottom ? '' : lastThreadStamp,
        markRead: markRead ? '1' : '0',
      });
      const url = `/api/thread_messages?${qs}`;
      const res = await fetchWithTimeout(url, { method: 'GET' }, API_READ_TIMEOUT_MS);
      const data = await safeReadJson(res, { url });
      if (data.locale) applyLocale(data.locale);
      if (!data.ok) {
        elChatStream.innerHTML = `<div class="msg-err">${esc(data.error || 'Error')}</div>`;
        return;
      }
      if (data.thread) renderThreadHeader(data.thread);
      if (!data.unchanged && Array.isArray(data.items)) {
        lastThreadStamp = data.stamp || '';
        renderThreadItems(data.items, forceBottom);
      } else if (
        data.unchanged &&
        Array.isArray(lastRenderedItems) &&
        openThreadObj &&
        !openThreadObj.archived &&
        openThreadObj.runState === 'RUN_STATE_RUNNING'
      ) {
        // Keep live tail elapsed seconds ticking smoothly even between transcript writes
        const liveDurEl = elChatStream.querySelector('details.trace-box[data-live-tail="1"] > summary > .trace-dur');
        const tailItem = lastRenderedItems[lastRenderedItems.length - 1];
        if (liveDurEl && tailItem?.kind === 'trace' && tailItem.startedAt) {
          const elapsed = Math.round((Date.now() - Date.parse(tailItem.startedAt)) / 1000);
          if (Number.isFinite(elapsed) && elapsed > 0) {
            liveDurEl.textContent = fmtWorkedDuration(Math.min(86400, elapsed));
          }
        }
      }
    } catch {
      // Ignore transient poll errors
    }
  }

  async function sendChatFollowUp() {
    if (!openThreadId) return;
    const text = elChatInput.value.trim();
    if (!text) return;
    const t = L();
    const targetThreadId = openThreadId;
    const chosenModel = pendingModelByThread.get(targetThreadId) || null;
    closeModelMenu();

    elSendBtn.disabled = true;
    elChatInput.value = '';
    autoResizeInput();

    const tempWrap = document.createElement('div');
    tempWrap.className = 'user-wrap';
    tempWrap.innerHTML = `<div class="msg-user">${esc(text)}</div><div class="msg-pending">${esc(t.sending)}</div>`;
    elChatStream.appendChild(tempWrap);
    elChatStream.scrollTop = elChatStream.scrollHeight;
    elLiveBar.hidden = true;

    try {
      const sendPayload = {
        threadId: targetThreadId,
        message: text,
      };
      if (chosenModel) {
        sendPayload.model = chosenModel.id || chosenModel.modelId || chosenModel.modelEnum || '';
        sendPayload.modelEnum = chosenModel.modelEnum || '';
        if (chosenModel.modelOrAlias) sendPayload.modelOrAlias = chosenModel.modelOrAlias;
        sendPayload.modelDisplayName = chosenModel.label || '';
      }
      const res = await postApi('/api/thread_send', '/api/thread_send_get', sendPayload);
      if (!res.ok) {
        tempWrap.innerHTML = `<div class="msg-user">${esc(text)}</div><div class="err">${esc(res.error || 'Error')}</div>`;
      } else {
        if (chosenModel) {
          pendingModelByThread.delete(targetThreadId);
        }
        if (res.thread && openThreadId === targetThreadId) {
          renderThreadHeader(res.thread);
        }
        lastThreadStamp = '';
        await refreshOpenThread(true, false);
      }
    } catch (e) {
      tempWrap.innerHTML = `<div class="msg-user">${esc(text)}</div><div class="err">${esc(e.message)}</div>`;
    } finally {
      elSendBtn.disabled = false;
      autoResizeInput();
      elChatInput.focus();
    }
  }

  async function loadMemory() {
    try {
      await syncHostConversationScope();
      const qs = new URLSearchParams(buildScopePayload());
      const url = `/api/memory?${qs}`;
      const res = await fetchWithTimeout(url, { method: 'GET' }, API_READ_TIMEOUT_MS);
      const data = await safeReadJson(res, { url });
      if (data.locale) applyLocale(data.locale);
      if (data.ok) {
        const shortPath = (data.path || '').split(/[\\/]/).slice(-3).join('/');
        const pathEl = document.getElementById('mem-path');
        pathEl.textContent = shortPath;
        pathEl.title = data.path || '';
        document.getElementById('mem-editor').value = data.content || '';
      }
    } catch {
      // Ignore transient errors
    }
  }

  async function refreshBoard(force = false) {
    if (isPanelHidden() && !force) return;
    try {
      const convChanged = await syncHostConversationScope();
      const qs = new URLSearchParams(
        buildScopePayload({
          includeArchived: '1',
          allWorkspaces: '0',
        }),
      );
      const url = `/api/state?${qs}`;
      const res = await fetchWithTimeout(url, { method: 'GET' }, API_READ_TIMEOUT_MS);
      const data = await safeReadJson(res, { url });
      if (data.locale) applyLocale(data.locale);
      inspectServerInfo(data, { fromState: true });
      if (data.error) {
        setLiveStatus(false);
        return;
      }
      setLiveStatus(true);

      if (data.projectId && data.projectId !== 'outside-of-project' && !hostProjectId) {
        hostProjectId = String(data.projectId).trim();
      }

      const nextScopeKey = String(data.scopeKey || '');
      const scopeChanged = activeScopeKey !== null && nextScopeKey !== activeScopeKey;
      activeScopeKey = nextScopeKey;

      const nextCoordTurnStamp = String(
        data.coordinatorTurnStamp ||
          (data.coordinator?.conversationId
            ? `${data.coordinator.conversationId}|${Number(data.coordinator.lastStepCount) || 0}`
            : ''),
      );
      const coordTurnChanged = Boolean(
        nextCoordTurnStamp &&
          lastCoordinatorTurnStamp &&
          nextCoordTurnStamp !== lastCoordinatorTurnStamp,
      );
      if (nextCoordTurnStamp) {
        lastCoordinatorTurnStamp = nextCoordTurnStamp;
      } else if (scopeChanged || convChanged) {
        lastCoordinatorTurnStamp = '';
      }

      if (scopeChanged || convChanged) {
        lastBoardKey = '';
        lastHasGitRepo = null;
        manualPopoutConvId = '';
        threadOpenState.clear();
        if (currentTab === 'library') {
          loadMemory();
        }
      }
      if (
        scopeChanged ||
        convChanged ||
        coordTurnChanged ||
        !loadedSettingsData ||
        nextScopeKey !== String(loadedSettingsData.scopeKey || '')
      ) {
        loadSettingsData({
          syncInputs: settingsScreenOpen && !settingsDirtyByUser && !isSettingsDraftDirty(),
        });
      }

      // Immediately close any open thread drawer that does not belong to the active project scope
      if (
        openThreadId &&
        !(data.threads || []).some((x) => x.threadId === openThreadId)
      ) {
        closeModelMenu({ restoreHeader: false });
        openThreadId = '';
        openThreadObj = null;
        lastThreadStamp = '';
        lastRenderedItems = null;
        openTraceIds.clear();
        closedLiveTraceIds.clear();
        openSubDetailIds.clear();
        elThreadScreen.hidden = true;
        elBoardScreen.hidden = false;
      }

      const timeBucket = Math.floor(Date.now() / 30000);
      const key = JSON.stringify({
        locale: curLocale,
        scopeKey: nextScopeKey,
        manualPopoutConvId,
        hasGitRepo: Boolean(data.hasGitRepo),
        projectName: data.projectName || '',
        workspaceName: data.workspaceName || '',
        workspacePath: data.workspacePath || '',
        scopeTitle: data.scopeTitle || '',
        projectLabel: data.projectLabel || '',
        sortMode,
        decisionsPanelCollapsed,
        timeBucket,
        coordinator: data.coordinator,
        threads: data.threads,
        decisions: data.decisions || [],
      });
      if (!force && !scopeChanged && !convChanged && key === lastBoardKey) return;
      lastBoardKey = key;
      renderBoard(data);
    } catch {
      setLiveStatus(false);
    }
  }

  function setDrawerOpen(open) {
    elDrawer.classList.toggle('open', open);
    elNewBtn.classList.toggle('active', open);
    document.getElementById('dispatch-msg').textContent = '';
    if (open) {
      if (currentTab !== 'threads') {
        document.getElementById('tab-threads').click();
      }
      loadSelectableModels(false);
      loadSettingsData();
      document.getElementById('f-title').focus();
    }
  }

  // ---------- UI Event Bindings ----------
  document.querySelectorAll('.nav-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      tabBtn.classList.add('active');
      tabBtn.setAttribute('aria-selected', 'true');
      currentTab = tabBtn.dataset.tab;
      document.getElementById('threads-pane').hidden = currentTab !== 'threads';
      document.getElementById('library-pane').hidden = currentTab !== 'library';
      document.getElementById('archived-pane').hidden = currentTab !== 'archived';
      if (currentTab !== 'threads' && elDrawer.classList.contains('open')) {
        elDrawer.classList.remove('open');
        elNewBtn.classList.remove('active');
      }
      if (currentTab === 'library') {
        loadMemory();
        refreshBoard(true);
      } else {
        refreshBoard(true);
      }
    });
  });

  // 3 Quick "Back to Coordinator" Entry Points (#22)
  elBtnOpenCoord.addEventListener('click', jumpToCoordinator);
  elBtnCardCoord.addEventListener('click', (e) => {
    e.stopPropagation();
    jumpToCoordinator();
  });
  elGoalCard.addEventListener('click', (e) => {
    if (e.target.closest('#btn-sort') || e.target.closest('#btn-card-coord')) return;
    if (lastSnap?.coordinator?.conversationId) {
      jumpToCoordinator();
    }
  });
  elBtnChatCoord.addEventListener('click', jumpToCoordinator);

  document.getElementById('btn-sort').addEventListener('click', (e) => {
    e.stopPropagation();
    sortMode = sortMode === 'priority' ? 'recent' : 'priority';
    if (lastSnap) renderBoard(lastSnap);
  });

  document.getElementById('btn-back').addEventListener('click', closeThreadDrawer);

  document.getElementById('btn-sync-coord').addEventListener('click', async (ev) => {
    if (!openThreadObj) return;
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = L().syncing;
    try {
      const res = await postApi('/api/thread_sync_coord', '/api/thread_sync_coord_get', {
        threadId: openThreadObj.threadId,
      });
      btn.textContent = res.ok && res.synced ? L().syncedOk : L().syncNone;
    } catch {
      btn.textContent = L().syncErr;
    }
    setTimeout(() => {
      btn.textContent = L().syncCoord;
      btn.disabled = false;
    }, 1600);
  });

  document.getElementById('btn-popout-cur').addEventListener('click', () => {
    if (openThreadObj?.conversationId) popoutToMainCanvas(openThreadObj.conversationId);
  });

  document.getElementById('btn-archive-cur').addEventListener('click', () => {
    if (!openThreadObj) return;
    requestArchiveThread(openThreadObj, {
      triggerBtn: document.getElementById('btn-archive-cur'),
      onArchived: () => {
        closeThreadDrawer();
      },
    });
  });

  document.getElementById('btn-clean-wt-cur').addEventListener('click', () => {
    if (!openThreadObj || !openThreadObj.worktreePath) return;
    requestCleanWorktree(openThreadObj, {
      triggerBtn: document.getElementById('btn-clean-wt-cur'),
      onCleaned: async () => {
        if (openThreadId) {
          lastThreadStamp = '';
          await refreshOpenThread(false, false);
        }
      },
    });
  });

  elModalForceWt.addEventListener('change', () => {
    if (elModalForceWt.checked && !elModalRemoveWt.checked) {
      elModalRemoveWt.checked = true;
    }
    syncModalConfirmButton();
  });

  elModalRemoveWt.addEventListener('change', () => {
    if (!elModalRemoveWt.checked && elModalForceWt.checked) {
      elModalForceWt.checked = false;
    }
    syncModalConfirmButton();
  });

  document.getElementById('composer-meta').addEventListener('click', (e) => {
    const modelBtn = e.target.closest('#btn-comp-model');
    if (modelBtn && !modelBtn.disabled) {
      e.stopPropagation();
      toggleModelMenu();
      return;
    }
    const wtBtn = e.target.closest('#btn-comp-wt');
    if (wtBtn && openThreadObj?.worktreePath) {
      copyText(openThreadObj.worktreePath, L().copiedPath);
    }
  });

  function stepBackModelMenuToLevel1() {
    const prevFamKey = modelMenuFamilyKey || modelMenuHoverFamilyKey;
    if (modelMenuHoverFamilyKey && !modelMenuFamilyKey) {
      closeModelSubmenu();
    } else {
      modelMenuFamilyKey = '';
      modelMenuHoverFamilyKey = '';
      renderModelMenu();
    }
    if (!elModelMenu) return;
    const match = prevFamKey
      ? [...elModelMenu.querySelectorAll('.pt-model-opt[data-family-key]')].find(
          (el) => el.dataset.familyKey === prevFamKey,
        )
      : null;
    (match || elModelMenu.querySelector('.pt-model-opt'))?.focus();
  }

  function enterModelFamilyLevel2(famKey, anchorRow = null, { focusSubmenu = false } = {}) {
    if (!famKey) return;
    if (!modelMenuFamilyKey && canUseModelMenuFlyout()) {
      const openedFlyout = openModelSubmenu(famKey, anchorRow, { focusFirst: focusSubmenu });
      if (openedFlyout) return;
    }
    closeModelSubmenu();
    modelMenuFamilyKey = famKey;
    renderModelMenu();
    const target =
      elModelMenu?.querySelector('.pt-model-opt.active') ||
      elModelMenu?.querySelector('.pt-model-opt');
    if (target) {
      target.focus();
      target.scrollIntoView({ block: 'nearest' });
    }
  }

  if (elModelMenu) {
    elModelMenu.addEventListener('pointerover', (e) => {
      if (!modelMenuOpen || modelMenuFamilyKey || !canUseModelMenuFlyout()) return;
      if (e.pointerType === 'touch') return;
      if (e.target.closest('.pt-model-submenu')) {
        clearModelSubmenuTimers();
        return;
      }
      const famOpt = e.target.closest('.pt-model-menu-card .pt-model-opt[data-family-key]');
      if (famOpt) {
        const famKey = famOpt.dataset.familyKey || '';
        if (!famKey) return;
        if (modelMenuCloseTimer) {
          clearTimeout(modelMenuCloseTimer);
          modelMenuCloseTimer = null;
        }
        if (modelMenuHoverFamilyKey === famKey) {
          if (modelMenuSwitchTimer) {
            clearTimeout(modelMenuSwitchTimer);
            modelMenuSwitchTimer = null;
          }
          return;
        }
        if (!modelMenuHoverFamilyKey) {
          openModelSubmenu(famKey, famOpt);
        } else {
          if (modelMenuSwitchTimer) clearTimeout(modelMenuSwitchTimer);
          modelMenuSwitchTimer = setTimeout(() => {
            modelMenuSwitchTimer = null;
            if (modelMenuOpen && !modelMenuFamilyKey) {
              openModelSubmenu(famKey, famOpt);
            }
          }, 95);
        }
        return;
      }
      const singleOpt = e.target.closest('.pt-model-menu-card .pt-model-opt[data-model-key]');
      if (singleOpt && modelMenuHoverFamilyKey) {
        scheduleCloseModelSubmenu(140);
      }
    });

    elModelMenu.addEventListener('mouseleave', () => {
      if (!modelMenuOpen || modelMenuFamilyKey || !modelMenuHoverFamilyKey) return;
      scheduleCloseModelSubmenu(180);
    });

    elModelMenu.addEventListener('click', (e) => {
      const backBtn = e.target.closest('.pt-model-back');
      if (backBtn) {
        e.stopPropagation();
        stepBackModelMenuToLevel1();
        return;
      }
      const opt = e.target.closest('.pt-model-opt');
      if (!opt) return;
      e.stopPropagation();
      const famKey = opt.dataset.familyKey || '';
      if (famKey) {
        enterModelFamilyLevel2(famKey, opt, { focusSubmenu: false });
        return;
      }
      const chosen = getModelByIdFromCatalog(opt.dataset.modelKey || '');
      if (chosen) selectThreadModel(chosen);
    });

    elModelMenu.addEventListener('keydown', (e) => {
      if (!modelMenuOpen) return;
      const inSubmenu = Boolean(document.activeElement?.closest?.('.pt-model-submenu'));
      if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && (modelMenuFamilyKey || inSubmenu || modelMenuHoverFamilyKey)) {
        e.preventDefault();
        e.stopPropagation();
        stepBackModelMenuToLevel1();
        return;
      }
      const scope = inSubmenu
        ? elModelMenu.querySelector('.pt-model-submenu')
        : elModelMenu.querySelector('.pt-model-menu-card') || elModelMenu;
      const opts = [...scope.querySelectorAll('.pt-model-opt')];
      if (!opts.length) return;
      const idx = opts.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        opts[(idx + 1) % opts.length].focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        opts[(idx - 1 + opts.length) % opts.length].focus();
      } else if (e.key === 'ArrowRight' && idx >= 0 && opts[idx].dataset.familyKey) {
        e.preventDefault();
        enterModelFamilyLevel2(opts[idx].dataset.familyKey, opts[idx], { focusSubmenu: true });
      } else if (e.key === 'Enter' && idx >= 0) {
        e.preventDefault();
        if (opts[idx].dataset.familyKey) {
          enterModelFamilyLevel2(opts[idx].dataset.familyKey, opts[idx], { focusSubmenu: true });
        } else {
          opts[idx].click();
        }
      }
    });
  }

  window.addEventListener('resize', () => {
    if (modelMenuOpen && modelMenuHoverFamilyKey && !modelMenuFamilyKey) {
      repositionModelSubmenu();
    }
  });

  document.addEventListener('click', (e) => {
    if (!modelMenuOpen) return;
    if (e.target.closest('#pt-model-menu') || e.target.closest('#btn-comp-model')) return;
    closeModelMenu();
  });

  elModalCancel.addEventListener('click', () => closePtModal());
  elModalClose.addEventListener('click', () => closePtModal());
  elModalBackdrop.addEventListener('click', (e) => {
    if (e.target === elModalBackdrop) closePtModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (modelMenuOpen) {
        e.preventDefault();
        e.stopPropagation();
        if (modelMenuFamilyKey || modelMenuHoverFamilyKey) {
          stepBackModelMenuToLevel1();
        } else {
          closeModelMenu();
          document.getElementById('btn-comp-model')?.focus();
        }
        return;
      }
      if (activeModalCtx && !activeModalCtx.busy) {
        closePtModal();
        return;
      }
      if (settingsScreenOpen) {
        closeSettingsScreen();
      }
    }
  });

  elModalConfirm.addEventListener('click', async () => {
    if (!activeModalCtx || activeModalCtx.busy) return;
    const ctx = activeModalCtx;
    const th = ctx.thread;
    ctx.busy = true;
    elModalErr.hidden = true;
    elModalErr.textContent = '';
    elModalConfirm.disabled = true;
    elModalCancel.disabled = true;
    elModalClose.disabled = true;
    elModalRemoveWt.disabled = true;
    elModalDelBranch.disabled = true;
    elModalForceWt.disabled = true;
    syncModalConfirmButton();

    try {
      if (ctx.mode === 'plugin_update') {
        pluginUpdateApplying = true;
        clearUpdateCardNotice();
        renderUpdateCard();
        const res = await postApi(
          '/api/update_apply',
          '/api/update_apply_get',
          {
            channel: ctx.channel || '',
            persistChannel: true,
          },
          { timeoutMs: API_UPDATE_TIMEOUT_MS },
        );
        pluginUpdateApplying = false;
        if (!res?.ok) {
          ctx.busy = false;
          const errMsg = res?.error || L().updateToastApplyErr;
          elModalErr.hidden = false;
          elModalErr.textContent = errMsg;
          elModalConfirm.disabled = false;
          elModalCancel.disabled = false;
          elModalClose.disabled = false;
          syncModalConfirmButton();
          if (res?.errorCode === 'dirty_worktree' && pluginUpdateState) {
            pluginUpdateState = {
              ...pluginUpdateState,
              isDirty: true,
              dirtyCount: res.dirtyCount || pluginUpdateState.dirtyCount || 1,
              dirtyFiles: res.dirtyFiles || pluginUpdateState.dirtyFiles || [],
            };
          }
          setUpdateCardNotice(errMsg, 'err');
          renderUpdateCard();
          return;
        }
        closePtModal(true);
        if (res.status) {
          pluginUpdateState = res.status;
        }
        pluginUpdateAppliedVersion =
          res.currentVersion || res.status?.currentVersion || pluginUpdateState?.currentVersion || '';
        syncSettingsUpdateDot();
        setUpdateCardNotice(L().updateToastApplied, 'ok', 4800);
        renderUpdateCard();
        return;
      }
      if (ctx.mode === 'archive') {
        const removeWorktree = elModalRemoveWt.checked;
        const forceWorktree = removeWorktree && elModalForceWt.checked;
        const res = await postApi('/api/archive', '/api/archive_get', {
          threadId: th.threadId,
          removeWorktree,
          forceWorktree,
          deleteBranch: true,
        });
        closePtModal(true);
        lastBoardKey = '';
        if (res?.ok && typeof ctx.onDone === 'function') await ctx.onDone(res);
        await refreshBoard(true);
        showArchiveResultToast(res);
      } else {
        const forceWorktree = elModalForceWt.checked;
        const deleteBranch = elModalDelBranch.checked;
        const res = await postApi('/api/cleanup_worktree', '/api/cleanup_worktree_get', {
          threadId: th.threadId,
          forceWorktree,
          deleteBranch,
        });
        closePtModal(true);
        lastBoardKey = '';
        if (typeof ctx.onDone === 'function') await ctx.onDone(res);
        await refreshBoard(true);
        showCleanupResultToast(res);
      }
    } catch (err) {
      ctx.busy = false;
      if (ctx.mode === 'plugin_update') {
        pluginUpdateApplying = false;
        if (err?.isBackendMismatch) {
          backendVersionMismatch = {
            kind: 'stale_backend',
            startedVersion: '',
            diskVersion: '',
            reason: err.code || 'route_not_found',
          };
        }
        setUpdateCardNotice(err?.message || L().updateToastApplyErr, 'err');
        renderUpdateCard();
      }
      elModalErr.hidden = false;
      elModalErr.textContent = err?.message || 'Request failed';
      elModalConfirm.disabled = false;
      elModalCancel.disabled = false;
      elModalClose.disabled = false;
      elModalRemoveWt.disabled = false;
      elModalDelBranch.disabled = false;
      elModalForceWt.disabled = false;
      syncModalConfirmButton();
    }
  });

  // Composer auto-grow & IME-safe Enter submission
  elChatInput.addEventListener('input', autoResizeInput);
  elChatInput.addEventListener('compositionstart', () => {
    isImeComposing = true;
  });
  elChatInput.addEventListener('compositionend', () => {
    isImeComposing = false;
  });
  elSendBtn.addEventListener('click', sendChatFollowUp);
  elChatInput.addEventListener('keydown', (e) => {
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !isImeComposing &&
      !e.isComposing &&
      e.keyCode !== 229
    ) {
      e.preventDefault();
      sendChatFollowUp();
    }
  });

  // Dispatch drawer controls
  elNewBtn.addEventListener('click', () => {
    setDrawerOpen(!elDrawer.classList.contains('open'));
  });
  document.getElementById('f-wt').addEventListener('change', () => {
    populateDispatchModelSelect();
  });
  if (elFModel) {
    elFModel.addEventListener('change', () => {
      const grp = dispatchModelGroups.find((g) => g.key === elFModel.value) || null;
      populateSettingsTierSelect(elFTier, grp, grp?.defaultValue ?? '');
    });
  }
  document.getElementById('btn-close-drawer').addEventListener('click', () => {
    setDrawerOpen(false);
  });
  document.getElementById('btn-cancel-dispatch').addEventListener('click', () => {
    setDrawerOpen(false);
  });

  // Settings slide-over controls
  if (elBtnSettings) {
    elBtnSettings.addEventListener('click', openSettingsScreen);
  }
  if (elBtnSettingsBack) {
    elBtnSettingsBack.addEventListener('click', closeSettingsScreen);
  }
  if (elBtnScopeGlobal) {
    elBtnScopeGlobal.addEventListener('click', () => {
      if (settingsScope === 'global') return;
      settingsScope = 'global';
      settingsDirtyByUser = false;
      renderSettingsScreen(true);
    });
  }
  if (elBtnScopeProject) {
    elBtnScopeProject.addEventListener('click', () => {
      const scopeKey =
        loadedSettingsData?.scopeKey || loadedSettingsData?.effective?.scopeKey || activeScopeKey || '';
      if (!scopeKey || settingsScope === 'project') return;
      settingsScope = 'project';
      settingsDirtyByUser = false;
      renderSettingsScreen(true);
    });
  }
  if (elSetWorktree) {
    elSetWorktree.addEventListener('change', () => {
      settingsDirtyByUser = true;
      const grp = settingsWorktreeGroups.find((g) => g.key === elSetWorktree.value) || null;
      populateSettingsTierSelect(elSetWorktreeTier, grp, grp?.defaultValue ?? '');
      syncSettingsActionState();
    });
  }
  if (elSetWorktreeTier) {
    elSetWorktreeTier.addEventListener('change', () => {
      settingsDirtyByUser = true;
      syncSettingsActionState();
    });
  }
  if (elSetReadOnly) {
    elSetReadOnly.addEventListener('change', () => {
      settingsDirtyByUser = true;
      const grp = settingsReadOnlyGroups.find((g) => g.key === elSetReadOnly.value) || null;
      populateSettingsTierSelect(elSetReadOnlyTier, grp, grp?.defaultValue ?? '');
      syncSettingsActionState();
    });
  }
  if (elSetReadOnlyTier) {
    elSetReadOnlyTier.addEventListener('change', () => {
      settingsDirtyByUser = true;
      syncSettingsActionState();
    });
  }
  if (elBtnSettingsRefreshModels) {
    elBtnSettingsRefreshModels.addEventListener('click', async () => {
      if (settingsRefreshing) return;
      settingsRefreshing = true;
      elBtnSettingsRefreshModels.disabled = true;
      elBtnSettingsRefreshModels.classList.add('spinning');
      try {
        const shouldSync = !settingsDirtyByUser && !isSettingsDraftDirty();
        await Promise.allSettled([
          loadSelectableModels(true),
          loadSettingsData({ syncInputs: shouldSync, forceRefresh: true }),
        ]);
      } finally {
        settingsRefreshing = false;
        elBtnSettingsRefreshModels.disabled = false;
        elBtnSettingsRefreshModels.classList.remove('spinning');
      }
    });
  }
  if (elBtnSettingsSave) {
    elBtnSettingsSave.addEventListener('click', () => {
      submitSettingsSave(false);
    });
  }
  if (elBtnSettingsReset) {
    elBtnSettingsReset.addEventListener('click', () => {
      submitSettingsSave(true);
    });
  }

  document.getElementById('btn-bind').addEventListener('click', async () => {
    await syncHostConversationScope();
    const res = await postApi('/api/init', '/api/init_get', buildScopePayload());
    if (res.ok) {
      manualPopoutConvId = '';
      flashToast(L().boundToast);
      lastBoardKey = '';
      refreshBoard(true);
    }
  });

  document.getElementById('btn-submit-dispatch').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const title = document.getElementById('f-title').value.trim();
    const taskPrompt = document.getElementById('f-prompt').value.trim();
    const branch = document.getElementById('f-branch').value.trim();
    const model = readDispatchModelValue();
    const wtChk = document.getElementById('f-wt');
    const createWorktree = !wtChk.disabled && wtChk.checked;
    const errEl = document.getElementById('dispatch-msg');
    errEl.textContent = '';

    if (!title || !taskPrompt) {
      errEl.textContent = L().fErrReq;
      return;
    }
    btn.disabled = true;
    btn.textContent = L().fCreating;
    try {
      await syncHostConversationScope();
      const res = await postApi(
        '/api/dispatch',
        '/api/dispatch_get',
        buildScopePayload({
          title,
          taskPrompt,
          branch,
          model,
          createWorktree,
        }),
      );
      if (!res.ok) {
        errEl.textContent = res.error || 'Error';
      } else {
        document.getElementById('f-title').value = '';
        document.getElementById('f-branch').value = '';
        document.getElementById('f-prompt').value = '';
        resetDispatchModelSelect();
        setDrawerOpen(false);
        lastBoardKey = '';
        await refreshBoard(true);
        openThreadPrimary(res.thread.threadId);
      }
    } catch (e) {
      errEl.textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = L().fSubmit;
    }
  });

  document.getElementById('btn-save-mem').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const content = document.getElementById('mem-editor').value;
    btn.disabled = true;
    btn.textContent = L().libSaving;
    try {
      await syncHostConversationScope();
      const res = await postApi(
        '/api/memory_save',
        '/api/memory_save_get',
        buildScopePayload({
          content,
          mode: 'replace',
        }),
      );
      if (res.ok) flashToast(L().libSaved);
    } finally {
      btn.disabled = false;
      btn.textContent = L().libSave;
    }
  });
  document.getElementById('btn-reload-mem').addEventListener('click', loadMemory);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (openThreadId) refreshOpenThread(false, false);
      if (settingsScreenOpen) {
        loadSettingsData({
          syncInputs: !settingsDirtyByUser && !isSettingsDraftDirty(),
        });
      }
      refreshBoard(false);
    }
  });

  // ---------- Plugin Version & Update Checker ----------
  function renderUpdateStatusNotice() {
    if (!elUpdateStatusMsg) return;
    const text = String(updateStatusNotice?.text || '');
    const tone = updateStatusNotice?.tone || 'ok';
    elUpdateStatusMsg.className =
      tone === 'err'
        ? 'toast update-toast err'
        : tone === 'warn'
          ? 'toast update-toast warn'
          : 'toast update-toast';
    elUpdateStatusMsg.textContent = text;
    elUpdateStatusMsg.title = text;
  }

  function clearUpdateCardNotice() {
    if (updateStatusTimer) {
      clearTimeout(updateStatusTimer);
      updateStatusTimer = null;
    }
    updateCardError = '';
    updateStatusNotice = { text: '', tone: 'ok' };
    renderUpdateStatusNotice();
  }

  function setUpdateCardNotice(msg, tone = 'ok', durationMs = 3600) {
    if (updateStatusTimer) {
      clearTimeout(updateStatusTimer);
      updateStatusTimer = null;
    }
    const text = String(msg || '').trim();
    if (tone === 'err') {
      updateCardError = text;
      updateStatusNotice = { text: '', tone: 'ok' };
      renderUpdateStatusNotice();
      if (elUpdateErr) {
        elUpdateErr.hidden = !text;
        elUpdateErr.textContent = text;
      }
      return;
    }
    updateCardError = '';
    updateStatusNotice = { text, tone };
    renderUpdateStatusNotice();
    if (text && durationMs > 0) {
      updateStatusTimer = setTimeout(() => {
        updateStatusTimer = null;
        updateStatusNotice = { text: '', tone: 'ok' };
        renderUpdateStatusNotice();
      }, durationMs);
    }
  }

  function syncSettingsUpdateDot() {
    if (!elBtnSettings) return;
    const t = L();
    const hasUpdate = Boolean(pluginUpdateState?.hasUpdate);
    if (elSettingsUpdateDot) {
      elSettingsUpdateDot.hidden = !hasUpdate;
    }
    const tip = hasUpdate
      ? t.settingsTipWithUpdate(pluginUpdateState?.targetVersion || '')
      : t.settingsTip;
    elBtnSettings.title = tip;
    elBtnSettings.setAttribute('aria-label', tip);
  }

  function renderUpdateCard() {
    if (!elUpdateCard) return;
    const t = L();
    const st = pluginUpdateState;
    const mismatch = backendVersionMismatch;
    const staleWithoutStatus = Boolean(mismatch && !st);
    const activeChannel = st ? (st.channel === 'dev' ? 'dev' : 'stable') : '';
    const isGit = st ? Boolean(st.isGitInstall) : true;
    const isDirty = Boolean(isGit && st?.isDirty);
    const hasChecked = Boolean(st?.checkedAt);
    const busy = pluginUpdateChecking || pluginUpdateApplying;

    const lblHdr = document.getElementById('lbl-update-hdr');
    if (lblHdr) lblHdr.textContent = t.updateHdr;
    const lblChan = document.getElementById('lbl-update-channel');
    if (lblChan) lblChan.textContent = t.updateChannelLabel;
    if (elBtnChannelStable && elBtnChannelDev) {
      elBtnChannelStable.textContent = t.updateChannelStable;
      elBtnChannelDev.textContent = t.updateChannelDev;
      const stableActive = !staleWithoutStatus && (activeChannel === 'stable' || (!activeChannel && !mismatch));
      const devActive = !staleWithoutStatus && activeChannel === 'dev';
      elBtnChannelStable.classList.toggle('active', stableActive);
      elBtnChannelDev.classList.toggle('active', devActive);
      elBtnChannelStable.setAttribute('aria-selected', stableActive ? 'true' : 'false');
      elBtnChannelDev.setAttribute('aria-selected', devActive ? 'true' : 'false');
      elBtnChannelStable.disabled = busy || staleWithoutStatus;
      elBtnChannelDev.disabled = busy || staleWithoutStatus;
    }
    const descChan = document.getElementById('desc-update-channel');
    if (descChan) {
      if (staleWithoutStatus) {
        descChan.textContent = t.updateChannelMismatchHint;
      } else {
        descChan.textContent =
          activeChannel === 'dev' ? t.updateChannelHintDev : t.updateChannelHintStable;
      }
    }

    if (elUpdateBadge) {
      elUpdateBadge.hidden = false;
      if (pluginUpdateChecking || st?.checking) {
        elUpdateBadge.className = 'update-badge';
        elUpdateBadge.textContent = t.updateBadgeChecking;
      } else if (mismatch) {
        elUpdateBadge.className = 'update-badge warn';
        elUpdateBadge.textContent = t.updateBadgeReloadRequired;
      } else if (isDirty) {
        elUpdateBadge.className = 'update-badge warn';
        elUpdateBadge.textContent = t.updateBadgeDirty;
      } else if (st?.offline) {
        elUpdateBadge.className = 'update-badge err';
        elUpdateBadge.textContent = t.updateBadgeOffline;
      } else if (st?.hasUpdate) {
        elUpdateBadge.className = 'update-badge avail';
        elUpdateBadge.textContent = t.updateBadgeAvailable;
      } else if (st?.channelMismatch && isGit) {
        elUpdateBadge.className = 'update-badge warn';
        elUpdateBadge.textContent = t.updateBadgeSwitch;
      } else if (hasChecked && st?.ok !== false) {
        elUpdateBadge.className = 'update-badge ok';
        elUpdateBadge.textContent = t.updateBadgeUpToDate;
      } else {
        elUpdateBadge.className = 'update-badge';
        elUpdateBadge.textContent = t.updateBadgeUnchecked;
      }
    }

    const lblCur = document.getElementById('lbl-update-current');
    if (lblCur) lblCur.textContent = t.updateCurrentLabel;
    const valCur = document.getElementById('val-update-current');
    if (valCur) {
      const curPills = [];
      if (st?.currentVersion) {
        curPills.push(`<span class="update-pill">v${esc(st.currentVersion)}</span>`);
      } else if (mismatch?.startedVersion) {
        curPills.push(`<span class="update-pill">v${esc(mismatch.startedVersion)}</span>`);
      }
      if (st) {
        if (isGit) {
          const branchLabel = st.currentBranch || t.updateBranchDetached;
          curPills.push(`<span class="update-pill">${esc(branchLabel)}</span>`);
          if (st.currentShortSha) {
            curPills.push(`<span class="update-pill">${esc(st.currentShortSha)}</span>`);
          }
        } else {
          curPills.push(`<span class="update-pill">${esc(t.updateInstallRelease)}</span>`);
        }
      }
      valCur.innerHTML = curPills.join('');
    }

    const rowTarget = document.getElementById('row-update-target');
    const lblTgt = document.getElementById('lbl-update-target');
    const valTgt = document.getElementById('val-update-target');
    if (lblTgt) lblTgt.textContent = t.updateTargetLabel;
    const showTarget = Boolean(
      st && (st.targetVersion || st.targetShortSha || st.channelMismatch || st.behindCount > 0),
    );
    if (rowTarget) rowTarget.hidden = !showTarget;
    if (valTgt && showTarget) {
      const tgtPills = [];
      if (st.targetVersion) {
        tgtPills.push(
          `<span class="update-pill${st.hasUpdate ? ' accent' : ''}">v${esc(st.targetVersion)}</span>`,
        );
      }
      if (isGit && st.targetRef) {
        tgtPills.push(`<span class="update-pill">${esc(st.targetRef)}</span>`);
      }
      if (isGit && st.targetShortSha) {
        tgtPills.push(`<span class="update-pill">${esc(st.targetShortSha)}</span>`);
      }
      if (isGit && st.behindCount > 0) {
        tgtPills.push(
          `<span class="update-pill accent">${esc(t.updateBehindCommits(st.behindCount))}</span>`,
        );
      } else if (isGit && st.channelMismatch && st.targetBranch) {
        tgtPills.push(
          `<span class="update-pill warn">${esc(t.updateSwitchBranchHint(st.currentBranch, st.targetBranch))}</span>`,
        );
      }
      valTgt.innerHTML = tgtPills.join('');
    }

    const elSummary = document.getElementById('update-summary-text');
    if (elSummary) {
      const summaryText = String(st?.summary || '').trim();
      elSummary.hidden = !summaryText;
      elSummary.textContent = summaryText;
    }

    const elCommits = document.getElementById('update-commits-list');
    if (elCommits) {
      const commits = Array.isArray(st?.recentCommits) ? st.recentCommits : [];
      elCommits.hidden = commits.length === 0;
      elCommits.innerHTML = commits.map((c) => `<li title="${esc(c)}">${esc(c)}</li>`).join('');
    }

    const elChecked = document.getElementById('update-checked-meta');
    if (elChecked) {
      elChecked.textContent = staleWithoutStatus
        ? t.updateChannelMismatchHint
        : st?.checkedAt
          ? t.updateCheckedAgo(relTimeAgo(st.checkedAt))
          : t.updateNotCheckedYet;
    }

    if (elUpdateDirtyWarn) {
      elUpdateDirtyWarn.hidden = !isDirty;
      if (isDirty) {
        elUpdateDirtyWarn.textContent = t.updateDirtyWarn(st?.dirtyCount || 1);
      }
    }

    if (elUpdateNonGitHint) {
      elUpdateNonGitHint.hidden = !st || isGit;
      if (st && !isGit) {
        elUpdateNonGitHint.textContent = t.updateNonGitHint;
      }
    }

    if (elUpdateReloadBanner) {
      if (pluginUpdateAppliedVersion) {
        elUpdateReloadBanner.hidden = false;
        elUpdateReloadBanner.classList.remove('warn');
        elUpdateReloadBanner.textContent = t.updateReloadBanner(pluginUpdateAppliedVersion);
      } else if (mismatch) {
        elUpdateReloadBanner.hidden = false;
        elUpdateReloadBanner.classList.add('warn');
        elUpdateReloadBanner.textContent = t.updateBackendMismatchBanner(
          mismatch.startedVersion || '',
          mismatch.diskVersion || '',
        );
      } else {
        elUpdateReloadBanner.hidden = true;
        elUpdateReloadBanner.classList.remove('warn');
        elUpdateReloadBanner.textContent = '';
      }
    }

    if (elUpdateErr) {
      const statusErr = st && st.ok === false && st.error ? String(st.error) : '';
      const errText = updateCardError || statusErr;
      const redundantWithBanner = Boolean(
        mismatch && !pluginUpdateAppliedVersion && errText === t.sidecarMismatchErr,
      );
      elUpdateErr.hidden = !errText || redundantWithBanner;
      elUpdateErr.textContent = redundantWithBanner ? '' : errText;
    }

    renderUpdateStatusNotice();

    if (elBtnUpdateCheck) {
      elBtnUpdateCheck.disabled = busy;
      elBtnUpdateCheck.textContent = pluginUpdateChecking ? t.updateCheckingBtn : t.updateCheckBtn;
    }

    if (elBtnUpdateApply) {
      const showApply = Boolean(st && isGit && st.canApplyUpdate && !staleWithoutStatus);
      elBtnUpdateApply.hidden = !showApply;
      elBtnUpdateApply.disabled = busy || isDirty;
      elBtnUpdateApply.textContent = pluginUpdateApplying
        ? t.updateApplyingBtn
        : st?.channelMismatch && !st?.hasUpdate
          ? t.updateSwitchApplyBtn
          : t.updateApplyBtn;
      elBtnUpdateApply.title = isDirty ? t.updateDirtyWarn(st?.dirtyCount || 1) : '';
    }

    if (elBtnUpdateRelease) {
      const showRelease = Boolean(st && !isGit && st.releaseUrl);
      elBtnUpdateRelease.hidden = !showRelease;
      if (showRelease) {
        elBtnUpdateRelease.href = st.releaseUrl;
        elBtnUpdateRelease.textContent = t.updateReleaseBtn;
        elBtnUpdateRelease.className = st.hasUpdate ? 'btn-link-primary' : 'btn-link-secondary';
      }
    }
  }

  async function loadPluginUpdateStatus({ bg = true, retryCount = 0 } = {}) {
    if (pluginUpdatePollTimer) {
      clearTimeout(pluginUpdatePollTimer);
      pluginUpdatePollTimer = null;
    }
    const qs = new URLSearchParams({ bg: bg ? '1' : '0' });
    const url = `/api/update_status?${qs}`;
    try {
      const res = await fetchWithTimeout(url, { method: 'GET' }, API_READ_TIMEOUT_MS);
      const data = await safeReadJson(res, { url });
      if (data?.locale) applyLocale(data.locale);
      inspectServerInfo(data);
      if (data && typeof data === 'object' && ('currentVersion' in data || 'hasUpdate' in data)) {
        pluginUpdateState = data;
        updateCardError = data.ok === false && data.error ? String(data.error) : '';
        if (!data.serverInfo?.versionDrifted) {
          backendVersionMismatch = null;
        }
        syncSettingsUpdateDot();
        if (settingsScreenOpen) renderUpdateCard();
        if (data.checking && retryCount < 3) {
          pluginUpdatePollTimer = setTimeout(() => {
            loadPluginUpdateStatus({ bg: false, retryCount: retryCount + 1 });
          }, 2500);
        }
      }
    } catch (err) {
      if (err?.isBackendMismatch) {
        backendVersionMismatch = {
          kind: 'stale_backend',
          startedVersion: backendVersionMismatch?.startedVersion || '',
          diskVersion: backendVersionMismatch?.diskVersion || '',
          reason: err.code || 'route_not_found',
        };
        updateCardError = err.message || L().sidecarMismatchErr;
        if (settingsScreenOpen) renderUpdateCard();
      } else if (!pluginUpdateState && settingsScreenOpen && err?.message) {
        updateCardError = err.message;
        renderUpdateCard();
      }
    }
  }

  async function runManualUpdateCheck(channelOverride = '') {
    if (pluginUpdateChecking || pluginUpdateApplying) return;
    const t = L();
    pluginUpdateChecking = true;
    clearUpdateCardNotice();
    renderUpdateCard();
    try {
      const payload = { force: true, persistChannel: true };
      if (channelOverride) payload.channel = channelOverride;
      const res = await postApi(
        '/api/update_check',
        '/api/update_check_get',
        payload,
        { timeoutMs: API_UPDATE_TIMEOUT_MS },
      );
      if (res && typeof res === 'object') {
        pluginUpdateState = res;
        if (!res.serverInfo?.versionDrifted) {
          backendVersionMismatch = null;
        }
      }
      syncSettingsUpdateDot();
      if (res?.ok === false) {
        setUpdateCardNotice(res.error || t.updateToastCheckErr, 'err');
      } else if (res?.hasUpdate) {
        setUpdateCardNotice(t.updateToastAvailable(res.targetVersion || ''), 'ok', 3600);
      } else {
        setUpdateCardNotice(t.updateToastUpToDate, 'ok', 2800);
      }
    } catch (err) {
      if (err?.isBackendMismatch) {
        backendVersionMismatch = {
          kind: 'stale_backend',
          startedVersion: backendVersionMismatch?.startedVersion || '',
          diskVersion: backendVersionMismatch?.diskVersion || '',
          reason: err.code || 'route_not_found',
        };
      }
      setUpdateCardNotice(err?.message || t.updateToastCheckErr, 'err');
    } finally {
      pluginUpdateChecking = false;
      renderUpdateCard();
    }
  }

  function openPluginUpdateModal(triggerBtn = null) {
    const st = pluginUpdateState;
    if (!st || !st.isGitInstall || st.isDirty || pluginUpdateApplying) return;
    const t = L();
    const targetChannel = st.channel === 'dev' ? 'dev' : 'stable';

    activeModalCtx = {
      mode: 'plugin_update',
      channel: targetChannel,
      triggerBtn,
      busy: false,
      onDone: null,
    };

    elModalTitle.textContent = t.updateModalTitle;
    elModalClose.title = t.closeTip;
    elModalCancel.textContent = t.fCancel;

    const curVer = st.currentVersion ? `v${st.currentVersion}` : '';
    const tgtVer = st.targetVersion ? `v${st.targetVersion}` : '';
    elModalThread.textContent =
      curVer && tgtVer && curVer !== tgtVer
        ? `${st.displayName || 'Project Threads'}: ${curVer} -> ${tgtVer}`
        : `${st.displayName || 'Project Threads'} (${targetChannel})`;

    const pills = [];
    pills.push(
      `<span class="branch-pill">${ICONS.branch} <span>${esc(
        st.currentBranch || t.updateBranchDetached,
      )} -> ${esc(st.targetBranch || targetChannel)}</span></span>`,
    );
    if (st.behindCount > 0) {
      pills.push(`<span class="commit-pill">${esc(t.updateBehindCommits(st.behindCount))}</span>`);
    }
    if (st.targetShortSha) {
      pills.push(`<span class="wt-pill">${esc(st.targetShortSha)}</span>`);
    }
    elModalWtInfo.innerHTML = pills.join('');

    const warnLines = [t.updateModalNote];
    if (st.summary) warnLines.unshift(st.summary);
    elModalWarn.hidden = false;
    elModalWarn.textContent = warnLines.join(' ');

    elModalRemoveRow.hidden = true;
    elModalBranchRow.hidden = true;
    elModalForceRow.hidden = true;

    elModalErr.hidden = true;
    elModalErr.textContent = '';
    elModalConfirm.disabled = false;
    elModalCancel.disabled = false;
    elModalClose.disabled = false;

    syncModalConfirmButton();
    elModalBackdrop.hidden = false;
    elModalConfirm.focus();
  }

  if (elBtnChannelStable) {
    elBtnChannelStable.addEventListener('click', () => {
      if (backendVersionMismatch && !pluginUpdateState) return;
      if (pluginUpdateState?.channel === 'stable' && pluginUpdateState?.checkedAt) return;
      runManualUpdateCheck('stable');
    });
  }
  if (elBtnChannelDev) {
    elBtnChannelDev.addEventListener('click', () => {
      if (backendVersionMismatch && !pluginUpdateState) return;
      if (pluginUpdateState?.channel === 'dev' && pluginUpdateState?.checkedAt) return;
      runManualUpdateCheck('dev');
    });
  }
  if (elBtnUpdateCheck) {
    elBtnUpdateCheck.addEventListener('click', () => {
      runManualUpdateCheck(pluginUpdateState?.channel || '');
    });
  }
  if (elBtnUpdateApply) {
    elBtnUpdateApply.addEventListener('click', (ev) => {
      openPluginUpdateModal(ev.currentTarget);
    });
  }

  // ---------- Boot & Reactive Polling ----------
  async function start() {
    applyLocale('en');
    await syncHostConversationScope();
    if (window.sidecar && window.sidecar.getWorkspaceUris) {
      try {
        const uris = await window.sidecar.getWorkspaceUris();
        workspace = uris[0] || '';
        window.sidecar.onWorkspaceChange((next) => {
          const nextWs = (next && next[0]) || '';
          if (nextWs !== workspace) {
            workspace = nextWs;
            lastBoardKey = '';
            lastHasGitRepo = null;
            threadOpenState.clear();
            if (currentTab === 'library') loadMemory();
            refreshBoard(true);
          }
        });
      } catch {
        // Ignore workspace URI errors
      }
    }
    if (window.sidecar && typeof window.sidecar.onConversationChange === 'function') {
      try {
        window.sidecar.onConversationChange(() => {
          lastBoardKey = '';
          if (currentTab === 'library') loadMemory();
          refreshBoard(true);
        });
      } catch {
        // Ignore optional listener errors
      }
    }
    populateDispatchModelSelect();
    loadSelectableModels(false);
    loadPluginUpdateStatus({ bg: true });
    await refreshBoard(true);
    setInterval(() => {
      refreshBoard(false);
    }, BOARD_POLL_MS);
    setInterval(() => {
      if (openThreadId) refreshOpenThread(false, false);
    }, CHAT_POLL_MS);
  }

  start();
})();

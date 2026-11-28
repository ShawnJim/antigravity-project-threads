(() => {
  'use strict';

  const BOARD_POLL_MS = 2200;
  const CHAT_POLL_MS = 1200;
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
      roleWorker: 'Worker',
      roleReadOnly: 'Read-only',
      readOnlyMode: 'Shared session',
      justNow: 'now',
      justNowAgo: 'just now',
      agoTime: (val, unit) => `${val}${unit} ago`,
      loadingChat: 'Loading conversation…',
      emptyChat: 'Waiting for first response…',
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
    },
  };

  let curLocale = 'en';
  const L = () => I18N[curLocale] || I18N.en;

  // ---------- Crisp Monochrome & Swarm Status SVG Icons ----------
  const ICONS = {
    chevronUp: '<svg class="ico ico-sm" viewBox="0 0 24 24"><polyline points="18 15 12 9 6 15"/></svg>',
    chevronDown: '<svg class="ico ico-sm" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>',
    chevronRight: '<svg class="ico ico-sm" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>',
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
  const threadOpenState = new Map(); // threadId -> boolean
  let lastBoardKey = '';
  let lastSnap = null;
  let cachedThreads = [];
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

  // ---------- DOM References ----------
  const elBoardScreen = document.getElementById('board-screen');
  const elThreadScreen = document.getElementById('thread-screen');
  const elBoardBody = document.getElementById('board-body');
  const elLivePill = document.getElementById('live-pill');
  const elLiveLabel = document.getElementById('live-label');
  const elDrawer = document.getElementById('dispatch-drawer');
  const elNewBtn = document.getElementById('btn-new');
  const elToast = document.getElementById('toast');
  const elGoalCard = document.getElementById('goal-card');
  const elBtnOpenCoord = document.getElementById('btn-open-coord');
  const elBtnCardCoord = document.getElementById('btn-card-coord');
  const elBtnChatCoord = document.getElementById('btn-chat-coord');
  const elChatStream = document.getElementById('chat-stream');
  const elChatInput = document.getElementById('chat-input');
  const elSendBtn = document.getElementById('btn-send');
  const elLiveBar = document.getElementById('live-bar');
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
      try {
        const meta = await window.sidecar.agent.getConversationMetadata(convId);
        const rawPid = meta?.projectId || meta?.project_id || '';
        if (getHostConvId() === convId) {
          hostProjectId =
            rawPid && rawPid !== 'outside-of-project' ? String(rawPid).trim() : '';
        }
      } catch {
        // Backend also resolves authoritative projectId via LS GetConversation
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
    document.getElementById('btn-bind').textContent = t.bindBtn;
    document.getElementById('lbl-sort').textContent =
      sortMode === 'priority' ? t.sortPriority : t.sortRecent;

    if (!lastSnap) {
      document.getElementById('panel-title').textContent = t.panelTitle;
      document.getElementById('goal-kicker-text').textContent = t.kickerProject;
      document.getElementById('goal-title').textContent = t.defaultProjTitle;
    }

    document.getElementById('lbl-drawer-title').textContent = t.drawerTitle;
    document.getElementById('btn-close-drawer').title = t.closeTip;
    document.getElementById('lbl-f-title').textContent = t.fTitle;
    document.getElementById('f-title').placeholder = t.fTitlePh;
    document.getElementById('lbl-f-branch').textContent = t.fBranch;
    document.getElementById('lbl-f-model').textContent = t.fModel;
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

    if (changed) {
      if (lastSnap) renderBoard(lastSnap);
      if (openThreadObj) renderThreadHeader(openThreadObj);
      if (openThreadId && Array.isArray(lastRenderedItems)) {
        renderThreadItems(lastRenderedItems, false);
      }
    }
    return changed;
  }

  function flashToast(msg, tone = 'ok', durationMs = 2400) {
    if (toastTimer) clearTimeout(toastTimer);
    const text = String(msg || '');
    elToast.className = tone === 'err' ? 'toast err' : tone === 'warn' ? 'toast warn' : 'toast';
    elToast.textContent = text;
    elToast.title = text;
    toastTimer = setTimeout(() => {
      elToast.textContent = '';
      elToast.title = '';
      elToast.className = 'toast';
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
      inherit: 'Gemini Pro',
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

  async function postApi(postPath, getFallbackPath, payload) {
    try {
      const res = await doFetch(postPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const json = await res.json();
        if (json?.locale) applyLocale(json.locale);
        return json;
      }
    } catch {
      // Fallback to GET query route
    }
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(payload)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const res2 = await doFetch(`${getFallbackPath}?${qs}`);
    const json2 = await res2.json();
    if (json2?.locale) applyLocale(json2.locale);
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

  function renderO2ThreadCard(th) {
    const t = L();
    const isWorking = th.bucket === 'working';
    const isWaiting = th.bucket === 'waiting';
    const stateCls = isWorking ? 'running' : isWaiting ? 'waiting' : 'done';
    const isOpen = isThreadCardOpen(th);
    const activeWorkerId = getActiveMainWorkerConvId();
    const isActiveMain = Boolean(
      activeWorkerId && th.conversationId && th.conversationId === activeWorkerId,
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
    const cardCls = `o2-th ${stateCls}${isOpen ? ' open' : ''}${isActiveMain ? ' active-main' : ''}`;

    return `
      <div class="${cardCls}" data-th-card="${esc(th.threadId)}">
        <div class="o2-thh">
          <span class="o2-thd ${stateCls}" aria-hidden="true"></span>
          <button type="button" class="o2-tht" data-action="open-primary" data-id="${esc(th.threadId)}" title="${esc(th.displayTitle || th.title)}">
            <b>${esc(th.title)}</b>
            <em>${esc(statusWord)}</em>
          </button>
          <span class="o2-thc">${rightMetaHtml}</span>
          <button type="button" class="o2-fold-btn" data-action="fold-th" data-id="${esc(th.threadId)}" aria-expanded="${isOpen ? 'true' : 'false'}" title="${esc(t.foldTip)}">
            <span class="o2-chev">${ICONS.chevronRight}</span>
          </button>
        </div>
        ${goalLine ? `<div class="o2-thg" data-action="open-primary" data-id="${esc(th.threadId)}">${esc(goalLine)}</div>` : ''}
        ${nowHtml}
        ${tasksHtml}
        <div class="o2-th-actions">
          ${actions.join('')}
          <span class="spacer"></span>
          ${modelChip}
        </div>
      </div>
    `;
  }

  function renderO2ThreadsSection(waiting, working, idle, active) {
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
        ${ordered.map(renderO2ThreadCard).join('')}
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

  function renderBoard(snap) {
    lastSnap = snap;
    const t = L();
    const c = snap.coordinator;
    const bindBtn = document.getElementById('btn-bind');
    const hasCoord = Boolean(c && c.conversationId);
    bindBtn.hidden = hasCoord;
    updateCoordinatorControls();

    const folderProj = c
      ? (c.repoRoot || c.workspacePath || '').split(/[\\/]/).filter(Boolean).pop()
      : workspace
        ? workspace.split(/[\\/]/).filter(Boolean).pop()
        : '';
    const projName = folderProj || String(snap.projectLabel || '').trim();

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

    const allThreads = snap.threads || [];
    cachedThreads = allThreads;

    const active = allThreads.filter((x) => !x.archived);
    const archived = allThreads.filter((x) => x.archived);
    const waiting = active.filter((x) => x.bucket === 'waiting');
    const working = active.filter((x) => x.bucket === 'working');
    const idle = active.filter((x) => x.bucket === 'idle');
    const wtThreads = active.filter((x) => x.worktreePath);

    // Header title & Underline tab counts/badges
    document.getElementById('panel-title').textContent = projName || t.panelTitle;
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
    document.getElementById('goal-title').textContent =
      projName || c?.title || t.defaultProjTitle;
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
        renderO2ThreadsSection(waiting, working, idle, active),
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
    const modelLabel = formatModelDisplay(th.modelDisplayName || th.resolvedModel || th.model);
    const roleLabel = th.worktreePath || th.branch ? t.roleWorker : t.roleReadOnly;
    const stepsHtml =
      th.toolStepCount > 0
        ? `<span class="comp-steps-pill">◌ ${esc(t.stepsUnit(th.toolStepCount))}</span>`
        : '';
    const wtBtn = th.worktreePath
      ? `<button type="button" id="btn-comp-wt" class="ghost" title="${esc(th.worktreePath)}">${ICONS.folder} <span>${esc(t.actFolder)}</span></button>`
      : '';

    compMeta.innerHTML = `<span class="comp-plus-ico" aria-hidden="true">${ICONS.plus}</span><span class="comp-role-lbl">${esc(roleLabel)}</span><span class="comp-model-pill" title="${esc(modelLabel)}">${esc(modelLabel)}</span>${stepsHtml}${wtBtn}`;
    const compWtBtn = document.getElementById('btn-comp-wt');
    if (compWtBtn) {
      compWtBtn.addEventListener('click', () => copyText(th.worktreePath, L().copiedPath));
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
      const res = await doFetch(`/api/thread_messages?${qs}`);
      const data = await res.json();
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
      const res = await postApi('/api/thread_send', '/api/thread_send_get', {
        threadId: openThreadId,
        message: text,
      });
      if (!res.ok) {
        tempWrap.innerHTML = `<div class="msg-user">${esc(text)}</div><div class="err">${esc(res.error || 'Error')}</div>`;
      } else {
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
      const res = await doFetch(`/api/memory?${qs}`);
      const data = await res.json();
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
      const res = await doFetch(`/api/state?${qs}`);
      const data = await res.json();
      if (data.locale) applyLocale(data.locale);
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

      if (scopeChanged || convChanged) {
        lastBoardKey = '';
        lastHasGitRepo = null;
        manualPopoutConvId = '';
        threadOpenState.clear();
        if (currentTab === 'library') {
          loadMemory();
        }
      }

      // Immediately close any open thread drawer that does not belong to the active project scope
      if (
        openThreadId &&
        !(data.threads || []).some((x) => x.threadId === openThreadId)
      ) {
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
        projectLabel: data.projectLabel || '',
        sortMode,
        timeBucket,
        coordinator: data.coordinator,
        threads: data.threads,
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

  elModalCancel.addEventListener('click', () => closePtModal());
  elModalClose.addEventListener('click', () => closePtModal());
  elModalBackdrop.addEventListener('click', (e) => {
    if (e.target === elModalBackdrop) closePtModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && activeModalCtx && !activeModalCtx.busy) {
      closePtModal();
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
  document.getElementById('btn-close-drawer').addEventListener('click', () => {
    setDrawerOpen(false);
  });
  document.getElementById('btn-cancel-dispatch').addEventListener('click', () => {
    setDrawerOpen(false);
  });

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
    const model = document.getElementById('f-model').value;
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
      refreshBoard(false);
    }
  });

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

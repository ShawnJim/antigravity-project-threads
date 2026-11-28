<div align="center">
  <img src="./assets/logo.svg" width="96" height="96" alt="Project Threads Logo" />

  <h1>Antigravity Project Threads</h1>

  <p>
    為 <strong>Antigravity 2.0 Desktop</strong> 打造的 Claude Code Projects 風格常駐專案總控與平行隔離工作執行緒體系。
  </p>

  <p>
    <img src="https://img.shields.io/badge/version-v1.2.0--rc.1-38BDF8?style=flat-square" alt="Version v1.2.0-rc.1" />
    <img src="https://img.shields.io/badge/dependencies-零依賴%20(Node.js%20ESM)-34D399?style=flat-square" alt="零依賴" />
    <img src="https://img.shields.io/badge/platform-Antigravity%202.0-818CF8?style=flat-square" alt="Antigravity 2.0" />
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-C084FC?style=flat-square" alt="MIT License" /></a>
  </p>

  <p>
    <a href="./README.md">English</a> | <a href="./README.zh-CN.md">简体中文</a> | <strong>繁體中文</strong>
  </p>
</div>

---

**Antigravity Project Threads**（`project-threads`）在 **Antigravity 2.0 Desktop** 中重現 **Claude Code Projects** 風格的持續專案總控與平行工作執行緒體系：將左側主視窗錨定為常駐 **`[Coordinator]`** 總控工作階段，背景透過原生 `ConversationService` 平行派發實體隔離的 **Git Worktree**（或零拷貝唯讀）子執行緒，並在右側 **Project Threads** 輔助面板即時監控與內聯預覽對話。

## 核心特色

- **常駐總控工作階段（`/coord`）與自主封存**：
  - 左側主畫布始終維持 `[Coordinator] <專案名稱>` 上下文精簡清晰，專注於需求拆解、架構決策、任務派發與結果驗收。
  - 內建 `PreInvocation` / `PreToolUse` / `Stop` 守護鉤子與持久規則，防止總控工作階段誤退化為一般單執行緒操作或臨時 Subagent。
  - **總控自主封存**：子執行緒完成並回報後（唯讀排查類立即封存，Worktree 程式碼類確認合併至目標分支或不再需要後封存），總控可自主呼叫 `archive_thread` 完成清理，無需逐次手動確認。
- **雙模平行工作執行緒（`dispatch_thread`）與語言跟隨**：
  - **獨立 Git Worktree 模式（`createWorktree: true`）**：自動於 `../.worktrees/<repo>/<thread-slug>` 建立獨立分支檢出副本，支援多任務平行修改程式碼互不干擾。
  - **共享唯讀排查模式（`createWorktree: false`）**：零磁碟拷貝直接在主儲存庫執行程式碼檢索、日誌分析與方案調研。
  - **自動跟隨使用者語言**：派發標題、任務提示詞以及子執行緒分析與總結皆自動跟隨使用者當前對話語言。
- **兩級 Model + 思考檔位選擇器與 `inherit` 模式**：
  - 於 Sidecar 設定頁與內聯對話抽屜中提供 **兩級模型家族 + 思考檔位選擇器**，可依需求快速切換模型與推理檔位，並支援工作階段中途無縫切換模型。
  - 支援全域與專案級預設模型設定（分別指定 Worktree 程式碼執行緒與唯讀排查執行緒），原生支援 **`inherit`（跟隨主工作階段模型）**，派發時自動解析總控當前使用的模型。
- **執行緒 Token 消耗與上下文壓縮遙測**：
  - 於執行緒看板即時顯示每個執行緒的 **Token 消耗總計**、**壓縮線進度** 與 **壓縮次數統計**。
  - 複用既有模型中繼資料輪詢通道並支援快取離線日誌回退，零額外 RPC 開銷。
- **嚴格的專案 / 工作階段級隔離與非同步背景感知**：
  - 基於即時 `GetConversation` 中繼資料與 Git 主儲存庫根目錄進行 Fail-Closed 作用域判定，每個專案的工作執行緒清單、Coordinator 綁定與共享記憶完全獨立，絕不跨專案串流。
  - 自動識別仍在執行背景命令（`run_command` 非同步任務）的執行緒，避免半途誤報完成；搭配核心級原子鎖（`wx` claim lock）去重，確保子執行緒真正完成後才自動向 `[Coordinator]` 推送結構化分段完成卡片。
- **Swarm 風格即時監控看板 + 1:1 原生內聯 `Preview` 抽屜**：
  - 對齊 Antigravity 內建 Swarm Overview 視覺體系（`--pt-*` 獨立命名空間權杖、深淺色自適應、即時步驟環形進度條與流光狀態展示）。
  - **點擊卡片優先內聯 `Preview`**：點擊任意執行緒預設於右側邊欄滑出與主聊天窗 1:1 對齊的原生對話流（含 `Worked for Xm Ys` 摺疊軌跡樹、檔案行號膠囊跳轉、步驟清單卡片、模型選擇器與青綠流光輸入框），不切走左側主視窗；同時保留 **`Open ↗`** 一鍵切至主窗及常駐 **`Coordinator`** 快速返回入口。
- **共享專案記憶（`project-memory.md`）與三語同步**：
  - 主儲存庫 `.agents/rules/project-memory.md` 自動同步至各活躍 Worktree（透過 `.git/info/exclude` 排除提交）；介面自動跟隨 Antigravity 全域語言設定切換 `English / 简体中文 / 繁體中文`。

## 安裝方式

> **零外部依賴**：完全基於 Antigravity 2.0 內建 Node.js ESM 執行環境建構，**無需執行 `npm install`**。

### 穩定版安裝（推薦 — `main` 分支）

`main` 分支始終與最新正式穩定版（`vX.Y.Z` / `stable` 標籤）保持同步，適合日常穩定使用。

#### Windows (PowerShell)

```powershell
New-Item -ItemType Directory -Force "$HOME\.gemini\config\plugins" | Out-Null
git clone https://github.com/agy-plugins/project-threads.git "$HOME\.gemini\config\plugins\project-threads"
```

#### macOS / Linux

```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/agy-plugins/project-threads.git ~/.gemini/config/plugins/project-threads
```

### 開發版 / 先行版安裝（`dev` 分支 / `rc` 標籤）

日常新功能開發與先行版（`vX.Y.Z-rc.N`）發布於 `dev` 分支，不會影響 `main` 與 `stable` 穩定標籤。如需搶先體驗最新特性：

```bash
# 直接複製 dev 分支
git clone -b dev https://github.com/agy-plugins/project-threads.git ~/.gemini/config/plugins/project-threads

# 或將既有安裝切換至 dev 分支
cd ~/.gemini/config/plugins/project-threads
git fetch origin && git checkout dev && git pull
```

### 啟用與使用

1. 開啟 **Antigravity 2.0** 桌面端，進入 **Customizations → Plugins**，確認 **Project Threads** 處於開啟狀態（更新外掛程式碼後可 **關 → 開** 一次觸發熱重載）。
2. 在主對話中輸入 `/coord` 將當前工作階段綁定為專案總控協調器。
3. 點擊右上角邊欄 **`+`** 選擇 **Project Threads** 開啟即時執行緒看板：
   - 點擊任意執行緒卡片或列表列於右側內聯開啟 **`Preview`** 對話抽屜（可直接追問、糾偏或切換該執行緒模型）；
   - 點擊 **`Open ↗`** 可將該執行緒彈出至左側主視窗，隨時點擊面板頂部 **`Coordinator`** 按鈕一鍵切回總控工作階段。

## 目錄結構

```text
project-threads/
├── plugin.json                 # Antigravity 2.0 外掛清單
├── mcp_config.json             # Coordinator MCP 工具服務宣告
├── hooks.json                  # PreInvocation / PreToolUse / Stop 生命週期鉤子
├── assets/
│   └── logo.svg                # 向量外掛與儲存庫 Logo
├── rules/
│   └── AGENTS.md               # Coordinator 與 Worktree 隔離規則
├── skills/
│   └── coord/
│       └── SKILL.md            # /coord 技能工作流指引
├── mcp/
│   └── server.mjs              # Stdio MCP Server（7 個總控編排工具）
├── scripts/
│   └── hook-handler.mjs        # 完成狀態擷取、原子去重推送與指令續期
├── lib/
│   ├── ls-client.mjs           # 本地 ConversationService / LanguageServerService 用戶端
│   ├── model-format.mjs        # 兩級模型目錄、思考檔位格式化與 inherit 解析
│   ├── store.mjs               # 專案隔離註冊表、Git Worktree 與記憶同步引擎
│   └── transcript.mjs          # 對話日誌解析、非同步任務偵測與 Token/壓縮遙測
├── sidecars/
│   └── threads/
│       ├── sidecar.json        # Auxiliary Pane Sidecar 檢視設定
│       ├── package.json
│       ├── main.mjs            # 本地 API 服務與無快取靜態資源路由
│       ├── index.html          # Swarm 風格看板、設定頁與內聯聊天抽屜骨架
│       ├── theme.css           # --pt-* 獨立命名空間樣式表（深淺色主題）
│       └── app.js              # 即時輪詢、Preview 抽屜、模型選擇器與三語國際化
└── tests/
    └── *.test.mjs              # 零依賴 Node.js 自動化測試套件
```

## 執行測試

```bash
node --test tests/*.test.mjs
```

## 友情連結

友情連結：[LINUX DO - 新的理想型社區](https://linux.do)

## License

[MIT License](./LICENSE) © 2026 [ShawnJim](https://github.com/ShawnJim)

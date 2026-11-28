<div align="center">
  <img src="./assets/logo.svg" width="96" height="96" alt="Project Threads Logo" />

  <h1>Antigravity Project Threads</h1>

  <p>
    <strong>把注意力留給決策，讓多 Agent 平行開發井然有序。</strong><br />
    專為 <strong>Antigravity 2.0 Desktop</strong> 打造的注意力管理與平行工程外掛：一個常駐聚焦的專案總控，搭配多條實體隔離的背景工作執行緒。
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

同時驅動多個 AI Agent 開發，不該讓你淪為疲於奔命的「視窗切換員」。**Antigravity Project Threads**（`project-threads`）是專為 **Antigravity 2.0 Desktop** 打造的**注意力管理與平行開發指揮中樞**：將左側主視窗錨定為始終清醒的 **`[Coordinator]`** 總控工作階段，專注處理拆解、權衡與拍板；將程式碼修改與深度排查透過原生 `ConversationService` 背景派發至實體隔離的 **Git Worktree**（或零拷貝唯讀）子執行緒；並將完成摘要、**待決策（Pending Decisions）** 卡片、內嵌 **`Preview`** 對話、一鍵切換總控與外掛更新統一收口於右側 **Project Threads** 看板——告別頻繁切窗、拒絕分支互踩，讓高併發 AI 開發真正可控。

## 為什麼你需要它：把注意力還給工程決策

當同時推進多個需求與排查任務時，真正的瓶頸往往不是模型速度，而是人類大腦的上下文切換損耗。**Project Threads** 將繁瑣的排程、追蹤與分支協調從大腦卸載出去：

- **守住主視窗心流**：左側 `[Coordinator]` 始終維持高訊噪比，只聚焦架構判斷、任務拆解與結果驗收，不再被數百行檢索日誌或報錯輸出淹沒。
- **真正無衝突的平行執行**：修改程式碼自動隔離於獨立 Git Worktree，唯讀排查零拷貝直連主儲存庫，多條任務同時推進卻互不污染工作區。
- **讓待拍板事項主動找你**：子執行緒收尾後自動向總控回傳結構化總結；需要選擇方案、合併分支或確認封存時，統一置頂收口於右側 **待決策** 佇列，一鍵回應不遺漏。
- **不切窗即可隨時介入**：點擊任意執行緒卡片即可於右側展開 1:1 內嵌 **`Preview`** 抽屜，隨時追問、糾偏或中途切換模型，視線與思路無需離開主視窗。

## 核心特色

- **常駐總控工作階段（`/coord`）、一鍵換綁與舊總控保護**：
  - 左側主畫布始終維持 `[Coordinator] <專案名稱>` 上下文精簡聚焦，專注於需求拆解、架構決策、任務派發與結果驗收，由 `PreInvocation` / `PreToolUse` / `Stop` 鉤子與 `v14` 常駐協議守護。
  - **一鍵切換 / 換綁總控**：直接在看板專案卡片透過 **`切換總控`** / **`換綁目前`** 選擇目前主視窗工作階段、本專案其他工作階段或手動輸入會話 UUID 完成換綁。本專案未封存的活躍子執行緒與顯式待決策會自動改綁回呼至新總控（不會觸發歷史閒置執行緒的舊回呼雪崩）；已退場舊總控會收到退場提示並攔截過期單執行緒寫入操作，避免誤觸發干擾。
  - **依模式區分的封存策略**：唯讀排查類執行緒（`createWorktree: false`）完成回報後可由總控自主封存；Worktree 程式碼開發執行緒（`createWorktree: true`）於合併後仍先保留以供驗收與追問，待使用者確認驗收通過後自動呼叫 `archive_thread` 封存，並同時識別一般合併與 `cherry-pick` 合併以安全清理乾淨的 Worktree 與分支。
- **右側「待決策（Pending Decisions）」看板（`manage_decisions`）**：
  - 置頂顯示於右側 **Project Threads** 面板頂部，確保需要你拍板的事項不會被對話流淹沒。
  - **顯式決策卡片**：總控在提出方案選擇、分支合併、發布或清理建議時呼叫 `manage_decisions` 登記卡片，附帶 1–3 個快捷操作按鈕（`send_coordinator` 一鍵回傳總控、`archive_thread` 或 `dismiss`）；若你直接在聊天框回覆決策，總控也會自動呼叫 `resolve` 清除卡片。
  - **Worktree 自動提示卡片**：自動偵測存在已提交未合併程式碼的分支（分支已就緒，待合併）以及已合併 / 已 `cherry-pick` 合併的分支（待驗收封存），並與同執行緒顯式決策自動去重。
- **雙模平行工作執行緒（`dispatch_thread`）與語言跟隨**：
  - **獨立 Git Worktree 模式（`createWorktree: true`）**：自動於 `../.worktrees/<repo>/<thread-slug>` 建立獨立分支檢出副本，支援多任務平行修改程式碼互不干擾。
  - **共享唯讀排查模式（`createWorktree: false`）**：零磁碟拷貝直接在主儲存庫執行程式碼檢索、日誌分析與方案調研。
  - **自動跟隨使用者語言**：派發標題、任務提示詞以及子執行緒分析與總結皆自動跟隨使用者目前對話語言。
- **Fail-Closed 作用域隔離、專案內序號 `#N` 與非同步背景感知**：
  - 基於即時 `GetConversation` 中繼資料與 Git 主儲存庫根目錄執行 Fail-Closed 作用域判定，每個專案的執行緒清單、總控綁定、待決策與共享記憶完全獨立；單執行緒 MCP 工具預設強制檢核作用域參數（`coordinatorId` / `workspacePath`）。
  - **專案內顯示序號（`#N`）**：保留全域唯一主鍵 `thr-xxx` 與 Worktree/分支命名的同時，為每個專案獨立維護連續的 `#1`、`#2`、`#3`… 顯示序號，消除跨專案跳號困擾，並支援於帶作用域的 MCP 呼叫中使用 `#N` 檢索。
  - 自動識別仍在執行背景命令（`run_command` 非同步任務）的執行緒，避免半途誤報完成；搭配核心級原子鎖（`wx` claim lock）去重，確保子執行緒真正完成後才向 `[Coordinator]` 推送結構化完成卡片。
- **兩級模型 + 思考檔位選擇器、`inherit` 模式與遙測**：
  - 於 Sidecar 設定頁與內嵌對話抽屜中提供 **兩級模型家族 + 思考檔位懸浮選擇器**，支援執行緒中途無縫切換模型，並對 **`Extra High`** 等高檔位標籤進行全鏈路一致正規化。
  - 支援全域與專案級預設模型設定（分別指定 Worktree 程式碼執行緒與唯讀排查執行緒），原生支援 **`inherit`（跟隨主會話模型）**，派發時自動解析總控最近一次已執行回合使用的模型。
  - 於執行緒看板即時顯示每個執行緒的 **Token 消耗總計**、**壓縮線進度** 與 **壓縮次數統計**，複用既有模型中繼資料輪詢通道並支援快取離線日誌回退，零額外 RPC 開銷。
- **Swarm 風格即時看板、真實專案名與 1:1 原生內嵌 `Preview` 抽屜**：
  - 對齊 Antigravity 內建 Swarm Overview 視覺體系（`--pt-*` 獨立命名空間權杖、深淺色自適應、透過 `ReadProject` 優先顯示真實 Antigravity 專案名稱、即時步驟環形進度條），並智慧控制「回到總控」按鈕顯示（已在總控頁自動隱藏，離開總控時保留單一清晰入口）。
  - **點擊卡片優先內嵌 `Preview`**：點擊任意執行緒預設於右側邊欄滑出與主聊天窗 1:1 對齊的原生對話流（含 `Worked for Xm Ys` 摺疊軌跡樹、檔案行號膠囊跳轉、步驟清單卡片、模型選擇器與流光輸入框），不切走左側主視窗；同時保留 **`Open ↗`** 一鍵彈出至主視窗。
- **雙渠道外掛檢查與安全本地更新器**：
  - Sidecar **設定** 內建 **版本與更新** 卡片，偵測到新版本時頂欄設定齒輪自動亮起紅點提示。
  - 支援於 **`stable`**（追蹤 `origin/main` 與 `vX.Y.Z` / `stable` 正式版）與 **`dev`**（追蹤 `origin/dev` 先行版）雙渠道間切換；一鍵更新嚴格檢查本地工作區乾淨並僅執行 `--ff-only` 快進更新（存在未提交改動時自動攔截，絕不執行 `git reset --hard`）；非 Git 安裝則安全引導前往 GitHub Releases；內建前後端版本漂移偵測與請求逾時保護，後端滯後時提供明確重新載入提示。
- **共享專案記憶（`project-memory.md`）與三語同步**：
  - 主儲存庫 `.agents/rules/project-memory.md`（內建預設 Worktree 合併與封存規範）自動同步至各活躍 Worktree（透過 `.git/info/exclude` 排除提交）；介面自動跟隨 Antigravity 全域語言設定切換 `English / 简体中文 / 繁體中文`。

## MCP 總控工具（8 個）

本地 stdio MCP 服務（`mcp/server.mjs`，服務名 `project-threads_coordinator`）共提供 8 個總控編排工具：

| 工具名稱 | 作用說明 |
| --- | --- |
| `init_project_coordinator` | 將目前工作階段初始化並綁定為 `[Coordinator]`，註冊生命週期鉤子，確保 `.agents/rules/project-memory.md` 存在並寫入預設合併封存約定。 |
| `dispatch_thread` | 透過 `ConversationService` 背景派發獨立 Git Worktree（`createWorktree: true`）或零拷貝唯讀（`createWorktree: false`）工作執行緒。 |
| `list_threads` | 依專案作用域同步並列出活躍（或已封存）執行緒，顯示 `#N` / `thr-xxx` 編號、即時 `runState`、Git 分支狀態與最新摘要。 |
| `get_thread_detail` | 僅局部重新整理並查詢單一執行緒的完整中繼資料、Git 狀態與最新總結，支援 `thr-xxx`、專案內 `#N` 或會話 UUID。 |
| `send_thread_message` | 在不切走左側總控工作階段的前提下，向既有工作執行緒背景傳送追問、糾偏或補充指令。 |
| `archive_thread` | 封存已完成或廢棄的執行緒，並於工作區乾淨且已合併（含 `cherry-pick` 等價提交）時安全移除其 Git Worktree 與分支。 |
| `update_project_memory` | 讀取、附加或重寫 `.agents/rules/project-memory.md`，並自動向本專案下所有活躍 Worktree 廣播同步。 |
| `manage_decisions` | 登記（`add`）、列出（`list`）、解決（`resolve`）或忽略（`dismiss`）置頂於右側看板的 **待決策** 卡片與 1–3 個快捷按鈕。 |

> **`v14` 協議單專案 Fail-Closed 隔離與 `#N` 序號**：`get_thread_detail`、`send_thread_message`、`archive_thread` 預設啟用 fail-closed 跨專案攔截，必須傳入專案作用域參數（`coordinatorId` / `workspacePath` / `projectId`）；僅於顯式傳入 `scope: "*"` 時才允許無作用域的全域 `thr-xxx` 存取。依專案內顯示序號檢索（`#1`、`#2`…）須帶前導 `#` 並提供專案作用域。

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

日常新功能開發與先行版（`vX.Y.Z-rc.N`）發布於 `dev` 分支，不會影響 `main` 與 `stable` 穩定標籤。除命令列複製/切換分支外，乾淨的 Git 安裝亦可直接在 Sidecar **設定 → 版本與更新** 中一鍵切換 **`stable`** / **`dev`** 渠道：

```bash
# 直接複製 dev 分支
git clone -b dev https://github.com/agy-plugins/project-threads.git ~/.gemini/config/plugins/project-threads

# 或將既有安裝切換至 dev 分支
cd ~/.gemini/config/plugins/project-threads
git fetch origin && git checkout dev && git pull
```

### 啟用與使用

1. 開啟 **Antigravity 2.0** 桌面端，進入 **Customizations → Plugins**，確認 **Project Threads** 處於開啟狀態（更新外掛程式碼後可 **關 → 開** 一次或重新載入視窗生效）。
2. 在主對話中輸入 `/coord` 將目前工作階段綁定為專案總控協調器。
3. 點擊右上角邊欄 **`+`** 選擇 **Project Threads** 開啟即時執行緒看板：
   - 於看板頂部 **待決策** 區域一鍵處理方案選擇、分支合併或驗收封存提示；
   - 點擊任意執行緒卡片或列表列於右側內嵌開啟 **`Preview`** 對話抽屜（可直接追問、糾偏或切換該執行緒模型）；
   - 點擊 **`Open ↗`** 將執行緒彈出至主視窗，離開總控時可一鍵切回，或點擊 **`切換總控`** / **`換綁目前`** 更換目前專案的總控工作階段；
   - 點擊右上角 **設定** 齒輪可設定全域/專案預設模型（`inherit` 或具體模型 + 檔位）並執行雙渠道外掛更新。

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
│   └── server.mjs              # Stdio MCP Server（8 個總控編排工具）
├── scripts/
│   └── hook-handler.mjs        # 完成狀態擷取、原子去重、舊總控退場保護與 v14 指令續期
├── lib/
│   ├── ls-client.mjs           # 本地 ConversationService / LanguageServerService 用戶端
│   ├── model-format.mjs        # 兩級模型目錄、思考檔位格式化與 inherit 解析
│   ├── store.mjs               # 專案隔離註冊表、#N 序號、待決策、總控換綁與 Worktree 同步
│   ├── transcript.mjs          # 對話日誌解析、非同步任務偵測與 Token/壓縮遙測
│   └── updater.mjs             # 雙渠道外掛版本檢查與安全快進本地更新器
├── sidecars/
│   └── threads/
│       ├── sidecar.json        # Auxiliary Pane Sidecar 檢視設定
│       ├── package.json
│       ├── main.mjs            # 本地 API 服務、版本漂移偵測與無快取靜態資源路由
│       ├── index.html          # Swarm 風格看板、待決策區、設定頁與內嵌聊天抽屜骨架
│       ├── theme.css           # --pt-* 獨立命名空間樣式表（深淺色主題）
│       └── app.js              # 即時輪詢、待決策、換綁、Preview 抽屜、模型選擇器、更新器與三語國際化
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

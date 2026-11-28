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

同時驅動多個 AI Agent 開發，不該讓你淪為疲於奔命的「切窗排程員」。**Antigravity Project Threads**（`project-threads`）為 **Antigravity 2.0 Desktop** 打造**注意力優先的平行開發指揮台**：左側主視窗始終錨定清醒的 **`[Coordinator]`** 總控專攻拆解與拍板，程式碼修改與排查由原生 `ConversationService` 派發至背景隔離執行緒，所有完成摘要、**待決策**與內嵌 **`Preview`** 統一收口於右側看板——把上下文切換從大腦卸載出去。

## 為什麼是 Project Threads：把注意力還給決策

| 平行開發痛點 | Project Threads 的解法 |
| --- | --- |
| 主對話被檢索日誌與長報錯淹沒 | 左側 `[Coordinator]` 始終維持高訊噪比，只聚焦架構權衡、任務拆解與驗收拍板。 |
| 多任務平行修改程式碼頻繁互踩 | 修改程式碼自動隔離於獨立 Git Worktree，唯讀排查零拷貝直連主儲存庫，互不衝突。 |
| 反覆切窗巡檢進度、漏看關鍵確認 | 子執行緒收尾自動回傳結構化總結；方案選擇、分支合併與封存統一置頂收口至 **待決策** 佇列，一鍵回應。 |
| 臨時追問或切換模型打斷主線心流 | 點擊執行緒卡片即可於右側展開 1:1 內嵌 **`Preview`** 抽屜，不離開主視窗就能追問、糾偏或換模型。 |

## 核心能力一覽

| 能力模組 | 核心體驗 | 關鍵機制與細節 |
| --- | --- | --- |
| **常駐總控與換綁（`/coord`）** | 主視窗長駐總控專攻決策，支援一鍵換綁與依模式自動封存 | 由 `PreInvocation` / `PreToolUse` / `Stop` 鉤子與 `v14` 協議守護；看板 **`切換總控`** / **`換綁目前`** 平滑遷移活躍執行緒與顯式待決策（防歷史閒置回呼雪崩），舊總控收到退場提示並攔截過期寫入操作；唯讀執行緒回報後可自主封存，Worktree 執行緒待使用者驗收通過後自動封存，並相容一般合併與 `cherry-pick` 清理。 |
| **待決策看板（`manage_decisions`）** | 需人拍板的事項置頂收口，告別翻對話紀錄找待辦 | 總控登記顯式決策卡片並附帶 1–3 個快捷按鈕（`send_coordinator` / `archive_thread` / `dismiss`），聊天直接回覆後自動 `resolve`；自動偵測已提交待合併與已合併/`cherry-pick` 的 Worktree 分支提示，並與同執行緒顯式決策去重。 |
| **雙模平行執行緒（`dispatch_thread`）** | 多任務平行無工作區衝突，全鏈路自動跟隨你的語言 | `createWorktree: true` 自動於 `../.worktrees/<repo>/<thread-slug>` 建立獨立分支檢出；`createWorktree: false` 零拷貝直連主儲存庫唯讀排查；標題、任務提示詞、分析與總結皆自動跟隨目前對話語言。 |
| **Fail-Closed 隔離與非同步感知** | 多專案嚴格隔離、編號直觀連續，杜絕半途誤報完成 | 基於即時 `GetConversation` 中繼資料與 Git 主儲存庫根執行 Fail-Closed 作用域判定，單執行緒 MCP 預設強制檢核作用域；保留 `thr-xxx` 全域主鍵並維護專案內連續 `#1`、`#2`… 序號（支援帶作用域 `#N` 檢索）；識別非同步 `run_command` 背景任務並以原子鎖（`wx`）去重推送完成卡片。 |
| **模型選擇、`inherit` 與遙測** | 依任務精細設定模型與思考深度，即時掌握上下文消耗 | 設定頁與內嵌抽屜提供兩級模型家族 + 思考檔位懸浮選擇器，支援中途切模型與 **`Extra High`** 全鏈路正規化；可分別設定全域/專案級 Worktree 與唯讀預設模型，原生支援 **`inherit`（跟隨總控最近執行模型）**；零額外 RPC 顯示總 Token、壓縮線進度與壓縮次數（支援快取離線日誌回退）。 |
| **Swarm 看板與 1:1 內嵌 `Preview`** | 對齊原生視覺體驗，不切主視窗即可隨時查看與介入 | `--pt-*` 獨立設計權杖、深淺色自適應、`ReadProject` 真實專案名、即時步驟環與自適應「回到總控」按鈕；點擊卡片預設於側欄開啟 1:1 內嵌 **`Preview`** 抽屜（摺疊軌跡樹、檔案行號膠囊、步驟清單與輸入框），同時保留 **`Open ↗`** 彈出至主視窗。 |
| **雙渠道檢查與安全更新器** | 自由切換 `stable` / `dev` 渠道，一鍵升級絕不傷本地改動 | 設定頁內建 **版本與更新** 卡片與頂欄紅點提示；Git 一鍵更新嚴格檢查本地工作區乾淨並僅執行 `--ff-only` 快進（絕不執行 `git reset --hard`）；非 Git 安裝安全引導前往 Releases；內建前後端版本漂移偵測與請求逾時保護。 |
| **共享專案記憶與三語同步** | 架構約定自動同步至每個子執行緒，介面無縫匹配系統語言 | 主儲存庫 `.agents/rules/project-memory.md`（內建預設合併封存規範）自動廣播至所有活躍 Worktree 並經 `.git/info/exclude` 排除提交；介面自動跟隨 Antigravity 全域語言切換 `English / 简体中文 / 繁體中文`。 |

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

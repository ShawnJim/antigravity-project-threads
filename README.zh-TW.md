<div align="center">
  <img src="./assets/logo.svg" width="96" height="96" alt="Project Threads Logo" />

  <h1>Antigravity Project Threads</h1>

  <p>
    管理你的注意力，讓 <strong>Antigravity 2.0 Desktop</strong> 的多 Agent 平行開發井然有序。
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

## 核心亮點

| 亮點 | 帶來的體驗 |
| --- | --- |
| 🧭 **總控專注決策** | 主窗常駐總控專攻拆解與拍板，遠離檢索日誌洗版。 |
| 🌿 **三軌隔離並行** | Worktree 改程式、唯讀零拷貝調研與獨立 Review 模型審查三軌並行。 |
| 📥 **待決策一鍵收口** | 完工自動彙總置頂，支援快捷按鈕一鍵回應或直接輸入自訂指令。 |
| 👀 **內嵌預覽與防卡死** | 側欄 1:1 預覽進度、追問與切模型，背景非阻塞看門狗自動巡檢防卡死。 |
| 🧠 **分層共享記憶** | 多專案獨立 `#N` 隔離，薄索引配按需專題知識庫同步規範且防上下文膨脹。 |
| 🔄 **換綁與安全更新** | 一鍵換綁總控，內建穩定版與開發版雙渠道安全升級。 |

## 核心工作流

<p align="center">
  <img src="./assets/workflow-zh-TW-light.svg#gh-light-mode-only" width="100%" alt="Antigravity Project Threads 核心工作流" />
  <img src="./assets/workflow-zh-TW-dark.svg#gh-dark-mode-only" width="100%" alt="Antigravity Project Threads 核心工作流" />
</p>
<p align="center"><sub>你只管拍板，總控按需派發程式、唯讀與審查三軌並行執行緒，結果自動回流看板一鍵處理。</sub></p>

## 快速開始

> 零外部依賴，直接基於 Antigravity 2.0 內建 Node.js ESM 執行，無需 `npm install`。

```bash
# macOS / Linux（穩定版 main 分支）
mkdir -p ~/.gemini/config/plugins && git clone https://github.com/agy-plugins/project-threads.git ~/.gemini/config/plugins/project-threads
```

```powershell
# Windows PowerShell（穩定版 main 分支）
New-Item -ItemType Directory -Force "$HOME\.gemini\config\plugins" | Out-Null; git clone https://github.com/agy-plugins/project-threads.git "$HOME\.gemini\config\plugins\project-threads"
```

| 1️⃣ 啟用外掛 | 2️⃣ 固定總控 | 3️⃣ 開啟看板 |
| :---: | :---: | :---: |
| 在 **Customizations → Plugins** 中啟用 **Project Threads**。 | 在主對話輸入 `/coord`，固定為常駐專案總控。 | 點擊右上角邊欄 **`+`**，檢視進度、內嵌預覽並處理待決策。 |

<details>
<summary><strong>MCP 工具與底層機制（開發者參考）</strong></summary>

### MCP 總控工具（`project-threads_coordinator`，8 個）

| 工具名稱 | 作用說明 |
| --- | --- |
| `init_project_coordinator` | 將目前工作階段綁定為 `[Coordinator]`，註冊生命週期鉤子並初始化薄索引 `.agents/rules/project-memory.md` 與預設合併規範。 |
| `dispatch_thread` | 透過 `ConversationService` 依 `threadType`（`worktree` / `readonly` / `review`）背景派發隔離 Git Worktree 或零拷貝執行緒，自動套用對應預設模型並按需推薦匹配專題。 |
| `list_threads` | 依專案作用域同步並列出活躍或已封存執行緒，顯示 `#N` / `thr-xxx`、即時 `runState`、步驟進度、Git 狀態與最新摘要。 |
| `get_thread_detail` | 僅局部重新整理並查詢單一執行緒的中繼資料、Git 狀態與總結，支援 `thr-xxx`、專案內 `#N` 或會話 UUID。 |
| `send_thread_message` | 不切走左側總控工作階段，向既有工作執行緒背景傳送追問、糾偏或補充指令。 |
| `archive_thread` | 封存已完成或廢棄的執行緒，並於工作區乾淨且已合併（含 `cherry-pick` 等價提交）時安全移除 Worktree 與分支。 |
| `update_project_memory` | 讀取、列出、附加、重寫或刪除雙層共享記憶：薄索引（`.agents/rules/project-memory.md`，`<= 60` 行）與按需專題（`.agents/memory/<topic>.md`），自動同步至所有活躍 Worktree。 |
| `manage_decisions` | 登記（`add`）、列出（`list`）、解決（`resolve`）或忽略（`dismiss`）置頂於右側看板的 **待決策** 卡片，支援 1–3 個快捷按鈕與自訂指令直接回覆（`custom_reply`）。 |

### 核心機制與工程約定

- **`v17` 協議與總控換綁**：由 `PreInvocation` / `PreToolUse` / `Stop` 鉤子守護；看板 **`切換總控`** / **`換綁目前`** 平滑遷移本專案活躍執行緒與顯式待決策（避免觸發歷史閒置執行緒回呼雪崩），退場舊總控收到提示並攔截過期單執行緒寫入操作。
- **依模式封存與待決策收口**：唯讀與 Review 執行緒回報後可自主封存；Worktree 程式碼執行緒（位於 `../.worktrees/<repo>/<thread-slug>`）保留至使用者驗收通過後自動封存，並相容一般合併與 `cherry-pick` 清理。顯式決策支援 `send_coordinator` / `archive_thread` / `dismiss` 快捷按鈕與內嵌 `custom_reply` 自訂指令回覆（具備冪等認領與解決後 `merge_ready` 回彈抑制），並與 Worktree 自動提示依執行緒去重。
- **雙層共享專案記憶**：將 `.agents/rules/project-memory.md` 保持為常駐薄索引（`<= 60` 行 / `~4KB`），模組細節沉澱至按需 `.agents/memory/<topic>.md` 並於派發時依關鍵字自動推薦。支援存量單檔記憶一鍵無損升級（保留驗證通過的 `legacy` 封存與原子回滾）、受控預設合併規範以及跨程序檔案鎖保護。
- **Fail-Closed 隔離、背景看門狗與步驟追蹤**：基於即時 `GetConversation` 中繼資料與 Git 主儲存庫根執行跨專案隔離（`get_thread_detail` / `send_thread_message` / `archive_thread` 預設強制檢核作用域，除非顯式傳入 `scope: "*"`；專案內 `#N` 檢索須帶前導 `#`）。內建依專案獨立運作的非阻塞背景看門狗（`lib/watchdog.mjs`），巡檢長時卡滯、非同步 `run_command` 任務與狀態失配並支援靜默、冷卻與原子認領去重；子執行緒提示詞聯動 `update_steps` 實現目前輪次即時步驟追蹤。
- **三檔預設模型、遙測與原生預覽**：兩級模型家族 + 思考檔位懸浮選擇器，支援執行緒中途切模型、`Extra High` 全鏈路正規化、三檔獨立預設模型（Worktree / 唯讀 / Review）與原生 **`inherit`（跟隨總控）**；零額外 RPC 顯示 Token 總計、壓縮線進度與壓縮次數（支援快取離線日誌回退）。Swarm 風格看板採用 `--pt-*` 獨立權杖、`ReadProject` 真實專案名、1:1 內嵌 **`Preview`** 抽屜與 **`Open ↗`** 彈出，介面自動跟隨 `English / 简体中文 / 繁體中文`。
- **雙渠道安全更新器**：可於 Sidecar **設定 → 版本與更新** 中切換 **`stable`**（`origin/main` / `vX.Y.Z`）與 **`dev`**（`origin/dev` 先行版）；Git 一鍵更新嚴格檢查乾淨工作區並僅執行 `--ff-only` 快進（絕不執行 `git reset --hard`），非 Git 安裝安全引導前往 Releases，並內建版本漂移偵測與請求逾時保護。

</details>

<details>
<summary><strong>開發版安裝、目錄結構與測試</strong></summary>

### 開發版 / 先行版渠道（`dev`）

乾淨的 Git 安裝可直接於 Sidecar **設定 → 版本與更新** 中切換 **`stable`** / **`dev`**，亦可使用命令列：

```bash
# 直接複製 dev 分支
git clone -b dev https://github.com/agy-plugins/project-threads.git ~/.gemini/config/plugins/project-threads

# 或將既有安裝切換至 dev 分支
cd ~/.gemini/config/plugins/project-threads && git fetch origin && git checkout dev && git pull
```

### 目錄結構

```text
project-threads/
├── plugin.json                 # Antigravity 2.0 外掛清單
├── mcp_config.json             # Coordinator MCP 工具服務宣告
├── hooks.json                  # PreInvocation / PreToolUse / Stop 生命週期鉤子
├── assets/
│   ├── logo.svg                # 向量外掛與儲存庫 Logo
│   └── workflow-*.svg          # 深淺色自適應三語三軌工作流配圖
├── rules/AGENTS.md             # Coordinator 與 Worktree 隔離規則
├── skills/coord/SKILL.md       # /coord 技能工作流指引
├── mcp/server.mjs              # Stdio MCP Server（8 個總控編排工具）
├── scripts/
│   ├── hook-handler.mjs        # 完成擷取、原子去重、舊總控保護與 v17 指令續期
│   └── run-hook.{sh,cmd}       # 跨平台生命週期鉤子啟動封裝腳本
├── lib/
│   ├── ls-client.mjs           # 本地 ConversationService / LanguageServerService 用戶端
│   ├── memory.mjs              # 雙層薄索引、按需專題記憶、併發鎖與存量無損升級
│   ├── model-format.mjs        # 兩級模型目錄、思考檔位格式化與 inherit 解析
│   ├── store.mjs               # 專案隔離註冊表、#N 序號、待決策、換綁與 Worktree 同步
│   ├── transcript.mjs          # 對話日誌解析、非同步任務/步驟偵測與 Token/壓縮遙測
│   ├── updater.mjs             # 雙渠道外掛版本檢查與安全快進本地更新器
│   └── watchdog.mjs            # 依專案獨立非阻塞背景看門狗巡檢與卡滯恢復
├── sidecars/threads/
│   ├── sidecar.json            # Auxiliary Pane Sidecar 檢視設定
│   ├── package.json
│   ├── main.mjs                # 本地 API 服務、版本漂移偵測與無快取靜態資源路由
│   ├── index.html              # Swarm 風格看板、待決策區、設定頁與內嵌聊天抽屜
│   ├── theme.css               # --pt-* 獨立命名空間樣式表（深淺色主題）
│   └── app.js                  # 即時輪詢、待決策、換綁、Preview、模型選擇器、更新器與三語
└── tests/*.test.mjs            # 零依賴 Node.js 自動化測試套件
```

### 執行測試

```bash
node --test tests/*.test.mjs
```

</details>

---

友情連結：[LINUX DO - 新的理想型社區](https://linux.do) | 開源協議：[MIT License](./LICENSE) © 2026 [ShawnJim](https://github.com/ShawnJim)

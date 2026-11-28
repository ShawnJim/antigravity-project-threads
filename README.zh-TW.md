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
| **總控專注決策** | 主窗常駐總控專攻拆解與拍板，遠離檢索日誌洗版。 |
| **隔離平行執行** | 寫程式自動隔離 Worktree，查程式零拷貝互不衝突。 |
| **待決策一鍵收口** | 完工自動彙總，選擇、合併與封存置頂一鍵回應。 |
| **右側內嵌預覽** | 側欄直接 1:1 追問、看進度與切模型，無需切離主窗。 |
| **隔離與共享記憶** | 多專案獨立 `#N` 編號防串線，專案規範自動同步。 |
| **換綁與安全更新** | 一鍵換綁總控，內建穩定版與開發版雙渠道安全升級。 |

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

1. 開啟 Antigravity 2.0，進入 **Customizations → Plugins** 確認已啟用 **Project Threads**。
2. 在主對話輸入 `/coord`，將目前視窗固定為常駐專案總控。
3. 點擊右上角邊欄 **`+`** 開啟 **Project Threads** 看板，在側欄檢視進度、內嵌對話並一鍵處理待決策。

<details>
<summary><strong>MCP 工具與底層機制（開發者參考）</strong></summary>

### MCP 總控工具（`project-threads_coordinator`，8 個）

| 工具名稱 | 作用說明 |
| --- | --- |
| `init_project_coordinator` | 將目前工作階段綁定為 `[Coordinator]`，註冊生命週期鉤子並初始化 `.agents/rules/project-memory.md`。 |
| `dispatch_thread` | 透過 `ConversationService` 背景派發獨立 Git Worktree（`createWorktree: true`）或零拷貝唯讀（`createWorktree: false`）執行緒。 |
| `list_threads` | 依專案作用域同步並列出活躍或已封存執行緒，顯示 `#N` / `thr-xxx`、即時 `runState`、Git 狀態與最新摘要。 |
| `get_thread_detail` | 僅局部重新整理並查詢單一執行緒的中繼資料、Git 狀態與總結，支援 `thr-xxx`、專案內 `#N` 或會話 UUID。 |
| `send_thread_message` | 不切走左側總控工作階段，向既有工作執行緒背景傳送追問、糾偏或補充指令。 |
| `archive_thread` | 封存已完成或廢棄的執行緒，並於工作區乾淨且已合併（含 `cherry-pick` 等價提交）時安全移除 Worktree 與分支。 |
| `update_project_memory` | 讀取、附加或重寫 `.agents/rules/project-memory.md`，並向本專案下所有活躍 Worktree 自動廣播同步。 |
| `manage_decisions` | 登記（`add`）、列出（`list`）、解決（`resolve`）或忽略（`dismiss`）置頂於右側看板的 **待決策** 卡片與 1–3 個快捷按鈕。 |

### 核心機制與工程約定

- **`v14` 協議與總控換綁**：由 `PreInvocation` / `PreToolUse` / `Stop` 鉤子守護；看板 **`切換總控`** / **`換綁目前`** 平滑遷移本專案活躍執行緒與顯式待決策（避免觸發歷史閒置執行緒回呼雪崩），退場舊總控收到提示並攔截過期單執行緒寫入操作。
- **依模式封存與待決策去重**：唯讀執行緒回報後可自主封存；Worktree 程式碼執行緒（位於 `../.worktrees/<repo>/<thread-slug>`）保留至使用者驗收通過後自動封存，並相容一般合併與 `cherry-pick` 清理。顯式決策支援 `send_coordinator` / `archive_thread` / `dismiss` 快捷按鈕，並與 Worktree 自動合併/封存提示依執行緒去重。
- **Fail-Closed 隔離與非同步背景感知**：基於即時 `GetConversation` 中繼資料與 Git 主儲存庫根執行跨專案隔離；`get_thread_detail`、`send_thread_message`、`archive_thread` 預設強制檢核作用域（`coordinatorId` / `workspacePath` / `projectId`），除非顯式傳入 `scope: "*"`；專案內 `#N` 檢索須帶前導 `#`。自動識別執行中的非同步 `run_command` 任務，並經原子鎖（`wx`）去重推送完成卡片。
- **模型選擇、遙測與原生預覽**：兩級模型家族 + 思考檔位懸浮選擇器，支援執行緒中途切模型、`Extra High` 全鏈路正規化、依模式設定預設模型與原生 **`inherit`（跟隨總控）**；零額外 RPC 顯示 Token 總計、壓縮線進度與壓縮次數（支援快取離線日誌回退）。Swarm 風格看板採用 `--pt-*` 獨立權杖、`ReadProject` 真實專案名、1:1 內嵌 **`Preview`** 抽屜與 **`Open ↗`** 彈出，介面自動跟隨 `English / 简体中文 / 繁體中文`。
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
├── assets/logo.svg             # 向量外掛與儲存庫 Logo
├── rules/AGENTS.md             # Coordinator 與 Worktree 隔離規則
├── skills/coord/SKILL.md       # /coord 技能工作流指引
├── mcp/server.mjs              # Stdio MCP Server（8 個總控編排工具）
├── scripts/hook-handler.mjs    # 完成擷取、原子去重、舊總控保護與 v14 指令續期
├── lib/
│   ├── ls-client.mjs           # 本地 ConversationService / LanguageServerService 用戶端
│   ├── model-format.mjs        # 兩級模型目錄、思考檔位格式化與 inherit 解析
│   ├── store.mjs               # 專案隔離註冊表、#N 序號、待決策、換綁與 Worktree 同步
│   ├── transcript.mjs          # 對話日誌解析、非同步任務偵測與 Token/壓縮遙測
│   └── updater.mjs             # 雙渠道外掛版本檢查與安全快進本地更新器
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

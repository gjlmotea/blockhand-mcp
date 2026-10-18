# BlockHand — Minecraft Education 的 MCP server

[English](https://github.com/gjlmotea/blockhand-mcp/blob/main/README.md) | **繁體中文**

![BlockHand：Minecraft Education Edition 的 MCP server](https://github.com/gjlmotea/blockhand-mcp/raw/main/assets/social-preview.png)

BlockHand 讓 AI agent 在 **Minecraft Education Edition** 裡有手也有眼。Claude Code、Codex、Gemini CLI、Grok 或任何 [Model Context Protocol](https://modelcontextprotocol.io) client 都能操控 Agent 機器人、蓋建築、讀方塊、比對區域，並對遊戲事件做出反應。

它只透過 Minecraft Education 內建的 `/connect`（`/wsserver`）WebSocket 指令和遊戲溝通。遊戲裡**不必安裝附加包、行為包、mod 或 Script API**，不注入遊戲行程，也不靠畫面辨識。在學校電腦上，唯一要裝的是 AI client。

- **44 個工具、2 份 resource**：Agent 機器人控制、修改世界、24 種建造形狀、藍圖、讀方塊、區域比對、對稱檢查與事件訂閱。
- **建造快**：形狀會合併成最少的 `/fill` 指令（半徑 8 的實心球從 2,000 多個方塊壓到不到 200 條指令）。
- **預設只在本機**：遊戲 WebSocket 監聽 `127.0.0.1`，除非用 `MINECRAFT_EDU_WS_HOST` 改掉；不需要任何帳號或線上服務。
- **位址固定**：同一台機器上的所有 AI session 共用一個背景中樞，所以遊戲永遠用 `/connect 127.0.0.1:19131` 連線。
- 從原始碼執行時，附 Claude Code、Codex、Gemini CLI 與 Grok CLI 的**安裝器**。

> `/connect` 指令是官方介面。它背後的 WebSocket 訊息協定沒有公開的穩定性保證，遊戲改版後應重新確認行為。

## 目錄

- [快速開始](#快速開始)
- [從原始碼安裝](#從原始碼安裝)
- [工具](#工具)
- [連線與保持連線](#連線與保持連線)
- [建造為什麼快](#建造為什麼快)
- [讀取方塊](#讀取方塊)
- [Undo（預設關閉）](#undo預設關閉)
- [設定](#設定)
- [安全](#安全)
- [疑難排解](#疑難排解)
- [已知限制](#已知限制)
- [開發](#開發)
- [授權與商標](#授權與商標)

## 快速開始

需求：

- Minecraft Education Edition，世界要開啟**作弊（Cheats）**，連線的玩家要有操作員權限。已在 1.26.32 驗證（Windows 桌面版與 macOS 14 以上）。
- 跑 AI client 的機器要有 Node.js 22 以上。

### 1. 在 AI client 註冊 server

Claude Code：

```bash
claude mcp add blockhand --scope user -- npx -y @gjlmotea/blockhand-mcp
```

Codex：

```bash
codex mcp add blockhand -- npx -y @gjlmotea/blockhand-mcp
```

讀 `mcpServers` JSON 設定的 client（Claude Desktop、Cursor、Gemini CLI）：

```json
{
  "mcpServers": {
    "blockhand": {
      "command": "npx",
      "args": ["-y", "@gjlmotea/blockhand-mcp"]
    }
  }
}
```

VS Code 改用最上層的 `servers` 鍵，每個 server 都要寫 `type`：

```json
{
  "servers": {
    "blockhand": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@gjlmotea/blockhand-mcp"]
    }
  }
}
```

各 client 的設定檔位置：

| Client | 設定檔 |
|---|---|
| Claude Desktop | macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`；Windows：`%APPDATA%\Claude\claude_desktop_config.json`。**Settings → Developer → Edit Config** 會開啟它 |
| Cursor | 所有專案共用 `~/.cursor/mcp.json`，單一專案用專案內的 `.cursor/mcp.json` |
| Gemini CLI | `~/.gemini/settings.json`（user）、`.gemini/settings.json`（project） |
| VS Code | 工作區的 `.vscode/mcp.json`，或用 **MCP: Open User Configuration** 指令開啟的使用者 `mcp.json` |

出處：[Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers)、[Cursor](https://cursor.com/docs/context/mcp)、[Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)、[VS Code](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)。

從 Finder 或開始選單啟動的桌面 app 常讀不到 shell 的 `PATH`。server 起不來、只看到含糊的「server not responding」錯誤時，把 `npx` 換成它的絕對路徑（macOS 用 `which npx`，Windows 用 `where npx` 查）。

註冊後重開 AI client。

### 2. 讓遊戲連進來

是遊戲連到 server，不是反過來。

1. 在 Minecraft Education 開一個世界。停在主選單沒有用。
2. 確認作弊已開啟。
3. 在聊天列輸入：

   ```
   /connect 127.0.0.1:19131
   ```

連上時，聊天列會出現一行綠字「✔ BlockHand connected」，語言跟著遊戲：英文、繁體中文或簡體中文，其他遊戲語言用英文（繁體中文的遊戲顯示「✔ 已連上 BlockHand」）。也可以請 AI 呼叫 `mc_status`，它會回傳確切的 `connectCommand`。

### 3. 提出要求

> 在我前面蓋一顆半徑 6 的空心玻璃球。

> 召喚 Agent，讓它往前走五格，種一排小麥。

> 檢查 0 64 0 到 20 80 20 那棟房子是不是鏡像對稱，告訴我哪些方塊破壞了對稱。

## 從原始碼安裝

要開發 BlockHand 本身，或想用安裝器與 `doctor` 檢查時，走這條路。

```bash
git clone https://github.com/gjlmotea/blockhand-mcp.git
cd blockhand-mcp
corepack pnpm install --frozen-lockfile
corepack pnpm run build
```

用其中一支安裝器註冊：

```bash
corepack pnpm run setup:claude    # 或 setup:codex / setup:gemini / setup:grok
corepack pnpm run doctor          # 加 --client=claude 等可檢查其他 client
```

安裝器不只是寫入一筆設定：

- 會填入這台機器 Node 的絕對路徑，讓讀不到 nvm、Homebrew 或 shell `PATH` 的桌面 app 也能啟動 server。
- 改任何設定之前，先用即將保存的 command、引數與環境變數實際跑一次 MCP `initialize`，確認 44 個工具都在。
- server 已正確註冊時什麼都不做，所以重跑是安全的。
- 已有同名但內容不同的項目時，停下來列出差異，不覆蓋別人的設定。
- 只透過各 client 官方的 `mcp add`／`mcp remove` 指令寫入，從不直接改設定檔。

移除用 `corepack pnpm run uninstall:claude`（或 `uninstall:codex` 等）。無法確認屬於這份 clone 的項目，它拒絕移除。

| Client | 寫入 | 之後 |
|---|---|---|
| Codex | `~/.codex/config.toml` | 完全退出再重開；桌面 app、CLI 與 IDE 共用這份設定 |
| Claude Code | `~/.claude.json`（user scope） | 重開 session |
| Gemini CLI | `~/.gemini/settings.json`（user scope） | 重開 CLI |
| Grok CLI | `~/.grok/config.toml` | 重開 CLI |

要手動註冊時，讓 client 執行 `<NODE> <REPO>/dist/index.js`：`<NODE>` 是 `node -p "process.execPath"` 印出的絕對路徑，`<REPO>` 是這份 clone 的絕對路徑。兩個 client 的特性：Gemini CLI 的 command 與引數是位置參數，不加 `--`，而且預設 scope 是 project（要全域可用請加 `--scope user`）。Claude Code 的預設 scope 是 local；`--scope project` 會寫出可分享的 `.mcp.json`，整班共用時很方便。

## 工具

### 連線與後備（6）

| 工具 | 用途 |
|---|---|
| `mc_status` | 橋接狀態、`/connect` 指令、已訂閱的事件、指令計數。任何失敗都先查這個 |
| `mc_await_connection` | 等遊戲連進來（每次呼叫最多 120 秒） |
| `mc_run_command` | 送一條原始 slash 指令，沒有專用工具時用 |
| `mc_run_commands` | 依序送多條原始指令 |
| `mc_undo_control` | 查看、清除或設定單步 Undo（預設關閉） |
| `mc_undo` | 先檢查有沒有衝突的修改，再復原上一筆受保護的建造 |

### Agent 機器人（10）

| 工具 | 用途 |
|---|---|
| `mc_agent_create` | 召喚 Agent |
| `mc_agent_move` | 往一個方向走 N 格 |
| `mc_agent_turn` | 向左或向右轉 90 度 |
| `mc_agent_teleport` | 把走丟的 Agent 叫回玩家身邊 |
| `mc_agent_act` | 攻擊、破壞或耕地，可重複 |
| `mc_agent_place` | 從背包格放置方塊 |
| `mc_agent_collect` | 撿起掉落物 |
| `mc_agent_inventory` | 數量、剩餘空間、物品細節、丟出、全部丟出、轉移 |
| `mc_agent_sense` | 檢視、檢視資料、偵測、偵測紅石：Agent 的眼睛 |
| `mc_agent_program` | 一次呼叫送出一整段動作，逐步回報結果 |

Agent 的方向是相對它自己面向的方向，不是東南西北。

### 世界（13）

`mc_set_block`、`mc_fill`、`mc_clone`、`mc_test_block`、`mc_read_block`、`mc_verify_reading`、`mc_compare_regions`、`mc_analyze_symmetry`、`mc_query_target`、`mc_summon`、`mc_world_settings`（時間、天氣、遊戲規則、難度）、`mc_structure`（存讀結構）、`mc_ticking_area`。

`mc_query_target` 會解析 `querytarget` 回傳的 JSON。建造前要知道玩家或 Agent 在哪裡，就用它。

`mc_compare_regions` 用一條 `testforblocks` 比對兩塊區域。它的 `masked` 模式忽略來源裡的空氣，用來檢查學生的建築該有的東西是不是都在，不管周圍還多了什麼。

`mc_analyze_symmetry` 檢查一塊區域是否鏡像對稱，不對稱時指出哪些格子不同。做法是存下區域、把鏡像副本載入暫存區、比對，最後還原暫存區。暫存區不能與分析區重疊，這在送出任何指令之前就會檢查。暫存區備份失敗時，什麼都不會放置。

`mc_structure` 預設存在記憶體（關掉遊戲就消失）。只有使用者要求保留結構時才用 `saveMode: "disk"`，它會寫進世界資料夾。遊戲沒有列出已存結構的指令，所以 `mc_status` 會列出本次 session 存過的名稱。

### 玩家與回饋（7）

`mc_teleport`、`mc_give`、`mc_gamemode`、`mc_effect`、`mc_player_action`（kill、clear、xp、ability）、`mc_message`（say、tell、title、subtitle、action bar）、`mc_feedback`（音效與粒子）。

### 建造（4）

| 工具 | 用途 |
|---|---|
| `mc_build_preview` | 只規劃：方塊數、邊界盒、`/fill` 批次數 |
| `mc_build_shape` | 24 種幾何形狀，多數支援空心 |
| `mc_blueprint_preview` | 預覽逐格藍圖 |
| `mc_build_blueprint` | 用「座標 → 方塊」清單蓋任意形狀，相同的方塊會合併 |

| 群組 | 形狀 |
|---|---|
| 實體 | `box`、`sphere`、`ellipsoid`、`cylinder`、`cone`、`pyramid`、`prism` |
| 線與面 | `line`、`curve`（平滑曲線）、`disk`、`tube`（任意方向的圓柱） |
| 建築構件 | `wedge`（單斜面）、`roof`（人字或四坡屋頂）、`arch`、`stairs`、`spiralStairs`、`polywall`（折線牆） |
| 地形與路徑 | `heightfield`（起伏地面）、`ribbon`（道路或橋面） |
| 裝飾 | `torus`、`helix`、`cross`、`star`、`revolution`（旋轉體） |

有 24 種形狀時，真正的風險是 AI 選錯：選錯不會失敗，只會蓋出看似合理但不對的東西。所以工具說明依「想蓋什麼」組織，並把最常混淆的幾組寫明：

| 你要的 | 用 | 不要用 |
|---|---|---|
| 斜的柱子、樑、管線 | `tube` | `cylinder`（只能對齊座標軸） |
| 有尖角的牆 | `polywall` | `curve`（會把轉角磨圓） |
| 有屋脊的屋頂 | `roof` | `wedge`（只有一面斜坡） |
| 繞塔而上的樓梯 | `spiralStairs` | `helix`（沒有踏面）或 `stairs`（直的） |
| 往上漸縮的塔或煙囪 | `cone`／`pyramid` 加 `topRadius` | 疊好幾個 `box` |
| 圓頂、花瓶、冷卻塔 | `revolution` 加一條輪廓 | 每種物件各加一個形狀 |
| 起伏的地面 | `heightfield` | 很多個 `box` |

幾個容易讀錯的參數：`prism` 與 `pyramid` 的 `radius` 是中心到邊的距離，不是到頂點；`roof` 的 `ridgeAxis` 是屋脊延伸的方向，不是坡面朝向；`heightfield` 的四角數值是厚度（幾格）；`arch` 畫的是拱圈本身，開口（寬 2 × radius − 1）在中間。

### 事件（4）

`mc_events_catalog`、`mc_events_subscribe`、`mc_events_unsubscribe`、`mc_events_poll`。

事件進入環形緩衝，用游標讀取。`dropped > 0` 代表輪詢太慢，有些事件遺失了。重新連線後會自動恢復訂閱。已知的事件名稱包括 `PlayerMessage`、`BlockPlaced`、`BlockBroken`、`ItemAcquired`、`ItemCrafted`、`MobKilled`、`PlayerTravelled`、`AgentCommand` 等（見 `mc_events_catalog`）。事件只在事情真的發生時觸發：`BlockPlaced` 在玩家親手放方塊時才送出，`/setblock` 與 `/fill` 不算。

### Resource（2）

`minecraft-edu://connection`（即時連線狀態）與 `minecraft-edu://capabilities`（橋接能做與不能做的事）。

## 連線與保持連線

同一台機器上的所有 AI session（桌面 app、CLI、IDE、平行任務）共用一個背景**中樞**，由它持有 19131 埠與唯一的遊戲連線。每個 session 的 MCP server 只是轉給它的薄代理。第一個需要中樞的 session 會把它叫起來；每個開著的 session 每分鐘報到一次，所以只要還有 session 開著，19131 就一直有人接，中樞意外結束也會立刻重開。最後一個 session 與遊戲都離開約 10 分鐘後，中樞才結束。

- 換 session、換模型或換 AI 工具，都不會斷開遊戲連線。
- 正常載入時，`/reload all` 和換到別的世界也不會斷線。回到主選單時連線還在，但每條指令都會回「不明的指令」（Unknown command）。
- 只有重開 Minecraft 後，或中樞那端關閉連線（聊天列顯示連線已關閉）時，才要重打 `/connect`。
- **已經連著時不必再打 `/connect`。** 再打一次什麼都不會顯示，看起來像卡住；打字和指令都照常運作。
- `mc_run_command` 可以送 `reload all`。開發包的腳本與行為包 JSON 用這個方式就會重載；資源包只有玩家在聊天列打 `/reload all` 才會重載。等世界載完再送其他指令。載入卡住時，橋接每 30 秒的保活探測照常送出，連續三次沒回應，橋接就會關閉連線。
- 如果 19131 已被不支援中樞的舊版 BlockHand 佔住，新 session 會退回獨立模式、改用隨機埠；請用 `mc_status` 回報的位址。獨立模式絕不自己佔用 19131。

要快速重連：在遊戲裡按 `T`，按 `↑` 叫回上一條指令，再按 Enter。

## 建造為什麼快

每個方塊送一條 `setblock` 的話，一顆中等大小的球就要上萬次 WebSocket 往返。BlockHand 的管線是：

```
形狀參數 → 在邊界盒內做 inside() 判定 → 方塊座標集合
  → 沿 X 合併連段 → 沿 Z 合併矩形 → 沿 Y 合併方塊（三階段 greedy）
  → 依 /fill 單次 32,768 格的上限拆批
  → 送出
```

合併是決定性的，測試釘住合併後的批次覆蓋的方塊集合與原始集合完全相同，不多也不少。空心形狀一律來自同一套「內部判定加外殼鄰居測試」，所以新增形狀只需要一個 `inside()` 函式。`tests/domain/fill-efficiency.test.ts` 為每個形狀設定「fill 指令數 ÷ 方塊數」的上限。

非常大的地形工程，請自己算座標，用 `mc_run_commands`（每次 200 條）送大量 `/fill`，或寫成 `.mcfunction` 檔用 `/function` 執行。相關上限見 [agents/docs/large-builds.md](https://github.com/gjlmotea/blockhand-mcp/blob/main/agents/docs/large-builds.md)。

## 讀取方塊

Minecraft Education 沒有直接回傳某個位置是什麼方塊的指令，所以讀取有先天限制：

- `mc_test_block` 是是非題：你得先猜一個方塊 ID。
- `mc_read_block` 不必猜。它先問那格是不是空氣，答案是否定時，遊戲的錯誤訊息會說出實際的方塊。結果是在地化的顯示名稱（「泥土」），不是方塊 ID（`dirt`）。
- 訊息解析不出來時，`mc_read_block` 回錯誤，絕不回 `block: null` 的成功回應。使用者是 AI，而 AI 看到成功的 `null` 會很有把握地把那格當成空地，可能蓋掉學生的作品。
- `mc_verify_reading` 最多用兩條唯讀指令檢查解析是否仍然有效。遊戲更新後、換了遊戲語言（支援繁體中文、簡體中文、英文）後，或 `mc_read_block` 開始對看得到的方塊回錯誤時，就跑它。突變測試確保解析規則被改壞時，探測與解析器的測試會轉紅。

要逐格讀整片區域得靠行為包與 Script API，BlockHand 刻意不走那條路，好讓學校電腦不必多裝東西。

## Undo（預設關閉）

> 自動 Undo **預設關閉**。在 Minecraft Education 1.26.32（macOS）上，Undo 在第一次小型建造前送出的原生整區檢查（`body.version=25`）一直沒有回覆；之後這條連線上的每條指令都逾時，連玩家在聊天列打的字也一樣，只有重開 Minecraft 才恢復。這個情形重現了三次。只有在接受這個風險時，才用 `MINECRAFT_EDU_UNDO_ENABLED=1` 或 `mc_undo_control` 的 `configure enabled=true` 開啟。設計說明：[agents/docs/undo/region-undo.md](https://github.com/gjlmotea/blockhand-mcp/blob/main/agents/docs/undo/region-undo.md)。

開啟後，Undo 保留一個最多 4,096 格的操作，用 `structure save ... memory` 快照在遊戲記憶體裡（不寫磁碟）。沒有 Redo。它涵蓋主世界、絕對整數座標與基本靜態建材；不支援的建造會在任何改動之前被拒絕。

## 設定

全部都有預設值，不需要 `.env` 檔。

| 變數 | 預設 | 說明 |
|---|---|---|
| `MINECRAFT_EDU_WS_HOST` | `127.0.0.1` | 遊戲 WebSocket 的監聽位址；預設只綁 loopback（見[安全](#安全)）。中樞的控制埠一律監聽 `127.0.0.1` |
| `MINECRAFT_EDU_WS_PORT` | `19131` | 遊戲連進來的埠。預設值使用共用中樞；其他值（例如 `0`）會跑一條隔離的獨立橋接 |
| `MINECRAFT_EDU_HUB` | 自動 | `0` 停用中樞（每個 session 各一條橋接）；`1` 在自訂埠上也強制使用中樞 |
| `MINECRAFT_EDU_HUB_PORT` | `19132` | session 連中樞用的本機控制埠，同時是決定哪個行程當中樞的鎖 |
| `MINECRAFT_EDU_HUB_DIR` | `~/.blockhand` | 中樞狀態檔 `hub.json`（含中樞的存取 token）與日誌 `hub.log` 的資料夾；見[安全](#安全) |
| `MINECRAFT_EDU_HUB_IDLE_MS` | `600000` | 沒有 session 報到、遊戲也沒連著超過這段時間，中樞就結束 |
| `MINECRAFT_EDU_HUB_ATTACH_MS` | `8000` | session 等剛叫起來的中樞回應的時間（500–60,000 毫秒）；逾時沒回應時，該 session 改在隨機埠跑獨立橋接 |
| `MINECRAFT_EDU_CONNECT_NOTICE` | 開 | 在聊天列顯示綠字「✔ BlockHand connected」，語言跟著遊戲（先送一條唯讀的 `time query daytime` 判斷）；`0` 關閉 |
| `MINECRAFT_EDU_WS_PORT_FALLBACK` | `1` | 優先埠被佔用時改用空閒埠；`0` 則直接失敗 |
| `MINECRAFT_EDU_ENCRYPTION` | 開 | 遊戲連上時嘗試 WebSocket 加密握手；沒有協商成功就以明文繼續。`0` 略過握手 |
| `MINECRAFT_EDU_COMMAND_TIMEOUT_MS` | `10000` | 單一指令等遊戲回應的時間 |
| `MINECRAFT_EDU_KEEPALIVE_INTERVAL_MS` | `30000` | 閒置時保活探測（`time query daytime`）的間隔；連續三次探測沒回應就關閉連線 |
| `MINECRAFT_EDU_EVENT_BUFFER` | `500` | 事件環形緩衝的大小 |
| `MINECRAFT_EDU_MAX_BUILD_BLOCKS` | `40000000` | 單次建造的方塊數上限；非實心形狀另受 8,000,000 格掃描體積限制 |
| `MINECRAFT_EDU_UNDO_ENABLED` | `0` | `1` 開啟自動單步 Undo（見上方警告） |
| `MINECRAFT_EDU_UNDO_MAX_BLOCKS` | `4096` | Undo 預算，1–32,768 格，最多 64 個區域 |
| `MINECRAFT_EDU_STEP_DELAY_MS` | `100` | Agent 程式每步之間的預設間隔 |
| `MINECRAFT_EDU_DEBUG_FRAMES` | 未設 | `1` 把遊戲傳來的每個原始訊框印到 stderr |

## 安全

- 遊戲 WebSocket 預設只監聽 `127.0.0.1`，`MINECRAFT_EDU_WS_HOST` 可以改這個位址。遊戲埠不驗證連線，而且新連線會取代目前的連線，所以改成其他位址時，任何連得到那個位址的機器都能取代遊戲連進來。中樞的控制埠（`MINECRAFT_EDU_HUB_PORT`，預設 `19132`）一律只監聽 `127.0.0.1`。BlockHand 本身不連網際網路。
- 共用中樞會在 `~/.blockhand`（或 `MINECRAFT_EDU_HUB_DIR`）留兩個檔。中樞關閉時（`MINECRAFT_EDU_HUB=0`，或自訂 `MINECRAFT_EDU_WS_PORT` 而沒有設 `MINECRAFT_EDU_HUB=1`），兩個檔都不寫。
  - `hub.json`：中樞的行程 ID、埠號、build ID、啟動時間與一組隨機的存取 token。中樞每次啟動都產生新 token，結束時刪除這個檔。控制埠的每個請求都必須以 bearer token 附上它；各 session 從這個檔讀 token 來連中樞。資料夾以 `0700`、檔案以 `0600` 權限建立。Node.js 在 Windows 上無法設定擁有者／群組／其他人的權限，所以這些權限只在 macOS 與 Linux 生效。
  - `hub.log`：中樞帶時間戳記的日誌。新中樞啟動時若日誌超過 1 MiB，會改名為 `hub.log.1`。設了 `MINECRAFT_EDU_DEBUG_FRAMES=1` 時，遊戲傳來的每個原始訊框也會記在這裡。
- 除了這兩個檔，server 不在主機上寫任何東西。`mc_structure` 用 `saveMode: "disk"` 時，是遊戲把結構寫進它的世界資料夾；工具回覆會說明寫到哪裡。
- 不涉及任何線上服務的帳號或憑證；中樞 token 只用來保護本機控制埠。
- `mc_run_command` 接受 slash 指令，而 slash 指令只作用在本機的遊戲世界裡。它的閘門是結構性的，不是關鍵字黑名單：
  1. 只允許單行。換行與 NUL 一律拒絕，一個請求不能變成兩條指令。
  2. 會切斷或轉向橋接的指令一律拒絕：`wsserver`、`connect` 與 `closewebsocket`，包在 `execute` 裡也一樣。
  3. 其餘指令標記為 `read-only`、`world-write` 或 `wide-effect`，讓 MCP host 能依工具 annotation 決定要不要請使用者確認。
- 要放進指令列的方塊 ID、選擇器與狀態字串，都先比對白名單樣式，所以無法用空白夾帶額外參數。
- 共用中樞上，一次只有一個 AI session 能修改世界。第二個 session 的寫入類工具會立刻被拒絕並附上清楚的訊息；唯讀工具不受影響。

## 疑難排解

**玩家說聊天列沒反應。** 先別重開遊戲，依序檢查：

1. 遊戲畫面顯示什麼（在世界裡、主選單，還是載入畫面）。
2. `mc_status`：`commandState: "timed-out"` 代表橋接自己的指令也沒有得到回應。
3. 訂閱 `PlayerMessage`，請玩家打一句字。玩家聊天會產生 `type: "chat"` 事件。收不到不能單獨當證據，因為訂閱不會得到遊戲確認；要和畫面對照。
4. `~/.blockhand/hub.log` 的最後幾行（每行都有時間戳記，被拒絕的握手也會記錄）。

`time` 這類內建指令回「不明的指令」（Unknown command）時，工具會附上提示：遊戲多半不在世界裡。

**`mc_status` 顯示 19131 以外的埠。** 有別的行程佔著 19131。用 `lsof -nP -iTCP:19131 -sTCP:LISTEN`（macOS）找出它，用 `ls ~/.blockhand` 確認中樞有沒有在跑。

**Windows 的 Microsoft Store（UWP）版。** Windows 的應用程式隔離會擋下 loopback 連線。用 `CheckNetIsolation LoopbackExempt` 加上豁免。

**大型建造被截斷。** MCP client 通常約 60 秒就讓請求逾時，而工具還在繼續送 fill。先用 `mc_build_preview` 看 `fillBatches`，把大型建造拆開。

## 已知限制

- **遊戲傳回的文字維持遊戲語言。** 工具描述、server instructions 與錯誤訊息是英文，但遊戲自己回的內容（`statusMessage`，以及 `mc_read_block` 讀到的方塊名稱）是遊戲語言。
- 世界必須開啟作弊，否則遊戲會拒絕每一條指令。
- Agent 只有 Education Edition 才有。
- 事件名稱與 `agent` 子指令沒有 Mojang 的正式文件，來自公開觀察，遊戲更新後可能改變。`mc_events_subscribe` 接受已知清單以外的名稱，但會標記為未驗證。
- 經 WebSocket 送出的指令不一定能解析 `@s`，所以 `mc_query_target` 預設用 `@p`。
- 有些回應帶的請求 ID 對不上任何請求。只有一個請求在等待、而且這條連線還沒發生過逾時時，橋接可以推斷歸屬並記錄下來；發生任何逾時之後，只接受精確對應的回應。修改類指令從不自動重送。
- 指令一次送一條，排隊上限 64 條；超過的以 `command-queue-full` 拒絕。在佇列裡等過自己逾時期限的指令會被丟棄，並回報為未送出。
- 重新 build 之後，執行中的中樞要等它重開才換成新版；中樞重開會中斷遊戲連線。

## 開發

```bash
corepack pnpm run verify   # 型別檢查、測試、build、stdio smoke、共用中樞 smoke
corepack pnpm run live     # 對執行中的遊戲做端到端檢查（會印出要輸入的 /connect）
```

`live` 依序走過：連線、讀玩家座標、聊天、設定時間、召喚 Agent、感測、走 L 形路徑、預覽並蓋一顆空心玻璃球、驗證方塊、合併藍圖、接收事件、測試指令閘門、清除。對 `node scripts/live-check.mjs` 加 `--keep` 可保留示範建築。

```
src/
  domain/          純邏輯，不依賴 MCP、ws 或 Node
    commands.ts            slash 指令建構器與防注入白名單
    command-policy.ts      原始指令的結構性閘門
    build/shapes.ts        24 種形狀：inside() 加外殼鄰居測試
    build/fill-planner.ts  三階段 greedy 合併與拆批
    build/undo-plan.ts     Undo 區域、預算與原生整區檢查
  adapters/ws-minecraft-connection.ts   WebSocket server、請求對應、事件、重連
  application/     服務：Agent 程式、querytarget 解析、建造、Undo
  hub/             共用中樞、session 代理、跨 session 寫入鎖
  server/          MCP server、schema 與各工具
  composition.ts   組裝；測試時可注入假連線
  index.ts         stdio 進入點
```

領域層完全不知道 WebSocket 的存在，所以整條 MCP 工具管線不必開遊戲，用記憶體內的假件就能測。

## 授權與商標

[MIT](https://github.com/gjlmotea/blockhand-mcp/blob/main/LICENSE)。

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.（非 Minecraft 官方產品，未經 Mojang 或 Microsoft 核准，也與兩者無關。）Minecraft 與 Minecraft Education 是 Mojang Studios 與 Microsoft 的商標。BlockHand 是獨立的開源專案。

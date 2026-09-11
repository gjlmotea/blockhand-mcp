# BlockHand（積木之手）— Minecraft Education MCP

讓 AI 在 Minecraft Education Edition 裡長出手腳：**動作**（Agent 走位、挖掘、放置、耕種、搬運）、**眼睛**（感測方塊、查詢座標、訂閱遊戲事件）、**造物**（二十四種幾何形狀與逐格藍圖）。

透過 Minecraft Education 官方文件化的 `/wsserver` 連線命令（`/connect` 是 alias）操作，不注入行程、不改遊戲檔案、不用畫面辨識。連線命令是官方介面；後續 WebSocket 訊息協定並沒有公開穩定性保證，因此遊戲改版後仍需重新驗證。

- 42 個工具、2 份 resource
- 216 項單元與整合測試、1 支不需開遊戲的 stdio／程序生命週期 smoke、1 支真機 live 驗證
- 不需要任何帳號、token 或祕密；MCP runtime 只綁 loopback，不寫遊戲檔或 artifact

---

## 1. 三步上手

### 步驟一：在每台機器安裝與建置

```bash
cd /你的路徑/minecraft-edu
corepack pnpm install --frozen-lockfile
corepack pnpm run build
```

Node 必須是專案 `.nvmrc` 指定的 **22.23.1**，pnpm 由 Corepack 固定為 **11.17.0**。Windows 與 Mac 都要在本機安裝依賴；不要把另一個作業系統的 `node_modules` 複製過來。Minecraft Education 目前在 Mac 的最低需求是 **macOS 14**。

### 步驟二：在該機登記一次 MCP

支援 **Codex／Claude Code／Gemini CLI／Grok CLI**，Windows 與 macOS 皆同。

#### 先取得兩個絕對路徑

註冊時**必須用絕對路徑**，不能只寫 `node`。桌面版 AI 工具是由 Finder／檔案總管啟動的，讀不到你 shell 裡的 nvm、Homebrew 或 PATH；寫 `node` 在終端機測得過，換成桌面版就會啟動失敗，而且錯誤訊息通常只說「server 沒回應」，很難查。

macOS：

```bash
node -p "process.execPath"   # Node 絕對路徑
pwd                          # 專案絕對路徑（在 minecraft-edu 目錄下執行）
```

Windows（PowerShell）：

```powershell
node -p "process.execPath"
(Get-Location).Path
```

下面用 `<NODE>` 代表 Node 絕對路徑、`<REPO>` 代表專案絕對路徑。伺服器進入點固定是 `<REPO>/dist/index.js`（Windows 寫成 `<REPO>\dist\index.js`）。路徑含空白時整段要加引號。

#### 用安裝器（四家都支援，建議）

```bash
corepack pnpm run setup:codex     # 或 setup:claude / setup:gemini / setup:grok
corepack pnpm run doctor          # 加 --client=claude 等可診斷其他家
```

安裝器不是只把指令寫進設定檔，它會：

- **自動填入這台機器的絕對 Node 路徑**，不依賴桌面程式能否讀到 nvm、Homebrew 或 shell PATH。
- **先跑一次真正的 MCP initialize**（用即將寫入的 command／args／env），確認 42 個工具都在，才動任何持久設定。舊 dist、錯誤 launcher、不可執行的 Node 都會在寫入之前就失敗。
- **已正確登記時什麼都不做**，重跑安全。
- **同名但不相容時停下並列出差異**，不自動 remove/add，避免覆寫別人的 timeout、tool policy 或另一個 clone 的設定。
- **只透過各家官方 `mcp add`／`mcp remove` 子指令寫入**，不手改設定檔——那會繞過各家自己的 schema 驗證與 scope 解析。

移除用 `corepack pnpm run uninstall:codex`（或 `uninstall:claude` 等）。同樣有防誤刪：不是這份工作樹可辨識的 entry 就拒絕。

各家寫入位置與重啟需求：

| Client | 寫入 | 之後 |
|---|---|---|
| Codex | `~/.codex/config.toml` | 完全退出並重啟；桌面版／CLI／IDE 共用 |
| Claude Code | `~/.claude.json`（user scope） | 重開 session |
| Gemini CLI | `~/.gemini/settings.json`（user scope） | 重開 CLI |
| Grok CLI | `~/.grok/config.toml` | 重開 CLI |

> 讀取策略有差異：Codex 與 Grok 有 `mcp list --json`，直接用機器可讀輸出。Claude Code 與 Gemini 的 `list` 只有人類可讀文字且不含 env，無法據以判斷相容性，所以改**唯讀**它們官方 CLI 剛寫入的設定檔。寫入永遠走 CLI。

#### 手動指令（不想用安裝器時）

指令等價，但**絕對路徑要自己填**，也沒有前置的 initialize 驗證與覆寫保護。

```bash
codex  mcp add minecraft-edu --env MINECRAFT_EDU_WS_PORT=19131 -- <NODE> <REPO>/dist/index.js
claude mcp add minecraft-edu --scope user --env MINECRAFT_EDU_WS_PORT=19131 -- <NODE> <REPO>/dist/index.js
gemini mcp add minecraft-edu <NODE> <REPO>/dist/index.js --scope user --env MINECRAFT_EDU_WS_PORT=19131
grok   mcp add minecraft-edu --scope user --env MINECRAFT_EDU_WS_PORT=19131 -- <NODE> <REPO>/dist/index.js
```

三個容易踩的差異：

- **Gemini 的 command 與 args 是位置參數**，接在名稱後面，**沒有** `--` 分隔。
- **Gemini 的預設 scope 是 project**，要全域可用必須明寫 `--scope user`。
- **Claude 的預設 scope 是 local**（只在目前目錄生效）；`--scope project` 會寫進專案根的 `.mcp.json`，可隨 repo 分享，**整班共用時用這個**。

#### 手動編設定檔（安裝器失效時的後備）

Claude Code 與 Gemini CLI 用 JSON：

```json
{
  "mcpServers": {
    "minecraft-edu": {
      "command": "<NODE>",
      "args": ["<REPO>/dist/index.js"],
      "env": { "MINECRAFT_EDU_WS_PORT": "19131" }
    }
  }
}
```

Codex 與 Grok CLI 用 TOML：

```toml
[mcp_servers.minecraft-edu]
command = "<NODE>"
args = ["<REPO>/dist/index.js"]
env = { MINECRAFT_EDU_WS_PORT = "19131" }
```

#### Windows 補充

- Node 絕對路徑通常是 `C:\Program Files\nodejs\node.exe`，用 nvm-windows 則像 `C:\Users\<你>\AppData\Roaming\nvm\v22.23.1\node.exe`。
- JSON 設定檔裡的反斜線要跳脫：`"C:\\Program Files\\nodejs\\node.exe"`。TOML 可以改用單引號字面字串：`command = 'C:\Program Files\nodejs\node.exe'`。
- Minecraft Education 若是 Microsoft Store 的 UWP 版，loopback 會被 Windows 應用程式隔離擋住，需要額外的 `CheckNetIsolation LoopbackExempt` 豁免（見第 8 節）。

#### 登記後

**完全退出並重啟該 AI 工具**——桌面版要真的結束程式，不是關掉視窗。然後用 doctor 確認（不碰 Minecraft、不改設定）：

```bash
corepack pnpm run doctor
```

它會檢查 Node 版本、build 產物、平台需求、登記狀態，並用**實際登記的** command／args／env 再跑一次 MCP initialize，避免設定指向失效 Node 卻假綠。加 `--json` 可得結構化輸出。也可以直接問各家 CLI：

```bash
codex mcp list
claude mcp list
gemini mcp list
grok mcp list
```

或直接叫 AI 呼叫 `mc_status`，能回傳 `connectCommand` 就代表 server 起得來。

**每台機器都要各自登記一次**：Windows 筆電、Mac、另一台電腦的 Node 與專案絕對路徑都不同，不能互相複製設定。同一台機器上，同一個工具的桌面版／CLI／IDE 共用同一份設定。

### 步驟三：在遊戲裡手動連進來

```bash
corepack pnpm run connect
```

這個相容入口只顯示操作方式，**不會**開 Minecraft、不會切換前景視窗，也不會模擬鍵盤。Windows PowerShell 自動輸入功能已移除；Mac 也不加入 AppleScript 自動化。

**方向很容易搞反：遊戲是連出來的一方，MCP server 是被連的一方。**

1. 在目前的 AI 對話中呼叫 `mc_status`，複製它回傳的 `connectCommand`。
2. 開 Minecraft Education，**進入一個世界**（停在主選單沒有用）。
3. 世界必須開啟 **Cheats**，操作者需有 Admin／OP 權限。
4. 在聊天列手動輸入，例如：

```
/connect 127.0.0.1:19131
```

看到 `Connection established` 就完成了。之後對 AI 說「幫我在前面蓋一顆空心玻璃球」即可。

**要重連時不必重打整串**：在聊天列按 `T` 開啟，再按 `↑` 叫回上一條指令，然後 Enter。

> 早期版本有一個「閒置約 60 秒必斷線」的 bug：心跳只認 WebSocket pong frame，但 Bedrock／Education 的客戶端從不回 pong，導致健康的連線被自己的心跳終止。現已修正（改以任何進來的封包判定活性，並輔以應用層探測），閒置不應再造成斷線。若仍會斷，先確認你跑的是重新 build 過的 `dist/`。

不要固定背 19131：桌面版、CLI、IDE 或多個 task 同時啟動時，後開的 MCP 可能取得不同空閒埠。永遠使用**目前要操作的那個 task**回報的指令。

---

## 2. 真機驗證

先做不開遊戲的安全診斷：

```bash
corepack pnpm run doctor
# 機器可讀版本
corepack pnpm blockhand doctor --json
```

doctor 不修改持久設定、不啟動 Minecraft；它會短暫建立隔離的 loopback socket，驗證 launcher、42 tools、2 resources、stdio EOF、監聽埠釋放，並以 Codex **實際登記的 command／args／env** 再完成一次 initialize，避免設定指向失效 Node 卻假綠。

遊戲開著、世界已載入、作弊已開之後：

```bash
cd gjlmotea/vibe/mcp/minecraft-edu && corepack pnpm run live
```

腳本會印出要輸入的 `/connect`，等你連上，然後走完一條完整路徑並逐項回報 PASS／FAIL：連線 → 讀玩家座標 → 遊戲內發話 → 設定時間 → 召喚 Agent → 感測 → 走 L 形路徑 → 預覽建造 → 蓋空心玻璃球 → 回頭驗證方塊真的存在 → 藍圖合併 → 訂閱並收事件 → 政策閘門 → 清除示範建築。

### 遊戲改版之後

讀方塊（`mc_read_block`）靠的是 `testforblock` **失敗訊息的文字格式**，那個格式沒有任何官方穩定性保證。Minecraft Education 默默自動更新改了文案、或遊戲語言換成不是繁中／簡中／英文，這條路就會失效。

**失效的樣子是安靜的**：工具不會壞掉，只會開始說「讀不出來」。所以本專案**刻意不把它做成每次 live 都跑的例行檢查**——例行檢查會養成看到綠燈就放心的習慣，而真正需要判斷的時機是「行為變得可疑的當下」，不是每週固定跑的那一次。

改成在需要時主動判斷：

```
mc_verify_reading  { position: 任一座標 }
```

它最多送兩條指令、完全不寫入世界，回傳 `parseable`：

- `true` → 解析路徑正常，`mc_read_block` 的結果可信。
- `false` → **協定已漂移**。此時 `mc_read_block` 一律回錯誤而不是 `null`（見第 3 節），所以不會有人把「讀不出來」誤當成「那裡是空的」。回傳的 `raw` 是遊戲的原始訊息，拿它去比對 `src/domain/block-report.ts` 的 `PATTERNS` 就知道要補哪一條。

三個會讓你想跑它的訊號：

1. `mc_read_block` 開始回錯誤，但你人在遊戲裡看得到那格明明有東西。
2. 遊戲剛更新過，而你接下來要做任何依賴讀取的事（批改、對稱分析）。
3. 換了遊戲語言。

server instructions 裡也放了同一條線索，所以 AI 在行為可疑時會自己找到這支工具，不需要你記得提醒它。

預設會把示範建築填回 `air`，不在世界裡留垃圾。想留下來看：

```bash
cd gjlmotea/vibe/mcp/minecraft-edu && node scripts/live-check.mjs --keep
```

不需要開遊戲的驗證（型別、測試、build、stdio 握手、STDIN 關閉釋放連接埠與占埠失敗一次跑完）：

```bash
cd gjlmotea/vibe/mcp/minecraft-edu && corepack pnpm run verify
```

---

## 3. 工具面

### 連線與後備（4）

| 工具 | 用途 |
|---|---|
| `mc_status` | 橋接狀態、連線指令、已訂閱事件、累計指令數。任何失敗先查這個 |
| `mc_await_connection` | 阻塞等待遊戲連入（單次上限 120 秒） |
| `mc_run_command` | 單行 raw slash 指令；沒有專用工具時的後備 |
| `mc_run_commands` | 依序執行多條 raw 指令 |

### Agent — 手腳（10）

| 工具 | 用途 |
|---|---|
| `mc_agent_create` | 召喚 Agent |
| `mc_agent_move` | 往指定方向走 N 格 |
| `mc_agent_turn` | 左右轉，每次 90 度 |
| `mc_agent_teleport` | 把走丟的 Agent 叫回玩家身邊 |
| `mc_agent_act` | attack／destroy／till，可連續 |
| `mc_agent_place` | 從背包槽放置方塊 |
| `mc_agent_collect` | 撿取掉落物 |
| `mc_agent_inventory` | count／space／detail／drop／dropAll／transfer |
| `mc_agent_sense` | inspect／inspectData／detect／detectRedstone —— Agent 的眼睛 |
| `mc_agent_program` | **一次送出一整段動作程式**，逐步回報結果 |

Agent 方向是**相對它自己的面向**，不是世界方位。

### 世界（13）

`mc_set_block`、`mc_fill`、`mc_clone`、`mc_test_block`、`mc_read_block`、`mc_verify_reading`、`mc_compare_regions`、`mc_analyze_symmetry`、`mc_query_target`、`mc_summon`、`mc_world_settings`（時間／天氣／遊戲規則／難度）、`mc_structure`（存讀結構）、`mc_ticking_area`。

`mc_query_target` 會把 `querytarget` 回傳的 JSON 字串解析好，這是取得玩家或 Agent 座標的正規做法——建造前先問它。

**讀取這一塊有先天限制，講清楚比假裝沒有好。** Education 沒有「讀取任意方塊」的指令，所以：

- `mc_test_block` 是是非題：你得先猜一個方塊 ID。
- `mc_read_block` 不必猜——它拿空氣當哨兵去問，猜錯時遊戲訊息會把實際方塊講出來。但回傳的是**在地化顯示名稱**（「泥土」）而不是方塊 ID（`dirt`），不能餵回 `mc_set_block`。**解析不出來時本工具回錯誤，不是回 `null` 的成功回應**——理由見下方。
- `mc_verify_reading` 主動驗證上面那條解析路徑還有效。**上課前跑一次**就知道 `mc_read_block` 的結果能不能信。
- `mc_compare_regions` 用一條 `testforblocks` 比對整片區域。逐格比對在幾百格以上就會撞到 host 逾時，這個不會。`masked` 模式忽略來源的空氣，適合檢查「該有的東西在不在」而不管周圍多了什麼——**批改學生作品**就是這個形狀。

**為什麼解析失敗要回錯誤而不是 `null`**

因為這個工具的使用者是 AI，而**AI 不會懷疑系統壞掉**。

一個「成功」的回應配上 `block: null`，很容易被讀成「讀到了，那裡是空的」。接著 AI 會非常有自信地基於這個錯誤認知繼續做事——例如把學生蓋了一整節課的作品當成空地覆蓋掉，而且事後沒有任何錯誤紀錄可查。人看到 `null` 會覺得怪並停下來除錯；AI 不會。

錯誤沒辦法被當成資料繼續用，這就是重點。

`mc_verify_reading` 則是另一半：它不需要事先知道那格是什麼——若該格是空氣就拿基岩去問（空氣不可能是基岩，保證不符）逼出失敗訊息；若該格有東西，第一問就已經給了訊息。兩條路都保證拿得到訊息，最多兩條指令，完全不寫入世界。

這條防線有**突變測試**守著：故意把解析規則改壞後，探測與解析器共 7 條測試必須轉紅。

要逐格讀整片區域請走行為包與 Script API；本專案刻意不走那條路，因為那會讓學校電腦多一道安裝步驟。


### 反覆修改同一棟建築

`mc_structure` 的 `saveMode` 就是為這件事設計的：

| 模式 | 什麼時候用 | 生命週期 |
|---|---|---|
| `memory`（預設） | AI 改建築時想留退路——存一版，改壞了 load 回來 | 關掉遊戲就消失，硬碟不留檔 |
| `disk` | **使用者明確說要保留**（「幫我記住這棟」） | 寫進世界資料夾，關掉遊戲仍在 |

**版本管理就是取名字**：`castle_v1`、`castle_v2`。同名會直接覆蓋，改版本前先換名字。

遊戲**沒有**「列出已存結構」的指令，所以存過什麼只能靠名字記。橋接會記住本次連線存過的名單，問 `mc_status` 就看得到——但那只涵蓋本行程，重啟就沒了（`disk` 模式的檔案還在，名字要你自己記）。

### 對稱性分析——批改作品

`mc_analyze_symmetry` 檢查一塊區域是否鏡像對稱，**不對稱時會指出哪幾塊不對稱**，不是只丟一個「否」。

原理：`testforblocks` 只做平移比對不會鏡像，所以先用 `structure save` 存下區域，再用 `structure load` 的 mirror 參數把它鏡像放到暫存區，然後兩區比對。整體通過就直接滿分；不通過才細分成 n³ 格逐格比，分數是相符格子的比例。

**這個工具會暫時寫入世界**，流程如下，任何一步失敗都不會留下爛攤子：

1. 存下分析區——失敗就中止（通常是區塊未載入）。
2. **先備份暫存區**——備份失敗就中止，且**絕不放置鏡像副本**，世界毫髮無傷。
3. 放鏡像副本、比對。
4. 不論成敗都還原暫存區並刪掉暫存結構；還原結果如實回報在 `scratchRestored`，失敗不粉飾。

暫存區不可與分析區重疊，否則鏡像副本會蓋掉原始建築——這個檢查在送出任何指令之前就做。

### 玩家與回饋（7）

`mc_teleport`、`mc_give`、`mc_gamemode`、`mc_effect`、`mc_player_action`（kill／clear／xp／ability）、`mc_message`（say／tell／title／subtitle／actionbar）、`mc_feedback`（音效／粒子）。

### 建造（4）

| 工具 | 用途 |
|---|---|
| `mc_build_preview` | 只算不做：方塊數、邊界盒、fill 批次數 |
| `mc_build_shape` | 二十四種幾何形狀，多數支援 hollow（見下表） |
| `mc_blueprint_preview` | 逐格藍圖的預覽 |
| `mc_build_blueprint` | 任意形狀：給「座標 → 方塊」清單，相同方塊自動合併 |

`mc_build_shape` 的形狀清單：

| 群組 | 形狀 |
|---|---|
| 基本量體 | `box`、`sphere`、`ellipsoid`、`cylinder`、`cone`、`pyramid`、`prism` |
| 線與面 | `line`、`curve`（平滑曲線）、`disk`、`tube`（任意方向圓柱） |
| 建築件 | `wedge`（單斜面）、`roof`（人字／四坡屋頂）、`arch`（拱）、`stairs`、`spiralStairs`（螺旋梯）、`polywall`（折線牆／城牆） |
| 地景與路徑 | `heightfield`（起伏地表）、`ribbon`（道路／橋面） |
| 裝飾與造型 | `torus`、`helix`、`cross`（十字柱）、`star`（星形柱）、`revolution`（旋轉體） |

### 選型比語意更容易出錯

形狀從 12 增到 24 的過程中，跨 AI 發想（grok／codex／agy，紀錄在 `agents/docs/ais/`）
三家獨立指向同一個風險：**真正的瓶頸不是幾何寫不寫得出來，而是清單變長之後 AI 選錯形狀**。
選錯不會報錯，只會蓋出一個看似合理但不是你要的東西。所以 `mc_build_shape` 的工具說明
是按「想蓋什麼」分組的選型指引，而不是一張平的清單，並且把最容易互相搶市場的幾組寫成對照：

| 你要的 | 用這個 | 不要用 |
|---|---|---|
| 斜的柱子、樑、管線 | `tube` | `cylinder`（只能對齊 x／y／z） |
| 直角轉折的牆、圍牆 | `polywall` | `curve`（平滑曲線，會把直角磨圓） |
| 有屋脊的屋頂 | `roof` | `wedge`（只有單面斜坡） |
| 繞塔而上的樓梯 | `spiralStairs` | `helix`（沒有踏面）／`stairs`（走直線） |
| 上下不等寬的塔身、基座、煙囪 | `cone`／`pyramid` 加 `topRadius` | 多層 `box` 疊 |
| 圓頂、花瓶、拋物面、冷卻塔 | `revolution` 換一組 profile | 各自新增一個形狀 |
| 一片起伏的地 | `heightfield` | 多個 `box` 拼 |

幾個容易搞錯的參數語意：

- **`prism`／`pyramid` 的 `radius` 是中心到「邊」的距離**（內切圓半徑），不是到頂點。所以邊數愈多就愈接近同半徑的 `cylinder`，而 `sides=4` 與同尺寸的 `box` 逐格相同。
- **`cone` 與 `pyramid` 的 `topRadius` 是漸近值**：頂層實際會比它略寬半格左右。這是沿用 `cone` 原本的線性收斂公式（`topRadius=0` 時逐格等於加這個參數之前），沒有為了錐台去改動既有形狀的輸出。
- **`roof` 的 `ridgeAxis` 是「屋脊延伸的方向」**，不是坡面朝向的方向——這兩個講法差 90 度，是這個形狀最容易填反的參數。
- **`heightfield` 的 `corners` 是厚度（幾格）**，不是「表面在 `from.y` 上方幾格」。厚度 1 就只有一層；波浪把厚度壓到不足一格的地方直接沒有方塊，所以窪地與水塘是免費的。
- **`wedge` 的終點端剩一格高而不是收到零**，所以它是走得上去的坡道。
- **`arch` 畫的是拱圈實體，中間的洞才是開口**，開口寬度為 2×radius−1。

合併效率有硬門檻：`tests/domain/fill-efficiency.test.ts` 針對每個形狀釘住
「fill 條數 ÷ 方塊數」的上限。述詞寫得出來不代表產物適合這條管線——細碎、分支狀的
形狀會讓 greedy 合併壓不下去，fill 條數逼近方塊數，教室現場的體感就是新功能反而更慢。

### 事件 — 感知（4）

`mc_events_catalog`、`mc_events_subscribe`、`mc_events_unsubscribe`、`mc_events_poll`。

事件進環形緩衝，用游標連續讀；`dropped > 0` 代表輪詢太慢、有事件永遠讀不到了。重新連線後會自動重新訂閱。

---

## 4. 為什麼建造不會卡死

天真作法是每個方塊送一次 `setblock`。一顆半徑 20 的實心球有 33,000 多格，等於三萬多次 WebSocket 往返——實務上等於當機。

BlockHand 的管線是：

```
形狀參數 → inside() 判定掃描 → 方塊座標集合
        → X 連段合併 → Z 矩形合併 → Y 立方合併（三階段 greedy）
        → 依 Bedrock 單次 /fill 上限 32768 拆批
        → 送出
```

半徑 8 的實心球從 2,000 多個方塊壓成不到 200 條指令，且合併結果是**決定性**的——同一組輸入永遠得到同一組批次，所以有測試釘住「合併後覆蓋的方塊集合必須與原始點集合完全相同」，不會多蓋也不會少蓋。

空心形狀一律用「內部判定 + 外殼鄰居測試」實作，而不是每個形狀各寫一套空心數學。新增形狀只要寫 `inside()`，空心行為自動一致。

---

## 5. 安全邊界

**不做的事**

- 不連外網：只在 `127.0.0.1` 開 WebSocket 監聽。
- MCP runtime 不寫主機檔案：沒有任何 artifact 輸出路徑。只有使用者明確執行 `setup:<client>`／`uninstall:<client>` 時，該家官方 CLI 才會更新本機 MCP 設定。
- **一個例外要講清楚**：`mc_structure` 的 `saveMode="disk"` 會透過遊戲把結構寫成檔案，存進 Minecraft 的世界資料夾。那不是 MCP runtime 在寫檔，但確實會在使用者硬碟上留下東西。所以預設是 `memory`（暫存，關掉遊戲就消失），只有使用者明確表示要保留時才該用 `disk`，而且工具回覆一定會講出它寫到哪裡——不會靜悄悄留檔。
- 不碰祕密：整個專案沒有 token、帳號或憑證。
- 不主動連線：遊戲不 `/connect` 進來，所有工具都回可照做的錯誤訊息，不會靜默失敗。

**`mc_run_command` 的閘門**

`mcp/README.md` 架構原則 4 要求拒絕任意執行入口。這裡的判斷是：slash 指令的作用域完全在本機遊戲世界內，不觸及主機檔案系統、行程或網路，所以它不等同任意程式碼執行。真正必須擋的是讓橋接失效的操作，因此政策是**結構性**的而非猜意圖的關鍵字黑名單：

1. 只允許單行——換行與 NUL 直接拒絕，不能用 `\n` 把一條請求拆成兩條指令。
2. 拒絕 `wsserver` 與 `connect`——那會把遊戲指向別的端點，之後所有工具全部失效。
3. 其餘指令標記 `read-only`／`world-write`／`wide-effect` 風險等級，交由 MCP Host 依 annotation 決定是否要人工確認。

所有會被插進指令列的方塊 ID、選擇器、狀態字串都先過白名單正規表達式，防止用空白拼出額外參數。

**商標**

依 [Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines)，第三方工具不得看起來像官方產品。產品名 **BlockHand** 刻意不含 Minecraft 商標；`minecraft-edu` 只是這個私人工作區內的描述性資料夾名。若日後要對外發布，套件名與任何公開露出都必須重新檢視。

---

## 6. 設定

全部有預設值，`.env` 不是必需品。

| 變數 | 預設 | 說明 |
|---|---|---|
| `MINECRAFT_EDU_WS_HOST` | `127.0.0.1` | 監聽位址；預設只綁 loopback |
| `MINECRAFT_EDU_WS_PORT` | `19131` | 優先監聽埠；實際值以 `mc_status` 回報為準 |
| `MINECRAFT_EDU_WS_PORT_FALLBACK` | `1` | 優先埠被其他 MCP 任務占用時，由作業系統自動配一個空閒埠；設成 `0` 可要求占埠即失敗 |
| `MINECRAFT_EDU_COMMAND_TIMEOUT_MS` | `10000` | 單一指令等待遊戲回應的逾時 |
| `MINECRAFT_EDU_KEEPALIVE_INTERVAL_MS` | `30000` | 閒置時送出保活探測（`time query daytime`）的間隔。調小可更快發現真的斷線，代價是更常打擾遊戲 |
| `MINECRAFT_EDU_EVENT_BUFFER` | `500` | 事件環形緩衝筆數 |
| `MINECRAFT_EDU_MAX_BUILD_BLOCKS` | `200000` | 單次建造方塊數上限，超過即拒絕 |
| `MINECRAFT_EDU_STEP_DELAY_MS` | `100` | Agent 程式每步預設間隔 |
| `MINECRAFT_EDU_DEBUG_FRAMES` | 未設 | 設成 `1` 會把遊戲回的每個原始封包印到 stderr，診斷協定行為用 |

---

## 7. 模組地圖

```
src/
  domain/                     純資料與純邏輯，不依賴 MCP、ws 或 Node
    contracts.ts              型別、已知事件名、Bedrock fill 上限
    coordinates.ts            絕對／相對／局部座標格式化與邊界檢查
    commands.ts               所有 slash 指令建構器 + 注入白名單
    command-policy.ts         raw 指令的結構性閘門
    build/shapes.ts           二十四種形狀；inside() + 外殼鄰居測試
    build/fill-planner.ts     三階段 greedy 合併 + 依上限拆批
  ports/minecraft-connection.ts   連線抽象；測試靠它塞假件
  adapters/ws-minecraft-connection.ts  WebSocket 監聽、requestId 對應、事件緩衝、重連重訂閱
  application/
    blockhand-service.ts      Agent 程式展開、querytarget 解析、事件
    build-service.ts          規劃與執行分離（先讀後寫）
  server/
    create-server.ts          server 實例與給 Host 的操作指引
    schemas.ts                共用 zod 片段
    tool-kit.ts               回應塑形與錯誤包裝
    tools/                    session／agent／world／player／build／event
  composition.ts              組裝；可注入假連線
  index.ts                    stdio 入口
```

領域層完全不知道 WebSocket 的存在，所以整條 MCP 工具管線可以用純記憶體假件測到底——`tests/integration/mcp-client.test.ts` 的 16 項測試都不需要開遊戲。

---

## 8. 已知限制

- **世界必須開作弊**，否則遊戲會拒絕每一條指令。這是 Minecraft 的規則，不是 bug。
- **macOS 已完成真機 live 驗證（Claude Code 路徑）**：2026-08-25 在 macOS 上經 Claude Code 完成 `/connect`、大量讀寫（單一工作階段逾 45,000 方塊、含 `fill`／`setblock`／`testforblock`／`teleport`）與斷線重連全流程。**尚未**驗證的是「從 Finder 啟動 Codex Desktop」這條啟動路徑——GUI 啟動的 PATH 與環境變數繼承方式不同，仍需各自實測。
- **Agent 是 Education Edition 專屬**，一般 Bedrock 版沒有這個功能。
- **事件名稱與 `agent` 子指令 Mojang 沒有正式文件化**，來自公開觀察；遊戲改版可能改變行為。`mc_events_subscribe` 允許清單外的名稱，但會標記為未驗證。
- **`agent setitem` 的參數順序未經證實**，目前沒有做成專用工具，需要時請走 `mc_run_command`。
- **`@s` 在 WebSocket 指令下不一定能解析**：從橋接送進去的指令沒有實體身分，實測 `querytarget @s` 會完全沒有回應。`mc_query_target` 因此預設用 `@p`（最近的玩家），`live` 也會依序試 `@p` → `@a` → `@e[type=player]` 並回報每次結果。
- **大型建造可能撞到 MCP Host 的請求逾時**：建造工具會逐條送出 fill 並等遊戲回應，實測半徑 6 的空心球（126 條）約需 13 秒，但遊戲繁忙時會更久。MCP client 預設逾時多為 60 秒，超過就會在 Host 端被砍斷（工具本身仍在跑）。先用 `mc_build_preview` 看 `fillBatches`，數量大時分批建造。
- **每個 BlockHand 程序仍各自持有一個監聽埠**：STDIO client 關閉後，server 會同步關閉 Minecraft WebSocket 並釋放連接埠。AI 工具的桌面版同時載入多個任務，或桌面版／CLI／IDE 並行時，第一份會取得優先埠，其餘會自動取得空閒埠；請一律用目前任務的 `mc_status.connectCommand` 讓遊戲連到實際要操作的那一份。若需要固定埠，可替各 client 配不同的 `MINECRAFT_EDU_WS_PORT`，或把 `MINECRAFT_EDU_WS_PORT_FALLBACK` 設成 `0`。
- **握手後的第一條指令曾必定逾時，現已修正**：四次獨立真機執行都重現——遊戲在伺服器裝好解密器之前就送出一個加密訊框，串流錯位導致下一次請求的回應讀不出來。AES-CFB8 會自我同步，所以只影響第一條。adapter 現在會在握手完成後自動送一條唯讀 `time query daytime` 把那次損失吸收掉並丟棄結果，呼叫端的第一個動作即可正常。stderr 會記 `primed post-handshake stream`。
- **事件只在真正發生時觸發**：`BlockPlaced` 只在玩家親手放方塊時發出，`/setblock` 與 `/fill` 都不算。要收到事件必須先訂閱、再讓事件真的發生。
- **部分回應的 requestId 對不上請求**（觀察到會回全為零的 ID）。adapter 在「只剩一個待決請求」時會把回應歸給它，並在 stderr 記錄這是推斷來的；否則那些請求會一路靜默逾時，呼叫端只看到「沒反應」而不是真正的失敗原因。
- 一次只維持一條遊戲連線；新連線會取代舊的。
- 已完成真機驗證的環境：Minecraft Education **1.26.32.0（Win32 桌面版）**。若改用 Microsoft Store 的 UWP 版，loopback 會被 Windows 應用程式隔離擋住，需要額外的 `CheckNetIsolation LoopbackExempt` 豁免。macOS 14+ 的驗收矩陣見 [`agents/docs/macos-support.md`](agents/docs/macos-support.md)。

---

## 9. 授權

本專案以 [MIT License](LICENSE) 釋出。你可以自由使用、修改、散布與再授權，包含商業用途，唯一條件是保留原始的版權聲明與授權條款。

軟體按「現狀」提供，不附任何明示或默示的擔保。

Minecraft、Minecraft Education 為 Mojang Studios 與 Microsoft 的商標；本專案與兩者無隸屬關係，也未獲其背書。

# BlockHand macOS 支援設計與驗收

## 現行狀態

BlockHand 的核心與安裝流程已做成 Windows／macOS 共用實作；目前狀態是：

> 程式層與安裝流程支援 macOS；尚待 macOS 14+ Minecraft Education 真機 live 驗證。

Windows 上已完成完整單元／整合、stdio lifecycle 與 Minecraft live 驗證。這些證據不能外推成 Mac 遊戲端已通過，尤其不能代替 Finder 啟動環境、POSIX signal、Darwin 套件與 macOS 版 Minecraft WebSocket client 的實測。

## 平台契約

### 單一核心

- Codex 與 BlockHand 之間固定走 stdio MCP。
- Minecraft Education 是 WebSocket client；BlockHand 是只綁 `127.0.0.1` 的 server。
- 不為 macOS 分叉指令、加密、事件或建造管線。
- 不改成 `0.0.0.0`、不開 LAN、不做 router port-forward，也不自動修改 macOS Firewall。
- 優先埠是 19131；同機已有其他 MCP instance 時可由作業系統配發空閒埠。因此只信目前 task 的 `mc_status.connectCommand`。

### 每台機器登記一次

Codex Desktop、CLI 與 IDE 在**同一台主機**共用 `~/.codex/config.toml`；不同電腦不會共用 Node 與專案的實體路徑。Windows 筆電、Apple Silicon Mac、Intel Mac 都要在本機各執行一次：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run build
corepack pnpm run setup:codex
corepack pnpm run doctor
```

安裝器以 `realpath(process.execPath)` 登記該機的 Node 22.23.1，並把絕對路徑指向 `scripts/launch-mcp.mjs`。launcher 再從自己的位置載入 `dist/index.js`，不依賴工作目錄或 GUI 程式的 shell PATH。專案搬移、Node 位置改變或升級 Node 後，必須重新登記。

安裝狀態機刻意保守：

- entry 不存在：以官方 `codex mcp add` 新增。
- 同一工作樹的 launcher 或舊 direct-dist entry 已可用：驗證絕對 Node 路徑、精確版本與實際 initialize 後 no-op，不犧牲既有 timeout／tool policy。
- 同名但不相容、來自另一個 clone、已停用或不像 BlockHand：停止，不自動 remove/add。
- `uninstall` 只有在使用者明確執行，且 entry 能確認屬於目前工作樹時才移除。

登記完成後要完全退出並重啟 Codex，讓桌面版與其他 Host 重新載入 MCP 設定。

## 不包含 UI 自動化

PowerShell 自動輸入已移除，macOS 也不加入 AppleScript、Accessibility 或 Automation 權限。`pnpm connect` 只顯示安全指引；`run-plan` 即使讀到舊的 `"autoConnect": true` 也只會說明已停用，絕不操作前景視窗或鍵盤。

真正的連線流程是：

1. 在目前 Codex task 呼叫 `mc_status`。
2. 進入已開 Cheats、操作者有 Admin／OP 權限的 Minecraft Education 世界。
3. 手動輸入該 task 回傳的 `/connect 127.0.0.1:<actual-port>`。
4. 再呼叫 `mc_status`，確認 `connected=true`；若遊戲要求加密，確認 `encrypted=true`。

`doctor` 的一般 lifecycle smoke 與「Codex 實際 entry smoke」都強制用 port 0 取得隔離埠；不會搶正在使用的 19131。它同時驗證登記的 Node 是存在的絕對路徑且版本為 22.23.1。Apple Silicon 若透過 Rosetta 執行，會用 `sysctl.proc_translated` 額外標示。

## 官方依據與協定邊界

- [OpenAI Codex MCP 文件](https://developers.openai.com/codex/mcp)：同一主機的 Codex client 共用 `~/.codex/config.toml`，stdio server 可設定 command、args 與 env，並可用 `codex mcp` 管理。
- [Minecraft Education 系統需求](https://edusupport.minecraft.net/hc/en-us/articles/360047556591-System-Requirements)：目前 Mac 最低需求為 macOS 14。
- [Microsoft `/wsserver` 指令文件](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/commandsreference/examples/commands/wsserver?view=minecraft-bedrock-stable)：`/connect` 是 alias，指令用來連到 WebSocket URI，需 Admin 與 Cheats。
- [Minecraft Education Classroom Mode 指南](https://edusupport.minecraft.net/hc/en-us/articles/360047116652-Get-Started-with-Classroom-Mode)：官方提供 Mac companion workflow，並要求使用者以 `/connect` 連線。
- [Node 22.23.1 發行頁](https://nodejs.org/en/blog/release/v22.23.1/)：同版提供 macOS Apple Silicon 與 Intel binaries。
- [Apple Firewall 設定](https://support.apple.com/guide/mac-help/change-firewall-settings-on-mac-mh11783/mac)：若真機連線失敗，可檢查是否封鎖 Node 的 incoming connection；程式不會自行放寬設定。

官方文件化的是 `/wsserver`／`/connect` 連線 command surface；連線後的 request、response、event 與加密訊息格式沒有公開穩定性承諾。BlockHand 對這一層的支援來自實測與回歸測試，遊戲更新後仍可能需要調整。

## Mac 真機驗收矩陣

| 項目 | Apple Silicon | Intel | 完成條件 |
|---|---:|---:|---|
| macOS 14+ clean install | 必測 | 有機器時測 | 不複製 Windows `node_modules`，frozen install 成功 |
| Node／pnpm | 必測 | 必測 | Node 22.23.1、pnpm 11.17.0，Node 架構與預期一致 |
| 專案 verify | 必測 | 必測 | typecheck、全部 tests、build、launcher stdio smoke 全過 |
| Finder 啟動 Codex Desktop | 必測 | 必測 | 沒有 shell PATH 仍載入 38 tools／2 resources |
| 同機共用設定 | 必測 | 必測 | Desktop、CLI、IDE 都讀到 `minecraft-edu` entry |
| 動態埠 | 必測 | 必測 | 兩個 MCP instance 同時啟動，第二個回報不同可用埠 |
| Minecraft `/connect` | 必測 | 必測 | 手動連入 `127.0.0.1:<actual-port>`，狀態為 connected |
| 讀取與可回復寫入 | 必測 | 必測 | 查玩家座標；在測試世界放一格再清回 air |
| 加密／重連 | 必測 | 必測 | encrypted 狀態符合世界設定；斷線後可重新連入 |
| lifecycle | 必測 | 必測 | stdin EOF、關閉 Host、SIGTERM 後監聽埠可立即重綁 |
| Firewall on | 必測 | 必測 | 不放寬 loopback bind；若被擋只提供人工診斷 |

未取得相應真機證據前，上表不得標示通過，也不得把 lockfile 中存在 Darwin optional package 當成執行成功。

## 常見失敗

- `doctor` 說 Node 版本不符：切回 22.23.1，再重跑 build 與 setup。
- `doctor` 說同名 entry 不相容：先確認是否是另一份 clone；工具不會替你刪。
- Codex 看不到 MCP：完全退出並重啟；只開新 task 不一定會重載桌面程序的 MCP 設定。
- 遊戲拒絕 `/connect`：確認已進世界、Cheats 開啟、操作者具 Admin／OP，並使用 `mc_status` 的實際埠。
- 連到錯的 task：同時啟動多個 Codex Host 時，不要沿用上一個 task 的 19131。
- Mac 仍連不上：先關閉 Code Builder／Classroom Mode 等其他 companion，再檢查 Firewall；不要把 server 改綁 `0.0.0.0` 當快捷修復。
- Minecraft 與 MCP 不在同一台電腦：`127.0.0.1` 不再成立；這需要另做 LAN 身分驗證、授權與威脅模型，不屬於本支援基線。

# 原生整區 Undo

## 儲存與規劃

保存施工前的任意方塊原貌，仍由 Minecraft 的 `structure save … false memory` 負責。MCP 不推導原貌、不從世界種子重建、不依賴磁碟舊存檔。保留一個操作；下一次配置前釋放上一代快照。

規劃器表示「本操作改過的範圍，以及最後預期的基本建材」。它使用互不重疊的長方體；後續寫入從舊區域扣除交集（至多切成六片），加入新區域，再合併相鄰同材質區域。`hollow` 包含外殼與空氣內部；`outline` 保留未修改的內部。整個過程不建立每格一筆的 JavaScript 紀錄。

資源上限為總計預設 4,096 格、可設定至 32,768 格、最多 64 區、各區每邊最多 32 格；中間規劃最多 1,024 區。快照包含的方塊總數不因區域合併而减少；節省的是 MCP 記錄與指令往返。原生記憶體配置大小未由此介面提供，不能把格數換算為固定 RAM bytes。

## 完整性檢查

每個區域的預期結果只有一種方塊與預設資料值 0：

1. 用 `if block` 檢查最小座標的基準方塊與資料。
2. 沿每個長度大於一的軸，取「全區減最後一層」與「全區減第一層」，以 `if blocks … all` 比較。
3. 所有條件與 `structure load` 組成同一個 `execute in overworld … run …`。

相鄰切片相等代表該軸所有相鄰格都相等。三軸的相鄰關係連通整區，因此每格必須與基準方塊相同。這包含內部，並非邊界抽樣；`all` 也會檢查空氣。單格、線與平面只省略長度為一的軸。

不需要鏡像參考區，不需要額外讀取後端，也不逐格發出指令。每區每次檢查至多三次原生區域比對，工作量仍與方塊數成正比。復原先檢查所有剩餘區域；實際載入各區時再重做條件，避免檢查與還原之間覆蓋後續變動。多區復原仍不是世界級交易，已確認載入的區域不能假裝尚未改動。

## WebSocket 指令版本

封包 `header.version` 是協定版本，仍為 1。`body.version` 是 Minecraft 指令格式版本：只在內部原生 Undo 指令指定 25（`0x19`，1.19.50），讓 `execute if blocks` 可用，同時保留數字方塊資料語法。一般公開 raw command 沿用原有版本 1，不全域改寫指令解讀方式。

每個連線首次建造前，以唯讀條件確認能力。只有已確認的條件不成立回覆，才允許再測相反條件；語法錯誤、未知回覆、權限錯誤或斷線不得視為支援。能力探測失敗時不刪除前一個還原點、不保存新快照、不施工。

受保護的保存、建造、檢查與載入固定主世界，並在每次呼叫前後核對連線世代。這些限制與部分失敗、未知結果、唯一快照名稱及清理策略一同由 [Undo service](../../../src/application/undo-service.ts) 管理。

格式依據：Microsoft 的 [1.19.50 創作者更新](https://learn.microsoft.com/en-us/minecraft/creator/documents/update1.19.50?view=minecraft-bedrock-stable)、[execute 指令](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/commandsreference/examples/commands/execute?view=minecraft-bedrock-stable)，以及公開協定實作 mcpews 的 [command version 對照](https://github.com/mcpews/mcpews/blob/master/src/lib/version.ts) 與 [封包型別](https://github.com/mcpews/mcpews/blob/master/src/lib/protocol.ts)。是否可用仍以連線中的遊戲唯讀探測為準。

對照這些來源可以確認本橋接與公開實作的格式一致；這不能代替目前 Education 客戶端的實機相容性驗證：

- `body.version` 25 是 `MinecraftCommandVersion.V1_19_50 = 0x19`，內部名稱為 `NewExecuteCommandRelease…AndCommandDeferral`——新式 `execute` 在此版釋出，同一版也引入指令延遲執行（command deferral）。25 不是隨便挑的數字。
- 方塊指令的 aux／數字資料參數要到 `RemoveAuxValueParameterFromBlockCommands = 0x1d`（29）才移除，所以在 25 下 `if block … air 0` 保留 aux 值是正確寫法，不是多餘參數。
- `header.version` 與 `body.version` 是兩個不同的 enum：前者是 `Version`（`V0_0_1 = 0x1`），後者是 `MinecraftCommandVersion`。mcpews 的 `WSServer` 預設就送 `Version.V0_0_1`，與本橋接送的 `1` 相同，因此「header 版本太舊」不是已知差異。
- mcpews 的 `sendCommandRaw` 送出的 body 是 `{ version, commandLine, origin: { type: 'player' } }`，與本橋接完全一致；`CommandRequestLegacyBody`（`name`／`overload`／`input`）是另一種結構化呼叫，與命令列請求無關。因此「body 形狀混到 legacy 欄位」也不是已知差異。
- 官方 `execute` 文件沒有說明 `if blocks` 的來源與目的區域是否允許重疊，也沒有提到 deferral 對 WebSocket 回覆的影響。這兩點無法由文件判定。

## 未結案的實機症狀

實機（Education macOS 1.26.32）出現過：橋接連線與保活連續 28 分鐘正常（`time query daytime` 93 ms、`querytarget @p` 63 ms），但第一條 `body.version=25` 的整區 guard 沒有任何回覆，接著連 `body.version=1` 的 `time query daytime` 也沒有回覆；沒有 `unmatched response`、沒有非 JSON 訊框，就是沒有回覆。沒有建立快照、沒有寫入方塊。

2026-09-26 同一台、同版本再重現兩次（兩條獨立連線），時序完全一致：`querytarget @s` 35–70 ms 正常回覆 → 緊接送出第一條 `body.version=25` guard → 永不回覆 → 同連線其後所有指令（含保活）逾時，socket 仍顯示 connected。新觀察到**玩家自己在聊天列打的指令（包括 `/connect`）也不再生效**，只能完全關閉 Minecraft：macOS `/Library/Logs/DiagnosticReports/minecraft-edu_*.cpu_resource.diag` 的 PID 顯示兩次卡死後都被迫重開 app（1499→2524→18871），卡死期間的取樣是正常渲染，不是當機或記憶體不足。關閉自動 Undo 後，同一遊戲 636 條指令（含曾觸發卡死的同一筆 25 格 fill）零逾時。

因此自動 Undo 改為**預設關閉**（`MINECRAFT_EDU_UNDO_ENABLED=1` 才開）。另外 `dimension()` 以前把 `querytarget @s` 的逾時報成「讀不到指令發起者的維度」，讓人誤以為是 `@s` 解析問題；現在逾時改報 `undo-context-no-reply`。

**成因尚未確定。** 已知的候選各自都還缺證據：`if blocks` 的來源與目的重疊、新式 execute 的 deferral 與 WebSocket 回覆的關係、`@s` 在 WebSocket 來源下的解析、比對體積、指令長度或條件數。不能因為時序相鄰就宣稱遊戲被這條指令鎖死，也不能無證據換一個 `body.version` 數字就說修好了。

區分方式是 [undo-live-check.mjs](../../../scripts/undo-live-check.mjs) 的 `{ "action": "probe" }` 唯讀探測：依每項 note 選取成對的對照，一次送一條，逾時就停止同一條連線的後續探測（不重播、不自動重試）。先比較 `time-v1`／`time-v25`，再比較 `time-v25`／`execute-time-v25`，可分開檢查版本與 execute 包裝；與 `execute-run-v25` 對照則可檢查 querytarget 的特殊行為。清單順序不代表相鄰項目皆為單變量對照。目前保留 `guardUndoRegion` 的形狀、`body.version` 25 與 1024 字元上限，待實機證據決定修正。

## 驗證邊界

自動測試以獨立逐格世界模型核對區域規劃，檢查重疊寫入、空心／外殼、每個可能位置的單格異常、整層異常與一致的非預設資料。Adapter 測試核對 `body.version` 隔離；MCP 與 service 測試驗證快照生命週期、衝突、斷線及部分復原。

真機驗證使用 [undo-live-check.mjs](../../../scripts/undo-live-check.mjs)，須明確指定已授權區域並手動連線。它先確認全空氣，再測整區保存、內部衝突、還原與有條件清理。工具耗時是請求至遊戲確認的時間，不能代表 FPS、遊戲執行緒 CPU 時間或精確 RAM 用量。32,768 是可設定的程式上限，不代表所有裝置都已通過該容量的效能驗收。

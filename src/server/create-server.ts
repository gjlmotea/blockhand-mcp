import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { BlockHandService } from '../application/blockhand-service.js';
import type { BuildService } from '../application/build-service.js';
import { DEFAULT_UNDO_BLOCKS } from '../domain/build/undo-plan.js';
import { registerResources } from './register-resources.js';
import { registerTools } from './register-tools.js';

export const SERVER_NAME = 'minecraft-edu-mcp';

export type WriteGuard = (tool: string, work: () => Promise<unknown>) => Promise<unknown>;

export function createMcpServer(options: {
  readonly service: BlockHandService;
  readonly build: BuildService;
  readonly version: string;
  /** Wraps every tool not annotated read-only; the shared hub uses it to serialize world writes across sessions. */
  readonly guardWrite?: WriteGuard;
}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version },
    {
      instructions: [
        '這個 server 透過 Minecraft Education 官方文件化的 /wsserver（/connect）連線命令操作遊戲；連線後的訊息協定沒有公開穩定性保證。',
        '遊戲是連進來的一方：任何工具回報 not-connected 時，先呼叫 mc_status 取得 connectCommand，請使用者在遊戲聊天列輸入它，再用 mc_await_connection 等待。',
        '請玩家打 /connect 之前先看 mc_status 的 connected：已經連著就不要叫他打（正常的 /reload all、換世界不會斷線；卡在載入畫面太久時保活探測會斷線）。連著時再打，遊戲不會顯示任何字，玩家會以為卡住。玩家說聊天列沒反應時，先看畫面，再訂閱 PlayerMessage 請他打一句字：玩家打字會產生 type=chat 的事件，收得到就是正常。收不到時不要單憑它判定失靈（訂閱不代表遊戲已確認，玩家也可能沒打），要對照畫面與聊天紀錄。',
        '世界必須開啟作弊（Cheats），否則所有 slash 指令都會被遊戲拒絕。',
        '動手之前先看：用 mc_query_target 取得玩家座標，用 mc_agent_sense 看 Agent 前方，用 mc_build_preview 確認方塊數與範圍。',
        '大量方塊不要用迴圈逐格呼叫 mc_set_block。曲面、收分這類幾何造型用 mc_build_shape／mc_build_blueprint，它們會把座標合併成最少的 fill；大片地形或規則的方塊自己算座標，用 mc_run_commands 一次送多條 fill；上萬條以上寫成 .mcfunction 用 /function 執行。上限與做法見 agents/docs/large-builds.md。',
        '送出 reload all 之後，確認畫面進到世界之前不要再送指令：載入中送的指令會逾時，實機也曾在那時卡在載入畫面。橋接每 30 秒的保活探測不受此限，載入太久時連續三次沒回應，橋接會自己斷線。內建指令回「不明的指令」時，遊戲多半不在世界裡（主選單或世界清單），先看畫面。',
        '自動 Undo 預設關閉：在 Minecraft Education 1.26.x 實機上，它施工前送出的原生整區檢查（command version 25）得不到回覆，之後整條指令通道連同玩家自己打的指令都不再回應，只能重開 Minecraft。除非使用者明確要求且接受這個風險，不要用 mc_undo_control 開啟。',
        `開啟時保留一個操作、最多 ${DEFAULT_UNDO_BLOCKS} 格；同材質連續範圍合併整區備份與比對。僅支援主世界的絕對整數座標及基本靜態建材；整個建造工具或純 setblock/fill 批次算一步。超量或不支援的建造會在施工前拒絕。用 mc_undo 復原；其他未追蹤的修改會清除舊還原點。`,
        'Undo 有衝突、失敗或斷線時先查看現場與狀態，不自動重送、不自行啟用 overwriteChanges；只有使用者明確接受覆蓋現況才可強制復原。施工與復原時請留在原維度。',
        'Agent 的方向是相對它自己的面向，不是世界方位；連續動作請用 mc_agent_program 一次送出。',
        'mc_run_command 是沒有專用工具時的後備，只接受單行指令，且永遠拒絕 wsserver／connect／closewebsocket，包括包在 execute 裡的（那會切斷本橋接）。',
        '讀方塊靠遊戲錯誤訊息的文字格式，遊戲改版或換語言就會失效。行為變得可疑時（讀不出方塊、結果與畫面不符）先呼叫 mc_verify_reading 判斷是不是協定漂移，不要當成「那裡是空的」繼續推論。',
      ].join('\n'),
    },
  );

  if (options.guardWrite !== undefined) guardWriteTools(server, options.guardWrite);
  registerResources(server, options.service);
  registerTools(server, { service: options.service, build: options.build });
  return server;
}

type AnyHandler = (...args: unknown[]) => unknown;

function guardWriteTools(server: McpServer, guard: WriteGuard): void {
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { readonly annotations?: { readonly readOnlyHint?: boolean } },
    handler: AnyHandler,
  ) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, handler) =>
    config.annotations?.readOnlyHint === true
      ? register(name, config, handler)
      : register(name, config, (...args: unknown[]) => guard(name, async () => await handler(...args)));
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { BlockHandService } from '../application/blockhand-service.js';
import type { BuildService } from '../application/build-service.js';
import { registerResources } from './register-resources.js';
import { registerTools } from './register-tools.js';

export const SERVER_NAME = 'minecraft-edu-mcp';

export function createMcpServer(options: {
  readonly service: BlockHandService;
  readonly build: BuildService;
  readonly version: string;
}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version },
    {
      instructions: [
        '這個 server 透過 Minecraft Education 官方文件化的 /wsserver（/connect）連線命令操作遊戲；連線後的訊息協定沒有公開穩定性保證。',
        '遊戲是連進來的一方：任何工具回報 not-connected 時，先呼叫 mc_status 取得 connectCommand，請使用者在遊戲聊天列輸入它，再用 mc_await_connection 等待。',
        '世界必須開啟作弊（Cheats），否則所有 slash 指令都會被遊戲拒絕。',
        '動手之前先看：用 mc_query_target 取得玩家座標，用 mc_agent_sense 看 Agent 前方，用 mc_build_preview 確認方塊數與範圍。',
        '大量方塊一律走 mc_build_shape 或 mc_build_blueprint，它們會把座標合併成最少的 fill；不要用迴圈逐格呼叫 mc_set_block。',
        'Agent 的方向是相對它自己的面向，不是世界方位；連續動作請用 mc_agent_program 一次送出。',
        'mc_run_command 是沒有專用工具時的後備，只接受單行指令，且永遠拒絕 wsserver／connect（那會切斷本橋接）。',
        '讀方塊靠遊戲錯誤訊息的文字格式，遊戲改版或換語言就會失效。行為變得可疑時（讀不出方塊、結果與畫面不符）先呼叫 mc_verify_reading 判斷是不是協定漂移，不要當成「那裡是空的」繼續推論。',
      ].join('\n'),
    },
  );

  registerResources(server, options.service);
  registerTools(server, { service: options.service, build: options.build });
  return server;
}

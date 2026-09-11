import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { BlockHandService } from '../application/blockhand-service.js';
import { SHAPE_KINDS } from '../domain/build/shapes.js';
import { AGENT_DIRECTIONS } from '../domain/contracts.js';

function jsonContents(uri: URL, payload: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function registerResources(server: McpServer, service: BlockHandService): void {
  server.registerResource(
    'connection',
    'minecraft-edu://connection',
    {
      title: '橋接連線狀態',
      description: '目前的監聽位址、連線狀態與遊戲內要輸入的 /connect 指令。',
      mimeType: 'application/json',
    },
    async (uri: URL) => jsonContents(uri, service.status()),
  );

  server.registerResource(
    'capabilities',
    'minecraft-edu://capabilities',
    {
      title: 'BlockHand 能力清單',
      description: '這個 server 支援的 Agent 方向、形狀種類與可訂閱事件。',
      mimeType: 'application/json',
    },
    async (uri: URL) =>
      jsonContents(uri, {
        target: 'Minecraft Education Edition',
        transport: 'websocket-bridge',
        officialInterface: '/connect（wsserver）',
        agentDirections: AGENT_DIRECTIONS,
        shapeKinds: SHAPE_KINDS,
        knownEventNames: service.knownEventNames(),
        limitations: [
          '需要世界開啟作弊（Cheats），否則所有指令都會被拒絕。',
          '遊戲是 WebSocket client，必須由玩家在聊天列輸入 /connect 主動連入。',
          'Agent 是 Education Edition 專屬功能，一般 Bedrock 版沒有。',
          '事件名稱與 agent 子指令未經 Mojang 正式文件化，版本更新可能改變行為。',
        ],
      }),
  );
}

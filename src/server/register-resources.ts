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
      title: 'Bridge connection status',
      description: 'The current listening address, connection state and the /connect command to type in the game.',
      mimeType: 'application/json',
    },
    async (uri: URL) => jsonContents(uri, service.status()),
  );

  server.registerResource(
    'capabilities',
    'minecraft-edu://capabilities',
    {
      title: 'BlockHand capabilities',
      description: 'The Agent directions, shape kinds and subscribable events this server supports.',
      mimeType: 'application/json',
    },
    async (uri: URL) =>
      jsonContents(uri, {
        target: 'Minecraft Education Edition',
        transport: 'websocket-bridge',
        officialInterface: '/connect (wsserver)',
        agentDirections: AGENT_DIRECTIONS,
        shapeKinds: SHAPE_KINDS,
        knownEventNames: service.knownEventNames(),
        limitations: [
          'The world must have cheats on, or every command is rejected.',
          'The game is the WebSocket client; the player must type /connect in chat to connect.',
          'The Agent exists only in Education Edition, not in regular Bedrock Edition.',
          'Event names and agent subcommands are not formally documented by Mojang; game updates may change their behavior.',
        ],
      }),
  );
}

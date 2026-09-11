import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { BlockHandService } from '../application/blockhand-service.js';
import type { BuildService } from '../application/build-service.js';
import { registerAgentTools } from './tools/agent-tools.js';
import { registerBuildTools } from './tools/build-tools.js';
import { registerEventTools } from './tools/event-tools.js';
import { registerPlayerTools } from './tools/player-tools.js';
import { registerSessionTools } from './tools/session-tools.js';
import { registerWorldTools } from './tools/world-tools.js';

export interface ToolDependencies {
  readonly service: BlockHandService;
  readonly build: BuildService;
}

export function registerTools(server: McpServer, dependencies: ToolDependencies): void {
  registerSessionTools(server, dependencies.service);
  registerAgentTools(server, dependencies.service);
  registerWorldTools(server, dependencies.service);
  registerPlayerTools(server, dependencies.service);
  registerBuildTools(server, dependencies.build);
  registerEventTools(server, dependencies.service);
}

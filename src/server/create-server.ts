import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { BlockHandService } from '../application/blockhand-service.js';
import type { BuildService } from '../application/build-service.js';
import { DEFAULT_UNDO_BLOCKS } from '../domain/build/undo-plan.js';
import { registerResources } from './register-resources.js';
import { registerTools } from './register-tools.js';

/**
 * 握手時回報的 serverInfo。對外的產品名是 BlockHand，name 與 npm 套件、執行檔同名。
 *
 * client 端的註冊名（`claude mcp add <名稱>`、設定檔的鍵）由使用者自己取，工具前綴也跟著那個名字走；
 * serverInfo 只用來顯示，改它不會讓既有的註冊失效。共用中樞認的是 buildId，也不看這個名字。
 */
export const SERVER_NAME = 'blockhand-mcp';
export const SERVER_TITLE = 'BlockHand';

/**
 * 單次 tools/call 引數的元素上限（陣列元素加物件成員），SDK 在 zod 驗證之前先數。
 *
 * 最大的合法輸入是 20,000 格的藍圖：每格是 1 個陣列元素，加上 position、block、
 * blockStates 與 x、y、z 共 7 個，總計約 14 萬。超過這個量級的引數不可能通過
 * schema，提早拒絕就不必把整份走過 zod。
 */
export const MAX_TOOL_INPUT_ELEMENTS = 150_000;

export type WriteGuard = (tool: string, work: () => Promise<unknown>) => Promise<unknown>;

export function createMcpServer(options: {
  readonly service: BlockHandService;
  readonly build: BuildService;
  readonly version: string;
  /** Wraps every tool not annotated read-only; the shared hub uses it to serialize world writes across sessions. */
  readonly guardWrite?: WriteGuard;
}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: SERVER_TITLE, version: options.version },
    {
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      instructions: [
        'This server drives Minecraft Education through its documented /wsserver (/connect) command. The message protocol used after the connection is made has no public stability guarantee.',
        'The game is the side that connects. When any tool reports not-connected, call mc_status to get connectCommand, ask the user to type it in the game chat, then wait with mc_await_connection.',
        'Before asking the player to type /connect, check connected in mc_status. If it is already connected, do not ask (a normal /reload all or world switch does not disconnect; the keepalive probe disconnects only when the game sits on a loading screen too long). Typing it again while connected shows no text at all, so the player will think the game is stuck. When the player says the chat bar does not respond, look at the screen first, then subscribe to PlayerMessage and ask them to type a line: typed text produces an event with type=chat, and receiving it means chat works. Not receiving it proves nothing on its own (subscribing does not mean the game confirmed it, and the player may not have typed anything); compare with the screen and the chat history.',
        'Cheats must be enabled in the world, or the game rejects every slash command.',
        'Look before you act: get the player position with mc_query_target, see what is in front of the Agent with mc_agent_sense, and check the block count and extent with mc_build_preview.',
        'Do not loop mc_set_block over many blocks. For geometric forms such as curved surfaces and tapers, use mc_build_shape / mc_build_blueprint, which merge the coordinates into the fewest fill commands. For large terrain or regular blocks, compute the coordinates yourself and send many fill commands at once with mc_run_commands. Beyond tens of thousands of commands, write a .mcfunction file and run it with /function. Limits and methods: agents/docs/large-builds.md in the source repository.',
        'After sending reload all, send no other command until you have confirmed the game is back in the world: commands sent while it loads time out, and on real hardware the game once got stuck on the loading screen at that moment. The bridge keepalive probe every 30 seconds is exempt; if loading takes too long and three probes in a row get no reply, the bridge disconnects by itself. When a built-in command comes back as "Unknown command" (or the same message in the game language), the game is usually not in a world (main menu or world list); look at the screen first.',
        'Automatic Undo is off by default: on Minecraft Education 1.26.x, the native whole-region check it sends before building (command version 25) never gets a reply, after which the whole command channel, including commands the player types, stops responding until Minecraft is restarted. Do not turn it on with mc_undo_control unless the user explicitly asks for it and accepts this risk.',
        `When on, it keeps one operation of at most ${DEFAULT_UNDO_BLOCKS} blocks; contiguous ranges of the same material are backed up and compared as whole regions. Only absolute integer coordinates in the Overworld and basic static building blocks are supported; one whole build tool call, or one batch of plain setblock/fill commands, counts as one step. Builds that are too large or unsupported are refused before anything is placed. Restore with mc_undo; any other untracked change clears the old restore point.`,
        'When Undo reports a conflict, a failure or a disconnect, inspect the site and the status first. Do not resend automatically and do not turn on overwriteChanges on your own; force a restore only when the user explicitly accepts overwriting what is there now. Stay in the same dimension while building and restoring.',
        'Agent directions are relative to the way the Agent faces, not world directions. Send a sequence of actions in one call with mc_agent_program.',
        'mc_run_command is the fallback when no dedicated tool exists. It accepts a single line only and always refuses wsserver / connect / closewebsocket, including when wrapped in execute (that would cut this bridge).',
        'Block reading relies on the text format of the game error messages, which breaks when the game updates or changes language. When behavior looks wrong (blocks cannot be read, results disagree with the screen), call mc_verify_reading first to tell whether the protocol has drifted, instead of concluding that the spot is empty and reasoning on from there.',
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

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { BlockHandService } from '../../application/blockhand-service.js';
import { DEFAULT_UNDO_BLOCKS, MAX_UNDO_BLOCKS } from '../../domain/build/undo-plan.js';
import {
  batchOutcomeSchema,
  commandOutcomeSchema,
  connectionStatusSchema,
  undoStatusSchema,
} from '../schemas.js';
import { batchToPayload, guard, ok, outcomeToPayload, summarizeBatch, summarizeOutcome } from '../tool-kit.js';

/** 連上之後給 AI 的提醒：連著時重打 /connect 遊戲什麼都不顯示，玩家會以為卡住。 */
const ALREADY_CONNECTED_HINT =
  ' Do not ask the player to type /connect again: typing it while connected shows no text at all, so the player may think the game is stuck. A normal /reload all or world switch does not disconnect.';

export function registerSessionTools(server: McpServer, service: BlockHandService): void {
  server.registerTool('mc_undo_control', {
    title:'View or configure one-step undo',
    description:`Note: automatic Undo is off by default. On Education 1.26.x, once it is on, the native check before the first build makes the game command channel stop responding for good (the player's typing gets no response either) until Minecraft is restarted; configure enabled=true only when the user explicitly asks for it. action=status only reads the automatic Undo state and timings; configure turns it on or off and sets the block budget (default ${DEFAULT_UNDO_BLOCKS}, max ${MAX_UNDO_BLOCKS}); same-material ranges are saved as whole regions and compared with native region checks. clear releases this server's backups. Backups live only in game memory, with no disk backup and no Redo. Turning automatic backup off clears the old history.`,
    inputSchema:z.object({action:z.enum(['status','configure','clear']).default('status'),enabled:z.boolean().optional(),maxBlocks:z.number().int().min(1).max(MAX_UNDO_BLOCKS).optional()}).strict(),
    outputSchema:undoStatusSchema(),
    annotations:{readOnlyHint:false,idempotentHint:true,destructiveHint:true,openWorldHint:false},
  },async({action,enabled,maxBlocks})=>guard(async()=>{
    if(!service.undo) throw new Error('Undo is not configured in this runtime.');
    if(action!=='configure'&&(enabled!==undefined||maxBlocks!==undefined)) throw new Error('enabled/maxBlocks apply only to configure.');
    const result=action==='status'?service.undo.status():await service.undo.configure(enabled,maxBlocks,action==='clear');
    return ok({...result},result.reason??`Undo is ${result.enabled?'on':'off'}; ${result.available?'an operation can be undone':'there is no operation that can be undone directly'}.`);
  }));
  server.registerTool('mc_undo', {
    title:'Undo the last build',
    description:'Undo the last protected setblock/fill or build tool call; several build commands count as one step. All target blocks are checked first, then each region is restored with conditional commands so later changes are not overwritten. operationId guards against undoing the wrong version. Use overwriteChanges only when the user explicitly asks to overwrite conflicts, or accepts restoring the site after an operation whose outcome is uncertain; never set it to true on your own. This first version covers basic Overworld building blocks only: no mobs, inventories, water flow or redstone chains outside the region, and no Redo. Do not switch worlds or dimensions while it runs.',
    inputSchema:z.object({operationId:z.string().min(1).optional(),overwriteChanges:z.boolean().default(false)}).strict(),
    outputSchema:undoStatusSchema(),
    annotations:{readOnlyHint:false,idempotentHint:false,destructiveHint:true,openWorldHint:false},
  },async({operationId,overwriteChanges})=>guard(async()=>{
    if(!service.undo) throw new Error('Undo is not configured in this runtime.');
    const result=await service.undo.undo(operationId,overwriteChanges);
    return ok({...result},result.reason??'Undo finished.');
  }));
  server.registerTool(
    'mc_status',
    {
      title: 'Read bridge and connection status',
      description:
        'Report the WebSocket bridge, whether the game is answering commands (commandState), the last reply and timeout times, the /connect command and subscribed events. connected only means the network link is up; timed-out means a recent command got no reply, so do not assume the game can still act. No side effects.',
      inputSchema: z.object({}).strict(),
      outputSchema: connectionStatusSchema(),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const status = service.status();
        const saved = service.savedStructures();
        return ok(
          { ...status, savedStructures: saved, ...(service.undo ? {undo: {...service.undo.status()}} : {}) },
          status.connected
            ? (status.commandState === 'timed-out'
                ? 'The network link is up, but a recent command got no reply; it is not confirmed that the game can act.'
                : `Connected (connection #${String(status.connectionCount)}), ${String(status.commandsIssued)} commands sent so far.${ALREADY_CONNECTED_HINT}`) +
              (saved.length === 0
                ? ''
                : ` Structures saved this session: ${saved.map((entry) => `${entry.name} (${entry.saveMode})`).join(', ')}.`)
            : `Not connected. Type this in the Minecraft Education chat: ${status.connectCommand} (the world must have cheats on).`,
        );
      }),
  );

  server.registerTool(
    'mc_await_connection',
    {
      title: 'Wait for Minecraft to connect',
      description:
        'Block until the game connects to the bridge, for at most timeoutSeconds seconds. A timeout is not an error; it just reports connected=false. Call it after asking the user to type /connect.',
      inputSchema: z
        .object({ timeoutSeconds: z.number().int().min(1).max(120).default(30) })
        .strict(),
      outputSchema: connectionStatusSchema(),
      annotations: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ timeoutSeconds }) =>
      guard(async () => {
        const status = await service.awaitConnection(timeoutSeconds * 1000);
        return ok(
          { ...status, savedStructures: service.savedStructures(), ...(service.undo ? {undo: {...service.undo.status()}} : {}) },
          status.connected
            ? status.commandState === 'timed-out'
              ? 'The network link is up, but a recent command got no reply; check the game screen and response state first.'
              : `Minecraft is connected to the bridge.${ALREADY_CONNECTED_HINT}`
            : `Still not connected after ${String(timeoutSeconds)} seconds. Check that ${status.connectCommand} was typed in the game and that the world has cheats on.`,
        );
      }),
  );

  server.registerTool(
    'mc_run_command',
    {
      title: 'Run one slash command',
      description:
        'Send one raw slash command, for anything this server has no dedicated tool for. Single line only, no newline chaining. Refuses wsserver / connect / closewebsocket, including when wrapped in execute (that would cut this bridge). The leading slash is optional.',
      inputSchema: z
        .object({
          command: z.string().min(1).max(1024).describe('For example "time set day" or "/give @s diamond 1"'),
        })
        .strict(),
      outputSchema: commandOutcomeSchema().extend({ risk: z.string() }).strict(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ command }) =>
      guard(async () => {
        const assessment = service.assessRaw(command);
        const outcome = await service.run(assessment.commandLine);
        return ok(
          { ...outcomeToPayload(outcome), risk: assessment.risk },
          summarizeOutcome(outcome),
        );
      }),
  );

  server.registerTool(
    'mc_run_commands',
    {
      title: 'Run several slash commands in order',
      description:
        'Send several raw commands in order; each one passes the command policy on its own. Good for hand-written macros; for many blocks use mc_build_shape or mc_build_blueprint, which merge them into the fewest fill commands automatically.',
      inputSchema: z
        .object({
          commands: z.array(z.string().min(1).max(1024)).min(1).max(200),
          stopOnError: z.boolean().default(true),
          delayMs: z.number().int().min(0).max(5000).default(0),
          reportFailuresOnly: z
            .boolean()
            .default(false)
            .describe(
              'Return only the failed commands and skip the successful ones. Per-command results of a large batch (for example 200 fill commands) easily run past ten thousand tokens, ' +
                'and most of them just say "N blocks filled"; turn this on for large batches when you do not need each number. The issued / succeeded / failed counts are not affected.',
            ),
        })
        .strict(),
      outputSchema: batchOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ commands, stopOnError, delayMs, reportFailuresOnly }) =>
      guard(async () => {
        const normalized = commands.map((command) => service.assessRaw(command).commandLine);
        const batch = await service.runMany(normalized, { stopOnError, delayMs });
        // 逐條結果在 200 條的批次裡動輒上萬 token，過濾發生在轉 payload「之前」，
        // 統計欄位仍取自完整的 batch，所以 issued／succeeded／failed 不會因此失真。
        const reported = reportFailuresOnly
          ? { ...batch, outcomes: batch.outcomes.filter((outcome) => !outcome.ok) }
          : batch;
        return ok(batchToPayload(reported), summarizeBatch(batch, 'Command batch'));
      }),
  );
}

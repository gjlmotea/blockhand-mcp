import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { AgentProgramStep, BlockHandService } from '../../application/blockhand-service.js';
import { agentCommands } from '../../domain/commands.js';
import {
  agentDirectionSchema,
  agentProgramStepSchema,
  batchOutcomeSchema,
  blockNameSchema,
  commandOutcomeSchema,
  quantitySchema,
  slotSchema,
  turnDirectionSchema,
} from '../schemas.js';
import { batchToPayload, guard, ok, outcomeToPayload, summarizeBatch, summarizeOutcome } from '../tool-kit.js';

const AGENT_NOTE =
  'Agent 是 Education Edition 專屬的機器人，必須先用 mc_agent_create 召喚。方向是相對 Agent 自身面向，不是世界方位。';

export function registerAgentTools(server: McpServer, service: BlockHandService): void {
  server.registerTool(
    'mc_agent_create',
    {
      title: '召喚 Agent',
      description: `在玩家旁邊生成 Agent。已存在時重複呼叫是安全的。${AGENT_NOTE}`,
      inputSchema: z.object({}).strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const outcome = await service.run(agentCommands.create());
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_agent_move',
    {
      title: 'Agent 移動',
      description: `讓 Agent 往指定方向走 steps 格，每格一條指令。被方塊擋住時該步會失敗但不會中斷後續。${AGENT_NOTE}`,
      inputSchema: z
        .object({
          direction: agentDirectionSchema(),
          steps: z.number().int().min(1).max(64).default(1),
          delayMs: z.number().int().min(0).max(2000).default(100).describe('每步間隔，給遊戲時間完成移動'),
        })
        .strict(),
      outputSchema: batchOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ direction, steps, delayMs }) =>
      guard(async () => {
        const commands = Array.from({ length: steps }, () => agentCommands.move(direction));
        const batch = await service.runMany(commands, { stopOnError: false, delayMs });
        return ok(batchToPayload(batch), summarizeBatch(batch, `Agent 往 ${direction} 移動`));
      }),
  );

  server.registerTool(
    'mc_agent_turn',
    {
      title: 'Agent 轉向',
      description: `讓 Agent 原地左轉或右轉，每次 90 度。times=2 等於轉身。${AGENT_NOTE}`,
      inputSchema: z
        .object({
          direction: turnDirectionSchema(),
          times: z.number().int().min(1).max(4).default(1),
        })
        .strict(),
      outputSchema: batchOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ direction, times }) =>
      guard(async () => {
        const commands = Array.from({ length: times }, () => agentCommands.turn(direction));
        const batch = await service.runMany(commands, { stopOnError: false, delayMs: 60 });
        return ok(batchToPayload(batch), summarizeBatch(batch, `Agent ${direction} 轉 ${String(times)} 次`));
      }),
  );

  server.registerTool(
    'mc_agent_teleport',
    {
      title: 'Agent 傳送到玩家身邊',
      description: `把 Agent 叫到玩家旁邊。Agent 走丟、卡住或掉進洞裡時用這個回收。${AGENT_NOTE}`,
      inputSchema: z.object({}).strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const outcome = await service.run(agentCommands.teleportToPlayer());
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_agent_act',
    {
      title: 'Agent 攻擊／挖掘／耕地',
      description: `對指定方向做動作：attack 攻擊生物、destroy 挖掉方塊並收進背包、till 把泥土翻成耕地。repeat 可連續執行。${AGENT_NOTE}`,
      inputSchema: z
        .object({
          action: z.enum(['attack', 'destroy', 'till']),
          direction: agentDirectionSchema().default('forward'),
          repeat: z.number().int().min(1).max(64).default(1),
          delayMs: z.number().int().min(0).max(2000).default(100),
        })
        .strict(),
      outputSchema: batchOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ action, direction, repeat, delayMs }) =>
      guard(async () => {
        const build =
          action === 'attack'
            ? agentCommands.attack
            : action === 'destroy'
              ? agentCommands.destroy
              : agentCommands.till;
        const commands = Array.from({ length: repeat }, () => build(direction));
        const batch = await service.runMany(commands, { stopOnError: false, delayMs });
        return ok(batchToPayload(batch), summarizeBatch(batch, `Agent ${action} ${direction}`));
      }),
  );

  server.registerTool(
    'mc_agent_place',
    {
      title: 'Agent 放置方塊',
      description: `從指定背包槽（1–27）取出方塊放到指定方向。槽位空的時候會失敗。${AGENT_NOTE}`,
      inputSchema: z
        .object({
          slot: slotSchema(),
          direction: agentDirectionSchema().default('forward'),
          repeat: z.number().int().min(1).max(64).default(1),
          delayMs: z.number().int().min(0).max(2000).default(100),
        })
        .strict(),
      outputSchema: batchOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ slot, direction, repeat, delayMs }) =>
      guard(async () => {
        const commands = Array.from({ length: repeat }, () => agentCommands.place(slot, direction));
        const batch = await service.runMany(commands, { stopOnError: false, delayMs });
        return ok(batchToPayload(batch), summarizeBatch(batch, `Agent 放置槽 ${String(slot)} 到 ${direction}`));
      }),
  );

  server.registerTool(
    'mc_agent_collect',
    {
      title: 'Agent 撿取掉落物',
      description: `撿取 Agent 附近的掉落物。item 留空代表全部撿。${AGENT_NOTE}`,
      inputSchema: z
        .object({ item: blockNameSchema().nullable().default(null) })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ item }) =>
      guard(async () => {
        const outcome = await service.run(
          item === null ? agentCommands.collectAll() : agentCommands.collect(item),
        );
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_agent_inventory',
    {
      title: 'Agent 背包操作',
      description:
        `對 Agent 背包做一件事：count 查槽內數量、space 查剩餘空間、detail 查物品細節、drop 丟出指定數量、dropAll 清空整槽方向、transfer 在槽之間搬移。${AGENT_NOTE}`,
      inputSchema: z
        .object({
          action: z.enum(['count', 'space', 'detail', 'drop', 'dropAll', 'transfer']),
          slot: slotSchema().optional().describe('count／space／detail／drop 需要'),
          quantity: quantitySchema().optional().describe('drop／transfer 需要'),
          direction: agentDirectionSchema().optional().describe('drop／dropAll 需要'),
          destinationSlot: slotSchema().optional().describe('transfer 需要'),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ action, slot, quantity, direction, destinationSlot }) =>
      guard(async () => {
        const need = <T,>(value: T | undefined, label: string): T => {
          if (value === undefined) {
            throw new Error(`action="${action}" 需要參數 ${label}。`);
          }
          return value;
        };

        const commandLine =
          action === 'count'
            ? agentCommands.getItemCount(need(slot, 'slot'))
            : action === 'space'
              ? agentCommands.getItemSpace(need(slot, 'slot'))
              : action === 'detail'
                ? agentCommands.getItemDetail(need(slot, 'slot'))
                : action === 'drop'
                  ? agentCommands.drop(
                      need(slot, 'slot'),
                      need(quantity, 'quantity'),
                      need(direction, 'direction'),
                    )
                  : action === 'dropAll'
                    ? agentCommands.dropAll(need(direction, 'direction'))
                    : agentCommands.transfer(
                        need(slot, 'slot'),
                        need(quantity, 'quantity'),
                        need(destinationSlot, 'destinationSlot'),
                      );

        const outcome = await service.run(commandLine);
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_agent_sense',
    {
      title: 'Agent 感測周遭',
      description:
        `讀取 Agent 周圍狀態，不改變世界：inspect 看方塊種類、inspectData 看方塊資料值、detect 偵測該方向是否有實體方塊、detectRedstone 偵測紅石訊號。這是 Agent 的「眼睛」，行動前先看。`,
      inputSchema: z
        .object({
          mode: z.enum(['inspect', 'inspectData', 'detect', 'detectRedstone']).default('inspect'),
          direction: agentDirectionSchema().default('forward'),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ mode, direction }) =>
      guard(async () => {
        const commandLine =
          mode === 'inspect'
            ? agentCommands.inspect(direction)
            : mode === 'inspectData'
              ? agentCommands.inspectData(direction)
              : mode === 'detect'
                ? agentCommands.detect(direction)
                : agentCommands.detectRedstone(direction);
        const outcome = await service.run(commandLine);
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_agent_program',
    {
      title: '執行一段 Agent 程式',
      description:
        '把一連串 Agent 動作當成一支程式依序執行，這是讓 Agent 真正「做事」的主力工具：邊走邊鋪路、挖一條隧道、耕一整片田都用它。每步結果都會個別回報，可設定失敗即停。',
      inputSchema: z
        .object({
          steps: z.array(agentProgramStepSchema()).min(1).max(256),
          stopOnError: z.boolean().default(false),
          delayMs: z
            .number()
            .int()
            .min(0)
            .max(2000)
            .nullable()
            .default(null)
            .describe('每步間隔；null 使用預設 100 ms'),
        })
        .strict(),
      outputSchema: batchOutcomeSchema().extend({ commands: z.array(z.string()) }).strict(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ steps, stopOnError, delayMs }) =>
      guard(async () => {
        const result = await service.runAgentProgram(
          steps as readonly AgentProgramStep[],
          stopOnError,
          delayMs,
        );
        return ok(
          { ...batchToPayload(result.batch), commands: [...result.commands] },
          summarizeBatch(result.batch, `Agent 程式（${String(steps.length)} 步）`),
        );
      }),
  );
}

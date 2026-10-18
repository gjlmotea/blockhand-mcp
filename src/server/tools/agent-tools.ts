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
  'The Agent is the robot found only in Education Edition; summon it with mc_agent_create first. Directions are relative to the way the Agent faces, not world directions.';

export function registerAgentTools(server: McpServer, service: BlockHandService): void {
  server.registerTool(
    'mc_agent_create',
    {
      title: 'Summon the Agent',
      description: `Spawn the Agent next to the player. Calling it again when the Agent already exists is safe. ${AGENT_NOTE}`,
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
      title: 'Move the Agent',
      description: `Move the Agent steps blocks in a direction, one command per block. A step blocked by a block fails without stopping the rest. ${AGENT_NOTE}`,
      inputSchema: z
        .object({
          direction: agentDirectionSchema(),
          steps: z.number().int().min(1).max(64).default(1),
          delayMs: z.number().int().min(0).max(2000).default(100).describe('Delay between steps, so the game has time to finish each move'),
        })
        .strict(),
      outputSchema: batchOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ direction, steps, delayMs }) =>
      guard(async () => {
        const commands = Array.from({ length: steps }, () => agentCommands.move(direction));
        const batch = await service.runMany(commands, { stopOnError: false, delayMs });
        return ok(batchToPayload(batch), summarizeBatch(batch, `Agent move ${direction}`));
      }),
  );

  server.registerTool(
    'mc_agent_turn',
    {
      title: 'Turn the Agent',
      description: `Turn the Agent left or right in place, 90 degrees each time. times=2 turns it around. ${AGENT_NOTE}`,
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
        return ok(batchToPayload(batch), summarizeBatch(batch, `Agent turn ${direction} x${String(times)}`));
      }),
  );

  server.registerTool(
    'mc_agent_teleport',
    {
      title: 'Teleport the Agent to the player',
      description: `Bring the Agent to the player. Use it to recover the Agent when it is lost, stuck or has fallen into a hole. ${AGENT_NOTE}`,
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
      title: 'Agent attack / destroy / till',
      description: `Act in a direction: attack hits a mob, destroy breaks a block and puts it in the inventory, till turns dirt into farmland. repeat runs it several times in a row. ${AGENT_NOTE}`,
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
      title: 'Agent place block',
      description: `Take a block from an inventory slot (1-27) and place it in a direction. Fails when the slot is empty. ${AGENT_NOTE}`,
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
        return ok(batchToPayload(batch), summarizeBatch(batch, `Agent place slot ${String(slot)} ${direction}`));
      }),
  );

  server.registerTool(
    'mc_agent_collect',
    {
      title: 'Agent collect items',
      description: `Pick up dropped items near the Agent. Leave item empty to pick up everything. ${AGENT_NOTE}`,
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
      title: 'Agent inventory',
      description:
        `Do one thing with the Agent inventory: count reads the amount in a slot, space reads the room left, detail reads item details, drop drops a quantity, dropAll drops everything in a direction, transfer moves items between slots. ${AGENT_NOTE}`,
      inputSchema: z
        .object({
          action: z.enum(['count', 'space', 'detail', 'drop', 'dropAll', 'transfer']),
          slot: slotSchema().optional().describe('Required for count / space / detail / drop'),
          quantity: quantitySchema().optional().describe('Required for drop / transfer'),
          direction: agentDirectionSchema().optional().describe('Required for drop / dropAll'),
          destinationSlot: slotSchema().optional().describe('Required for transfer'),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ action, slot, quantity, direction, destinationSlot }) =>
      guard(async () => {
        const need = <T,>(value: T | undefined, label: string): T => {
          if (value === undefined) {
            throw new Error(`action="${action}" requires ${label}.`);
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
      title: 'Agent sense surroundings',
      description:
        `Read what is around the Agent without changing the world: inspect reads the block type, inspectData reads the block data value, detect checks whether there is a solid block in that direction, detectRedstone checks for a redstone signal. These are the Agent's eyes; look before acting.`,
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
      title: 'Run an Agent program',
      description:
        'Run a sequence of Agent actions in order as one program. This is the main tool for getting real work done with the Agent: laying a path as it walks, digging a tunnel, tilling a whole field. Each step is reported separately, and it can stop at the first failure.',
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
            .describe('Delay between steps; null uses the default of 100 ms'),
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
          summarizeBatch(result.batch, `Agent program (${String(steps.length)} steps)`),
        );
      }),
  );
}

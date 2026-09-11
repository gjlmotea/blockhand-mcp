import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { BlockHandService } from '../../application/blockhand-service.js';
import { chatCommands, playerCommands } from '../../domain/commands.js';
import {
  blockNameSchema,
  commandOutcomeSchema,
  coordinateSchema,
  selectorSchema,
} from '../schemas.js';
import { guard, ok, outcomeToPayload, summarizeOutcome, toCoordinate } from '../tool-kit.js';

export function registerPlayerTools(server: McpServer, service: BlockHandService): void {
  server.registerTool(
    'mc_teleport',
    {
      title: '傳送玩家或實體',
      description: '把選擇器指定的對象傳送到座標。target 預設 @s 是執行指令的玩家。',
      inputSchema: z
        .object({ target: selectorSchema().default('@s'), destination: coordinateSchema() })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ target, destination }) =>
      guard(async () => {
        const outcome = await service.run(
          playerCommands.teleport(target, toCoordinate(destination)),
        );
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_give',
    {
      title: '給予物品',
      description: '給對象指定數量的物品。要讓 Agent 有東西可放，先 give 給玩家再交給 Agent。',
      inputSchema: z
        .object({
          target: selectorSchema().default('@s'),
          item: blockNameSchema(),
          amount: z.number().int().min(1).max(64).default(1),
          data: z.number().int().min(0).max(32767).nullable().default(null),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ target, item, amount, data }) =>
      guard(async () => {
        const outcome = await service.run(playerCommands.give(target, item, amount, data));
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_gamemode',
    {
      title: '切換遊戲模式',
      description: '把對象切成 survival、creative、adventure 或 spectator。',
      inputSchema: z
        .object({
          mode: z.enum(['survival', 'creative', 'adventure', 'spectator']),
          target: selectorSchema().default('@s'),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ mode, target }) =>
      guard(async () => {
        const outcome = await service.run(playerCommands.gameMode(target, mode));
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_effect',
    {
      title: '施加或清除狀態效果',
      description: 'action="apply" 施加藥水效果，"clear" 清除全部效果。',
      inputSchema: z
        .object({
          action: z.enum(['apply', 'clear']).default('apply'),
          target: selectorSchema().default('@s'),
          effect: blockNameSchema().optional().describe('apply 需要，例如 speed 或 night_vision'),
          seconds: z.number().int().min(0).max(1_000_000).default(30),
          amplifier: z.number().int().min(0).max(255).default(0),
          hideParticles: z.boolean().default(false),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ action, target, effect, seconds, amplifier, hideParticles }) =>
      guard(async () => {
        if (action === 'clear') {
          const cleared = await service.run(playerCommands.clearEffects(target));
          return ok(outcomeToPayload(cleared), summarizeOutcome(cleared));
        }
        if (effect === undefined) throw new Error('action="apply" 需要提供 effect。');
        const outcome = await service.run(
          playerCommands.effect(target, effect, seconds, amplifier, hideParticles),
        );
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_player_action',
    {
      title: '玩家雜項動作',
      description:
        'kill 殺死對象、clear 清空背包（可指定單一物品）、xp 給經驗、ability 開關 worldbuilder／mayfly／mute 權限。',
      inputSchema: z
        .object({
          action: z.enum(['kill', 'clear', 'xp', 'ability']),
          target: selectorSchema().default('@s'),
          item: blockNameSchema().nullable().default(null).describe('clear 可選'),
          amount: z.number().int().min(-100_000).max(100_000).default(1).describe('xp 需要'),
          unit: z.enum(['levels', 'points']).default('points'),
          ability: z.enum(['worldbuilder', 'mayfly', 'mute']).optional(),
          enabled: z.boolean().default(true),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ action, target, item, amount, unit, ability, enabled }) =>
      guard(async () => {
        const commandLine =
          action === 'kill'
            ? playerCommands.kill(target)
            : action === 'clear'
              ? playerCommands.clear(target, item)
              : action === 'xp'
                ? playerCommands.experience(target, amount, unit)
                : playerCommands.ability(
                    target,
                    (() => {
                      if (ability === undefined) throw new Error('action="ability" 需要提供 ability。');
                      return ability;
                    })(),
                    enabled,
                  );
        const outcome = await service.run(commandLine);
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_message',
    {
      title: '在遊戲內顯示訊息',
      description:
        'say 全體聊天、tell 私訊、title／subtitle／actionbar 在畫面上顯示大字。教學或回報進度時用這個跟玩家說話。',
      inputSchema: z
        .object({
          channel: z.enum(['say', 'tell', 'title', 'subtitle', 'actionbar']).default('say'),
          message: z.string().trim().min(1).max(512),
          target: selectorSchema().default('@a'),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ channel, message, target }) =>
      guard(async () => {
        const commandLine =
          channel === 'say'
            ? chatCommands.say(message)
            : channel === 'tell'
              ? chatCommands.tell(target, message)
              : chatCommands.title(target, channel, message);
        const outcome = await service.run(commandLine);
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_feedback',
    {
      title: '播放音效或粒子',
      description: '播一個音效或在座標生成粒子效果，用來給玩家即時的感官回饋。',
      inputSchema: z
        .object({
          kind: z.enum(['sound', 'particle']),
          id: blockNameSchema().describe('音效或粒子 ID，例如 random.levelup 或 minecraft:heart_particle'),
          target: selectorSchema().default('@a').describe('kind="sound" 時的聽眾'),
          position: coordinateSchema().nullable().default(null),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ kind, id, target, position }) =>
      guard(async () => {
        if (kind === 'particle') {
          if (position === null) throw new Error('kind="particle" 需要提供 position。');
          const particle = await service.run(chatCommands.particle(id, toCoordinate(position)));
          return ok(outcomeToPayload(particle), summarizeOutcome(particle));
        }
        const outcome = await service.run(
          chatCommands.playSound(id, target, position === null ? null : toCoordinate(position)),
        );
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );
}

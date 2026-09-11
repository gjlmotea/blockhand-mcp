import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { BlockHandService } from '../../application/blockhand-service.js';
import { guard, ok } from '../tool-kit.js';

const eventNameSchema = z.string().trim().min(1).max(64);

const eventRecordSchema = z
  .object({
    cursor: z.number(),
    receivedAt: z.string(),
    eventName: z.string(),
    properties: z.record(z.unknown()),
    measurements: z.record(z.unknown()).nullable(),
  })
  .strict();

export function registerEventTools(server: McpServer, service: BlockHandService): void {
  server.registerTool(
    'mc_events_catalog',
    {
      title: '列出可訂閱的事件名稱',
      description:
        '回傳已知可用的事件名稱。Mojang 沒有正式文件化這份清單，所以訂閱清單外的名稱是允許的，只會被標記為未驗證。無副作用。',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ eventNames: z.array(z.string()) }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const eventNames = [...service.knownEventNames()];
        return ok({ eventNames }, `已知 ${String(eventNames.length)} 種事件可訂閱。`);
      }),
  );

  server.registerTool(
    'mc_events_subscribe',
    {
      title: '訂閱遊戲事件',
      description:
        '開始接收某類遊戲事件（例如 PlayerMessage 聊天、BlockPlaced 放置方塊、PlayerTravelled 移動）。' +
        '事件會存進環形緩衝，之後用 mc_events_poll 取出。這是讓 AI「感知」玩家在做什麼的方式。重新連線後會自動重新訂閱。',
      inputSchema: z.object({ eventName: eventNameSchema }).strict(),
      outputSchema: z
        .object({ eventName: z.string(), verified: z.boolean(), subscribedEvents: z.array(z.string()) })
        .strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ eventName }) =>
      guard(async () => {
        const result = await service.subscribe(eventName);
        const status = service.status();
        return ok(
          { eventName, verified: result.verified, subscribedEvents: [...status.subscribedEvents] },
          result.verified
            ? `已訂閱 ${eventName}。`
            : `已送出 ${eventName} 的訂閱請求，但它不在已知清單內；若始終收不到事件，請確認名稱拼寫。`,
        );
      }),
  );

  server.registerTool(
    'mc_events_unsubscribe',
    {
      title: '取消訂閱遊戲事件',
      description: '停止接收某類事件。已經收進緩衝的事件不會被清除。',
      inputSchema: z.object({ eventName: eventNameSchema }).strict(),
      outputSchema: z.object({ eventName: z.string(), subscribedEvents: z.array(z.string()) }).strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ eventName }) =>
      guard(async () => {
        await service.unsubscribe(eventName);
        const status = service.status();
        return ok(
          { eventName, subscribedEvents: [...status.subscribedEvents] },
          `已取消訂閱 ${eventName}。`,
        );
      }),
  );

  server.registerTool(
    'mc_events_poll',
    {
      title: '讀取已收到的事件',
      description:
        '取出游標之後的事件。第一次用 afterCursor=0，之後帶回上次回傳的 nextCursor 就能連續讀。' +
        'dropped 大於 0 代表緩衝環繞、有事件永遠讀不到了，該提高輪詢頻率。無副作用。',
      inputSchema: z
        .object({
          afterCursor: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(200).default(50),
          eventName: eventNameSchema.nullable().default(null).describe('只取這一種事件'),
        })
        .strict(),
      outputSchema: z
        .object({
          events: z.array(eventRecordSchema),
          nextCursor: z.number(),
          dropped: z.number(),
        })
        .strict(),
      annotations: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ afterCursor, limit, eventName }) =>
      guard(async () => {
        const page = service.readEvents(afterCursor, limit, eventName);
        const payload = {
          events: page.events.map((record) => ({
            cursor: record.cursor,
            receivedAt: record.receivedAt,
            eventName: record.eventName,
            properties: record.properties,
            measurements: record.measurements,
          })),
          nextCursor: page.nextCursor,
          dropped: page.dropped,
        };
        return ok(
          payload,
          page.dropped > 0
            ? `取得 ${String(page.events.length)} 筆事件；另有 ${String(page.dropped)} 筆因緩衝溢出而遺失。`
            : `取得 ${String(page.events.length)} 筆事件。`,
        );
      }),
  );
}

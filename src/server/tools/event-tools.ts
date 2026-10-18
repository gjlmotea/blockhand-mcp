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
      title: 'List subscribable event names',
      description:
        'Return the event names known to work. Mojang does not formally document this list, so subscribing to a name outside it is allowed; it is just marked unverified. No side effects.',
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ eventNames: z.array(z.string()) }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const eventNames = [...service.knownEventNames()];
        return ok({ eventNames }, `${String(eventNames.length)} known events can be subscribed to.`);
      }),
  );

  server.registerTool(
    'mc_events_subscribe',
    {
      title: 'Subscribe to game events',
      description:
        'Start receiving a kind of game event (for example PlayerMessage for chat, BlockPlaced for placed blocks, PlayerTravelled for movement). ' +
        'Events go into a ring buffer; read them later with mc_events_poll. This is how the AI perceives what the player is doing. Subscriptions are renewed automatically after a reconnect.',
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
            ? `Subscribed to ${eventName}.`
            : `Sent a subscription request for ${eventName}, but it is not on the known list; if no events ever arrive, check the spelling.`,
        );
      }),
  );

  server.registerTool(
    'mc_events_unsubscribe',
    {
      title: 'Unsubscribe from game events',
      description: 'Stop receiving a kind of event. Events already in the buffer are kept.',
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
          `Unsubscribed from ${eventName}.`,
        );
      }),
  );

  server.registerTool(
    'mc_events_poll',
    {
      title: 'Read received events',
      description:
        'Return the events after a cursor. Use afterCursor=0 the first time, then pass back the nextCursor from the previous call to keep reading. ' +
        'dropped greater than 0 means the buffer wrapped around and some events are lost for good; poll more often. No side effects.',
      inputSchema: z
        .object({
          afterCursor: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(200).default(50),
          eventName: eventNameSchema.nullable().default(null).describe('Only return this kind of event'),
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
            ? `Got ${String(page.events.length)} events; another ${String(page.dropped)} were lost to buffer overflow.`
            : `Got ${String(page.events.length)} events.`,
        );
      }),
  );
}

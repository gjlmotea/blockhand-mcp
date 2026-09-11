import type {
  BatchOutcome,
  CommandOutcome,
  ConnectionStatus,
  GameEventPage,
  GameEventRecord,
} from '../../src/domain/contracts.js';
import { MinecraftBridgeError } from '../../src/domain/contracts.js';
import type { MinecraftConnection, SequenceOptions } from '../../src/ports/minecraft-connection.js';

export interface FakeConnection extends MinecraftConnection {
  readonly issued: string[];
  setConnected(connected: boolean): void;
  failNext(statusMessage: string): void;
  pushEvent(eventName: string, properties: Record<string, unknown>): void;
}

/**
 * 純記憶體的假連線，用來測整條 MCP 工具管線而不需要開遊戲。
 * 它會記下每一條實際送出的指令，所以測試可以直接斷言指令字串。
 */
export function createFakeConnection(options?: { readonly connected?: boolean }): FakeConnection {
  const issued: string[] = [];
  const subscribed = new Set<string>();
  const buffer: GameEventRecord[] = [];
  let connected = options?.connected ?? true;
  let nextCursor = 1;
  let pendingFailure: string | null = null;

  function status(): ConnectionStatus {
    return {
      listening: true,
      host: '127.0.0.1',
      port: 19131,
      connected,
      connectCommand: '/connect 127.0.0.1:19131',
      connectedAt: connected ? '2026-08-16T00:00:00.000Z' : null,
      connectionCount: connected ? 1 : 0,
      subscribedEvents: [...subscribed].sort(),
      bufferedEvents: buffer.length,
      commandsIssued: issued.length,
      encrypted: false,
    };
  }

  function requireConnected(): void {
    if (!connected) {
      // 訊息刻意比照 ws-minecraft-connection，讓測試驗到的是真實契約。
      throw new MinecraftBridgeError(
        'not-connected',
        'Minecraft 尚未連上。請在遊戲聊天列輸入：/connect 127.0.0.1:19131（世界需開啟作弊／Cheats）。',
      );
    }
  }

  const connection: FakeConnection = {
    issued,

    setConnected(next: boolean): void {
      connected = next;
    },

    failNext(statusMessage: string): void {
      pendingFailure = statusMessage;
    },

    pushEvent(eventName: string, properties: Record<string, unknown>): void {
      buffer.push({
        cursor: nextCursor,
        receivedAt: '2026-08-16T00:00:00.000Z',
        eventName,
        properties,
        measurements: null,
      });
      nextCursor += 1;
    },

    async start(): Promise<void> {
      /* 假連線不需要開埠。 */
    },

    async close(): Promise<void> {
      connected = false;
    },

    status,

    async awaitConnection(): Promise<ConnectionStatus> {
      return status();
    },

    async runCommand(commandLine: string): Promise<CommandOutcome> {
      requireConnected();
      issued.push(commandLine);
      if (pendingFailure !== null) {
        const message = pendingFailure;
        pendingFailure = null;
        return {
          ok: false,
          commandLine,
          statusCode: -2_147_483_648,
          statusMessage: message,
          data: null,
          elapsedMs: 1,
        };
      }
      return {
        ok: true,
        commandLine,
        statusCode: 0,
        statusMessage: null,
        data: commandLine.startsWith('querytarget')
          ? { details: '[{"position":{"x":10,"y":64,"z":-5}}]' }
          : null,
        elapsedMs: 1,
      };
    },

    async runSequence(
      commandLines: readonly string[],
      sequenceOptions: SequenceOptions,
    ): Promise<BatchOutcome> {
      const outcomes: CommandOutcome[] = [];
      let firstFailure: CommandOutcome | null = null;
      for (const commandLine of commandLines) {
        const outcome = await connection.runCommand(commandLine);
        outcomes.push(outcome);
        if (!outcome.ok && firstFailure === null) firstFailure = outcome;
        if (!outcome.ok && sequenceOptions.stopOnError) break;
      }
      const succeeded = outcomes.filter((outcome) => outcome.ok).length;
      return {
        ok: firstFailure === null,
        issued: outcomes.length,
        succeeded,
        failed: outcomes.length - succeeded,
        firstFailure,
        outcomes,
        elapsedMs: 1,
      };
    },

    async subscribe(eventName: string): Promise<void> {
      requireConnected();
      subscribed.add(eventName);
    },

    async unsubscribe(eventName: string): Promise<void> {
      requireConnected();
      subscribed.delete(eventName);
    },

    readEvents(afterCursor: number, limit: number, eventName: string | null): GameEventPage {
      const matched = buffer
        .filter((record) => record.cursor > afterCursor)
        .filter((record) => eventName === null || record.eventName === eventName);
      const page = matched.slice(0, limit);
      return {
        events: page,
        nextCursor: page.at(-1)?.cursor ?? afterCursor,
        dropped: 0,
      };
    },
  };

  return connection;
}

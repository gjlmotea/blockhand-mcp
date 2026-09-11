/**
 * Education Edition WebSocket 橋接。
 *
 * 方向很容易搞反：**遊戲是 client，我們是 server**。玩家在聊天列輸入
 * `/connect 127.0.0.1:19131`，遊戲才主動連進來。所以這個 adapter 一啟動就
 * 開監聽並等待，而不是去撥號給遊戲。
 *
 * 協定形狀（Mojang 未正式文件化，以下為公開觀察到的穩定形式）：
 * - 送指令：messagePurpose `commandRequest`，body.commandLine 不帶前導斜線
 * - 訂閱：  messagePurpose `subscribe` / `unsubscribe`，body.eventName
 * - 回應：  messagePurpose `commandResponse`，header.requestId 對回請求
 * - 失敗：  messagePurpose `error`，body.statusCode / statusMessage
 *
 * 連上之後第一件事是嘗試加密握手。Education 的「需要加密的 WebSocket」設定
 * 預設開啟，未完成握手前遊戲會靜默丟棄所有指令，詳見 ws-encryption.ts。
 */

import { randomUUID } from 'node:crypto';

import { WebSocketServer, type WebSocket } from 'ws';

import type {
  BatchOutcome,
  CommandOutcome,
  ConnectionStatus,
  GameEventPage,
  GameEventRecord,
} from '../domain/contracts.js';
import { MinecraftBridgeError } from '../domain/contracts.js';
import type { MinecraftConnection, SequenceOptions } from '../ports/minecraft-connection.js';
import { log } from '../logger.js';
import type { EncryptionSession } from './ws-encryption.js';
import { createEncryptionOffer, extractPublicKey } from './ws-encryption.js';

export interface WsConnectionOptions {
  readonly host: string;
  /** 優先監聽埠；被同機其他 MCP instance 占用時可退回 OS 配發的空閒埠。 */
  readonly port: number;
  readonly fallbackToRandomPort: boolean;
  readonly commandTimeoutMs: number;
  /** 閒置保活探測的間隔；省略時用 HEARTBEAT_INTERVAL_MS。 */
  readonly keepaliveIntervalMs?: number;
  readonly eventBufferSize: number;
  /** 把收到的每個原始封包印到 stderr，用於診斷協定行為。 */
  readonly debugFrames: boolean;
  /** 連線後是否嘗試加密握手。關閉只在診斷時有意義。 */
  readonly negotiateEncryption: boolean;
}

interface PendingRequest {
  readonly commandLine: string;
  readonly startedAt: number;
  readonly settle: (outcome: CommandOutcome) => void;
  readonly timer: NodeJS.Timeout;
  /** 橋接自己發的保活探測，不算進 commandsIssued，也不參與 sole-pending 歸屬。 */
  readonly internal: boolean;
}

interface IncomingMessage {
  readonly header?: {
    readonly requestId?: unknown;
    readonly messagePurpose?: unknown;
    /** Education 26.x 把事件名放在 header；舊格式放在 body。兩種都要接。 */
    readonly eventName?: unknown;
  };
  readonly body?: Record<string, unknown>;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const ENCRYPTION_TIMEOUT_MS = 5_000;
const BRIDGE_CLOSE_TIMEOUT_MS = 1500;
/**
 * 保活探測用的指令。
 *
 * 為什麼不能只靠 WebSocket ping：Education 的客戶端不回 pong frame。只用
 * `ws` 的 ping/pong 判活，會在閒置 60 秒後把一條完全正常的連線 terminate 掉
 * ——症狀是「放著不動就斷線」，而且斷線是橋接自己造成的。
 *
 * `time query daytime` 是唯讀、不寫世界、不在聊天欄留痕跡的指令，遊戲一定會回
 * commandResponse，正好當作應用層的活性證據。
 */
const KEEPALIVE_COMMAND = 'time query daytime';
const KEEPALIVE_TIMEOUT_MS = 10_000;

export function createWsMinecraftConnection(options: WsConnectionOptions): MinecraftConnection {
  let server: WebSocketServer | null = null;
  let listeningPort: number | null = null;
  let socket: WebSocket | null = null;
  let connectedAt: string | null = null;
  let connectionCount = 0;
  let commandsIssued = 0;
  let session: EncryptionSession | null = null;

  const pending = new Map<string, PendingRequest>();
  const subscribed = new Set<string>();
  const buffer: GameEventRecord[] = [];
  let nextCursor = 1;
  let firstAvailableCursor = 1;
  let connectionWaiters: Array<(status: ConnectionStatus) => void> = [];
  let heartbeat: NodeJS.Timeout | null = null;
  let alive = false;

  const keepaliveIntervalMs = options.keepaliveIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  // 探測逾時不能超過週期太多，否則死連線的偵測延遲會由逾時主宰而不是週期。
  const keepaliveTimeoutMs = Math.min(KEEPALIVE_TIMEOUT_MS, keepaliveIntervalMs * 2);
  /**
   * 握手完成前送出的指令會被遊戲靜默丟掉，所以任何公開操作都必須先等它結束。
   * 只在 attachSocket 設定，dispatch 本身不等（否則握手會等自己）。
   */
  let negotiation: Promise<void> | null = null;

  function currentStatus(): ConnectionStatus {
    const port = listeningPort ?? options.port;
    return {
      listening: server !== null,
      host: options.host,
      port,
      connected: socket !== null && socket.readyState === 1,
      connectCommand: `/connect ${options.host}:${String(port)}`,
      connectedAt,
      connectionCount,
      subscribedEvents: [...subscribed].sort(),
      bufferedEvents: buffer.length,
      commandsIssued,
      encrypted: session !== null,
    };
  }

  function requireSocket(): WebSocket {
    if (socket === null || socket.readyState !== 1) {
      const connectCommand = currentStatus().connectCommand;
      throw new MinecraftBridgeError(
        'not-connected',
        `Minecraft 尚未連上。請在遊戲聊天列輸入：${connectCommand}（世界需開啟作弊／Cheats）。`,
      );
    }
    return socket;
  }

  /** 唯一的送出口：握手完成後自動轉為加密二進位訊框。 */
  function sendFrame(target: WebSocket, frame: unknown): void {
    const json = JSON.stringify(frame);
    if (session === null) {
      target.send(json);
      return;
    }
    target.send(session.encrypt(json));
  }

  function pushEvent(eventName: string, body: Record<string, unknown>): void {
    const properties = body['properties'];
    const measurements = body['measurements'];

    // 實測 Education 26.32 的事件 body 就是屬性本身，沒有 properties 包裝：
    //   {"body":{"message":"…","sender":"教師","type":"say"},
    //    "header":{"eventName":"PlayerMessage","messagePurpose":"event"}}
    // 舊格式則是 body.properties。兩種都支援，不然事件會全部被丟掉。
    const resolvedProperties =
      typeof properties === 'object' && properties !== null && !Array.isArray(properties)
        ? (properties as Record<string, unknown>)
        : Object.fromEntries(
            Object.entries(body).filter(
              ([key]) => key !== 'eventName' && key !== 'measurements' && key !== 'properties',
            ),
          );

    const record: GameEventRecord = {
      cursor: nextCursor,
      receivedAt: new Date().toISOString(),
      eventName,
      properties: resolvedProperties,
      measurements:
        typeof measurements === 'object' && measurements !== null
          ? (measurements as Record<string, unknown>)
          : null,
    };
    nextCursor += 1;
    buffer.push(record);

    while (buffer.length > options.eventBufferSize) {
      buffer.shift();
      firstAvailableCursor += 1;
    }
  }

  function settlePending(requestId: string, body: Record<string, unknown>, purpose: string): void {
    const request = pending.get(requestId);
    if (request === undefined) return;
    pending.delete(requestId);
    clearTimeout(request.timer);

    const rawStatus = body['statusCode'];
    const statusCode = typeof rawStatus === 'number' ? rawStatus : null;
    const rawMessage = body['statusMessage'];
    const statusMessage = typeof rawMessage === 'string' ? rawMessage : null;

    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === 'statusCode' || key === 'statusMessage') continue;
      rest[key] = value;
    }

    // Bedrock 慣例：statusCode 0 或未回報視為成功，負值為失敗。
    const ok = purpose !== 'error' && (statusCode === null || statusCode >= 0);

    request.settle({
      ok,
      commandLine: request.commandLine,
      statusCode,
      statusMessage,
      data: Object.keys(rest).length > 0 ? rest : null,
      elapsedMs: Date.now() - request.startedAt,
    });
  }

  function handleMessage(data: Buffer): void {
    // 任何進來的封包都是活性證據。Education 不回 pong frame，所以這裡是
    // `alive` 唯一可靠的來源；少了這行，閒置的連線會被心跳誤判成死的。
    alive = true;

    let raw: string;
    try {
      raw = session === null ? data.toString('utf8') : session.decrypt(data);
    } catch (error: unknown) {
      log('error', 'failed to decrypt frame', {
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (options.debugFrames) {
      process.stderr.write(`[minecraft-edu-mcp] frame: ${raw}\n`);
    }

    let parsed: IncomingMessage;
    try {
      parsed = JSON.parse(raw) as IncomingMessage;
    } catch {
      log('error', 'received non-JSON frame', { preview: raw.slice(0, 120) });
      return;
    }

    const purpose = parsed.header?.messagePurpose;
    const requestId = parsed.header?.requestId;
    const body = parsed.body ?? {};

    if (purpose === 'event') {
      // Education 26.x 放在 header.eventName，舊格式放在 body.eventName。
      const headerEventName = parsed.header?.eventName;
      const bodyEventName = body['eventName'];
      const eventName =
        typeof headerEventName === 'string'
          ? headerEventName
          : typeof bodyEventName === 'string'
            ? bodyEventName
            : null;
      if (eventName !== null) pushEvent(eventName, body);
      return;
    }

    if (purpose === 'commandResponse' || purpose === 'error') {
      if (typeof requestId === 'string' && pending.has(requestId)) {
        settlePending(requestId, body, purpose);
        return;
      }

      // 觀察到的行為：Education 對部分指令（尤其是被拒絕的）會回一個
      // requestId 不吻合、甚至全為零的封包。若只認 requestId，那些請求會一路
      // 靜默逾時，呼叫端看到的是「沒反應」而不是真正的失敗原因。
      //
      // 指令實務上都是循序送出，所以「只剩一個待決請求」時把它歸給該請求，
      // 比讓它逾時誠實得多。歸屬方式會記進 log，不隱瞞這是推斷來的。
      // 保活探測不參與這個推斷：它是橋接自己發的，不該去吃掉使用者指令的回應。
      const attributable = [...pending.entries()].filter(([, request]) => !request.internal);
      if (attributable.length === 1) {
        const soleRequestId = attributable[0]?.[0];
        if (soleRequestId !== undefined) {
          log('info', 'correlated response by sole-pending fallback', {
            purpose,
            headerRequestId: typeof requestId === 'string' ? requestId : null,
            statusMessage: body['statusMessage'] ?? null,
          });
          settlePending(soleRequestId, body, purpose);
          return;
        }
      }

      log('error', 'unmatched response', {
        purpose,
        pendingCount: pending.size,
        statusMessage: body['statusMessage'] ?? null,
      });
      return;
    }
  }

  function dispatch(
    target: WebSocket,
    commandLine: string,
    timeoutMs: number,
    internal = false,
  ): Promise<CommandOutcome> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    if (!internal) commandsIssued += 1;

    return new Promise<CommandOutcome>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({
          ok: false,
          commandLine,
          statusCode: null,
          statusMessage: `等待遊戲回應超過 ${String(timeoutMs)} ms。`,
          data: null,
          elapsedMs: Date.now() - startedAt,
        });
      }, timeoutMs);
      timer.unref();

      pending.set(requestId, { commandLine, startedAt, settle: resolve, timer, internal });

      sendFrame(target, {
        header: {
          version: 1,
          requestId,
          messageType: 'commandRequest',
          messagePurpose: 'commandRequest',
        },
        body: {
          version: 1,
          commandLine,
          origin: { type: 'player' },
        },
      });
    });
  }

  /**
   * 嘗試加密握手。失敗不是致命錯誤——如果玩家關掉了「需要加密的 WebSocket」，
   * 明文一樣能用，所以這裡只記錄並繼續。
   */
  async function negotiateEncryption(target: WebSocket): Promise<void> {
    if (!options.negotiateEncryption) return;

    const offer = createEncryptionOffer();
    const outcome = await dispatch(target, offer.commandLine, ENCRYPTION_TIMEOUT_MS);

    const clientPublicKey = extractPublicKey(outcome.data);
    if (clientPublicKey === null) {
      log('info', 'encryption not negotiated; continuing in plaintext', {
        ok: outcome.ok,
        statusMessage: outcome.statusMessage,
      });
      return;
    }

    try {
      session = offer.complete(clientPublicKey);
      log('info', 'websocket encryption enabled', {});

      // 實測（四次獨立執行皆重現）：握手完成後遊戲送出的第一個加密訊框會與
      // 我們剛裝好的解密器錯位，那一次的回應必定讀不出來。AES-CFB8 會自我
      // 同步，所以只影響第一條指令——但那代表呼叫端的第一個動作必定逾時。
      //
      // 這裡先送一條唯讀指令把那次損失吸收掉，結果直接丟棄。付出一次
      // round-trip，換到「第一條指令就能用」。
      const primed = await dispatch(target, 'time query daytime', ENCRYPTION_TIMEOUT_MS);
      log('info', 'primed post-handshake stream', { absorbedFailure: !primed.ok });
    } catch (error: unknown) {
      log('error', 'encryption handshake failed; continuing in plaintext', {
        detail: error instanceof Error ? error.message : String(error),
      });
      session = null;
    }
  }

  function resubscribeAll(target: WebSocket): void {
    for (const eventName of subscribed) {
      sendFrame(target, {
        header: {
          version: 1,
          requestId: randomUUID(),
          messageType: 'commandRequest',
          messagePurpose: 'subscribe',
        },
        body: { eventName },
      });
    }
  }

  function failAllPending(reason: string): void {
    for (const [requestId, request] of pending) {
      pending.delete(requestId);
      clearTimeout(request.timer);
      request.settle({
        ok: false,
        commandLine: request.commandLine,
        statusCode: null,
        statusMessage: reason,
        data: null,
        elapsedMs: Date.now() - request.startedAt,
      });
    }
  }

  function settleConnectionWaiters(status: ConnectionStatus): void {
    const waiters = connectionWaiters;
    connectionWaiters = [];
    for (const waiter of waiters) waiter(status);
  }

  function attachSocket(next: WebSocket): void {
    if (socket !== null && socket.readyState === 1) {
      log('info', 'replacing previous connection', {});
      socket.close(1000, 'replaced by newer connection');
    }

    socket = next;
    session = null;
    alive = true;
    connectedAt = new Date().toISOString();
    connectionCount += 1;

    next.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const payload = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      handleMessage(payload);
    });
    next.on('pong', () => {
      alive = true;
    });
    next.on('close', () => {
      if (socket === next) {
        socket = null;
        session = null;
        negotiation = null;
        connectedAt = null;
        failAllPending('Minecraft 連線已中斷。');
      }
      log('info', 'minecraft disconnected', {});
    });
    next.on('error', (error: Error) => {
      log('error', 'socket error', { detail: error.message });
    });

    log('info', 'minecraft connected', { connectionCount });

    // 握手完成前不通知等待者，否則呼叫端會在加密就緒之前搶跑。
    negotiation = negotiateEncryption(next).finally(() => {
      resubscribeAll(next);
      settleConnectionWaiters(currentStatus());
    });
  }

  return {
    async start(): Promise<void> {
      if (server !== null) return;

      const listen = async (port: number): Promise<WebSocketServer> =>
        await new Promise<WebSocketServer>((resolve, reject) => {
          const created = new WebSocketServer({ host: options.host, port });
          const onError = (error: Error): void => {
            created.off('listening', onListening);
            // bind 失敗時仍顯式收掉 ws 包裝的 HTTP server，不依賴目前 Node/ws
            // 剛好沒有留下 event-loop handle 的實作細節。
            created.close(() => undefined);
            reject(error);
          };
          const onListening = (): void => {
            created.off('error', onError);
            resolve(created);
          };
          created.once('error', onError);
          created.once('listening', onListening);
          created.on('connection', (incoming: WebSocket) => {
            attachSocket(incoming);
          });
        });

      let created: WebSocketServer;
      try {
        created = await listen(options.port);
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!options.fallbackToRandomPort || code !== 'EADDRINUSE') {
          const detail = error instanceof Error ? error.message : String(error);
          throw new MinecraftBridgeError(
            'listen-failed',
            `無法在 ${options.host}:${String(options.port)} 監聽：${detail}`,
          );
        }

        log('info', 'preferred websocket port is busy; requesting a free port', {
          host: options.host,
          preferredPort: options.port,
        });
        try {
          created = await listen(0);
        } catch (fallbackError: unknown) {
          const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          throw new MinecraftBridgeError(
            'listen-failed',
            `優先埠 ${options.host}:${String(options.port)} 已占用，且無法取得空閒埠：${detail}`,
          );
        }
      }

      const address = created.address();
      if (address === null || typeof address === 'string') {
        await new Promise<void>((resolve) => created.close(() => resolve()));
        throw new MinecraftBridgeError('listen-failed', 'WebSocket bridge 無法取得實際監聽埠。');
      }
      server = created;
      listeningPort = address.port;

      heartbeat = setInterval(() => {
        const active = socket;
        if (active === null || active.readyState !== 1) return;

        // 已經有請求在飛：回應本身就會證明活性，而且它各自帶逾時，
        // 不需要（也不該）再插一條探測進去攪亂 sole-pending 歸屬。
        if (pending.size > 0) return;

        alive = false;
        active.ping(); // 對會回 pong 的客戶端仍然有效，是額外保險而非唯一依據。

        // 判死掛在探測本身的逾時上，而不是等下一個週期：後者在探測逾時
        // 遠大於週期時，會讓 pending 一直非空，心跳每次都提早 return，
        // 死連線要拖到探測逾時才被發現。
        void dispatch(active, KEEPALIVE_COMMAND, keepaliveTimeoutMs, true).then(() => {
          if (socket !== active) return;
          // handleMessage 收到任何封包都會把 alive 設回 true，
          // 所以 alive 仍是 false 代表整段探測期間遊戲一個字都沒回。
          if (alive) return;
          log('error', 'keepalive unanswered, terminating socket', {});
          active.terminate();
        });
      }, keepaliveIntervalMs);
      heartbeat.unref();

      log('info', 'websocket bridge listening', {
        host: options.host,
        port: listeningPort,
        preferredPort: options.port,
        connectCommand: currentStatus().connectCommand,
      });
    },

    async close(): Promise<void> {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      failAllPending('MCP server 正在關閉。');

      const active = server;
      server = null;
      listeningPort = null;
      if (active !== null) {
        // 新遊戲連入時，舊 socket 可能仍卡在 CLOSING 且不再由 socket 變數指到。
        // 必須掃完整 clients，否則 WebSocketServer.close() 會無限等舊 TCP。
        for (const client of active.clients) client.terminate();
      }
      socket = null;
      session = null;
      negotiation = null;
      connectedAt = null;
      settleConnectionWaiters(currentStatus());

      if (active === null) return;
      await new Promise<void>((resolve, reject) => {
        let finished = false;
        const finish = (error?: Error): void => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          if (error === undefined) resolve();
          else reject(error);
        };
        const timeout = setTimeout(() => {
          finish(
            new MinecraftBridgeError(
              'close-timeout',
              `WebSocket bridge 關閉超過 ${String(BRIDGE_CLOSE_TIMEOUT_MS)} ms。`,
            ),
          );
        }, BRIDGE_CLOSE_TIMEOUT_MS);
        timeout.unref();
        try {
          active.close((error?: Error) => {
            finish(error);
          });
        } catch (error: unknown) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    status: currentStatus,

    async awaitConnection(timeoutMs: number): Promise<ConnectionStatus> {
      // 已連上但握手還在進行：必須等它結束才算「可以用了」。
      if (currentStatus().connected && negotiation !== null) {
        await negotiation;
        return currentStatus();
      }

      const immediate = currentStatus();
      if (immediate.connected) return immediate;

      return await new Promise<ConnectionStatus>((resolve) => {
        const timer = setTimeout(() => {
          connectionWaiters = connectionWaiters.filter((waiter) => waiter !== onConnected);
          resolve(currentStatus());
        }, timeoutMs);
        timer.unref();

        const onConnected = (status: ConnectionStatus): void => {
          clearTimeout(timer);
          resolve(status);
        };
        connectionWaiters.push(onConnected);
      });
    },

    async runCommand(commandLine: string): Promise<CommandOutcome> {
      if (negotiation !== null) await negotiation;
      return await dispatch(requireSocket(), commandLine, options.commandTimeoutMs);
    },

    async runSequence(
      commandLines: readonly string[],
      sequenceOptions: SequenceOptions,
    ): Promise<BatchOutcome> {
      const startedAt = Date.now();
      const outcomes: CommandOutcome[] = [];
      let firstFailure: CommandOutcome | null = null;

      for (const [index, commandLine] of commandLines.entries()) {
        const outcome = await this.runCommand(commandLine);
        outcomes.push(outcome);
        if (!outcome.ok && firstFailure === null) firstFailure = outcome;
        if (!outcome.ok && sequenceOptions.stopOnError) break;
        if (sequenceOptions.delayMs > 0 && index < commandLines.length - 1) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, sequenceOptions.delayMs);
            timer.unref();
          });
        }
      }

      const succeeded = outcomes.filter((outcome) => outcome.ok).length;
      return {
        ok: firstFailure === null,
        issued: outcomes.length,
        succeeded,
        failed: outcomes.length - succeeded,
        firstFailure,
        outcomes,
        elapsedMs: Date.now() - startedAt,
      };
    },

    async subscribe(eventName: string): Promise<void> {
      if (negotiation !== null) await negotiation;
      const active = requireSocket();
      subscribed.add(eventName);
      sendFrame(active, {
        header: {
          version: 1,
          requestId: randomUUID(),
          messageType: 'commandRequest',
          messagePurpose: 'subscribe',
        },
        body: { eventName },
      });
    },

    async unsubscribe(eventName: string): Promise<void> {
      if (negotiation !== null) await negotiation;
      const active = requireSocket();
      subscribed.delete(eventName);
      sendFrame(active, {
        header: {
          version: 1,
          requestId: randomUUID(),
          messageType: 'commandRequest',
          messagePurpose: 'unsubscribe',
        },
        body: { eventName },
      });
    },

    readEvents(afterCursor: number, limit: number, eventName: string | null): GameEventPage {
      const dropped = Math.max(0, firstAvailableCursor - 1 - afterCursor);
      const matched = buffer
        .filter((record) => record.cursor > afterCursor)
        .filter((record) => eventName === null || record.eventName === eventName);
      const page = matched.slice(0, limit);
      const last = page.at(-1);

      return {
        events: page,
        nextCursor: last?.cursor ?? Math.max(afterCursor, nextCursor - 1),
        dropped,
      };
    },
  };
}

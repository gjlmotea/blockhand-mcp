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
import type { CommandOptions, MinecraftConnection, SequenceOptions } from '../ports/minecraft-connection.js';
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
  /**
   * 握手完成後在玩家聊天列印一行「已連上」。
   *
   * 已經連著時玩家再打一次同一個 /connect，遊戲不會重連，也不會顯示任何字，
   * 看起來跟卡死一模一樣。只有每次真的建立連線都留下一行字，玩家才分得出來。
   */
  readonly announceConnection?: boolean;
}

interface PendingRequest {
  readonly commandLine: string;
  readonly startedAt: number;
  readonly settle: (outcome: CommandOutcome) => void;
  readonly timer: NodeJS.Timeout;
  /** 橋接自己發的保活探測，不算進 commandsIssued，也不參與 sole-pending 歸屬。 */
  readonly internal: boolean;
  /**
   * 在 settle 之前**同步**執行的掛鉤，只給必須改變傳輸層狀態的回覆用。
   *
   * 加密握手是唯一的使用者：ws 會在同一個同步批次裡把整段接收的訊框 emit 完，
   * 所以解密器必須在處理下一個訊框之前就裝好。等 `await` 的 microtask 才裝，
   * 同批後續的加密訊框會被當明文丟棄，串流也會與遊戲錯開。
   */
  readonly onResponse: ((body: Record<string, unknown>, purpose: string) => void) | undefined;
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
/**
 * 幾次探測完全沒有回應才判死。
 *
 * 一次未回不能證明斷線：遊戲可能正在載入、背景暫停或短暫卡頓。
 * 容忍短暫無回應，避免在 TCP 仍可用時就要求玩家重打 /connect；
 * 這些可能原因仍需實機對照確認。
 */
const KEEPALIVE_MISS_LIMIT = 3;
/**
 * 排隊等待送出的指令上限。
 *
 * MCP 的 request handler 是併發的（SDK 收到 tools/call 就直接 dispatch，不等
 * 前一個做完），所以呼叫端平行丟工具時這裡會同時收到多條指令。指令一律排隊
 * 逐條送，目的是限制同時對遊戲發出的請求數：避免額外負載，也避免多條同時在飛
 * 時 requestId 對不上的回覆無法歸屬。佇列滿了就明確拒絕，不無聲累積。
 */
const MAX_QUEUED_COMMANDS = 64;

export function createWsMinecraftConnection(options: WsConnectionOptions): MinecraftConnection {
  let server: WebSocketServer | null = null;
  let listeningPort: number | null = null;
  let socket: WebSocket | null = null;
  let connectedAt: string | null = null;
  let connectionCount = 0;
  let commandsIssued = 0;
  let session: EncryptionSession | null = null;
  let commandState: NonNullable<ConnectionStatus['commandState']> = 'unknown';
  let lastCommandResponseAt: string | null = null;
  let lastCommandTimeoutAt: string | null = null;
  // After any timeout, an uncorrelated reply may belong to that retired request.
  // Nothing observable proves the late reply will never arrive: the game is not
  // contractually ordered, and "no reply yet" is not "no reply ever". So the
  // guess-by-sole-pending path stays off for the rest of this socket; only a new
  // socket restores it. Matching requestIds keep working throughout.
  let allowAmbiguousResponse = true;
  let keepaliveMisses = 0;
  /**
   * 目前這條遊戲連線的送出佇列。
   *
   * 刻意綁在 socket 上而不是整個橋接：換線時舊佇列整批退休，舊的 callback 只會
   * 去扣它自己那個物件的計數（不會把新 session 扣成負數），新遊戲的握手拿到的
   * 是一條空佇列，不會被上一局塞滿的佇列擋住。
   */
  let commandSession: {
    readonly socket: WebSocket;
    /** 逐條送出的串接點。永遠已 catch，所以不會有 unhandled rejection。 */
    chain: Promise<void>;
    /** 這條 session 裡還沒送出的指令數。 */
    queued: number;
    /** 退休後一律回報未送出，不再送任何東西進遊戲。 */
    open: boolean;
  } | null = null;

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
      commandState,
      lastCommandResponseAt,
      lastCommandTimeoutAt,
      inFlightCommands: pending.size,
      queuedCommands: commandSession?.queued ?? 0,
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

  async function readySocket(): Promise<WebSocket> {
    const target = requireSocket();
    if (negotiation !== null) await negotiation;
    if (socket !== target || target.readyState !== 1) {
      throw new MinecraftBridgeError('connection-changed', '等待握手時遊戲連線已改變；沒有把原指令送到新連線。');
    }
    return target;
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
    commandState = 'responsive';
    lastCommandResponseAt = new Date().toISOString();

    // 必須在回到 ws 的接收迴圈之前跑完，否則同批的下一個訊框就來不及了。
    // 掛鉤丟錯不能讓例外逃進 ws 的 message handler（那會變成未捕捉例外），
    // 也不能讓這個請求停在未 settle 的狀態。
    if (request.onResponse !== undefined) {
      try {
        request.onResponse(body, purpose);
      } catch (error: unknown) {
        log('error', 'synchronous response hook failed', {
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

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
      // 指令一律排隊逐條送出（見 MAX_QUEUED_COMMANDS），所以「只剩一個待決
      // 請求」時把它歸給該請求，比讓它逾時誠實得多。歸屬方式會記進 log，
      // 不隱瞞這是推斷來的。
      // 保活探測不參與這個推斷：它是橋接自己發的，不該去吃掉使用者指令的回應。
      const attributable = [...pending.entries()].filter(([, request]) => !request.internal);
      if (allowAmbiguousResponse && attributable.length === 1) {
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
        // 逾時過一次之後這裡一定是 false；診斷時要能分辨「遊戲沒回」與
        // 「回了但橋接刻意不敢歸屬」。
        ambiguousFallback: allowAmbiguousResponse,
        statusMessage: body['statusMessage'] ?? null,
      });
      return;
    }
  }

  function sendAndAwait(
    target: WebSocket,
    commandLine: string,
    timeoutMs: number,
    internal: boolean,
    commandVersion: 1 | 25,
    onResponse: ((body: Record<string, unknown>, purpose: string) => void) | undefined,
  ): Promise<CommandOutcome> {
    const startedAt = Date.now();
    // 排隊期間遊戲可能已經換連線。舊指令絕不轉送到新遊戲，語意與
    // failAllPending 一致。
    if (socket !== target || target.readyState !== 1) {
      return Promise.resolve({
        ok: false,
        commandLine,
        statusCode: null,
        statusMessage: '排隊等待送出時遊戲連線已改變；沒有把原指令送到新連線。',
        data: null,
        elapsedMs: 0,
      });
    }

    const requestId = randomUUID();
    if (!internal) commandsIssued += 1;

    return new Promise<CommandOutcome>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        if (socket === target) {
          commandState = 'timed-out';
          lastCommandTimeoutAt = new Date().toISOString();
          allowAmbiguousResponse = false;
        }
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

      pending.set(requestId, { commandLine, startedAt, settle: resolve, timer, internal, onResponse });

      sendFrame(target, {
        header: {
          version: 1,
          requestId,
          messageType: 'commandRequest',
          messagePurpose: 'commandRequest',
        },
        body: {
          version: commandVersion,
          commandLine,
          origin: { type: 'player' },
        },
      });
    });
  }

  /**
   * 排隊送出一條指令。同一時間只有一條指令在遊戲裡飛，理由見
   * MAX_QUEUED_COMMANDS。
   *
   * 排隊本身有期限：等超過這條指令自己的逾時預算就直接回報「未送出」並跳過。
   * 沒有期限的話，呼叫端那邊早就放棄的指令還是會在幾分鐘後被送進遊戲，變成
   * 一次沒人預期的世界修改。
   */
  function dispatch(
    target: WebSocket,
    commandLine: string,
    timeoutMs: number,
    internal = false,
    commandVersion: 1 | 25 = 1,
    onResponse?: (body: Record<string, unknown>, purpose: string) => void,
  ): Promise<CommandOutcome> {
    const enqueuedAt = Date.now();
    const notSent = (statusMessage: string): CommandOutcome => ({
      ok: false,
      commandLine,
      statusCode: null,
      statusMessage,
      data: null,
      elapsedMs: Date.now() - enqueuedAt,
    });

    // 佇列屬於某一條 socket session。舊 session 的佇列不能擋住新遊戲的握手，
    // 舊 callback 也不能去扣新 session 的計數。
    const owner = commandSession;
    if (owner === null || owner.socket !== target || !owner.open) {
      return Promise.resolve(notSent('排隊前遊戲連線已改變；沒有把原指令送到新連線。'));
    }

    if (owner.queued >= MAX_QUEUED_COMMANDS) {
      throw new MinecraftBridgeError(
        'command-queue-full',
        `已有 ${String(owner.queued)} 條指令排隊等待送出，達到上限 ${String(MAX_QUEUED_COMMANDS)}；這條指令沒有送出。` +
          '請等前面的指令收斂（可用 mc_status 看 queuedCommands 與 commandState），不要繼續平行送指令。',
      );
    }

    const enqueueDeadline = enqueuedAt + timeoutMs;
    owner.queued += 1;
    const outcome = owner.chain.then(() => {
      owner.queued -= 1;
      if (!owner.open || socket !== target || target.readyState !== 1) {
        return notSent('排隊等待送出時遊戲連線已改變；沒有把原指令送到新連線。');
      }
      if (Date.now() > enqueueDeadline) {
        return notSent(`排隊等待送出超過 ${String(timeoutMs)} ms，這條指令沒有送出，之後也不會送出。`);
      }
      return sendAndAwait(target, commandLine, timeoutMs, internal, commandVersion, onResponse);
    });
    owner.chain = outcome.then(
      () => undefined,
      () => undefined,
    );
    return outcome;
  }

  /**
   * 嘗試加密握手。失敗不是致命錯誤——如果玩家關掉了「需要加密的 WebSocket」，
   * 明文一樣能用，所以這裡只記錄並繼續。
   */
  async function negotiateEncryption(target: WebSocket): Promise<void> {
    if (!options.negotiateEncryption) return;

    const offer = createEncryptionOffer();
    let installed = false;
    let installFailure: string | null = null;

    /**
     * 收到握手回覆的那一刻就把解密器裝上，**不等 await**。
     *
     * 遊戲會在握手回覆之後立刻開始加密，而那些訊框常常與回覆落在同一次接收
     * 裡；ws 會在同一個同步批次把它們 emit 完。若等 `await` 的 microtask 才裝
     * 解密器，同批後續的訊框會被當明文而 JSON.parse 失敗丟棄，解密器也沒吃到
     * 那些位元組，於是與遊戲的 CFB8 串流錯開（下一個回覆前 16 bytes 是亂碼）。
     */
    const install = (body: Record<string, unknown>, _purpose: string): void => {
      // 沿用既有握手的公鑰接受條件，不在這次時序修正中改動 messagePurpose
      // 或 statusCode 的處理方式；不能據此推論遊戲實際會回哪一種格式。
      if (socket !== target || session !== null) return;
      const clientPublicKey = extractPublicKey(body);
      if (clientPublicKey === null) return;
      try {
        session = offer.complete(clientPublicKey);
        installed = true;
      } catch (error: unknown) {
        // 公鑰壞掉不是致命錯誤：明文一樣能用，所以只記下原因並維持明文。
        session = null;
        installFailure = error instanceof Error ? error.message : String(error);
      }
    };

    const outcome = await dispatch(target, offer.commandLine, ENCRYPTION_TIMEOUT_MS, false, 1, install);
    if (socket !== target || target.readyState !== 1) return;

    if (installFailure !== null) {
      log('error', 'encryption handshake failed; continuing in plaintext', { detail: installFailure });
      return;
    }
    if (!installed) {
      log('info', 'encryption not negotiated; continuing in plaintext', {
        ok: outcome.ok,
        statusMessage: outcome.statusMessage,
      });
      return;
    }

    log('info', 'websocket encryption enabled', {});

    // 握手後的就緒探測。解密器已經同步裝好，所以這條**不是**用來犧牲第一個
    // 加密回覆的——它只是在把連線交給呼叫端之前，先確認加密後的來回真的通。
    // 結果不影響加密狀態：探測失敗仍維持加密，只是記錄下來供診斷。
    const probe = await dispatch(target, 'time query daytime', ENCRYPTION_TIMEOUT_MS);
    if (socket !== target || target.readyState !== 1) return;
    log('info', 'primed post-handshake stream', { ok: probe.ok, elapsedMs: probe.elapsedMs });
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

  /** 舊佇列整批退休：等在裡面的指令一律回報未送出，且不再扣新 session 的計數。 */
  function retireCommandSession(): void {
    if (commandSession === null) return;
    commandSession.open = false;
    commandSession = null;
  }

  function attachSocket(next: WebSocket): void {
    if (socket !== null) failAllPending('舊遊戲連線已被新連線取代；未重送原指令。');
    retireCommandSession();
    if (socket !== null && socket.readyState === 1) {
      log('info', 'replacing previous connection', {});
      socket.close(1000, 'replaced by newer connection');
    }

    socket = next;
    commandSession = { socket: next, chain: Promise.resolve(), queued: 0, open: true };
    session = null;
    commandState = 'unknown';
    lastCommandResponseAt = null;
    lastCommandTimeoutAt = null;
    allowAmbiguousResponse = true;
    keepaliveMisses = 0;
    alive = true;
    connectedAt = new Date().toISOString();
    connectionCount += 1;

    next.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      if (socket !== next) return;
      const payload = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      handleMessage(payload);
    });
    next.on('pong', () => {
      if (socket === next) alive = true;
    });
    next.on('close', () => {
      if (socket === next) {
        socket = null;
        session = null;
        negotiation = null;
        connectedAt = null;
        failAllPending('Minecraft 連線已中斷。');
        retireCommandSession();
      }
      log('info', 'minecraft disconnected', {});
    });
    next.on('error', (error: Error) => {
      log('error', 'socket error', { detail: error.message });
    });

    log('info', 'minecraft connected', { connectionCount });

    // 握手完成前不通知等待者，否則呼叫端會在加密就緒之前搶跑。
    // 握手失敗絕不能變成 negotiation 的 rejection：readySocket 會 await 它，
    // 否則之後每一條指令都會拿到握手的錯誤，而且沒人 catch 就是 unhandled
    // rejection。明文本來就是可用的退路，這裡記錄後繼續。
    negotiation = negotiateEncryption(next)
      .catch((error: unknown) => {
        log('error', 'encryption negotiation aborted; continuing in plaintext', {
          detail: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (socket !== next || next.readyState !== 1) return;
        resubscribeAll(next);
        settleConnectionWaiters(currentStatus());
        if (options.announceConnection === true) announceConnection(next);
      });
  }

  /** 只是給玩家看的回饋：送不出去就記錄，不影響連線本身。 */
  function announceConnection(target: WebSocket): void {
    const { host, port } = currentStatus();
    const rawtext = [
      { text: `§a✔ 已連上 Claude §7(${host}:${String(port)})` },
      { text: '\n§7之後再打一次 /connect 不會有任何反應，那代表本來就連著。' },
    ];
    try {
      void dispatch(target, `tellraw @a ${JSON.stringify({ rawtext })}`, options.commandTimeoutMs, true).then((outcome) => {
        if (!outcome.ok) log('error', 'connection notice not shown', { detail: outcome.statusMessage });
      });
    } catch (error: unknown) {
      log('error', 'connection notice not shown', { detail: error instanceof Error ? error.message : String(error) });
    }
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

        // 已經有請求在飛或在排隊：回應本身就會證明活性，而且它各自帶逾時，
        // 不需要（也不該）再插一條探測進去攪亂 sole-pending 歸屬。
        if (pending.size > 0 || (commandSession?.queued ?? 0) > 0) return;

        alive = false;
        active.ping(); // 對會回 pong 的客戶端仍然有效，是額外保險而非唯一依據。

        // 判死掛在探測本身的逾時上，而不是等下一個週期：後者在探測逾時
        // 遠大於週期時，會讓 pending 一直非空，心跳每次都提早 return，
        // 死連線要拖到探測逾時才被發現。
        void dispatch(active, KEEPALIVE_COMMAND, keepaliveTimeoutMs, true).then(() => {
          if (socket !== active) return;
          // handleMessage 收到任何封包都會把 alive 設回 true，
          // 所以 alive 仍是 false 代表整段探測期間遊戲一個字都沒回。
          if (alive) {
            keepaliveMisses = 0;
            return;
          }
          keepaliveMisses += 1;
          if (keepaliveMisses < KEEPALIVE_MISS_LIMIT) {
            // 可能只是暫時沒有處理指令；目前不足以證明連線已失效。
            log('error', 'keepalive unanswered; keeping the socket', {
              misses: keepaliveMisses,
              limit: KEEPALIVE_MISS_LIMIT,
            });
            return;
          }
          log('error', 'keepalive unanswered repeatedly, terminating socket', {
            misses: keepaliveMisses,
          });
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
      retireCommandSession();

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

    async runCommand(commandLine: string, commandOptions?: CommandOptions): Promise<CommandOutcome> {
      return await dispatch(await readySocket(), commandLine, options.commandTimeoutMs, false, commandOptions?.commandVersion ?? 1);
    },

    async runSequence(
      commandLines: readonly string[],
      sequenceOptions: SequenceOptions,
    ): Promise<BatchOutcome> {
      const startedAt = Date.now();
      const sequenceSocket = socket;
      const outcomes: CommandOutcome[] = [];
      let firstFailure: CommandOutcome | null = null;

      for (const [index, commandLine] of commandLines.entries()) {
        if (socket !== sequenceSocket) {
          throw new MinecraftBridgeError('connection-changed', '批次執行期間遊戲連線已改變；其餘指令未送出。');
        }
        const outcome = await this.runCommand(commandLine);
        outcomes.push(outcome);
        if (!outcome.ok && firstFailure === null) firstFailure = outcome;
        if (!outcome.ok && (sequenceOptions.stopOnError || outcome.statusCode === null || socket !== sequenceSocket)) break;
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
      const active = await readySocket();
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
      const active = await readySocket();
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

/**
 * 加密握手測試：假客戶端完整實作遊戲那一側的 ECDH，握手後雙向都走 AES。
 *
 * 這是唯一能在不開 Minecraft 的情況下證明加密路徑真的通的方法——
 * 如果金鑰推導、cipher 模式或訊框方向有任何一處錯，這裡就會解不開。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
} from 'node:crypto';

import { createRequire } from 'node:module';

import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWsMinecraftConnection } from '../../src/adapters/ws-minecraft-connection.js';
import { createEncryptionOffer, extractPublicKey } from '../../src/adapters/ws-encryption.js';
import type { MinecraftConnection } from '../../src/ports/minecraft-connection.js';

let active: MinecraftConnection | null = null;
let client: WebSocket | null = null;

afterEach(async () => {
  client?.close();
  client = null;
  await active?.close();
  active = null;
});

/**
 * 把多個 WebSocket 訊框併成單一 TCP write。
 *
 * 這是重現實機時序的關鍵：遊戲的明文握手回覆與緊接著的加密訊框會落在同一次
 * 接收裡，接收端的 ws Receiver 會在同一個同步批次中連續 emit 多個 message。
 * 使用 ws 自己的 framing 產生訊框，再合併成一次底層 socket write，避免依賴
 * 多次 send 恰好合併。TCP 不保證 write 與 read 邊界一致；測試使用本機連線
 * 驗證此接收情境，保留真正的加密與遮罩處理。
 */
interface WsFramer {
  frame(
    data: Buffer,
    options: {
      readonly fin: boolean;
      readonly rsv1: boolean;
      readonly opcode: number;
      readonly mask: boolean;
      readonly readOnly: boolean;
    },
  ): Buffer[];
}
const { Sender } = createRequire(import.meta.url)('ws') as { Sender: WsFramer };

function writeOneBatch(
  socket: WebSocket,
  frames: readonly { readonly data: Buffer; readonly binary: boolean }[],
): void {
  const chunks: Buffer[] = [];
  for (const { data, binary } of frames) {
    chunks.push(
      ...Sender.frame(data, {
        fin: true,
        rsv1: false,
        opcode: binary ? 0x2 : 0x1,
        mask: true,
        readOnly: false,
      }),
    );
  }
  const transport = (socket as unknown as { readonly _socket: { write(chunk: Buffer): void } })._socket;
  transport.write(Buffer.concat(chunks));
}

/** 遊戲端的 ECDH：與 attachFakeGame 相同，只是把訊框交給呼叫端決定怎麼送。 */
function completeGameSideHandshake(commandLine: string): {
  readonly publicKey: string;
  readonly cipher: ReturnType<typeof createCipheriv>;
  readonly decipher: ReturnType<typeof createDecipheriv>;
} {
  const unquote = (value: string | undefined): string => (value ?? '').replace(/^"|"$/g, '');
  const [, rawPublicKey, rawSalt] = commandLine.split(' ');
  const serverKey = createPublicKey({
    key: Buffer.from(unquote(rawPublicKey), 'base64'),
    format: 'der',
    type: 'spki',
  });
  const own = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const shared = diffieHellman({ privateKey: own.privateKey, publicKey: serverKey });
  const secret = createHash('sha256')
    .update(Buffer.concat([Buffer.from(unquote(rawSalt), 'base64'), shared]))
    .digest();
  const iv = secret.subarray(0, 16);
  return {
    publicKey: own.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    cipher: createCipheriv('aes-256-cfb8', secret, iv),
    decipher: createDecipheriv('aes-256-cfb8', secret, iv),
  };
}

/** 模擬遊戲端：完成握手，之後所有收發都加密。 */
function attachFakeGame(socket: WebSocket, intercept?: (command: string, reply: () => void) => boolean): void {
  let cipher: ReturnType<typeof createCipheriv> | null = null;
  let decipher: ReturnType<typeof createDecipheriv> | null = null;

  socket.on('message', (data: Buffer) => {
    const raw = decipher === null ? data.toString('utf8') : decipher.update(data).toString('utf8');
    const frame = JSON.parse(raw) as {
      header: { requestId: string; messagePurpose: string };
      body: { commandLine?: string };
    };
    if (frame.header.messagePurpose !== 'commandRequest') return;

    const commandLine = frame.body.commandLine ?? '';
    const send = (payload: unknown): void => {
      const json = JSON.stringify(payload);
      socket.send(cipher === null ? json : cipher.update(Buffer.from(json, 'utf8')));
    };

    if (commandLine.startsWith('enableencryption ')) {
      const unquote = (value: string | undefined): string => (value ?? '').replace(/^"|"$/g, '');
      const [, rawPublicKey, rawSalt] = commandLine.split(' ');
      const serverPublicKeyBase64 = unquote(rawPublicKey);
      const saltBase64 = unquote(rawSalt);
      const serverKey = createPublicKey({
        key: Buffer.from(serverPublicKeyBase64, 'base64'),
        format: 'der',
        type: 'spki',
      });
      const own = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
      const shared = diffieHellman({ privateKey: own.privateKey, publicKey: serverKey });
      const secret = createHash('sha256')
        .update(Buffer.concat([Buffer.from(saltBase64, 'base64'), shared]))
        .digest();
      const iv = secret.subarray(0, 16);

      // 回覆本身仍是明文，之後才切換。
      send({
        header: { version: 1, requestId: frame.header.requestId, messagePurpose: 'commandResponse' },
        body: {
          statusCode: 0,
          publicKey: own.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        },
      });

      cipher = createCipheriv('aes-256-cfb8', secret, iv);
      decipher = createDecipheriv('aes-256-cfb8', secret, iv);
      return;
    }

    const reply = (): void => send({
      header: { version: 1, requestId: frame.header.requestId, messagePurpose: 'commandResponse' },
      body: { statusCode: 0, statusMessage: `ran ${commandLine}` },
    });
    if (!intercept?.(commandLine, reply)) reply();
  });
}

async function startEncryptedHarness(): Promise<MinecraftConnection> {
  const connection = createWsMinecraftConnection({
    host: '127.0.0.1',
    port: 0,
    fallbackToRandomPort: false,
    commandTimeoutMs: 2000,
    eventBufferSize: 20,
    debugFrames: false,
    negotiateEncryption: true,
  });
  active = connection;
  await connection.start();

  const port = connection.status().port;
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}`);
  client = socket;
  // 伺服器一收到連線就立刻送出握手，所以 handler 必須在 open 之前就掛好，
  // 否則第一個訊框會在沒有監聽者的情況下被丟掉。
  attachFakeGame(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve();
    });
    socket.once('error', reject);
  });

  await connection.awaitConnection(4000);
  return connection;
}

/**
 * 遊戲端：把明文握手回覆與緊接著的加密事件訊框併在同一次 TCP write 送出，
 * 之後一切收發都加密。
 */
function attachCoalescingGame(socket: WebSocket, seen: string[], events: readonly string[]): void {
  let cipher: ReturnType<typeof createCipheriv> | null = null;
  let decipher: ReturnType<typeof createDecipheriv> | null = null;

  socket.on('message', (data: Buffer) => {
    const raw = decipher === null ? data.toString('utf8') : decipher.update(data).toString('utf8');
    const frame = JSON.parse(raw) as {
      header: { requestId: string; messagePurpose: string };
      body: { commandLine?: string };
    };
    if (frame.header.messagePurpose !== 'commandRequest') return;
    const commandLine = frame.body.commandLine ?? '';
    seen.push(commandLine);

    if (commandLine.startsWith('enableencryption ')) {
      const negotiated = completeGameSideHandshake(commandLine);
      cipher = negotiated.cipher;
      decipher = negotiated.decipher;
      const handshake = Buffer.from(
        JSON.stringify({
          header: { version: 1, requestId: frame.header.requestId, messagePurpose: 'commandResponse' },
          body: { statusCode: 0, publicKey: negotiated.publicKey },
        }),
        'utf8',
      );
      const encrypted = (message: string): Buffer =>
        negotiated.cipher.update(
          Buffer.from(
            JSON.stringify({
              header: { eventName: 'PlayerMessage', messagePurpose: 'event', version: 17_104_896 },
              body: { message, sender: '教師', type: 'say' },
            }),
            'utf8',
          ),
        );
      writeOneBatch(socket, [
        { data: handshake, binary: false },
        ...events.map((message) => ({ data: encrypted(message), binary: true })),
      ]);
      return;
    }

    const json = JSON.stringify({
      header: { version: 1, requestId: frame.header.requestId, messagePurpose: 'commandResponse' },
      body: { statusCode: 0, statusMessage: `ran ${commandLine}` },
    });
    socket.send(cipher === null ? json : cipher.update(Buffer.from(json, 'utf8')));
  });
}

/** 遊戲端：握手只回明文，永不加密。用來驗退回明文的邊界。 */
function attachPlaintextOnlyGame(socket: WebSocket, handshakeBody: Record<string, unknown>, purpose: string): void {
  socket.on('message', (data: Buffer) => {
    const frame = JSON.parse(data.toString('utf8')) as {
      header: { requestId: string; messagePurpose: string };
      body: { commandLine?: string };
    };
    if (frame.header.messagePurpose !== 'commandRequest') return;
    const commandLine = frame.body.commandLine ?? '';
    const isHandshake = commandLine.startsWith('enableencryption ');
    socket.send(
      JSON.stringify({
        header: {
          version: 1,
          requestId: frame.header.requestId,
          messagePurpose: isHandshake ? purpose : 'commandResponse',
        },
        body: isHandshake ? handshakeBody : { statusCode: 0, statusMessage: `ran ${commandLine}` },
      }),
    );
  });
}

async function startWith(
  attach: (socket: WebSocket) => void,
  commandTimeoutMs = 2000,
): Promise<MinecraftConnection> {
  const connection = createWsMinecraftConnection({
    host: '127.0.0.1',
    port: 0,
    fallbackToRandomPort: false,
    commandTimeoutMs,
    eventBufferSize: 20,
    debugFrames: false,
    negotiateEncryption: true,
  });
  active = connection;
  await connection.start();
  const socket = new WebSocket(`ws://127.0.0.1:${String(connection.status().port)}`);
  client = socket;
  attach(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => { resolve(); });
    socket.once('error', reject);
  });
  return connection;
}

describe('加密握手的同批接收', () => {
  /**
   * 回歸：舊實作在 `await dispatch(...)` 的 microtask 才安裝 session，而 ws 會在
   * 同一個同步批次裡把後續訊框 emit 完。那些已加密的訊框因此被當明文處理、
   * JSON.parse 失敗而丟棄（實機 log 的 `received non-JSON frame`），解密器也沒有
   * 吃掉那些位元組，於是與遊戲的串流錯開——下一個回覆的前 16 bytes 是亂碼
   * （AES-CFB8 在 16 bytes 後自我同步），primer 因此逾時。
   */
  it('握手回覆與加密訊框同批到達時不丟事件、不錯開串流、primer 不逾時', async () => {
    const seen: string[] = [];
    const connection = await startWith((socket) =>
      { attachCoalescingGame(socket, seen, ['coalesced-1', 'coalesced-2']); });

    const status = await connection.awaitConnection(8000);
    expect(status.encrypted).toBe(true);

    // 同批裡的加密事件必須完整保留。
    const page = connection.readEvents(0, 10, null);
    expect(page.events.map((event) => event.properties['message'])).toEqual(['coalesced-1', 'coalesced-2']);

    // 解密器必須在處理下一個訊框之前就裝好，所以 primer 不該逾時。
    expect(connection.status()).toMatchObject({ commandState: 'responsive', lastCommandTimeoutAt: null });
    expect(seen).toContain('time query daytime');

    // 呼叫端的第一條指令直接可用。
    await expect(connection.runCommand('say hello')).resolves.toMatchObject({
      ok: true,
      statusMessage: 'ran say hello',
    });
  }, 20_000);

  it('公鑰無法解析時退回明文，不丟例外也不影響後續指令', async () => {
    const connection = await startWith((socket) =>
      { attachPlaintextOnlyGame(socket, { statusCode: 0, publicKey: 'not-a-key' }, 'commandResponse'); });

    const status = await connection.awaitConnection(8000);
    expect(status).toMatchObject({ connected: true, encrypted: false });
    await expect(connection.runCommand('say hello')).resolves.toMatchObject({
      ok: true,
      statusMessage: 'ran say hello',
    });
  }, 20_000);

  it('握手被回 error 時退回明文，不丟例外也不影響後續指令', async () => {
    const connection = await startWith((socket) =>
      { attachPlaintextOnlyGame(socket, { statusCode: -2_147_483_648, statusMessage: 'syntax error' }, 'error'); });

    const status = await connection.awaitConnection(8000);
    expect(status).toMatchObject({ connected: true, encrypted: false });
    await expect(connection.runCommand('say hello')).resolves.toMatchObject({
      ok: true,
      statusMessage: 'ran say hello',
    });
  }, 20_000);
});

describe('websocket 加密握手', () => {
  it('does not replay a command waiting for an old handshake onto a replacement game', async () => {
    const connection = createWsMinecraftConnection({ host: '127.0.0.1', port: 0,
      fallbackToRandomPort: false, commandTimeoutMs: 1000, eventBufferSize: 20,
      debugFrames: false, negotiateEncryption: true });
    active = connection;
    await connection.start();
    const address = `ws://127.0.0.1:${connection.status().port}`;
    const old = new WebSocket(address);
    client = old;
    let priming!: () => void;
    const primerSeen = new Promise<void>(resolve => { priming = resolve; });
    attachFakeGame(old, command => {
      if (command !== 'time query daytime') return false;
      priming(); return true;
    });
    await primerSeen;
    const rejected = expect(connection.runCommand('say must-not-replay')).rejects.toThrow('connection changed');
    const replacement = new WebSocket(address);
    client = replacement;
    const received: string[] = [];
    attachFakeGame(replacement, command => { received.push(command); return false; });
    await new Promise<void>((resolve, reject) => {
      replacement.once('open', resolve); replacement.once('error', reject);
    });
    await rejected;
    await connection.awaitConnection(2000);
    expect(connection.status().encrypted).toBe(true);
    expect((await connection.runCommand('time query daytime')).ok).toBe(true);
    expect(received).not.toContain('say must-not-replay');
    old.terminate();
  });

  /**
   * 回歸：舊遊戲把送出佇列塞滿（一條在飛 + 64 條排隊）之後，新遊戲連進來。
   * 佇列若屬於整個橋接而不是某一條 socket，新連線的 `enableencryption` 就會被
   * command-queue-full 擋掉——握手根本沒發出去，那個錯誤又變成沒人接的
   * rejection，結果是「連上了但一條指令都不會動」。
   */
  it('舊連線塞滿的佇列不會擋住新遊戲的握手', async () => {
    const connection = createWsMinecraftConnection({ host: '127.0.0.1', port: 0,
      fallbackToRandomPort: false, commandTimeoutMs: 1000, eventBufferSize: 20,
      debugFrames: false, negotiateEncryption: true });
    active = connection;
    await connection.start();
    const address = `ws://127.0.0.1:${String(connection.status().port)}`;

    // 舊遊戲：握手與 primer 正常，之後所有指令一律不回覆。
    const old = new WebSocket(address);
    client = old;
    let primed!: () => void;
    const oldReady = new Promise<void>((resolve) => { primed = resolve; });
    let seenPrimer = false;
    attachFakeGame(old, (command, reply) => {
      if (!seenPrimer && command === 'time query daytime') {
        seenPrimer = true;
        reply();
        primed();
        return true;
      }
      return true;
    });
    await oldReady;
    await connection.awaitConnection(4000);
    expect(connection.status().encrypted).toBe(true);

    // 一條在飛 + 64 條排隊 = 佇列已滿。
    const stalled = Array.from({ length: 64 }, (_unused, index) =>
      connection.runCommand(`testforblock 0 ${String(20 + index)} 0 air`));
    await vi.waitFor(() =>
      expect(connection.status()).toMatchObject({ inFlightCommands: 1, queuedCommands: 63 }));
    // runCommand 先 await 握手才進佇列，所以計數要等一個 tick 才看得到。
    stalled.push(connection.runCommand('testforblock 0 200 0 air'));
    await vi.waitFor(() =>
      expect(connection.status()).toMatchObject({ inFlightCommands: 1, queuedCommands: 64 }));
    await expect(connection.runCommand('say overflow')).rejects.toThrow(/limit/);

    const replacement = new WebSocket(address);
    client = replacement;
    const received: string[] = [];
    attachFakeGame(replacement, (command) => { received.push(command); return false; });
    await new Promise<void>((resolve, reject) => {
      replacement.once('open', resolve); replacement.once('error', reject);
    });

    // 新 session 必須拿到一條空佇列，握手立刻發得出去。
    const status = await connection.awaitConnection(4000);
    expect(status).toMatchObject({ connected: true, encrypted: true, queuedCommands: 0 });
    expect(received).toContain('time query daytime');

    // 舊工作全部回報未送出，而且一條都沒有流進新遊戲。
    const settled = await Promise.all(stalled);
    expect(settled.every((outcome) => !outcome.ok)).toBe(true);
    expect(received.some((command) => command.startsWith('testforblock'))).toBe(false);
    expect(connection.status().queuedCommands).toBe(0);

    // 新連線本身完全可用。
    expect((await connection.runCommand('say after-replacement')).ok).toBe(true);
    old.terminate();
  }, 20_000);

  it('握手完成後 status 回報 encrypted=true', async () => {
    const connection = await startEncryptedHarness();
    expect(connection.status().encrypted).toBe(true);
  });

  it('握手後的指令仍能正確送達與回應', async () => {
    const connection = await startEncryptedHarness();
    const outcome = await connection.runCommand('say hello');
    expect(outcome.ok).toBe(true);
    expect(outcome.statusMessage).toBe('ran say hello');
  });

  it('連續多條加密指令不會讓串流狀態脫序', async () => {
    const connection = await startEncryptedHarness();
    const batch = await connection.runSequence(
      ['say 一', 'say 二', 'say 三', 'setblock 0 64 0 stone'],
      { stopOnError: true, delayMs: 0 },
    );
    expect(batch.ok).toBe(true);
    expect(batch.succeeded).toBe(4);
    expect(batch.outcomes.at(-1)?.statusMessage).toBe('ran setblock 0 64 0 stone');
  });

  it('遊戲不回應握手時退回明文而不是卡死', async () => {
    const connection = createWsMinecraftConnection({
      host: '127.0.0.1',
      port: 0,
      fallbackToRandomPort: false,
      commandTimeoutMs: 1000,
      eventBufferSize: 20,
      debugFrames: false,
      negotiateEncryption: true,
    });
    active = connection;
    await connection.start();

    const port = connection.status().port;
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}`);
    client = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });
    // 故意完全不回應握手。
    socket.on('message', () => {
      /* 沉默 */
    });

    const status = await connection.awaitConnection(10_000);
    expect(status.connected).toBe(true);
    expect(status.encrypted).toBe(false);
  }, 20_000);
});

describe('extractPublicKey', () => {
  it('讀出頂層 publicKey', () => {
    expect(extractPublicKey({ statusCode: 0, publicKey: 'abc' })).toBe('abc');
  });

  it('也接受 snake_case 欄位名', () => {
    expect(extractPublicKey({ public_key: 'xyz' })).toBe('xyz');
  });

  it('會往巢狀物件裡找', () => {
    expect(extractPublicKey({ body: { nested: { publicKey: 'deep' } } })).toBe('deep');
  });

  it('找不到時回 null', () => {
    expect(extractPublicKey({ statusCode: 0 })).toBeNull();
    expect(extractPublicKey(null)).toBeNull();
  });
});

describe('createEncryptionOffer', () => {
  it('產生可解析的 enableencryption 指令', () => {
    const offer = createEncryptionOffer();
    const parts = offer.commandLine.split(' ');
    expect(parts[0]).toBe('enableencryption');
    expect(parts).toHaveLength(3);

    const unquote = (value: string | undefined): string => (value ?? '').replace(/^"|"$/g, '');
    // 公鑰必須是可還原的 SPKI DER。
    expect(() =>
      createPublicKey({
        key: Buffer.from(unquote(parts[1]), 'base64'),
        format: 'der',
        type: 'spki',
      }),
    ).not.toThrow();
    expect(Buffer.from(unquote(parts[2]), 'base64')).toHaveLength(16);
  });

  /**
   * 真機回歸：未加引號時 Minecraft 會在 base64 的第一個 `/` 斷句，回
   * 「語法錯誤：預期外的『/』」，握手失敗後遊戲會靜默丟棄之後所有指令。
   * 產生金鑰直到 `/` 與 `+` 都各出現過，確保含它們的參數一定被引號包住。
   *
   * 舊版固定跑一千組 P-384 金鑰，閒置時約 0.7 秒，機器忙的時候會超過 5 秒的逾時。
   * 一組金鑰的 base64 有一百多個隨機字元，`/`、`+` 各自出現的機率約九成，
   * 通常一兩組就夠；上限 200 組只是保險，兩個字元都等不到的機率小到可以忽略。
   */
  it('兩個參數一律加引號，base64 的 / 與 + 不會截斷指令', () => {
    const seen = new Set<string>();

    for (let i = 0; i < 200 && seen.size < 2; i += 1) {
      const parts = createEncryptionOffer().commandLine.split(' ');
      const publicKey = parts[1] ?? '';
      const salt = parts[2] ?? '';

      expect(publicKey.startsWith('"') && publicKey.endsWith('"')).toBe(true);
      expect(salt.startsWith('"') && salt.endsWith('"')).toBe(true);

      for (const char of ['/', '+']) {
        if (publicKey.includes(char) || salt.includes(char)) seen.add(char);
      }
    }

    // 保護測試本身：/ 與 + 沒有都出現過，這條就沒有真的驗到東西。
    expect([...seen].sort()).toEqual(['+', '/']);
  });

  it('公鑰壞掉時給出明確錯誤而不是崩潰', () => {
    const offer = createEncryptionOffer();
    expect(() => offer.complete('not-a-key')).toThrow(/public key/);
  });
});

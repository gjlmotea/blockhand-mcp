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

import { WebSocket } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

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

/** 模擬遊戲端：完成握手，之後所有收發都加密。 */
function attachFakeGame(socket: WebSocket): void {
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

    send({
      header: { version: 1, requestId: frame.header.requestId, messagePurpose: 'commandResponse' },
      body: { statusCode: 0, statusMessage: `ran ${commandLine}` },
    });
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

describe('websocket 加密握手', () => {
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
   * 這個測試跑一千組金鑰，確保含 `/` 或 `+` 的情況一定被引號包住。
   */
  it('兩個參數一律加引號，base64 的 / 與 + 不會截斷指令', () => {
    let sawSlashOrPlus = false;

    for (let i = 0; i < 1000; i += 1) {
      const parts = createEncryptionOffer().commandLine.split(' ');
      const publicKey = parts[1] ?? '';
      const salt = parts[2] ?? '';

      expect(publicKey.startsWith('"') && publicKey.endsWith('"')).toBe(true);
      expect(salt.startsWith('"') && salt.endsWith('"')).toBe(true);

      if (/[/+]/.test(publicKey) || /[/+]/.test(salt)) sawSlashOrPlus = true;
    }

    // 保護測試本身：如果一千組都沒出現 / 或 +，這條就沒有真的驗到東西。
    expect(sawSlashOrPlus).toBe(true);
  });

  it('公鑰壞掉時給出明確錯誤而不是崩潰', () => {
    const offer = createEncryptionOffer();
    expect(() => offer.complete('not-a-key')).toThrow(/公鑰/);
  });
});

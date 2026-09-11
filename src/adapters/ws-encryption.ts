/**
 * Education Edition 的 WebSocket 加密握手。
 *
 * 為什麼需要這個：Education 的「需要加密的 WebSocket」（設定 → 一般）預設開啟。
 * 開啟時遊戲會連上、也接受指令封包，但在伺服器完成加密握手前**靜默丟棄所有指令**
 * ——不回應、不報錯。症狀就是「連得上，但什麼都不回」，非常難查。
 *
 * 握手流程：
 *   1. 伺服器產生 secp384r1 金鑰對與 16 bytes 隨機 salt。
 *   2. 伺服器以明文送出 `enableencryption <base64 SPKI 公鑰> <base64 salt>`。
 *   3. 遊戲回一個 commandResponse，body 內含它自己的 base64 公鑰。
 *   4. 雙方以 ECDH 算出共享密鑰，secret = SHA256(salt ‖ sharedSecret)。
 *   5. 之後所有訊息以 AES-256-CFB8 加密，key = secret，IV = secret 前 16 bytes。
 *
 * CFB8 是串流模式，cipher 物件必須跨訊息保留狀態，不能每次重建。
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

import { MinecraftBridgeError } from '../domain/contracts.js';

const CURVE = 'secp384r1';
const CIPHER = 'aes-256-cfb8';
const SALT_BYTES = 16;

export interface EncryptionOffer {
  /** 要以明文送出的指令。 */
  readonly commandLine: string;
  /** 收到遊戲公鑰後完成握手，取得雙向串流密碼器。 */
  complete(clientPublicKeyBase64: string): EncryptionSession;
}

export interface EncryptionSession {
  encrypt(plaintext: string): Buffer;
  decrypt(payload: Buffer): string;
}

export function createEncryptionOffer(): EncryptionOffer {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: CURVE });
  const salt = randomBytes(SALT_BYTES);
  const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  return {
    // 兩個參數**必須**加引號：base64 字母表含有 `/` 與 `+`，未加引號時
    // Minecraft 的指令解析器會在第一個 `/` 就中斷，回
    // 「語法錯誤：預期外的『/』」，握手隨即失敗，之後所有指令被遊戲靜默丟棄。
    commandLine: `enableencryption "${publicKeyBase64}" "${salt.toString('base64')}"`,

    complete(clientPublicKeyBase64: string): EncryptionSession {
      const clientKey = parseClientPublicKey(clientPublicKeyBase64);
      const sharedSecret = diffieHellman({ privateKey, publicKey: clientKey });
      const secret = createHash('sha256').update(Buffer.concat([salt, sharedSecret])).digest();
      const iv = secret.subarray(0, 16);

      // CFB8 是串流：這兩個物件必須長期保留，逐訊息推進內部狀態。
      const cipher = createCipheriv(CIPHER, secret, iv);
      const decipher = createDecipheriv(CIPHER, secret, iv);

      return {
        encrypt(plaintext: string): Buffer {
          return cipher.update(Buffer.from(plaintext, 'utf8'));
        },
        decrypt(payload: Buffer): string {
          return decipher.update(payload).toString('utf8');
        },
      };
    },
  };
}

function parseClientPublicKey(base64: string): KeyObject {
  const trimmed = base64.trim();
  if (trimmed === '') {
    throw new MinecraftBridgeError('encryption-failed', '遊戲沒有回傳公鑰，無法完成加密握手。');
  }

  try {
    return createPublicKey({
      key: Buffer.from(trimmed, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch (error: unknown) {
    throw new MinecraftBridgeError(
      'encryption-failed',
      `無法解析遊戲回傳的公鑰：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 從 commandResponse 的 body 撈出遊戲公鑰。
 *
 * 欄位名沒有官方文件，實務上看過 publicKey／public_key 兩種寫法，也可能包在
 * 巢狀物件裡。這裡逐層找而不是寫死一條路徑，避免遊戲改版就整個握手失敗。
 */
export function extractPublicKey(body: Readonly<Record<string, unknown>> | null): string | null {
  if (body === null) return null;

  const direct = body['publicKey'] ?? body['public_key'];
  if (typeof direct === 'string' && direct.length > 0) return direct;

  for (const value of Object.values(body)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const nested = extractPublicKey(value as Record<string, unknown>);
    if (nested !== null) return nested;
  }

  return null;
}

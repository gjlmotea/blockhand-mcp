/**
 * 受控 raw 指令政策。
 *
 * `mcp/README.md` 架構原則 4 要求「拒絕任意執行入口」。這裡的立場是：
 * slash 指令的作用域完全在本機遊戲世界內，不觸及主機檔案系統、行程或網路，
 * 因此不等同任意程式碼執行；真正必須擋掉的是「讓橋接本身失效或改指向」
 * 的指令，以及會把單行請求拆成多行的注入。
 *
 * 因此政策是結構性的，不是靠字串黑名單猜意圖：
 * 1. 一次只允許一行，明確拒絕換行與 NUL。
 * 2. 拒絕會改變或切斷 WebSocket 連線的指令。
 * 3. 其餘指令標記風險等級，交由 MCP Host 依 annotation 決定是否確認。
 */

import { MinecraftBridgeError } from './contracts.js';

/** 會讓遊戲離開這個橋接、或把遊戲指向別的 WebSocket 端點的指令。 */
const BRIDGE_BREAKING = new Set(['wsserver', 'connect', 'closewebsocket']);

/** 影響範圍是整個世界或全體玩家、預期需要 Host 確認的指令。 */
const WIDE_EFFECT = new Set([
  'clear',
  'clone',
  'difficulty',
  'fill',
  'gamerule',
  'kick',
  'kill',
  'op',
  'setworldspawn',
  'structure',
  'deop',
]);

/** 純讀取、不改變世界狀態的指令。 */
const READ_ONLY = new Set([
  'querytarget',
  'testfor',
  'testforblock',
  'testforblocks',
  'list',
  'help',
  'getlocalplayername',
]);

export const COMMAND_RISKS = ['read-only', 'world-write', 'wide-effect'] as const;
export type CommandRisk = (typeof COMMAND_RISKS)[number];

export interface CommandAssessment {
  readonly commandLine: string;
  readonly verb: string;
  readonly risk: CommandRisk;
}

/**
 * `execute` 包著的指令裡有沒有斷線指令。不照語法逐個解析子指令（玩家名稱可以叫 `run`、
 * 可以加引號帶空白，照參數位置找很容易漏），而是保守地看：`execute` 後面任何一個獨立的字
 * 是斷線指令就算。代價是極少數合法指令會被誤擋（例如 `execute … say connect`），改用不包
 * `execute` 的寫法即可；斷線指令寧可多擋。
 */
function breakingInsideExecute(commandLine: string): string | undefined {
  const tokens = commandLine.split(/\s+/).filter((token) => token !== '');
  if ((tokens[0] ?? '').toLowerCase() !== 'execute') return undefined;
  return tokens
    .slice(1)
    .map((token) => token.replace(/^\/+/, '').toLowerCase())
    .find((token) => BRIDGE_BREAKING.has(token));
}

/**
 * 正規化並驗證一行 raw 指令。
 * 通過即回傳去掉前導 `/` 的單行指令與風險等級；不通過一律丟錯，不做「盡力猜測」。
 */
export function assessRawCommand(input: string): CommandAssessment {
  if (input.includes('\0')) {
    throw new MinecraftBridgeError('invalid-command', 'The command must not contain NUL characters.');
  }

  if (/[\n\r]/.test(input)) {
    throw new MinecraftBridgeError(
      'invalid-command',
      'Only one single-line command is accepted per call; make separate calls instead of chaining commands with newlines.',
    );
  }

  const normalized = input.trim().replace(/^\/+/, '').trim();
  if (normalized === '') {
    throw new MinecraftBridgeError('invalid-command', 'The command must not be empty.');
  }

  if (normalized.length > 1024) {
    throw new MinecraftBridgeError(
      'invalid-command',
      `The command is ${String(normalized.length)} characters long, over the limit of 1024.`,
    );
  }

  const verb = (normalized.split(/\s+/)[0] ?? '').toLowerCase();

  const breaking = BRIDGE_BREAKING.has(verb) ? verb : breakingInsideExecute(normalized);
  if (breaking !== undefined) {
    throw new MinecraftBridgeError(
      'command-forbidden',
      `Refused to run ${breaking}: it would cut or redirect this MCP server's WebSocket bridge, and every tool would stop working afterwards. ` +
        'To connect somewhere else, the user has to type it in the game themselves.',
    );
  }

  const risk: CommandRisk = READ_ONLY.has(verb)
    ? 'read-only'
    : WIDE_EFFECT.has(verb)
      ? 'wide-effect'
      : 'world-write';

  return { commandLine: normalized, verb, risk };
}

export function isBridgeBreaking(verb: string): boolean {
  return BRIDGE_BREAKING.has(verb.toLowerCase());
}

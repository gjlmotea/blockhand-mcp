/**
 * BlockHand 領域契約。
 *
 * 這一層只描述「要對遊戲做什麼」與「遊戲回了什麼」，不依賴 MCP transport、
 * 不依賴 ws，也不依賴任何 Node API，因此可以被純函式測試完整覆蓋。
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Bedrock／Education 的座標寫法。
 * - `absolute`：`10 64 -5`
 * - `relative`：`~1 ~0 ~-3`，相對指令發起者
 * - `local`：`^ ^ ^1`，相對發起者面向
 */
export const COORDINATE_MODES = ['absolute', 'relative', 'local'] as const;
export type CoordinateMode = (typeof COORDINATE_MODES)[number];

export interface Coordinate extends Vec3 {
  readonly mode: CoordinateMode;
}

export const AGENT_DIRECTIONS = ['forward', 'back', 'left', 'right', 'up', 'down'] as const;
export type AgentDirection = (typeof AGENT_DIRECTIONS)[number];

export const TURN_DIRECTIONS = ['left', 'right'] as const;
export type TurnDirection = (typeof TURN_DIRECTIONS)[number];

export const BLOCK_HANDLING_MODES = ['replace', 'destroy', 'keep'] as const;
export type BlockHandlingMode = (typeof BLOCK_HANDLING_MODES)[number];

export const FILL_MODES = ['replace', 'destroy', 'keep', 'hollow', 'outline'] as const;
export type FillMode = (typeof FILL_MODES)[number];

/** structure load 的鏡像軸；xz 等於同時對兩軸鏡射。 */
export const STRUCTURE_MIRRORS = ['none', 'x', 'z', 'xz'] as const;
export type StructureMirror = (typeof STRUCTURE_MIRRORS)[number];

/** 單一指令送進遊戲後的結果。遊戲永遠回一包 JSON，這裡保持原樣不猜測。 */
export interface CommandOutcome {
  readonly ok: boolean;
  readonly commandLine: string;
  readonly statusCode: number | null;
  readonly statusMessage: string | null;
  /** 遊戲回傳 body 去掉 statusCode／statusMessage 之後的殘餘欄位。 */
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly elapsedMs: number;
}

/** 一批指令的彙總結果，用於 agent program 與建造。 */
export interface BatchOutcome {
  readonly ok: boolean;
  readonly issued: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly firstFailure: CommandOutcome | null;
  readonly outcomes: readonly CommandOutcome[];
  readonly elapsedMs: number;
}

export interface ConnectionStatus {
  readonly listening: boolean;
  readonly host: string;
  readonly port: number;
  readonly connected: boolean;
  /** 遊戲內要輸入的連線指令。 */
  readonly connectCommand: string;
  readonly connectedAt: string | null;
  readonly connectionCount: number;
  readonly subscribedEvents: readonly string[];
  readonly bufferedEvents: number;
  readonly commandsIssued: number;
  /** 是否已完成 WebSocket 加密握手。Education 的「需要加密的 WebSocket」開啟時必須為 true，否則遊戲會靜默丟棄所有指令。 */
  readonly encrypted: boolean;
}

export interface GameEventRecord {
  readonly cursor: number;
  readonly receivedAt: string;
  readonly eventName: string;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly measurements: Readonly<Record<string, unknown>> | null;
}

export interface GameEventPage {
  readonly events: readonly GameEventRecord[];
  readonly nextCursor: number;
  /** 因緩衝環繞而被丟棄、呼叫端永遠讀不到的事件數。 */
  readonly dropped: number;
}

/**
 * Education Edition WebSocket 已知可訂閱的事件名。
 *
 * 這份清單來自公開的 Bedrock／Education wsserver 觀察，Mojang 沒有官方保證；
 * `mc_events_subscribe` 仍接受清單外的名稱，但會標記為 `unverified`。
 */
export const KNOWN_EVENT_NAMES = [
  'AgentCommand',
  'AgentCreated',
  'BlockBroken',
  'BlockPlaced',
  'BoardTextUpdated',
  'EndOfDay',
  'EntitySpawned',
  'ItemAcquired',
  'ItemCrafted',
  'ItemDestroyed',
  'ItemDropped',
  'ItemEquipped',
  'ItemInteracted',
  'ItemSmelted',
  'ItemUsed',
  'MobInteracted',
  'MobKilled',
  'PlayerBounced',
  'PlayerDied',
  'PlayerMessage',
  'PlayerTeleported',
  'PlayerTransform',
  'PlayerTravelled',
  'SlashCommandExecuted',
  'TargetBlockHit',
  'WorldGenerated',
  'WorldLoaded',
  'WorldUnloaded',
] as const;
export type KnownEventName = (typeof KNOWN_EVENT_NAMES)[number];

/** Bedrock `/fill` 單次上限。超過就必須拆批。 */
export const BEDROCK_FILL_LIMIT = 32768;

export class MinecraftBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MinecraftBridgeError';
    this.code = code;
  }
}

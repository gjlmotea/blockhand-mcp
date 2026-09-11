import type {
  BatchOutcome,
  CommandOutcome,
  ConnectionStatus,
  GameEventPage,
} from '../domain/contracts.js';

export interface SequenceOptions {
  /** 任一步失敗就停止，不繼續送後面的指令。 */
  readonly stopOnError: boolean;
  /** 每步之間的間隔毫秒；Agent 動作需要留時間讓遊戲完成移動。 */
  readonly delayMs: number;
}

/**
 * 與 Minecraft Education 之間的連線抽象。
 *
 * application 層只認得這個介面，不知道底下是 WebSocket；
 * 因此測試可以塞入一個純記憶體的假連線，完全不需要開遊戲。
 */
export interface MinecraftConnection {
  start(): Promise<void>;
  close(): Promise<void>;
  status(): ConnectionStatus;
  awaitConnection(timeoutMs: number): Promise<ConnectionStatus>;
  runCommand(commandLine: string): Promise<CommandOutcome>;
  runSequence(commandLines: readonly string[], options: SequenceOptions): Promise<BatchOutcome>;
  subscribe(eventName: string): Promise<void>;
  unsubscribe(eventName: string): Promise<void>;
  readEvents(afterCursor: number, limit: number, eventName: string | null): GameEventPage;
}

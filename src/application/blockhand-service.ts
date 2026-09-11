/**
 * BlockHand 應用服務：把 MCP 工具呼叫翻成 slash 指令，並把遊戲回應整理成
 * 結構化結果。這一層不認識 WebSocket，只認識 `MinecraftConnection` port。
 */

import type {
  AgentDirection,
  BatchOutcome,
  CommandOutcome,
  ConnectionStatus,
  GameEventPage,
  TurnDirection,
} from '../domain/contracts.js';
import { KNOWN_EVENT_NAMES } from '../domain/contracts.js';
import { agentCommands } from '../domain/commands.js';
import type { CommandAssessment } from '../domain/command-policy.js';
import { assessRawCommand } from '../domain/command-policy.js';
import type { MinecraftConnection, SequenceOptions } from '../ports/minecraft-connection.js';

export interface AgentMoveStep {
  readonly action: 'move';
  readonly direction: AgentDirection;
  readonly steps: number;
}
export interface AgentTurnStep {
  readonly action: 'turn';
  readonly direction: TurnDirection;
  readonly times: number;
}
export interface AgentDirectionalStep {
  readonly action: 'attack' | 'destroy' | 'till' | 'dropAll';
  readonly direction: AgentDirection;
}
export interface AgentPlaceStep {
  readonly action: 'place';
  readonly slot: number;
  readonly direction: AgentDirection;
}
export interface AgentCollectStep {
  readonly action: 'collect';
  readonly item: string | null;
}
export interface AgentDropStep {
  readonly action: 'drop';
  readonly slot: number;
  readonly quantity: number;
  readonly direction: AgentDirection;
}
export interface AgentTransferStep {
  readonly action: 'transfer';
  readonly sourceSlot: number;
  readonly quantity: number;
  readonly destinationSlot: number;
}

export type AgentProgramStep =
  | AgentMoveStep
  | AgentTurnStep
  | AgentDirectionalStep
  | AgentPlaceStep
  | AgentCollectStep
  | AgentDropStep
  | AgentTransferStep;

/** 把一段 Agent 程式展開成逐條 slash 指令。純函式，可單獨測試。 */
export function expandAgentProgram(steps: readonly AgentProgramStep[]): string[] {
  const commands: string[] = [];

  for (const step of steps) {
    switch (step.action) {
      case 'move':
        for (let i = 0; i < step.steps; i += 1) commands.push(agentCommands.move(step.direction));
        break;
      case 'turn':
        for (let i = 0; i < step.times; i += 1) commands.push(agentCommands.turn(step.direction));
        break;
      case 'attack':
        commands.push(agentCommands.attack(step.direction));
        break;
      case 'destroy':
        commands.push(agentCommands.destroy(step.direction));
        break;
      case 'till':
        commands.push(agentCommands.till(step.direction));
        break;
      case 'dropAll':
        commands.push(agentCommands.dropAll(step.direction));
        break;
      case 'place':
        commands.push(agentCommands.place(step.slot, step.direction));
        break;
      case 'collect':
        commands.push(
          step.item === null ? agentCommands.collectAll() : agentCommands.collect(step.item),
        );
        break;
      case 'drop':
        commands.push(agentCommands.drop(step.slot, step.quantity, step.direction));
        break;
      case 'transfer':
        commands.push(
          agentCommands.transfer(step.sourceSlot, step.quantity, step.destinationSlot),
        );
        break;
      default: {
        const exhaustive: never = step;
        throw new Error(`未知的 Agent 步驟：${JSON.stringify(exhaustive)}`);
      }
    }
  }

  return commands;
}

/**
 * `querytarget` 會把結果塞在 body.details 的 JSON 字串裡。
 * 解析失敗時回 null 而不是丟錯——遊戲版本改格式時不該讓整個工具崩掉。
 */
export function parseQueryTargetDetails(outcome: CommandOutcome): unknown {
  const details = outcome.data?.['details'];
  if (typeof details !== 'string') return null;
  try {
    return JSON.parse(details) as unknown;
  } catch {
    return null;
  }
}

export interface BlockHandServiceOptions {
  readonly version: string;
  readonly defaultStepDelayMs: number;
}

export function createBlockHandService(
  connection: MinecraftConnection,
  options: BlockHandServiceOptions,
) {
  const savedStructures = new Map<string, 'memory' | 'disk'>();

  return {
    version: options.version,

    /**
     * 本次連線存過的結構。遊戲沒有「列出已存結構」的指令，所以 AI 反覆修改
     * 同一棟建築時，唯一能知道「我剛才存過哪些版本」的辦法就是自己記。
     * 只涵蓋本行程，重啟就沒了——disk 模式的檔案仍在，但名字要靠使用者記。
     */
    rememberStructure(name: string, mode: 'memory' | 'disk'): void {
      savedStructures.set(name, mode);
    },

    status(): ConnectionStatus {
      return connection.status();
    },

    savedStructures(): readonly { readonly name: string; readonly saveMode: string }[] {
      return [...savedStructures].map(([name, saveMode]) => ({ name, saveMode }));
    },

    async awaitConnection(timeoutMs: number): Promise<ConnectionStatus> {
      return await connection.awaitConnection(timeoutMs);
    },

    async run(commandLine: string): Promise<CommandOutcome> {
      return await connection.runCommand(commandLine);
    },

    async runMany(
      commandLines: readonly string[],
      sequenceOptions?: Partial<SequenceOptions>,
    ): Promise<BatchOutcome> {
      return await connection.runSequence(commandLines, {
        stopOnError: sequenceOptions?.stopOnError ?? false,
        delayMs: sequenceOptions?.delayMs ?? 0,
      });
    },

    assessRaw(commandLine: string): CommandAssessment {
      return assessRawCommand(commandLine);
    },

    async runAgentProgram(
      steps: readonly AgentProgramStep[],
      stopOnError: boolean,
      delayMs: number | null,
    ): Promise<{ readonly commands: readonly string[]; readonly batch: BatchOutcome }> {
      const commands = expandAgentProgram(steps);
      const batch = await connection.runSequence(commands, {
        stopOnError,
        delayMs: delayMs ?? options.defaultStepDelayMs,
      });
      return { commands, batch };
    },

    async subscribe(eventName: string): Promise<{ readonly verified: boolean }> {
      await connection.subscribe(eventName);
      return {
        verified: (KNOWN_EVENT_NAMES as readonly string[]).includes(eventName),
      };
    },

    async unsubscribe(eventName: string): Promise<void> {
      await connection.unsubscribe(eventName);
    },

    readEvents(afterCursor: number, limit: number, eventName: string | null): GameEventPage {
      return connection.readEvents(afterCursor, limit, eventName);
    },

    knownEventNames(): readonly string[] {
      return KNOWN_EVENT_NAMES;
    },
  };
}

export type BlockHandService = ReturnType<typeof createBlockHandService>;

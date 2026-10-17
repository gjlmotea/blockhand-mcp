import type { Coordinate } from '../domain/contracts.js';
import type { BatchOutcome, CommandOutcome } from '../domain/contracts.js';

/**
 * MCP SDK 的 CallToolResult 帶有 `[x: string]: unknown` 索引簽章，而 interface
 * 不會取得隱含索引簽章、type alias 才會——所以這裡必須用 type 而不是 interface。
 * content 也必須是可變陣列，不能加 readonly。
 */
export type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
};

export function ok(payload: Record<string, unknown>, summary: string): ToolResult {
  return {
    content: [{ type: 'text', text: summary }],
    structuredContent: payload,
    isError: false,
  };
}

/**
 * 失敗一律只回文字、不帶 structuredContent。
 * MCP SDK 只在成功時要求 structuredContent 符合 outputSchema，
 * 所以這樣可以讓錯誤訊息保持人看得懂，而不必硬塞一個假的成功形狀。
 */
export function fail(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 把工具處理器包起來，讓領域錯誤變成乾淨的 isError 回應而不是 protocol 例外。 */
export async function guard(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error: unknown) {
    return fail(describeError(error));
  }
}

export function outcomeToPayload(outcome: CommandOutcome): Record<string, unknown> {
  return {
    ok: outcome.ok,
    commandLine: outcome.commandLine,
    statusCode: outcome.statusCode,
    statusMessage: outcome.statusMessage,
    data: outcome.data,
    elapsedMs: outcome.elapsedMs,
    ...(outcome.undo ? { undo: { ...outcome.undo } } : {}),
  };
}

export function batchToPayload(batch: BatchOutcome): Record<string, unknown> {
  return {
    ok: batch.ok,
    issued: batch.issued,
    succeeded: batch.succeeded,
    failed: batch.failed,
    firstFailure: batch.firstFailure === null ? null : outcomeToPayload(batch.firstFailure),
    outcomes: batch.outcomes.map(outcomeToPayload),
    elapsedMs: batch.elapsedMs,
    ...(batch.undo ? { undo: { ...batch.undo } } : {}),
  };
}

/** 遊戲內建、任何開了作弊的世界都認得的指令。 */
const BUILT_IN_VERBS = new Set([
  'ability', 'agent', 'camera', 'clear', 'clone', 'effect', 'execute', 'fill', 'function', 'gamemode', 'gamerule',
  'give', 'hud', 'kill', 'list', 'particle', 'playsound', 'querytarget', 'replaceitem', 'say', 'scoreboard',
  'scriptevent', 'setblock', 'structure', 'summon', 'teleport', 'tellraw', 'testfor', 'testforblock',
  'testforblocks', 'time', 'title', 'titleraw', 'tp', 'weather',
]);

/** 遊戲回「不明的指令」的兩種語系（commands.generic.unknown）。 */
const UNKNOWN_COMMAND = /^(?:不明的指令：|Unknown command: )([^。.\s]+)/u;

/**
 * 內建指令也回「不明的指令」時，多半不是指令錯了，而是遊戲不在世界裡：
 * 回到主選單或世界清單時橋接仍然連著，但所有指令都被當成不認得。
 */
export function notInWorldHint(outcome: CommandOutcome): string {
  if (outcome.ok || outcome.statusMessage === null) return '';
  const verb = UNKNOWN_COMMAND.exec(outcome.statusMessage)?.[1]?.toLowerCase();
  if (verb === undefined || !BUILT_IN_VERBS.has(verb)) return '';
  return `（${verb} 是內建指令卻被當成不認得：遊戲多半不在世界裡，例如回到主選單或世界清單，或世界沒開作弊。先截圖確認畫面。）`;
}

export function summarizeOutcome(outcome: CommandOutcome): string {
  const undoNote=outcome.undo ? ` ${outcome.undo.reason ?? ''}（備份 ${outcome.undo.storedBlocks} 格／${outcome.undo.snapshotCount} 區）` : '';
  if (outcome.ok) {
    return (outcome.statusMessage ?? `已執行：${outcome.commandLine}`)+undoNote;
  }
  return `失敗：${outcome.commandLine}｜${outcome.statusMessage ?? '遊戲沒有回報原因'}${notInWorldHint(outcome)}`+undoNote;
}

export function summarizeBatch(batch: BatchOutcome, label: string): string {
  const undoNote=batch.undo ? ` ${batch.undo.reason ?? ''}（備份 ${batch.undo.storedBlocks} 格／${batch.undo.snapshotCount} 區）` : '';
  if (batch.ok) {
    return `${label}：${String(batch.succeeded)} 條指令全部成功，用時 ${String(batch.elapsedMs)} ms。`+undoNote;
  }
  const reason = (batch.firstFailure?.statusMessage ?? '遊戲沒有回報原因') + (batch.firstFailure ? notInWorldHint(batch.firstFailure) : '');
  return `${label}：${String(batch.succeeded)}/${String(batch.issued)} 成功，${String(batch.failed)} 失敗。首個失敗：${batch.firstFailure?.commandLine ?? '未知'}｜${reason}`+undoNote;
}

/** zod 已經套用 mode 預設值，這裡只是把形狀轉成領域型別。 */
export function toCoordinate(input: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly mode: 'absolute' | 'relative' | 'local';
}): Coordinate {
  return { x: input.x, y: input.y, z: input.z, mode: input.mode };
}

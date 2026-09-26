import { createWsMinecraftConnection } from './adapters/ws-minecraft-connection.js';
import { createBlockHandService } from './application/blockhand-service.js';
import { createBuildService } from './application/build-service.js';
import { createUndoConnection } from './application/undo-service.js';
import { DEFAULT_UNDO_BLOCKS, MAX_UNDO_BLOCKS } from './domain/build/undo-plan.js';
import type { MinecraftConnection } from './ports/minecraft-connection.js';

export interface RuntimeConfig {
  readonly undoEnabled?: boolean;
  readonly maxUndoBlocks?: number;
  readonly host: string;
  readonly port: number;
  readonly fallbackToRandomPort: boolean;
  readonly commandTimeoutMs: number;
  readonly keepaliveIntervalMs: number;
  readonly eventBufferSize: number;
  readonly maxBuildBlocks: number;
  readonly stepDelayMs: number;
  readonly debugFrames: boolean;
  readonly negotiateEncryption: boolean;
}

const DEFAULTS: RuntimeConfig = {
  host: '127.0.0.1',
  port: 19131,
  fallbackToRandomPort: true,
  commandTimeoutMs: 10_000,
  keepaliveIntervalMs: 30_000,
  eventBufferSize: 500,
  maxBuildBlocks: 40_000_000,
  stepDelayMs: 100,
  debugFrames: false,
  negotiateEncryption: true,
};

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function readRuntimeConfig(): RuntimeConfig {
  const host = process.env['MINECRAFT_EDU_WS_HOST']?.trim();
  return {
    // 預設關閉：Education 1.26.x 上 Undo 的 version 25 原生檢查會卡死整條指令通道（見 agents/docs/undo/region-undo.md）。
    undoEnabled: process.env['MINECRAFT_EDU_UNDO_ENABLED'] === '1',
    maxUndoBlocks: readInt('MINECRAFT_EDU_UNDO_MAX_BLOCKS', DEFAULT_UNDO_BLOCKS, 1, MAX_UNDO_BLOCKS),
    host: host === undefined || host === '' ? DEFAULTS.host : host,
    // 0 是 Node 的正式語意：請作業系統配發空閒埠。一般使用仍預設 19131，
    // doctor／隔離 smoke 可明確設 0，避免碰到使用中的 MCP task。
    port: readInt('MINECRAFT_EDU_WS_PORT', DEFAULTS.port, 0, 65_535),
    fallbackToRandomPort: process.env['MINECRAFT_EDU_WS_PORT_FALLBACK'] !== '0',
    commandTimeoutMs: readInt('MINECRAFT_EDU_COMMAND_TIMEOUT_MS', DEFAULTS.commandTimeoutMs, 500, 120_000),
    // 閒置保活的探測間隔。調小可更快發現真的斷線，但會更常打擾遊戲；
    // 主要存在理由是讓測試不必真的等 30 秒。
    keepaliveIntervalMs: readInt(
      'MINECRAFT_EDU_KEEPALIVE_INTERVAL_MS',
      DEFAULTS.keepaliveIntervalMs,
      1_000,
      600_000,
    ),
    eventBufferSize: readInt('MINECRAFT_EDU_EVENT_BUFFER', DEFAULTS.eventBufferSize, 10, 20_000),
    maxBuildBlocks: readInt('MINECRAFT_EDU_MAX_BUILD_BLOCKS', DEFAULTS.maxBuildBlocks, 1, 40_000_000),
    stepDelayMs: readInt('MINECRAFT_EDU_STEP_DELAY_MS', DEFAULTS.stepDelayMs, 0, 5_000),
    debugFrames: process.env['MINECRAFT_EDU_DEBUG_FRAMES'] === '1',
    // 預設嘗試握手。Education 的「需要加密的 WebSocket」開啟時這是必要的，
    // 關閉時握手失敗也只會退回明文，所以預設開著沒有壞處。
    negotiateEncryption: process.env['MINECRAFT_EDU_ENCRYPTION'] !== '0',
  };
}

export function composeRuntime(version: string, config: RuntimeConfig, connection?: MinecraftConnection) {
  const activeConnection =
    connection ??
    createWsMinecraftConnection({
      host: config.host,
      port: config.port,
      fallbackToRandomPort: config.fallbackToRandomPort,
      commandTimeoutMs: config.commandTimeoutMs,
      keepaliveIntervalMs: config.keepaliveIntervalMs,
      eventBufferSize: config.eventBufferSize,
      debugFrames: config.debugFrames,
      negotiateEncryption: config.negotiateEncryption,
    });

  const protectedWorld = createUndoConnection(activeConnection, {
    enabled: config.undoEnabled ?? false,
    maxBlocks: config.maxUndoBlocks ?? DEFAULT_UNDO_BLOCKS,
  });
  const service = createBlockHandService(protectedWorld.connection, {
    version,
    defaultStepDelayMs: config.stepDelayMs,
    undo: protectedWorld.undo,
  });

  const build = createBuildService(protectedWorld.connection, { maxBuildBlocks: config.maxBuildBlocks });

  return { connection: protectedWorld.connection, service, build };
}

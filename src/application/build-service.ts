/**
 * 建造服務：形狀 → 方塊座標 → 最少 `/fill` 批次 → 實際送進遊戲。
 *
 * 這裡刻意把「規劃」與「執行」拆成兩個公開方法。`mcp/README.md` 架構原則 3
 * 要求先讀後寫，而建造是這個 server 唯一會大規模改變世界的動作，
 * 所以呼叫端永遠可以先拿到方塊數、邊界盒與批次數再決定要不要動手。
 */

import type { BatchOutcome, Coordinate, Vec3 } from '../domain/contracts.js';
import { BEDROCK_FILL_LIMIT, MinecraftBridgeError } from '../domain/contracts.js';
import { assertBlockStates, assertIdentifier, worldCommands } from '../domain/commands.js';
import { boundingBox } from '../domain/coordinates.js';
import type { FillBatch } from '../domain/build/fill-planner.js';
import { planBoxFills, planPointFills, totalBlocks } from '../domain/build/fill-planner.js';
import type { ShapeSpec } from '../domain/build/shapes.js';
import { generateShape } from '../domain/build/shapes.js';
import type { MinecraftConnection } from '../ports/minecraft-connection.js';

export interface BuildPlan {
  readonly shape: ShapeSpec['kind'];
  readonly block: string;
  readonly blockStates: string | null;
  readonly blockCount: number;
  readonly fillBatches: number;
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };
  /** 相對於逐格 setblock 少送了幾次指令。 */
  readonly savedCommands: number;
}

export interface BuildExecution {
  readonly plan: BuildPlan;
  readonly batch: BatchOutcome;
}

export interface BlueprintEntry {
  readonly position: Vec3;
  readonly block: string;
  readonly blockStates?: string | undefined;
}

interface PlannedFills {
  readonly plan: BuildPlan;
  readonly commands: readonly string[];
}

export interface BuildServiceOptions {
  readonly maxBuildBlocks: number;
}

function toAbsolute(position: Vec3): Coordinate {
  return { x: position.x, y: position.y, z: position.z, mode: 'absolute' };
}

function batchesToCommands(
  batches: readonly FillBatch[],
  block: string,
  blockStates: string | null,
): string[] {
  return batches.map((batch) =>
    batch.blockCount === 1
      ? worldCommands.setBlock(toAbsolute(batch.from), block, blockStates, null)
      : worldCommands.fill(
          toAbsolute(batch.from),
          toAbsolute(batch.to),
          block,
          blockStates,
          null,
          null,
          null,
        ),
  );
}

export function createBuildService(
  connection: MinecraftConnection,
  options: BuildServiceOptions,
) {
  function planShape(
    spec: ShapeSpec,
    block: string,
    blockStates: string | null,
  ): PlannedFills {
    assertIdentifier(block, 'block ID');
    if (blockStates !== null) assertBlockStates(blockStates);

    // 實心長方體走的快速路徑不經過 scanSolid 的體積守門，所以這裡得自己先擋：
    // 否則一個跨度百萬的 box 會在 splitBox 遞迴拆批時就把行程的記憶體吃光，
    // 而 maxBuildBlocks 的檢查在拆批「之後」才做，來不及。
    if (spec.kind === 'box' && !spec.hollow) {
      const volume =
        (Math.abs(spec.to.x - spec.from.x) + 1) *
        (Math.abs(spec.to.y - spec.from.y) + 1) *
        (Math.abs(spec.to.z - spec.from.z) + 1);
      if (volume > options.maxBuildBlocks) {
        throw new MinecraftBridgeError(
          'build-too-large',
          `This build needs ${String(volume)} blocks, over the per-build limit of ${String(options.maxBuildBlocks)}; make it smaller or split it into batches.`,
        );
      }
    }

    // 實心長方體不必展開成點集合，直接切批就是最佳解。
    const batches =
      spec.kind === 'box' && !spec.hollow
        ? planBoxFills(spec.from, spec.to, BEDROCK_FILL_LIMIT)
        : planPointFills(generateShape(spec), BEDROCK_FILL_LIMIT);

    const blockCount = totalBlocks(batches);
    if (blockCount === 0) {
      throw new MinecraftBridgeError('empty-shape', 'These parameters produced no blocks.');
    }
    if (blockCount > options.maxBuildBlocks) {
      throw new MinecraftBridgeError(
        'build-too-large',
        `This build needs ${String(blockCount)} blocks, over the per-build limit of ${String(options.maxBuildBlocks)}; make it smaller or split it into batches.`,
      );
    }

    const corners = batches.flatMap((batch) => [batch.from, batch.to]);
    const bounds = boundingBox(corners);

    return {
      plan: {
        shape: spec.kind,
        block,
        blockStates,
        blockCount,
        fillBatches: batches.length,
        bounds,
        savedCommands: blockCount - batches.length,
      },
      commands: batchesToCommands(batches, block, blockStates),
    };
  }

  function planBlueprint(entries: readonly BlueprintEntry[]): PlannedFills {
    if (entries.length === 0) {
      throw new MinecraftBridgeError('empty-shape', 'The blueprint has no blocks.');
    }

    // 同一種方塊（含狀態）才能合併成同一批 fill。
    const groups = new Map<string, { block: string; states: string | null; points: Vec3[] }>();
    for (const entry of entries) {
      assertIdentifier(entry.block, 'block ID');
      const states = entry.blockStates ?? null;
      if (states !== null) assertBlockStates(states);
      const key = `${entry.block}|${states ?? ''}`;
      const group = groups.get(key);
      if (group === undefined) {
        groups.set(key, { block: entry.block, states, points: [entry.position] });
      } else {
        group.points.push(entry.position);
      }
    }

    const commands: string[] = [];
    const allCorners: Vec3[] = [];
    let blockCount = 0;
    let fillBatches = 0;

    for (const group of groups.values()) {
      const batches = planPointFills(group.points, BEDROCK_FILL_LIMIT);
      blockCount += totalBlocks(batches);
      fillBatches += batches.length;
      for (const batch of batches) {
        allCorners.push(batch.from, batch.to);
      }
      commands.push(...batchesToCommands(batches, group.block, group.states));
    }

    if (blockCount > options.maxBuildBlocks) {
      throw new MinecraftBridgeError(
        'build-too-large',
        `This blueprint needs ${String(blockCount)} blocks, over the per-build limit of ${String(options.maxBuildBlocks)}.`,
      );
    }

    const firstGroup = [...groups.values()][0];
    return {
      plan: {
        shape: 'box',
        block: groups.size === 1 ? (firstGroup?.block ?? 'mixed') : 'mixed',
        blockStates: null,
        blockCount,
        fillBatches,
        bounds: boundingBox(allCorners),
        savedCommands: blockCount - fillBatches,
      },
      commands,
    };
  }

  return {
    previewShape(spec: ShapeSpec, block: string, blockStates: string | null): BuildPlan {
      return planShape(spec, block, blockStates).plan;
    },

    async buildShape(
      spec: ShapeSpec,
      block: string,
      blockStates: string | null,
    ): Promise<BuildExecution> {
      const planned = planShape(spec, block, blockStates);
      const batch = await connection.runSequence(planned.commands, {
        stopOnError: false,
        delayMs: 0,
      });
      return { plan: planned.plan, batch };
    },

    previewBlueprint(entries: readonly BlueprintEntry[]): BuildPlan {
      return planBlueprint(entries).plan;
    },

    async buildBlueprint(entries: readonly BlueprintEntry[]): Promise<BuildExecution> {
      const planned = planBlueprint(entries);
      const batch = await connection.runSequence(planned.commands, {
        stopOnError: false,
        delayMs: 0,
      });
      return { plan: planned.plan, batch };
    },
  };
}

export type BuildService = ReturnType<typeof createBuildService>;

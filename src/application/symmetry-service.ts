import type { Vec3 } from '../domain/contracts.js';
import { MinecraftBridgeError } from '../domain/contracts.js';
import type { StructureMirror } from '../domain/contracts.js';
import { worldCommands } from '../domain/commands.js';
import type { CellVerdict, SymmetrySummary } from '../domain/build/symmetry.js';
import {
  assertStructureFits,
  normalizeRegion,
  regionSize,
  subdivideRegion,
  summarizeSymmetry,
  translateCell,
} from '../domain/build/symmetry.js';

/**
 * 鏡像對稱分析。
 *
 * `testforblocks` 只會平移比對，不會鏡像，所以無法直接問「這棟建築左右對稱嗎」。
 * 這裡的作法是先用 `structure save` 把區域存下來，再用 `structure load` 的
 * mirror 參數把它**鏡像**放到一塊暫存區，然後拿原區跟暫存區做 `testforblocks`。
 *
 * 整體不對稱時再細分逐格比對——因為一個「不對稱」對老師沒有用，他要知道
 * 哪一塊不對稱。細分後每格一條指令，成本仍遠低於逐方塊。
 *
 * **這個操作會暫時寫入暫存區**。流程一定先把暫存區原內容存起來，比對完再放
 * 回去；備份失敗就直接中止，絕不在沒有備份的情況下覆寫。
 */

const SOURCE_STRUCTURE = 'blockhand_sym_src';
const BACKUP_STRUCTURE = 'blockhand_sym_bak';

export interface SymmetryRequest {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly mirror: Exclude<StructureMirror, 'none'>;
  readonly scratch: Vec3;
  readonly cellsPerAxis: number;
}

export interface SymmetryReport extends SymmetrySummary {
  readonly mirror: StructureMirror;
  readonly commandsIssued: number;
  /** 暫存區是否已還原。false 代表世界被留下改動，呼叫端必須據實回報。 */
  readonly scratchRestored: boolean;
}

interface Runner {
  run(commandLine: string): Promise<{ readonly ok: boolean; readonly statusMessage: string | null }>;
}

function scratchRegionFor(scratch: Vec3, size: Vec3) {
  return {
    min: scratch,
    max: { x: scratch.x + size.x - 1, y: scratch.y + size.y - 1, z: scratch.z + size.z - 1 },
  };
}

function overlaps(left: { min: Vec3; max: Vec3 }, right: { min: Vec3; max: Vec3 }): boolean {
  return (
    left.min.x <= right.max.x &&
    left.max.x >= right.min.x &&
    left.min.y <= right.max.y &&
    left.max.y >= right.min.y &&
    left.min.z <= right.max.z &&
    left.max.z >= right.min.z
  );
}

const absolute = (point: Vec3) => ({ ...point, mode: 'absolute' as const });

export async function analyzeSymmetry(
  runner: Runner,
  request: SymmetryRequest,
): Promise<SymmetryReport> {
  const region = normalizeRegion(request.from, request.to);
  assertStructureFits(region);
  const size = regionSize(region);
  const scratch = scratchRegionFor(request.scratch, size);

  // 暫存區疊到分析區上，鏡像副本會把原始建築蓋掉——那不只是分析失準，是真的
  // 毀了使用者的東西。
  if (overlaps(region, scratch)) {
    throw new MinecraftBridgeError(
      'invalid-shape',
      '暫存區與分析區重疊；鏡像副本會覆蓋原始建築。請把 scratch 移到不相交的位置。',
    );
  }

  let commandsIssued = 0;
  const run = async (commandLine: string) => {
    commandsIssued += 1;
    return await runner.run(commandLine);
  };

  const saved = await run(
    worldCommands.saveStructure(SOURCE_STRUCTURE, absolute(region.min), absolute(region.max), false, 'memory'),
  );
  if (!saved.ok) {
    throw new MinecraftBridgeError(
      'command-failed',
      `無法保存分析區（區塊可能未載入）：${saved.statusMessage ?? '未知原因'}`,
    );
  }

  const backedUp = await run(
    worldCommands.saveStructure(BACKUP_STRUCTURE, absolute(scratch.min), absolute(scratch.max), false, 'memory'),
  );
  if (!backedUp.ok) {
    // 沒有備份就不動世界。這裡中止比留下一塊被覆蓋的區域好。
    await run(worldCommands.deleteStructure(SOURCE_STRUCTURE));
    throw new MinecraftBridgeError(
      'command-failed',
      `無法備份暫存區，已中止且未改動世界：${backedUp.statusMessage ?? '未知原因'}`,
    );
  }

  // 清理不能放在 finally 裡再回填欄位：return 的物件在 finally 執行前就已建好，
  // scratchRestored 會永遠是初始值，等於對呼叫端謊報世界狀態。
  let verdicts: CellVerdict[] = [];
  let failure: unknown = null;
  try {
    const mirrored = await run(
      worldCommands.loadStructure(SOURCE_STRUCTURE, absolute(scratch.min), request.mirror),
    );
    if (!mirrored.ok) {
      throw new MinecraftBridgeError(
        'command-failed',
        `鏡像副本放置失敗：${mirrored.statusMessage ?? '未知原因'}`,
      );
    }

    const whole = await run(
      worldCommands.testForBlocks(absolute(region.min), absolute(region.max), absolute(scratch.min), false),
    );

    if (whole.ok) {
      // 整體就通過，不必再花指令細分。
      verdicts = [{ min: region.min, max: region.max, symmetric: true }];
    } else {
      const cells = subdivideRegion(region, request.cellsPerAxis);
      for (const cell of cells) {
        const counterpart = translateCell(cell, scratch.min);
        const outcome = await run(
          worldCommands.testForBlocks(
            absolute(cell.min),
            absolute(cell.max),
            absolute(counterpart.min),
            false,
          ),
        );
        verdicts.push({ min: cell.min, max: cell.max, symmetric: outcome.ok });
      }
    }
  } catch (error) {
    failure = error;
  }

  // 不論成敗都要還原：暫存區已經被鏡像副本蓋掉了，留著就是把使用者的世界弄髒。
  const restored = await run(worldCommands.loadStructure(BACKUP_STRUCTURE, absolute(scratch.min)));
  await run(worldCommands.deleteStructure(SOURCE_STRUCTURE));
  await run(worldCommands.deleteStructure(BACKUP_STRUCTURE));

  if (failure !== null) throw failure;
  return {
    ...summarizeSymmetry(verdicts),
    mirror: request.mirror,
    commandsIssued,
    scratchRestored: restored.ok,
  };
}

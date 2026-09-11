import type { Vec3 } from '../contracts.js';
import { MinecraftBridgeError } from '../contracts.js';

/**
 * 對稱性分析的純幾何層：只算「要比哪些格子」與「怎麼記分」，不碰遊戲。
 *
 * 為什麼要細分而不是只比整體：`testforblocks` 只回是非。整棟不對稱時，
 * 一個 false 對老師毫無用處——他要知道**哪裡**不對稱。切成格子逐格比，
 * 就能同時給出分數與位置，成本仍然是每格一條指令而不是每方塊一條。
 */

export interface Region {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface Cell {
  readonly min: Vec3;
  readonly max: Vec3;
  /** 相對整體最小角的位移；掃描鏡像副本時要用同一個位移。 */
  readonly offset: Vec3;
}

/** 每軸細分上限。3 軸各 4 段 = 64 格 = 64 條指令，再多就會撞到 host 逾時。 */
export const MAX_CELLS_PER_AXIS = 4;

export function normalizeRegion(from: Vec3, to: Vec3): Region {
  return {
    min: {
      x: Math.min(from.x, to.x),
      y: Math.min(from.y, to.y),
      z: Math.min(from.z, to.z),
    },
    max: {
      x: Math.max(from.x, to.x),
      y: Math.max(from.y, to.y),
      z: Math.max(from.z, to.z),
    },
  };
}

export function regionSize(region: Region): Vec3 {
  return {
    x: region.max.x - region.min.x + 1,
    y: region.max.y - region.min.y + 1,
    z: region.max.z - region.min.z + 1,
  };
}

/**
 * Bedrock `structure save` 的體積上限。超過遊戲會直接拒絕，先擋掉比讓使用者
 * 看到看不懂的遊戲錯誤好。
 */
export const MAX_STRUCTURE_SPAN: Vec3 = { x: 64, y: 384, z: 64 };

export function assertStructureFits(region: Region): void {
  const size = regionSize(region);
  const over = (['x', 'y', 'z'] as const).filter((axis) => size[axis] > MAX_STRUCTURE_SPAN[axis]);
  if (over.length > 0) {
    throw new MinecraftBridgeError(
      'shape-too-large',
      `區域超過 structure 指令上限（x/y/z 各 ${String(MAX_STRUCTURE_SPAN.x)}/${String(MAX_STRUCTURE_SPAN.y)}/${String(MAX_STRUCTURE_SPAN.z)}）：` +
        `超標軸 ${over.join('、')}，實際 ${String(size.x)}×${String(size.y)}×${String(size.z)}。`,
    );
  }
}

/**
 * 把區域切成 cellsPerAxis³ 個格子。
 *
 * 邊界用累進取整而不是固定格寬，否則不能整除時最後一格會超出區域或漏格。
 */
export function subdivideRegion(region: Region, cellsPerAxis: number): Cell[] {
  if (!Number.isInteger(cellsPerAxis) || cellsPerAxis < 1) {
    throw new MinecraftBridgeError('invalid-shape', '細分數必須是 1 以上的整數。');
  }
  if (cellsPerAxis > MAX_CELLS_PER_AXIS) {
    throw new MinecraftBridgeError(
      'shape-too-large',
      `每軸細分上限 ${String(MAX_CELLS_PER_AXIS)}；再多會撞到 MCP host 逾時。`,
    );
  }

  const size = regionSize(region);
  const bounds = (axis: 'x' | 'y' | 'z'): number[] => {
    // 該軸格數不能超過它的實際長度，否則會切出零寬度的格子。
    const slices = Math.min(cellsPerAxis, size[axis]);
    const edges: number[] = [];
    for (let index = 0; index <= slices; index += 1) {
      edges.push(Math.round((size[axis] * index) / slices));
    }
    return edges;
  };

  const xs = bounds('x');
  const ys = bounds('y');
  const zs = bounds('z');
  const cells: Cell[] = [];
  for (let iz = 0; iz < zs.length - 1; iz += 1) {
    for (let iy = 0; iy < ys.length - 1; iy += 1) {
      for (let ix = 0; ix < xs.length - 1; ix += 1) {
        const offset = { x: xs[ix]!, y: ys[iy]!, z: zs[iz]! };
        cells.push({
          offset,
          min: {
            x: region.min.x + offset.x,
            y: region.min.y + offset.y,
            z: region.min.z + offset.z,
          },
          max: {
            x: region.min.x + xs[ix + 1]! - 1,
            y: region.min.y + ys[iy + 1]! - 1,
            z: region.min.z + zs[iz + 1]! - 1,
          },
        });
      }
    }
  }
  return cells;
}

/** 把格子位移套到另一個原點——用來在鏡像副本上找到對應格。 */
export function translateCell(cell: Cell, origin: Vec3): Region {
  const span = {
    x: cell.max.x - cell.min.x,
    y: cell.max.y - cell.min.y,
    z: cell.max.z - cell.min.z,
  };
  const min = {
    x: origin.x + cell.offset.x,
    y: origin.y + cell.offset.y,
    z: origin.z + cell.offset.z,
  };
  return { min, max: { x: min.x + span.x, y: min.y + span.y, z: min.z + span.z } };
}

export interface CellVerdict {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly symmetric: boolean;
}

export interface SymmetrySummary {
  readonly symmetric: boolean;
  readonly matchedCells: number;
  readonly totalCells: number;
  /** 0–100，四捨五入到整數。整體通過時直接 100，不必細分。 */
  readonly score: number;
  readonly asymmetricCells: readonly CellVerdict[];
}

export function summarizeSymmetry(verdicts: readonly CellVerdict[]): SymmetrySummary {
  const total = verdicts.length;
  if (total === 0) {
    throw new MinecraftBridgeError('invalid-shape', '沒有可比對的格子。');
  }
  const matched = verdicts.filter((verdict) => verdict.symmetric).length;
  return {
    symmetric: matched === total,
    matchedCells: matched,
    totalCells: total,
    score: Math.round((matched / total) * 100),
    asymmetricCells: verdicts.filter((verdict) => !verdict.symmetric),
  };
}

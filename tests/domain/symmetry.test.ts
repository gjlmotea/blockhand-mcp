import { describe, expect, it } from 'vitest';

import { MinecraftBridgeError } from '../../src/domain/contracts.js';
import {
  MAX_CELLS_PER_AXIS,
  assertStructureFits,
  normalizeRegion,
  regionSize,
  subdivideRegion,
  summarizeSymmetry,
  translateCell,
} from '../../src/domain/build/symmetry.js';

const v = (x: number, y: number, z: number) => ({ x, y, z });

describe('normalizeRegion', () => {
  it('對角給反了也能得到正確的 min/max', () => {
    const region = normalizeRegion(v(10, 70, 5), v(0, 64, -5));
    expect(region.min).toEqual(v(0, 64, -5));
    expect(region.max).toEqual(v(10, 70, 5));
  });

  it('尺寸是含端點的格數，不是差值', () => {
    expect(regionSize(normalizeRegion(v(0, 0, 0), v(0, 0, 0)))).toEqual(v(1, 1, 1));
    expect(regionSize(normalizeRegion(v(0, 0, 0), v(3, 0, 0)))).toEqual(v(4, 1, 1));
  });
});

describe('assertStructureFits', () => {
  it('在上限內通過', () => {
    expect(() => assertStructureFits(normalizeRegion(v(0, 0, 0), v(63, 383, 63)))).not.toThrow();
  });

  it('超過上限時明講是哪一軸超標，而不是只說太大', () => {
    expect(() => assertStructureFits(normalizeRegion(v(0, 0, 0), v(64, 0, 0)))).toThrow(/超標軸 x/u);
    expect(() => assertStructureFits(normalizeRegion(v(0, 0, 0), v(0, 0, 999)))).toThrow(/超標軸 z/u);
  });
});

describe('subdivideRegion', () => {
  it('細分數 1 時就是整個區域本身', () => {
    const region = normalizeRegion(v(0, 64, 0), v(7, 71, 7));
    const cells = subdivideRegion(region, 1);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.min).toEqual(region.min);
    expect(cells[0]!.max).toEqual(region.max);
  });

  it('格子彼此不重疊，且合起來剛好覆蓋整個區域', () => {
    const region = normalizeRegion(v(0, 64, 0), v(7, 67, 7));
    const cells = subdivideRegion(region, 2);
    const covered = new Set<string>();
    for (const cell of cells) {
      for (let x = cell.min.x; x <= cell.max.x; x += 1) {
        for (let y = cell.min.y; y <= cell.max.y; y += 1) {
          for (let z = cell.min.z; z <= cell.max.z; z += 1) {
            const key = `${String(x)},${String(y)},${String(z)}`;
            expect(covered.has(key), `${key} 被覆蓋兩次`).toBe(false);
            covered.add(key);
          }
        }
      }
    }
    const size = regionSize(region);
    expect(covered.size).toBe(size.x * size.y * size.z);
  });

  it('不能整除時仍完整覆蓋，不會漏格也不會超出邊界', () => {
    const region = normalizeRegion(v(0, 64, 0), v(6, 64, 6));
    const cells = subdivideRegion(region, 4);
    const total = cells.reduce(
      (sum, cell) =>
        sum +
        (cell.max.x - cell.min.x + 1) * (cell.max.y - cell.min.y + 1) * (cell.max.z - cell.min.z + 1),
      0,
    );
    expect(total).toBe(7 * 1 * 7);
    for (const cell of cells) {
      expect(cell.min.x).toBeGreaterThanOrEqual(region.min.x);
      expect(cell.max.x).toBeLessThanOrEqual(region.max.x);
    }
  });

  it('該軸長度小於細分數時不會切出零寬度的格子', () => {
    const region = normalizeRegion(v(0, 64, 0), v(1, 64, 1));
    const cells = subdivideRegion(region, 4);
    for (const cell of cells) {
      expect(cell.max.x).toBeGreaterThanOrEqual(cell.min.x);
      expect(cell.max.y).toBeGreaterThanOrEqual(cell.min.y);
      expect(cell.max.z).toBeGreaterThanOrEqual(cell.min.z);
    }
  });

  it('超過每軸上限直接拒絕，避免撞到 host 逾時', () => {
    const region = normalizeRegion(v(0, 64, 0), v(31, 95, 31));
    expect(() => subdivideRegion(region, MAX_CELLS_PER_AXIS + 1)).toThrow(MinecraftBridgeError);
  });

  it('細分數不是正整數時拒絕', () => {
    const region = normalizeRegion(v(0, 64, 0), v(7, 71, 7));
    expect(() => subdivideRegion(region, 0)).toThrow(MinecraftBridgeError);
    expect(() => subdivideRegion(region, 1.5)).toThrow(MinecraftBridgeError);
  });
});

describe('translateCell', () => {
  it('位移套到鏡像副本原點後，格子大小完全相同', () => {
    const region = normalizeRegion(v(100, 64, 100), v(107, 71, 107));
    const [cell] = subdivideRegion(region, 2);
    const moved = translateCell(cell!, v(0, 200, 0));
    expect(moved.max.x - moved.min.x).toBe(cell!.max.x - cell!.min.x);
    expect(moved.max.y - moved.min.y).toBe(cell!.max.y - cell!.min.y);
    expect(moved.max.z - moved.min.z).toBe(cell!.max.z - cell!.min.z);
    expect(moved.min).toEqual(v(0 + cell!.offset.x, 200 + cell!.offset.y, 0 + cell!.offset.z));
  });
});

describe('summarizeSymmetry', () => {
  const cell = (symmetric: boolean) => ({ min: v(0, 0, 0), max: v(1, 1, 1), symmetric });

  it('全數通過時 symmetric 為真且滿分', () => {
    const summary = summarizeSymmetry([cell(true), cell(true)]);
    expect(summary.symmetric).toBe(true);
    expect(summary.score).toBe(100);
    expect(summary.asymmetricCells).toHaveLength(0);
  });

  it('部分通過時給比例分數並列出不對稱的格子', () => {
    const summary = summarizeSymmetry([cell(true), cell(true), cell(true), cell(false)]);
    expect(summary.symmetric).toBe(false);
    expect(summary.matchedCells).toBe(3);
    expect(summary.totalCells).toBe(4);
    expect(summary.score).toBe(75);
    expect(summary.asymmetricCells).toHaveLength(1);
  });

  it('全數不通過時 0 分', () => {
    expect(summarizeSymmetry([cell(false), cell(false)]).score).toBe(0);
  });

  it('沒有格子時拒絕，不回傳 NaN 分數', () => {
    expect(() => summarizeSymmetry([])).toThrow(MinecraftBridgeError);
  });
});

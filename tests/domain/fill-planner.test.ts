import { describe, expect, it } from 'vitest';

import type { Vec3 } from '../../src/domain/contracts.js';
import { planBoxFills, planPointFills, totalBlocks } from '../../src/domain/build/fill-planner.js';

function box(from: Vec3, to: Vec3): Vec3[] {
  const points: Vec3[] = [];
  for (let y = from.y; y <= to.y; y += 1) {
    for (let z = from.z; z <= to.z; z += 1) {
      for (let x = from.x; x <= to.x; x += 1) {
        points.push({ x, y, z });
      }
    }
  }
  return points;
}

describe('planBoxFills', () => {
  it('小長方體只需要一條 fill', () => {
    const batches = planBoxFills({ x: 0, y: 0, z: 0 }, { x: 9, y: 9, z: 9 });
    expect(batches).toHaveLength(1);
    expect(batches[0]?.blockCount).toBe(1000);
  });

  it('超過上限時拆批，且總方塊數不變', () => {
    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 63, y: 63, z: 63 };
    const batches = planBoxFills(from, to);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.blockCount).toBeLessThanOrEqual(32768);
    }
    expect(totalBlocks(batches)).toBe(64 * 64 * 64);
  });

  it('起訖順序顛倒仍得到相同結果', () => {
    const a = planBoxFills({ x: 5, y: 5, z: 5 }, { x: 0, y: 0, z: 0 });
    const b = planBoxFills({ x: 0, y: 0, z: 0 }, { x: 5, y: 5, z: 5 });
    expect(a).toEqual(b);
  });
});

describe('planPointFills', () => {
  it('空輸入回空計畫', () => {
    expect(planPointFills([])).toEqual([]);
  });

  it('把實心長方體的點集合合併回單一 fill', () => {
    const points = box({ x: 0, y: 0, z: 0 }, { x: 7, y: 3, z: 5 });
    const batches = planPointFills(points);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual({
      from: { x: 0, y: 0, z: 0 },
      to: { x: 7, y: 3, z: 5 },
      blockCount: 8 * 4 * 6,
    });
  });

  it('沿 X 的單一連段合併成一條 fill', () => {
    const points: Vec3[] = Array.from({ length: 10 }, (_, index) => ({ x: index, y: 64, z: 0 }));
    const batches = planPointFills(points);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.blockCount).toBe(10);
  });

  it('不相鄰的方塊不會被錯誤合併', () => {
    const batches = planPointFills([
      { x: 0, y: 0, z: 0 },
      { x: 5, y: 0, z: 0 },
    ]);
    expect(batches).toHaveLength(2);
    expect(totalBlocks(batches)).toBe(2);
  });

  it('重複座標只算一次', () => {
    const batches = planPointFills([
      { x: 1, y: 1, z: 1 },
      { x: 1, y: 1, z: 1 },
    ]);
    expect(totalBlocks(batches)).toBe(1);
  });

  it('合併後的批次不會多蓋也不會少蓋方塊', () => {
    // L 形：兩個互相接觸但無法合併成單一長方體的長方體。
    const points = [
      ...box({ x: 0, y: 0, z: 0 }, { x: 9, y: 0, z: 0 }),
      ...box({ x: 0, y: 1, z: 0 }, { x: 0, y: 4, z: 0 }),
    ];
    const batches = planPointFills(points);
    const covered = new Set<string>();
    for (const batch of batches) {
      for (let y = batch.from.y; y <= batch.to.y; y += 1) {
        for (let z = batch.from.z; z <= batch.to.z; z += 1) {
          for (let x = batch.from.x; x <= batch.to.x; x += 1) {
            covered.add(`${String(x)},${String(y)},${String(z)}`);
          }
        }
      }
    }
    const expected = new Set(points.map((p) => `${String(p.x)},${String(p.y)},${String(p.z)}`));
    expect(covered).toEqual(expected);
  });

  it('輸出是決定性的', () => {
    const points = box({ x: -3, y: 60, z: 12 }, { x: 4, y: 63, z: 18 });
    expect(planPointFills(points)).toEqual(planPointFills([...points].reverse()));
  });
});

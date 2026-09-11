import { describe, expect, it } from 'vitest';

import { planPointFills } from '../../src/domain/build/fill-planner.js';
import { generateShape } from '../../src/domain/build/shapes.js';
import type { ShapeSpec } from '../../src/domain/build/shapes.js';

const ORIGIN = { x: 0, y: 64, z: 0 };
const BEDROCK_FILL_LIMIT = 32_768;

/**
 * 合併效率門檻。
 *
 * 這是跨 AI 發想裡唯一能直接變成 CI 檢查的建議（grok）：形狀的述詞寫得出來
 * ≠ 產物適合這條管線。細碎、分支狀的形狀會讓三階段 greedy 合併壓不下去，
 * fill 條數逼近方塊數——教室現場的體感就是「新功能反而更慢更不穩」。
 *
 * 比值定義為 fill 條數 ÷ 方塊數。愈小愈好；接近 1 代表合併完全失效。
 * 門檻按形狀的「該有多實心」分級，不是一刀切——螺旋線本來就該比實心球差。
 */
function fillRatio(spec: ShapeSpec): number {
  const points = generateShape(spec);
  const batches = planPointFills(points, BEDROCK_FILL_LIMIT);
  return batches.length / points.length;
}

describe('合併效率門檻', () => {
  it.each([
    ['box', { kind: 'box', from: ORIGIN, to: { x: 20, y: 84, z: 20 }, hollow: false }, 0.001],
    ['sphere', { kind: 'sphere', center: ORIGIN, radius: 12, hollow: false }, 0.05],
    [
      'heightfield',
      {
        kind: 'heightfield',
        from: ORIGIN,
        to: { x: 39, y: 64, z: 39 },
        corners: { nw: 1, ne: 8, sw: 3, se: 12 },
        waves: null,
        solid: true,
      },
      0.03,
    ],
    [
      'roof',
      {
        kind: 'roof',
        from: ORIGIN,
        to: { x: 30, y: 64, z: 20 },
        height: 10,
        style: 'hip',
        ridgeAxis: 'x',
        hollow: false,
      },
      0.01,
    ],
    [
      'polywall',
      {
        kind: 'polywall',
        points: [
          { x: 0, y: 64, z: 0 },
          { x: 40, y: 64, z: 0 },
          { x: 40, y: 64, z: 40 },
        ],
        height: 8,
        thickness: 2,
        closed: false,
        battlement: false,
        merlonWidth: 2,
      },
      0.01,
    ],
    [
      'ribbon',
      {
        kind: 'ribbon',
        points: [
          { x: 0, y: 64, z: 0 },
          { x: 40, y: 64, z: 0 },
          { x: 40, y: 64, z: 40 },
        ],
        width: 5,
        thickness: 1,
        closed: false,
      },
      0.03,
    ],
    [
      'prism',
      { kind: 'prism', center: ORIGIN, radius: 12, height: 20, sides: 6, rotation: 0, axis: 'y', hollow: false },
      0.005,
    ],
    [
      'star',
      {
        kind: 'star',
        center: ORIGIN,
        points: 5,
        outerRadius: 20,
        innerRadius: 8,
        height: 10,
        rotation: 0,
        axis: 'y',
        hollow: false,
      },
      0.015,
    ],
    [
      'spiralStairs',
      {
        kind: 'spiralStairs',
        center: ORIGIN,
        radius: 8,
        innerRadius: 2,
        height: 24,
        turns: 3,
        clockwise: true,
        stepRise: 1,
      },
      0.3,
    ],
  ])('%s 的 fill 條數／方塊數不超過 %s', (_label, spec, limit) => {
    expect(fillRatio(spec as ShapeSpec)).toBeLessThanOrEqual(limit as number);
  });

  it('城垛把頂層打碎，但整面牆的比值仍在可接受範圍', () => {
    // 城垛是刻意製造的不連續，是這批形狀裡最不利合併的一個；訂在這裡當上限，
    // 之後有人把它改得更碎會立刻紅。
    expect(
      fillRatio({
        kind: 'polywall',
        points: [
          { x: 0, y: 64, z: 0 },
          { x: 60, y: 64, z: 0 },
        ],
        height: 6,
        thickness: 1,
        closed: false,
        battlement: true,
        merlonWidth: 2,
      }),
    ).toBeLessThanOrEqual(0.1);
  });
});

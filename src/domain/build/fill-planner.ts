/**
 * 把一堆方塊座標壓成最少的 `/fill` 批次。
 *
 * 直接對每個方塊送一次 `setblock` 會讓一顆半徑 20 的球變成三萬多次往返，
 * 實務上等於掛掉。這裡做三階段 greedy 合併（X 連段 → Z 矩形 → Y 立方），
 * 再依 Bedrock 的單次 `/fill` 上限拆批。
 *
 * 合併結果是決定性的：同一組輸入永遠得到同一組批次，所以可以寫測試釘住。
 */

import type { Vec3 } from '../contracts.js';
import { BEDROCK_FILL_LIMIT } from '../contracts.js';

export interface FillBatch {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly blockCount: number;
}

interface Run {
  readonly y: number;
  readonly z: number;
  readonly x0: number;
  readonly x1: number;
}

interface Rect {
  readonly y: number;
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
}

interface Box {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly z0: number;
  readonly z1: number;
}

function boxVolume(box: Box): number {
  return (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1) * (box.z1 - box.z0 + 1);
}

/** 沿最長軸對半切，直到每塊都不超過 `limit`。 */
export function splitBox(box: Box, limit: number): Box[] {
  if (boxVolume(box) <= limit) return [box];

  const spanX = box.x1 - box.x0 + 1;
  const spanY = box.y1 - box.y0 + 1;
  const spanZ = box.z1 - box.z0 + 1;
  const longest = Math.max(spanX, spanY, spanZ);

  if (longest <= 1) return [box];

  if (longest === spanX) {
    const mid = box.x0 + Math.floor(spanX / 2) - 1;
    return [
      ...splitBox({ ...box, x1: mid }, limit),
      ...splitBox({ ...box, x0: mid + 1 }, limit),
    ];
  }
  if (longest === spanY) {
    const mid = box.y0 + Math.floor(spanY / 2) - 1;
    return [
      ...splitBox({ ...box, y1: mid }, limit),
      ...splitBox({ ...box, y0: mid + 1 }, limit),
    ];
  }
  const mid = box.z0 + Math.floor(spanZ / 2) - 1;
  return [
    ...splitBox({ ...box, z1: mid }, limit),
    ...splitBox({ ...box, z0: mid + 1 }, limit),
  ];
}

function toBatch(box: Box): FillBatch {
  return {
    from: { x: box.x0, y: box.y0, z: box.z0 },
    to: { x: box.x1, y: box.y1, z: box.z1 },
    blockCount: boxVolume(box),
  };
}

/** 實心長方體的最佳解：直接拆批，不必先展開成點。 */
export function planBoxFills(
  from: Vec3,
  to: Vec3,
  limit: number = BEDROCK_FILL_LIMIT,
): FillBatch[] {
  const box: Box = {
    x0: Math.min(from.x, to.x),
    x1: Math.max(from.x, to.x),
    y0: Math.min(from.y, to.y),
    y1: Math.max(from.y, to.y),
    z0: Math.min(from.z, to.z),
    z1: Math.max(from.z, to.z),
  };
  return splitBox(box, limit).map(toBatch);
}

function collectRuns(points: readonly Vec3[]): Run[] {
  const sorted = [...points].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  const runs: Run[] = [];

  let current: { y: number; z: number; x0: number; x1: number } | null = null;
  for (const point of sorted) {
    if (
      current !== null &&
      current.y === point.y &&
      current.z === point.z &&
      point.x === current.x1 + 1
    ) {
      current.x1 = point.x;
      continue;
    }
    if (
      current !== null &&
      current.y === point.y &&
      current.z === point.z &&
      point.x === current.x1
    ) {
      // 重複座標，忽略。
      continue;
    }
    if (current !== null) runs.push({ ...current });
    current = { y: point.y, z: point.z, x0: point.x, x1: point.x };
  }
  if (current !== null) runs.push({ ...current });

  return runs;
}

function mergeRunsIntoRects(runs: readonly Run[]): Rect[] {
  const byShape = new Map<string, Run[]>();
  for (const run of runs) {
    const key = `${String(run.y)}|${String(run.x0)}|${String(run.x1)}`;
    const bucket = byShape.get(key);
    if (bucket === undefined) byShape.set(key, [run]);
    else bucket.push(run);
  }

  const rects: Rect[] = [];
  for (const bucket of byShape.values()) {
    bucket.sort((a, b) => a.z - b.z);
    let current: { y: number; x0: number; x1: number; z0: number; z1: number } | null = null;
    for (const run of bucket) {
      if (current !== null && run.z === current.z1 + 1) {
        current.z1 = run.z;
        continue;
      }
      if (current !== null) rects.push({ ...current });
      current = { y: run.y, x0: run.x0, x1: run.x1, z0: run.z, z1: run.z };
    }
    if (current !== null) rects.push({ ...current });
  }

  return rects;
}

function mergeRectsIntoBoxes(rects: readonly Rect[]): Box[] {
  const byShape = new Map<string, Rect[]>();
  for (const rect of rects) {
    const key = `${String(rect.x0)}|${String(rect.x1)}|${String(rect.z0)}|${String(rect.z1)}`;
    const bucket = byShape.get(key);
    if (bucket === undefined) byShape.set(key, [rect]);
    else bucket.push(rect);
  }

  const boxes: Box[] = [];
  for (const bucket of byShape.values()) {
    bucket.sort((a, b) => a.y - b.y);
    let current: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number } | null =
      null;
    for (const rect of bucket) {
      if (current !== null && rect.y === current.y1 + 1) {
        current.y1 = rect.y;
        continue;
      }
      if (current !== null) boxes.push({ ...current });
      current = { x0: rect.x0, x1: rect.x1, y0: rect.y, y1: rect.y, z0: rect.z0, z1: rect.z1 };
    }
    if (current !== null) boxes.push({ ...current });
  }

  // 決定性輸出順序：由下往上、由近而遠，方便人在遊戲裡看著長出來。
  boxes.sort((a, b) => a.y0 - b.y0 || a.z0 - b.z0 || a.x0 - b.x0);
  return boxes;
}

/** 任意點集合 → 最少批次的 `/fill` 計畫。 */
export function planPointFills(
  points: readonly Vec3[],
  limit: number = BEDROCK_FILL_LIMIT,
): FillBatch[] {
  if (points.length === 0) return [];

  const runs = collectRuns(points);
  const rects = mergeRunsIntoRects(runs);
  const boxes = mergeRectsIntoBoxes(rects);

  return boxes.flatMap((box) => splitBox(box, limit)).map(toBatch);
}

export function totalBlocks(batches: readonly FillBatch[]): number {
  return batches.reduce((sum, batch) => sum + batch.blockCount, 0);
}

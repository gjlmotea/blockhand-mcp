import type { Coordinate, Vec3 } from './contracts.js';
import { MinecraftBridgeError } from './contracts.js';

const MAX_ABS_HORIZONTAL = 30_000_000;
const MIN_Y = -64;
const MAX_Y = 320;

function formatComponent(value: number, mode: Coordinate['mode']): string {
  if (!Number.isFinite(value)) {
    throw new MinecraftBridgeError('invalid-coordinate', `座標分量不是有限數：${String(value)}`);
  }

  if (mode === 'absolute') {
    return String(value);
  }

  const prefix = mode === 'relative' ? '~' : '^';
  // `~0` 與 `~` 等價，輸出較短的形式讓指令列更好讀。
  return value === 0 ? prefix : `${prefix}${String(value)}`;
}

export function formatCoordinate(coordinate: Coordinate): string {
  const { x, y, z, mode } = coordinate;
  return `${formatComponent(x, mode)} ${formatComponent(y, mode)} ${formatComponent(z, mode)}`;
}

/**
 * 只對絕對座標做世界邊界檢查。相對／局部座標的最終落點取決於發起者位置，
 * 這一層不知道也不該猜。
 */
export function assertPlaceableCoordinate(coordinate: Coordinate, label: string): void {
  if (coordinate.mode !== 'absolute') return;

  if (!Number.isInteger(coordinate.x) || !Number.isInteger(coordinate.y) || !Number.isInteger(coordinate.z)) {
    throw new MinecraftBridgeError('invalid-coordinate', `${label} 的絕對方塊座標必須是整數。`);
  }

  if (Math.abs(coordinate.x) > MAX_ABS_HORIZONTAL || Math.abs(coordinate.z) > MAX_ABS_HORIZONTAL) {
    throw new MinecraftBridgeError(
      'coordinate-out-of-range',
      `${label} 的水平座標超出世界邊界 ±${String(MAX_ABS_HORIZONTAL)}。`,
    );
  }

  if (coordinate.y < MIN_Y || coordinate.y > MAX_Y) {
    throw new MinecraftBridgeError(
      'coordinate-out-of-range',
      `${label} 的 Y 座標 ${String(coordinate.y)} 超出可建造範圍 ${String(MIN_Y)}～${String(MAX_Y)}。`,
    );
  }
}

export function toVec3(coordinate: Coordinate): Vec3 {
  return { x: coordinate.x, y: coordinate.y, z: coordinate.z };
}

export function withMode(vector: Vec3, mode: Coordinate['mode']): Coordinate {
  return { x: vector.x, y: vector.y, z: vector.z, mode };
}

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vec3Key(vector: Vec3): string {
  return `${String(vector.x)},${String(vector.y)},${String(vector.z)}`;
}

export function boundingBox(points: readonly Vec3[]): { readonly min: Vec3; readonly max: Vec3 } {
  const first = points[0];
  if (first === undefined) {
    throw new MinecraftBridgeError('empty-shape', '形狀沒有產生任何方塊。');
  }

  let minX = first.x;
  let minY = first.y;
  let minZ = first.z;
  let maxX = first.x;
  let maxY = first.y;
  let maxZ = first.z;

  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.z < minZ) minZ = point.z;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
    if (point.z > maxZ) maxZ = point.z;
  }

  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  };
}

import { MinecraftBridgeError, type Vec3 } from '../contracts.js';
import { assessRawCommand } from '../command-policy.js';
import { assertPlaceableCoordinate } from '../coordinates.js';
import { planBoxFills, type FillBatch } from './fill-planner.js';

export const DEFAULT_UNDO_BLOCKS = 4096;
export const MAX_UNDO_BLOCKS = 32768;
export const MAX_UNDO_REGIONS = 64;
// Bounds native scan/structure work, including long, thin fills. No scratch world area.
export const UNDO_REGION_BLOCKS = 32768;
const MAX_REGION_EDGE = 32;
const MAX_PLANNING_REGIONS = 1024;

const STATIC_BLOCKS = new Set([
  'air', 'stone', 'granite', 'polished_granite', 'diorite', 'polished_diorite',
  'andesite', 'polished_andesite', 'cobblestone', 'mossy_cobblestone', 'bedrock',
  'dirt', 'coarse_dirt', 'bricks', 'stone_bricks', 'mossy_stone_bricks',
  'cracked_stone_bricks', 'chiseled_stone_bricks', 'smooth_stone', 'deepslate',
  'cobbled_deepslate', 'polished_deepslate', 'deepslate_bricks', 'deepslate_tiles',
  'glass', 'tinted_glass', 'quartz_block', 'smooth_quartz', 'quartz_bricks',
  'prismarine', 'prismarine_bricks', 'dark_prismarine', 'sea_lantern', 'glowstone',
  'gold_block', 'iron_block', 'diamond_block', 'emerald_block', 'lapis_block',
  'coal_block', 'netherite_block', 'amethyst_block', 'obsidian', 'crying_obsidian',
  'netherrack', 'nether_bricks', 'red_nether_bricks', 'end_stone', 'end_bricks',
  'purpur_block', 'sandstone', 'red_sandstone', 'terracotta',
  'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
  'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks',
  'crimson_planks', 'warped_planks',
]);
const COLORED_BLOCK = /^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_(wool|concrete|terracotta|stained_glass)$/;

export interface UndoRegion extends FillBatch { readonly block: string }
export interface UndoPlan { readonly blockCount: number; readonly regions: readonly UndoRegion[] }

const axes = ['x', 'y', 'z'] as const;
const position = (p: Vec3): string => `${p.x} ${p.y} ${p.z}`;
const volume = (from: Vec3, to: Vec3): number => axes.reduce((n, axis) => n * (to[axis] - from[axis] + 1), 1);
const region = (from: Vec3, to: Vec3, block: string): UndoRegion => ({from, to, block, blockCount: volume(from, to)});

/** A \ B as at most six disjoint boxes; never expands to individual cells. */
function subtract(a: UndoRegion, b: FillBatch): UndoRegion[] {
  const lo = {...a.from}, hi = {...a.to};
  for (const axis of axes) {
    lo[axis] = Math.max(a.from[axis], b.from[axis]);
    hi[axis] = Math.min(a.to[axis], b.to[axis]);
    if (lo[axis] > hi[axis]) return [a];
  }
  const remainingFrom = {...a.from}, remainingTo = {...a.to};
  const pieces: UndoRegion[] = [];
  for (const axis of axes) {
    if (remainingFrom[axis] < lo[axis]) {
      pieces.push(region({...remainingFrom}, {...remainingTo, [axis]: lo[axis] - 1}, a.block));
      remainingFrom[axis] = lo[axis];
    }
    if (remainingTo[axis] > hi[axis]) {
      pieces.push(region({...remainingFrom, [axis]: hi[axis] + 1}, {...remainingTo}, a.block));
      remainingTo[axis] = hi[axis];
    }
  }
  return pieces;
}

function coalesce(input: UndoRegion[]): UndoRegion[] {
  let result = input;
  let previousLength: number;
  do {
    previousLength = result.length;
    for (const axis of axes) {
      const other = axes.filter(a => a !== axis);
      const groups = new Map<string, UndoRegion[]>();
      for (const r of result) {
        const key = [r.block, ...other.flatMap(a => [r.from[a], r.to[a]])].join('|');
        const group = groups.get(key) ?? [];
        group.push(r);
        groups.set(key, group);
      }
      result = [];
      for (const group of groups.values()) {
        group.sort((a,b) => a.from[axis] - b.from[axis]);
        let current = group[0]!;
        for (const next of group.slice(1)) {
          if (current.to[axis] + 1 === next.from[axis]) current = region(current.from, next.to, current.block);
          else { result.push(current); current = next; }
        }
        result.push(current);
      }
    }
  } while (result.length < previousLength);
  return result;
}

function limitDimensions(r: UndoRegion): UndoRegion[] {
  const axis = axes.find(a => r.to[a] - r.from[a] + 1 > MAX_REGION_EDGE);
  if (!axis) return planBoxFills(r.from, r.to, UNDO_REGION_BLOCKS).map(b => ({...b, block:r.block}));
  const mid = Math.floor((r.from[axis] + r.to[axis]) / 2);
  return [
    ...limitDimensions(region(r.from, {...r.to, [axis]:mid}, r.block)),
    ...limitDimensions(region({...r.from, [axis]:mid+1}, r.to, r.block)),
  ];
}

function unsupported(message: string): never {
  throw new MinecraftBridgeError('undo-unsupported', `${message} 自動 Undo 只支援小範圍、絕對座標的基本建材；需要原有完整功能時，可用 mc_undo_control 停用自動備份。`);
}

/** No reads or writes: reject resource/semantic limits before retiring the previous undo. */
export function planUndo(commands: readonly string[], maxBlocks: number): UndoPlan | null {
  const assessed = commands.map(assessRawCommand);
  if (!assessed.some(c => c.verb === 'fill' || c.verb === 'setblock')) return null;
  if (assessed.some(c => !['fill', 'setblock'].includes(c.verb))) {
    unsupported('可復原的建造批次不能混入其他指令。');
  }
  let regions: UndoRegion[] = [];
  for (const command of assessed) {
    const tokens = command.commandLine.match(/\[[^\]]*\]|\S+/g) ?? [];
    const coordinateCount = command.verb === 'fill' ? 6 : 3;
    const numbers = tokens.slice(1, coordinateCount + 1);
    if (numbers.length !== coordinateCount || numbers.some(n => !/^-?\d+$/.test(n))) {
      unsupported('自動 Undo 需要整數絕對座標。');
    }
    const p = numbers.map(Number);
    const from = { x: p[0]!, y: p[1]!, z: p[2]! };
    const to = coordinateCount === 6 ? { x: p[3]!, y: p[4]!, z: p[5]! } : from;
    for (const v of [from, to]) assertPlaceableCoordinate({ ...v, mode: 'absolute' }, 'Undo 範圍');
    const block = (tokens[coordinateCount + 1] ?? '').replace(/^minecraft:/, '');
    if (!STATIC_BLOCKS.has(block) && !COLORED_BLOCK.test(block)) {
      unsupported(`「${block}」未列入可可靠檢查的基本建材；容器、生物、流體與動態機關不在第一版範圍。`);
    }
    const tail = tokens.slice(coordinateCount + 2);
    if (tail[0] === '[]') tail.shift();
    const mode = tail[0] ?? 'replace';
    if (tail.length > 1 || !['replace', 'hollow', 'outline'].includes(mode)
      || command.verb === 'setblock' && mode !== 'replace') {
      unsupported('自動 Undo 不接受自訂 blockStates、keep、destroy 或條件 replace。');
    }
    const min = { x: Math.min(from.x,to.x), y: Math.min(from.y,to.y), z: Math.min(from.z,to.z) };
    const max = { x: Math.max(from.x,to.x), y: Math.max(from.y,to.y), z: Math.max(from.z,to.z) };
    const commandVolume = volume(min, max);
    if (commandVolume > maxBlocks) {
      throw new MinecraftBridgeError('undo-too-large', `這條指令涵蓋 ${commandVolume} 格，超過自動 Undo 的 ${maxBlocks} 格預算；尚未施工。請縮小操作，或停用自動備份後使用既有建造流程。`);
    }
    const outer = region(min, max, block);
    let writes = [outer];
    if (mode !== 'replace' && axes.every(a => max[a] - min[a] >= 2)) {
      const inner = region({x:min.x+1,y:min.y+1,z:min.z+1}, {x:max.x-1,y:max.y-1,z:max.z-1}, 'air');
      writes = subtract(outer, inner);
      if (mode === 'hollow') writes.push(inner);
    }
    for (const write of writes) {
      regions = regions.flatMap(previous => subtract(previous, write));
      regions.push(write);
    }
    if (regions.length > MAX_PLANNING_REGIONS) throw new MinecraftBridgeError('undo-too-fragmented', '修改規劃太零散；尚未施工。');
    regions = coalesce(regions);
    if (regions.reduce((n,r) => n+r.blockCount,0) > maxBlocks) throw new MinecraftBridgeError('undo-too-large', `整個操作超過自動 Undo 的 ${maxBlocks} 格預算；尚未施工。`);
  }
  regions = regions.flatMap(limitDimensions);
  regions.sort((a,b) => a.from.y-b.from.y || a.from.z-b.from.z || a.from.x-b.from.x);
  if (regions.length > MAX_UNDO_REGIONS) throw new MinecraftBridgeError('undo-too-fragmented', `修改範圍太零散，超過 ${MAX_UNDO_REGIONS} 個備份區；尚未施工。`);
  return { blockCount: regions.reduce((n,r) => n+r.blockCount,0), regions };
}

/**
 * Adjacent-slice equality along every nontrivial axis connects every cell to the
 * anchor. The anchor's block/data plus these comparisons prove uniformity, including
 * interior cells. All checks and the restore run in one dimension-pinned command.
 * Requires command version 25 (modern execute, numeric block data still accepted).
 */
export function guardUndoRegion(region: UndoRegion, terminal: string): string {
  const {from, to, block} = region;
  const conditions = [`if block ${position(from)} ${block} 0`];
  for (const axis of axes) {
    if (from[axis] === to[axis]) continue;
    const end = {...to, [axis]:to[axis]-1};
    const destination = {...from, [axis]:from[axis]+1};
    conditions.push(`if blocks ${position(from)} ${position(end)} ${position(destination)} all`);
  }
  const command = `execute in overworld ${conditions.join(' ')} run ${terminal}`;
  if (command.length > 1024) throw new MinecraftBridgeError('undo-command-too-long', 'Undo 條件指令超過 1024 字元，未執行。');
  return command;
}

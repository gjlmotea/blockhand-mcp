import { z } from 'zod';

import {
  AGENT_DIRECTIONS,
  BLOCK_HANDLING_MODES,
  COORDINATE_MODES,
  FILL_MODES,
  TURN_DIRECTIONS,
} from '../domain/contracts.js';
import { AXES, ROOF_STYLES, STAIR_DIRECTIONS } from '../domain/build/shapes.js';

/*
 * 為什麼這裡每個共用片段都是 function 而不是 const？
 *
 * MCP SDK 把 Zod schema 轉成 JSON Schema 時走的是 `zod-to-json-schema`，它會
 * **依物件 identity 去重**：同一個 schema 實例出現在第二個欄位時，輸出的不是
 * 展開後的定義，而是 `{"$ref":"#/properties/<第一個欄位>"}`。
 *
 * 於是 `z.object({ from: coordinateSchema, to: coordinateSchema })` 會產出
 * `"to":{"$ref":"#/properties/from"}`。這是合法的 JSON Schema，但不解析內部
 * $ref 的 MCP Host 會看不出 `to` 是物件，實測會把它當字串送出，server 端
 * 收到後回 `Invalid arguments: expected object, received string`——工具直接不能用。
 *
 * 每次呼叫都建新實例就沒有可去重的對象，JSON Schema 保證自給自足。
 * 巢狀欄位也必須跟著呼叫（例如 shape() 裡的 vec3()），只換掉最外層是不夠的：
 * 去重會下沉到 x/y/z 那一層，反而更難查。
 *
 * tests/server/tool-schemas.test.ts 會擋住任何 $ref 回歸。
 */

/* ────────────────────────── 共用片段 ────────────────────────── */

export const coordinateSchema = () =>
  z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      z: z.number().finite(),
      mode: z
        .enum(COORDINATE_MODES)
        .default('absolute')
        .describe('absolute=世界座標；relative=~ 相對發起者；local=^ 相對面向'),
    })
    .strict();

export const vec3Schema = () =>
  z
    .object({
      x: z.number().int(),
      y: z.number().int(),
      z: z.number().int(),
    })
    .strict();

export const blockNameSchema = () =>
  z.string().trim().min(1).max(80).describe('方塊 ID，例如 stone 或 minecraft:oak_planks');

export const blockStatesSchema = () =>
  z.string().trim().min(2).max(200).describe('選用的方塊狀態，例如 ["stone_type":"granite"]');

export const selectorSchema = () =>
  z.string().trim().min(1).max(120).describe('目標選擇器（@a/@p/@s/@e/@r，可帶 []）或玩家名稱');

export const agentDirectionSchema = () => z.enum(AGENT_DIRECTIONS);
export const turnDirectionSchema = () => z.enum(TURN_DIRECTIONS);
export const axisSchema = () => z.enum(AXES);
export const slotSchema = () => z.number().int().min(1).max(27);
export const quantitySchema = () => z.number().int().min(1).max(64);

/* ────────────────────────── 共用輸出 ────────────────────────── */

export const commandOutcomeSchema = () =>
  z
    .object({
      ok: z.boolean(),
      commandLine: z.string(),
      statusCode: z.number().nullable(),
      statusMessage: z.string().nullable(),
      data: z.record(z.unknown()).nullable(),
      elapsedMs: z.number(),
    })
    .strict();

export const batchOutcomeSchema = () =>
  z
    .object({
      ok: z.boolean(),
      issued: z.number(),
      succeeded: z.number(),
      failed: z.number(),
      firstFailure: commandOutcomeSchema().nullable(),
      outcomes: z.array(commandOutcomeSchema()),
      elapsedMs: z.number(),
    })
    .strict();

export const connectionStatusSchema = () =>
  z
    .object({
      listening: z.boolean(),
      host: z.string(),
      port: z.number(),
      connected: z.boolean(),
      connectCommand: z.string(),
      connectedAt: z.string().nullable(),
      connectionCount: z.number(),
      subscribedEvents: z.array(z.string()),
      bufferedEvents: z.number(),
      commandsIssued: z.number(),
      encrypted: z.boolean(),
      savedStructures: z
        .array(z.object({ name: z.string(), saveMode: z.string() }).strict())
        .describe('本次連線存過的結構；遊戲沒有列出結構的指令，所以只能由橋接自己記'),
    })
    .strict();

export const buildPlanSchema = () =>
  z
    .object({
      shape: z.string(),
      block: z.string(),
      blockStates: z.string().nullable(),
      blockCount: z.number(),
      fillBatches: z.number(),
      bounds: z.object({ min: vec3Schema(), max: vec3Schema() }).strict(),
      savedCommands: z.number(),
    })
    .strict();

/* ────────────────────────── 形狀輸入 ────────────────────────── */

export const shapeSchema = () =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('line'), from: vec3Schema(), to: vec3Schema() }).strict(),
    z
      .object({
        kind: z.literal('box'),
        from: vec3Schema(),
        to: vec3Schema(),
        hollow: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('sphere'),
        center: vec3Schema(),
        radius: z.number().min(1).max(128),
        hollow: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('ellipsoid'),
        center: vec3Schema(),
        radii: z
          .object({
            x: z.number().min(1).max(128),
            y: z.number().min(1).max(128),
            z: z.number().min(1).max(128),
          })
          .strict(),
        hollow: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('cylinder'),
        center: vec3Schema(),
        radius: z.number().min(1).max(128),
        height: z.number().int().min(1).max(384),
        axis: axisSchema().default('y'),
        hollow: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('cone'),
        center: vec3Schema(),
        radius: z.number().min(1).max(128),
        height: z.number().int().min(1).max(384),
        topRadius: z
          .number()
          .min(0)
          .max(128)
          .default(0)
          .describe('頂面半徑；0 是傳統圓錐，大於 0 就是圓錐台（煙囪、塔身、橋墩）'),
        axis: axisSchema().default('y'),
        hollow: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('pyramid'),
        center: vec3Schema(),
        baseRadius: z
          .number()
          .min(1)
          .max(128)
          .describe('底面中心到「邊」的距離，不是到頂點；底邊長 = 2×baseRadius+1'),
        height: z.number().int().min(1).max(384),
        topRadius: z
          .number()
          .min(0)
          .max(128)
          .default(0)
          .describe('頂面半徑；0 收成尖點，大於 0 就是角錐台（城堡塔身、神廟基座）'),
        sides: z.number().int().min(3).max(12).default(4).describe('4 是傳統方底，3 三角錐，6 六角錐'),
        rotation: z.number().min(-360).max(360).default(0).describe('底面繞 Y 軸轉幾度'),
        hollow: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('disk'),
        center: vec3Schema(),
        radius: z.number().min(1).max(256),
        axis: axisSchema().default('y'),
        hollow: z.boolean().default(false).describe('true 只畫圓環外框'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('torus'),
        center: vec3Schema(),
        majorRadius: z.number().min(2).max(128),
        minorRadius: z.number().min(1).max(64),
        axis: axisSchema().default('y'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('helix'),
        center: vec3Schema(),
        radius: z.number().min(1).max(128),
        height: z.number().int().min(2).max(384),
        turns: z.number().min(0.25).max(64),
        axis: axisSchema().default('y'),
        thickness: z.number().int().min(1).max(7).default(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal('curve'),
        points: z
          .array(vec3Schema())
          .min(2)
          .max(64)
          .describe('曲線會平滑通過每一個控制點，不是折線'),
        thickness: z.number().int().min(1).max(7).default(1),
        closed: z.boolean().default(false).describe('true 時首尾相接成封閉迴圈'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('revolution'),
        center: vec3Schema(),
        axis: axisSchema().default('y'),
        profile: z
          .array(
            z
              .object({
                along: z.number().int().describe('沿軸位置，相對 center'),
                radius: z.number().min(0).max(128).describe('該高度的半徑'),
              })
              .strict(),
          )
          .min(2)
          .max(64)
          .describe('側面輪廓；半徑在相鄰點之間線性內插，可蓋花瓶、塔樓、圓頂'),
        hollow: z.boolean().default(false).describe('true 只留側面殼層'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('tube'),
        from: vec3Schema(),
        to: vec3Schema(),
        radius: z
          .number()
          .min(0.5)
          .max(64)
          .describe('cylinder 的任意方向版；兩端是半球收尾'),
        hollow: z
          .boolean()
          .default(false)
          .describe('封閉殼層，兩端的半球蓋也算殼，所以不是通的管子'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('wedge'),
        from: vec3Schema(),
        to: vec3Schema(),
        rise: axisSchema().default('y').describe('高度方向'),
        run: axisSchema()
          .default('x')
          .describe('斜面下降的方向，必須與 rise 不同軸；起點端滿高、終點端剩一格'),
        reversed: z.boolean().default(false).describe('true 改成沿 run 軸負向變矮'),
        hollow: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('arch'),
        center: vec3Schema().describe('起拱線中心，也就是兩隻拱腳連線的中點'),
        radius: z.number().min(1).max(128).describe('拱內緣半徑；開口寬度 = 2×radius−1'),
        thickness: z.number().min(1).max(64).default(1).describe('拱圈厚度'),
        depth: z.number().int().min(1).max(256).default(1).describe('沿第三軸的進深'),
        span: axisSchema().default('x').describe('拱跨越的方向'),
        rise: axisSchema().default('y').describe('向上的方向，必須與 span 不同軸'),
        legHeight: z
          .number()
          .int()
          .min(0)
          .max(256)
          .default(0)
          .describe('起拱線以下的直柱高度；城門與橋拱要它，純半圓設 0'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('stairs'),
        from: vec3Schema().describe('第一階踏面的起點角落：最低、最靠近起點、寬度方向座標最小那一格'),
        direction: z.enum(STAIR_DIRECTIONS).describe('水平前進方向；階梯一律沿 Y 軸上升'),
        steps: z.number().int().min(1).max(256),
        width: z.number().int().min(1).max(64).default(1).describe('梯寬，往前進方向的左手邊展開'),
        stepRise: z.number().int().min(1).max(8).default(1).describe('每階上升幾格'),
        stepRun: z.number().int().min(1).max(8).default(1).describe('每階前進幾格（踏面深度）'),
        solid: z
          .boolean()
          .default(false)
          .describe('false 懸空踏板；true 每階往下補滿到起點高度，做成實心梯體'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('prism'),
        center: vec3Schema(),
        radius: z
          .number()
          .min(1)
          .max(128)
          .describe('中心到「邊」的距離；邊數愈多愈接近同半徑的 cylinder'),
        height: z.number().int().min(1).max(384),
        sides: z.number().int().min(3).max(12).default(6).describe('3 三角柱、6 六角塔、8 八角亭'),
        rotation: z.number().min(-360).max(360).default(0).describe('繞軸旋轉幾度，用來對齊某一邊的朝向'),
        axis: axisSchema().default('y'),
        hollow: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('polywall'),
        points: z
          .array(vec3Schema())
          .min(2)
          .max(32)
          .describe('XZ 折線的轉折點，轉角不會被磨圓（curve 會）；Y 取第一點當牆基'),
        height: z.number().int().min(1).max(384),
        thickness: z.number().int().min(1).max(32).default(1),
        closed: z.boolean().default(false).describe('true 首尾相接，圍成一圈'),
        battlement: z.boolean().default(false).describe('頂層做成城垛，沿路徑交替留空'),
        merlonWidth: z.number().int().min(1).max(32).default(2).describe('城垛的垛與缺口各幾格'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('ribbon'),
        points: z.array(vec3Schema()).min(2).max(32).describe('XZ 折線；Y 取第一點當路面高度'),
        width: z.number().min(1).max(64).default(3).describe('往兩側攤開的總寬'),
        thickness: z.number().int().min(1).max(64).default(1).describe('往上疊幾層'),
        closed: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('heightfield'),
        from: vec3Schema().describe('地皮的一角；Y 是地基高度'),
        to: vec3Schema().describe('地皮的對角'),
        corners: z
          .object({
            nw: z.number().min(0).max(384).default(1),
            ne: z.number().min(0).max(384).default(1),
            sw: z.number().min(0).max(384).default(1),
            se: z.number().min(0).max(384).default(1),
          })
          .strict()
          .default({ nw: 1, ne: 1, sw: 1, se: 1 })
          .describe('四角相對 from.y 的高度，中間雙線性內插。−X 是西、−Z 是北'),
        waves: z
          .object({
            amplitude: z.number().min(0).max(128),
            wavelength: z.number().min(1).max(512),
          })
          .strict()
          .nullable()
          .default(null)
          .describe('疊在四角內插之上的正弦起伏；不需要就給 null'),
        solid: z
          .boolean()
          .default(true)
          .describe('true 從 from.y 填實到地表，false 只鋪地表那一層皮'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('spiralStairs'),
        center: vec3Schema().describe('螺旋軸的底部中心'),
        radius: z.number().min(1).max(128).describe('踏面外半徑'),
        innerRadius: z.number().min(0).max(128).default(0).describe('中間留洞的半徑；0 是實心到軸'),
        height: z.number().int().min(1).max(384),
        turns: z.number().min(0.25).max(64).describe('總共繞幾圈'),
        clockwise: z.boolean().default(true).describe('由上往下看的旋轉方向'),
        stepRise: z.number().int().min(1).max(8).default(1).describe('每階上升幾格'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('cross'),
        center: vec3Schema(),
        radius: z.number().min(1).max(128).describe('中心到臂端的距離'),
        armWidth: z.number().int().min(1).max(64).default(1).describe('臂寬（格）'),
        height: z.number().int().min(1).max(384),
        axis: axisSchema().default('y'),
        hollow: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('star'),
        center: vec3Schema(),
        points: z.number().int().min(3).max(12).default(5).describe('幾角星'),
        outerRadius: z.number().min(2).max(128).describe('星芒尖端的半徑'),
        innerRadius: z.number().min(1).max(128).describe('凹處的半徑，必須小於 outerRadius'),
        height: z.number().int().min(1).max(384).default(1),
        rotation: z.number().min(-360).max(360).default(0),
        axis: axisSchema().default('y'),
        hollow: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('roof'),
        from: vec3Schema().describe('屋頂底面的一角；Y 是屋簷高度'),
        to: vec3Schema().describe('屋頂底面的對角'),
        height: z.number().int().min(1).max(384).describe('從屋簷到屋脊的高度'),
        style: z
          .enum(ROOF_STYLES)
          .default('gable')
          .describe('gable 人字（兩坡），hip 四坡（四面都落下）'),
        ridgeAxis: z
          .enum(['x', 'z'])
          .default('x')
          .describe('屋脊「延伸」的方向，不是坡面朝向的方向；這兩個講法差 90 度'),
        hollow: z.boolean().default(false).describe('true 只留屋面殼層，不填實內部'),
      })
      .strict(),
  ]);

/* ────────────────────────── Agent 程式 ────────────────────────── */

export const agentProgramStepSchema = () =>
  z.discriminatedUnion('action', [
    z
      .object({
        action: z.literal('move'),
        direction: agentDirectionSchema(),
        steps: z.number().int().min(1).max(64).default(1),
      })
      .strict(),
    z
      .object({
        action: z.literal('turn'),
        direction: turnDirectionSchema(),
        times: z.number().int().min(1).max(4).default(1),
      })
      .strict(),
    z.object({ action: z.literal('attack'), direction: agentDirectionSchema() }).strict(),
    z.object({ action: z.literal('destroy'), direction: agentDirectionSchema() }).strict(),
    z.object({ action: z.literal('till'), direction: agentDirectionSchema() }).strict(),
    z.object({ action: z.literal('dropAll'), direction: agentDirectionSchema() }).strict(),
    z
      .object({ action: z.literal('place'), slot: slotSchema(), direction: agentDirectionSchema() })
      .strict(),
    z
      .object({
        action: z.literal('collect'),
        item: blockNameSchema().nullable().default(null).describe('null 代表收集全部'),
      })
      .strict(),
    z
      .object({
        action: z.literal('drop'),
        slot: slotSchema(),
        quantity: quantitySchema(),
        direction: agentDirectionSchema(),
      })
      .strict(),
    z
      .object({
        action: z.literal('transfer'),
        sourceSlot: slotSchema(),
        quantity: quantitySchema(),
        destinationSlot: slotSchema(),
      })
      .strict(),
  ]);

export { BLOCK_HANDLING_MODES, FILL_MODES };

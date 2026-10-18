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
        .describe('absolute = world coordinates; relative = ~ relative to the command source; local = ^ relative to its facing'),
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
  z.string().trim().min(1).max(80).describe('Block ID, for example stone or minecraft:oak_planks');

export const blockStatesSchema = () =>
  z.string().trim().min(2).max(200).describe('Optional block states, for example ["stone_type":"granite"]');

export const selectorSchema = () =>
  z.string().trim().min(1).max(120).describe('Target selector (@a/@p/@s/@e/@r, optionally with []) or a player name');

export const agentDirectionSchema = () => z.enum(AGENT_DIRECTIONS);
export const turnDirectionSchema = () => z.enum(TURN_DIRECTIONS);
export const axisSchema = () => z.enum(AXES);
export const slotSchema = () => z.number().int().min(1).max(27);
export const quantitySchema = () => z.number().int().min(1).max(64);

/* ────────────────────────── 共用輸出 ────────────────────────── */

export const undoStatusSchema = () => z.object({
  enabled:z.boolean(), maxBlocks:z.number().int(), maxRegions:z.number().int(),
  state:z.enum(['empty','ready','uncertain','partial','cleanup-required','invalidated']),
  busy:z.boolean(), available:z.boolean(), operationId:z.string().nullable(),
  storedBlocks:z.number().int(), snapshotCount:z.number().int(), restoredRegions:z.number().int(),
  backupMs:z.number(), checkMs:z.number(), restoreMs:z.number(), reason:z.string().nullable(),
}).strict();

export const commandOutcomeSchema = () =>
  z
    .object({
      ok: z.boolean(),
      commandLine: z.string(),
      statusCode: z.number().nullable(),
      statusMessage: z.string().nullable(),
      data: z.record(z.unknown()).nullable(),
      elapsedMs: z.number(),
      undo: undoStatusSchema().optional(),
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
      undo: undoStatusSchema().optional(),
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
      commandState: z.enum(['unknown', 'responsive', 'timed-out']).optional(),
      lastCommandResponseAt: z.string().nullable().optional(),
      lastCommandTimeoutAt: z.string().nullable().optional(),
      inFlightCommands: z.number().optional().describe('Commands sent to the game and still waiting for a reply; the bridge sends one at a time'),
      queuedCommands: z
        .number()
        .optional()
        .describe('Commands queued and not yet sent; greater than 0 means the backlog comes from concurrent calls on the client side, not from the game'),
      undo: undoStatusSchema().optional(),
      savedStructures: z
        .array(z.object({ name: z.string(), saveMode: z.string() }).strict())
        .describe('Structures saved during this connection; the game has no command to list structures, so the bridge keeps its own record'),
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
          .describe('Top radius; 0 is a classic cone, greater than 0 makes a truncated cone (chimneys, tower bodies, bridge piers)'),
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
          .describe('Distance from the base center to an edge, not to a corner; base side length = 2*baseRadius+1'),
        height: z.number().int().min(1).max(384),
        topRadius: z
          .number()
          .min(0)
          .max(128)
          .default(0)
          .describe('Top radius; 0 ends in a point, greater than 0 makes a frustum (castle towers, temple bases)'),
        sides: z.number().int().min(3).max(12).default(4).describe('4 is a classic square base, 3 a triangular pyramid, 6 a hexagonal pyramid'),
        rotation: z.number().min(-360).max(360).default(0).describe('Degrees to rotate the base around the Y axis'),
        hollow: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('disk'),
        center: vec3Schema(),
        radius: z.number().min(1).max(256),
        axis: axisSchema().default('y'),
        hollow: z.boolean().default(false).describe('true draws only the outer ring'),
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
          .describe('The curve passes smoothly through every control point; it is not a polyline'),
        thickness: z.number().int().min(1).max(7).default(1),
        closed: z.boolean().default(false).describe('When true, the ends join into a closed loop'),
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
                along: z.number().int().describe('Position along the axis, relative to center'),
                radius: z.number().min(0).max(128).describe('Radius at that position'),
              })
              .strict(),
          )
          .min(2)
          .max(64)
          .describe('Side profile; the radius is linearly interpolated between neighboring points. Builds vases, turrets, domes'),
        hollow: z.boolean().default(false).describe('true keeps only the side shell'),
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
          .describe('A cylinder in any direction; both ends are capped with hemispheres'),
        hollow: z
          .boolean()
          .default(false)
          .describe('A closed shell: the hemispherical end caps are part of the shell, so it is not an open pipe'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('wedge'),
        from: vec3Schema(),
        to: vec3Schema(),
        rise: axisSchema().default('y').describe('Height direction'),
        run: axisSchema()
          .default('x')
          .describe('Direction the slope descends along; must be a different axis from rise. Full height at the start end, one block at the far end'),
        reversed: z.boolean().default(false).describe('When true, it gets lower toward the negative run axis instead'),
        hollow: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('arch'),
        center: vec3Schema().describe('Center of the springing line, the midpoint between the two arch feet'),
        radius: z.number().min(1).max(128).describe('Inner radius of the arch; opening width = 2*radius-1'),
        thickness: z.number().min(1).max(64).default(1).describe('Thickness of the arch ring'),
        depth: z.number().int().min(1).max(256).default(1).describe('Depth along the third axis'),
        span: axisSchema().default('x').describe('Direction the arch spans'),
        rise: axisSchema().default('y').describe('Upward direction; must be a different axis from span'),
        legHeight: z
          .number()
          .int()
          .min(0)
          .max(256)
          .default(0)
          .describe('Height of the straight legs below the springing line; city gates and bridge arches need it, set 0 for a pure semicircle'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('stairs'),
        from: vec3Schema().describe('Starting corner of the first tread: the lowest block, nearest the start, with the smallest coordinate across the width'),
        direction: z.enum(STAIR_DIRECTIONS).describe('Horizontal direction of travel; stairs always rise along the Y axis'),
        steps: z.number().int().min(1).max(256),
        width: z.number().int().min(1).max(64).default(1).describe('Stair width, extending to the left of the direction of travel'),
        stepRise: z.number().int().min(1).max(8).default(1).describe('Blocks each step rises'),
        stepRun: z.number().int().min(1).max(8).default(1).describe('Blocks each step advances (tread depth)'),
        solid: z
          .boolean()
          .default(false)
          .describe('false gives floating treads; true fills each step down to the starting height for a solid staircase'),
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
          .describe('Distance from the center to an edge; the more sides, the closer it gets to a cylinder of the same radius'),
        height: z.number().int().min(1).max(384),
        sides: z.number().int().min(3).max(12).default(6).describe('3 for a triangular prism, 6 for a hexagonal tower, 8 for an octagonal pavilion'),
        rotation: z.number().min(-360).max(360).default(0).describe('Degrees to rotate around the axis, to align one side with a direction'),
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
          .describe('Corner points of an XZ polyline; corners are not rounded (curve rounds them). The Y of the first point is the wall base'),
        height: z.number().int().min(1).max(384),
        thickness: z.number().int().min(1).max(32).default(1),
        closed: z.boolean().default(false).describe('When true, the ends join to enclose a loop'),
        battlement: z.boolean().default(false).describe('Make the top layer battlements, alternating gaps along the path'),
        merlonWidth: z.number().int().min(1).max(32).default(2).describe('Width in blocks of each merlon and each gap'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('ribbon'),
        points: z.array(vec3Schema()).min(2).max(32).describe('XZ polyline; the Y of the first point is the road surface height'),
        width: z.number().min(1).max(64).default(3).describe('Total width spread to both sides'),
        thickness: z.number().int().min(1).max(64).default(1).describe('Number of layers stacked upward'),
        closed: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('heightfield'),
        from: vec3Schema().describe('One corner of the plot; Y is the base height'),
        to: vec3Schema().describe('The opposite corner of the plot'),
        corners: z
          .object({
            nw: z.number().min(0).max(384).default(1),
            ne: z.number().min(0).max(384).default(1),
            sw: z.number().min(0).max(384).default(1),
            se: z.number().min(0).max(384).default(1),
          })
          .strict()
          .default({ nw: 1, ne: 1, sw: 1, se: 1 })
          .describe('Height of each corner relative to from.y, bilinearly interpolated in between. -X is west, -Z is north'),
        waves: z
          .object({
            amplitude: z.number().min(0).max(128),
            wavelength: z.number().min(1).max(512),
          })
          .strict()
          .nullable()
          .default(null)
          .describe('Sine waves added on top of the corner interpolation; pass null if not needed'),
        solid: z
          .boolean()
          .default(true)
          .describe('true fills solid from from.y up to the surface; false lays only the surface layer'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('spiralStairs'),
        center: vec3Schema().describe('Bottom center of the spiral axis'),
        radius: z.number().min(1).max(128).describe('Outer radius of the treads'),
        innerRadius: z.number().min(0).max(128).default(0).describe('Radius of the hole in the middle; 0 is solid to the axis'),
        height: z.number().int().min(1).max(384),
        turns: z.number().min(0.25).max(64).describe('Total number of turns'),
        clockwise: z.boolean().default(true).describe('Direction of rotation seen from above'),
        stepRise: z.number().int().min(1).max(8).default(1).describe('Blocks each step rises'),
      })
      .strict(),
    z
      .object({
        kind: z.literal('cross'),
        center: vec3Schema(),
        radius: z.number().min(1).max(128).describe('Distance from the center to the end of an arm'),
        armWidth: z.number().int().min(1).max(64).default(1).describe('Arm width in blocks'),
        height: z.number().int().min(1).max(384),
        axis: axisSchema().default('y'),
        hollow: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('star'),
        center: vec3Schema(),
        points: z.number().int().min(3).max(12).default(5).describe('Number of star points'),
        outerRadius: z.number().min(2).max(128).describe('Radius at the star tips'),
        innerRadius: z.number().min(1).max(128).describe('Radius at the inner corners; must be less than outerRadius'),
        height: z.number().int().min(1).max(384).default(1),
        rotation: z.number().min(-360).max(360).default(0),
        axis: axisSchema().default('y'),
        hollow: z.boolean().default(false),
      })
      .strict(),
    z
      .object({
        kind: z.literal('roof'),
        from: vec3Schema().describe('One corner of the roof base; Y is the eave height'),
        to: vec3Schema().describe('The opposite corner of the roof base'),
        height: z.number().int().min(1).max(384).describe('Height from the eaves to the ridge'),
        style: z
          .enum(ROOF_STYLES)
          .default('gable')
          .describe('gable has two slopes; hip has four (it slopes down on all four sides)'),
        ridgeAxis: z
          .enum(['x', 'z'])
          .default('x')
          .describe('The direction the ridge runs along, not the direction a slope faces; the two differ by 90 degrees'),
        hollow: z.boolean().default(false).describe('true keeps only the roof shell and leaves the inside empty'),
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
        item: blockNameSchema().nullable().default(null).describe('null collects everything'),
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

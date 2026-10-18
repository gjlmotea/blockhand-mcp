import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { BuildService } from '../../application/build-service.js';
import type { ShapeSpec } from '../../domain/build/shapes.js';
import {
  batchOutcomeSchema,
  blockNameSchema,
  blockStatesSchema,
  buildPlanSchema,
  shapeSchema,
  vec3Schema,
} from '../schemas.js';
import { batchToPayload, guard, ok, summarizeBatch } from '../tool-kit.js';

const BUILD_NOTE =
  'All coordinates are absolute world coordinates; if you do not know where the player is, call mc_query_target first. Building changes the world directly, so check the block count and bounding box with the matching preview tool before you build.';

/**
 * 形狀選型指引。
 *
 * 24 種形狀最典型的失效方式不是幾何算錯，而是**選錯形狀**——選錯不會報錯，只會
 * 蓋出一個看似合理但不是使用者要的東西。所以這段按「想蓋什麼」分組，並把最容易
 * 互相搶市場的幾組直接寫成對照，而不是列一張平的清單。
 */
const SHAPE_GUIDE = [
  '',
  '[Choose a shape by intent]',
  'Basic volumes: box, sphere, ellipsoid, cylinder, cone (topRadius>0 makes a truncated cone), pyramid (sides sets the number of sides, topRadius>0 makes a frustum), prism (regular n-sided prism).',
  'Lines and surfaces: line (straight line), curve (smooth curve), disk (disk / ring), tube (cylinder in any direction).',
  'Building parts: wedge (single slope), roof (gable / hip), arch, stairs (straight stairs), spiralStairs, polywall (polyline wall / city wall).',
  'Terrain and paths: heightfield (rolling ground), ribbon (road / bridge deck).',
  'Decoration and forms: torus (ring), helix, cross (plus-shaped column), star (star-shaped column), revolution (solid of revolution).',
  '',
  '[Easy to confuse; read this first]',
  'Slanted columns, beams, pipes -> tube, not cylinder (cylinder only aligns with x / y / z).',
  'Walls or fences with right-angle turns -> polywall, not curve (curve is smooth and rounds off right angles).',
  'A roof with a ridge -> roof; a single slope or ramp only -> wedge.',
  'Stairs that wind around a tower -> spiralStairs; straight up and down -> stairs.',
  'Tower bodies, bases or chimneys that are wider at one end -> cone or pyramid with topRadius, not stacked layers of box.',
  'Domes, vases, paraboloids, cooling towers and other round forms whose width changes -> revolution with a different profile; no other shape is needed.',
  'A stretch of rolling ground -> heightfield; a flat road with a width -> ribbon.',
  '',
  'If unsure, check the block count and bounding box with mc_build_preview first; it does not touch the world.',
].join('\n');

export function registerBuildTools(server: McpServer, build: BuildService): void {
  server.registerTool(
    'mc_build_preview',
    {
      title: 'Preview a shape build',
      description: `Compute only, build nothing: report how many blocks the shape uses, where its bounding box is, and how many fill commands it splits into. ${BUILD_NOTE}`,
      inputSchema: z
        .object({
          shape: shapeSchema(),
          block: blockNameSchema(),
          blockStates: blockStatesSchema().nullable().default(null),
        })
        .strict(),
      outputSchema: buildPlanSchema(),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ shape, block, blockStates }) =>
      guard(async () => {
        const plan = build.previewShape(shape as ShapeSpec, block, blockStates);
        return ok(
          { ...plan },
          `${plan.shape}: ${String(plan.blockCount)} blocks in ${String(plan.fillBatches)} fill commands (${String(plan.savedCommands)} fewer than placing block by block), from (${String(plan.bounds.min.x)}, ${String(plan.bounds.min.y)}, ${String(plan.bounds.min.z)}) to (${String(plan.bounds.max.x)}, ${String(plan.bounds.max.y)}, ${String(plan.bounds.max.z)}).`,
        );
      }),
  );

  server.registerTool(
    'mc_build_shape',
    {
      title: 'Build a shape',
      description:
        `Build a shape directly in the world. Block coordinates are merged into the fewest fill commands automatically, so a sphere of radius 20 takes a few hundred commands instead of thirty thousand.${SHAPE_GUIDE}\n\n${BUILD_NOTE}`,
      inputSchema: z
        .object({
          shape: shapeSchema(),
          block: blockNameSchema(),
          blockStates: blockStatesSchema().nullable().default(null),
        })
        .strict(),
      outputSchema: batchOutcomeSchema().extend({ plan: buildPlanSchema() }).strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    async ({ shape, block, blockStates }) =>
      guard(async () => {
        const execution = await build.buildShape(shape as ShapeSpec, block, blockStates);
        return ok(
          { ...batchToPayload(execution.batch), plan: { ...execution.plan } },
          summarizeBatch(
            execution.batch,
            `Build ${execution.plan.shape} (${String(execution.plan.blockCount)} blocks / ${String(execution.plan.fillBatches)} batches)`,
          ),
        );
      }),
  );

  const blueprintEntrySchema = z
    .object({
      position: vec3Schema(),
      block: blockNameSchema(),
      blockStates: blockStatesSchema().optional(),
    })
    .strict();

  server.registerTool(
    'mc_blueprint_preview',
    {
      title: 'Preview a blueprint build',
      description:
        'Compute only, build nothing: group a block-by-block blueprint by block type and report the total block count and the number of merged fill batches.',
      inputSchema: z
        .object({ entries: z.array(blueprintEntrySchema).min(1).max(20_000) })
        .strict(),
      outputSchema: buildPlanSchema(),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ entries }) =>
      guard(async () => {
        const plan = build.previewBlueprint(entries);
        return ok(
          { ...plan },
          `Blueprint: ${String(plan.blockCount)} blocks merged into ${String(plan.fillBatches)} commands.`,
        );
      }),
  );

  server.registerTool(
    'mc_build_blueprint',
    {
      title: 'Build a block-by-block blueprint',
      description:
        'Build any form from a list of coordinate -> block entries; identical blocks are merged into the fewest fill commands automatically. ' +
        'Prefer mc_build_shape for geometric shapes; this tool is for pixel art, text, irregular forms, or models converted from external data.',
      inputSchema: z
        .object({ entries: z.array(blueprintEntrySchema).min(1).max(20_000) })
        .strict(),
      outputSchema: batchOutcomeSchema().extend({ plan: buildPlanSchema() }).strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    async ({ entries }) =>
      guard(async () => {
        const execution = await build.buildBlueprint(entries);
        return ok(
          { ...batchToPayload(execution.batch), plan: { ...execution.plan } },
          summarizeBatch(
            execution.batch,
            `Build blueprint (${String(execution.plan.blockCount)} blocks / ${String(execution.plan.fillBatches)} batches)`,
          ),
        );
      }),
  );
}

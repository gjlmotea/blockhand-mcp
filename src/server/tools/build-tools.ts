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
  '座標一律是絕對世界座標；不知道玩家在哪就先用 mc_query_target。建造會直接改變世界，動手前建議先用對應的 preview 工具看方塊數與邊界盒。';

/**
 * 形狀選型指引。
 *
 * 24 種形狀最典型的失效方式不是幾何算錯，而是**選錯形狀**——選錯不會報錯，只會
 * 蓋出一個看似合理但不是使用者要的東西。所以這段按「想蓋什麼」分組，並把最容易
 * 互相搶市場的幾組直接寫成對照，而不是列一張平的清單。
 */
const SHAPE_GUIDE = [
  '',
  '【依意圖選形狀】',
  '基本量體：box 方體、sphere 球、ellipsoid 橢球、cylinder 圓柱、cone 圓錐（topRadius>0 就是圓錐台）、pyramid 金字塔（sides 可調邊數、topRadius>0 就是角錐台）、prism 正 n 角柱。',
  '線與面：line 直線、curve 平滑曲線、disk 圓盤／圓環、tube 任意方向的圓柱。',
  '建築件：wedge 單斜面、roof 屋頂（gable 人字／hip 四坡）、arch 拱、stairs 直階梯、spiralStairs 螺旋梯、polywall 折線牆／城牆。',
  '地景與路徑：heightfield 起伏地表、ribbon 道路／橋面。',
  '裝飾與造型：torus 環、helix 螺旋線、cross 十字柱、star 星形柱、revolution 旋轉體。',
  '',
  '【容易選錯的幾組，先看這裡】',
  '要斜的柱子、樑、管線 → tube，不是 cylinder（cylinder 只能對齊 x／y／z）。',
  '要直角轉折的牆或圍牆 → polywall，不是 curve（curve 是平滑曲線，會把直角磨圓）。',
  '要有屋脊的屋頂 → roof；只要一面斜坡或坡道 → wedge。',
  '要繞塔而上的樓梯 → spiralStairs；直上直下 → stairs。',
  '要上下不等寬的塔身、基座、煙囪 → cone 或 pyramid 加 topRadius，不要用多層 box 疊。',
  '要圓頂、花瓶、拋物面、冷卻塔這類「圓的但粗細會變」→ revolution 換一組 profile，不需要別的形狀。',
  '要一片起伏的地 → heightfield；要一條有寬度的平路 → ribbon。',
  '',
  '不確定就先用 mc_build_preview 看方塊數與邊界盒，它不會動到世界。',
].join('\n');

export function registerBuildTools(server: McpServer, build: BuildService): void {
  server.registerTool(
    'mc_build_preview',
    {
      title: '預覽幾何建造',
      description: `只計算不動工：回報這個形狀會用掉幾個方塊、邊界盒在哪、會拆成幾條 fill 指令。${BUILD_NOTE}`,
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
          `${plan.shape}：${String(plan.blockCount)} 個方塊，拆成 ${String(plan.fillBatches)} 條 fill（比逐格放置少送 ${String(plan.savedCommands)} 次），範圍 (${String(plan.bounds.min.x)}, ${String(plan.bounds.min.y)}, ${String(plan.bounds.min.z)}) 到 (${String(plan.bounds.max.x)}, ${String(plan.bounds.max.y)}, ${String(plan.bounds.max.z)})。`,
        );
      }),
  );

  server.registerTool(
    'mc_build_shape',
    {
      title: '建造幾何形狀',
      description:
        `直接在世界蓋出形狀。方塊座標會自動合併成最少的 fill 指令，所以蓋一顆半徑 20 的球只要幾百條指令而不是三萬條。${SHAPE_GUIDE}${BUILD_NOTE}`,
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
            `建造 ${execution.plan.shape}（${String(execution.plan.blockCount)} 方塊 / ${String(execution.plan.fillBatches)} 批）`,
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
      title: '預覽藍圖建造',
      description:
        '只計算不動工：把一份逐格藍圖依方塊種類分組，回報總方塊數與合併後的 fill 批次數。',
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
          `藍圖：${String(plan.blockCount)} 個方塊，合併成 ${String(plan.fillBatches)} 條指令。`,
        );
      }),
  );

  server.registerTool(
    'mc_build_blueprint',
    {
      title: '建造逐格藍圖',
      description:
        '蓋出任意形狀：直接給一份「座標 → 方塊」清單，相同方塊會自動合併成最少的 fill。' +
        '幾何形狀請優先用 mc_build_shape；這個工具是給像素畫、文字、不規則造型或從外部資料轉來的模型用的。',
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
            `建造藍圖（${String(execution.plan.blockCount)} 方塊 / ${String(execution.plan.fillBatches)} 批）`,
          ),
        );
      }),
  );
}

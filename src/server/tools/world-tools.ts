import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { BlockHandService } from '../../application/blockhand-service.js';
import { analyzeSymmetry } from '../../application/symmetry-service.js';
import { probeReadingPath } from '../../application/reading-probe.js';
import { parseQueryTargetDetails } from '../../application/blockhand-service.js';
import { SENTINEL_BLOCK, readBlockFromOutcome } from '../../domain/block-report.js';
import { worldCommands } from '../../domain/commands.js';
import { assertPlaceableCoordinate } from '../../domain/coordinates.js';
import { BLOCK_HANDLING_MODES, FILL_MODES } from '../../domain/contracts.js';
import {
  blockNameSchema,
  blockStatesSchema,
  commandOutcomeSchema,
  coordinateSchema,
  selectorSchema,
} from '../schemas.js';
import { fail, guard, ok, outcomeToPayload, summarizeOutcome, toCoordinate } from '../tool-kit.js';

export function registerWorldTools(server: McpServer, service: BlockHandService): void {
  server.registerTool(
    'mc_set_block',
    {
      title: '放置單一方塊',
      description:
        '在指定座標放一個方塊。大量方塊請改用 mc_fill 或 mc_build_shape——逐格呼叫這個工具會非常慢。',
      inputSchema: z
        .object({
          position: coordinateSchema(),
          block: blockNameSchema(),
          blockStates: blockStatesSchema().nullable().default(null),
          handling: z.enum(BLOCK_HANDLING_MODES).nullable().default(null),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    async ({ position, block, blockStates, handling }) =>
      guard(async () => {
        const coordinate = toCoordinate(position);
        assertPlaceableCoordinate(coordinate, '放置座標');
        const outcome = await service.run(
          worldCommands.setBlock(coordinate, block, blockStates, handling),
        );
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_fill',
    {
      title: '填滿一個長方體',
      description:
        '用同一種方塊填滿 from 到 to 的長方體。Bedrock 單次上限 32768 格；超過請改用 mc_build_shape，它會自動拆批。mode=hollow 只留外殼、outline 只留邊框。',
      inputSchema: z
        .object({
          from: coordinateSchema(),
          to: coordinateSchema(),
          block: blockNameSchema(),
          blockStates: blockStatesSchema().nullable().default(null),
          mode: z.enum(FILL_MODES).nullable().default(null),
          replaceBlock: blockNameSchema().nullable().default(null).describe('只在 mode="replace" 時有效'),
          replaceStates: blockStatesSchema().nullable().default(null),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    async ({ from, to, block, blockStates, mode, replaceBlock, replaceStates }) =>
      guard(async () => {
        const fromCoordinate = toCoordinate(from);
        const toCoordinateValue = toCoordinate(to);
        assertPlaceableCoordinate(fromCoordinate, '起點');
        assertPlaceableCoordinate(toCoordinateValue, '終點');
        const outcome = await service.run(
          worldCommands.fill(
            fromCoordinate,
            toCoordinateValue,
            block,
            blockStates,
            mode,
            replaceBlock,
            replaceStates,
          ),
        );
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_clone',
    {
      title: '複製一塊區域',
      description:
        '把 begin–end 的區域複製到 destination。cloneMode="move" 會把原地清空。適合把手工蓋好的樣板量產。',
      inputSchema: z
        .object({
          begin: coordinateSchema(),
          end: coordinateSchema(),
          destination: coordinateSchema(),
          maskMode: z.enum(['replace', 'masked']).nullable().default(null),
          cloneMode: z.enum(['normal', 'force', 'move']).nullable().default(null),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ begin, end, destination, maskMode, cloneMode }) =>
      guard(async () => {
        const outcome = await service.run(
          worldCommands.clone(
            toCoordinate(begin),
            toCoordinate(end),
            toCoordinate(destination),
            maskMode,
            cloneMode,
          ),
        );
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_test_block',
    {
      title: '檢查某座標是不是指定方塊',
      description: '不改變世界，只回報該座標是否為指定方塊。建造前確認地形、或驗證剛才蓋的東西時用。',
      inputSchema: z
        .object({
          position: coordinateSchema(),
          block: blockNameSchema(),
          blockStates: blockStatesSchema().nullable().default(null),
        })
        .strict(),
      outputSchema: commandOutcomeSchema().extend({ matches: z.boolean() }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ position, block, blockStates }) =>
      guard(async () => {
        const outcome = await service.run(
          worldCommands.testForBlock(toCoordinate(position), block, blockStates),
        );
        return ok(
          { ...outcomeToPayload(outcome), matches: outcome.ok },
          outcome.ok ? `符合：該座標是 ${block}。` : `不符合：${outcome.statusMessage ?? '該座標不是指定方塊'}`,
        );
      }),
  );

  server.registerTool(
    'mc_analyze_symmetry',
    {
      title: '分析建築的鏡像對稱程度',
      description:
        '檢查一塊區域是否左右（或前後）對稱，並在不對稱時指出**哪幾塊**不對稱。' +
        '批改學生作品用這個：分數是對稱格子的比例，不是憑感覺。' +
        '原理：testforblocks 只會平移比對不會鏡像，所以先用 structure save／load ' +
        '的 mirror 參數做出鏡像副本，再跟原區比對。' +
        '⚠️ 這會**暫時寫入** scratch 指定的暫存區：流程一定先備份該區內容，比對完立刻還原；' +
        '備份失敗就中止且不動世界。scratch 不可與分析區重疊，否則鏡像副本會蓋掉原始建築。' +
        '區域受 structure 指令上限限制（64×384×64）。',
      inputSchema: z
        .object({
          from: coordinateSchema().describe('分析區的一角'),
          to: coordinateSchema().describe('分析區的對角'),
          mirror: z
            .enum(['x', 'z', 'xz'])
            .default('x')
            .describe('鏡射軸；x 檢查左右對稱、z 檢查前後對稱、xz 兩軸都要'),
          scratch: coordinateSchema().describe('暫存區最小角；會被覆蓋後還原，不可與分析區重疊'),
          cellsPerAxis: z
            .number()
            .int()
            .min(1)
            .max(4)
            .default(2)
            .describe('整體不對稱時的細分粒度；每軸 n 段共 n³ 格，每格一條指令'),
        })
        .strict(),
      outputSchema: z
        .object({
          symmetric: z.boolean(),
          score: z.number().describe('0–100，對稱格子的比例'),
          matchedCells: z.number(),
          totalCells: z.number(),
          mirror: z.string(),
          commandsIssued: z.number(),
          scratchRestored: z.boolean().describe('false 代表暫存區沒還原成功，世界被留下改動'),
          asymmetricCells: z.array(
            z.object({
              min: z.object({ x: z.number(), y: z.number(), z: z.number() }),
              max: z.object({ x: z.number(), y: z.number(), z: z.number() }),
            }),
          ),
        })
        .strict(),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
    },
    async ({ from, to, mirror, scratch, cellsPerAxis }) =>
      guard(async () => {
        const report = await analyzeSymmetry(service, {
          from: toCoordinate(from),
          to: toCoordinate(to),
          mirror,
          scratch: toCoordinate(scratch),
          cellsPerAxis,
        });
        const warning = report.scratchRestored ? '' : '⚠️ 暫存區還原失敗，世界被留下改動。';
        const summary = report.symmetric
          ? `完全對稱（${report.mirror} 軸）。${warning}`
          : `對稱度 ${String(report.score)}%（${String(report.matchedCells)}/${String(report.totalCells)} 格相符）；` +
            `不對稱的區塊有 ${String(report.asymmetricCells.length)} 塊。${warning}`;
        return ok(
          {
            symmetric: report.symmetric,
            score: report.score,
            matchedCells: report.matchedCells,
            totalCells: report.totalCells,
            mirror: report.mirror,
            commandsIssued: report.commandsIssued,
            scratchRestored: report.scratchRestored,
            asymmetricCells: report.asymmetricCells.map((cell) => ({ min: cell.min, max: cell.max })),
          },
          summary,
        );
      }),
  );

  server.registerTool(
    'mc_read_block',
    {
      title: '讀取某座標實際是什麼方塊',
      description:
        '回報該座標實際上放著什麼，不需要你先猜。Education 沒有讀取方塊的指令，' +
        '這裡是拿空氣當哨兵去 testforblock，猜錯時遊戲的訊息會把實際方塊講出來。' +
        '注意：回傳的是**在地化顯示名稱**（例如「泥土」）而不是方塊 ID（dirt），' +
        '不能直接餵回 mc_set_block；要用 ID 判斷請改用 mc_test_block。' +
        '訊息格式沒有官方保證，解析不出來時 block 會是 null 並附上原始訊息，不會亂猜。',
      inputSchema: z.object({ position: coordinateSchema() }).strict(),
      outputSchema: commandOutcomeSchema()
        .extend({
          block: z.string().describe('在地化顯示名稱；解析不出來時本工具回錯誤而不是 null'),
          isAir: z.boolean(),
          raw: z.string().nullable(),
        })
        .strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ position }) =>
      guard(async () => {
        const outcome = await service.run(
          worldCommands.testForBlock(toCoordinate(position), SENTINEL_BLOCK, null),
        );
        const reading = readBlockFromOutcome(outcome.ok, outcome.statusMessage ?? null);

        // 解析失敗一律回錯誤，不回「成功但 block 是 null」。
        //
        // 這是刻意的：使用者是 AI，而 AI 不會懷疑系統壞掉。一個成功的回應配上
        // block=null，很容易被讀成「讀到了，那裡是空的」，然後基於錯誤認知繼續
        // 蓋東西——把學生的作品當空地覆蓋掉，而且事後沒有任何錯誤紀錄。
        // 錯誤沒辦法被當成資料繼續用，這就是重點。
        if (reading.block === null) {
          return fail(
            `讀不出 ${String(position.x)},${String(position.y)},${String(position.z)} 的方塊名稱。` +
              '**這不代表那裡是空的**——是遊戲回的訊息格式不符合預期，本工具無法判定。' +
              '最可能的原因是 Minecraft 改版改了訊息文字，或遊戲語言不是繁中／簡中／英文。' +
              `請用 mc_verify_reading 確認解析路徑是否仍然有效。遊戲原始訊息：${reading.raw ?? '(無)'}`,
          );
        }

        return ok(
          {
            ...outcomeToPayload(outcome),
            block: reading.block,
            isAir: reading.isSentinel,
            raw: reading.raw,
          },
          reading.isSentinel ? '該座標是空氣（沒有方塊）。' : `該座標是 ${reading.block}。`,
        );
      }),
  );

  server.registerTool(
    'mc_verify_reading',
    {
      title: '驗證「讀方塊」這條路還有效',
      description:
        '讀方塊靠的是 testforblock **失敗訊息**會洩漏方塊名稱，而那個訊息格式沒有官方穩定性保證。' +
        '遊戲改版改了文案、或遊戲語言不是繁中／簡中／英文，解析就會失效——而且失效的樣子是**安靜的**。' +
        '這支探測會主動驗證解析路徑是否仍然有效，**上課前跑一次**就知道 mc_read_block 的結果能不能信。' +
        '它不需要事先知道那格是什麼：若該格是空氣，就拿基岩去問（保證不符）逼出失敗訊息；' +
        '若該格有東西，第一問就已經給了訊息。最多兩條指令，完全不寫入世界。' +
        'parseable=false 代表協定已漂移，此時 mc_read_block 的結果一律不可信。',
      inputSchema: z
        .object({
          position: coordinateSchema().describe('任一座標皆可，空的或有方塊都行'),
        })
        .strict(),
      outputSchema: z
        .object({
          parseable: z.boolean().describe('false 代表協定已漂移，讀方塊不可信'),
          parsedName: z.string().nullable(),
          raw: z.string().nullable(),
          branch: z.string(),
          commandsIssued: z.number(),
        })
        .strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ position }) =>
      guard(async () => {
        const report = await probeReadingPath(service, toCoordinate(position));
        return ok(
          {
            parseable: report.parseable,
            parsedName: report.parsedName,
            raw: report.raw,
            branch: report.branch,
            commandsIssued: report.commandsIssued,
          },
          report.parseable
            ? `解析路徑正常：從遊戲訊息成功讀出「${report.parsedName ?? ''}」。mc_read_block 可信。`
            : '⚠️ 解析路徑已失效——遊戲訊息不符合任何已知格式。' +
              `mc_read_block 的結果一律不可信，請勿據以判斷「那裡是空的」。原始訊息：${report.raw ?? '(無)'}`,
        );
      }),
  );

  server.registerTool(
    'mc_compare_regions',
    {
      title: '比對兩個等大區域是否一致',
      description:
        '用一條指令比對整片區域，適合檢查學生蓋的東西跟參考範例是否相同。' +
        '逐格比對在幾百格以上就會撞到 MCP host 逾時，這個不會。' +
        'masked=true 會忽略來源區域裡的空氣，只檢查「該有的東西在不在」，' +
        '不管周圍多了什麼；masked=false 則要求完全一致。' +
        '兩個區域大小必須相同，destination 是目標區域的最小角。',
      inputSchema: z
        .object({
          begin: coordinateSchema().describe('來源區域的一角'),
          end: coordinateSchema().describe('來源區域的對角'),
          destination: coordinateSchema().describe('目標區域的最小角'),
          masked: z.boolean().default(false).describe('true 時忽略來源的空氣'),
        })
        .strict(),
      outputSchema: commandOutcomeSchema().extend({ identical: z.boolean() }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ begin, end, destination, masked }) =>
      guard(async () => {
        const outcome = await service.run(
          worldCommands.testForBlocks(
            toCoordinate(begin),
            toCoordinate(end),
            toCoordinate(destination),
            masked,
          ),
        );
        return ok(
          { ...outcomeToPayload(outcome), identical: outcome.ok },
          outcome.ok
            ? `兩個區域一致${masked ? '（忽略空氣）' : ''}。`
            : `不一致：${outcome.statusMessage ?? '區域內容有差異'}`,
        );
      }),
  );

  server.registerTool(
    'mc_query_target',
    {
      title: '查詢實體位置與朝向',
      description:
        '用選擇器查詢實體的座標、朝向與唯一 ID，回傳已解析的 JSON。這是取得玩家或 Agent 目前位置的正規做法——建造前先問這個，才知道要蓋在哪裡。' +
        '預設用 @p（最近的玩家）而非 @s：WebSocket 送進來的指令沒有實體身分，@s 在部分情況下無法解析。',
      inputSchema: z
        .object({ target: selectorSchema().default('@p') })
        .strict(),
      outputSchema: commandOutcomeSchema().extend({ details: z.unknown() }).strict(),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ target }) =>
      guard(async () => {
        const outcome = await service.run(worldCommands.queryTarget(target));
        const details = parseQueryTargetDetails(outcome);
        return ok(
          { ...outcomeToPayload(outcome), details },
          outcome.ok
            ? `已取得 ${target} 的位置資料。`
            : `查詢失敗：${outcome.statusMessage ?? '找不到目標'}`,
        );
      }),
  );

  server.registerTool(
    'mc_summon',
    {
      title: '生成生物或實體',
      description: '在指定座標生成一個實體，可加名牌。position 留空則生在指令發起者位置。',
      inputSchema: z
        .object({
          entity: blockNameSchema().describe('實體 ID，例如 cow 或 minecraft:villager'),
          position: coordinateSchema().nullable().default(null),
          nameTag: z.string().trim().min(1).max(64).nullable().default(null),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ entity, position, nameTag }) =>
      guard(async () => {
        const outcome = await service.run(
          worldCommands.summon(entity, position === null ? null : toCoordinate(position), nameTag),
        );
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_world_settings',
    {
      title: '調整世界設定',
      description:
        '一次改一項世界設定：time 設定時間（day/night/noon/midnight 或 tick 數）、weather 天氣、gamerule 遊戲規則、difficulty 難度。',
      inputSchema: z
        .object({
          setting: z.enum(['time', 'weather', 'gamerule', 'difficulty']),
          value: z.string().trim().min(1).max(64).describe('time:day｜weather:clear｜difficulty:peaceful｜gamerule 的值'),
          rule: z.string().trim().min(1).max(64).optional().describe('setting="gamerule" 時的規則名稱'),
          durationSeconds: z.number().int().min(0).max(1_000_000).nullable().default(null),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ setting, value, rule, durationSeconds }) =>
      guard(async () => {
        let commandLine: string;
        if (setting === 'time') {
          commandLine = worldCommands.setTime(value);
        } else if (setting === 'weather') {
          const parsed = z.enum(['clear', 'rain', 'thunder']).safeParse(value);
          if (!parsed.success) throw new Error('weather 只接受 clear、rain 或 thunder。');
          commandLine = worldCommands.setWeather(parsed.data, durationSeconds);
        } else if (setting === 'difficulty') {
          const parsed = z.enum(['peaceful', 'easy', 'normal', 'hard']).safeParse(value);
          if (!parsed.success) throw new Error('difficulty 只接受 peaceful、easy、normal 或 hard。');
          commandLine = worldCommands.setDifficulty(parsed.data);
        } else {
          if (rule === undefined) throw new Error('setting="gamerule" 需要提供 rule。');
          commandLine = worldCommands.setGameRule(rule, value);
        }
        const outcome = await service.run(commandLine);
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_structure',
    {
      title: '儲存或載入結構',
      description:
        '把一塊區域存成具名結構，或把已存的結構放回世界。這是把 AI 蓋好的東西保存、量產、帶到別的世界的官方途徑。' +
        '\n\n**saveMode 要照使用者的意圖選，不要一律用同一個：**' +
        '\n- `memory`（預設）＝這次連線內的暫存。AI 反覆修改同一棟建築時用這個：想留退路就存一版，' +
        '改壞了 load 回來。關掉遊戲就消失，不會在硬碟累積檔案。' +
        '\n- `disk` ＝**使用者明確表示要保留**時才用（「幫我記住這棟」「存起來下次還要用」）。' +
        '它會寫成檔案存進遊戲的世界資料夾，關掉遊戲也還在——但那是真的在使用者硬碟上留東西，' +
        '不要在他沒說要保留時擅自寫入。' +
        '\n\n版本管理就是**取名字**：`castle_v1`、`castle_v2`。同名會直接覆蓋，改版本前先換名字。' +
        '遊戲沒有「列出已存結構」的指令，所以存過什麼只能靠名字記——本次連線存過的名單可以問 mc_status。',
      inputSchema: z
        .object({
          action: z.enum(['save', 'load']),
          name: z.string().trim().min(1).max(64).describe('版本就靠這個區分；同名會覆蓋'),
          from: coordinateSchema().optional().describe('save 需要'),
          to: coordinateSchema().optional().describe('save 需要'),
          destination: coordinateSchema().optional().describe('load 需要'),
          includeEntities: z.boolean().default(false),
          saveMode: z
            .enum(['memory', 'disk'])
            .default('memory')
            .describe('memory=暫存（預設）；disk=寫進硬碟，只在使用者明確說要保留時用'),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ action, name, from, to, destination, includeEntities, saveMode }) =>
      guard(async () => {
        let commandLine: string;
        if (action === 'save') {
          if (from === undefined || to === undefined) {
            throw new Error('action="save" 需要 from 與 to。');
          }
          commandLine = worldCommands.saveStructure(
            name,
            toCoordinate(from),
            toCoordinate(to),
            includeEntities,
            saveMode,
          );
        } else {
          if (destination === undefined) throw new Error('action="load" 需要 destination。');
          commandLine = worldCommands.loadStructure(name, toCoordinate(destination));
        }
        const outcome = await service.run(commandLine);
        if (action === 'save' && outcome.ok) service.rememberStructure(name, saveMode);

        // 寫入硬碟一定要講出來。使用者只說「存一下」卻在他的世界資料夾留下
        // 檔案，是那種當下沒人察覺、事後才變成問題的事。
        const note =
          action === 'save'
            ? saveMode === 'disk'
              ? '（已寫入遊戲世界資料夾，關掉遊戲仍在）'
              : '（暫存於記憶體，關掉遊戲就消失）'
            : '';
        return ok(outcomeToPayload(outcome), `${summarizeOutcome(outcome)}${note}`);
      }),
  );

  server.registerTool(
    'mc_ticking_area',
    {
      title: '新增常載區域',
      description:
        '把一塊區域設為常載，讓玩家離開後那裡的機制仍會運作。Agent 要在遠處自動工作時需要這個。',
      inputSchema: z
        .object({
          from: coordinateSchema(),
          to: coordinateSchema(),
          name: z.string().trim().min(1).max(32).nullable().default(null),
        })
        .strict(),
      outputSchema: commandOutcomeSchema(),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ from, to, name }) =>
      guard(async () => {
        const outcome = await service.run(
          worldCommands.addTickingArea(toCoordinate(from), toCoordinate(to), name),
        );
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );
}

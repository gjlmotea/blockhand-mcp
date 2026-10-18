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
import { fail, guard, notInWorldHint, ok, outcomeToPayload, summarizeOutcome, toCoordinate } from '../tool-kit.js';

export function registerWorldTools(server: McpServer, service: BlockHandService): void {
  server.registerTool(
    'mc_set_block',
    {
      title: 'Place one block',
      description:
        'Place one block at a coordinate. For many blocks use mc_fill or mc_build_shape instead; calling this tool block by block is very slow.',
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
        assertPlaceableCoordinate(coordinate, 'position');
        const outcome = await service.run(
          worldCommands.setBlock(coordinate, block, blockStates, handling),
        );
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_fill',
    {
      title: 'Fill a box',
      description:
        'Fill the box from from to to with one kind of block. Bedrock allows at most 32768 blocks per fill; beyond that use mc_build_shape, which splits the work into batches automatically. mode=hollow keeps only the shell, outline keeps only the edges.',
      inputSchema: z
        .object({
          from: coordinateSchema(),
          to: coordinateSchema(),
          block: blockNameSchema(),
          blockStates: blockStatesSchema().nullable().default(null),
          mode: z.enum(FILL_MODES).nullable().default(null),
          replaceBlock: blockNameSchema().nullable().default(null).describe('Only used when mode="replace"'),
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
        assertPlaceableCoordinate(fromCoordinate, 'from');
        assertPlaceableCoordinate(toCoordinateValue, 'to');
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
      title: 'Clone a region',
      description:
        'Copy the region from begin to end to destination. cloneMode="move" clears the original. Good for mass-producing a hand-built template.',
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
      title: 'Test whether a coordinate holds a block',
      description: 'Report whether a coordinate holds the given block, without changing the world. Use it to check the terrain before building or to verify what was just built.',
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
          outcome.ok ? `Match: the coordinate is ${block}.` : `No match: ${outcome.statusMessage ?? 'the coordinate is not that block'}${notInWorldHint(outcome)}`,
        );
      }),
  );

  server.registerTool(
    'mc_analyze_symmetry',
    {
      title: 'Analyze how mirror-symmetric a build is',
      description:
        'Check whether a region is symmetric left to right (or front to back), and when it is not, point out **which parts** are not. ' +
        'Use it to grade student builds: the score is the share of symmetric cells, not a gut feeling. ' +
        'How it works: testforblocks only compares by translation, never mirrored, so a mirrored copy is made first with the mirror option of structure save / load ' +
        'and then compared with the original. ' +
        'Warning: this **temporarily writes** to the scratch area: its contents are always backed up first and restored right after the comparison; ' +
        'if the backup fails, it stops without touching the world. scratch must not overlap the analyzed region, or the mirrored copy overwrites the original build. ' +
        'The region is limited by the structure command (64x384x64).',
      inputSchema: z
        .object({
          from: coordinateSchema().describe('One corner of the analyzed region'),
          to: coordinateSchema().describe('The opposite corner of the analyzed region'),
          mirror: z
            .enum(['x', 'z', 'xz'])
            .default('x')
            .describe('Mirror axis: x checks left-right symmetry, z checks front-back symmetry, xz requires both'),
          scratch: coordinateSchema().describe('Minimum corner of the scratch area; it is overwritten and then restored, and must not overlap the analyzed region'),
          cellsPerAxis: z
            .number()
            .int()
            .min(1)
            .max(4)
            .default(2)
            .describe('Subdivision when the whole region is not symmetric: n parts per axis, n^3 cells, one command per cell'),
        })
        .strict(),
      outputSchema: z
        .object({
          symmetric: z.boolean(),
          score: z.number().describe('0-100, the share of symmetric cells'),
          matchedCells: z.number(),
          totalCells: z.number(),
          mirror: z.string(),
          commandsIssued: z.number(),
          scratchRestored: z.boolean().describe('false means the scratch area was not restored and the world was left changed'),
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
        const warning = report.scratchRestored ? '' : ' Warning: restoring the scratch area failed, so the world was left changed.';
        const summary = report.symmetric
          ? `Fully symmetric (${report.mirror} axis).${warning}`
          : `Symmetry ${String(report.score)}% (${String(report.matchedCells)}/${String(report.totalCells)} cells match); ` +
            `${String(report.asymmetricCells.length)} cells are not symmetric.${warning}`;
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
      title: 'Read which block is at a coordinate',
      description:
        'Report what is actually at a coordinate, without you having to guess first. Education has no command to read a block, ' +
        'so this runs testforblock with air as a sentinel; when the guess is wrong, the game message names the actual block. ' +
        'Note: it returns the **localized display name** (for example "Dirt", or "泥土" in a Chinese game), not the block ID (dirt), ' +
        'so it cannot be fed back to mc_set_block; to check by ID, use mc_test_block. ' +
        'The message format has no official guarantee; when it cannot be parsed, this tool returns an error with the raw message instead of guessing.',
      inputSchema: z.object({ position: coordinateSchema() }).strict(),
      outputSchema: commandOutcomeSchema()
        .extend({
          block: z.string().describe('Localized display name; when it cannot be parsed, this tool returns an error instead of null'),
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
            `Could not read the block name at ${String(position.x)},${String(position.y)},${String(position.z)}. ` +
              '**This does not mean the spot is empty**: the game message did not match the expected format, so this tool cannot tell. ' +
              'The most likely causes are a Minecraft update that changed the message text, or a game language other than Traditional Chinese, Simplified Chinese or English. ' +
              `Use mc_verify_reading to check whether the reading path still works. Raw game message: ${reading.raw ?? '(none)'}${notInWorldHint(outcome)}`,
          );
        }

        return ok(
          {
            ...outcomeToPayload(outcome),
            block: reading.block,
            isAir: reading.isSentinel,
            raw: reading.raw,
          },
          reading.isSentinel ? 'The coordinate is air (no block).' : `The coordinate is ${reading.block}.`,
        );
      }),
  );

  server.registerTool(
    'mc_verify_reading',
    {
      title: 'Verify that block reading still works',
      description:
        'Block reading relies on the testforblock **failure message** revealing the block name, and that message format has no official stability guarantee. ' +
        'When a game update changes the wording, or the game language is not Traditional Chinese, Simplified Chinese or English, parsing breaks, and it breaks **silently**. ' +
        'This probe actively checks whether the reading path still works; **run it once before class** to know whether mc_read_block results can be trusted. ' +
        'It does not need to know what is at the spot: if it is air, it asks about bedrock (a guaranteed mismatch) to force a failure message; ' +
        'if something is there, the first question already produced a message. At most two commands, and it never writes to the world. ' +
        'parseable=false means the protocol has drifted, and mc_read_block results cannot be trusted at all.',
      inputSchema: z
        .object({
          position: coordinateSchema().describe('Any coordinate works, empty or not'),
        })
        .strict(),
      outputSchema: z
        .object({
          parseable: z.boolean().describe('false means the protocol has drifted and block reading cannot be trusted'),
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
            ? `The reading path works: read "${report.parsedName ?? ''}" from the game message. mc_read_block can be trusted.`
            : 'Warning: the reading path is broken; the game message matches no known format. ' +
              `mc_read_block results cannot be trusted at all; do not conclude from them that a spot is empty. Raw message: ${report.raw ?? '(none)'}`,
        );
      }),
  );

  server.registerTool(
    'mc_compare_regions',
    {
      title: 'Compare two regions of equal size',
      description:
        'Compare a whole region with one command; good for checking whether a student build matches a reference. ' +
        'Comparing block by block hits the MCP host timeout beyond a few hundred blocks; this does not. ' +
        'masked=true ignores air in the source region and only checks that what should be there is there, ' +
        'regardless of anything extra around it; masked=false requires an exact match. ' +
        'Both regions must be the same size; destination is the minimum corner of the target region.',
      inputSchema: z
        .object({
          begin: coordinateSchema().describe('One corner of the source region'),
          end: coordinateSchema().describe('The opposite corner of the source region'),
          destination: coordinateSchema().describe('Minimum corner of the target region'),
          masked: z.boolean().default(false).describe('When true, air in the source is ignored'),
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
            ? `The regions match${masked ? ' (air ignored)' : ''}.`
            : `No match: ${outcome.statusMessage ?? 'the regions differ'}${notInWorldHint(outcome)}`,
        );
      }),
  );

  server.registerTool(
    'mc_query_target',
    {
      title: 'Query entity position and facing',
      description:
        'Query the coordinates, facing and unique ID of entities by selector, returned as parsed JSON. This is the standard way to get the current position of the player or the Agent; ask this before building so you know where to build. ' +
        'It defaults to @p (the nearest player) rather than @s: commands sent over the WebSocket have no entity identity, so @s cannot be resolved in some cases.',
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
            ? `Got position data for ${target}.`
            : `Query failed: ${outcome.statusMessage ?? 'no target found'}${notInWorldHint(outcome)}`,
        );
      }),
  );

  server.registerTool(
    'mc_summon',
    {
      title: 'Summon a mob or entity',
      description: 'Spawn one entity at a coordinate, optionally with a name tag. Leave position empty to spawn it where the command runs.',
      inputSchema: z
        .object({
          entity: blockNameSchema().describe('Entity ID, for example cow or minecraft:villager'),
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
      title: 'Change a world setting',
      description:
        'Change one world setting at a time: time sets the time (day/night/noon/midnight or a tick count), weather the weather, gamerule a game rule, difficulty the difficulty.',
      inputSchema: z
        .object({
          setting: z.enum(['time', 'weather', 'gamerule', 'difficulty']),
          value: z.string().trim().min(1).max(64).describe('time: day | weather: clear | difficulty: peaceful | the gamerule value'),
          rule: z.string().trim().min(1).max(64).optional().describe('Rule name when setting="gamerule"'),
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
          if (!parsed.success) throw new Error('weather accepts only clear, rain or thunder.');
          commandLine = worldCommands.setWeather(parsed.data, durationSeconds);
        } else if (setting === 'difficulty') {
          const parsed = z.enum(['peaceful', 'easy', 'normal', 'hard']).safeParse(value);
          if (!parsed.success) throw new Error('difficulty accepts only peaceful, easy, normal or hard.');
          commandLine = worldCommands.setDifficulty(parsed.data);
        } else {
          if (rule === undefined) throw new Error('setting="gamerule" requires rule.');
          commandLine = worldCommands.setGameRule(rule, value);
        }
        const outcome = await service.run(commandLine);
        return ok(outcomeToPayload(outcome), summarizeOutcome(outcome));
      }),
  );

  server.registerTool(
    'mc_structure',
    {
      title: 'Save or load a structure',
      description:
        'Save a region as a named structure, or place a saved structure back into the world. This is the official way to keep what the AI built, mass-produce it, or take it to another world.' +
        '\n\n**Choose saveMode by what the user wants; do not always use the same one:**' +
        '\n- `memory` (default) = temporary storage for this connection. Use it while the AI keeps revising the same build: save a version to keep a way back, ' +
        'and load it if a change goes wrong. It disappears when the game closes and leaves no files on disk.' +
        '\n- `disk` = only when **the user explicitly says to keep it** ("remember this building", "save it so I can use it next time"). ' +
        'It is written as a file into the game world folder and survives closing the game, which really leaves something on the user disk, ' +
        'so do not write it when they did not ask to keep it.' +
        '\n\nVersioning is **naming**: `castle_v1`, `castle_v2`. The same name overwrites without warning, so change the name before saving a new version. ' +
        'The game has no command to list saved structures, so names are the only record; mc_status lists the ones saved during this connection.',
      inputSchema: z
        .object({
          action: z.enum(['save', 'load']),
          name: z.string().trim().min(1).max(64).describe('Versions are told apart by this; the same name overwrites'),
          from: coordinateSchema().optional().describe('Required for save'),
          to: coordinateSchema().optional().describe('Required for save'),
          destination: coordinateSchema().optional().describe('Required for load'),
          includeEntities: z.boolean().default(false),
          saveMode: z
            .enum(['memory', 'disk'])
            .default('memory')
            .describe('memory = temporary (default); disk = written to disk, only when the user explicitly says to keep it'),
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
            throw new Error('action="save" requires from and to.');
          }
          commandLine = worldCommands.saveStructure(
            name,
            toCoordinate(from),
            toCoordinate(to),
            includeEntities,
            saveMode,
          );
        } else {
          if (destination === undefined) throw new Error('action="load" requires destination.');
          commandLine = worldCommands.loadStructure(name, toCoordinate(destination));
        }
        const outcome = await service.run(commandLine);
        if (action === 'save' && outcome.ok) service.rememberStructure(name, saveMode);

        // 寫入硬碟一定要講出來。使用者只說「存一下」卻在他的世界資料夾留下
        // 檔案，是那種當下沒人察覺、事後才變成問題的事。
        const note =
          action === 'save'
            ? saveMode === 'disk'
              ? ' (written to the game world folder; it stays after the game closes)'
              : ' (kept in memory; it disappears when the game closes)'
            : '';
        return ok(outcomeToPayload(outcome), `${summarizeOutcome(outcome)}${note}`);
      }),
  );

  server.registerTool(
    'mc_ticking_area',
    {
      title: 'Add a ticking area',
      description:
        'Keep a region loaded so its mechanisms keep running after the player leaves. Needed when the Agent works on its own far away.',
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

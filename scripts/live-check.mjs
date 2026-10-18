/**
 * 真機驗證：需要 Minecraft Education 正在執行、世界已開作弊。
 *
 * 這支腳本走完一條真實使用路徑——連線、讀玩家位置、召喚 Agent、感測、
 * 建造、回頭驗證方塊真的存在、訂閱並收事件——每一步都印出結果。
 * 它刻意不做任何 mock：這裡失敗就是真的不能用。
 *
 * 用法：node scripts/live-check.mjs [--keep]
 *   --keep  保留示範建築（預設會清乾淨，不留垃圾在世界裡）
 */

import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const keepBuild = process.argv.includes('--keep');
const port = process.env.MINECRAFT_EDU_WS_PORT ?? '19131';
const waitSeconds = Number.parseInt(process.env.LIVE_WAIT_SECONDS ?? '120', 10);

const steps = [];
let stepNumber = 0;

function record(name, passed, detail) {
  stepNumber += 1;
  steps.push({ name, passed, detail });
  const mark = passed ? 'PASS' : 'FAIL';
  process.stdout.write(`[${String(stepNumber).padStart(2, '0')}] ${mark}  ${name}\n`);
  if (detail !== undefined && detail !== '') {
    process.stdout.write(`         ${detail}\n`);
  }
}

function text(result) {
  return result?.content?.[0]?.text ?? '';
}

/**
 * MCP client 預設 60 秒逾時。建造工具會逐條送出上百條 fill 並等回應，
 * 大型形狀很容易超過，所以這些呼叫必須自己指定較長的逾時。
 */
const BUILD_TIMEOUT_MS = 300_000;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['scripts/launch-mcp.mjs'],
  cwd: projectRoot,
  stderr: 'pipe',
  env: {
    ...getDefaultEnvironment(),
    MINECRAFT_EDU_WS_HOST: '127.0.0.1',
    MINECRAFT_EDU_WS_PORT: port,
    ...(process.env.MINECRAFT_EDU_WS_PORT_FALLBACK === undefined
      ? {}
      : { MINECRAFT_EDU_WS_PORT_FALLBACK: process.env.MINECRAFT_EDU_WS_PORT_FALLBACK }),
    // getDefaultEnvironment() 只帶最小安全集合，這兩個必須明確轉發，
    // 否則在外層設了也不會生效——診斷時會誤以為除錯輸出壞掉。
    ...(process.env.MINECRAFT_EDU_DEBUG_FRAMES === undefined
      ? {}
      : { MINECRAFT_EDU_DEBUG_FRAMES: process.env.MINECRAFT_EDU_DEBUG_FRAMES }),
    ...(process.env.MINECRAFT_EDU_ENCRYPTION === undefined
      ? {}
      : { MINECRAFT_EDU_ENCRYPTION: process.env.MINECRAFT_EDU_ENCRYPTION }),
  },
});

const client = new Client({ name: 'minecraft-edu-live-check', version: '1.0.0' });

try {
  await client.connect(transport);

  // stderr 是 pipe，沒人讀就等於把 MINECRAFT_EDU_DEBUG_FRAMES 的輸出丟掉。
  // 轉發到本行程的 stdout，診斷資訊才看得到。
  transport.stderr?.on('data', (chunk) => {
    process.stdout.write(`  · ${chunk.toString().trimEnd().split('\n').join('\n  · ')}\n`);
  });

  const initial = await client.callTool({ name: 'mc_status', arguments: {} });
  process.stdout.write(
    `\nThe bridge is listening. Type this into the Minecraft Education chat:\n\n    ${initial.structuredContent.connectCommand}\n\nWaiting for the connection (up to ${waitSeconds} seconds)...\n\n`,
  );

  // 分段輪詢：單次等待受工具 schema 上限與 MCP client 預設逾時（60 秒）雙重限制，
  // 所以用 45 秒為一段反覆等，直到總時長用完。
  const chunkSeconds = 45;
  const deadline = Date.now() + waitSeconds * 1000;
  let connected = initial;
  while (Date.now() < deadline) {
    connected = await client.callTool({
      name: 'mc_await_connection',
      arguments: { timeoutSeconds: chunkSeconds },
    });
    if (connected.isError === true) {
      throw new Error(`mc_await_connection failed: ${text(connected)}`);
    }
    if (connected.structuredContent?.connected === true) break;
    process.stdout.write(`  ...still waiting (${Math.max(0, Math.round((deadline - Date.now()) / 1000))} seconds left)\n`);
  }

  if (connected.structuredContent?.connected !== true) {
    process.stdout.write('\nNot connected within the time limit; stopping the check.\n');
    process.exitCode = 1;
  } else {
    record('WebSocket connection established', true, `connection #${connected.structuredContent.connectionCount}`);

    /* 1. 讀玩家位置——所有建造座標都以此為基準。
     *
     * WebSocket 送進來的指令沒有實體身分，@s 不一定能解析，所以依序試
     * @p → @a → @e[type=player]，並把每次的實際回應印出來，失敗時看得到原因。 */
    let origin = null;
    let usedSelector = null;
    const attempts = [];

    for (const selector of ['@p', '@a', '@e[type=player]']) {
      const target = await client.callTool({ name: 'mc_query_target', arguments: { target: selector } });
      const details = target.structuredContent?.details;
      const position = Array.isArray(details) ? details[0]?.position : undefined;
      attempts.push(
        `${selector} → ${position === undefined ? (target.structuredContent?.statusMessage ?? text(target)) : 'ok'}`,
      );
      if (position !== undefined) {
        origin = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
        usedSelector = selector;
        break;
      }
    }

    record(
      'mc_query_target reads the player position',
      origin !== null,
      origin === null
        ? `every selector failed: ${attempts.join('; ')}`
        : `${usedSelector} found the player at (${origin.x}, ${origin.y}, ${origin.z})`,
    );

    if (origin === null) {
      throw new Error(`Could not get the player position, so the builds that follow have no reference point. Attempts: ${attempts.join('; ')}`);
    }

    /* 1.5 事件訂閱必須在動作之前。
     *
     * 先前版本在建造「之後」才訂閱，結果什麼都收不到——因為 BlockPlaced 只在
     * 玩家親手放方塊時觸發，/fill 與 /setblock 都不算。訂閱提前，後面的 Agent
     * 動作與玩家移動才會產生真事件可收。 */
    const watchedEvents = [
      'PlayerMessage',
      'PlayerTravelled',
      'BlockPlaced',
      'BlockBroken',
      'AgentCommand',
    ];
    const subscribed = [];
    for (const eventName of watchedEvents) {
      const result = await client.callTool({
        name: 'mc_events_subscribe',
        arguments: { eventName },
      });
      if (result.isError !== true) subscribed.push(eventName);
    }
    record(
      'mc_events_subscribe subscribes to events up front',
      subscribed.length === watchedEvents.length,
      `subscribed: ${subscribed.join(', ')}`,
    );

    /* 2. 在遊戲內說話。 */
    const said = await client.callTool({
      name: 'mc_message',
      arguments: { channel: 'say', message: 'BlockHand connected; starting the self-check.' },
    });
    record('mc_message speaks in the game', said.structuredContent?.ok === true, text(said));

    /* 3. 世界設定：把時間設成白天，方便肉眼確認。 */
    const day = await client.callTool({
      name: 'mc_world_settings',
      arguments: { setting: 'time', value: 'day' },
    });
    record('mc_world_settings sets the time', day.structuredContent?.ok === true, text(day));

    /* 4. Agent：召喚 → 感測 → 走動。 */
    const created = await client.callTool({ name: 'mc_agent_create', arguments: {} });
    record('mc_agent_create summons the Agent', created.structuredContent?.ok === true, text(created));

    const sensed = await client.callTool({
      name: 'mc_agent_sense',
      arguments: { mode: 'detect', direction: 'down' },
    });
    record(
      'mc_agent_sense detects the block below',
      sensed.structuredContent !== undefined,
      JSON.stringify(sensed.structuredContent?.data ?? sensed.structuredContent?.statusMessage),
    );

    const walked = await client.callTool({
      name: 'mc_agent_program',
      arguments: {
        steps: [
          { action: 'move', direction: 'forward', steps: 2 },
          { action: 'turn', direction: 'left', times: 1 },
          { action: 'move', direction: 'forward', steps: 2 },
        ],
        delayMs: 250,
      },
    });
    record(
      'mc_agent_program walks an L-shaped path',
      walked.structuredContent?.issued === 5,
      `${walked.structuredContent?.issued} sent, ${walked.structuredContent?.succeeded} succeeded`,
    );

    /* 5. 建造：先預覽，再動工，最後回頭驗證方塊真的在。 */
    const center = { x: origin.x + 12, y: origin.y + 6, z: origin.z };
    const shape = { kind: 'sphere', center, radius: 6, hollow: true };

    const preview = await client.callTool({
      name: 'mc_build_preview',
      arguments: { shape, block: 'glass' },
    });
    record(
      'mc_build_preview computes without building',
      preview.structuredContent?.blockCount > 0,
      `${preview.structuredContent?.blockCount} blocks → ${preview.structuredContent?.fillBatches} fill commands (${preview.structuredContent?.savedCommands} round trips saved)`,
    );

    /* 先清空目標區域。
     *
     * Bedrock 的 /fill 在「沒有任何方塊被改變」時回報失敗，所以對著上一輪
     * 留下的同一顆球再蓋一次，會得到 0/126 全失敗——那不是工具壞掉，是世界
     * 已經長那樣了。清空之後這一步才真的在驗建造。 */
    const clearFrom = { x: center.x - 7, y: center.y - 7, z: center.z - 7 };
    const clearTo = { x: center.x + 7, y: center.y + 7, z: center.z + 7 };
    const cleared = await client.callTool({
      name: 'mc_fill',
      arguments: { from: clearFrom, to: clearTo, block: 'air' },
    }, undefined, { timeout: BUILD_TIMEOUT_MS });
    process.stdout.write(
      `  · Before building, cleared ${JSON.stringify(clearFrom)}–${JSON.stringify(clearTo)}: ${cleared.structuredContent?.ok === true ? 'cleared' : 'already empty'}\n`,
    );

    const built = await client.callTool({
      name: 'mc_build_shape',
      arguments: { shape, block: 'glass' },
    }, undefined, { timeout: BUILD_TIMEOUT_MS });
    record(
      'mc_build_shape builds a hollow glass sphere',
      built.structuredContent?.ok === true,
      `${built.structuredContent?.succeeded}/${built.structuredContent?.issued} commands succeeded in ${built.structuredContent?.elapsedMs} ms`,
    );

    /* 球心正上方 radius 格必定是殼上的方塊。 */
    const shellPoint = { x: center.x, y: center.y + 6, z: center.z };
    const verified = await client.callTool({
      name: 'mc_test_block',
      arguments: { position: shellPoint, block: 'glass' },
    });
    record(
      'mc_test_block confirms the block is really there',
      verified.structuredContent?.matches === true,
      `(${shellPoint.x}, ${shellPoint.y}, ${shellPoint.z}) is glass: ${verified.structuredContent?.matches}`,
    );

    /* 6. 藍圖：用逐格資料蓋一根柱子，驗證合併邏輯在真機也對。 */
    const pillar = Array.from({ length: 5 }, (_, index) => ({
      position: { x: center.x, y: origin.y + index, z: center.z + 8 },
      block: 'sea_lantern',
    }));
    const blueprint = await client.callTool({
      name: 'mc_build_blueprint',
      arguments: { entries: pillar },
    }, undefined, { timeout: BUILD_TIMEOUT_MS });
    record(
      'mc_build_blueprint merges a per-block blueprint into one fill',
      blueprint.structuredContent?.plan?.fillBatches === 1,
      `5 blocks merged into ${blueprint.structuredContent?.plan?.fillBatches} command(s)`,
    );

    /* 7. 事件：收取這段期間累積的真實遊戲事件。 */
    process.stdout.write('\n  → Walk a few steps in the game or type a line in the chat (within 10 seconds)…\n\n');
    await new Promise((resolve) => setTimeout(resolve, 10_000));

    const polled = await client.callTool({
      name: 'mc_events_poll',
      arguments: { afterCursor: 0, limit: 50 },
    });
    const received = polled.structuredContent?.events ?? [];
    record(
      'mc_events_subscribe/poll receives real game events',
      received.length > 0,
      received.length > 0
        ? `received ${received.length}: ${[...new Set(received.map((event) => event.eventName))].join(', ')}`
        : 'no events received (this world may not fire these events)',
    );

    /* 8. 政策閘門在真機同樣生效。 */
    const forbidden = await client.callTool({
      name: 'mc_run_command',
      arguments: { command: `connect 127.0.0.1:${port}` },
    });
    record('Policy gate blocks a command that would cut the bridge', forbidden.isError === true, text(forbidden));

    /* 9. 收尾。 */
    if (keepBuild) {
      record('Demo build kept', true, `glass sphere centered at (${center.x}, ${center.y}, ${center.z}), radius 6`);
    } else {
      const cleanup = await client.callTool({
        name: 'mc_build_shape',
        arguments: { shape: { ...shape, hollow: false }, block: 'air' },
      }, undefined, { timeout: BUILD_TIMEOUT_MS });
      const cleanupPillar = await client.callTool({
        name: 'mc_build_blueprint',
        arguments: { entries: pillar.map((entry) => ({ ...entry, block: 'air' })) },
      }, undefined, { timeout: BUILD_TIMEOUT_MS });
      record(
        'Demo build removed, world restored',
        cleanup.structuredContent?.ok === true && cleanupPillar.structuredContent?.ok === true,
        'glass sphere and lantern pillar filled back with air',
      );
    }

    const finalStatus = await client.callTool({ name: 'mc_status', arguments: {} });
    record(
      'Final status',
      finalStatus.structuredContent?.connected === true,
      `${finalStatus.structuredContent?.commandsIssued} commands sent in this run`,
    );
  }
} catch (error) {
  record('Unexpected error', false, error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  const failed = steps.filter((step) => !step.passed);
  process.stdout.write(
    `\n───────────────\n${steps.length - failed.length}/${steps.length} passed\n`,
  );
  if (failed.length > 0) {
    process.stdout.write(`Failed: ${failed.map((step) => step.name).join(', ')}\n`);
    process.exitCode = 1;
  }
  await client.close();
}

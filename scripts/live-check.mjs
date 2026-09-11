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
    `\n橋接已監聽。請在 Minecraft Education 聊天列輸入：\n\n    ${initial.structuredContent.connectCommand}\n\n等待連線中（最多 ${waitSeconds} 秒）...\n\n`,
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
      throw new Error(`mc_await_connection 失敗：${text(connected)}`);
    }
    if (connected.structuredContent?.connected === true) break;
    process.stdout.write(`  ...仍在等待（剩 ${Math.max(0, Math.round((deadline - Date.now()) / 1000))} 秒）\n`);
  }

  if (connected.structuredContent?.connected !== true) {
    process.stdout.write('\n未在時限內連上，中止驗證。\n');
    process.exitCode = 1;
  } else {
    record('WebSocket 連線建立', true, `第 ${connected.structuredContent.connectionCount} 次連線`);

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
      'mc_query_target 讀出玩家座標',
      origin !== null,
      origin === null
        ? `全部選擇器都失敗：${attempts.join('；')}`
        : `${usedSelector} 讀到玩家在 (${origin.x}, ${origin.y}, ${origin.z})`,
    );

    if (origin === null) {
      throw new Error(`拿不到玩家座標，後續建造無法定位。嘗試紀錄：${attempts.join('；')}`);
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
      'mc_events_subscribe 提前訂閱事件',
      subscribed.length === watchedEvents.length,
      `已訂閱：${subscribed.join(', ')}`,
    );

    /* 2. 在遊戲內說話。 */
    const said = await client.callTool({
      name: 'mc_message',
      arguments: { channel: 'say', message: 'BlockHand 已接上，開始自我驗證。' },
    });
    record('mc_message 在遊戲內發話', said.structuredContent?.ok === true, text(said));

    /* 3. 世界設定：把時間設成白天，方便肉眼確認。 */
    const day = await client.callTool({
      name: 'mc_world_settings',
      arguments: { setting: 'time', value: 'day' },
    });
    record('mc_world_settings 設定時間', day.structuredContent?.ok === true, text(day));

    /* 4. Agent：召喚 → 感測 → 走動。 */
    const created = await client.callTool({ name: 'mc_agent_create', arguments: {} });
    record('mc_agent_create 召喚 Agent', created.structuredContent?.ok === true, text(created));

    const sensed = await client.callTool({
      name: 'mc_agent_sense',
      arguments: { mode: 'detect', direction: 'down' },
    });
    record(
      'mc_agent_sense 感測腳下',
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
      'mc_agent_program 走出 L 形路徑',
      walked.structuredContent?.issued === 5,
      `送出 ${walked.structuredContent?.issued} 條、成功 ${walked.structuredContent?.succeeded} 條`,
    );

    /* 5. 建造：先預覽，再動工，最後回頭驗證方塊真的在。 */
    const center = { x: origin.x + 12, y: origin.y + 6, z: origin.z };
    const shape = { kind: 'sphere', center, radius: 6, hollow: true };

    const preview = await client.callTool({
      name: 'mc_build_preview',
      arguments: { shape, block: 'glass' },
    });
    record(
      'mc_build_preview 先算不動工',
      preview.structuredContent?.blockCount > 0,
      `${preview.structuredContent?.blockCount} 方塊 → ${preview.structuredContent?.fillBatches} 條 fill（省下 ${preview.structuredContent?.savedCommands} 次往返）`,
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
      `  · 建造前清空 ${JSON.stringify(clearFrom)}–${JSON.stringify(clearTo)}：${cleared.structuredContent?.ok === true ? '已清空' : '原本就是空的'}\n`,
    );

    const built = await client.callTool({
      name: 'mc_build_shape',
      arguments: { shape, block: 'glass' },
    }, undefined, { timeout: BUILD_TIMEOUT_MS });
    record(
      'mc_build_shape 蓋出空心玻璃球',
      built.structuredContent?.ok === true,
      `${built.structuredContent?.succeeded}/${built.structuredContent?.issued} 條指令成功，用時 ${built.structuredContent?.elapsedMs} ms`,
    );

    /* 球心正上方 radius 格必定是殼上的方塊。 */
    const shellPoint = { x: center.x, y: center.y + 6, z: center.z };
    const verified = await client.callTool({
      name: 'mc_test_block',
      arguments: { position: shellPoint, block: 'glass' },
    });
    record(
      'mc_test_block 回頭驗證方塊真的存在',
      verified.structuredContent?.matches === true,
      `(${shellPoint.x}, ${shellPoint.y}, ${shellPoint.z}) 是 glass：${verified.structuredContent?.matches}`,
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
      'mc_build_blueprint 逐格藍圖合併成單一 fill',
      blueprint.structuredContent?.plan?.fillBatches === 1,
      `5 個方塊合併成 ${blueprint.structuredContent?.plan?.fillBatches} 條指令`,
    );

    /* 7. 事件：收取這段期間累積的真實遊戲事件。 */
    process.stdout.write('\n  → 請在遊戲裡走幾步、或在聊天列打一句話（10 秒內）…\n\n');
    await new Promise((resolve) => setTimeout(resolve, 10_000));

    const polled = await client.callTool({
      name: 'mc_events_poll',
      arguments: { afterCursor: 0, limit: 50 },
    });
    const received = polled.structuredContent?.events ?? [];
    record(
      'mc_events_subscribe/poll 收到真實遊戲事件',
      received.length > 0,
      received.length > 0
        ? `收到 ${received.length} 筆：${[...new Set(received.map((event) => event.eventName))].join(', ')}`
        : '沒有收到事件（可能該世界不觸發此類事件）',
    );

    /* 8. 政策閘門在真機同樣生效。 */
    const forbidden = await client.callTool({
      name: 'mc_run_command',
      arguments: { command: `connect 127.0.0.1:${port}` },
    });
    record('政策閘門擋下會切斷橋接的指令', forbidden.isError === true, text(forbidden));

    /* 9. 收尾。 */
    if (keepBuild) {
      record('保留示範建築', true, `玻璃球中心 (${center.x}, ${center.y}, ${center.z})，半徑 6`);
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
        '清除示範建築，世界恢復原狀',
        cleanup.structuredContent?.ok === true && cleanupPillar.structuredContent?.ok === true,
        '玻璃球與光柱已填回 air',
      );
    }

    const finalStatus = await client.callTool({ name: 'mc_status', arguments: {} });
    record(
      '最終狀態',
      finalStatus.structuredContent?.connected === true,
      `本次共送出 ${finalStatus.structuredContent?.commandsIssued} 條指令`,
    );
  }
} catch (error) {
  record('未預期的錯誤', false, error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  const failed = steps.filter((step) => !step.passed);
  process.stdout.write(
    `\n───────────────\n通過 ${steps.length - failed.length}／${steps.length} 項\n`,
  );
  if (failed.length > 0) {
    process.stdout.write(`失敗項目：${failed.map((step) => step.name).join('、')}\n`);
    process.exitCode = 1;
  }
  await client.close();
}

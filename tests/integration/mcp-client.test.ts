import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { composeRuntime } from '../../src/composition.js';
import { createMcpServer } from '../../src/server/create-server.js';
import type { FakeConnection } from './fake-connection.js';
import { createFakeConnection } from './fake-connection.js';

/**
 * callTool 的回傳是聯集型別，其中一支沒有 structuredContent，而有的那支型別是 {}。
 * 這裡統一收斂成可索引的形狀，斷言才寫得下去。
 */
function structured(result: unknown): Record<string, unknown> {
  const value = (result as { structuredContent?: unknown }).structuredContent;
  return (value ?? {}) as Record<string, unknown>;
}

const CONFIG = {
  host: '127.0.0.1',
  port: 19131,
  fallbackToRandomPort: true,
  commandTimeoutMs: 1000,
  keepaliveIntervalMs: 30_000,
  eventBufferSize: 100,
  maxBuildBlocks: 200_000,
  stepDelayMs: 0,
  debugFrames: false,
  negotiateEncryption: false,
};

async function connect(fake: FakeConnection): Promise<Client> {
  const runtime = composeRuntime('0.1.0-test', CONFIG, fake);
  const server = createMcpServer({
    service: runtime.service,
    build: runtime.build,
    version: '0.1.0-test',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'minecraft-edu-test', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe('MCP 工具面', () => {
  let fake: FakeConnection;
  let client: Client;

  beforeEach(async () => {
    fake = createFakeConnection();
    client = await connect(fake);
  });

  it('註冊了完整的工具面', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      'mc_agent_act',
      'mc_agent_collect',
      'mc_agent_create',
      'mc_agent_inventory',
      'mc_agent_move',
      'mc_agent_place',
      'mc_agent_program',
      'mc_agent_sense',
      'mc_agent_teleport',
      'mc_agent_turn',
      'mc_analyze_symmetry',
      'mc_await_connection',
      'mc_blueprint_preview',
      'mc_build_blueprint',
      'mc_build_preview',
      'mc_build_shape',
      'mc_clone',
      'mc_compare_regions',
      'mc_effect',
      'mc_events_catalog',
      'mc_events_poll',
      'mc_events_subscribe',
      'mc_events_unsubscribe',
      'mc_feedback',
      'mc_fill',
      'mc_gamemode',
      'mc_give',
      'mc_message',
      'mc_player_action',
      'mc_query_target',
      'mc_read_block',
      'mc_run_command',
      'mc_run_commands',
      'mc_set_block',
      'mc_status',
      'mc_structure',
      'mc_summon',
      'mc_teleport',
      'mc_test_block',
      'mc_ticking_area',
      'mc_verify_reading',
      'mc_world_settings',
    ]);
    expect(names).toHaveLength(42);
  });

  it('mc_status 回報連線資訊', async () => {
    const result = await client.callTool({ name: 'mc_status', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(structured(result)['connected']).toBe(true);
    expect(structured(result)['connectCommand']).toBe('/connect 127.0.0.1:19131');
  });

  it('未連線時 mc_status 給出可照做的指示', async () => {
    fake.setConnected(false);
    const result = await client.callTool({ name: 'mc_status', arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('/connect 127.0.0.1:19131');
    expect(text).toContain('作弊');
  });

  it('mc_set_block 送出正確指令', async () => {
    await client.callTool({
      name: 'mc_set_block',
      arguments: { position: { x: 1, y: 64, z: 2 }, block: 'stone' },
    });
    expect(fake.issued).toContain('setblock 1 64 2 stone');
  });

  it('mc_agent_program 依序展開並送出', async () => {
    const result = await client.callTool({
      name: 'mc_agent_program',
      arguments: {
        steps: [
          { action: 'move', direction: 'forward', steps: 2 },
          { action: 'place', slot: 1, direction: 'down' },
        ],
      },
    });
    expect(result.isError).toBeFalsy();
    expect(fake.issued).toEqual([
      'agent move forward',
      'agent move forward',
      'agent place 1 down',
    ]);
    expect(structured(result)['succeeded']).toBe(3);
  });

  it('mc_build_preview 不會送出任何指令', async () => {
    const result = await client.callTool({
      name: 'mc_build_preview',
      arguments: {
        shape: { kind: 'sphere', center: { x: 0, y: 70, z: 0 }, radius: 5, hollow: true },
        block: 'glass',
      },
    });
    expect(result.isError).toBeFalsy();
    expect(fake.issued).toHaveLength(0);
    expect(structured(result)['blockCount']).toBeGreaterThan(0);
    expect(structured(result)['fillBatches']).toBeGreaterThan(0);
  });

  /**
   * 新形狀最典型的失效方式不是幾何算錯，而是「domain 加了、schema 沒接上」或
   * 「schema 的預設值填不進去」——兩者都只在真正走一次工具面時才會現形。
   * 這裡刻意只給必填參數，讓 zod 的 default 去補其餘欄位。
   */
  it.each([
    ['tube', { kind: 'tube', from: { x: 0, y: 70, z: 0 }, to: { x: 8, y: 76, z: 8 }, radius: 2 }],
    ['wedge', { kind: 'wedge', from: { x: 0, y: 70, z: 0 }, to: { x: 6, y: 76, z: 4 } }],
    ['arch', { kind: 'arch', center: { x: 0, y: 70, z: 0 }, radius: 4 }],
    ['stairs', { kind: 'stairs', from: { x: 0, y: 70, z: 0 }, direction: 'x+', steps: 6 }],
    ['prism', { kind: 'prism', center: { x: 0, y: 70, z: 0 }, radius: 5, height: 8 }],
    [
      'polywall',
      {
        kind: 'polywall',
        points: [
          { x: 0, y: 70, z: 0 },
          { x: 12, y: 70, z: 0 },
          { x: 12, y: 70, z: 12 },
        ],
        height: 4,
      },
    ],
    [
      'ribbon',
      {
        kind: 'ribbon',
        points: [
          { x: 0, y: 70, z: 0 },
          { x: 12, y: 70, z: 6 },
        ],
      },
    ],
    [
      'heightfield',
      { kind: 'heightfield', from: { x: 0, y: 70, z: 0 }, to: { x: 15, y: 70, z: 15 } },
    ],
    [
      'spiralStairs',
      { kind: 'spiralStairs', center: { x: 0, y: 70, z: 0 }, radius: 4, height: 10, turns: 2 },
    ],
    ['cross', { kind: 'cross', center: { x: 0, y: 70, z: 0 }, radius: 5, height: 6 }],
    [
      'star',
      { kind: 'star', center: { x: 0, y: 70, z: 0 }, outerRadius: 8, innerRadius: 3 },
    ],
    [
      'roof',
      { kind: 'roof', from: { x: 0, y: 70, z: 0 }, to: { x: 10, y: 70, z: 8 }, height: 5 },
    ],
    [
      'cone 錐台',
      { kind: 'cone', center: { x: 0, y: 70, z: 0 }, radius: 8, height: 8, topRadius: 4 },
    ],
  ])('mc_build_preview 接得住 %s，缺的參數由預設值補齊', async (_kind, shape) => {
    const result = await client.callTool({
      name: 'mc_build_preview',
      arguments: { shape, block: 'stone' },
    });
    expect(result.isError).toBeFalsy();
    expect(structured(result)['blockCount']).toBeGreaterThan(0);
    expect(fake.issued).toHaveLength(0);
  });

  it('mc_build_shape 把球面合併成遠少於方塊數的指令', async () => {
    const result = await client.callTool({
      name: 'mc_build_shape',
      arguments: {
        shape: { kind: 'sphere', center: { x: 0, y: 70, z: 0 }, radius: 8, hollow: false },
        block: 'stone',
      },
    });
    expect(result.isError).toBeFalsy();
    const plan = structured(result)['plan'] as { blockCount: number; fillBatches: number };
    expect(plan.blockCount).toBeGreaterThan(2000);
    expect(plan.fillBatches).toBeLessThan(plan.blockCount / 10);
    expect(fake.issued).toHaveLength(plan.fillBatches);
    expect(fake.issued.every((command) => command.startsWith('fill ') || command.startsWith('setblock '))).toBe(true);
  });

  it('mc_build_blueprint 依方塊種類分組合併', async () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, index) => ({
        position: { x: index, y: 64, z: 0 },
        block: 'stone',
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        position: { x: index, y: 65, z: 0 },
        block: 'glass',
      })),
    ];
    const result = await client.callTool({
      name: 'mc_build_blueprint',
      arguments: { entries },
    });
    expect(result.isError).toBeFalsy();
    expect(fake.issued).toEqual(['fill 0 64 0 4 64 0 stone', 'fill 0 65 0 4 65 0 glass']);
  });

  it('超過單次上限的建造會被擋下且不動工', async () => {
    const runtime = composeRuntime('0.1.0-test', { ...CONFIG, maxBuildBlocks: 10 }, fake);
    const server = createMcpServer({ service: runtime.service, build: runtime.build, version: '0.1.0-test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const limited = new Client({ name: 'limited', version: '1.0.0' });
    await Promise.all([limited.connect(clientTransport), server.connect(serverTransport)]);

    const result = await limited.callTool({
      name: 'mc_build_shape',
      arguments: {
        shape: { kind: 'box', from: { x: 0, y: 0, z: 0 }, to: { x: 20, y: 20, z: 20 }, hollow: false },
        block: 'stone',
      },
    });
    expect(result.isError).toBe(true);
    expect(fake.issued).toHaveLength(0);
  });

  it('mc_run_command 拒絕會切斷橋接的指令且不送出', async () => {
    const result = await client.callTool({
      name: 'mc_run_command',
      arguments: { command: '/connect 10.0.0.1:1234' },
    });
    expect(result.isError).toBe(true);
    expect(fake.issued).toHaveLength(0);
  });

  it('mc_run_command 拒絕換行串接', async () => {
    const result = await client.callTool({
      name: 'mc_run_command',
      arguments: { command: 'say hi\nkill @a' },
    });
    expect(result.isError).toBe(true);
    expect(fake.issued).toHaveLength(0);
  });

  it('mc_query_target 解析出位置 JSON', async () => {
    const result = await client.callTool({
      name: 'mc_query_target',
      arguments: { target: '@s' },
    });
    expect(structured(result)['details']).toEqual([
      { position: { x: 10, y: 64, z: -5 } },
    ]);
  });

  it('遊戲回報失敗時工具如實反映', async () => {
    fake.failNext('Cheats are not enabled');
    const result = await client.callTool({
      name: 'mc_set_block',
      arguments: { position: { x: 0, y: 64, z: 0 }, block: 'stone' },
    });
    expect(structured(result)['ok']).toBe(false);
    expect(structured(result)['statusMessage']).toBe('Cheats are not enabled');
  });

  it('事件訂閱與輪詢可連續讀取', async () => {
    await client.callTool({ name: 'mc_events_subscribe', arguments: { eventName: 'PlayerMessage' } });
    fake.pushEvent('PlayerMessage', { Message: '哈囉', Sender: 'GJLMoTea' });
    fake.pushEvent('BlockPlaced', { Block: 'stone' });

    const first = await client.callTool({
      name: 'mc_events_poll',
      arguments: { afterCursor: 0, limit: 1 },
    });
    const events = structured(first)['events'] as { eventName: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]?.eventName).toBe('PlayerMessage');

    const second = await client.callTool({
      name: 'mc_events_poll',
      arguments: { afterCursor: structured(first)['nextCursor'] as number, limit: 10 },
    });
    const rest = structured(second)['events'] as { eventName: string }[];
    expect(rest).toHaveLength(1);
    expect(rest[0]?.eventName).toBe('BlockPlaced');
  });

  it('未連線時工具回錯誤而不是靜默失敗', async () => {
    fake.setConnected(false);
    const result = await client.callTool({
      name: 'mc_set_block',
      arguments: { position: { x: 0, y: 64, z: 0 }, block: 'stone' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('/connect');
  });

  it('公開連線與能力兩份 resource', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual([
      'minecraft-edu://capabilities',
      'minecraft-edu://connection',
    ]);
  });
});

/**
 * 協定漂移的偵測是「按需呼叫」而不是例行檢查——設計上刻意如此，因為例行
 * 檢查會養成看到綠燈就放心的習慣。代價是它完全依賴 AI 在行為可疑時**自己
 * 找到** mc_verify_reading，而唯一的線索就在 server instructions 裡。
 *
 * 所以那行字是這個設計的單點依賴：有人整理 instructions 順手刪掉，整套偵測
 * 就靜靜失效，而且沒有任何測試會紅。這條測試就是守它的。
 */
describe('協定漂移的可發現性', () => {
  it('server instructions 要指向 mc_verify_reading，否則 AI 出事時找不到它', async () => {
    const fake = createFakeConnection();
    const client = await connect(fake);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('mc_verify_reading');
  });

  it('instructions 要明講「不要當成那裡是空的」，這是最容易犯的誤判', async () => {
    const fake = createFakeConnection();
    const client = await connect(fake);
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('空的');
  });
});

/**
 * mc_structure 的 saveMode 語意：memory 是「這次協作的暫存」，disk 是「使用者
 * 明確說要保留」。預設必須是 memory——使用者只說「存一下」卻在他的世界資料夾
 * 留下檔案，是那種當下沒人察覺、事後才變成問題的事。
 */
describe('mc_structure 儲存語意', () => {
  let fake: FakeConnection;
  let client: Client;

  beforeEach(async () => {
    fake = createFakeConnection();
    client = await connect(fake);
  });

  it('沒指定 saveMode 時走 memory，不在硬碟留檔', async () => {
    const result = await client.callTool({
      name: 'mc_structure',
      arguments: { action: 'save', name: 'castle_v1', from: { x: 0, y: 64, z: 0 }, to: { x: 4, y: 68, z: 4 } },
    });
    expect(structured(result)['commandLine']).toContain('memory');
  });

  it('寫入硬碟時一定要在回覆裡講出來，不能靜悄悄', async () => {
    const result = await client.callTool({
      name: 'mc_structure',
      arguments: {
        action: 'save',
        name: 'castle_final',
        from: { x: 0, y: 64, z: 0 },
        to: { x: 4, y: 68, z: 4 },
        saveMode: 'disk',
      },
    });
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('世界資料夾');
  });

  it('存過的名字會記進 mc_status——遊戲沒有列出結構的指令，這是唯一的辦法', async () => {
    await client.callTool({
      name: 'mc_structure',
      arguments: { action: 'save', name: 'castle_v1', from: { x: 0, y: 64, z: 0 }, to: { x: 4, y: 68, z: 4 } },
    });
    await client.callTool({
      name: 'mc_structure',
      arguments: {
        action: 'save',
        name: 'castle_v2',
        from: { x: 0, y: 64, z: 0 },
        to: { x: 4, y: 68, z: 4 },
        saveMode: 'disk',
      },
    });
    const status = await client.callTool({ name: 'mc_status', arguments: {} });
    const saved = structured(status)['savedStructures'] as { name: string; saveMode: string }[];
    expect(saved.map((entry) => entry.name)).toEqual(['castle_v1', 'castle_v2']);
    expect(saved[1]?.saveMode).toBe('disk');
  });

  it('load 不會被記成存過的版本', async () => {
    await client.callTool({
      name: 'mc_structure',
      arguments: { action: 'load', name: 'castle_v1', destination: { x: 20, y: 64, z: 20 } },
    });
    const status = await client.callTool({ name: 'mc_status', arguments: {} });
    expect(structured(status)['savedStructures']).toEqual([]);
  });
});

/**
 * 直接測 WebSocket adapter：起一個真的監聽，再用真的 ws client 假裝自己是遊戲。
 * 這樣可以在不開 Minecraft 的情況下驗證協定處理，包含 requestId 對應、
 * 事件緩衝，以及「回應的 requestId 對不上」時的歸屬行為。
 */

import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { createWsMinecraftConnection } from '../../src/adapters/ws-minecraft-connection.js';
import type { MinecraftConnection } from '../../src/ports/minecraft-connection.js';

const ZERO_REQUEST_ID = '00000000-0000-0000-0000-000000000000';

let active: MinecraftConnection | null = null;
let client: WebSocket | null = null;

interface Harness {
  readonly connection: MinecraftConnection;
  readonly socket: WebSocket;
  /** 設定遊戲端要如何回應下一批 commandRequest。 */
  respond(handler: (commandLine: string, requestId: string, socket: WebSocket) => void): void;
}

async function startHarness(): Promise<Harness> {
  const connection = createWsMinecraftConnection({
    host: '127.0.0.1',
    port: 0,
    fallbackToRandomPort: false,
    commandTimeoutMs: 1500,
    eventBufferSize: 50,
    debugFrames: false,
    negotiateEncryption: false,
  });
  active = connection;
  await connection.start();

  const port = connection.status().port;
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}`);
  client = socket;
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve();
    });
    socket.once('error', reject);
  });
  await connection.awaitConnection(2000);

  let handler: ((commandLine: string, requestId: string, socket: WebSocket) => void) | null = null;
  socket.on('message', (data: Buffer) => {
    const frame = JSON.parse(data.toString()) as {
      header: { requestId: string; messagePurpose: string };
      body: { commandLine?: string };
    };
    if (frame.header.messagePurpose !== 'commandRequest') return;
    handler?.(frame.body.commandLine ?? '', frame.header.requestId, socket);
  });

  return {
    connection,
    socket,
    respond(next) {
      handler = next;
    },
  };
}

afterEach(async () => {
  client?.close();
  client = null;
  await active?.close();
  active = null;
});

describe('ws adapter', () => {
  it('連線後回報 connected 與正確的 /connect 指令', async () => {
    const harness = await startHarness();
    const status = harness.connection.status();
    expect(status.connected).toBe(true);
    expect(status.connectCommand).toBe(`/connect 127.0.0.1:${String(status.port)}`);
  });

  it('優先埠已占用時自動取得空閒埠並回報實際 /connect 指令', async () => {
    const reservation = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      reservation.once('listening', resolve);
      reservation.once('error', reject);
    });
    const address = reservation.address();
    if (address === null || typeof address === 'string') throw new Error('測試無法取得保留埠。');

    const connection = createWsMinecraftConnection({
      host: '127.0.0.1',
      port: address.port,
      fallbackToRandomPort: true,
      commandTimeoutMs: 500,
      eventBufferSize: 10,
      debugFrames: false,
      negotiateEncryption: false,
    });
    active = connection;

    try {
      await connection.start();
      const status = connection.status();
      expect(status.listening).toBe(true);
      expect(status.port).not.toBe(address.port);
      expect(status.connectCommand).toBe(`/connect 127.0.0.1:${String(status.port)}`);

      const game = new WebSocket(`ws://127.0.0.1:${String(status.port)}`);
      client = game;
      await new Promise<void>((resolve, reject) => {
        game.once('open', resolve);
        game.once('error', reject);
      });
      await expect(connection.awaitConnection(2000)).resolves.toMatchObject({ connected: true });
    } finally {
      client?.terminate();
      client = null;
      await connection.close().catch(() => undefined);
      active = null;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
    }
  });

  it('遊戲重連後關閉會終止所有 client 並立即釋放監聽埠', async () => {
    const harness = await startHarness();
    const original = harness.socket;
    const port = harness.connection.status().port;
    let replacement: WebSocket | null = null;
    let probe: MinecraftConnection | null = null;

    try {
      replacement = new WebSocket(`ws://127.0.0.1:${String(port)}`);
      client = replacement;
      await new Promise<void>((resolve, reject) => {
        replacement?.once('open', resolve);
        replacement?.once('error', reject);
      });

      await harness.connection.close();
      active = null;

      probe = createWsMinecraftConnection({
        host: '127.0.0.1',
        port,
        fallbackToRandomPort: false,
        commandTimeoutMs: 500,
        eventBufferSize: 10,
        debugFrames: false,
        negotiateEncryption: false,
      });
      await probe.start();
      expect(probe.status().listening).toBe(true);
    } finally {
      original.terminate();
      replacement?.terminate();
      client = null;
      await probe?.close();
      await harness.connection.close().catch(() => undefined);
      active = null;
    }
  });

  it('關閉橋接會立即結束尚在等待的連線請求', async () => {
    const connection = createWsMinecraftConnection({
      host: '127.0.0.1',
      port: 0,
      fallbackToRandomPort: false,
      commandTimeoutMs: 500,
      eventBufferSize: 10,
      debugFrames: false,
      negotiateEncryption: false,
    });
    active = connection;
    await connection.start();

    const waiting = connection.awaitConnection(120_000);
    await connection.close();
    active = null;

    await expect(waiting).resolves.toMatchObject({ listening: false, connected: false });
  });

  it('以 requestId 正確對應回應', async () => {
    const harness = await startHarness();
    harness.respond((commandLine, requestId, socket) => {
      socket.send(
        JSON.stringify({
          header: { version: 1, requestId, messagePurpose: 'commandResponse' },
          body: { statusCode: 0, statusMessage: `ran ${commandLine}` },
        }),
      );
    });

    const outcome = await harness.connection.runCommand('say hi');
    expect(outcome.ok).toBe(true);
    expect(outcome.statusMessage).toBe('ran say hi');
    expect(outcome.commandLine).toBe('say hi');
  });

  it('負的 statusCode 視為失敗', async () => {
    const harness = await startHarness();
    harness.respond((_commandLine, requestId, socket) => {
      socket.send(
        JSON.stringify({
          header: { version: 1, requestId, messagePurpose: 'commandResponse' },
          body: { statusCode: -2_147_483_648, statusMessage: 'Cheats are not enabled' },
        }),
      );
    });

    const outcome = await harness.connection.runCommand('setblock 0 64 0 stone');
    expect(outcome.ok).toBe(false);
    expect(outcome.statusMessage).toBe('Cheats are not enabled');
  });

  it('requestId 全為零時仍歸給唯一待決請求，而不是靜默逾時', async () => {
    const harness = await startHarness();
    harness.respond((_commandLine, _requestId, socket) => {
      socket.send(
        JSON.stringify({
          header: { version: 1, requestId: ZERO_REQUEST_ID, messagePurpose: 'error' },
          body: { statusCode: -2_147_483_648, statusMessage: 'Selector could not be resolved' },
        }),
      );
    });

    const outcome = await harness.connection.runCommand('querytarget @s');
    expect(outcome.ok).toBe(false);
    expect(outcome.statusMessage).toBe('Selector could not be resolved');
    // 關鍵：這是真正的失敗原因，不是「等待遊戲回應超過…」的逾時訊息。
    expect(outcome.statusMessage).not.toMatch(/超過/);
  });

  it('遊戲完全不回應時，逾時訊息說清楚是逾時', async () => {
    const harness = await startHarness();
    harness.respond(() => {
      /* 故意不回。 */
    });

    const outcome = await harness.connection.runCommand('querytarget @s');
    expect(outcome.ok).toBe(false);
    expect(outcome.statusMessage).toMatch(/等待遊戲回應超過/);
  });

  it('把 querytarget 的殘餘欄位保留在 data', async () => {
    const harness = await startHarness();
    harness.respond((_commandLine, requestId, socket) => {
      socket.send(
        JSON.stringify({
          header: { version: 1, requestId, messagePurpose: 'commandResponse' },
          body: { statusCode: 0, details: '[{"position":{"x":1,"y":2,"z":3}}]' },
        }),
      );
    });

    const outcome = await harness.connection.runCommand('querytarget @p');
    expect(outcome.data).toEqual({ details: '[{"position":{"x":1,"y":2,"z":3}}]' });
  });

  it('事件進緩衝並可用游標連續讀取', async () => {
    const harness = await startHarness();
    await harness.connection.subscribe('PlayerMessage');

    for (const message of ['一', '二']) {
      harness.socket.send(
        JSON.stringify({
          header: { version: 1, requestId: ZERO_REQUEST_ID, messagePurpose: 'event' },
          body: { eventName: 'PlayerMessage', properties: { Message: message } },
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 120));

    const first = harness.connection.readEvents(0, 1, null);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.properties['Message']).toBe('一');

    const second = harness.connection.readEvents(first.nextCursor, 10, null);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.properties['Message']).toBe('二');

    expect(harness.connection.status().subscribedEvents).toEqual(['PlayerMessage']);
  });

  /**
   * 真機回歸：Minecraft Education 26.32 實際送出的事件把 eventName 放在
   * header，而 body 直接就是屬性、沒有 properties 包裝。照舊格式只讀
   * body.eventName 的話，每一個事件都會被靜默丟棄。
   */
  it('接受 Education 26.x 的事件格式：eventName 在 header、body 即屬性', async () => {
    const harness = await startHarness();
    harness.socket.send(
      JSON.stringify({
        body: { message: '[教師] BlockHand 已接上', receiver: '', sender: '教師', type: 'say' },
        header: { eventName: 'PlayerMessage', messagePurpose: 'event', version: 17_104_896 },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 120));

    const page = harness.connection.readEvents(0, 10, null);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.eventName).toBe('PlayerMessage');
    expect(page.events[0]?.properties['sender']).toBe('教師');
    expect(page.events[0]?.properties['type']).toBe('say');
  });

  it('仍相容舊格式：eventName 與 properties 都在 body', async () => {
    const harness = await startHarness();
    harness.socket.send(
      JSON.stringify({
        header: { version: 1, requestId: ZERO_REQUEST_ID, messagePurpose: 'event' },
        body: { eventName: 'BlockPlaced', properties: { Block: 'stone' } },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 120));

    const page = harness.connection.readEvents(0, 10, null);
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.eventName).toBe('BlockPlaced');
    expect(page.events[0]?.properties['Block']).toBe('stone');
  });

  it('可依事件名過濾', async () => {
    const harness = await startHarness();
    for (const eventName of ['PlayerMessage', 'BlockPlaced']) {
      harness.socket.send(
        JSON.stringify({
          header: { version: 1, requestId: ZERO_REQUEST_ID, messagePurpose: 'event' },
          body: { eventName, properties: {} },
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 120));

    const page = harness.connection.readEvents(0, 10, 'BlockPlaced');
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.eventName).toBe('BlockPlaced');
  });

  /**
   * 回歸：舊版心跳只認 WebSocket 的 `pong` frame，而 Minecraft Education 的
   * 客戶端根本不回 pong。結果是每條連線閒置滿兩個心跳週期後就被橋接自己
   * terminate 掉——症狀是「放著不動就斷線」，而且看起來像遊戲的錯。
   *
   * 這個 harness 的假遊戲刻意不回 pong（ws 預設會自動回，所以要覆寫掉），
   * 只回應 commandRequest。連線必須活過好幾個週期。
   */
  it('遊戲不回 pong frame 時，閒置連線不會被心跳誤殺', async () => {
    const connection = createWsMinecraftConnection({
      host: '127.0.0.1',
      port: 0,
      fallbackToRandomPort: false,
      commandTimeoutMs: 1000,
      keepaliveIntervalMs: 60,
      eventBufferSize: 10,
      debugFrames: false,
      negotiateEncryption: false,
    });
    active = connection;
    await connection.start();

    // autoPong: false 是這條測試的重點——ws 預設會自動回 pong，
    // 那樣就模擬不到 Education 的行為，測試會假通過。
    const game = new WebSocket(`ws://127.0.0.1:${String(connection.status().port)}`, {
      autoPong: false,
    });
    client = game;
    await new Promise<void>((resolve, reject) => {
      game.once('open', resolve);
      game.once('error', reject);
    });
    await connection.awaitConnection(2000);

    const keepalives: string[] = [];
    game.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as {
        header: { requestId: string; messagePurpose: string };
        body: { commandLine?: string };
      };
      if (frame.header.messagePurpose !== 'commandRequest') return;
      keepalives.push(frame.body.commandLine ?? '');
      game.send(
        JSON.stringify({
          header: { version: 1, requestId: frame.header.requestId, messagePurpose: 'commandResponse' },
          body: { statusCode: 0, statusMessage: 'ok' },
        }),
      );
    });

    // 舊實作在第二個週期就會 terminate；這裡放行六個週期。
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(connection.status().connected).toBe(true);
    expect(keepalives.length).toBeGreaterThan(0);
    // 保活探測必須是唯讀指令，不能改動世界。
    expect(new Set(keepalives)).toEqual(new Set(['time query daytime']));
    // 也不該灌水使用者可見的指令計數。
    expect(connection.status().commandsIssued).toBe(0);
  });

  it('保活探測沒有回應時仍會斷開，不會留下殭屍連線', async () => {
    const connection = createWsMinecraftConnection({
      host: '127.0.0.1',
      port: 0,
      fallbackToRandomPort: false,
      commandTimeoutMs: 1000,
      keepaliveIntervalMs: 60,
      eventBufferSize: 10,
      debugFrames: false,
      negotiateEncryption: false,
    });
    active = connection;
    await connection.start();

    // 完全裝死：不回 pong，也不回 commandResponse。
    const game = new WebSocket(`ws://127.0.0.1:${String(connection.status().port)}`, {
      autoPong: false,
    });
    client = game;
    await new Promise<void>((resolve, reject) => {
      game.once('open', resolve);
      game.once('error', reject);
    });
    await connection.awaitConnection(2000);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(connection.status().connected).toBe(false);
  });

  it('未連線時 runCommand 丟出帶連線指示的錯誤', async () => {
    const connection = createWsMinecraftConnection({
      host: '127.0.0.1',
      port: 0,
      fallbackToRandomPort: false,
      commandTimeoutMs: 500,
      eventBufferSize: 10,
      debugFrames: false,
      negotiateEncryption: false,
    });
    active = connection;
    await connection.start();

    await expect(connection.runCommand('say hi')).rejects.toThrow(/\/connect/);
  });
});

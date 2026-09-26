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

async function startHarness(commandTimeoutMs = 1500): Promise<Harness> {
  const connection = createWsMinecraftConnection({
    host: '127.0.0.1',
    port: 0,
    fallbackToRandomPort: false,
    commandTimeoutMs,
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
  it('stops a batch on an unknown timeout even when ordinary command errors may continue', async () => {
    const harness = await startHarness();
    const received: string[] = [];
    harness.respond(command => { received.push(command); });
    const result = await harness.connection.runSequence(['time query daytime', 'say must-not-send'],
      { stopOnError: false, delayMs: 0 });
    expect(result).toMatchObject({ ok: false, issued: 1 });
    expect(received).toEqual(['time query daytime']);
  });

  it('does not send the remainder of a batch into a replacement connection', async () => {
    const harness = await startHarness();
    const received: string[] = [];
    let opened!: () => void;
    const replacementReady = new Promise<void>(resolve => { opened = resolve; });
    harness.respond(() => {
      const replacement = new WebSocket(`ws://127.0.0.1:${harness.connection.status().port}`);
      client = replacement;
      replacement.once('open', opened);
      replacement.on('message', data => {
        const frame = JSON.parse(data.toString());
        received.push(frame.body.commandLine);
        replacement.send(JSON.stringify({ header: { messagePurpose: 'commandResponse', requestId: frame.header.requestId },
          body: { statusCode: 0 } }));
      });
    });
    const result = await harness.connection.runSequence(['time query daytime', 'say must-not-send'],
      { stopOnError: false, delayMs: 0 });
    await replacementReady;
    expect(result).toMatchObject({ ok: false, issued: 1 });
    expect(received).toEqual([]);
    harness.socket.terminate();
  });

  it('retires pending requests when a new game replaces the old connection', async () => {
    const harness = await startHarness();
    let issued!: () => void;
    const sent = new Promise<void>(resolve => { issued = resolve; });
    harness.respond(() => issued());
    const previous = harness.connection.runCommand('time query daytime');
    await sent;
    const replacement = new WebSocket(`ws://127.0.0.1:${harness.connection.status().port}`);
    client = replacement;
    replacement.on('message', () => replacement.send(JSON.stringify({
      header: { messagePurpose: 'error', requestId: ZERO_REQUEST_ID },
      body: { statusCode: -99, statusMessage: 'new connection rejected command' },
    })));
    await new Promise<void>((resolve, reject) => {
      replacement.once('open', resolve); replacement.once('error', reject);
    });
    const current = await harness.connection.runCommand('testforblock 0 20 0 air');
    expect(current.statusCode).toBe(-99);
    expect((await previous).statusMessage).toContain('取代');
    harness.socket.terminate();
  });

  it('does not attribute an ambiguous late response to the next command after a timeout', async () => {
    const harness = await startHarness();
    harness.respond(() => {});
    expect((await harness.connection.runCommand('time query daytime')).statusCode).toBeNull();
    expect(harness.connection.status()).toMatchObject({ connected: true, commandState: 'timed-out',
      lastCommandTimeoutAt: expect.any(String), lastCommandResponseAt: null });
    harness.respond((_command, requestId, socket) => {
      socket.send(JSON.stringify({ header: { messagePurpose: 'commandResponse', requestId: ZERO_REQUEST_ID },
        body: { statusCode: 0, statusMessage: 'late previous success' } }));
      socket.send(JSON.stringify({ header: { messagePurpose: 'error', requestId },
        body: { statusCode: -99, statusMessage: 'current command failed' } }));
    });
    const current = await harness.connection.runCommand('testforblock 0 20 0 air');
    expect(current.ok).toBe(false);
    expect(current.statusMessage).toBe('current command failed');
    expect(harness.connection.status()).toMatchObject({ commandState: 'responsive', lastCommandResponseAt: expect.any(String) });
  });

  /**
   * 一條指令逾時之後，即使中間已經有別的指令拿到正常 requestId 的成功回覆，
   * 遲到的零 ID 回覆**仍然**可能是那條逾時指令的。這時不能把它算給正在執行的
   * 指令：Undo 的「未知結果」保護就是靠這個不猜測撐起來的。
   */
  it('逾時後就算有新指令正常回覆，遲到的零 ID 回覆也不算給下一條',async()=>{
    const harness=await startHarness();
    harness.respond(()=>{});
    expect((await harness.connection.runCommand('time query daytime')).statusCode).toBeNull();

    harness.respond((_command,requestId,socket)=>socket.send(JSON.stringify({
      header:{messagePurpose:'commandResponse',requestId},
      body:{statusCode:0,statusMessage:'correlated success'}})));
    expect((await harness.connection.runCommand('time query daytime')).ok).toBe(true);

    // 現在送第三條，遊戲只回一個零 ID 的成功——那可能是第一條遲到的回覆。
    harness.respond((_command,_requestId,socket)=>socket.send(JSON.stringify({
      header:{messagePurpose:'commandResponse',requestId:ZERO_REQUEST_ID},
      body:{statusCode:0,statusMessage:'late first success'}})));
    const current=await harness.connection.runCommand('setblock 0 20 0 stone');
    expect(current.ok).toBe(false);
    expect(current.statusMessage).toMatch(/等待遊戲回應超過/);
  });

  /** 時間過去也不是證據：逾時很久之後才到的零 ID 回覆同樣不能歸屬。 */
  it('逾時很久之後才到的零 ID 回覆也不算給下一條',async()=>{
    const harness=await startHarness(200);
    harness.respond(()=>{});
    expect((await harness.connection.runCommand('time query daytime')).statusCode).toBeNull();
    await new Promise(resolve=>setTimeout(resolve,400));
    harness.respond((_command,_requestId,socket)=>socket.send(JSON.stringify({
      header:{messagePurpose:'commandResponse',requestId:ZERO_REQUEST_ID},
      body:{statusCode:0,statusMessage:'very late success'}})));
    const current=await harness.connection.runCommand('setblock 0 20 0 stone');
    expect(current.ok).toBe(false);
    expect(current.statusMessage).toMatch(/等待遊戲回應超過/);
  });

  /** 對得上 requestId 的回覆在逾時之後仍然正常運作，沒有被一起關掉。 */
  it('逾時之後對得上 requestId 的回覆仍然照常歸屬',async()=>{
    const harness=await startHarness(200);
    harness.respond(()=>{});
    expect((await harness.connection.runCommand('time query daytime')).statusCode).toBeNull();
    harness.respond((_command,requestId,socket)=>socket.send(JSON.stringify({
      header:{messagePurpose:'commandResponse',requestId},
      body:{statusCode:0,statusMessage:'still correlated'}})));
    const outcome=await harness.connection.runCommand('testforblock 0 20 0 air');
    expect(outcome).toMatchObject({ok:true,statusMessage:'still correlated'});
  });

  /**
   * MCP 的 request handler 是併發的（SDK 收到 tools/call 就直接 dispatch），
   * 而唯讀指令不經過 Undo 的互斥鎖，所以呼叫端平行丟兩個讀取工具就會有兩條
   * 指令同時在飛。那會讓 requestId 對不上的回覆無法歸屬（兩條都逾時），也讓
   * 同時對遊戲發出的請求數失控。指令必須排隊逐條送。
   */
  it('平行呼叫也逐條送出，requestId 對不上的回覆仍能歸屬',async()=>{
    const harness=await startHarness();
    let live=0,peak=0;
    harness.respond((_command,_requestId,socket)=>{
      live+=1;peak=Math.max(peak,live);
      setTimeout(()=>{
        live-=1;
        socket.send(JSON.stringify({header:{messagePurpose:'error',requestId:ZERO_REQUEST_ID},
          body:{statusCode:-2_147_352_576,statusMessage:'找不到方塊'}}));
      },20);
    });
    const outcomes=await Promise.all([
      harness.connection.runCommand('testforblock 0 20 0 air'),
      harness.connection.runCommand('testforblock 0 21 0 air'),
      harness.connection.runCommand('testforblock 0 22 0 air'),
    ]);
    expect(peak).toBe(1);
    expect(outcomes.map(o=>o.statusMessage)).toEqual(['找不到方塊','找不到方塊','找不到方塊']);
    expect(harness.connection.status()).toMatchObject({inFlightCommands:0,queuedCommands:0});
  });

  /**
   * 排隊不能變成「稍後偷偷施工」。呼叫端那邊早就放棄的指令若在幾分鐘後才被
   * 送進遊戲，就是一次沒人預期的世界修改。
   */
  it('排隊等太久的指令回報未送出，而且之後也不會送出',async()=>{
    // 逾時預算 400 ms，每條指令要 250 ms 才回：第三條輪到時已經等了 ~500 ms。
    const harness=await startHarness(400);
    const sent:string[]=[];
    harness.respond((command,requestId,socket)=>{
      sent.push(command);
      setTimeout(()=>socket.send(JSON.stringify({
        header:{messagePurpose:'commandResponse',requestId},
        body:{statusCode:0,statusMessage:`ran ${command}`}})),250);
    });
    const [first,second,third]=await Promise.all([
      harness.connection.runCommand('time query daytime'),
      harness.connection.runCommand('time query day'),
      harness.connection.runCommand('setblock 0 20 0 stone'),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third).toMatchObject({ok:false,statusCode:null});
    expect(third.statusMessage).toMatch(/沒有送出/);
    // 關鍵：跳過之後也不能在稍後偷偷送出去。
    await new Promise(resolve=>setTimeout(resolve,300));
    expect(sent).toEqual(['time query daytime','time query day']);
    expect(harness.connection.status()).toMatchObject({queuedCommands:0,commandsIssued:2});
  });

  it('排隊指令超過上限時明確拒絕，不無聲累積',async()=>{
    const harness=await startHarness();
    harness.respond(()=>{});
    const queued=Array.from({length:64},(_unused,index)=>
      harness.connection.runCommand(`testforblock 0 ${String(20+index)} 0 air`));
    await expect(harness.connection.runCommand('say overflow')).rejects.toThrow(/上限/);
    harness.socket.terminate();
    const settled=await Promise.all(queued);
    expect(settled.every(outcome=>!outcome.ok)).toBe(true);
    expect(harness.connection.status().queuedCommands).toBe(0);
  });

  /** 換線：排隊中的舊指令一條都不能流進新遊戲。 */
  it('換連線時排隊中的舊指令不會送到新遊戲',async()=>{
    const harness=await startHarness();
    const address=`ws://127.0.0.1:${String(harness.connection.status().port)}`;
    harness.respond(()=>{});
    const queued=[
      harness.connection.runCommand('time query daytime'),
      harness.connection.runCommand('setblock 0 20 0 stone'),
      harness.connection.runCommand('setblock 0 21 0 stone'),
    ];
    const replacement=new WebSocket(address);
    client=replacement;
    const receivedByReplacement:string[]=[];
    replacement.on('message',data=>{
      receivedByReplacement.push(JSON.parse(data.toString()).body.commandLine);
    });
    await new Promise<void>((resolve,reject)=>{
      replacement.once('open',resolve);replacement.once('error',reject);
    });
    const settled=await Promise.all(queued);
    expect(settled.every(outcome=>!outcome.ok)).toBe(true);
    expect(settled.slice(1).every(outcome=>outcome.statusMessage?.includes('連線已改變'))).toBe(true);
    expect(receivedByReplacement).toEqual([]);
    expect(harness.connection.status().queuedCommands).toBe(0);
    harness.socket.terminate();
  });

  /** 關閉：排隊中的指令必須立刻收斂，不能留下永遠不 settle 的 promise。 */
  it('關閉橋接會讓排隊中的指令立即收斂且不送出',async()=>{
    const harness=await startHarness();
    const sent:string[]=[];
    harness.respond(command=>{sent.push(command);});
    const queued=[
      harness.connection.runCommand('time query daytime'),
      harness.connection.runCommand('setblock 0 20 0 stone'),
    ];
    // 先確認第一條真的在飛，否則關閉時佇列還沒開始，測不到要測的東西。
    await new Promise(resolve=>setTimeout(resolve,50));
    expect(harness.connection.status()).toMatchObject({inFlightCommands:1,queuedCommands:1});
    await harness.connection.close();
    active=null;
    const settled=await Promise.all(queued);
    expect(settled.every(outcome=>!outcome.ok)).toBe(true);
    expect(sent).toEqual(['time query daytime']);
  });

  it('uses modern command version only when explicitly requested',async()=>{
    const harness=await startHarness();
    const versions:number[]=[];
    harness.socket.on('message',data=>{versions.push(JSON.parse(data.toString()).body.version);});
    harness.respond((_command,requestId,socket)=>socket.send(JSON.stringify({header:{messagePurpose:'commandResponse',requestId},body:{statusCode:0}})));
    await harness.connection.runCommand('execute in overworld run querytarget @s',{commandVersion:25});
    await harness.connection.runCommand('time query daytime');
    expect(versions).toEqual([25,1]);
  });
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

  /**
   * 回歸：遊戲切到背景會暫停（macOS 的 pause_menu_on_focus_lost 預設開啟），
   * 載入世界或單幀卡頓也一樣——那段時間它不處理指令，但 TCP 連線是好的。
   * 舊實作一次探測沒回就 terminate，玩家只是切個視窗回來就得重打 /connect。
   */
  it('遊戲短暫不處理指令（例如切到背景暫停）時不會被斷線', async () => {
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

    const game = new WebSocket(`ws://127.0.0.1:${String(connection.status().port)}`, {
      autoPong: false,
    });
    client = game;
    await new Promise<void>((resolve, reject) => {
      game.once('open', resolve);
      game.once('error', reject);
    });
    await connection.awaitConnection(2000);

    // 前兩次探測完全裝死（暫停中），第三次起恢復回覆。
    let probes = 0;
    game.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as {
        header: { requestId: string; messagePurpose: string };
      };
      if (frame.header.messagePurpose !== 'commandRequest') return;
      probes += 1;
      if (probes <= 2) return;
      game.send(
        JSON.stringify({
          header: { version: 1, requestId: frame.header.requestId, messagePurpose: 'commandResponse' },
          body: { statusCode: 0 },
        }),
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(probes).toBeGreaterThan(2);
    expect(connection.status().connected).toBe(true);
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

    // 要連續 KEEPALIVE_MISS_LIMIT 次探測都沒回才判死，所以等得比單一週期久。
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(connection.status().connected).toBe(false);
  });

  it('開啟 announceConnection 時，握手後在聊天列宣告已連上，且不算進玩家送出的指令數', async () => {
    const connection = createWsMinecraftConnection({
      host: '127.0.0.1',
      port: 0,
      fallbackToRandomPort: false,
      commandTimeoutMs: 1500,
      eventBufferSize: 50,
      debugFrames: false,
      negotiateEncryption: false,
      announceConnection: true,
    });
    active = connection;
    await connection.start();
    const port = connection.status().port;
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}`);
    client = socket;
    const notice = new Promise<string>((resolve) => {
      socket.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString()) as {
          header: { requestId: string; messagePurpose: string };
          body: { commandLine?: string };
        };
        if (frame.header.messagePurpose !== 'commandRequest') return;
        socket.send(JSON.stringify({
          header: { messagePurpose: 'commandResponse', requestId: frame.header.requestId },
          body: { statusCode: 0 },
        }));
        resolve(frame.body.commandLine ?? '');
      });
    });
    await connection.awaitConnection(2000);
    const commandLine = await notice;
    expect(commandLine.startsWith('tellraw @a ')).toBe(true);
    const text = (JSON.parse(commandLine.slice('tellraw @a '.length)) as { rawtext: Array<{ text: string }> })
      .rawtext.map((part) => part.text).join('');
    expect(text).toContain('已連上 Claude');
    expect(text).toContain(`127.0.0.1:${String(port)}`);
    expect(connection.status().commandsIssued).toBe(0);
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

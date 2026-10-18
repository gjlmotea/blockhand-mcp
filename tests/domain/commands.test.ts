import { describe, expect, it } from 'vitest';

import { agentCommands, chatCommands, playerCommands, worldCommands } from '../../src/domain/commands.js';
import { assessRawCommand } from '../../src/domain/command-policy.js';
import { MinecraftBridgeError } from '../../src/domain/contracts.js';
import { assertPlaceableCoordinate, formatCoordinate } from '../../src/domain/coordinates.js';

const ABS = { x: 10, y: 64, z: -5, mode: 'absolute' } as const;

describe('formatCoordinate', () => {
  it('絕對座標直接輸出數字', () => {
    expect(formatCoordinate(ABS)).toBe('10 64 -5');
  });

  it('相對座標用 ~ 且 0 省略數字', () => {
    expect(formatCoordinate({ x: 1, y: 0, z: -3, mode: 'relative' })).toBe('~1 ~ ~-3');
  });

  it('局部座標用 ^', () => {
    expect(formatCoordinate({ x: 0, y: 0, z: 2, mode: 'local' })).toBe('^ ^ ^2');
  });
});

describe('assertPlaceableCoordinate', () => {
  it('接受合法的絕對座標', () => {
    expect(() => assertPlaceableCoordinate(ABS, '測試')).not.toThrow();
  });

  it('擋下超出高度的座標', () => {
    expect(() =>
      assertPlaceableCoordinate({ x: 0, y: 5000, z: 0, mode: 'absolute' }, '測試'),
    ).toThrow(/outside the buildable range/);
  });

  it('不檢查相對座標的邊界', () => {
    expect(() =>
      assertPlaceableCoordinate({ x: 0, y: 5000, z: 0, mode: 'relative' }, '測試'),
    ).not.toThrow();
  });
});

describe('agentCommands', () => {
  it('組出正確的移動與轉向指令', () => {
    expect(agentCommands.move('forward')).toBe('agent move forward');
    expect(agentCommands.turn('left')).toBe('agent turn left');
  });

  it('組出放置與搬移指令', () => {
    expect(agentCommands.place(1, 'down')).toBe('agent place 1 down');
    expect(agentCommands.transfer(1, 32, 2)).toBe('agent transfer 1 32 2');
  });

  it('擋下超出範圍的槽位', () => {
    expect(() => agentCommands.place(0, 'forward')).toThrow(/from 1 to 27/);
    expect(() => agentCommands.place(28, 'forward')).toThrow(/from 1 to 27/);
  });

  it('擋下超出範圍的數量', () => {
    expect(() => agentCommands.drop(1, 65, 'forward')).toThrow(/from 1 to 64/);
  });
});

describe('worldCommands', () => {
  it('setblock 帶狀態與處理模式', () => {
    expect(worldCommands.setBlock(ABS, 'stone', '["stone_type":"granite"]', 'destroy')).toBe(
      'setblock 10 64 -5 stone ["stone_type":"granite"] destroy',
    );
  });

  it('setblock 省略選用參數', () => {
    expect(worldCommands.setBlock(ABS, 'stone', null, null)).toBe('setblock 10 64 -5 stone');
  });

  it('fill 在 replace 模式下才接受 replaceBlock', () => {
    expect(() =>
      worldCommands.fill(ABS, ABS, 'stone', null, 'hollow', 'air', null),
    ).toThrow(/replace/);
    expect(worldCommands.fill(ABS, ABS, 'stone', null, 'replace', 'air', null)).toBe(
      'fill 10 64 -5 10 64 -5 stone replace air',
    );
  });

  it('拒絕含空白的方塊名稱，避免拼出額外參數', () => {
    expect(() => worldCommands.setBlock(ABS, 'stone 1 2 3 kill @a', null, null)).toThrow(
      MinecraftBridgeError,
    );
  });

  it('拒絕格式錯誤的方塊狀態', () => {
    expect(() => worldCommands.setBlock(ABS, 'stone', 'stone_type=granite', null)).toThrow(
      /Block states/,
    );
  });
});

describe('playerCommands 與 chatCommands', () => {
  it('give 組出正確順序', () => {
    expect(playerCommands.give('@s', 'diamond', 5, null)).toBe('give @s diamond 5');
  });

  it('xp 以 L 後綴表示等級', () => {
    expect(playerCommands.experience('@s', 3, 'levels')).toBe('xp 3L @s');
    expect(playerCommands.experience('@s', 3, 'points')).toBe('xp 3 @s');
  });

  it('接受帶條件的選擇器', () => {
    expect(playerCommands.kill('@e[type=cow]')).toBe('kill @e[type=cow]');
  });

  it('拒絕非法選擇器', () => {
    expect(() => playerCommands.kill('@x')).toThrow(/selector/);
  });

  it('訊息不得含換行', () => {
    expect(() => chatCommands.say('hello\nkill @a')).toThrow(/newlines/);
  });
});

describe('assessRawCommand', () => {
  it('去掉前導斜線並標記風險', () => {
    expect(assessRawCommand('/time set day')).toMatchObject({
      commandLine: 'time set day',
      verb: 'time',
      risk: 'world-write',
    });
  });

  it('把唯讀指令標為 read-only', () => {
    expect(assessRawCommand('querytarget @s').risk).toBe('read-only');
  });

  it('把大範圍指令標為 wide-effect', () => {
    expect(assessRawCommand('fill 0 0 0 1 1 1 stone').risk).toBe('wide-effect');
  });

  it('拒絕會切斷橋接的指令', () => {
    expect(() => assessRawCommand('/connect evil.example.com:80')).toThrow(/cut or redirect/);
    expect(() => assessRawCommand('wsserver localhost:1234')).toThrow(/cut or redirect/);
    expect(() => assessRawCommand('/closewebsocket')).toThrow(/cut or redirect/);
  });

  it('包在 execute 裡的斷線指令也拒絕', () => {
    expect(() => assessRawCommand('execute @p ~ ~ ~ closewebsocket')).toThrow(/closewebsocket/);
    expect(() => assessRawCommand('execute as @a at @s run connect 127.0.0.1:1')).toThrow(/connect/);
    expect(() => assessRawCommand('execute @a ~ ~ ~ detect ~ ~-1 ~ stone 0 wsserver x')).toThrow(/wsserver/);
    expect(() => assessRawCommand('execute @a ~ ~ ~ execute @s ~ ~ ~ /closewebsocket')).toThrow(/closewebsocket/);
    // 玩家名稱叫 run、名稱帶空白：照參數位置找會漏掉的寫法
    expect(() => assessRawCommand('execute as run run closewebsocket')).toThrow(/closewebsocket/);
    expect(() => assessRawCommand('execute "Player One" ~ ~ ~ closewebsocket')).toThrow(/closewebsocket/);
  });

  it('不在 execute 裡、或包在引號與 JSON 裡的字不算', () => {
    expect(assessRawCommand('say connect').verb).toBe('say');
    expect(assessRawCommand('tellraw @a {"rawtext":[{"text":"closewebsocket"}]}').verb).toBe('tellraw');
    expect(assessRawCommand('execute as @a run tellraw @s {"rawtext":[{"text":"connect"}]}').verb).toBe('execute');
    expect(assessRawCommand('execute as "connect" run say hi').verb).toBe('execute');
  });

  it('寧可多擋：execute 裡單獨出現 connect 這個字就拒絕', () => {
    expect(() => assessRawCommand('execute @p ~ ~ ~ say connect')).toThrow(/connect/);
  });

  it('拒絕用換行串接多條指令', () => {
    expect(() => assessRawCommand('say hi\nkill @a')).toThrow(/single-line/);
  });

  it('拒絕空指令', () => {
    expect(() => assessRawCommand('   /  ')).toThrow(/must not be empty/);
  });
});

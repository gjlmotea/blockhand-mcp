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
    ).toThrow(/超出可建造範圍/);
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
    expect(() => agentCommands.place(0, 'forward')).toThrow(/1～27/);
    expect(() => agentCommands.place(28, 'forward')).toThrow(/1～27/);
  });

  it('擋下超出範圍的數量', () => {
    expect(() => agentCommands.drop(1, 65, 'forward')).toThrow(/1～64/);
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
      /方塊狀態/,
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
    expect(() => playerCommands.kill('@x')).toThrow(/選擇器/);
  });

  it('訊息不得含換行', () => {
    expect(() => chatCommands.say('hello\nkill @a')).toThrow(/換行/);
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
    expect(() => assessRawCommand('/connect evil.example.com:80')).toThrow(/切斷/);
    expect(() => assessRawCommand('wsserver localhost:1234')).toThrow(/切斷/);
  });

  it('拒絕用換行串接多條指令', () => {
    expect(() => assessRawCommand('say hi\nkill @a')).toThrow(/單行/);
  });

  it('拒絕空指令', () => {
    expect(() => assessRawCommand('   /  ')).toThrow(/不得為空/);
  });
});

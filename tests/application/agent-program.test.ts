import { describe, expect, it } from 'vitest';

import { expandAgentProgram, parseQueryTargetDetails } from '../../src/application/blockhand-service.js';

describe('expandAgentProgram', () => {
  it('把多步移動展開成逐格指令', () => {
    expect(expandAgentProgram([{ action: 'move', direction: 'forward', steps: 3 }])).toEqual([
      'agent move forward',
      'agent move forward',
      'agent move forward',
    ]);
  });

  it('轉向 times=2 等於轉身', () => {
    expect(expandAgentProgram([{ action: 'turn', direction: 'left', times: 2 }])).toEqual([
      'agent turn left',
      'agent turn left',
    ]);
  });

  it('collect 的 null 代表收集全部', () => {
    expect(expandAgentProgram([{ action: 'collect', item: null }])).toEqual(['agent collect all']);
    expect(expandAgentProgram([{ action: 'collect', item: 'dirt' }])).toEqual([
      'agent collect dirt',
    ]);
  });

  it('保留步驟順序', () => {
    const commands = expandAgentProgram([
      { action: 'move', direction: 'forward', steps: 1 },
      { action: 'place', slot: 1, direction: 'down' },
      { action: 'turn', direction: 'right', times: 1 },
    ]);
    expect(commands).toEqual([
      'agent move forward',
      'agent place 1 down',
      'agent turn right',
    ]);
  });

  it('鋪一條路：走一步放一塊，重複四次', () => {
    const steps = Array.from({ length: 4 }, () => [
      { action: 'move', direction: 'forward', steps: 1 } as const,
      { action: 'place', slot: 1, direction: 'down' } as const,
    ]).flat();
    expect(expandAgentProgram(steps)).toHaveLength(8);
  });

  it('空程式回空陣列', () => {
    expect(expandAgentProgram([])).toEqual([]);
  });
});

describe('parseQueryTargetDetails', () => {
  const base = {
    ok: true,
    commandLine: 'querytarget @s',
    statusCode: 0,
    statusMessage: null,
    elapsedMs: 1,
  };

  it('解析 details 內的 JSON 字串', () => {
    const parsed = parseQueryTargetDetails({
      ...base,
      data: { details: '[{"position":{"x":1,"y":2,"z":3}}]' },
    });
    expect(parsed).toEqual([{ position: { x: 1, y: 2, z: 3 } }]);
  });

  it('details 不是字串時回 null', () => {
    expect(parseQueryTargetDetails({ ...base, data: { details: 42 } })).toBeNull();
  });

  it('沒有 data 時回 null', () => {
    expect(parseQueryTargetDetails({ ...base, data: null })).toBeNull();
  });

  it('JSON 壞掉時回 null 而不是丟錯', () => {
    expect(parseQueryTargetDetails({ ...base, data: { details: '{not json' } })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import type { CommandOutcome } from '../../src/domain/contracts.js';
import { notInWorldHint, summarizeOutcome } from '../../src/server/tool-kit.js';

function failed(commandLine: string, statusMessage: string | null): CommandOutcome {
  return { ok: false, commandLine, statusCode: -2147483648, statusMessage, data: null, elapsedMs: 60 };
}

describe('notInWorldHint', () => {
  it('內建指令回「不明的指令」時提示遊戲可能不在世界裡', () => {
    const outcome = failed('time query daytime', '不明的指令：time。請確認該指令是否存在，以及您是否具備使用該指令的權限。');
    expect(notInWorldHint(outcome)).toContain('不在世界裡');
    expect(summarizeOutcome(outcome)).toContain('不在世界裡');
  });

  it('區域比對（testforblocks）也提示', () => {
    expect(notInWorldHint(failed('testforblocks 0 0 0 1 1 1 5 5 5', '不明的指令：testforblocks。請確認該指令是否存在，以及您是否具備使用該指令的權限。'))).toContain('不在世界裡');
  });

  it('英文語系也認得', () => {
    const outcome = failed('testfor @a', 'Unknown command: testfor. Please check that the command exists and that you have permission to use it.');
    expect(notInWorldHint(outcome)).toContain('testfor');
  });

  it('不是內建指令（打錯字、附加包自訂指令）就不提示', () => {
    expect(notInWorldHint(failed('tme set day', '不明的指令：tme。請確認該指令是否存在，以及您是否具備使用該指令的權限。'))).toBe('');
    expect(notInWorldHint(failed('gjl:debug', '不明的指令：gjl:debug。請確認該指令是否存在，以及您是否具備使用該指令的權限。'))).toBe('');
  });

  it('其他失敗與成功都不提示', () => {
    expect(notInWorldHint(failed('testfor @e[type=pig]', '無符合選擇器的目標'))).toBe('');
    expect(notInWorldHint(failed('time query daytime', null))).toBe('');
    expect(notInWorldHint({ ...failed('time query daytime', '白天時間為 1000'), ok: true })).toBe('');
  });
});

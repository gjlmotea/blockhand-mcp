import { describe, expect, it } from 'vitest';

import { probeReadingPath } from '../../src/application/reading-probe.js';

/**
 * 這支探測存在的唯一理由是「靜默失效」：解析壞掉時工具不會報錯，只會安靜地
 * 說讀不出來，而 AI 會把那當成「那裡是空的」繼續蓋東西。所以測試的重點是
 * **協定壞掉時 parseable 必須是 false**，不是探測跑得完。
 */

const POSITION = { x: 10, y: 64, z: 20 };

function fakeRunner(responses: readonly { ok: boolean; statusMessage: string | null }[]) {
  const issued: string[] = [];
  let index = 0;
  return {
    issued,
    async run(commandLine: string) {
      issued.push(commandLine);
      return responses[index++] ?? { ok: true, statusMessage: null };
    },
  };
}

describe('probeReadingPath：該格有方塊', () => {
  it('第一問就拿到失敗訊息，解析成功即判定路徑正常', async () => {
    const runner = fakeRunner([{ ok: false, statusMessage: '在 10,64,20 的方塊是 泥土 (預期：空氣)。' }]);
    const report = await probeReadingPath(runner, POSITION);
    expect(report.parseable).toBe(true);
    expect(report.parsedName).toBe('泥土');
    expect(report.branch).toBe('position-had-block');
    expect(report.commandsIssued).toBe(1);
  });

  it('訊息格式不認得時 parseable=false，並保留原始訊息當線索', async () => {
    const runner = fakeRunner([{ ok: false, statusMessage: 'ブロックは 土 です' }]);
    const report = await probeReadingPath(runner, POSITION);
    expect(report.parseable).toBe(false);
    expect(report.parsedName).toBeNull();
    expect(report.raw).toBe('ブロックは 土 です');
  });
});

describe('probeReadingPath：該格是空氣', () => {
  it('拿基岩去問逼出失敗訊息——不必事先知道那格是什麼', async () => {
    const runner = fakeRunner([
      { ok: true, statusMessage: '成功找到該方塊。' },
      { ok: false, statusMessage: '在 10,64,20 的方塊是 空氣 (預期：基岩)。' },
    ]);
    const report = await probeReadingPath(runner, POSITION);
    expect(report.parseable).toBe(true);
    expect(report.parsedName).toBe('空氣');
    expect(report.branch).toBe('position-was-air');
    expect(report.commandsIssued).toBe(2);
    expect(runner.issued[1]).toContain('bedrock');
  });

  it('對照測試的訊息解析不出來時 parseable=false', async () => {
    const runner = fakeRunner([
      { ok: true, statusMessage: null },
      { ok: false, statusMessage: '完全沒見過的格式' },
    ]);
    expect((await probeReadingPath(runner, POSITION)).parseable).toBe(false);
  });

  it('對照測試竟然「成功」代表與前一問矛盾，同樣判定協定異常', async () => {
    const runner = fakeRunner([
      { ok: true, statusMessage: null },
      { ok: true, statusMessage: '成功找到該方塊。' },
    ]);
    const report = await probeReadingPath(runner, POSITION);
    expect(report.parseable).toBe(false);
  });
});

describe('probeReadingPath：不寫入世界', () => {
  it('只送 testforblock，不含任何寫入指令', async () => {
    const runner = fakeRunner([
      { ok: true, statusMessage: null },
      { ok: false, statusMessage: '在 10,64,20 的方塊是 空氣 (預期：基岩)。' },
    ]);
    await probeReadingPath(runner, POSITION);
    for (const command of runner.issued) {
      expect(command.startsWith('testforblock ')).toBe(true);
    }
  });
});

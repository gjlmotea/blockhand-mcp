import { describe, expect, it } from 'vitest';

import { analyzeSymmetry } from '../../src/application/symmetry-service.js';
import { MinecraftBridgeError } from '../../src/domain/contracts.js';

/**
 * 這個工具會**寫入世界**，所以測試重點不是分數算得對（那在 domain 層測過），
 * 而是三件安全性質：
 *   1. 暫存區疊到分析區時，在送出任何指令之前就拒絕。
 *   2. 備份失敗時中止，且**沒有**放置鏡像副本——世界必須毫髮無傷。
 *   3. 不論成敗都會還原暫存區，並據實回報還原結果。
 */

const v = (x: number, y: number, z: number) => ({ x, y, z });

interface Script {
  readonly match: RegExp;
  readonly ok: boolean;
  readonly statusMessage?: string;
}

function fakeRunner(scripts: readonly Script[]) {
  const issued: string[] = [];
  return {
    issued,
    async run(commandLine: string) {
      issued.push(commandLine);
      const script = scripts.find((entry) => entry.match.test(commandLine));
      return { ok: script?.ok ?? true, statusMessage: script?.statusMessage ?? null };
    },
  };
}

const baseRequest = {
  from: v(0, 64, 0),
  to: v(7, 71, 7),
  mirror: 'x' as const,
  scratch: v(100, 64, 100),
  cellsPerAxis: 2,
};

describe('analyzeSymmetry：安全邊界', () => {
  it('暫存區與分析區重疊時拒絕，且一條指令都不送', async () => {
    const runner = fakeRunner([]);
    await expect(
      analyzeSymmetry(runner, { ...baseRequest, scratch: v(4, 64, 4) }),
    ).rejects.toThrow(MinecraftBridgeError);
    expect(runner.issued).toHaveLength(0);
  });

  it('備份暫存區失敗時中止，且絕不放置鏡像副本', async () => {
    const runner = fakeRunner([{ match: /structure save blockhand_sym_bak/u, ok: false, statusMessage: '區塊未載入' }]);
    await expect(analyzeSymmetry(runner, baseRequest)).rejects.toThrow(/無法備份/u);
    expect(runner.issued.some((command) => command.startsWith('structure load'))).toBe(false);
  });

  it('保存分析區失敗時中止，連備份都不做', async () => {
    const runner = fakeRunner([{ match: /structure save blockhand_sym_src/u, ok: false }]);
    await expect(analyzeSymmetry(runner, baseRequest)).rejects.toThrow(/無法保存分析區/u);
    expect(runner.issued.some((command) => /blockhand_sym_bak/u.test(command))).toBe(false);
  });

  it('比對途中出錯仍會還原暫存區並清掉暫存結構', async () => {
    const runner = fakeRunner([{ match: /^testforblocks/u, ok: false, statusMessage: 'boom' }]);
    const report = await analyzeSymmetry(runner, baseRequest);
    expect(report.symmetric).toBe(false);
    expect(runner.issued.filter((command) => /structure load blockhand_sym_bak/u.test(command))).toHaveLength(1);
    expect(runner.issued.filter((command) => /structure delete/u.test(command))).toHaveLength(2);
  });

  it('還原失敗時據實回報 scratchRestored=false，不粉飾', async () => {
    const runner = fakeRunner([{ match: /structure load blockhand_sym_bak/u, ok: false }]);
    const report = await analyzeSymmetry(runner, baseRequest);
    expect(report.scratchRestored).toBe(false);
  });

  it('還原成功時回報 true', async () => {
    const runner = fakeRunner([]);
    const report = await analyzeSymmetry(runner, baseRequest);
    expect(report.scratchRestored).toBe(true);
  });
});

describe('analyzeSymmetry：比對行為', () => {
  it('整體就對稱時不再細分，省下指令', async () => {
    const runner = fakeRunner([]);
    const report = await analyzeSymmetry(runner, baseRequest);
    expect(report.symmetric).toBe(true);
    expect(report.score).toBe(100);
    expect(report.totalCells).toBe(1);
    expect(runner.issued.filter((command) => /^testforblocks/u.test(command))).toHaveLength(1);
  });

  it('整體不對稱時細分，並指出哪幾塊不對稱', async () => {
    let comparisons = 0;
    const runner = {
      issued: [] as string[],
      async run(commandLine: string) {
        runner.issued.push(commandLine);
        if (!commandLine.startsWith('testforblocks')) return { ok: true, statusMessage: null };
        comparisons += 1;
        // 第一次是整體比對（失敗），之後 8 格中讓最後一格不符。
        if (comparisons === 1) return { ok: false, statusMessage: '不一致' };
        return { ok: comparisons !== 9, statusMessage: null };
      },
    };
    const report = await analyzeSymmetry(runner, baseRequest);
    expect(report.symmetric).toBe(false);
    expect(report.totalCells).toBe(8);
    expect(report.matchedCells).toBe(7);
    expect(report.score).toBe(88);
    expect(report.asymmetricCells).toHaveLength(1);
  });

  it('鏡像軸會傳進 structure load 的參數，且補上 rotation', async () => {
    const runner = fakeRunner([]);
    await analyzeSymmetry(runner, { ...baseRequest, mirror: 'xz' });
    const load = runner.issued.find((command) => /structure load blockhand_sym_src/u.test(command));
    expect(load).toContain('0_degrees');
    expect(load).toMatch(/xz$/u);
  });

  it('回報的指令數含清理，因為那本來就是真實成本', async () => {
    const runner = fakeRunner([]);
    const report = await analyzeSymmetry(runner, baseRequest);
    expect(report.commandsIssued).toBe(runner.issued.length);
    // save×2、load 鏡像、testforblocks、還原、delete×2
    expect(report.commandsIssued).toBe(7);
  });

  it('超過 structure 指令上限的區域直接拒絕', async () => {
    const runner = fakeRunner([]);
    await expect(
      analyzeSymmetry(runner, { ...baseRequest, to: v(200, 71, 7) }),
    ).rejects.toThrow(/structure 指令上限/u);
    expect(runner.issued).toHaveLength(0);
  });
});

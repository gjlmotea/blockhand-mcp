import type { Vec3 } from '../domain/contracts.js';
import { worldCommands } from '../domain/commands.js';
import { SENTINEL_BLOCK, readBlockFromOutcome } from '../domain/block-report.js';

/**
 * 驗證「讀方塊」這條路還活著。
 *
 * 讀方塊靠的是 `testforblock` **失敗訊息**會洩漏實際方塊名稱。那個訊息格式
 * 沒有任何官方穩定性保證：遊戲改版改文案、或玩家把遊戲語言換成日文，解析就
 * 會失效。而失效的樣子是**安靜的**——工具不會壞掉，只會開始說「讀不出來」。
 *
 * 這支探測的巧妙處在於**不需要事先知道那格是什麼**：
 *
 *   - 先問「這格是空氣嗎」。
 *   - 若答是 → 那格是空氣 → 再問「這格是基岩嗎」。空氣不可能是基岩，所以
 *     這一問**保證失敗**，於是我們拿到一則失敗訊息可以驗解析。
 *   - 若答否 → 第一問就已經給了失敗訊息，直接驗它。
 *
 * 兩條路都保證能拿到訊息，最多兩條指令，完全不寫入世界。
 */

/** 用來製造「保證失敗」的對照方塊。空氣永遠不會是基岩。 */
const CONTRAST_BLOCK = 'bedrock';

export interface ReadingProbeReport {
  /** 解析路徑是否仍然有效。false 代表協定已漂移，讀方塊的結果不可信。 */
  readonly parseable: boolean;
  /** 解析出來的方塊名稱（在地化顯示名）。 */
  readonly parsedName: string | null;
  /** 遊戲回的原始訊息，解析失敗時這是唯一的線索。 */
  readonly raw: string | null;
  /** 探測走的是哪一條分支，方便判讀。 */
  readonly branch: 'position-was-air' | 'position-had-block';
  readonly commandsIssued: number;
}

interface Runner {
  run(commandLine: string): Promise<{ readonly ok: boolean; readonly statusMessage: string | null }>;
}

const absolute = (point: Vec3) => ({ ...point, mode: 'absolute' as const });

export async function probeReadingPath(runner: Runner, position: Vec3): Promise<ReadingProbeReport> {
  let commandsIssued = 0;
  const run = async (commandLine: string) => {
    commandsIssued += 1;
    return await runner.run(commandLine);
  };

  const airTest = await run(worldCommands.testForBlock(absolute(position), SENTINEL_BLOCK, null));

  if (!airTest.ok) {
    // 那格有東西，第一問就給了失敗訊息，直接驗。
    const reading = readBlockFromOutcome(false, airTest.statusMessage ?? null);
    return {
      parseable: reading.block !== null,
      parsedName: reading.block,
      raw: reading.raw,
      branch: 'position-had-block',
      commandsIssued,
    };
  }

  // 那格是空氣。拿基岩去問，保證不符，藉此逼出一則失敗訊息。
  const contrast = await run(worldCommands.testForBlock(absolute(position), CONTRAST_BLOCK, null));
  const reading = readBlockFromOutcome(false, contrast.statusMessage ?? null);
  return {
    // 對照測試若「成功」代表那格真的是基岩——與前一問矛盾，同樣視為協定異常。
    parseable: !contrast.ok && reading.block !== null,
    parsedName: reading.block,
    raw: reading.raw,
    branch: 'position-was-air',
    commandsIssued,
  };
}

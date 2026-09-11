import { describe, expect, it } from 'vitest';

import { SENTINEL_BLOCK, readBlockFromOutcome } from '../../src/domain/block-report.js';

/**
 * 這支解析器讀的是沒有穩定性保證的在地化訊息，所以測試的重點不是「能解析」，
 * 而是**解析不出來時絕不亂猜**。回一個錯的方塊名比回 null 傷害大得多——
 * 呼叫端會拿它去做判斷。
 */
describe('readBlockFromOutcome', () => {
  it('命中哨兵時直接回哨兵方塊，不必解析訊息', () => {
    const reading = readBlockFromOutcome(true, '在 0,64,0 成功找到該方塊。');
    expect(reading.block).toBe(SENTINEL_BLOCK);
    expect(reading.isSentinel).toBe(true);
  });

  it('解析繁中訊息（本專案真機實測到的格式）', () => {
    const reading = readBlockFromOutcome(false, '在 -20,75,8 的方塊是 泥土 (預期：空氣)。');
    expect(reading.block).toBe('泥土');
    expect(reading.isSentinel).toBe(false);
  });

  it('方塊名含空白也完整取出，不會只取第一個詞', () => {
    const reading = readBlockFromOutcome(false, '在 20,75,8 的方塊是 橡樹樹葉 (預期：空氣)。');
    expect(reading.block).toBe('橡樹樹葉');
  });

  it('解析英文訊息', () => {
    const reading = readBlockFromOutcome(false, 'The block at -20,75,8 is oak leaves (expected: air).');
    expect(reading.block).toBe('oak leaves');
  });

  it('全形與半形括號都認', () => {
    expect(readBlockFromOutcome(false, '在 0,64,0 的方塊是 石頭 （預期：空氣）').block).toBe('石頭');
    expect(readBlockFromOutcome(false, '在 0,64,0 的方塊是 石頭 (預期：空氣)').block).toBe('石頭');
  });

  it('認得簡中的「预期」', () => {
    expect(readBlockFromOutcome(false, '在 0,64,0 的方塊是 石頭 (预期：空气)').block).toBe('石頭');
  });

  it('訊息格式不認得時回 null，不猜', () => {
    const reading = readBlockFromOutcome(false, 'Некоторый неизвестный формат сообщения');
    expect(reading.block).toBeNull();
    expect(reading.raw).toBe('Некоторый неизвестный формат сообщения');
  });

  it('沒有訊息時回 null 而不是空字串', () => {
    expect(readBlockFromOutcome(false, null).block).toBeNull();
    expect(readBlockFromOutcome(false, '   ').block).toBeNull();
  });

  it('永遠保留原始訊息，讓呼叫端在解析失敗時仍有線索', () => {
    const raw = '某種沒見過的訊息';
    expect(readBlockFromOutcome(false, raw).raw).toBe(raw);
  });
});

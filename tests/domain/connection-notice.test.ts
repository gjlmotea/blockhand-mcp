import { describe, expect, it } from 'vitest';

import { connectionNoticeCommand, noticeLanguageFromDaytime } from '../../src/domain/connection-notice.js';

function noticeText(commandLine: string): string {
  expect(commandLine.startsWith('tellraw @a ')).toBe(true);
  return (JSON.parse(commandLine.slice('tellraw @a '.length)) as { rawtext: Array<{ text: string }> })
    .rawtext.map((part) => part.text).join('');
}

describe('noticeLanguageFromDaytime', () => {
  // 回覆字串照抄遊戲語言檔的 commands.time.query.daytime。
  it('認得繁中、簡中與英文的 time query daytime 回覆', () => {
    expect(noticeLanguageFromDaytime('白天時間為 6000')).toBe('zh-TW');
    expect(noticeLanguageFromDaytime('白天为 6000')).toBe('zh-CN');
    expect(noticeLanguageFromDaytime('Daytime is 6000')).toBe('en');
  });

  it('其他語言與沒有回覆時用英文', () => {
    expect(noticeLanguageFromDaytime('時刻は 6000 です')).toBe('en');
    expect(noticeLanguageFromDaytime('Tagedauer ist 6000')).toBe('en');
    expect(noticeLanguageFromDaytime(null)).toBe('en');
  });
});

describe('connectionNoticeCommand', () => {
  it('三種語言都帶連線位址', () => {
    for (const language of ['en', 'zh-TW', 'zh-CN'] as const) {
      expect(noticeText(connectionNoticeCommand(language, '127.0.0.1:19131'))).toContain('(127.0.0.1:19131)');
    }
  });

  it('英文通知不含中文', () => {
    const text = noticeText(connectionNoticeCommand('en', '127.0.0.1:19131'));
    expect(text).toContain('BlockHand connected');
    expect(text).not.toMatch(/[一-鿿]/u);
  });

  it('簡中通知用簡體字', () => {
    const text = noticeText(connectionNoticeCommand('zh-CN', '127.0.0.1:19131'));
    expect(text).toContain('已连上 BlockHand');
    expect(text).not.toContain('連');
  });
});

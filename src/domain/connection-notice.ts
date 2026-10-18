/**
 * 遊戲連上時在聊天列顯示的通知，語言跟著遊戲走。
 *
 * 這是本 server 唯一自己產生、玩家會看到的文字。玩家看的是遊戲畫面，所以
 * 用遊戲的語言，而不是 AI 客戶端或作業系統的語言。
 *
 * 遊戲的指令回覆取自它自己的語言檔，所以先送一條唯讀的 `time query daytime`
 * （保活探測用的同一條），看回覆是哪一種語言。對照字串取自遊戲安裝檔
 * `resource_packs/vanilla/texts/*.lang` 的 `commands.time.query.daytime`：
 *
 *   en_US「Daytime is %d」 zh_TW「白天時間為 %d」 zh_CN「白天为 %d」
 *
 * 認不出來的語言（含日文「時刻は %d です」）與探測失敗一律用英文。
 */

export type NoticeLanguage = 'en' | 'zh-TW' | 'zh-CN';

export function noticeLanguageFromDaytime(statusMessage: string | null): NoticeLanguage {
  if (statusMessage === null) return 'en';
  if (statusMessage.includes('白天時間為')) return 'zh-TW';
  if (statusMessage.includes('白天为')) return 'zh-CN';
  return 'en';
}

const NOTICE_TEXT: Readonly<Record<NoticeLanguage, { readonly connected: string; readonly hint: string }>> = {
  en: {
    connected: 'BlockHand connected',
    hint:
      'No need to type /connect again: typing it while connected shows no text at all. ' +
      '/reload all and switching worlds usually keep the connection.',
  },
  'zh-TW': {
    connected: '已連上 BlockHand',
    hint: '之後不用再打 /connect：連著時再打，遊戲不會顯示任何字。/reload all、換世界通常也不會斷線。',
  },
  'zh-CN': {
    connected: '已连上 BlockHand',
    hint: '之后不用再输入 /connect：连着时再输入，游戏不会显示任何文字。/reload all、切换世界通常也不会断线。',
  },
};

/** 組出 `tellraw @a`；address 是 `host:port`。 */
export function connectionNoticeCommand(language: NoticeLanguage, address: string): string {
  const text = NOTICE_TEXT[language];
  const rawtext = [
    { text: `§a✔ ${text.connected} §7(${address})` },
    { text: `\n§7${text.hint}` },
  ];
  return `tellraw @a ${JSON.stringify({ rawtext })}`;
}

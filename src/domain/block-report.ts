/**
 * 從 testforblock 的失敗訊息還原「那一格實際是什麼方塊」。
 *
 * 為什麼要這樣繞：Education 版沒有「讀取任意方塊」的指令，`testforblock` 只
 * 回答是非題。但它**失敗時**的訊息會把實際方塊講出來——
 *
 *   在 -20,75,8 的方塊是 泥土 (預期：空氣)。
 *
 * 所以拿一個哨兵方塊去問，猜錯反而拿到答案。這是不裝行為包能做到的讀取極限。
 *
 * 三個必須誠實面對的限制：
 * 1. 回傳的是**在地化顯示名稱**（泥土），不是方塊 ID（dirt），不能餵回 setblock。
 * 2. 訊息格式沒有官方穩定性保證，遊戲改版或換語言都可能失效。
 * 3. 解析失敗時一律回 null，不猜——寧可說「讀不到」也不要回一個錯的方塊名。
 */

/** 用來當哨兵的方塊。空氣最安全：純唯讀、不會誤判成玩家蓋的東西。 */
export const SENTINEL_BLOCK = 'air';

/**
 * 各語言的訊息形態。只認「方塊名」與「預期」之間的關係，不依賴座標怎麼排版，
 * 這樣座標格式改變不會連帶打壞解析。
 */
const PATTERNS: readonly RegExp[] = [
  /的方塊是\s*(.+?)\s*[（(]\s*(?:預期|预期)/u,
  /\bis\s+(.+?)\s*\(\s*expected/iu,
];

export interface BlockReading {
  /** 在地化顯示名稱；解析不出來時為 null。 */
  readonly block: string | null;
  /** 該格是否就是哨兵方塊（預設哨兵為空氣，即「這裡是空的」）。 */
  readonly isSentinel: boolean;
  /** 遊戲原始訊息，解析失敗時呼叫端仍拿得到線索。 */
  readonly raw: string | null;
}

/**
 * @param matched testforblock 是否命中哨兵。命中代表該格就是哨兵方塊。
 * @param statusMessage 遊戲回的訊息；未命中時才有解析價值。
 */
export function readBlockFromOutcome(matched: boolean, statusMessage: string | null): BlockReading {
  if (matched) return { block: SENTINEL_BLOCK, isSentinel: true, raw: statusMessage };
  if (statusMessage === null || statusMessage.trim() === '') {
    return { block: null, isSentinel: false, raw: statusMessage };
  }
  for (const pattern of PATTERNS) {
    const match = pattern.exec(statusMessage);
    const captured = match?.[1]?.trim();
    if (captured !== undefined && captured !== '') {
      return { block: captured, isSentinel: false, raw: statusMessage };
    }
  }
  return { block: null, isSentinel: false, raw: statusMessage };
}

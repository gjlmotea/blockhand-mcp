/**
 * Bedrock／Education slash 指令建構器。
 *
 * 全部是純函式：輸入結構化參數，輸出一行不帶前導 `/` 的指令字串
 * （WebSocket 的 commandLine 不吃前導斜線）。
 *
 * 每個會被插進指令列的字串都必須先過白名單，避免呼叫端用空白或換行
 * 把一條指令拆成兩條——這是這個橋接唯一真正的注入面。
 */

import type {
  AgentDirection,
  BlockHandlingMode,
  Coordinate,
  FillMode,
  StructureMirror,
  TurnDirection,
} from './contracts.js';
import { MinecraftBridgeError } from './contracts.js';
import { formatCoordinate } from './coordinates.js';

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;
const BLOCK_STATES_PATTERN = /^\[[^[\]\n\r]*\]$/;
const SELECTOR_PATTERN = /^(@[aeprs](\[[^[\]\n\r]*\])?|[A-Za-z0-9_ .-]{1,64})$/;
const TEXT_FORBIDDEN = /[\n\r]/;

export function assertIdentifier(value: string, label: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new MinecraftBridgeError(
      'invalid-identifier',
      `${label} 只接受字母、數字、底線、點、冒號與連字號，實際收到：${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function assertBlockStates(value: string): string {
  if (!BLOCK_STATES_PATTERN.test(value)) {
    throw new MinecraftBridgeError(
      'invalid-block-states',
      `方塊狀態必須是單一組 [] 且不得含換行，實際收到：${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function assertSelector(value: string, label: string): string {
  if (!SELECTOR_PATTERN.test(value)) {
    throw new MinecraftBridgeError(
      'invalid-selector',
      `${label} 必須是 @a/@e/@p/@r/@s 選擇器或單純玩家名，實際收到：${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function assertFreeText(value: string, label: string, maxLength = 512): string {
  if (TEXT_FORBIDDEN.test(value)) {
    throw new MinecraftBridgeError('invalid-text', `${label} 不得包含換行。`);
  }
  if (value.length > maxLength) {
    throw new MinecraftBridgeError(
      'invalid-text',
      `${label} 長度 ${String(value.length)} 超過上限 ${String(maxLength)}。`,
    );
  }
  return value;
}

function join(parts: readonly (string | null)[]): string {
  return parts.filter((part): part is string => part !== null && part !== '').join(' ');
}

function blockToken(block: string, states: string | null): readonly (string | null)[] {
  return [assertIdentifier(block, '方塊 ID'), states === null ? null : assertBlockStates(states)];
}

/* ────────────────────────── Agent（手腳） ────────────────────────── */

export const agentCommands = {
  create(): string {
    return 'agent create';
  },
  move(direction: AgentDirection): string {
    return `agent move ${direction}`;
  },
  turn(direction: TurnDirection): string {
    return `agent turn ${direction}`;
  },
  teleportToPlayer(): string {
    return 'agent tp';
  },
  attack(direction: AgentDirection): string {
    return `agent attack ${direction}`;
  },
  destroy(direction: AgentDirection): string {
    return `agent destroy ${direction}`;
  },
  till(direction: AgentDirection): string {
    return `agent till ${direction}`;
  },
  place(slot: number, direction: AgentDirection): string {
    return `agent place ${String(assertSlot(slot))} ${direction}`;
  },
  collect(item: string): string {
    return `agent collect ${assertIdentifier(item, '收集目標')}`;
  },
  collectAll(): string {
    return 'agent collect all';
  },
  drop(slot: number, quantity: number, direction: AgentDirection): string {
    return `agent drop ${String(assertSlot(slot))} ${String(assertQuantity(quantity))} ${direction}`;
  },
  dropAll(direction: AgentDirection): string {
    return `agent dropall ${direction}`;
  },
  transfer(sourceSlot: number, quantity: number, destinationSlot: number): string {
    return `agent transfer ${String(assertSlot(sourceSlot))} ${String(assertQuantity(quantity))} ${String(assertSlot(destinationSlot))}`;
  },
  inspect(direction: AgentDirection): string {
    return `agent inspect ${direction}`;
  },
  inspectData(direction: AgentDirection): string {
    return `agent inspectdata ${direction}`;
  },
  detect(direction: AgentDirection): string {
    return `agent detect ${direction}`;
  },
  detectRedstone(direction: AgentDirection): string {
    return `agent detectredstone ${direction}`;
  },
  getItemCount(slot: number): string {
    return `agent getitemcount ${String(assertSlot(slot))}`;
  },
  getItemSpace(slot: number): string {
    return `agent getitemspace ${String(assertSlot(slot))}`;
  },
  getItemDetail(slot: number): string {
    return `agent getitemdetail ${String(assertSlot(slot))}`;
  },
} as const;

function assertSlot(slot: number): number {
  if (!Number.isInteger(slot) || slot < 1 || slot > 27) {
    throw new MinecraftBridgeError(
      'invalid-slot',
      `Agent 背包槽位必須是 1～27 的整數，實際收到：${String(slot)}`,
    );
  }
  return slot;
}

function assertQuantity(quantity: number): number {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 64) {
    throw new MinecraftBridgeError(
      'invalid-quantity',
      `數量必須是 1～64 的整數，實際收到：${String(quantity)}`,
    );
  }
  return quantity;
}

/* ────────────────────────── 世界讀寫 ────────────────────────── */

export const worldCommands = {
  setBlock(
    position: Coordinate,
    block: string,
    states: string | null,
    handling: BlockHandlingMode | null,
  ): string {
    return join([
      'setblock',
      formatCoordinate(position),
      ...blockToken(block, states),
      handling,
    ]);
  },

  fill(
    from: Coordinate,
    to: Coordinate,
    block: string,
    states: string | null,
    mode: FillMode | null,
    replaceBlock: string | null,
    replaceStates: string | null,
  ): string {
    if (replaceBlock !== null && mode !== 'replace') {
      throw new MinecraftBridgeError(
        'invalid-fill',
        'replaceBlock 只能搭配 mode="replace" 使用。',
      );
    }
    return join([
      'fill',
      formatCoordinate(from),
      formatCoordinate(to),
      ...blockToken(block, states),
      mode,
      ...(replaceBlock === null ? [] : blockToken(replaceBlock, replaceStates)),
    ]);
  },

  clone(
    begin: Coordinate,
    end: Coordinate,
    destination: Coordinate,
    maskMode: 'replace' | 'masked' | null,
    cloneMode: 'normal' | 'force' | 'move' | null,
  ): string {
    return join([
      'clone',
      formatCoordinate(begin),
      formatCoordinate(end),
      formatCoordinate(destination),
      maskMode,
      cloneMode,
    ]);
  },

  testForBlock(position: Coordinate, block: string, states: string | null): string {
    return join(['testforblock', formatCoordinate(position), ...blockToken(block, states)]);
  },

  /**
   * 比對兩個等大區域是否一致。
   *
   * 這是唯一能「一條指令比對整片區域」的原生指令；逐格 testforblock 在幾百格
   * 以上就會撞到 MCP host 逾時。masked 模式把來源的空氣視為忽略，適合檢查
   * 「該有的東西在不在」而不管周圍多了什麼。
   */
  testForBlocks(begin: Coordinate, end: Coordinate, destination: Coordinate, masked: boolean): string {
    return join([
      'testforblocks',
      formatCoordinate(begin),
      formatCoordinate(end),
      formatCoordinate(destination),
      masked ? 'masked' : 'all',
    ]);
  },

  queryTarget(selector: string): string {
    return `querytarget ${assertSelector(selector, '查詢目標')}`;
  },

  summon(entity: string, position: Coordinate | null, nameTag: string | null): string {
    return join([
      'summon',
      assertIdentifier(entity, '生物 ID'),
      position === null ? null : formatCoordinate(position),
      nameTag === null ? null : `"${assertFreeText(nameTag, '名牌', 64).replace(/"/g, '')}"`,
    ]);
  },

  setTime(value: string): string {
    return `time set ${assertIdentifier(value, '時間')}`;
  },

  setWeather(condition: 'clear' | 'rain' | 'thunder', durationSeconds: number | null): string {
    return join(['weather', condition, durationSeconds === null ? null : String(durationSeconds)]);
  },

  setGameRule(rule: string, value: string): string {
    return `gamerule ${assertIdentifier(rule, '遊戲規則')} ${assertIdentifier(value, '規則值')}`;
  },

  setDifficulty(level: 'peaceful' | 'easy' | 'normal' | 'hard'): string {
    return `difficulty ${level}`;
  },

  saveStructure(
    name: string,
    from: Coordinate,
    to: Coordinate,
    includeEntities: boolean,
    saveMode: 'memory' | 'disk',
  ): string {
    return join([
      'structure save',
      assertIdentifier(name, '結構名稱'),
      formatCoordinate(from),
      formatCoordinate(to),
      includeEntities ? 'true' : 'false',
      saveMode,
    ]);
  },

  /**
   * mirror 必須跟在 rotation 後面，這是遊戲的位置參數順序；只給 mirror 會被
   * 當成 rotation 解析而失敗。所以需要鏡像時一律補上 0_degrees。
   */
  loadStructure(name: string, to: Coordinate, mirror: StructureMirror = 'none'): string {
    return join([
      'structure load',
      assertIdentifier(name, '結構名稱'),
      formatCoordinate(to),
      mirror === 'none' ? null : '0_degrees',
      mirror === 'none' ? null : mirror,
    ]);
  },

  deleteStructure(name: string): string {
    return join(['structure delete', assertIdentifier(name, '結構名稱')]);
  },

  addTickingArea(from: Coordinate, to: Coordinate, name: string | null): string {
    return join([
      'tickingarea add',
      formatCoordinate(from),
      formatCoordinate(to),
      name === null ? null : assertIdentifier(name, '常載區名稱'),
    ]);
  },
} as const;

/* ────────────────────────── 玩家 ────────────────────────── */

export const playerCommands = {
  teleport(target: string, destination: Coordinate): string {
    return `teleport ${assertSelector(target, '傳送對象')} ${formatCoordinate(destination)}`;
  },
  give(target: string, item: string, amount: number, data: number | null): string {
    return join([
      'give',
      assertSelector(target, '給予對象'),
      assertIdentifier(item, '物品 ID'),
      String(amount),
      data === null ? null : String(data),
    ]);
  },
  clear(target: string, item: string | null): string {
    return join([
      'clear',
      assertSelector(target, '清空對象'),
      item === null ? null : assertIdentifier(item, '物品 ID'),
    ]);
  },
  gameMode(target: string, mode: 'survival' | 'creative' | 'adventure' | 'spectator'): string {
    return `gamemode ${mode} ${assertSelector(target, '對象')}`;
  },
  effect(
    target: string,
    effect: string,
    seconds: number,
    amplifier: number,
    hideParticles: boolean,
  ): string {
    return join([
      'effect',
      assertSelector(target, '對象'),
      assertIdentifier(effect, '效果 ID'),
      String(seconds),
      String(amplifier),
      hideParticles ? 'true' : 'false',
    ]);
  },
  clearEffects(target: string): string {
    return `effect ${assertSelector(target, '對象')} clear`;
  },
  experience(target: string, amount: number, unit: 'levels' | 'points'): string {
    const suffix = unit === 'levels' ? 'L' : '';
    return `xp ${String(amount)}${suffix} ${assertSelector(target, '對象')}`;
  },
  kill(target: string): string {
    return `kill ${assertSelector(target, '對象')}`;
  },
  ability(target: string, ability: 'worldbuilder' | 'mayfly' | 'mute', enabled: boolean): string {
    return `ability ${assertSelector(target, '對象')} ${ability} ${enabled ? 'true' : 'false'}`;
  },
} as const;

/* ────────────────────────── 訊息與回饋 ────────────────────────── */

export const chatCommands = {
  say(message: string): string {
    return `say ${assertFreeText(message, '訊息')}`;
  },
  tell(target: string, message: string): string {
    return `tell ${assertSelector(target, '對象')} ${assertFreeText(message, '訊息')}`;
  },
  title(
    target: string,
    slot: 'title' | 'subtitle' | 'actionbar',
    message: string,
  ): string {
    return `title ${assertSelector(target, '對象')} ${slot} ${assertFreeText(message, '訊息', 256)}`;
  },
  clearTitle(target: string): string {
    return `title ${assertSelector(target, '對象')} clear`;
  },
  playSound(sound: string, target: string, position: Coordinate | null): string {
    return join([
      'playsound',
      assertIdentifier(sound, '音效 ID'),
      assertSelector(target, '對象'),
      position === null ? null : formatCoordinate(position),
    ]);
  },
  particle(effect: string, position: Coordinate): string {
    return `particle ${assertIdentifier(effect, '粒子 ID')} ${formatCoordinate(position)}`;
  },
} as const;

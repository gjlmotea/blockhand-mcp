import { describe, expect, it } from 'vitest';

import { CLIENTS, CLIENT_IDS, resolveClient } from '../../scripts/lib/mcp-clients.mjs';
import { createDesiredRegistration } from '../../scripts/lib/mcp-registration.mjs';

const NODE = '/Users/墨茶/.nvm/versions/node/v22.23.1/bin/node';
const LAUNCHER = '/Users/墨茶/My Projects/minecraft-edu/scripts/launch-mcp.mjs';
const desired = createDesiredRegistration({ nodePath: NODE, launcherPath: LAUNCHER });

const ENV_PAIRS = [
  'MINECRAFT_EDU_WS_HOST=127.0.0.1',
  'MINECRAFT_EDU_WS_PORT=19131',
  'MINECRAFT_EDU_WS_PORT_FALLBACK=1',
];

describe('mcp add 參數形狀（各家實測差異）', () => {
  it('codex 用 --env 並以 -- 分隔命令', () => {
    expect(CLIENTS.codex.buildAddArguments(desired)).toEqual([
      'mcp', 'add', 'minecraft-edu',
      '--env', ENV_PAIRS[0], '--env', ENV_PAIRS[1], '--env', ENV_PAIRS[2],
      '--', NODE, LAUNCHER,
    ]);
  });

  it('claude 明寫 --scope user，否則預設 local 只在單一專案生效', () => {
    expect(CLIENTS.claude.buildAddArguments(desired)).toEqual([
      'mcp', 'add', 'minecraft-edu',
      '--scope', 'user',
      '--env', ENV_PAIRS[0], '--env', ENV_PAIRS[1], '--env', ENV_PAIRS[2],
      '--', NODE, LAUNCHER,
    ]);
  });

  it('gemini 的 command 與 args 是位置參數，沒有 -- 分隔', () => {
    expect(CLIENTS.gemini.buildAddArguments(desired)).toEqual([
      'mcp', 'add', 'minecraft-edu',
      NODE, LAUNCHER,
      '--scope', 'user',
      '--env', ENV_PAIRS[0], '--env', ENV_PAIRS[1], '--env', ENV_PAIRS[2],
    ]);
  });

  it('grok 用 -- 分隔，否則旗標會被 grok 自己吃掉', () => {
    expect(CLIENTS.grok.buildAddArguments(desired)).toEqual([
      'mcp', 'add', 'minecraft-edu',
      '--scope', 'user',
      '--env', ENV_PAIRS[0], '--env', ENV_PAIRS[1], '--env', ENV_PAIRS[2],
      '--', NODE, LAUNCHER,
    ]);
  });

  it('所有 client 都以 argv array 傳遞，路徑不經 shell quote', () => {
    for (const id of CLIENT_IDS) {
      const argv = CLIENTS[id].buildAddArguments(desired);
      expect(argv).toContain(NODE);
      expect(argv).toContain(LAUNCHER);
      expect(argv.every((token) => typeof token === 'string')).toBe(true);
    }
  });
});

describe('mcp remove 參數形狀', () => {
  it('codex 不需要 scope；其餘三家明寫 user 以免誤刪其他 scope', () => {
    expect(CLIENTS.codex.buildRemoveArguments('minecraft-edu')).toEqual(['mcp', 'remove', 'minecraft-edu']);
    for (const id of ['claude', 'gemini', 'grok']) {
      expect(CLIENTS[id].buildRemoveArguments('minecraft-edu')).toEqual([
        'mcp', 'remove', 'minecraft-edu', '--scope', 'user',
      ]);
    }
  });
});

describe('entry 正規化', () => {
  it('grok 的扁平形狀轉成 transport 形狀', () => {
    const raw = {
      name: 'minecraft-edu',
      enabled: true,
      scope: 'user',
      command: NODE,
      args: [LAUNCHER],
      env: { MINECRAFT_EDU_WS_PORT: '19131' },
    };
    expect(CLIENTS.grok.normalizeListed(raw, 'minecraft-edu')).toEqual({
      name: 'minecraft-edu',
      enabled: true,
      transport: { type: 'stdio', command: NODE, args: [LAUNCHER], env: { MINECRAFT_EDU_WS_PORT: '19131' } },
    });
  });

  it('claude 設定檔形狀轉成 transport 形狀', () => {
    const raw = { type: 'stdio', command: NODE, args: [LAUNCHER], env: {} };
    expect(CLIENTS.claude.normalizeListed(raw, 'minecraft-edu').transport.command).toBe(NODE);
  });

  it('gemini 沒有 type 欄位時補上 stdio', () => {
    const raw = { command: NODE, args: [LAUNCHER], env: {} };
    expect(CLIENTS.gemini.normalizeListed(raw, 'minecraft-edu').transport.type).toBe('stdio');
  });

  it('codex 原樣通過，不重複包裝', () => {
    const raw = { name: 'minecraft-edu', enabled: true, transport: { type: 'stdio', command: NODE, args: [LAUNCHER], env: {} } };
    expect(CLIENTS.codex.normalizeListed(raw, 'minecraft-edu')).toBe(raw);
  });

  it('沒有 entry 時一律回 null，不會憑空造出空 entry', () => {
    for (const id of CLIENT_IDS) {
      expect(CLIENTS[id].normalizeListed(null, 'minecraft-edu')).toBeNull();
      expect(CLIENTS[id].normalizeListed(undefined, 'minecraft-edu')).toBeNull();
    }
  });
});

describe('讀取策略與 client 解析', () => {
  it('codex／grok 走 CLI JSON；claude／gemini 因無機器可讀輸出而讀設定檔', () => {
    expect(CLIENTS.codex.read.kind).toBe('cli-json');
    expect(CLIENTS.grok.read.kind).toBe('cli-json');
    expect(CLIENTS.claude.read.kind).toBe('config-file');
    expect(CLIENTS.gemini.read.kind).toBe('config-file');
  });

  it('設定檔路徑以傳入的 home 計算，不寫死使用者目錄', () => {
    expect(CLIENTS.claude.read.configPath('/home/x')).toBe('/home/x/.claude.json');
    expect(CLIENTS.gemini.read.configPath('/home/x')).toBe('/home/x/.gemini/settings.json');
  });

  it('每家都有各自的 CLI 路徑覆寫環境變數', () => {
    const variables = CLIENT_IDS.map((id) => CLIENTS[id].pathEnvironmentVariable);
    expect(new Set(variables).size).toBe(CLIENT_IDS.length);
  });

  it('未知 client 明確拒絕並列出可用值', () => {
    expect(() => resolveClient('cursor')).toThrow(/不支援的 client/u);
    expect(() => resolveClient('cursor')).toThrow(/codex/u);
  });
});

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MCP_NAME,
  REQUIRED_ENV,
  classifyRegistration,
  createDesiredRegistration,
  isAbsolutePortablePath,
  isBlockHandEntryPath,
  normalizeComparablePath,
  samePath,
} from '../../scripts/lib/mcp-registration.mjs';

const blockhandCli = fileURLToPath(new URL('../../scripts/blockhand.mjs', import.meta.url));

const macPaths = {
  launcherPath: '/Users/墨茶/My Projects/minecraft-edu/scripts/launch-mcp.mjs',
  distPath: '/Users/墨茶/My Projects/minecraft-edu/dist/index.js',
};
const macDesired = createDesiredRegistration({
  nodePath: '/Users/墨茶/.nvm/versions/node/v24.21.0/bin/node',
  launcherPath: macPaths.launcherPath,
});

function entryWith(overrides = {}) {
  const { transport: transportOverrides = {}, ...entryOverrides } = overrides;
  return {
    name: MCP_NAME,
    enabled: true,
    transport: {
      type: 'stdio',
      command: macDesired.transport.command,
      args: [...macDesired.transport.args],
      env: { ...REQUIRED_ENV },
      ...transportOverrides,
    },
    ...entryOverrides,
  };
}

function classify(entry, registeredNodeUsable = true) {
  return classifyRegistration(entry, macDesired, macPaths, { registeredNodeUsable });
}

describe('Codex registration path handling', () => {
  it('保留 macOS 的空白與中文絕對路徑', () => {
    expect(macDesired.transport.args).toEqual([macPaths.launcherPath]);
    expect(macDesired.transport.command).toContain('/Users/墨茶/');
  });

  it('以 POSIX 規則比較 macOS 路徑', () => {
    expect(samePath('/Users/me/project/./scripts/launch-mcp.mjs', '/Users/me/project/scripts/launch-mcp.mjs')).toBe(
      true,
    );
    expect(samePath('/Users/Me/project', '/Users/me/project')).toBe(false);
  });

  it('以 win32 規則比較 Windows 路徑，不受大小寫與斜線方向影響', () => {
    expect(
      samePath(
        'C:\\Users\\Student\\Desktop\\minecraft-edu\\dist\\index.js',
        'c:/users/student/Desktop/minecraft-edu/dist/index.js',
      ),
    ).toBe(true);
    expect(normalizeComparablePath('C:\\A\\..\\B\\')).toBe('c:\\b');
  });

  it('只辨識 BlockHand 的兩種歷史 entry 形狀', () => {
    expect(isBlockHandEntryPath('/work/minecraft-edu/dist/index.js')).toBe(true);
    expect(isBlockHandEntryPath('/work/minecraft-edu/scripts/launch-mcp.mjs')).toBe(true);
    expect(isBlockHandEntryPath('/work/other/dist/index.js')).toBe(false);
  });

  it('跨平台辨識絕對路徑，拒絕只靠 Finder PATH 的裸 node', () => {
    expect(isAbsolutePortablePath('/opt/homebrew/bin/node')).toBe(true);
    expect(isAbsolutePortablePath('C:\\Program Files\\nodejs\\node.exe')).toBe(true);
    expect(isAbsolutePortablePath('node')).toBe(false);
  });
});

describe('Codex registration classification', () => {
  it('沒有 entry 時分類為 missing', () => {
    expect(classify(null)).toEqual({
      kind: 'missing',
      differences: [],
    });
  });

  it('launcher、Node 與必要環境完全一致時分類為 exact', () => {
    expect(classify(entryWith()).kind).toBe('exact');
  });

  it('接受同一工作樹既有的 direct-dist entry，不強迫 remove/add', () => {
    const existing = entryWith({
      transport: {
        command: '/opt/homebrew/Cellar/node@24/24.21.0/bin/node',
        args: [macPaths.distPath],
      },
    });
    const outcome = classify(existing);
    expect(outcome.kind).toBe('compatible');
    expect(outcome.differences).toContain('Node path differs from the Node running this installer');
  });

  it('同一 entry 被停用時不會誤判為可用', () => {
    const outcome = classify(entryWith({ enabled: false }));
    expect(outcome.kind).toBe('blockhand-mismatch');
    expect(outcome.differences).toContain('entry is disabled');
  });

  it('另一個 clone 的 BlockHand entry 會停止，不自動覆寫', () => {
    const outcome = classify(
      entryWith({ transport: { args: ['/Users/other/minecraft-edu/scripts/launch-mcp.mjs'] } }),
    );
    expect(outcome.kind).toBe('blockhand-mismatch');
    expect(outcome.differences.join('\n')).toContain('somewhere else');
  });

  it('陌生同名 MCP 分類為 foreign', () => {
    const outcome = classify(
      entryWith({
        transport: {
          command: '/usr/bin/python3',
          args: ['/Users/me/not-blockhand/server.py'],
          env: {},
        },
      }),
    );
    expect(outcome.kind).toBe('foreign');
  });

  it('舊 entry 缺少等同 runtime 預設的 HOST／FALLBACK 仍相容', () => {
    const outcome = classify(
      entryWith({
        transport: {
          args: [macPaths.distPath],
          env: { MINECRAFT_EDU_WS_PORT: '19131' },
        },
      }),
    );
    expect(outcome.kind).toBe('compatible');
  });

  it('拒絕會改變 Node 啟動行為的非 BlockHand env', () => {
    const outcome = classify(
      entryWith({ transport: { env: { ...REQUIRED_ENV, NODE_OPTIONS: '--require /missing.js' } } }),
    );
    expect(outcome.kind).toBe('blockhand-mismatch');
  });

  it('裸 node 或實際不可用的 Node 都不能分類為 compatible', () => {
    const bare = classify(entryWith({ transport: { command: 'node' } }));
    const missing = classify(entryWith(), false);
    expect(bare.kind).toBe('blockhand-mismatch');
    expect(bare.differences).toContain('Node command is not an absolute path');
    expect(missing.kind).toBe('blockhand-mismatch');
    expect(missing.differences.join('\n')).toContain('does not exist, cannot run');
  });
});

describe('BlockHand CLI argv grammar', () => {
  it('未知 connect 參數以 exit 2 拒絕', () => {
    const result = spawnSync(process.execPath, [blockhandCli, 'connect', '--definitely-unknown'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('connect takes no arguments');
  });

  it('uninstall --dry-run 不會被誤當成真正移除', () => {
    const result = spawnSync(process.execPath, [blockhandCli, 'uninstall', '--dry-run'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('uninstall takes no arguments');
  });
});

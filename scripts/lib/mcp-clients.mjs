import { join } from 'node:path';

/**
 * 四家 AI CLI 的 MCP 註冊差異都收斂在這裡；blockhand.mjs 只認這層的介面。
 *
 * 每家都用官方 `mcp add` / `mcp remove` 子指令做「寫入」，不手改設定檔——
 * 那會繞過各家自己的 schema 驗證與 scope 解析。
 *
 * 「讀取」則分兩種，因為各家能力不一致：
 *   - codex／grok 有 `mcp list --json`，可直接拿機器可讀輸出。
 *   - claude／gemini 的 list 只有人類可讀文字，且不含 env，無法據以判斷
 *     既有設定是否相容。對這兩家改讀官方 CLI 剛寫入的設定檔（唯讀）。
 *     這仍然不違反「不手改設定檔」——寫入永遠走 CLI。
 */

export const CLIENT_IDS = Object.freeze(['codex', 'claude', 'gemini', 'grok']);

function environmentPairs(environment, flag) {
  return Object.entries(environment).flatMap(([key, value]) => [flag, `${key}=${value}`]);
}

/** 各家 entry 形狀不同，一律正規化成 codex 的 transport 形狀再交給分類器。 */
function toCanonical(name, { command, args, env, enabled = true, type = 'stdio' }) {
  return {
    name,
    enabled,
    transport: {
      type,
      command,
      args: Array.isArray(args) ? args : [],
      env: env ?? {},
    },
  };
}

export const CLIENTS = Object.freeze({
  codex: {
    id: 'codex',
    label: 'Codex',
    binary: 'codex',
    pathEnvironmentVariable: 'CODEX_CLI_PATH',
    configHint: '~/.codex/config.toml',
    read: { kind: 'cli-json', args: ['mcp', 'list', '--json'] },
    // codex 本來就回 transport 形狀，原樣通過。
    normalizeListed: (raw) => (raw === null || raw === undefined ? null : raw),
    buildAddArguments: (desired) => [
      'mcp',
      'add',
      desired.name,
      ...environmentPairs(desired.transport.env, '--env'),
      '--',
      desired.transport.command,
      ...desired.transport.args,
    ],
    buildRemoveArguments: (name) => ['mcp', 'remove', name],
    restartHint: '完全退出並重啟 Codex；同一台機器的桌面版、CLI 與 IDE 共用這份設定。',
  },

  claude: {
    id: 'claude',
    label: 'Claude Code',
    binary: 'claude',
    pathEnvironmentVariable: 'CLAUDE_CLI_PATH',
    configHint: '~/.claude.json（user scope）',
    read: {
      kind: 'config-file',
      // claude mcp list 只有人類可讀輸出且不含 env，無法用來判斷相容性。
      configPath: (home) => join(home, '.claude.json'),
      extract: (parsed, name) => parsed?.mcpServers?.[name] ?? null,
    },
    normalizeListed: (raw, name) => (raw === null || raw === undefined ? null : toCanonical(name, raw)),
    buildAddArguments: (desired) => [
      'mcp',
      'add',
      desired.name,
      '--scope',
      'user',
      ...environmentPairs(desired.transport.env, '--env'),
      '--',
      desired.transport.command,
      ...desired.transport.args,
    ],
    buildRemoveArguments: (name) => ['mcp', 'remove', name, '--scope', 'user'],
    restartHint:
      '重新啟動 Claude Code session（CLI 重開、桌面版完全退出）。若要整班共用，改用專案根的 .mcp.json（--scope project）。',
  },

  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    binary: 'gemini',
    pathEnvironmentVariable: 'GEMINI_CLI_PATH',
    configHint: '~/.gemini/settings.json（user scope）',
    read: {
      kind: 'config-file',
      configPath: (home) => join(home, '.gemini', 'settings.json'),
      extract: (parsed, name) => parsed?.mcpServers?.[name] ?? null,
    },
    normalizeListed: (raw, name) => (raw === null || raw === undefined ? null : toCanonical(name, raw)),
    // gemini 的 command 與 args 直接接在名稱後面，沒有 `--` 分隔。
    // 預設 scope 是 project，要全域必須明寫 user。
    buildAddArguments: (desired) => [
      'mcp',
      'add',
      desired.name,
      desired.transport.command,
      ...desired.transport.args,
      '--scope',
      'user',
      ...environmentPairs(desired.transport.env, '--env'),
    ],
    buildRemoveArguments: (name) => ['mcp', 'remove', name, '--scope', 'user'],
    restartHint: '重新啟動 Gemini CLI。注意它的預設 scope 是 project，本安裝器一律寫 user。',
  },

  grok: {
    id: 'grok',
    label: 'Grok CLI',
    binary: 'grok',
    pathEnvironmentVariable: 'GROK_CLI_PATH',
    configHint: '~/.grok/config.toml',
    read: { kind: 'cli-json', args: ['mcp', 'list', '--json'] },
    // grok 回的是扁平形狀（command/args/env 直接在頂層）。
    normalizeListed: (raw, name) => (raw === null || raw === undefined ? null : toCanonical(name, raw)),
    buildAddArguments: (desired) => [
      'mcp',
      'add',
      desired.name,
      '--scope',
      'user',
      ...environmentPairs(desired.transport.env, '--env'),
      '--',
      desired.transport.command,
      ...desired.transport.args,
    ],
    buildRemoveArguments: (name) => ['mcp', 'remove', name, '--scope', 'user'],
    restartHint: '重新啟動 Grok CLI。',
  },
});

export function resolveClient(id) {
  const client = CLIENTS[id];
  if (client === undefined) {
    throw new Error(`不支援的 client：${String(id)}。可用：${CLIENT_IDS.join('、')}`);
  }
  return client;
}

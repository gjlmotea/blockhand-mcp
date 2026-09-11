import { posix, win32 } from 'node:path';

export const MCP_NAME = 'minecraft-edu';
export const REQUIRED_NODE_VERSION = '22.23.1';

export const REQUIRED_ENV = Object.freeze({
  MINECRAFT_EDU_WS_HOST: '127.0.0.1',
  MINECRAFT_EDU_WS_PORT: '19131',
  MINECRAFT_EDU_WS_PORT_FALLBACK: '1',
});

const ALLOWED_ENV_NAMES = new Set([
  ...Object.keys(REQUIRED_ENV),
  'MINECRAFT_EDU_COMMAND_TIMEOUT_MS',
  'MINECRAFT_EDU_EVENT_BUFFER',
  'MINECRAFT_EDU_MAX_BUILD_BLOCKS',
  'MINECRAFT_EDU_STEP_DELAY_MS',
  'MINECRAFT_EDU_DEBUG_FRAMES',
  'MINECRAFT_EDU_ENCRYPTION',
]);

function pathApi(value) {
  return /^(?:[a-z]:[\\/]|\\\\)/i.test(value) ? win32 : posix;
}

export function normalizeComparablePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const api = pathApi(value);
  const normalized = api.normalize(value.trim()).replace(/[\\/]+$/, '');
  return api === win32 ? normalized.toLowerCase() : normalized;
}

export function samePath(left, right) {
  const normalizedLeft = normalizeComparablePath(left);
  const normalizedRight = normalizeComparablePath(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

export function isNodeCommand(command) {
  if (typeof command !== 'string' || command.trim() === '') return false;
  const basename = pathApi(command).basename(command).toLowerCase();
  return basename === 'node' || basename === 'node.exe';
}

export function isAbsolutePortablePath(value) {
  return typeof value === 'string' && value.trim() !== '' && pathApi(value).isAbsolute(value);
}

export function isBlockHandEntryPath(value) {
  const normalized = normalizeComparablePath(value)?.replaceAll('\\', '/');
  if (normalized === undefined || normalized === null) return false;
  return (
    normalized.endsWith('/minecraft-edu/dist/index.js') ||
    normalized.endsWith('/minecraft-edu/scripts/launch-mcp.mjs')
  );
}

export function createDesiredRegistration({ nodePath, launcherPath }) {
  return {
    name: MCP_NAME,
    enabled: true,
    transport: {
      type: 'stdio',
      command: nodePath,
      args: [launcherPath],
      env: { ...REQUIRED_ENV },
    },
  };
}

function requiredEnvironmentMatches(environment) {
  if (
    environment !== null &&
    environment !== undefined &&
    (typeof environment !== 'object' || Array.isArray(environment))
  ) {
    return false;
  }
  const configured = environment ?? {};
  if (Object.keys(configured).some((key) => !ALLOWED_ENV_NAMES.has(key))) return false;
  return Object.entries(REQUIRED_ENV).every(
    ([key, value]) => configured[key] === undefined || configured[key] === value,
  );
}

function describeDifferences(entry, desired, currentPaths, registeredNodeUsable) {
  const differences = [];
  const transport = entry?.transport;
  if (entry?.enabled === false) differences.push('entry 已停用');
  if (transport?.type !== 'stdio') return [...differences, 'transport 不是 stdio'];
  if (!isNodeCommand(transport.command)) differences.push('command 不是 Node 執行檔');
  if (!isAbsolutePortablePath(transport.command)) differences.push('Node command 不是絕對路徑');
  if (!registeredNodeUsable) differences.push(`登記的 Node 不存在、無法執行或不是 ${REQUIRED_NODE_VERSION}`);

  const args = Array.isArray(transport.args) ? transport.args : [];
  if (args.length !== 1) {
    differences.push(`args 預期 1 個，實際 ${String(args.length)} 個`);
  } else if (
    !samePath(args[0], currentPaths.launcherPath) &&
    !samePath(args[0], currentPaths.distPath)
  ) {
    differences.push(`entry 指向其他位置：${String(args[0])}`);
  }

  if (!requiredEnvironmentMatches(transport.env)) {
    differences.push('loopback／port 環境設定與 BlockHand 基線不同');
  }

  if (!samePath(transport.command, desired.transport.command)) {
    differences.push('Node 路徑與目前執行安裝器的 Node 不同');
  }
  return differences;
}

/**
 * 分類既有 Codex entry。這個函式只判斷，不做任何設定寫入。
 *
 * `compatible` 特別接受同一工作樹的舊 `node dist/index.js` 形狀，避免為了
 * 換 launcher 而 remove/add，進而遺失使用者既有 timeout 或 tool policy。
 */
export function classifyRegistration(
  entry,
  desired,
  currentPaths,
  { registeredNodeUsable = false } = {},
) {
  if (entry === null || entry === undefined) {
    return { kind: 'missing', differences: [] };
  }

  const transport = entry.transport;
  const args = Array.isArray(transport?.args) ? transport.args : [];
  const entryPath = args.length === 1 && typeof args[0] === 'string' ? args[0] : null;
  const enabled = entry.enabled !== false;
  const currentEntry =
    entryPath !== null &&
    (samePath(entryPath, currentPaths.launcherPath) || samePath(entryPath, currentPaths.distPath));
  const validBase =
    transport?.type === 'stdio' &&
    isNodeCommand(transport.command) &&
    isAbsolutePortablePath(transport.command) &&
    registeredNodeUsable &&
    args.length === 1 &&
    enabled &&
    requiredEnvironmentMatches(transport.env);

  if (
    validBase &&
    samePath(transport.command, desired.transport.command) &&
    samePath(entryPath, currentPaths.launcherPath)
  ) {
    return { kind: 'exact', differences: [] };
  }

  if (validBase && currentEntry) {
    return {
      kind: 'compatible',
      differences: describeDifferences(entry, desired, currentPaths, registeredNodeUsable),
    };
  }

  return {
    kind: entryPath !== null && isBlockHandEntryPath(entryPath) ? 'blockhand-mismatch' : 'foreign',
    differences: describeDifferences(entry, desired, currentPaths, registeredNodeUsable),
  };
}


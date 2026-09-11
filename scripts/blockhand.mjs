#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { arch, homedir, platform } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  MCP_NAME,
  REQUIRED_NODE_VERSION,
  classifyRegistration,
  createDesiredRegistration,
  isAbsolutePortablePath,
} from './lib/mcp-registration.mjs';
import { CLIENT_IDS, resolveClient } from './lib/mcp-clients.mjs';

const EXPECTED_PNPM_VERSION = '11.17.0';
const EXPECTED_TOOL_COUNT = 42;
const EXPECTED_RESOURCE_COUNT = 2;
const PROJECT_ROOT = canonicalPath(fileURLToPath(new URL('..', import.meta.url)));
const LAUNCHER_PATH = canonicalPath(fileURLToPath(new URL('./launch-mcp.mjs', import.meta.url)));
const DIST_PATH = canonicalPath(fileURLToPath(new URL('../dist/index.js', import.meta.url)));
const SMOKE_PATH = canonicalPath(fileURLToPath(new URL('./stdio-smoke.mjs', import.meta.url)));

function canonicalPath(value) {
  try {
    return realpathSync.native(value);
  } catch {
    return resolve(value);
  }
}

function clientCommand(client) {
  const configured = process.env[client.pathEnvironmentVariable]?.trim();
  if (configured === undefined || configured === '') return client.binary;
  if (!isAbsolutePortablePath(configured) || !existsSync(configured)) {
    throw new Error(
      `${client.pathEnvironmentVariable} 已設定但不是存在的絕對路徑：${configured}`,
    );
  }
  return configured;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

function summarizeCommandFailure(label, result) {
  if (result.error !== null) return `${label} 無法執行：${result.error.message}`;
  const detail = (result.stderr || result.stdout).trim().split(/\r?\n/u)[0];
  return `${label} 失敗（exit ${String(result.status)}）${detail === '' ? '' : `：${detail}`}`;
}

function readViaCli(client) {
  const label = `${client.binary} ${client.read.args.join(' ')}`;
  const result = run(clientCommand(client), client.read.args);
  if (result.status !== 0) throw new Error(summarizeCommandFailure(label, result));
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) throw new Error('輸出不是陣列');
    return parsed.find((server) => server?.name === MCP_NAME) ?? null;
  } catch (error) {
    throw new Error(
      `${label} 回傳無法解析的資料：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * claude／gemini 的 `mcp list` 只有人類可讀輸出且不含 env，無法用來判斷既有
 * 設定是否相容。這裡唯讀它們官方 CLI 剛寫入的設定檔；寫入永遠走 CLI。
 */
function readViaConfigFile(client) {
  const path = client.read.configPath(homedir());
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `${client.label} 設定檔無法解析：${path}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  return client.read.extract(parsed, MCP_NAME);
}

function currentRegistration(client) {
  const raw = client.read.kind === 'cli-json' ? readViaCli(client) : readViaConfigFile(client);
  return client.normalizeListed(raw, MCP_NAME);
}

function desiredState() {
  return createDesiredRegistration({
    nodePath: canonicalPath(process.execPath),
    launcherPath: LAUNCHER_PATH,
  });
}

function currentPaths() {
  return { launcherPath: LAUNCHER_PATH, distPath: DIST_PATH };
}

function registeredNodeStatus(entry) {
  const command = entry?.transport?.command;
  if (typeof command !== 'string' || !isAbsolutePortablePath(command)) {
    return { usable: false, detail: 'Node command 不是絕對路徑' };
  }
  if (!existsSync(command)) return { usable: false, detail: `Node 路徑不存在：${command}` };
  const result = run(command, ['--version'], { timeout: 5000 });
  if (result.status !== 0) {
    return { usable: false, detail: summarizeCommandFailure('登記的 Node --version', result) };
  }
  const version = result.stdout.trim();
  if (version !== `v${REQUIRED_NODE_VERSION}`) {
    return {
      usable: false,
      detail: `登記的 Node 是 ${version || '未知版本'}，需要 v${REQUIRED_NODE_VERSION}`,
    };
  }
  return { usable: true, detail: `${command}（${version}）` };
}

function classifyCurrentRegistration(entry, desired) {
  const node = registeredNodeStatus(entry);
  return {
    node,
    classification: classifyRegistration(entry, desired, currentPaths(), {
      registeredNodeUsable: node.usable,
    }),
  };
}

function requireInstallPrerequisites() {
  if (process.versions.node !== REQUIRED_NODE_VERSION) {
    throw new Error(
      `需要 Node ${REQUIRED_NODE_VERSION}，目前是 ${process.versions.node}。請先切到專案 .nvmrc 指定版本。`,
    );
  }
  if (!existsSync(LAUNCHER_PATH)) throw new Error(`找不到 launcher：${LAUNCHER_PATH}`);
  if (!existsSync(DIST_PATH)) {
    throw new Error(
      `找不到建置產物：${DIST_PATH}\n請先在這台機器執行 corepack pnpm install 與 corepack pnpm run build。`,
    );
  }
}

function mismatchMessage(client, classification) {
  const details = classification.differences.length > 0
    ? `\n- ${classification.differences.join('\n- ')}`
    : '';
  return (
    `${client.label} 已有同名 ${MCP_NAME} 設定，但與這份工作樹不相容。為避免遺失既有 timeout、tool policy 或其他設定，安裝器不會自動覆寫。` +
    `${details}\n請先確認那份設定的用途；若確定不要它，再明確執行 ${client.binary} mcp remove ${MCP_NAME}，之後重跑安裝。`
  );
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超過 ${String(timeoutMs)} ms`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function assertPortReusable(port) {
  const probe = createServer();
  try {
    probe.listen(port, '127.0.0.1');
    await withTimeout(once(probe, 'listening'), 3000, `重綁 127.0.0.1:${String(port)}`);
  } finally {
    if (probe.listening) {
      await new Promise((resolve, reject) => {
        probe.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  }
}

async function smokeRegistration(registration, label) {
  const configured = registration?.transport;
  if (configured?.type !== 'stdio') throw new Error(`${label} 不是 stdio registration`);
  if (typeof configured.command !== 'string' || !Array.isArray(configured.args)) {
    throw new Error(`${label} 缺少 command／args`);
  }

  const configuredEnvironment = {};
  for (const [key, value] of Object.entries(configured.env ?? {})) {
    if (typeof value !== 'string') throw new Error(`${label} 的 env ${key} 不是字串`);
    configuredEnvironment[key] = value;
  }

  const transportOptions = {
    command: configured.command,
    args: configured.args,
    stderr: 'pipe',
    env: {
      ...getDefaultEnvironment(),
      ...configuredEnvironment,
      MINECRAFT_EDU_WS_HOST: '127.0.0.1',
      MINECRAFT_EDU_WS_PORT: '0',
      MINECRAFT_EDU_WS_PORT_FALLBACK: '0',
    },
  };
  if (typeof configured.cwd === 'string' && configured.cwd !== '') {
    transportOptions.cwd = configured.cwd;
  }

  const transport = new StdioClientTransport(transportOptions);
  const client = new Client({ name: 'blockhand-registration-doctor', version: '1.0.0' });
  let listeningPort = null;
  try {
    await withTimeout(client.connect(transport), 15_000, `${label} initialize`);
    const [{ tools }, { resources }] = await Promise.all([
      withTimeout(client.listTools(), 5000, `${label} listTools`),
      withTimeout(client.listResources(), 5000, `${label} listResources`),
    ]);
    if (tools.length !== EXPECTED_TOOL_COUNT || resources.length !== EXPECTED_RESOURCE_COUNT) {
      throw new Error(
        `${label} 工具面不符：${String(tools.length)} tools／${String(resources.length)} resources`,
      );
    }
    const status = await client.callTool(
      { name: 'mc_status', arguments: {} },
      undefined,
      { timeout: 5000 },
    );
    listeningPort = status.structuredContent?.port;
    if (
      status.structuredContent?.listening !== true ||
      typeof listeningPort !== 'number' ||
      listeningPort <= 0
    ) {
      throw new Error(`${label} 沒有回報有效的 loopback 監聽埠`);
    }
  } finally {
    try {
      await withTimeout(client.close(), 5000, `${label} close`);
    } catch (error) {
      await withTimeout(transport.close(), 5000, `${label} transport close`).catch(() => undefined);
      throw error;
    }
  }
  if (listeningPort !== null) await assertPortReusable(listeningPort);
  return listeningPort;
}

async function install(client) {
  requireInstallPrerequisites();
  const desired = desiredState();
  const before = currentRegistration(client);
  const { classification } = classifyCurrentRegistration(before, desired);

  if (classification.kind === 'exact') {
    await smokeRegistration(before, `現有 ${client.label} entry`);
    process.stdout.write(`BlockHand 已在 ${client.label} 正確登記，沒有修改設定。\n`);
    return;
  }
  if (classification.kind === 'compatible') {
    await smokeRegistration(before, `現有 ${client.label} entry`);
    process.stdout.write(
      `BlockHand 已用同一工作樹的相容設定登記到 ${client.label}，保留既有設定不做 remove/add。\n` +
      `執行 corepack pnpm run doctor 可檢查目前 Node 與完整 MCP 生命週期。\n`,
    );
    return;
  }
  if (classification.kind !== 'missing') throw new Error(mismatchMessage(client, classification));

  // 先用將要寫入的精確 command／args／env 完成 initialize；舊 dist、錯誤
  // launcher 或不可執行 Node 都會在任何持久設定變更之前失敗。
  await smokeRegistration(desired, '待登記 entry');

  const result = run(clientCommand(client), client.buildAddArguments(desired));
  if (result.status !== 0) {
    throw new Error(summarizeCommandFailure(`${client.binary} mcp add`, result));
  }

  const after = currentRegistration(client);
  const verified = classifyCurrentRegistration(after, desired).classification;
  if (verified.kind !== 'exact') {
    throw new Error(
      `${client.label} 回報新增完成，但重新讀取後設定不一致。請執行 corepack pnpm run doctor 查看細節；安裝器沒有改寫其他 entry。`,
    );
  }

  process.stdout.write(
    `BlockHand 已登記到這台機器的 ${client.label}（${client.configHint}）。\n${client.restartHint}\n`,
  );
}

function uninstall(client) {
  const desired = desiredState();
  const existing = currentRegistration(client);
  // uninstall 是使用者明確要求的移除；ownership 只看目前工作樹 fingerprint，
  // 不要求舊 Node 仍可執行，否則 brew/nvm 搬家後反而無法清掉死 entry。
  const classification = classifyRegistration(existing, desired, currentPaths(), {
    registeredNodeUsable: true,
  });
  if (classification.kind === 'missing') {
    process.stdout.write(`BlockHand 原本就沒有登記到 ${client.label}，沒有修改設定。\n`);
    return;
  }
  if (classification.kind !== 'exact' && classification.kind !== 'compatible') {
    throw new Error(
      `同名 ${MCP_NAME} entry 不是這份工作樹可安全辨識的 BlockHand；為避免誤刪，已停止。`,
    );
  }

  const result = run(clientCommand(client), client.buildRemoveArguments(MCP_NAME));
  if (result.status !== 0) {
    throw new Error(summarizeCommandFailure(`${client.binary} mcp remove`, result));
  }
  if (currentRegistration(client) !== null) {
    throw new Error(`${client.label} 回報移除完成，但 entry 仍存在。`);
  }
  process.stdout.write(
    `已移除這台機器的 BlockHand ${client.label} 登記；專案、Minecraft 與世界都沒有刪除。\n`,
  );
}

function addCheck(checks, id, status, message, detail) {
  checks.push({ id, status, message, ...(detail === undefined ? {} : { detail }) });
}

function inspectPnpm(checks) {
  const userAgent = process.env.npm_config_user_agent ?? '';
  const match = /(?:^|\s)pnpm\/([^\s]+)/u.exec(userAgent);
  if (match?.[1] === EXPECTED_PNPM_VERSION) {
    addCheck(checks, 'pnpm-version', 'pass', `pnpm ${EXPECTED_PNPM_VERSION}`);
  } else if (match?.[1] !== undefined) {
    addCheck(
      checks,
      'pnpm-version',
      'fail',
      `目前透過 pnpm ${match[1]} 執行；專案固定 ${EXPECTED_PNPM_VERSION}`,
    );
  } else {
    addCheck(
      checks,
      'pnpm-version',
      'warn',
      `無法從執行環境確認 pnpm；建議用 corepack pnpm run doctor（固定 ${EXPECTED_PNPM_VERSION}）`,
    );
  }
}

function inspectPlatform(checks) {
  const currentPlatform = platform();
  if (currentPlatform === 'darwin') {
    const versionResult = run('/usr/bin/sw_vers', ['-productVersion']);
    if (versionResult.status !== 0) {
      addCheck(checks, 'macos-version', 'fail', '無法讀取 macOS 版本；Minecraft 真機驗收需 macOS 14+');
    } else {
      const version = versionResult.stdout.trim();
      const major = Number.parseInt(version.split('.')[0] ?? '', 10);
      addCheck(
        checks,
        'macos-version',
        Number.isFinite(major) && major >= 14 ? 'pass' : 'fail',
        `macOS ${version || '未知'}；Minecraft Education 目前最低需求為 macOS 14`,
      );
    }

    const hardware = run('/usr/bin/uname', ['-m']);
    const hardwareArch = hardware.status === 0 ? hardware.stdout.trim() : '未知';
    const nodeArch = arch();
    const translatedResult = run('/usr/sbin/sysctl', ['-in', 'sysctl.proc_translated']);
    const translated = translatedResult.status === 0 && translatedResult.stdout.trim() === '1';
    const mismatch =
      (hardwareArch === 'arm64' && nodeArch === 'x64') ||
      (hardwareArch === 'x86_64' && nodeArch === 'arm64');
    addCheck(
      checks,
      'architecture',
      mismatch || translated ? 'warn' : 'pass',
      `Node 架構 ${nodeArch}；uname ${hardwareArch}${translated ? '；Rosetta 轉譯中' : mismatch ? '（架構不一致）' : ''}`,
    );
    return;
  }

  if (currentPlatform === 'win32') {
    addCheck(checks, 'platform', 'pass', `Windows ${arch()}；用於本機回歸驗證`);
    return;
  }
  addCheck(
    checks,
    'platform',
    'fail',
    `${currentPlatform}/${arch()} 尚未列入 Minecraft Education 支援矩陣`,
  );
}

function inspectRegistration(checks, client) {
  try {
    const desired = desiredState();
    const entry = currentRegistration(client);
    const { node, classification } = classifyCurrentRegistration(entry, desired);
    if (classification.kind === 'exact') {
      addCheck(
        checks,
        'client-registration',
        'pass',
        `${client.label} 登記使用可執行的絕對 Node 與 launcher 路徑`,
        node.detail,
      );
    } else if (classification.kind === 'compatible') {
      addCheck(
        checks,
        'client-registration',
        'warn',
        `${client.label} 使用同一工作樹的相容既有設定；保留 timeout／tool policy，不強制遷移`,
        [node.detail, ...classification.differences].filter(Boolean).join('；'),
      );
    } else if (classification.kind === 'missing') {
      addCheck(
        checks,
        'client-registration',
        'fail',
        `尚未在這台機器登記到 ${client.label}；請執行 corepack pnpm run setup:${client.id}`,
      );
    } else {
      addCheck(
        checks,
        'client-registration',
        'fail',
        `同名 ${client.label} entry 與這份工作樹不相容（${classification.kind}）`,
        classification.differences.join('；'),
      );
    }
    return { entry, classification };
  } catch (error) {
    addCheck(
      checks,
      'client-cli',
      'fail',
      `無法讀取 ${client.label} MCP 設定`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

async function inspectConfiguredSmoke(checks, registrationState, client) {
  if (
    registrationState === null ||
    (registrationState.classification.kind !== 'exact' &&
      registrationState.classification.kind !== 'compatible')
  ) {
    addCheck(
      checks,
      'registered-entry-smoke',
      'fail',
      `${client.label} entry 不可用，未執行實際 registration smoke`,
    );
    return;
  }
  try {
    const port = await smokeRegistration(registrationState.entry, `${client.label} 實際 entry`);
    addCheck(
      checks,
      'registered-entry-smoke',
      'pass',
      `已用 ${client.label} 登記的 command／args／env 完成 initialize，隔離埠 ${String(port)} 已釋放`,
    );
  } catch (error) {
    addCheck(
      checks,
      'registered-entry-smoke',
      'fail',
      `${client.label} 實際 entry 無法完成 MCP initialize`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function inspectSmoke(checks) {
  if (process.versions.node !== REQUIRED_NODE_VERSION || !existsSync(DIST_PATH)) {
    addCheck(checks, 'mcp-smoke', 'fail', '缺少正確 Node 或 dist，未執行 MCP smoke');
    return;
  }
  const result = run(process.execPath, [SMOKE_PATH], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      MINECRAFT_EDU_WS_HOST: '127.0.0.1',
      MINECRAFT_EDU_WS_PORT: '0',
      MINECRAFT_EDU_WS_PORT_FALLBACK: '0',
    },
    timeout: 60_000,
  });
  if (result.status === 0) {
    addCheck(
      checks,
      'mcp-smoke',
      'pass',
      `${String(EXPECTED_TOOL_COUNT)} tools／${String(EXPECTED_RESOURCE_COUNT)} resources、stdio EOF 與監聽埠釋放通過`,
    );
  } else {
    addCheck(checks, 'mcp-smoke', 'fail', summarizeCommandFailure('stdio smoke', result));
  }
}

async function doctor({ json, client }) {
  const checks = [];
  addCheck(
    checks,
    'node-version',
    process.versions.node === REQUIRED_NODE_VERSION ? 'pass' : 'fail',
    `Node ${process.versions.node}（需要 ${REQUIRED_NODE_VERSION}）`,
    canonicalPath(process.execPath),
  );
  addCheck(
    checks,
    'build-output',
    existsSync(DIST_PATH) ? 'pass' : 'fail',
    existsSync(DIST_PATH) ? 'dist/index.js 已存在' : '缺少 dist/index.js；請先 build',
    DIST_PATH,
  );
  inspectPnpm(checks);
  inspectPlatform(checks);
  const registrationState = inspectRegistration(checks, client);
  inspectSmoke(checks);
  await inspectConfiguredSmoke(checks, registrationState, client);

  const failedIds = new Set(checks.filter((check) => check.status === 'fail').map((check) => check.id));
  const mcpReady = ![
    'node-version',
    'build-output',
    'client-cli',
    'client-registration',
    'mcp-smoke',
    'registered-entry-smoke',
  ].some((id) => failedIds.has(id));
  const minecraftPlatformSupported = !['platform', 'macos-version'].some((id) => failedIds.has(id));
  const developmentEnvironmentReady = !['node-version', 'pnpm-version', 'build-output'].some((id) =>
    failedIds.has(id),
  );
  const ok = mcpReady && minecraftPlatformSupported && developmentEnvironmentReady;
  const report = {
    ok,
    mcpReady,
    minecraftPlatformSupported,
    developmentEnvironmentReady,
    persistentChanges: false,
    projectRoot: PROJECT_ROOT,
    client: client.id,
    checks,
    macLiveVerified: false,
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `BlockHand doctor — ${client.label}（不修改持久設定、不啟動 Minecraft）\n\n`,
    );
    for (const check of checks) {
      const marker = check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗';
      process.stdout.write(`${marker} ${check.message}${check.detail ? `\n  ${check.detail}` : ''}\n`);
    }
    process.stdout.write(
      `\n${ok ? '診斷通過。' : '診斷未通過。'}Mac 遊戲 live 狀態：尚待 macOS 14+ 真機驗證。\n`,
    );
  }
  if (!ok) process.exitCode = 1;
}

function connectGuide() {
  process.stdout.write(
    `BlockHand 不會操作前景視窗或替你輸入鍵盤。\n` +
    `請在目前的 AI 對話中呼叫 mc_status，查看它回傳的 connectCommand；進入已開啟 Cheats 的 Minecraft Education 世界後，手動輸入到聊天列。\n` +
    `重連時在聊天列按 T 再按 ↑ 就能叫回上一條指令。\n` +
    `埠可能因同時開啟多個 MCP task 而變動，所以不要固定背 19131。\n`,
  );
}

function usage() {
  process.stdout.write(
    `用法（--client 預設 codex，可選 ${CLIENT_IDS.join('｜')}）：\n` +
    `  corepack pnpm blockhand install [--client=X]    在這台機器登記 MCP\n` +
    `  corepack pnpm blockhand doctor [--client=X]     執行不碰 Minecraft 的診斷\n` +
    `  corepack pnpm blockhand doctor --json           輸出結構化診斷\n` +
    `  corepack pnpm blockhand connect                 顯示安全的手動連線指引\n` +
    `  corepack pnpm blockhand uninstall [--client=X]  移除這台機器的 MCP 登記\n` +
    `\n捷徑：corepack pnpm run setup:codex｜setup:claude｜setup:gemini｜setup:grok\n`,
  );
}

class UsageError extends Error {}

function requireNoArguments(command, arguments_) {
  if (arguments_.length > 0) {
    throw new UsageError(`${command} 不接受參數：${arguments_.join(' ')}`);
  }
}

/**
 * 只認 `--client=<id>` 這一種寫法。分開的 `--client X` 會讓 `uninstall X` 這類
 * 打錯的指令看起來合法，寧可嚴格一點。未知旗標仍由 requireNoArguments 擋下。
 */
function extractClient(command, arguments_) {
  const rest = [];
  let id = 'codex';
  let seen = false;
  for (const argument of arguments_) {
    const match = /^--client=(.+)$/u.exec(argument);
    if (match === null) {
      rest.push(argument);
      continue;
    }
    if (seen) throw new UsageError(`${command} 只接受一次 --client`);
    seen = true;
    id = match[1];
  }
  try {
    return { client: resolveClient(id), rest };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function parseDoctorArguments(arguments_) {
  const { client, rest } = extractClient('doctor', arguments_);
  if (rest.length === 0) return { json: false, client };
  if (rest.length === 1 && rest[0] === '--json') return { json: true, client };
  throw new UsageError(`doctor 只接受一次 --json 與一次 --client；收到：${arguments_.join(' ')}`);
}

const [command, ...arguments_] = process.argv.slice(2);
try {
  if (command === 'install') {
    const { client, rest } = extractClient(command, arguments_);
    requireNoArguments(command, rest);
    await install(client);
  } else if (command === 'uninstall') {
    const { client, rest } = extractClient(command, arguments_);
    requireNoArguments(command, rest);
    uninstall(client);
  } else if (command === 'doctor') {
    await doctor(parseDoctorArguments(arguments_));
  } else if (command === 'connect') {
    requireNoArguments(command, arguments_);
    connectGuide();
  } else if (command === undefined || command === '--help' || command === '-h') {
    usage();
  } else {
    usage();
    throw new UsageError(`不支援的指令：${command}`);
  }
} catch (error) {
  process.stderr.write(`BlockHand：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}

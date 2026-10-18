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
const EXPECTED_TOOL_COUNT = 44;
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
      `${client.pathEnvironmentVariable} is set but is not an existing absolute path: ${configured}`,
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
  if (result.error !== null) return `${label} could not run: ${result.error.message}`;
  const detail = (result.stderr || result.stdout).trim().split(/\r?\n/u)[0];
  return `${label} failed (exit ${String(result.status)})${detail === '' ? '' : `: ${detail}`}`;
}

function readViaCli(client) {
  const label = `${client.binary} ${client.read.args.join(' ')}`;
  const result = run(clientCommand(client), client.read.args);
  if (result.status !== 0) throw new Error(summarizeCommandFailure(label, result));
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) throw new Error('output is not an array');
    return parsed.find((server) => server?.name === MCP_NAME) ?? null;
  } catch (error) {
    throw new Error(
      `${label} returned output that could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
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
      `${client.label} config file could not be parsed: ${path} (${error instanceof Error ? error.message : String(error)})`,
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
    return { usable: false, detail: 'Node command is not an absolute path' };
  }
  if (!existsSync(command)) return { usable: false, detail: `Node path does not exist: ${command}` };
  const result = run(command, ['--version'], { timeout: 5000 });
  if (result.status !== 0) {
    return { usable: false, detail: summarizeCommandFailure('registered Node --version', result) };
  }
  const version = result.stdout.trim();
  if (version !== `v${REQUIRED_NODE_VERSION}`) {
    return {
      usable: false,
      detail: `registered Node is ${version || 'an unknown version'}; v${REQUIRED_NODE_VERSION} is required`,
    };
  }
  return { usable: true, detail: `${command} (${version})` };
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
      `Node ${REQUIRED_NODE_VERSION} is required; this is ${process.versions.node}. Switch to the version in the project's .nvmrc first.`,
    );
  }
  if (!existsSync(LAUNCHER_PATH)) throw new Error(`Launcher not found: ${LAUNCHER_PATH}`);
  if (!existsSync(DIST_PATH)) {
    throw new Error(
      `Build output not found: ${DIST_PATH}\nRun corepack pnpm install and corepack pnpm run build on this machine first.`,
    );
  }
}

function mismatchMessage(client, classification) {
  const details = classification.differences.length > 0
    ? `\n- ${classification.differences.join('\n- ')}`
    : '';
  return (
    `${client.label} already has an entry named ${MCP_NAME}, but it does not match this checkout. The installer will not overwrite it, so no existing timeout, tool policy or other setting is lost.` +
    `${details}\nCheck what that entry is for first. If you are sure you do not need it, run ${client.binary} mcp remove ${MCP_NAME} yourself, then run the installer again.`
  );
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} took longer than ${String(timeoutMs)} ms`)), timeoutMs);
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
    await withTimeout(once(probe, 'listening'), 3000, `rebinding 127.0.0.1:${String(port)}`);
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
  if (configured?.type !== 'stdio') throw new Error(`${label} is not a stdio registration`);
  if (typeof configured.command !== 'string' || !Array.isArray(configured.args)) {
    throw new Error(`${label} is missing command/args`);
  }

  const configuredEnvironment = {};
  for (const [key, value] of Object.entries(configured.env ?? {})) {
    if (typeof value !== 'string') throw new Error(`env ${key} of ${label} is not a string`);
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
        `${label} has an unexpected tool surface: ${String(tools.length)} tools / ${String(resources.length)} resources`,
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
      throw new Error(`${label} did not report a valid loopback listening port`);
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
    await smokeRegistration(before, `existing ${client.label} entry`);
    process.stdout.write(`BlockHand is already registered correctly in ${client.label}; no settings were changed.\n`);
    return;
  }
  if (classification.kind === 'compatible') {
    await smokeRegistration(before, `existing ${client.label} entry`);
    process.stdout.write(
      `BlockHand is already registered in ${client.label} with a compatible entry from this checkout; it was kept as is (no remove/add).\n` +
      `Run corepack pnpm run doctor to check the current Node and the full MCP lifecycle.\n`,
    );
    return;
  }
  if (classification.kind !== 'missing') throw new Error(mismatchMessage(client, classification));

  // 先用將要寫入的精確 command／args／env 完成 initialize；舊 dist、錯誤
  // launcher 或不可執行 Node 都會在任何持久設定變更之前失敗。
  await smokeRegistration(desired, 'entry to be registered');

  const result = run(clientCommand(client), client.buildAddArguments(desired));
  if (result.status !== 0) {
    throw new Error(summarizeCommandFailure(`${client.binary} mcp add`, result));
  }

  const after = currentRegistration(client);
  const verified = classifyCurrentRegistration(after, desired).classification;
  if (verified.kind !== 'exact') {
    throw new Error(
      `${client.label} reported the entry as added, but reading it back shows a different entry. Run corepack pnpm run doctor for details; the installer did not change any other entry.`,
    );
  }

  process.stdout.write(
    `BlockHand is now registered in ${client.label} on this machine (${client.configHint}).\n${client.restartHint}\n`,
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
    process.stdout.write(`BlockHand was not registered in ${client.label}; no settings were changed.\n`);
    return;
  }
  if (classification.kind !== 'exact' && classification.kind !== 'compatible') {
    throw new Error(
      `The ${MCP_NAME} entry cannot be safely identified as BlockHand from this checkout; stopped so the wrong entry is not removed.`,
    );
  }

  const result = run(clientCommand(client), client.buildRemoveArguments(MCP_NAME));
  if (result.status !== 0) {
    throw new Error(summarizeCommandFailure(`${client.binary} mcp remove`, result));
  }
  if (currentRegistration(client) !== null) {
    throw new Error(`${client.label} reported the entry as removed, but it is still there.`);
  }
  process.stdout.write(
    `Removed the BlockHand registration from ${client.label} on this machine; the project, Minecraft and your worlds were not deleted.\n`,
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
      `Running through pnpm ${match[1]}; the project pins ${EXPECTED_PNPM_VERSION}`,
    );
  } else {
    addCheck(
      checks,
      'pnpm-version',
      'warn',
      `Could not tell the pnpm version from the environment; use corepack pnpm run doctor (pinned to ${EXPECTED_PNPM_VERSION})`,
    );
  }
}

function inspectPlatform(checks) {
  const currentPlatform = platform();
  if (currentPlatform === 'darwin') {
    const versionResult = run('/usr/bin/sw_vers', ['-productVersion']);
    if (versionResult.status !== 0) {
      addCheck(checks, 'macos-version', 'fail', 'Could not read the macOS version; live Minecraft testing needs macOS 14+');
    } else {
      const version = versionResult.stdout.trim();
      const major = Number.parseInt(version.split('.')[0] ?? '', 10);
      addCheck(
        checks,
        'macos-version',
        Number.isFinite(major) && major >= 14 ? 'pass' : 'fail',
        `macOS ${version || 'unknown'}; Minecraft Education currently needs macOS 14 or later`,
      );
    }

    const hardware = run('/usr/bin/uname', ['-m']);
    const hardwareArch = hardware.status === 0 ? hardware.stdout.trim() : 'unknown';
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
      `Node architecture ${nodeArch}; uname ${hardwareArch}${translated ? '; running under Rosetta translation' : mismatch ? ' (architectures differ)' : ''}`,
    );
    return;
  }

  if (currentPlatform === 'win32') {
    addCheck(checks, 'platform', 'pass', `Windows ${arch()}; used for local regression testing`);
    return;
  }
  addCheck(
    checks,
    'platform',
    'fail',
    `${currentPlatform}/${arch()} is not in the Minecraft Education support matrix`,
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
        `${client.label} registration uses absolute, runnable Node and launcher paths`,
        node.detail,
      );
    } else if (classification.kind === 'compatible') {
      addCheck(
        checks,
        'client-registration',
        'warn',
        `${client.label} uses a compatible existing entry from this checkout; its timeout/tool policy is kept, no forced migration`,
        [node.detail, ...classification.differences].filter(Boolean).join('; '),
      );
    } else if (classification.kind === 'missing') {
      addCheck(
        checks,
        'client-registration',
        'fail',
        `Not registered in ${client.label} on this machine yet; run corepack pnpm run setup:${client.id}`,
      );
    } else {
      addCheck(
        checks,
        'client-registration',
        'fail',
        `The ${client.label} entry with this name does not match this checkout (${classification.kind})`,
        classification.differences.join('; '),
      );
    }
    return { entry, classification };
  } catch (error) {
    addCheck(
      checks,
      'client-cli',
      'fail',
      `Could not read the ${client.label} MCP settings`,
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
      `${client.label} entry is not usable; the registered-entry smoke was skipped`,
    );
    return;
  }
  try {
    const port = await smokeRegistration(registrationState.entry, `${client.label} registered entry`);
    addCheck(
      checks,
      'registered-entry-smoke',
      'pass',
      `Initialized with the command/args/env registered in ${client.label}; isolated port ${String(port)} was released`,
    );
  } catch (error) {
    addCheck(
      checks,
      'registered-entry-smoke',
      'fail',
      `${client.label} registered entry could not complete MCP initialize`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function inspectSmoke(checks) {
  if (process.versions.node !== REQUIRED_NODE_VERSION || !existsSync(DIST_PATH)) {
    addCheck(checks, 'mcp-smoke', 'fail', 'Wrong Node version or missing dist; MCP smoke skipped');
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
      `${String(EXPECTED_TOOL_COUNT)} tools / ${String(EXPECTED_RESOURCE_COUNT)} resources, stdio EOF and listening-port release passed`,
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
    `Node ${process.versions.node} (requires ${REQUIRED_NODE_VERSION})`,
    canonicalPath(process.execPath),
  );
  addCheck(
    checks,
    'build-output',
    existsSync(DIST_PATH) ? 'pass' : 'fail',
    existsSync(DIST_PATH) ? 'dist/index.js exists' : 'dist/index.js is missing; run the build first',
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
      `BlockHand doctor — ${client.label} (changes no persistent settings, does not start Minecraft)\n\n`,
    );
    for (const check of checks) {
      const marker = check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗';
      process.stdout.write(`${marker} ${check.message}${check.detail ? `\n  ${check.detail}` : ''}\n`);
    }
    process.stdout.write(
      `\n${ok ? 'All checks passed.' : 'Some checks failed.'} Live game on Mac: not yet verified on real macOS 14+ hardware.\n`,
    );
  }
  if (!ok) process.exitCode = 1;
}

function connectGuide() {
  process.stdout.write(
    `BlockHand never touches the foreground window or types for you.\n` +
    `In your current AI conversation, call mc_status and look at the connectCommand it returns. Then, in a Minecraft Education world with Cheats on, type it into the chat yourself.\n` +
    `To reconnect, press T to open the chat, then press ↑ to bring back the last command.\n` +
    `All AI conversations share one background hub, so the command is normally /connect 127.0.0.1:19131.\n` +
    `The port differs only when an older BlockHand holds 19131 and this one falls back to standalone mode; then go by mc_status.\n`,
  );
}

function usage() {
  process.stdout.write(
    `Usage (--client defaults to codex; one of ${CLIENT_IDS.join(' | ')}):\n` +
    `  corepack pnpm blockhand install [--client=X]    register the MCP server on this machine\n` +
    `  corepack pnpm blockhand doctor [--client=X]     run checks that do not touch Minecraft\n` +
    `  corepack pnpm blockhand doctor --json           print the checks as JSON\n` +
    `  corepack pnpm blockhand connect                 show how to connect the game by hand\n` +
    `  corepack pnpm blockhand uninstall [--client=X]  remove the MCP registration from this machine\n` +
    `\nShortcuts: corepack pnpm run setup:codex | setup:claude | setup:gemini | setup:grok\n`,
  );
}

class UsageError extends Error {}

function requireNoArguments(command, arguments_) {
  if (arguments_.length > 0) {
    throw new UsageError(`${command} takes no arguments: ${arguments_.join(' ')}`);
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
    if (seen) throw new UsageError(`${command} accepts --client only once`);
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
  throw new UsageError(`doctor accepts at most one --json and one --client; got: ${arguments_.join(' ')}`);
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
    throw new UsageError(`Unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`BlockHand: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}

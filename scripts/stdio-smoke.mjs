/**
 * stdio smoke：不需要開遊戲。
 *
 * 驗證真正的 dist 產物能以 stdio 啟動、開得起 WebSocket 監聽、公開完整工具面，
 * 並在未連線時給出可照做的指示而不是靜默失敗。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

async function closeNetServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error == null) resolve();
      else reject(error);
    });
  });
}

async function listenOnAvailablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  return { server, port: address.port };
}

async function pickAvailablePort() {
  const reservation = await listenOnAvailablePort();
  await closeNetServer(reservation.server);
  return reservation.port;
}

function spawnRawServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['scripts/launch-mcp.mjs'], {
    cwd: projectRoot,
    env: {
      ...getDefaultEnvironment(),
      MINECRAFT_EDU_WS_HOST: '127.0.0.1',
      MINECRAFT_EDU_WS_PORT: String(port),
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return { child, stderr: () => stderr };
}

async function waitForOutput(processState, pattern, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!pattern.test(processState.stderr())) {
    if (processState.child.exitCode !== null || processState.child.signalCode !== null) {
      throw new Error(`MCP server 在出現 ${String(pattern)} 前退出：${processState.stderr()}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待 MCP server 輸出 ${String(pattern)} 逾時：${processState.stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise((resolve, reject) => {
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error('等待 MCP server 結束逾時'));
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await waitForExit(child);
}

async function assertPortReusable(port) {
  const probe = createServer();
  probe.listen(port, '127.0.0.1');
  await once(probe, 'listening');
  await closeNetServer(probe);
}

async function verifyStdinCleanup() {
  const lifecyclePort = await pickAvailablePort();
  const processState = spawnRawServer(lifecyclePort);
  try {
    await waitForOutput(processState, /info: ready/);
    processState.child.stdin.end();
    const exit = await waitForExit(processState.child, 3000);
    assert.equal(exit.code, 0, `STDIN EOF 後應正常結束：${processState.stderr()}`);
    assert.match(processState.stderr(), /shutting down.*stdin-/);
    await assertPortReusable(lifecyclePort);
  } finally {
    await stopChild(processState.child);
  }
}

async function verifyEarlyStdinCleanup() {
  const lifecyclePort = await pickAvailablePort();
  const processState = spawnRawServer(lifecyclePort);
  try {
    // 模擬 MCP Host 在 initialize／ready 前就取消啟動。
    processState.child.stdin.end();
    const exit = await waitForExit(processState.child, 3000);
    assert.equal(exit.code, 0, `早期 STDIN EOF 後應正常結束：${processState.stderr()}`);
    assert.match(processState.stderr(), /shutting down.*stdin-/);
    await assertPortReusable(lifecyclePort);
  } finally {
    await stopChild(processState.child);
  }
}

async function verifyOccupiedPortFailure() {
  const reservation = await listenOnAvailablePort();
  const processState = spawnRawServer(reservation.port, {
    MINECRAFT_EDU_WS_PORT_FALLBACK: '0',
  });
  try {
    const exit = await waitForExit(processState.child, 3000);
    assert.equal(exit.code, 1, `占埠時應明確失敗：${processState.stderr()}`);
    assert.match(processState.stderr(), /EADDRINUSE/);
  } finally {
    await stopChild(processState.child);
    await closeNetServer(reservation.server);
  }
}

async function verifyOccupiedPortFallback() {
  const reservation = await listenOnAvailablePort();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['scripts/launch-mcp.mjs'],
    cwd: projectRoot,
    stderr: 'pipe',
    env: {
      ...getDefaultEnvironment(),
      MINECRAFT_EDU_WS_HOST: '127.0.0.1',
      MINECRAFT_EDU_WS_PORT: String(reservation.port),
    },
  });
  const fallbackClient = new Client({ name: 'minecraft-edu-port-fallback-smoke', version: '1.0.0' });
  let fallbackPort = null;

  try {
    await fallbackClient.connect(transport);
    const status = await fallbackClient.callTool({ name: 'mc_status', arguments: {} });
    assert.equal(status.isError, false);
    assert.equal(status.structuredContent.listening, true);
    fallbackPort = status.structuredContent.port;
    assert.notEqual(fallbackPort, reservation.port, '占埠時應自動改用其他空閒埠');
    assert.equal(
      status.structuredContent.connectCommand,
      `/connect 127.0.0.1:${String(fallbackPort)}`,
    );
  } finally {
    await fallbackClient.close();
    await closeNetServer(reservation.server);
  }

  assert.equal(typeof fallbackPort, 'number');
  await assertPortReusable(fallbackPort);
}

// 舊版登記直接指向 dist/index.js。installer 會保留同一工作樹的這種相容
// 設定以免 remove/add 遺失 timeout 或 tool policy，所以 direct entry 也必須持續可啟動。
async function verifyDirectDistCompatibility() {
  const directPort = String(await pickAvailablePort());
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    cwd: projectRoot,
    stderr: 'pipe',
    env: {
      ...getDefaultEnvironment(),
      MINECRAFT_EDU_WS_HOST: '127.0.0.1',
      MINECRAFT_EDU_WS_PORT: directPort,
      MINECRAFT_EDU_WS_PORT_FALLBACK: '0',
    },
  });
  const directClient = new Client({ name: 'minecraft-edu-direct-dist-smoke', version: '1.0.0' });
  try {
    await directClient.connect(transport);
    const { tools } = await directClient.listTools();
    assert.equal(tools.length, 42);
    const status = await directClient.callTool({ name: 'mc_status', arguments: {} });
    assert.equal(status.structuredContent.connectCommand, `/connect 127.0.0.1:${directPort}`);
  } finally {
    await directClient.close();
  }
  await assertPortReusable(Number(directPort));
}

// 先取得真正空閒的埠，避免撞到使用者正在跑的橋接或平行測試。
const port = String(await pickAvailablePort());

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['scripts/launch-mcp.mjs'],
  cwd: projectRoot,
  stderr: 'pipe',
  env: {
    ...getDefaultEnvironment(),
    MINECRAFT_EDU_WS_HOST: '127.0.0.1',
    MINECRAFT_EDU_WS_PORT: port,
  },
});

const client = new Client({ name: 'minecraft-edu-stdio-smoke', version: '1.0.0' });
let toolCount = 0;

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  toolCount = names.length;
  assert.equal(names.length, 42, `預期 42 個工具，實際 ${names.length}`);
  for (const required of [
    'mc_status',
    'mc_agent_program',
    'mc_build_shape',
    'mc_build_preview',
    'mc_events_poll',
    'mc_run_command',
  ]) {
    assert.ok(names.includes(required), `缺少工具 ${required}`);
  }

  // 每個工具都必須有標題與描述，否則 MCP Host 無從判斷該不該用。
  for (const tool of tools) {
    assert.ok((tool.description ?? '').length > 10, `${tool.name} 缺少足夠描述`);
  }

  const { resources } = await client.listResources();
  assert.deepEqual(
    resources.map((resource) => resource.uri).sort(),
    ['minecraft-edu://capabilities', 'minecraft-edu://connection'],
  );

  const status = await client.callTool({ name: 'mc_status', arguments: {} });
  assert.equal(status.isError, false);
  assert.equal(status.structuredContent.listening, true, '橋接應該已在監聽');
  assert.equal(status.structuredContent.connected, false, 'smoke 不開遊戲，應為未連線');
  assert.equal(status.structuredContent.connectCommand, `/connect 127.0.0.1:${port}`);

  // 未連線時的錯誤必須帶著可照做的指示。
  const blocked = await client.callTool({
    name: 'mc_set_block',
    arguments: { position: { x: 0, y: 64, z: 0 }, block: 'stone' },
  });
  assert.equal(blocked.isError, true);
  assert.ok(blocked.content[0].text.includes('/connect'), '錯誤訊息應包含連線指示');

  // 純計算的預覽不需要連線也要能算。
  const preview = await client.callTool({
    name: 'mc_build_preview',
    arguments: {
      shape: { kind: 'sphere', center: { x: 0, y: 70, z: 0 }, radius: 10, hollow: true },
      block: 'glass',
    },
  });
  assert.equal(preview.isError, false);
  assert.ok(preview.structuredContent.blockCount > 500);
  assert.ok(
    preview.structuredContent.fillBatches < preview.structuredContent.blockCount,
    '合併後的批次數必須少於方塊數',
  );

  // 政策閘門在沒有遊戲時也要生效。
  const forbidden = await client.callTool({
    name: 'mc_run_command',
    arguments: { command: 'wsserver 10.0.0.1:1234' },
  });
  assert.equal(forbidden.isError, true);

  const catalog = await client.callTool({ name: 'mc_events_catalog', arguments: {} });
  assert.equal(catalog.isError, false);
  assert.ok(catalog.structuredContent.eventNames.includes('PlayerMessage'));
} finally {
  await client.close();
}

await verifyStdinCleanup();
await verifyEarlyStdinCleanup();
await verifyOccupiedPortFallback();
await verifyOccupiedPortFailure();
await verifyDirectDistCompatibility();
process.stdout.write(
  `Minecraft Education MCP stdio/lifecycle smoke passed（${String(toolCount)} tools）。\n`,
);

#!/usr/bin/env node
// End-to-end check of the shared hub with real processes (run after build): stdio proxies,
// a detached hub, re-attach after the hub dies, idle exit, and the standalone fallback when
// the game port is already taken. Uses isolated ports and a temp state dir.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const stateDir = mkdtempSync(join(tmpdir(), 'blockhand-hub-smoke-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const hubState = () => {
  const file = join(stateDir, 'hub.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
};

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(100);
  }
}

const wsPort = await freePort();
const controlPort = await freePort();
const env = {
  ...getDefaultEnvironment(),
  MINECRAFT_EDU_HUB: '1',
  MINECRAFT_EDU_HUB_DIR: stateDir,
  MINECRAFT_EDU_HUB_PORT: String(controlPort),
  MINECRAFT_EDU_WS_PORT: String(wsPort),
  MINECRAFT_EDU_HUB_IDLE_MS: '2000',
  MINECRAFT_EDU_ENCRYPTION: '0',
};
const expected = `/connect 127.0.0.1:${wsPort}`;
const proxies = [];

async function proxy(label) {
  const client = new Client({ name: `hub-smoke-${label}`, version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  await client.connect(transport);
  const handle = { client, transport, stderr: () => stderr };
  proxies.push(handle);
  return handle;
}

async function connectCommand(client) {
  const result = await client.callTool({ name: 'mc_status', arguments: {} });
  return result.structuredContent?.connectCommand;
}

try {
  const a = await proxy('a');
  assert.equal((await a.client.listTools()).tools.length, 44, 'proxy exposes every tool');
  assert.equal(await connectCommand(a.client), expected, 'first proxy is served by a hub on the shared port');
  const first = hubState();
  assert.ok(first !== null && alive(first.pid), 'hub process is running');
  assert.notEqual(first.pid, a.transport.pid, 'hub is a separate, detached process');

  const b = await proxy('b');
  assert.equal(await connectCommand(b.client), expected, 'second proxy sees the same game port');
  assert.equal(hubState().pid, first.pid, 'second proxy attached to the existing hub');

  await a.client.close();
  assert.equal(await connectCommand(b.client), expected, 'closing one proxy leaves the other working');

  process.kill(first.pid, 'SIGTERM');
  await waitFor(() => !alive(first.pid), 5_000, 'hub to exit after SIGTERM');
  // No tool call here: the open session's keepalive alone must bring the shared port back.
  await waitFor(() => {
    const next = hubState();
    return next !== null && next.pid !== first.pid && alive(next.pid);
  }, 8_000, 'an open session to restart the hub without any tool call');
  const second = hubState();
  assert.equal(await connectCommand(b.client), expected, 'proxy re-attaches after the hub died');
  assert.equal(hubState().pid, second.pid, 'the request used the hub the keepalive started');

  await b.client.close();
  await waitFor(() => !alive(second.pid), 8_000, 'idle hub to exit');
  assert.equal(hubState(), null, 'idle hub removed its state file');

  const squatter = createServer();
  await new Promise((resolve) => squatter.listen(wsPort, '127.0.0.1', resolve));
  try {
    const c = await proxy('c');
    const fallback = await connectCommand(c.client);
    assert.ok(typeof fallback === 'string' && fallback !== expected, 'falls back to a standalone bridge on another port');
    assert.equal(hubState(), null, 'no hub is started while the game port is taken');
    await c.client.close();
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }

  console.log('Minecraft Education MCP shared-hub smoke passed (attach, share, keepalive restart, re-attach, idle exit, fallback).');
} catch (error) {
  for (const [index, handle] of proxies.entries()) {
    process.stderr.write(`--- proxy ${index} stderr ---\n${handle.stderr()}\n`);
  }
  const log = join(stateDir, 'hub.log');
  if (existsSync(log)) process.stderr.write(`--- hub.log ---\n${readFileSync(log, 'utf8')}\n`);
  throw error;
} finally {
  await Promise.allSettled(proxies.map(async (handle) => await handle.client.close()));
  const leftover = hubState();
  if (leftover !== null && alive(leftover.pid)) process.kill(leftover.pid, 'SIGKILL');
  rmSync(stateDir, { recursive: true, force: true });
}

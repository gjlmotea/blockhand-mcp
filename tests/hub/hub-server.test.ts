import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RuntimeConfig } from '../../src/composition.js';
import { startHub, type HubHandle } from '../../src/hub/hub-server.js';
import type { HubHealth, HubSettings } from '../../src/hub/settings.js';
import { createFakeConnection, type FakeConnection } from '../integration/fake-connection.js';

const CONFIG: RuntimeConfig = {
  host: '127.0.0.1',
  port: 19131,
  fallbackToRandomPort: true,
  commandTimeoutMs: 1000,
  keepaliveIntervalMs: 30_000,
  eventBufferSize: 100,
  maxBuildBlocks: 200_000,
  stepDelayMs: 0,
  debugFrames: false,
  negotiateEncryption: false,
  undoEnabled: false,
};

let dir = '';
const hubs: HubHandle[] = [];
const clients: Client[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'blockhand-hub-'));
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(async (client) => await client.close()));
  await Promise.allSettled(hubs.splice(0).map(async (hub) => await hub.close('test-cleanup')));
  rmSync(dir, { recursive: true, force: true });
});

function settings(overrides: Partial<HubSettings> = {}): HubSettings {
  return { enabled: true, controlPort: 0, stateDir: dir, idleMs: 60_000, attachTimeoutMs: 1_000, ...overrides };
}

async function start(fake: FakeConnection, overrides?: Partial<HubSettings>): Promise<HubHandle> {
  const hub = await startHub({ version: '0.1.0-test', config: CONFIG, settings: settings(overrides), connection: fake });
  if (hub === null) throw new Error('hub did not start');
  hubs.push(hub);
  return hub;
}

async function attach(hub: HubHandle, token = hub.state.token): Promise<Client> {
  const client = new Client({ name: 'hub-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(hub.state.controlPort)}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as unknown as Transport);
  clients.push(client);
  return client;
}

async function control(hub: HubHandle, path: string, method = 'GET', token = hub.state.token): Promise<Response> {
  return await fetch(`http://127.0.0.1:${String(hub.state.controlPort)}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}

function text(result: unknown): string {
  const content = (result as { readonly content?: ReadonlyArray<{ readonly text?: string }> }).content ?? [];
  return content.map((item) => item.text ?? '').join('\n');
}

function structured(result: unknown): Record<string, unknown> {
  return ((result as { readonly structuredContent?: unknown }).structuredContent ?? {}) as Record<string, unknown>;
}

describe('shared hub', () => {
  it('serves the same tools to every session over one shared game connection', async () => {
    const hub = await start(createFakeConnection());
    const first = await attach(hub);
    const second = await attach(hub);

    const [a, b] = await Promise.all([first.listTools(), second.listTools()]);
    expect(a.tools).toHaveLength(44);
    expect(b.tools.map((tool) => tool.name)).toEqual(a.tools.map((tool) => tool.name));

    const status = await second.callTool({ name: 'mc_status', arguments: {} });
    expect(structured(status)['connectCommand']).toBe('/connect 127.0.0.1:19131');

    const health = (await (await control(hub, '/health')).json()) as HubHealth;
    expect(health).toMatchObject({ ok: true, pid: process.pid, sessions: 2, connected: true, writer: null });
  });

  it('rejects callers without the token', async () => {
    const hub = await start(createFakeConnection());
    expect((await control(hub, '/health', 'GET', 'wrong')).status).toBe(401);
    await expect(attach(hub, 'wrong')).rejects.toThrow();
  });

  it('lets one session write at a time while reads keep working', async () => {
    const fake = createFakeConnection();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fake.runCommand.bind(fake);
    fake.runCommand = async (line, options) => {
      if (line.startsWith('setblock 0 70 0')) await gate;
      return await original(line, options);
    };
    const hub = await start(fake);
    const first = await attach(hub);
    const second = await attach(hub);

    const pending = first.callTool({ name: 'mc_run_command', arguments: { command: 'setblock 0 70 0 stone' } });
    for (let i = 0; i < 100; i += 1) {
      const health = (await (await control(hub, '/health')).json()) as HubHealth;
      if (health.writer !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const blocked = await second.callTool({
      name: 'mc_set_block',
      arguments: { position: { x: 1, y: 70, z: 1 }, block: 'stone' },
    });
    expect(blocked.isError).toBe(true);
    expect(text(blocked)).toContain('Another AI session is changing the world');

    const read = await second.callTool({ name: 'mc_status', arguments: {} });
    expect(read.isError).toBeFalsy();

    release();
    expect((await pending).isError).toBeFalsy();
    const retried = await second.callTool({
      name: 'mc_set_block',
      arguments: { position: { x: 1, y: 70, z: 1 }, block: 'stone' },
    });
    expect(retried.isError).toBeFalsy();
    expect(fake.issued).toContain('setblock 1 70 1 stone');
  });

  it('never shuts down while the game is connected', async () => {
    const fake = createFakeConnection();
    const hub = await start(fake);
    expect((await control(hub, '/shutdown', 'POST')).status).toBe(409);
    fake.setConnected(false);
    expect((await control(hub, '/shutdown', 'POST')).status).toBe(200);
    await hub.closed;
    expect(existsSync(join(dir, 'hub.json'))).toBe(false);
  });

  it('exits on its own once idle with no game connected', async () => {
    const hub = await start(createFakeConnection({ connected: false }), { idleMs: 1_000 });
    expect(existsSync(join(dir, 'hub.json'))).toBe(true);
    await hub.closed;
    expect(existsSync(join(dir, 'hub.json'))).toBe(false);
  });

  it('stays up while sessions keep checking in, even with no game and no tool calls', async () => {
    const hub = await start(createFakeConnection({ connected: false }), { idleMs: 1_000 });
    let exited = false;
    void hub.closed.then(() => { exited = true; });
    for (let i = 0; i < 6; i += 1) {
      expect((await control(hub, '/keepalive', 'POST')).status).toBe(204);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    expect(exited).toBe(false);
    await hub.closed;
    expect(existsSync(join(dir, 'hub.json'))).toBe(false);
  });

  it('does not accept a keepalive without the token', async () => {
    const hub = await start(createFakeConnection());
    expect((await control(hub, '/keepalive', 'POST', 'wrong-token')).status).toBe(401);
  });

  it('steps aside when another hub already owns the control port', async () => {
    const hub = await start(createFakeConnection());
    const second = await startHub({
      version: '0.1.0-test',
      config: CONFIG,
      settings: settings({ controlPort: hub.state.controlPort }),
      connection: createFakeConnection(),
    });
    expect(second).toBeNull();
  });
});

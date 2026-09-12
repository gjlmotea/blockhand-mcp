import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composeRuntime, readRuntimeConfig } from '../../src/composition.js';
import { createMcpServer } from '../../src/server/create-server.js';
import { createUndoWorld } from '../helpers/undo-world.js';

describe('automatic Undo through the MCP boundary', () => {
  let world: ReturnType<typeof createUndoWorld>;
  let runtime: ReturnType<typeof composeRuntime>;
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError, data: result.structuredContent as Record<string, unknown> };
  };
  beforeEach(async () => {
    world = createUndoWorld();
    runtime = composeRuntime('test', { ...readRuntimeConfig(), stepDelayMs: 0, undoEnabled: true, maxUndoBlocks: 128 }, world.connection);
    server = createMcpServer({ service: runtime.service, build: runtime.build, version: 'test' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'undo-test', version: '1' });
    await Promise.all([client.connect(a), server.connect(b)]);
  });
  afterEach(async () => {
    await runtime.connection.close();
    await client.close();
    await server.close();
  });
  it('exposes settings, native outcome history, and undo with validated schemas', async () => {
    expect((await call('mc_undo_control')).data).toMatchObject({ enabled: true, maxBlocks: 128, state: 'empty' });
    expect(world.issued).toHaveLength(0);
    const edit = await call('mc_set_block', { position: { x: 0, y: 20, z: 0 }, block: 'glass' });
    expect(edit.error).toBeFalsy();
    expect(edit.data['undo']).toMatchObject({ available: true, storedBlocks: 1 });
    const id = (edit.data['undo'] as { operationId: string }).operationId;
    expect((await call('mc_undo', { operationId: 'stale' })).error).toBe(true);
    const restored = await call('mc_undo', { operationId: id });
    expect(restored.error).toBeFalsy();
    expect(restored.data).toMatchObject({ state: 'empty', storedBlocks: 0 });
    expect(world.get(0, 20, 0).block).toBe('air');
  });
  it('reports a command timeout without presenting the socket as a healthy game', async () => {
    const originalStatus = runtime.service.status;
    runtime.service.status = () => ({ ...originalStatus(), commandState: 'timed-out',
      lastCommandTimeoutAt: '2026-09-12T14:00:00.000Z', lastCommandResponseAt: null });
    const result = await client.callTool({ name: 'mc_status', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ connected: true, commandState: 'timed-out' });
    expect(JSON.stringify(result.content)).toContain('最近指令未獲回覆');
  });
  it('groups a multi-material blueprint into one restorable operation', async () => {
    const result = await call('mc_build_blueprint', { entries: [
      { position: { x: 0, y: 20, z: 0 }, block: 'stone' },
      { position: { x: 1, y: 20, z: 0 }, block: 'glass' },
    ] });
    expect(result.error).toBeFalsy();
    expect(result.data['undo']).toMatchObject({ available: true, storedBlocks: 2 });
    expect((await call('mc_undo')).error).toBeFalsy();
    expect(world.get(0, 20, 0).block).toBe('air');
    expect(world.get(1, 20, 0).block).toBe('air');
  });
  it('protects shapes and raw batches with the same budget', async () => {
    const shape = await call('mc_build_shape', { shape: { kind: 'box', from: { x: 0, y: 20, z: 0 }, to: { x: 2, y: 22, z: 2 } }, block: 'glass' });
    expect(shape.error).toBeFalsy();
    expect(shape.data['undo']).toMatchObject({ available: true, storedBlocks: 27 });
    await call('mc_undo');
    const batch = await call('mc_run_commands', { commands: ['setblock 0 20 0 stone', 'setblock 1 20 0 glass'], reportFailuresOnly: true });
    expect(batch.error).toBeFalsy();
    expect(batch.data['outcomes']).toEqual([]);
    expect(batch.data['undo']).toMatchObject({ storedBlocks: 2 });
    const before = world.issued.length;
    expect((await call('mc_run_command', { command: 'fill 0 20 0 20 40 20 stone' })).error).toBe(true);
    expect(world.issued).toHaveLength(before);
  });
  it('returns conflict errors without clobbering player work', async () => {
    await call('mc_run_command', { command: 'setblock 0 20 0 glass' });
    world.put(0, 20, 0, 'diamond_block');
    expect((await call('mc_undo')).error).toBe(true);
    expect(world.get(0, 20, 0).block).toBe('diamond_block');
    expect((await call('mc_status')).data['undo']).toMatchObject({ state: 'ready', snapshotCount: 1 });
  });
  it('opt-out preserves the legacy full-size command path', async () => {
    await call('mc_undo_control', { action: 'configure', enabled: false });
    const result = await call('mc_run_command', { command: 'fill 0 20 0 15 30 15 stone' });
    expect(result.error).toBeFalsy();
    expect(result.data['undo']).toMatchObject({ enabled: false, storedBlocks: 0 });
    expect(world.issued).toEqual(['fill 0 20 0 15 30 15 stone']);
  });
});

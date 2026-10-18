import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { composeRuntime } from '../../src/composition.js';
import { createMcpServer } from '../../src/server/create-server.js';
import { createStdioTransport } from '../../src/transports/stdio.js';
import { createFakeConnection } from '../integration/fake-connection.js';

const SDK_DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * schema 允許、而且超過 SDK 預設 10 MiB 的藍圖：20,000 格，座標用最長的安全整數，
 * blockStates 塞滿要跳脫的引號（每個在 JSON 裡占 2 bytes）。
 */
function oversizedBlueprintCall(id: number): string {
  const states = `[${'"'.repeat(198)}]`;
  const entries = Array.from({ length: 20_000 }, (_, i) => ({
    position: { x: -9_007_199_254_740_991 + i, y: -9_007_199_254_740_991, z: -9_007_199_254_740_991 },
    block: 'a'.repeat(80),
    blockStates: states,
  }));
  const line = `${JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'mc_blueprint_preview', arguments: { entries } },
  })}\n`;
  expect(Buffer.byteLength(line)).toBeGreaterThan(SDK_DEFAULT_MAX_BUFFER);
  return line;
}

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('stdio transport 的訊息上限', () => {
  it('超過 SDK 預設 10 MiB 的單一訊息仍會送達，transport 不會關閉', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = createStdioTransport(stdin, stdout);
    const received: unknown[] = [];
    const errors: Error[] = [];
    let closed = false;
    transport.onmessage = (message) => received.push(message);
    transport.onerror = (error) => errors.push(error);
    transport.onclose = () => {
      closed = true;
    };
    await transport.start();

    stdin.write(oversizedBlueprintCall(1));
    await waitFor(() => received.length > 0 || errors.length > 0 || closed);

    expect(errors.map((error) => error.message)).toEqual([]);
    expect(closed).toBe(false);
    expect(received).toHaveLength(1);
    await transport.close();
  });

  it('經過真正的 server，最大量級的藍圖請求拿得到回應', async () => {
    const fake = createFakeConnection();
    const runtime = composeRuntime('0.1.0-test', {
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
    }, fake);
    const server = createMcpServer({ service: runtime.service, build: runtime.build, version: '0.1.0-test' });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let output = '';
    stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    await server.connect(createStdioTransport(stdin, stdout));

    stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1.0.0' } },
    })}\n`);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    stdin.write(oversizedBlueprintCall(2));

    const responses = (): Array<{ id?: number }> =>
      output.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as { id?: number });
    await waitFor(() => responses().some((message) => message.id === 2));
    expect(responses().find((message) => message.id === 2)).toHaveProperty('result');
    await server.close();
  }, 30_000);
});

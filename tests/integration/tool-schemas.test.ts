import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { composeRuntime } from '../../src/composition.js';
import { createMcpServer } from '../../src/server/create-server.js';
import { createFakeConnection } from './fake-connection.js';

const CONFIG = {
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
};

/** 回傳 schema 裡所有 `$ref` 的出現位置，方便失敗時直接指出是哪個欄位。 */
function findRefs(node: unknown, path: string[] = []): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => findRefs(item, [...path, String(index)]));
  }
  if (typeof node !== 'object' || node === null) return [];

  const found: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref') {
      found.push(`${[...path, key].join('.')} → ${String(value)}`);
      continue;
    }
    found.push(...findRefs(value, [...path, key]));
  }
  return found;
}

describe('工具 JSON Schema', () => {
  let client: Client;

  beforeEach(async () => {
    const runtime = composeRuntime('0.1.0-test', CONFIG, createFakeConnection());
    const server = createMcpServer({
      service: runtime.service,
      build: runtime.build,
      version: '0.1.0-test',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'minecraft-edu-schema-test', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  /**
   * 這條是回歸測試，不是風格檢查。
   *
   * SDK 用的 zod-to-json-schema 會把重複出現的**同一個 schema 實例**折成
   * `$ref`。曾經因此讓 `mc_ticking_area` 的 `to` 變成 `{"$ref":"#/properties/from"}`，
   * 不解析內部 $ref 的 MCP Host 會把它當成字串送出，工具直接不能用。
   *
   * 修法是把 src/server/schemas.ts 的共用片段都做成 factory function；
   * 只要有人改回模組層級的 const，這裡就會亮紅燈。
   */
  it('沒有任何工具的 inputSchema 含 $ref', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);

    const offenders = tools
      .map((tool) => ({ name: tool.name, refs: findRefs(tool.inputSchema) }))
      .filter((entry) => entry.refs.length > 0);

    expect(offenders).toEqual([]);
  });

  it('沒有任何工具的 outputSchema 含 $ref', async () => {
    const { tools } = await client.listTools();

    const offenders = tools
      .map((tool) => ({ name: tool.name, refs: findRefs(tool.outputSchema) }))
      .filter((entry) => entry.refs.length > 0);

    expect(offenders).toEqual([]);
  });

  /** 具體釘住當初炸掉的那個欄位，讓回歸時的失敗訊息一眼可讀。 */
  it('mc_ticking_area 的 from／to 都是展開的物件 schema', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((candidate) => candidate.name === 'mc_ticking_area');
    expect(tool).toBeDefined();

    const properties = (tool?.inputSchema as { properties?: Record<string, unknown> }).properties;
    for (const field of ['from', 'to']) {
      const shape = properties?.[field] as { type?: string; properties?: Record<string, unknown> };
      expect(shape.type, `${field} 應該是 object`).toBe('object');
      expect(Object.keys(shape.properties ?? {}).sort()).toEqual(['mode', 'x', 'y', 'z']);
    }
  });
});

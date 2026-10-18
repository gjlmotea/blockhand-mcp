import type { Readable, Writable } from 'node:stream';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * 單一 stdio 訊息的上限，與共用中樞的 HTTP body 上限（hub-server.ts 的 MAX_BODY_BYTES）一致。
 *
 * SDK 預設 10 MiB，但 schema 允許的最大藍圖會超過它（blockStates 全是要跳脫的字元時約
 * 11 MiB）。超過時 SDK 不是只拒絕那一則，而是關掉整條 transport，整個工作階段就斷了。
 */
export const STDIO_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** 直接連 stdio 與共用中樞的代理都用這個建 transport，兩邊的上限才會一致。 */
export function createStdioTransport(stdin?: Readable, stdout?: Writable): StdioServerTransport {
  return new StdioServerTransport(stdin, stdout, { maxBufferSize: STDIO_MAX_BUFFER_BYTES });
}

export async function connectStdio(server: McpServer): Promise<StdioServerTransport> {
  const transport = createStdioTransport();
  await server.connect(transport);
  return transport;
}

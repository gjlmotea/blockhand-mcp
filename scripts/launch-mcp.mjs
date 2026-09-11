#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { REQUIRED_NODE_VERSION } from './lib/mcp-registration.mjs';

const RUNTIME_URL = new URL('../dist/index.js', import.meta.url);
const RUNTIME_PATH = fileURLToPath(RUNTIME_URL);

function fail(message, error) {
  const detail = error instanceof Error ? `：${error.message}` : '';
  process.stderr.write(`[blockhand-launcher] ${message}${detail}\n`);
  process.exitCode = 1;
}

if (process.versions.node !== REQUIRED_NODE_VERSION) {
  fail(
    `需要 Node ${REQUIRED_NODE_VERSION}，目前是 ${process.versions.node}。請用正確 Node 重新執行安裝登記。`,
  );
} else if (!existsSync(RUNTIME_PATH)) {
  fail(`找不到建置產物 ${RUNTIME_PATH}。請先在這台機器執行 corepack pnpm install 與 corepack pnpm run build。`);
} else {
  try {
    const runtime = await import(RUNTIME_URL.href);
    if (typeof runtime.main !== 'function') {
      fail('建置產物沒有公開 main()，請重新 build。');
    } else {
      try {
        await runtime.main();
      } catch (error) {
        if (typeof runtime.reportFatal === 'function') runtime.reportFatal(error);
        else fail('MCP 啟動失敗', error);
      }
    }
  } catch (error) {
    fail('無法載入 MCP 建置產物', error);
  }
}

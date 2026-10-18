#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { REQUIRED_NODE_VERSION } from './lib/mcp-registration.mjs';

const RUNTIME_URL = new URL('../dist/index.js', import.meta.url);
const RUNTIME_PATH = fileURLToPath(RUNTIME_URL);

function fail(message, error) {
  const detail = error instanceof Error ? `: ${error.message}` : '';
  process.stderr.write(`[blockhand-launcher] ${message}${detail}\n`);
  process.exitCode = 1;
}

if (process.versions.node !== REQUIRED_NODE_VERSION) {
  fail(
    `Node ${REQUIRED_NODE_VERSION} is required; this is ${process.versions.node}. Run the installer again with the right Node.`,
  );
} else if (!existsSync(RUNTIME_PATH)) {
  fail(`Build output not found: ${RUNTIME_PATH}. Run corepack pnpm install and corepack pnpm run build on this machine first.`);
} else {
  try {
    const runtime = await import(RUNTIME_URL.href);
    if (typeof runtime.main !== 'function') {
      fail('The build output does not export main(); rebuild it.');
    } else {
      try {
        await runtime.main();
      } catch (error) {
        if (typeof runtime.reportFatal === 'function') runtime.reportFatal(error);
        else fail('MCP server failed to start', error);
      }
    }
  } catch (error) {
    fail('Could not load the MCP build output', error);
  }
}

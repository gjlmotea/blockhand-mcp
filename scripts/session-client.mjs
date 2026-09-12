#!/usr/bin/env node
/** Keep this CLI in a terminal/PTY session. JSON-line requests return job status without waiting on a build. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createSessionQueue } from './lib/session-queue.mjs';

const flag = process.argv.indexOf('--state');
if (flag < 0 || !process.argv[flag + 1]) {
  process.stderr.write('Usage: node scripts/session-client.mjs --state <new checkpoint.json>\n');
  process.exit(2);
}
const statePath = resolve(process.argv[flag + 1]);
// Never overwrite evidence of an earlier run; the operator must inspect it before constructing a continuation.
if (existsSync(statePath)) {
  process.stderr.write(`Checkpoint already exists; inspect it and use a new path: ${statePath}\n`);
  process.exit(2);
}
mkdirSync(dirname(statePath), { recursive: true });
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('./launch-mcp.mjs', import.meta.url))],
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: {
    ...getDefaultEnvironment(),
    MINECRAFT_EDU_WS_HOST: '127.0.0.1',
    MINECRAFT_EDU_WS_PORT: process.env.MINECRAFT_EDU_WS_PORT ?? '19131',
    MINECRAFT_EDU_WS_PORT_FALLBACK: process.env.MINECRAFT_EDU_WS_PORT_FALLBACK ?? '1',
  },
  stderr: 'pipe',
});
transport.stderr?.on('data', chunk => process.stderr.write(chunk));
const client = new Client({ name: 'blockhand-persistent-session', version: '1.0.0' });
const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
const queue = createSessionQueue({
  call,
  save(state) {
    const temporary = `${statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(temporary, statePath);
  },
  publish: state => emit({ event: 'build-progress', state }),
});
let callBusy = false;
let closing;
function close() {
  closing ??= (async () => {
    try { await client.close(); }
    finally { await queue.finished(); }
  })();
  return closing;
}
process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });
try {
  await client.connect(transport);
  emit({ event: 'ready', result: await call('mc_status'), checkpoint: statePath });
  const input = createInterface({ input: process.stdin });
  input.on('line', line => {
    void (async () => {
      let request;
      try {
        request = JSON.parse(line);
        if (closing) throw new Error('Session is closing.');
        if (request.action === 'status') {
          emit({ id: request.id, state: queue.snapshot(), callBusy }); return;
        }
        if (queue.busy() || callBusy) throw new Error('Session busy; use action=status.');
        if (request.action === 'run') {
          const commands = request.commandsFile ? JSON.parse(readFileSync(resolve(request.commandsFile), 'utf8')) : request.commands;
          emit({ id: request.id, accepted: true, state: queue.submit(commands) }); return;
        }
        if (request.action === 'call') {
          if (typeof request.name !== 'string') throw new Error('call requires name.');
          callBusy = true;
          try { emit({ id: request.id, result: await call(request.name, request.args) }); }
          finally { callBusy = false; }
          return;
        }
        if (request.action === 'close') { input.close(); await close(); return; }
        throw new Error('Use action=status, run, call, or close.');
      } catch (error) {
        emit({ id: request?.id, error: error instanceof Error ? error.message : String(error), state: queue.snapshot() });
      }
    })();
  });
  await new Promise(resolve => input.once('close', resolve));
} finally {
  await close();
}

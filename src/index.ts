#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeRuntime, readRuntimeConfig } from './composition.js';
import { log } from './logger.js';
import { createMcpServer } from './server/create-server.js';
import { connectStdio } from './transports/stdio.js';

const PACKAGE_URL = new URL('../package.json', import.meta.url);
const FORCED_EXIT_TIMEOUT_MS = 3000;

async function readVersion(): Promise<string> {
  try {
    const raw = await readFile(PACKAGE_URL, 'utf8');
    const parsed = JSON.parse(raw) as { readonly version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function main(): Promise<void> {
  const version = await readVersion();
  const config = readRuntimeConfig();
  const runtime = composeRuntime(version, config);
  let server: ReturnType<typeof createMcpServer> | null = null;
  let bridgeStarted = false;
  let startupComplete = false;
  let shutdownRequested: string | null = null;
  let shutdownPromise: Promise<void> | null = null;

  const onStdinEnd = (): void => {
    requestShutdown('stdin-end');
  };
  const onStdinClose = (): void => {
    requestShutdown('stdin-close');
  };
  const onStdinError = (error: NodeJS.ErrnoException): void => {
    process.exitCode = 1;
    log('error', 'stdin error', { detail: error.message });
    requestShutdown('stdin-error');
  };
  const onSigint = (): void => {
    requestShutdown('SIGINT');
  };
  const onSigterm = (): void => {
    requestShutdown('SIGTERM');
  };
  const onStdoutError = (error: NodeJS.ErrnoException): void => {
    if (error.code !== 'EPIPE') {
      process.exitCode = 1;
      log('error', 'stdout error', { detail: error.message });
    }
    requestShutdown(error.code === 'EPIPE' ? 'stdout-EPIPE' : 'stdout-error');
  };

  function removeShutdownHandlers(): void {
    process.stdin.off('end', onStdinEnd);
    process.stdin.off('close', onStdinClose);
    process.stdin.off('error', onStdinError);
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    process.stdout.off('error', onStdoutError);
  }

  async function closeResources(reason: string): Promise<boolean> {
    log('info', 'shutting down', { reason });

    const targets: Array<{ readonly name: string; readonly close: () => Promise<void> }> = [];
    if (server !== null) {
      const activeServer = server;
      targets.push({ name: 'stdio', close: async () => await activeServer.close() });
    }
    if (bridgeStarted) {
      targets.push({ name: 'websocket-bridge', close: async () => await runtime.connection.close() });
    }

    const results = await Promise.allSettled(targets.map(async (target) => await target.close()));
    let allClosed = true;
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') continue;
      allClosed = false;
      process.exitCode = 1;
      log('error', 'shutdown failure', {
        target: targets[index]?.name ?? 'unknown',
        detail: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }

    removeShutdownHandlers();
    return allClosed;
  }

  function shutdown(reason: string): Promise<void> {
    if (shutdownPromise === null) {
      const forcedExit = setTimeout(() => {
        log('error', 'shutdown timeout; forcing process exit', {
          reason,
          timeoutMs: FORCED_EXIT_TIMEOUT_MS,
        });
        process.exit(process.exitCode ?? 0);
      }, FORCED_EXIT_TIMEOUT_MS);
      forcedExit.unref();
      shutdownPromise = closeResources(reason).then((allClosed) => {
        // 任一 close 失敗時保留 hard-stop timer；只要還有第三方 handle 卡住，
        // 到期就由作業系統回收整個子程序與監聽埠。
        if (allClosed) clearTimeout(forcedExit);
      });
    }
    return shutdownPromise;
  }

  function requestShutdown(reason: string): void {
    shutdownRequested ??= reason;
    if (startupComplete) void shutdown(shutdownRequested);
  }

  // 先掛生命週期 listener，再做任何非同步啟動；Host 若在 initialize 前就
  // 關閉 STDIN，也一定會被記住並在已啟動資源可安全關閉時執行。
  process.stdin.once('end', onStdinEnd);
  process.stdin.once('close', onStdinClose);
  process.stdin.on('error', onStdinError);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.stdout.on('error', onStdoutError);

  if (process.stdin.readableEnded || process.stdin.destroyed) {
    startupComplete = true;
    await shutdown('stdin-already-closed');
    return;
  }

  try {
    await runtime.connection.start();
    bridgeStarted = true;

    if (shutdownRequested !== null) {
      startupComplete = true;
      await shutdown(shutdownRequested);
      return;
    }

    server = createMcpServer({
      service: runtime.service,
      build: runtime.build,
      version,
    });
    await connectStdio(server);
    startupComplete = true;
  } catch (error: unknown) {
    await closeResources('startup-failure');
    throw error;
  }

  if (shutdownRequested !== null || process.stdin.readableEnded || process.stdin.destroyed) {
    await shutdown(shutdownRequested ?? 'stdin-already-closed');
    return;
  }

  const status = runtime.service.status();
  log('info', 'ready', {
    version,
    transport: 'stdio',
    bridge: `${status.host}:${String(status.port)}`,
    connectCommand: status.connectCommand,
    networkAccess: 'loopback-websocket-only',
    filesystemWrites: false,
  });
}

export function reportFatal(error: unknown): void {
  log('error', 'fatal', {
    detail: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
  const forcedExit = setTimeout(() => {
    process.exit(1);
  }, FORCED_EXIT_TIMEOUT_MS);
  forcedExit.unref();
}

function canonicalPath(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return resolve(value);
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  canonicalPath(invokedPath) === canonicalPath(fileURLToPath(import.meta.url))
) {
  void main().catch(reportFatal);
}

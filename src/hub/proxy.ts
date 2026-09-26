import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isInitializeRequest, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { log } from '../logger.js';
import {
  buildId,
  fetchHealth,
  hubLogFile,
  readHubState,
  requestHubShutdown,
  type HubSettings,
  type HubState,
} from './settings.js';

const MAX_LOG_BYTES = 1024 * 1024;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(150);
  }
}

function spawnHub(settings: HubSettings): void {
  mkdirSync(settings.stateDir, { recursive: true, mode: 0o700 });
  const logPath = hubLogFile(settings.stateDir);
  try {
    if (statSync(logPath).size > MAX_LOG_BYTES) renameSync(logPath, `${logPath}.1`);
  } catch {
    // No log yet.
  }
  const logFd = openSync(logPath, 'a');
  try {
    const entry = fileURLToPath(new URL('../index.js', import.meta.url));
    spawn(process.execPath, [entry, '--hub'], {
      detached: true,
      stdio: ['ignore', 'ignore', logFd],
      windowsHide: true,
      env: process.env,
    }).unref();
  } finally {
    closeSync(logFd);
  }
}

/** Finds a live hub for this build, starting one if needed. Null means run standalone instead. */
export async function ensureHub(settings: HubSettings, version: string, wsPort: number): Promise<HubState | null> {
  const current = readHubState(settings.stateDir);
  let replacedOld = false;
  if (current !== null) {
    const health = await fetchHealth(current);
    if (health !== null) {
      if (health.build === buildId(version)) return current;
      if (health.connected) {
        log('info', 'shared hub runs an older build; keeping it while the game is connected', { hubBuild: health.build });
        return current;
      }
      await requestHubShutdown(current);
      await waitUntil(async () => (await fetchHealth(current, 500)) === null, 5_000);
      replacedOld = true;
    }
  }
  if (!(await waitUntil(async () => await portIsFree(wsPort), replacedOld ? 5_000 : 0))) {
    log('info', 'the shared game port is held by another bridge; not starting a hub', { wsPort });
    return null;
  }
  spawnHub(settings);
  const attached = await waitUntil(async () => {
    const state = readHubState(settings.stateDir);
    return state !== null && (await fetchHealth(state, 500)) !== null;
  }, settings.attachTimeoutMs);
  return attached ? readHubState(settings.stateDir) : null;
}

/**
 * Relays this process's stdio MCP traffic to the shared hub unchanged, so every tool, schema and
 * description is exactly the hub's. If the hub goes away (idle exit, rebuild), the next request
 * re-attaches by replaying the client's original initialize on a fresh hub session.
 */
export async function runProxy(settings: HubSettings, version: string, wsPort: number): Promise<'attached' | 'unavailable'> {
  const first = await ensureHub(settings, version, wsPort);
  if (first === null) return 'unavailable';

  const stdio = new StdioServerTransport();
  let initialize: (JSONRPCMessage & { readonly id: string | number }) | null = null;
  let initialized: JSONRPCMessage | null = null;
  let reattaching: Promise<boolean> | null = null;
  let closing = false;

  const deliver = (message: JSONRPCMessage): void => {
    void stdio.send(message).catch((error: unknown) => {
      log('error', 'proxy stdout write failed', { detail: detail(error) });
    });
  };

  function connectUpstream(state: HubState): StreamableHTTPClientTransport {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(state.controlPort)}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${state.token}` } },
    });
    transport.onmessage = (message) => {
      adoptProtocolVersion(transport, message, initialize?.id);
      deliver(message);
    };
    transport.onerror = (error) => {
      if (!closing) log('error', 'hub transport error', { detail: error.message });
    };
    return transport;
  }

  function adoptProtocolVersion(
    transport: StreamableHTTPClientTransport,
    message: JSONRPCMessage,
    initializeId: string | number | undefined,
  ): void {
    if (initializeId === undefined || !('id' in message) || message.id !== initializeId || !('result' in message)) return;
    const version = (message.result as { readonly protocolVersion?: unknown }).protocolVersion;
    if (typeof version === 'string') transport.setProtocolVersion(version);
  }

  let upstream = connectUpstream(first);
  await upstream.start();

  async function reattach(replayInitialize: boolean): Promise<boolean> {
    reattaching ??= (async () => {
      await upstream.close().catch(() => undefined);
      const state = await ensureHub(settings, version, wsPort);
      if (state === null) return false;
      const candidate = connectUpstream(state);
      await candidate.start();
      if (replayInitialize && initialize !== null) {
        const replayId = `blockhand-proxy-replay-${String(Date.now())}`;
        const acknowledged = new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 5_000);
          candidate.onmessage = (message) => {
            if ('id' in message && message.id === replayId) {
              clearTimeout(timer);
              adoptProtocolVersion(candidate, message, replayId);
              resolve(!('error' in message));
            } else {
              deliver(message);
            }
          };
        });
        await candidate.send({ ...initialize, id: replayId });
        const ok = await acknowledged;
        candidate.onmessage = (message) => {
          adoptProtocolVersion(candidate, message, initialize?.id);
          deliver(message);
        };
        if (!ok) {
          await candidate.close().catch(() => undefined);
          return false;
        }
        if (initialized !== null) await candidate.send(initialized);
      }
      upstream = candidate;
      log('info', 'reattached to the shared hub', { controlPort: state.controlPort });
      return true;
    })().finally(() => {
      reattaching = null;
    });
    return await reattaching;
  }

  async function forward(message: JSONRPCMessage): Promise<void> {
    const isInitialize = isInitializeRequest(message);
    if (isInitialize && 'id' in message) initialize = message as unknown as JSONRPCMessage & { readonly id: string | number };
    else if ('method' in message && message.method === 'notifications/initialized') initialized = message;
    let failure: unknown;
    try {
      await upstream.send(message);
      return;
    } catch (error) {
      failure = error;
    }
    if (closing) return;
    log('error', 'hub request failed; reattaching', { detail: detail(failure) });
    if (await reattach(!isInitialize)) {
      try {
        await upstream.send(message);
        return;
      } catch (error) {
        failure = error;
      }
    }
    if ('id' in message && 'method' in message) {
      deliver({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: `無法連到 Minecraft 中樞 bridge：${detail(failure)}` },
      });
    }
  }

  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log('info', 'proxy shutting down', { reason });
    await upstream.terminateSession().catch(() => undefined);
    await upstream.close().catch(() => undefined);
    await stdio.close().catch(() => undefined);
    setTimeout(() => process.exit(process.exitCode ?? 0), 1_000).unref();
  };

  stdio.onmessage = (message) => {
    void forward(message);
  };
  stdio.onerror = (error) => {
    log('error', 'proxy stdio error', { detail: error.message });
  };
  process.stdin.once('end', () => void shutdown('stdin-end'));
  process.stdin.once('close', () => void shutdown('stdin-close'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdout.on('error', () => void shutdown('stdout-error'));
  await stdio.start();

  log('info', 'attached to the shared hub', {
    controlPort: first.controlPort,
    connectCommand: `/connect 127.0.0.1:${String(first.wsPort)}`,
  });
  return 'attached';
}

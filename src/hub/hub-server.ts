import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { composeRuntime, type RuntimeConfig } from '../composition.js';
import { log } from '../logger.js';
import type { MinecraftConnection } from '../ports/minecraft-connection.js';
import { createMcpServer } from '../server/create-server.js';
import {
  buildId,
  newToken,
  removeHubState,
  tokenMatches,
  writeHubState,
  type HubHealth,
  type HubSettings,
  type HubState,
} from './settings.js';
import { WriteLock } from './write-lock.js';

/**
 * 最大的合法請求是 20,000 格的藍圖：每格欄位都填到 schema 上限時約 7.4 MiB，
 * blockStates 全是需要跳脫的字元時約 11.2 MiB。32 MiB 留了餘裕。
 * token 在讀 body 之前就驗；body 也由這裡讀完再交給 SDK，所以 SDK 自己讀 body 的路徑不會經過。
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const STALE_SESSION_MS = 30 * 60_000;
// Subscriptions change what the bridge buffers, not the world.
const LOCK_EXEMPT = new Set(['mc_events_subscribe', 'mc_events_unsubscribe']);

export interface HubHandle {
  readonly state: HubState;
  readonly close: (reason: string) => Promise<void>;
  readonly closed: Promise<void>;
}

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

function listen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return chunks.length === 0 ? undefined : (JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The shared hub owns the fixed game port and the one live game connection; every AI session's
 * MCP process is a thin proxy that talks to it over loopback Streamable HTTP. Returns null when
 * another hub already owns the control port.
 */
export async function startHub(options: {
  readonly version: string;
  readonly config: RuntimeConfig;
  readonly settings: HubSettings;
  readonly connection?: MinecraftConnection;
}): Promise<HubHandle | null> {
  const { version, config, settings } = options;
  const http = createServer();
  // The control port doubles as the election lock: whoever binds it first is the hub.
  if (!(await listen(http, settings.controlPort))) return null;

  const runtime = composeRuntime(version, { ...config, fallbackToRandomPort: false }, options.connection);
  try {
    await runtime.connection.start();
  } catch (error) {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    throw error;
  }

  const token = newToken();
  const state: HubState = {
    pid: process.pid,
    controlPort: (http.address() as AddressInfo).port,
    wsPort: runtime.service.status().port,
    token,
    build: buildId(version),
    startedAt: new Date().toISOString(),
  };
  const lock = new WriteLock();
  const sessions = new Map<string, Session>();
  let lastActivity = Date.now();
  let lastConnected = Date.now();
  let closing: Promise<void> | null = null;
  let markClosed = (): void => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const health = (): HubHealth => ({
    ok: true,
    pid: process.pid,
    build: state.build,
    version,
    wsPort: state.wsPort,
    connected: runtime.service.status().connected,
    sessions: sessions.size,
    writer: lock.holder?.session ?? null,
  });

  async function openSession(): Promise<StreamableHTTPServerTransport> {
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, lastSeen: Date.now() });
        log('info', 'hub session opened', { sessions: sessions.size });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined && sessions.delete(transport.sessionId)) {
        log('info', 'hub session closed', { sessions: sessions.size });
      }
    };
    const server = createMcpServer({
      service: runtime.service,
      build: runtime.build,
      version,
      guardWrite: (tool, work) =>
        LOCK_EXEMPT.has(tool) ? work() : lock.run(transport.sessionId ?? 'initializing', tool, work),
    });
    // The SDK types onclose as optional, which exactOptionalPropertyTypes rejects for Transport.
    await server.connect(transport as unknown as Transport);
    return transport;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!tokenMatches(token, request.headers.authorization)) {
      response.writeHead(401).end();
      return;
    }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && path === '/health') {
      sendJson(response, 200, health());
      return;
    }
    if (request.method === 'POST' && path === '/shutdown') {
      // Never drop a live game connection on another session's behalf.
      if (runtime.service.status().connected) {
        sendJson(response, 409, { ok: false, reason: 'game-connected' });
        return;
      }
      sendJson(response, 200, { ok: true });
      void close('shutdown-request');
      return;
    }
    if (request.method === 'POST' && path === '/keepalive') {
      // 閒置的對話不送任何 MCP 請求，只看 /mcp 流量會誤判沒人在用；報到也算活動。
      lastActivity = Date.now();
      response.writeHead(204).end();
      return;
    }
    if (path !== '/mcp') {
      response.writeHead(404).end();
      return;
    }

    lastActivity = Date.now();
    const body = request.method === 'POST' ? await readJson(request) : undefined;
    const sessionHeader = request.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    let transport: StreamableHTTPServerTransport | undefined;
    if (sessionId !== undefined) {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        sendJson(response, 404, { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        return;
      }
      session.lastSeen = Date.now();
      transport = session.transport;
    } else if (request.method === 'POST' && isInitializeRequest(body)) {
      transport = await openSession();
    } else {
      sendJson(response, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Session not initialized' }, id: null });
      return;
    }
    await transport.handleRequest(request, response, body);
  }

  http.on('request', (request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response).catch((error: unknown) => {
      log('error', 'hub request failed', { detail: detail(error) });
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
    });
  });

  const housekeeping = setInterval(
    () => {
      const now = Date.now();
      for (const [id, session] of sessions) {
        if (now - session.lastSeen > STALE_SESSION_MS) {
          sessions.delete(id);
          void session.transport.close().catch(() => undefined);
        }
      }
      if (runtime.service.status().connected) {
        lastConnected = now;
        return;
      }
      if (now - lastActivity >= settings.idleMs && now - lastConnected >= settings.idleMs) void close('idle');
    },
    Math.max(250, Math.min(30_000, Math.floor(settings.idleMs / 4))),
  );

  function close(reason: string): Promise<void> {
    closing ??= (async () => {
      log('info', 'hub shutting down', { reason });
      clearInterval(housekeeping);
      // Remove the state file first so no new proxy attaches to a hub that is going away.
      removeHubState(settings.stateDir, token);
      await Promise.allSettled([...sessions.values()].map(async (session) => await session.transport.close()));
      sessions.clear();
      // Release the game port before the control port: once /health stops answering, 19131 is free.
      await runtime.connection.close();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    })().finally(markClosed);
    return closing;
  }

  writeHubState(settings.stateDir, state);
  return { state, close, closed };
}

/** Entry point of the detached hub process (`index.js --hub`). */
export async function runHub(version: string, config: RuntimeConfig, settings: HubSettings): Promise<void> {
  let hub: HubHandle | null;
  try {
    hub = await startHub({ version, config, settings });
  } catch (error) {
    log('error', 'hub failed to start', { detail: detail(error) });
    process.exitCode = 3;
    return;
  }
  if (hub === null) {
    log('info', 'another hub already owns the control port; exiting', { controlPort: settings.controlPort });
    return;
  }
  const active = hub;
  log('info', 'hub ready', {
    pid: process.pid,
    controlPort: active.state.controlPort,
    connectCommand: `/connect 127.0.0.1:${String(active.state.wsPort)}`,
    build: active.state.build,
  });
  process.once('SIGINT', () => void active.close('SIGINT'));
  process.once('SIGTERM', () => void active.close('SIGTERM'));
  await active.closed;
  process.exit(process.exitCode ?? 0);
}

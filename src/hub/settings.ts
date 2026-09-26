import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RuntimeConfig } from '../composition.js';

export const SHARED_WS_PORT = 19131;
const DEFAULT_CONTROL_PORT = 19132;

export interface HubSettings {
  readonly enabled: boolean;
  readonly controlPort: number;
  readonly stateDir: string;
  readonly idleMs: number;
  readonly attachTimeoutMs: number;
}

export interface HubState {
  readonly pid: number;
  readonly controlPort: number;
  readonly wsPort: number;
  readonly token: string;
  readonly build: string;
  readonly startedAt: string;
}

export interface HubHealth {
  readonly ok: boolean;
  readonly pid: number;
  readonly build: string;
  readonly version: string;
  readonly wsPort: number;
  readonly connected: boolean;
  readonly sessions: number;
  readonly writer: string | null;
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) || parsed < min || parsed > max ? fallback : parsed;
}

export function readHubSettings(config: RuntimeConfig, env: NodeJS.ProcessEnv = process.env): HubSettings {
  const flag = env['MINECRAFT_EDU_HUB'];
  const stateDir = env['MINECRAFT_EDU_HUB_DIR']?.trim();
  return {
    // A custom WebSocket port (doctor and smoke use 0) asks for an isolated standalone bridge.
    enabled: flag === '1' || (flag !== '0' && config.port === SHARED_WS_PORT),
    controlPort: readInt(env, 'MINECRAFT_EDU_HUB_PORT', DEFAULT_CONTROL_PORT, 0, 65_535),
    stateDir: stateDir === undefined || stateDir === '' ? join(homedir(), '.blockhand') : stateDir,
    idleMs: readInt(env, 'MINECRAFT_EDU_HUB_IDLE_MS', 10 * 60_000, 1_000, 24 * 3_600_000),
    attachTimeoutMs: readInt(env, 'MINECRAFT_EDU_HUB_ATTACH_MS', 8_000, 500, 60_000),
  };
}

/** tsc rewrites every output on each build, so this file's mtime identifies the build. */
export function buildId(version: string): string {
  return `${version}+${String(Math.trunc(statSync(fileURLToPath(import.meta.url)).mtimeMs))}`;
}

export function newToken(): string {
  return randomBytes(24).toString('hex');
}

export function tokenMatches(expected: string, authorization: string | undefined): boolean {
  const given = Buffer.from(authorization?.startsWith('Bearer ') ? authorization.slice(7) : '');
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

const stateFile = (dir: string): string => join(dir, 'hub.json');
export const hubLogFile = (dir: string): string => join(dir, 'hub.log');

export function writeHubState(dir: string, state: HubState): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${stateFile(dir)}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, stateFile(dir));
}

export function readHubState(dir: string): HubState | null {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(dir), 'utf8')) as Partial<HubState>;
    if (typeof parsed.token !== 'string' || typeof parsed.controlPort !== 'number' || typeof parsed.pid !== 'number') {
      return null;
    }
    return parsed as HubState;
  } catch {
    return null;
  }
}

/** Only removes the file this hub wrote; a newer hub may already have replaced it. */
export function removeHubState(dir: string, token: string): void {
  if (readHubState(dir)?.token === token) rmSync(stateFile(dir), { force: true });
}

export async function fetchHealth(state: HubState, timeoutMs = 1_500): Promise<HubHealth | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(state.controlPort)}/health`, {
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const health = (await response.json()) as HubHealth;
    return health.pid === state.pid ? health : null;
  } catch {
    return null;
  }
}

/**
 * 對話開著就定期報到，讓中樞不會因為「沒人呼叫工具」而關掉共用埠。
 * false 代表中樞已經不在，或已被別的中樞取代（token 對不上）。
 */
export async function sendKeepalive(state: HubState, timeoutMs = 3_000): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(state.controlPort)}/keepalive`, {
      method: 'POST',
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function requestHubShutdown(state: HubState): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(state.controlPort)}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

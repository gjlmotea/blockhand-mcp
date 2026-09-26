import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimeConfig } from '../../src/composition.js';
import {
  readHubSettings,
  readHubState,
  removeHubState,
  tokenMatches,
  writeHubState,
  type HubState,
} from '../../src/hub/settings.js';

const CONFIG: RuntimeConfig = {
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
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('hub settings', () => {
  it('uses the hub only for the shared default port unless explicitly forced or disabled', () => {
    expect(readHubSettings(CONFIG, {}).enabled).toBe(true);
    expect(readHubSettings({ ...CONFIG, port: 0 }, {}).enabled).toBe(false);
    expect(readHubSettings({ ...CONFIG, port: 40_000 }, {}).enabled).toBe(false);
    expect(readHubSettings(CONFIG, { MINECRAFT_EDU_HUB: '0' }).enabled).toBe(false);
    expect(readHubSettings({ ...CONFIG, port: 40_000 }, { MINECRAFT_EDU_HUB: '1' }).enabled).toBe(true);
  });

  it('reads overrides and falls back on invalid numbers', () => {
    const custom = readHubSettings(CONFIG, {
      MINECRAFT_EDU_HUB_PORT: '40123',
      MINECRAFT_EDU_HUB_DIR: '/tmp/blockhand-test',
      MINECRAFT_EDU_HUB_IDLE_MS: '5000',
    });
    expect(custom).toMatchObject({ controlPort: 40_123, stateDir: '/tmp/blockhand-test', idleMs: 5000 });
    const invalid = readHubSettings(CONFIG, { MINECRAFT_EDU_HUB_PORT: '70000', MINECRAFT_EDU_HUB_IDLE_MS: '10' });
    expect(invalid.controlPort).toBe(19_132);
    expect(invalid.idleMs).toBe(600_000);
  });

  it('accepts only the exact bearer token', () => {
    expect(tokenMatches('abc123', 'Bearer abc123')).toBe(true);
    expect(tokenMatches('abc123', 'Bearer abc124')).toBe(false);
    expect(tokenMatches('abc123', 'abc123')).toBe(false);
    expect(tokenMatches('abc123', undefined)).toBe(false);
    expect(tokenMatches('abc123', 'Bearer abc1234')).toBe(false);
  });

  it('writes a private state file and only removes its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blockhand-hub-'));
    dirs.push(dir);
    const state: HubState = {
      pid: 1234,
      controlPort: 40_000,
      wsPort: 19_131,
      token: 'mine',
      build: '0.1.0+1',
      startedAt: '2026-09-27T00:00:00.000Z',
    };
    writeHubState(dir, state);
    expect(readHubState(dir)).toEqual(state);
    if (process.platform !== 'win32') expect(statSync(join(dir, 'hub.json')).mode & 0o777).toBe(0o600);
    removeHubState(dir, 'someone-else');
    expect(readHubState(dir)).toEqual(state);
    removeHubState(dir, 'mine');
    expect(readHubState(dir)).toBeNull();
  });
});

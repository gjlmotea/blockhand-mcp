import { afterEach, describe, expect, it } from 'vitest';

import { readRuntimeConfig } from '../../src/composition.js';

const ENV_NAMES = [
  'MINECRAFT_EDU_WS_HOST',
  'MINECRAFT_EDU_WS_PORT',
  'MINECRAFT_EDU_WS_PORT_FALLBACK',
] as const;
const originalEnvironment = Object.fromEntries(
  ENV_NAMES.map((name) => [name, process.env[name]]),
) as Record<(typeof ENV_NAMES)[number], string | undefined>;

afterEach(() => {
  for (const name of ENV_NAMES) {
    const original = originalEnvironment[name];
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
});

describe.sequential('runtime WebSocket config', () => {
  it('接受 port 0 交由作業系統配發空閒埠', () => {
    process.env['MINECRAFT_EDU_WS_PORT'] = '0';
    process.env['MINECRAFT_EDU_WS_PORT_FALLBACK'] = '0';
    const config = readRuntimeConfig();
    expect(config.port).toBe(0);
    expect(config.fallbackToRandomPort).toBe(false);
  });

  it('缺少 host／port／fallback 時使用安全的 loopback 預設', () => {
    for (const name of ENV_NAMES) delete process.env[name];
    const config = readRuntimeConfig();
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(19_131);
    expect(config.fallbackToRandomPort).toBe(true);
  });

  it('負數或超出範圍的 port 不會傳給 WebSocket server', () => {
    process.env['MINECRAFT_EDU_WS_PORT'] = '-1';
    expect(readRuntimeConfig().port).toBe(19_131);
    process.env['MINECRAFT_EDU_WS_PORT'] = '65536';
    expect(readRuntimeConfig().port).toBe(19_131);
  });
});

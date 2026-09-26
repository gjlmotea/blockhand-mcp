import { describe, expect, it } from 'vitest';

import { WriteLock } from '../../src/hub/write-lock.js';

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('WriteLock', () => {
  it('refuses another session immediately while a write is running, then lets it through', async () => {
    const lock = new WriteLock();
    const gate = deferred();
    const first = lock.run('A', 'mc_fill', async () => {
      await gate.promise;
      return 'done';
    });
    expect(lock.holder).toMatchObject({ session: 'A', tool: 'mc_fill' });
    await expect(lock.run('B', 'mc_set_block', async () => 'nope')).rejects.toThrow('另一個 AI 對話正在修改世界（mc_fill');
    gate.release();
    await expect(first).resolves.toBe('done');
    expect(lock.holder).toBeNull();
    await expect(lock.run('B', 'mc_set_block', async () => 'ok')).resolves.toBe('ok');
  });

  it('queues concurrent writes from the same session in order', async () => {
    const lock = new WriteLock();
    const order: string[] = [];
    const gate = deferred();
    const first = lock.run('A', 'one', async () => {
      await gate.promise;
      order.push('one');
    });
    const second = lock.run('A', 'two', async () => {
      order.push('two');
    });
    gate.release();
    await Promise.all([first, second]);
    expect(order).toEqual(['one', 'two']);
    expect(lock.holder).toBeNull();
  });

  it('releases the lock when the write fails', async () => {
    const lock = new WriteLock();
    await expect(lock.run('A', 'mc_fill', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(lock.holder).toBeNull();
    await expect(lock.run('B', 'mc_fill', async () => 'ok')).resolves.toBe('ok');
  });
});

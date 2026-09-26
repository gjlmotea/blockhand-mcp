export interface WriteHolder {
  readonly session: string;
  readonly tool: string;
  readonly since: number;
}

/**
 * One world-writing tool call at a time across all attached sessions. Another session is
 * refused immediately (not queued) so an agent learns why instead of silently stalling;
 * concurrent calls from the same session wait their turn.
 */
export class WriteLock {
  #holder: WriteHolder | null = null;
  #tail: Promise<void> = Promise.resolve();

  get holder(): WriteHolder | null {
    return this.#holder;
  }

  run<T>(session: string, tool: string, work: () => Promise<T>): Promise<T> {
    const current = this.#holder;
    if (current !== null) {
      if (current.session !== session) {
        const seconds = Math.round((Date.now() - current.since) / 1000);
        return Promise.reject(
          new Error(
            `另一個 AI 對話正在修改世界（${current.tool}，已進行 ${String(seconds)} 秒）。等它完成再試，避免兩邊的指令互相穿插。`,
          ),
        );
      }
      return this.#tail.then(() => this.run(session, tool, work));
    }
    this.#holder = { session, tool, since: Date.now() };
    const running = (async () => {
      try {
        return await work();
      } finally {
        this.#holder = null;
      }
    })();
    this.#tail = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }
}

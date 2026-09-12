import { createHash } from 'node:crypto';

/** Long builds belong to a persistent process, not the lifetime of a caller waiting for a result. */
export function createSessionQueue({ call, save, publish = () => {} }) {
  let state = { version: 1, status: 'idle', nextIndex: 0, total: 0, inFlight: null };
  let completion = Promise.resolve();
  const snapshot = () => structuredClone(state);
  const persist = () => save(snapshot());
  const notify = () => { try { publish(snapshot()); } catch { /* Progress display cannot cancel world work. */ } };

  async function execute(commands) {
    try {
      while (state.nextIndex < commands.length) {
        const index = state.nextIndex;
        const command = commands[index];
        state.inFlight = { index, command };
        persist(); // A crash after dispatch must never look like an unissued command.
        let result;
        try {
          result = await call('mc_run_command', { command });
        } catch (error) {
          state.status = 'uncertain';
          state.error = error instanceof Error ? error.message : String(error);
          persist(); notify(); return;
        }
        const outcome = result.structuredContent;
        const noop = result.isError !== true && /^\/?fill\s/.test(command)
          && outcome?.ok === false && outcome.statusCode === -2147352576 && outcome.data?.fillCount === 0;
        if (result.isError === true || outcome?.ok !== true && !noop) {
          // A game-command timeout has no definitive response: do not retry it or send later commands.
          state.status = typeof outcome?.statusCode === 'number' ? 'failed' : 'uncertain';
          state.error = outcome?.statusMessage ?? result.content?.[0]?.text ?? 'Missing command outcome';
          if (state.status === 'failed') state.inFlight = null;
          persist(); notify(); return;
        }
        state.nextIndex = index + 1;
        state.noops += Number(noop);
        state.lastElapsedMs = outcome.elapsedMs ?? null;
        state.inFlight = null;
        persist(); // One acknowledged command per checkpoint, independent of batch/display timeout.
        if (state.nextIndex % 20 === 0) notify();
      }
      state.status = 'complete'; persist(); notify();
    } catch (error) {
      // A checkpoint failure must stop dispatch; the previous durable inFlight record remains conservative.
      state.status = 'uncertain';
      state.error = `Checkpoint failure: ${error instanceof Error ? error.message : String(error)}`;
      notify();
    }
  }

  return {
    snapshot,
    busy: () => state.status === 'running',
    finished: () => completion,
    submit(input) {
      if (state.status === 'running') throw new Error('A build is already running; query status.');
      if (state.status === 'uncertain' || state.status === 'failed') throw new Error('Inspect the failed/uncertain command before starting a new session; no automatic replay.');
      if (!Array.isArray(input) || input.length < 1 || input.length > 20_000
        || input.some(command => typeof command !== 'string' || command.length < 1 || command.length > 1024 || /[\r\n\0]/.test(command))) {
        throw new Error('commands must contain 1–20000 single-line commands, each at most 1024 characters.');
      }
      const commands = [...input];
      state = {
        version: 1, status: 'running', planHash: createHash('sha256').update(JSON.stringify(commands)).digest('hex'),
        total: commands.length, nextIndex: 0, inFlight: null, noops: 0, lastElapsedMs: null,
      };
      try { persist(); } catch (error) { state.status = 'uncertain'; throw error; }
      completion = Promise.resolve().then(() => execute(commands));
      return snapshot(); // Immediate acknowledgement; clients may stop polling without killing this process.
    },
  };
}

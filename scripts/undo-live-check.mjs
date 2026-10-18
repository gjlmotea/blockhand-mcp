/**
 * Native whole-region Undo acceptance through the real WS adapter and MCP tools.
 * node scripts/undo-live-check.mjs --origin=x,y,z [--size=16] [--keep-open]
 * --diagnose starts only the bridge: no automatic region checks or construction.
 * With an explicit origin, JSONL {action:'test'} starts/repeats the acceptance test.
 * Prints a connectCommand; the player enters it manually. The explicitly scoped
 * test area must be all air and clear of players. Failure stops without blind cleanup.
 * --keep-open retains this bridge and accepts JSONL {name,args} MCP requests.
 *
 * JSONL {action:'probe'} lists a read-only ladder that isolates one variable at a
 * time (body.version, execute wrapper, selector, if block aux value, 1D compare,
 * source/destination overlap, condition count, then the real region guard).
 * {action:'probe',probe:'<name>'} sends exactly one of them. Every entry is
 * read-only and bypasses the Undo service, so no snapshot is allocated and no
 * block is written. A timeout halts the whole ladder for that connection: nothing
 * is retried or replayed, and probing only resumes after a new /connect.
 */
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWsMinecraftConnection } from '../dist/adapters/ws-minecraft-connection.js';
import { composeRuntime, readRuntimeConfig } from '../dist/composition.js';
import { createMcpServer } from '../dist/server/create-server.js';
import { planUndo, guardUndoRegion } from '../dist/domain/build/undo-plan.js';

const argument = process.argv.find(arg => arg.startsWith('--origin='));
const diagnose = process.argv.includes('--diagnose');
assert((diagnose && !argument) || argument && /^-?\d+,-?\d+,-?\d+$/.test(argument.slice(9)), 'Pass --origin=x,y,z');
const [x, y, z] = argument ? argument.slice(9).split(',').map(Number) : [0, 20, 0];
const port = Number(process.argv.find(arg => arg.startsWith('--port='))?.slice(7) ?? 0);
assert(Number.isInteger(port) && port >= 0 && port <= 65535, 'Invalid --port');
const size = Number(process.argv.find(arg => arg.startsWith('--size='))?.slice(7) ?? 16);
assert(Number.isInteger(size) && size >= 2 && size <= 16, 'Test size must be 2–16');
const keepOpen = process.argv.includes('--keep-open');
const from = { x, y, z }, to = { x: x + size - 1, y: y + size - 1, z: z + size - 1 };
const fill = block => `fill ${x} ${y} ${z} ${to.x} ${to.y} ${to.z} ${block}`;
const air = planUndo([fill('air')], 4096).regions[0];
const stone = planUndo([fill('stone')], 4096).regions[0];
const config = { ...readRuntimeConfig(), host: '127.0.0.1', port, stepDelayMs: 0,
  undoEnabled: true, maxUndoBlocks: 4096, debugFrames: false };
const wire = createWsMinecraftConnection(config);
const records = [], saved = new Set();
const base = { ...wire, runCommand: async (command, options) => {
  const match = /\bstructure (save|delete) (\S+)/.exec(command);
  if (match?.[1] === 'save') saved.add(match[2]);
  const result = await wire.runCommand(command, options);
  records.push(result);
  if (match?.[1] === 'delete' && result.ok) saved.delete(match[2]);
  return result;
} };
const runtime = composeRuntime('undo-region-live-check', config, base);
const server = createMcpServer({ service: runtime.service, build: runtime.build, version: 'undo-region-live-check' });
const client = new Client({ name: 'undo-region-live-check', version: '1' });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([client.connect(a), server.connect(b)]);
await runtime.connection.start();
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const call = (name, args = {}) => client.callTool({ name, arguments: args });
async function checkedTool(name, args = {}) {
  const result = await call(name, args);
  assert(!result.isError, JSON.stringify(result));
  return result.structuredContent;
}
async function requireOK(command, native = true) {
  const result = await base.runCommand(command, native ? { commandVersion: 25 } : undefined);
  assert(result.ok, `${command}: ${result.statusMessage}`);
  return result;
}
const verify = region => requireOK(guardUndoRegion(region, 'querytarget @s'));

/**
 * 唯讀診斷階梯。
 *
 * 實機症狀是「第一條 body.version=25 的整區 guard 沒有任何回覆，之後連 version 1
 * 的 time query 也沒有回覆」。那條 guard 同時改變了六個變數（指令版本、execute
 * 包裝、選擇器 @s、if block 的 aux 值、三次來源與目的重疊的 if blocks 區域比對、
 * 指令長度），所以整條測不出原因。這個表提供成對的對照；需依 note 選取
 * 對照組，不代表清單內每兩個相鄰項目都只差一個變數。
 *
 * 來源對照：body 形狀與 header.version 都與公開實作 mcpews 相同
 * （`{version, commandLine, origin:{type:'player'}}`、`Version.V0_0_1 = 1`），
 * 25 = `MinecraftCommandVersion.V1_19_50`，而 aux 值要到 `0x1d`（29）才移除，
 * 這支持 v25 使用 `air 0` 的設計，但不代替目前 Education 客戶端的相容性驗證。
 */
const spot = (dx, dy, dz) => `${x + dx} ${y + dy} ${z + dz}`;
const compare = (begin, end, destination) => `if blocks ${begin} ${end} ${destination} all`;
const repeated = count =>
  `execute in overworld ${Array.from({ length: count }, () => `if block ${spot(0, 0, 0)} air 0`).join(' ')} run querytarget @p`;
const probes = [
  { name: 'time-v1', version: 1, command: 'time query daytime',
    note: 'Time query baseline; differs from time-v25 only in body.version' },
  { name: 'query-v1', version: 1, command: 'querytarget @p',
    note: 'Baseline: no execute, no v25' },
  { name: 'query-v25', version: 25, command: 'querytarget @p',
    note: 'Only body.version changes; the command string is identical' },
  { name: 'time-v25', version: 25, command: 'time query daytime',
    note: 'v25 with a non-execute command; together with query-v25, shows whether changing the version alone makes the game go silent' },
  { name: 'execute-time-v25', version: 25, command: 'execute in overworld run time query daytime',
    note: 'Differs from time-v25 only in the execute wrapper; compare with execute-run-v25 for behavior specific to querytarget' },
  { name: 'execute-run-v1', version: 1, command: 'execute in overworld run querytarget @p',
    note: 'The old version parsing the new syntax. A clear error message is expected; if it goes silent, the silence has nothing to do with v25' },
  { name: 'execute-run-v25', version: 25, command: 'execute in overworld run querytarget @p',
    note: 'The shortest new-style execute, with no conditions' },
  { name: 'execute-self-v25', version: 25, command: 'execute in overworld run querytarget @s',
    note: 'Only the selector changes, to @s; @s does not always resolve for a WebSocket origin' },
  { name: 'if-block-v25', version: 25, area: true,
    command: `execute in overworld if block ${spot(0, 0, 0)} air 0 run querytarget @p`,
    note: 'Single-block condition with aux value 0' },
  { name: 'if-block-noaux-v25', version: 25, area: true,
    command: `execute in overworld if block ${spot(0, 0, 0)} air run querytarget @p`,
    note: 'Same, without the aux value, to see which form v25 accepts' },
  { name: 'if-blocks-1d-disjoint-v25', version: 25, area: true,
    command: `execute in overworld ${compare(spot(0, 0, 0), spot(1, 0, 0), spot(4, 0, 0))} run querytarget @p`,
    note: 'Smallest region compare: two blocks, source and destination do not overlap' },
  { name: 'if-blocks-1d-overlap-v25', version: 25, area: true,
    command: `execute in overworld ${compare(spot(0, 0, 0), spot(1, 0, 0), spot(1, 0, 0))} run querytarget @p`,
    note: 'Same, but source and destination overlap by one block, which is the shape of the whole-region guard' },
  { name: 'testforblocks-disjoint-v1', version: 1, area: true,
    command: `testforblocks ${spot(0, 0, 0)} ${spot(1, 0, 0)} ${spot(4, 0, 0)} all`,
    note: 'The same compare without execute and without v25' },
  { name: 'testforblocks-overlap-v1', version: 1, area: true,
    command: `testforblocks ${spot(0, 0, 0)} ${spot(1, 0, 0)} ${spot(1, 0, 0)} all`,
    note: 'The overlapping compare without execute and without v25; shows on its own whether overlap is rejected' },
  { name: 'guard-2x2x2-v25', version: 25, area: true,
    command: guardUndoRegion({ from, to: { x: x + 1, y: y + 1, z: z + 1 }, block: 'air', blockCount: 8 }, 'querytarget @p'),
    note: 'The real guard shape (base block + overlapping compares on three axes), but only 8 blocks' },
  { name: 'guard-2x2x2-self-v25', version: 25, area: true,
    command: guardUndoRegion({ from, to: { x: x + 1, y: y + 1, z: z + 1 }, block: 'air', blockCount: 8 }, 'querytarget @s'),
    note: 'Differs from guard-2x2x2 only in the @s selector, and from guard-region only in the compared volume (same length and condition count)' },
  { name: 'guard-conditions-3-v25', version: 25, area: true, command: repeated(3),
    note: 'Condition count/length axis: three single-block conditions' },
  { name: 'guard-conditions-12-v25', version: 25, area: true, command: repeated(12),
    note: 'Condition count/length axis: twelve single-block conditions, longer than the command that failed in the game' },
  { name: 'guard-region-v25', version: 25, area: true,
    command: guardUndoRegion(air, 'querytarget @s'),
    note: 'Exactly the whole-region guard that failed in the game; test it last' },
].map((probe, index) => ({ ...probe, order: index + 1 }));

// 讀寫分界必須是啟動時就成立的事實，不是執行時才發現。
const readOnlyTerminal = /^(?:querytarget|testforblocks?|time query)\b/;
for (const probe of probes) {
  const terminal = probe.command.includes(' run ') ? probe.command.split(' run ').at(-1) : probe.command;
  assert(readOnlyTerminal.test(terminal), `probe ${probe.name} ends in a command that is not read-only: ${terminal}`);
  assert(!/\b(?:fill|setblock|structure|clone|give|summon|kill|tp|teleport)\b/.test(probe.command),
    `probe ${probe.name} contains a verb that changes the world`);
  assert(probe.command.length <= 1024, `probe ${probe.name} is longer than 1024 characters`);
}

/** 逾時後同一條連線不再送出任何 probe：不重播、不自動重試。 */
let probeHalt = null;
async function runProbe(name) {
  const probe = probes.find(entry => entry.name === name);
  if (!probe) {
    emit({ kind: 'probe', ok: false, error: `Unknown probe: ${String(name)}`,
      available: probes.map(entry => entry.name) });
    return;
  }
  const connectionCount = wire.status().connectionCount;
  if (probeHalt && probeHalt.connectionCount === connectionCount) {
    emit({ kind: 'probe', probe: probe.name, skipped: true, haltedBy: probeHalt.probe,
      reason: 'A probe already timed out on this connection, so no more commands are sent. Run /connect again to continue.' });
    return;
  }
  if (probe.area && !argument) {
    emit({ kind: 'probe', probe: probe.name, skipped: true,
      reason: 'This probe reads coordinates in the test area; start the script with --origin=x,y,z.' });
    return;
  }
  if (!wire.status().connected) {
    emit({ kind: 'probe', probe: probe.name, skipped: true, reason: 'The game is not connected yet.' });
    return;
  }
  const result = await base.runCommand(probe.command, { commandVersion: probe.version });
  const timedOut = result.statusCode === null;
  if (timedOut) probeHalt = { probe: probe.name, connectionCount };
  const details = result.data === null ? null : JSON.stringify(result.data).slice(0, 400);
  emit({ kind: 'probe', probe: probe.name, order: probe.order, note: probe.note,
    commandVersion: probe.version, commandLength: probe.command.length, command: probe.command,
    ok: result.ok, timedOut, statusCode: result.statusCode, statusMessage: result.statusMessage,
    elapsedMs: result.elapsedMs, details,
    halted: timedOut, status: wire.status() });
}

let failed = false;
emit({ kind: 'ready', ...wire.status(), diagnose, testArea: argument ? { from, to, cells: size ** 3 } : null });
async function runTest() {
assert(argument, 'Acceptance requires an explicitly scoped --origin=x,y,z');
const firstRecord = records.length;
try {
  while (!wire.status().connected) await wire.awaitConnection(30_000);
  assert((await checkedTool('mc_undo_control')).state === 'empty', 'Existing Undo history must be resolved before testing');
  const players = JSON.parse((await requireOK('querytarget @a', false)).data.details);
  assert(players.length > 0);
  for (const { dimension, position: p } of players) {
    assert(dimension === 0 && p, 'All players must be in the overworld');
    assert(p.x < x - 2 || p.x > to.x + 2 || p.y < y - 4 || p.y > to.y + 4 || p.z < z - 2 || p.z > to.z + 2,
      'A player is inside the test area');
  }
  await verify(air);
  emit({ kind: 'progress', message: `All ${size ** 3} test cells verified empty; native predicates accepted.` });
  const baseline = await requireOK(guardUndoRegion(air, fill('stone')));
  const built = await checkedTool('mc_fill', { from, to, block: 'glass' });
  assert(built.ok && built.undo.available && built.undo.storedBlocks === size ** 3);
  assert(built.undo.snapshotCount === 1);
  const conflict = `${x + Math.floor(size / 2)} ${y + Math.floor(size / 2)} ${z + Math.floor(size / 2)}`;
  await requireOK(`execute in overworld if block ${conflict} glass 0 run setblock ${conflict} diamond_block`);
  const refused = await call('mc_undo');
  assert(refused.isError, 'Undo must refuse an interior conflict');
  await requireOK(`testforblock ${conflict} diamond_block 0`, false);
  await requireOK(`execute in overworld if block ${conflict} diamond_block 0 run setblock ${conflict} glass`);
  const restored = await checkedTool('mc_undo');
  assert(restored.state === 'empty' && restored.snapshotCount === 0);
  await verify(stone);
  await requireOK(guardUndoRegion(stone, fill('air')));
  await verify(air);
  const saves = records.slice(firstRecord).filter(r => /\bstructure save\b/.test(r.commandLine));
  emit({ kind: 'report', ok: true, origin: from, cells: size ** 3,
    snapshotCount: saves.length, baselineMs: baseline.elapsedMs,
    backupMs: built.undo.backupMs, checkMs: restored.checkMs, restoreMs: restored.restoreMs,
    conflictPreserved: true, restoredOriginalStone: true, finalAllAir: true,
    remainingSnapshotNames: [...saved], finalUndo: restored,
    note: 'Actual acknowledged command durations; no FPS or exact RAM-byte claim.' });
} catch (error) {
  failed = true;
  emit({ kind: 'report', ok: false, error: String(error), origin: from,
    undo: (await call('mc_undo_control')).structuredContent, remainingSnapshotNames: [...saved],
    note: 'Stopped without blind cleanup. Inspect the test area before recovery.' });
  process.exitCode = 1;
}
}
if (!diagnose) await runTest();
// Keep recovery metadata and memory snapshots reachable after a failed live edit.
if (diagnose || keepOpen || failed && wire.status().connected) {
  emit({ kind: 'bridge-retained', ...wire.status() });
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  const input = createInterface({ input: process.stdin, terminal: false });
  for await (const line of input) {
    try {
      const request = JSON.parse(line);
      if (request.action === 'close') break;
      if (request.action === 'test') { await runTest(); continue; }
      if (request.action === 'probe') {
        if (request.probe === undefined) {
          emit({ kind: 'probe-list', halted: probeHalt,
            probes: probes.map(({ name, order, version, note, area, command }) =>
              ({ name, order, commandVersion: version, needsOrigin: area === true, commandLength: command.length, note })) });
        } else {
          await runProbe(request.probe);
        }
        continue;
      }
      emit({ kind: 'response', name: request.name, result: await call(request.name, request.args ?? {}) });
    } catch (error) { emit({ kind: 'error', error: String(error) }); }
  }
  input.close();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}
await runtime.connection.close();
await client.close();
await server.close();

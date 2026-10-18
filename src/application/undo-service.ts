import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MinecraftBridgeError, type BatchOutcome, type CommandOutcome } from '../domain/contracts.js';
import type { UndoController, UndoStatus } from '../domain/undo.js';
import type { MinecraftConnection, SequenceOptions } from '../ports/minecraft-connection.js';
import { assessRawCommand } from '../domain/command-policy.js';
import { worldCommands } from '../domain/commands.js';
import { DEFAULT_UNDO_BLOCKS, MAX_UNDO_BLOCKS, MAX_UNDO_REGIONS, guardUndoRegion, planUndo, type UndoRegion } from '../domain/build/undo-plan.js';

interface Snapshot { name: string; region: UndoRegion; restored: boolean }
interface Entry {
  id: string;
  epoch: string;
  dimension: number;
  snapshots: Snapshot[];
  state: UndoStatus['state'];
}

export function createUndoConnection(base: MinecraftConnection, options: { enabled?: boolean; maxBlocks?: number } = {}): {
  connection: MinecraftConnection; undo: UndoController;
} {
  let enabled = options.enabled ?? true;
  let maxBlocks = options.maxBlocks ?? DEFAULT_UNDO_BLOCKS;
  if (!Number.isInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > MAX_UNDO_BLOCKS) {
    throw new MinecraftBridgeError('undo-invalid-budget', `The Undo block limit must be between 1 and ${MAX_UNDO_BLOCKS}.`);
  }
  let entry: Entry | null = null;
  let busy = false;
  let closing = false;
  let reason: string | null = null;
  let backupMs = 0, checkMs = 0, restoreMs = 0;
  let running: Promise<unknown> = Promise.resolve();
  let nativeChecksEpoch: string | null = null;

  function epoch(): string {
    const s=base.status();
    return s.connected ? `${s.connectionCount}:${s.connectedAt}` : 'disconnected';
  }
  function status(): UndoStatus {
    if (entry && entry.epoch !== epoch()) {
      entry.state='invalidated'; reason='The connection changed, so the old restore point no longer applies; clear the old history.';
    }
    return {
      enabled, maxBlocks, maxRegions: MAX_UNDO_REGIONS,
      state: entry?.state ?? 'empty', busy,
      available: !busy && (entry?.state === 'ready' || entry?.state === 'partial'),
      operationId: entry?.id ?? null,
      storedBlocks: entry?.snapshots.reduce((n,s)=>n+s.region.blockCount,0) ?? 0,
      snapshotCount: entry?.snapshots.length ?? 0,
      restoredRegions: entry?.snapshots.filter(s=>s.restored).length ?? 0,
      backupMs, checkMs, restoreMs, reason,
    };
  }
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (busy || closing) return Promise.reject(new MinecraftBridgeError('undo-busy', 'An operation is running or the server is shutting down; check status with mc_undo_control first.'));
    busy=true;
    const pending=work().finally(()=>{busy=false;});
    running=pending.catch(()=>{});
    return pending;
  }
  function completedStatus(): UndoStatus {
    const current = status();
    return { ...current, busy: false, available: current.state === 'ready' || current.state === 'partial' };
  }
  function sameSession(expected: string): void {
    if (epoch() !== expected) {
      if(entry) entry.state='invalidated';
      throw new MinecraftBridgeError('undo-session-changed', 'The game connection changed, so the operation stopped; the restore will not be replayed on the new connection.');
    }
  }
  async function dimension(expectedEpoch: string): Promise<number> {
    sameSession(expectedEpoch);
    const result=await base.runCommand('querytarget @s');
    sameSession(expectedEpoch);
    try {
      const raw=result.data?.['details'];
      const rows: unknown=typeof raw === 'string' ? JSON.parse(raw) : null;
      if(result.ok && Array.isArray(rows) && rows.length===1 && typeof rows[0]?.dimension === 'number') return rows[0].dimension as number;
    } catch { /* A missing world context must not become an assumed overworld. */ }
    if(!result.ok && result.statusCode===null) {
      throw new MinecraftBridgeError('undo-context-no-reply', `The game did not reply when asked for the command source dimension (${result.statusMessage ?? 'reason unknown'}); no undoable change was made.`);
    }
    throw new MinecraftBridgeError('undo-context-unknown', 'Could not read the command source dimension; no undoable change was made.');
  }
  async function requireContext(target: Entry): Promise<void> {
    if(await dimension(target.epoch) !== target.dimension) throw new MinecraftBridgeError('undo-dimension-changed', 'The player switched dimensions; go back to the original dimension before undoing.');
  }
  async function checked(command: string, expectedEpoch: string, native = false): Promise<CommandOutcome> {
    sameSession(expectedEpoch);
    const result=await base.runCommand(command, native ? {commandVersion:25} : undefined);
    sameSession(expectedEpoch);
    return result;
  }
  function requireSuccess(result: CommandOutcome, stage: string): void {
    if(!result.ok) throw new MinecraftBridgeError('undo-command-failed', `${stage} failed: ${result.statusMessage ?? 'the game did not confirm the result'}.`);
  }
  async function ensureNativeChecks(expectedEpoch: string, first: UndoRegion): Promise<void> {
    if (nativeChecksEpoch === expectedEpoch) return;
    const p = `${first.from.x} ${first.from.y} ${first.from.z}`;
    const prefix = `execute in overworld if blocks ${p} ${p} ${p} all`;
    let result = await checked(`${prefix} if block ${p} ${first.block} 0 run querytarget @s`, expectedEpoch, true);
    // Only a confirmed false predicate permits the complementary read-only probe.
    // Syntax errors, permissions, timeouts and transport failures must stop here.
    if (!result.ok && result.statusCode === -2147352576) {
      result = await checked(`${prefix} unless block ${p} ${first.block} 0 run querytarget @s`, expectedEpoch, true);
    }
    requireSuccess(result, 'Checking native whole-region support (nothing built; needs command version 25)');
    nativeChecksEpoch = expectedEpoch;
  }
  async function release(): Promise<void> {
    if(!entry) return;
    // Unique names belong only to this process. Never touch manually saved structures.
    const currentEpoch=epoch();
    if(currentEpoch==='disconnected') throw new MinecraftBridgeError('undo-cleanup-disconnected', 'Not connected, so it cannot confirm the backups were released; the history is kept and no new change was started.');
    entry.state='cleanup-required';
    while(entry.snapshots.length) {
      const snapshot=entry.snapshots[0]!;
      const result=await checked(worldCommands.deleteStructure(snapshot.name),currentEpoch);
      // A timed-out save may never have created its uniquely owned structure.
      const absent = result.statusCode === -2147352576
        && result.statusMessage?.includes(snapshot.name)
        && /找不到|未找到|不存在|could not be found|not found|cannot find/i.test(result.statusMessage);
      if (!absent) requireSuccess(result,'Releasing the old backup');
      entry.snapshots.shift();
    }
    entry=null;
  }
  const isReadOnly = (command: string): boolean => assessRawCommand(command).risk === 'read-only'
    || /^agent (?:inspect|inspectdata|detect|detectredstone|getitemcount|getitemspace|getitemdetail)\b/.test(command)
    || /^time query\b/.test(command);

  async function execute(commands: readonly string[], sequence: SequenceOptions): Promise<BatchOutcome> {
    const started=performance.now();
    const plan=enabled ? planUndo(commands,maxBlocks) : null;
    status();
    if(entry && ['uncertain','partial','invalidated','cleanup-required'].includes(entry.state)) {
      throw new MinecraftBridgeError('undo-recovery-required', 'The previous operation still needs to be undone or cleared; its backup was not overwritten. Check mc_undo_control first.');
    }
    // Unmanaged mutations cannot leave an older edit labelled "the last step".
    if(!plan) {
      if(entry) await release();
      reason=enabled ? 'This operation is outside automatic Undo, so there is no history to undo.' : 'Automatic Undo is off.';
      const result=await base.runSequence(commands,sequence);
      return { ...result, undo: completedStatus() };
    }
    const currentEpoch=epoch();
    const currentDimension=await dimension(currentEpoch);
    if(currentDimension!==0) throw new MinecraftBridgeError('undo-dimension-unsupported','This first version of automatic Undo supports only the Overworld; no blocks were changed.');
    const id=randomUUID().replaceAll('-','');
    // Validate all guarded restore commands before any save/delete/write.
    const snapshots=plan.regions.map((region,i)=>({region,name:`bhundo_${id}_${i}`,restored:false}));
    for(const s of snapshots) guardUndoRegion(s.region,worldCommands.loadStructure(s.name,{...s.region.from,mode:'absolute'}));
    await ensureNativeChecks(currentEpoch, snapshots[0]!.region);
    await release();
    entry={id,epoch:currentEpoch,dimension:currentDimension,snapshots:[],state:'uncertain'};
    reason='Saving the blocks before building.'; backupMs=0; checkMs=0; restoreMs=0;
    const backupStart=performance.now();
    try {
      for(const s of snapshots) {
        // Account for an unacknowledged save too; it may have allocated game RAM.
        entry.snapshots.push(s);
        const save=worldCommands.saveStructure(s.name,{...s.region.from,mode:'absolute'},{...s.region.to,mode:'absolute'},false,'memory');
        const result=await checked(`execute in overworld run ${save}`,currentEpoch,true);
        requireSuccess(result,'Backup before building');
      }
      backupMs=Math.round(performance.now()-backupStart);
    } catch(error) {
      backupMs=Math.round(performance.now()-backupStart);
      if(entry) entry.state='cleanup-required';
      reason='Not every backup succeeded, so no build command was sent; any backups already made are kept for cleanup.';
      throw error;
    }
    const outcomes: CommandOutcome[]=[];
    try {
      await requireContext(entry);
      for(const command of commands) {
        const wireResult=await checked(`execute in overworld run ${command}`,currentEpoch,true);
        const result={...wireResult, commandLine:command};
        outcomes.push(result);
        const noop=!result.ok && result.statusCode===-2147352576 && result.data?.['fillCount']===0 && /^fill\b/.test(command);
        if(!result.ok && !noop) { reason='A build reply failed or was uncertain; the remaining commands were stopped and the backup of the original state is kept.'; break; }
        if(sequence.delayMs>0) await new Promise(resolve=>setTimeout(resolve,sequence.delayMs));
      }
      const complete=outcomes.length===commands.length && outcomes.every(r=>r.ok || r.statusCode===-2147352576&&r.data?.['fillCount']===0&&/^fill\b/.test(r.commandLine));
      entry.state=complete?'ready':'uncertain';
      if(complete) reason='A one-step backup of this whole operation is kept; mc_undo checks for later changes first.';
    } catch(error) {
      if(entry && entry.state!=='invalidated') entry.state='uncertain';
      reason='The build was interrupted; the backup of the original state is kept and nothing is resent automatically.';
      throw error;
    }
    const succeeded=outcomes.filter(r=>r.ok).length;
    return { ok:outcomes.every(r=>r.ok),issued:outcomes.length,succeeded,failed:outcomes.length-succeeded,
      firstFailure:outcomes.find(r=>!r.ok)??null,outcomes,elapsedMs:Math.round(performance.now()-started),undo:completedStatus() };
  }

  const undo: UndoController = {
    status,
    configure: (nextEnabled,nextMax,clear=false)=>exclusive(async()=>{
      if(nextMax!==undefined && (!Number.isInteger(nextMax)||nextMax<1||nextMax>MAX_UNDO_BLOCKS)) throw new MinecraftBridgeError('undo-invalid-budget',`The Undo block limit must be between 1 and ${MAX_UNDO_BLOCKS}.`);
      if(clear || nextEnabled===false || nextMax!==undefined&&nextMax<status().storedBlocks) await release();
      if(nextEnabled!==undefined) enabled=nextEnabled;
      if(nextMax!==undefined) maxBlocks=nextMax;
      reason=entry?reason:enabled?'Automatic one-step backup is on.':'Automatic backup is off and the old history was cleared.';
      return completedStatus();
    }),
    undo: (operationId,overwriteChanges=false)=>exclusive(async()=>{
      status();
      const target=entry;
      if(!target) throw new MinecraftBridgeError('undo-empty','There is no operation to undo.');
      if(operationId!==undefined&&target.id!==operationId) throw new MinecraftBridgeError('undo-stale-id','The restore point was replaced by another operation; the world was not changed.');
      if(target.state==='invalidated'||target.state==='cleanup-required') throw new MinecraftBridgeError('undo-unavailable','This backup no longer applies or is incomplete, so Undo cannot run.');
      if(target.state==='uncertain'&&!overwriteChanges) throw new MinecraftBridgeError('undo-uncertain','The result of the previous build is uncertain; inspect the site first. Use overwriteChanges only when overwriting the current blocks is explicitly accepted.');
      await requireContext(target);
      const remaining=target.snapshots.filter(s=>!s.restored);
      const checkStart=performance.now();
      if(!overwriteChanges) for(const s of remaining) {
        const result=await checked(guardUndoRegion(s.region,'querytarget @s'),target.epoch,true);
        if(!result.ok) {
          checkMs=Math.round(performance.now()-checkStart);
          reason='Blocks have changed, or the check could not finish; the restore did not start and nothing was overwritten.';
          throw new MinecraftBridgeError('undo-conflict',reason);
        }
      }
      checkMs=Math.round(performance.now()-checkStart);
      const restoreStart=performance.now();
      try {
        for(const s of remaining) {
          const load=worldCommands.loadStructure(s.name,{...s.region.from,mode:'absolute'});
          const result=await checked(overwriteChanges?`execute in overworld run ${load}`:guardUndoRegion(s.region,load),target.epoch,true);
          if(!result.ok) {
            target.state=result.statusCode===null?'uncertain':'partial';
            reason='The restore stopped partway; regions already restored will not be resent, and the remaining backups are kept.';
            throw new MinecraftBridgeError('undo-restore-failed',reason);
          }
          s.restored=true;
        }
      } catch(error) {
        const confirmedFailure = error instanceof MinecraftBridgeError && error.code === 'undo-restore-failed';
        if(!confirmedFailure && status().state!=='invalidated') target.state='uncertain';
        throw error;
      } finally { restoreMs=Math.round(performance.now()-restoreStart); }
      reason='The previous operation was undone; this first version keeps no Redo.';
      await release();
      return completedStatus();
    }),
  };
  const connection: MinecraftConnection = {
    start:()=>base.start(), status:()=>base.status(), awaitConnection:ms=>base.awaitConnection(ms),
    subscribe:event=>base.subscribe(event), unsubscribe:event=>base.unsubscribe(event),
    readEvents:(after,limit,event)=>base.readEvents(after,limit,event),
    runCommand:async command=>{
      if(isReadOnly(command)) return base.runCommand(command);
      return exclusive(async()=>{
        const batch=await execute([command],{stopOnError:true,delayMs:0});
        const result=batch.outcomes[0];
        if(!result) throw new MinecraftBridgeError('undo-no-command-outcome','The game did not report the build result.');
        return {...result,undo:batch.undo!};
      });
    },
    runSequence:(commands,settings)=>commands.every(isReadOnly)?base.runSequence(commands,settings):exclusive(()=>execute(commands,settings)),
    close:async()=>{
      closing=true;
      // Do not race a shutdown cleanup with an in-flight build/restore. Runtime's existing
      // hard-stop still bounds process lifetime; a forced exit leaves memory until world unload.
      try { await running; if(entry && epoch()!=='disconnected') await release(); }
      finally { await base.close(); }
    },
  };
  return { connection, undo };
}

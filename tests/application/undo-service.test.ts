import {describe,it,expect,vi} from 'vitest';
import {createUndoConnection} from '../../src/application/undo-service.js';
import {createUndoWorld} from '../helpers/undo-world.js';

const options={stopOnError:true,delayMs:0};
const twoRegions=['fill 0 20 0 7 20 0 glass','fill 8 20 0 15 20 0 stone'];
const setup=()=>{const w=createUndoWorld();return {w,...createUndoConnection(w.connection)};};

describe('single-step undo lifecycle',()=>{
  it('backs up before writing, restores original block data, and releases memory',async()=>{
    const {w,connection,undo}=setup();w.put(0,20,0,'chest',2,'original treasure');
    const r=await connection.runCommand('setblock 0 20 0 glass');
    expect(r.undo).toMatchObject({available:true,busy:false,state:'ready',storedBlocks:1});
    expect(undo.status().available).toBe(true);
    expect(w.issued.findIndex(c=>c.startsWith('structure save'))).toBeLessThan(w.issued.indexOf('setblock 0 20 0 glass'));
    await undo.undo();
    expect(w.get(0,20,0)).toEqual({block:'chest',data:2,contents:'original treasure'});
    expect(w.snapshots.size).toBe(0);expect(undo.status().state).toBe('empty');
    await expect(undo.undo()).rejects.toThrow('no operation to undo');
  });
  it('treats an entire macro as one step and preserves unmodified holes',async()=>{
    const {w,connection,undo}=setup();
    await connection.runSequence(['setblock 0 20 0 stone','setblock 2 20 0 gold_block','setblock 0 20 0 glass'],options);
    w.put(1,20,0,'diamond_block');await undo.undo();
    expect(w.get(0,20,0).block).toBe('air');expect(w.get(2,20,0).block).toBe('air');expect(w.get(1,20,0).block).toBe('diamond_block');
  });
  it('retires the previous generation before allocating the next',async()=>{
    const {w,connection,undo}=setup();
    for(let i=0;i<5;i++)await connection.runCommand(`fill 0 20 0 7 23 3 ${i%2?'stone':'glass'}`);
    expect(w.peakBlocks()).toBe(128);expect(undo.status().storedBlocks).toBe(128);
    await undo.undo();expect(w.get(0,20,0).block).toBe('stone');
  });
  it('rejects an oversized plan without touching the old history or world',async()=>{
    const {w,connection,undo}=setup();await connection.runCommand('setblock 0 20 0 glass');
    const id=undo.status().operationId, before=w.issued.length;
    await expect(connection.runCommand('fill 0 20 0 20 40 20 stone')).rejects.toThrow('budget');
    expect(w.issued).toHaveLength(before);expect(undo.status().operationId).toBe(id);
  });
  it('does not issue any construction when a later backup fails',async()=>{
    const {w,connection,undo}=setup();let saves=0;
    w.setHook(c=>c.startsWith('structure save')&&++saves===2?w.result(c,false):undefined);
    await expect(connection.runSequence(twoRegions,options)).rejects.toThrow('Backup before building');
    expect(w.issued.some(c=>c.startsWith('fill '))).toBe(false);expect(undo.status().state).toBe('cleanup-required');
    w.setHook(undefined);await undo.configure(undefined,undefined,true);expect(w.snapshots.size).toBe(0);
  });
  it('detects a later block edit or data change without restoring any region',async()=>{
    const {w,connection,undo}=setup();await connection.runCommand('fill 0 20 0 15 20 0 quartz_block');
    w.put(15,20,0,'quartz_block',2);
    await expect(undo.undo()).rejects.toThrow('Blocks have changed');
    expect(w.issued.some(c=>c.includes('structure load'))).toBe(false);
    expect(w.get(0,20,0).block).toBe('quartz_block');expect(w.snapshots.size).toBe(1);
  });
  it('checks again atomically at restore time after a successful preflight',async()=>{
    const {w,connection,undo}=setup();await connection.runCommand('setblock 0 20 0 glass');
    w.setHook(c=>{if(c.includes('structure load'))w.put(0,20,0,'diamond_block');return undefined;});
    await expect(undo.undo()).rejects.toThrow('stopped partway');
    expect(w.get(0,20,0).block).toBe('diamond_block');expect(undo.status().state).toBe('partial');
  });
  it('retains partial construction for explicit recovery and never replays a timeout',async()=>{
    const {w,connection,undo}=setup();
    w.setHook(c=>c==='setblock 1 20 0 stone'?w.result(c,false,{statusCode:null,statusMessage:'timeout'}):undefined);
    await connection.runSequence(['setblock 0 20 0 glass','setblock 1 20 0 stone','setblock 2 20 0 gold_block'],options);
    expect(w.get(0,20,0).block).toBe('glass');expect(w.issued).not.toContain('setblock 2 20 0 gold_block');
    expect(undo.status().state).toBe('uncertain');await expect(undo.undo()).rejects.toThrow('uncertain');
    await expect(connection.runCommand('setblock 3 20 0 glass')).rejects.toThrow('still needs to be undone or cleared');
    await expect(connection.runCommand('time set day')).rejects.toThrow('still needs to be undone or cleared');
    w.setHook(undefined);await undo.undo(undefined,true);expect(w.get(0,20,0).block).toBe('air');
  });
  it('a transport failure during restore never marks the region restored',async()=>{
    const {w,connection,undo}=setup();await connection.runCommand('setblock 0 20 0 glass');
    w.setHook(c=>{if(c.includes('structure load'))throw new Error('transport closed');return undefined;});
    await expect(undo.undo()).rejects.toThrow('transport closed');expect(undo.status()).toMatchObject({state:'uncertain',restoredRegions:0,snapshotCount:1});
  });
  it('does not replay regions already restored after a later failure',async()=>{
    const {w,connection,undo}=setup();await connection.runSequence(twoRegions,options);let loads=0;
    w.setHook(c=>c.includes('structure load')&&++loads===2?w.result(c,false):undefined);
    await expect(undo.undo()).rejects.toThrow('stopped partway');expect(undo.status().restoredRegions).toBe(1);
    w.put(0,20,0,'diamond_block');w.setHook(undefined);await undo.undo();
    expect(w.get(0,20,0).block).toBe('diamond_block');expect(w.get(15,20,0).block).toBe('air');
  });
  it('does not use a different connection or dimension as the same world',async()=>{
    const {w,connection,undo}=setup();await connection.runCommand('setblock 0 20 0 glass');
    w.setDimension(1);await expect(undo.undo()).rejects.toThrow('switched dimensions');
    w.setDimension(0);w.disconnect();w.reconnect();await expect(undo.undo()).rejects.toThrow('no longer applies');
    expect(w.issued.some(c=>c.includes('structure load'))).toBe(false);
    await expect(connection.runCommand('setblock 1 20 0 glass')).rejects.toThrow('still needs to be undone or cleared');
  });
  it('marks a failed transport while resuming partial restoration as uncertain',async()=>{
    const {w,connection,undo}=setup();await connection.runSequence(twoRegions,options);let loads=0;
    w.setHook(c=>c.includes('structure load')&&++loads===2?w.result(c,false):undefined);
    await expect(undo.undo()).rejects.toThrow('stopped partway');
    w.setHook(c=>{if(c.includes('structure load'))throw new Error('socket lost');return undefined;});
    await expect(undo.undo()).rejects.toThrow('socket lost');
    expect(undo.status()).toMatchObject({state:'uncertain',restoredRegions:1});
    await expect(undo.undo()).rejects.toThrow('uncertain');
  });
  it('serializes writes/configuration while allowing status reads',async()=>{
    const {w,connection,undo}=setup();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
    w.setHook(async c=>{if(c.startsWith('structure save'))await gate;return undefined;});
    const pending=connection.runCommand('setblock 0 20 0 glass');await vi.waitFor(()=>expect(undo.status().snapshotCount).toBe(1));
    await expect(connection.runCommand('setblock 1 20 0 stone')).rejects.toThrow('An operation is running');
    await expect(undo.configure(false)).rejects.toThrow('An operation is running');expect(undo.status().busy).toBe(true);
    expect((await connection.runCommand('testforblock 1 20 0 air')).ok).toBe(true);release();await pending;
  });
  it('supports opt-out without allocating snapshots and retires stale history on unmanaged writes',async()=>{
    const {w,connection,undo}=setup();await connection.runCommand('setblock 0 20 0 glass');
    await connection.runCommand('time set day');expect(undo.status().state).toBe('empty');expect(w.snapshots.size).toBe(0);
    await undo.configure(false);const before=w.issued.length;await connection.runCommand('fill 0 20 0 15 30 15 stone');
    expect(w.issued.slice(before)).toEqual(['fill 0 20 0 15 30 15 stone']);
  });
  it('a cleanup error cannot silently allocate a second generation',async()=>{
    const {w,connection,undo}=setup();await connection.runCommand('setblock 0 20 0 glass');
    w.setHook(c=>c.startsWith('structure delete')?w.result(c,false):undefined);
    await expect(connection.runCommand('setblock 1 20 0 glass')).rejects.toThrow('Releasing the old backup');
    expect(w.peakBlocks()).toBe(1);expect(w.get(1,20,0).block).toBe('air');expect(undo.status().state).toBe('cleanup-required');
  });
  it('normal close releases its own memory structures',async()=>{
    const {w,connection}=setup();await connection.runCommand('setblock 0 20 0 glass');await connection.close();
    expect(w.snapshots.size).toBe(0);expect(w.connection.status().connected).toBe(false);
  });
  it('protects 4096 cells with one save, one preflight, and one guarded load',async()=>{
    const {w,connection,undo}=setup();
    const built=await connection.runCommand('fill 0 20 0 15 35 15 glass');
    expect(built.undo).toMatchObject({storedBlocks:4096,snapshotCount:1,available:true});
    const before=w.issued.length;await undo.undo();
    const recovery=w.issued.slice(before);
    expect(recovery.filter(c=>c.includes('if blocks'))).toHaveLength(2);
    expect(recovery.filter(c=>c.includes('structure load'))).toHaveLength(1);
    expect(w.peakBlocks()).toBe(4096);expect(w.snapshots.size).toBe(0);
    expect(w.wireIssued.filter(r=>r.command.startsWith('execute in overworld ')).every(r=>r.version===25)).toBe(true);
  });
  /**
   * `execute` 包住的指令一律當成未追蹤的修改：選擇器與引號裡可以塞進任何字
   * （`@e[name=" run time query noon"]`），所以「看穿 run 找出真正的終端指令」
   * 需要真的懂引號的解析器。第一版不做那件事——寧可把唯讀探測也算成未追蹤
   * 修改（代價是清掉還原點），也不能把一條真的 setblock 誤判成唯讀而繞過
   * 互斥鎖與還原點失效。
   */
  it('treats every execute-wrapped command as an untracked mutation',async()=>{
    const {connection,undo}=setup();await connection.runCommand('setblock 0 20 0 glass');
    expect(undo.status().state).toBe('ready');
    await connection.runCommand('execute as @e[name=" run time query noon"] run setblock 1 20 0 glass');
    expect(undo.status().state).toBe('empty');
  });
  it('does not allocate snapshots or write when native predicate support is unavailable',async()=>{
    const {w,connection,undo}=setup();
    w.setHook(c=>c.startsWith('execute in overworld if blocks')?w.result(c,false,{statusCode:-2147483648,statusMessage:'old execute only'}):undefined);
    await expect(connection.runCommand('setblock 0 20 0 glass')).rejects.toThrow('Checking native whole-region support');
    expect(w.snapshots.size).toBe(0);expect(w.get(0,20,0).block).toBe('air');expect(undo.status().busy).toBe(false);
  });
  it('reports a timed-out dimension query as no reply, not as an unreadable dimension',async()=>{
    const {w,connection,undo}=setup();
    w.setHook(c=>c.startsWith('querytarget')?w.result(c,false,{statusCode:null,statusMessage:'No reply from the game within 10000 ms.'}):undefined);
    await expect(connection.runCommand('setblock 0 20 0 glass')).rejects.toMatchObject({code:'undo-context-no-reply',message:expect.stringContaining('did not reply')});
    expect(w.issued.some(c=>c.startsWith('structure save')||c.startsWith('setblock'))).toBe(false);
    expect(w.get(0,20,0).block).toBe('air');expect(undo.status().busy).toBe(false);
  });
});

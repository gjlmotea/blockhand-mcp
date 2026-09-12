import {describe,it,expect} from 'vitest';
import {planUndo,guardUndoRegion,MAX_UNDO_BLOCKS,type UndoPlan} from '../../src/domain/build/undo-plan.js';
import {createUndoWorld} from '../helpers/undo-world.js';

function expand(plan:UndoPlan):Map<string,string> {
  const cells=new Map<string,string>();
  for(const r of plan.regions)for(let x=r.from.x;x<=r.to.x;x++)for(let y=r.from.y;y<=r.to.y;y++)for(let z=r.from.z;z<=r.to.z;z++) {
    const key=`${x},${y},${z}`;
    expect(cells.has(key),'snapshot regions must be disjoint').toBe(false);
    cells.set(key,r.block);
  }
  return cells;
}

describe('bounded undo planning',()=>{
  it('deduplicates overlapping writes and snapshots only the changed mask',()=>{
    const p=planUndo(['fill 0 10 0 2 10 0 stone','setblock 1 10 0 glass','setblock 10 10 0 gold_block'],128)!;
    expect(p.blockCount).toBe(4);
    expect(expand(p).get('1,10,0')).toBe('glass');
    expect(p.regions.reduce((n,r)=>n+r.blockCount,0)).toBe(4);
    expect(expand(p).has('5,10,0')).toBe(false);
  });
  it('includes hollow interiors and excludes untouched outline interiors',()=>{
    const h=planUndo(['fill 0 10 0 2 12 2 glass hollow'],128)!;
    expect(h.blockCount).toBe(27);expect(expand(h).get('1,11,1')).toBe('air');
    const outline=planUndo(['fill 0 10 0 2 12 2 glass outline'],128)!;
    expect(outline.blockCount).toBe(26);expect(expand(outline).has('1,11,1')).toBe(false);
  });
  it.each(['fill 0 0 0 20000000 320 20000000 stone','fill 0 0 0 5 5 5 glass'])('rejects large bounds before enumerating them: %s',command=>{
    expect(()=>planUndo([command],128)).toThrow('預算');
  });
  it('applies one budget to the whole command sequence',()=>{
    expect(()=>planUndo(['fill 0 0 0 127 0 0 glass','setblock 128 0 0 glass'],128)).toThrow('整個操作');
  });
  it.each(['setblock ~ ~ ~ stone','setblock 0 10 0 chest','setblock 0 10 0 water','setblock 0 10 0 sand','setblock 0 10 0 stone destroy','fill 0 10 0 1 10 1 stone replace dirt','setblock 0 10 0 quartz_block ["chisel_type":"lines"]'])('rejects unsupported semantics: %s',command=>{
    expect(()=>planUndo([command],128)).toThrow('自動 Undo');
  });
  it('rejects mixed macros rather than silently omitting some writes',()=>{
    expect(()=>planUndo(['setblock 0 10 0 stone','summon pig'],128)).toThrow('混入');
    expect(planUndo(['summon pig'],128)).toBeNull();
  });
  it('rejects excessive snapshot fragmentation',()=>{
    expect(()=>planUndo(Array.from({length:65},(_,i)=>`setblock ${i*2} 20 0 glass`),128)).toThrow('太零散');
  });
  it('keeps native restore guards within the command limit even at extreme coordinates',()=>{
    const p=planUndo(['fill 29999993 100 -30000000 30000000 107 -29999993 light_blue_stained_glass'],MAX_UNDO_BLOCKS)!;
    expect(p.regions).toHaveLength(1);
    for(const r of p.regions)expect(guardUndoRegion(r,`structure load bhundo_${'a'.repeat(32)}_63 ${r.from.x} ${r.from.y} ${r.from.z}`).length).toBeLessThanOrEqual(1024);
  });
  it('represents 32768 uniform cells in one region and a bounded-size guard',()=>{
    const p=planUndo(['fill 0 20 0 31 51 31 glass'],MAX_UNDO_BLOCKS)!;
    expect(p.blockCount).toBe(32768);expect(p.regions).toHaveLength(1);
    expect('cells' in p).toBe(false);expect('cells' in p.regions[0]!).toBe(false);
    const command=guardUndoRegion(p.regions[0]!,'testforblock 0 20 0 glass 0');
    expect(command.match(/if blocks /g)).toHaveLength(3);expect(command.length).toBeLessThan(400);
  });
  it('merges fragmented input and respects native structure dimensions',()=>{
    const p=planUndo(Array.from({length:128},(_,i)=>`setblock ${i%16} 20 ${Math.floor(i/16)} glass`),4096)!;
    expect(p.regions).toHaveLength(1);
    const line=planUndo(['fill 0 20 0 1023 20 0 glass'],4096)!;
    expect(line.regions).toHaveLength(32);expect(line.regions.every(r=>r.to.x-r.from.x<32)).toBe(true);
  });
  it('matches an independent voxel model across overlapping fills, hollow, and outline',()=>{
    let seed=91437;
    const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%6;};
    for(let trial=0;trial<30;trial++) {
      const w=createUndoWorld(),commands:string[]=[];
      for(let i=0;i<8;i++) {
        const command=`fill ${rand()} ${20+rand()} ${rand()} ${rand()} ${20+rand()} ${rand()} ${i%2?'glass':'stone'} ${['replace','hollow','outline'][i%3]}`;
        commands.push(command);w.apply(command);
      }
      expect(expand(planUndo(commands,4096)!)).toEqual(new Map([...w.cells].map(([key,value])=>[key,value.block])));
    }
  });
  it.each([
    ['point','fill 0 20 0 0 20 0 glass'],
    ['line','fill 0 20 0 7 20 0 glass'],
    ['plane','fill 0 20 0 7 20 7 glass'],
    ['volume','fill 0 20 0 7 27 7 glass'],
  ])('native guard rejects every possible single-cell defect in a %s',(_name,command)=>{
    const w=createUndoWorld();w.apply(command);
    const plan=planUndo([command],4096)!;
    const guard=guardUndoRegion(plan.regions[0]!,'testforblock 0 20 0 glass 0');
    expect(w.apply(guard).ok).toBe(true);
    for(const key of expand(plan).keys()) {
      const [x,y,z]=key.split(',').map(Number) as [number,number,number];
      w.put(x,y,z,'diamond_block');expect(w.apply(guard).ok).toBe(false);w.put(x,y,z,'glass');
    }
  });
  it('checks all axes and the anchor data, including uniform metadata changes',()=>{
    const w=createUndoWorld();w.apply('fill 0 20 0 3 23 3 quartz_block');
    const r=planUndo(['fill 0 20 0 3 23 3 quartz_block'],4096)!.regions[0]!;
    const command=guardUndoRegion(r,'testforblock 0 20 0 quartz_block 0');
    for(const axis of ['x','y','z'] as const) {
      for(let x=0;x<4;x++)for(let y=20;y<24;y++)for(let z=0;z<4;z++) {
        const coordinate={x,y:y-20,z}[axis];w.put(x,y,z,coordinate===2?'stone':'quartz_block');
      }
      expect(w.apply(command).ok).toBe(false);
    }
    for(let x=0;x<4;x++)for(let y=20;y<24;y++)for(let z=0;z<4;z++)w.put(x,y,z,'quartz_block',2);
    expect(w.apply(command).ok).toBe(false);
  });
});

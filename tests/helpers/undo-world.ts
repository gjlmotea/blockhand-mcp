import type { CommandOutcome, ConnectionStatus, Vec3 } from '../../src/domain/contracts.js';
import type { MinecraftConnection } from '../../src/ports/minecraft-connection.js';

type Cell={block:string;data:number;contents?:string};
export function createUndoWorld() {
  const cells=new Map<string,Cell>();
  const snapshots=new Map<string,Array<{offset:Vec3;cell:Cell}>>();
  const issued:string[]=[];
  const wireIssued:Array<{command:string;version:number}>=[];
  let connected=true,connectionCount=1,dimension=0,peakBlocks=0;
  let hook: ((command:string)=>Promise<CommandOutcome|undefined>|CommandOutcome|undefined)|undefined;
  const get=(x:number,y:number,z:number):Cell=>cells.get(`${x},${y},${z}`)??{block:'air',data:0};
  const put=(x:number,y:number,z:number,block:string,data=0,contents?:string)=>cells.set(`${x},${y},${z}`,contents===undefined?{block,data}:{block,data,contents});
  const result=(commandLine:string,ok=true,overrides:Partial<CommandOutcome>={}):CommandOutcome=>({ok,commandLine,statusCode:ok?0:-2147352576,statusMessage:ok?null:'game rejected',data:null,elapsedMs:1,...overrides});
  function apply(command:string):CommandOutcome {
    if(command.startsWith('execute in overworld ')) {
      let remaining=command.slice('execute in overworld '.length);
      while(!remaining.startsWith('run ')) {
        const compare=/^(if|unless) blocks (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) all (.+)$/.exec(remaining);
        const single=/^(if|unless) block (-?\d+) (-?\d+) (-?\d+) (\S+) (-?\d+) (.+)$/.exec(remaining);
        let matches:boolean;
        let positive:boolean;
        if(compare) {
          const [ax,ay,az,bx,by,bz,dx,dy,dz]=compare.slice(2,11).map(Number) as [number,number,number,number,number,number,number,number,number];
          matches=true;
          for(let x=ax;x<=bx;x++)for(let y=ay;y<=by;y++)for(let z=az;z<=bz;z++) {
            if(JSON.stringify(get(x,y,z))!==JSON.stringify(get(dx+x-ax,dy+y-ay,dz+z-az))) matches=false;
          }
          positive=compare[1]==='if'; remaining=compare[11]!;
        } else if(single) {
          const cell=get(Number(single[2]),Number(single[3]),Number(single[4]));
          matches=cell.block===single[5]&&cell.data===Number(single[6]);
          positive=single[1]==='if'; remaining=single[7]!;
        } else return result(command,false,{statusCode:-2147483648,statusMessage:'unsupported execute syntax'});
        if(matches!==positive)return result(command,false);
      }
      return {...apply(remaining.slice(4)),commandLine:command};
    }
    const guarded=/^execute @s ~ ~ ~ detect (-?\d+) (-?\d+) (-?\d+) (\S+) (\d+) (.+)$/.exec(command);
    if(guarded) {
      const actual=get(Number(guarded[1]),Number(guarded[2]),Number(guarded[3]));
      return actual.block===guarded[4]&&actual.data===Number(guarded[5]) ? {...apply(guarded[6]!),commandLine:command} : result(command,false);
    }
    const t=command.split(/\s+/);
    if(t[0]==='querytarget') return result(command,true,{data:{details:JSON.stringify([{dimension,position:{x:10,y:64,z:10}}])}});
    if(t[0]==='testforblock') {
      const cell=get(Number(t[1]),Number(t[2]),Number(t[3]));
      return result(command,cell.block===t[4]&&(t[5]===undefined||Number(t[5])===-1||cell.data===Number(t[5])));
    }
    if(t[0]==='structure'&&t[1]==='save') {
      const [x1,y1,z1,x2,y2,z2]=t.slice(3,9).map(Number) as [number,number,number,number,number,number];
      const copy:Array<{offset:Vec3;cell:Cell}>=[];
      for(let x=x1;x<=x2;x++)for(let y=y1;y<=y2;y++)for(let z=z1;z<=z2;z++)copy.push({offset:{x:x-x1,y:y-y1,z:z-z1},cell:structuredClone(get(x,y,z))});
      snapshots.set(t[2]!,copy);
      peakBlocks=Math.max(peakBlocks,[...snapshots.values()].reduce((n,s)=>n+s.length,0));
      return result(command);
    }
    if(t[0]==='structure'&&t[1]==='delete') {
      return snapshots.delete(t[2]!)?result(command):result(command,false,{statusMessage:`找不到 mystructure:${t[2]} 結構。請確定名稱拼寫正確，然後重試一次。`});
    }
    if(t[0]==='structure'&&t[1]==='load') {
      const saved=snapshots.get(t[2]!);
      if(!saved) return result(command,false);
      for(const {offset,cell} of saved)cells.set(`${Number(t[3])+offset.x},${Number(t[4])+offset.y},${Number(t[5])+offset.z}`,structuredClone(cell));
      return result(command);
    }
    if(t[0]==='setblock') { put(Number(t[1]),Number(t[2]),Number(t[3]),t[4]!.replace(/^minecraft:/,''));return result(command); }
    if(t[0]==='fill') {
      const [x1,y1,z1,x2,y2,z2]=t.slice(1,7).map(Number) as [number,number,number,number,number,number];
      const mode=t.at(-1),block=t[7]!.replace(/^minecraft:/,'');
      for(let x=Math.min(x1,x2);x<=Math.max(x1,x2);x++)for(let y=Math.min(y1,y2);y<=Math.max(y1,y2);y++)for(let z=Math.min(z1,z2);z<=Math.max(z1,z2);z++) {
        const boundary=x===x1||x===x2||y===y1||y===y2||z===z1||z===z2;
        if(mode==='outline'&&!boundary)continue;
        put(x,y,z,mode==='hollow'&&!boundary?'air':block);
      }
    }
    return result(command);
  }
  const status=():ConnectionStatus=>({listening:true,host:'127.0.0.1',port:19131,connected,connectCommand:'/connect 127.0.0.1:19131',connectedAt:connected?'2026-09-12T10:00:00Z':null,connectionCount,subscribedEvents:[],bufferedEvents:0,commandsIssued:issued.length,encrypted:true});
  const connection:MinecraftConnection={
    start:async()=>{},close:async()=>{connected=false;},status,awaitConnection:async()=>status(),
    runCommand:async(command,options)=>{
      if(!connected)throw new Error('disconnected');
      wireIssued.push({command,version:options?.commandVersion??1});
      if(command.startsWith('execute in overworld ')&&options?.commandVersion!==25)return result(command,false,{statusCode:-2147483648,statusMessage:'legacy command version'});
      const inner=command.replace(/^execute in overworld run /,'');
      issued.push(inner);
      return await hook?.(inner)??apply(inner);
    },
    runSequence:async(commands,options)=>{
      const outcomes:CommandOutcome[]=[];
      for(const c of commands){const r=await connection.runCommand(c);outcomes.push(r);if(!r.ok&&options.stopOnError)break;}
      const succeeded=outcomes.filter(r=>r.ok).length;
      return {ok:succeeded===outcomes.length,issued:outcomes.length,succeeded,failed:outcomes.length-succeeded,firstFailure:outcomes.find(r=>!r.ok)??null,outcomes,elapsedMs:1};
    },
    subscribe:async()=>{},unsubscribe:async()=>{},readEvents:()=>({events:[],nextCursor:0,dropped:0}),
  };
  return {connection,cells,snapshots,issued,wireIssued,get,put,result,apply,
    peakBlocks:()=>peakBlocks,
    setHook:(next:typeof hook)=>{hook=next;},setDimension:(next:number)=>{dimension=next;},
    disconnect:()=>{connected=false;},reconnect:()=>{connected=true;connectionCount++;},
  };
}

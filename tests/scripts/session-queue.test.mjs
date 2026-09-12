import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionQueue } from '../../scripts/lib/session-queue.mjs';

const success = () => ({ isError: false, structuredContent: { ok: true, statusCode: 0, elapsedMs: 10 } });
const deferred = () => { let resolve; let reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
afterEach(() => vi.useRealTimers());

describe('persistent build session queue', () => {
  it('a polling caller timing out does not cancel a slow command or later work', async () => {
    vi.useFakeTimers();
    const pending=deferred(),saved=[];
    const call=vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(success());
    const q=createSessionQueue({call,save:s=>saved.push(s)});
    expect(q.submit(['fill 0 0 0 1 1 1 glass','fill 0 0 0 0 0 0 air']).status).toBe('running');
    const waiter=Promise.race([q.finished(),new Promise(resolve=>setTimeout(()=>resolve('caller-timeout'),20))]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await waiter).toBe('caller-timeout');
    expect(q.snapshot()).toMatchObject({status:'running',nextIndex:0,inFlight:{index:0}});
    expect(call).toHaveBeenCalledTimes(1);
    pending.resolve(success());
    await q.finished();
    expect(q.snapshot()).toMatchObject({status:'complete',nextIndex:2,inFlight:null});
    expect(call).toHaveBeenCalledTimes(2);
    expect(saved.some(s=>s.nextIndex===1&&s.inFlight===null)).toBe(true);
  });

  it('writes the in-flight checkpoint before dispatch and rejects overlapping jobs', async () => {
    const pending=deferred(),saved=[];
    const call=vi.fn(()=>{expect(saved.at(-1).inFlight).toEqual({index:0,command:'time query daytime'});return pending.promise;});
    const q=createSessionQueue({call,save:s=>saved.push(s)});
    q.submit(['time query daytime']);
    expect(()=>q.submit(['say second'])).toThrow('already running');
    await Promise.resolve(); pending.resolve(success()); await q.finished();
  });

  it('does not issue later commands or retry an uncertain transport failure', async () => {
    const call=vi.fn().mockRejectedValue(new Error('transport closed'));
    const q=createSessionQueue({call,save:()=>{}});
    q.submit(['summon tropicalfish 0 40 0','summon tropicalfish 1 40 0']);await q.finished();
    expect(q.snapshot()).toMatchObject({status:'uncertain',nextIndex:0,inFlight:{index:0}});
    expect(call).toHaveBeenCalledTimes(1);
    expect(()=>q.submit(['summon tropicalfish 0 40 0'])).toThrow('no automatic replay');
  });

  it('treats game-command timeout as uncertain even though MCP returned normally', async () => {
    const call=vi.fn().mockResolvedValue({structuredContent:{ok:false,statusCode:null,statusMessage:'timeout'}});
    const q=createSessionQueue({call,save:()=>{}});
    q.submit(['fill 0 0 0 1 1 1 glass']);await q.finished();
    expect(q.snapshot()).toMatchObject({status:'uncertain',nextIndex:0,inFlight:{index:0}});
  });

  it('retains the in-flight command when an MCP error has no definitive game outcome', async () => {
    const call=vi.fn().mockResolvedValue({isError:true,content:[{type:'text',text:'handler failed'}]});
    const q=createSessionQueue({call,save:()=>{}});
    q.submit(['summon tropicalfish 0 40 0']);await q.finished();
    expect(q.snapshot()).toMatchObject({status:'uncertain',nextIndex:0,inFlight:{index:0,command:'summon tropicalfish 0 40 0'}});
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('stops at a rejected game command and preserves its index', async () => {
    const call=vi.fn().mockResolvedValue({structuredContent:{ok:false,statusCode:-1,statusMessage:'syntax error'}});
    const q=createSessionQueue({call,save:()=>{}});
    q.submit(['bad command','time query daytime']);await q.finished();
    expect(q.snapshot()).toMatchObject({status:'failed',nextIndex:0,inFlight:null});
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('accepts only the specific zero-change fill outcome as an idempotent no-op', async () => {
    const zero={isError:false,structuredContent:{ok:false,statusCode:-2147352576,data:{fillCount:0}}};
    const call=vi.fn().mockResolvedValueOnce(zero).mockResolvedValueOnce(success());
    const q=createSessionQueue({call,save:()=>{}});
    q.submit(['fill 0 0 0 0 0 0 air','time query daytime']);await q.finished();
    expect(q.snapshot()).toMatchObject({status:'complete',nextIndex:2,noops:1});
    const other=createSessionQueue({call:async()=>zero,save:()=>{}});
    other.submit(['summon tropicalfish 0 0 0']);await other.finished();
    expect(other.snapshot().status).toBe('failed');
  });

  it('stops dispatch if acknowledging a command cannot be saved', async () => {
    let writes=0;const call=vi.fn().mockResolvedValue(success());
    const q=createSessionQueue({call,save:()=>{if(++writes===3)throw new Error('disk full');}});
    q.submit(['time query daytime','time query daytime']);await q.finished();
    expect(q.snapshot()).toMatchObject({status:'uncertain',nextIndex:1});
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('isolates plan input and progress display errors from execution', async () => {
    const input=['time query daytime'];const call=vi.fn().mockResolvedValue(success());
    const q=createSessionQueue({call,save:()=>{},publish:()=>{throw new Error('display closed');}});
    q.submit(input);input[0]='kill @a';await q.finished();
    expect(call).toHaveBeenCalledWith('mc_run_command',{command:'time query daytime'});
    expect(q.snapshot().status).toBe('complete');
  });

  it.each([[],[''],['say one\nsay two'],[null],Array(20001).fill('time query daytime')])('rejects invalid plans before dispatch', input => {
    const call=vi.fn(),q=createSessionQueue({call,save:()=>{}});
    expect(()=>q.submit(input)).toThrow('single-line');expect(call).not.toHaveBeenCalled();
  });
});

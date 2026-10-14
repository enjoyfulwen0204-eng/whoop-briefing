// Synthetic-only diagnostics: counts/durations, never values, IDs, SQL or keys.
import {createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {PerformanceObserver} from 'node:perf_hooks';
export function installLateProfile(){
 const scope=new AsyncLocalStorage(),totals=new Map(),unique=new Map();let enabled=false,start,base,peak,gcMs=0,gcCount=0;
 const observation=new PerformanceObserver(list=>{if(enabled)for(const e of list.getEntries()){gcMs+=e.duration;gcCount++;}});observation.observe({entryTypes:['gc']});
 const count=(label,ms,exclusive,bytes=0)=>{const s=totals.get(label)??{calls:0,inclusiveMs:0,exclusiveMs:0,bytes:0};s.calls++;s.inclusiveMs+=ms;s.exclusiveMs+=exclusive;s.bytes+=bytes;totals.set(label,s);};
 const memory=()=>{const m=process.memoryUsage();if(peak)for(const k of Object.keys(m))peak[k]=Math.max(peak[k],m[k]);return m;};
 const api={
  wrap(label,fn){return async function(...args){if(!enabled)return fn.apply(this,args);const parent=scope.getStore(),frame={child:0},at=performance.now();try{const result=await scope.run(frame,()=>fn.apply(this,args));if(label==='RAW_UNIT'&&result?.unit)count('UNIT_'+result.unit,0,0);return result;}finally{const elapsed=performance.now()-at;if(parent)parent.child+=elapsed;count(label,elapsed,Math.max(0,elapsed-frame.child));}};},
  sync(label,fn){if(!enabled)return fn();const parent=scope.getStore(),at=performance.now();let result;try{return result=fn();}finally{const elapsed=performance.now()-at;if(parent)parent.child+=elapsed;count(label,elapsed,elapsed,typeof result==='string'?Buffer.byteLength(result):0);}},
  sql(stmt,result,ms){if(!enabled)return;const sql=typeof stmt==='string'?stmt:stmt.sql??'',args=typeof stmt==='string'?[]:stmt.args??[],label=/phase4_source_links/.test(sql)?'SQL_GRAPH':/evidence_runs|evidence_items/.test(sql)?'SQL_RUN_ITEM':/phase4_.*authorit|phase4_operation_receipts|phase4_execution_producers/.test(sql)?'SQL_AUTHORITY':'SQL_OTHER';count(label,ms,ms);const identity=createHash('sha256').update(JSON.stringify([sql,args])).digest('hex');const set=unique.get(label)??new Set();set.add(identity);unique.set(label,set);memory();},
  mark(label,ms){if(enabled)count(label,ms,ms);memory();},
  start(){totals.clear();unique.clear();enabled=true;gcMs=0;gcCount=0;start=performance.now();base=memory();peak={...base};},
  stop(){const elapsedMs=performance.now()-start,end=memory();enabled=false;return {elapsedMs,base,peak,end,gcMs,gcCount,operations:Object.fromEntries([...totals].map(([k,v])=>[k,{...v,uniqueSql:unique.get(k)?.size}]))};},
  close(){enabled=false;observation.disconnect();scope.disable();delete globalThis.__stage6LateProfile;}
 };globalThis.__stage6LateProfile=api;return api;
}

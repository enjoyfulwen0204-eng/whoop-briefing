// Real installed rotating-connection driver in a separate OS process. The
// wrapper only reports native BEGIN contention; it does not emulate storage.
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { composeDb } from '../src/db.js';
import { fixtureKeys } from './localDb.js';
import { createPhase4Foundation } from '../src/phase4Foundation.js';
import { T } from './stage5ReviewBFixture.js';
const [url,role]=process.argv.slice(2),client=createClient({url});
let performing=false,context,reconnects=0,admissionReads=0,ddlAfterReady=0;
const reconnect=client.reconnect.bind(client),execute=client.execute.bind(client);
Object.defineProperty(client,'reconnect',{value:async(...args)=>{reconnects++;return reconnect(...args);},writable:true,configurable:true});
client.execute=async statement=>{const sql=typeof statement==='string'?statement:statement.sql;
 if(performing&&sql.includes('FROM sqlite_master'))admissionReads++;
 if(performing&&/^\s*(CREATE|ALTER|DROP)\b/i.test(sql))ddlAfterReady++;
 return execute(statement);};
const original=client.transaction.bind(client);
client.transaction=async(...args)=>{
  try{return await original(...args);}catch(error){if(error.code==='SQLITE_BUSY')process.send({kind:performing?'busy':'startup-busy'});throw error;}
};
const db=composeDb(client,{phase4Keys:fixtureKeys}),admission=await db.admitRuntime(),stores=await createPhase4Foundation({db,keys:fixtureKeys,admission,now:()=>new Date(T)});
const commands=new Map();
process.on('message',message=>{const queued=commands.get(message);if(typeof queued==='function')queued();else commands.set(message,true);});
const command=name=>commands.get(name)===true?Promise.resolve():new Promise(resolve=>commands.set(name,resolve));
try {
  process.send({kind:'initialized'});await command('capture');
  context=await stores.capture('a',{executionMode:'SHADOW'});
  // Prepare one coherent source snapshot before the deliberate operation race.
  // Avoid retaining dozens of completed native connections at the IPC barrier.
  const refs=await db.transaction(async()=>{
    const rows=(await db.raw.execute("SELECT sleep_id FROM whoop_recoveries WHERE user_id='a' ORDER BY sleep_id")).rows,refs=[];
    for(const row of rows)refs.push((await stores.root(context,'recovery',row.sleep_id)).ref);
    return refs;
  });
  global.gc?.();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  process.send({kind:'ready'});await command('go');performing=true;
  const perform=()=>stores.intelligence.analyzeMetric(context,{metricKey:'recovery_score',currentSource:refs[0],baselineSources:refs.slice(1),asOfUtc:T,windowFamily:'PROCESS_EQUIVALENT'});
  const result=role==='holder'?await db.transaction(async()=>{
    process.send({kind:'locked'});await command('continue');return perform();
  }):await perform();
  if(reconnects)assert.throws(()=>db.requireRuntimeAdmission(admission));
  const fresh=await db.admitRuntime();assert.equal(db.requireRuntimeAdmission(fresh),32);if(reconnects)assert.notEqual(fresh,admission);
  process.send({kind:'retry-proof',reconnects,admissionReads,ddlAfterReady,oldCapabilityRejected:Boolean(reconnects)});
  process.send({kind:'result',runId:result.run.row.run_id,itemId:result.item.row.evidence_item_id,resultState:result.resultState,
    episodeId:result.episode.episode.row.episode_id,revision:result.episode.episode.row.revision});
} catch(error) {process.send({kind:'error',code:error.code,message:error.message,stack:error.stack});process.exitCode=1;}
finally {
  // Only preparation owns manual cleanup. Successful operation callers must
  // prove the runtime itself released their leases; do not mask that assertion.
  if(context&&!performing)await stores.release(context);
  global.gc?.();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  db.close();global.gc?.();await new Promise(resolve=>setImmediate(resolve));process.disconnect();
}

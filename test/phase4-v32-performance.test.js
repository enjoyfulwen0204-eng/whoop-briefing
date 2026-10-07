import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {createOwnedDb} from './stage5OwnedDb.js';import {fixtureKeys} from './localDb.js';import {createDb} from '../src/db.js';
import {admitRuntime} from '../src/runtimeAdmission.js';import {hranaTransport} from './hranaTransport.js';
import {runExecutionPhase} from '../src/phase4Execution.js';import {configurationProof} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';
test('v32 five-query fresh metadata admission cost independent of 1000 tenants / 50000 health-history rows',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-v32-performance-')),db=createOwnedDb({url:`file:${join(dir,'db.sqlite')}`});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});await db.migrate({targetVersion:32});const execute=db.raw.execute;
 for(const populated of [false,true]){
  if(populated){await execute(`WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<1000)
   INSERT INTO users(id,display_name,timezone,status,created_at,updated_at) SELECT 'fixture-'||x,'Synthetic','Asia/Taipei','ACTIVE','2026-10-08','2026-10-08' FROM n`);
   await execute(`WITH RECURSIVE n(x) AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<50000)
   INSERT INTO whoop_cycles(user_id,id,synced_at) SELECT 'fixture-1','cycle-'||x,'2026-10-08' FROM n`);}
  for(const latencyMs of [0,20,50,150]){const queries=[];db.raw.execute=async q=>{queries.push(typeof q==='string'?q:q.sql);if(latencyMs)await new Promise(r=>setTimeout(r,latencyMs));return execute(q);};
   const at=performance.now();await admitRuntime(db.raw,fixtureKeys);const durationMs=performance.now()-at;
   assert.equal(queries.length,5);assert.ok(queries.every(q=>/^SELECT|^PRAGMA (foreign_keys|ignore_check_constraints)/.test(q)));assert.ok(durationMs<10000);
   console.log(JSON.stringify({measurement:'v32_admission',latencyMs,tenants:populated?1000:0,historyRows:populated?50000:0,queries:queries.length,durationMs}));
  }db.raw.execute=execute;
 }
});
test('v32 actual HTTP settlement and lost-ack reconciliation at local/20/50/150ms transport latency',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-v32-settlement-perf-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});await seed.close();t.after(()=>rm(dir,{recursive:true,force:true}));
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off'};
 for(const latencyMs of [0,20,50,150]){const transport=hranaTransport(url);let queries=0;
  const db=createDb({url:'https://isolated.invalid',fetch:async q=>{queries++;if(latencyMs)await new Promise(r=>setTimeout(r,latencyMs));return transport.fetch(q);},phase4Keys:fixtureKeys});
  try{const value={requestId:randomUUID(),phase:'SYNC',releaseSha:runningReleaseSha(),triggerSource:'manual',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment)};
   let work=0;const options={db,request:value,environment,keys:fixtureKeys,env:{timezone:'Asia/Taipei'},deps:{runBriefing:async()=>{work++;transport.arm({loseAcknowledgement:true});return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'};}}};
   const at=performance.now(),first=await runExecutionPhase(options),settlementMs=performance.now()-at;
   assert.equal(first.body.result.outcome,'COMMIT_INDETERMINATE');assert.equal(first.body.drainAuthorized,false);
   const retryAt=performance.now(),reconciled=await runExecutionPhase(options),reconciliationMs=performance.now()-retryAt;
   assert.equal(reconciled.body.syncComplete,true);assert.equal(work,1);
   console.log(JSON.stringify({measurement:'v32_settlement_reconciliation',latencyMs,settlementMs,reconciliationMs,transportRequests:queries}));
  }finally{db.close();transport.close();}
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createClient} from '@libsql/client';
import {createOwnedDb} from './stage5OwnedDb.js';
import {createDb} from '../src/db.js';
import {hranaTransport} from './hranaTransport.js';
import {fixtureKeys} from './localDb.js';
import {createSync} from '../src/sync.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof,canonicalPhaseRequest} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {currentExecutionBudget} from '../src/executionBudget.js';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'sync-input-checks-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});
 await seed.createUser({id:'alice',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 await seed.saveTokens('alice',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000),whoopUserId:'1001'});
 await seed.saveCapabilities('alice',[{key:'sleep',status:'SUPPORTED'}],{expectedLifecycleGeneration:1});
 await seed.saveSyncState('alice','sleep',{backfillComplete:true,lastSuccessAt:'2026-10-01T00:00:00Z'});
 await seed.close();
 const transport=hranaTransport(url),db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:transport.fetch}),other=createClient({url});
 await db.admitRuntime();
 t.after(async()=>{db.close();other.close();transport.close();await rm(dir,{recursive:true,force:true});});
 return {db,other,transport};
}
const now=new Date('2026-10-11T00:00:00Z');
const payload=[{id:'synthetic-sleep',user_id:1001,start:'2026-10-10T16:00:00Z',end:'2026-10-10T23:00:00Z',timezone_offset:'+08:00',nap:false,score_state:'SCORED',created_at:'2026-10-10T23:00:00Z',updated_at:'2026-10-10T23:00:00Z',score:{sleep_performance_percentage:85}}];
async function run(db,onProvider){
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',BRIEFING_CONTINUATION_SCOPE:'sync'};
 const request={requestId:`p4s1_${randomUUID()}`,releaseSha:runningReleaseSha(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(fixtureKeys,{runtime:'off',mode:'off'},environment)};
 let syncResult,providerCalls=0;
 const response=await runExecutionPhase({db,keys:fixtureKeys,request,body:canonicalPhaseRequest(request),environment,env:{dryRun:true,timezone:'Asia/Taipei'},now,
  deps:{runBriefing:async()=>{
   syncResult=await createSync({db,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,now,budget:currentExecutionBudget(),whoop:{sleeps:async()=>{providerCalls++;assert.equal(db.processingTransactionActive(),false);await onProvider?.(request);return structuredClone(payload);}}}).syncAll({resources:['sleep'],force:true});
   return {syncComplete:syncResult.complete,syncOutcome:syncResult.outcome,users:1,failed:syncResult.complete?0:1};
  }}});
 return {response,syncResult,providerCalls,request};
}
for(const [name,sql] of [
 ['auth',"UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='alice'"],
 ['WHOOP identity',"UPDATE user_whoop_tokens SET whoop_user_id='1002' WHERE user_id='alice'"],
 ['lifecycle',"UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='alice'"],
 ['timezone',"UPDATE users SET timezone='UTC' WHERE id='alice'"],
 ['purge',"UPDATE phase4_user_state SET purge_generation=purge_generation+1 WHERE user_id='alice'"],
 ['pending purge',"UPDATE phase4_user_state SET pending_purge_count=1 WHERE user_id='alice'"],
])test(`actual HTTP input metadata BEFORE rejects fresh ${name} change before canonical writes`,async t=>{
 const {db,other}=await fixture(t);
 const result=await run(db,()=>other.execute(sql));
 assert.equal(result.providerCalls,1);assert.equal(result.response.body.syncComplete,false);assert.equal(result.syncResult.complete,false);
 assert.equal((await other.execute("SELECT COUNT(*) n FROM whoop_sleeps WHERE user_id='alice'")).rows[0].n,0);
 assert.equal((await other.execute("SELECT last_success_at FROM whoop_sync_state WHERE user_id='alice' AND resource='sleep'")).rows[0].last_success_at,'2026-10-01T00:00:00Z');
});
test('actual HTTP marked metadata cannot write, even through a lifecycle callback replacement',async t=>{
 const {db,other}=await fixture(t),original=db.assertAccountActive;let armed=false;
 db.assertAccountActive=async(...args)=>armed?db.raw.execute("INSERT INTO telegram_state VALUES('forbidden-check','value','2026-10-11')"):original(...args);
 const result=await run(db,async()=>{armed=true;});assert.equal(result.response.body.syncComplete,false);
 assert.equal((await other.execute("SELECT COUNT(*) n FROM telegram_state WHERE key='forbidden-check'")).rows[0].n,0);
 assert.equal((await other.execute("SELECT COUNT(*) n FROM whoop_sleeps WHERE user_id='alice'")).rows[0].n,0);
});
test('input proof failure keeps priority and waits for the independently failing lifecycle sibling',async t=>{
 const {db,other}=await fixture(t),original=db.assertAccountActive;let armed=false,settled=false;
 db.assertAccountActive=async(...args)=>{if(!armed)return original(...args);await new Promise(resolve=>setTimeout(resolve,20));settled=true;throw Error('SECONDARY_LIFECYCLE_FAILURE');};
 const result=await run(db,async()=>{await other.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='alice'");armed=true;});
 assert.equal(settled,true);assert.equal(result.syncResult.resources[0].status,'stale_authorization');
 assert.equal((await other.execute("SELECT COUNT(*) n FROM whoop_sleeps WHERE user_id='alice'")).rows[0].n,0);
});
test('unchanged synthetic authority commits one source and receipts without claiming a whole SYNC',async t=>{
 const {db,other}=await fixture(t);const result=await run(db);
 assert.equal(result.response.status,207);assert.equal(result.syncResult.complete,false);assert.equal(result.syncResult.outcome,'PARTIAL');
 assert.equal(result.syncResult.resources[0].status,'ok');assert.equal(result.syncResult.processed,1);assert.equal(result.providerCalls,1);
 assert.equal((await other.execute("SELECT COUNT(*) n FROM whoop_sleeps WHERE user_id='alice'")).rows[0].n,1);
 const receipts=(await other.execute({sql:'SELECT result_json FROM phase4_execution_work_receipts WHERE execution_id=?',args:[result.request.requestId]})).rows;
 assert.ok(receipts.length>0);assert.ok(receipts.some(row=>row.result_json==='1'));
});

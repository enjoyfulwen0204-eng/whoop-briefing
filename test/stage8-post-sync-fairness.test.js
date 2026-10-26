import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Sqlite3Transaction} from '@libsql/client/sqlite3';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {canonicalJson} from '../src/phase4EntityStore.js';
import {createSync} from '../src/sync.js';
import {recordStage8SyncSubject,createStage8PostSync} from '../src/stage8PostSync.js';

async function fixture(t){
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,now:()=>new Date()});
 const users=['a','b','c'];
 await f.db.createUser({id:'c',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await f.core.initializeTenant('c','SHADOW');
 for(const [index,userId] of users.entries()){
  await f.db.saveTokens(userId,{accessToken:'SYNTHETIC_NOT_A_TOKEN',refreshToken:'SYNTHETIC_NOT_A_TOKEN',expiresAt:new Date(Date.now()+3600000).toISOString(),scope:''});
  await f.db.ensureOnboarding(userId,{state:'READY'});
  await f.db.linkTelegram({userId,chatId:String(10001+index)});
  for(const resource of ['sleep','recovery','cycle','workout'])await f.db.saveSyncState(userId,resource,{backfillComplete:true,lastSuccessAt:new Date().toISOString()});
 }
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'};
 async function syncParent({requestId=randomUUID()}={}){const request={phase:'SYNC',triggerSource:'manual',requestId,releaseSha:runningReleaseSha(),executionMode:'OFF',configProof:configurationProof(f.keys,{runtime:'off',mode:'off'},environment)};
 const response=await runExecutionPhase({...f,request,environment,env:{dryRun:true,timezone:'Asia/Taipei',telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},deps:{runBriefing:async()=>{
  for(const userId of users){
   const whoop={sleeps:async()=>[],recoveries:async()=>[],cycles:async()=>[],workouts:async()=>[],bodyMeasurement:async()=>({})};
   const sync=await createSync({...f,whoop,userId,timezone:'Asia/Taipei',expectedLifecycleGeneration:1}).syncAll({force:true});
   assert.equal(sync.complete,true);await recordStage8SyncSubject({...f,userId,sync});
  }
  return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:users.length,failed:0};
 }}});
 assert.equal(response.body.syncComplete,true);return request.requestId;}
 const parent=await syncParent();
 const calls=[],eligible=new Set(users);let failNext=false,nextCode=null;
 const producer={run:async value=>{calls.push(value);if(nextCode){const code=nextCode;nextCode=null;throw Object.assign(Error(code),{code});}if(failNext){failNext=false;throw Error('SYNTHETIC_BOUNDED_LEG_FAILURE');}return {publication:{status:'ANALYSIS_UPDATING'},replayed:false,executionId:value.requestId};}};
 const restart=()=>createStage8PostSync({...f,environment,userIds:users,eligible:id=>eligible.has(id),enabled:()=>true,producer});
 return {...f,calls,eligible,restart,parent,syncParent,failCode:code=>{nextCode=code;},failNext:()=>{failNext=true;}};
}

test('three-subject discovery rotates partial work and failures without changing durable request ordinals',async t=>{
 const f=await fixture(t),app=f.restart();
 for(let n=0;n<6;n++)assert.equal((await app.resume()).status,'ANALYSIS_UPDATING');
 assert.deepEqual(f.calls.map(call=>call.userId),['a','b','c','a','b','c']);
 assert.equal(new Set(f.calls.map(call=>call.requestId)).size,6,'each subject has its own signed next ordinal');
 const progress=(await f.db.raw.execute("SELECT value FROM telegram_state WHERE key LIKE 'stage8:sync-progress:%'")).rows.map(row=>JSON.parse(row.value));
 assert.equal(progress.length,3);assert.ok(progress.every(row=>row.ordinal===2&&!row.done));
 f.failNext();await assert.rejects(app.resume(),/SYNTHETIC_BOUNDED_LEG_FAILURE/);const failed=f.calls.at(-1);
 await app.resume();await app.resume();await app.resume();
 assert.deepEqual(f.calls.slice(-4).map(call=>call.userId),['a','b','c','a']);
 assert.equal(f.calls.at(-1).requestId,failed.requestId,'failure reuses its original durable ordinal when the subject returns');
 f.eligible.delete('b');await app.resume();assert.equal(f.calls.at(-1).userId,'c');
 const original=Date.now,before=f.calls.length;Date.now=()=>original()+16*60000;
 try{assert.deepEqual(await app.resume(),{status:'IDLE',invoked:0});}finally{Date.now=original;}
 assert.equal(f.calls.length,before,'fair scheduling never extends the original parent expiry');
});

test('one unavailable subject surfaces its denial and does not monopolize later discovery ticks',async t=>{
 const f=await fixture(t),app=f.restart();await f.db.setOnboardingState('a','ACTION_REQUIRED',{from:['READY']});
 await assert.rejects(app.resume(),/FINALIZED_SYNC_REQUIRED/);
 assert.equal(f.calls.length,0);
 assert.equal((await app.resume()).status,'ANALYSIS_UPDATING');assert.equal(f.calls.at(-1).userId,'b');
 assert.equal((await app.resume()).status,'ANALYSIS_UPDATING');assert.equal(f.calls.at(-1).userId,'c');
});

test('expired original LIVE RID stops its signed parent durably without ordinal renewal or older-parent fallback',async t=>{
 const f=await fixture(t),newest=await f.syncParent(),app=f.restart();
 const executions=(await f.db.raw.execute('SELECT * FROM phase4_executions ORDER BY execution_seq')).rows;
 const receipts=(await f.db.raw.execute('SELECT * FROM phase4_execution_work_receipts ORDER BY receipt_key')).rows;
 f.failCode('STAGE8_LIVE_REQUEST_EXPIRED');
 assert.deepEqual(await app.resume(),{status:'ORIGINAL_LIVE_EXECUTION_EXPIRED',continuation:false,requiresFreshSync:true,invoked:1});
 const original=f.calls[0];assert.equal(original.userId,'a');
 const saved=(await f.db.raw.execute("SELECT key,value FROM telegram_state WHERE key LIKE 'stage8:sync-progress:%'")).rows;
 assert.equal(saved.length,1);const progress=JSON.parse(saved[0].value);assert.equal(progress.ordinal,0);assert.equal(progress.done,false);assert.equal(progress.stopped,'ORIGINAL_LIVE_EXECUTION_EXPIRED');
 const restarted=f.restart();
 for(let i=0;i<4;i++)await restarted.resume();
 assert.ok(f.calls.slice(1).every(row=>row.userId!=='a'),'restart must not repeat stopped RID or fall back to the older valid parent');
 const n=f.calls.length;assert.deepEqual(await restarted.run({executionId:newest,userId:'a'}),{status:'ORIGINAL_LIVE_EXECUTION_EXPIRED',continuation:false,requiresFreshSync:true});assert.equal(f.calls.length,n);
 assert.equal(await f.db.getState(saved[0].key),saved[0].value,'stopped signed ordinal remains byte-identical');
 assert.deepEqual((await f.db.raw.execute('SELECT * FROM phase4_executions ORDER BY execution_seq')).rows,executions);
 assert.deepEqual((await f.db.raw.execute('SELECT * FROM phase4_execution_work_receipts ORDER BY receipt_key')).rows,receipts);
 // Only a genuinely new finalized per-subject SYNC supplies fresh authority.
 const fresh=await f.syncParent();assert.equal((await restarted.run({executionId:fresh,userId:'a'})).status,'ANALYSIS_UPDATING');
 assert.notEqual(f.calls.at(-1).requestId,original.requestId);assert.equal(await f.db.getState(saved[0].key),saved[0].value);
 // Other failure classes keep the original request retry, never a stop marker.
 for(const code of ['STAGE8_LIVE_REQUEST_PENDING','COMMIT_INDETERMINATE','SYNC_TIMEOUT']){
  const before=(await f.db.raw.execute("SELECT key,value FROM telegram_state WHERE key LIKE 'stage8:sync-progress:%' ORDER BY key")).rows;
  f.failCode(code);await assert.rejects(restarted.run({executionId:fresh,userId:'b'}),error=>error.code===code);const failed=f.calls.at(-1);
  assert.deepEqual((await f.db.raw.execute("SELECT key,value FROM telegram_state WHERE key LIKE 'stage8:sync-progress:%' ORDER BY key")).rows,before);
  await restarted.run({executionId:fresh,userId:'b'});assert.equal(f.calls.at(-1).requestId,failed.requestId);
 }
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_executions')).rows[0].n,0,'this focused continuation test models producer errors, not LIVE computation qualification');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
});

test('a newer genuine SYNC wins an equal-millisecond tie over a lexically greater stopped parent',async t=>{
 const f=await fixture(t),app=f.restart(),now=Date.now,tie=now();let older,newer;
 // Model a valid shared claim millisecond. Both original requests run through
 // actual SYNC/finalization and subject receipts; no durable row is edited.
 try{Date.now=()=>tie;older=await f.syncParent({requestId:'zzzz-stopped-original-parent'});}finally{Date.now=now;}
 f.failCode('STAGE8_LIVE_REQUEST_EXPIRED');assert.equal((await app.run({executionId:older,userId:'a'})).requiresFreshSync,true);
 const stopped=(await f.db.raw.execute("SELECT key,value FROM telegram_state WHERE key LIKE 'stage8:sync-progress:%'")).rows;
 try{Date.now=()=>tie;newer=await f.syncParent({requestId:'aaaa-new-authorized-parent'});}finally{Date.now=now;}
 const parents=(await f.db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id IN (?,?) ORDER BY execution_seq',args:[older,newer]})).rows;
 assert.equal(parents.length,2);assert.equal(parents[0].execution_id,older);assert.equal(parents[1].execution_id,newer);assert.equal(parents[0].created_at,parents[1].created_at);
 const restarted=f.restart();assert.equal((await restarted.resume()).status,'ANALYSIS_UPDATING');assert.equal(f.calls.at(-1).userId,'a','sequence-newer subject must not be hidden by stopped UUID ordering');
 assert.deepEqual((await f.db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id IN (?,?) ORDER BY execution_seq',args:[older,newer]})).rows,parents);
 for(const row of stopped)assert.equal(await f.db.getState(row.key),row.value);
});

test('a committed stopped continuation survives lost COMMIT acknowledgement without retrying its original RID',async t=>{
 const f=await fixture(t),app=f.restart();
 const executions=(await f.db.raw.execute('SELECT * FROM phase4_executions ORDER BY execution_seq')).rows;
 const receipts=(await f.db.raw.execute('SELECT * FROM phase4_execution_work_receipts ORDER BY receipt_key')).rows;
 const execute=Sqlite3Transaction.prototype.execute,commit=Sqlite3Transaction.prototype.commit,stops=new WeakSet();
 let fired=false,saved;
 // Inject only after the actual native transaction wrote the signed stop and
 // its real COMMIT acknowledged locally. No SQL/result/row is fabricated. The
 // producer error is modeled; this is continuation-metadata recovery evidence.
 Sqlite3Transaction.prototype.execute=async function(statement,...args){
  const result=await execute.call(this,statement,...args);
  if(typeof statement?.sql==='string'&&/^INSERT INTO telegram_state\b/.test(statement.sql)
   &&statement.args?.[0]?.startsWith('stage8:sync-progress:')
   &&JSON.parse(statement.args[1]).stopped==='ORIGINAL_LIVE_EXECUTION_EXPIRED'){
   stops.add(this);saved={key:statement.args[0],value:statement.args[1]};
  }
  return result;
 };
 Sqlite3Transaction.prototype.commit=async function(...args){
  await commit.apply(this,args);
  if(stops.has(this)&&!fired){fired=true;throw Object.assign(Error('SYNTHETIC_LOST_STOP_COMMIT_ACK'),{code:'SQLITE_IOERR'});}
 };
 try{
  f.failCode('STAGE8_LIVE_REQUEST_EXPIRED');
  await assert.rejects(app.run({executionId:f.parent,userId:'a'}),error=>error.code==='COMMIT_INDETERMINATE');
 }finally{Sqlite3Transaction.prototype.execute=execute;Sqlite3Transaction.prototype.commit=commit;}
 assert.equal(fired,true);assert.equal(f.calls.length,1);
 assert.equal(await f.db.getState(saved.key),saved.value,'unknown ACK must not erase an actually committed signed stop');
 const {hmac,...progress}=JSON.parse(saved.value);
 assert.deepEqual(progress,{done:false,ordinal:0,stopped:'ORIGINAL_LIVE_EXECUTION_EXPIRED'});
 assert.equal(hmac,f.keys.lookup(['stage8-post-sync-metadata-v1',canonicalJson({progressKey:saved.key,...progress})]));
 assert.deepEqual(await f.restart().run({executionId:f.parent,userId:'a'}),{status:'ORIGINAL_LIVE_EXECUTION_EXPIRED',continuation:false,requiresFreshSync:true});
 assert.equal(f.calls.length,1,'verified durable stop must not invoke the expired producer again');
 assert.equal(await f.db.getState(saved.key),saved.value);
 assert.deepEqual((await f.db.raw.execute('SELECT * FROM phase4_executions ORDER BY execution_seq')).rows,executions);
 assert.deepEqual((await f.db.raw.execute('SELECT * FROM phase4_execution_work_receipts ORDER BY receipt_key')).rows,receipts);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_executions')).rows[0].n,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
});

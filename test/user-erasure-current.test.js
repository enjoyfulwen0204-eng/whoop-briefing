import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {createUserErasure} from '../src/userErasure.js';
import {resolveErasureKv} from '../src/erasureKvOwnership.js';
import {fixtureKeys} from './localDb.js';
import {randomUUID} from 'node:crypto';
import {runningReleaseSha} from '../src/phase4Release.js';
import {canonicalPhaseRequest,claimPhaseRequest,commitPhaseWork,finalizePhaseWork,readPhaseProgress} from '../src/phase4ExecutionStore.js';
import {userErrorClearReceiptKey} from '../src/erasureCatalog.js';
import {createOperationalRetention} from '../src/operationalRetention.js';
import {legacyPrivacyFence} from '../src/legacyPrivacyFence.js';
const now=()=>new Date('2026-11-07T00:00:00Z');
async function setup(t){
 const f=await syntheticStage7V33Fixture(t,{now});
 await f.db.linkTelegram({userId:'a',chatId:'101',now:now()});
 await f.db.setLocale('a','zh-TW');await f.db.setLocale('b','en');
 await f.db.revokeTelegramLink('101');
 await f.db.transitionUserLifecycle({userId:'a',targetStatus:'DISABLED',expectedCurrentStatus:'ACTIVE',now:now()});
 return {...f,engine:createUserErasure({db:f.db,keys:f.keys,environment:{OWNER_USER_IDS:'b',FAMILY_GROUP_USER_IDS:'b,c'},now})};
}
async function snapshot(db){const schema=(await db.raw.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') ORDER BY type,name")).rows;const rows={};
 for(const t of schema.filter(r=>r.type==='table'))rows[t.name]=(await db.raw.execute('SELECT * FROM "'+t.name+'"')).rows.map(r=>JSON.stringify(r)).sort();return {schema,rows};}
test('atomic erasure removes a fenced subject, preserves peer rows and exact schema, and is idempotent',async t=>{
 const f=await setup(t),before=await snapshot(f.db);
 const result=await f.engine.eraseDisabled('a',{maintenance:true});assert.equal(result.status,'ERASED');assert.equal(result.pending,0);
 assert.equal(await f.db.getUser('a'),null);assert.equal((await f.db.getUser('b')).status,'ACTIVE');
 const after=await snapshot(f.db);assert.deepEqual(after.schema,before.schema);
 for(const [table,rows] of Object.entries(after.rows))assert.deepEqual(rows.filter(r=>JSON.parse(r).user_id==='b'||table==='users'&&JSON.parse(r).id==='b'),before.rows[table].filter(r=>JSON.parse(r).user_id==='b'||table==='users'&&JSON.parse(r).id==='b'),table);
 assert.deepEqual((await f.db.raw.execute('PRAGMA foreign_key_check')).rows,[]);
 assert.equal(Object.values((await f.db.raw.execute('PRAGMA integrity_check')).rows[0])[0],'ok');
 assert.equal((await f.engine.eraseDisabled('a',{maintenance:true})).status,'ALREADY_ABSENT');
});
test('atomic failure rolls back every delete and temporary guard change; the disabled subject may retry',async t=>{
 const f=await setup(t),before=await snapshot(f.db),batch=f.db.raw.batch;
 f.db.raw.batch=(statements,mode)=>batch([...statements.slice(0,-1),{sql:'SELECT * FROM synthetic_erasure_failure',args:[]},statements.at(-1)],mode);
 await assert.rejects(f.engine.eraseDisabled('a',{maintenance:true}),{code:'ERASURE_ATOMIC_BATCH_FAILED'});
 assert.deepEqual(await snapshot(f.db),before);assert.equal((await f.db.getUser('a')).status,'DISABLED');assert.equal(await f.db.resolveUserByChatId('101'),null);
 f.db.raw.batch=batch;assert.equal((await f.engine.eraseDisabled('a',{maintenance:true})).status,'ERASED');
});
test('Owner, active subject and family maintenance are denied before mutation',async t=>{
 const f=await setup(t);await assert.rejects(f.engine.eraseDisabled('b'),{code:'ERASURE_OWNER_FORBIDDEN'});
 const engine=createUserErasure({db:f.db,keys:f.keys,environment:{OWNER_USER_IDS:'other',FAMILY_GROUP_USER_IDS:'a,b'},now});
 await assert.rejects(engine.eraseDisabled('a',{maintenance:true}),{code:'ERASURE_FAMILY_MAINTENANCE_FORBIDDEN'});
 await assert.rejects(engine.eraseDisabled('b'),{code:'ERASURE_DISABLED_REQUIRED'});
});
test('KV ownership fails closed for unrecognized keys and unmatched health-bearing snapshots',()=>{
 const input={keys:fixtureKeys,users:[{id:'a',lifecycle_generation:1}],familyIds:[]};
 assert.throws(()=>resolveErasureKv({...input,entries:[{key:'new-secret-prefix:x',value:'{}'}]}),{code:'ERASURE_KV_UNCLASSIFIED'});
 assert.throws(()=>resolveErasureKv({...input,entries:[{key:'morning-snapshot:'+fixtureKeys.lookup(['missing']),value:'{}'}]}),{code:'ERASURE_KV_OWNERSHIP_UNPROVEN'});
 const key='night-analysis:'+fixtureKeys.lookup(['night-analysis-v1','a',1,'2026-11-06','LIGHT']);
 const r=resolveErasureKv({...input,entries:[{key,value:JSON.stringify({date:'2026-11-06',version:'night-analysis-v1'})}]});
 assert.deepEqual([...r.owners.get(key)],['a']);
});

test('a failed erasure after fencing is durably pending and the automatic retry completes without touching peers',async t=>{
 const f=await setup(t);await f.engine.fence('a',{maintenance:true});
 const peer=(await f.db.raw.execute("SELECT * FROM users WHERE id='b'")).rows;
 const batch=f.db.raw.batch;f.db.raw.batch=()=>{throw Error('SYNTHETIC_FAILURE');};
 await assert.rejects(f.engine.eraseDisabled('a'),{code:'ERASURE_ATOMIC_BATCH_FAILED'});
 f.db.raw.batch=batch;
 assert.equal((await f.db.getUser('a')).status,'DISABLED');assert.equal(await f.db.resolveUserByChatId('101'),null);
 assert.equal((await f.db.raw.execute("SELECT COUNT(*) n FROM telegram_state WHERE key LIKE 'e1b:pending:%'")).rows[0].n,1);
 const result=await f.engine.retryPending({budget:{remainingMs:()=>90000,assert(){}}});
 assert.equal(result.completed,1);assert.equal(await f.db.getUser('a'),null);
 assert.deepEqual((await f.db.raw.execute("SELECT * FROM users WHERE id='b'")).rows,peer);
 assert.equal((await f.db.raw.execute("SELECT COUNT(*) n FROM telegram_state WHERE key LIKE 'e1b:pending:%'")).rows[0].n,0);
});
test('signed global boot metadata is SYSTEM, but extra identity fields and unknown operator rows fail closed',()=>{
 const keys=fixtureKeys,domain='production-supervisor-monotonic-boot-v1',body={contract:domain,generation:1,nonce:'a'.repeat(64),issuedAtMs:1,releaseSha:'b'.repeat(40)};
 const signature=keys.digest(keys.lookup([domain]),[domain,body]),key='canonical-profile-revision:v1:supervisor:boot-generation:v1';
 const wire={body,signature,digest:keys.lookup([domain,body,signature])};
 const input={keys,users:[],familyIds:[],entries:[{key,value:JSON.stringify(wire)}]};
 assert.ok(resolveErasureKv(input).system.has(key));
 assert.throws(()=>resolveErasureKv({...input,entries:[{key,value:JSON.stringify({...wire,body:{...body,user_id:'synthetic'}})}]}),{code:'ERASURE_SYSTEM_BOOT_INVALID'});
 assert.throws(()=>resolveErasureKv({...input,entries:[{key:'canonical-profile-revision:v1:operator:unknown',value:'{}'}]}),{code:'ERASURE_KV_OWNERSHIP_UNPROVEN'});
});

test('live execution receipts survive personal erasure, then retry deletes only the erased subject after finalization',async t=>{
 const f=await setup(t),request={requestId:'p4s1_'+randomUUID(),phase:'SYNC',releaseSha:runningReleaseSha(),triggerSource:'cloudflare',executionMode:'OFF',configProof:'a'.repeat(64)};
 const claim=await claimPhaseRequest(f.db,request,canonicalPhaseRequest(request),{keys:f.keys});
 const execution=(await f.db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[request.requestId]})).rows[0];
 const own=userErrorClearReceiptKey(f.keys,execution,'a',1),peer=userErrorClearReceiptKey(f.keys,execution,'b',1);
 for(const receiptKey of [own,peer])await f.db.raw.execute({sql:'INSERT INTO phase4_execution_work_receipts(execution_id,receipt_key,scope_key,request_digest,step_key,generation,committed_at,result_json) VALUES(?,?,?,?,?,?,?,NULL)',args:[request.requestId,receiptKey,claim.scopeKey,claim.identity,receiptKey,claim.generation,Date.now()]});
 const peerBefore=(await f.db.raw.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE receipt_key=?',args:[peer]})).rows;
 const schemaBefore=(await snapshot(f.db)).schema;
 await f.engine.fence('a',{maintenance:true});
 assert.equal((await f.engine.eraseDisabled('a',{maintenance:true})).status,'PENDING_RECEIPTS');
 assert.equal(await f.db.getUser('a'),null);
 const budget={remainingMs:()=>90000,assert(){}};
 assert.equal((await f.engine.retryPending({budget})).pending,1);
 assert.equal((await f.db.raw.execute('SELECT COUNT(*) n FROM phase4_execution_work_receipts')).rows[0].n,2);
 await commitPhaseWork(f.db,request,claim,{outcome:'NO_NEW_DATA_SUCCESS'},{assert(){}});
 await finalizePhaseWork(f.db,request,claim,f.keys,{assert(){}});
 assert.equal((await f.engine.retryPending({budget})).completed,1);
 assert.equal((await f.db.raw.execute({sql:'SELECT COUNT(*) n FROM phase4_execution_work_receipts WHERE receipt_key=?',args:[own]})).rows[0].n,0);
 assert.deepEqual((await f.db.raw.execute({sql:'SELECT * FROM phase4_execution_work_receipts WHERE receipt_key=?',args:[peer]})).rows,peerBefore);
 assert.equal((await f.db.raw.execute("SELECT COUNT(*) n FROM telegram_state WHERE key LIKE 'e1b:pending:%'")).rows[0].n,0);
 assert.deepEqual((await snapshot(f.db)).schema,schemaBefore);
 assert.deepEqual((await f.db.raw.execute('PRAGMA foreign_key_check')).rows,[]);
});

test('retention preserves existing-user receipts, whole executions and readPhaseProgress even after thirty days',async t=>{
 const f=await setup(t);
 for(let n=0;n<2;n++){
  const request={requestId:'p4s1_'+randomUUID(),phase:'SYNC',releaseSha:runningReleaseSha(),triggerSource:'cloudflare',executionMode:'OFF',configProof:'a'.repeat(64)};
  const claim=await claimPhaseRequest(f.db,request,canonicalPhaseRequest(request),{keys:f.keys});
  const execution=(await f.db.raw.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[request.requestId]})).rows[0];
  const key=userErrorClearReceiptKey(f.keys,execution,'b',1);
  await f.db.raw.execute({sql:'INSERT INTO phase4_execution_work_receipts(execution_id,receipt_key,scope_key,request_digest,step_key,generation,committed_at,result_json) VALUES(?,?,?,?,?,?,?,NULL)',args:[request.requestId,key,claim.scopeKey,claim.identity,key,claim.generation,Date.now()]});
  await commitPhaseWork(f.db,request,claim,{outcome:'NO_NEW_DATA_SUCCESS'},{assert(){}});
  await finalizePhaseWork(f.db,request,claim,f.keys,{assert(){}});
 }
 const before=await snapshot(f.db),progress=await readPhaseProgress(f.db,'SYNC','cloudflare');
 const result=await createOperationalRetention({db:f.db,keys:f.keys,now:()=>new Date(Date.now()+31*86400000),emit(){}}).run({budget:{remainingMs:()=>90000,assert(){}}});
 assert.equal(result.protected,2);assert.equal(result.retired,0);assert.equal(result.receipts,0);
 assert.deepEqual(await snapshot(f.db),before);
 assert.deepEqual(await readPhaseProgress(f.db,'SYNC','cloudflare'),progress);
});

test('completed personal migration cursor is redacted without deleting checkpoints or changing key authority',async t=>{
 const f=await setup(t);
 await f.db.raw.execute("UPDATE phase4_migration_checkpoints SET last_cursor='a' WHERE target_version=21 AND step_key='tenant_metadata'");
 const read=async()=>(await f.db.raw.execute('SELECT * FROM phase4_migration_checkpoints ORDER BY target_version,step_key')).rows;
 const before=await read();
 await f.engine.eraseDisabled('a',{maintenance:true});
 assert.deepEqual(await read(),before.map(r=>r.target_version===21&&r.step_key==='tenant_metadata'?{...r,last_cursor:null}:r));
 await f.db.admitRuntime({source:'cloudflare',fresh:true});
});

test('late webhook cannot recreate erased user data; unresolved pre-fence events are removed',async t=>{
 const f=await setup(t);
 await f.db.raw.execute({sql:"INSERT INTO user_whoop_tokens(user_id,access_token,refresh_token,access_token_expires_at,whoop_user_id,updated_at,auth_generation) VALUES(?,?,?,?,?,?,?)",args:['a','','',now().toISOString(),'synthetic-provider-a',now().toISOString(),1]});
 const {createWhoopWebhookStore}=await import('../src/whoopWebhookStore.js');
 const historical=createWhoopWebhookStore(f.db.raw),event={whoopUserId:'synthetic-provider-a',eventType:'sleep.updated',resourceType:'sleep',resourceId:'synthetic-sleep',traceId:'synthetic-trace',now:now()};
 await historical.recordWhoopEvent(event);
 await f.engine.eraseDisabled('a',{maintenance:true});
 const live=createWhoopWebhookStore(f.db.raw,{requireActiveBinding:true});
 assert.equal((await live.recordWhoopEvent(event)).ignored,true);
 assert.equal((await f.db.raw.execute("SELECT COUNT(*) n FROM whoop_webhook_events WHERE whoop_user_id='synthetic-provider-a'")).rows[0].n,0);
});

test('in-flight work captured before erasure cannot persist after the lifecycle fence; a peer remains writable',async t=>{
 const f=await syntheticStage7V33Fixture(t,{now}),privacy=legacyPrivacyFence(f.db.raw,f.keys);
 const captured=await privacy.capture('a'),peer=await privacy.capture('b');
 const engine=createUserErasure({db:f.db,keys:f.keys,environment:{OWNER_USER_IDS:'b',FAMILY_GROUP_USER_IDS:'b'},now});
 let resume;const providerFinished=new Promise(resolve=>{resume=resolve;});
 // An actual production processing fence is captured before the simulated
 // external wait. Deletion wins before the old worker tries its write batch.
 const stale=f.db.withRuntimeFence(()=>privacy.assert(captured),async()=>{
  await providerFinished;
  return f.db.transaction(()=>f.db.raw.execute({sql:'INSERT INTO user_locales(user_id,locale,updated_at) VALUES(?,?,?)',args:['a','en',now().toISOString()]}));
 });
 await engine.fence('a');await engine.eraseDisabled('a');resume();
 await assert.rejects(stale,error=>['PHASE4_PURGE_FENCED','PHASE4_TENANT_NOT_FOUND'].includes(error.code)||error.name==='AccountInactiveError');
 assert.equal(await f.db.getUser('a'),null);
 assert.equal((await f.db.raw.execute("SELECT COUNT(*) n FROM user_locales WHERE user_id='a'")).rows[0].n,0);
 await f.db.withRuntimeFence(()=>privacy.assert(peer),()=>f.db.setLocale('b','vi'));
 assert.equal(await f.db.getLocale('b'),'vi');
});

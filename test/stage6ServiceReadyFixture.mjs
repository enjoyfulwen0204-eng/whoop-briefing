// Synthetic enrollment only. No production URL, token, identity, or delivery.
import assert from 'node:assert/strict';
import {createOwnedDb} from './stage5OwnedDb.js';import {fixtureKeys} from './localDb.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createWebhookServer} from '../src/bot/webhook.js';import {createUpdateProcessor} from '../src/bot/updateProcessor.js';import {handleLinkAttempt} from '../src/bot/link.js';
import {createWhoopOAuthCallback} from '../src/whoopOAuthCallback.js';import {WHOOP_SYNC} from '../src/config.js';
import {createOperationReceipts} from '../src/phase4OperationReceipts.js';
import {morningNow,morningRecords} from './stage6LinuxMorningFixture.mjs';
const resources=WHOOP_SYNC.RESOURCES;
const jobs=db=>db.raw.execute("SELECT job_kind,requested_generation,completed_generation,scope_revision,full_scan_cursor FROM phase4_jobs WHERE user_id='a' ORDER BY job_kind").then(r=>r.rows.map(r=>({...r})));
export async function seedServiceReadyFixture(url){
 if(!url.startsWith('file:'))throw Error('ISOLATED_FILE_FIXTURE_REQUIRED');
 const db=createOwnedDb({url});let server;try{
  const users=(await db.raw.execute('SELECT id,display_name FROM users')).rows;assert.deepEqual(users.map(r=>[r.id,r.display_name]),[['a','Synthetic']]);
  const beforeJobs=await jobs(db),oldReceipts=(await db.raw.execute('SELECT operation_key,receipt_hmac FROM phase4_operation_receipts')).rows;
  const oldReceiptDigest=fixtureKeys.lookup(['service-fixture-preserved-receipts-v1',oldReceipts]);
  const beforeMode=(await db.raw.execute('PRAGMA journal_mode')).rows[0][0];assert.equal((await db.raw.execute('PRAGMA journal_mode=WAL')).rows[0][0],'wal');
  const secret='synthetic-service-enrollment-secret',codes=new Map();let linkUpdates=700000,authCalls=0;
  const processor=createUpdateProcessor({db,resolveUser:id=>db.resolveUserByChatId(id),handleMessage:async()=>null,
   handleUnlinked:args=>handleLinkAttempt({...args,db}),workerId:'synthetic-enrollment',now:()=>new Date()});
  server=createWebhookServer({secret,processUpdate:processor.processUpdate});await new Promise((r,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',r);});
  const base='http://127.0.0.1:'+server.address().port;
  const admission=await db.admitRuntime(),stores=await createPhase4Foundation({db,keys:fixtureKeys,admission});
  const identities=[];
  for(const [i,id] of ['a','alice','bob','lan'].entries()){
   const chatId=String(1000+i),whoopId=String(i===0?1:2000+i),now=new Date();
   if(id!=='a'){await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});await db.ensureOnboarding(id,{state:'STARTED'});}
   const historical=await db.getHistoricalWhoopUserIds(id);assert.ok(!historical.length||historical.length===1&&historical[0]===whoopId,'synthetic identity must match existing history');
   const created=await db.createLinkCode(id,{ttlMs:60000,now});codes.set(id,created.code);
   const update={update_id:++linkUpdates,message:{message_id:linkUpdates,chat:{id:Number(chatId),type:'private'},from:{id:Number(chatId),is_bot:false},date:Math.floor(Date.now()/1000),text:'/link '+created.code}};
   const send=credential=>fetch(base+'/telegram/webhook',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':credential},body:JSON.stringify(update)});
   assert.equal((await send('incorrect-synthetic-secret')).status,401);assert.equal(await db.getActiveChatIdForUser(id),null);
   assert.equal((await send(secret)).status,200);assert.equal((await send(secret)).status,200);assert.equal(await db.getActiveChatIdForUser(id),chatId);
   assert.equal((await db.redeemLinkCode(created.code,{chatId:'999999'})).ok,false);assert.equal((await db.resolveUserByChatId(chatId)).user.id,id);
   await db.setLocale(id,['en','en','zh-TW','vi'][i]);
   const priorAuthGeneration=(await db.getTokens(id))?.authGeneration??0,expectedAuthGeneration=priorAuthGeneration+1;
   const state=await db.createOAuthState(id,{ttlMs:60000,now});
   const callback=createWhoopOAuthCallback({db,exchange:async()=>{authCalls++;return {accessToken:'synthetic-access-'+id,refreshToken:'synthetic-refresh-'+id,expiresAt:new Date(Date.now()+3600000),scope:'read:sleep read:recovery read:cycles read:workout read:body_measurement'};},verifyIdentity:async()=>whoopId});
   const authorized=await callback({query:new URLSearchParams({state:state.state,code:'synthetic-code'})});assert.equal(authorized.status,200);assert.equal(authorized.userId,id);
   assert.equal((await callback({query:new URLSearchParams({state:state.state,code:'synthetic-code'})})).status,400);
   const user=await db.getUser(id),tokens=await db.getTokens(id);assert.equal(user.lifecycleGeneration,1);assert.equal(tokens.authGeneration,expectedAuthGeneration);assert.equal(tokens.whoopUserId,whoopId);
   await db.setOnboardingState(id,'WHOOP_AUTHORIZED',{from:['WHOOP_AUTHORIZED'],timezoneConfirmed:true,expectedLifecycleGeneration:1,requireActiveLifecycle:true});
   if(id!=='a'){
    const data=syntheticRecords(id);await db.upsertSleeps(id,data.sleeps.slice(2),{timezone:'Asia/Taipei',now:morningNow});await db.upsertRecoveries(id,data.recoveries.slice(2),{now:morningNow});await db.upsertCycles(id,data.cycles.slice(2),{now:morningNow});
   }
   // Successful bounded synthetic resource observations, tied to this auth.
   await db.recordResourceAccess(id,resources.map(resource=>({resource,status:'ACCESSIBLE'})),{expectedAuthGeneration,expectedLifecycleGeneration:1});
   await db.saveCapabilities(id,[{key:'sleep',status:'SUPPORTED'}],{expectedLifecycleGeneration:1});
   for(const resource of resources)await db.saveSyncState(id,resource,{backfillComplete:true,lastSuccessAt:new Date(morningNow.getTime()-3*3600000).toISOString()},{now:morningNow});
   const ready=await db.setReadyIfEligible({userId:id,requiredResources:resources,expectedLifecycleGeneration:1});assert.equal(ready.ok,true);
   if(id!=='a')await stores.initializeTenant(id,'SHADOW');
   const control=await stores.captureControl(id);const currentPreferences=await stores.preferences.read(control);const preferences=await stores.preferences.update(control,currentPreferences.preference_version,{notifications_paused:0,morning_brief_mode:'FIXED_LOCAL_TIME',morning_brief_local_time:'08:00'});assert.equal(preferences.notifications_paused,0);
   identities.push({id,chatId,whoopId,lifecycleGeneration:1,authGeneration:expectedAuthGeneration,ready:true,notificationDestinationVerified:true});
  }
  assert.equal(authCalls,4);assert.equal((await db.listSchedulableUsers({activeStatus:'ACTIVE'})).length,4);
  const afterJobs=await jobs(db),afterReceipts=(await db.raw.execute('SELECT operation_key,receipt_hmac FROM phase4_operation_receipts')).rows;assert.equal(fixtureKeys.lookup(['service-fixture-preserved-receipts-v1',afterReceipts]),oldReceiptDigest);
  assert.ok(afterJobs.every((j,i)=>j.requested_generation>beforeJobs[i].requested_generation&&j.completed_generation===beforeJobs[i].completed_generation&&j.scope_revision>beforeJobs[i].scope_revision&&j.full_scan_cursor===null));
  const state=(await db.raw.execute("SELECT u.timezone,u.lifecycle_generation,t.auth_generation,p.source_generation,p.purge_generation,c.input_generation,c.algorithm_set_version FROM users u JOIN user_whoop_tokens t ON t.user_id=u.id JOIN phase4_user_state p ON p.user_id=u.id JOIN phase4_computation_state c ON c.user_id=u.id AND c.execution_mode='SHADOW' WHERE u.id='a'")).rows[0];
  const context={userId:'a',executionMode:'SHADOW',timezone:state.timezone,lifecycleGeneration:state.lifecycle_generation,authGeneration:state.auth_generation,sourceGeneration:state.source_generation,purgeGeneration:state.purge_generation,inputGeneration:state.input_generation,algorithmSetVersion:state.algorithm_set_version};
  const verifier=createOperationReceipts({client:db.raw,keys:fixtureKeys,schemaVersion:32}),historical=(await db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE user_id='a' AND execution_mode='SHADOW'")).rows;
  for(const receipt of historical)verifier.authenticate(context,receipt);
  const sample=historical.find(r=>r.operation_kind==='analyzeMetric');assert.ok(sample);
  await assert.rejects(verifier.read(context,sample),{code:'PHASE4_PARENT_STALE'});
  assert.throws(()=>verifier.authenticate({...context,userId:'alice'},sample),{code:'PHASE4_OPERATION_RECEIPT_INTEGRITY'});
  assert.throws(()=>verifier.authenticate(context,{...sample,receipt_hmac:'0'.repeat(64)}),{code:'PHASE4_OPERATION_RECEIPT_INTEGRITY'});
  return {synthetic:true,production:false,identities,authExchangeCalls:authCalls,journalBefore:beforeMode,journalAfter:'wal',busyTimeoutMs:(await db.raw.execute('PRAGMA busy_timeout')).rows[0][0],beforeJobs,afterJobs,preservedReceiptCount:oldReceipts.length,preservedReceiptDigest:oldReceiptDigest,historicalHmacVerified:historical.length,staleCurrentReadRejected:true,crossTenantReceiptRejected:true,tamperedReceiptRejected:true};
 }finally{if(server)await new Promise(r=>server.close(r));await db.close();}
}
export function syntheticRecords(userId){
 const i=['a','alice','bob','lan'].indexOf(userId);assert.ok(i>=0);const value=morningRecords(),whoopId=i===0?1:2000+i;
 for(const name of ['sleeps','recoveries','cycles','workouts'])for(const row of value[name])row.user_id=whoopId;return value;
}

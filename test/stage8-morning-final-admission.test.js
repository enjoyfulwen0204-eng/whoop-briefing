import test from 'node:test';
import assert from 'node:assert/strict';
import {stage8Fixture} from './stage8Fixture.js';
import {createStage8MorningRuntime} from '../src/stage8MorningRuntime.js';

for(const mutation of ['none','binding','binding_relinked','enrollment','enrollment_ABA','paused','preference_ABA','cutover','lease','recovered'])test(`Morning final delivery admission: ${mutation}`,async t=>{
 const f=await stage8Fixture(t);let sends=0,changed=false;
 // Install the only provider transport before constructing the real runtime.
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(String(url),'https://api.telegram.org/botSYNTHETIC_NOT_A_TOKEN/sendMessage');
  assert.equal(JSON.parse(options.body).chat_id,'123');sends++;
  return new Response(JSON.stringify({ok:true,result:{message_id:99,date:1,chat:{id:123,type:'private'}}}),{status:200});
 });
 const environment={...f.environment,STAGE8_MORNING_BRIEF:'on',PHASE4_DELIVERY_CUTOVER:'off'},runtime=await createStage8MorningRuntime({...f,environment,env:f.env,now:f.now});
 await runtime.core.initializeTenant('a','LIVE');const control=await runtime.core.captureControl('a');
 await runtime.store.requestCutover(control,{expectedRevision:0});f.setTime('2026-09-20T02:10:00Z');
 const before=f.db.assertRuntimeFences;
 t.mock.method(f.db,'assertRuntimeFences',async()=>{
  await before();if(changed)return;changed=true;
  if(mutation==='binding'||mutation==='binding_relinked'){
   await f.db.revokeTelegramLink('123');
   if(mutation==='binding_relinked')await f.db.linkTelegram({userId:'a',chatId:'123',now:f.now()});
  }
  if(mutation==='enrollment'||mutation==='enrollment_ABA'){
   await f.db.setOnboardingState('a','SYNCING',{now:f.now()});
   if(mutation==='enrollment_ABA')await f.db.setOnboardingState('a','READY',{now:f.now()});
  }
  if(mutation==='paused'||mutation==='preference_ABA'){
   const c=await f.core.captureControl('a'),p=await f.stores.preferences.read(c);
   const paused=await f.stores.preferences.update(c,p.preference_version,{notifications_paused:1});
   if(mutation==='preference_ABA')await f.stores.preferences.update(c,paused.preference_version,{notifications_paused:0});
  }
  if(mutation==='cutover')await f.db.raw.execute("UPDATE tenant_delivery_modes SET mode='LEGACY',revision=revision+1,reason_code='ROLLED_BACK' WHERE user_id='a' AND execution_mode='LIVE' AND message_family='MORNING_BRIEF_V1'");
  if(mutation==='lease'||mutation==='recovered')f.setTime('2026-09-20T02:13:00Z');
  if(mutation==='recovered'){
   const r=(await f.db.raw.execute("SELECT message_id,revision FROM outbound_messages WHERE user_id='a' AND execution_mode='LIVE'")).rows[0];
   await runtime.store.transport.recover(control,'LIVE',{messageId:r.message_id,expectedRevision:r.revision});
  }
 });
 const result=await runtime.daily({userId:'a',expectedLifecycleGeneration:f.user.lifecycleGeneration,timezone:'Asia/Taipei',source:{poll:async()=>({sleeps:[],recoveries:[]})}});
 assert.equal(changed,true);
 if(mutation==='none')assert.equal(result.status,'sent');
 else assert.equal(result.status,mutation==='recovered'?'AMBIGUOUS':'FAILED_DEFINITE');
 assert.equal(sends,mutation==='none'?1:0);
 const a=(await f.db.raw.execute("SELECT state,provider_message_id FROM outbound_delivery_attempts WHERE user_id='a' AND execution_mode='LIVE'")).rows;
 assert.equal(a.length,1);assert.equal(a[0].state,mutation==='none'?'DELIVERED':mutation==='recovered'?'AMBIGUOUS':'FAILED_DEFINITE');
 assert.equal(a[0].provider_message_id,mutation==='none'?'99':null);
 const m=(await f.db.raw.execute("SELECT state,attempt_count FROM outbound_messages WHERE user_id='a' AND execution_mode='LIVE'")).rows;
 assert.equal(m.length,1);assert.equal(m[0].attempt_count,1);
 if(mutation==='enrollment_ABA'){
  const row=(await f.db.raw.execute("SELECT state,enrollment_revision FROM user_onboarding WHERE user_id='a'")).rows[0];
  assert.equal(row.state,'READY');assert.equal(row.enrollment_revision,2);
 }
});

for(const mutation of ['source_before_final_snapshot','source_freshness_expires'])test(`Morning consistent final source admission: ${mutation}`,async t=>{
 const f=await stage8Fixture(t);let sends=0,armed=false,changed=false;
 t.mock.method(globalThis,'fetch',async()=>{sends++;throw Error('PROVIDER_MUST_NOT_BE_CALLED');});
 const runtime=await createStage8MorningRuntime({...f,environment:{...f.environment,STAGE8_MORNING_BRIEF:'on'},env:f.env,now:f.now});
 await runtime.core.initializeTenant('a','LIVE');const control=await runtime.core.captureControl('a');await runtime.store.requestCutover(control,{expectedRevision:0});
 f.setTime('2026-09-20T02:10:00Z');
 await f.db.raw.execute("UPDATE whoop_sleeps SET end_at='2026-09-20T00:00:00.000Z',start_at='2026-09-19T16:00:00.000Z' WHERE user_id='a' AND id='sleep-00'");
 await f.db.raw.execute("UPDATE whoop_recoveries SET recovery_score=61 WHERE user_id='a' AND sleep_id='sleep-00'");
 if(mutation==='source_freshness_expires'){
  await f.db.raw.execute("UPDATE whoop_cycles SET score_state='SCORED',strain=8,synced_at='2026-09-20T00:40:05.000Z' WHERE user_id='a'");
  await f.db.raw.execute("UPDATE whoop_sync_state SET last_success_at='2026-09-20T02:10:00.000Z' WHERE user_id='a' AND resource='cycle'");
 }
 const generations=(await f.db.raw.execute("SELECT source_generation,purge_generation FROM phase4_user_state WHERE user_id='a'")).rows[0];
 const fence=f.db.assertRuntimeFences,open=f.db.raw.transaction,execute=f.db.raw.execute.bind(f.db.raw);
 t.mock.method(f.db,'assertRuntimeFences',async()=>{await fence();armed=true;});
 // This owned native transaction hook changes the source BEFORE the final
 // snapshot's first read. It models a correction committed in the old gap,
 // not an impossible external write after a locked snapshot's content read.
 f.db.raw.transaction=async mode=>{
  const tx=await open(mode);
  if(armed&&!changed&&mutation==='source_before_final_snapshot'){
   changed=true;await tx.execute("UPDATE whoop_recoveries SET recovery_score=99 WHERE user_id='a' AND sleep_id='sleep-00'");
  }
  return tx;
 };
 // Time may pass while a consistent read is validating content. Expiring a
 // cycle's source freshness must still fence an otherwise-valid live lease.
 f.db.raw.execute=async statement=>{
  if(armed&&!changed&&mutation==='source_freshness_expires'&&String(statement?.sql??statement).startsWith('SELECT u.status,u.timezone,u.lifecycle_generation')){
   changed=true;f.setTime('2026-09-20T02:10:10Z');
  }
  return execute(statement);
 };
 t.after(()=>{f.db.raw.transaction=open;f.db.raw.execute=execute;});
 const result=await runtime.daily({userId:'a',expectedLifecycleGeneration:f.user.lifecycleGeneration,timezone:'Asia/Taipei',source:{poll:async()=>({sleeps:[],recoveries:[]})}});
 assert.equal(changed,true);assert.equal(sends,0);assert.equal(result.status,'FAILED_DEFINITE');
 assert.deepEqual((await execute("SELECT source_generation,purge_generation FROM phase4_user_state WHERE user_id='a'")).rows[0],generations);
 const attempts=(await execute("SELECT state,provider_message_id FROM outbound_delivery_attempts WHERE user_id='a' AND execution_mode='LIVE'")).rows;
 assert.equal(attempts.length,1);assert.equal(attempts[0].state,'FAILED_DEFINITE');assert.equal(attempts[0].provider_message_id,null);
});

import {fileURLToPath} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../..',import.meta.url));
const {stage8Fixture}=await import(root+'/test/stage8Fixture.js');
const {createStage8MorningRuntime}=await import(root+'/src/stage8MorningRuntime.js');
async function morning(t){const f=await stage8Fixture(t);let sends=0;t.mock.method(globalThis,'fetch',()=>{sends++;return new Response(JSON.stringify({ok:false,error_code:429,description:'Synthetic rejection'}),{status:429});});
 const runtime=await createStage8MorningRuntime({...f,environment:{...f.environment,STAGE8_MORNING_BRIEF:'on'},env:f.env,now:f.now});
 await runtime.core.initializeTenant('a','LIVE');await runtime.store.requestCutover(await runtime.core.captureControl('a'),{expectedRevision:0});f.setTime('2026-09-20T02:10:00Z');
 const input={userId:'a',expectedLifecycleGeneration:1,timezone:'Asia/Taipei',source:{poll:async()=>({sleeps:[],recoveries:[]})}};return {...f,runtime,input,sends:()=>sends};}
for(const mutation of ['auth','profile','pause'])test('Morning stale '+mutation+' after retry becomes ELIGIBLE must close original reservation',async t=>{
 const f=await morning(t);assert.equal((await f.runtime.daily(f.input)).status,'FAILED_DEFINITE');assert.equal((await f.runtime.daily(f.input)).status,'RETRY_WAIT');
 if(mutation==='auth')await f.db.raw.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'");
 if(mutation==='profile')await f.db.setLocale('a','vi');
 if(mutation==='pause'){const p=await f.app.preferences.read({user:f.user,chatId:'123'});await f.app.preferences.update({user:f.user,chatId:'123'},p.preference_version,{notifications_paused:1});}
 if(mutation==='resource')await f.db.raw.execute("UPDATE whoop_resource_access SET status='DENIED' WHERE user_id='a' AND resource='sleep'");
 f.setTime('2026-09-20T02:11:00Z');let result,error;try{result=await f.runtime.daily(f.input);}catch(e){error=e.message;}
 const row=(await f.db.raw.execute('SELECT state FROM outbound_messages')).rows[0],reservation=(await f.db.raw.execute('SELECT state FROM outbound_semantic_reservations')).rows[0];
 console.log('RETRY_PROBE',JSON.stringify({mutation,result,error,message:row.state,reservation:reservation.state,sends:f.sends()}));
 assert.equal(result?.status,'FAILED_TERMINAL');assert.equal(reservation.state,'CLOSED');assert.equal(f.sends(),1);
});

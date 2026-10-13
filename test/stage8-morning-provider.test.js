import test from 'node:test';import assert from 'node:assert/strict';
import {stage8Fixture} from './stage8Fixture.js';
import {createStage8MorningRuntime} from '../src/stage8MorningRuntime.js';
import {createStage7Runtime} from '../src/stage7Runtime.js';
for(const acceptance of ['delivered','malformed','uncertain'])test(`Morning provider ${acceptance}: bounded source refresh, typed receipt and permanent dedupe`,async t=>{
 const f=await stage8Fixture(t);let sends=0,polls=0;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(String(url),'https://api.telegram.org/botSYNTHETIC_NOT_A_TOKEN/sendMessage');const body=JSON.parse(options.body);assert.equal(body.chat_id,'123');assert.match(body.text,/Morning Brief/);sends++;
  if(acceptance==='uncertain')throw Error('SYNTHETIC_NETWORK_UNCERTAIN');
  return new Response(JSON.stringify({ok:true,result:{message_id:acceptance==='malformed'?0:99,date:1,chat:{id:123,type:'private'}}}),{status:200});
 });
 const environment={...f.environment,STAGE8_MORNING_BRIEF:'on',PHASE4_DELIVERY_CUTOVER:'off'},runtime=await createStage8MorningRuntime({...f,environment,env:f.env,now:f.now});
 await runtime.core.initializeTenant('a','LIVE');const control=await runtime.core.captureControl('a');await runtime.store.requestCutover(control,{expectedRevision:0});f.setTime('2026-09-20T02:10:00Z');
 const input={userId:'a',expectedLifecycleGeneration:f.user.lifecycleGeneration,timezone:'Asia/Taipei',source:{poll:async()=>{polls++;return {sleeps:[],recoveries:[]};}}};
 const first=await runtime.daily(input);assert.equal(first.status,acceptance==='delivered'?'sent':'AMBIGUOUS');assert.equal(await runtime.settled('a','2026-09-20'),true);
 assert.equal((await runtime.daily(input)).status,'already_sent');assert.equal(sends,1);assert.equal(polls,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_delivery_attempts')).rows[0].n,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM report_claims')).rows[0].n,0);
 assert.equal((await f.db.raw.execute("SELECT last_completed_generation FROM phase4_computation_state WHERE user_id='a' AND execution_mode='LIVE'")).rows[0].last_completed_generation,0);
 // Only a confirmed typed delivery can enable Stage 7 post-brief Journal.
 const stage7=await createStage7Runtime({...f,environment:{STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a'},now:f.now});
 const actor=await stage7.companion.interactions.authenticate(f.input);await f.db.transaction(async()=>{const prefs=await stage7.companion.preferences(actor);await stage7.companion.changePreferences(actor,prefs,{daily_enabled:1});});
 const next=await stage7.companion.prepareAfterBrief({...f.input,healthDay:'2026-09-20'});assert.equal(next.status,acceptance==='delivered'?'PROPOSED':'BRIEF_NOT_CONFIRMED');
});
test('Morning runtime disabled performs no database IO; bounded poll overflow cannot invoke provider or persist a refresh',async t=>{
 const db=new Proxy({},{get(){throw Error('DATABASE_FORBIDDEN');}});assert.equal(await createStage8MorningRuntime({db,environment:{}}),null);
 const f=await stage8Fixture(t);t.mock.method(globalThis,'fetch',()=>{throw Error('NETWORK_FORBIDDEN');});
 const environment={...f.environment,STAGE8_MORNING_BRIEF:'on'},runtime=await createStage8MorningRuntime({...f,environment,env:f.env,now:f.now});await runtime.core.initializeTenant('a','LIVE');const control=await runtime.core.captureControl('a');await runtime.store.requestCutover(control,{expectedRevision:0});f.setTime('2026-09-20T02:10:00Z');
 await assert.rejects(runtime.daily({userId:'a',expectedLifecycleGeneration:1,timezone:'Asia/Taipei',source:{poll:async()=>({sleeps:Array(51).fill({}),recoveries:[]})}}),/REFRESH_BOUNDS/);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM morning_readiness_refreshes')).rows[0].n,0);
 environment.STAGE8_USER_IDS='b';environment.PHASE4_BETA_PILOT_USER_ID='b';assert.equal(runtime.eligible('a'),false);
});

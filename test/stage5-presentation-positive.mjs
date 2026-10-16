// Separate positive acceptance probe. A failure here is not counted as reader
// success; keep the original Stage6 result and diagnose that dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,request} from './stage5HistoryFixture.js';
import {call} from './stage5ClosureFixture.js';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {finalizedFixtureDrain} from './finalizedStage6Fixture.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createStage5PresentationReader} from '../src/stage5PresentationReader.js';
async function bind(f){
 await f.db.linkTelegram({userId:'a',chatId:'123'});await f.db.linkTelegram({userId:'b',chatId:'456'});
 await f.db.saveTokens('a',{accessToken:'fixture',refreshToken:'fixture',expiresAt:new Date('2027-01-01'),scope:'offline',whoopUserId:'fixture'},{now:new Date()});
 await f.db.raw.execute("INSERT INTO user_onboarding(user_id,state,state_changed_at,created_at,updated_at) VALUES('a','READY','2026-10-16','2026-10-16','2026-10-16') ON CONFLICT(user_id) DO UPDATE SET state='READY'");
 return f.db.getUser('a');
}
const reader=async f=>createStage5PresentationReader({...f,stores:await createPhase4Foundation({db:f.db,keys:f.keys,admission:await f.db.admitRuntime(),now:()=>new Date()}),eligible:id=>id==='a',now:()=>new Date()});

test('genuine finalized v33 analysis presents typed episode and baseline evidence without publishing LIVE', {timeout:120000},async t=>{
 const f=await setup(t,{targetVersion:30,inputAsOf:Date.now()-1000,liveClock:true});
 await f.stores.release(f.context);f.context=null;
 await f.db.migrate();await f.db.setLocale('a','en');
 const user=await bind(f);
 // Token binding changes source generations, so capture the real current roots.
 const restarted=await f.restart();f.stores=restarted.stores;
 const context=await f.stores.capture('a',{executionMode:'SHADOW'}),refs=[];
 for(const id of f.recoveryIds)refs.push((await f.stores.root(context,'recovery',id)).ref);
 f.context=context;
 const result=await call(f,'intelligence','analyzeMetric',{...request(refs[0],refs.slice(1),new Date().toISOString()),windowFamily:'PRESENTATION_TYPED_EPISODE'});
 assert.ok(result.episode);
 await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
 const worker=await createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date()});
 for(let n=0;n<12&&(await worker.diagnostics()).pendingJobs;n++){
  const drained=await finalizedFixtureDrain(f.db,worker,{budget:{maxItemsPerTenant:32,maxItems:64}});
  assert.equal(drained.failedJobs,0,JSON.stringify(drained));
 }
 assert.equal((await worker.diagnostics()).pendingJobs,0);
 f.stores=(await f.restart()).stores;const r=await reader(f);
 const reply=await r.handle({text:'/evidence phase4',chatId:'123',user});
 assert.ok(reply.stage5PresentationGuard,reply.text);assert.match(reply.text,/personal baseline/);assert.match(reply.text,/Current value/);assert.match(reply.text,/Samples/);
 assert.ok(reply.stage7SourceEvidence.length>0);assert.equal(await r.verify({userId:'a',chatId:'123',reply}),true);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_computation_state WHERE execution_mode='LIVE'")).rows[0].n,0);
 await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
 assert.equal(await r.verify({userId:'a',chatId:'123',reply}),false);
});

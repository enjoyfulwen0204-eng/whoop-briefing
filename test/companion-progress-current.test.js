import test from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createCompanionProgress} from '../src/companionProgress.js';
import {runCompanionStep} from '../src/companionStep.js';
import {currentExecutionBudget} from '../src/executionBudget.js';
import {syntheticStage7V33Fixture} from './stage7-v33-fixture.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {invokeCompanion,invokeExtras} from '../cloudflare/briefing-scheduler/worker.js';
registerHooks({load(url,context,next){if(url.endsWith('/src/stage7Cohort.js'))return {format:'module',source:'export const isApprovedStage7Three=ids=>ids.join(",")==="a,b,c";',shortCircuit:true};return next(url,context);}});
const {runCompanionService,runExtrasService,COMPANION_KIND,EXTRAS_KIND}=await import('../src/companionService.js');
test('progress preserves partial insight, counts untouched work, and freezes against late callbacks',()=>{
 const p=createCompanionProgress(['a','b','c'].map(u=>[u,['daily','insight','coach']]));
 p.start('a');p.observe({user:'a',step:'daily',status:'SENT'});p.finish('a');
 p.start('b');p.observe({user:'b',step:'daily',status:'SENT'});p.observe({user:'b',step:'insight',status:'DEFERRED_BUDGET'});p.observe({user:'b',step:'coach',status:'STARTED'});
 const r=p.freeze(true);assert.deepEqual([r.checked,r.completedUsers,r.unprocessedUsers,r.incompleteUsers],[2,1,1,1]);assert.deepEqual(r.deferredSteps,{insight:2,daily:1,coach:1});assert.deepEqual(r.interruptedSteps,{coach:1});
 p.observe({user:'b',step:'coach',status:'SENT'});p.finish('b');assert.deepEqual(p.snapshot(),r);assert.equal(r.outcomes.SENT,2);
});
for(const extras of [false,true])test(`${extras?'extras':'companion'}: actual admitted service expires midway user 2 without losing summary`,async t=>{
 const f=await syntheticStage7V33Fixture(t);await f.db.createUser({id:'c',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'},{now:f.core.now()});await f.core.initializeTenant('c','SHADOW');
 for(const [i,id] of ['a','b','c'].entries()){await f.db.linkTelegram({userId:id,chatId:String(123+i),now:f.core.now()});await f.db.ensureOnboarding(id,{state:'READY',now:f.core.now()});}
 const environment={STAGE7_COMPANION:'on',STAGE7_AUTOMATIC:'on',STAGE7_COMPANION_USER_IDS:'a,b,c',...(extras?{FAMILY_SHARING:'on',FAMILY_GROUP_USER_IDS:'a,b,c'}:{})};
 const releaseSha=runningReleaseSha(environment),request={kind:extras?EXTRAS_KIND:COMPANION_KIND,requestId:'synthetic-progress-request-001',releaseSha,configProof:configurationProof(f.keys,publicBetaConfiguration(environment),environment,releaseSha),executionMode:'OFF',triggerSource:'cloudflare'};
 let count=0,clock=Date.now();t.mock.method(Date,'now',()=>clock);t.mock.method(console,'log',()=>{});
 const step=(id,name,status)=>runCompanionStep({db:f.db,keys:f.keys,userId:id,step:name,run:async()=>({status})});
 const expire=()=>{clock=currentExecutionBudget().deadlineAt+1;currentExecutionBudget().assert();};
 const deps=extras?{createFamily:()=>({tick:async()=>{
  for(const id of ['a','b']){await step(id,'family_daily','NO_CONSENT');await step(id,'family_alert','DEFERRED_BUDGET');count++;if(count===2)expire();await step(id,'family_weekly','NO_CONSENT');}
  assert.fail('unreachable');}}),notifyPrediction:()=>assert.fail('not reached')}:{createRuntime:async()=>({tick:async({user})=>{
  count++;await step(user.id,'daily','DISABLED');await step(user.id,'insight','DEFERRED_BUDGET');if(count===2)expire();return {daily:'DISABLED',insight:'DEFERRED_BUDGET'};
 }})};
 const r=await (extras?runExtrasService:runCompanionService)({db:f.db,keys:f.keys,env:{},environment,request,now:f.core.now,deps});
 assert.equal(r.status,503);assert.equal(r.body.error,'SYNC_TIMEOUT');assert.equal(r.body.checked,2);assert.equal(r.body.unprocessedUsers,1);assert.equal(r.body.budgetExhausted,true);
 if(extras){assert.equal(r.body.deferredSteps.family_alert,3);assert.equal(r.body.deferredSteps.family_weekly,2);assert.equal(r.body.deferredSteps.prediction,3);}else{assert.equal(r.body.completedUsers,1);assert.equal(r.body.deferredSteps.insight,3);assert.equal(r.body.deferredSteps.coach,2);}
 assert.equal(count,2);
});
for(const [invoke,kind,label] of [[invokeCompanion,'COMPANION_V1','companion'],[invokeExtras,'EXTRAS_V1','extras']])test(`${label}: Worker retains sanitized deadline summary on failed response`,async t=>{
 const logs=[];t.mock.method(console,'log',s=>logs.push(JSON.parse(s)));
 const env={BRIEFING_COMPANION_ENABLED:'on',BRIEFING_ENDPOINT_URL:'https://synthetic.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:'x'.repeat(32),BRIEFING_RELEASE_SHA:'a'.repeat(40),BRIEFING_CONFIG_PROOF:'b'.repeat(64),BRIEFING_EXECUTION_MODE:'OFF'};
 await assert.rejects(invoke(env,{signImpl:async()=> 'synthetic',fetchImpl:async()=>Response.json({ok:false,kind,source:'cloudflare',releaseSha:env.BRIEFING_RELEASE_SHA,drainAuthorized:false,checked:2,completedUsers:1,unprocessedUsers:1,incompleteUsers:1,budgetExhausted:true,deferredSteps:{insight:2,private:'SECRET'},interruptedSteps:{coach:1},private:'SECRET'},{status:503})}),new RegExp(label+'_failed'));
 assert.equal(logs[0].checked,2);assert.equal(logs[0].unprocessed_users,1);assert.equal(logs[0].deferred_steps.insight,2);assert.equal(logs[0].interrupted_steps.coach,1);assert.doesNotMatch(JSON.stringify(logs),/SECRET|private/);
});

test('unstarted family deferrals do not count checked users, and uncertain outcomes survive a later timeout',()=>{
 const p=createCompanionProgress([['a',['family_daily','prediction']],['b',['family_daily','prediction']]]);
 p.observe({user:'a',step:'family_daily',status:'DEFERRED_BUDGET'});p.observe({user:'b',step:'family_daily',status:'DEFERRED_BUDGET'});
 assert.equal(p.snapshot().checked,0);assert.equal(p.snapshot().unprocessedUsers,2);
 p.observe({user:'a',step:'prediction',status:'DELIVERY_STARTED'});p.observe({user:'a',step:'private',status:'SECRET'});p.observe({user:'a',step:'prediction',status:'private data'});
 const r=p.freeze(true);assert.equal(r.failedUsers,1);assert.equal(r.outcomes.DELIVERY_STARTED,1);assert.doesNotMatch(JSON.stringify(r),/SECRET|private/);
 assert.deepEqual(r.deferredSteps,{family_daily:2,prediction:1});
});

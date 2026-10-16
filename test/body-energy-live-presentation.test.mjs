import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {createStage8Runtime} from '../src/stage8Runtime.js';
import {createStage8DerivedReader} from '../src/stage8DerivedReader.js';
import {createScopedHealthContext} from '../src/scopedHealthContext.js';
import {createBodyEnergyIntegration} from '../src/bodyEnergyIntegration.js';
import {authorizeBodyEnergyFixturePublication} from '../src/bodyEnergyQualificationAuthority.js';
import {BODY_ENERGY_PROVISIONAL_POLICY as PROVISIONAL} from '../src/bodyEnergyProvisionalPolicy.js';
import {createStage8PresentationSender} from '../src/stage8PresentationSender.js';

async function setup(t,days){
 let offset=0,enabled=true;const now=()=>new Date(Date.now()+offset),f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now});
 const input=bodyInput({asOf:Date.now()-1000,days});
 input.sources.recovery[0].cycle_id=input.sources.cycle[0].id;
 input.sources.cycle[0].start_at=input.sources.sleep[0].start_at;input.sources.cycle[0].score_state='SCORED';
 await f.db.transaction(()=>seedBodyInput(f.db,input));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});await f.db.setLocale('a','en');
 const admission=await f.db.admitRuntime(),producer=await createStage8LiveProducer({...f,admission,userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 let last,legs=0;for(;legs<40;legs++){last=await producer.run({userId:'a',requestId:`body-live-query-${days}-${legs}`});if(last.publication.status==='CURRENT')break;}
 assert.equal(last.publication.status,'CURRENT','genuine local producer must finalize before positive presentation');
 t.diagnostic(`Synthetic ${days}-day fixture: ${legs+1} original bounded genuine producer legs, no Production evidence.`);
 const environment={PHASE4_STAGE8_RUNTIME:'on',PHASE4_BETA_PILOT_USER_ID:'a',STAGE8_USER_IDS:'a'};
 const service=async policy=>{
  const grant=policy===false?null:await authorizeBodyEnergyFixturePublication({db:f.db,userIds:['a'],presentationPolicy:policy});
  const bodyEnergy=createBodyEnergyIntegration({...f,publicationCapability:grant,publicationEnabled:()=>enabled,now});
  return createStage8Runtime({...f,environment,bodyEnergy,now});
 };
 const user=await f.db.getUser('a'),actor={user,chatId:'10001'};
 return {...f,admission,environment,service,actor,now,disable:()=>{enabled=false;},advance:ms=>{offset+=ms;}};
}
const inputFor=(f,reply)=>({userId:'a',chatId:'10001',reply});
const send=async input=>({sent:await input.beforeSend()});

test('qualified mature LIVE query uses actual finalized artifacts, separate source pages and final dual authority',async t=>{
 const f=await setup(t,30),app=await f.service(null);
 for(const [locale,word] of [['en',/engineering estimate/],['zh-TW',/工程估計/],['vi',/Ước tính kỹ thuật/]]){
  await f.db.setLocale('a',locale);
  const reply=await app.handle({...f.actor,text:'/energy@Synthetic_Bot sources 2'});
  assert.match(reply.text,/\d+\/100/);assert.match(reply.text,word);assert.match(reply.text,/sources 2/);
  assert.ok(reply.text.length<4096);assert.ok(reply.stage8ReplyGuard);assert.equal(reply.stage8BodyEnergyGuard.qualified,true);
  assert.equal((await app.sendReply(send,inputFor(f,reply))).sent,true);
  assert.equal((await app.sendReply(send,inputFor(f,{...reply,text:reply.text+'tampered'}))).sent,false);
 }
 // The generic typed projection remains small; the larger provenance is only
 // produced by the separately composed qualified self-presentation reader.
 const reader=createStage8DerivedReader({...f,eligible:id=>id==='a',now:f.now}),scopes=await createScopedHealthContext({...f,derivedReader:reader,now:f.now}),scope=await scopes.open({...f.actor,text:'/energy',asOf:f.now()});
 const generic=await scopes.derived(scope,'BODY_ENERGY');assert.equal(generic.status,'CURRENT');assert.ok(generic.items.length);
 assert.ok(generic.items.every(item=>!Object.hasOwn(item,'presentation')&&!Object.hasOwn(item,'provenance')));
 const reply=await app.handle({...f.actor,text:'/energy'});
 let previous=0,transport=0;
 assert.equal((await app.sendReply(async input=>{transport++;return send(input);},{...inputFor(f,reply),beforeSend:()=>{previous++;return false;}})).sent,false);
 assert.equal(previous,1);assert.equal(transport,0);
 for(const changed of [{...inputFor(f,reply),userId:'b',chatId:'10002'},inputFor(f,{stage8BodyEnergyGuard:reply.stage8BodyEnergyGuard}),inputFor(f,{...reply,stage8BodyEnergyGuard:{...reply.stage8BodyEnergyGuard,ready:false}})])
  assert.equal((await app.sendReply(send,changed)).sent,false);
 const ownerOnly=await f.service(PROVISIONAL.version),blocked=await ownerOnly.handle({...f.actor,text:'/energy'});
 assert.doesNotMatch(blocked.text,/\d+\/100/,'owner provisional never authorizes a mature score');
 const noGrant=await f.service(false),pending=await noGrant.handle({...f.actor,text:'/energy'});
 assert.doesNotMatch(pending.text,/\d+\/100/);assert.equal(pending.stage8BodyEnergyGuard.qualified,false);
 assert.equal((await noGrant.sendReply(send,inputFor(f,pending))).sent,true);
 f.disable();assert.equal((await app.sendReply(send,inputFor(f,reply))).sent,false);
 assert.equal((await createStage8PresentationSender(null,send)(inputFor(f,reply))).sent,false);
 assert.equal((await createStage8PresentationSender(null,send)(inputFor(f,{stage8BodyEnergyGuard:reply.stage8BodyEnergyGuard}))).sent,false);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
});

test('owner baseline-only LIVE estimate remains explicitly LIMITED and suppresses stale source, profile and availability changes',async t=>{
 const f=await setup(t,7),app=await f.service(PROVISIONAL.version),reply=await app.handle({...f.actor,text:'/energy'});
 assert.match(reply.text,/\d+\/100/);assert.match(reply.text,/LIMITED/);assert.match(reply.text,/baseline still being established/);
 assert.equal(reply.stage8BodyEnergyGuard.presentationPolicy,PROVISIONAL.version);
 assert.equal((await app.sendReply(send,inputFor(f,reply))).sent,true);
 const matureOnly=await f.service(null),blocked=await matureOnly.handle({...f.actor,text:'/energy'});
 assert.doesNotMatch(blocked.text,/\d+\/100/,'mature grant does not approve a LIMITED result');
 const stop=Error('ROLLBACK');
 const changed=async work=>{try{await f.db.transaction(async()=>{await work();assert.equal((await app.sendReply(send,inputFor(f,reply))).sent,false);throw stop;});}catch(error){if(error!==stop)throw error;}};
 await changed(()=>f.db.raw.execute("UPDATE whoop_recoveries SET hrv_rmssd_milli=hrv_rmssd_milli+1 WHERE user_id='a'"));
 await changed(()=>f.db.raw.execute("UPDATE user_onboarding SET state='PENDING_OAUTH' WHERE user_id='a'"));
 await changed(()=>f.db.updateUser('a',{displayName:'Changed'}));
 await changed(()=>f.db.setLocale('a','vi'));
 assert.equal((await app.sendReply(send,inputFor(f,reply))).sent,true);
 f.advance(91*60000);assert.equal((await app.sendReply(send,inputFor(f,reply))).sent,false);
 const stale=await app.handle({...f.actor,text:'/energy'});assert.doesNotMatch(stale.text,/\d+\/100/);
 f.environment.PHASE4_STAGE8_RUNTIME='off';assert.equal((await app.sendReply(send,inputFor(f,reply))).sent,false);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
});

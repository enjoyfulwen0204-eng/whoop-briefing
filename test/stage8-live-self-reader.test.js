import test from 'node:test';
import assert from 'node:assert/strict';
import {stage8Fixture} from './stage8Fixture.js';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {createStage8DerivedReader,stage8EvidenceProjection,stage8AssociationProjection,stage8EvidenceItemSelection} from '../src/stage8DerivedReader.js';
import {createScopedHealthContext,selfQueryPerspective} from '../src/scopedHealthContext.js';
import {createStage8SelfQa,stage8LiveCommand} from '../src/stage8SelfQa.js';

test('LIVE command namespace preserves legacy handlers and never takes a caller-selected subject',()=>{
 for(const value of ['/insights','/evidence','/insights phase4','/evidence phase4','/insights weekly','/settings'])assert.equal(stage8LiveCommand(value),null);
 for(const [text,kind,history] of [['/insights live','INSIGHTS',false],['/evidence@bot live','EVIDENCE',false],['/episodes','EPISODES',false],['/episodes live history','EPISODES',true],['/insights live history','INSIGHTS',true]]){
  assert.deepEqual(stage8LiveCommand(text),{kind,history});assert.equal(selfQueryPerspective({text}).usePersonalData,true);
 }
 for(const value of ['/episodes b','/insights live user b','/evidence live SHADOW'])assert.deepEqual(stage8LiveCommand(value),{invalid:true});
 assert.equal(selfQueryPerspective({text:'Why has my friend’s Recovery been low?'}).usePersonalData,false);
});

test('data-only evidence projection labels insufficient calculations and excludes unapproved methods/claims',()=>{
 const run={run_id:'local-fixture',state:'COMPLETED',method:'PERSONAL_BASELINE_DEVIATION',as_of_utc:'2026-10-16T00:00:00.000Z',window_start_utc:'2026-10-01T00:00:00.000Z',window_end_utc:'2026-10-16T00:00:00.000Z',sample_count:7,input_manifest_json:JSON.stringify({manifest_version:'phase4-metric-evidence-input-v2',metric_key:'recovery_score',baseline:{median:60,q1:59,q3:63,lookback_days:45}})};
 const item={run_id:run.run_id,claim_key:'metric:recovery_score',unit:'score',quality:'LIMITED',causal_status:'ASSOCIATION_ONLY',effect:-50,provenance_json:JSON.stringify({method:'CURRENT_VS_ROBUST_BASELINE',current:{value:10,observedAt:run.as_of_utc,healthDate:'2026-10-16',sourceId:'PRIVATE_SOURCE_ID'}})};
 const projected=stage8EvidenceProjection(run,item);assert.equal(projected.outcome,'PERSONAL_BASELINE_COMPARISON');assert.equal(projected.baseline.median,60);assert.equal(projected.delta,-50);assert.ok(!JSON.stringify(projected).includes('PRIVATE_SOURCE_ID'));
 assert.equal(stage8EvidenceProjection({...run,sample_count:3},item).outcome,'INSUFFICIENT_EVIDENCE');
 assert.equal(stage8EvidenceProjection(run,{...item,quality:'WARMING_UP'}).baseline,undefined);
 assert.equal(stage8EvidenceProjection({...run,method:'CORRELATION'},item),null);
 assert.equal(stage8EvidenceProjection(run,{...item,causal_status:'CAUSAL'}),null);
 assert.equal(stage8AssociationProjection('caffeine caused low recovery'),null);
 assert.deepEqual(stage8AssociationProjection('caffeine has been repeatedly associated in your data with lower recovery_score.'),{factor:'caffeine',direction:'LOWER',metricKey:'recovery_score'});
});

test('v34 explicit LIVE reads are guarded updating, localized, and bare legacy commands pass through',async t=>{
 const f=await stage8Fixture(t);
 assert.deepEqual((await f.db.raw.execute(stage8EvidenceItemSelection({userId:'a'},999,'unrelated-run'))).rows,[]);
 for(const text of ['/insights','/evidence','/insights phase4','/evidence phase4'])assert.equal(await f.app.handle({...f.input,text}),null);
 for(const [locale,word] of [['en',/Analysis is updating/],['zh-TW',/分析仍在更新/],['vi',/Phân tích đang cập nhật/]]){
  await f.db.setLocale('a',locale);
  for(const text of ['/insights live','/episodes','/evidence live']){
   const reply=await f.app.handle({...f.input,text});assert.match(reply.text,word);assert.ok(reply.stage8ReplyGuard);
   assert.equal(await f.app.scopes.verifyReply({userId:'a',chatId:'123',reply}),true);
   assert.equal(await f.app.scopes.verifyReply({userId:'b',chatId:'456',reply}),false);
  }
 }
});

test('genuine LIVE producer supplies personal-baseline evidence and episode details to guarded self commands',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,now:()=>new Date()}),input=bodyInput({asOf:Date.now()-1000,days:10});
 // Ten real earlier Recovery days satisfy the registry's severe-single
 // confidence threshold. Sleep history is unrelated to this reader seam.
 input.sources.sleep=input.sources.sleep.slice(0,1);
 for(let i=0;i<input.sources.recovery.length;i++)input.sources.recovery[i].recovery_score=i===0?10:60+i%5;
 await f.db.transaction(()=>seedBodyInput(f.db,input));await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});await f.db.setLocale('a','en');
 const admission=await f.db.admitRuntime(),producer=await createStage8LiveProducer({...f,admission,userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 let last,legs=0;for(;legs<40;legs++){last=await producer.run({userId:'a',requestId:`self-reader-positive-${legs}`});t.diagnostic(`Genuine local producer leg ${legs+1}: ${last.publication.status}`);if(last.publication.status==='CURRENT')break;}
 assert.equal(last.publication.status,'CURRENT');
 const derivedReader=createStage8DerivedReader({...f,admission,eligible:id=>id==='a'}),scopes=await createScopedHealthContext({...f,admission,derivedReader}),qa=createStage8SelfQa({scopes,db:f.db}),user=await f.db.getUser('a'),actor={user,chatId:'10001'},scope=await scopes.open({...actor,text:'/episodes'});
 const episodes=await scopes.derived(scope,'EPISODES');assert.equal(episodes.status,'CURRENT');assert.ok(episodes.items.some(item=>item.metricKey==='recovery_score'));assert.ok(episodes.items.every(item=>item.evidence.length&&item.history.length));assert.equal(episodes.historyScope,'RETAINED_CURRENT_GENERATION_ONLY');
 const evidence=await scopes.derived(scope,'EVIDENCE');assert.equal(evidence.status,'CURRENT');assert.ok(evidence.items.some(item=>item.evidence.some(value=>value.outcome==='PERSONAL_BASELINE_COMPARISON')));assert.ok(evidence.items.every(item=>!Object.hasOwn(item,'value')));
 const reply=await qa.handle({...actor,text:'/episodes history'});assert.match(reply.text,/Recovery/);assert.match(reply.text,/personal baseline/);assert.match(reply.text,/not your complete health history/);assert.ok(reply.stage8ReplyGuard);assert.equal(await scopes.verifyReply({userId:'a',chatId:'10001',reply}),true);
 const why=await qa.handle({...actor,text:'Why has my Recovery been low recently?'});assert.match(why.text,/cannot establish why/);assert.match(why.text,/Recovery/);assert.equal(await scopes.verifyReply({userId:'a',chatId:'10001',reply:why}),true);
 await t.test('final-send verification rechecks actual source graphs even when computation metadata is unchanged',async()=>{
  const stop=Error('ROLLBACK');try{await f.db.transaction(async()=>{await f.db.raw.execute("UPDATE whoop_recoveries SET recovery_score=recovery_score+1 WHERE user_id='a'");assert.equal(await scopes.verifyReply({userId:'a',chatId:'10001',reply}),false);throw stop;});}catch(error){if(error!==stop)throw error;}
  assert.equal(await scopes.verifyReply({userId:'a',chatId:'10001',reply}),true);
 });
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
 t.diagnostic(`Bounded local synthetic positive: ${legs+1} genuine producer legs; no production evidence or deployment claim.`);
});

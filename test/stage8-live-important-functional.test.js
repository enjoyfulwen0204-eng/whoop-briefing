import {importantFixture as fixture} from './stage8LiveFunctionalFixture.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {subjectAlertExecutionId} from '../src/stage8SubjectAlertManifest.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {createSyntheticStage8SubjectAlertProvider} from '../src/stage8SubjectAlerts.js';
import {createOwnerMonitoring} from '../src/stage8OwnerMonitoring.js';
import {createStage8DerivedReader} from '../src/stage8DerivedReader.js';import {createScopedHealthContext} from '../src/scopedHealthContext.js';
for(const outcome of ['DELIVERED','AMBIGUOUS'])test(`genuine ${outcome} subject alert is finalized, signed and typed before separately authorized IMPORTANT copying`,async t=>{
 const start=performance.now(),cpu=process.cpuUsage(),f=await fixture(t,outcome);let last;
 for(let leg=0;leg<40;leg++){last=await f.producer.run({userId:'a',requestId:`important-${outcome}-${leg}`});if(last.publication.status==='CURRENT')break;}
 assert.equal(last.publication.status,'CURRENT');assert.equal(f.provider.calls.length,1);
 const message=(await f.db.raw.execute("SELECT * FROM outbound_messages WHERE message_class='EPISODE_NOTIFICATION'")).rows[0];assert.equal(message.state,outcome);
 const decision=(await f.db.raw.execute('SELECT * FROM phase4_proactive_decisions')).rows[0];assert.equal(decision.action,'NOTIFY');
 const source=(await f.db.raw.execute("SELECT e.*,p.user_id FROM stage8_live_executions e JOIN stage8_live_execution_producers p ON p.producing_execution_id=e.execution_id WHERE p.user_id='a' AND json_extract(e.result_json,'$.alertSourceDigest') IS NOT NULL")).rows;assert.equal(source.length,1);assert.equal(source[0].state,'FINALIZED_SUCCESS');assert.equal(source[0].execution_id,f.keys.lookup(['stage8-live-subject-alert-execution-v1','a',JSON.parse(source[0].canonical_request_json).tenantScope]));assert.match(JSON.parse(source[0].result_json).alertSourceDigest,/^[a-f0-9]{64}$/);
 const reader=createStage8DerivedReader({...f,eligible:id=>id==='a'}),scopes=await createScopedHealthContext({...f,derivedReader:reader}),scope=await scopes.open({user:await f.db.getUser('a'),chatId:'10001',text:'How is my recovery?'}),typed=await scopes.derived(scope,'EPISODES');assert.equal(typed.status,'CURRENT');assert.ok(typed.items.length>0);
 await t.test('replay and restart never send a second subject alert',async()=>{
  const restart=await createStage8LiveProducer({...f,userIds:['a'],enabled:()=>true,eligible:id=>id==='a',subjectAlertProvider:f.provider});
  assert.equal((await restart.run({userId:'a',requestId:`important-${outcome}-0`})).publication.status,'CURRENT');assert.equal(f.provider.calls.length,1);
 });
 await f.db.raw.execute("INSERT INTO user_whoop_tokens(user_id,access_token,refresh_token,access_token_expires_at,updated_at,auth_generation) VALUES('b','SYNTHETIC','SYNTHETIC','2099-01-01','2026-10-01',1)");await f.db.linkTelegram({userId:'b',chatId:'10002'});
 const owner=await createOwnerMonitoring({...f,ownerId:'b',enabled:()=>true}),actor=await owner.authenticate({user:await f.db.getUser('b'),chatId:'10002'}),request={subjectId:'a',notificationClass:'IMPORTANT_ALERT'};
 await t.test('no fabricated follow, explicit class authority required',async()=>{await assert.rejects(owner.authorize(actor,request),/SUBSCRIPTION/);});
 await owner.configure(actor,{...request,enabled:true,expectedRevision:0,operationKey:`important-follow-${outcome}`});
 const approved=await owner.authorize(actor,request);assert.equal(approved.status,'APPROVED');const proposal=await owner.propose(actor,approved.ticket);assert.equal(proposal.status,'PROPOSED');
 const value=await owner.validate(actor,'a',proposal.messageId);assert.equal(value.payload.claims[0].kind,'APPROVED_IMPORTANT_ALERT');assert.equal(value.payload.claims[0].claim,message.payload_text);
 await t.test('Owner semantic identity deduplicates unchanged alert',async()=>{const again=await owner.authorize(actor,request);assert.equal((await owner.propose(actor,again.ticket)).messageId,proposal.messageId);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM owner_monitoring_outbox')).rows[0].n,1);});
 const rollback=async fn=>{const stop=Error('ROLLBACK');try{await f.db.transaction(async()=>{await fn();throw stop;});}catch(e){if(e!==stop)throw e;}};
 await t.test('immutable source payload rejects fabrication before it can reach an Owner',async()=>{await assert.rejects(f.db.transaction(()=>f.db.raw.execute("UPDATE outbound_messages SET payload_text='FABRICATED' WHERE user_id='a'")),/content_append_only/);assert.equal((await owner.authorize(actor,request)).status,'APPROVED');});
 await t.test('stale input generation is not an approved alert',()=>rollback(async()=>{await f.db.raw.execute("UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a' AND execution_mode='LIVE'");assert.equal((await owner.authorize(actor,request)).status,'ANALYSIS_UPDATING');}));
 await t.test('revoked subject provider and follow are fenced',async()=>{await rollback(async()=>{await f.db.raw.execute("UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'");await assert.rejects(owner.authorize(actor,request),/SUBSCRIPTION/);});await owner.configure(actor,{...request,enabled:false,expectedRevision:1,operationKey:`revoke-important-${outcome}`});await assert.rejects(owner.authorize(actor,request),/SUBSCRIPTION/);});
 t.diagnostic(JSON.stringify({kind:'IMPORTANT_SYNTHETIC_COST',outcome,durationMs:performance.now()-start,cpu:process.cpuUsage(cpu),memory:process.memoryUsage(),resource:process.resourceUsage()}));
});

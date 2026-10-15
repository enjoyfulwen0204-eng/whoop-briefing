import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {createStage8DerivedReader} from '../src/stage8DerivedReader.js';
import {createStage8Runtime} from '../src/stage8Runtime.js';
import {createOwnerMonitoring} from '../src/stage8OwnerMonitoring.js';
import {composePhase4Stores} from '../src/phase4Repositories.js';
import {createScopedHealthContext} from '../src/scopedHealthContext.js';
async function fixture(t){
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,now:()=>new Date()});
 await f.db.linkTelegram({userId:'a',chatId:'10001',now:new Date()});await f.db.ensureOnboarding('a',{state:'READY'});
 await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:7})));
 const control=await f.stores.captureControl('a'),eventAt=new Date(Date.now()-86400000).toISOString(),sourceText=`caffeine at ${eventAt}`;
 const fact=await f.stores.journal.create(control,{sourceEventKey:'live-privacy-source',sourceText,candidate:{category:'caffeine',eventAt,valueKind:'PRESENCE',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:sourceText.length}});
 assert.equal(fact.status,'ACCEPT');
 let enabled=true;
 const admission=await f.db.admitRuntime(),environment={PHASE4_STAGE8_RUNTIME:'on',PHASE4_STAGE8_OWNER_MONITORING:'off',STAGE8_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a',STAGE8_LIVE_ANALYSIS:'on'},app=await createStage8Runtime({...f,environment,env:{telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'}}),producer=app.analysis;
 const reader=createStage8DerivedReader({...f,admission,eligible:id=>id==='a'}),scopes=await createScopedHealthContext({...f,admission,derivedReader:reader});
 const read=async(kind='BODY_ENERGY')=>{const user=(await f.db.resolveUserByChatId('10001')).user;return scopes.derived(await scopes.open({user,chatId:'10001',text:'/energy'}),kind);};
 return {...f,admission,app,environment,fact,producer,read,disable:()=>{enabled=false;environment.STAGE8_LIVE_ANALYSIS='off';}};
}
test('genuine finalized canonical LIVE source computation publishes once and typed self reader accepts only current certificate',async t=>{
 const started=performance.now(),before=process.memoryUsage(),f=await fixture(t);assert.equal((await f.read()).status,'ANALYSIS_UPDATING');
 let last;for(let leg=0;leg<20;leg++){
  last=await f.producer.run({userId:'a',requestId:`positive-leg-${leg}`});
  console.log('synthetic LIVE progress',JSON.stringify(last));
  if(last.publication.status==='CURRENT')break;
 }
 assert.equal(last.publication.status,'CURRENT');const value=await f.read();assert.equal(value.status,'CURRENT');
 assert.equal(value.items.length,1);assert.ok(Number.isFinite(value.items[0].value));assert.equal(value.items[0].estimated,true);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_job_completions')).rows[0].n,2);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_execution_producers')).rows[0].n,0);
 await t.test('all registered typed kinds verify the actual same-generation certificate',async()=>{for(const kind of ['INSIGHTS','EPISODES','EVIDENCE'])assert.equal((await f.read(kind)).status,'CURRENT');});
 const replay=await f.producer.run({userId:'a',requestId:'positive-leg-0'});assert.equal(replay.replayed,true);
 await assert.rejects(f.producer.run({userId:'b',requestId:'peer-request'}),/PRODUCING_AUTHORITY|PRINCIPAL_FENCED/);
 await t.test('runtime composition is off by default and refuses peer production',async()=>{assert.ok(f.app.analysis);await assert.rejects(f.producer.run({userId:'b',requestId:'peer-request-2'}),/PRODUCING_AUTHORITY|PRINCIPAL_FENCED/);});
 const rollback=async work=>{const stop=Error('SYNTHETIC_ROLLBACK');try{await f.db.transaction(async()=>{await work();throw stop;});}catch(e){if(e!==stop)throw e;}};
 await t.test('stale input and source generations reject publication reads',async()=>{for(const sql of ["UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a' AND execution_mode='LIVE'","UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'"])await rollback(async()=>{await f.db.raw.execute(sql);assert.equal((await f.read()).status,'ANALYSIS_UPDATING');});});
 await t.test('revoked provider generation and lifecycle are fenced',async()=>{for(const sql of ["UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'","UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='a'"])await rollback(async()=>{await f.db.raw.execute(sql);assert.equal((await f.read()).status,'ANALYSIS_UPDATING');});});
 await t.test('enrollment revocation blocks canonical computation',async()=>{await rollback(async()=>{await f.db.raw.execute("UPDATE user_onboarding SET state='ACTION_REQUIRED' WHERE user_id='a'");await assert.rejects(f.producer.run({userId:'a',requestId:'revoked-enrollment'}),/PRINCIPAL_FENCED/);});});
 await t.test('receipt metadata stays opaque and no delivery is performed',async()=>{assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);const publication=(await f.db.raw.execute('SELECT * FROM stage8_live_publications')).rows[0];assert.ok(!JSON.stringify(publication).includes('caffeine'));assert.equal(JSON.parse(publication.proofs_json).length,2);});
 await t.test('restart composition replays without duplicate computation or publication',async()=>{const restart=await createStage8LiveProducer({...f,admission:await f.db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});const before=(await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n;assert.equal((await restart.run({userId:'a',requestId:'positive-leg-0'})).replayed,true);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n,before);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,1);});
 await t.test('pending purge blocks reads and producer, then physically scrubs LIVE receipt health fields',async()=>{
  const control=await f.stores.capturePrivacyControl('a'),purge=await f.stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:f.fact.logicalFactId,idempotencyKey:'live-analysis-purge'});
  await assert.rejects(f.read(),/PRINCIPAL_FENCED/);await assert.rejects(f.producer.run({userId:'a',requestId:'pending-purge-request'}),/PRINCIPAL_FENCED/);
  await f.stores.privacy.redact(control,purge.purge_id);assert.equal((await f.stores.privacy.complete(control,purge.purge_id)).state,'COMPLETE');
  const rows=(await f.db.raw.execute("SELECT * FROM stage8_live_operation_receipts WHERE content_state='REDACTED'")).rows;assert.ok(rows.length>0);
  for(const row of rows)for(const key of ['request_json','result_json','related_results_json','required_roots_json','receipt_hmac'])assert.equal(row[key],null);
  assert.equal((await f.read()).status,'ANALYSIS_UPDATING');assert.equal((await f.db.raw.execute("SELECT pending_purge_count n FROM phase4_user_state WHERE user_id='b'")).rows[0].n,0);
 });
 f.disable();await assert.rejects(f.producer.run({userId:'a',requestId:'revoked-request'}),/CONFIGURATION_CHANGED|PRODUCING_AUTHORITY/);
 t.diagnostic(JSON.stringify({kind:'LIVE_PIPELINE_SYNTHETIC_RESOURCES',durationMs:performance.now()-started,before,after:process.memoryUsage(),maxRssKiB:process.resourceUsage().maxRSS}));
});

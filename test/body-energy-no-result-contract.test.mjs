/** Real isolated v34 calculation/source-unit path, synthetic inputs only.
 * Missing required data never becomes a provisional zero or numerical value. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {finalizedFixtureDrain} from './finalizedStage6Fixture.js';
import {authorizeBodyEnergyFixturePublication} from '../src/bodyEnergyQualificationAuthority.js';
import {createBodyEnergyIntegration} from '../src/bodyEnergyIntegration.js';
import {BODY_ENERGY_PROVISIONAL_POLICY as PROVISIONAL} from '../src/bodyEnergyProvisionalPolicy.js';
test('native incomplete→LIMITED no-result keeps honest quality, invalidates prepared state and does not opt-in alerts or defer Morning',async t=>{
 const now=()=>new Date(),f=await syntheticPhase4Fixture(t,{targetVersion:34,ownedConnection:true,now});
 const input=bodyInput({asOf:Date.now()-1000,days:27});input.sources.sleep[0].sleep_performance_percentage=null;
 input.sources.recovery[0].cycle_id=input.sources.cycle[0].id;input.sources.cycle[0].start_at=input.sources.sleep[0].start_at;input.sources.cycle[0].score_state='SCORED';
 await f.db.transaction(()=>seedBodyInput(f.db,input));await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'100001'});await f.db.setLocale('a','en');
 const grant=await authorizeBodyEnergyFixturePublication({db:f.db,userIds:['a'],presentationPolicy:PROVISIONAL.version}),ui=createBodyEnergyIntegration({db:f.db,stores:f.stores,keys:f.keys,publicationCapability:grant,now});
 await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
 const pending=await ui.query({text:'/energy',userId:'a',requestedAt:now()});assert.equal(pending.status,'PROCESSING');assert.doesNotMatch(pending.message,/\d+\/100/);assert.equal(await pending.verifyCurrent(),true);
 const worker=await createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now});
 let rows=[];
 for(let n=0;n<12&&!rows.length;n++){
  const result=await finalizedFixtureDrain(f.db,worker,{budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});assert.equal(result.failedJobs,0);
  rows=(await f.db.raw.execute("SELECT quality_state,value FROM body_energy_results WHERE user_id='a' AND invalidated_at IS NULL")).rows;
 }
 assert.equal(rows.length,1);assert.equal(rows[0].quality_state,'LIMITED');assert.equal(rows[0].value,null);
 const limited=await ui.query({text:'/energy',userId:'a',requestedAt:now()});assert.equal(limited.status,'LIMITED');assert.doesNotMatch(limited.message,/\d+\/100/);assert.match(limited.message,/required inputs are incomplete/);assert.equal(limited.replyGuard.publicationProof,null);assert.equal(limited.replyGuard.presentationPolicy,undefined);assert.equal(await limited.verifyCurrent(),true);
 await assert.rejects(pending.verifyCurrent(),/CURRENTNESS_FENCED/);
 assert.equal((await ui.notificationControl.read('a')).alertsEnabled,false);assert.deepEqual(await ui.beforeMorning({userId:'a'}),{action:'ORDINARY'});
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM briefing_evaluations WHERE report_type='daily_body_readiness'")).rows[0].n,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
 t.diagnostic('Synthetic missingness only: actual original calculation/source-unit receipt; unrelated analysis family completion and genuine publication qualification not claimed.');
});

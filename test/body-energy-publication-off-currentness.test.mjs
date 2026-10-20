import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {finalizedFixtureDrain} from './finalizedStage6Fixture.js';
import {authorizeBodyEnergyFixturePublication} from '../src/bodyEnergyQualificationAuthority.js';
import {createBodyEnergyIntegration} from '../src/bodyEnergyIntegration.js';
import {BODY_ENERGY_PROVISIONAL_POLICY as PROVISIONAL} from '../src/bodyEnergyProvisionalPolicy.js';
async function setup(t){
 const now=()=>new Date(),f=await syntheticPhase4Fixture(t,{targetVersion:34,ownedConnection:true,now});
 const input=bodyInput({asOf:Date.now()-1000,days:27});
 input.sources.recovery[0].cycle_id=input.sources.cycle[0].id;
 input.sources.cycle[0].start_at=input.sources.sleep[0].start_at;input.sources.cycle[0].score_state='SCORED';
 await f.db.transaction(()=>seedBodyInput(f.db,input));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'100001'});await f.db.setLocale('a','en');
 const worker=await createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now});
 await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
 for(let n=0;n<12&&(await worker.diagnostics()).pendingJobs;n++){
  const result=await finalizedFixtureDrain(f.db,worker,{budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});
  assert.equal(result.failedJobs,0);
 }
 // Other analysis families may remain pending. The positive query below must
 // independently verify the actual finalized Body source-unit receipt.
 t.diagnostic('Synthetic other-family pending jobs='+String((await worker.diagnostics()).pendingJobs)+'; no whole-generation completion claim.');
 const grant=await authorizeBodyEnergyFixturePublication({db:f.db,userIds:['a'],presentationPolicy:PROVISIONAL.version});
 return {...f,grant,now};
}
// Synthetic native SQLite + original Stage6 producer/receipt. No publication
// grant for a file/provider destination and no actual health/provider access.
test('ordinary prepared Body query loses publication authority when server configuration switches off',async t=>{
 const f=await setup(t);let enabled=true;
 const ui=createBodyEnergyIntegration({db:f.db,stores:f.stores,keys:f.keys,publicationCapability:f.grant,now:f.now,publicationEnabled:()=>enabled});
 const before=await ui.query({text:'/energy',userId:'a',requestedAt:f.now()});
 assert.equal(before.status,'PROVISIONAL');assert.match(before.message,/\d+\/100/);assert.equal(await before.verifyCurrent(),true);
 enabled=false;
 const after=await ui.query({text:'/energy',userId:'a',requestedAt:f.now()});
 assert.equal(after.status,'QUALIFICATION_PENDING');assert.doesNotMatch(after.message,/\d+\/100/);
 assert.deepEqual(await ui.beforeMorning(new Proxy({},{get(){throw Error('DISABLED_OPTIONAL_BODY_MUST_NOT_INSPECT');}})),{action:'ORDINARY'});
 await assert.rejects(before.verifyCurrent(),/CURRENTNESS_FENCED|PUBLICATION_NOT_QUALIFIED/);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
});

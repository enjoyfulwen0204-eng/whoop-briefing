import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,request,fixtureKeys,environment} from './v32ReviewFixture.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {runExecutionPhase} from '../src/phase4Execution.js';import {readExecution,reconcileExecution,readPhaseProgress} from '../src/phase4ExecutionStore.js';
async function runtime(db){const admission=await db.admitRuntime({fresh:true}),stores=await createPhase4Foundation({db,keys:fixtureKeys,admission});
 await db.createUser({id:'isolated',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});await stores.initializeTenant('isolated','SHADOW');
 for(let i=0;i<3;i++){const at=new Date(Date.now()-3600000).toISOString(),text=`caffeine at ${at}`;await stores.journal.create(await stores.captureControl('isolated'),{sourceEventKey:`fixture-${i}`,sourceText:text,
  candidate:{category:'caffeine',eventAt:at,valueKind:'PRESENCE',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:text.length}});}
 return {phase4Stage6:await createPhase4Stage6({db,keys:fixtureKeys,admission,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})})};
}
for(const skipMatches of [0,1])test(`real HTTP Stage6 checkpoint ${skipMatches+1} lost ACK is reconciliation-required, never calculation failure or PARTIAL success`,async t=>{
 const {db,transport}=await fixture(t),worker=await runtime(db),sync=request();
 const run=(r,deps)=>runExecutionPhase({db,request:r,keys:fixtureKeys,environment,env:{dryRun:true},deps});
 const s=await run(sync,{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'})});assert.equal(s.body.ok,true);
 const r=request({phase:'STAGE6_DRAIN',syncRequestId:sync.requestId,handoff:s.body.handoff});
 transport.arm({matchSql:/^UPDATE phase4_jobs SET full_scan_cursor=/i,skipMatches,loseAcknowledgement:true});
 const first=await run(r,{runtime:worker});assert.equal(first.status,503);assert.equal(first.body.result.outcome,'COMMIT_INDETERMINATE');assert.equal(first.body.ok,false);
 const rows=(await db.raw.execute('SELECT attempt,last_error_code,full_scan_cursor FROM phase4_jobs')).rows;
 assert.ok(rows.some(row=>row.full_scan_cursor));assert.ok(rows.every(row=>row.attempt===0&&row.last_error_code===null));
 const reconciled=await reconcileExecution(db,r);assert.equal(reconciled.state,'WORK_COMMITTED_UNFINALIZED');
 assert.notEqual((await readExecution(db,r.requestId)).state,'FINALIZED_FAILURE');
 assert.equal((await readPhaseProgress(db,'STAGE6_DRAIN','manual')).complete,null);
});

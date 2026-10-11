import {createReanalysisInputs} from '../src/phase4ReanalysisInputs.js';
import test from 'node:test';import assert from 'node:assert/strict';
import Database from 'libsql';import {createDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {buildPhase4Core} from '../src/phase4Core.js';import {composePhase4Stores} from '../src/phase4Repositories.js';
import {stage6CurrentCaptureTime} from '../src/stage6CurrentCaptureTime.js';
import {request,claim,authority} from './v32ReviewFixture.js';import {commitPhaseWork,finalizePhaseWork} from '../src/phase4ExecutionStore.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';

test('current capture requires a real active owner; future injected clock does not mint future captures, cancellation and foreign/expired owner fail closed',async t=>{
 const anchor=new Database('file::memory:?cache=shared'),db=createDb({url:'file::memory:?cache=shared',phase4Keys:fixtureKeys});t.after(()=>{db.close();anchor.close();});
 await db.migrate();await db.createUser({id:'a',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 const foundation=await createPhase4Foundation({db,keys:fixtureKeys,admission:await db.admitRuntime()});await foundation.initializeTenant('a','SHADOW');
 await db.transaction(()=>seedBodyInput(db,bodyInput({asOf:Date.now()-1000})));
 let futureClock=true;const core=await buildPhase4Core({processing:{client:db.raw,transaction:db.transaction,active:db.processingTransactionActive,
   afterCommit:db.afterProcessingCommit,afterCompletion:db.afterProcessingCompletion},keys:fixtureKeys,admission:await db.admitRuntime(),
   authorizeMode:mode=>assert.equal(mode,'SHADOW'),now:()=>new Date(Date.now()+(futureClock?30000:0))}),stores=composePhase4Stores(core);
 await stores.withContext('a',{executionMode:'SHADOW'},async context=>{
   const root=await stores.root(context,'recovery','sleep-00');await assert.rejects(stage6CurrentCaptureTime(core,context,'rhr',root),/OWNER_REQUIRED/);
   await assert.rejects(stores.bodyEnergy.computeForCurrentDrain(context),/CURRENT_DRAIN_REQUIRED/);
 });
 const sync=request(),sc=await claim(db,sync);await commitPhaseWork(db,sync,sc,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
 const done=await finalizePhaseWork(db,sync,sc,fixtureKeys,authority),drain=request({phase:'STAGE6_DRAIN',syncRequestId:sync.requestId,handoff:done.handoff}),dc=await claim(db,drain);
 const execute=(owner=dc,auth=authority,fn)=>withDurableExecution({claim:owner,keys:fixtureKeys,pending:new Set(),authority:auth},()=>stores.withContext('a',{executionMode:'SHADOW'},fn));
 await execute(dc,authority,async context=>{
   const root=await stores.root(context,'recovery','sleep-00'),clock=await stage6CurrentCaptureTime(core,context,'rhr',root);assert.ok(Date.parse(clock)<=Date.now());
   await assert.rejects(stores.bodyEnergy.computeForCurrentDrain(context),/CLOCK_FENCED/);
   assert.equal((await db.raw.execute('SELECT COUNT(*) n FROM body_energy_results')).rows[0].n,0);futureClock=false;
   const body=await stores.bodyEnergy.computeForCurrentDrain(context);assert.ok(body.row.as_of_epoch_ms<=Date.now());
   // The generic compute path retains its exact original manifest/receipt.
   const replay=await stores.bodyEnergy.computeForCurrentDrain(context);assert.equal(replay.row.result_id,body.row.result_id);assert.equal(replay.row.input_manifest_json,body.row.input_manifest_json);
   const captured=await stage6CurrentCaptureTime(core,context,'rhr',root),inputs=createReanalysisInputs(core,stores),req=await inputs.metric(context,'rhr',root,captured);
   await stores.intelligence.analyzeMetric(context,{...req,refresh:true});
   assert.equal(await stage6CurrentCaptureTime(core,context,'rhr',root),captured);
   const before=(await db.raw.execute("SELECT request_json FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows[0].request_json;
   await stores.intelligence.analyzeMetric(context,{...req,refresh:true});
   assert.equal((await db.raw.execute("SELECT request_json FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows[0].request_json,before);
 });
 await assert.rejects(execute({...dc,generation:dc.generation+1},authority,c=>stores.bodyEnergy.computeForCurrentDrain(c)),/OWNER_FENCED/);
 await assert.rejects(execute(dc,{assert(){throw Error('SYNTHETIC_CANCELLED');}},c=>stores.bodyEnergy.computeForCurrentDrain(c)),/SYNTHETIC_CANCELLED/);
 await db.raw.execute({sql:"UPDATE phase4_executions SET lease_until=0,deadline_at=0 WHERE execution_id=?",args:[dc.executionId]});
 await assert.rejects(execute(dc,authority,c=>stores.bodyEnergy.computeForCurrentDrain(c)),/OWNER_FENCED/);
});

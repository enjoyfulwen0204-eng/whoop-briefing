import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createOwnedDb} from './stage5OwnedDb.js';import {fixtureKeys} from './localDb.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {request,claim} from './v32ReviewFixture.js';import {commitPhaseWork,finalizePhaseWork} from '../src/phase4ExecutionStore.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';
export async function familyFixture(t,{positive=false,targetVersion=34}={}){
 const dir=await mkdtemp(join(tmpdir(),'stage6-family-no-result-')),url='file:'+join(dir,'fixture.sqlite');let db=createOwnedDb({url});
 t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});await db.migrate({targetVersion});
 await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});await db.ensureOnboarding('a',{state:'READY'});
 let stores;const refresh=async()=>{stores=await createPhase4Foundation({db,keys:fixtureKeys,admission:await db.admitRuntime()});};await refresh();await stores.initializeTenant('a','SHADOW');
 const input=bodyInput({asOf:Date.now()-3600000,days:positive?30:0});
 if(positive)for(let i=0;i<input.sources.recovery.length;i++)input.sources.recovery[i].recovery_score=i===0?15:40+(i%5)*5;
 await db.transaction(()=>seedBodyInput(db,input));await stores.queue.sourceChanged(await stores.captureControl('a'));
 const syncRequest=request(),syncOwner=await claim(db,syncRequest),authority={assert(){}};
 await commitPhaseWork(db,syncRequest,syncOwner,{outcome:'NO_NEW_DATA_SUCCESS'},authority);
 const sync=await finalizePhaseWork(db,syncRequest,syncOwner,fixtureKeys,authority);
 const jobs=async()=>(await db.raw.execute("SELECT * FROM phase4_jobs WHERE user_id='a' ORDER BY job_kind")).rows;
 async function leg(){
  const req=request({phase:'STAGE6_DRAIN',syncRequestId:syncRequest.requestId,handoff:sync.handoff}),owner=await claim(db,req),a={assert(){}};
  const worker=await createPhase4Stage6({db,keys:fixtureKeys,admission:await db.admitRuntime(),executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
  const result=await withDurableExecution({claim:owner,keys:fixtureKeys,pending:new Set(),authority:a},()=>worker.drain({triggerSource:'manual',userId:'a',budget:{maxItems:1,maxItemsPerTenant:1}}));
  await commitPhaseWork(db,req,owner,{outcome:result.outcome,itemsProcessed:result.processedItems,jobsCompleted:result.completedJobs,jobsFailed:result.failedJobs,unitsCommitted:result.unitsCommitted},a);
  await finalizePhaseWork(db,req,owner,fixtureKeys,a);return {req,owner,result};
 }
 return {get db(){return db;},keys:fixtureKeys,get stores(){return stores;},jobs,leg,async readMetric(req){const r=request({phase:'STAGE6_DRAIN',syncRequestId:syncRequest.requestId,handoff:sync.handoff}),owner=await claim(db,r);return withDurableExecution({claim:owner,keys:fixtureKeys,pending:new Set(),authority},async()=>stores.intelligence.resumeMetricPreparation(await stores.capture('a',{executionMode:'SHADOW'}),req));},async restart(){await db.close();db=createOwnedDb({url});await refresh();}};
}

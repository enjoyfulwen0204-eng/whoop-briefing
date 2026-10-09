import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
const root=new URL('../',import.meta.url).href;const {createDb}=await import(root+'src/db.js');const {createOwnedDb}=await import(root+'test/stage5OwnedDb.js');const {fixtureKeys}=await import(root+'test/localDb.js');const {hranaTransport}=await import(root+'test/hranaTransport.js');
const {runExecutionPhase}=await import(root+'src/phase4Execution.js');const {configurationProof,readExecution}=await import(root+'src/phase4ExecutionStore.js');const {publicBetaConfiguration}=await import(root+'src/publicBetaConfig.js');const {runningReleaseSha}=await import(root+'src/phase4Release.js');
const {withSyncOwnership}=await import(root+'src/syncOwnership.js');const {currentExecutionBudget}=await import(root+'src/executionBudget.js');
test('same identity remains resumable across timeout and tenant lease grace; old owner is fenced',async t=>{
 const dir=await mkdtemp('/private/tmp/rc4-resume-'),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});await seed.migrate({targetVersion:32});
 const ids=['alice','bob','lan'];for(const id of ids)await seed.createUser({id,displayName:'Before',status:'ACTIVE',timezone:'Asia/Taipei'});await seed.close();
 const transport=hranaTransport(url),db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:transport.fetch});t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'},request={releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)};
 let shouldDelay=true,heavy=0;const errors=[];
 const deps={runBriefing:async()=>{
  const work=await Promise.all(ids.map(async id=>{try{return await withSyncOwnership({db,userId:id,budget:currentExecutionBudget()},async()=>{
   heavy++;await db.updateUser(id,{displayName:'Committed progress'});if(shouldDelay)await new Promise(r=>setTimeout(r,2200));return true;
  });}catch(e){errors.push(e.code);return false;}}));
  return {syncComplete:work.every(Boolean),syncOutcome:work.every(Boolean)?'COMPLETE_SUCCESS':'PARTIAL',users:3,failed:work.filter(x=>!x).length};
 }};
 const run=r=>runExecutionPhase({request:r,db,keys:fixtureKeys,environment,env:{timezone:'Asia/Taipei',dryRun:true},budgetMs:1200,deps});
 const first=await run(request);assert.equal(first.status,202,JSON.stringify(first));assert.equal(first.body.result.resumable,true);
 const leases=(await db.raw.execute("SELECT name,expires_at FROM resource_locks WHERE name LIKE 'phase4:sync:%'")).rows;
 assert.equal(leases.length,3);assert.ok(leases.every(r=>Date.parse(r.expires_at)>Date.now()));
 shouldDelay=false;const second=await run(request);assert.equal(second.status,202,JSON.stringify(second));assert.equal(second.body.result.resumable,true);assert.notEqual((await readExecution(db,request.requestId)).state,'FINALIZED_FAILURE');assert.ok(errors.filter(x=>x==='SYNC_SCOPE_BUSY').length===3);
 await db.raw.execute("UPDATE resource_locks SET expires_at='2000-01-01T00:00:00Z' WHERE name='phase4:sync:alice'");
 const mixed=await run(request);assert.equal(mixed.status,202);assert.notEqual((await readExecution(db,request.requestId)).state,'FINALIZED_FAILURE');
 await db.raw.execute("UPDATE resource_locks SET expires_at='2000-01-01T00:00:00Z' WHERE name LIKE 'phase4:sync:%'");
 const before=heavy;const completed=await run(request);assert.equal(completed.status,200,JSON.stringify(completed));assert.ok(heavy>before);assert.deepEqual(await run(request),completed);
 await assert.rejects(()=>run({...request,configProof:'0'.repeat(64)}),/EXECUTION_CONFIG_CHANGED/);
 const fresh=await run({...request,requestId:randomUUID()});assert.equal(fresh.status,200,JSON.stringify(fresh));
 console.log('REVIEW_FINDING '+JSON.stringify({kind:'TIMEOUT_RESUMPTION_LEASE_POISON',first:first.status,activeTenantLeases:leases.length,retry:second.status,failed:second.body.result.failed,terminal:second.body.result.settlementState,afterLeaseExpiryReplay:second.status,freshIdentity:fresh.status,errors}));
});

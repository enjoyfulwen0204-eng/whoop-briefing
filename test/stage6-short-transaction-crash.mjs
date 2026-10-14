import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
import {writeFile,readFile,mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {residualFixture,fixtureKeys} from './stage6JournalBoundaryFixture.js';import {syncFor,leg} from './stage6ShortTransactionHarness.mjs';import {request,claim} from './v32ReviewFixture.js';
import {commitPhaseWork,finalizePhaseWork,reconcileExecution} from '../src/phase4ExecutionStore.js';
import {verifyShortProof} from './stage6ShortProof.mjs';import {isolatedPublicationClient} from './stage6ShortTransactionPrototype.mjs';
for(const point of ['before-publication','after-durable-commit'])test('real SIGKILL '+point+' preserves original receipt/cursor replay',async t=>{
 const f=await residualFixture(t),sync=await syncFor(f);
 for(let n=0;n<60;n++){const r=await leg(f,sync,{prepare:false});assert.equal(r.result.failedJobs,0);if((await f.jobs()).every(j=>j.full_scan_cursor===JSON.stringify(['USER','a']))&&Number((await f.db.raw.execute("SELECT count(*) n FROM phase4_evidence_result_authorities WHERE result_scope='METRIC'")).rows[0].n)>1)break;}
 const req=request({phase:'STAGE6_DRAIN',syncRequestId:sync.req.requestId,handoff:sync.result.handoff}),owner=await claim(f.db,req,{leaseMs:60000,deadlineAt:Date.now()+45000}),dir=await mkdtemp(join(tmpdir(),'stage6-crash-control-')),input=join(dir,'input.json'),marker=join(dir,'ack.json');t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(input,JSON.stringify({synthetic:true,url:f.isolatedFileUrl,owner,marker,point}));
 const child=spawn(process.execPath,['--import','./test/stage6ArchitectureIsolatedProfile.js','test/stage6-short-crash-child.mjs',input],{cwd:new URL('../',import.meta.url),env:{...process.env,STAGE6_ISOLATED_PROTOTYPE:'prefix-terminal',NODE_TEST_CONTEXT:'child-v8'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
 const exit=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));assert.equal(exit.signal,'SIGKILL',output);const evidence=JSON.parse(await readFile(marker,'utf8'));await f.fresh();
 const reconciled=await reconcileExecution(f.db,req);let proof;
 if(point==='after-durable-commit'){
  assert.equal(reconciled.state,'WORK_COMMITTED_UNFINALIZED');assert.equal((await f.counts()).domain,2);const a={assert(){}};await commitPhaseWork(f.db,req,owner,{outcome:evidence.result.outcome,itemsProcessed:evidence.result.processedItems,jobsCompleted:evidence.result.completedJobs,jobsFailed:evidence.result.failedJobs,unitsCommitted:evidence.result.unitsCommitted},a);await finalizePhaseWork(f.db,req,owner,fixtureKeys,a);proof=await verifyShortProof(f,{domainOnly:true});
 }else{assert.equal(reconciled.state,'NOT_COMMITTED');assert.equal((await f.counts()).domain,1);}
 const leaseName=`p4ctx:${fixtureKeys.lookup(['context-tenant-v1','a'])}:short:${owner.executionId}`;await f.db.raw.execute({sql:'DELETE FROM resource_locks WHERE name=?',args:[leaseName]});
 await f.toHttp();f.setLatency(115);f.transport.setTransactionMaxMs(5000);const client=isolatedPublicationClient(f.syntheticFetch);t.after(()=>client.close());
 const result=await leg(f,sync,{client});assert.ok(result.result.processedItems||result.result.unitsCommitted);f.setLatency(0);
 if(point==='after-durable-commit'){assert.equal((await f.counts()).domain,2);assert.equal(result.result.processedItems,1);}else{assert.equal((await f.counts()).domain,2);proof=await verifyShortProof(f,{domainOnly:true});}
 console.log('SHORT_CRASH_PROOF '+JSON.stringify({point,actualSignal:exit.signal,reconciledState:reconciled.state,domainRows:2,restartWorkMs:result.workMs,transactionMs:result.transactionMs,proof,production:false}));
});

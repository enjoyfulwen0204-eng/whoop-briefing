import {stage6CapacityStatus} from '../src/stage6CapacityRuntime.js';
import {verifyShortProof} from './stage6ShortProof.mjs';
import {reconcileExecution} from '../src/phase4ExecutionStore.js';
import {ExecutionBudgetError} from '../src/executionBudget.js';
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {randomUUID} from 'node:crypto';
import {createOwnedDb} from './stage5OwnedDb.js';import {fixtureKeys} from './localDb.js';import {createDb} from '../src/db.js';import {hranaTransport} from './hranaTransport.js';
import {runExecutionPhase} from '../src/phase4Execution.js';import {configurationProof} from '../src/phase4ExecutionStore.js';import {runningReleaseSha} from '../src/phase4Release.js';import {publicBetaConfiguration} from '../src/publicBetaConfig.js';import {OWNER_PILOT_APPROVAL_SHA256} from '../src/betaPilotAllowance.js';import {receiverScopeStatistics} from '../src/receiverScopeLifetime.js';
test('actual phase composition uses branded monitored grant and publishes retained source progress',{skip:stage6CapacityStatus().heapLimit>192*1024*1024?'explicit bounded V8 memory qualification only':false},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'whoop-stage6-runtime-')),path=join(dir,'fixture.sqlite'),url='file:'+path;
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const completed=process.env.STAGE6_RUNTIME_COMPLETED==='1',checkpoint=completed?'/private/tmp/stage6-late-six-complete1/checkpoint.sqlite':'/private/tmp/stage6-late-78/checkpoint.sqlite';
 const cp=spawnSync('python3',['-c',"import sqlite3,sys;a=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro&immutable=1',uri=True);b=sqlite3.connect(sys.argv[2]);a.backup(b);b.close();a.close()",checkpoint,path],{encoding:'utf8'});assert.equal(cp.status,0,cp.stderr);
 const seed=createOwnedDb({url});assert.deepEqual((await seed.raw.execute('SELECT id,display_name FROM users')).rows.map(r=>[r.id,r.display_name]),[['a','Synthetic']]);await seed.close();
 const transport=hranaTransport(url,{transactionMaxMs:5000});t.after(()=>transport.close());let latency=115;
 const fault=process.env.STAGE6_RUNTIME_FAULT,controller=new AbortController();assert.ok(fault===undefined||['ACK_LOSS','CANCEL','CANCEL_RAM','SIGKILL_AFTER'].includes(fault));let armedCancellation=false,dataDelivered=false;
 const fetch=async r=>{let data=false;if(['CANCEL','CANCEL_RAM'].includes(fault)&&armedCancellation){const payload=JSON.stringify(await r.clone().json());data=payload.includes('PREPARATION_FRESH_PAGE_BOUNDS');if(fault==='CANCEL'&&data||fault==='CANCEL_RAM'&&dataDelivered&&payload.includes('SELECT * FROM phase4_executions WHERE execution_id=?')){armedCancellation=false;controller.abort(new ExecutionBudgetError('SYNC_CANCELLED'));throw controller.signal.reason;}}await new Promise(ok=>setTimeout(ok,latency));const result=await transport.fetch(r);if(data)dataDelivered=true;return result;};let db=createDb({url:'https://isolated.invalid',fetch,phase4Keys:fixtureKeys});t.after(()=>db.close());
 const env={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'a',PHASE4_BETA_PILOT_START_AT:new Date(Date.now()-1000).toISOString(),PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256};
 const request=(phase,extra={})=>({requestId:randomUUID(),releaseSha:runningReleaseSha(env),phase,triggerSource:'manual',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(env),env,runningReleaseSha(env)),...extra});
 const options={db,keys:fixtureKeys,environment:env,signal:controller.signal,env:{timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1,telegramBotToken:'SYNTHETIC',telegramChatId:'SYNTHETIC'}};
 const syncReq=request('SYNC'),sync=await runExecutionPhase({...options,request:syncReq,deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0})}});assert.equal(sync.body.drainAuthorized,true);
 const req=request('STAGE6_DRAIN',{syncRequestId:syncReq.requestId,handoff:sync.body.handoff}),before=structuredClone(transport.counts),at=performance.now();
 if(fault==='ACK_LOSS')transport.arm({matchSql:/UPDATE phase4_jobs SET full_scan_cursor=/,loseAcknowledgement:true});if(['CANCEL','CANCEL_RAM'].includes(fault))armedCancellation=true;
 if(fault==='SIGKILL_AFTER'){const marker=process.env.STAGE6_RUNTIME_MARKER;assert.match(marker,/^\/private\/tmp\/whoop-stage6-runtime-crash-[^/]+\/marker.json$/);transport.arm({matchSql:/UPDATE phase4_jobs SET full_scan_cursor=/,after:async()=>{await writeFile(marker,JSON.stringify({synthetic:true,path,url,req,env}));process.kill(process.pid,'SIGKILL');}});}
 const result=await runExecutionPhase({...options,request:req});console.log('RUNTIME_TARGET '+JSON.stringify({result,elapsedMs:performance.now()-at,counts:Object.fromEntries(Object.keys(before).map(k=>[k,transport.counts[k]-before[k]])),scopes:receiverScopeStatistics(),capacity:stage6CapacityStatus(),rejections:transport.evidence}));
 latency=0;console.log('RUNTIME_TARGET_JOBS '+JSON.stringify((await db.raw.execute("SELECT job_kind,state,requested_generation,completed_generation,full_scan_cursor FROM phase4_jobs")).rows));
 if(fault){
  assert.equal(stage6CapacityStatus().active,false);
  if(['CANCEL','CANCEL_RAM'].includes(fault)){assert.equal(result.body.result.outcome,'CANCELLED');assert.equal((await db.raw.execute("SELECT count(*) n FROM phase4_operation_receipts")).rows[0].n,18);assert.ok((await db.raw.execute('SELECT full_scan_cursor FROM phase4_jobs')).rows.every(r=>r.full_scan_cursor===JSON.stringify(['recovery','synthetic-old-recovery'])));if(fault==='CANCEL_RAM'){assert.equal(dataDelivered,true);assert.equal(receiverScopeStatistics().retired,2);}}
  else{assert.equal(result.body.result.outcome,'COMMIT_INDETERMINATE');const state=await reconcileExecution(db,req);console.log('RUNTIME_ACK_RECONCILIATION '+JSON.stringify({state:state.state,receiptCount:state.receipts?.length}));assert.equal(state.state,'WORK_COMMITTED_UNFINALIZED');assert.ok(state.receipts.length>0);
   await db.close();db=createDb({url:'https://isolated.invalid',fetch,phase4Keys:fixtureKeys});options.db=db;const deadline=(await db.raw.execute({sql:'SELECT deadline_at FROM phase4_executions WHERE execution_id=?',args:[req.requestId]})).rows[0].deadline_at;while(Date.now()<=deadline)await new Promise(r=>setTimeout(r,Math.min(30000,deadline-Date.now()+50)));const recovered=await runExecutionPhase({...options,request:req});console.log('RUNTIME_ACK_RECOVERY '+JSON.stringify(recovered));assert.equal(recovered.body.result.settlementState,'FINALIZED_SUCCESS');const f={get db(){return db;},fresh:async()=>{await db.close();db=createDb({url:'https://isolated.invalid',fetch,phase4Keys:fixtureKeys});}};console.log('RUNTIME_ACK_PROOF '+JSON.stringify(await verifyShortProof(f,{domainOnly:true})));
  }
  console.log('RUNTIME_FAULT_PROOF '+JSON.stringify({fault,outcome:result.body.result.outcome,scopes:receiverScopeStatistics()}));return;
 }
 assert.equal(result.body.ok,true);assert.ok(result.body.result.itemsProcessed||result.body.result.unitsCommitted||result.body.result.jobsCompleted||completed&&result.body.result.outcome==='NO_WORK');
 const replay=await runExecutionPhase({...options,request:req});assert.deepEqual(replay,result);
 const fresh=async()=>{await db.close();db=createDb({url:'https://isolated.invalid',fetch,phase4Keys:fixtureKeys});options.db=db;};
 const f={get db(){return db;},fresh};console.log('RUNTIME_RESTART_PROOF '+JSON.stringify(await verifyShortProof(f,{domainOnly:true})));
 assert.deepEqual(await runExecutionPhase({...options,request:req}),result);
 const legs=Number(process.env.STAGE6_RUNTIME_LEGS??2);assert.ok(legs>=2&&legs<=12);
 for(let n=2;n<=legs;n++){
  latency=115;const next=request('STAGE6_DRAIN',{syncRequestId:syncReq.requestId,handoff:sync.body.handoff}),at=performance.now(),before=structuredClone(transport.counts),continued=await runExecutionPhase({...options,request:next});
  console.log('RUNTIME_CONTINUATION '+JSON.stringify({attempt:n,result:continued,elapsedMs:performance.now()-at,http:transport.counts.httpRequests-before.httpRequests,sql:transport.counts.sqlStatements-before.sqlStatements,capacity:stage6CapacityStatus()}));assert.equal(continued.body.ok,true);
  latency=0;await fresh();console.log('RUNTIME_RESTART_PROOF '+JSON.stringify(await verifyShortProof(f,{domainOnly:true})));assert.deepEqual(await runExecutionPhase({...options,request:next}),continued);
 }
});

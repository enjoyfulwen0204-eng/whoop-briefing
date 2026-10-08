import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,request,claim,authority,fixtureKeys} from './v32ReviewFixture.js';
import {readExecution,commitPhaseWork,finalizePhaseWork,abortPhaseExecution,reconcileExecution,readPhaseProgress} from '../src/phase4ExecutionStore.js';
const states=['ESTABLISHED','WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE','ABORTED'];
const legal={ESTABLISHED:['ESTABLISHED','WORK_COMMITTED','ABORTED'],WORK_COMMITTED:['WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE']};
test('SQL exhaustive 25-pair execution transition matrix; terminal owners/generations cannot be replaced',async t=>{
 const {db}=await fixture(t);
 for(const from of states)for(const to of states){
  const r=request(),c=await claim(db,r);
  if(from==='ABORTED')await abortPhaseExecution(db,c);
  if(['WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE'].includes(from))await commitPhaseWork(db,r,c,{outcome:from==='FINALIZED_FAILURE'?'FAILED':'NO_NEW_DATA_SUCCESS'},authority);
  if(from.startsWith('FINALIZED'))await finalizePhaseWork(db,r,c,fixtureKeys,authority);
  const row=await readExecution(db,r.requestId);
  const result=row.result_json??JSON.stringify({version:2,releaseSha:r.releaseSha,phase:r.phase,source:r.triggerSource,outcome:'NO_NEW_DATA_SUCCESS',identity:c.identity,configProof:r.configProof,executionMode:r.executionMode});
  const hasWork=['WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE'].includes(to),isFinal=to.startsWith('FINALIZED');
  const sql={sql:'UPDATE phase4_executions SET state=?,result_json=?,result_digest=?,work_committed_at=?,finalized_at=? WHERE execution_id=?',args:[to,hasWork?result:null,hasWork?(row.result_digest??'a'.repeat(64)):null,hasWork?(row.work_committed_at??Date.now()):null,isFinal?Date.now():null,r.requestId]};
  if(legal[from]?.includes(to))await db.raw.execute(sql);else await assert.rejects(()=>db.raw.execute(sql),undefined,`${from} -> ${to}`);
  if(!legal[from])await assert.rejects(()=>db.raw.execute({sql:'UPDATE phase4_executions SET owner=?,generation=generation+1 WHERE execution_id=?',args:['replacement',r.requestId]}));
  console.log(JSON.stringify({transition:{from,to,legal:!!legal[from]?.includes(to)}}));
 }
});
test('INSERT/IGNORE/REPLACE/UPSERT/DELETE cannot reset active or terminal authority, or its ordinal',async t=>{
 const {db}=await fixture(t);
 await db.raw.execute('PRAGMA recursive_triggers=OFF');
 for(const state of states){const r=request(),c=await claim(db,r);
  if(state==='ABORTED')await abortPhaseExecution(db,c);
  else if(state!=='ESTABLISHED'){await commitPhaseWork(db,r,c,{outcome:state==='FINALIZED_FAILURE'?'FAILED':'NO_NEW_DATA_SUCCESS'},authority);if(state.startsWith('FINALIZED'))await finalizePhaseWork(db,r,c,fixtureKeys,authority);}
  const before=await readExecution(db,r.requestId),copy={...before,state:'ESTABLISHED',owner:'attack',generation:1,result_json:null,result_digest:null,work_committed_at:null,finalized_at:null,abort_outcome:null,observed_outcome:'IN_PROGRESS'};
  delete copy.execution_seq;const cols=Object.keys(copy),args=cols.map(k=>copy[k]);
  for(const verb of ['INSERT','INSERT OR IGNORE','INSERT OR REPLACE'])await assert.rejects(()=>db.raw.execute({sql:`${verb} INTO phase4_executions(${cols}) VALUES(${cols.map(()=>'?')})`,args}));
  await assert.rejects(()=>db.raw.execute({sql:`INSERT INTO phase4_executions(${cols}) VALUES(${cols.map(()=>'?')}) ON CONFLICT(execution_id) DO UPDATE SET state='ESTABLISHED',generation=1,owner='attack'`,args}));
  await assert.rejects(()=>db.raw.execute({sql:'DELETE FROM phase4_executions WHERE execution_id=?',args:[r.requestId]}));
  await assert.rejects(()=>db.raw.execute({sql:'UPDATE phase4_executions SET execution_seq=execution_seq+100 WHERE execution_id=?',args:[r.requestId]}));
  assert.deepEqual(await readExecution(db,r.requestId),before);
 }
});
test('all immutable helper mismatches reject before write; valid retry remains healthy after every rejection',async t=>{
 const {db}=await fixture(t);
 const mutations=[r=>({...r,releaseSha:'b'.repeat(40)}),r=>({...r,phase:'STAGE6_DRAIN'}),r=>({...r,triggerSource:'github'}),r=>({...r,executionMode:'OFF'}),r=>({...r,configProof:'b'.repeat(64)}),r=>({...r,requestId:'different'}),r=>({...r,legacyBodyDigest:'b'.repeat(64)})];
 for(const mutate of mutations){const r=request(),c=await claim(db,r),before=await readExecution(db,r.requestId);
  await assert.rejects(()=>commitPhaseWork(db,mutate(r),c,{outcome:'NO_NEW_DATA_SUCCESS'},authority));assert.deepEqual(await readExecution(db,r.requestId),before);
  await commitPhaseWork(db,r,c,{outcome:'NO_NEW_DATA_SUCCESS'},authority);assert.equal((await finalizePhaseWork(db,r,c,fixtureKeys,authority)).settlementState,'FINALIZED_SUCCESS');}
 for(const patch of [{scopeKey:'b'.repeat(64)},{identity:'b'.repeat(64)},{generation:99},{owner:'stale'}]){const r=request(),c=await claim(db,r),before=await readExecution(db,r.requestId);
  await assert.rejects(()=>commitPhaseWork(db,r,{...c,...patch},{outcome:'NO_NEW_DATA_SUCCESS'},authority));assert.deepEqual(await readExecution(db,r.requestId),before);
  await commitPhaseWork(db,r,c,{outcome:'NO_NEW_DATA_SUCCESS'},authority);await finalizePhaseWork(db,r,c,fixtureKeys,authority);}
 const sync=request(),sc=await claim(db,sync);await commitPhaseWork(db,sync,sc,{outcome:'NO_NEW_DATA_SUCCESS'},authority);const completed=await finalizePhaseWork(db,sync,sc,fixtureKeys,authority);
 const drain=request({phase:'STAGE6_DRAIN',syncRequestId:sync.requestId,handoff:completed.handoff}),dc=await claim(db,drain),before=await readExecution(db,drain.requestId);
 await assert.rejects(()=>commitPhaseWork(db,{...drain,handoff:'b'.repeat(64)},dc,{outcome:'NO_WORK'},authority));assert.deepEqual(await readExecution(db,drain.requestId),before);
 await commitPhaseWork(db,drain,dc,{outcome:'NO_WORK'},authority);await finalizePhaseWork(db,drain,dc,fixtureKeys,authority);
});
test('canonical reconciliation distinguishes absent/established/work/final-success/final-failure/abort and rejects mismatch',async t=>{
 const {db}=await fixture(t),absent=request();assert.equal((await reconcileExecution(db,absent)).state,'NOT_COMMITTED');
 for(const state of states){const r=request(),c=await claim(db,r);
  if(state==='ABORTED')await abortPhaseExecution(db,c);
  else if(state!=='ESTABLISHED'){await commitPhaseWork(db,r,c,{outcome:state==='FINALIZED_FAILURE'?'FAILED':'NO_NEW_DATA_SUCCESS'},authority);if(state.startsWith('FINALIZED'))await finalizePhaseWork(db,r,c,fixtureKeys,authority);}
  assert.equal((await reconcileExecution(db,r)).state,state==='ESTABLISHED'?'NOT_COMMITTED':state==='WORK_COMMITTED'?'WORK_COMMITTED_UNFINALIZED':state);
  await assert.rejects(()=>reconcileExecution(db,{...r,releaseSha:'b'.repeat(40)}));
  if(state==='ABORTED')await assert.rejects(()=>claim(db,r),/ABORTED_RETRY_REQUIRES_NEW_ID/);
 }
});
test('global durable ordinal increases strictly, survives late finalization, and isolates phase/source diagnostics',async t=>{
 const {db}=await fixture(t),rows=[];
 for(const source of ['manual','github','manual']){const r=request({triggerSource:source}),c=await claim(db,r);rows.push({r,c,row:await readExecution(db,r.requestId)});}
 assert.ok(rows.every((value,i)=>!i||value.row.execution_seq>rows[i-1].row.execution_seq));
 await commitPhaseWork(db,rows[0].r,rows[0].c,{outcome:'NO_NEW_DATA_SUCCESS'},authority);await finalizePhaseWork(db,rows[0].r,rows[0].c,fixtureKeys,authority);
 assert.equal((await readPhaseProgress(db,'SYNC','manual')).execution.execution_id,rows[2].r.requestId);
 assert.equal((await readPhaseProgress(db,'SYNC','github')).execution.execution_id,rows[1].r.requestId);
});

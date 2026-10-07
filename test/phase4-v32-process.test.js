import test from 'node:test';import assert from 'node:assert/strict';import {fork} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {createDb} from '../src/db.js';import {createOwnedDb} from './stage5OwnedDb.js';import {fixtureKeys} from './localDb.js';import {hranaTransport} from './hranaTransport.js';
import {claimPhaseRequest,readExecution,settlePhaseRequest,configurationProof} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';import {createExecutionBudget} from '../src/executionBudget.js';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'p4-v32-process-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});await seed.close();const transport=hranaTransport(url),db=createDb({url:'https://isolated.invalid',fetch:transport.fetch,phase4Keys:fixtureKeys});
 t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});await db.admitRuntime();return {db,url};}
function child(t,url,request,variant){const process=fork(new URL('./v32SettlementChild.js',import.meta.url),[url,JSON.stringify(request),variant],{execArgv:['--expose-gc'],silent:true});
 const messages=[],waiters=[],chunks=[];let done;
 process.stdout.on('data',c=>chunks.push(c));process.stderr.on('data',c=>chunks.push(c));
 process.on('message',m=>{messages.push(m);for(const waiter of waiters)waiter();});
 const exited=new Promise(resolve=>process.on('close',(code,signal)=>{done={code,signal};for(const waiter of waiters)waiter();resolve(done);}));
 t.after(()=>{if(!done)process.kill('SIGKILL');});
 const wait=event=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('PROCESS_BARRIER_TIMEOUT')),30000);
  const check=()=>{const m=messages.find(m=>m.event===event),error=messages.find(m=>m.event==='error');if(m||error||done){clearTimeout(timer);m?resolve(m):reject(Error(JSON.stringify(error??done)+Buffer.concat(chunks).toString()));}};waiters.push(check);check();});
 return {process,wait,exited};}
const request=()=>{const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off'};return {requestId:randomUUID(),phase:'SYNC',releaseSha:runningReleaseSha(),triggerSource:'manual',executionMode:'SHADOW',
 configProof:configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment)};};
for(const variant of ['takeover','after-commit','before-commit'])test(`v32 two real OS processes: ${variant}, reconcile durable truth and reject stale finalization`,async t=>{
 const {db,url}=await fixture(t),value=request(),other=child(t,url,value,variant);
 await other.wait(variant==='after-commit'?'committed_ack_pending':'commit_pending');
 if(variant==='takeover'){other.process.send('resume');await other.wait('work_committed');}
 else {other.process.kill('SIGKILL');assert.equal((await other.exited).signal,'SIGKILL');}
 const row=await readExecution(db,value.requestId);assert.equal(row.state,variant==='before-commit'?'ESTABLISHED':'WORK_COMMITTED');
 if(variant==='before-commit'){const cutoff=Date.now()-1;await db.raw.execute({sql:'UPDATE phase4_executions SET lease_until=?,deadline_at=? WHERE execution_id=?',args:[cutoff,cutoff,value.requestId]});}
 const claim=await claimPhaseRequest(db,value,JSON.stringify(value),{keys:fixtureKeys});assert.equal(claim.generation,2);
 const authority=createExecutionBudget();let first;try{first=await settlePhaseRequest(db,value,claim,{outcome:'NO_NEW_DATA_SUCCESS'},fixtureKeys,authority);}finally{authority.close();}
 assert.equal(first.settlementState,'FINALIZED_SUCCESS');const cached=await claimPhaseRequest(db,value,JSON.stringify(value),{keys:fixtureKeys});assert.deepEqual(cached.cached,first);
 if(variant==='takeover'){other.process.send('finalize');assert.equal((await other.wait('fenced')).code,'REQUEST_OWNER_FENCED');assert.equal((await other.exited).code,0);}
 assert.equal((await readExecution(db,value.requestId)).generation,2);
 console.log(JSON.stringify({measurement:'v32_process_reconciliation',variant,generation:2,finalized:true}));
});

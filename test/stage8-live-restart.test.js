import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createOwnedFileDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';import {createStage8DerivedReader} from '../src/stage8DerivedReader.js';
for(const action of ['crash','lost-ack'])test(`actual process restart after ${action} keeps original COMMIT evidence and recomputes before CURRENT`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'stage8-live-crash-')),filename=join(dir,'synthetic.db');let db=createOwnedFileDb({url:'file:'+filename,phase4Keys:fixtureKeys});t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
 await db.migrate({targetVersion:35});await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});await db.ensureOnboarding('a',{state:'READY'});await db.transaction(()=>seedBodyInput(db,bodyInput({asOf:Date.now()-1000,days:7})));db.close();
 const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['test/stage8LiveCrashChild.js',filename,action],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal,output}));});
 assert.equal(result.signal,null,result.output);assert.equal(result.code,action==='crash'?99:98,result.output);if(action==='lost-ack')assert.match(result.output,/COMMIT_INDETERMINATE/);
 db=createOwnedFileDb({url:'file:'+filename,phase4Keys:fixtureKeys});const admission=await db.admitRuntime();
 assert.equal((await db.raw.execute('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,0);
 const before=(await db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n;assert.ok(before>0);assert.equal((await db.raw.execute("SELECT count(*) n FROM body_energy_results WHERE execution_mode='LIVE'")).rows[0].n,1);
 const producer=await createStage8LiveProducer({db,keys:fixtureKeys,admission,userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 await assert.rejects(producer.run({userId:'a',requestId:'child-original-request'}),/REQUEST_PENDING/);
 // Deterministic expiration of coordination only; never edit created_at,
 // health output, source generation, completion rows or signed receipts.
 await db.raw.execute({sql:'UPDATE stage8_live_executions SET deadline_at=?,lease_until=?',args:[Date.now()-2,Date.now()-1]});
 const recovered=await producer.run({userId:'a',requestId:'child-original-request'});assert.equal(recovered.recovered,true);assert.equal(recovered.result.outcome,'PARTIAL');assert.equal(recovered.publication.status,'ANALYSIS_UPDATING');
 assert.equal((await db.raw.execute('SELECT count(*) n FROM stage8_live_execution_work_receipts')).rows[0].n,before);
 await db.raw.execute("UPDATE resource_locks SET expires_at='2000-01-01T00:00:00.000Z'");
 const source=(await db.raw.execute("SELECT source_generation n FROM phase4_user_state WHERE user_id='a'")).rows[0].n;
 let last;for(let i=0;i<30;i++){last=await producer.run({userId:'a',requestId:`restart-fresh-${i}`});if(last.publication.status==='CURRENT')break;}
 assert.equal(last.publication.status,'CURRENT');assert.equal((await db.raw.execute("SELECT source_generation n FROM phase4_user_state WHERE user_id='a'")).rows[0].n,source);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM body_energy_results WHERE execution_mode='LIVE'")).rows[0].n,2);
 const read=createStage8DerivedReader({db,keys:fixtureKeys,admission:await db.admitRuntime(),eligible:id=>id==='a'}),scope={permitted:true,purpose:'SELF_QA',executionMode:'LIVE',userId:'a',asOfUtc:new Date().toISOString()};
 assert.equal((await read({scope,kind:'BODY_ENERGY',inputGeneration:last.publication.inputGeneration})).status,'CURRENT');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';

for(const fault of ['REDACTED_RESULT','REVOKED_OWNER'])test('raw metric readonly scheduling retains original boundary: '+fault,async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:0})));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 const p=await createStage8LiveProducer({...f,admission:await f.db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 const prefix=await p.run({userId:'a',requestId:'raw-read-boundary-original-prefix'});
 assert.notEqual(prefix.publication.status,'CURRENT');assert.ok(prefix.result.unitsCommitted>0);
 const before=(await f.db.raw.execute('SELECT * FROM stage8_live_execution_work_receipts ORDER BY 1,2')).rows;
 const original=f.db.raw.execute;let injected=false;
 f.db.raw.execute=async stmt=>{
  const sql=typeof stmt==='string'?stmt:stmt.sql,result=await original(stmt);
  if(injected&&fault==='REVOKED_OWNER'
    &&(/^SELECT \* FROM stage8_live_executions WHERE execution_id=\? AND owner=\? AND generation=\?/.test(sql)
      ||/FROM stage8_live_executions e LEFT JOIN stage8_live_execution_work_receipts/.test(sql)))
   return {...result,rows:[]};
  // The real factory has already produced the signed raw metric DOMAIN.
  // Corrupt only the later exact typed row observation, never seed a result,
  // cursor, receipt, completion, authority token or replacement worker.
  if(/^SELECT \* FROM evidence_runs WHERE user_id=\? AND execution_mode=\?\s+AND run_id=\?/.test(sql)
    &&result.rows[0]?.subject_key==='cycle_strain'){
   injected=true;
   if(fault==='REDACTED_RESULT')return {...result,rows:result.rows.map(r=>({...r,health_content_redacted_at:new Date().toISOString()}))};
   // Every subsequent fresh owner observation sees revocation. The injected
   // transport never issues an otherwise unauthorized control-table write.
  }
  return result;
 };
 let value,error;
 try{value=await p.run({userId:'a',requestId:'raw-read-boundary-fresh-attempt'});}catch(e){error=e;}finally{f.db.raw.execute=original;}
 assert.equal(injected,true,'actual signed cycle metric typed replay must be reached');
 if(error)assert.match(String(error.code??error.message),/CONTENT_REDACTED|OWNER_FENCED|STAGE8_LIVE|METRIC_PREPARATION_CAPTURE_REQUIRED/);
 else{assert.ok(value.result.jobsFailed>0);assert.notEqual(value.publication.status,'CURRENT');}
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,0);
 const after=new Set((await f.db.raw.execute('SELECT * FROM stage8_live_execution_work_receipts')).rows.map(r=>JSON.stringify(r)));
 for(const row of before)assert.ok(after.has(JSON.stringify(row)),'original receipt remains byte-identical');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM outbound_messages')).rows[0].n,0);
});

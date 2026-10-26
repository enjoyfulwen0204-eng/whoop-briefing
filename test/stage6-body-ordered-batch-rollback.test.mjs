import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {liveTable} from '../src/stage8LiveAllocation.js';
import {ROUTE_RECEIPTS,ROUTE_ENTRIES,ROUTE_MANIFESTS} from '../src/phase4V29Schema.js';

test('actual privacy-link failure after BODY DOMAIN INSERT rolls back the whole original source unit',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:0})));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 // TEMP trigger is isolated to this actual owned fixture connection. It
 // attests that the original DOMAIN row really exists before raising, then
 // lets the original processing transaction perform its normal rollback.
 await f.db.raw.execute(`CREATE TEMP TRIGGER synthetic_privacy_after_domain BEFORE INSERT ON main.phase4_source_links
  WHEN NEW.artifact_type='stage8_live_operation_receipts'
  BEGIN
   SELECT CASE WHEN EXISTS(SELECT 1 FROM stage8_live_operation_receipts WHERE privacy_artifact_id=NEW.artifact_id)
    THEN RAISE(ABORT,'SYNTHETIC_PRIVACY_FAILURE_AFTER_REAL_DOMAIN')
    ELSE RAISE(ABORT,'SYNTHETIC_DOMAIN_NOT_EXECUTED') END;
  END`);
 const producer=await createStage8LiveProducer({...f,admission:await f.db.admitRuntime(),userIds:['a'],enabled:()=>true,eligible:id=>id==='a'});
 const original=f.db.raw.batch,execute=f.db.raw.execute;let mixed=0,afterDomainFailure=false,priorReceipts=[],latestMissingKey=null,sourceReceiptKey=null;
 f.db.raw.execute=async stmt=>{
  const sql=typeof stmt==='string'?stmt:stmt.sql,result=await execute(stmt);
  if(/FROM stage8_live_executions e LEFT JOIN stage8_live_execution_work_receipts/.test(sql)&&result.rows[0]?.receipt_receipt_key===null)
   latestMissingKey=stmt.args[0];
  return result;
 };
 f.db.raw.batch=async(statements,...rest)=>{
  const list=[...statements],isBody=/^INSERT INTO stage8_live_operation_receipts/.test(list[0]?.sql??'')
   &&list.slice(1).some(s=>/^INSERT INTO phase4_source_links/.test(s.sql));
  if(isBody){mixed++;assert.ok(list.length<=64);sourceReceiptKey=latestMissingKey;priorReceipts=(await execute('SELECT * FROM stage8_live_execution_work_receipts')).rows;}
  try{return await original(list,...rest);}catch(error){
   if(isBody){assert.match(String(error.message),/SYNTHETIC_PRIVACY_FAILURE_AFTER_REAL_DOMAIN/);afterDomainFailure=true;}
   throw error;
  }
 };
 let value,error;try{value=await producer.run({userId:'a',requestId:'body-ordered-batch-real-rollback'});}catch(e){error=e;}finally{f.db.raw.batch=original;f.db.raw.execute=execute;}
 assert.equal(mixed,1,'exactly one ordered mixed batch; no fallback or resubmission');
 assert.equal(afterDomainFailure,true,'SQL trigger must attest actual preceding DOMAIN INSERT');
 if(!error){assert.ok(value.result.jobsFailed>0);assert.notEqual(value.publication.status,'CURRENT');}
 for(const table of ['body_energy_results','stage8_live_operation_receipts',...[ROUTE_RECEIPTS,ROUTE_ENTRIES,ROUTE_MANIFESTS].map(liveTable),'stage8_live_publications','outbound_messages'])
  assert.equal((await execute('SELECT count(*) n FROM '+table)).rows[0].n,0,table+' must not retain a partial source result');
 const rows=(await execute('SELECT * FROM stage8_live_execution_work_receipts')).rows;
 const retained=new Set(rows.map(r=>JSON.stringify(r)));
 for(const r of priorReceipts)assert.ok(retained.has(JSON.stringify(r)),'prior durable receipts stay byte-identical');
 assert.match(sourceReceiptKey,/^[a-f0-9]{64}$/);
 assert.ok(rows.every(r=>r.receipt_key!==sourceReceiptKey),'failed original source work must have no named receipt');
 assert.ok((await execute("SELECT full_scan_cursor,completed_generation FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE'")).rows.every(r=>r.full_scan_cursor===null&&r.completed_generation===0));
});

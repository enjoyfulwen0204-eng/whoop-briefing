import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createStage8LiveProducer} from '../src/stage8LiveProducer.js';
import {currentExecutionReceiptTransactionMarker} from '../src/phase4ExecutionContext.js';
const at="'2026-10-26T00:00:00.000Z'";
const attacks={
 CANONICAL:`UPDATE whoop_cycles SET strain=strain+1 WHERE user_id=NEW.user_id AND id='cycle-current';`,
 ACCESS:`UPDATE whoop_resource_access SET status='REVOKED' WHERE user_id=NEW.user_id AND resource='cycle';`,
 TOMBSTONE:`INSERT INTO whoop_resource_tombstones(user_id,resource_type,resource_id,state,deleted_at,created_at,updated_at)
  VALUES(NEW.user_id,'cycle','cycle-current','ACTIVE',${at},${at},${at});`,
 PARENT:`UPDATE evidence_runs SET invalidated_at=${at} WHERE user_id=NEW.user_id AND execution_mode='LIVE' AND privacy_artifact_id=NEW.source_id;`,
 RUN_LINK:`UPDATE phase4_source_links SET unlinked_at=${at} WHERE user_id=NEW.user_id AND artifact_execution_mode='LIVE'
  AND artifact_type='evidence_runs' AND artifact_id=NEW.source_id;`,
 ITEM_LINK:`UPDATE phase4_source_links SET unlinked_at=${at} WHERE user_id=NEW.user_id AND artifact_execution_mode='LIVE'
  AND artifact_type='evidence_items' AND artifact_id=NEW.artifact_id AND source_type='evidence_runs';`,
 COMPLEX_VALID_GRAPH:`INSERT INTO phase4_source_links(user_id,artifact_execution_mode,artifact_type,artifact_id,
  source_execution_mode,source_type,source_id,relationship,linked_at)
  VALUES(NEW.user_id,'LIVE','evidence_runs',NEW.source_id,'SHARED','USER',NEW.user_id,'DEPENDS_ON',${at});`,
 SQL_ERROR:'',RUNTIME_REVOKED:'',
};
for(const [fault,action] of Object.entries(attacks))test('actual final privacy-link trigger cannot escape fresh raw ITEM closure: '+fault,async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true,now:()=>new Date()});
 await f.db.transaction(()=>seedBodyInput(f.db,bodyInput({asOf:Date.now()-1000,days:0})));
 await f.db.ensureOnboarding('a',{state:'READY'});await f.db.linkTelegram({userId:'a',chatId:'10001'});
 // TEMP fault instrumentation belongs only to this original owned synthetic
 // connection. It fires on the actual last parent-link INSERT, after its raw
 // links were written; it never seeds results, proofs, cursors or completion.
 await f.db.raw.execute(`CREATE TEMP TRIGGER synthetic_raw_item_postlink AFTER INSERT ON main.phase4_source_links
  WHEN NEW.artifact_execution_mode='LIVE' AND NEW.artifact_type='evidence_items' AND NEW.source_type='evidence_runs'
   AND EXISTS(SELECT 1 FROM evidence_runs r WHERE r.user_id=NEW.user_id AND r.execution_mode='LIVE'
    AND r.privacy_artifact_id=NEW.source_id AND r.subject_key='cycle_strain')
  BEGIN INSERT INTO telegram_state(key,value,updated_at) VALUES('raw_postlink_witness','synthetic',${at}); ${action} END`);
 let enabled=true;
 const producer=await createStage8LiveProducer({...f,admission:await f.db.admitRuntime(),userIds:['a'],enabled:()=>enabled,eligible:id=>id==='a'});
 const execute=f.db.raw.execute,batch=f.db.raw.batch;
 let targeted=false,witness=false,targetArtifact=null,queryFailed=false,prior=[],healthReadsAfterRevoke=0,beforeGeneration,targetMarker,targetJob;
 let targetReceiptAttempts=0,targetItemReadbacks=0,targetReceiptKey;
 const postlinkReads=new Set(),generation=async()=>JSON.stringify((await execute("SELECT source_generation FROM phase4_user_state WHERE user_id='a'")).rows);
 f.db.raw.batch=async(statements,...rest)=>{
  const target=!targeted&&statements.some(s=>s.sql?.startsWith('INSERT INTO phase4_source_links')&&s.args[2]==='evidence_items'&&s.args[5]==='cycle');
  if(target){targeted=true;targetArtifact=statements.find(s=>s.args?.[2]==='evidence_items').args[3];
   targetMarker=currentExecutionReceiptTransactionMarker();
   const active=(await execute("SELECT job_kind,full_scan_cursor,requested_generation,completed_generation,scope_revision FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE' AND state='RUNNING'")).rows;
   assert.equal(active.length,1);targetJob={...active[0]};
   prior=(await execute('SELECT * FROM stage8_live_execution_work_receipts')).rows;
   beforeGeneration=await generation();
  }
  const value=await batch(statements,...rest);
  if(target){witness=(await execute("SELECT value FROM telegram_state WHERE key='raw_postlink_witness'")).rows[0]?.value==='synthetic';
   assert.equal(witness,true,'the actual final-link trigger must fire before any post-link observation');
   assert.equal(await generation(),beforeGeneration,'the source-only trigger must not cause rejection via generation drift');
   if(fault==='RUNTIME_REVOKED')enabled=false;
  }return value;
 };
 f.db.raw.execute=async statement=>{
  const sql=typeof statement==='string'?statement:statement.sql;
  if(targetMarker&&currentExecutionReceiptTransactionMarker()===targetMarker){
   if(sql.startsWith('INSERT INTO stage8_live_execution_work_receipts')){targetReceiptAttempts++;targetReceiptKey=statement.args[1];}
   if(witness&&sql==='SELECT * FROM evidence_items WHERE user_id=? AND execution_mode=? AND evidence_item_id=?')targetItemReadbacks++;
  }
  if(witness)for(const [kind,pattern] of [['canonical',/SELECT \* FROM whoop_cycles WHERE/],['access',/SELECT status FROM whoop_resource_access/],['tombstone',/SELECT 1 FROM whoop_resource_tombstones/]])if(pattern.test(sql))postlinkReads.add(kind);
  if(!enabled&&/FROM whoop_(sleeps|recoveries|cycles|workouts) WHERE/.test(sql))healthReadsAfterRevoke++;
  if(witness&&fault==='SQL_ERROR'&&!queryFailed&&sql==='SELECT * FROM evidence_items WHERE user_id=? AND execution_mode=? AND evidence_item_id=?'){
   queryFailed=true;return execute({sql:'SELECT synthetic_postlink_missing_column FROM evidence_items'});
  }
  return execute(statement);
 };
 let result,error;
 try{
  for(let leg=0;leg<4&&!targeted;leg++)result=await producer.run({userId:'a',requestId:`postlink-${fault}-${leg}`});
 }catch(e){error=e;}finally{f.db.raw.execute=execute;f.db.raw.batch=batch;}
 assert.equal(targeted,true,'must reach a real fresh raw ITEM writer');assert.equal(witness,true);
 assert.ok(targetMarker);
 if(fault==='COMPLEX_VALID_GRAPH'){
  assert.ifError(error);assert.equal(result.result.jobsFailed,0);
  assert.ok(targetItemReadbacks>=2,'complex actual RUN graph must fall back to the original typed ITEM reader in the same root');
  assert.equal(targetReceiptAttempts,1);assert.equal((await execute({sql:'SELECT count(*) n FROM stage8_live_execution_work_receipts WHERE receipt_key=?',args:[targetReceiptKey]})).rows[0].n,1);
  assert.equal((await execute({sql:'SELECT count(*) n FROM evidence_items WHERE privacy_artifact_id=?',args:[targetArtifact]})).rows[0].n,1);
  assert.equal((await execute("SELECT count(*) n FROM telegram_state WHERE key='raw_postlink_witness'")).rows[0].n,1);
  assert.equal((await execute('SELECT count(*) n FROM stage8_live_publications')).rows[0].n,0);
  return;
 }
 assert.equal(targetReceiptAttempts,0,'failed original ITEM root must not issue its named work receipt');
 if(fault==='SQL_ERROR')assert.equal(queryFailed,true,'the actual post-link SQL failure must be reached');
 if(fault==='RUNTIME_REVOKED')assert.equal(healthReadsAfterRevoke,0,'original runtime guards prevent post-revocation health reads');
 if(['CANONICAL','ACCESS','TOMBSTONE'].includes(fault))for(const kind of ['canonical','access','tombstone'])
  assert.ok(postlinkReads.has(kind),'must actually reread post-link '+kind+' while generation remains unchanged');
 if(!error){assert.ok(result.result.jobsFailed>0);assert.notEqual(result.publication.status,'CURRENT');}
 assert.equal((await execute({sql:'SELECT count(*) n FROM evidence_items WHERE privacy_artifact_id=?',args:[targetArtifact]})).rows[0].n,0);
 assert.equal((await execute({sql:'SELECT count(*) n FROM phase4_source_links WHERE artifact_type=\'evidence_items\' AND artifact_id=?',args:[targetArtifact]})).rows[0].n,0);
 assert.equal((await execute("SELECT count(*) n FROM telegram_state WHERE key='raw_postlink_witness'")).rows[0].n,0,'the actual trigger effect rolls back with its ITEM');
 assert.equal((await execute('SELECT strain FROM whoop_cycles WHERE id=\'cycle-current\'')).rows[0].strain,0);
 assert.equal((await execute("SELECT status FROM whoop_resource_access WHERE user_id='a' AND resource='cycle'")).rows[0].status,'ACCESSIBLE');
 assert.equal((await execute('SELECT count(*) n FROM whoop_resource_tombstones')).rows[0].n,0);
 for(const table of ['stage8_live_publications','outbound_messages'])assert.equal((await execute('SELECT count(*) n FROM '+table)).rows[0].n,0);
 assert.ok((await execute("SELECT completed_generation FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE'")).rows.every(row=>row.completed_generation===0));
 const afterJob=(await execute({sql:"SELECT job_kind,full_scan_cursor,requested_generation,completed_generation,scope_revision FROM phase4_jobs WHERE user_id='a' AND execution_mode='LIVE' AND job_kind=?",args:[targetJob.job_kind]})).rows[0];
 assert.deepEqual({...afterJob},targetJob,'failed ITEM cannot ACK its source cursor or advance original job scope/generation');
 const after=new Set((await execute('SELECT * FROM stage8_live_execution_work_receipts')).rows.map(row=>JSON.stringify(row)));
 for(const row of prior)assert.ok(after.has(JSON.stringify(row)),'all original durable receipts remain byte-identical');
});

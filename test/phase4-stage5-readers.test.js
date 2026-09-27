import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,request } from './stage5HistoryFixture.js';
import { setup as associationSetup,hypothesis,family } from './stage5AssociationFixture.js';
import { call,read } from './stage5ClosureFixture.js';

async function withMutation(f,table,mutation,check) {
  const rows=(await f.db.raw.execute(`SELECT * FROM ${table}`)).rows;
  const guards=(await f.db.raw.execute({sql:"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?",args:[table]})).rows;
  for(const guard of guards)await f.db.raw.execute(`DROP TRIGGER ${guard.name}`);
  try {await mutation();await check();}
  finally {
    await f.db.raw.execute(`DELETE FROM ${table}`);
    for(const row of rows) {
      const keys=Object.keys(row);await f.db.raw.execute({sql:`INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,args:keys.map(key=>row[key])});
    }
    for(const guard of guards)await f.db.raw.execute(guard.sql);
  }
}
async function readers(f,tables) {
  const result=[];
  for(const table of tables) {
    const row=(await f.db.raw.execute(`SELECT * FROM ${table} LIMIT 1`)).rows[0];assert.ok(row,table);
    const columns=(await f.db.raw.execute(`PRAGMA table_info(${table})`)).rows;
    const key=Object.fromEntries(columns.filter(column=>column.pk&&!['user_id','execution_mode'].includes(column.name)).map(column=>[column.name,row[column.name]]));
    result.push({table,key});assert.ok((await read(f,table,key)).row);
  }
  return result;
}
async function allReject(f,readers,label) {
  const before={};for(const table of new Set(readers.map(reader=>reader.table)))before[table]=(await f.db.raw.execute(`SELECT * FROM ${table}`)).rows;
  for(const reader of readers)await assert.rejects(read(f,reader.table,reader.key),
    /INTEGRITY|BINDING_INVALID|UNAVAILABLE|INCOMPLETE_PROVENANCE|SOURCE_NOT_FOUND|CONTENT_REDACTED|PARENT_NOT_FOUND|PARENT_STALE/,
    `${label}: ${reader.table}`);
  for(const [table,rows] of Object.entries(before))assert.deepEqual((await f.db.raw.execute(`SELECT * FROM ${table}`)).rows,rows,`${label}: no repair`);
}

test('C: all metric reader routes enforce every applicable authority layer',async t=>{
  const f=await setup(t);await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],f.initialRefs.slice(1)));
  const routes=await readers(f,['evidence_runs','evidence_items','observation_episodes','phase4_episode_revisions','episode_events',
    'episode_semantic_events','episode_observations','episode_evidence','phase4_evidence_result_authorities','phase4_operation_receipts']);
  for(const [label,table,sql] of [
    ['missing v26','phase4_evidence_result_authorities','DELETE FROM phase4_evidence_result_authorities'],
    ['bad v26 HMAC','phase4_evidence_result_authorities',"UPDATE phase4_evidence_result_authorities SET authority_hmac='"+'0'.repeat(64)+"'"],
    ['wrong origin','phase4_evidence_result_authorities',"UPDATE phase4_evidence_result_authorities SET original_result_json='{}'"],
    ['missing snapshot','phase4_episode_revisions','DELETE FROM phase4_episode_revisions'],
    ['wrong snapshot revision','phase4_episode_revisions',"UPDATE phase4_episode_revisions SET snapshot_json='{}'"],
    ['corrupt semantic run','evidence_runs','UPDATE evidence_runs SET sample_count=99999'],
    ['structural graph loss','phase4_source_links',"DELETE FROM phase4_source_links WHERE artifact_type='episode_events'"],
    ['missing v27','phase4_operation_receipts','DELETE FROM phase4_operation_receipts'],
    ['bad v27 HMAC','phase4_operation_receipts',"UPDATE phase4_operation_receipts SET receipt_hmac='"+'0'.repeat(64)+"'"],
  ])await t.test(label,()=>withMutation(f,table,()=>f.db.raw.execute(sql),()=>allReject(f,routes,label)));
  await withMutation(f,'whoop_recoveries',()=>f.db.raw.execute("DELETE FROM whoop_recoveries WHERE sleep_id='sleep-30'"),
    async()=>withMutation(f,'phase4_source_links',()=>f.db.raw.execute("DELETE FROM phase4_source_links WHERE source_type='recovery' AND source_id='sleep-30'"),
      ()=>allReject(f,routes,'root and indexes missing')));
});

test('C: every insight and association reader requires whole operation and evidence authority',async t=>{
  const f=await associationSetup(t,{days:30});await call(f,'intelligence','analyzeAssociationFamily',family('reader-matrix',hypothesis(f,Array.from({length:30},(_,i)=>i))));
  const routes=await readers(f,['evidence_runs','evidence_items','health_insights','insight_revisions',
    'phase4_evidence_result_authorities','phase4_operation_receipts']);
  for(const [label,table,sql] of [
    ['one missing association scope','phase4_evidence_result_authorities',"DELETE FROM phase4_evidence_result_authorities WHERE result_scope='INSIGHT_CONTRADICTION'"],
    ['bad association HMAC','phase4_evidence_result_authorities',"UPDATE phase4_evidence_result_authorities SET authority_hmac='"+'0'.repeat(64)+"'"],
    ['wrong insight origin','phase4_evidence_result_authorities',"UPDATE phase4_evidence_result_authorities SET original_result_json='{}'"],
    ['missing insight revision','insight_revisions','DELETE FROM insight_revisions'],
    ['corrupt insight revision','insight_revisions',"UPDATE insight_revisions SET normalized_claim='forged'"],
    ['corrupt run timezone','evidence_runs',"UPDATE evidence_runs SET timezone='UTC'"],
    ['missing v27','phase4_operation_receipts','DELETE FROM phase4_operation_receipts'],
    ['bad v27 HMAC','phase4_operation_receipts',"UPDATE phase4_operation_receipts SET receipt_hmac='"+'0'.repeat(64)+"'"],
  ])await t.test(label,()=>withMutation(f,table,()=>f.db.raw.execute(sql),()=>allReject(f,routes,label)));
  await withMutation(f,'whoop_recoveries',()=>f.db.raw.execute("DELETE FROM whoop_recoveries WHERE sleep_id='sleep-00'"),
    async()=>withMutation(f,'phase4_source_links',()=>f.db.raw.execute("DELETE FROM phase4_source_links WHERE source_type='recovery' AND source_id='sleep-00'"),
      ()=>allReject(f,routes,'association root and indexes missing')));
});

test('C: every Body Energy result and retained audit reader requires complete receipt authority',async t=>{
  const f=await setup(t),asOfEpochMs=Date.parse('2026-09-25T12:00:00Z');
  const result=await call(f,'bodyEnergy','compute',{asOfEpochMs,targetHealthDate:'2026-09-25'});
  const checkpoint=await call(f,'bodyEnergy','checkpoint',{bucketStart:asOfEpochMs-900000});
  const routes=[
    ['read',c=>f.stores.bodyEnergy.read(c,result.row.result_id)],
    ['audit',c=>f.stores.bodyEnergy.audit(c,result.row.result_id)],
    ['readExact',c=>f.stores.bodyEnergy.readExact(c,{healthDate:'2026-09-25',asOfEpochMs})],
    ['auditCheckpoint',c=>f.stores.bodyEnergy.auditCheckpoint(c,checkpoint.row.checkpoint_id)],
    ['generic result',c=>f.stores.readArtifact(c,'body_energy_results',{result_id:result.row.result_id})],
    ['generic checkpoint',c=>f.stores.readArtifact(c,'body_energy_checkpoints',{checkpoint_id:checkpoint.row.checkpoint_id})],
  ];
  for(const [,reader] of routes)await f.stores.withContext('a',{executionMode:'SHADOW'},reader);
  for(const [label,table,sql] of [
    ['missing receipt','phase4_operation_receipts','DELETE FROM phase4_operation_receipts'],
    ['bad receipt','phase4_operation_receipts',"UPDATE phase4_operation_receipts SET receipt_hmac='"+'0'.repeat(64)+"'"],
    ['corrupt result','body_energy_results','UPDATE body_energy_results SET value=CASE WHEN value=12 THEN 13 ELSE 12 END'],
    ['missing physical root','whoop_sleeps',"DELETE FROM whoop_sleeps WHERE id='sleep-00'"],
    ['graph loss','phase4_source_links',"DELETE FROM phase4_source_links WHERE artifact_type IN ('body_energy_results','body_energy_checkpoints')"],
  ])await t.test(label,()=>withMutation(f,table,()=>f.db.raw.execute(sql),async()=>{
    for(const [name,reader] of routes)await assert.rejects(f.stores.withContext('a',{executionMode:'SHADOW'},reader),
      /INTEGRITY|UNAVAILABLE|CONFLICT|MISMATCH|SOURCE_NOT_FOUND|INCOMPLETE_PROVENANCE/,`${label}: ${name}`);
  }));
});

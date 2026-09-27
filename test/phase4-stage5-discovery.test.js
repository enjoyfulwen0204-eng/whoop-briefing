import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,request } from './stage5HistoryFixture.js';
import { call } from './stage5ClosureFixture.js';
import { createLegacyDiscovery } from '../src/phase4LegacyDiscovery.js';
import { V23_HEALTH_FIELDS } from '../src/phase4V23Schema.js';

const tables=['evidence_runs','evidence_items','phase4_evidence_result_authorities','phase4_operation_receipts'];
const snapshot=async f=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await f.db.raw.execute(`SELECT * FROM ${table}`)).rows])));

test('F: exact-key misses exhaustively authenticate candidates despite poisoned selectors or broken parents',async t=>{
  for(const [name,table,sql,error] of [
    ['one incomplete operation',null,null,/OPERATION_RESULT_UNAVAILABLE/],
    ['poisoned subject','evidence_runs',"UPDATE evidence_runs SET subject_key='hidden-from-index'",/BINDING_INVALID|UNAVAILABLE/],
    ['poisoned method','evidence_runs',"UPDATE evidence_runs SET method='MONOTONIC_TREND'",/BINDING_INVALID|UNAVAILABLE/],
    ['poisoned as-of','evidence_runs',"UPDATE evidence_runs SET as_of_utc='2000-01-01T00:00:00.000Z'",/BINDING_INVALID|UNAVAILABLE/],
    ['poisoned algorithm','evidence_runs',"UPDATE evidence_runs SET algorithm_version='unregistered'",/BINDING_INVALID|UNAVAILABLE/],
    ['dangling authority','evidence_runs','DELETE FROM evidence_runs',/BINDING_INVALID/],
    ['corrupt HMAC','phase4_evidence_result_authorities',"UPDATE phase4_evidence_result_authorities SET authority_hmac='"+'0'.repeat(64)+"'",/BINDING_INVALID/],
    ['redacted candidate','evidence_runs',`UPDATE evidence_runs SET content_state='REDACTED',content_digest_salt=NULL,
      source_linkage_state='DISCONNECTED',health_content_redaction_reason='SOURCE_DELETED',health_content_redacted_at='2026-09-25T12:00:00Z',${V23_HEALTH_FIELDS.evidence_runs.map(field=>`${field}=NULL`).join(',')}`,/CONTENT_REDACTED/],
  ])await t.test(name,async t=>{
    const f=await setup(t),req=request(f.initialRefs[0],[]);await call(f,'intelligence','analyzeMetric',req);
    for(const target of ['phase4_operation_receipts',table].filter(Boolean)) {
      const guards=(await f.db.raw.execute({sql:"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name=?",args:[target]})).rows;
      for(const guard of guards)await f.db.raw.execute(`DROP TRIGGER ${guard.name}`);
    }
    await f.db.raw.execute('DELETE FROM phase4_operation_receipts');if(sql)await f.db.raw.execute(sql);
    const before=await snapshot(f);await assert.rejects(call(f,'intelligence','analyzeMetric',req),error);
    assert.deepEqual(await snapshot(f),before,'discovery never repairs or computes');
  });
});

test('F: the scoped scan excludes wrong tenant/mode decoys and admits a truly new request',async t=>{
  const f=await setup(t),req=request(f.initialRefs[0],[]),first=await call(f,'intelligence','analyzeMetric',req);
  const guardRows=(await f.db.raw.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('evidence_runs','phase4_evidence_result_authorities','phase4_operation_receipts')")).rows;
  for(const guard of guardRows)await f.db.raw.execute(`DROP TRIGGER ${guard.name}`);
  await f.db.raw.execute('DELETE FROM phase4_operation_receipts');await f.db.raw.execute('DELETE FROM phase4_evidence_result_authorities');
  await f.db.raw.execute("UPDATE evidence_runs SET user_id='b',input_manifest_json='{}'");
  const decoy={...first.run.row,run_id:'wrong-mode-decoy',execution_mode:'LIVE',privacy_artifact_id:'wrong-mode-private',deterministic_run_key:'wrong-mode-key',input_manifest_json:'{}'};
  const columns=Object.keys(decoy);await f.db.raw.execute({sql:`INSERT INTO evidence_runs(${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`,args:columns.map(key=>decoy[key])});
  const result=await call(f,'intelligence','analyzeMetric',{...req,windowFamily:'truly-new'});
  assert.notEqual(result.run.row.run_id,first.run.row.run_id);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM evidence_runs WHERE user_id='b' OR execution_mode='LIVE'")).rows[0].n,2);
});

test('F: elapsed discovery deadline fails closed without writes',async()=>{
  const original=performance.now;let calls=0;
  Object.defineProperty(performance,'now',{configurable:true,value:()=>calls++===0?0:5001});
  try {
    const core={client:{execute:async()=>({rows:[]})},keys:{}};
    await assert.rejects(createLegacyDiscovery(core)({userId:'a',executionMode:'SHADOW',inputGeneration:1},'analyzeMetric',{}),/LEGACY_DISCOVERY_UNAVAILABLE/);
  } finally {Object.defineProperty(performance,'now',{configurable:true,value:original});}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageLineage,validateCoverageNode } from '../src/phase4CoverageLineage.js';
import { healthDateFor } from '../src/journal.js';

const at='2026-09-25T12:00:00.000Z';
const root=()=>({user_id:'a',coverage_window_id:'root',revision:1,supersedes_coverage_window_id:null,status:'ACTIVE',
  input_generation:1,lifecycle_generation:1,auth_generation:1,purge_generation:0,created_at:at,updated_at:at,
  content_state:'PRESENT',source_linkage_state:'COMPLETE',health_content_redacted_at:null,
  window_start_utc:'2026-09-24T00:00:00.000Z',window_end_utc:'2026-09-25T00:00:00.000Z',
  health_date_start:'2026-09-24',health_date_end:'2026-09-25',recorded_timezone:'Asia/Taipei',
  factor_set_version:'journal-factors-v1',factor_keys_json:'["caffeine","alcohol"]',answer_confidence:1,
  parser_version:'journal-candidate-v1',normalizer_version:'journal-normalizer-v1',source_event_key:'source',
  confirmation_text_hash:'confirmation',privacy_artifact_id:'private',content_digest_salt:'salt'});
const client=rows=>({execute:async({sql,args})=>({rows:sql.includes('supersedes_coverage_window_id=?')
  ?rows.filter(row=>row.user_id===args[0]&&row.supersedes_coverage_window_id===args[1])
  :rows.filter(row=>row.user_id===args[0]&&row.coverage_window_id===args[1])})});

test('I: every root and correction field has an explicit validity contract',async t=>{
  const value=root();assert.equal(validateCoverageNode(value,'a'),value);
  for(const [label,patch] of Object.entries({tenant:{user_id:'b'},rootRevision:{revision:99},unsafeRevision:{revision:2**53},
    fractionalRevision:{revision:1.5},nanRevision:{revision:NaN},generation:{input_generation:NaN},origin:{source_event_key:''},
    rootPredecessor:{supersedes_coverage_window_id:'missing'},unknownType:{parser_version:'unknown'},
    unknownNormalizer:{normalizer_version:'unknown'},factorDomain:{factor_keys_json:'["invented"]'},
    custom:{factor_keys_json:'["custom"]'},duplicateFactor:{factor_keys_json:'["caffeine","caffeine"]'},
    emptyFactor:{factor_keys_json:'[]'},factorVersion:{factor_set_version:'future'},timezone:{recorded_timezone:'invalid/zone'},
    emptyWindow:{window_end_utc:value.window_start_utc},futureWindow:{window_end_utc:'2027-01-01T00:00:00.000Z'},
    wrongHealthDate:{health_date_end:'2026-09-24'},invalidDate:{health_date_start:'2026-02-30'},
    backwardsUpdate:{updated_at:'2020-01-01T00:00:00Z'},offsetless:{created_at:'2026-09-25T12:00:00'},
    precision:{created_at:'2026-09-25T12:00:00.000001Z'},nanConfidence:{answer_confidence:NaN},
    unlinked:{source_linkage_state:'DISCONNECTED'},deleted:{status:'DELETED'},redacted:{content_state:'REDACTED'}}))
    await t.test(label,()=>assert.throws(()=>validateCoverageNode({...value,...patch},'a'),/LINEAGE_INVALID|CONTENT_REDACTED/));
  const child={...value,coverage_window_id:'child',revision:2,supersedes_coverage_window_id:'root',factor_keys_json:'["caffeine"]'};
  assert.equal(validateCoverageNode(child,'a',value),child,'equal instants are ordered by revision');
  for(const patch of [{revision:3},{supersedes_coverage_window_id:'other'},{created_at:'2026-09-25T11:00:00Z'},
    {factor_keys_json:'["caffeine","food"]'},{recorded_timezone:'UTC'}])
    assert.throws(()=>validateCoverageNode({...child,...patch},'a',value),/LINEAGE_INVALID/);
});

test('I: complete linear traversal detects branches, cycles, missing parents and cap+1',async()=>{
  const rows=[root()];
  for(let i=1;i<1000;i++) {
    rows[i-1].status='SUPERSEDED';rows.push({...root(),coverage_window_id:`node-${i}`,revision:i+1,
      supersedes_coverage_window_id:rows[i-1].coverage_window_id});
  }
  assert.equal((await coverageLineage(client(rows),'a','node-999')).rows.length,1000);
  const overflow=[...rows,{...root(),coverage_window_id:'over',revision:1001,supersedes_coverage_window_id:'node-999'}];
  overflow[999]={...overflow[999],status:'SUPERSEDED'};
  await assert.rejects(coverageLineage(client(overflow),'a','root'),/LINEAGE_INVALID/);
  const r={...root(),status:'SUPERSEDED'},c={...root(),coverage_window_id:'child',revision:2,supersedes_coverage_window_id:'root'};
  for(const values of [[r,c,{...c,coverage_window_id:'branch'}],[{...r,supersedes_coverage_window_id:'root'}],
    [{...r,supersedes_coverage_window_id:'child'},c],[c],[{...r,status:'ACTIVE'},c],[r]])
    await assert.rejects(coverageLineage(client(values),'a',values[0].coverage_window_id),/LINEAGE_INVALID/);
  assert.equal(healthDateFor(new Date(root().window_start_utc),root().recorded_timezone),root().health_date_start);
});

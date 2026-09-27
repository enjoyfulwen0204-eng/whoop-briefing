import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,hypothesis,family } from './stage5AssociationFixture.js';
import { call } from './stage5ClosureFixture.js';
import { stage5PrivacyIndex } from '../src/phase4Stage5Privacy.js';

test('G: COMPLETE independently detects a sensitive parent omitted from the target ledger',async t=>{
  const f=await setup(t,{days:30});await call(f,'intelligence','analyzeAssociationFamily',family('oracle-parent',hypothesis(f,Array.from({length:30},(_,i)=>i))));
  const parent=(await f.db.raw.execute('SELECT * FROM health_insights')).rows[0];
  await f.db.raw.execute('DELETE FROM phase4_source_links');
  const control=await f.stores.capturePrivacyControl('a'),purge=await f.stores.privacy.admit(control,
    {targetType:'JOURNAL_FACT',targetId:f.logicalFacts[0],idempotencyKey:'independent-oracle'});
  await f.stores.privacy.redact(control,purge.purge_id);
  for(const table of ['evidence_runs','evidence_items','health_insights','insight_revisions',
    'phase4_evidence_result_authorities','phase4_operation_receipts'])
    assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${table} WHERE content_state='PRESENT'`)).rows[0].n,0,table);
  await assert.rejects(f.db.raw.execute("UPDATE health_insights SET statement='REHYDRATED'"),/redacted_plaintext/);
  await assert.rejects(f.db.raw.execute("UPDATE health_insights SET content_state='PRESENT'"),/content_redacted|invalid_current_insight_revision/);
  // Simulate an omitted-store/harness defect, including a lying target ledger.
  // Only this controlled fixture bypasses the real no-rehydration SQL guards.
  const guards=(await f.db.raw.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='health_insights'")).rows;
  for(const guard of guards)await f.db.raw.execute(`DROP TRIGGER ${guard.name}`);
  const columns=Object.keys(parent);
  await f.db.raw.execute({sql:`UPDATE health_insights SET ${columns.map(key=>`${key}=?`).join(',')} WHERE id=?`,args:[...columns.map(key=>parent[key]),parent.id]});
  for(const guard of guards)await f.db.raw.execute(guard.sql);
  await f.db.raw.execute("DELETE FROM health_purge_targets WHERE artifact_type='health_insights'");
  await assert.rejects(stage5PrivacyIndex(f.core,'a',{verifyRemaining:true}),/PURGE_CLOSURE_UNPROVEN|PURGE_SENSITIVE_REMAINS/);
  await assert.rejects(f.stores.privacy.complete(control,purge.purge_id),/PURGE_CLOSURE_UNPROVEN|PURGE_SENSITIVE_REMAINS|UNCLASSIFIED_PLAINTEXT_REMAINS/);
  assert.notEqual((await f.stores.privacy.status(control,purge.purge_id)).state,'COMPLETE');
  await assert.rejects(f.stores.capture('a',{executionMode:'SHADOW'}),/PURGE_FENCED/);
});

test('G: a corrupt standalone receipt never narrows closure or permits COMPLETE',async t=>{
  const f=await setup(t,{days:30});await call(f,'intelligence','analyzeAssociationFamily',family('corrupt-closure',hypothesis(f,Array.from({length:30},(_,i)=>i))));
  await f.db.raw.execute('DELETE FROM phase4_source_links');
  const guards=(await f.db.raw.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='phase4_operation_receipts'")).rows;
  for(const guard of guards)await f.db.raw.execute(`DROP TRIGGER ${guard.name}`);
  await f.db.raw.execute("UPDATE phase4_operation_receipts SET receipt_hmac='"+'0'.repeat(64)+"'");
  for(const guard of guards)await f.db.raw.execute(guard.sql);
  const control=await f.stores.capturePrivacyControl('a'),purge=await f.stores.privacy.admit(control,
    {targetType:'JOURNAL_FACT',targetId:f.logicalFacts[0],idempotencyKey:'corrupt-oracle'});
  await assert.rejects(f.stores.privacy.redact(control,purge.purge_id),/OPERATION_RECEIPT_INTEGRITY/);
  assert.equal((await f.stores.privacy.status(control,purge.purge_id)).state,'ADMITTED');
  await assert.rejects(f.stores.privacy.complete(control,purge.purge_id),/CONTENT_PENDING/);
  await assert.rejects(f.stores.capture('a',{executionMode:'SHADOW'}),/PURGE_FENCED/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,hypothesis,family } from './stage5AssociationFixture.js';
import { call } from './stage5ClosureFixture.js';
import { guards,T } from './stage5ReviewBFixture.js';

const sensitive=['semantic_at','request_json','result_json','related_results_json','required_roots_json','schema_contract_json','receipt_hmac'];
test('BF-H01: marker-only outer receipt with lost links is physically scrubbed before COMPLETE',async t=>{
  const f=await setup(t,{days:30});
  await call(f,'intelligence','analyzeAssociationFamily',family('blind-privacy',hypothesis(f,Array.from({length:30},(_,i)=>i))));
  const receipt=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='analyzeAssociationFamily'")).rows[0];
  await f.db.raw.execute({sql:'UPDATE phase4_operation_receipts SET health_content_redacted_at=? WHERE operation_key=?',args:[T,receipt.operation_key]});
  await f.db.raw.execute('DELETE FROM phase4_source_links');
  const control=await f.stores.capturePrivacyControl('a'),purge=await f.stores.privacy.admit(control,
    {targetType:'JOURNAL_FACT',targetId:f.logicalFacts[0],idempotencyKey:'blind-marker'});
  await f.stores.privacy.redact(control,purge.purge_id);
  assert.equal((await f.stores.privacy.complete(control,purge.purge_id)).state,'COMPLETE');
  const scrubbed=(await f.db.raw.execute({sql:'SELECT * FROM phase4_operation_receipts WHERE operation_key=?',args:[receipt.operation_key]})).rows[0];
  assert.equal(scrubbed.content_state,'REDACTED');for(const key of sensitive)assert.equal(scrubbed[key],null,key);
  await assert.rejects(f.db.raw.execute({sql:'UPDATE phase4_operation_receipts SET result_json=? WHERE operation_key=?',args:[receipt.result_json,receipt.operation_key]}),/redacted|immutable/);
  // Adversarial restore uses only captured genuine bytes, never a re-signed
  // receipt. Neither a COMPLETE ledger nor omitted targets can hide content.
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:`UPDATE phase4_operation_receipts SET ${Object.keys(receipt).map(k=>`${k}=?`).join(',')},health_content_redacted_at=? WHERE operation_key=?`,args:[...Object.values(receipt),T,receipt.operation_key]}));
  await f.db.raw.execute("DELETE FROM health_purge_targets WHERE artifact_type='phase4_operation_receipts'");
  await assert.rejects(f.stores.privacy.complete(control,purge.purge_id),/PURGE_SENSITIVE_REMAINS/);
  t.diagnostic(JSON.stringify({finding:'BF-H01',scrubbedFields:sensitive,completeOnlyAfterScrub:true,restoredPayloadRejected:true}));
});

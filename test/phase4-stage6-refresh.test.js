import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, hypothesis, family } from './stage5AssociationFixture.js';
import { call } from './stage5ClosureFixture.js';
import { snapshot } from './stage5M007Fixture.js';
import { guards } from './stage5ReviewBFixture.js';

const at = '2026-09-25T12:00:01.000Z';
const identity = { subject: 'journal:caffeine', outcome: 'recovery_score', direction: 'LOWER',
  exposureCategory: 'caffeine', algorithmFamily: 'journal-association', evidenceContractMajor: '1' };

async function fixture(t,{terminal=false}={}) {
  const f = await setup(t, { days: 30,targetVersion:28 });
  const initial = await call(f, 'intelligence', 'analyzeAssociationFamily',
    family('stage6-initial', hypothesis(f, Array.from({ length: 30 }, (_, i) => i))));
  const old = initial.items[0].insight.current;
  assert.equal(old.row.input_generation, 15);
  assert.equal(old.row.status, 'EMERGING');
  if(terminal)await call(f,'insights','transition',{insightId:old.row.id,expectedRevision:old.row.current_revision,
    status:'RETIRED',disposition:'REFUTED',claim:old.row.statement,supportingEvidenceIds:[initial.items[0].item.row.evidence_item_id],
    reason:'REFUTED',semanticAt:'2026-09-25T12:00:00.000Z'});
  f.setNow(at);
  const eventAt = '2026-09-25T11:00:00.000Z', sourceText = `caffeine at ${eventAt}`;
  const mutation = await f.stores.journal.create(await f.stores.captureControl('a'), {
    sourceEventKey: 'stage6-new-journal', sourceText,
    candidate: { category: 'caffeine', eventAt, valueKind: 'PRESENCE', exposureState: 'EXPOSED',
      extractionConfidence: 1, excerptStart: 0, excerptEnd: [...sourceText].length },
  });
  assert.equal(mutation.status, 'ACCEPT');
  const fresh = await call(f, 'intelligence', 'analyzeAssociationFamily',
    {...family('stage6-current-evidence', hypothesis(f, Array.from({ length: 30 }, (_, i) => i)), at),lifecycleMode:'EVIDENCE_ONLY'});
  assert.equal(fresh.items[0].insight, null);
  assert.equal(fresh.runs[0].row.input_generation, 16);
  const request = { insightId: old.row.id, expectedRevision: old.row.current_revision, identity, refresh: true,
    status: 'EMERGING', claim: 'Caffeine may be associated with lower recovery; further evidence is needed.',
    supportingEvidenceIds: [fresh.items[0].item.row.evidence_item_id], reason: 'REPEATED_EVIDENCE', semanticAt: at };
  return { f, old, fresh, initial, request };
}

test('Stage 6: public 15→16 refresh seals fresh evidence and predecessor; ordinary stale readers stay fenced; retry and restart converge', async t => {
  const { f, old, request } = await fixture(t);
  await assert.rejects(f.stores.withContext('a', { executionMode: 'SHADOW' }, c => f.stores.insights.read(c, old.row.id, { asOfUtc: at })),
    { code: 'PHASE4_PARENT_STALE' });
  const first = await call(f, 'insights', 'transition', request);
  assert.equal(first.row.input_generation, 16);
  assert.equal(first.row.current_revision, old.row.current_revision + 1);
  assert.equal(first.refreshPredecessor.inputGeneration, 15);
  assert.equal(first.refreshPredecessor.revision, old.row.current_revision);
  const current = await f.stores.withContext('a', { executionMode: 'SHADOW' }, c => f.stores.insights.read(c, old.row.id, { asOfUtc: at }));
  assert.equal(current.row.input_generation, 16);
  const before = await snapshot(f);
  const results = await Promise.all([call(f, 'insights', 'transition', request), call(f, 'insights', 'transition', request)]);
  for (const result of results) assert.deepEqual(result, first);
  assert.deepEqual(await snapshot(f), before);
  f.stores = (await f.restart()).stores; f.context = undefined;
  assert.deepEqual(await call(f, 'insights', 'transition', request), first);
  assert.deepEqual(await snapshot(f), before);
});

test('Stage 6: different fresh evidence target fails without writes',async t=>{
  const {f,request}=await fixture(t);
  const h={...hypothesis(f,Array.from({length:20},(_,i)=>i+10)),outcomeMetric:'rhr'};
  const other=await call(f,'intelligence','analyzeAssociationFamily',family('wrong-target',h,at));
  const before=await snapshot(f);
  await assert.rejects(call(f,'insights','transition',{...request,supportingEvidenceIds:[other.items[0].item.row.evidence_item_id]}),
    /REFRESH_EVIDENCE_IDENTITY/);
  assert.deepEqual(await snapshot(f),before);
});

test('Stage 6: simultaneous first refresh attempts converge on one revision and receipt',async t=>{
  const {f,old,request}=await fixture(t);
  const results=await Promise.all([call(f,'insights','transition',request),call(f,'insights','transition',request)]);
  assert.deepEqual(results[0],results[1]);
  assert.equal(results[0].row.current_revision,old.row.current_revision+1);
  assert.equal((await f.db.raw.execute({sql:'SELECT count(*) n FROM insight_revisions WHERE insight_id=? AND revision=?',
    args:[old.row.id,old.row.current_revision+1]})).rows[0].n,1);
  const receipts=(await f.db.raw.execute("SELECT request_json FROM phase4_operation_receipts WHERE operation_kind='INSIGHT_TRANSITION'")).rows;
  assert.equal(receipts.filter(row=>JSON.parse(row.request_json).request.refresh===true).length,1);
});

test('Stage 6: actual source purge scrubs the refreshed receipt and forbids refresh replay',async t=>{
  const {f,request}=await fixture(t);
  await call(f,'insights','transition',request);
  const before=(await f.db.raw.execute("SELECT operation_key FROM phase4_operation_receipts WHERE operation_kind='INSIGHT_TRANSITION'")).rows[0];
  const control=await f.stores.capturePrivacyControl('a');
  const purge=await f.stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:f.logicalFacts[0],idempotencyKey:'stage6-refresh-purge'});
  await f.stores.privacy.redact(control,purge.purge_id);
  assert.equal((await f.stores.privacy.complete(control,purge.purge_id)).state,'COMPLETE');
  const receipt=(await f.db.raw.execute({sql:'SELECT * FROM phase4_operation_receipts WHERE operation_key=?',args:[before.operation_key]})).rows[0];
  assert.equal(receipt.content_state,'REDACTED');
  for(const field of ['request_json','result_json','related_results_json','required_roots_json','receipt_hmac'])assert.equal(receipt[field],null,field);
  const after=await snapshot(f);
  await assert.rejects(call(f,'insights','transition',request),/CONTENT_REDACTED|PARENT_STALE|OPERATION_RESULT_UNAVAILABLE/);
  assert.deepEqual(await snapshot(f),after);
});

test('Stage 6: authenticated terminal predecessor cannot be resurrected or hidden by an older expected revision',async t=>{
  const {f,request}=await fixture(t,{terminal:true});
  for(const expectedRevision of [request.expectedRevision,request.expectedRevision+1]) {
    const before=await snapshot(f);
    await assert.rejects(call(f,'insights','transition',{...request,expectedRevision}),/CAS_LOST|TERMINAL_REFRESH/);
    assert.deepEqual(await snapshot(f),before);
  }
});

for(const fault of ['corrupt','redacted','missing-revision'])test(`Stage 6: ${fault} predecessor fails closed`,async t=>{
  const {f,request}=await fixture(t);
  if(fault==='missing-revision')await guards(f,'insight_revisions',()=>f.db.raw.execute('DELETE FROM insight_revisions'));
  else {
    const receipt=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='INSIGHT_CREATE'")).rows[0];
    if(fault==='corrupt')await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute({sql:
      'UPDATE phase4_operation_receipts SET receipt_hmac=? WHERE operation_key=?',args:['0'.repeat(64),receipt.operation_key]}));
    else await guards(f,'health_insights',()=>f.db.raw.execute("UPDATE health_insights SET health_content_redacted_at='2026-09-25T12:00:00.000Z'"));
  }
  const before=await snapshot(f);
  await assert.rejects(call(f,'insights','transition',request),/RECEIPT_INTEGRITY|CONTENT_REDACTED|OPERATION_RESULT_UNAVAILABLE/);
  assert.deepEqual(await snapshot(f),before);
});

for(const fence of ['input','lifecycle','auth','purge'])test(`Stage 6: ${fence} changes before commit roll back revision and receipt`,async t=>{
  const {f,request}=await fixture(t),before=await snapshot(f),execute=f.db.raw.execute.bind(f.db.raw);let changed=false;
  f.db.raw.execute=async statement=>{
    const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
    if(!changed&&sql.startsWith('INSERT INTO insight_revisions')) {
      changed=true;
      const mutation={input:"UPDATE phase4_computation_state SET input_generation=input_generation+1 WHERE user_id='a'",
        lifecycle:"UPDATE users SET lifecycle_generation=lifecycle_generation+1 WHERE id='a'",
        auth:"UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='a'",
        purge:"UPDATE phase4_user_state SET purge_generation=purge_generation+1 WHERE user_id='a'"}[fence];
      await execute(mutation);
    }
    return result;
  };
  await assert.rejects(call(f,'insights','transition',request),/FENCED|PARENT_STALE/);
  assert.equal(changed,true);f.db.raw.execute=execute;
  assert.deepEqual(await snapshot(f),before);
});

test('Stage 6: old evidence and wrong requested identity cannot refresh, with zero writes', async t => {
  const { f, request, initial } = await fixture(t);
  for (const [patch, error] of [
    [{ supportingEvidenceIds: [initial.items[0].item.row.evidence_item_id] }, /PARENT_STALE/],
    [{ identity: { ...identity, exposureCategory: 'alcohol', subject: 'journal:alcohol' } }, /IDENTITY_MISMATCH/],
  ]) {
    const before = await snapshot(f);
    await assert.rejects(call(f, 'insights', 'transition', { ...request, ...patch }), error);
    assert.deepEqual(await snapshot(f), before);
  }
});

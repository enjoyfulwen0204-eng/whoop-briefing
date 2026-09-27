import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,hypothesis,family } from './stage5AssociationFixture.js';
import { call } from './stage5ClosureFixture.js';
import { guards,semantic,leases,T } from './stage5ReviewBFixture.js';

const retiredAt='2026-09-25T12:00:02.000Z';
const identity={subject:'journal:caffeine',outcome:'recovery_score',direction:'LOWER',exposureCategory:'caffeine',
  algorithmFamily:'journal-association',evidenceContractMajor:'1'};
async function durable(f) {
  const snapshot={};
  for(const {name} of (await f.db.raw.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).rows)
    snapshot[name]=(await f.db.raw.execute(`SELECT * FROM "${name.replaceAll('"','""')}"`)).rows;
  return snapshot;
}
async function predecessor(t) {
  const f=await setup(t,{days:30}),h=hypothesis(f,Array.from({length:30},(_,i)=>i));
  const originalRequest=family('terminal-predecessor',h),original=await call(f,'intelligence','analyzeAssociationFamily',originalRequest);
  const old=original.items[0].insight.current,evidenceId=original.items[0].item.row.evidence_item_id;
  f.setNow('2026-09-25T12:00:10.000Z');
  const retirement={insightId:old.row.id,expectedRevision:old.row.current_revision,status:'RETIRED',disposition:'EXPIRED',
    claim:old.row.statement,supportingEvidenceIds:[evidenceId],reason:'EXPIRED',semanticAt:retiredAt};
  const terminal=await call(f,'insights','transition',retirement);
  const successor=(path,at,key='successor')=>path==='direct'
    ?call(f,'insights','create',{identity,claim:old.row.statement,evidenceContractVersion:'phase4-evidence-v1',
      supportingEvidenceIds:[evidenceId],expiresAt:'2026-09-26T12:00:00.000Z',creationKey:key,supersedesId:old.row.id,semanticAt:at})
    :call(f,'intelligence','analyzeAssociationFamily',family(key,h,at));
  return {f,old,original,originalRequest,retirement,terminal,successor};
}
async function mutableTime(f,id,time) {
  await guards(f,'health_insights',()=>f.db.raw.execute({sql:'UPDATE health_insights SET retired_at=? WHERE id=?',args:[time,id]}));
}

for(const path of ['direct','association']) {
  for(const [name,at,material,valid] of [
    ['before sealed boundary','2026-09-25T12:00:01.000Z',T,false],
    ['equal sealed boundary',retiredAt,T,true],
    ['after sealed boundary','2026-09-25T12:00:02.001Z',T,true],
    ['mutable later than sealed',retiredAt,'2026-09-25T12:00:05.000Z',true],
  ])test(`M006: ${path} ${name}`,async t=>{
    const {f,old,successor}=await predecessor(t);await mutableTime(f,old.row.id,material);
    const before=await durable(f);
    if(!valid) {
      await assert.rejects(successor(path,at),/SEMANTIC_CHRONOLOGY_INVALID/);
      assert.deepEqual(await durable(f),before,'rejection leaves every durable derived row and receipt byte unchanged');
    } else {
      const result=await successor(path,at),next=path==='direct'?result:result.items[0].insight.current;
      assert.notEqual(next.row.id,old.row.id);assert.equal(next.row.supersedes_id,old.row.id);
      assert.equal(next.row.first_detected_at,at);
      assert.equal((await f.db.raw.execute({sql:'SELECT first_detected_at FROM health_insights WHERE id=?',args:[next.row.id]})).rows[0].first_detected_at,at);
    }
    assert.equal(await leases(f),0);
  });

  test(`M006: ${path} missing/corrupt terminal receipt/revision and redacted predecessor fail closed`,async t=>{
    const {f,old,terminal,successor}=await predecessor(t);
    await mutableTime(f,old.row.id,T);
    const terminalReceipts=(await f.db.raw.execute({sql:"SELECT * FROM phase4_operation_receipts WHERE operation_kind='INSIGHT_TRANSITION' AND semantic_at=?",args:[retiredAt]})).rows;
    assert.equal(terminalReceipts.length,1);const receipt=terminalReceipts[0];
    const revision=(await f.db.raw.execute({sql:'SELECT * FROM insight_revisions WHERE insight_id=? AND revision=?',
      args:[old.row.id,terminal.row.current_revision]})).rows[0];
    for(const [table,row,column] of [['phase4_operation_receipts',receipt,'receipt_hmac'],['insight_revisions',revision,'normalized_claim']]) {
      for(const fault of ['missing','corrupt']) {
        await guards(f,table,()=>f.db.raw.execute(fault==='missing'
          ?{sql:`DELETE FROM ${table} WHERE privacy_artifact_id=?`,args:[row.privacy_artifact_id]}
          :{sql:`UPDATE ${table} SET ${column}=? WHERE privacy_artifact_id=?`,args:[column==='receipt_hmac'?'0'.repeat(64):'CORRUPT',row.privacy_artifact_id]}));
        const before=await durable(f);
        await assert.rejects(successor(path,retiredAt,`${table}-${fault}`),/OPERATION_RESULT_UNAVAILABLE|RECEIPT_INTEGRITY|PARENT_NOT_FOUND|PARENT_STALE/,`${table} ${fault}`);
        assert.deepEqual(await durable(f),before,`${path} ${table} ${fault} must write nothing`);
        await guards(f,table,()=>f.db.raw.execute({sql:`INSERT OR REPLACE INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,args:Object.values(row)}));
      }
    }
    await guards(f,'health_insights',()=>f.db.raw.execute({sql:'UPDATE health_insights SET health_content_redacted_at=? WHERE id=?',args:[retiredAt,old.row.id]}));
    const before=await durable(f);
    await assert.rejects(successor(path,retiredAt,'redacted-predecessor'),/CONTENT_REDACTED/);
    assert.deepEqual(await durable(f),before);assert.equal(await leases(f),0);
  });

  test(`M006: ${path} historical exact replay survives terminal chronology and mutable timestamp drift`,async t=>{
    const {f,old,original,originalRequest,retirement,terminal,successor}=await predecessor(t);
    const result=await successor(path,retiredAt);
    await mutableTime(f,old.row.id,'2026-09-25T12:00:09.000Z');
    const before=await durable(f);
    assert.deepEqual(semantic(await successor(path,retiredAt)),semantic(result));
    assert.deepEqual(semantic(await call(f,'insights','transition',retirement)),semantic(terminal));
    assert.deepEqual(semantic(await call(f,'intelligence','analyzeAssociationFamily',originalRequest)),semantic(original));
    assert.deepEqual(await durable(f),before);assert.equal(await leases(f),0);
  });
}

test('M006: actual Journal purge redacts terminal history and blocks linked successor/replay',async t=>{
  const {f,old,originalRequest,successor}=await predecessor(t);
  const control=await f.stores.capturePrivacyControl('a'),purge=await f.stores.privacy.admit(control,
    {targetType:'JOURNAL_FACT',targetId:f.logicalFacts[0],idempotencyKey:'terminal-predecessor-purge'});
  await f.stores.privacy.redact(control,purge.purge_id);
  assert.equal((await f.stores.privacy.complete(control,purge.purge_id)).state,'COMPLETE');
  const parent=(await f.db.raw.execute({sql:'SELECT * FROM health_insights WHERE id=?',args:[old.row.id]})).rows[0];
  assert.equal(parent.statement,'[HEALTH_CONTENT_REDACTED]');assert.ok(parent.health_content_redacted_at);
  const before=await durable(f);
  await assert.rejects(successor('direct',retiredAt),/REDACTED|STALE|FENCED|UNAVAILABLE/);
  await assert.rejects(call(f,'intelligence','analyzeAssociationFamily',originalRequest),/REDACTED|STALE|FENCED|UNAVAILABLE|NOT_FOUND/);
  assert.deepEqual(await durable(f),before);assert.equal(await leases(f),0);
});

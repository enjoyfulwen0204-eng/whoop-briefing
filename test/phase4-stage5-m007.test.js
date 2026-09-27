import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,identity,insight,retire,retirement,snapshot,preM007Stores } from './stage5M007Fixture.js';
import { guards,semantic,leases,T } from './stage5ReviewBFixture.js';
import { call } from './stage5ClosureFixture.js';
import { INSIGHT_DISCOVERY_BUDGET } from '../src/phase4OperationReceipts.js';

async function hideKey(f,id) {
  await guards(f,'health_insights',()=>f.db.raw.execute({sql:'UPDATE health_insights SET insight_key=? WHERE id=?',args:['f'.repeat(64),id]}));
}
for(const kind of ['direct','association']) {
  test(`M007: ${kind} exact Review B key miss rejects before sealed retirement with zero writes`,async t=>{
    const {f,old,successor}=await fixture(t);await hideKey(f,old.row.id);
    const read=await f.stores.withContext('a',{executionMode:'SHADOW'},c=>f.stores.insights.read(c,old.row.id,{history:true}));
    assert.equal(read.row.insight_key,old.row.insight_key);assert.equal(read.row.retired_at,retirement);
    const before=await snapshot(f);
    await assert.rejects(successor(kind,'2026-09-25T12:00:01.000Z'),/SEMANTIC_CHRONOLOGY_INVALID/);
    const after=await snapshot(f);assert.deepEqual(after,before);assert.equal(await leases(f),0);
    const tables=['evidence_runs','evidence_items','health_insights','insight_revisions','phase4_evidence_result_authorities','phase4_operation_receipts','resource_locks'];
    t.diagnostic(JSON.stringify({kind,before:Object.fromEntries(tables.map(k=>[k,before[k].length])),after:Object.fromEntries(tables.map(k=>[k,after[k].length]))}));
  });

  test(`M007: ${kind} discovers hidden predecessor, links valid successor and preserves exact history/retry`,async t=>{
    const {f,old,original,initialRequest,evidenceId,successor}=await fixture(t);await hideKey(f,old.row.id);
    const result=await successor(kind,'2026-09-25T12:00:02.001Z'),next=insight(kind,result);
    assert.equal(next.row.supersedes_id,old.row.id);assert.equal(next.row.insight_key,old.row.insight_key);
    assert.equal(next.row.first_detected_at,'2026-09-25T12:00:02.001Z');
    const before=await snapshot(f);
    assert.deepEqual(semantic(await successor(kind,'2026-09-25T12:00:02.001Z')),semantic(result));
    assert.deepEqual(semantic(await call(f,'intelligence','analyzeAssociationFamily',initialRequest)),semantic(original));
    assert.deepEqual(await snapshot(f),before);
    // Two authenticated retired ancestors in one chain have one applicable
    // tip. Selection follows sealed lineage, never latest/first materialized ID.
    const support=kind==='direct'?evidenceId:result.items[0].item.row.evidence_item_id;
    await retire(f,next,support,'2026-09-25T12:00:03.000Z');await hideKey(f,next.row.id);
    const third=insight(kind,await successor(kind,'2026-09-25T12:00:04.000Z','m007-third'));
    assert.equal(third.row.supersedes_id,next.row.id);assert.equal(await leases(f),0);
  });

  test(`M007: ${kind} proves genuine absence before admitting an unlinked first incarnation`,async t=>{
    const {f,successor}=await fixture(t,{retired:false});
    assert.equal((await snapshot(f)).health_insights.length,0);
    const result=await successor(kind,T,'m007-first');assert.equal(insight(kind,result).row.supersedes_id,null);
    const before=await snapshot(f);assert.deepEqual(semantic(await successor(kind,T,'m007-first')),semantic(result));
    assert.deepEqual(await snapshot(f),before);assert.equal(await leases(f),0);
  });

  test(`M007: ${kind} concurrent identical absence admissions converge to one incarnation`,async t=>{
    const {f,successor}=await fixture(t,{retired:false});
    const results=await Promise.all([successor(kind,T,'m007-race'),successor(kind,T,'m007-race')]);
    assert.deepEqual(semantic(results[0]),semantic(results[1]));
    assert.equal((await snapshot(f)).health_insights.length,1);assert.equal(await leases(f),0);
  });

  test(`M007: ${kind} multiple genuine pre-repair terminal candidates are ambiguous`,async t=>{
    const {f,old,evidenceId,direct,successor}=await fixture(t),legacy={...f,stores:await preM007Stores(t,f)};
    const second=await call(legacy,'insights','create',direct(retirement,'m007-legacy-unlinked'));
    assert.equal(second.row.supersedes_id,null);
    await retire(legacy,second,evidenceId,'2026-09-25T12:00:03.000Z');
    const before=await snapshot(f);
    await assert.rejects(successor(kind,'2026-09-25T12:00:04.000Z'),/INSIGHT_PREDECESSOR_AMBIGUOUS/);
    if(kind==='direct')await assert.rejects(successor(kind,'2026-09-25T12:00:04.000Z','explicit-pick',{supersedesId:old.row.id}),/INSIGHT_PREDECESSOR_AMBIGUOUS/);
    assert.deepEqual(await snapshot(f),before);assert.equal(await leases(f),0);
  });

  test(`M007: ${kind} corrupt/incomplete/redacted hidden history cannot prove absence`,async t=>{
    const {f,old,successor}=await fixture(t);await hideKey(f,old.row.id);
    const receipt=(await f.db.raw.execute({sql:"SELECT * FROM phase4_operation_receipts WHERE operation_kind='INSIGHT_TRANSITION' AND semantic_at=?",args:[retirement]})).rows[0];
    const revision=(await f.db.raw.execute({sql:'SELECT * FROM insight_revisions WHERE insight_id=? ORDER BY revision DESC LIMIT 1',args:[old.row.id]})).rows[0];
    for(const [table,row,column] of [['phase4_operation_receipts',receipt,'receipt_hmac'],['insight_revisions',revision,'normalized_claim']])for(const fault of ['missing','corrupt']) {
      await guards(f,table,()=>f.db.raw.execute(fault==='missing'?{sql:`DELETE FROM ${table} WHERE privacy_artifact_id=?`,args:[row.privacy_artifact_id]}
        :{sql:`UPDATE ${table} SET ${column}=? WHERE privacy_artifact_id=?`,args:[column==='receipt_hmac'?'0'.repeat(64):'CORRUPT',row.privacy_artifact_id]}));
      const before=await snapshot(f);
      await assert.rejects(successor(kind,'2026-09-25T12:00:04.000Z',`${table}-${fault}`),/RECEIPT_INTEGRITY|OPERATION_RESULT_UNAVAILABLE|PARENT_STALE/);
      assert.deepEqual(await snapshot(f),before);
      await guards(f,table,()=>f.db.raw.execute({sql:`INSERT OR REPLACE INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,args:Object.values(row)}));
    }
    await guards(f,'health_insights',()=>f.db.raw.execute({sql:'UPDATE health_insights SET health_content_redacted_at=? WHERE id=?',args:[retirement,old.row.id]}));
    const before=await snapshot(f);await assert.rejects(successor(kind,'2026-09-25T12:00:04.000Z','redacted'),/CONTENT_REDACTED/);
    assert.deepEqual(await snapshot(f),before);assert.equal(await leases(f),0);
  });
}

test('M007: discovery is user/mode scoped and excludes authenticated unrelated logical identities',async t=>{
  const {f,old,evidenceId,successor}=await fixture(t);await hideKey(f,old.row.id);
  const parent=(await f.db.raw.execute({sql:'SELECT * FROM health_insights WHERE id=?',args:[old.row.id]})).rows[0];
  await guards(f,'health_insights',async()=>{
    for(const [id,user_id,execution_mode] of [[1001,'b','SHADOW'],[1002,'a','LIVE']]) {
      const row={...parent,id,user_id,execution_mode};
      await f.db.raw.execute({sql:`INSERT INTO health_insights(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,args:Object.values(row)});
    }
  });
  const result=await successor('direct',retirement);assert.equal(result.row.supersedes_id,old.row.id);
  const unrelated=await call(f,'insights','create',{identity:{...identity,subject:'unrelated'},claim:'Unrelated candidate',
    evidenceContractVersion:'phase4-evidence-v1',supportingEvidenceIds:[evidenceId],expiresAt:'2026-09-26T12:00:00.000Z',
    creationKey:'unrelated-first',semanticAt:retirement});
  assert.equal(unrelated.row.supersedes_id,null);assert.equal(await leases(f),0);
});

test('M007: hidden predecessor generation mismatch and unauthenticated inventory fail closed',async t=>{
  const {f,old,successor}=await fixture(t);await hideKey(f,old.row.id);
  await guards(f,'health_insights',()=>f.db.raw.execute({sql:'UPDATE health_insights SET input_generation=input_generation+1 WHERE id=?',args:[old.row.id]}));
  let before=await snapshot(f);await assert.rejects(successor('direct',retirement),/PARENT_STALE/);assert.deepEqual(await snapshot(f),before);
  await guards(f,'health_insights',()=>f.db.raw.execute({sql:'UPDATE health_insights SET input_generation=input_generation-1 WHERE id=?',args:[old.row.id]}));
  // A retained parent whose every receipt was lost is unknown, not absent.
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute("DELETE FROM phase4_operation_receipts WHERE operation_kind LIKE 'INSIGHT_%' OR operation_kind='analyzeAssociationFamily'"));
  before=await snapshot(f);await assert.rejects(successor('association',retirement),/OPERATION_RESULT_UNAVAILABLE/);
  assert.deepEqual(await snapshot(f),before);assert.equal(await leases(f),0);
});

test('M007: scoped cap+1 inventories and byte overflow reject before any writes',async t=>{
  const {f,successor}=await fixture(t,{retired:false}),execute=f.db.raw.execute;
  for(const target of ['insights','receipts','revisions','authorities','bytes']) {
    let observed=false;
    f.db.raw.execute=async statement=>{
      const sql=typeof statement==='string'?statement:statement.sql;
      const parent=sql.startsWith('SELECT id FROM health_insights WHERE user_id=? AND execution_mode=?\n      ORDER BY id LIMIT ?');
      const receipt=sql.startsWith('SELECT * FROM phase4_operation_receipts WHERE user_id=? AND execution_mode=?\n      ORDER BY operation_kind,operation_key LIMIT ?');
      const revision=sql.startsWith('SELECT insight_id,revision FROM insight_revisions WHERE user_id=? AND execution_mode=?\n      ORDER BY insight_id,revision LIMIT ?');
      const authority=sql.startsWith('SELECT * FROM phase4_evidence_result_authorities WHERE user_id=? AND execution_mode=?\n      ORDER BY evidence_item_id,result_scope LIMIT ?');
      if(target==='insights'&&parent||(target==='receipts'||target==='bytes')&&receipt||target==='revisions'&&revision||target==='authorities'&&authority) {
        observed=true;assert.deepEqual(statement.args,['a','SHADOW',INSIGHT_DISCOVERY_BUDGET[target==='bytes'?'receipts':target]+1]);
        if(target==='bytes')return {rows:[{request_json:'x'.repeat(INSIGHT_DISCOVERY_BUDGET.bytes+1)}]};
        return {rows:Array.from({length:INSIGHT_DISCOVERY_BUDGET[target]+1},()=>({}))};
      }
      return execute(statement);
    };
    const before=await snapshot(f);
    await assert.rejects(successor('direct',T,`overflow-${target}`),/INSIGHT_DISCOVERY_BOUNDS_UNAVAILABLE/);
    assert.deepEqual(await snapshot(f),before);assert.equal(observed,true);f.db.raw.execute=execute;
  }
  assert.equal(await leases(f),0);
});

for(const retained of ['revision','v26 origin'])test(`M007: a retained ${retained} prevents absence after parent/v27 history loss`,async t=>{
  const {f,successor}=await fixture(t);
  await guards(f,'health_insights',()=>f.db.raw.execute('DELETE FROM health_insights'));
  await guards(f,'phase4_operation_receipts',()=>f.db.raw.execute("DELETE FROM phase4_operation_receipts WHERE operation_kind LIKE 'INSIGHT_%' OR operation_kind='analyzeAssociationFamily'"));
  if(retained==='v26 origin')await guards(f,'insight_revisions',()=>f.db.raw.execute('DELETE FROM insight_revisions'));
  const before=await snapshot(f);
  assert.equal(before.health_insights.length,0);assert.ok(before.phase4_evidence_result_authorities.length>0);
  await assert.rejects(successor('association','2026-09-25T12:00:04.000Z'),/OPERATION_RESULT_UNAVAILABLE/);
  assert.deepEqual(await snapshot(f),before);assert.equal(await leases(f),0);
});

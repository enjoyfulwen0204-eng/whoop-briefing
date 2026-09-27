import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, request, replayInitial, progressOneDay } from './stage5HistoryFixture.js';
import { canonicalInstant } from '../src/phase4Time.js';
import { setup as associationSetup, hypothesis, family } from './stage5AssociationFixture.js';
import { recoveryRefs } from './stage5HistoryFixture.js';
import { call, read } from './stage5ClosureFixture.js';
import { coverageLineage } from '../src/phase4CoverageLineage.js';

const T='2026-09-25T12:00:00.000Z';
async function guards(f,table,fn) {
  const triggers=(await f.db.raw.execute({sql:"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?",args:[table]})).rows;
  for(const trigger of triggers)await f.db.raw.execute(`DROP TRIGGER ${trigger.name}`);
  try{return await fn();}finally{for(const trigger of triggers)await f.db.raw.execute(trigger.sql);}
}
async function durable(f) {
  const rows={};for(const table of ['evidence_runs','evidence_items','observation_episodes','phase4_episode_revisions',
    'episode_events','episode_evidence','episode_observations','health_insights','insight_revisions',
    'phase4_evidence_result_authorities','phase4_operation_receipts','phase4_source_links'])
    rows[table]=(await f.db.raw.execute(`SELECT * FROM ${table}`)).rows;
  return rows;
}

// Independent recursive oracle: capabilities and explicitly operational retry
// flags are excluded; every other field, including unknown future fields, counts.
function semantic(value) {
  if(value===null||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(semantic);
  return Object.fromEntries(Object.entries(value).filter(([key])=>!['ref','created','replayed'].includes(key))
    .map(([key,entry])=>[key,semantic(entry)]));
}

test('A: complete metric return survives restart and later revisions',async t=>{
  const f=await setup(t);
  const first=await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],f.initialRefs.slice(1)));
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows[0].n,1);
  const restarted=await f.restart();
  assert.deepEqual(semantic(await replayInitial(f,'a',f.recoveryIds,restarted.stores)),semantic(first));
  await progressOneDay(f);
  assert.deepEqual(semantic(await replayInitial(f)),semantic(first));
});

test('E: explicit offset and lossless millisecond instant contract',()=>{
  for(const time of ['2026-09-25T12:00:00Z','2026-09-25T20:00:00.000+08:00','2026-09-25T12:00:00.000000Z'])
    assert.equal(canonicalInstant(time),'2026-09-25T12:00:00.000Z');
  for(const time of ['2026-09-25T12:00:00','2026-09-25T12:00:00.000001Z','2026-02-30T12:00:00Z',
    '2026-09-25T24:00:00Z','Fri, 25 Sep 2026 12:00:00 GMT'])assert.throws(()=>canonicalInstant(time));
});

test('D/E: window family changes identity; branded aliases fail without writes',async t=>{
  const f=await setup(t),req=request(f.initialRefs[0],f.initialRefs.slice(1));
  const a=await call(f,'intelligence','analyzeMetric',req);
  const b=await call(f,'intelligence','analyzeMetric',{...req,windowFamily:'OTHER_WINDOW'});
  assert.notEqual(a.run.row.run_id,b.run.row.run_id);
  assert.notEqual(a.episode.episode.row.episode_id,b.episode.episode.row.episode_id);
  const alias={...f.initialRefs[1]},before=await durable(f);
  await assert.rejects(call(f,'intelligence','analyzeMetric',{...req,baselineSources:[...req.baselineSources,alias]}),/SEMANTIC_SOURCE_DUPLICATE/);
  assert.deepEqual(await durable(f),before);
});

test('B/C: column growth and missing roots cannot use generic fallback',async t=>{
  const f=await setup(t),a=await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],f.initialRefs.slice(1)));
  await f.db.raw.execute('ALTER TABLE evidence_runs ADD COLUMN future_semantic_value TEXT');
  const before=await durable(f);
  await assert.rejects(replayInitial(f),/OPERATION_RESULT_UNAVAILABLE/);
  await assert.rejects(read(f,'evidence_runs',{run_id:a.run.row.run_id}),/OPERATION_RESULT_UNAVAILABLE/);
  assert.deepEqual(await durable(f),before);
});

test('A/J: complete insight historical return, direct retry and chronology',async t=>{
  const f=await associationSetup(t,{days:30}),req=family('complete-insight',hypothesis(f,Array.from({length:30},(_,i)=>i)));
  const first=await call(f,'intelligence','analyzeAssociationFamily',req),current=first.items[0].insight.current;
  assert.ok(current);
  const transition={insightId:current.row.id,expectedRevision:current.row.current_revision,status:'RETIRED',disposition:'EXPIRED',
    claim:current.row.statement,supportingEvidenceIds:[first.items[0].item.row.evidence_item_id],reason:'EXPIRED',semanticAt:T};
  const before=await durable(f);
  await assert.rejects(call(f,'insights','transition',{...transition,semanticAt:'2020-01-01T00:00:00Z'}),/CHRONOLOGY/);
  assert.deepEqual(await durable(f),before);
  const retired=await call(f,'insights','transition',transition);
  assert.deepEqual(semantic(await call(f,'insights','transition',transition)),semantic(retired));
  await guards(f,'health_insights',()=>f.db.raw.execute("UPDATE health_insights SET confidence=0.123,expires_at='2026-11-01T00:00:00.000Z',first_detected_at='2000-01-01T00:00:00.000Z'"));
  assert.deepEqual(semantic(await call(f,'intelligence','analyzeAssociationFamily',req)),semantic(first));
  const next=await call(f,'intelligence','analyzeAssociationFamily',{...req,multipleTestingFamily:'new-incarnation'});
  assert.notEqual(next.items[0].insight.current.row.id,current.row.id);
  assert.notEqual(next.items[0].insight.current.row.status,'RETIRED');
  assert.equal(next.items[0].insight.current.row.supersedes_id,current.row.id);
});

test('H: empty association universe is a durable typed result',async t=>{
  const f=await setup(t),req={asOfUtc:T,multipleTestingFamily:'empty',hypotheses:[{factor:'caffeine',outcomeMetric:'recovery_score',lagDays:1,
    comparisonHealthDates:['2026-09-24'],outcomeSources:[],journalFactSources:[],coverageSources:[]}]};
  const result=await call(f,'intelligence','analyzeAssociationFamily',req);
  assert.equal(result.resultState,'EMPTY_ASSOCIATION_UNIVERSE');
  const restarted=await f.restart(),context=await restarted.stores.capture('a',{executionMode:'SHADOW'});
  assert.deepEqual(semantic(await restarted.stores.intelligence.analyzeAssociationFamily(context,req)),semantic(result));
});

test('G: standalone explanation closure survives loss of every naming link',async t=>{
  const f=await setup(t),control=await f.stores.captureControl('a'),sourceText='caffeine at 2026-09-25T10:00:00.000Z';
  const fact=await f.stores.journal.create(control,{sourceEventKey:'standalone-explanation',sourceText,candidate:{category:'caffeine',
    eventAt:'2026-09-25T10:00:00.000Z',valueKind:'PRESENCE',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:sourceText.length}});
  await f.stores.release(f.context);
  const context=await f.stores.capture('a',{executionMode:'SHADOW'}),refs=await recoveryRefs(f.stores,context,f.recoveryIds);
  const a=await call(f,'intelligence','analyzeMetric',request(refs[0],refs.slice(1)));
  const row=(await f.db.raw.execute({sql:'SELECT privacy_artifact_id FROM journal_events WHERE logical_fact_id=?',args:[fact.logicalFactId]})).rows[0];
  const j=(await f.stores.root(context,'JOURNAL_FACT',row.privacy_artifact_id)).ref;
  await call(f,'episodes','revise',{episodeId:a.episode.episode.row.episode_id,expectedRevision:1,toState:'EXPLAINED',
    patch:{explained_status:1,explanation_evidence_item_id:a.item.row.evidence_item_id,explanation_context_id:'private-context',
      explanation_json:{journal:'SENSITIVE_STANDALONE_EXPLANATION'}},sourceRefs:[j,a.item.ref],reasonCode:'CURRENT_EXPLANATION',semanticAt:T});
  await f.db.raw.execute({sql:'DELETE FROM phase4_source_links WHERE source_id=? OR artifact_id=?',args:[row.privacy_artifact_id,row.privacy_artifact_id]});
  await f.stores.release(context);
  const purge=await f.stores.privacy.admit(control,{targetType:'JOURNAL_FACT',targetId:fact.logicalFactId,idempotencyKey:'closure-standalone'});
  await f.stores.privacy.redact(control,purge.purge_id);
  assert.equal((await f.stores.privacy.complete(control,purge.purge_id)).state,'COMPLETE');
  for(const table of ['observation_episodes','phase4_episode_revisions','episode_events','phase4_operation_receipts'])
    for(const value of (await f.db.raw.execute(`SELECT * FROM ${table}`)).rows)
      assert.ok(!JSON.stringify(value).includes('SENSITIVE_STANDALONE_EXPLANATION'));
});

test('I: malformed coverage root is rejected before analysis writes',async t=>{
  const f=await associationSetup(t,{days:30});
  await f.db.raw.execute("UPDATE journal_coverage_windows SET revision=99 WHERE coverage_window_id='coverage-caffeine'");
  const before=await durable(f);
  await assert.rejects(coverageLineage(f.db.raw,'a','coverage-caffeine'),/COVERAGE_LINEAGE_INVALID/);
  assert.deepEqual(await durable(f),before);
});

test('C: every metric reader rejects receipt corruption, missing authority and missing required root',async t=>{
  const f=await setup(t),a=await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],f.initialRefs.slice(1)));
  const readers=[];
  for(const table of ['evidence_runs','evidence_items','observation_episodes','phase4_episode_revisions','episode_events',
    'episode_semantic_events','episode_observations','episode_evidence','phase4_evidence_result_authorities','phase4_operation_receipts']) {
    const row=(await f.db.raw.execute(`SELECT * FROM ${table} LIMIT 1`)).rows[0];
    const info=(await f.db.raw.execute(`PRAGMA table_info(${table})`)).rows;
    const key=Object.fromEntries(info.filter(c=>c.pk&&!['user_id','execution_mode'].includes(c.name)).map(c=>[c.name,row[c.name]]));
    readers.push({table,key});
    assert.ok((await read(f,table,key)).row);
  }
  const receipts=(await f.db.raw.execute('SELECT * FROM phase4_operation_receipts')).rows;
  for(const fault of ['corrupt','missing'])await guards(f,'phase4_operation_receipts',async()=>{
    if(fault==='corrupt')await f.db.raw.execute("UPDATE phase4_operation_receipts SET result_json='null'");
    else await f.db.raw.execute('DELETE FROM phase4_operation_receipts');
    const before=await durable(f);
    for(const reader of readers)await assert.rejects(read(f,reader.table,reader.key),/INTEGRITY|UNAVAILABLE|PARENT_NOT_FOUND/,
      `${reader.table}: ${fault}`);
    assert.deepEqual(await durable(f),before);
    await f.db.raw.execute('DELETE FROM phase4_operation_receipts');
    for(const receipt of receipts) {
      const fields=Object.keys(receipt);
      await f.db.raw.execute({sql:`INSERT INTO phase4_operation_receipts(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,args:fields.map(k=>receipt[k])});
    }
  });
  const root=f.recoveryIds.at(-1);
  await f.db.raw.execute({sql:"DELETE FROM whoop_recoveries WHERE user_id='a' AND sleep_id=?",args:[root]});
  await f.db.raw.execute({sql:'DELETE FROM phase4_source_links WHERE source_id=?',args:[root]});
  const before=await durable(f);
  for(const reader of readers)await assert.rejects(read(f,reader.table,reader.key),/SOURCE_NOT_FOUND|INCOMPLETE_PROVENANCE/,
    `${reader.table}: deleted root`);
  assert.deepEqual(await durable(f),before);
  assert.ok(a.run.row.sample_count>0);
});

test('K: required-root count and serialized bytes match an independent input oracle',async t=>{
  const f=await associationSetup(t,{days:360}),h=hypothesis(f,Array.from({length:360},(_,i)=>i));
  const result=await call(f,'intelligence','analyzeAssociationFamily',family('root-scale',h));
  const rows=(await f.db.raw.execute("SELECT * FROM phase4_operation_receipts WHERE operation_kind='analyzeAssociationFamily'")).rows;
  const roots=JSON.parse(rows[0].required_roots_json),expected=new Set([...h.outcomeSources,...h.journalFactSources,...h.coverageSources]
    .map(ref=>JSON.stringify([ref.executionMode,ref.type,ref.id])));
  expected.add(JSON.stringify(['SHADOW','evidence_items',result.items[0].item.row.privacy_artifact_id]));
  assert.deepEqual(new Set(roots.roots.map(root=>JSON.stringify([root.mode,root.type,root.id]))),expected);
  assert.equal(roots.root_count,expected.size);
  const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
  assert.equal(roots.serialized_bytes,Buffer.byteLength(JSON.stringify(sorted(roots.roots))));
  t.diagnostic(`360-day authority: ${roots.root_count} distinct roots, ${roots.serialized_bytes} canonical bytes`);
});

test('L/N: concurrent equivalent operations converge and release completed leases',async t=>{
  const f=await setup(t);await f.stores.release(f.context);
  const contexts=await Promise.all([f.stores.capture('a',{executionMode:'SHADOW'}),f.stores.capture('a',{executionMode:'SHADOW'})]);
  const refs=[];for(const context of contexts)refs.push(await recoveryRefs(f.stores,context,f.recoveryIds));
  const results=await Promise.all(contexts.map((context,index)=>f.stores.intelligence.analyzeMetric(context,
    request(refs[index][0],index?refs[index].slice(1).reverse():refs[index].slice(1),index?'2026-09-25T20:00:00.000000+08:00':T))));
  assert.deepEqual(semantic(results[0]),semantic(results[1]));
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows[0].n,1);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM resource_locks WHERE name LIKE 'p4ctx:%'")).rows[0].n,0);
  for(const context of contexts)await assert.rejects(f.stores.assertCurrent(context),/CONTEXT_RELEASED/);
});

test('L: receipt insertion failure rolls back every Stage 5 write and releases the lease',async t=>{
  const f=await setup(t),before=await durable(f),execute=f.db.raw.execute;
  f.db.raw.execute=async statement=>{
    const sql=typeof statement==='string'?statement:statement.sql;
    if(sql.startsWith('INSERT INTO phase4_operation_receipts('))throw Error('RECEIPT_INSERT_FAILURE');
    return execute(statement);
  };
  await assert.rejects(f.stores.intelligence.analyzeMetric(f.context,request(f.initialRefs[0],f.initialRefs.slice(1))),/RECEIPT_INSERT_FAILURE/);
  f.db.raw.execute=execute;
  assert.deepEqual(await durable(f),before);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM resource_locks WHERE name LIKE 'p4ctx:%'")).rows[0].n,0);
});

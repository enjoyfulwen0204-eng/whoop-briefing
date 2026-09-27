import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,request } from './stage5HistoryFixture.js';
import { setup as associationSetup,hypothesis,family } from './stage5AssociationFixture.js';
import { call,read } from './stage5ClosureFixture.js';
import { createAnalysisStore } from '../src/analysisStore.js';
import { createDb } from './localDb.js';
import { V23_HEALTH_FIELDS } from '../src/phase4V23Schema.js';

const T='2026-09-25T12:00:00.000Z';
const semantic=value=>Array.isArray(value)?value.map(semantic):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).filter(([key])=>!['ref','created','replayed'].includes(key)).map(([key,value])=>[key,semantic(value)])):value;
const counts=async f=>(await f.db.raw.execute(`SELECT (SELECT count(*) FROM evidence_runs) runs,
  (SELECT count(*) FROM evidence_items) items,(SELECT count(*) FROM phase4_operation_receipts) receipts,
  (SELECT count(*) FROM insight_revisions) revisions`)).rows[0];

test('H: every admitted metric absence state is durable and distinct after restart',async t=>{
  for(const [state,patch,baseline] of [['POSITIVE',{},30],['WARMING_UP',{},0],
    ['NO_CHANGE',{recovery_score:50},30],['NO_DATA',{recovery_score:null},30],['INSUFFICIENT_QUALITY',{updated_at:null},30],
    ['INSUFFICIENT_EVIDENCE',{recovery_score:20},7]])await t.test(state,async t=>{
    const f=await setup(t);
    if(Object.keys(patch).length)await f.db.raw.execute({sql:`UPDATE whoop_recoveries SET ${Object.keys(patch).map(key=>`${key}=?`).join(',')} WHERE user_id='a' AND sleep_id=?`,
      args:[...Object.values(patch),f.recoveryIds[0]]});
    const req=request(f.initialRefs[0],f.initialRefs.slice(1,baseline+1));
    const result=await call(f,'intelligence','analyzeMetric',req);assert.equal(result.resultState,state);
    const restarted=await f.restart();f.stores=restarted.stores;f.context=undefined;f.setNow('2026-10-01T12:00:00Z');
    const before=await counts(f);assert.deepEqual(semantic(await call(f,'intelligence','analyzeMetric',req)),semantic(result));
    assert.deepEqual(await counts(f),before);
    if(state!=='POSITIVE')assert.equal(result.episode,null);
  });
});

test('D/E: metric, as-of, profile, family and canonical set permutations have explicit identity behavior',async t=>{
  const f=await setup(t),base=request(f.initialRefs[0],f.initialRefs.slice(1)),first=await call(f,'intelligence','analyzeMetric',base);
  const alias={windowFamily:base.windowFamily,asOfUtc:'2026-09-25T20:00:00.000000+08:00',baselineSources:[...base.baselineSources].reverse(),
    currentSource:base.currentSource,metricKey:base.metricKey};
  const before=await counts(f);assert.deepEqual(semantic(await call(f,'intelligence','analyzeMetric',alias)),semantic(first));
  assert.deepEqual(await counts(f),before);
  f.setNow('2026-09-25T12:01:00Z');
  const later=await call(f,'intelligence','analyzeMetric',{...base,asOfUtc:'2026-09-25T12:01:00Z'});
  assert.notEqual(later.run.row.run_id,first.run.row.run_id);
  const other=await call(f,'intelligence','analyzeMetric',{...base,metricKey:'hrv'});
  assert.notEqual(other.run.row.run_id,first.run.row.run_id);
  const receipt=(await f.db.raw.execute("SELECT request_json FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric' LIMIT 1")).rows[0];
  const identity=JSON.parse(receipt.request_json);assert.equal(identity.profiles.intelligence.baseline,'robust-baseline-v1');
  assert.equal(identity.profiles.time,'explicit-offset-lossless-milliseconds-v1');
  const unchanged=await counts(f);
  await assert.rejects(call(f,'intelligence','analyzeMetric',{...base,method:'UNREGISTERED'}),/REQUEST_INVALID/);
  assert.deepEqual(await counts(f),unchanged);
});

test('E: a future Journal transaction absent at semantic as-of cannot split operation identity',async t=>{
  const f=await associationSetup(t,{days:10}),h=hypothesis(f,Array.from({length:10},(_,i)=>i)),req=family('future-absent',h);
  const first=await call(f,'intelligence','analyzeAssociationFamily',req);
  f.setNow('2026-09-26T12:00:00Z');
  // A new transaction after as-of; insertion here preserves the input fence
  // so this test isolates historical representation equivalence.
  const old=(await f.db.raw.execute('SELECT * FROM journal_events LIMIT 1')).rows[0];
  const row={...old,id:undefined,logical_fact_id:'future-fact',privacy_artifact_id:'future-private',
    source_event_key:'future-source',created_at:'2026-09-26T12:00:00.000Z',updated_at:'2026-09-26T12:00:00.000Z'};
  delete row.id;const columns=Object.keys(row);
  await f.db.raw.execute({sql:`INSERT INTO journal_events(${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`,args:columns.map(key=>row[key])});
  const c=await f.stores.capture('a',{executionMode:'SHADOW'}),future=(await f.stores.root(c,'JOURNAL_FACT','future-private')).ref;
  await f.stores.release(c);const before=await counts(f);
  assert.deepEqual(semantic(await call(f,'intelligence','analyzeAssociationFamily',{...req,hypotheses:[{...h,journalFactSources:[future,...h.journalFactSources]}]})),semantic(first));
  assert.deepEqual(await counts(f),before);
});

test('D: association factor, outcome, lag, family, generation and algorithm scope independently bind results',async t=>{
  const f=await associationSetup(t,{days:10}),h=hypothesis(f,Array.from({length:10},(_,i)=>i)),base=family('dimensions',h),ids=new Set();
  for(const req of [base,{...base,hypotheses:[{...h,factor:'stress'}]},
    {...base,hypotheses:[{...h,outcomeMetric:'hrv'}]},{...base,hypotheses:[{...h,lagDays:0}]},
    {...base,multipleTestingFamily:'different-family'}]) {
    const result=await call(f,'intelligence','analyzeAssociationFamily',req);ids.add(result.runs[0].row.run_id);
    assert.equal(result.resultState,'NO_INSIGHT');
  }
  assert.equal(ids.size,5);
  await f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
  const next=await call(f,'intelligence','analyzeAssociationFamily',base);assert.ok(!ids.has(next.runs[0].row.run_id));ids.add(next.runs[0].row.run_id);
  await f.db.raw.execute("UPDATE phase4_computation_state SET algorithm_set_version='closure-dimension-profile' WHERE user_id='a' AND execution_mode='SHADOW'");
  const profile=await call(f,'intelligence','analyzeAssociationFamily',base);assert.ok(!ids.has(profile.runs[0].row.run_id));
  const restarted=await f.restart();f.stores=restarted.stores;f.context=undefined;
  assert.deepEqual(semantic(await call(f,'intelligence','analyzeAssociationFamily',base)),semantic(profile));
});

test('H/C: never computed, missing receipt, corrupt and redacted are distinct reader outcomes',async t=>{
  const f=await setup(t);
  await assert.rejects(read(f,'evidence_runs',{run_id:'never-computed'}),/PARENT_NOT_FOUND/);
  const a=await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],[]));
  const guards=(await f.db.raw.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='phase4_operation_receipts'")).rows;
  for(const guard of guards)await f.db.raw.execute(`DROP TRIGGER ${guard.name}`);
  const receipts=(await f.db.raw.execute('SELECT * FROM phase4_operation_receipts')).rows;
  await f.db.raw.execute("UPDATE phase4_operation_receipts SET receipt_hmac='"+'0'.repeat(64)+"'");
  await assert.rejects(read(f,'evidence_runs',{run_id:a.run.row.run_id}),/OPERATION_RECEIPT_INTEGRITY/);
  await f.db.raw.execute('DELETE FROM phase4_operation_receipts');
  await assert.rejects(read(f,'evidence_runs',{run_id:a.run.row.run_id}),/UNAVAILABLE_MISSING_RECEIPT/);
  assert.equal(receipts.length,1);
  await f.db.raw.execute(`UPDATE evidence_runs SET content_state='REDACTED',source_linkage_state='DISCONNECTED',health_content_redaction_reason='SOURCE_DELETED',
    content_digest_salt=NULL,health_content_redacted_at='2026-09-25T12:00:00Z',${V23_HEALTH_FIELDS.evidence_runs.map(field=>`${field}=NULL`).join(',')}`);
  await assert.rejects(read(f,'evidence_runs',{run_id:a.run.row.run_id}),/CONTENT_REDACTED/);
});

test('ownership: every legacy insight mutator rejects authoritative and redacted rows, including v20 compatibility',async t=>{
  const db=createDb({url:':memory:'});t.after(()=>db.close());await db.migrate({targetVersion:20});
  const legacy=createAnalysisStore(db.raw);await db.createUser({id:'legacy',displayName:'Synthetic',timezone:'UTC',status:'ACTIVE'});
  const id=await legacy.createInsight('legacy',{insightType:'synthetic',subject:'x',statement:'original'});
  assert.equal(await legacy.reconfirmInsight('legacy',id,{statement:'updated'}),true);
  assert.equal((await legacy.getInsight('legacy',id)).statement,'updated');
  await db.migrate();assert.ok(await legacy.getInsight('legacy',id),'same store observes migrated shape');
  const f=await associationSetup(t,{days:30}),a=await call(f,'intelligence','analyzeAssociationFamily',family('legacy-writer',hypothesis(f,Array.from({length:30},(_,i)=>i))));
  const store=createAnalysisStore(f.db.raw),row=a.items[0].insight.current.row;
  const before=(await f.db.raw.execute('SELECT * FROM health_insights')).rows;
  assert.equal(await store.getInsight('a',row.id),null);assert.deepEqual(await store.getActiveInsights('a'),[]);
  assert.equal(await store.reconfirmInsight('a',row.id,{statement:'overwrite',evidence:{secret:'replacement'},sampleCount:999,confidence:.1}),false);
  assert.equal(await store.updateInsightStatus('a',row.id,'RETIRED'),false);
  assert.equal(await store.supersedeInsight('a',row.id,{statement:'replacement'}),null);
  assert.deepEqual((await f.db.raw.execute('SELECT * FROM health_insights')).rows,before);
});

test('L: source generation change between preparation and commit rolls back the whole result',async t=>{
  const f=await setup(t),execute=f.db.raw.execute,before=await counts(f);let injected=false;
  f.db.raw.execute=async statement=>{
    const sql=typeof statement==='string'?statement:statement.sql;
    if(!injected&&sql.startsWith('INSERT INTO phase4_operation_receipts(')) {
      injected=true;await execute("UPDATE phase4_user_state SET source_generation=source_generation+1 WHERE user_id='a'");
    }
    return execute(statement);
  };
  await assert.rejects(call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],f.initialRefs.slice(1))),/FENCED|STALE|GENERATION/);
  f.db.raw.execute=execute;assert.equal(injected,true);assert.deepEqual(await counts(f),before);
  assert.equal((await execute("SELECT count(*) n FROM resource_locks WHERE name LIKE 'p4ctx:%'")).rows[0].n,0);
});

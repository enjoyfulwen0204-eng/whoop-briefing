import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,request } from './stage5HistoryFixture.js';
import { call } from './stage5ClosureFixture.js';
import { setup as associationSetup,hypothesis,family } from './stage5AssociationFixture.js';
import { createPhase4Stage6,authorizeStage6ShadowWorker } from '../src/phase4Reanalysis.js';
import { fixture as recurrenceFixture } from './stage6RecurrenceFixture.js';

const T='2026-09-25T12:00:00.000Z';
const worker=(f,at)=>createPhase4Stage6({db:f.db,keys:f.keys,executionMode:'SHADOW',
  workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'}),now:()=>new Date(at)});
const enqueue=async f=>f.stores.queue.sourceChanged(await f.stores.captureControl('a'));
async function drain(f,at) {
  const running=await worker(f,at);
  for(let i=0;i<16&&(await running.diagnostics()).pendingJobs;i++) {
    const result=await running.drain({budget:{maxItemsPerTenant:32,maxItems:64,maxWallMs:90000,leaseMs:120000}});
    assert.equal(result.failedJobs,0,JSON.stringify(result));
  }
  assert.equal((await running.diagnostics()).pendingJobs,0);
}

test('v30 worker refreshes an active custom metric/episode family',async t=>{
  const f=await setup(t,{targetVersion:30}),initial=await call(f,'intelligence','analyzeMetric',
    {...request(f.initialRefs[0],f.initialRefs.slice(1),T),windowFamily:'EXISTING_CANONICAL_CUSTOM_FAMILY'});
  await enqueue(f);await drain(f,T);
  const current=await f.stores.withContext('a',{executionMode:'SHADOW'},context=>
    f.stores.episodes.read(context,initial.episode.episode.row.episode_id));
  assert.equal(current.row.input_generation,1);
  assert.equal(current.row.revision,2);
});

test('v30 worker refreshes a stale supported insight',async t=>{
  const f=await associationSetup(t,{days:30,targetVersion:30});
  const initial=await call(f,'intelligence','analyzeAssociationFamily',
    family('worker-initial',hypothesis(f,Array.from({length:30},(_,i)=>i))));
  const old=initial.items[0].insight.current.row;
  await enqueue(f);await drain(f,T);
  const current=await f.stores.withContext('a',{executionMode:'SHADOW'},context=>
    f.stores.insights.read(context,old.id,{asOfUtc:T}));
  assert.equal(current.row.input_generation,16);
  assert.equal(current.row.current_revision,old.current_revision+1);
});

test('v30 worker opens a normal DAILY episode with no predecessor',async t=>{
  const f=await setup(t,{targetVersion:30});
  await enqueue(f);await drain(f,T);
  const rows=(await f.db.raw.execute({sql:`SELECT * FROM observation_episodes
    WHERE user_id='a' AND execution_mode='SHADOW' AND subject_key='recovery_score'`})).rows;
  assert.ok(rows.some(row=>row.reopens_episode_id===null&&row.input_generation===1));
});

test('v30 worker settles two active families fairly under the same metric',async t=>{
  const f=await setup(t,{targetVersion:30}),base=request(f.initialRefs[0],f.initialRefs.slice(1),T),opened=[];
  for(const windowFamily of ['DAILY_RECOVERY','SECONDARY_RECOVERY'])
    opened.push((await call(f,'intelligence','analyzeMetric',{...base,windowFamily})).episode.episode.row);
  await enqueue(f);await drain(f,T);
  for(const old of opened) {
    const current=await f.stores.withContext('a',{executionMode:'SHADOW'},context=>
      f.stores.episodes.read(context,old.episode_id));
    assert.equal(current.row.input_generation,1);
    assert.equal(current.row.revision,old.revision+1);
  }
});

test('v30 historical custom family beyond recurrence window creates no lifecycle work',async t=>{
  const at='2026-10-10T12:00:01.000Z', {f,old}=await recurrenceFixture(t,
    {targetVersion:30,windowFamily:'OLD_CUSTOM_FAMILY',asOfUtc:at});
  const before=(await f.db.raw.execute({sql:`SELECT count(*) count FROM phase4_operation_receipts
    WHERE operation_kind='analyzeMetric' AND request_json LIKE '%OLD_CUSTOM_FAMILY%'`})).rows[0].count;
  await drain(f,at);
  const rows=(await f.db.raw.execute({sql:'SELECT * FROM observation_episodes WHERE episode_family_key=?',
    args:[old.episode_family_key]})).rows;
  assert.equal(rows.length,1);
  const after=(await f.db.raw.execute({sql:`SELECT count(*) count FROM phase4_operation_receipts
    WHERE operation_kind='analyzeMetric' AND request_json LIKE '%OLD_CUSTOM_FAMILY%'`})).rows[0].count;
  assert.equal(after,before);
});

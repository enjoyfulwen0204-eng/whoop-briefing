import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, request, recoveryRefs } from './stage5HistoryFixture.js';
import { call } from './stage5ClosureFixture.js';

const T='2026-09-25T12:00:00.000Z';
const semantic=value=>Array.isArray(value)?value.map(semantic):value&&typeof value==='object'
  ?Object.fromEntries(Object.entries(value).filter(([key])=>!['ref','created','replayed'].includes(key))
    .map(([key,value])=>[key,semantic(value)])):value;
const count=async f=>(await f.db.raw.execute('SELECT count(*) n FROM phase4_operation_receipts')).rows[0].n;

test('A: expiry wrapper and terminal no-op each replay their complete return after restart',async t=>{
  const f=await setup(t),first=await call(f,'intelligence','analyzeMetric',request(f.initialRefs[0],f.initialRefs.slice(1)));
  const episode=first.episode.episode.row,asOfUtc=new Date(Date.parse(episode.expires_at)+1).toISOString();
  f.setNow(asOfUtc);
  const req={episodeId:episode.episode_id,asOfUtc},expired=await call(f,'intelligence','expireEpisode',req);
  assert.equal(expired.row.state,'EXPIRED');
  const next={...req,asOfUtc:new Date(Date.parse(asOfUtc)+1).toISOString()};f.setNow(next.asOfUtc);
  const noop=await call(f,'intelligence','expireEpisode',next),before=await count(f);
  f.stores=(await f.restart()).stores;f.context=undefined;f.setNow('2027-01-01T12:00:00Z');
  assert.deepEqual(semantic(await call(f,'intelligence','expireEpisode',req)),semantic(expired));
  assert.deepEqual(semantic(await call(f,'intelligence','expireEpisode',next)),semantic(noop));
  assert.equal(await count(f),before);
});

test('A: prepared Body persistence and checkpoint have complete restart replay',async t=>{
  const f=await setup(t),req={asOfEpochMs:Date.parse(T),targetHealthDate:'2026-09-25'};
  await f.stores.release(f.context);f.context=undefined;
  const context=await f.stores.capture('a',{executionMode:'SHADOW'}),ticket=await f.stores.bodyEnergy.prepare(context,req);
  const original=await f.stores.bodyEnergy.persist(context,ticket);
  const checkpointReq={bucketStart:Date.parse(T)-900000},checkpoint=await call(f,'bodyEnergy','checkpoint',checkpointReq);
  f.stores=(await f.restart()).stores;f.setNow('2026-09-26T12:00:00Z');
  await call(f,'bodyEnergy','compute',{asOfEpochMs:Date.parse('2026-09-26T12:00:00Z'),targetHealthDate:'2026-09-26'});
  const before=await count(f);
  assert.deepEqual(semantic(await call(f,'bodyEnergy','compute',req)),semantic(original));
  assert.deepEqual(semantic(await call(f,'bodyEnergy','checkpoint',checkpointReq)),semantic(checkpoint));
  assert.equal(await count(f),before);
});

test('L: concurrent distinct window families commit separate complete authorities',async t=>{
  const f=await setup(t);await f.stores.release(f.context);f.context=undefined;
  const contexts=await Promise.all([0,1].map(()=>f.stores.capture('a',{executionMode:'SHADOW'}))),refs=[];
  for(const context of contexts)refs.push(await recoveryRefs(f.stores,context,f.recoveryIds));
  const reqs=refs.map((sources,index)=>({...request(sources[0],sources.slice(1)),windowFamily:`CONCURRENT_${index}`}));
  const results=await Promise.all(contexts.map((context,index)=>f.stores.intelligence.analyzeMetric(context,reqs[index])));
  assert.notEqual(results[0].run.row.run_id,results[1].run.row.run_id);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows[0].n,2);
  for(let i=0;i<2;i++)assert.deepEqual(semantic(await call(f,'intelligence','analyzeMetric',reqs[i])),semantic(results[i]));
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM resource_locks WHERE name LIKE 'p4ctx:%'")).rows[0].n,0);
});

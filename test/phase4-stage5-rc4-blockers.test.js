import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, request, progressOneDay, replayInitial, semanticProjection, analyzeInserted } from './stage5HistoryFixture.js';

const first = f => f.stores.intelligence.analyzeMetric(f.context,request(f.initialRefs[0],f.initialRefs.slice(1)));

test('RC4 pre/post RC2-H-001: complete R1 semantics and artifact survive later explanation/context changes',async t=>{
  const f=await setup(t),r1=await first(f),r2=await progressOneDay(f);
  const context=await f.stores.capture('a',{executionMode:'SHADOW'});
  const item=await f.stores.readArtifact(context,'evidence_items',{evidence_item_id:r1.item.row.evidence_item_id});
  await f.stores.episodes.revise(context,{episodeId:r1.episode.episode.row.episode_id,expectedRevision:2,toState:'EXPLAINED',
    patch:{explained_status:1,explanation_evidence_item_id:r2.item.row.evidence_item_id,explanation_context_id:'synthetic-context',
      explanation_json:{private:'R3 explanation'},current_context_json:{private:'R3 context'}},
    sourceRefs:[item.ref],reasonCode:'CURRENT_EXPLANATION',semanticAt:'2026-09-26T13:00:00.000Z'});
  const replay=await replayInitial(f);
  assert.deepEqual(semanticProjection(replay.episode.episode.row),semanticProjection(r1.episode.episode.row));
  assert.deepEqual(replay.episode.episode.ref,r1.episode.episode.ref);
});

test('RC4 pre/post RC2-H-002: forged A membership cannot borrow legitimate B revision',async t=>{
  const f=await setup(t),a=await first(f);
  await analyzeInserted(f,{id:'same-time-B',healthDate:'2026-09-25',observedAt:'2026-09-25T12:00:00.000Z',
    asOfUtc:'2026-09-25T12:00:00.000Z',baselineIds:f.recoveryIds.slice(1)});
  await f.db.raw.execute('DROP TRIGGER p4_episode_evidence_envelope_immutable');
  await f.db.raw.execute({sql:'UPDATE episode_evidence SET episode_revision=2 WHERE evidence_item_id=?',args:[a.item.row.evidence_item_id]});
  await assert.rejects(replayInitial(f),/PHASE4_DURABLE_REPLAY_BINDING_INVALID/);
});

test('RC4 pre/post RC2-M-001: deterministic duplicate still requires semantic time',async t=>{
  const f=await setup(t),a=await first(f);
  const change={episodeId:a.episode.episode.row.episode_id,expectedRevision:1,toState:'OPEN',patch:{current_novelty:0},
    sourceRefs:[a.item.ref],reasonCode:'NEW_EVIDENCE'};
  await f.stores.episodes.revise(f.context,{...change,semanticAt:'2026-09-25T13:00:00.000Z'});
  await assert.rejects(f.stores.episodes.revise(f.context,change),/PHASE4_SEMANTIC_TIME_REQUIRED/);
});

test('RC4 pre/post RC2-M-002 / S5-M-003: source permutations preserve full evidence identity',async t=>{
  const f=await setup(t),a=await first(f),baseline=f.initialRefs.slice(1);
  for(const permutation of [[...baseline].reverse(),[...baseline.slice(10),...baseline.slice(0,10)],
    baseline.filter((_,i)=>i%2).concat(baseline.filter((_,i)=>!(i%2)))]) {
    const b=await f.stores.intelligence.analyzeMetric(f.context,request(f.initialRefs[0],permutation));
    assert.deepEqual(b.quality,a.quality);assert.deepEqual(b.baseline,a.baseline);
    for(const field of ['input_manifest_json','input_manifest_hash','run_id'])assert.equal(b.run.row[field],a.run.row[field]);
    assert.equal(b.item.row.evidence_item_id,a.item.row.evidence_item_id);
    assert.deepEqual(semanticProjection(b.episode.episode.row),semanticProjection(a.episode.episode.row));
  }
});

test('RC4 pre/post RC3-H-001: every committed revision has durable full history',async t=>{
  const f=await setup(t),a=await first(f);await progressOneDay(f);
  const tables=(await f.db.raw.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='phase4_episode_revisions'")).rows;
  assert.equal(tables.length,1,'v24 has no authoritative revision history table');
  const rows=(await f.db.raw.execute('SELECT * FROM phase4_episode_revisions ORDER BY revision')).rows;
  assert.equal(rows.length,2);assert.deepEqual(JSON.parse(rows[0].snapshot_json).episode,semanticProjection(a.episode.episode.row));
});

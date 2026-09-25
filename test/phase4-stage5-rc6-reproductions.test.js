import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, request, replayInitial, syntheticEvidence, historyCounts } from './stage5HistoryFixture.js';

const T='2026-09-25T12:00:00.000Z';
const first=f=>f.stores.intelligence.analyzeMetric(f.context,request(f.initialRefs[0],f.initialRefs.slice(1)));

test('RC6 pre/post H001: authentic R2 genuinely reuses A+B, forged A membership cannot select R2 after restart',async t=>{
  const f=await setup(t),a=await first(f),b=await syntheticEvidence(f,f.context,'reuse-B');
  const episodeId=a.episode.episode.row.episode_id,itemId=a.item.row.evidence_item_id;
  await f.stores.episodes.revise(f.context,{episodeId,expectedRevision:1,toState:'OPEN',
    patch:{latest_evidence_item_id:itemId,current_novelty:0},sourceRefs:[a.item.ref,b.ref],reasonCode:'NEW_EVIDENCE',semanticAt:T});
  const event=(await f.db.raw.execute('SELECT * FROM episode_events WHERE resulting_revision=2')).rows[0];
  assert.ok(JSON.parse(event.evidence_references_json).some(ref=>ref[1]===itemId));
  assert.equal((await f.stores.episodes.readRevision(f.context,{episodeId,revision:2})).row.revision,2);
  const guard=(await f.db.raw.execute("SELECT sql FROM sqlite_master WHERE name='p4_episode_evidence_envelope_immutable'")).rows[0].sql;
  await f.db.raw.execute('DROP TRIGGER p4_episode_evidence_envelope_immutable');
  await f.db.raw.execute({sql:'UPDATE episode_evidence SET episode_revision=2 WHERE evidence_item_id=?',args:[itemId]});
  await f.db.raw.execute(guard);
  const before=await historyCounts(f.db);
  const restarted=await f.restart();
  await assert.rejects(replayInitial(f,'a',f.recoveryIds,restarted.stores),/PHASE4_DURABLE_REPLAY_BINDING_INVALID/);
  assert.deepEqual(await historyCounts(f.db),before);
});

test('RC6 pre/post H002: deleting required baseline root AND every naming edge cannot authorize history after restart',async t=>{
  const f=await setup(t),a=await first(f),episodeId=a.episode.episode.row.episode_id;
  const replay=(stores,context)=>stores.episodes.readRevision(context,{episodeId,revision:1,evidenceItemId:a.item.row.evidence_item_id});
  await replay(f.stores,f.context);
  const root=f.recoveryIds.at(-1);
  await f.db.raw.execute({sql:'DELETE FROM whoop_recoveries WHERE user_id=? AND sleep_id=?',args:['a',root]});
  await assert.rejects(replay(f.stores,f.context));
  await f.db.raw.execute({sql:"DELETE FROM phase4_source_links WHERE user_id=? AND source_type='recovery' AND source_id=?",args:['a',root]});
  const restarted=await f.restart(),context=await restarted.stores.capture('a',{executionMode:'SHADOW'});
  await assert.rejects(replay(restarted.stores,context));
});

test('RC6 pre/post M001: equivalent insight expiry instants agree at the exclusive boundary',async t=>{
  const f=await setup(t),item=await syntheticEvidence(f,f.context,'expiry');
  const insight=await f.stores.insights.create(f.context,{identity:{subject:'test',outcome:'test',direction:'up',
    exposureCategory:'test',algorithmFamily:'test',evidenceContractMajor:'1'},claim:'Synthetic',creationKey:'expiry',
    evidenceContractVersion:'fixture',supportingEvidenceIds:[item.row.evidence_item_id],expiresAt:'2026-09-26T12:00:00.000Z',semanticAt:T});
  for(const asOfUtc of ['2026-09-26T12:00:00.000Z','2026-09-26T05:00:00.000-07:00',
    '2026-09-26T19:00:00.000+07:00','2026-09-26T12:00:00Z'])
    await assert.rejects(f.stores.insights.read(f.context,insight.row.id,{asOfUtc}),/PHASE4_INSIGHT_NOT_CURRENT/,asOfUtc);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, request, syntheticEvidence, semanticProjection } from './stage5HistoryFixture.js';

test('RC3-H-001 diagnostic: overwritten revision payload remains durable solely in full history',async t=>{
  const f=await setup(t),first=await f.stores.intelligence.analyzeMetric(f.context,request(f.initialRefs[0],f.initialRefs.slice(1))),
    id=first.episode.episode.row.episode_id;
  const originals=[];
  for(const revision of [2,3]) {
    const item=await syntheticEvidence(f,f.context,`diagnostic-evidence-${revision}`);
    await f.stores.episodes.revise(f.context,{episodeId:id,expectedRevision:revision-1,toState:'EXPLAINED',
      patch:{explained_status:1,explanation_evidence_item_id:item.row.evidence_item_id,explanation_context_id:`diagnostic-context-${revision}`,
        explanation_json:{value:revision===2?'RC3_OVERWRITTEN_EXPLANATION':'LATEST_EXPLANATION'},
        current_context_json:{value:revision===2?'RC3_OVERWRITTEN_CONTEXT':'LATEST_CONTEXT'}},sourceRefs:[item.ref],
      reasonCode:'CURRENT_EXPLANATION',semanticAt:`2026-09-25T${10+revision}:00:00.000Z`});
    originals.push(await f.stores.episodes.read(f.context,id));
  }
  const matches=[];
  for(const {name} of (await f.db.raw.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows) {
    const content=JSON.stringify((await f.db.raw.execute(`SELECT * FROM "${name}"`)).rows);
    if(content.includes('RC3_OVERWRITTEN_EXPLANATION')&&content.includes('RC3_OVERWRITTEN_CONTEXT'))matches.push(name);
  }
  assert.deepEqual(matches,['phase4_episode_revisions'],'v24 overwrote both semantic values everywhere in durable storage');
  const restarted=await f.restart(),context=await restarted.stores.capture('a',{executionMode:'SHADOW'});
  for(const [index,original] of originals.entries())assert.deepEqual(semanticProjection((await restarted.stores.episodes.readRevision(context,
    {episodeId:id,revision:index+2})).row),semanticProjection(original.row));
});

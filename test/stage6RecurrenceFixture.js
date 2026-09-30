import assert from 'node:assert/strict';
import { setup,request,recoveryRefs } from './stage5HistoryFixture.js';
import { call } from './stage5ClosureFixture.js';
import { canonicalEpisodeData } from '../src/phase4IntelligenceStore.js';

export const TERMINAL='2026-09-27T12:00:00.000Z',NEXT='2026-09-28T12:00:01.000Z';
export const identity={algorithmMajor:'phase4-intelligence-v1',domain:'recovery',metric:'recovery_score',subject:'recovery_score',
  windowFamily:'DAILY_RECOVERY',direction:'LOWER'};
export async function journal(f,key,at) {
  const sourceText=`caffeine at ${at}`;
  const result=await f.stores.journal.create(await f.stores.captureControl('a'),{sourceEventKey:key,sourceText,
    candidate:{category:'caffeine',eventAt:at,valueKind:'PRESENCE',exposureState:'EXPOSED',extractionConfidence:1,
      excerptStart:0,excerptEnd:sourceText.length}});
  assert.equal(result.status,'ACCEPT');
}
export async function fixture(t,{windowFamily='DAILY_RECOVERY',asOfUtc=NEXT,active=false,mutate=true,targetVersion=28}={}) {
  const f=await setup(t,{targetVersion});
  for(let i=0;i<15;i++)await journal(f,`initial-${i}`,'2026-09-25T11:00:00.000Z');
  const req=(current,baseline,at)=>({...request(current,baseline,at),windowFamily});
  const opened=await call(f,'intelligence','analyzeMetric',req(f.initialRefs[0],f.initialRefs.slice(1),'2026-09-25T12:00:00.000Z'));
  assert.equal(opened.episode.episode.row.input_generation,15);
  let old=opened.episode.episode.row;
  if(!active) {
    f.setNow('2026-09-26T12:00:00.000Z');
    await f.db.raw.execute(`INSERT INTO whoop_recoveries(user_id,sleep_id,health_date,score_state,recovery_score,
      hrv_rmssd_milli,resting_heart_rate,user_calibrating,updated_at,synced_at)
      VALUES ('a','normal-reopen','2026-09-26','SCORED',50,50,60,0,'2026-09-26T10:00:00.000Z','2026-09-26T12:00:00.000Z')`);
    const context=await f.stores.capture('a',{executionMode:'SHADOW'}),refs=await recoveryRefs(f.stores,context,['normal-reopen',...f.recoveryIds.slice(0,30)]);
    const stable=await call(f,'intelligence','analyzeMetric',req(refs[0],refs.slice(1),'2026-09-26T12:00:00.000Z'));
    assert.equal(stable.episode.episode.row.state,'STABILIZING');
    f.setNow(TERMINAL);
    old=(await call(f,'intelligence','analyzeMetric',req(refs[0],refs.slice(1),TERMINAL))).episode.episode.row;
    assert.equal(old.state,'RESOLVED');
  }
  f.setNow(asOfUtc);
  const observedAt=new Date(Date.parse(asOfUtc)-7200000).toISOString();
  await f.db.raw.execute({sql:`INSERT INTO whoop_recoveries(user_id,sleep_id,health_date,score_state,recovery_score,
    hrv_rmssd_milli,resting_heart_rate,user_calibrating,updated_at,synced_at) VALUES ('a','recur-low',?,'SCORED',10,50,60,0,?,?)`,
    args:[observedAt.slice(0,10),observedAt,asOfUtc]});
  if(mutate)await journal(f,'generation-16',new Date(Date.parse(asOfUtc)-3600000).toISOString());
  const context=await f.stores.capture('a',{executionMode:'SHADOW'}),refs=await recoveryRefs(f.stores,context,['recur-low',...f.recoveryIds.slice(1)]);
  const analysis={...req(refs[0],refs.slice(1),asOfUtc),refresh:true};
  const prepared=await call(f,'intelligence','analyzeMetric',analysis);
  const metricIdentity={...identity,windowFamily};
  const openRequest=(evidence=prepared)=>{
    const manifest=JSON.parse(evidence.run.row.input_manifest_json),calculation=evidence.calculation;
    return {recurrence:true,predecessorRevision:old.revision,identity:metricIdentity,reopensEpisodeId:old.episode_id,
      data:canonicalEpisodeData({timezone:'Asia/Taipei'},{current:manifest.current,calculation,asOfUtc,
        confidence:JSON.parse(evidence.item.row.provenance_json).confidence}),evidenceItemId:evidence.item.row.evidence_item_id,semanticAt:asOfUtc,
      semanticEvent:{eventKind:'OPENED',severityOrdinal:calculation.severity,claimKey:'metric:recovery_score',semanticContentHash:calculation.semanticHash}};
  };
  return {f,old,opened,analysis,prepared,openRequest,identity:metricIdentity};
}

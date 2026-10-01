import test from 'node:test';
import assert from 'node:assert/strict';
import { renderFallback, renderSyncAnswer } from '../src/bot/answer.js';
import { renderDataQuality } from '../src/dataQuality.js';
import { renderEvidence } from '../src/evidence.js';
import { renderCost } from '../src/usage.js';
import { renderPersonalHealthspan } from '../src/healthspanEngine.js';
import { urgentReply, symptomEducationReply } from '../src/bot/triage.js';
import { educationAnswer } from '../src/bot/healthEducation.js';
import { PERSPECTIVE } from '../src/bot/perspective.js';

const chinese = /[\u3400-\u9fff]/u;

test('health Q&A and emergency copy remain in each target locale without changing computed facts', () => {
  const trend = {
    available:true, intent:'trend_query', metric:'hrv', current_display:'65.5 ms',
    window:{ window_days:30, mean_display:'62 ms', n:18 },
    trends:{ '30d':{ sufficient:true, direction:'IMPROVING' } },
  };
  const cause = {
    available:true, intent:'cause_query',
    facts:[{ key:'recovery', display:'55%', comparable:true, noteworthy:true,
      baseline_display:'70%' }],
    contributors:[{ category:'alcohol', temporal:'after' }],
    not_ready_metrics:['hrv'],
  };
  const readiness = {
    available:true, intent:'readiness_query', all_ready:false,
    has_today_facts:true, not_ready_metrics:['hrv'], calibrating:true,
    min_samples_needed:5,
  };
  const sync = { verdict:'STALE_SUCCESS', last_success_at:'2026-09-01T00:00:00Z',
    now:'2026-09-02T00:00:00Z', latest_health_date:'2026-09-01' };
  for (const locale of ['en','vi']) {
    for (const text of [
      renderFallback(trend, locale), renderFallback(cause, locale),
      renderFallback(readiness, locale), renderSyncAnswer(sync, locale),
      urgentReply(locale), symptomEducationReply(locale),
      educationAnswer({ text:'喝酒會讓人累嗎', perspective:PERSPECTIVE.GENERAL, locale }).text,
    ]) {
      assert.doesNotMatch(text, chinese, locale);
      assert.doesNotMatch(text, /undefined|null|LOCALIZATION_|Kelvin/);
    }
    assert.match(renderFallback(trend, locale), locale === 'vi' ? /65,5 ms/ : /65\.5 ms/);
    assert.match(renderFallback(cause, locale), /55%/);
  }
});

test('data, evidence, usage and longer-term overview render without internal codes in English and Vietnamese', () => {
  const quality = {
    state:'READY', has_any_health_data:true, history_start:'2026-09-01',
    history_end:'2026-09-10', coverage_days:10, missing_days:1, coverage_ratio:0.9,
    sleep_count:9,recovery_count:8,valid_recoveries:7,cycle_count:9,
    workout_count:2,nap_count:1,unscored_records:1,days_behind:0,journal_count:3,
    capabilities:{ probed:true,lastProbedAt:'2026-09-10T12:00:00Z',
      counts:{ SUPPORTED:3,PARTIAL:1,UNAVAILABLE:0,UNKNOWN:1 } },
    backfill_status:{ sleep:{ complete:true }, recovery:{ complete:false } },
    backfill_complete:false, missing_scopes:[],
  };
  const evidence = { available:true, cards:[{
    metric:'hrv',method:'linear_trend',sample_count:18,effect:0.4,
    confidence:'MODERATE',date_range:{from:'2026-09-01',to:'2026-09-10'},
    warnings:[],
  }] };
  const cost = { available:true,today:'2026-09-10',month:'2026-09',
    todaySummary:{ calls:1,failed_calls:0,calls_with_unknown_cost:0,
      total_cost_usd:0.003,groups:{ model:{calls:1,unknown_cost_calls:0,cost:0.003} } },
    monthSummary:{ calls:1,failed_calls:0,calls_with_unknown_cost:0,
      total_cost_usd:0.003,groups:{ model:{calls:1,unknown_cost_calls:0,cost:0.003} } },
  };
  const healthspan = { maturity:'LIMITED',scopedCount:2,usableCount:1,historyDays:45,
    historyTier:'一個月',algorithmVersion:'v1',contributors:[
      { metricKey:'hrv',availability:'AVAILABLE',sampleCount:18 },
      { metricKey:'sleep_duration',availability:'PARTIAL',sampleCount:9 },
    ], scoringPolicyActive:false };
  for (const locale of ['en','vi']) {
    for (const text of [
      renderDataQuality(quality,locale),renderEvidence(evidence,locale),
      renderCost(cost,locale),renderPersonalHealthspan(healthspan,locale),
    ]) {
      assert.doesNotMatch(text,chinese,locale);
      assert.doesNotMatch(text,/linear_trend|sleep_duration|MODERATE|undefined|null|Kelvin/);
    }
  }
});

import test from 'node:test';import assert from 'node:assert/strict';
import {renderJournalWeek,summarizeJournalWeek} from '../src/stage7WeeklyReview.js';
import {TOPICS,JOURNAL_COPY} from '../src/stage7Registry.js';
for(const locale of ['zh-TW','en','vi'])test(`weekly hides zeros/unknowns, selects nearest evidence and preserves input numbers (${locale})`,()=>{
 const summary=summarizeJournalWeek({facts:[{health_date:'2026-10-27',category:'alcohol',exposure_state:'EXPOSED',fact_status:'ACTIVE',content_state:'PRESENT'}],history:[],topics:TOPICS,startDate:'2026-10-26',endDate:'2026-11-01'});
 summary.onDemand={topics:TOPICS.map((topic,i)=>({topic,status:'INSUFFICIENT',exposed:i<3?i+1:0,unexposed:i<3?i+2:0,metrics:[]}))};
 const frozen=JSON.stringify(summary),result=renderJournalWeek(summary,locale);assert.equal(JSON.stringify(summary),frozen);assert.equal(result.summary,summary);
 assert.match(result.text,/1\/7/);assert.doesNotMatch(result.text,/undefined|0\/7|🤔|⏭/);
 const c=JOURNAL_COPY[locale];assert.ok(!result.text.includes(c.unknown+':'));assert.ok(!result.text.includes(c.notAsked+':'));
 assert.equal(result.text.split('\n').filter(x=>/5/.test(x)).length,2); // only two nonzero insufficient topics
});

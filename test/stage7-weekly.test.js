import test from 'node:test';import assert from 'node:assert/strict';
import {stage7Fixture} from './stage7Fixture.js';
import {summarizeJournalWeek,renderJournalWeek} from '../src/stage7WeeklyReview.js';
test('weekly frequency is observed days, NO is coverage, unknown is missing and three locales make no causal claim',()=>{
 const fact=(day,state)=>({health_date:day,category:'caffeine',exposure_state:state,fact_status:'ACTIVE',content_state:'PRESENT'});
 const summary=summarizeJournalWeek({facts:[fact('2026-09-14','EXPOSED'),fact('2026-09-14','EXPOSED'),fact('2026-09-15','CONFIRMED_UNEXPOSED')],history:[{target_date:'2026-09-14',selected_choice:'YES'},{target_date:'2026-09-15',selected_choice:'NOT_SURE'},{target_date:'2026-09-16',selected_choice:null}],topics:['caffeine'],startDate:'2026-09-14',endDate:'2026-09-20'});
 assert.equal(summary.daysRecorded,2);assert.equal(summary.frequency.caffeine,1);assert.equal(summary.coverage.caffeine,2);assert.equal(summary.responses.NO_RESPONSE,1);assert.equal(summary.responses.NOT_ASKED,4);
 for(const locale of ['zh-TW','vi','en'])assert.ok(!renderJournalWeek(summary,locale).text.includes('undefined'));
});
test('on-demand weekly review uses own canonical facts; automatic weekly preference is default off',async t=>{
 const f=await stage7Fixture(t),actor=await f.companion.interactions.authenticate({user:f.user,chatId:'123'});
 const result=await f.companion.weekly.build(actor);assert.equal(result.summary.daysRecorded,0);assert.equal(result.summary.associations.length,0);
 const prefs=await f.db.transaction(()=>f.companion.preferences(actor));assert.equal(prefs.weekly_enabled,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,0);
});

test('weekly review reserves one week identity but never grants automatic rollout from a preference',async t=>{
 const f=await stage7Fixture(t),actor=await f.companion.interactions.authenticate({user:f.user,chatId:'123'});
 const first=await f.companion.weekly.prepare(actor),second=await f.companion.weekly.prepare(actor);
 assert.equal(first.deliveryId,second.deliveryId);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_prompt_deliveries')).rows[0].n,1);
 await f.db.transaction(async()=>{const prefs=await f.companion.preferences(actor);await f.companion.changePreferences(actor,prefs,{weekly_enabled:1});});
 assert.equal((await f.companion.weekly.prepare(actor,{automatic:true})).status,'ROLLOUT_NOT_APPROVED');
});

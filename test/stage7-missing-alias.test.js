import test from 'node:test';
import assert from 'node:assert/strict';
import {stage7Fixture} from './stage7Fixture.js';
import {createStage7Development} from '../src/stage7Development.js';

async function pending(t){
 const f=await stage7Fixture(t,{now:()=>new Date('2026-09-21T00:00:00Z')});
 await f.db.setLocale('a','en',{now:f.core.now()});
 const actor=await f.companion.interactions.authenticate({user:f.user,chatId:'123'});
 const origin=(await f.companion.interactions.issue(actor,{kind:'DAILY',category:'alcohol',targetDate:'2026-09-20'})).row;
 return {...f,actor,origin};
}
async function openAlias(f){let card=await f.command();card=await f.tap(card,'Recent entries');return f.tap(card,'Alcohol');}

for(const [label,state] of [['Not sure','NOT_SURE'],['Skip','SKIPPED']])test(`renewed daily ${state} closes its original identity, counts once, and fences other aliases after restart`,async t=>{
 const f=await pending(t);
 await f.db.setLocale('a','vi',{now:f.core.now()});await f.db.setLocale('a','en',{now:f.core.now()});
 let card=await openAlias(f);const stale=await openAlias(f);card=await f.tap(card,label);
 const origin=await f.companion.interactions.read('a',f.origin.interaction_id),alias=await f.companion.interactions.read('a',card.stage7InteractionId);
 assert.equal(origin.state,state);assert.equal(origin.selected_choice,state);assert.equal(origin.revision,f.origin.revision+1);assert.ok(origin.answered_at);
 assert.equal(JSON.parse(alias.diagnostics_json).answerAnchor.revision,origin.revision);
 const actor=await f.companion.interactions.authenticate({user:f.user,chatId:'123'}),weekly=await f.companion.weekly.build(actor);
 assert.equal(weekly.summary.responses[state],1);assert.equal(weekly.summary.responses.NO_RESPONSE,0);assert.equal(weekly.summary.daysRecorded,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 assert.match((await f.tap(stale,'Yes')).text,/expired/i);
 const restarted=await f.restart(),companion=await createStage7Development({...restarted,db:f.db});
 const button=stale.replyMarkup.inline_keyboard.flat().find(b=>b.text.includes('No'));
 const replay=await companion.handle({user:f.user,chatId:'123',callback:{id:'restart-old-alias',data:button.callback_data,from:{id:123},message:{message_id:42,chat:{id:123,type:'private'}}}});
 assert.match(replay.text,/expired/i);
 // The winning card retains a current anchor and can still be corrected.
 card=await f.tap(card,'Edit');card=await f.tap(card,'No');await f.tap(card,'Confirm');
 assert.equal((await f.companion.interactions.read('a',origin.interaction_id)).state,'COMPLETED');
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,1);
});

test('fresh missing-history edits update the original missingness and retract all copies',async t=>{
 const f=await pending(t);let card=await f.companion.card(f.actor,f.origin);
 await f.companion.interactions.bind(f.actor,f.origin.interaction_id,42);await f.tap(card,'Not sure');
 card=await openAlias(f);card=await f.tap(card,'Edit');card=await f.tap(card,'Skip');
 const origin=await f.companion.interactions.read('a',f.origin.interaction_id);assert.equal(origin.state,'SKIPPED');
 const weekly=await f.companion.weekly.prepare(f.actor);assert.equal(weekly.summary.responses.SKIPPED,1);assert.equal(weekly.summary.responses.NOT_SURE,0);
 await f.tap(card,'Retract');
 assert.equal((await f.companion.interactions.read('a',origin.interaction_id)).content_state,'REDACTED');
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM quick_action_interactions WHERE category='alcohol' AND content_state='PRESENT'")).rows[0].n,0);
 assert.equal((await f.db.raw.execute({sql:'SELECT payload_json FROM journal_prompt_deliveries WHERE delivery_id=?',args:[weekly.deliveryId]})).rows[0].payload_json,null);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
});

test('an alias persistence failure rolls back its original missing answer and permits a safe retry',async t=>{
 const f=await pending(t),card=await openAlias(f);
 await f.db.raw.execute("CREATE TRIGGER stage7_missing_failure BEFORE UPDATE ON quick_action_interactions WHEN NEW.kind='QUICK' AND NEW.state='NOT_SURE' AND OLD.state='ISSUED' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_MISSING_ALIAS_FAILURE'); END");
 await assert.rejects(f.tap(card,'Not sure'),/SYNTHETIC_MISSING_ALIAS_FAILURE/);
 const original=await f.companion.interactions.read('a',f.origin.interaction_id);assert.equal(original.state,'ISSUED');assert.equal(original.revision,f.origin.revision);assert.equal(original.answered_at,null);
 assert.equal((await f.companion.interactions.read('a',card.stage7InteractionId)).state,'ISSUED');
 await f.db.raw.execute('DROP TRIGGER stage7_missing_failure');await f.tap(card,'Not sure');
 assert.equal((await f.companion.interactions.read('a',f.origin.interaction_id)).state,'NOT_SURE');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {stage7Fixture} from './stage7Fixture.js';
import {createStage7Development} from '../src/stage7Development.js';

async function acceptedDaily(t,options={}){
 const f=await stage7Fixture(t,{now:()=>new Date('2026-09-21T00:00:00Z'),...options});await f.db.setLocale('a','en',{now:f.core.now()});
 const actor=await f.companion.interactions.authenticate({user:f.user,chatId:'123'});
 const origin=(await f.companion.interactions.issue(actor,{kind:'DAILY',category:'alcohol',targetDate:'2026-09-20',dayKey:f.core.keys.lookup(['journal-day-v1','a','2026-09-21'])})).row;
 let card=await f.companion.card(actor,origin);await f.companion.interactions.bind(actor,origin.interaction_id,42);
 card=await f.tap(card,'Yes');card=await f.tap(card,'Add note');card=await f.companion.handleNote({user:f.user,chatId:'123',text:'old synthetic private note'});card=await f.tap(card,'Confirm');
 const fact=(await f.db.raw.execute('SELECT * FROM journal_events')).rows[0];return {...f,actor,origin,fact,card};
}
let sequence=0;
async function tapWith(companion,user,card,label){
 const button=card.replyMarkup.inline_keyboard.flat().find(b=>b.text.includes(label));assert.ok(button,label);
 if(card.stage7InteractionId)await companion.interactions.bind(await companion.interactions.authenticate({user,chatId:'123'}),card.stage7InteractionId,42);
 return companion.handle({user,chatId:'123',callback:{id:`missing-correction-${++sequence}`,data:button.callback_data,from:{id:123},message:{message_id:42,chat:{id:123,type:'private'}}}});
}
async function assertMissing(f,companion,state){
 const rows=(await f.db.raw.execute("SELECT * FROM quick_action_interactions WHERE content_state='PRESENT' AND json_extract(diagnostics_json,'$.dailyAnswerKey') IS NOT NULL")).rows;
 assert.equal(rows.length,1);const row=rows[0];assert.equal(row.state,state);assert.equal(row.selected_choice,state);assert.equal(row.target_date,'2026-09-20');assert.ok(row.answered_at);
 assert.equal(row.logical_fact_id,null);assert.equal(row.detail_choice,null);assert.equal(row.note,null);assert.equal(JSON.parse(row.diagnostics_json).missingCorrection,undefined);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 const origin=await companion.interactions.read('a',f.origin.interaction_id);assert.equal(origin.content_state,'REDACTED');assert.equal(origin.category,null);assert.equal(origin.note,null);assert.equal(origin.selected_choice,null);
 assert.equal((await f.db.raw.execute({sql:"SELECT count(*) n FROM phase4_source_links WHERE artifact_id=? AND source_type='JOURNAL_FACT'",args:[row.privacy_artifact_id]})).rows[0].n,0);
 const actor=await companion.interactions.authenticate({user:f.user,chatId:'123'}),weekly=await companion.weekly.prepare(actor);
 assert.equal(weekly.summary.responses[state],1);assert.equal(weekly.summary.responses.NO_RESPONSE,0);assert.equal(weekly.summary.daysRecorded,0);
 return {row,weekly,actor};
}

for(const [label,state] of [['Not sure','NOT_SURE'],['Skip','SKIPPED']])test(`accepted daily fact → ${state} retains only the independent missing assertion and its daily identity`,async t=>{
 const f=await acceptedDaily(t);let card=await f.tap(f.card,'Edit');card=await f.tap(card,label);
 assert.match(card.text,state==='NOT_SURE'?/Not sure/:/Skip/);assert.equal(card.editMessageId,'42');const {row,weekly}=await assertMissing(f,f.companion,state);
 await f.tap(card,'Retract');assert.equal((await f.companion.interactions.read('a',row.interaction_id)).content_state,'REDACTED');
 assert.equal((await f.db.raw.execute({sql:'SELECT payload_json FROM journal_prompt_deliveries WHERE delivery_id=?',args:[weekly.deliveryId]})).rows[0].payload_json,null);
 await f.db.raw.execute({sql:"INSERT INTO report_claims(user_id,report_type,local_date,owner,claimed_at,expires_at,lifecycle_generation,delivery_state,telegram_message_id) VALUES('a','daily','2026-09-21','synthetic',?,?,1,'DELIVERED',11)",args:[f.core.timestamp(),f.core.timestamp()]});
 await f.db.transaction(async()=>{const p=await f.companion.preferences(f.actor);await f.companion.changePreferences(f.actor,p,{daily_enabled:1});});
 assert.equal((await f.companion.prepareAfterBrief({user:f.user,chatId:'123',healthDay:'2026-09-21'})).status,'EXISTING','the scrubbed original day barrier still prevents another question');
});

for(const phase of ['BEFORE_PURGE','AFTER_COMPLETED_PURGE'])test(`durable missing correction resumes after ${phase}, expiry and profile ABA without restoring old content`,async t=>{
 let clock=new Date('2026-09-21T00:00:00Z');const f=await acceptedDaily(t,{now:()=>clock});const edit=await f.tap(f.card,'Edit');
 const faulty={...f.stores,journal:{...f.stores.journal,remove:async(...args)=>{
  if(phase==='AFTER_COMPLETED_PURGE'){const result=await f.stores.journal.remove(...args);if(result.purgeId)await f.stores.privacy.complete(args[0],result.purgeId);}
  throw Error(`SYNTHETIC_CRASH_${phase}`);
 }}};
 const interrupted=await createStage7Development({core:f.core,db:f.db,stores:faulty});
 await assert.rejects(tapWith(interrupted,f.user,edit,'Not sure'),new RegExp(`SYNTHETIC_CRASH_${phase}`));
 const staged=(await f.db.raw.execute("SELECT * FROM quick_action_interactions WHERE content_state='PRESENT' AND json_extract(diagnostics_json,'$.missingCorrection') IS NOT NULL")).rows;
 assert.equal(staged.length,1);assert.equal(staged[0].state,'CONFIRM');assert.equal(staged[0].note,null);assert.equal(staged[0].detail_choice,null);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,phase==='BEFORE_PURGE'?1:0);
 assert.equal((await f.db.raw.execute("SELECT pending_purge_count n FROM phase4_user_state WHERE user_id='a'")).rows[0].n,0);
 clock=new Date('2026-09-24T00:00:00Z');await f.db.setLocale('a','vi',{now:clock});await f.db.setLocale('a','en',{now:clock});
 const restarted=await f.restart(),companion=await createStage7Development({...restarted,db:f.db});await companion.resumePending({user:f.user,chatId:'123'});await companion.resumePending({user:f.user,chatId:'123'});
 await assertMissing(f,companion,'NOT_SURE');assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_event_tombstones')).rows[0].n,1);
 // A fresh history capability permits a new explicit factual assertion;
 // the deleted fact identity remains tombstoned and is never refilled.
 let card=await companion.handle({user:f.user,chatId:'123',text:'/journal'});card=await tapWith(companion,f.user,card,'Recent entries');card=await tapWith(companion,f.user,card,'Alcohol');card=await tapWith(companion,f.user,card,'Edit');card=await tapWith(companion,f.user,card,'No');await tapWith(companion,f.user,card,'Confirm');
 const fact=(await f.db.raw.execute('SELECT * FROM journal_events')).rows[0];assert.equal(fact.answer_polarity,'NO');assert.notEqual(fact.logical_fact_id,f.fact.logical_fact_id);
 const actor=await companion.interactions.authenticate({user:f.user,chatId:'123'}),weekly=await companion.weekly.build(actor);assert.equal(weekly.summary.responses.NO,1);assert.equal(weekly.summary.responses.NOT_SURE,0);
});

test('revocation fences a staged missing assertion and cross-tenant recovery has no write authority',async t=>{
 const f=await acceptedDaily(t),edit=await f.tap(f.card,'Edit'),faulty={...f.stores,journal:{...f.stores.journal,remove:async()=>{throw Error('SYNTHETIC_BEFORE_PURGE');}}};
 const interrupted=await createStage7Development({core:f.core,db:f.db,stores:faulty});await assert.rejects(tapWith(interrupted,f.user,edit,'Skip'),/SYNTHETIC_BEFORE_PURGE/);
 const oldStage=(await f.db.raw.execute("SELECT * FROM quick_action_interactions WHERE json_extract(diagnostics_json,'$.missingCorrection') IS NOT NULL")).rows[0];
 await f.db.saveTokens('a',{accessToken:'synthetic-new',refreshToken:'synthetic-new',expiresAt:new Date('2026-12-01'),whoopUserId:'synthetic'},{now:f.core.now(),bumpAuthGeneration:true});
 const restarted=await f.restart(),companion=await createStage7Development({...restarted,db:f.db});
 await assert.rejects(companion.resumePending({user:f.user,chatId:'456'}),/STAGE7_ACTOR_FENCED/);await companion.resumePending({user:f.user,chatId:'123'});
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM quick_action_interactions WHERE state='CONFIRM' AND json_extract(diagnostics_json,'$.missingCorrection') IS NOT NULL")).rows[0].n,1);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,1);assert.equal((await f.db.raw.execute("SELECT count(*) n FROM journal_events WHERE user_id='b'")).rows[0].n,0);
 // Reauthorization does not revive the old submitted intent, but a fresh
 // explicit action must be able to supersede its fenced reservation.
 let card=await companion.handle({user:f.user,chatId:'123',text:'/journal'});card=await tapWith(companion,f.user,card,'Recent entries');card=await tapWith(companion,f.user,card,'Alcohol');card=await tapWith(companion,f.user,card,'Edit');await tapWith(companion,f.user,card,'Not sure');
 await assertMissing(f,companion,'NOT_SURE');const scrubbed=await companion.interactions.read('a',oldStage.interaction_id);assert.equal(scrubbed.content_state,'REDACTED');assert.equal(scrubbed.diagnostics_json,null);assert.equal(scrubbed.selected_choice,null);
});

test('two factual aliases reserve one missing correction for the same fact revision',async t=>{
 const f=await acceptedDaily(t),open=async()=>{let card=await f.command();card=await f.tap(card,'Recent entries');card=await f.tap(card,'Alcohol');return f.tap(card,'Edit');};
 const first=await open(),second=await open();
 const settled=await Promise.allSettled([tapWith(f.companion,f.user,first,'Not sure'),tapWith(f.companion,f.user,second,'Skip')]);
 assert.equal(settled.filter(r=>r.status==='fulfilled'&&/Recorded/.test(r.value.text)).length,1);
 const roots=(await f.db.raw.execute("SELECT * FROM quick_action_interactions WHERE content_state='PRESENT' AND json_extract(diagnostics_json,'$.dailyAnswerKey') IS NOT NULL")).rows;
 assert.equal(roots.length,1);assert.ok(['NOT_SURE','SKIPPED'].includes(roots[0].state));
 const weekly=await f.companion.weekly.build(f.actor);assert.equal(weekly.summary.responses.NOT_SURE+weekly.summary.responses.SKIPPED,1);assert.equal(weekly.summary.responses.NO_RESPONSE,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
});

test('revocation between T1 and T2 settles only admitted cleanup and retracts the obsolete missing intent',async t=>{
 const f=await acceptedDaily(t),edit=await f.tap(f.card,'Edit');
 const interrupted=await createStage7Development({core:f.core,db:f.db,stores:{...f.stores,privacy:{...f.stores.privacy,complete:async()=>{throw Error('SYNTHETIC_AFTER_T1');}}}});
 await assert.rejects(tapWith(interrupted,f.user,edit,'Not sure'),/SYNTHETIC_AFTER_T1/);
 const old=(await f.db.raw.execute("SELECT * FROM quick_action_interactions WHERE json_extract(diagnostics_json,'$.missingCorrection') IS NOT NULL")).rows[0];
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);assert.equal((await f.db.raw.execute("SELECT pending_purge_count n FROM phase4_user_state WHERE user_id='a'")).rows[0].n,1);
 await f.db.saveTokens('a',{accessToken:'synthetic-new',refreshToken:'synthetic-new',expiresAt:new Date('2026-12-01'),whoopUserId:'synthetic'},{bumpAuthGeneration:true});
 const restarted=await f.restart(),companion=await createStage7Development({...restarted,db:f.db});await companion.resumePending({user:f.user,chatId:'123'});await companion.resumePending({user:f.user,chatId:'123'});
 assert.equal((await f.db.raw.execute("SELECT pending_purge_count n FROM phase4_user_state WHERE user_id='a'")).rows[0].n,0);
 const scrubbed=await companion.interactions.read('a',old.interaction_id);assert.equal(scrubbed.content_state,'REDACTED');assert.equal(scrubbed.diagnostics_json,null);assert.equal(scrubbed.selected_choice,null);
 assert.equal((await f.db.raw.execute("SELECT count(*) n FROM quick_action_interactions WHERE content_state='PRESENT' AND state IN ('NOT_SURE','SKIPPED')")).rows[0].n,0);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM journal_event_tombstones')).rows[0].n,1);assert.equal((await f.db.raw.execute('SELECT count(*) n FROM health_plaintext_purges')).rows[0].n,1);
 const command=await companion.handle({user:f.user,chatId:'123',text:'/journal'});assert.ok(command.replyMarkup.inline_keyboard.length);
});

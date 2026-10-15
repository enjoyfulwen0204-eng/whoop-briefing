import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {createStage7InteractionStore} from '../src/stage7InteractionStore.js';
async function fixture(t){const f=await syntheticPhase4Fixture(t,{targetVersion:34});await f.db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});const user=await f.db.getUser('a');const s=createStage7InteractionStore({...f});const actor=await s.authenticate({user,chatId:'123'});return {...f,s,actor,user};}
const callback=(data,id='1',chat='123')=>({id,data,from:{id:chat},message:{message_id:42,chat:{id:chat,type:'private'}}});
test('opaque tenant-bound callbacks survive restart and reject forged, stale, duplicate, chat and message switches',async t=>{
 const f=await fixture(t),{s,actor}=f;
 const {row}=await s.issue(actor,{category:'caffeine',targetDate:'2026-09-18'});const card=await s.render(actor,row);await s.bind(actor,row.interaction_id,42);
 const data=card.replyMarkup.inline_keyboard[0][0].callback_data;assert.equal(data.length,35);
 assert.equal((await s.resolve(actor,callback(data))).action,'NO');
 const restarted=await f.restart(),again=createStage7InteractionStore({...restarted,db:f.db});const nextActor=await again.authenticate({user:f.user,chatId:'123'});
 assert.equal((await again.resolve(nextActor,callback(data))).row.interaction_id,row.interaction_id);
 await s.update(actor,await s.read('a',row.interaction_id),{state:'SKIPPED'});assert.equal(await s.resolve(actor,callback(data)),null);
 await assert.rejects(s.authenticate({user:f.user,chatId:'123',callback:callback(data,'2','999')}),/PRIVATE_ACTOR/);
 assert.equal(await s.resolve(actor,{...callback(data),message:{message_id:43,chat:{id:'123',type:'private'}}}),null);
});

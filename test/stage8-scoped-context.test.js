import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createScopedHealthContext,selfQueryPerspective} from '../src/scopedHealthContext.js';
async function fixture(t){
 const f=await syntheticPhase4Fixture(t,{targetVersion:34});await seedBodyInput(f.db,bodyInput({days:2}));
 await f.db.linkTelegram({userId:'a',chatId:'123',now:f.core.now()});await f.db.setLocale('a','en',{now:f.core.now()});
 const scopes=await createScopedHealthContext({db:f.db,keys:f.keys,now:f.core.now}),user=await f.db.getUser('a');
 return {...f,scopes,user,open:()=>scopes.open({user,chatId:'123',text:'my HRV today',asOf:f.core.now()})};
}
for(const text of ['Recovery score for Alice','Today sleep for Bob','今天 Alice 的恢復狀況',"How is Alice's sleep?",'我朋友的恢復證據呢？','Recovery for my wife','giấc ngủ của cô ấy','vợ tôi có HRV bao nhiêu','睡眠和恢復的證據？'])test(`perspective cannot upgrade another/unknown subject: ${text}`,()=>{
 assert.equal(selfQueryPerspective({text,intent:'today_status'}).usePersonalData,false);
});
for(const text of ['我的 HRV','my recovery today','HRV của tôi','今天HRV多少？','Recovery today'])test(`explicit or complete supported self query: ${text}`,()=>assert.equal(selfQueryPerspective({text,intent:'today_status'}).usePersonalData,true));
test('scope rejects request-controlled identity/mode, forged scopes and a different authenticated binding',async t=>{
 const f=await fixture(t);await assert.rejects(f.scopes.open({user:f.user,chatId:'123',text:'my HRV',userId:'b'}),/REQUEST_INVALID/);
 await assert.rejects(f.scopes.open({user:await f.db.getUser('b'),chatId:'123',text:'my HRV'}),/ACTOR_FENCED/);
 await assert.rejects(f.scopes.facts({userId:'a',executionMode:'LIVE'},'sleep'),/CAPABILITY_REQUIRED/);
 const denied=await f.scopes.open({user:f.user,chatId:'123',text:'What is the evidence for Alice?',intent:'trend_query'});assert.equal(denied.permitted,false);
 assert.equal((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n,0);
 const scope=await f.open(),cycle=await f.scopes.facts(scope,'cycle');assert.equal(cycle.status,'CURRENT_SOURCE_FACTS');assert.ok(cycle.rows.every(r=>r.user_id==='a'));
 assert.equal((await f.scopes.derived(scope,'INSIGHTS')).status,'ANALYSIS_UPDATING');
});
test('same-source computation change fences an open scope and its persisted reply',async t=>{
 const f=await fixture(t);await f.core.initializeTenant('a','LIVE');
 const scope=await f.open(),reply=await f.scopes.sealReply(scope,{text:'synthetic scoped answer'});
 assert.equal(await f.scopes.verifyReply({userId:'a',chatId:'123',reply:JSON.parse(JSON.stringify(reply))}),true);
 await f.db.raw.execute("UPDATE phase4_computation_state SET input_generation=input_generation+1,revision=revision+1,algorithm_set_version='changed' WHERE user_id='a' AND execution_mode='LIVE'");
 await assert.rejects(f.scopes.assert(scope),/CURRENTNESS_FENCED/);assert.equal(await f.scopes.verifyReply({userId:'a',chatId:'123',reply}),false);
});
test('source reads remain own-only and locale ABA fences persisted replies',async t=>{
 const f=await fixture(t),scope=await f.open();
 const result=await f.scopes.facts(scope,'sleep');assert.ok(result.rows.length);
 assert.ok(!result.rows.some(r=>r.user_id==='b'));await assert.rejects(f.scopes.facts(scope,'user_whoop_tokens'),/SOURCE_NOT_ALLOWED/);
 const reply=await f.scopes.sealReply(scope,{text:'synthetic'});await f.db.setLocale('a','vi');await f.db.setLocale('a','en');
 assert.equal(await f.scopes.verifyReply({userId:'a',chatId:'123',reply}),false);
});

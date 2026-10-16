import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('actual runtime exposes source Settings and retains revocation after monitoring is disabled',()=>{
 const child=spawnSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',`
  import {mock,test} from 'node:test';import assert from 'node:assert/strict';
  // Only replace the immutable real-cohort predicate in this isolated child.
  // Runtime, consent storage and the Settings nonce path remain real.
  mock.module('./src/stage7Cohort.js',{namedExports:{isApprovedStage7Three:ids=>JSON.stringify([...ids].sort())===JSON.stringify(['a','b','c'])}});
  const {syntheticPhase4Fixture}=await import('./test/phase4Fixture.js');
  const {createStage8Runtime}=await import('./src/stage8Runtime.js');
  const {createSettings}=await import('./src/bot/settings.js');
  test('source grant and feature-off revoke use composed authority',async t=>{
   const now=()=>new Date('2026-09-19T01:10:00Z'),f=await syntheticPhase4Fixture(t,{targetVersion:35,now});
   for(const [uid,chatId] of [['a','123'],['b','456']]){
    await f.db.linkTelegram({userId:uid,chatId,now:now()});await f.db.setLocale(uid,'en',{now:now()});
    await f.db.saveTokens(uid,{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date('2026-12-01'),scope:'offline',whoopUserId:'synthetic-'+uid});
    await f.db.ensureOnboarding(uid,{state:'READY',now:now()});
   }
   const environment={PHASE4_STAGE8_RUNTIME:'on',PHASE4_STAGE8_OWNER_MONITORING:'on',PHASE4_BETA_PILOT_USER_ID:'a',STAGE8_USER_IDS:'a,b,c'};
   const app=await createStage8Runtime({...f,environment,env:{},now});assert.ok(app.sourceConsent);assert.ok(app.owner);
   const input={user:await f.db.getUser('b'),chatId:'456'};
   async function navigate(runtime,action){
    const settings=createSettings({db:f.db,stage8:runtime,now});let card=await settings({...input,text:'/settings'});
    const tap=async action=>{
     const button=card.replyMarkup.inline_keyboard.flat().find(b=>b.callback_data.endsWith('.'+action));assert.ok(button,action);
     card=await settings({...input,callback:{id:'synthetic',data:button.callback_data,from:{id:456,is_bot:false},message:{message_id:7,chat:{id:456,type:'private'}}}});
    };
    await tap('sharing');
    if(action==='revoke')assert.ok(!card.replyMarkup.inline_keyboard.flat().some(b=>b.callback_data.endsWith('_on')),'disabled monitoring cannot offer a new grant');
    await tap(action==='grant'?'share_daily_on':'share_daily_off');
   }
   await navigate(app,'grant');assert.ok(await app.sourceConsent.check('b','DAILY_SUMMARY'));
   const stopped=await createStage8Runtime({...f,environment:{...environment,PHASE4_STAGE8_OWNER_MONITORING:'off'},env:{},now});
   assert.equal(stopped.owner,null);assert.ok(stopped.sourceConsent);
   await navigate(stopped,'revoke');assert.equal(await app.sourceConsent.check('b','DAILY_SUMMARY'),null);
   assert.deepEqual(await app.owner.enrolled({user:await f.db.getUser('a'),chatId:'123'}),[]);
  });
 `],{cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:60000});
 assert.equal(child.status,0,child.stdout+child.stderr);
});

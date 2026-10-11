import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';
import {createSettings,settingsKey} from '../src/bot/settings.js';
import {handleLocaleOnlyMessage} from '../src/onboarding.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof,canonicalPhaseRequest,claimPhaseRequest,readExecution,EXECUTION_WORK_MAX_AGE_MS} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {createTelegram} from '../src/telegram.js';
import {currentExecutionBudget} from '../src/executionBudget.js';
const action=(r,x)=>r.replyMarkup.inline_keyboard.flat().find(b=>b.callback_data.endsWith('.'+x)).callback_data;
const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'};
const request=()=>({requestId:`p4c1_${randomUUID()}`,releaseSha:runningReleaseSha(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)});

test('F07: an old Settings language callback survives product locale changes and value ABA',async t=>{
 const {db}=await deliveryFixture(t);await db.admitRuntime();await db.createUser({id:'alice',displayName:'Alice',status:'ACTIVE',timezone:'Asia/Taipei'});await db.linkTelegram({userId:'alice',chatId:'1001'});await db.setLocale('alice','en');
 const settings=createSettings({db});
 const route=async(text,data)=>{
  const user=await db.getUser('alice');const reply=await settings({text,chatId:'1001',user,...(data?{callback:{data}}:{})});
  return reply??handleLocaleOnlyMessage({db,user,text});
 };
 const chooser=await route('/language');const preview=await route('',action(chooser,'vi'));const callback=action(preview,'confirm');
 const initial=await db.getState(settingsKey('alice'));
 await route('繁體中文');assert.equal(await db.getLocale('alice'),'zh-TW');
 const conflict=await route('',callback);assert.match(conflict.text,/其他操作/);
 await route('English');assert.equal(await db.getLocale('alice'),'en');
 assert.equal(await db.getState(settingsKey('alice')),initial);
 const stale=await route('',callback);assert.equal(await db.getLocale('alice'),'en');assert.match(stale.text,/changed in another interaction/);
 console.log('COUNTEREXAMPLE '+JSON.stringify({issue:'SETTINGS_LOCALE_ABA',before:'en',intermediate:['zh-TW','en'],oldCallbackResult:stale,after:await db.getLocale('alice')}));
});

test('F07: name confirmation compares only values after concurrent canonical name ABA',async t=>{
 const {db}=await deliveryFixture(t);await db.admitRuntime();await db.createUser({id:'alice',displayName:'Alice',status:'ACTIVE'});await db.linkTelegram({userId:'alice',chatId:'1001'});await db.setLocale('alice','en');
 const settings=createSettings({db});const call=async(text,data)=>settings({text,chatId:'1001',user:await db.getUser('alice'),...(data?{callback:{data}}:{})});
 await call('/name');const preview=await call('Old proposal'),data=action(preview,'save');
 await db.updateUser('alice',{displayName:'Concurrent name'});await db.updateUser('alice',{displayName:'Alice'});
 await call('',data);assert.equal((await db.getUser('alice')).displayName,'Alice');
 console.log('COUNTEREXAMPLE '+JSON.stringify({issue:'SETTINGS_NAME_ABA',canonicalChanges:['Alice','Concurrent name','Alice'],oldProposalAccepted:true}));
});

for(const locale of ['zh-TW','en','vi'])test('F07 legacy locale ABA at identical timestamps: '+locale,async t=>{
 const {db}=await deliveryFixture(t);await db.createUser({id:'alice',displayName:'Alice',status:'ACTIVE'});await db.linkTelegram({userId:'alice',chatId:'1001'});await db.setLocale('alice',locale);
 const fixed=new Date(),flow=createSettings({db,now:()=>fixed}),call=async(text,data)=>flow({text,chatId:'1001',user:await db.getUser('alice'),...(data?{callback:{data}}:{})});
 const chooser=await call('/language'),preview=await call('',action(chooser,locale==='vi'?'en':'vi')),data=action(preview,'confirm');const before=await db.getProfileRevision('alice');
 await db.setLocale('alice',locale==='en'?'zh-TW':'en',{now:fixed});await db.setLocale('alice',locale,{now:fixed});
 assert.equal(await db.getProfileRevision('alice'),before+2);await call('',data);assert.equal(await db.getLocale('alice'),locale);
});
test('F07 real second process canonical name ABA fences the old callback',async t=>{
 const {db,url}=await deliveryFixture(t);await db.createUser({id:'alice',displayName:'Alice',status:'ACTIVE'});await db.linkTelegram({userId:'alice',chatId:'1001'});await db.setLocale('alice','en');
 const flow=createSettings({db}),call=async(text,data)=>flow({text,chatId:'1001',user:await db.getUser('alice'),...(data?{callback:{data}}:{})});await call('/name');const preview=await call('Old proposal'),data=action(preview,'save'),before=await db.getProfileRevision('alice');
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');const fixtureUrl=new URL('./deliveryDefaultFixture.js',import.meta.url).href;
 const program=`import {openHttpFixture} from ${JSON.stringify(fixtureUrl)};const f=openHttpFixture(${JSON.stringify(url)});try{await f.db.admitRuntime();const now=new Date('2026-10-10T00:00:00Z');await f.db.updateUser('alice',{displayName:'Other'},{now});await f.db.updateUser('alice',{displayName:'Alice'},{now});}finally{f.close();}`;
 await promisify(execFile)(process.execPath,['--input-type=module','-e',program],{timeout:15000});assert.equal(await db.getProfileRevision('alice'),before+2);
 const restarted=createSettings({db});await restarted({text:'',chatId:'1001',user:await db.getUser('alice'),callback:{data}});assert.equal((await db.getUser('alice')).displayName,'Alice');
});
test('F07 compare-and-swap, rollback, reserved revision and lost ACK never resurrect an old callback',async t=>{
 const {db,transport}=await deliveryFixture(t);await db.createUser({id:'alice',displayName:'Alice',status:'ACTIVE'});await db.linkTelegram({userId:'alice',chatId:'1001'});await db.setLocale('alice','en');
 const {profileRevisionKey}=await import('../src/profileRevision.js');const initial=await db.getProfileRevision('alice');
 await assert.rejects(()=>db.setState(profileRevisionKey('alice'),'0'),/PROFILE_REVISION_RESERVED/);
 await assert.rejects(()=>db.transaction(async()=>{await db.setLocale('alice','vi');throw Error('rollback');}),/rollback/);assert.equal(await db.getProfileRevision('alice'),initial);assert.equal(await db.getLocale('alice'),'en');
 await db.updateUser('alice',{displayName:'Other'},{expectedProfileRevision:initial});await assert.rejects(()=>db.setLocale('alice','vi',{expectedProfileRevision:initial}),/PROFILE_REVISION_CONFLICT/);
 const flow=createSettings({db}),call=async(text,data)=>flow({text,chatId:'1001',user:await db.getUser('alice'),...(data?{callback:{data}}:{})});await call('/name');const preview=await call('Committed name'),data=action(preview,'save'),revision=await db.getProfileRevision('alice');
 transport.arm({matchSql:/UPDATE telegram_state SET value/,loseAcknowledgement:true});await assert.rejects(()=>call('',data),/COMMIT_INDETERMINATE/);
 assert.equal((await db.getUser('alice')).displayName,'Committed name');assert.equal(await db.getProfileRevision('alice'),revision+1);await call('',data);assert.equal(await db.getProfileRevision('alice'),revision+1);
});

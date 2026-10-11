import test from 'node:test';import assert from 'node:assert/strict';
import {deliveryFixture} from './deliveryDefaultFixture.js';
import {createSettings,SETTINGS_COPY,normalizeSettingsName,settingsKey,SETTINGS_TTL_MS,isSettingsCallback} from '../src/bot/settings.js';
import {displayNameFor} from '../src/displayName.js';
const buttons=r=>r.replyMarkup.inline_keyboard.flat();
const action=(r,code)=>buttons(r).find(b=>b.callback_data.endsWith('.'+code)).callback_data;
async function fixture(t,locale){
 const {db,transport}=await deliveryFixture(t);await db.admitRuntime();
 for(const [id,chatId] of [['alice','1001'],['bob','1002']]){await db.createUser({id,displayName:id,status:'ACTIVE',timezone:'Asia/Taipei'});await db.linkTelegram({userId:id,chatId});if(locale)await db.setLocale(id,locale);}
 let at=Date.now();const options={db,now:()=>new Date(at)};let handle=createSettings(options);
 const call=async(text,{uid='alice',data}={})=>handle({text,chatId:uid==='alice'?'1001':'1002',user:await db.getUser(uid),...(data?{callback:{data}}:{})});
 return {db,transport,call,restart:()=>handle=createSettings(options),advance:ms=>at+=ms};
}
for(const locale of ['zh-TW','en','vi'])test(`Settings commands, icon buttons, language/name isolation and stale callbacks: ${locale}`,async t=>{
 const f=await fixture(t,locale),c=SETTINGS_COPY[locale];
 const menu=await f.call('/settings');assert.equal(menu.text,c.title);assert.ok(buttons(menu).every(b=>/^\p{Extended_Pictographic}|^\p{Regional_Indicator}/u.test(b.text)));assert.ok(buttons(menu).every(b=>Buffer.byteLength(b.callback_data)<=64));
 const language=await f.call('',{data:action(menu,'language')});assert.equal(language.text,c.choose);
 const opts=buttons(language);for(const label of ['🇹🇼 繁體中文','🇺🇸 English','🇻🇳 Tiếng Việt'])assert.ok(opts.some(b=>b.text===label));
 assert.ok(opts.some(b=>b.text===c.back));assert.ok(opts.some(b=>b.text===c.cancel));
 const chosen=await f.call('',{data:action(language,'en')});assert.ok(buttons(chosen).some(b=>b.text===c.confirm));assert.equal(await f.db.getLocale('alice'),locale,'chooser never mutates before confirmation');
 await f.call('',{data:action(chosen,'confirm')});assert.equal(await f.db.getLocale('alice'),'en');assert.equal(await f.db.getLocale('bob'),locale);assert.equal(await displayNameFor(f.db,'alice'),'alice');
 await f.call('',{data:action(chosen,'confirm')});assert.equal(await f.db.getLocale('alice'),'en');
 const chooser=await f.call('/language'),back=await f.call('',{data:action(chooser,'back')});assert.equal(back.text,SETTINGS_COPY.en.title);
 const edit=await f.call('/name');assert.equal(edit.text,SETTINGS_COPY.en.enter);assert.equal(buttons(edit)[0].text,SETTINGS_COPY.en.back);
 const preview=await f.call('  A\u0301nh <&> 🧑‍💻  ');assert.match(preview.text,/Ánh <&> 🧑‍💻/);assert.ok(buttons(preview).some(b=>b.text===SETTINGS_COPY.en.save));assert.ok(buttons(preview).some(b=>b.text===SETTINGS_COPY.en.edit));
 const stale=await f.call('',{data:action(edit,'cancel')});assert.equal(stale.text,SETTINGS_COPY.en.expired);
 const other=await f.call('',{uid:'bob',data:action(preview,'save')});assert.equal(other.text,SETTINGS_COPY[locale].expired);assert.equal((await f.db.getUser('bob')).displayName,'bob');
 f.restart();const saved=await f.call('',{data:action(preview,'save')});assert.equal(saved.text,SETTINGS_COPY.en.saved);assert.equal(await displayNameFor(f.db,'alice'),'Ánh <&> 🧑‍💻');
 const updated=(await f.db.getUser('alice')).updatedAt;await f.call('',{data:action(preview,'save')});assert.equal((await f.db.getUser('alice')).updatedAt,updated);
 assert.equal(await f.db.getState(settingsKey('alice')),null);assert.equal((await f.db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v,32);
});
test('UNSET reaches chooser; expiration, cancel, invalid names and concurrent profile changes fail closed',async t=>{
 const f=await fixture(t,null),chooser=await f.call('/settings');assert.match(chooser.text,/Language.*語言.*Ngôn ngữ/);assert.equal(await f.db.getLocale('alice'),null);
 await f.call('',{data:action(chooser,'cancel')});assert.equal(await f.db.getLocale('alice'),null);
 let edit=await f.call('/name');let reply=await f.call('');assert.equal(reply,null);
 for(const name of ['   ','\uD800','A\u0000B','A\u202EB','A\u200BB','a'.repeat(65)]){reply=await f.call(name);assert.equal(reply.text,SETTINGS_COPY.en.invalid);assert.equal((await f.db.getUser('alice')).displayName,'alice');}
 let preview=await f.call('New name');await f.db.updateUser('alice',{displayName:'Concurrent'});reply=await f.call('',{data:action(preview,'save')});assert.equal(reply.text,SETTINGS_COPY.en.conflict);assert.equal((await f.db.getUser('alice')).displayName,'Concurrent');
 edit=await f.call('/name');preview=await f.call('Never saved');await f.call('',{data:action(preview,'edit')});const cancel=await f.call('/name');await f.call('',{data:action(cancel,'cancel')});assert.equal((await f.db.getUser('alice')).displayName,'Concurrent');
 preview=await f.call('/language');f.advance(SETTINGS_TTL_MS+1);reply=await f.call('',{data:action(preview,'en')});assert.equal(reply.text,SETTINGS_COPY.en.expired);assert.equal(await f.db.getLocale('alice'),null);
});
test('failed DB save rolls back the profile/session; fresh retry succeeds',async t=>{
 const f=await fixture(t,'vi'),preview=await f.call('/name');await f.call('Lan mới');const raw=JSON.parse(await f.db.getState(settingsKey('alice'))),data=`sv1:${raw.nonce}.${raw.revision}.save`;
 const broken=createSettings({db:{...f.db,updateUser:async()=>{throw Error('synthetic DB failure');}}});
 await assert.rejects(async()=>broken({text:'',chatId:'1001',user:{...(await f.db.getUser('alice'))},callback:{data}}),/synthetic DB failure/);
 assert.equal((await f.db.getUser('alice')).displayName,'alice');assert.ok(await f.db.getState(settingsKey('alice')));await f.call('',{data});assert.equal(await displayNameFor(f.db,'alice'),'Lan mới');
});
for(const [input,expected] of [['  Nguyễn   Ánh  ','Nguyễn Ánh'],['A\u0301','Á'],['陳小明','陳小明'],['🧑‍💻','🧑‍💻'],["O'Connor","O'Connor"],["'; DROP TABLE users; --","'; DROP TABLE users; --"]])test(`Unicode name normalization: ${input}`,()=>assert.equal(normalizeSettingsName(input),expected));
for(const name of ['',null,123,'\uD800','\uDC00','a\u0001b','a\u202Eb','a\u2066b','a\u00ADb','a'.repeat(65),'🧑‍💻'.repeat(64)])test(`invalid/oversized Unicode name: ${JSON.stringify(name)}`,()=>assert.throws(()=>normalizeSettingsName(name),/SETTINGS_NAME_INVALID/));
test('arbitrary user IDs/actions and oversized callback data never enter settings callbacks',()=>{
 for(const data of ['sv1:alice.save','sv1:abc.0.set_user=bob','/delete','sv1:'+ 'a'.repeat(200)])assert.equal(isSettingsCallback(data),false);
});
for(const locale of ['zh-TW','en','vi'])test(`every localized name editor/preview/navigation icon: ${locale}`,async t=>{
 const f=await fixture(t,locale),c=SETTINGS_COPY[locale],menu=await f.call('/settings');assert.ok(buttons(menu).some(b=>b.text===c.language));assert.ok(buttons(menu).some(b=>b.text===c.name));
 const edit=await f.call('/name');assert.equal(edit.text,c.enter);assert.ok(buttons(edit).some(b=>b.text===c.back));assert.ok(buttons(edit).some(b=>b.text===c.cancel));
 const preview=await f.call('Safe name');for(const label of [c.save,c.edit,c.back,c.cancel])assert.ok(buttons(preview).some(b=>b.text===label));
 const edited=await f.call('',{data:action(preview,'edit')});assert.equal(edited.text,c.enter);const back=await f.call('',{data:action(edited,'back')});assert.equal(back.text,c.title);await f.call('',{data:action(back,'cancel')});assert.equal((await f.db.getUser('alice')).displayName,'alice');
});
test('replacement sessions, concurrent locale update and lifecycle ABA reject stale mutation',async t=>{
 const f=await fixture(t,'en');await f.call('/name');const old=await f.call('Old proposal');await f.call('/name');assert.equal((await f.call('',{data:action(old,'save')})).text,SETTINGS_COPY.en.expired);assert.equal(await displayNameFor(f.db,'alice'),'alice');
 const language=await f.call('/language'),confirmed=await f.call('',{data:action(language,'vi')});await f.db.setLocale('alice','zh-TW');assert.equal((await f.call('',{data:action(confirmed,'confirm')})).text,SETTINGS_COPY['zh-TW'].conflict);assert.equal(await f.db.getLocale('alice'),'zh-TW');
 await f.call('/name');const preview=await f.call('ABA proposal');await f.db.transitionUserLifecycle({userId:'alice',targetStatus:'DISABLED'});await f.db.transitionUserLifecycle({userId:'alice',targetStatus:'ACTIVE'});const result=await f.call('',{data:action(preview,'save')});assert.equal(result.text,SETTINGS_COPY['zh-TW'].expired);assert.equal(await displayNameFor(f.db,'alice'),'alice');
});
test('concurrent tenants keep distinct sessions; a blank canonical name uses no invented fallback',async t=>{
 const f=await fixture(t,'vi');await f.db.updateUser('alice',{displayName:''});const [a,b]=await Promise.all([f.call('/name'),f.call('/name',{uid:'bob'})]);assert.notEqual(action(a,'cancel'),action(b,'cancel'));
 const [ap,bp]=await Promise.all([f.call("'; DROP TABLE users; --"),f.call('Bình',{uid:'bob'})]);await Promise.all([f.call('',{data:action(ap,'save')}),f.call('',{uid:'bob',data:action(bp,'save')})]);assert.equal((await f.db.getUser('alice')).displayName,"'; DROP TABLE users; --");assert.equal((await f.db.getUser('bob')).displayName,'Bình');assert.equal((await f.db.raw.execute('SELECT count(*) n FROM users')).rows[0].n,2);
});
test('missing lifecycle or inactive canonical actor cannot create a Settings session',async()=>{
 let writes=0;for(const user of [{id:'alice',status:'ACTIVE'},{id:'alice',status:'ACTIVE',lifecycleGeneration:0},{id:'alice',status:'DISABLED',lifecycleGeneration:1}]){
  const handler=createSettings({db:{transaction:fn=>fn(),resolveUserByChatId:async()=>user,setState:async()=>writes++}});
  const reply=await handler({text:'/name',chatId:'1001',user});assert.equal(reply.text,SETTINGS_COPY.en.expired);
 }assert.equal(writes,0);
});
test('failed locale save rolls back; the same confirmed selection succeeds after recovery',async t=>{
 const f=await fixture(t,'en'),chooser=await f.call('/language'),confirmed=await f.call('',{data:action(chooser,'vi')}),data=action(confirmed,'confirm');
 const broken=createSettings({db:{...f.db,setLocale:async()=>{throw Error('SYNTHETIC_LOCALE_UPDATE_FAILED');}}});
 await assert.rejects(async()=>broken({text:'',chatId:'1001',user:await f.db.getUser('alice'),callback:{data}}),/SYNTHETIC_LOCALE_UPDATE_FAILED/);
 assert.equal(await f.db.getLocale('alice'),'en');assert.ok(await f.db.getState(settingsKey('alice')));await f.call('',{data});assert.equal(await f.db.getLocale('alice'),'vi');
});

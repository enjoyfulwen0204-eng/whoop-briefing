import {fileURLToPath} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../..',import.meta.url));
const {stage8Fixture}=await import(root+'/test/stage8Fixture.js');
const {createRouter}=await import(root+'/src/bot/router.js');
const {urgentReply,assessUrgency}=await import(root+'/src/bot/triage.js');
const samples=[
 ['en','I have chest pain and cannot breathe. What is my HRV today?'],
 ['en','I feel faint and my heart is racing. How is my recovery today?'],
 ['vi','Tôi đang đau ngực và khó thở. HRV của tôi hôm nay là bao nhiêu?'],
 ['vi','Tôi khó thở và sắp ngất. Phục hồi của tôi hôm nay thế nào?'],
 ['zh-TW','我現在胸痛而且呼吸困難，想知道今天我的恢復如何？'],
 ['zh-TW','我有點累而且現在胸痛，今天我的 HRV 多少？'],
 ['zh-TW','昨天頭痛已經好了，但現在胸痛且喘不過氣，今天我的 HRV 多少？'],
 ['zh-TW','我現在胸痛而且呼吸困難，今天我的恢復如何？']
];
for(const [locale,text] of samples)test('Urgent native input '+locale+' '+text,async t=>{
 const f=await stage8Fixture(t);await f.db.setLocale('a',locale);let model=0,body=0;
 const router=createRouter({db:f.db,stage8:f.app,now:f.now,coachFor(){model++;return null;},bodyEnergy:{notificationControl:{handle:async()=>{body++;return null;}},query:async()=>{body++;return null;}}});
 const result=await router.handle({...f.input,text}),reply=typeof result==='string'?result:result?.text??result?.reply;
 const audit=Number((await f.db.raw.execute('SELECT count(*) n FROM stage8_scoped_read_audit')).rows[0].n);
 console.log('PROBE',JSON.stringify({locale,text,urgency:assessUrgency(text),reply,audit,model,body}));
 assert.equal(reply,urgentReply(locale));assert.equal(audit,0);assert.equal(model,0);assert.equal(body,0);
});
for(const locale of ['en','vi','zh-TW'])test('Ordinary health query still works '+locale,async t=>{
 const f=await stage8Fixture(t);await f.db.setLocale('a',locale);const result=await f.app.handle({...f.input,text:'my HRV today'});assert.match(result.text,/HRV: 50\.0/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {renderStage8OwnerPayload,createStage8OwnerDispatcher} from '../src/stage8OwnerDispatcher.js';
import {createOwnerMonitoring} from '../src/stage8OwnerMonitoring.js';
import {stage8Fixture} from './stage8Fixture.js';
import {grantSourceConsent} from './stage8SourceConsentFixture.js';

const asOfUtc='2026-09-19T01:10:00.000Z';
const daily=()=>({notificationClass:'DAILY_SUMMARY',subjectId:'b',asOfUtc,claims:[
 {kind:'SOURCE_FACT_SUMMARY',metric:'sleep',value:'480 min',asOfUtc},
 {kind:'SOURCE_FACT_SUMMARY',metric:'recovery',value:'75.0%',asOfUtc},
 {kind:'SOURCE_FACT_SUMMARY',metric:'load',value:'8.5',asOfUtc},
]});
const weekly=()=>({notificationClass:'WEEKLY_SUMMARY',subjectId:'b',asOfUtc,claims:[
 {kind:'OBSERVATIONAL_ASSOCIATION',claim:'late_meal has been repeatedly associated in your data with lower recovery_score.',nonCausal:true},
 {kind:'OBSERVATIONAL_ASSOCIATION',claim:'exercise_note has been repeatedly associated in your data with higher respiratory_rate.',nonCausal:true},
]});
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const labels={
 'zh-TW':{daily:['睡眠時間: 480 min','恢復分數: 75.0%','活動負荷: 8.5'],weekly:['晚餐較晚','恢復分數偏低','運動','呼吸率偏高','已追蹤使用者的資料','觀察性關聯，不代表因果。']},
 en:{daily:['Sleep duration: 480 min','Recovery score: 75.0%','Strain: 8.5'],weekly:['Late meals','lower Recovery score','Exercise','higher Respiratory rate','followed user’s data','Observational association only; not causation.']},
 vi:{daily:['Thời lượng ngủ: 480 min','Điểm phục hồi: 75,0%','Mức gắng sức: 8,5'],weekly:['Ăn muộn','Điểm phục hồi thấp hơn','Tập luyện','Nhịp thở cao hơn','người được theo dõi','Chỉ là mối liên hệ quan sát, không phải quan hệ nhân quả.']},
};
for(const locale of ['zh-TW','en','vi']){
 test(`DAILY uses registered metric labels and preserves approved values: ${locale}`,()=>{
  const payload=freeze(daily()),before=JSON.stringify(payload),text=renderStage8OwnerPayload(payload,locale);
  for(const value of labels[locale].daily)assert.ok(text.includes(value),text);
  assert.doesNotMatch(text,/^(?:sleep|recovery|load):/m);assert.ok(text.endsWith(asOfUtc));assert.equal(JSON.stringify(payload),before);
 });
 test(`WEEKLY localizes registered associations about the followed subject: ${locale}`,()=>{
  const payload=freeze(weekly()),before=JSON.stringify(payload),text=renderStage8OwnerPayload(payload,locale);
  for(const value of labels[locale].weekly)assert.ok(text.includes(value),text);
  assert.doesNotMatch(text,/late_meal|exercise_note|recovery_score|respiratory_rate|in your data|你的資料|Dữ liệu của bạn/);
  assert.equal(JSON.stringify(payload),before);
 });
}

test('unsupported claims, daily sections and class/kind combinations have no raw fallback',()=>{
 const invalid=[];
 for(const claim of ['A new unregistered health claim.','late_meal causes lower recovery_score.',
  'unknown has been repeatedly associated in your data with lower recovery_score.',
  'late_meal has been repeatedly associated in your data with sideways recovery_score.',
  'late_meal has been repeatedly associated in your data with lower unknown_metric.',
  'late_meal has been repeatedly associated in your data with lower body_energy.']){
  const p=weekly();p.claims[0].claim=claim;invalid.push(p);
 }
 const causal=weekly();causal.claims[0].nonCausal=false;invalid.push(causal);
 const unknown=daily();unknown.claims[0].metric='unknown';invalid.push(unknown);
 const mismatch=weekly();mismatch.notificationClass='DAILY_SUMMARY';invalid.push(mismatch);
 const kind=daily();kind.claims[0]={kind:'UNREGISTERED',claim:'raw text'};invalid.push(kind);
 for(const p of invalid)assert.throws(()=>renderStage8OwnerPayload(p,'en'),/OWNER_CLAIM_UNRENDERABLE/);
});

test('IMPORTANT preserves exact approved text and unset locale retains English fallback',()=>{
 const original='已核可的原始提醒。\nExact approved source text.',payload=freeze({notificationClass:'IMPORTANT_ALERT',subjectId:'b',asOfUtc,claims:[{kind:'APPROVED_IMPORTANT_ALERT',claim:original}]}),before=JSON.stringify(payload);
 const text=renderStage8OwnerPayload(payload,'vi');assert.ok(text.includes('\n'+original+'\n'));assert.equal(JSON.stringify(payload),before);
 assert.equal(renderStage8OwnerPayload(daily(),null),renderStage8OwnerPayload(daily(),'en'));
});

async function preparedOwner(t,locale){
 const f=await stage8Fixture(t,{owner:true}),sourceLocale=locale==='en'?'vi':'en';
 await f.db.setLocale('a',locale,{now:f.now()});await f.db.setLocale('b',sourceLocale,{now:f.now()});
 const monitoring=await createOwnerMonitoring({...f,ownerId:'a',enabled:()=>true,sourceConsent:f.app.sourceConsent,now:f.now});
 await grantSourceConsent(f);const actor=await monitoring.authenticate(f.input),request={subjectId:'b',notificationClass:'DAILY_SUMMARY'};
 await monitoring.configure(actor,{...request,enabled:true,expectedRevision:0,operationKey:'localized-explicit-owner-follow'});
 assert.equal((await monitoring.prepareDaily(actor,'b')).status,'CURRENT_PLAN');
 const allowed=await monitoring.authorize(actor,request),proposal=await monitoring.propose(actor,allowed.ticket);
 assert.equal(proposal.status,'PROPOSED');
 const raw=(await f.db.raw.execute({sql:'SELECT payload_json FROM owner_monitoring_outbox WHERE message_id=?',args:[proposal.messageId]})).rows[0].payload_json;
 return {...f,monitoring,request,proposal,raw,sourceLocale};
}
for(const locale of ['zh-TW','en','vi'])test(`genuine current daily copy uses owner locale, settles one ACK and never resends: ${locale}`,async t=>{
 const f=await preparedOwner(t,locale),calls=[];
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  assert.equal(url,'https://api.telegram.org/botSYNTHETIC_NOT_A_TOKEN/sendMessage');calls.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ok:true,result:{message_id:909,date:Math.floor(f.now().getTime()/1000),chat:{id:123,type:'private'}}}),{status:200});
 });
 const dispatcher=createStage8OwnerDispatcher({...f,env:f.env,enabled:()=>true,now:f.now}),result=await dispatcher.dispatch(f.input,f.request);
 assert.equal(result.providerOutcome,'DELIVERED');assert.equal(calls.length,1);assert.equal(String(calls[0].chat_id),'123');
 assert.equal(calls[0].text,renderStage8OwnerPayload(JSON.parse(f.raw),locale));assert.notEqual(locale,f.sourceLocale);
 assert.equal((await dispatcher.dispatch(f.input,f.request)).status,'DELIVERED');assert.equal(calls.length,1);
 const row=(await f.db.raw.execute({sql:'SELECT payload_json,state,attempt_count FROM owner_monitoring_outbox WHERE message_id=?',args:[f.proposal.messageId]})).rows[0];
 assert.equal(row.payload_json,f.raw);assert.equal(row.state,'DELIVERED');assert.equal(row.attempt_count,1);
 assert.equal((await f.db.raw.execute('SELECT state FROM owner_monitoring_attempts')).rows[0].state,'DELIVERED');
});

test('unrenderable boundary copy performs zero IO and settles a definite non-send',async t=>{
 const f=await preparedOwner(t,'en');let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('SYNTHETIC_PROVIDER_FORBIDDEN');});
 // Boundary unit fault only: genuine stored authorization remains unchanged.
 // This wrapper is not an owner-authority or LIVE-evidence fixture.
 const monitoring={...f.monitoring,validate:async(...args)=>{
  const value=await f.monitoring.validate(...args);return {...value,payload:{...value.payload,claims:[{kind:'SOURCE_FACT_SUMMARY',metric:'unsupported',value:'raw text'}]}};
 }};
 const dispatcher=createStage8OwnerDispatcher({...f,monitoring,env:f.env,enabled:()=>true,now:f.now}),result=await dispatcher.dispatch(f.input,f.request);
 assert.equal(calls,0);assert.equal(result.providerOutcome,'FAILED_DEFINITE');
 assert.equal((await f.db.raw.execute('SELECT state FROM owner_monitoring_attempts')).rows[0].state,'FAILED_DEFINITE');
 assert.equal((await f.db.raw.execute('SELECT payload_json FROM owner_monitoring_outbox')).rows[0].payload_json,f.raw);
});

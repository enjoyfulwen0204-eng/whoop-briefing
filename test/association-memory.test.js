import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {stage7Fixture} from './stage7Fixture.js';
import {updateAssociationMemory,latestMemory,renderMemory,selectMemoryChange} from '../src/associationMemory.js';
import {calculateAssociations} from '../src/onDemandAssociations.js';
import {addDays} from '../src/time.js';
import {notifyMemory} from '../src/insightNotifications.js';
import {proactiveQuota} from '../src/proactiveQuota.js';
const at=new Date('2026-09-19T06:00:00Z');
function view(n=6,reverse=false){const days=[],facts=[];for(let i=0;i<2*n;i++){const day=addDays('2026-09-19',-i);days.push({health_date:day,hrv:i<n?(reverse?70:40):60});facts.push({category:'alcohol',health_date:addDays(day,-1),exposure_state:i<n?'EXPOSED':'CONFIRMED_UNEXPOSED',fact_status:'ACTIVE',content_state:'PRESENT'});}return calculateAssociations({days,facts,today:'2026-09-19'});}
const reader={assertFresh:async()=>true};
test('only explicit B2 arms feed legacy state machine; immutable versions, same-day retry, reversal',async t=>{
 const f=await stage7Fixture(t,{now:()=>at});const args={db:f.db,user:f.user,reader,view:view(),now:at};
 await updateAssociationMemory(args);let rows=await latestMemory(f.db,'a');assert.equal(rows.length,1);assert.equal(rows[0].status,'EMERGING');const first=rows[0].id;
 await updateAssociationMemory(args);assert.equal((await latestMemory(f.db,'a'))[0].id,first);
 await updateAssociationMemory({...args,view:view(20),now:new Date('2026-09-20T06:00:00Z')});rows=await latestMemory(f.db,'a');assert.equal(rows[0].status,'SUPPORTED');assert.equal(rows[0].version,2);assert.equal((await f.db.getInsight('a',first)).status,'RETIRED');
 await updateAssociationMemory({...args,view:view(20,true),now:new Date('2026-09-21T06:00:00Z')});rows=await latestMemory(f.db,'a');assert.equal(rows[0].status,'WEAKENED');
 for(const locale of ['zh-TW','en','vi']){const text=renderMemory(rows[0],locale,at);assert.match(text,/⚠️/);assert.doesNotMatch(text,/undefined/);}
 assert.equal((await f.db.getInsightHistory('a',rows[0].id)).length,3);
});
test('insufficient groups and missing source cannot create an insight',async t=>{
 const f=await stage7Fixture(t,{now:()=>at});await updateAssociationMemory({db:f.db,user:f.user,reader,view:view(4),now:at});assert.deepEqual(await latestMemory(f.db,'a'),[]);
 await assert.rejects(updateAssociationMemory({db:f.db,user:f.user,reader:{assertFresh:async()=>{throw Error('PHASE4_SOURCE_NOT_CURRENT');}},view:view(),now:at}));assert.deepEqual(await latestMemory(f.db,'a'),[]);
});
test('weekly notification prioritizes supported/retired; retains unknown ACK reservation and shared optional quota',async t=>{
 const f=await stage7Fixture(t,{now:()=>at});await updateAssociationMemory({db:f.db,user:f.user,reader,view:view(20),now:at});let sends=0;
 const args={db:f.db,keys:f.keys,user:f.user,locale:'en',now:at,telegram:{send:async()=>{sends++;return {};}}};
 assert.equal((await notifyMemory(args)).status,'UNKNOWN');assert.equal((await notifyMemory(args)).status,'ALREADY_RESERVED');assert.equal(sends,1);
 assert.deepEqual(await proactiveQuota(f.db.raw,{userId:'a',timezone:f.user.timezone,now:at}),{total:1,health:0,ask:0});
 const rows=[{id:1,version:1,status:'WEAKENED'},{id:2,version:1,status:'EMERGING'},{id:3,version:1,status:'RETIRED'}].map(r=>({...r,evidence_json:JSON.stringify({version:'b2-memory-v1',statusChangedAt:at.toISOString()})}));
 assert.equal(selectMemoryChange(rows,'2026-09-14').id,3);
 assert.equal(selectMemoryChange([rows[2]],'2026-09-14',new Set(['3:1'])),null);
 assert.equal(selectMemoryChange(rows,'2026-09-21'),null,'unchosen changes do not become next week’s notifications');
});
test('night is sole automatic memory writer and B2 old notifier is disconnected; prediction policy remains closed',()=>{
 const r=readFileSync(new URL('../src/proactiveReanalysis.js',import.meta.url),'utf8');assert.doesNotMatch(r,/await (?:recordInsight|reviseInsight|retireInsight)\(/);
 const runtime=readFileSync(new URL('../src/stage7Runtime.js',import.meta.url),'utf8');assert.match(runtime,/notifyMemory\(/);assert.doesNotMatch(runtime,/notifyAssociation\(/);
 const policy=readFileSync(new URL('../src/predictionPolicy.js',import.meta.url),'utf8');for(const gate of ['MAX_MAE','MIN_R2','MIN_INTERVAL_COVERAGE'])assert.match(policy,new RegExp(gate+': null'));
});
test('memory notifications respect quiet/pause and revalidate the selected version before sending',async t=>{
 const f=await stage7Fixture(t,{now:()=>at});await updateAssociationMemory({db:f.db,user:f.user,reader,view:view(20),now:at});let sends=0;
 const args={db:f.db,keys:f.keys,user:f.user,locale:'en',now:at,telegram:{send:async()=>{sends++;return {messageId:1};}}};
 assert.equal((await notifyMemory({...args,now:new Date('2026-09-19T15:00:00Z')})).status,'QUIET_OR_PAUSED');
 await f.db.raw.execute({sql:'INSERT INTO user_notification_preferences(user_id,notifications_paused,created_at,updated_at) VALUES(?,1,?,?) ON CONFLICT(user_id) DO UPDATE SET notifications_paused=1',args:['a',at.toISOString(),at.toISOString()]});
 assert.equal((await notifyMemory(args)).status,'QUIET_OR_PAUSED');assert.equal(sends,0);
 await f.db.raw.execute({sql:'UPDATE user_notification_preferences SET notifications_paused=0 WHERE user_id=?',args:['a']});
 const guardedDb={...f.db,getInsight:async()=>null};
 assert.equal((await notifyMemory({...args,db:guardedDb})).status,'ALREADY_RESERVED_OR_LIMITED');assert.equal(sends,0);
 assert.equal((await notifyMemory({...args,now:new Date('2026-09-21T06:00:00Z')})).status,'NO_NEW_INSIGHT');assert.equal(sends,0);
});

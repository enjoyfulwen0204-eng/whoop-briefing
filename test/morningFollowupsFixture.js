// Synthetic shared report claims: legacy companion -> extras cutover regression.
import {fakeDb} from './fakes.js';
import {fixtureKeys} from './localDb.js';
import {createMorningSnapshotStore} from '../src/morningReportSnapshot.js';
const TZ='Asia/Taipei';
export function followFixture({at='2026-11-03T04:10:00Z',gap=0,nap=false}={}){
 const db=fakeDb(),state=new Map(),now=()=>new Date(at),user={id:'synthetic',lifecycleGeneration:1,timezone:TZ,status:'ACTIVE',createdAt:'2026-10-01T00:00:00Z'};
 let paused=0,quiet=false,generation=1,purge=0,access=2,chat="synthetic-chat";const day='2026-11-03',past=new Date(Date.parse(day)-gap*86400000).toISOString().slice(0,10);
 const sleeps=[{id:'sleep',health_date:past,nap:0,score_state:'SCORED',end_at:past+'T00:00:00Z',total_sleep_milli:8*3600000},...(nap?[{id:'nap',health_date:day,nap:1}]:[])];
 const rec=[{sleep_id:'sleep',score_state:'SCORED',user_calibrating:0,recovery_score:75}];
 db.transaction=async f=>f();db.getState=async k=>state.get(k);db.setState=async(k,v)=>state.set(k,v);
 db.getSleeps=async()=>sleeps;db.getRecoveries=async()=>rec;
 db.raw={execute:async({sql})=>({rows:sql.includes('notifications_paused')?[{notifications_paused:paused,quiet_start:quiet?'08:00':'22:00',quiet_end:quiet?'18:00':'08:00'}]:[{status:'ACTIVE',lifecycle_generation:1,timezone:TZ,auth_generation:1,purge_generation:purge,source_generation:generation,pending_purge_count:0,onboarding:'READY',connected:1,telegram_chat_id:chat,access_count:access,last_main_date:past,created_at:user.createdAt}]})};
 const originalClaim={owner:'original',lifecycleGeneration:1,deliveryState:'CLAIMED',telegramSentAt:null};db.claims.set('synthetic|daily|'+day,originalClaim);
 const originalGet=db.getClaim.bind(db);db.getClaim=originalGet;
 const store=createMorningSnapshotStore({db,keys:fixtureKeys}),sent=[];
 const telegram={send:async(text,{authorize}={})=>{if(authorize)await authorize();sent.push(text);return {sent:true,messageId:100};}};
 const input={db,keys:fixtureKeys,user,telegram,locale:'zh-TW',now};
 return {db,state,input,sent,sleeps,rec,originalClaim,store,day,setTime:v=>{at=v;},setPaused:v=>{paused=v;},setQuiet:v=>{quiet=v;},changeSource:()=>{generation++;},purge:()=>{purge++;},revokeAccess:()=>{access=0;},relink:()=>{chat="new-chat";},
  capture:async()=>{await store.capture({userId:user.id,healthDate:day,claim:originalClaim,briefing:{sleepId:'sleep',metrics:[{key:'recovery_score',value:35},{key:'sleep_total',value:4*3600000}]}});originalClaim.deliveryState='DELIVERED';originalClaim.telegramSentAt='2026-11-03T00:00:00Z';}};
}

// Reuses the already accepted three-user Morning Brief workload, with its
// physical synthetic provider moved outside the application cgroup.
import {createOwnedDb} from './stage5OwnedDb.js';import {WHOOP_SYNC} from '../src/config.js';
export const morningNow=new Date('2026-10-11T00:00:00Z');
export function morningRecords(){
 const sleeps=[],recoveries=[],cycles=[],workouts=[],day=86400000;
 for(let i=0;i<7;i++){
  const end=new Date(morningNow.getTime()-i*day-3600000).toISOString(),start=new Date(Date.parse(end)-7*3600000).toISOString();
  sleeps.push({id:`sleep-${i}`,user_id:1,start,end,timezone_offset:'+08:00',nap:false,score_state:'SCORED',created_at:end,updated_at:end,score:{stage_summary:{total_light_sleep_time_milli:4*3600000,total_slow_wave_sleep_time_milli:3600000,total_rem_sleep_time_milli:2*3600000},sleep_needed:{baseline_milli:8*3600000},sleep_performance_percentage:90}});
  recoveries.push({sleep_id:`sleep-${i}`,cycle_id:1000+i,user_id:1,score_state:'SCORED',created_at:end,updated_at:end,score:{recovery_score:65,resting_heart_rate:51,hrv_rmssd_milli:55}});
  cycles.push({id:1000+i,user_id:1,start:new Date(Date.parse(end)-day).toISOString(),end,score_state:'SCORED',created_at:end,updated_at:end,score:{strain:12}});
  if(i===1||i===4)workouts.push({id:`workout-${i}`,user_id:1,start,end,score_state:'SCORED',created_at:end,updated_at:end,score:{strain:9}});
 }return {sleeps,recoveries,cycles,workouts,body:{height_meter:1.75,weight_kilogram:70,max_heart_rate:190}};
}
export async function seedMorningProvider(url){
 const db=createOwnedDb({url}),data=morningRecords();try{
  await db.migrate({targetVersion:32});
  for(const [i,id] of ['alice','bob','lan'].entries()){
   await db.createUser({id,displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});await db.linkTelegram({userId:id,chatId:String(1001+i)});await db.setLocale(id,['en','zh-TW','vi'][i]);await db.ensureOnboarding(id,{state:'READY'});
   await db.saveTokens(id,{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000),whoopUserId:String(2001+i)});await db.saveCapabilities(id,[{key:'sleep',status:'SUPPORTED'}],{expectedLifecycleGeneration:1});
   await db.upsertSleeps(id,data.sleeps.slice(2),{timezone:'Asia/Taipei',now:morningNow});await db.upsertRecoveries(id,data.recoveries.slice(2),{now:morningNow});await db.upsertCycles(id,data.cycles.slice(2),{now:morningNow});
   for(const resource of WHOOP_SYNC.RESOURCES)await db.saveSyncState(id,resource,{backfillComplete:true,lastSuccessAt:new Date(morningNow.getTime()-3*3600000).toISOString()},{now:morningNow});
  }
 }finally{await db.close();}
}

// Data-only qualification fixture. No Production records, identities, provider
// credentials, runtime overrides, receipts or derived results are accepted here.
import assert from 'node:assert/strict';
import {bodyInput} from './bodyEnergyFixture.js';
import {localDate} from '../src/time.js';

export const OFFLINE_LIVE_USERS=Object.freeze(['a','b','c']);
export const OFFLINE_LIVE_RESOURCES=Object.freeze(['sleep','recovery','cycle','workout']);
export const OFFLINE_LIVE_TABLES=Object.freeze({sleep:'whoop_sleeps',recovery:'whoop_recoveries',cycle:'whoop_cycles',workout:'whoop_workouts'});
const DAY=86400000,HOUR=3600000,HEAVY_ROWS=40;
const counts=n=>Object.fromEntries(OFFLINE_LIVE_RESOURCES.map(type=>[type,n]));
const assertProfile=profile=>assert.ok(['empty','dense'].includes(profile),'EXPLICIT_SYNTHETIC_PROFILE_REQUIRED');

export function offlineLiveFixtureShape(profile){
 assertProfile(profile);
 return {contract:'stage8-live-synthetic-shape-v2',syntheticUsers:3,heavyUser:profile==='dense'?'a':null,
  historyDaysPerUser:Object.fromEntries(OFFLINE_LIVE_USERS.map(id=>[id,profile==='dense'&&id==='a'?HEAVY_ROWS-1:0])),
  expectedRowsPerUser:Object.fromEntries(OFFLINE_LIVE_USERS.map(id=>[id,counts(profile==='dense'&&id==='a'?HEAVY_ROWS:0)])),
  expectedTotalRows:counts(profile==='dense'?HEAVY_ROWS:0),
  provenance:{kind:'SYNTHETIC_COUNT_ENVELOPE_ONLY',productionRecordsUsed:false,productionHealthValuesUsed:false,
   description:'One synthetic 40-row-per-resource user plus two empty users, or three empty users. Counts exercise a bounded workload envelope; values and identifiers are synthetic.',
   limitation:'Three-user scheduling coverage; not three simultaneously dense users, a Production capacity proof, or a Production workload execution.'}};
}

export function offlineLiveFixtureInput({profile,userId,asOf}){
 assertProfile(profile);assert.ok(OFFLINE_LIVE_USERS.includes(userId),'SYNTHETIC_COHORT_REQUIRED');
 assert.ok(Number.isSafeInteger(asOf)&&Number.isFinite(new Date(asOf).getTime()),'EXACT_SYNTHETIC_AS_OF_REQUIRED');
 const dense=profile==='dense'&&userId==='a',input=bodyInput({asOf,days:HEAVY_ROWS-1}),iso=ms=>new Date(ms).toISOString(),at=iso(asOf);
 input.userId=userId;
 for(const type of OFFLINE_LIVE_RESOURCES)input.sources[type]=dense?input.sources[type].map(row=>({...row,user_id:userId})):[];
 for(const name of ['access','sync','capabilities'])input[name]=input[name].map(row=>({...row,user_id:userId}));
 if(dense){
  input.sources.cycle=[];input.sources.workout=[];
  for(let n=0;n<HEAVY_ROWS;n++){
   const wake=asOf-n*DAY,id=`cycle-${String(n).padStart(2,'0')}`,start=wake-8*HOUR,end=n===0?null:wake+16*HOUR;
   // Match each Recovery to its main-sleep cycle; only the newest cycle is
   // open. Older cycles end exactly when the next daily cycle starts.
   input.sources.recovery[n].cycle_id=id;
   input.sources.cycle.push({user_id:userId,id,start_at:iso(start),end_at:end===null?null:iso(end),
    score_state:'SCORED',strain:3,created_at:iso(start),updated_at:end===null?at:iso(end),synced_at:at});
   // Completed daytime activity preceding this main sleep, never future or
   // overlapping the synthetic eight-hour main-sleep interval.
   const workoutStart=wake-12*HOUR,workoutEnd=wake-11*HOUR;
   input.sources.workout.push({user_id:userId,id:`workout-${String(n).padStart(2,'0')}`,
    health_date:localDate(new Date(workoutEnd),input.timezone),start_at:iso(workoutStart),end_at:iso(workoutEnd),
    sport_name:'Synthetic activity',score_state:'SCORED',strain:3,created_at:iso(workoutStart),updated_at:iso(workoutEnd),synced_at:at});
  }
 }
 return input;
}

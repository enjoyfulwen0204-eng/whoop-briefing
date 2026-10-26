import test from 'node:test';
import assert from 'node:assert/strict';
import {runDaily} from '../src/daily.js';
import {makeDataset} from './fixtures.js';
import {LIFECYCLE_UNFENCED} from '../src/accountLifecycle.js';
import {BRIEFING_OUTCOME} from '../src/briefingState.js';

const impossible=()=>{throw Error('EXPIRED_OBSERVATION_MUST_NOT_CREATE_OR_SEND_REPORT');};
function fixture({delivered,previous=null}){
 const observedAt=new Date('2026-10-20T01:00:00.000Z'),data=makeDataset({now:observedAt,wakeMinutesAgo:45});
 const now=new Date(observedAt.getTime()+72*3600000),evaluations=[],notifications=[];let polls=0;
 const db={isSent:async()=>delivered,getBriefingEvaluation:async()=>previous,
  recordBriefingEvaluation:async row=>{evaluations.push(row);},claimReport:impossible};
 const args={db,userId:'synthetic',timezone:'Asia/Kuala_Lumpur',now,presentationClock:()=>now,
  expectedLifecycleGeneration:LIFECYCLE_UNFENCED,
  source:{poll:async()=>{polls++;return data;},history:impossible},coach:{},
  telegram:{send:impossible,notifyError:async(...args)=>{notifications.push(args);}}};
 return {args,evaluations,notifications,get polls(){return polls;}};
}

test('expired already delivered wake records the current evaluation without another claim or notification',async()=>{
 const f=fixture({delivered:true}),result=await runDaily(f.args);
 assert.equal(result.status,'already_sent');assert.equal(result.staleObservation,true);
 assert.equal(f.polls,1);assert.equal(f.evaluations.length,1);
 const row=f.evaluations[0];assert.equal(row.outcome,BRIEFING_OUTCOME.ALREADY_SENT);
 assert.equal(row.evaluatedAt,f.args.now.toISOString());assert.equal(row.localDate,'2026-10-23');
 assert.equal(row.targetHealthDate,result.healthDate);assert.notEqual(row.targetHealthDate,row.localDate);
 assert.equal(row.reason,'prior_health_date');assert.equal(row.retryable,false);
 assert.deepEqual(f.notifications,[]);
 // Every natural later poll gets a fresh operational observation, while
 // preserving the same accepted health-day identity and zero send attempts.
 f.args.presentationClock=()=>new Date(f.args.now.getTime()+3600000);
 const later=await runDaily(f.args);assert.deepEqual(later,result);
 assert.equal(f.evaluations.length,2);assert.notEqual(f.evaluations[1].evaluatedAt,row.evaluatedAt);
 assert.deepEqual(f.notifications,[]);
});

test('expired unsent wake retains the one-time MISSED policy',async()=>{
 const f=fixture({delivered:false}),result=await runDaily(f.args);
 assert.equal(result.status,'missed');assert.equal(f.evaluations.length,1);
 assert.equal(f.evaluations[0].outcome,BRIEFING_OUTCOME.MISSED);
 assert.equal(f.evaluations[0].reason,'sleep_too_old');assert.equal(f.notifications.length,1);
 const repeated=fixture({delivered:false,previous:{outcome:BRIEFING_OUTCOME.MISSED,targetHealthDate:result.healthDate}});
 assert.equal((await runDaily(repeated.args)).status,'missed');
 assert.equal(repeated.evaluations.length,0);assert.equal(repeated.notifications.length,0);
});

test('evaluation persistence failure keeps an accepted expired report deduplicated',async()=>{
 const f=fixture({delivered:true});f.args.db.recordBriefingEvaluation=async()=>{throw Error('SYNTHETIC_EVALUATION_UNAVAILABLE');};
 assert.equal((await runDaily(f.args)).status,'already_sent');assert.equal(f.polls,1);
 assert.deepEqual(f.notifications,[]);
});

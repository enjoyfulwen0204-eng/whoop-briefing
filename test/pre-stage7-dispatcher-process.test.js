import test from 'node:test';import assert from 'node:assert/strict';import {fork} from 'node:child_process';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';
import {createBriefingEndpoint} from '../src/briefingEndpoint.js';
import {discoverPhaseContinuation} from '../src/phase4Continuation.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';import {runningReleaseSha} from '../src/phase4Release.js';
import {MAX_CONTINUATION_SEGMENTS} from '../cloudflare/briefing-scheduler/worker.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'},secret='synthetic-worker-restart-only-secret-32bytes';
test('SIGKILL Worker after a committed HTTP receipt; new OS process discovers and finalizes the original identity once',async t=>{
 const {db}=await deliveryFixture(t);let victim,killed=false,callbacks=0,sideEffects=0;const bodies=[],serverRuns=[];
 const endpoint=createBriefingEndpoint({secret,environment,
  discoverContinuation:options=>discoverPhaseContinuation({...options,db,keys:fixtureKeys,environment}),
  runPhase:options=>runExecutionPhase({...options,db,keys:fixtureKeys,environment,env:{dryRun:true},budgetMs:500,
   deps:{runBriefing:async()=>{
    callbacks++;
    await db.transaction(async()=>{
     sideEffects++;await db.raw.execute("INSERT INTO telegram_state(key,value,updated_at) VALUES('restart_effect','1','2026-10-09') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1");return 1;
    },{workStep:'dispatcher-restart-business'});
    if(!killed){killed=true;victim.kill('SIGKILL');await new Promise(resolve=>setTimeout(resolve,750));}
    return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0};
   }}})});
 const env={BRIEFING_ENDPOINT_URL:'https://isolated.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:secret,BRIEFING_RELEASE_SHA:runningReleaseSha(),BRIEFING_EXECUTION_MODE:'OFF',
  BRIEFING_CONFIG_PROOF:configurationProof(fixtureKeys,{runtime:'off',mode:'off'},environment),BRIEFING_CONTINUATION_DISCOVERY:'on'};
 function start(){
  const child=fork(new URL('./continuationWorkerChild.js',import.meta.url),[JSON.stringify(env)],{execArgv:[],silent:true});let finished;
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  child.on('message',message=>{
   if(message.type==='finished')finished=message.result;
   if(message.type!=='request')return;
   const path=new URL(message.url).pathname;if(path.endsWith('/run'))bodies.push(message.body);
   const pending=endpoint({method:'POST',url:path,headers:message.headers},message.body).then(result=>{
    if(child.connected)child.send({type:'response',id:message.id,result});return result;
   });serverRuns.push(pending);
  });
  return {child,closed:new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal,finished})))};
 }
 const first=start();victim=first.child;assert.equal((await first.closed).signal,'SIGKILL');
 await Promise.all(serverRuns);const row=(await db.raw.execute('SELECT * FROM phase4_executions')).rows[0];
 assert.equal(row.state,'ESTABLISHED');assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_execution_work_receipts')).rows[0].n,1);
 const second=start(),result=await second.closed;assert.equal(result.code,0);assert.equal(result.finished.ok,true);
 // A loaded 500ms segment may require additional bounded retries; ownership
 // and the single committed effect must remain invariant across all of them.
 await Promise.all(serverRuns);assert.ok(bodies.length>=2&&bodies.length<=1+MAX_CONTINUATION_SEGMENTS);
 assert.ok(bodies.every(body=>body===bodies[0]),'every bounded retry must retain the killed Worker identity');
 assert.ok(callbacks>=2&&callbacks<=bodies.length);assert.equal(sideEffects,1);
 assert.equal((await db.raw.execute("SELECT value FROM telegram_state WHERE key='restart_effect'")).rows[0].value,'1');
 const rows=(await db.raw.execute('SELECT state,generation FROM phase4_executions')).rows;assert.equal(rows.length,1);assert.equal(rows[0].state,'FINALIZED_SUCCESS');assert.ok(rows[0].generation>=2&&rows[0].generation<=bodies.length);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_execution_work_receipts')).rows[0].n,1,'all segments converge on one committed business effect');
});

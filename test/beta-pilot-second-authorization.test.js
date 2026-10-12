import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {createDb,fixtureKeys} from './localDb.js';
import {OWNER_PILOT_APPROVAL_SHA256,OWNER_SECOND_PILOT_APPROVAL_SHA256,reviewedPilotAllowance} from '../src/betaPilotAllowance.js';
import {betaPilotConfiguration,reviewedPilotAdmission,createBetaPilotPermit,withBetaPilotAttempt,PILOT_DURATION_MS} from '../src/betaPilotPermit.js';
import {runExecutionPhase,discoverExecutionContinuation} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';import {publicBetaConfiguration} from '../src/publicBetaConfig.js';import {runningReleaseSha} from '../src/phase4Release.js';
const oldComponent='phase4_beta_pilot_permit_v1',newComponent='phase4_beta_pilot_permit_owner_20261012_v2';
const oldEnv=()=>({PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',BRIEFING_CONTINUATION_SCOPE:'sync-and-stage6-shadow',
 PHASE4_BETA_PILOT_ID:'a'.repeat(64),PHASE4_BETA_PILOT_USER_ID:'pilot-user',PHASE4_BETA_PILOT_START_AT:'2026-10-11T07:07:02.633Z',
 PHASE4_BETA_PILOT_CONSENT_SHA256:'b'.repeat(64),PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_PILOT_APPROVAL_SHA256,PHASE4_BETA_PILOT_STOP:'off'});
const environment=()=>({...oldEnv(),PHASE4_BETA_PILOT_START_AT:'FIRST_RESERVATION',PHASE4_BETA_PILOT_ALLOWANCE_ID:OWNER_SECOND_PILOT_APPROVAL_SHA256});
const read=async(db,component)=>(await db.raw.execute({sql:"SELECT last_detail FROM system_heartbeats WHERE scope='global' AND component=?",args:[component]})).rows[0]?.last_detail??null;
const permit=(db,env=environment())=>{const config=betaPilotConfiguration(env);return createBetaPilotPermit({db,keys:fixtureKeys,config,reservation:reviewedPilotAdmission(config)});};
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'second-pilot-')),url='file:'+join(dir,'db'),db=createDb({url}),owned=[db];
 t.after(async()=>{for(const d of owned.reverse())d.close();await rm(dir,{recursive:true,force:true});});await db.migrate();await db.admitRuntime();
 await db.createUser({id:'pilot-user',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});await db.ensureOnboarding('pilot-user');
 await db.raw.execute("UPDATE user_onboarding SET state='READY' WHERE user_id='pilot-user'");
 const config=betaPilotConfiguration(oldEnv()),reservation=reviewedPilotAdmission(config),state={version:1,fingerprint:fixtureKeys.lookup(['beta-pilot-v1',config,reservation]),
  startAt:config.startAt,endAt:config.endAt,lifecycleGeneration:1,attempts:4,lastObservedAt:config.startAt+1000,closed:false};
 const original=JSON.stringify({...state,signature:fixtureKeys.lookup(['beta-pilot-state-v1',state])});
 await db.raw.execute({sql:"INSERT INTO system_heartbeats(scope,component,last_detail,last_ok_at,updated_at) VALUES('global',?,?,'2026-10-11T07:07:03.633Z','2026-10-11T07:07:03.633Z')",args:[oldComponent,original]});
 return {db,url,original,own:d=>{owned.push(d);return d;}};
}
test('second authorization is exact typed policy; legacy start and copied remote policy cannot grant it',()=>{
 const env=environment(),c=betaPilotConfiguration(env),r=reviewedPilotAdmission(c);
 assert.equal(c.startAt,null);assert.equal(c.endAt,null);assert.equal(r.budgetMicroUsd,2000000);assert.equal(r.maxAttempts,12);
 assert.throws(()=>betaPilotConfiguration({...env,PHASE4_BETA_PILOT_START_AT:new Date().toISOString()}),/BETA_PILOT_DENIED/);
 assert.throws(()=>betaPilotConfiguration({...oldEnv(),PHASE4_BETA_PILOT_START_AT:'FIRST_RESERVATION'}),/BETA_PILOT_DENIED/);
 assert.throws(()=>createBetaPilotPermit({db:{raw:{protocol:'http'},transaction(){}},keys:fixtureKeys,config:c,reservation:{...r}}),/BETA_PILOT_DENIED/);
 assert.notEqual(configurationProof(fixtureKeys,publicBetaConfiguration(env),env),configurationProof(fixtureKeys,publicBetaConfiguration(oldEnv()),oldEnv()));
});
test('availability does not start or reserve the new window and preserves the expired original ledger',async t=>{
 const {db,original}=await fixture(t),s=await permit(db).availability();assert.equal(s.possible,true);assert.equal(s.windowStarted,false);assert.equal(s.startAt,null);assert.equal(s.endAt,null);assert.equal(s.remainingAttempts,12);
 assert.equal(await read(db,newComponent),null);assert.equal(await read(db,oldComponent),original);assert.deepEqual(await permit(db,oldEnv()).availability(),{possible:false});
});
test('first reservation sets durable database start once; restart and failed work consume without refund',async t=>{
 const {db,original}=await fixture(t),before=Date.now(),p=permit(db),g=await p.reserve(),s=JSON.parse(await read(db,newComponent));
 assert.equal(g.attempt,1);assert.ok(s.startAt>=before-1000&&s.startAt<=Date.now()+1000);assert.equal(s.endAt-s.startAt,PILOT_DURATION_MS);assert.equal(s.version,2);
 await assert.rejects(()=>withBetaPilotAttempt(g,'pilot-user',async()=>{throw Error('synthetic failure');}),/synthetic failure/);
 await assert.rejects(()=>withBetaPilotAttempt(g,'pilot-user',async()=>{}),/BETA_PILOT_DENIED/);
 const g2=await permit(db).reserve(),s2=JSON.parse(await read(db,newComponent));assert.equal(g2.attempt,2);assert.equal(s2.startAt,s.startAt);assert.equal(s2.endAt,s.endAt);assert.equal(await read(db,oldComponent),original);
 for(const change of [{PHASE4_BETA_PILOT_ID:'e'.repeat(64)},{PHASE4_BETA_PILOT_USER_ID:'other'},{PHASE4_BETA_PILOT_CONSENT_SHA256:'c'.repeat(64)}])await assert.rejects(()=>permit(db,{...environment(),...change}).reserve(),/BETA_PILOT_DENIED/);
 assert.equal(JSON.parse(await read(db,newComponent)).attempts,2);
});
test('concurrent connections share twelve new slots without changing the four original slots',async t=>{
 const {db,url,own,original}=await fixture(t),other=own(createDb({url}));await other.admitRuntime();const ps=[permit(db),permit(other)];
 const rs=await Promise.allSettled(Array.from({length:18},(_,i)=>ps[i%2].reserve()));const yes=rs.filter(x=>x.status==='fulfilled');assert.equal(yes.length,12);
 assert.deepEqual(new Set(yes.map(x=>x.value.attempt)),new Set(Array.from({length:12},(_,i)=>i+1)));assert.equal(JSON.parse(await read(db,newComponent)).attempts,12);
 assert.deepEqual(await permit(db).availability(),{possible:false});await assert.rejects(()=>permit(db).reserve(),/BETA_PILOT_DENIED/);assert.equal(await read(db,oldComponent),original);
});
test('missing predecessor, changed consent and prior lifecycle cannot initialize a new ledger',async t=>{
 const {db}=await fixture(t);await db.raw.execute("UPDATE users SET lifecycle_generation=2 WHERE id='pilot-user'");await assert.rejects(()=>permit(db).reserve(),/BETA_PILOT_DENIED/);assert.equal(await read(db,newComponent),null);
 await db.raw.execute("UPDATE users SET lifecycle_generation=1 WHERE id='pilot-user'");await assert.rejects(()=>permit(db,{...environment(),PHASE4_BETA_PILOT_CONSENT_SHA256:'e'.repeat(64)}).reserve(),/BETA_PILOT_DENIED/);
 await db.raw.execute({sql:"DELETE FROM system_heartbeats WHERE component=?",args:[oldComponent]});await assert.rejects(()=>permit(db).reserve(),/BETA_PILOT_DENIED/);assert.equal(await read(db,newComponent),null);
});
test('new expiry closes only the second ledger; database rollback and restart cannot renew it',async t=>{
 const {db,original}=await fixture(t),p=permit(db),g=await p.reserve(),s=JSON.parse(await read(db,newComponent)),execute=db.raw.execute.bind(db.raw);let now=s.endAt;
 db.raw.execute=async q=>{const r=await execute(q);if(q?.sql?.includes('observed_at')&&q.sql.includes('user_onboarding'))r.rows[0].observed_at=now;return r;};
 await assert.rejects(()=>g.assert(),/BETA_PILOT_DENIED/);assert.equal(JSON.parse(await read(db,newComponent)).closed,true);now=s.startAt+1000;
 await assert.rejects(()=>permit(db).reserve(),/BETA_PILOT_DENIED/);const after=JSON.parse(await read(db,newComponent));assert.equal(after.attempts,1);assert.equal(after.endAt,s.endAt);assert.equal(await read(db,oldComponent),original);
});
test('uncertain reservation commit never refunds; a fresh call consumes another new slot',async t=>{
 const {db,original}=await fixture(t),transaction=db.transaction.bind(db);let fail=true;
 db.transaction=async(...args)=>{const result=await transaction(...args);if(fail){fail=false;throw Error('synthetic unknown commit');}return result;};
 await assert.rejects(()=>permit(db).reserve(),/synthetic unknown commit/);assert.equal(JSON.parse(await read(db,newComponent)).attempts,1);assert.equal((await permit(db).reserve()).attempt,2);assert.equal(await read(db,oldComponent),original);
});
test('tampered or duplicate signed state denies restart without resetting either ledger',async t=>{
 const {db,original}=await fixture(t);await permit(db).reserve();const raw=await read(db,newComponent);const bad=raw.replace('{','{"attempts":0,');
 await db.raw.execute({sql:"UPDATE system_heartbeats SET last_detail=? WHERE component=?",args:[bad,newComponent]});await assert.rejects(()=>permit(db).reserve(),/BETA_PILOT_DENIED/);assert.equal(await read(db,newComponent),bad);assert.equal(await read(db,oldComponent),original);
});
test('actual admitted phase composition starts only on DRAIN; final replay consumes no extra slot',async t=>{
 const {db,original}=await fixture(t),env=environment(),calls=[],opts={db,environment:env,keys:fixtureKeys,env:{timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1,telegramBotToken:'SYNTHETIC',telegramChatId:'SYNTHETIC'},
  deps:{runBriefing:async()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0}),runtime:{phase4Stage6:{drain:async x=>{calls.push(x.userId);return {outcome:'NO_WORK',jobsConsidered:0,itemsAttempted:0,processedItems:0,completedJobs:0,remainingJobs:0};}}}}};
 const req=(phase,extra={})=>({releaseSha:runningReleaseSha(),requestId:randomUUID(),phase,triggerSource:'manual',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(env),env),...extra});
 const sr=req('SYNC'),s=await runExecutionPhase({...opts,request:sr});assert.equal(s.body.syncComplete,true);assert.equal(s.body.drainAuthorized,true);assert.equal(await read(db,newComponent),null);
 const dr=req('STAGE6_DRAIN',{syncRequestId:sr.requestId,handoff:s.body.handoff}),d=await runExecutionPhase({...opts,request:dr});assert.equal(d.body.ok,true);assert.deepEqual(calls,['pilot-user']);assert.equal(JSON.parse(await read(db,newComponent)).attempts,1);
 assert.deepEqual(await runExecutionPhase({...opts,request:dr}),d);assert.equal(JSON.parse(await read(db,newComponent)).attempts,1);assert.equal(await read(db,oldComponent),original);
 for(let i=0;i<11;i++)await permit(db).reserve();
 assert.deepEqual(await runExecutionPhase({...opts,request:dr}),d);assert.equal(JSON.parse(await read(db,newComponent)).attempts,12);
 const denied=await runExecutionPhase({...opts,request:req('STAGE6_DRAIN',{syncRequestId:sr.requestId,handoff:s.body.handoff})});
 assert.equal(denied.body.result.outcome,'DISABLED');assert.deepEqual(calls,['pilot-user']);assert.equal(JSON.parse(await read(db,newComponent)).attempts,12);
 env.PHASE4_BETA_PILOT_STOP='on';const stopped=await runExecutionPhase({...opts,request:req('SYNC')});assert.equal(stopped.body.syncComplete,true);assert.equal(stopped.body.drainAuthorized,false);
});
test('actual scheduler discovery admits before lazy availability and keeps the window unstarted',async t=>{
 const {db,original}=await fixture(t),env=environment(),query={releaseSha:runningReleaseSha(),triggerSource:'cloudflare',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(env),env),scope:'sync-and-stage6-shadow'};
 const d=await discoverExecutionContinuation({db,keys:fixtureKeys,environment:env,query});assert.equal(d.status,200);assert.equal(d.body.state,'NONE');assert.equal(await read(db,newComponent),null);assert.equal(await read(db,oldComponent),original);
});
test('missing or corrupt optional ledger disables DRAIN without blocking ordinary SYNC or discovery',async t=>{
 const {db}=await fixture(t),env=environment();let calls=0;
 const opts={db,keys:fixtureKeys,environment:env,env:{dryRun:true},deps:{runBriefing:async()=>{calls++;return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0};}}};
 const request=()=>({releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:'manual',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(env),env)});
 await db.raw.execute({sql:"DELETE FROM system_heartbeats WHERE component=?",args:[oldComponent]});
 const missing=await runExecutionPhase({...opts,request:request()});assert.equal(missing.body.syncComplete,true);assert.equal(missing.body.drainAuthorized,false);assert.equal(calls,1);
 const query={releaseSha:runningReleaseSha(),triggerSource:'cloudflare',executionMode:'SHADOW',scope:'sync-and-stage6-shadow',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(env),env)};
 const absent=await discoverExecutionContinuation({db,keys:fixtureKeys,environment:env,query});assert.equal(absent.status,200);
 await db.raw.execute({sql:"INSERT INTO system_heartbeats(scope,component,last_ok_at,last_detail,updated_at) VALUES('global',?,'2026-10-11T07:07:03.633Z','BROKEN','2026-10-11T07:07:03.633Z')",args:[oldComponent]});
 const corrupt=await runExecutionPhase({...opts,request:request()});assert.equal(corrupt.body.syncComplete,true);assert.equal(corrupt.body.drainAuthorized,false);assert.equal(calls,2);
 const bad=await discoverExecutionContinuation({db,keys:fixtureKeys,environment:env,query});assert.equal(bad.status,200);assert.equal(await read(db,newComponent),null);
});

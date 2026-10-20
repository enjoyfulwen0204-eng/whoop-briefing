/** SYNTHETIC ONLY: real native SQLite, fixed public supervisor/ingress/processor,
 * mock SDK target construction and mock WHOOP. Never Production evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtemp,realpath,chmod,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
const source=new URL('file:///Users/kelvin/Desktop/whoop-briefing/tmp/production-completion-20261016/stage8-normal-c-continuity-proposed-r3-20261020.private/normalCContinuity.mjs');
// The clean frozen public7410 graph is read-only. New engineering source is
// not a clean-release substitute or authority; only native target transport is mocked.
const app=new URL('file:///Users/kelvin/Desktop/whoop-briefing/tmp/production-completion-20261016/stage8-worktree/');
const urls=['src/productionSupervisorController.js','src/productionEpochBootstrap.js','src/db.js','src/productionFastControl.js','src/currentTerminalRuntime.js','src/productionInitializationRevocation.js'].map(p=>new URL(p,app).href);
const projections=new Set();
registerHooks({resolve(specifier,context,next){
 if(specifier==='@libsql/client'&&(urls.includes(context.parentURL)||projections.has(context.parentURL))){
  return {url:'data:text/javascript,'+encodeURIComponent('export function createClient(o){return globalThis.__normalCSyntheticSdk(o,'+JSON.stringify(context.parentURL)+');}'),shortCircuit:true};
 }
 return next(specifier,context);
}});
const {createClient}=await import('@libsql/client');
const {createOwnedDb}=await import(new URL('test/stage5OwnedDb.js',app));
const {hranaTransport}=await import(new URL('test/hranaTransport.js',app));
const {fixtureKeys:keys}=await import(new URL('test/localDb.js',app));
const {runningReleaseSha}=await import(new URL('src/phase4Release.js',app));
const {runMigrations}=await import(new URL('src/migrations.js',app));
const {computeWhoopSignature}=await import(new URL('src/whoopWebhookAuth.js',app));
const {createProductionSupervisorRuntime,sealProductionSupervisorCommand}=await import(urls[0]);
const {advanceProductionSupervisorBoot,qualifyProductionEpochOperator,sealProductionTransitionWindow,PRODUCTION_EPOCH_TARGET:P}=await import(urls[1]);
const {describeNormalCContinuity,openNormalCContinuity}=await import(source);
assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'),'1f8e25b1b0665138e283de2100d0266905207dfc1a143da0bda5d050f0041276');
const {stage8PreservationSnapshot}=await import(new URL('scripts/stage8-migration-safety.mjs',app));
const H=x=>createHash('sha256').update(x).digest('hex');
function request(runtime,path,{body='',method='POST',headers={}}={}){
 const req=Readable.from([Buffer.from(body)]);Object.assign(req,{url:path,method,headers});
 let resolve,reject;const completion=new Promise((r,j)=>{resolve=r;reject=j;});
 const res={headersSent:false,writableEnded:false,writeHead(status,h){this.status=status;this.headers=h;this.headersSent=true;},end(value=''){this.writableEnded=true;resolve(new Response(method==='HEAD'?null:value,{status:this.status,headers:this.headers}));},destroy(){reject(Error('SYNTHETIC_RESPONSE_DESTROYED'));}};
 void runtime.handler(req,res).catch(reject);return completion;
}
async function continuityFixture(t,{deleteBindingRace=false,loseClaimAck=false,restoreBindingAfterResolve=false,forceRefresh=false,hranaProfile=true,transactionMaxMs=Infinity,delayHttpMs=0,loseCanonicalCommitAck=false}={}){
 let forbidden=0,providerGets=0,tokenPosts=0,session,runtime,currentManifest,moved=false,restored=false,lost=false,operator,transport,helperHttpEnabled=false;
 const directory=await realpath(await mkdtemp(join(tmpdir(),'normal-C-SYNTHETIC-')));await chmod(directory,0o700);
 const dbPath=join(directory,'synthetic.sqlite'),privateRoot=join(directory,'protected');
 await (await import('node:fs/promises')).mkdir(privateRoot,{mode:0o700});
 const release=runningReleaseSha({});assert.equal(release,'7410b9039f77dc2860ac366e8c9f166a7870daaf');
 const ids=['91801','91802','91803'],at=Date.now()-10000,iso=new Date(at).toISOString();
 const env={PHASE4_BETA_PILOT_USER_ID:'SYNTHETIC-NORMAL-C-0',OPENROUTER_API_KEY:'SYNTHETIC-NOT-LIVE',PORT:'0',TURSO_DATABASE_URL:P.databaseUrl,TURSO_AUTH_TOKEN:'SYNTHETIC-NOT-LIVE',PHASE4_LOOKUP_KEY:'47'.repeat(32),PHASE4_AUDIT_KEY:'53'.repeat(32),PHASE4_EXECUTION_PROFILE:'STAGE8_SCHEMA_TRANSITION',PHASE4_RELEASE_SHA:release,RENDER_GIT_COMMIT:release,WHOOP_WEBHOOK_ENABLED:'on',WHOOP_CLIENT_ID:'SYNTHETIC',WHOOP_CLIENT_SECRET:'SYNTHETIC-WHOOP',TELEGRAM_BOT_TOKEN:'SYNTHETIC-TG',TELEGRAM_WEBHOOK_SECRET:'SYNTHETIC-TG-SECRET',BRIEFING_TRIGGER_SECRET:'SYNTHETIC-BRIEFING',STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'SYNTHETIC-NORMAL-C-0',STAGE7_AUTOMATIC:'off'};
 const seed=createOwnedDb({url:'file:'+dbPath});
 try{await seed.migrate({targetVersion:33});for(let i=0;i<3;i++){
  const uid='SYNTHETIC-NORMAL-C-'+i;
  await seed.raw.execute({sql:"INSERT INTO users(id,display_name,timezone,status,created_at,updated_at) VALUES(?,?,'Asia/Taipei','ACTIVE',?,?)",args:[uid,'Synthetic',iso,iso]});
  await seed.raw.execute({sql:"INSERT INTO user_whoop_tokens(user_id,whoop_user_id,access_token,refresh_token,scope,access_token_expires_at,updated_at) VALUES(?,?,'SYNTHETIC','SYNTHETIC','read:sleep read:recovery read:workout',?,?)",args:[uid,ids[i],new Date(Date.now()+3600000).toISOString(),iso]});
  await seed.raw.execute({sql:'INSERT INTO phase4_user_state(user_id,source_generation,purge_generation,pending_purge_count,created_at,updated_at) VALUES(?,0,0,0,?,?)',args:[uid,iso,iso]});
  await seed.raw.execute({sql:"INSERT INTO user_onboarding(user_id,state,state_changed_at,created_at,updated_at) VALUES(?,'READY',?,?,?)",args:[uid,iso,iso,iso]});
 }
 if(deleteBindingRace){
  await seed.raw.execute({sql:"INSERT INTO users(id,display_name,timezone,status,created_at,updated_at) VALUES('SYNTHETIC-OUTSIDE','Synthetic','Asia/Taipei','ACTIVE',?,?)",args:[iso,iso]});
  await seed.raw.execute({sql:"INSERT INTO user_whoop_tokens(user_id,whoop_user_id,access_token,refresh_token,scope,access_token_expires_at,updated_at) VALUES('SYNTHETIC-OUTSIDE','999999','SYNTHETIC','SYNTHETIC','read:sleep',?,?)",args:[new Date(Date.now()+3600000).toISOString(),iso]});
  await seed.raw.execute({sql:"INSERT INTO whoop_sleeps(user_id,id,whoop_user_id,synced_at,raw_json) VALUES('SYNTHETIC-OUTSIDE',?,'999999',?,?)",args:['12345678-1234-4234-8234-123456789abc',iso,JSON.stringify({SYNTHETIC_OUTSIDE_CANONICAL_MUST_SURVIVE:true})]});
 }

 const pending=[];
 for(let i=0;i<37;i++){
  const id='SYNTHETIC-EXEC-PENDING-'+i,identity=H('identity'+i),scope=H('scope'+i),config=H('config'),request={requestId:id,phase:'SYNC',releaseSha:'ca4bff7b711737527ca6c4e306d4a3ef555c9f3b',executionMode:'OFF',triggerSource:'manual',configProof:config};
  pending.push({sql:"INSERT INTO phase4_executions(execution_id,identity_digest,scope_key,canonical_request_json,phase,release_sha,execution_mode,trigger_source,config_proof,owner,generation,lease_until,deadline_at,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'OFF','manual',?,'SYNTHETIC',1,9999999999999,9999999999999,'ESTABLISHED',1,1)",args:[id,identity,scope,JSON.stringify(request),'SYNC',request.releaseSha,config]});
  for(let j=0;j<(i?35:36);j++)pending.push({sql:'INSERT INTO phase4_execution_work_receipts(execution_id,receipt_key,scope_key,request_digest,step_key,generation,committed_at,result_json) VALUES(?,?,?,?,?,1,1,NULL)',args:[id,H('receipt'+i+':'+j),scope,identity,H('step'+i+':'+j)]});
 }
 await seed.raw.batch(pending,'write');
 await seed.raw.execute('UPDATE phase4_executions SET lease_until=1,deadline_at=1');
 await seed.recordWhoopEvent({whoopUserId:'999999',eventType:'sleep.updated',resourceType:'sleep',resourceId:'99999999-1234-4234-8234-123456789abc',traceId:'SYNTHETIC-OUTSIDE-SCOPE',now:new Date()});
 }finally{seed.close();}
 await chmod(dbPath,0o600);
 if(hranaProfile)transport=hranaTransport('file:'+dbPath,{traceTransactions:true,transactionMaxMs});
 const sdk=[],nativeWriters=[];globalThis.__normalCSyntheticSdk=(o,parent)=>{
  assert.equal(o.url,P.databaseUrl);assert.equal(o.authToken,env.TURSO_AUTH_TOKEN);
  const c=createClient(hranaProfile&&helperHttpEnabled&&parent===urls[2]?o:{url:'file:'+dbPath,intMode:'number'});sdk.push(c);
  if(parent===urls[2]){
   const execute=c.execute.bind(c);
   c.execute=async(statement,...rest)=>{
    const result=await execute(statement,...rest),sql=typeof statement==='string'?statement:statement.sql??'';
    if(restoreBindingAfterResolve&&moved&&!restored&&/SELECT t.user_id, u.status, u.timezone/.test(sql)){
     restored=true;assert.equal(result.rows[0].user_id,'SYNTHETIC-OUTSIDE');
     const m=currentManifest,permit={key:m.permitKey,value:m.records[2].epochToken,updated_at:m.records[2].updated_at};
     await operator.batch([
      {sql:'INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?)',args:[permit.key,permit.value,permit.updated_at]},
      {sql:"UPDATE user_whoop_tokens SET whoop_user_id='999999' WHERE user_id='SYNTHETIC-OUTSIDE'",args:[]},
      {sql:"UPDATE user_whoop_tokens SET whoop_user_id=? WHERE user_id='SYNTHETIC-NORMAL-C-0'",args:[ids[0]]},
      {sql:'DELETE FROM telegram_state WHERE key=?',args:[permit.key]},
     ],'write');
    }
    return result;
   };
   const transaction=c.transaction.bind(c);
   c.transaction=async(...args)=>{
    const tx=await transaction(...args),profile={statements:0,sdkExecuteCalls:0,sdkBatchCalls:0,sdkCommitCalls:0,combinedFreshFence:0,fenceRoster:0,fenceBindings:0,fenceEvent:0,canonicalWrites:0,eventSettles:0};nativeWriters.push(profile);
    const observe=statement=>{const sql=typeof statement==='string'?statement:statement.sql??'';profile.statements++;if(sql.startsWith('SELECT /* normal-C immutable original scope */'))profile.combinedFreshFence++;if(sql.startsWith('SELECT u.id userId,u.status,u.lifecycle_generation'))profile.fenceRoster++;if(sql.startsWith('SELECT user_id,whoop_user_id FROM user_whoop_tokens WHERE whoop_user_id IN'))profile.fenceBindings++;if(sql==='SELECT * FROM whoop_webhook_events WHERE id=?')profile.fenceEvent++;if(/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)&&sql.includes('whoop_sleeps'))profile.canonicalWrites++;if(/UPDATE whoop_webhook_events\s+SET state = \?/.test(sql))profile.eventSettles++;};
    const execute=tx.execute.bind(tx),batch=tx.batch.bind(tx),commit=tx.commit.bind(tx);let executeDepth=0;
    tx.execute=async(statement,...rest)=>{profile.sdkExecuteCalls++;observe(statement);executeDepth++;try{return await execute(statement,...rest);}finally{executeDepth--;}};
    tx.batch=async(statements,...rest)=>{if(!executeDepth){profile.sdkBatchCalls++;for(const statement of statements)observe(statement);}return batch(statements,...rest);};
    tx.commit=async(...args)=>{profile.sdkCommitCalls++;return commit(...args);};
    return tx;
   };
  }
  if((deleteBindingRace||loseClaimAck)&&parent===urls[2]){
   const batch=c.batch.bind(c);
   c.batch=async(queries,...rest)=>{
    const result=await batch(queries,...rest);
    if(deleteBindingRace&&!moved&&currentManifest&&queries.some(q=>/UPDATE whoop_webhook_events SET state='PROCESSING',owner=/.test(q.sql??''))){
     moved=true;const m=currentManifest,permit={key:m.permitKey,value:m.records[2].epochToken,updated_at:m.records[2].updated_at};
     await operator.batch([
      {sql:'INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?)',args:[permit.key,permit.value,permit.updated_at]},
      {sql:"UPDATE user_whoop_tokens SET whoop_user_id='777777' WHERE user_id='SYNTHETIC-NORMAL-C-0'",args:[]},
      {sql:"UPDATE user_whoop_tokens SET whoop_user_id=? WHERE user_id='SYNTHETIC-OUTSIDE'",args:[ids[0]]},
      {sql:'DELETE FROM telegram_state WHERE key=?',args:[permit.key]},
     ],'write');
    }
    if(loseClaimAck&&!lost&&queries.some(q=>/UPDATE whoop_webhook_events SET state='PROCESSING',owner=/.test(q.sql??''))){lost=true;throw Error('SYNTHETIC_CLAIM_ACK_LOST_AFTER_COMMIT');}
    return result;
   };
  }
  return c;
 };
 const service={id:P.service,ownerId:P.owner,repo:P.repo,autoDeploy:'no',suspended:'not_suspended',type:'web_service',serviceDetails:{maintenanceMode:{enabled:false},envSpecificDetails:{startCommand:'npm run bot:webhook'}}};
 const resource='12345678-1234-4234-8234-123456789abc',resource2='23456789-2345-4345-8345-23456789abcd';
 const providerRecord={id:resource,user_id:Number(ids[0]),nap:false,score_state:'PENDING_SCORE',start:'2026-10-19T00:00:00.000Z',end:'2026-10-19T01:00:00.000Z',created_at:'2026-10-19T01:00:01.000Z',updated_at:'2026-10-19T01:00:02.000Z'};
 t.mock.method(globalThis,'fetch',async(input,init)=>{
  const req=input instanceof Request?input:new Request(input,init),u=new URL(req.url);
  if(u.origin==='https://api.render.com'){
   const value=u.pathname.endsWith('/deploys')?[{deploy:{id:'SYNTHETIC-LIVE',status:'live',commit:{id:release}}}]:u.pathname.endsWith('/env-vars')?Object.entries(env).filter(([k])=>k!=='RENDER_GIT_COMMIT').map(([key,value])=>({envVar:{key,value}})):service;
   return new Response(JSON.stringify(value),{headers:{date:new Date().toUTCString(),'content-type':'application/json'}});
  }
  if(u.origin===P.origin&&runtime)return request(runtime,u.pathname,{method:req.method,body:req.method==='GET'?'':await req.text(),headers:Object.fromEntries(req.headers)});
  if(hranaProfile&&u.hostname===new URL(P.databaseUrl).hostname){if(delayHttpMs)await new Promise(resolve=>setTimeout(resolve,delayHttpMs));return transport.fetch(req,{role:'SYNTHETIC_NORMAL_C_CONTINUITY'});}
  if(u.origin==='https://api.prod.whoop.com'&&u.pathname==='/oauth/oauth2/token'){tokenPosts++;assert.equal(forceRefresh,true);return Response.json({access_token:'SYNTHETIC-ROTATED',refresh_token:'SYNTHETIC-ROTATED-REFRESH',expires_in:3600,scope:'read:sleep read:recovery read:workout',token_type:'Bearer'});}
  if(u.origin==='https://api.prod.whoop.com'&&[resource,resource2].some(id=>u.pathname==='/developer/v2/activity/sleep/'+id)){providerGets++;if(forceRefresh&&providerGets===1)return new Response('',{status:401});assert.equal(req.headers.get('authorization'),'Bearer '+(forceRefresh&&u.pathname.endsWith(resource)?'SYNTHETIC-ROTATED':'SYNTHETIC'));return Response.json({...providerRecord,id:u.pathname.endsWith(resource)?resource:resource2,user_id:Number(u.pathname.endsWith(resource)?ids[0]:ids[1])});}
  forbidden++;throw Error('REAL_NETWORK_FORBIDDEN');
 });
 const window={contract:'production-transition-r3-original-window-v1',approvalId:'owner-SYNTHETIC-NORMAL-C',originalWindowId:'SYNTHETIC-NORMAL-C-ORIGINAL-WINDOW',originalWindowStartMs:at,originalWindowEndMs:at+3600000,attemptNonce:H('synthetic-nonce'),startIdentity:H('synthetic-start'),source33RuntimeSha:release,targetRuntimeSha:release,historicalCa4BaselineSha:'ca4bff7b711737527ca6c4e306d4a3ef555c9f3b',origin:P.origin,databaseUrl:P.databaseUrl,resourceApiVersion:'v2',acceptFromMs:at,acceptUntilMs:at+3600000,tenants:ids.map((whoopUserId,i)=>({userId:'SYNTHETIC-NORMAL-C-'+i,whoopUserId,lifecycleGeneration:1,authGeneration:1,sourceGeneration:0,purgeGeneration:0}))};
 let sequence=0;
 const qualify=()=>qualifyProductionEpochOperator({operatorEnvironment:{...env,RENDER_API_KEY:'SYNTHETIC-RENDER'},signedWindow:sealProductionTransitionWindow({keys,window})});
 const command=async(action,qualification)=>{const now=Date.now(),sealed=sealProductionSupervisorCommand({keys,command:{contract:'production-supervisor-owner-command-v2',action,originalWindowId:window.originalWindowId,commandId:H('command-'+sequence++),issuedAtMs:now,expiresAtMs:now+120000,...(qualification?{operatorQualification:qualification}:{})}});const response=await request(runtime,'/internal/production-transition-control',{body:JSON.stringify(sealed)});assert.equal(response.status,200,await response.clone().text());return response.json();};
 const whoop=async(id=resource,whoopId=ids[0],trace='SYNTHETIC-ORIGINAL-TRACE')=>{const body=JSON.stringify({user_id:whoopId,id,type:deleteBindingRace?'sleep.deleted':'sleep.updated',trace_id:trace}),timestamp=String(Date.now());return request(runtime,'/whoop/webhook',{body,headers:{'x-whoop-signature-timestamp':timestamp,'x-whoop-signature':computeWhoopSignature(timestamp,body,env.WHOOP_CLIENT_SECRET)}});};
 operator=createClient({url:'file:'+dbPath,intMode:'number'});
 const original=await stage8PreservationSnapshot(operator,keys,{phase4_executions:{},phase4_execution_work_receipts:{}});assert.equal(original.phase4_executions.count,37);assert.equal(original.phase4_execution_work_receipts.count,1296);
 try{
  assert.equal(describeNormalCContinuity().actualActions,0);
  await assert.rejects(openNormalCContinuity(undefined),{code:'CONTINUITY_SOURCE_REVIEW_PENDING'});
  await advanceProductionSupervisorBoot({environment:env});runtime=await createProductionSupervisorRuntime({environment:env});
  const q=await qualify();await command('prepare',q);
  assert.equal(runtime.status().businessReady,false);
  assert.equal((await request(runtime,'/telegram/webhook',{body:'SYNTHETIC-NOT-AN-UPDATE'})).status,503);
  assert.equal((await whoop()).status,200);if(!deleteBindingRace&&!loseClaimAck)assert.equal((await whoop(resource2,ids[1],'SYNTHETIC-SECOND-TRACE')).status,200);
  const initial=(await operator.execute('SELECT * FROM whoop_webhook_events ORDER BY id')).rows,before=initial.filter(r=>r.trace_id==='SYNTHETIC-ORIGINAL-TRACE');assert.equal(initial.length,deleteBindingRace||loseClaimAck?2:3);assert.equal(before.length,1);assert.equal(before[0].state,'RECEIVED');assert.equal(before[0].attempt_count,0);assert.equal(providerGets,0);
  const {createProductionEpochBootstrap,requireProductionEpochBootstrap}=await import(urls[1]);
  const bootstrap=createProductionEpochBootstrap({environment:env,operatorQualification:q}),observed=await bootstrap.observeRestart(),manifest=requireProductionEpochBootstrap(observed,keys).s;bootstrap.close();currentManifest=manifest;
  const transition=async(from,to)=>operator.execute({sql:'UPDATE telegram_state SET value=?,updated_at=? WHERE key=? AND value=? AND updated_at=?',args:[to.value,to.updated_at,manifest.registryKey,from.value,from.updated_at]});
  await transition(manifest.records[0],manifest.records[1]);
  const tx=await operator.transaction('write');try{for(const statement of manifest.sourceTriggers)await tx.execute('DROP TRIGGER '+/^CREATE TRIGGER ("[^"]+")/.exec(statement.sql)[1]);await runMigrations(tx,{allowRebuild:false,targetVersion:35,privacyKeys:keys});for(const statement of manifest.targetTriggers)await tx.execute(statement);await tx.commit();}finally{tx.close();}
  await transition(manifest.records[1],manifest.records[2]);await command('resume');
  assert.equal(runtime.status().businessReady,true);assert.equal(runtime.status().maintenance,false);
  const projected=join(directory,'synthetic-projection.mjs');let body=await readFile(source,'utf8');body=body.replace("const STATUS='PENDING_INDEPENDENT_REVIEW';","const STATUS='SOURCE_REVIEWED_FIXED_COMPOSITION';").replace("const ROOT='/Users/kelvin/WHOOP-Private-Recovery';",'const ROOT='+JSON.stringify(privateRoot)+';').replaceAll('../stage8-worktree/',app.href);await writeFile(projected,body,{mode:0o600});projections.add(pathToFileURL(projected).href);
  const api=await import(pathToFileURL(projected).href);if(loseCanonicalCommitAck)transport.arm({matchSql:/INSERT INTO whoop_sleeps/,loseAcknowledgement:true});helperHttpEnabled=true;session=await api.openNormalCContinuity({environment:env});
  const outsideBefore=(await operator.execute("SELECT * FROM whoop_sleeps WHERE user_id='SYNTHETIC-OUTSIDE'")).rows;
  const result=await session.consumeOne();
  if(transactionMaxMs!==Infinity||loseCanonicalCommitAck){
   assert.equal(result.status,'UNKNOWN_RETAIN_ORIGINAL_OWNER_READONLY_RECONCILE_ONLY',JSON.stringify(result));
   assert.equal(providerGets,1);assert.equal(tokenPosts,0);
   const held=(await operator.execute({sql:'SELECT * FROM whoop_webhook_events WHERE id=?',args:[before[0].id]})).rows[0];
   assert.equal(held.state,'PROCESSING');assert.equal(held.attempt_count,1);assert.ok(held.owner.startsWith('normal-C:'));
   const canonical=(await operator.execute({sql:'SELECT user_id,id FROM whoop_sleeps WHERE user_id=? AND id=?',args:['SYNTHETIC-NORMAL-C-0',resource]})).rows;
   assert.equal(canonical.length,loseCanonicalCommitAck?1:0);
   if(transactionMaxMs!==Infinity)assert.ok(transport.evidence.some(e=>e.event==='transaction_timeout'&&e.limitMs===5000));
   if(loseCanonicalCommitAck)assert.ok(transport.evidence.some(e=>e.event==='commit_durable'));
   assert.equal((await session.reconcile({eventId:held.id})).status,'ORIGINAL_OUTCOME_UNKNOWN_RETAINED');
   const observer=await api.openNormalCContinuity({environment:env}),cold=await observer.consumeOne({eventId:held.id});
   assert.equal(cold.status,'ORIGINAL_INTENT_ALREADY_CONSUMED_READ_ONLY');assert.equal(cold.newClaims,0);assert.equal(cold.observation.status,'ORIGINAL_OUTCOME_UNKNOWN_RETAINED');assert.equal(providerGets,1);
   const retained=(await operator.execute({sql:'SELECT owner,lease_expires_at,attempt_count FROM whoop_webhook_events WHERE id=?',args:[held.id]})).rows[0];
   assert.deepEqual(retained,{owner:held.owner,lease_expires_at:held.lease_expires_at,attempt_count:1});
   assert.deepEqual(await stage8PreservationSnapshot(operator,keys,original),original);
   assert.throws(()=>observer.close(),{code:'CONTINUITY_UNKNOWN_OR_ACTIVE_OWNERSHIP_RETAINED'});
   assert.throws(()=>session.close(),{code:'CONTINUITY_UNKNOWN_OR_ACTIVE_OWNERSHIP_RETAINED'});
   t.diagnostic(JSON.stringify({syntheticOnly:true,mode:loseCanonicalCommitAck?'CANONICAL_COMMIT_ACK_LOST':'MODELED_NATIVE_5000MS_EXPIRY',requestDelayMs:delayHttpMs,transportEvidence:transport.evidence.filter(e=>e.event==='transaction_timeout'||e.event==='commit_durable'),originalExecutions:37,originalBindings:1296,remoteRuntimeQualified:false}));
  }else if(deleteBindingRace){
   assert.equal(moved,true);assert.equal(result.status,'UNKNOWN_RETAIN_ORIGINAL_OWNER_READONLY_RECONCILE_ONLY',JSON.stringify(result));
   assert.equal(providerGets,0);const partial=await session.consumeBatch();assert.equal(partial.status,restoreBindingAfterResolve?'PARTIAL_NORMAL_BUSINESS_BACKLOG_RETAINED':'PARTIAL_NORMAL_BUSINESS_RECONCILIATION_UNCONFIRMED');if(!restoreBindingAfterResolve)assert.equal(partial.scopedPending,null);assert.equal(partial.newClaims,1);
   assert.deepEqual((await operator.execute("SELECT * FROM whoop_sleeps WHERE user_id='SYNTHETIC-OUTSIDE'")).rows,outsideBefore);
   const held=(await operator.execute({sql:'SELECT * FROM whoop_webhook_events WHERE id=?',args:[before[0].id]})).rows[0];
   assert.equal(held.state,'PROCESSING');assert.equal(held.attempt_count,1);assert.ok(held.owner.startsWith('normal-C:'));
   await assert.rejects(session.consumeOne({eventId:held.id}),{code:'CONTINUITY_IDLE_BOUNDED_BATCH_REQUIRED'});
   if(restoreBindingAfterResolve){assert.equal(restored,true);assert.equal((await session.reconcile({eventId:held.id})).status,'ORIGINAL_OUTCOME_UNKNOWN_RETAINED');}
   else await assert.rejects(session.reconcile({eventId:held.id}),{code:'CONTINUITY_CURRENT_ORIGINAL_THREE_REQUIRED'});
   const unchanged=(await operator.execute({sql:'SELECT owner,lease_expires_at,attempt_count FROM whoop_webhook_events WHERE id=?',args:[held.id]})).rows[0];
   assert.equal(unchanged.owner,held.owner);assert.equal(unchanged.lease_expires_at,held.lease_expires_at);assert.equal(unchanged.attempt_count,1);
   assert.throws(()=>session.close(),{code:'CONTINUITY_UNKNOWN_OR_ACTIVE_OWNERSHIP_RETAINED'});
  }else if(loseClaimAck){
   assert.equal(lost,true);assert.equal(result.status,'UNKNOWN_RETAIN_ORIGINAL_OWNER_READONLY_RECONCILE_ONLY');assert.equal(providerGets,0);
   const held=(await operator.execute({sql:'SELECT * FROM whoop_webhook_events WHERE id=?',args:[before[0].id]})).rows[0];assert.equal(held.state,'PROCESSING');assert.equal(held.attempt_count,1);
   assert.equal((await session.reconcile({eventId:held.id})).status,'ORIGINAL_OUTCOME_UNKNOWN_RETAINED');const partial=await session.consumeBatch();assert.equal(partial.status,'PARTIAL_NORMAL_BUSINESS_BACKLOG_RETAINED');assert.equal(partial.newClaims,1);
   const observer=await api.openNormalCContinuity({environment:env});const sameEvent=await observer.consumeOne({eventId:held.id});assert.equal(sameEvent.status,'ORIGINAL_INTENT_ALREADY_CONSUMED_READ_ONLY');assert.equal(sameEvent.newClaims,0);assert.equal(sameEvent.observation.status,'ORIGINAL_OUTCOME_UNKNOWN_RETAINED');
   assert.throws(()=>observer.close(),{code:'CONTINUITY_UNKNOWN_OR_ACTIVE_OWNERSHIP_RETAINED'});
   const after=(await operator.execute({sql:'SELECT owner,lease_expires_at,attempt_count FROM whoop_webhook_events WHERE id=?',args:[held.id]})).rows[0];assert.equal(after.owner,held.owner);assert.equal(after.lease_expires_at,held.lease_expires_at);assert.equal(after.attempt_count,1);assert.equal(providerGets,0);
   assert.throws(()=>session.close(),{code:'CONTINUITY_UNKNOWN_OR_ACTIVE_OWNERSHIP_RETAINED'});
  }else{
   assert.equal(result.status,'ORIGINAL_EVENT_PROCESSED_AND_CANONICAL_READBACK_VERIFIED',JSON.stringify(result));
   const second=await session.consumeOne();assert.equal(second.status,'ORIGINAL_EVENT_PROCESSED_AND_CANONICAL_READBACK_VERIFIED',JSON.stringify(second));
   const profile=nativeWriters.filter(p=>p.canonicalWrites||p.eventSettles);assert.equal(profile.filter(p=>p.canonicalWrites).length,2);assert.equal(profile.filter(p=>p.eventSettles).length,2);for(const writer of profile){assert.ok(writer.combinedFreshFence>0);assert.equal(writer.fenceRoster+writer.fenceBindings+writer.fenceEvent,0);}console.log(JSON.stringify({event:'SYNTHETIC_NATIVE_WRITER_FENCE_COUNTS_NOT_REMOTE_TIMING',transactions:profile}));
   if(hranaProfile){const writers=transport.transactions.filter(tx=>tx.statements.some(s=>s.table==='whoop_sleeps'&&s.verb==='INSERT'));assert.equal(writers.length,2);assert.ok(writers.every(tx=>tx.outcome==='COMMITTED'));console.log(JSON.stringify({event:'SYNTHETIC_INSTALLED_HTTP_HRANA_WRITER_ENVELOPES_NOT_REMOTE_TIMING',writers:writers.map(tx=>({sqlOperations:tx.sqlOperations,httpOperations:tx.httpOperations,outcome:tx.outcome})),remoteRuntimeQualified:false}));}
   const expectedGets=forceRefresh?3:2;assert.equal(providerGets,expectedGets);assert.equal(tokenPosts,forceRefresh?1:0);assert.equal(session.status().completed,2);
   const terminals=(await operator.execute("SELECT * FROM whoop_webhook_events WHERE trace_id IN ('SYNTHETIC-ORIGINAL-TRACE','SYNTHETIC-SECOND-TRACE') ORDER BY id")).rows;
   assert.equal(terminals.length,2);for(const row of terminals){assert.equal(row.state,'PROCESSED');assert.equal(row.attempt_count,1);assert.equal(row.owner,null);}
   const canonical=(await operator.execute({sql:'SELECT id,user_id,raw_json FROM whoop_sleeps WHERE id IN (?,?) ORDER BY id',args:[resource,resource2]})).rows;
   assert.equal(canonical.length,2);assert.deepEqual(JSON.parse(canonical[0].raw_json),providerRecord);assert.equal(canonical[1].user_id,'SYNTHETIC-NORMAL-C-1');
   const prior=await session.consumeOne({eventId:terminals[0].id});assert.equal(prior.status,'ORIGINAL_INTENT_ALREADY_CONSUMED_READ_ONLY');assert.equal(prior.newClaims,0);assert.equal(prior.observation.terminalReadback,true);assert.equal(providerGets,expectedGets);
   assert.equal((await whoop()).status,200);assert.equal((await whoop(resource2,ids[1],'SYNTHETIC-SECOND-TRACE')).status,200);
   assert.equal((await operator.execute('SELECT count(*) n FROM whoop_webhook_events')).rows[0].n,3);
   const completed=await session.consumeBatch();assert.equal(completed.status,'SCOPED_BACKLOG_RECONCILED_AT_READ');assert.equal(completed.newClaims,2);assert.equal(completed.processedReadbackVerified,2);assert.equal(completed.scopedPending,0);
   const outside=(await operator.execute("SELECT state,attempt_count,owner FROM whoop_webhook_events WHERE trace_id='SYNTHETIC-OUTSIDE-SCOPE'")).rows[0];assert.equal(outside.state,'RECEIVED');assert.equal(outside.attempt_count,0);assert.equal(outside.owner,null);
   assert.equal(session.close().remoteSqlCancelled,false);session=null;
   // A second invocation under the SAME q can inspect the same event without
   // creating any new owner, claim, request or maintenance identity.
   session=await api.openNormalCContinuity({environment:env});const cold=await session.consumeOne({eventId:terminals[0].id});assert.equal(cold.status,'ORIGINAL_INTENT_ALREADY_CONSUMED_READ_ONLY');assert.equal(cold.newClaims,0);assert.equal(providerGets,expectedGets);session.close();session=null;
  }
  assert.equal(forbidden,0);
 }finally{
  if(session&&!session.status().unknown)session.close();
  if(runtime)await runtime.close();operator.close();for(const c of sdk)try{c.close();}catch{}
  transport?.close();delete globalThis.__normalCSyntheticSdk;await rm(directory,{recursive:true,force:true});
 }
}


test('isolated physical HTTP/Hrana modeled5s writer expiry rolls back canonical work and cold same-event never claims again',t=>continuityFixture(t,{transactionMaxMs:5000,delayHttpMs:140}));
test('isolated durable canonical COMMIT lostACK retains original owner and cannot replay the same provider event',t=>continuityFixture(t,{loseCanonicalCommitAck:true}));

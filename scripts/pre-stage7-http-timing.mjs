import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,readdir} from 'node:fs/promises';
import {AsyncLocalStorage} from 'node:async_hooks';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url).href;
const output=process.env.PRE_STAGE7_TIMING_OUTPUT;
if(!/^tmp\/[\w/-]+$/.test(output??''))throw Error('FRESH_TIMING_OUTPUT_REQUIRED');
await mkdir(output,{recursive:true});if((await readdir(output)).length)throw Error('FRESH_TIMING_OUTPUT_REQUIRED');
const hash=x=>createHash('sha256').update(x).digest('hex');
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();
await writeFile(join(output,'inventory.json'),JSON.stringify({node:process.version,head:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),diffSha256:hash(execFileSync('git',['diff','HEAD'])),command:[process.execPath,...process.argv.slice(1)],fixture:'Installed HTTP/Hrana v2 JSON; isolated native file backend; controlled WHOOP/model/Telegram',productionMutation:'NONE'},null,2));
const imp=p=>import(root+p);
const {createDb}=await imp('src/db.js');
const {createOwnedDb}=await imp('test/stage5OwnedDb.js');
const {fixtureKeys}=await imp('test/localDb.js');
const {hranaTransport}=await imp('test/hranaTransport.js');
const {makeDataset}=await imp('test/fixtures.js');
const {fakeCoach}=await imp('test/fakes.js');
const {runExecutionPhase}=await imp('src/phase4Execution.js');
const {configurationProof,readPhaseProgress,readExecution}=await imp('src/phase4ExecutionStore.js');
const {publicBetaConfiguration}=await imp('src/publicBetaConfig.js');
const {runningReleaseSha}=await imp('src/phase4Release.js');
const {createSync}=await imp('src/sync.js');
const {runDaily}=await imp('src/daily.js');
const {runPredictionCycle}=await imp('src/predictionPipeline.js');
const {runHealthspanSnapshot}=await imp('src/healthspanEngine.js');
const {createReconciler}=await imp('src/reconcile.js');
const {createWhoopClient}=await imp('src/whoop.js');
const {createBriefingEndpoint}=await imp('src/briefingEndpoint.js');
const {discoverPhaseContinuation}=await imp('src/phase4Continuation.js');
const {invoke}=await imp('cloudflare/briefing-scheduler/worker.js');
const {WHOOP_SYNC}=await imp('src/config.js');
const now=new Date('2026-10-09T00:00:00Z');
const env={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:3,telegramBotToken:'synthetic',telegramChatId:'synthetic',whoopClientId:'synthetic',whoopClientSecret:'synthetic',openrouterApiKey:'synthetic',openrouterModel:'synthetic',repoLastCommitAt:now.toISOString()};
const workerDriver=process.env.PRE_STAGE7_TIMING_DRIVER==='worker';
const environment={PHASE4_BETA_SHADOW_RUNTIME:process.env.PRE_STAGE7_TIMING_SHADOW==='on'?'on':'off',PHASE4_PUBLIC_BETA_MODE:'off'};
const results=[];
const scope=new AsyncLocalStorage();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function scenario({name,users=3,latency=10,jitter=0,cold=false,partial=false,tenantDelay=0,resourceDelay=0,source='cloudflare',replay=true}){
 const dir=await mkdtemp('/private/tmp/rc4-timing-'),url=`file:${join(dir,'fixture.db')}`,seed=createOwnedDb({url});
 let db,transport;
 try{
  await seed.migrate({targetVersion:32});
  const ids=['alice','bob','lan'].slice(0,users),locales=['zh-TW','en','vi'];
  const dataset=makeDataset({now,days:45,withNaps:false});
  for(const [i,id] of ids.entries()){
   await seed.createUser({id,displayName:id,status:'ACTIVE',timezone:'Asia/Taipei'});
   await seed.setLocale(id,locales[i]);await seed.linkTelegram({userId:id,chatId:String(1001+i)});
   await seed.saveTokens(id,{accessToken:`synthetic-${id}`,refreshToken:`synthetic-refresh-${id}`,expiresAt:new Date(Date.now()+3600000),whoopUserId:String(12345+i)});
   await seed.saveCapabilities(id,[{key:'sleep',status:'SUPPORTED'}],{expectedLifecycleGeneration:1});
   // READY sleep evidence remains present even when the other resource state is cold.
   await seed.saveSyncState(id,'sleep',{backfillComplete:!cold,lastSuccessAt:null},{now});
   if(!cold){
    for(const resource of WHOOP_SYNC.RESOURCES.filter(r=>r!=='sleep'))await seed.saveSyncState(id,resource,{backfillComplete:true,lastSuccessAt:null},{now});
    const own=rows=>rows.map(row=>({...row,user_id:12345+i}));
    await seed.upsertSleeps(id,own(dataset.sleeps),{timezone:'Asia/Taipei',now});
    await seed.upsertRecoveries(id,own(dataset.recoveries),{now});await seed.upsertCycles(id,own(dataset.cycles),{now});
    if(!partial)await seed.upsertBodyMeasurement(id,{height_meter:1.7,weight_kilogram:70},{now});
   }
   await seed.setProactiveEnabled(id,false);
  }
  await seed.ensureOnboardingDerivedForAll({now});assert.equal((await seed.listSchedulableUsers({activeStatus:'ACTIVE'})).length,users);
  await seed.close();transport=hranaTransport(url);
  let calls=0,lateProviderRequests=0;const metrics={},payloads=[],providerRequests=[];
  const add=(key,ms)=>{const v=metrics[key]??={calls:0,totalMs:0,maxMs:0};v.calls++;v.totalMs+=ms;v.maxMs=Math.max(v.maxMs,ms);};
  const measure=async(key,fn)=>{const start=performance.now();try{return await scope.run(key,fn);}finally{add(key,performance.now()-start);}};
  db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async request=>{
   calls++;const body=await request.clone().json();const sql=[];
   const visit=v=>{if(!v||typeof v!=='object')return;if(typeof v.sql==='string')sql.push(v.sql);for(const x of Object.values(v))if(x&&typeof x==='object')visit(x);};visit(body);
   const phase=scope.getStore()??'coordination';const start=performance.now();
   if(latency||jitter)await wait(latency+(jitter?(calls%5)*jitter:0));
   try{return await transport.fetch(request);}finally{const ms=performance.now()-start;add('http:'+phase,ms);
    if(sql.some(s=>/pending_purge_count|initialized_user_id|initialized_computation_user_id|EXISTS\(SELECT 1 FROM phase4_user_state/.test(s)))add('privacy_observations',ms);
    if(sql.some(s=>/WORK_COMMITTED|FINALIZED_SUCCESS|FINALIZED_FAILURE/.test(s)&&/UPDATE phase4_executions/.test(s)))add('settlement_sql',ms);
   }
  }});
  const admission=db.admitRuntime;db.admitRuntime=(...a)=>measure('admission',()=>admission(...a));
  const grouped=db.getDailyMetricInputs;db.getDailyMetricInputs=(...a)=>measure('analytics_inputs',()=>grouped(...a));
  for(const fn of ['authorizeReportDelivery','renewClaim','markClaimSent','getActiveChatIdForUser']){
   const original=db[fn];if(original)db[fn]=(...a)=>measure('telegram_delivery_preparation:'+fn,()=>original(...a));
  }
  const deps={
   makeWhoop:options=>{
    const {userId}=options,i=ids.indexOf(userId),own=rows=>rows.map(row=>({...row,user_id:12345+i}));
    const whoop=createWhoopClient({...options,fetchImpl:async(url,init)=>{
     const u=new URL(url),resource=u.pathname.includes('measurement')?'body_measurement':u.pathname.includes('sleep')?'sleep':u.pathname.includes('recovery')?'recovery':u.pathname.includes('workout')?'workout':'cycle';
     assert.equal(init.headers.Authorization,`Bearer synthetic-${userId}`);
     if(init.signal?.aborted)lateProviderRequests++;
     providerRequests.push({userId,resource,path:u.pathname,from:u.searchParams.get('start'),to:u.searchParams.get('end'),page:u.searchParams.get('nextToken')});
     if(userId==='alice'&&tenantDelay)await wait(tenantDelay);
     if(resource==='recovery'&&resourceDelay)await wait(resourceDelay);
     if(partial&&resource==='workout')return new Response('{}',{status:403});
     if(resource==='body_measurement')return new Response(JSON.stringify(partial?null:{height_meter:1.7,weight_kilogram:70}));
     const rows=resource==='sleep'?dataset.sleeps:resource==='recovery'?dataset.recoveries:resource==='cycle'?dataset.cycles:[];
     const from=u.searchParams.get('start'),to=u.searchParams.get('end');
     const filtered=own(rows).filter(r=>{const at=Date.parse(r.start??r.created_at);return (!from||at>=Date.parse(from))&&(!to||at<=Date.parse(to));});
     const offset=Number(u.searchParams.get('nextToken')??0),limit=25;
     return new Response(JSON.stringify({records:filtered.slice(offset,offset+limit),next_token:offset+limit<filtered.length?String(offset+limit):null}));
    }});
    for(const name of ['sleeps','recoveries','cycles','workouts','bodyMeasurement','apiGet']){
     const fn=whoop[name];whoop[name]=(...a)=>measure('resource:'+name,()=>fn(...a));
    }
    return whoop;
   },
   makeCoach:()=>{const coach=fakeCoach(),plan=coach.narrativePlan;coach.narrativePlan=(...a)=>measure('briefing_narrative_plan',()=>plan(...a));return coach;},
   makeTelegram:({chatId})=>({send:async text=>measure('telegram_send',async()=>{payloads.push({chatId,text});return {messageId:payloads.length};}),sendTyping:async()=>true,notifyError:async()=>false}),
   makeSync:o=>{const s=createSync(o);return {...s,syncAll:(...a)=>measure('WHOOP_sync',()=>s.syncAll(...a))};},
   makeReconciler:o=>{const r=createReconciler(o);return {...r,reconcileAll:(...a)=>measure('reconciliation',()=>r.reconcileAll(...a))};},
   daily:o=>measure('briefing_build_claim_delivery',()=>runDaily(o)),
   predictionCycle:o=>measure('analytics_prediction',()=>runPredictionCycle(o)),
   healthspan:o=>measure('Healthspan',()=>runHealthspanSnapshot(o)),
   guardian:async()=>null,
  };
  let request={releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:source,executionMode:environment.PHASE4_BETA_SHADOW_RUNTIME==='on'?'SHADOW':'OFF',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)};
  const started=performance.now();let response,error;
  let workerResult,workerError,workerElapsedMs,workerResponses=[],workerInvocations=[];
  if(workerDriver){
   if(source!=='cloudflare')throw Error('WORKER_SOURCE_INVALID');
   const secret='synthetic-http-timing-worker-only-secret',pending=new Set();
   const endpoint=createBriefingEndpoint({secret,environment,discoverContinuation:options=>discoverPhaseContinuation({...options,db,keys:fixtureKeys,environment}),runPhase:options=>{
    const at=performance.now();if(options.request.phase==='SYNC')request=options.request;
    const work=runExecutionPhase({...options,db,keys:fixtureKeys,environment,env,deps,now}).then(async result=>{
     workerResponses.push({phase:options.request.phase,response:result,elapsedMs:performance.now()-at,generation:(await readExecution(db,options.request.requestId))?.generation,sends:payloads.length});return result;
    });pending.add(work);work.finally(()=>pending.delete(work)).catch(()=>{});return work;
   }});
   const workerEnv={BRIEFING_ENDPOINT_URL:'https://isolated.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:secret,BRIEFING_RELEASE_SHA:request.releaseSha,
    BRIEFING_EXECUTION_MODE:request.executionMode,BRIEFING_CONFIG_PROOF:request.configProof,BRIEFING_CONTINUATION_DISCOVERY:'on'};
   const fetchImpl=async(url,init)=>{
    const result=await endpoint({url:new URL(url).pathname,method:'POST',headers:init.headers},init.body);return new Response(JSON.stringify(result.body),{status:result.status});
   };
   // A second authorized cron invocation rediscovers the original durable ID.
   // Keep the original 561s caller window, 120s work budget and 900s context.
   for(let invocation=0;invocation<2;invocation++){
    if(invocation){let remaining=600000-(performance.now()-started);while(remaining>0){await wait(Math.min(remaining,30000));remaining=600000-(performance.now()-started);}}
    const at=performance.now();workerResult=undefined;workerError=undefined;
    try{workerResult=await invoke(workerEnv,{fetchImpl});}catch(e){workerError={code:e.code,category:e.category,message:e.message};}
    workerInvocations.push({invocation:invocation+1,startedAfterMs:at-started,elapsedMs:performance.now()-at,result:workerResult,error:workerError});
    await Promise.allSettled([...pending]);
    if(workerResult?.ok||!['timeout','continuation_pending','http_5xx','transport'].includes(workerError?.category))break;
   }
   workerElapsedMs=performance.now()-started;
   response=workerResponses.find(r=>r.phase==='SYNC')?.response;
  }else try{response=await runExecutionPhase({request,db,keys:fixtureKeys,environment,env,deps,now});}catch(e){error={code:e.code,message:e.message};}
  const elapsedMs=performance.now()-started,workRequests=calls;
  const segments=workerDriver?workerResponses.map(r=>({phase:r.phase,elapsedMs:r.elapsedMs,status:r.response.status,outcome:r.response.body?.result?.outcome,continuationState:r.response.body?.result?.continuationState,generation:r.generation,sends:r.sends})):[{elapsedMs,status:response?.status,outcome:response?.body?.result?.outcome,continuationState:response?.body?.result?.continuationState,generation:(await readExecution(db,request.requestId))?.generation}];
  const resumeSegment=async()=>{const start=performance.now();const r=await runExecutionPhase({request,db,keys:fixtureKeys,environment,env,deps,now});segments.push({elapsedMs:performance.now()-start,status:r.status,outcome:r.body?.result?.outcome,continuationState:r.body?.result?.continuationState,generation:(await readExecution(db,request.requestId))?.generation});return r;};
  const delivered=async()=>(await db.raw.execute("SELECT user_id,local_date,delivery_state,delivery_attempts FROM report_claims WHERE report_type='daily' ORDER BY user_id")).rows.map(r=>({...r}));
  const claims=await delivered(),before=payloads.length;
  let resumed=workerDriver?workerResponses.filter(r=>r.phase==='SYNC').at(-1)?.response:undefined,replayed,resumeError,additionalFinalizedReplaySends=0;
  if(replay&&!workerDriver){try{
    const start=performance.now();resumed=await resumeSegment();
    for(let segment=0;segment<5&&resumed.body?.result?.resumable===true;segment++){await wait(15_000);resumed=await resumeSegment();}
    add('resumption_or_replay',performance.now()-start);
    if(resumed.status===200){const deliveredBeforeReplay=payloads.length;replayed=await runExecutionPhase({request,db,keys:fixtureKeys,environment,env,deps,now});assert.deepEqual(replayed,resumed);additionalFinalizedReplaySends=payloads.length-deliveredBeforeReplay;assert.equal(additionalFinalizedReplaySends,0);}
   }catch(e){resumeError={code:e.code,message:e.message};}}
  if(workerDriver&&resumed?.status===200){const deliveredBeforeReplay=payloads.length;replayed=await runExecutionPhase({request,db,keys:fixtureKeys,environment,env,deps,now});assert.deepEqual(replayed,resumed);additionalFinalizedReplaySends=payloads.length-deliveredBeforeReplay;assert.equal(additionalFinalizedReplaySends,0);}
  const finalClaims=await delivered(),duplicates=(await db.raw.execute("SELECT count(*) n FROM (SELECT user_id,report_type,local_date,count(*) n FROM report_claims GROUP BY user_id,report_type,local_date HAVING count(*)>1)")).rows[0].n;
  assert.equal(lateProviderRequests,0);assert.equal(duplicates,0);assert.ok(finalClaims.every(c=>c.delivery_attempts<=1));
  for(const payload of payloads)assert.doesNotMatch(payload.text,/Body Energy|Kelvin|Beta Summary/);
  const progress=await readPhaseProgress(db,'SYNC',source);
  const out={providerClient:'REAL_CREATE_WHOOP_CLIENT_SYNTHETIC_FETCH',providerRequests,lateProviderRequests,name,users,latency,jitter,cold,partial,tenantDelay,resourceDelay,source,elapsedMs,workRequests,segments,workerDriver,workerInvocations,workerResult,workerError,workerElapsedMs,additionalFinalizedReplaySends,response,error,metrics,claims,finalClaims,sends:before,additionalReplaySends:payloads.length-before,resumed,replayMatched:!!replayed,resumeError,progress:{state:progress.state,settlementState:progress.settlementState,workReceipts:progress.workReceipts}};
  results.push(out);await writeFile(join(output,'timings.json'),JSON.stringify(results,null,2));console.log('REVIEW_TIMING '+JSON.stringify({name,elapsedMs,status:response?.status,resumed:resumed?.status,segments,additionalReplaySends:out.additionalReplaySends,additionalFinalizedReplaySends}));
 }finally{try{await seed.close();}catch{}db?.close();transport?.close();await rm(dir,{recursive:true,force:true});}
}
const cases=[
 {name:'A_1_READY',users:1},
 {name:'B_3_READY'},
 {name:'C_3_COLD',cold:true},
 {name:'D_3_PARTIAL_OPTIONAL',partial:true},
 {name:'F_SLOW_HTTP',latency:112},
 {name:'I_HTTP_JITTER',latency:112,jitter:8},
 {name:'J_HTTP_HIGH_LATENCY',latency:160},
 {name:'G_ONE_TENANT_DELAYED',tenantDelay:500},
 {name:'H_ONE_RESOURCE_DELAYED',resourceDelay:3000},
];
const selected=process.argv.slice(2);
for(const c of cases.filter(c=>!selected.length||selected.includes(c.name)))await scenario(c);

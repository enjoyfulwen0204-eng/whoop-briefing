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
const {WHOOP_SYNC}=await imp('src/config.js');
const now=new Date('2026-10-09T00:00:00Z');
const env={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:3,telegramBotToken:'synthetic',telegramChatId:'synthetic',whoopClientId:'synthetic',whoopClientSecret:'synthetic',openrouterApiKey:'synthetic',openrouterModel:'synthetic',repoLastCommitAt:now.toISOString()};
const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'};
const results=[];
const scope=new AsyncLocalStorage();
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function scenario({name,users=3,latency=10,cold=false,partial=false,tenantDelay=0,resourceDelay=0,source='cloudflare',replay=true}){
 const dir=await mkdtemp('/private/tmp/rc4-timing-'),url=`file:${join(dir,'fixture.db')}`,seed=createOwnedDb({url});
 let db,transport;
 try{
  await seed.migrate({targetVersion:32});
  const ids=['alice','bob','lan'].slice(0,users),locales=['zh-TW','en','vi'];
  const dataset=makeDataset({now,days:45,withNaps:false});
  for(const [i,id] of ids.entries()){
   await seed.createUser({id,displayName:id,status:'ACTIVE',timezone:'Asia/Taipei'});
   await seed.setLocale(id,locales[i]);await seed.linkTelegram({userId:id,chatId:String(1001+i)});
   await seed.saveTokens(id,{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000),whoopUserId:String(12345+i)});
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
  let calls=0;const metrics={},payloads=[];
  const add=(key,ms)=>{const v=metrics[key]??={calls:0,totalMs:0,maxMs:0};v.calls++;v.totalMs+=ms;v.maxMs=Math.max(v.maxMs,ms);};
  const measure=async(key,fn)=>{const start=performance.now();try{return await scope.run(key,fn);}finally{add(key,performance.now()-start);}};
  db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:async request=>{
   calls++;const body=await request.clone().json();const sql=[];
   const visit=v=>{if(!v||typeof v!=='object')return;if(typeof v.sql==='string')sql.push(v.sql);for(const x of Object.values(v))if(x&&typeof x==='object')visit(x);};visit(body);
   const phase=scope.getStore()??'coordination';const start=performance.now();
   if(latency)await wait(latency);
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
   makeWhoop:({userId})=>{
    const i=ids.indexOf(userId),own=rows=>rows.map(row=>({...row,user_id:12345+i}));
    const get=(resource,rows)=>async(from,to)=>measure('resource:'+resource,async()=>{
     if(userId==='alice'&&tenantDelay)await wait(tenantDelay);
     if(resource==='recovery'&&resourceDelay)await wait(resourceDelay);
     if(partial&&resource==='workout')throw Object.assign(Error('scope_missing'),{status:403,code:'WHOOP_SCOPE_MISSING'});
     if(resource==='body_measurement')return partial?null:{height_meter:1.7,weight_kilogram:70};
     return own(rows).filter(r=>{const at=Date.parse(r.start??r.created_at);return (!from||at>=new Date(from).getTime())&&(!to||at<=new Date(to).getTime());});
    });
    return {getAccessToken:async()=>'synthetic',sleeps:get('sleep',dataset.sleeps),recoveries:get('recovery',dataset.recoveries),cycles:get('cycle',dataset.cycles),workouts:get('workout',[]),bodyMeasurement:get('body_measurement',[]),
     apiGet:async(path,query={})=>{
      const resource=path.includes('sleep')?'sleep':path.includes('recovery')?'recovery':path.includes('workout')?'workout':'cycle';
      const rows=resource==='sleep'?dataset.sleeps:resource==='recovery'?dataset.recoveries:resource==='cycle'?dataset.cycles:[];
      return {records:await get(resource,rows)(query.start,query.end),next_token:null};
     }};
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
  const request={releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:source,executionMode:'OFF',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)};
  const started=performance.now();let response,error;
  try{response=await runExecutionPhase({request,db,keys:fixtureKeys,environment,env,deps,now});}catch(e){error={code:e.code,message:e.message};}
  const elapsedMs=performance.now()-started,workRequests=calls;
  const segments=[{elapsedMs,status:response?.status,outcome:response?.body?.result?.outcome,continuationState:response?.body?.result?.continuationState,generation:(await readExecution(db,request.requestId))?.generation}];
  const resumeSegment=async()=>{const start=performance.now();const r=await runExecutionPhase({request,db,keys:fixtureKeys,environment,env,deps,now});segments.push({elapsedMs:performance.now()-start,status:r.status,outcome:r.body?.result?.outcome,continuationState:r.body?.result?.continuationState,generation:(await readExecution(db,request.requestId))?.generation});return r;};
  const delivered=async()=>(await db.raw.execute("SELECT user_id,local_date,delivery_state,delivery_attempts FROM report_claims WHERE report_type='daily' ORDER BY user_id")).rows.map(r=>({...r}));
  const claims=await delivered(),before=payloads.length;
  let resumed,replayed,resumeError,additionalFinalizedReplaySends=0;
  if(replay){try{
    const start=performance.now();resumed=await resumeSegment();
    for(let segment=0;segment<5&&resumed.body?.result?.resumable===true;segment++){await wait(15_000);resumed=await resumeSegment();}
    add('resumption_or_replay',performance.now()-start);
    if(resumed.status===200){const deliveredBeforeReplay=payloads.length;replayed=await runExecutionPhase({request,db,keys:fixtureKeys,environment,env,deps,now});assert.deepEqual(replayed,resumed);additionalFinalizedReplaySends=payloads.length-deliveredBeforeReplay;assert.equal(additionalFinalizedReplaySends,0);}
   }catch(e){resumeError={code:e.code,message:e.message};}}
  const finalClaims=await delivered(),duplicates=(await db.raw.execute("SELECT count(*) n FROM (SELECT user_id,report_type,local_date,count(*) n FROM report_claims GROUP BY user_id,report_type,local_date HAVING count(*)>1)")).rows[0].n;
  assert.equal(duplicates,0);assert.ok(finalClaims.every(c=>c.delivery_attempts<=1));
  for(const payload of payloads)assert.doesNotMatch(payload.text,/Body Energy|Kelvin|Beta Summary/);
  const progress=await readPhaseProgress(db,'SYNC',source);
  const out={name,users,latency,cold,partial,tenantDelay,resourceDelay,source,elapsedMs,workRequests,segments,additionalFinalizedReplaySends,response,error,metrics,claims,finalClaims,sends:before,additionalReplaySends:payloads.length-before,resumed,replayMatched:!!replayed,resumeError,progress:{state:progress.state,settlementState:progress.settlementState,workReceipts:progress.workReceipts}};
  results.push(out);await writeFile(join(output,'timings.json'),JSON.stringify(results,null,2));console.log('REVIEW_TIMING '+JSON.stringify({name,elapsedMs,status:response?.status,resumed:resumed?.status,segments,additionalReplaySends:out.additionalReplaySends,additionalFinalizedReplaySends}));
 }finally{try{await seed.close();}catch{}db?.close();transport?.close();await rm(dir,{recursive:true,force:true});}
}
const cases=[
 {name:'A_1_READY',users:1},
 {name:'B_3_READY'},
 {name:'C_3_COLD',cold:true},
 {name:'D_3_PARTIAL_OPTIONAL',partial:true},
 {name:'F_SLOW_HTTP',latency:112},
 {name:'G_ONE_TENANT_DELAYED',tenantDelay:500},
 {name:'H_ONE_RESOURCE_DELAYED',resourceDelay:3000},
];
const selected=process.argv.slice(2);
for(const c of cases.filter(c=>!selected.length||selected.includes(c.name)))await scenario(c);

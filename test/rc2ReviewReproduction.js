/** Read-only source baseline plus isolated synthetic databases. Never loads .env.
 * Invoke with an archive of exact RC2; imports are confined to that archive. */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
if(Number(process.versions.node.split('.')[0])<22)throw Error('NODE_22_REQUIRED');
const root=resolve(process.argv[2]??'');if(!root.startsWith('/private/tmp/')&&!root.startsWith('/tmp/'))throw Error('ISOLATED_RC2_ARCHIVE_REQUIRED');
const load=file=>import(pathToFileURL(join(root,file)).href);
const {createDb,fixtureKeys}=await load('test/localDb.js'),{runBriefing}=await load('src/index.js');
const {createSync}=await load('src/sync.js'),{LIFECYCLE_UNFENCED}=await load('src/accountLifecycle.js');
const {createPhase4Foundation}=await load('src/phase4Foundation.js'),{createPhase4Stage6,authorizeStage6ShadowWorker}=await load('src/phase4Reanalysis.js');
const {createBriefingEndpoint}=await load('src/briefingEndpoint.js'),{signTriggerRequest,BRIEFING_TRIGGER}=await load('src/briefingTriggerAuth.js');
const {invoke}=await load('cloudflare/briefing-scheduler/worker.js');
const dir=await mkdtemp(join(tmpdir(),'p4-rc2-reproduction-')),db=createDb({url:`file:${join(dir,'isolated.db')}`});
try{
 await db.migrate();await db.createUser({id:'synthetic',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 const resources=await createSync({db:{getSyncState:async()=>null,saveSyncState:async()=>{}},whoop:{sleeps:async()=>{throw Error('synthetic required-resource failure');}},userId:'synthetic',timezone:'Asia/Taipei',expectedLifecycleGeneration:LIFECYCLE_UNFENCED}).syncAll({force:true,resources:['sleep']});
 let queryCount=0,ddl=0;const execute=db.raw.execute;
 db.raw.execute=async statement=>{queryCount++;const sql=typeof statement==='string'?statement:statement.sql;if(/^\s*(CREATE|ALTER|DROP)\b/i.test(sql))ddl++;return execute(statement);};
 db.listSchedulableUsers=async()=>[{id:'synthetic'}];db.listPendingOnboarding=async()=>[];
 const summary=await runBriefing({triggerSource:'manual',deps:{db,env:{dryRun:true,timezone:'Asia/Taipei',maxUserConcurrency:1,telegramBotToken:'synthetic',telegramChatId:'synthetic'},runUser:async()=>({sync:resources,errors:[],skipped:null}),guardian:async()=>null,drainWebhook:async()=>({}),keepConnectionOpen:true}});
 assert.equal(resources[0].status,'failed');assert.equal(summary.failed,0);
 console.log(JSON.stringify({reproduction:'H2_RC2_STRUCTURED_REQUIRED_FAILURE',resourceStatus:resources[0].status,runnerFailed:summary.failed,outcome:summary.outcome}));
 console.log(JSON.stringify({reproduction:'H1_RC2_RUNTIME_MIGRATION_REPLAY',queryCount,ddl}));
 assert.ok(ddl>0);db.raw.execute=execute;
 // RC2 runner closes its connection even with an injected keep-open flag.
 db.raw.reconnect();
 const stores=await createPhase4Foundation({db,keys:fixtureKeys});await stores.initializeTenant('synthetic','SHADOW');
 for(let i=0;i<9;i++){
 const text='caffeine at 2026-10-06T11:00:00Z';await stores.journal.create(await stores.captureControl('synthetic'),{sourceEventKey:`item-${i}`,sourceText:text,candidate:{category:'caffeine',eventAt:'2026-10-06T11:00:00Z',valueKind:'PRESENCE',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:text.length}});
 }
 const worker=await createPhase4Stage6({db,keys:fixtureKeys,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
 const drain=await worker.drain({triggerSource:'github'});assert.equal(drain.completedJobs,0);assert.equal(drain.outcome,'DRAINED');
 console.log(JSON.stringify({reproduction:'M1_RC2_FALSE_DRAINED',outcome:drain.outcome,processed:drain.processedItems,completed:drain.completedJobs}));
 const secret='synthetic-secret-with-at-least-32-bytes',at=Date.now(),id=randomUUID();let runs=0;
 const endpoint=createBriefingEndpoint({secret,now:()=>at,runBriefing:async()=>{runs++;return {users:0,ok:0,failed:0,skipped:0,errors:[],perUser:[]};}});
 const signed=body=>({url:BRIEFING_TRIGGER.PATH,method:'POST',headers:{'content-type':'application/json','x-briefing-request-id':id,'x-briefing-timestamp':String(at),'x-briefing-signature':signTriggerRequest({timestamp:String(at),requestId:id,method:'POST',path:BRIEFING_TRIGGER.PATH,body},secret)}});
 const first='{}',changed='{"phase":"STAGE6_DRAIN"}',a=await endpoint(signed(first),first),b=await endpoint(signed(changed),changed);
 assert.deepEqual(a,b);assert.equal(runs,1);
 console.log(JSON.stringify({reproduction:'M2_RC2_CONFLICTING_SIGNED_BODY_CACHE',status:b.status,runs}));
 let bodyStarted,finishBody;const gate=new Promise(r=>bodyStarted=r),bodyDone=new Promise(r=>finishBody=r);let aborted=false;
 const pending=invoke({BRIEFING_ENDPOINT_URL:'https://synthetic.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:secret},{timeoutMs:20,sleep:async()=>{},fetchImpl:async(_u,{signal})=>{signal.addEventListener('abort',()=>aborted=true);return {status:200,ok:true,text:async()=>{bodyStarted();await bodyDone;return '{}';}};}});
 await gate;await new Promise(r=>setTimeout(r,50));assert.equal(aborted,true);finishBody();const late=await pending;assert.equal(late.ok,true);
 console.log(JSON.stringify({reproduction:'H3_RC2_WORKER_BODY_UNBOUNDED',timeoutMs:20,bodyHeldMs:50,aborted,lateSuccess:true}));
 console.log(JSON.stringify({reproduction:'H3_L1_RC2_SOURCE_AUDIT',durableHeavySyncScope:false,overallServerSyncDeadline:false,connectionBoundAdmission:false,separatePhaseHeartbeat:false}));
}finally{db.close();await rm(dir,{recursive:true,force:true});}

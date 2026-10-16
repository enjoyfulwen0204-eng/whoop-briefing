// Isolated synthetic process only; no provider access or Production fallback.
import {realpath} from 'node:fs/promises';
import {writeSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createOwnedFileDb} from '../src/db.js';
import {fixtureKeys as keys} from './localDb.js';
import {bodyInput,seedBodyInput} from './bodyEnergyFixture.js';
import {createPhase4Foundation} from '../src/phase4Foundation.js';
import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {createSync} from '../src/sync.js';
import {recordStage8SyncSubject} from '../src/stage8PostSync.js';
import {createStage8Runtime} from '../src/stage8Runtime.js';
const [mode,path]=process.argv.slice(2),directory=await realpath(dirname(path));
if(!['CRASH','RESUME','INSPECT'].includes(mode)||basename(path)!=='fixture.sqlite'||!directory.startsWith(join(await realpath(tmpdir()),'stage8-real-restart-')))throw Error('ISOLATED_RESTART_FIXTURE_REQUIRED');
globalThis.fetch=async()=>{throw Error('SYNTHETIC_PROVIDER_NETWORK_FORBIDDEN');};
const db=createOwnedFileDb({url:'file:'+path,phase4Keys:keys}),env={dryRun:true,timezone:'Asia/Taipei',telegramBotToken:'SYNTHETIC_NOT_A_TOKEN'},
 environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_STAGE8_RUNTIME:'on',PHASE4_BETA_PILOT_USER_ID:'a',STAGE8_USER_IDS:'a',STAGE8_LIVE_ANALYSIS:'on',STAGE8_POST_SYNC:'on'};
async function counts(){
 const value=Object.fromEntries(await Promise.all(['phase4_executions','stage8_live_executions','stage8_live_execution_work_receipts'].map(async table=>[table,(await db.raw.execute(`SELECT count(*) n FROM ${table}`)).rows[0].n])));
 value.subjectLockExpiry=(await db.raw.execute("SELECT MAX(expires_at) expiry FROM resource_locks WHERE name LIKE 'stage8:live-subject:%'")).rows[0].expiry;
 value.completedJobs=(await db.raw.execute("SELECT count(*) n FROM phase4_jobs WHERE execution_mode='LIVE' AND state='COMPLETED'")).rows[0].n;
 return value;
}
try{
 if(mode==='CRASH'){
  await db.migrate({targetVersion:35});await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
  const stores=await createPhase4Foundation({db,keys});await stores.initializeTenant('a','SHADOW');
  await db.transaction(()=>seedBodyInput(db,bodyInput({asOf:Date.now()-1000,days:0})));await db.ensureOnboarding('a',{state:'READY'});await db.linkTelegram({userId:'a',chatId:'10001'});
  for(const resource of ['sleep','recovery','cycle','workout'])await db.saveSyncState('a',resource,{backfillComplete:true,lastSuccessAt:new Date().toISOString()});
  await stores.preferences.read(await stores.captureControl('a'));
  const setState=db.setState;db.setState=async function(key,value){if(key.startsWith('stage8:sync-progress:')){
   // Producer is genuinely finalized; no progress write has been submitted.
   writeSync(1,'RESTART_CHILD_RESULT '+JSON.stringify({kind:'BEFORE_PROGRESS_SIGKILL',pid:process.pid,counts:await counts()})+'\n');process.kill(process.pid,'SIGKILL');await new Promise(()=>{});
  }return setState.call(this,key,value);};
  const request={phase:'SYNC',triggerSource:'manual',requestId:randomUUID(),releaseSha:runningReleaseSha(),executionMode:'OFF',configProof:configurationProof(keys,{runtime:'off',mode:'off'},environment)};
  await runExecutionPhase({db,keys,request,environment,env,deps:{runBriefing:async()=>{
   const whoop={sleeps:async()=>[],recoveries:async()=>[],cycles:async()=>[],workouts:async()=>[],bodyMeasurement:async()=>({})};
   const sync=await createSync({db,whoop,userId:'a',timezone:'Asia/Taipei',expectedLifecycleGeneration:1}).syncAll({force:true});
   if(!sync.complete)throw Error('GENUINE_SYNC_REQUIRED');await recordStage8SyncSubject({db,userId:'a',sync});return {syncComplete:true,syncOutcome:sync.outcome,users:1,failed:0};
  }}});throw Error('REAL_CRASH_BOUNDARY_NOT_REACHED');
 }
 if(mode==='INSPECT'){await db.admitRuntime();console.log('RESTART_CHILD_RESULT '+JSON.stringify({kind:'INSPECT',pid:process.pid,counts:await counts()}));}
 else{const app=await createStage8Runtime({db,keys,environment,env}),result=await app.analysis.resume();console.log('RESTART_CHILD_RESULT '+JSON.stringify({kind:'RESUME',pid:process.pid,result,counts:await counts()}));}
}finally{db.close();}

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Sqlite3Client} from '@libsql/client/sqlite3';
import {createOwnedFileDb} from '../src/db.js';
import {createPhase4Keys} from '../src/phase4Keys.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {SCHEMA_TRANSITION_PROFILE} from '../src/schemaTransitionProfile.js';
import {main} from '../src/bot/webhook.js';
import {createSettings} from '../src/bot/settings.js';
import {runMorningReadiness} from '../src/morningReadiness.js';
import {runCompanionService} from '../src/companionService.js';
import {runExecutionPhase,discoverExecutionContinuation} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';

const keys=createPhase4Keys({lookupKey:Buffer.alloc(32,71),auditKey:Buffer.alloc(32,83)}),releaseSha=runningReleaseSha({});
const environment=url=>({TELEGRAM_BOT_TOKEN:'123456:SYNTHETIC-ONLY',TELEGRAM_WEBHOOK_SECRET:'SYNTHETIC-ONLY-32-BYTE-WEBHOOK-SECRET',
 TURSO_DATABASE_URL:url,TURSO_AUTH_TOKEN:'SYNTHETIC-NOT-LIVE',OPENROUTER_API_KEY:'SYNTHETIC-NOT-LIVE',
 PHASE4_LOOKUP_KEY:'47'.repeat(32),PHASE4_AUDIT_KEY:'53'.repeat(32),PHASE4_EXECUTION_PROFILE:SCHEMA_TRANSITION_PROFILE,
 PHASE4_RELEASE_SHA:releaseSha,RENDER_GIT_COMMIT:releaseSha,PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',
 PHASE4_PUBLIC_BETA_USER_IDS:'',PHASE4_BETA_PILOT_STOP:'on',PHASE4_BETA_PILOT_USER_ID:'synthetic-user',
 STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'synthetic-user',STAGE7_AUTOMATIC:'off',
 PHASE4_STAGE8_RUNTIME:'off',PHASE4_STAGE8_OWNER_MONITORING:'off',STAGE8_MORNING_BRIEF:'off',STAGE8_LIVE_ANALYSIS:'off',
 STAGE8_POST_SYNC:'off',STAGE8_SUBJECT_ALERTS:'off',PHASE4_DELIVERY_CUTOVER:'off',BODY_ENERGY_PUBLICATION:'off',BODY_ENERGY_ALERTS:'off',
 WHOOP_CLIENT_ID:'',WHOOP_CLIENT_SECRET:'',WHOOP_REDIRECT_URI:'',BRIEFING_TRIGGER_SECRET:'',WHOOP_WEBHOOK_ENABLED:'off',
 BRIEFING_CONTINUATION_SCOPE:'sync'});
async function fixture(t,version){
 const directory=await mkdtemp(join(tmpdir(),'schema-transition-startup-')),url=pathToFileURL(join(directory,'synthetic.db')).href;
 const db=createOwnedFileDb({url,phase4Keys:keys});await db.migrate({targetVersion:version});
 t.after(async()=>{db.close();await rm(directory,{recursive:true,force:true});});return {db,url,directory};
}

for(const version of [33,35])test(`actual business bootstrap preserves manual Stage7/Settings on${version} without Stage8 table access or network`,async t=>{
 const f=await fixture(t,version),env=environment(f.url),previous={...process.env},cwd=process.cwd();let started,network=0;
 t.mock.method(globalThis,'fetch',async()=>{network++;throw Error('SYNTHETIC_NETWORK_FORBIDDEN');});
 await f.db.createUser({id:'synthetic-user',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await f.db.linkTelegram({userId:'synthetic-user',chatId:'12345'});await f.db.setLocale('synthetic-user','en');
 f.db.close();
 const queries=[],execute=Sqlite3Client.prototype.execute;
 t.mock.method(Sqlite3Client.prototype,'execute',function(statement){queries.push(typeof statement==='string'?statement:statement.sql);return execute.call(this,statement);});
 for(const key of Object.keys(process.env))if(/^(PHASE4_|STAGE[78]_|BODY_ENERGY_|WHOOP_|BRIEFING_|GITHUB_|RENDER_)/.test(key))delete process.env[key];
 Object.assign(process.env,env);process.chdir(f.directory);
 try{
  started=await main({listen:false,port:0});assert.equal(started.server.listening,false);
  assert.equal(started.db.requireRuntimeAdmission(await started.db.admitRuntime()),version);
  const user=await started.db.getUser('synthetic-user'),settings=await createSettings({db:started.db})({text:'/settings',chatId:'12345',user});
  assert.match(settings.text,/Settings/);assert.ok(settings.replyMarkup.inline_keyboard.flat().some(button=>button.callback_data.endsWith('.name')));
  assert.ok(!settings.replyMarkup.inline_keyboard.flat().some(button=>/owner|stage8/.test(button.callback_data)));
  assert.ok(queries.length>0);
  assert.ok(!queries.some(sql=>/\b(recipient_identity_sources|stage8_live_\w*|stage8_scoped_read_audit|tenant_delivery_modes|morning_brief_plans|owner_monitoring_\w*)\b/.test(sql)));
  assert.equal(network,0);
 }finally{
  started?.server.close();started?.db.close();process.chdir(cwd);
  for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);
 }
});

for(const version of [33,35])test(`secondary readiness, phase and continuation owned clients inherit transition admission on${version}`,async t=>{
 const f=await fixture(t,version),environmentValue=environment(f.url),providedEnv={tursoUrl:f.url,tursoToken:'SYNTHETIC',telegramBotToken:'SYNTHETIC',maxUserConcurrency:1};
 let network=0;t.mock.method(globalThis,'fetch',async()=>{network++;throw Error('SYNTHETIC_NETWORK_FORBIDDEN');});
 f.db.close();
 const proof=configurationProof(keys,publicBetaConfiguration(environmentValue),environmentValue,releaseSha),base={releaseSha,triggerSource:'cloudflare',executionMode:'OFF',configProof:proof};
 const deps={get morning(){throw Error('TRANSITION_MUST_SKIP_STAGE8_MORNING_FACTORY');}};
 const readiness=await runMorningReadiness({request:{...base,kind:'MORNING_READINESS_V1',requestId:'synthetic-readiness-0001'},
  environment:environmentValue,env:providedEnv,keys,deps});
 assert.equal(readiness.status,200);assert.equal(readiness.body.result.users,0);
 const companion=await runCompanionService({request:{...base,kind:'COMPANION_V1',requestId:'synthetic-companion-0001'},
  environment:environmentValue,env:providedEnv,keys});assert.equal(companion.status,200);assert.equal(companion.body.enabled,false);
 let called=0;
 const phase=await runExecutionPhase({request:{...base,phase:'SYNC',requestId:'synthetic-sync-0001'},environment:environmentValue,env:providedEnv,keys,
  deps:{runBriefing:async()=>{called++;return {syncComplete:true,syncOutcome:'COMPLETE_SUCCESS',users:0,failed:0};}}});
 assert.equal(called,1);assert.equal(phase.status,200);assert.equal(phase.body.syncComplete,true);
 const continuation=await discoverExecutionContinuation({query:{...base,scope:'sync'},environment:environmentValue,env:providedEnv,keys});
 assert.equal(continuation.status,200);assert.equal(continuation.body.state,'NONE');assert.equal(network,0);
});

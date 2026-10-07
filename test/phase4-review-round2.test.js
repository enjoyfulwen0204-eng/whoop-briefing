import { runningReleaseSha } from '../src/phase4Release.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,cp,symlink,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {randomUUID} from 'node:crypto';
import {createClient} from '@libsql/client';import {composeDb} from '../src/db.js';import {fixtureKeys} from './localDb.js';
import {createDb as privateDb} from '../src/db.js';import {hranaTransport} from './hranaTransport.js';
import {createOwnedDb} from './stage5OwnedDb.js';import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof,readPhaseProgress} from '../src/phase4ExecutionStore.js';
import {currentExecutionBudget} from '../src/executionBudget.js';
import {invoke} from '../cloudflare/briefing-scheduler/worker.js';
const root=fileURLToPath(new URL('..',import.meta.url)),sha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off'};
const env={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1,telegramBotToken:'SYNTHETIC',telegramChatId:'SYNTHETIC'};
const request=(phase='SYNC',extra={})=>({releaseSha:runningReleaseSha(),requestId:randomUUID(),phase,triggerSource:'manual',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,{runtime:'on',mode:'off'},environment),...extra});
const success=()=>({syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS',users:0,failed:0});
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'p4-round2-')),url=`file:${join(dir,'isolated.db')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});await seed.close();const transport=hranaTransport(url),db=privateDb({url:'https://isolated.invalid',fetch:transport.fetch,phase4Keys:fixtureKeys});
 t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});return {db,dir,url};}
const run=(db,value,extra={})=>runExecutionPhase({db,request:value,environment,env,keys:fixtureKeys,deps:{runBriefing:success},...extra});
for(const boundary of ['request','heartbeat'])test(`R2-H1: cancellation before successful ${boundary} settlement cannot authorize drain`,async t=>{
 const {db}=await fixture(t),controller=new AbortController(),execute=db.raw.execute;let injected=false;
 db.raw.execute=async statement=>{const args=statement?.args??[];if(!injected&&JSON.stringify(args).includes('NO_NEW_DATA_SUCCESS')&&
  (boundary==='request'?String(statement?.sql).includes("SET state='WORK_COMMITTED'"):args[1]?.endsWith(':complete'))){injected=true;controller.abort();}return execute(statement);};
 const response=await run(db,request(),{signal:controller.signal});assert.equal(injected,true);assert.notEqual(response.body.syncComplete,true);
 assert.equal(response.body.handoff,undefined);const progress=await readPhaseProgress(db,'SYNC','manual');if(boundary==='request')assert.notEqual(progress.complete?.outcome,'NO_NEW_DATA_SUCCESS');else assert.equal(progress.settlementState,'FINALIZED_SUCCESS');
});
test('R2-H1: original deadline expiry during settlement cannot mint handoff',async t=>{
 const {db}=await fixture(t),execute=db.raw.execute;let injected=false;
 db.raw.execute=async statement=>{const args=statement?.args??[];if(!injected&&String(statement?.sql).includes("SET state='WORK_COMMITTED'")&&JSON.stringify(args).includes('NO_NEW_DATA_SUCCESS')){
 injected=true;const signal=currentExecutionBudget().signal;if(!signal.aborted)await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));}return execute(statement);};
 const response=await run(db,request(),{budgetMs:5000,overallBudgetMs:2000});assert.equal(injected,true);assert.notEqual(response.body.syncComplete,true);assert.equal(response.body.handoff,undefined);
});
test('R2-H2: retained underlying close/reconnect cannot resurrect admission or bypass changed schema',async t=>{
 const {dir,url}=await fixture(t),base=createClient({url}),close=base.close.bind(base),reconnect=base.reconnect.bind(base),db=composeDb(base,{phase4Keys:fixtureKeys});
 t.after(()=>db.close());const cap=await db.admitRuntime();assert.equal(db.requireRuntimeAdmission(cap),32);
 close();assert.throws(()=>db.requireRuntimeAdmission(cap));base.closed=false;assert.throws(()=>db.requireRuntimeAdmission(cap),'mutable closed flag cannot revive');
 await reconnect();assert.throws(()=>db.requireRuntimeAdmission(cap));await assert.rejects(()=>db.admitRuntime());const replacement=composeDb(createClient({url}),{phase4Keys:fixtureKeys});t.after(()=>replacement.close());const next=await replacement.admitRuntime();assert.notEqual(next,cap);assert.equal(replacement.requireRuntimeAdmission(next),32);
 close();const other=createClient({url});await other.execute('DROP TRIGGER p4_outbox_transition');other.close();await reconnect();
 assert.throws(()=>db.requireRuntimeAdmission(next));await assert.rejects(()=>db.admitRuntime());
});
const cliEnv=f=>({PATH:process.env.PATH,TMPDIR:tmpdir(),WHOOP_CLIENT_ID:'synthetic',WHOOP_CLIENT_SECRET:'synthetic',OPENROUTER_API_KEY:'synthetic',
 TELEGRAM_BOT_TOKEN:'synthetic',TELEGRAM_CHAT_ID:'1001',TURSO_DATABASE_URL:f.url,TURSO_AUTH_TOKEN:'synthetic',DRY_RUN:'1',TIMEZONE:'Asia/Taipei',
 PHASE4_LOOKUP_KEY:Buffer.alloc(32,71).toString('hex'),PHASE4_AUDIT_KEY:Buffer.alloc(32,83).toString('hex'),...environment,
 PHASE4_EXECUTION_PHASE:'SYNC',GITHUB_ACTIONS:'true',GITHUB_RUN_ID:'round2',GITHUB_RUN_ATTEMPT:'1',PHASE4_RELEASE_SHA:sha});
test('R2-M1: malformed GitHub event cannot fall back to manual',async t=>{
 const f=await fixture(t);await f.db.close();for(const event of [undefined,'','schedul','push','pull_request','repository_dispatch','arbitrary','Schedule']){
 const childEnv={...cliEnv(f),...(event!==undefined?{GITHUB_EVENT_NAME:event}:{})};
 const r=spawnSync(process.execPath,[join(root,'scripts/phase4-run.js')],{cwd:f.dir,env:childEnv,encoding:'utf8',timeout:10000});
 assert.equal(r.status,1,`${event}: ${r.stdout}${r.stderr}`);assert.match(r.stderr,/GITHUB_SOURCE_UNSUPPORTED/);}
});
test('R2-M2: identical code at different actual checkout commits cannot share a handoff',async t=>{
 const f=await fixture(t);await f.db.close();const repo=join(f.dir,'checkout');await cp(join(root,'src'),join(repo,'src'),{recursive:true});
 await cp(join(root,'scripts'),join(repo,'scripts'),{recursive:true});await cp(join(root,'package.json'),join(repo,'package.json'));
 await symlink(join(root,'node_modules'),join(repo,'node_modules'),'dir');const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git(['init','-q']);git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','add','src','scripts','package.json']);
 git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','release A']);const a=git(['rev-parse','HEAD']);
 const output=join(f.dir,'outputs'),runCli=extra=>spawnSync(process.execPath,[join(repo,'scripts/phase4-run.js')],{cwd:f.dir,env:{...cliEnv(f),GITHUB_EVENT_NAME:'schedule',GITHUB_OUTPUT:output,...extra},encoding:'utf8',timeout:15000});
 const sync=runCli({PHASE4_RELEASE_SHA:a});assert.equal(sync.status,0,sync.stderr);
 const fields=Object.fromEntries((await readFile(output,'utf8')).trim().split('\n').map(x=>x.split('=')));
 git(['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','--allow-empty','-qm','release B']);const b=git(['rev-parse','HEAD']);assert.notEqual(a,b);
 const drain=runCli({PHASE4_EXECUTION_PHASE:'STAGE6_DRAIN',PHASE4_RELEASE_SHA:b,PHASE4_SYNC_REQUEST_ID:fields.sync_request_id,PHASE4_SYNC_HANDOFF:fields.sync_handoff});
 assert.equal(drain.status,1,drain.stdout+drain.stderr);assert.match(drain.stderr,/SYNC_HANDOFF_REJECTED|RELEASE/);
});
test('R2-M3: cancellation during WebCrypto signing cannot start fetch',async()=>{
 const controller=new AbortController(),sign=crypto.subtle.sign.bind(crypto.subtle);let calls=0,signs=0;
 crypto.subtle.sign=async(...args)=>{signs++;await new Promise(r=>setTimeout(r,20));controller.abort();return sign(...args);};
 try{await assert.rejects(()=>invoke({BRIEFING_ENDPOINT_URL:'https://synthetic.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:'synthetic-secret-with-at-least-32-bytes',
 BRIEFING_EXECUTION_MODE:'OFF',BRIEFING_CONFIG_PROOF:'a'.repeat(64),BRIEFING_RELEASE_SHA:sha},{signal:controller.signal,fetchImpl:async()=>{calls++;return new Response(JSON.stringify({ok:true,phase:'SYNC',source:'cloudflare',syncComplete:true,drainAuthorized:false}));}}),e=>e.category==='cancelled');
 assert.equal(signs,1);assert.equal(calls,0);}finally{crypto.subtle.sign=sign;}
});

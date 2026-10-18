import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import http from 'node:http';
import {Sqlite3Client} from '@libsql/client/sqlite3';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createOwnedFileDb} from '../src/db.js';
import {createPhase4Keys} from '../src/phase4Keys.js';
import {runningReleaseSha} from '../src/phase4Release.js';
// Fault injection modifies only this isolated test module graph, never repository files.
const factories=['createBodyEnergyRuntime','createStage7Runtime','createStage8Runtime','createStage5PresentationRuntime','createRouter','createSettings','createUpdateProcessor'];
const special=['createWhoopOAuthCallback','runOnboardingBootstrap','createBriefingEndpoint','runMorningReadiness','createTelegramApi','createStage8ContinuationLoop'];
registerHooks({load(url,context,nextLoad){
 const result=nextLoad(url,context);if(result.format!=='module'||!url.startsWith(new URL('../src/',import.meta.url).href))return result;
 let source=String(result.source),changed=false;
 for(const name of [...factories,...special]){
  const expression=new RegExp(`export (async )?function ${name}\\(`);const match=source.match(expression);if(!match)continue;
  changed=true;source=source.replace(expression,`${match[1]??''}function __syntheticOriginal_${name}(`);
  source+=`\nexport ${match[1]??''}function ${name}(...args){if(globalThis.__syntheticFactoryFault===${JSON.stringify(name)})throw Object.assign(Error('SYNTHETIC_FACTORY_FAILURE'),{code:'SYNTHETIC_FACTORY_FAILURE'});if(globalThis.__syntheticFactoryHooks?.${name})return globalThis.__syntheticFactoryHooks.${name}(...args);return __syntheticOriginal_${name}(...args);}\n`;
 }
 return changed?{...result,source}:result;
}});
const {createBusinessWebhookRuntime,main}=await import('../src/bot/webhook.js');
const keys=createPhase4Keys({lookupKey:Buffer.alloc(32,71),auditKey:Buffer.alloc(32,83)}),releaseSha=runningReleaseSha({});
const environment=url=>({TELEGRAM_BOT_TOKEN:'123456:SYNTHETIC-ONLY',TELEGRAM_WEBHOOK_SECRET:'SYNTHETIC-ONLY-32-BYTE-WEBHOOK-SECRET',
 TURSO_DATABASE_URL:url,TURSO_AUTH_TOKEN:'SYNTHETIC-NOT-LIVE',OPENROUTER_API_KEY:'SYNTHETIC-NOT-LIVE',
 PHASE4_LOOKUP_KEY:'47'.repeat(32),PHASE4_AUDIT_KEY:'53'.repeat(32),PHASE4_EXECUTION_PROFILE:'PHASE4',
 PHASE4_RELEASE_SHA:releaseSha,RENDER_GIT_COMMIT:releaseSha,PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',
 PHASE4_PUBLIC_BETA_USER_IDS:'',PHASE4_BETA_PILOT_STOP:'on',PHASE4_BETA_PILOT_USER_ID:'synthetic-user',
 STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'synthetic-user',STAGE7_AUTOMATIC:'off',
 PHASE4_STAGE8_RUNTIME:'off',PHASE4_STAGE8_OWNER_MONITORING:'off',STAGE8_MORNING_BRIEF:'off',STAGE8_LIVE_ANALYSIS:'off',
 STAGE8_POST_SYNC:'off',STAGE8_SUBJECT_ALERTS:'off',PHASE4_DELIVERY_CUTOVER:'off',BODY_ENERGY_PUBLICATION:'off',BODY_ENERGY_ALERTS:'off',
 WHOOP_CLIENT_ID:'',WHOOP_CLIENT_SECRET:'',WHOOP_REDIRECT_URI:'',BRIEFING_TRIGGER_SECRET:'',WHOOP_WEBHOOK_ENABLED:'off'});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const turn=()=>new Promise(r=>setImmediate(r));
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'business-construction-')),url=pathToFileURL(join(directory,'synthetic.db')).href;
 const db=createOwnedFileDb({url,phase4Keys:keys});await db.migrate({targetVersion:35});await db.createUser({id:'synthetic-user',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});db.close();
 t.after(()=>rm(directory,{recursive:true,force:true}));return {url};
}
function response(){return Object.assign(new EventEmitter(),{headersSent:false,statusCode:null,body:null,
 writeHead(status,headers){this.statusCode=status;this.headers=headers;this.headersSent=true;},end(body){this.body=body;this.emit('finish');}});}
async function call(runtime,{path='/health',method='GET',body='',headers={}}={}){
 const req=Readable.from([Buffer.from(body)]);Object.assign(req,{url:path,method,headers});const res=response();await runtime.handler(req,res);return res;
}
test('every post-admission factory failure closes the owned SQLite client without listener or provider',async t=>{
 const f=await fixture(t);let closed=0,network=0;const close=Sqlite3Client.prototype.close;
 t.mock.method(Sqlite3Client.prototype,'close',function(){closed++;return close.call(this);});
 t.mock.method(globalThis,'fetch',async()=>{network++;throw Error('SYNTHETIC_NETWORK_FORBIDDEN');});
 try{for(const name of factories){globalThis.__syntheticFactoryFault=name;const before=closed;
  await assert.rejects(createBusinessWebhookRuntime({environment:environment(f.url)}),{code:'SYNTHETIC_FACTORY_FAILURE'});
  assert.equal(closed,before+1,`${name} closes exactly one primary DB`);
 }}finally{delete globalThis.__syntheticFactoryFault;}assert.equal(network,0);
});
test('real OAuth onAuthorized detached bootstrap remains owned after callback responds',async t=>{
 const f=await fixture(t),pending=deferred(),entered=deferred();let runtime;
 globalThis.__syntheticFactoryHooks={
  createWhoopOAuthCallback:options=>async()=>{await options.onAuthorized('synthetic-user',{expectedLifecycleGeneration:null});return {status:200,html:'synthetic'};},
  runOnboardingBootstrap:()=>{entered.resolve();return pending.promise;},
 };
 t.mock.method(globalThis,'fetch',async()=>{throw Error('SYNTHETIC_NETWORK_FORBIDDEN');});
 try{
  runtime=await createBusinessWebhookRuntime({environment:{...environment(f.url),WHOOP_CLIENT_ID:'SYNTHETIC',WHOOP_CLIENT_SECRET:'SYNTHETIC',WHOOP_REDIRECT_URI:'https://example.invalid/callback'}});
  const result=await call(runtime,{path:'/whoop/oauth/callback'});await entered.promise;assert.equal(result.statusCode,200);
  assert.equal(runtime.status().requests,0);assert.equal(runtime.status().background,1);
  runtime.closeAdmission('synthetic_window_0001');const disposing=runtime.dispose({signal:new AbortController().signal});await turn();assert.equal(runtime.status().databaseClosed,false);
  pending.resolve();await disposing;assert.equal(runtime.status().ownedDatabases,0);
 }finally{pending.resolve();delete globalThis.__syntheticFactoryHooks;if(runtime&&!runtime.status().disposed){runtime.closeAdmission('synthetic_window_0001');await runtime.dispose({signal:new AbortController().signal});}}
});
test('accepted internal request owns later secondary client until its promise settles, including thrown service errors',async t=>{
 const f=await fixture(t),pending=deferred(),entered=deferred();let runtime;
 globalThis.__syntheticFactoryHooks={
  createBriefingEndpoint:options=>async()=>{await options.runReadiness({request:{}});return {status:200,body:{ok:true}};},
  runMorningReadiness:async()=>{entered.resolve();await pending.promise;throw Error('SYNTHETIC_SERVICE_FAILURE');},
 };
 t.mock.method(globalThis,'fetch',async()=>{throw Error('SYNTHETIC_NETWORK_FORBIDDEN');});
 try{
  const env={...environment(f.url),WHOOP_CLIENT_ID:'SYNTHETIC',WHOOP_CLIENT_SECRET:'SYNTHETIC',WHOOP_REDIRECT_URI:'https://example.invalid/callback',TELEGRAM_CHAT_ID:'SYNTHETIC',BRIEFING_TRIGGER_SECRET:'SYNTHETIC-BRIEFING-SECRET-32-BYTES-LONG'};
  runtime=await createBusinessWebhookRuntime({environment:env});const request=call(runtime,{path:'/internal/briefing/readiness',method:'POST',body:'{}'});
  await entered.promise;assert.equal(runtime.status().requests,1);assert.equal(runtime.status().ownedDatabases,2);
  runtime.closeAdmission('synthetic_window_0001');const disposing=runtime.dispose({signal:new AbortController().signal});await turn();assert.equal(runtime.status().databaseClosed,false);
  pending.resolve();assert.equal((await request).statusCode,500);await disposing;assert.equal(runtime.status().ownedDatabases,0);
 }finally{pending.resolve();delete globalThis.__syntheticFactoryHooks;if(runtime&&!runtime.status().disposed){runtime.closeAdmission('synthetic_window_0001');await runtime.dispose({signal:new AbortController().signal});}}
});

test('callback ACK promise remains locally owned after the processor bounded wait ends',async t=>{
 const f=await fixture(t),pending=deferred(),entered=deferred();let runtime;
 globalThis.__syntheticFactoryHooks={createTelegramApi:()=>({answerCallbackQuery:()=>{entered.resolve();return pending.promise;}})};
 t.mock.method(globalThis,'fetch',async()=>{throw Error('SYNTHETIC_NETWORK_FORBIDDEN');});
 try{
  const env=environment(f.url);runtime=await createBusinessWebhookRuntime({environment:env});
  const request=call(runtime,{path:'/telegram/webhook',method:'POST',headers:{'x-telegram-bot-api-secret-token':env.TELEGRAM_WEBHOOK_SECRET},
   body:JSON.stringify({update_id:321,callback_query:{id:'synthetic-callback',from:{id:12345},message:{message_id:1,chat:{id:12345,type:'private'}},data:'synthetic-invalid-callback'}})});
  await entered.promise;const result=await request;assert.equal(result.statusCode,200);assert.equal(runtime.status().requests,0);assert.equal(runtime.status().background,1);
  runtime.closeAdmission('synthetic_window_0001');const disposing=runtime.dispose({signal:new AbortController().signal});await turn();assert.equal(runtime.status().databaseClosed,false);
  pending.resolve();await disposing;assert.equal(runtime.status().ownedDatabases,0);
 }finally{pending.resolve();delete globalThis.__syntheticFactoryHooks;if(runtime&&!runtime.status().disposed){runtime.closeAdmission('synthetic_window_0001');await runtime.dispose({signal:new AbortController().signal});}}
});

for(const phase of ['construction','listen'])test(`standalone server ${phase} failure disposes the constructed business DB`,async t=>{
 const f=await fixture(t);let closed=0;const close=Sqlite3Client.prototype.close;
 t.mock.method(Sqlite3Client.prototype,'close',function(){closed++;return close.call(this);});
 t.mock.method(globalThis,'fetch',async()=>{throw Error('SYNTHETIC_NETWORK_FORBIDDEN');});
 t.mock.method(http,'createServer',()=>{
  if(phase==='construction')throw Error('SYNTHETIC_SERVER_FAILURE');
  return Object.assign(new EventEmitter(),{listening:false,listen(){queueMicrotask(()=>this.emit('error',Error('SYNTHETIC_SERVER_FAILURE')));}});
 });
 const signals=['SIGTERM','SIGINT'].map(signal=>process.listeners(signal));
 await assert.rejects(main({environment:environment(f.url)}),/SYNTHETIC_SERVER_FAILURE/);
 assert.equal(closed,1);assert.deepEqual(['SIGTERM','SIGINT'].map(signal=>process.listeners(signal)),signals);
});

test('background startup failure leaves no process handlers or owned resources',async t=>{
 const f=await fixture(t),signals=['SIGTERM','SIGINT'].map(s=>process.listeners(s));let closed=0,stopped=0;
 const close=Sqlite3Client.prototype.close;
 t.mock.method(Sqlite3Client.prototype,'close',function(){closed++;return close.call(this);});
 t.mock.method(globalThis,'fetch',async()=>{throw Error('SYNTHETIC_NETWORK_FORBIDDEN');});
 const server=Object.assign(new EventEmitter(),{listening:false,
  listen(_port,_host,ready){this.listening=true;queueMicrotask(ready);},address(){return {port:12345};},
  close(done){this.listening=false;queueMicrotask(()=>{done();this.emit('close');});}});
 t.mock.method(http,'createServer',()=>server);
 globalThis.__syntheticFactoryHooks={createStage8Runtime:()=>({analysis:{resume(){}}}),
  createStage8ContinuationLoop:()=>({start(){throw Error('SYNTHETIC_BACKGROUND_START_FAILURE');},stop(){stopped++;}})};
 try{
  await assert.rejects(main({environment:{...environment(f.url),STAGE8_POST_SYNC:'on'}}),/SYNTHETIC_BACKGROUND_START_FAILURE/);
  assert.equal(closed,1);assert.equal(stopped,1);assert.equal(server.listening,false);
  assert.deepEqual(['SIGTERM','SIGINT'].map(s=>process.listeners(s)),signals);
 }finally{
  delete globalThis.__syntheticFactoryHooks;
  for(const [i,name]of ['SIGTERM','SIGINT'].entries())for(const listener of process.listeners(name))if(!signals[i].includes(listener))process.removeListener(name,listener);
 }
});

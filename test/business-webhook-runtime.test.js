import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createOwnedFileDb} from '../src/db.js';
import {createPhase4Keys} from '../src/phase4Keys.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {computeWhoopSignature} from '../src/whoopWebhookAuth.js';
import {createBusinessWebhookRuntime,main} from '../src/bot/webhook.js';
const keys=createPhase4Keys({lookupKey:Buffer.alloc(32,71),auditKey:Buffer.alloc(32,83)}),releaseSha=runningReleaseSha({});
const environment=url=>({TELEGRAM_BOT_TOKEN:'123456:SYNTHETIC-ONLY',TELEGRAM_WEBHOOK_SECRET:'SYNTHETIC-ONLY-32-BYTE-WEBHOOK-SECRET',
 TURSO_DATABASE_URL:url,TURSO_AUTH_TOKEN:'SYNTHETIC-NOT-LIVE',OPENROUTER_API_KEY:'SYNTHETIC-NOT-LIVE',
 PHASE4_LOOKUP_KEY:'47'.repeat(32),PHASE4_AUDIT_KEY:'53'.repeat(32),PHASE4_EXECUTION_PROFILE:'STAGE8_SCHEMA_TRANSITION',
 PHASE4_RELEASE_SHA:releaseSha,RENDER_GIT_COMMIT:releaseSha,PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',
 PHASE4_PUBLIC_BETA_USER_IDS:'',PHASE4_BETA_PILOT_STOP:'on',PHASE4_BETA_PILOT_USER_ID:'synthetic-user',
 STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'synthetic-user',STAGE7_AUTOMATIC:'off',
 PHASE4_STAGE8_RUNTIME:'off',PHASE4_STAGE8_OWNER_MONITORING:'off',STAGE8_MORNING_BRIEF:'off',STAGE8_LIVE_ANALYSIS:'off',
 STAGE8_POST_SYNC:'off',STAGE8_SUBJECT_ALERTS:'off',PHASE4_DELIVERY_CUTOVER:'off',BODY_ENERGY_PUBLICATION:'off',BODY_ENERGY_ALERTS:'off',
 WHOOP_CLIENT_ID:'',WHOOP_CLIENT_SECRET:'SYNTHETIC-WHOOP-SECRET',WHOOP_REDIRECT_URI:'',BRIEFING_TRIGGER_SECRET:'',WHOOP_WEBHOOK_ENABLED:'on',
 BRIEFING_CONTINUATION_SCOPE:'sync'});
async function fixture(t,version){
 const directory=await mkdtemp(join(tmpdir(),'business-lifecycle-')),url=pathToFileURL(join(directory,'synthetic.db')).href;
 const db=createOwnedFileDb({url,phase4Keys:keys});await db.migrate({targetVersion:version});db.close();
 t.after(()=>rm(directory,{recursive:true,force:true}));return {url};
}
function response(){return Object.assign(new EventEmitter(),{headersSent:false,statusCode:null,body:null,
 writeHead(status,headers){this.statusCode=status;this.headers=headers;this.headersSent=true;},end(body){this.body=body;this.emit('finish');}});}
async function call(runtime,{path='/health',method='GET',body='',headers={}}={}){
 const req=Readable.from([Buffer.from(body)]);Object.assign(req,{url:path,method,headers});const res=response();await runtime.handler(req,res);return res;
}
for(const version of [33,35])test(`managed actual SQLite${version} has no listener/signals/env mutation; durable WHOOP and closed rejection`,async t=>{
 const f=await fixture(t,version),env=environment(f.url),original={...process.env},signals=['SIGTERM','SIGINT'].map(s=>process.listeners(s));let runtime,network=0;
 t.mock.method(globalThis,'fetch',async()=>{network++;throw Error('SYNTHETIC_NETWORK_FORBIDDEN');});
 try{
  runtime=await main({managed:true,environment:env});assert.equal(runtime.server,undefined);
  assert.ok(JSON.stringify({...process.env})===JSON.stringify(original),'process environment unchanged');assert.deepEqual(['SIGTERM','SIGINT'].map(s=>process.listeners(s)),signals);
  assert.equal(runtime.db.requireRuntimeAdmission(await runtime.db.admitRuntime()),version);
  assert.equal((await call(runtime)).statusCode,200);
  const body=JSON.stringify({user_id:123456,id:'synthetic-resource-0001',type:'sleep.updated',trace_id:`synthetic-trace-${version}`});
  const timestamp=String(Date.now()),headers={'x-whoop-signature-timestamp':timestamp,'x-whoop-signature':computeWhoopSignature(timestamp,body,env.WHOOP_CLIENT_SECRET)};
  const accepted=await call(runtime,{path:'/whoop/webhook',method:'POST',body,headers});assert.equal(accepted.statusCode,200);
  const events=await runtime.db.raw.execute('SELECT COUNT(*) AS n FROM whoop_webhook_events');assert.equal(Number(events.rows[0].n),1);
  runtime.closeAdmission('synthetic_window_0001');const req={url:'/telegram/webhook',method:'POST',on(){throw Error('BODY_MUST_NOT_BE_READ');}},res=response();
  await runtime.handler(req,res);assert.equal(res.statusCode,503);
  await runtime.dispose({signal:new AbortController().signal});assert.equal(runtime.status().ownedDatabases,0);assert.equal(runtime.status().databaseClosed,true);
  assert.equal(runtime.status().provesRemoteSqlCancellation,false);assert.equal(network,0);
 }finally{if(runtime&&!runtime.status().disposed){runtime.closeAdmission('synthetic_window_0001');await runtime.dispose({signal:new AbortController().signal});}}
});
test('legacy listen:false exposes awaitable idempotent close without listening',async t=>{
 const f=await fixture(t,33),started=await main({listen:false,environment:environment(f.url)});
 assert.equal(started.server.listening,false);await started.close();await started.close();assert.equal(started.status().ownedDatabases,0);
});
test('unissued epoch option fails closed before constructing any business DB',async()=>{
 await assert.rejects(createBusinessWebhookRuntime({environment:environment('file:/synthetic-never-opened.db'),runtimeEpoch:{}}),{code:'RUNTIME_EPOCH_ORIGINAL_OPAQUE_SCOPE_REQUIRED'});
});
test('one unchanged environment can dispose all33 clients, migrate the owned synthetic file, and cold construct35',async t=>{
 const f=await fixture(t,33),env=environment(f.url);let original,current;
 t.mock.method(globalThis,'fetch',async()=>{throw Error('SYNTHETIC_NETWORK_FORBIDDEN');});
 try{
  original=await createBusinessWebhookRuntime({environment:env});assert.equal(original.db.requireRuntimeAdmission(await original.db.admitRuntime()),33);
  original.closeAdmission('synthetic_window_0001');await original.dispose({signal:new AbortController().signal});assert.equal(original.status().ownedDatabases,0);
  const migration=createOwnedFileDb({url:f.url,phase4Keys:keys});try{await migration.migrate({targetVersion:35});}finally{migration.close();}
  current=await createBusinessWebhookRuntime({environment:env});assert.notEqual(current.db,original.db);
  assert.equal(current.db.requireRuntimeAdmission(await current.db.admitRuntime()),35);assert.equal((await call(current)).statusCode,200);
  assert.equal((await call(original)).statusCode,503);assert.equal(original.status().admission,'CLOSED');
 }finally{for(const runtime of [original,current])if(runtime&&!runtime.status().disposed){runtime.closeAdmission('synthetic_window_0001');await runtime.dispose({signal:new AbortController().signal});}}
});

// Synthetic-only transport around the actual recoveryEntry composition.
// No application module, runtime admission or business runner is replaced.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {AsyncResource} from 'node:async_hooks';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {recoveryFixture,fixtureKeys} from './round4Fixture.js';
import {hranaTransport} from './hranaTransport.js';
import {makeDataset} from './fixtures.js';
import {main as recovery} from '../src/recoveryEntry.js';
import {RECOVERY_PRODUCTION_HOST} from '../src/recoveryPolicy.js';
import {runningReleaseSha} from '../src/phase4Release.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {publicBetaConfiguration} from '../src/publicBetaConfig.js';
import {WHOOP_SYNC} from '../src/config.js';
import {localDate} from '../src/time.js';
import {log} from '../src/logger.js';
import {HEARTBEAT_COMPONENT} from '../src/guardianPolicy.js';
export const syntheticUser='p0-synthetic-user';
export const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});

export function denyExternalIO(t){
 const fail=()=>{throw Error('P0_EXTERNAL_IO_FORBIDDEN');};
 t.mock.method(net.Socket.prototype,'connect',fail);
 t.mock.method(tls,'connect',fail);
 for(const mod of [http,https])for(const name of ['request','get'])t.mock.method(mod,name,fail);
 t.mock.method(process,'loadEnvFile',()=>{throw Error('P0_ENV_FILE_FORBIDDEN');});
}
export async function dispatch(handler,url,init){
 const req=Readable.from([Buffer.from(init.body??'')]);
 Object.assign(req,{method:init.method,url:new URL(url,'https://synthetic.invalid').pathname,headers:Object.fromEntries(new Headers(init.headers)),socket:{remoteAddress:'127.0.0.1'}});
 const res=new EventEmitter();let status=200,headers={};
 const result=new Promise((resolve,reject)=>{
  res.writeHead=(code,h)=>{status=code;headers=h;res.headersSent=true;return res;};
  res.end=body=>{res.writableEnded=true;res.emit('finish');resolve(new Response(body,{status,headers}));};
  res.destroy=reject;
 });
 await handler(req,res);return result;
}
export async function p0Harness(t,{source='ready',send='success',retired=false}={}){
 denyExternalIO(t);
 const events=[];
 for(const name of ['info','warn','error'])t.mock.method(log,name,(event,fields)=>events.push({event,code:fields?.code}));
 const f=await recoveryFixture(t),db=f.db,now=new Date(),day=localDate(now,'Asia/Taipei');
 const data={...makeDataset({now,days:10,wakeMinutesAgo:60,withNaps:false}),workouts:[],body:{height_meter:1.75,weight_kilogram:70,max_heart_rate:190}};
 if(source==='missing-sleep'){data.sleeps=[];data.recoveries=[];}
 if(source==='missing-recovery')data.recoveries=[];
 if(source==='stale'){data.sleeps=data.sleeps.slice(3);data.recoveries=data.recoveries.slice(3);}
 await db.createUser({id:syntheticUser,displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 await db.linkTelegram({userId:syntheticUser,chatId:'910001'});
 await db.setLocale(syntheticUser,'en');await db.ensureOnboarding(syntheticUser,{state:'READY'});
 await db.setProactiveEnabled(syntheticUser,false);
 await db.recordHeartbeat('global',HEARTBEAT_COMPONENT.GITHUB,{now});
 await db.saveTokens(syntheticUser,{accessToken:'synthetic-access-only',refreshToken:'synthetic-refresh-only',expiresAt:new Date(now.getTime()+3600000),whoopUserId:'920001'});
 await db.saveCapabilities(syntheticUser,[{key:'sleep',status:'SUPPORTED'}],{expectedLifecycleGeneration:1});
 for(const resource of WHOOP_SYNC.RESOURCES)await db.saveSyncState(syntheticUser,resource,{backfillComplete:true,lastSuccessAt:new Date(now.getTime()-3*3600000).toISOString()},{now});
 if(retired){const {SCHEMA}=await import('../src/schema.js');for(const name of ['idx_insight_subject','idx_insight_active'])await db.raw.execute(SCHEMA.find(sql=>sql.includes('INDEX IF NOT EXISTS '+name+' ')));}
 const releaseSha=runningReleaseSha({}),environment={PHASE4_RELEASE_SHA:releaseSha,RENDER_GIT_COMMIT:releaseSha,
  PHASE4_EXECUTION_PROFILE:'STAGE8_SCHEMA_TRANSITION',PHASE4_LOOKUP_KEY:'47'.repeat(32),PHASE4_AUDIT_KEY:'53'.repeat(32),
  TURSO_DATABASE_URL:'libsql://'+RECOVERY_PRODUCTION_HOST,TURSO_AUTH_TOKEN:'SYNTHETIC-NOT-LIVE',BRIEFING_CONTINUATION_SCOPE:'sync',
  TELEGRAM_BOT_TOKEN:'synthetic-only',TELEGRAM_CHAT_ID:'910001',TELEGRAM_WEBHOOK_SECRET:'synthetic-webhook-secret-more-than-32',
  BRIEFING_TRIGGER_SECRET:'synthetic-scheduler-secret-more-than-32',OPENROUTER_API_KEY:'synthetic-only',
  WHOOP_CLIENT_ID:'synthetic-only',WHOOP_CLIENT_SECRET:'synthetic-only',TIMEZONE:'Asia/Taipei',DRY_RUN:'0',
  REPO_LAST_COMMIT_AT:now.toISOString(),STAGE7_COMPANION:'off',STAGE7_AUTOMATIC:'off',WHOOP_WEBHOOK_ENABLED:'off'};
 const previous={...process.env};
 // Remove inherited app configuration; only explicitly synthetic values enter runtime.
 for(const key of Object.keys(process.env))if(!['PATH','HOME','TMPDIR','LANG','LC_ALL','NODE_TEST_CONTEXT'].includes(key))delete process.env[key];
 Object.assign(process.env,environment);
 const wire=hranaTransport('file:'+f.dir+'/synthetic.db');
 const counts={db:0,whoop:0,model:0,telegram:0,ddl:0,unknown:0},statements=[];
 let started,handler,bootstrap=true;
 t.after(async()=>{await started?.close();wire.close();for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,previous);});
 t.mock.method(globalThis,'fetch',async(input,init)=>{
  const request=input instanceof Request?input:new Request(input,init),url=new URL(request.url);
  if(url.hostname===RECOVERY_PRODUCTION_HOST){
   counts.db++;const packet=await request.clone().json();
   const scan=value=>{if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){
    if(key==='sql'&&typeof item==='string'){statements.push(item);if(/^\s*(CREATE|ALTER|DROP)\b/i.test(item)){counts.ddl++;throw Error('RUNTIME_DDL_FORBIDDEN');}
     if(bootstrap&&/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(item))throw Error('STARTUP_WRITE_FORBIDDEN');
    }else if(typeof item==='object')scan(item);
   }};scan(packet);return wire.fetch(request);
  }
  if(url.hostname==='api.prod.whoop.com'){
   counts.whoop++;assert.equal(request.method,'GET','no OAuth refresh');
   if(source==='failure')return json({error:'synthetic-forbidden'},403);
   const paths={'/developer/v2/activity/sleep':'sleeps','/developer/v2/recovery':'recoveries','/developer/v2/cycle':'cycles','/developer/v2/activity/workout':'workouts'};
   if(paths[url.pathname])return json({records:data[paths[url.pathname]],next_token:null});
   if(url.pathname==='/developer/v2/user/measurement/body')return json(data.body);
   throw Error('UNDECLARED_SYNTHETIC_WHOOP_PATH');
  }
  if(url.hostname==='openrouter.ai'){
   counts.model++;return json({choices:[{message:{content:'{"order":[]}'}}],usage:{prompt_tokens:1,completion_tokens:1}});
  }
  if(url.hostname==='api.telegram.org'){
   counts.telegram++;assert.equal(url.pathname,'/botsynthetic-only/sendMessage');
   if(send==='lost-ack')throw Object.assign(Error('SYNTHETIC_ACK_LOST'),{code:'ECONNRESET'});
   return json({ok:true,result:{message_id:940001,chat:{id:910001,type:'private'},date:Math.floor(Date.now()/1000)}});
  }
  counts.unknown++;throw Error('UNDECLARED_EXTERNAL_TRANSPORT');
 });
 const createServer=http.createServer;
 t.mock.method(http,'createServer',fn=>{
  // Model Node's server request callback retaining the entry's ALS context;
  // do not bind a socket or expose a real webhook receiver.
  handler=AsyncResource.bind(fn);return createServer(fn);
 });
 const start=async()=>{bootstrap=true;started=await recovery({environment,argv:[],listen:false});bootstrap=false;return started;};
 const restart=async()=>{await started?.close();return start();};
 const workerEnvironment={BRIEFING_ENDPOINT_URL:'https://synthetic.invalid/internal/briefing/run',BRIEFING_TRIGGER_SECRET:environment.BRIEFING_TRIGGER_SECRET,
  BRIEFING_RELEASE_SHA:releaseSha,BRIEFING_EXECUTION_MODE:'OFF',BRIEFING_CONTINUATION_DISCOVERY:'on',BRIEFING_CONTINUATION_SCOPE:'sync',
  BRIEFING_CONFIG_PROOF:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment,releaseSha)};
 const calls=[];
 const fetchWorker=async(url,init)=>{const response=await dispatch(handler,url,init);calls.push({path:new URL(url).pathname,body:init.body,status:response.status,result:await response.clone().json()});return response;};
 return {...f,day,now,environment,workerEnvironment,counts,events,statements,calls,start,restart,fetchWorker,wire,get runtime(){return started;}};
}

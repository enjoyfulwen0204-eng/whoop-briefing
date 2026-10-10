import {AsyncResource} from 'node:async_hooks';
import {createCoach} from '../src/coach.js';
import {createTelegram} from '../src/telegram.js';
import {openHttpFixture} from './deliveryDefaultFixture.js';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
const root=new URL('../',import.meta.url).href;const {createDb}=await import(root+'src/db.js');const {createOwnedDb}=await import(root+'test/stage5OwnedDb.js');const {fixtureKeys}=await import(root+'test/localDb.js');const {hranaTransport}=await import(root+'test/hranaTransport.js');const {makeDataset}=await import(root+'test/fixtures.js');const {fakeCoach}=await import(root+'test/fakes.js');const {staticDataSource}=await import(root+'src/dataSource.js');const {WHOOP_SYNC}=await import(root+'src/config.js');
const {runExecutionPhase}=await import(root+'src/phase4Execution.js');const {configurationProof}=await import(root+'src/phase4ExecutionStore.js');const {publicBetaConfiguration}=await import(root+'src/publicBetaConfig.js');const {runningReleaseSha}=await import(root+'src/phase4Release.js');const {RECONCILE_RESULT}=await import(root+'src/schema.js');
for(const change of ['auth','purge','source'])test(`F01 actual Morning Brief refuses cached health after ${change} while other tenants continue`,async t=>{
 const shadow='off';
 const now=new Date('2026-10-09T00:00:00Z'),ids=['alice','bob','lan'],locales=['zh-TW','en','vi'],names=['REVIEW_ALICE','REVIEW_BOB','REVIEW_LAN'],data=new Map();
 const dir=await mkdtemp('/private/tmp/rc4-three-language-'),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});await seed.migrate({targetVersion:32});
 for(const [i,id] of ids.entries()){
  await seed.createUser({id,displayName:names[i],status:'ACTIVE',timezone:'Asia/Taipei'});await seed.setLocale(id,locales[i]);await seed.linkTelegram({userId:id,chatId:String(1001+i)});
  await seed.saveTokens(id,{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000),whoopUserId:String(12345+i)});await seed.saveCapabilities(id,[{key:'sleep',status:'SUPPORTED'}],{expectedLifecycleGeneration:1});
  data.set(id,makeDataset({now,days:45,withNaps:false,seed:42+i,overrides:{0:{hrv:60+i*30}}}));
  for(const resource of WHOOP_SYNC.RESOURCES){await seed.saveSyncState(id,resource,{backfillComplete:true,lastSuccessAt:now.toISOString()},{now});const owner='seed-'+id+'-'+resource;assert.equal(await seed.claimReconciliation({userId:id,resource,owner,leaseMs:300000,now,lifecycleGeneration:1}),true);assert.equal(await seed.settleReconciliation({userId:id,resource,owner,result:RECONCILE_RESULT.SUCCESS,windowTo:now,now,lifecycleGeneration:1}),true);}
 }
 await seed.close();const transport=hranaTransport(url),db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:transport.fetch});t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});
 const environment={PHASE4_BETA_SHADOW_RUNTIME:shadow,PHASE4_PUBLIC_BETA_MODE:'off'},request={releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:'cloudflare',executionMode:shadow==='on'?'SHADOW':'OFF',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)};
 const operator=openHttpFixture(url);t.after(()=>operator.close());const external=new AsyncResource('independent-morning-operator');t.after(()=>external.emitDestroy());let revoked=false,aliceProviderCalls=0;
 const payloads=[],env={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:3,telegramBotToken:'synthetic',telegramChatId:'synthetic',whoopClientId:'synthetic',whoopClientSecret:'synthetic',openrouterApiKey:'synthetic',openrouterModel:'synthetic',repoLastCommitAt:now.toISOString()};
 const deps={makeWhoop:({userId})=>({userId,getAccessToken:async()=>'synthetic'}),makeSource:({whoop})=>staticDataSource(data.get(whoop.userId)),makeCoach:options=>createCoach({...options,env:{},maxRetries:2,backoffFor:()=>0,fetchImpl:async(_url,init)=>{
  if(options.userId==='alice'){aliceProviderCalls++;if(!revoked){revoked=true;await external.runInAsyncScope(async()=>{
   if(change==='auth')await operator.db.saveTokens('alice',{accessToken:'synthetic-new',refreshToken:'synthetic-new',expiresAt:new Date(Date.now()+3600000),whoopUserId:'12345'},{bumpAuthGeneration:true,expectedLifecycleGeneration:1});
   else await operator.db.raw.execute(`UPDATE phase4_user_state SET ${change==='purge'?'purge_generation':'source_generation'}=${change==='purge'?'purge_generation':'source_generation'}+1 WHERE user_id='alice'`);
  });return new Response(JSON.stringify({error:{message:'synthetic retry'}}),{status:503});}}
  return new Response(JSON.stringify({choices:[{message:{content:'{"order":[]}'}}]}));
 }}),makeTelegram:options=>{let notice=false;const sender=createTelegram({...options,dryRun:false,fetchImpl:async(_url,init)=>{const body=JSON.parse(init.body);payloads.push({kind:notice?'notice':'brief',chatId:String(body.chat_id),text:body.text});return new Response(JSON.stringify({ok:true,result:{message_id:payloads.length,date:1791586800,chat:{id:Number(body.chat_id),type:'private'}}}));}});const notify=sender.notifyError;sender.notifyError=async(...args)=>{notice=true;try{return await notify(...args);}finally{notice=false;}};return sender;},proactive:async()=>null,guardian:async()=>null,predictionCycle:async()=>null,healthspan:async()=>null};
 const run=r=>runExecutionPhase({request:r,db,keys:fixtureKeys,environment,env,deps,now});await run(request);
 assert.equal(revoked,true);assert.equal(aliceProviderCalls,1);assert.equal(payloads.some(p=>p.chatId==='1001'&&p.kind==='brief'),false,'no stale canonical fallback delivery');
 assert.equal(payloads.filter(p=>['1002','1003'].includes(p.chatId)).length,2,'unrelated tenants still receive ordinary briefs');
 for(const p of payloads.filter(p=>p.chatId==='1001')){assert.equal(p.kind,'notice');assert.doesNotMatch(p.text,/REVIEW_ALICE|HRV|60%/);}
 assert.equal((await db.raw.execute("SELECT count(*) n FROM report_runs WHERE user_id='alice' AND status='SENT'")).rows[0].n,0);
});

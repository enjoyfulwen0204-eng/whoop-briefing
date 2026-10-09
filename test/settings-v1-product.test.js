import {createSettings} from '../src/bot/settings.js';
import {createRouter} from '../src/bot/router.js';
import {deliverPublicBetaSummary} from '../src/publicBetaSummaryDelivery.js';
import {createPublicBetaPresentation,publicBetaPolicy,authorizePublicBetaRuntime} from '../src/publicBeta.js';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
const root=new URL('../',import.meta.url).href;const {createDb}=await import(root+'src/db.js');const {createOwnedDb}=await import(root+'test/stage5OwnedDb.js');const {fixtureKeys}=await import(root+'test/localDb.js');const {hranaTransport}=await import(root+'test/hranaTransport.js');const {makeDataset}=await import(root+'test/fixtures.js');const {fakeCoach}=await import(root+'test/fakes.js');const {staticDataSource}=await import(root+'src/dataSource.js');const {WHOOP_SYNC}=await import(root+'src/config.js');
const {runExecutionPhase}=await import(root+'src/phase4Execution.js');const {configurationProof}=await import(root+'src/phase4ExecutionStore.js');const {publicBetaConfiguration}=await import(root+'src/publicBetaConfig.js');const {runningReleaseSha}=await import(root+'src/phase4Release.js');const {RECONCILE_RESULT}=await import(root+'src/schema.js');
test('post-Settings real three-user Morning Brief and Journal/Coach rendering use saved profile; synthetic typed Beta rendering uses fresh profile',async t=>{
 const now=new Date('2026-10-09T00:00:00Z'),ids=['alice','bob','lan'],locales=['zh-TW','en','vi'],names=['REVIEW_ALICE','REVIEW_BOB','REVIEW_LAN'],data=new Map();
 const dir=await mkdtemp('/private/tmp/rc4-three-language-'),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});await seed.migrate({targetVersion:32});
 for(const [i,id] of ids.entries()){
  await seed.createUser({id,displayName:"Before",status:'ACTIVE',timezone:'Asia/Taipei'});await seed.setLocale(id,'zh-TW');await seed.linkTelegram({userId:id,chatId:String(1001+i)});
  await seed.saveTokens(id,{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000),whoopUserId:String(12345+i)});await seed.saveCapabilities(id,[{key:'sleep',status:'SUPPORTED'}],{expectedLifecycleGeneration:1});
  data.set(id,makeDataset({now,days:45,withNaps:false,seed:42+i,overrides:{0:{hrv:60+i*30}}}));
  for(const resource of WHOOP_SYNC.RESOURCES){await seed.saveSyncState(id,resource,{backfillComplete:true,lastSuccessAt:now.toISOString()},{now});const owner='seed-'+id+'-'+resource;assert.equal(await seed.claimReconciliation({userId:id,resource,owner,leaseMs:300000,now,lifecycleGeneration:1}),true);assert.equal(await seed.settleReconciliation({userId:id,resource,owner,result:RECONCILE_RESULT.SUCCESS,windowTo:now,now,lifecycleGeneration:1}),true);}
 }
 await seed.close();const transport=hranaTransport(url),db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:transport.fetch});t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});

 const flow=createSettings({db});await db.admitRuntime();
 const callbackData=(reply,code)=>reply.replyMarkup.inline_keyboard.flat().find(b=>b.callback_data.endsWith('.'+code)).callback_data;
 for(const [i,id] of ids.entries()){
  const call=async(text,callbackData)=>flow({text,chatId:String(1001+i),user:await db.getUser(id),...(callbackData?{callback:{data:callbackData}}:{})});
  const chooser=await call('/language'),preview=await call('',callbackData(chooser,['tw','en','vi'][i]));await call('',callbackData(preview,'confirm'));
  await call('/name');const name=await call(names[i]);await call('',callbackData(name,'save'));
 }
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'},request={releaseSha:runningReleaseSha(),requestId:randomUUID(),phase:'SYNC',triggerSource:'cloudflare',executionMode:'OFF',configProof:configurationProof(fixtureKeys,publicBetaConfiguration(environment),environment)};
 const payloads=[],env={timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:3,telegramBotToken:'synthetic',telegramChatId:'synthetic',whoopClientId:'synthetic',whoopClientSecret:'synthetic',openrouterApiKey:'synthetic',openrouterModel:'synthetic',repoLastCommitAt:now.toISOString()};
 const deps={makeWhoop:({userId})=>({userId,getAccessToken:async()=>'synthetic'}),makeSource:({whoop})=>staticDataSource(data.get(whoop.userId)),makeCoach:()=>fakeCoach(),makeTelegram:({chatId,locale})=>({send:async text=>{payloads.push({chatId,locale,text});return {messageId:payloads.length};},sendTyping:async()=>true,notifyError:async()=>false}),proactive:async()=>null,guardian:async()=>null,predictionCycle:async()=>null,healthspan:async()=>null};
 const run=r=>runExecutionPhase({request:r,db,keys:fixtureKeys,environment,env,deps,now});const first=await run(request);assert.equal(first.status,200,JSON.stringify(first));assert.equal(payloads.length,3);
 for(const [i,id] of ids.entries()){const p=payloads.find(p=>p.chatId===String(1001+i));assert.equal(p.locale,locales[i]);assert.ok(p.text.includes(names[i]));for(const name of names.filter(x=>x!==names[i]))assert.ok(!p.text.includes(name));assert.doesNotMatch(p.text,/Body Energy|Beta Summary|Kelvin/);}
 assert.deepEqual(await run(request),first);assert.equal(payloads.length,3);assert.equal((await run({...request,requestId:randomUUID()})).status,200);assert.equal(payloads.length,3);
 const claims=(await db.raw.execute("SELECT user_id,local_date,delivery_state,delivery_attempts,telegram_message_id FROM report_claims WHERE report_type='daily' ORDER BY user_id")).rows.map(r=>({...r}));assert.equal(claims.length,3);assert.ok(claims.every(r=>r.delivery_state==='DELIVERED'&&r.delivery_attempts===1&&r.telegram_message_id!==null));assert.equal((await db.raw.execute("SELECT count(*) n FROM report_runs WHERE report_type='daily' AND status='SENT'")).rows[0].n,3);

 const router=createRouter({db,coachFor:()=>({json:async()=>null,ask:async()=>null}),now:()=>now});
 const stores={withContext:async(userId,options,fn)=>fn({userId,...options}),assertCurrent:async()=>true,
  betaSummary:{readCurrent:async context=>({userId:context.userId,executionMode:'SHADOW',episodes:[{metricKey:'hrv',direction:'HIGHER'}],insights:[]})}};
 const presentation=createPublicBetaPresentation({db,stores,policy:publicBetaPolicy({mode:'allowlist',userIds:ids}),runtimeCapability:authorizePublicBetaRuntime({executionMode:'SHADOW'})});
 const betaPayloads=[];
 for(const [i,id] of ids.entries()){
  const user=await db.getUser(id),chatId=String(1001+i);
  const journal=await router.handle({text:'/log alcohol 1 drinks',chatId,user});
  const coachReply=await router.handle({text:'我今天狀態怎樣？',chatId,user});
  const beta=await presentation.summary({userId:id,now});assert.ok(beta?.includes(names[i]));
  const makeTelegram=({chatId})=>({send:async text=>{betaPayloads.push({chatId,text});return {messageId:100+betaPayloads.length};}});
  const delivered=await deliverPublicBetaSummary({db,env,user,presentation,now,makeTelegram});assert.equal(delivered.status,'delivered');
  const sent=betaPayloads.at(-1);assert.equal(sent.chatId,chatId);assert.ok(sent.text.includes(names[i]));for(const name of names.filter(n=>n!==names[i]))assert.ok(!sent.text.includes(name));
  const count=betaPayloads.length;await deliverPublicBetaSummary({db,env,user,presentation,now,makeTelegram});assert.equal(betaPayloads.length,count);
  if(locales[i]!=='zh-TW')for(const text of [journal,coachReply,beta])assert.doesNotMatch(text,/[\u3400-\u9fff]/u);
  for(const text of [journal,coachReply,beta])assert.doesNotMatch(text,/Kelvin|Body Energy/);
  assert.equal((await db.getJournalEvents(id,{from:'2026-10-09',to:'2026-10-09'})).length,1);
 }
 assert.equal(betaPayloads.length,3);
 console.log('REVIEW_DELIVERY '+JSON.stringify({locales,claims,delivered:payloads.length,cachedReplayAdditional:0,freshIdentityReplayAdditional:0,bodyEnergy:'NOT_AUTHORIZED_NOT_PRESENTED'}));
});

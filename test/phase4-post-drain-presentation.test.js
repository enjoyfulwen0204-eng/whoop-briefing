import { runningReleaseSha } from '../src/phase4Release.js';
import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createDb,fixtureKeys} from './localDb.js';import {runExecutionPhase} from '../src/phase4Execution.js';
import {configurationProof} from '../src/phase4ExecutionStore.js';
import {createPublicBetaPresentation,publicBetaPolicy,authorizePublicBetaRuntime} from '../src/publicBeta.js';
const locales=[['alice','zh-TW','Alice'],['bob','en','Bob'],['nameless','vi','']];
test('authorized post-drain path presents typed current state in zh-TW/en/vi, names and recipients isolated; SYNC and OFF never present',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-post-drain-')),db=createDb({url:`file:${join(dir,'isolated.db')}`});
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});await db.migrate();
 for(const [id,locale,name] of [...locales,['outsider','en','Outside']]){
  await db.createUser({id,displayName:name||'Temporary',timezone:'Asia/Taipei',status:'ACTIVE'});if(!name)await db.raw.execute({sql:"UPDATE users SET display_name='' WHERE id=?",args:[id]});
  await db.setLocale(id,locale);await db.linkTelegram({userId:id,chatId:String(1001+locales.findIndex(u=>u[0]===id))});
 }
 db.listSchedulableUsers=async()=>Promise.all([...locales.map(u=>u[0]),'outsider'].map(id=>db.getUser(id)));
 const payloads=[],order=[],current=new Set(locales.map(u=>u[0])),items=id=>({userId:id,executionMode:'SHADOW',episodes:current.has(id)?[{metricKey:'recovery_score',direction:'LOWER'}]:[],insights:[]});
 const presentation=createPublicBetaPresentation({db,stores:{withContext:async(id,_options,fn)=>fn({userId:id}),assertCurrent:async()=>true,
  betaSummary:{readCurrent:async c=>{order.push('typed_read');return items(c.userId);}}},policy:publicBetaPolicy({mode:'allowlist',userIds:locales.map(u=>u[0])}),runtimeCapability:authorizePublicBetaRuntime({executionMode:'SHADOW'})});
 const runtime={betaPresentation:presentation,phase4Stage6:{drain:async()=>{order.push('drain');return {outcome:'PARTIAL',completion:'PARTIAL',jobsConsidered:3,itemsAttempted:4,processedItems:4,completedJobs:2,remainingJobs:4,stopReason:'TENANT_LIMIT'};}}};
 const environment={PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'allowlist',PHASE4_PUBLIC_BETA_USER_IDS:locales.map(u=>u[0]).join(',')};
 const request=(phase='SYNC',extra={})=>({releaseSha:runningReleaseSha(),requestId:randomUUID(),phase,triggerSource:'manual',executionMode:'SHADOW',configProof:configurationProof(fixtureKeys,{runtime:'on',mode:environment.PHASE4_PUBLIC_BETA_MODE},environment),...extra});
 const deps={runtime,runBriefing:async()=>{order.push('sync');return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'};},makeTelegram:({chatId})=>({send:async text=>{order.push('send');payloads.push({chatId,text});return {messageId:payloads.length};}})};
 const run=r=>runExecutionPhase({request:r,db,keys:fixtureKeys,environment,env:{dryRun:true},deps});
 const syncRequest=request(),sync=await run(syncRequest);assert.deepEqual(order,['sync']);assert.equal(payloads.length,0);
 const drain=request('STAGE6_DRAIN',{syncRequestId:syncRequest.requestId,handoff:sync.body.handoff});await run(drain);
 assert.equal(order[1],'drain');assert.equal(payloads.length,3);assert.ok(order.indexOf('typed_read')>order.indexOf('drain'));
 for(const [id,locale,name] of locales){const p=payloads.find(x=>x.chatId===String(1001+locales.findIndex(u=>u[0]===id)));assert.ok(p);
  assert.match(p.text,locale==='zh-TW'?/恢復分數/:locale==='en'?/Recovery/:/phục hồi/i);
  if(name)assert.match(p.text,new RegExp(name));else assert.doesNotMatch(p.text,/Temporary|Alice|Bob/);
  assert.doesNotMatch(p.text,/Kelvin|Body Energy|身體能量|Outside/);
  for(const [other,,otherName] of locales)if(other!==id&&otherName)assert.doesNotMatch(p.text,new RegExp(otherName));
 }
 await run(drain);assert.equal(payloads.length,3,'identical drain retry caches and delivery remains deduped');
 environment.PHASE4_PUBLIC_BETA_MODE='off';const off=request(),offSync=await run(off);
 await run(request('STAGE6_DRAIN',{syncRequestId:off.requestId,handoff:offSync.body.handoff}));assert.equal(payloads.length,3,'OFF gate applies before an injected presentation can run');
});

/** Isolated native SQLite + real Stage7/updateProcessor/router kernel.
 * Synthetic callback/transport only, no Production listener or epoch grant.
 * v34 is an isolated interrupted-upgrade compatibility state, never an
 * externally published production epoch or a downgrade/recovery instruction. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys as keys} from './localDb.js';
import {createStage7Runtime} from '../src/stage7Runtime.js';
import {createStage8Runtime} from '../src/stage8Runtime.js';
import {createUpdateProcessor,isAcknowledgeable} from '../src/bot/updateProcessor.js';
import {createStableWebhookRouter} from '../src/stableWebhookRouter.js';
import {applyStage8LocalMigrationStep,stage8PreservationSnapshot} from '../scripts/stage8-migration-safety.mjs';
const H=x=>createHash('sha256').update(x).digest('hex');
const environment={PHASE4_EXECUTION_PROFILE:'STAGE8_V35_RECOVERY',PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',STAGE7_COMPANION:'on',STAGE7_COMPANION_USER_IDS:'a',PHASE4_BETA_PILOT_USER_ID:'a',STAGE7_AUTOMATIC:'off',BODY_ENERGY_PUBLICATION:'off',BODY_ENERGY_ALERTS:'off'};
async function seedOriginal(db){
 const statements=[];
 for(let i=0;i<37;i++){
  const id='SYNTHETIC-EXEC-PENDING-'+i,identity=H('identity'+i),scope=H('scope'+i),config=H('config'),request={requestId:id,phase:'SYNC',releaseSha:'ca4bff7b711737527ca6c4e306d4a3ef555c9f3b',executionMode:'OFF',triggerSource:'manual',configProof:config};
  statements.push({sql:"INSERT INTO phase4_executions(execution_id,identity_digest,scope_key,canonical_request_json,phase,release_sha,execution_mode,trigger_source,config_proof,owner,generation,lease_until,deadline_at,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'OFF','manual',?,'SYNTHETIC',1,9999999999999,9999999999999,'ESTABLISHED',1,1)",args:[id,identity,scope,JSON.stringify(request),'SYNC',request.releaseSha,config]});
  for(let j=0;j<(i?35:36);j++)statements.push({sql:'INSERT INTO phase4_execution_work_receipts(execution_id,receipt_key,scope_key,request_digest,step_key,generation,committed_at,result_json) VALUES(?,?,?,?,?,1,1,NULL)',args:[id,H('receipt'+i+':'+j),scope,identity,H('step'+i+':'+j)]});
 }
 await db.raw.batch(statements,'write');await db.raw.execute('UPDATE phase4_executions SET lease_until=1,deadline_at=1');
}
async function business(db,cards,workerId){
 const version=(await db.raw.execute('SELECT max(version) n FROM schema_version')).rows[0].n;
 const localEnvironment=version===34?{...environment,PHASE4_EXECUTION_PROFILE:'PHASE4'}:environment;
 const runtime=await createStage7Runtime({db,keys,environment:localEnvironment,env:{}});let admission='OPEN',active=0;
 assert.equal(await createStage8Runtime({db,keys,environment:localEnvironment,env:{}}),null);
 const processor=createUpdateProcessor({db,workerId,resolveUser:id=>db.resolveUserByChatId(id),stage7Inbound:runtime.stage7Inbound,stage7Reply:runtime.stage7Reply,handleMessage:()=>null,answerCallback:async()=>{},
  sendReply:input=>runtime.sendReply(async value=>{
   if(!await value.beforeSend())return {sent:false,messageId:null};
   cards.push(value.reply);return {sent:true,messageId:701}; // Raw synthetic immediate ACK has the Bot API integer type.
  },input)});
 return {
  handler:async(req,res)=>{assert.equal(admission,'OPEN');active++;try{const result=await processor.processUpdate(req.syntheticUpdate);res.writeHead(isAcknowledgeable(result.outcome)?200:503,{});res.end(JSON.stringify(result));}finally{active--;}},
  closeAdmission:()=>{admission='CLOSED';},waitForDrained:async()=>assert.equal(active,0),dispose:async()=>{assert.equal(active,0);await db.close();},status:()=>({admission}),startBackground:async()=>{},
 };
}
async function route(router,update,{loseAck=false}={}){
 let status=0,payload;
 const res={headersSent:false,writableEnded:false,writeHead(n){status=n;this.headersSent=true;},end(value){this.writableEnded=true;if(loseAck)throw Error('SYNTHETIC_HTTP_ACK_LOST_AFTER_OPERATION');payload=JSON.parse(value);}};
 await router.handler({url:'/telegram/webhook',syntheticUpdate:update},res);return {status,payload};
}
function callback(card,label,id){
 const button=card.replyMarkup.inline_keyboard.flat().find(b=>b.text.includes(label));assert.ok(button,label);
 return {update_id:id,callback_query:{id:'SYNTHETIC-CALLBACK-'+id,data:button.callback_data,from:{id:123,is_bot:false},message:{message_id:701,chat:{id:123,type:'private'}}}};
}
test('native v34 draft callback survives isolated35 recovery, quiescence503, lost HTTP ACK and cold same-update dedup with all original37/1296 intact',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'v34-v35-callback-SYNTHETIC-')),url='file:'+join(directory,'isolated.sqlite');let db=createOwnedDb({url}),disposed=false;
 t.after(async()=>{if(!disposed)await db.close();await rm(directory,{recursive:true,force:true});});
 await db.migrate({targetVersion:33});for(const id of ['a','b','c'])await db.createUser({id,displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await db.linkTelegram({userId:'a',chatId:'123'});await db.setLocale('a','en');await db.saveTokens('a',{accessToken:'SYNTHETIC',refreshToken:'SYNTHETIC',expiresAt:new Date(Date.now()+3600000),scope:'offline',whoopUserId:'SYNTHETIC-WHOOP'});
 await seedOriginal(db);const original=await stage8PreservationSnapshot(db.raw,keys,{phase4_executions:{},phase4_execution_work_receipts:{},users:{}});
 assert.equal(original.phase4_executions.count,37);assert.equal(original.phase4_execution_work_receipts.count,1296);
 await applyStage8LocalMigrationStep(db.raw,{keys,fromVersion:33,targetVersion:34});assert.deepEqual(await stage8PreservationSnapshot(db.raw,keys,original),original);
 const cards34=[],old=await business(db,cards34,'SYNTHETIC-V34-WORKER'),router=createStableWebhookRouter({business:old});
 const initial={update_id:75001,message:{message_id:1,text:'/journal',chat:{id:123,type:'private'},from:{id:123,is_bot:false}}};
 assert.equal((await route(router,initial)).status,200);assert.equal(cards34.length,1);
 for(const [label,id] of [['Alcohol',75002],['Yes',75003]]){const result=await route(router,callback(cards34.at(-1),label,id));assert.equal(result.status,200);assert.equal(result.payload.outcome,'processed');}
 const final=callback(cards34.at(-1),'Confirm',75004),ingress={handler:async()=>assert.fail('Telegram must never hit WHOOP intake'),closeAdmission(){},waitForDrained:async()=>{},dispose:async()=>{}};
 router.stageMaintenanceIngress({nativeIngress:ingress,originalWindowId:'SYNTHETIC-ISOLATED-CALLBACK-WINDOW'});router.closeBusinessAdmission();
 assert.equal((await route(router,final)).status,503);assert.equal(await db.getTelegramOperation(75004),null);assert.equal((await db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,0);
 await router.drainAndDisposeBusiness({signal:new AbortController().signal});disposed=true;
 db=createOwnedDb({url});disposed=false;await applyStage8LocalMigrationStep(db.raw,{keys,fromVersion:34,targetVersion:35});assert.deepEqual(await stage8PreservationSnapshot(db.raw,keys,original),original);
 const cards35=[],fresh=await business(db,cards35,'SYNTHETIC-V35-RECOVERY-WORKER');router.stageFreshBusiness({freshBusiness:fresh});await router.finishReopen({signal:new AbortController().signal});
 await assert.rejects(route(router,final,{loseAck:true}),/SYNTHETIC_HTTP_ACK_LOST_AFTER_OPERATION/);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,1);assert.equal(cards35.length,1);assert.deepEqual(await stage8PreservationSnapshot(db.raw,keys,original),original);
 await db.close();disposed=true;db=createOwnedDb({url});disposed=false;const coldCards=[],coldRouter=createStableWebhookRouter({business:await business(db,coldCards,'SYNTHETIC-COLD-V35-WORKER')});
 const replay=await route(coldRouter,final);assert.equal(replay.status,200);assert.equal(replay.payload.outcome,'replayed');assert.equal(coldCards.length,0);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM journal_events')).rows[0].n,1);assert.equal((await db.raw.execute("SELECT count(*) n FROM journal_events WHERE user_id<>'a'")).rows[0].n,0);
 assert.deepEqual(await stage8PreservationSnapshot(db.raw,keys,original),original);
 assert.equal((await db.raw.execute('SELECT max(version) n FROM schema_version')).rows[0].n,35);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM stage8_live_executions')).rows[0].n,0);
 t.diagnostic('Synthetic only: real additive schemas/Stage7/Telegram native claims and routing kernel; no production epoch/control grant, real callback or actual Telegram send.');
});

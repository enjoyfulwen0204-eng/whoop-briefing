import test from 'node:test';import assert from 'node:assert/strict';
import {createClient} from '@libsql/client/sqlite3';
import {fixture,request,claim,fixtureKeys} from './v32ReviewFixture.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';
import {createExecutionBudget,withExecutionBudget} from '../src/executionBudget.js';
import {withSyncOwnership} from '../src/syncOwnership.js';
import {createReconciler} from '../src/reconcile.js';
import {openingReceiptProof,parseOpeningReceipt} from '../src/reconciliationOpeningReceipt.js';

test('closed opening scalar schema rejects legacy grants, objects, noncanonical and malformed values',()=>{
 const hash='a'.repeat(64);assert.equal(parseOpeningReceipt('0'),0);assert.equal(parseOpeningReceipt(JSON.stringify(hash)),hash);
 for(const value of ['1','-1','1.5','true','false','null','[]','{}','{"inputProof":"'+hash+'","health":"forbidden"}','"'+hash.toUpperCase()+'"','"'+hash.slice(1)+'"','-0','0e0',' 0 ',0,null,undefined])assert.throws(()=>parseOpeningReceipt(value),e=>e.code==='RECONCILIATION_OPENING_RECEIPT_INVALID');
});
test('closed metadata domain requires authentic keys, exact nonhealth fields, proof/outcome coupling and canonical bounds',()=>{
 const metadata={keys:fixtureKeys,executionIdentity:'a'.repeat(64),executionScope:'b'.repeat(64),userId:'alice',resource:'sleep',scope:'recent',owner:'owner',intent:'c'.repeat(64),leaseExpiresAt:'2026-10-11T01:00:00.000Z',lastAttemptAt:'2026-10-11T00:00:00.000Z',runId:1,mode:'incremental',from:'2026-10-10T00:00:00.000Z',to:'2026-10-11T00:00:00.000Z',token:null,inputProof:'d'.repeat(64),outcome:'ready'};
 const original=openingReceiptProof(metadata);assert.match(original,/^[a-f0-9]{64}$/);
 for(const patch of [{runId:1.5},{runId:-1},{mode:'unknown'},{scope:'other'},{outcome:'unknown'},{inputProof:null},{from:null},{to:null},{from:'2026-10-11T00:00:00.000Z'},{to:'2026-10-11'},{to:new Date(NaN)},{token:1},{leaseExpiresAt:null},{lastAttemptAt:'2026-10-11'},{leaseExpiresAt:'2026-10-11T00:00:00.000Z'},{outcome:'input_fenced'}])assert.throws(()=>openingReceiptProof({...metadata,...patch}),e=>e.code==='RECONCILIATION_OPENING_RECEIPT_INVALID');
 assert.throws(()=>openingReceiptProof({...metadata,health:'forbidden'}),e=>e.code==='RECONCILIATION_OPENING_RECEIPT_INVALID');
 assert.throws(()=>openingReceiptProof({...metadata,keys:{lookup:()=>original}}),e=>e.code==='PHASE4_PRIVACY_KEYS_REQUIRED');
 for(const patch of [{runId:2},{executionIdentity:'e'.repeat(64)},{executionScope:'e'.repeat(64)},{userId:'bob'},{owner:'successor'},{inputProof:'e'.repeat(64)},{to:'2026-10-12T00:00:00.000Z'},{token:'different-continuation'},{outcome:'pending_fenced'},{leaseExpiresAt:'2026-10-11T02:00:00.000Z'},{lastAttemptAt:'2026-10-11T00:00:01.000Z'}])assert.notEqual(openingReceiptProof({...metadata,...patch}),original);
});
async function actual(t){
 const f=await fixture(t),other=createClient({url:f.url});t.after(()=>other.close());await f.db.createUser({id:'alice',displayName:'Synthetic',status:'ACTIVE',timezone:'Asia/Taipei'});
 await f.db.saveTokens('alice',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3600000),whoopUserId:'synthetic-original'});await f.db.getCapabilities('alice');
 const c=await claim(f.db,request()),budget=createExecutionBudget({budgetMs:30000});t.after(()=>budget.close());const context={claim:c,keys:fixtureKeys,pending:new Set(),authority:budget},anchor=new Date(c.startedAt);let provider=0;
 const callbacks={claim:0,run:0,pending:0};for(const [name,k] of [['claimReconciliation','claim'],['openReconciliationRun','run'],['openPendingWindow','pending']]){const original=f.db[name];f.db[name]=async(...args)=>{callbacks[k]++;return original(...args);};}
 const run=(o={})=>withExecutionBudget(budget,()=>withDurableExecution(context,()=>withSyncOwnership({db:f.db,userId:'alice',budget},()=>createReconciler({db:f.db,userId:'alice',timezone:'Asia/Taipei',expectedLifecycleGeneration:1,ownerId:o.owner??'owner',windowNow:anchor,maxPagesPerRun:1,whoop:{apiGet:async(_path,q)=>{provider++;assert.equal(f.db.processingTransactionActive(),false);return o.page?.(q)??{records:[],next_token:null};},bodyMeasurement:async()=>{provider++;assert.equal(f.db.processingTransactionActive(),false);return {height_meter:1.7,weight_kilogram:70};}}}).reconcileResource(o.resource??'sleep',o.options))));
 return {...f,other,context,anchor,callbacks,run,get provider(){return provider;}};
}
function interrupted(f){const transaction=f.db.transaction;let first=true;f.db.transaction=async(fn,options)=>{const root=!f.db.processingTransactionActive(),result=await transaction(fn,options);if(root&&first&&options?.replay){first=false;throw Error('SYNTHETIC_AFTER_ACK_INTERRUPT');}return result;};}
const modes={point:{resource:'body_measurement'},incremental:{},deep:{options:{scope:'deep'}},explicit:{options:{explicitWindow:{from:new Date('2026-10-09T00:00:00Z'),to:new Date('2026-10-10T00:00:00Z')}}},resumed:{}};
for(const [name,options] of Object.entries(modes))test(`actual ${name} replay rejects coupled substituted run/state bounds before any provider or effect`,async t=>{
 const f=await actual(t),resource=options.resource??'sleep',key=name==='deep'?'sleep/deep':resource;
 if(name==='resumed')assert.equal((await f.run({owner:'first',page:()=>({records:[],next_token:'synthetic-resume'})})).result,'PARTIAL');
 interrupted(f);await assert.rejects(f.run(options),/SYNTHETIC_AFTER_ACK_INTERRUPT/);const before=f.provider,callbacks={...f.callbacks};
 await f.other.execute({sql:"UPDATE whoop_reconciliation_runs SET window_to='2026-09-01T00:00:00.000Z',window_from=? WHERE user_id='alice' AND resource=? AND finished_at IS NULL",args:[name==='point'?null:'2026-08-31T00:00:00.000Z',key]});
 if(name!=='point'&&name!=='explicit')await f.other.execute({sql:"UPDATE whoop_reconciliation_state SET continuation_from='2026-08-31T00:00:00.000Z',continuation_to='2026-09-01T00:00:00.000Z' WHERE user_id='alice' AND resource=?",args:[key]});
 assert.equal((await f.run(options)).result,'SKIPPED');assert.equal(f.provider,before);assert.deepEqual(f.callbacks,callbacks);
 assert.equal((await f.other.execute("SELECT count(*) n FROM whoop_body_measurements WHERE user_id='alice'")).rows[0].n,0);
});
for(const [name,sql] of Object.entries({subject:"UPDATE user_whoop_tokens SET whoop_user_id='synthetic-new' WHERE user_id='alice'",authorization:"UPDATE user_whoop_tokens SET auth_generation=auth_generation+1 WHERE user_id='alice'",privacy:"UPDATE phase4_user_state SET purge_generation=purge_generation+1 WHERE user_id='alice'"}))test(`actual ${name} replay cannot refresh the original captured proof as authority`,async t=>{
 const f=await actual(t);interrupted(f);await assert.rejects(f.run(),/SYNTHETIC_AFTER_ACK_INTERRUPT/);const callbacks={...f.callbacks};await f.other.execute(sql);
 assert.equal((await f.run()).result,'SKIPPED');assert.equal(f.provider,0);assert.deepEqual(f.callbacks,callbacks);assert.equal((await f.other.execute("SELECT count(*) n FROM whoop_sleeps WHERE user_id='alice'")).rows[0].n,0);
});
for(const [name,options] of Object.entries(modes))test(`actual intact ${name} capsule resumes only its original acknowledged grant/window`,async t=>{
 const f=await actual(t);if(name==='resumed')assert.equal((await f.run({owner:'first',page:()=>({records:[],next_token:'synthetic-resume'})})).result,'PARTIAL');
 interrupted(f);await assert.rejects(f.run(options),/SYNTHETIC_AFTER_ACK_INTERRUPT/);const callbacks={...f.callbacks},before=f.provider;
 assert.equal((await f.run(options)).result,'SUCCESS');assert.equal(f.provider,before+1);assert.deepEqual(f.callbacks,callbacks);
});
test('actual reused owner with a later resource lease cannot turn an old opening capsule into renewed authority',async t=>{
 const f=await actual(t);interrupted(f);await assert.rejects(f.run(),/SYNTHETIC_AFTER_ACK_INTERRUPT/);const callbacks={...f.callbacks};
 await f.other.execute("UPDATE whoop_reconciliation_state SET lease_expires_at='2999-01-01T00:00:00.000Z',last_attempt_at='2026-10-12T00:00:00.000Z' WHERE user_id='alice' AND resource='sleep'");
 assert.equal((await f.run()).result,'SKIPPED');assert.equal(f.provider,0);assert.deepEqual(f.callbacks,callbacks);assert.equal((await f.other.execute("SELECT count(*) n FROM whoop_sleeps WHERE user_id='alice'")).rows[0].n,0);
});

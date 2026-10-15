// Pure metadata/SQL model, NOT monitored calculation, grants, or completion evidence.
import test from 'node:test';import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';
import {createClient} from '@libsql/client';import {metricUnitReceipt,metricRunReceipt,metricUnitWork} from '../src/phase4MetricUnitReceipt.js';
import {withDurableExecution} from '../src/phase4ExecutionContext.js';import {bodySha256} from '../src/briefingTriggerAuth.js';
const modelUrl=process.env.STAGE6_METADATA_MODEL_URL??':memory:';
if(modelUrl!==':memory:'&&modelUrl!=='http://127.0.0.1:18080')throw Error('ISOLATED_METADATA_MODEL_URL_REQUIRED');
const keys={lookup:value=>createHmac('sha256','synthetic-metadata-model-only').update(JSON.stringify(value)).digest('hex')};
async function model(t,count,{active=true}={}){
 const db=createClient({url:modelUrl});t.after(()=>db.close());assert.equal((await db.execute("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).rows[0].n,0,'metadata model requires a fresh empty isolated database');
 await db.executeMultiple(`CREATE TABLE phase4_executions(execution_id TEXT PRIMARY KEY,owner TEXT,generation INTEGER,state TEXT,phase TEXT,execution_seq INTEGER,identity_digest TEXT,scope_key TEXT,canonical_request_json TEXT,release_sha TEXT,trigger_source TEXT,execution_mode TEXT,config_proof TEXT,sync_execution_id TEXT,created_at INTEGER,deadline_at INTEGER,lease_until INTEGER,finalized_at INTEGER,result_json TEXT,result_digest TEXT);
 CREATE TABLE phase4_execution_producers(user_id TEXT,execution_mode TEXT,input_generation INTEGER,producing_execution_id TEXT,producing_generation INTEGER,execution_seq INTEGER,tenant_proof TEXT,PRIMARY KEY(user_id,execution_mode,input_generation,producing_execution_id));
 CREATE TABLE phase4_execution_work_receipts(execution_id TEXT,receipt_key TEXT PRIMARY KEY,scope_key TEXT,request_digest TEXT,step_key TEXT,generation INTEGER,committed_at INTEGER,result_json TEXT);`);
 const req={requestId:'current',releaseSha:'metadata-model',phase:'STAGE6_DRAIN',triggerSource:'manual',executionMode:'SHADOW',configProof:'model-config'},canonical=JSON.stringify(Object.fromEntries(Object.keys(req).sort().map(k=>[k,req[k]]))),claim={request:req,executionId:'current',owner:'model-owner',generation:1,identity:'current-identity',scopeKey:'current-scope'};
 const now=Date.now();await db.execute({sql:`INSERT INTO phase4_executions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,args:['current','model-owner',1,'ESTABLISHED','STAGE6_DRAIN',10000,'current-identity','current-scope',canonical,req.releaseSha,req.triggerSource,'SHADOW',req.configProof,null,now-5000,now+600000,now+600000,null,null,null]});
 const context={userId:'model-a',executionMode:'SHADOW',inputGeneration:11,sourceGeneration:1,lifecycleGeneration:1,authGeneration:1,purgeGeneration:1,algorithmSetVersion:'model',timezone:'UTC'},plan={runKey:'run',inputHash:'input',itemKey:'item'},job={},counts={producerPages:0,exactReceiptReads:0,checks:0,lookups:0},seen=[];
 const producers=[];
 for(let i=1;i<=count;i++){
  const id='producer-'+String(i).padStart(5,'0'),identity='identity-'+id,scope='scope-'+id,record=JSON.stringify({identity,phase:'STAGE6_DRAIN',releaseSha:req.releaseSha,source:req.triggerSource,configProof:req.configProof,executionMode:'SHADOW',outcome:'PARTIAL'}),p={id,identity,scope,seq:i};producers.push(p);
  await db.execute({sql:'INSERT INTO phase4_executions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',args:[id,'retired',1,'FINALIZED_SUCCESS','STAGE6_DRAIN',i,identity,scope,'{}',req.releaseSha,req.triggerSource,'SHADOW',req.configProof,null,now-5000,now+600000,0,now-1000,record,bodySha256(record)]});
  await db.execute({sql:'INSERT INTO phase4_execution_producers VALUES(?,?,?,?,?,?,?)',args:['model-a','SHADOW',11,id,1,i,keys.lookup(['execution-producer-v1','model-a','SHADOW',11,id,i,1])]});
 }
 let afterPage=()=>{},valid=true;const client={async execute(stmt){seen.push(stmt);const result=await db.execute(stmt);if(stmt.sql.includes('SELECT p.*,e.state')){counts.producerPages++;await afterPage(counts.producerPages);}if(stmt.sql.startsWith('WITH expected'))counts.exactReceiptReads++;return result;}};
 const core={schemaVersion:32,keys:{lookup(v){counts.lookups++;return keys.lookup(v);}},jobAuthority:()=>job,processing:{active:()=>active},client,async assertContext(){counts.checks++;if(!valid)throw Error('MODEL_AUTHORITY_REVOKED');}},execution={claim,keys,pending:new Set(),authority:{assert(){}}};
 async function receipt(index,kind='ITEM',{bad=false}={}){const p=producers[index],step=withDurableExecution(execution,()=>metricUnitWork(context,plan,kind).workStep),key=keys.lookup(['execution-work-step-v2',p.identity,p.scope,['named',step]]);await db.execute({sql:'INSERT INTO phase4_execution_work_receipts VALUES(?,?,?,?,?,?,?,?)',args:[p.id,key,p.scope,p.identity,key,bad?2:1,now-2000,null]});return key;}
 const run=fn=>withDurableExecution(execution,fn),unit=()=>run(()=>metricUnitReceipt(core,context,plan,'ITEM')),whole=()=>run(()=>metricRunReceipt(core,context,plan));
 return {db,core,context,plan,producers,counts,seen,run,receipt,unit,whole,setPage(fn){afterPage=fn;},revoke(){valid=false;}};
}
for(const count of [1,64,65,128,129,288])test('exact metadata lookup reaches final producer across indexed pages: '+count,async t=>{
 const m=await model(t,count);await m.receipt(count-1);assert.ok(await m.unit());assert.equal(m.counts.producerPages,Math.ceil(count/64));assert.equal(m.counts.exactReceiptReads,Math.ceil(count/64));
 assert.ok(m.counts.lookups>=count*2);assert.ok(m.seen.filter(s=>s.sql.includes('SELECT p.*,e.state')).every(s=>s.args.length===4));
 const sql=m.seen.find(s=>s.sql.includes('SELECT p.*,e.state'));const plan=(await m.db.execute({sql:'EXPLAIN QUERY PLAN '+sql.sql,args:sql.args})).rows.map(r=>r.detail).join('\n');assert.match(plan,/SEARCH p USING INDEX.*producing_execution_id>\?/);assert.doesNotMatch(plan,/TEMP B-TREE/);
});
test('empty producer history fails closed; completed search with no matching receipt returns null',async t=>{await assert.rejects((await model(t,0)).unit(),/METRIC_UNIT_RECEIPT_REQUIRED/);const m=await model(t,129);assert.equal(await m.unit(),null);assert.equal(m.counts.producerPages,3);});
test('unmatched producer HMAC and matching receipt ownership cannot be skipped',async t=>{
 const m=await model(t,129);await m.receipt(128);await m.db.execute("UPDATE phase4_execution_producers SET tenant_proof='forged' WHERE producing_execution_id='producer-00001'");await assert.rejects(m.unit(),/METRIC_UNIT_RECEIPT_REQUIRED/);
 const n=await model(t,65);await n.receipt(64,'ITEM',{bad:true});await assert.rejects(n.unit(),/METRIC_UNIT_RECEIPT_REQUIRED/);
});
test('fresh revoked context and expired current owner fail between pages',async t=>{
 const m=await model(t,129);await m.receipt(128);m.setPage(n=>{if(n===1)m.revoke();});await assert.rejects(m.unit(),/MODEL_AUTHORITY_REVOKED/);assert.equal(m.counts.producerPages,1);
 const n=await model(t,129);await n.receipt(128);n.setPage(async page=>{if(page===1)await n.db.execute("UPDATE phase4_executions SET lease_until=0 WHERE execution_id='current'");});await assert.rejects(n.unit(),/REQUEST_OWNER_FENCED/);assert.equal(n.counts.producerPages,1);
});
test('tenant/mode/generation mismatch cannot import another cohort receipt',async t=>{const m=await model(t,1);await m.receipt(0);for(const [key,value]of [['userId','model-b'],['executionMode','LIVE'],['inputGeneration',12]]){const saved=m.context[key];m.context[key]=value;await assert.rejects(m.unit(),/METRIC_UNIT_RECEIPT_REQUIRED/);m.context[key]=saved;}});
test('RUN alternative priority and separate START/COMPLETE producers remain intact',async t=>{
 const m=await model(t,129);await m.receipt(128,'RUN');await m.receipt(0,'RUN_START',{bad:true});await m.receipt(64,'RUN_COMPLETE',{bad:true});assert.equal(await m.whole(),true);
 const n=await model(t,129);await n.receipt(128,'RUN_COMPLETE',{bad:true});assert.equal(await n.whole(),false);
 const p=await model(t,129);await p.receipt(0,'RUN_START');await p.receipt(128,'RUN_COMPLETE');assert.equal(await p.whole(),true);
 const q=await model(t,65);await q.receipt(64,'RUN',{bad:true});await q.receipt(0,'RUN_START');await q.receipt(64,'RUN_COMPLETE');await assert.rejects(q.whole(),/METRIC_UNIT_RECEIPT_REQUIRED/);
});
test('tampered sealed result and cumulative metadata bounds reject, never claim absence',async t=>{
 const m=await model(t,65);await m.receipt(64);await m.db.execute("UPDATE phase4_executions SET result_digest='forged' WHERE execution_id='producer-00065'");await assert.rejects(m.unit(),/METRIC_UNIT_RECEIPT_REQUIRED/);
 const n=await model(t,65);await n.receipt(64);await n.db.execute({sql:"UPDATE phase4_executions SET result_json=? WHERE execution_id='producer-00001'",args:['x'.repeat(2*1024*1024)]});await assert.rejects(n.unit(),/METRIC_UNIT_RECEIPT_REQUIRED/);
});

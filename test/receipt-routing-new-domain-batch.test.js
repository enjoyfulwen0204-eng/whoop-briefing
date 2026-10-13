import test from 'node:test';import assert from 'node:assert/strict';
import {fixture,fixtureKeys} from './v32ReviewFixture.js';
import {createReceiptRouting} from '../src/phase4ReceiptRouting.js';

const context={userId:'a',executionMode:'SHADOW'};
const row={user_id:'a',execution_mode:'SHADOW',operation_kind:'analyzeMetric',operation_key:'a'.repeat(64)};
const decoded={request:{request:{metricKey:'body_energy',windowFamily:'SYNTHETIC_DOMAIN'}},
 related:[{type:'evidence_runs',id:'synthetic-run'},{type:'evidence_items',id:'synthetic-item'}]};
const tables=['phase4_receipt_routes','phase4_receipt_route_entries','phase4_receipt_route_manifests'];
async function setup(t){
 const {db,transport}=await fixture(t);await db.admitRuntime();
 await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 return {db,transport,routing:createReceiptRouting(db.raw,fixtureKeys)};
}
async function stored(db){return Promise.all(tables.map(async table=>(await db.raw.execute(`SELECT * FROM ${table} ORDER BY 1,2,3,4`)).rows.map(row=>({...row}))));}
// Routing is retained after redaction. This isolated source contains no
// calculation/health payload; it satisfies the actual deferred receipt FK.
async function source(db){await db.raw.execute({sql:`INSERT INTO phase4_operation_receipts
 (user_id,execution_mode,content_state,source_linkage_state,health_content_redacted_at,health_content_redaction_reason,privacy_artifact_id,operation_kind,operation_key,
 receipt_version,input_generation,lifecycle_generation,auth_generation,created_at)
 VALUES (?,?,'REDACTED','DISCONNECTED','2026-10-12T00:00:00.000Z','SOURCE_DELETED',?,?,?,'stage5-operation-result-v1',0,1,0,'2026-10-12T00:00:00.000Z')`,
 args:['a','SHADOW','b'.repeat(64),row.operation_kind,row.operation_key]});}

test('new DOMAIN route subjects have authentic tips and replay keeps their original immutable rows',async t=>{
 const {db,routing}=await setup(t);
 const subjects=await db.transaction(async()=>{const values=await routing.register(row,decoded,{batchNew:true});await source(db);return values;});
 assert.equal(subjects.length,4);
 const before=await stored(db);
 for(const [kind,token] of subjects){
  const identity=kind==='EPISODE'?['body_energy','body_energy']:null;
  // inventory's precise-token mode authenticates every entry and header.
  const proof=await db.transaction(()=>routing.inventory(context,kind,token,true,{metadataOnly:true}));
  assert.equal(proof.manifest.entryCount,1);assert.equal(proof.unknown,0);
  if(identity)assert.equal((await db.transaction(()=>routing.tip(context,kind,identity))).entryCount,1);
 }
 await db.transaction(()=>routing.register(row,decoded,{batchNew:true}));
 assert.deepEqual(await stored(db),before);
});

test('a real middle-of-batch uniqueness rejection rolls back route row, earlier entries and manifests',async t=>{
 const {db,routing}=await setup(t),batch=db.raw.batch.bind(db.raw);let injected=false;
 db.raw.batch=statements=>{
  if(!injected&&statements.length>2&&/^INSERT INTO phase4_receipt_route_entries/.test(statements[0].sql)){
   injected=true;const broken=[...statements];broken.splice(3,0,statements[0]);return batch(broken);
  }
  return batch(statements);
 };
 try{await assert.rejects(db.transaction(()=>routing.register(row,decoded,{batchNew:true})),/UNIQUE|CONSTRAINT/i);}
 finally{db.raw.batch=batch;}
 assert.equal(injected,true);assert.deepEqual((await stored(db)).map(rows=>rows.length),[0,0,0]);
 await db.transaction(async()=>{await routing.register(row,decoded,{batchNew:true});await source(db);});
 assert.deepEqual((await stored(db)).map(rows=>rows.length),[1,4,4]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './v32ReviewFixture.js';
import {captureRawSourceEffectCatalog} from '../src/processingRawSourceEffects.js';
test('same original acknowledged HTTP fixture transaction admits only the exact canonical effect catalog',async t=>{
 const {db}=await fixture(t,35);await db.admitRuntime();
 const direct={batch:queries=>db.raw.batch(queries),execute:query=>db.raw.execute(query)};
 const current=()=>assert.equal(db.processingTransactionActive(),true);
 await assert.rejects(captureRawSourceEffectCatalog({client:db.raw,transaction:direct,assertCurrent:current,revision:()=>0}));
 await db.transaction(async()=>{
  const result=await captureRawSourceEffectCatalog({client:db.raw,transaction:direct,assertCurrent:current,revision:()=>0});
  assert.ok(result,'EXACT_CANONICAL_CATALOG_MUST_BE_PROVEN');
  assert.ok(result.tables.has('whoop_recoveries'));assert.ok(result.tables.has('evidence_items'));
  result.assert();
 });
 await db.transaction(async()=>{
  await db.raw.execute('CREATE TEMP TABLE raw_effect_temp_probe(x TEXT)');
  assert.equal(await captureRawSourceEffectCatalog({client:db.raw,transaction:direct,assertCurrent:current,revision:()=>0}),null);
  await db.raw.execute('DROP TABLE raw_effect_temp_probe');
 });
 await db.transaction(async()=>{
  await db.raw.execute('CREATE TRIGGER raw_effect_injected AFTER INSERT ON evidence_items BEGIN UPDATE whoop_sleeps SET raw_json=NULL; END');
  assert.equal(await captureRawSourceEffectCatalog({client:db.raw,transaction:direct,assertCurrent:current,revision:()=>0}),null);
  await db.raw.execute('DROP TRIGGER raw_effect_injected');
 });
 await db.transaction(async()=>{
  await db.raw.execute('CREATE TABLE raw_effect_extra(id TEXT REFERENCES users(id) ON DELETE CASCADE)');
  assert.equal(await captureRawSourceEffectCatalog({client:db.raw,transaction:direct,assertCurrent:current,revision:()=>0}),null);
  await db.raw.execute('DROP TABLE raw_effect_extra');
 });
 // These are explicit synthetic metadata faults, not provider evidence.
 const observed=async transform=>db.transaction(async()=>captureRawSourceEffectCatalog({client:db.raw,
  transaction:{execute:direct.execute,batch:async q=>transform(await direct.batch(q))},assertCurrent:current,revision:()=>0}));
 const replaceRows=(results,index,rows)=>results.map((r,i)=>i===index?{...r,rows}:r);
 assert.equal(await observed(r=>replaceRows(r,1,[...r[1].rows,{seq:2,name:'other',file:':memory:'}])),null);
 assert.equal(await observed(r=>replaceRows(r,3,[...r[3].rows,{name:'coalesce',builtin:0,narg:-1}])),null);
 for(const name of ['glob','json_array'])assert.equal(await observed(r=>replaceRows(r,3,[...r[3].rows,{name,builtin:0,narg:-1}])),null);
 assert.ok(await observed(r=>replaceRows(r,4,[...r[4].rows,{seq:3,name:'UNUSED_PROVIDER_COLLATION'}])));
 for(const mutation of ['CANONICAL_TRIGGER','RAW_FK','VIRTUAL_HEADER','RENAMED_HEADER','WRONG_TBL_NAME'])await db.transaction(async()=>{
  const tx={batch:direct.batch,execute:async query=>{
   const result=await direct.execute(query);
   if(query!=='SELECT type,name,tbl_name,sql FROM sqlite_master LIMIT 2049')return result;
   let changed=false;return {...result,rows:result.rows.map(row=>{
    if(!changed&&(mutation==='CANONICAL_TRIGGER'?row.type==='trigger':row.type==='table'&&row.name==='whoop_sleeps')){
     changed=true;
     if(mutation==='VIRTUAL_HEADER')return {...row,sql:row.sql.replace(/^CREATE TABLE(?: IF NOT EXISTS)? [^(]+/i,'CREATE VIRTUAL TABLE whoop_sleeps USING unknown_static_module ')};
     if(mutation==='RENAMED_HEADER')return {...row,sql:row.sql.replace('whoop_sleeps','wrong_table')};
     if(mutation==='WRONG_TBL_NAME')return {...row,tbl_name:'wrong_table'};
     return {...row,sql:row.sql+(mutation==='CANONICAL_TRIGGER'?' SELECT 1':' REFERENCES users(id)')};
    }return row;
   })};
  }};
  assert.equal(await captureRawSourceEffectCatalog({client:db.raw,transaction:tx,assertCurrent:current,revision:()=>0}),null,mutation);
 });
 await db.transaction(async()=>{
  let revision=0;
  const tx={execute:direct.execute,batch:async q=>{const results=await direct.batch(q);revision++;return results;}};
  assert.equal(await captureRawSourceEffectCatalog({client:db.raw,transaction:tx,assertCurrent:current,revision:()=>revision}),null);
 });
});

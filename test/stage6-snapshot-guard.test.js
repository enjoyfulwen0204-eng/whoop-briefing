import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClient} from '@libsql/client';
import {snapshotGuards} from '../src/stage6SnapshotGuard.js';
import {exactRealStatement} from '../src/exactRealStatement.js';
import {hranaTransport} from './hranaTransport.js';

const quote=s=>'"'+s.replaceAll('"','""')+'"';
// Immutable original publication proof, used as the behavioral oracle.
const legacy=d=>[
 {sql:`SELECT json(CASE WHEN (SELECT count(*) FROM ${quote(d.table)} WHERE ${d.filter.where})=? THEN 'true' ELSE 'REJECTED' END)`,args:[...d.filter.args,d.rows.length]},
 ...d.rows.map(row=>({sql:`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM ${quote(d.table)} WHERE (${d.filter.where}) AND ${d.columns.map(c=>quote(c)+' IS ?').join(' AND ')}) THEN 'true' ELSE 'REJECTED' END)`,args:[...d.filter.args,...row]})),
];
const succeeds=async(c,stmts)=>{try{await c.batch(stmts.map(exactRealStatement),'write');return true;}catch{return false;}};
async function fixture(t,{http=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'stage6-snapshot-guard-')),url='file:'+join(dir,'fixture.db');
 const transport=http?hranaTransport(url):null,c=createClient(http?{url:'https://isolated.invalid',fetch:r=>transport.fetch(r)}:{url});
 t.after(async()=>{c.close();transport?.close();await rm(dir,{recursive:true,force:true});});
 // Deliberate alias-like names and a column named value exercise correlation.
 await c.execute('CREATE TABLE "__stage6_expected" (tenant TEXT,id INTEGER,value,other,PRIMARY KEY(tenant,id))');
 return {c,transport,descriptor:async()=>{
  const r=await c.execute("SELECT tenant,id,value,other FROM __stage6_expected WHERE tenant='a' ORDER BY id");
  return {table:'__stage6_expected',columns:r.columns,filter:{where:'tenant=? OR tenant=?',args:['a','also-a']},rows:r.rows.map(row=>r.columns.map(k=>row[k]))};
 }};
}
for(const http of [false,true])test(`snapshot proof retains typed rows and rejects content replacement (${http?'Hrana':'native'})`,async t=>{
 const {c,descriptor}=await fixture(t,{http});
 const values=[null,'',0,-0,Number.MAX_SAFE_INTEGER,Number.MIN_SAFE_INTEGER,'0','null','🧬\n\t"\\','a\tb',.9048374180359595,-1.8650518308093398e232,4.6106866700014776e210,-3.139504432940214e-149,Number.MIN_VALUE,Number.MAX_VALUE,2**53];
 await c.batch(values.map((v,i)=>exactRealStatement({sql:'INSERT INTO __stage6_expected VALUES(?,?,?,?)',args:['a',i,v,'original']})));
 await c.execute("INSERT INTO __stage6_expected VALUES('peer',999,'private','untouched')");
 const d=await descriptor();assert.equal(await succeeds(c,legacy(d)),true);assert.equal(await succeeds(c,snapshotGuards(d)),true);
 for(const [i,value] of [[0,'null'],[2,'0'],[6,0],[8,'different'],[9,'a\tc'],[10,.9048374180359596]]){
  await c.execute(exactRealStatement({sql:'UPDATE __stage6_expected SET value=? WHERE tenant=? AND id=?',args:[value,'a',i]}));
  assert.equal(await succeeds(c,legacy(d)),false,'legacy mutation '+i);assert.equal(await succeeds(c,snapshotGuards(d)),false,'packed mutation '+i);
  await c.execute(exactRealStatement({sql:'UPDATE __stage6_expected SET value=? WHERE tenant=? AND id=?',args:[d.rows[i][2],'a',i]}));
 }
 await c.execute("UPDATE __stage6_expected SET other='changed peer' WHERE tenant='peer'");assert.equal(await succeeds(c,snapshotGuards(d)),true);
 await c.execute("UPDATE __stage6_expected SET tenant='also-a' WHERE tenant='a' AND id=1");assert.equal(await succeeds(c,snapshotGuards(d)),false,'OR scope must not bypass full-column proof');
});
test('embedded NUL preserves both exact supplied values and the original driver-truncation rejection',async t=>{
 const {c,descriptor}=await fixture(t),value='a\u0000b';await c.execute({sql:'INSERT INTO __stage6_expected VALUES(?,?,?,?)',args:['a',1,value,null]});
 const captured=await descriptor(),exact={...captured,rows:[['a',1,value,null]]};
 assert.equal(await succeeds(c,legacy(exact)),true);assert.equal(await succeeds(c,snapshotGuards(exact)),true);
 assert.equal(captured.rows[0][2],'a','installed native result decoder truncates embedded NUL');
 assert.equal(await succeeds(c,legacy(captured)),false);assert.equal(await succeeds(c,snapshotGuards(captured)),false);
});
test('empty, insert, delete and same-count replacement preserve the original membership proof',async t=>{
 const {c,descriptor}=await fixture(t),empty=await descriptor();assert.equal(snapshotGuards(empty).length,1);assert.equal(await succeeds(c,snapshotGuards(empty)),true);
 await c.execute("INSERT INTO __stage6_expected VALUES('a',1,'one',NULL)");assert.equal(await succeeds(c,snapshotGuards(empty)),false);
 const d=await descriptor();await c.execute("DELETE FROM __stage6_expected WHERE tenant='a'");assert.equal(await succeeds(c,snapshotGuards(d)),false);
 await c.execute("INSERT INTO __stage6_expected VALUES('a',2,'one',NULL)");assert.equal(await succeeds(c,legacy(d)),false);assert.equal(await succeeds(c,snapshotGuards(d)),false);
});
test('REALs and ill-formed strings retain exact positional binds; unsupported JSON values fail closed',async t=>{
 const {c}=await fixture(t),d={table:'__stage6_expected',columns:['tenant','id','value','other'],filter:{where:'tenant=?',args:['a']},rows:[['a',1,'\ud800',null]]};
 await c.execute({sql:'INSERT INTO __stage6_expected VALUES(?,?,?,?)',args:d.rows[0]});assert.equal(await succeeds(c,legacy(d)),true);assert.equal(await succeeds(c,snapshotGuards(d)),true);assert.ok(!snapshotGuards(d).some(s=>s.sql.includes('json_each')));
 for(const value of [NaN,Infinity,-Infinity,undefined,1n,{},[]])assert.throws(()=>snapshotGuards({...d,rows:[['a',1,value,null]]}),/PREPARATION_SNAPSHOT_TYPE/);
});
test('packed chunks retain existing 1000-row and 2MiB escaped-text ceilings',()=>{
 const d={table:'t',columns:['id','value'],filter:{where:'1',args:[]},rows:Array.from({length:2001},(_,i)=>[i,'"\\'.repeat(1200)])},guards=snapshotGuards(d);
 const packed=guards.filter(s=>s.sql.includes('json_each'));assert.ok(packed.length>=3);
 assert.equal(packed.reduce((n,s)=>n+JSON.parse(s.args[0]).length,0),2001);
 for(const s of packed){assert.ok(JSON.parse(s.args[0]).length<=1000);assert.ok(Buffer.byteLength(JSON.stringify({type:'text',value:s.args[0]}))<=2*1024*1024);}
 const huge=snapshotGuards({...d,rows:[[1,'"'.repeat(600000)]]});assert.equal(huge.length,2);assert.equal(huge[1].sql.includes('json_each'),false,'oversized individual envelope retains original bindings');
});
test('late failing packed guard rolls back the entire real Hrana write transaction',async t=>{
 const {c,descriptor}=await fixture(t,{http:true});await c.execute("INSERT INTO __stage6_expected VALUES('a',1,'original',NULL)");const d=await descriptor();
 const stmts=[{sql:"UPDATE __stage6_expected SET other='must roll back' WHERE tenant='a'"},...snapshotGuards(d)];
 assert.equal(await succeeds(c,stmts),false);assert.equal((await c.execute("SELECT other FROM __stage6_expected WHERE tenant='a'")).rows[0].other,null);
});
test('representative integer/text snapshot prepares two statements instead of one per historical row',async t=>{
 const {c,descriptor}=await fixture(t);await c.batch(Array.from({length:1000},(_,i)=>({sql:'INSERT INTO __stage6_expected VALUES(?,?,?,?)',args:['a',i,'receipt-'+i,'sealed authority']})));
 const d=await descriptor(),old=legacy(d),current=snapshotGuards(d),start=performance.now();assert.equal(await succeeds(c,old),true);const oldMs=performance.now()-start,at=performance.now();assert.equal(await succeeds(c,current),true);const currentMs=performance.now()-at;
 assert.equal(old.length,1001);assert.equal(current.length,2);
 console.log('SYNTHETIC_SHADOW_SNAPSHOT_PREPARATION '+JSON.stringify({rows:1000,oldStatements:old.length,currentStatements:current.length,oldMs,currentMs,productionEvidence:false,linuxQualification:false}));
});

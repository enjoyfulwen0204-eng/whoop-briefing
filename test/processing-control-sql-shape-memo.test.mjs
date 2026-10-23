import test from 'node:test';
import assert from 'node:assert/strict';
import {inflightControlReadKey,ownershipControlReadKey,contextLeaseDataReadKey,CONTEXT_LEASE_DATA_SQL} from '../src/processingInflightControlReads.js';
const OWN=`SELECT state,lease_owner,lease_expires_at,requested_generation,
 claimed_generation,scope_revision,claimed_scope_revision,claimed_purge_generation,claimed_lifecycle_generation,
 claimed_auth_generation FROM phase4_jobs WHERE user_id=? AND execution_mode=? AND job_kind=?`;
const LOCK='SELECT 1 FROM resource_locks WHERE name=? AND owner=? AND expires_at=? AND expires_at>?';
const LEASE='SELECT owner FROM resource_locks WHERE name=? AND expires_at>?';
const name='p4ctx:'+'a'.repeat(64)+':12345678-1234-4123-8123-123456789abc';
const context=()=>({userId:'synthetic-shapes',executionMode:'LIVE',providerRequired:true});
const templates=c=>[
 {sql:OWN,args:[c.userId,'LIVE','RECOMPUTE_DERIVED']},
 {sql:LOCK,args:[`phase4-stage6-pass:${JSON.stringify([c.userId,'LIVE'])}`,'owner','expiry','clock']},
 {sql:LEASE,args:[name,'clock']},
 {sql:CONTEXT_LEASE_DATA_SQL,args:[name]},
];
test('all warmed static SQL shapes retain exact raw SQL and fresh argument keys',()=>{
 const c=context();for(const q of templates(c)){
  assert.equal(inflightControlReadKey(q,c),JSON.stringify([q.sql,q.args]));
  for(const sql of [' '+q.sql+'\n',q.sql.replaceAll(' ','\t')])assert.equal(inflightControlReadKey({...q,sql},c),JSON.stringify([sql,q.args]));
  for(const sql of [q.sql.toLowerCase(),q.sql+';',q.sql+' OR 1=1',q.sql+' -- comment'])assert.equal(inflightControlReadKey({...q,sql},c),null);
 }
});
test('SQL cache never retains tenant/mode/provider or argument eligibility',()=>{
 const c=context(),qs=templates(c);for(const q of qs)assert.ok(inflightControlReadKey(q,c));
 for(const q of qs){for(const changed of [{...c,executionMode:'SHADOW'},{...c,providerRequired:false}])assert.equal(inflightControlReadKey(q,changed),null);}
 qs[0].args[0]='other';assert.equal(inflightControlReadKey(qs[0],c),null);qs[0].args[0]=c.userId;qs[0].args[1]='SHADOW';assert.equal(inflightControlReadKey(qs[0],c),null);
 qs[1].args[0]='other';assert.equal(inflightControlReadKey(qs[1],c),null);
 for(const q of qs){q.args[0]=12;assert.equal(inflightControlReadKey(q,c),null);}
});
test('legacy and clock-free lease templates cannot share parameter arity or selectors',()=>{
 const c=context(),qs=templates(c);assert.ok(ownershipControlReadKey(qs[0],c));assert.ok(contextLeaseDataReadKey(qs[3],c));
 for(const q of qs.slice(1))assert.equal(ownershipControlReadKey(q,c),null);
 for(const q of qs.slice(0,3))assert.equal(contextLeaseDataReadKey(q,c),null);
 assert.equal(inflightControlReadKey({...qs[2],args:[name]},c),null);assert.equal(inflightControlReadKey({...qs[3],args:[name,'clock']},c),null);
 assert.notEqual(inflightControlReadKey(qs[2],c),inflightControlReadKey({...qs[2],args:[name,'new-clock']},c));
 for(const sql of [LEASE,CONTEXT_LEASE_DATA_SQL])assert.equal(inflightControlReadKey({sql,args:sql===LEASE?['invalid','clock']:['invalid']},c),null);
});
test('warm shape selection performs no repeated whitespace replacement',()=>{
 const c=context(),qs=templates(c).map(q=>({...q,sql:'\n\n'+q.sql+'\t\t'})),replace=String.prototype.replace;let calls=0;
 try{
  String.prototype.replace=function(...args){if(args[0]instanceof RegExp&&args[0].source==='\\s+')calls++;return Reflect.apply(replace,this,args);};
  for(const q of qs)inflightControlReadKey(q,c);assert.ok(calls>0);calls=0;
  for(let i=0;i<128;i++){
   for(const q of qs)assert.ok(inflightControlReadKey(q,c));
   assert.ok(ownershipControlReadKey(qs[0],c));assert.ok(contextLeaseDataReadKey(qs[3],c));
  }
  assert.equal(calls,0);
 }finally{String.prototype.replace=replace;}
});
test('bounded cache eviction preserves unsupported SQL rejection and original keys',()=>{
 const c=context();for(let i=1;i<=160;i++){
  const q={sql:' '.repeat(i)+OWN,args:[c.userId,'LIVE','RECOMPUTE_DERIVED']};assert.equal(inflightControlReadKey(q,c),JSON.stringify([q.sql,q.args]));
 }
 assert.equal(inflightControlReadKey({sql:OWN+' UNION SELECT 1',args:[c.userId,'LIVE','RECOMPUTE_DERIVED']},c),null);
 const q=templates(c)[0];assert.equal(ownershipControlReadKey(q,c),JSON.stringify([q.sql,q.args]));
});
test('oversized SQL/arguments retain original bounds outside the syntax cache',()=>{
 const c=context(),q=templates(c)[3];assert.equal(inflightControlReadKey({...q,sql:' '.repeat(9000)+q.sql},c),null);
 assert.equal(inflightControlReadKey({...q,args:['a'.repeat(4097)]},c),null);
 const own=templates(c)[0];assert.equal(inflightControlReadKey({...own,args:[c.userId,'LIVE','x'.repeat(4097)]},c),null);
});

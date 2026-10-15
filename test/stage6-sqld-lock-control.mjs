import test from 'node:test';import assert from 'node:assert/strict';import {createClient} from '@libsql/client';
// Dedicated empty upstream server on an internal Docker network. No app rows.
const connect=()=>createClient({url:'http://sqld-control:8080',fetch:async(r,i)=>{const u=new URL(typeof r==='string'?r:r.url);assert.equal(u.hostname,'sqld-control');await new Promise(resolve=>setTimeout(resolve,115));return fetch(r,i);}});
test('upstream sqld waits for write owner and characterizes five-second idle behavior',async()=>{
 const left=connect(),right=connect(),reader=connect();let owner,contender,expired;
 try{
  owner=await left.transaction('write');await owner.execute('SELECT 1');contender=await right.transaction('write');
  const submittedAt=performance.now(),pending=contender.execute('SELECT 2');let resolved=false;pending.then(()=>{resolved=true;});
  assert.equal((await reader.execute('SELECT 3')).rows[0][0],3);await new Promise(r=>setTimeout(r,150));assert.equal(resolved,false);
  await owner.commit();await pending;const waitMs=performance.now()-submittedAt;await contender.commit();
  expired=await left.transaction('write');await expired.execute('SELECT 4');const expiryAt=performance.now();await new Promise(r=>setTimeout(r,5100));
  let code,value;try{value=(await expired.execute('SELECT 5')).rows[0][0];}catch(e){code=e.code;}
  if(code)assert.ok(['TRANSACTION_TIMEOUT','TRANSACTION_CLOSED','SQLITE_TXN_TIMEOUT'].includes(code),String(code));else assert.equal(value,5);
  await expired.rollback().catch(e=>{if(!code)throw e;});
  console.log('UPSTREAM_SQLD_LOCK_CONTROL '+JSON.stringify({representativeLatencyMs:115,waitMs,readerResponsive:true,ownerSettled:true,expiryObservedAfterMs:performance.now()-expiryAt,expiryCode:code??null,stillActiveAfterIdle:value===5,absoluteFiveSecondLimitObserved:Boolean(code),applicationWrites:0,proxyRetries:0}));
 }finally{owner?.close();contender?.close();expired?.close();left.close();right.close();reader.close();}
});

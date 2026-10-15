import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@libsql/client';

// A failed SELECT-only guard uses no application rows or test permits.
test('pinned upstream classifies a rejected JSON assertion and keeps the client usable',async()=>{
 const client=createClient({url:'http://sqld-control:8080'});
 const at=performance.now();let error;
 try{
  await client.batch(["SELECT json(CASE WHEN 0 THEN 'true' ELSE 'SYNTHETIC_AUTHORITY_REJECTED' END)", 'SELECT 42'], 'write');
 }catch(e){error=e;}
 try{
  assert.ok(error);assert.equal(error.code,'SQLITE_UNKNOWN');
  assert.match(error.message,/malformed JSON/i);
  assert.equal((await client.execute('SELECT 43')).rows[0][0],43);
  console.log('UPSTREAM_ASSERTION_CONTROL '+JSON.stringify({code:error.code,reason:'JSON_ASSERTION_REJECTED',elapsedMs:performance.now()-at,applicationWrites:0,clientUsableAfterError:true,rollbackIndependentlyProven:false}));
 }finally{client.close();}
});

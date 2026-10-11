import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDb} from '../src/db.js';
import {readOnlyProcessingCheck} from '../src/processingTransaction.js';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';
import {hranaTransport} from './hranaTransport.js';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'read-checks-')),url=`file:${join(dir,'db.sqlite')}`,seed=createOwnedDb({url});
 await seed.migrate({targetVersion:32});await seed.close();
 const transport=hranaTransport(url),db=createDb({url:'https://isolated.invalid',phase4Keys:fixtureKeys,fetch:transport.fetch});
 t.after(async()=>{db.close();transport.close();await rm(dir,{recursive:true,force:true});});await db.admitRuntime();return {db,transport};
}
test('original independent read checks share real HTTP pipelines while running before callback and every COMMIT',async t=>{
 const {db,transport}=await fixture(t),run=async coalesced=>{
  let checks=0,callback=false;
  const make=value=>{const check=async client=>{if(!client)return;checks++;assert.equal((await client.execute(`SELECT ${value} value`)).rows[0].value,value);};return coalesced?readOnlyProcessingCheck(check):check;};
  const before=transport.counts.httpRequests;
  await db.withRuntimeFence(make(111),()=>db.withRuntimeFence(make(222),()=>db.transaction(async()=>{
   assert.equal(checks,2);callback=true;await db.raw.execute('SELECT 333 value');
  })));
  assert.equal(callback,true);assert.equal(checks,4);return transport.counts.httpRequests-before;
 };
 const serial=await run(false),coalesced=await run(true);
 assert.equal(serial-coalesced,2);console.log('READ_CHECK_HTTP_MEASUREMENT '+JSON.stringify({serial,coalesced,originalChecks:4}));
});
test('a declared read-only check cannot issue a mutation or enter the business callback',async t=>{
 const {db}=await fixture(t);let callback=false;
 const check=readOnlyProcessingCheck(async client=>{if(client)await client.execute("INSERT INTO telegram_state VALUES('forbidden','value','2026-10-11')");});
 await assert.rejects(()=>db.withRuntimeFence(check,()=>db.transaction(async()=>{callback=true;})),/PROCESSING_READ_ONLY_CHECK_REQUIRED/);
 assert.equal(callback,false);assert.equal((await db.raw.execute("SELECT COUNT(*) n FROM telegram_state WHERE key='forbidden'")).rows[0].n,0);
});
test('all independent read checks settle before a rejected group rolls back',async t=>{
 const {db}=await fixture(t);let settled=false,callback=false;
 const failed=readOnlyProcessingCheck(async client=>{if(client)await client.execute('SELECT * FROM deliberately_absent_table');});
 const sibling=readOnlyProcessingCheck(async client=>{if(!client)return;await client.execute('SELECT 222');await new Promise(resolve=>setTimeout(resolve,20));settled=true;});
 await assert.rejects(()=>db.withRuntimeFence(failed,()=>db.withRuntimeFence(sibling,()=>db.transaction(async()=>{callback=true;}))));
 assert.equal(settled,true);assert.equal(callback,false);await db.transaction(()=>db.raw.execute('SELECT 444'));
});

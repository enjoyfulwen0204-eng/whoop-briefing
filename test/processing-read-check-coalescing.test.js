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
 await seed.migrate({targetVersion:34});await seed.close();
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

// Actual installed HTTP-driver nested boundary, preserving all original checks.
test('nested marked before uses checked readonly transport and every original after fence',async t=>{
 const {db,transport}=await fixture(t);
 const run=async marked=>{
  let ownerChecks=0,beforeChecks=0,afterChecks=0;
  const owner=readOnlyProcessingCheck(async client=>{ownerChecks++;await (client??db.raw).execute('SELECT 1 owner');});
  const before=async client=>{beforeChecks++;await client.execute('SELECT 2 context');};
  const after=readOnlyProcessingCheck(async client=>{afterChecks++;await client.execute('SELECT 3 current');});
  const at=transport.counts.httpRequests;
  await db.withRuntimeFence(owner,()=>db.transaction(()=>db.transaction(()=>db.raw.execute('SELECT 4 business'),{before:marked?readOnlyProcessingCheck(before):before,after})));
  assert.equal(beforeChecks,1);assert.equal(afterChecks,1);
  return {http:transport.counts.httpRequests-at,ownerChecks};
 };
 const serial=await run(false),marked=await run(true);
 assert.equal(serial.http-marked.http,1);assert.equal(serial.ownerChecks-marked.ownerChecks,1);
});
test('nested marked before refuses mutation before callback while unmarked before still writes',async t=>{
 const {db}=await fixture(t);let callback=false;
 const write=client=>client.execute("INSERT INTO telegram_state VALUES('nested-owner','safe','2026-10-11')");
 await assert.rejects(()=>db.transaction(()=>db.transaction(()=>{callback=true;},{before:readOnlyProcessingCheck(write)})),/PROCESSING_READ_ONLY_CHECK_REQUIRED/);
 assert.equal(callback,false);assert.equal((await db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key='nested-owner'")).rows[0].n,0);
 await db.transaction(()=>db.transaction(()=>{callback=true;},{before:client=>write(client)}));assert.equal(callback,true);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key='nested-owner'")).rows[0].n,1);
});
test('a nested marked guard observes fresh metadata and rejected before rolls back prior work',async t=>{
 const {db}=await fixture(t);let callback=false,checks=0;
 await assert.rejects(()=>db.transaction(async()=>{
  await db.raw.execute("INSERT INTO telegram_state VALUES('current-owner','revoked','2026-10-11')");
  await db.transaction(()=>{callback=true;},{before:readOnlyProcessingCheck(async client=>{
   checks++;const row=(await client.execute("SELECT value FROM telegram_state WHERE key='current-owner'")).rows[0];
   if(row?.value==='revoked')throw Error('CURRENT_AUTHORITY_REJECTED');
  })});
 }),/CURRENT_AUTHORITY_REJECTED/);
 assert.equal(checks,1);assert.equal(callback,false);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM telegram_state WHERE key='current-owner'")).rows[0].n,0);
});

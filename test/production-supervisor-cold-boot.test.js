/** Native local SQLite, fixed synthetic metadata/history only. No listener,
 * provider credentials, provider requests, health values or public edits. */
import test from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtemp,realpath,copyFile,chmod,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createClient as nativeCreateClient} from '@libsql/client';
const root=new URL('../',import.meta.url),bootUrl=new URL('src/productionEpochBootstrap.js',root).href,entryUrl=new URL('src/bot/webhook-entry.js',root).href;
let current;
registerHooks({resolve(specifier,context,next){if(specifier==='@libsql/client'&&context.parentURL===bootUrl)return {url:'data:text/javascript,'+encodeURIComponent('export const createClient=o=>globalThis.__coldBootTestNative(o);'),shortCircuit:true};return next(specifier,context);}});
globalThis.__coldBootTestNative=options=>{
 assert.ok(current);assert.equal(options.url,'libsql://whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io');assert.equal(options.authToken,'SYNTHETIC');assert.equal(options.intMode,'number');assert.equal(typeof options.fetch,'function');
 const state=current,c=nativeCreateClient({url:'file:'+state.path,intMode:'number'});state.clients.push(c);
 return {async transaction(mode){state.transactions.push(mode);assert.equal(mode,'read');const tx=await c.transaction(mode);return {execute:q=>tx.execute(q),commit:()=>tx.commit(),rollback:()=>tx.rollback(),close:()=>tx.close()};},async batch(packet,mode){state.packets.push(packet);assert.equal(mode,'write');assert.equal(packet.length,6);await state.beforeBatch?.(c,packet);const result=await c.batch(packet,mode);await state.afterBatch?.(c,packet);return result;},close(){c.close();}};
};
const {runMigrations}=await import(new URL('src/migrations.js',root)),{phase4AuthorityKeys}=await import(new URL('src/phase4EnvironmentKeys.js',root)),{runningReleaseSha}=await import(new URL('src/phase4Release.js',root));
const {advanceProductionSupervisorBoot}=await import(bootUrl),{PRODUCTION_SUPERVISOR_BOOT_KEY:BOOT}=await import(new URL('src/productionEpochManifest.js',root)),{webhookEntryFatalCode}=await import(entryUrl);
const SHA=runningReleaseSha({}),env={TURSO_DATABASE_URL:'libsql://whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io',TURSO_AUTH_TOKEN:'SYNTHETIC',PHASE4_LOOKUP_KEY:'47'.repeat(32),PHASE4_AUDIT_KEY:'53'.repeat(32),PHASE4_RELEASE_SHA:SHA,RENDER_GIT_COMMIT:SHA,PHASE4_EXECUTION_PROFILE:'STAGE8_SCHEMA_TRANSITION'},keys=phase4AuthorityKeys(env);
let dir,seed,network=0;const originalFetch=globalThis.fetch;
test.before(async()=>{globalThis.fetch=()=>{network++;throw Error('REAL_NETWORK_FORBIDDEN');};dir=await realpath(await mkdtemp(join(tmpdir(),'cold-boot-native-test-')));await chmod(dir,0o700);seed=join(dir,'seed.sqlite');const c=nativeCreateClient({url:'file:'+seed,intMode:'number'});try{await runMigrations(c,{allowRebuild:false,targetVersion:33,privacyKeys:keys});await c.execute({sql:'INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?)',args:['SYNTHETIC_EXISTING_MONITORING_HISTORY','SYNTHETIC attempts=4 unchanged','2026-10-11T07:07:02.633Z']});
 const request={phase:'SYNC',releaseSha:'ca4bff7b711737527ca6c4e306d4a3ef555c9f3b',triggerSource:'manual',requestId:'SYNTHETIC_ORIGINAL_PENDING',executionMode:'OFF',configProof:'c'.repeat(64)};
 await c.execute({sql:"INSERT INTO phase4_executions(execution_id,identity_digest,scope_key,canonical_request_json,phase,release_sha,execution_mode,trigger_source,config_proof,owner,generation,lease_until,deadline_at,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'OFF','manual',?,'SYNTHETIC-OWNER',1,9999999999999,9999999999999,'ESTABLISHED',1,1)",args:[request.requestId,'a'.repeat(64),'b'.repeat(64),JSON.stringify(request),'SYNC',request.releaseSha,request.configProof]});
 await c.execute({sql:'INSERT INTO phase4_execution_work_receipts(execution_id,receipt_key,scope_key,request_digest,step_key,generation,committed_at,result_json) VALUES(?,?,?,?,?,1,1,NULL)',args:[request.requestId,'d'.repeat(64),'b'.repeat(64),'a'.repeat(64),'e'.repeat(64)]});await c.execute("UPDATE phase4_executions SET lease_until=1,deadline_at=1 WHERE execution_id='SYNTHETIC_ORIGINAL_PENDING'");}finally{c.close();}await chmod(seed,0o600);});
test.after(async()=>{globalThis.fetch=originalFetch;assert.equal(network,0);delete globalThis.__coldBootTestNative;await rm(dir,{recursive:true,force:true});});
async function fixture(t){const path=join(dir,'case-'+Math.random().toString(16).slice(2)+'.sqlite');await copyFile(seed,path);await chmod(path,0o600);const c=nativeCreateClient({url:'file:'+path,intMode:'number'}),f={path,c,clients:[],packets:[],transactions:[]};current=f;t.after(()=>{c.close();for(const x of f.clients)try{x.close();}catch{}});return f;}
const rows=async(c,sql,args=[])=> (await c.execute({sql,args})).rows.map(r=>({...r}));
const readBoot=async c=>{const r=(await rows(c,'SELECT key,value,updated_at FROM telegram_state WHERE key=?',[BOOT]))[0];return r?{...r,wire:JSON.parse(r.value)}:null;};
const oldControls=async c=>({state:await rows(c,'SELECT key,value,updated_at FROM telegram_state WHERE key<>? ORDER BY key',[BOOT]),executions:await rows(c,'SELECT * FROM phase4_executions ORDER BY execution_id'),receipts:await rows(c,'SELECT * FROM phase4_execution_work_receipts ORDER BY receipt_key'),versions:await rows(c,'SELECT * FROM schema_version ORDER BY version'),checkpoints:await rows(c,'SELECT * FROM phase4_migration_checkpoints ORDER BY target_version,step_key')});
test('one native batch creates authentic BOOT, readback precedes opaque capability; original history remains',async t=>{
 const f=await fixture(t),base=await oldControls(f.c);assert.equal(base.executions.length,1);assert.equal(base.receipts.length,1);const r=await advanceProductionSupervisorBoot({environment:env}),b=await readBoot(f.c);assert.deepEqual(Object.keys(r),['contract','productionAuthority']);assert.ok(Object.isFrozen(r));assert.equal(b.wire.body.generation,1);assert.equal(b.wire.body.releaseSha,SHA);assert.equal(b.wire.signature,keys.digest(keys.lookup(['production-supervisor-monotonic-boot-v1']),['production-supervisor-monotonic-boot-v1',b.wire.body]));assert.equal(b.wire.digest,keys.lookup(['production-supervisor-monotonic-boot-v1',b.wire.body,b.wire.signature]));assert.deepEqual(await oldControls(f.c),base);assert.deepEqual(f.transactions,['read','read']);assert.equal(f.packets.length,1);assert.ok(f.packets[0][1].sql.includes('rootpage'));assert.ok(f.packets[0][1].sql.includes('ELSE NULL'));
});
test('next startup genuinely increments generation and preserves previous authority/history',async t=>{
 const f=await fixture(t);await advanceProductionSupervisorBoot({environment:env});const a=await readBoot(f.c);await advanceProductionSupervisorBoot({environment:env});const b=await readBoot(f.c);assert.equal(b.wire.body.generation,a.wire.body.generation+1);assert.notEqual(b.wire.body.nonce,a.wire.body.nonce);assert.equal(f.packets.length,2);assert.equal(f.packets[1][2].sql,'UPDATE telegram_state SET value=?,updated_at=? WHERE key=? AND value=? AND updated_at=?');
});
for(const [name,mutate]of [
 ['catalog',c=>c.execute('CREATE INDEX SYNTHETIC_SCHEMA_DRIFT ON telegram_state(updated_at)')],
 ['versions',c=>c.execute("UPDATE schema_version SET applied_at='SYNTHETIC-CHANGED' WHERE version=33")],
 ['checkpoints',c=>c.execute("UPDATE phase4_migration_checkpoints SET updated_at='SYNTHETIC-CHANGED' WHERE target_version=22 AND step_key='audit_key_check'")],
 ['operator',c=>c.execute("INSERT INTO telegram_state VALUES('canonical-profile-revision:v1:operator:SYNTHETIC','SYNTHETIC','SYNTHETIC')")],
])test('batch rejects intervening '+name+' drift before any BOOT change',async t=>{const f=await fixture(t);f.beforeBatch=mutate;await assert.rejects(advanceProductionSupervisorBoot({environment:env}));assert.equal(await readBoot(f.c),null);assert.equal(f.packets.length,1);});
for(const pragma of ['ignore_check_constraints','foreign_keys'])test('native NOTNULL guard rejects '+pragma+' drift even with ignored CHECKs',async t=>{
 const f=await fixture(t);f.beforeBatch=c=>c.execute('PRAGMA '+pragma+'='+(pragma==='foreign_keys'?0:1));await assert.rejects(advanceProductionSupervisorBoot({environment:env}));assert.equal(await readBoot(f.c),null);
});
test('server clock rejects stale local15s lease without a BOOT mutation',async t=>{
 const f=await fixture(t),original=Date.now;Date.now=()=>original()-20000;try{await assert.rejects(advanceProductionSupervisorBoot({environment:env}));assert.equal(await readBoot(f.c),null);assert.equal(f.packets.length,1);}finally{Date.now=original;}
});
test('lost ACK after real commit issues no capability; next startup rotates actual durable generation',async t=>{
 const f=await fixture(t);f.afterBatch=()=>{throw Object.assign(Error('SYNTHETIC_LOST_ACK'),{code:'COMMIT_INDETERMINATE'});};await assert.rejects(advanceProductionSupervisorBoot({environment:env}),{code:'COMMIT_INDETERMINATE'});assert.equal((await readBoot(f.c)).wire.body.generation,1);f.afterBatch=null;const recovered=await advanceProductionSupervisorBoot({environment:env});assert.ok(Object.isFrozen(recovered));assert.equal((await readBoot(f.c)).wire.body.generation,2);
});
test('confirmed ACK followed by a concurrent genuine rotation cannot issue stale captured BOOT',async t=>{
 const f=await fixture(t);let concurrent;f.afterBatch=async()=>{f.afterBatch=null;concurrent=await advanceProductionSupervisorBoot({environment:env});};await assert.rejects(advanceProductionSupervisorBoot({environment:env}),{code:'PRODUCTION_BOOT_EXACT_READBACK_REQUIRED'});assert.ok(Object.isFrozen(concurrent));assert.equal((await readBoot(f.c)).wire.body.generation,2);
});
test('concurrent genuine first rotation defeats the stale absent-BOOT CAS without overwriting it',async t=>{
 const f=await fixture(t);let winner;f.beforeBatch=async()=>{f.beforeBatch=null;winner=await advanceProductionSupervisorBoot({environment:env});};await assert.rejects(advanceProductionSupervisorBoot({environment:env}));assert.ok(Object.isFrozen(winner));assert.equal((await readBoot(f.c)).wire.body.generation,1);assert.equal(f.packets.length,2);
});
test('corrupt BOOT or wrong key checkpoint rejects before batch rather than healing/resetting',async t=>{
 const f=await fixture(t);await f.c.execute({sql:'INSERT INTO telegram_state VALUES(?,?,?)',args:[BOOT,'SYNTHETIC-CORRUPT','SYNTHETIC']});await assert.rejects(advanceProductionSupervisorBoot({environment:env}),{code:'PRODUCTION_EPOCH_AUTHENTIC_BOOT_ROW_REQUIRED'});assert.equal(f.packets.length,0);await f.c.execute({sql:'DELETE FROM telegram_state WHERE key=?',args:[BOOT]});await f.c.execute("UPDATE phase4_migration_checkpoints SET last_cursor='SYNTHETIC-WRONG' WHERE target_version=22 AND step_key='audit_key_check'");await assert.rejects(advanceProductionSupervisorBoot({environment:env}),{code:'PRODUCTION_EPOCH_ACTUAL_KEY_AUTHORITY_REQUIRED'});assert.equal(f.packets.length,0);
});
test('safe startup fatal enum logging includes owned startup codes and redacts unknown errors',()=>{
 for(const code of ['SUPERVISOR_FIXED_DATABASE_REQUIRED','PRODUCTION_EPOCH_CONSTRAINTS_REQUIRED','SCHEMA_TRANSITION_PROFILE_REQUIRED','STAGE8_CLEAN_RELEASE_REQUIRED','EPOCH_CLIENT_REVOKED','RELEASE_CHECKOUT_MISMATCH','WHOOP_BRIDGE_BAD_SIGNATURE','PHASE4_PRIVACY_KEY_MISMATCH','SQLITE_BUSY','SQLITE_CONSTRAINT_NOTNULL','TRANSACTION_TIMEOUT'])assert.equal(webhookEntryFatalCode({code,message:'SYNTHETIC SECRET'}),code);
 for(const error of [new Error('SYNTHETIC SECRET'),{code:'UNKNOWN_SECRET',message:'SYNTHETIC SECRET'},{code:'SUPERVISOR_bad raw value'},{code:'SQLITE_OTHER_SENSITIVE_UNKNOWN',message:'SYNTHETIC SECRET'},{code:{toString(){throw Error('SYNTHETIC SECRET');}}},{get code(){throw Error('SYNTHETIC SECRET');}},null])assert.equal(webhookEntryFatalCode(error),'WEBHOOK_ENTRY_START_FAILED');
});

import {mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import * as libsql from '@libsql/client';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';

const mode=process.argv[2],directory=await mkdtemp('/private/tmp/stage8-bounded-main-');await chmod(directory,0o700);
const host='whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io',SHA='a'.repeat(40),SOURCE='b'.repeat(40),sourcePath=join(directory,'source.sqlite');
const controller=new AbortController(),base=Date.now(),deadlineAt=base+60000;let at=base,db,source,controls=0,boundaries=0,writeBatches=0,diagnosticClients=0,diagnosticReads=0;
mock.method(Date,'now',()=>at);
const context=Object.freeze({kind:'BOUNDED_WINDOW_CONTEXT_V1',phase:'MIGRATE_35',deadlineAt,assertBeforeMutation:async()=>undefined,
 async dispatchMutation({prepare,dispatch}){
  const prepared=await prepare();boundaries++;if(boundaries===2&&mode==='deadline-in-final-guard')at=deadlineAt;
  const result=await dispatch({prepared,deadlineAt,remainingMs:Math.max(1,deadlineAt-at),signal:controller.signal});
  if(at>=deadlineAt)throw Error('SYNTHETIC_JOURNAL_DEADLINE');return result;
 }});
mock.module('@libsql/client',{namedExports:{...libsql,createClient:options=>{
 if(options.url.startsWith('file:'))return libsql.createClient(options);
 assert.equal(options.url,'libsql://'+host);assert.equal(options.authToken,'synthetic-only');
 if(at>=deadlineAt||controller.signal.aborted)diagnosticClients++;
 const local=libsql.createClient({url:'file:'+sourcePath,intMode:'number'}),execute=local.execute.bind(local),batch=local.batch.bind(local);
 const read=s=>{const sql=typeof s==='string'?s:s.sql;assert.match(sql.trim(),/^(SELECT|PRAGMA)\b/i);if(at>=deadlineAt||controller.signal.aborted)diagnosticReads++;};
 local.execute=s=>{read(s);return execute(s);};local.batch=(s,m)=>{assert.equal(m,'read');s.forEach(read);return batch(s,m);};return local;
}}});
const safety=await import('../scripts/stage8-migration-safety.mjs'),control=await import('../scripts/stage8-production-control.mjs');
mock.module('../scripts/stage8-migration-safety.mjs',{namedExports:{...safety,assertCleanStage8Release:()=>SHA}});
mock.module('../scripts/stage8-production-control.mjs',{namedExports:{...control,productionControl:()=>({authorize:async()=>({}),close(){}}),requireProductionControl:async()=>{
 controls++;if(controls===4&&mode==='deadline-in-last-read')at=deadlineAt;
 return {client:db.raw,keys:fixtureKeys,releaseSha:SHA,sourceSha:SOURCE,environment:{TURSO_AUTH_TOKEN:'synthetic-only',TURSO_DATABASE_URL:'libsql://'+host},database:source,current:await control.readDatabaseControl(db.raw,fixtureKeys)};
}}});
const {main}=await import('../scripts/stage8-production-migrate.mjs');
try{
 db=createOwnedDb({url:'file:'+sourcePath});await db.migrate({targetVersion:33});await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 source=await control.readDatabaseControl(db.raw,fixtureKeys);
 const sql=execFileSync('/usr/bin/sqlite3',['-safe','-init','/dev/null',sourcePath,'.dump']);
 globalThis.fetch=async(url,options)=>{assert.equal(url,'https://'+host+'/dump');assert.equal(options.signal instanceof AbortSignal,true);assert.equal(options.redirect,'error');return new Response(sql,{status:200});};
 for(const [name,bytes] of [['inventory','{}'],['observation','{}'],['key',Buffer.alloc(32,19)]])await writeFile(join(directory,name),bytes,{mode:0o600});
 const batch=db.raw.batch.bind(db.raw);db.raw.batch=async(statements,transactionMode)=>{
  if(transactionMode==='write'&&statements.some(s=>s.sql?.startsWith('INSERT INTO schema_version'))){
   writeBatches++;assert.equal(boundaries,2);assert.equal(controls,4);
   if(mode!=='late-before-commit')await batch(statements,transactionMode);
   if(mode.startsWith('late-')||mode==='abort-after-commit'){if(mode.startsWith('late-'))at=deadlineAt;controller.abort(Error('SYNTHETIC_ORIGINAL_DEADLINE'));if(mode==='late-before-commit')throw Error('SYNTHETIC_LOST_BEFORE_COMMIT');}
   return [];
  }
  return batch(statements,transactionMode);
 };
 const run=()=>main(['--apply','--expected-commit',SHA,'--source-commit',SOURCE,'--inventory-file',join(directory,'inventory'),'--observation-file',join(directory,'observation'),
  '--backup-file',join(directory,'source.enc'),'--key-file',join(directory,'key'),'--from-version','33','--target-version','35','--confirm-production','whoop-briefing'],{},context);
 if(mode==='success'){const result=await run();assert.equal(result.schema,35);assert.equal(result.trafficReopened,false);assert.equal(writeBatches,1);}
 else if(mode.startsWith('late-')||mode==='abort-after-commit'){
  let failure;try{await run();}catch(error){failure=error;}
  const committed=mode!=='late-before-commit';assert.equal(failure?.code,committed?`STAGE8_ATOMIC_${mode==='abort-after-commit'?'ABORTED':'LATE'}_PREPARED35_VERIFIED_KEEP_CLOSED`:'STAGE8_ATOMIC_LATE_COMMIT_UNCERTAIN');
  assert.equal(failure.readOnlyReconciliation.status,committed?'PREPARED35_VERIFIED':'SOURCE33_OBSERVED_COMMIT_UNCERTAIN');
  assert.equal(failure.readOnlyReconciliation.commitVerified,committed);assert.equal(failure.readOnlyReconciliation.originalDeadlineAt,deadlineAt);assert.equal(failure.readOnlyReconciliation.late,mode!=='abort-after-commit');assert.equal(failure.readOnlyReconciliation.normalSuccess,false);assert.equal(failure.trafficReopened,false);
  assert.equal(writeBatches,1);assert.equal(diagnosticClients,1);assert.ok(diagnosticReads>0);
 }else{await assert.rejects(run,/MAINTENANCE_DEADLINE_REACHED/);assert.equal(writeBatches,0);assert.equal((await db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v,33);}
 console.log(JSON.stringify({status:'PASS',mode,writeBatches,boundaries,diagnosticClients,diagnosticReads}));
}finally{await db?.close();await rm(directory,{recursive:true,force:true});}

import {mock} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile,unlink,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createOwnedDb} from './stage5OwnedDb.js';
import {fixtureKeys} from './localDb.js';

// Synthetic local fixture only: actual operator, dump authentication, backup,
// fsync, sealed target, and SQLite write batch; no real provider is contacted.
const [directory,mode]=process.argv.slice(2),SHA='a'.repeat(40),SOURCE='b'.repeat(40),path=join(directory,'source.sqlite'),backupPath=join(directory,'source.enc'),keyPath=join(directory,'key');
const safety=await import('../scripts/stage8-migration-safety.mjs'),control=await import('../scripts/stage8-production-control.mjs');
let db,source,controls=0,writeBatches=0,manifestSynced=false;
mock.module('../scripts/stage8-migration-safety.mjs',{namedExports:{...safety,assertCleanStage8Release:()=>SHA,
 stage8DurableExclusiveImage:async(...args)=>{await safety.stage8DurableExclusiveImage(...args);if(args[0]===backupPath+'.atomic-precommit.json')manifestSynced=true;}}});
mock.module('../scripts/stage8-production-control.mjs',{namedExports:{...control,productionControl:()=>({authorize:async()=>({}),close(){}}),requireProductionControl:async()=>{
 controls++;
 if(controls===4&&mode==='missing')await unlink(backupPath+'.atomic-precommit.json');
 if(controls===4&&mode==='forged'){
  const file=backupPath+'.atomic-precommit.json',value=JSON.parse(await readFile(file,'utf8'));value.planEvidence.targetDigest='f'.repeat(64);await writeFile(file,JSON.stringify(value)+'\n');
 }
 return {client:db.raw,keys:fixtureKeys,releaseSha:SHA,sourceSha:SOURCE,environment:{TURSO_AUTH_TOKEN:'synthetic-only',TURSO_DATABASE_URL:'file:'+path},database:source,current:await control.readDatabaseControl(db.raw,fixtureKeys)};
}}});
const {main}=await import('../scripts/stage8-production-migrate.mjs'),{authenticateStage8AtomicRecovery}=await import('../scripts/stage8-atomic-recovery.mjs');
try{
 db=createOwnedDb({url:'file:'+path});await db.migrate({targetVersion:33});await db.createUser({id:'a',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 source=await control.readDatabaseControl(db.raw,fixtureKeys);
 const sql=execFileSync('python3',['-c','import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(chr(10).join(c.iterdump()))',path]);
 globalThis.fetch=async(url,options)=>{assert.equal(url,'https://'+control.PRODUCTION_CONTROL.host+'/dump');assert.equal(options.method,undefined);return new Response(sql,{status:200});};
 for(const [file,bytes] of [[join(directory,'inventory'),'{}'],[join(directory,'observation'),'{}'],[keyPath,Buffer.alloc(32,19)]])await writeFile(file,bytes,{mode:0o600});
 const batch=db.raw.batch.bind(db.raw);db.raw.batch=async(statements,transactionMode)=>{
  if(transactionMode==='write'&&statements.some(statement=>statement.sql?.startsWith('INSERT INTO schema_version'))){
   writeBatches++;assert.equal(manifestSynced,true,'the real exclusive manifest publication finished file and directory fsync before DDL');
   const authenticated=await authenticateStage8AtomicRecovery({manifestPath:backupPath+'.atomic-precommit.json',keyPath,keys:fixtureKeys,releaseSha:SHA,sourceSha:SOURCE});
   assert.equal(authenticated.manifest.planEvidence.sourceDigest,source.digest);assert.equal((await stat(backupPath+'.atomic-precommit.json')).mode&0o777,0o600);
   await batch(statements,transactionMode);
   assert.equal((await db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v,35);
   // A real process exit discards the private plan before main reconciles or
   // reaches its successful final response. No prepared plaintext is needed.
   if(mode==='commit-crash')process.exit(77);
   throw Error('UNEXPECTED_WRITE_MODE');
  }
  return batch(statements,transactionMode);
 };
 const run=()=>main(['--apply','--expected-commit',SHA,'--source-commit',SOURCE,'--inventory-file',join(directory,'inventory'),'--observation-file',join(directory,'observation'),
  '--backup-file',backupPath,'--key-file',keyPath,'--from-version','33','--target-version','35','--confirm-production','whoop-briefing'],{});
 await assert.rejects(run,mode==='forged'?/MANIFEST_AUTHENTICATION_FAILED/:/ENOENT/);
 assert.equal(writeBatches,0);assert.equal((await db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v,33);
 console.log(JSON.stringify({status:'PRECOMMIT_EVIDENCE_FAILURE_BLOCKED_DDL',mode,writeBatches}));
}finally{await db?.close();}

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixtureKeys} from './localDb.js';
import {createPhase4Keys} from '../src/phase4Keys.js';
import {authenticateStage8AtomicRecovery,verifyStage8AtomicRecovery} from '../scripts/stage8-atomic-recovery.mjs';

const SHA='a'.repeat(40),SOURCE='b'.repeat(40),repository=new URL('../',import.meta.url);
const child=(file,directory,...args)=>spawnSync(process.execPath,['--experimental-test-module-mocks',file,directory,...args],{cwd:repository,encoding:'utf8',env:Object.fromEntries(Object.entries(process.env).filter(([name])=>name!=='NODE_TEST_CONTEXT')),timeout:60000});
const resultJson=result=>JSON.parse(result.stdout.trim().split('\n').at(-1));
test('durable precommit evidence survives actual postcommit process death; missing and forged manifests block DDL',async t=>{
 let network=0;t.mock.method(globalThis,'fetch',()=>{network++;throw Error('REAL_NETWORK_FORBIDDEN');});
 for(const mode of ['commit-crash','missing','forged'])await t.test(mode,async()=>{
  const directory=await mkdtemp('/private/tmp/stage8-crash-recovery-');await chmod(directory,0o700);t.after(()=>rm(directory,{recursive:true,force:true}));
  const operator=spawnSync(process.execPath,['--experimental-test-module-mocks','test/stage8AtomicCrashChild.mjs',directory,mode],{cwd:repository,encoding:'utf8',env:Object.fromEntries(Object.entries(process.env).filter(([name])=>name!=='NODE_TEST_CONTEXT')),timeout:60000});
  assert.equal(operator.status,mode==='commit-crash'?77:0,operator.stdout+operator.stderr);
  if(mode!=='commit-crash'){assert.equal(resultJson(operator).writeBatches,0);return;}
  // Discard every disposable plaintext target. The next process has no opaque
  // plan object, prepared file, or ability to regenerate marker timestamps.
  for(const name of await readdir(directory))if(name.startsWith('restore-'))await rm(join(directory,name),{recursive:true,force:true});
  const fresh=child('test/stage8AtomicRecoveryReadChild.mjs',directory);assert.equal(fresh.status,0,fresh.stdout+fresh.stderr);
  const verified=resultJson(fresh);assert.equal(verified.status,'PREPARED35_VERIFIED');assert.equal(verified.commitVerified,true);assert.equal(verified.readOnly,true);assert.equal(verified.syntheticWriteAttempts,0);
  const manifestPath=join(directory,'source.enc.atomic-precommit.json'),keyPath=join(directory,'key'),options={manifestPath,keyPath,keys:fixtureKeys,releaseSha:SHA,sourceSha:SOURCE};
  const authenticated=await authenticateStage8AtomicRecovery(options),manifest=authenticated.manifest;
  assert.equal(verified.digest,manifest.planEvidence.targetDigest);assert.deepEqual(manifest.planEvidence.preparedMarkers.map(marker=>marker.version),[34,35]);
  assert.ok(manifest.planEvidence.originalVersionMarkers.some(marker=>marker.version===33));
  assert.equal(JSON.stringify(manifest).includes('CREATE TABLE'),false);assert.equal(JSON.stringify(manifest).includes('statements'),false);
  for(const attack of [{releaseSha:SOURCE},{sourceSha:SHA},{now:manifest.createdAt+3600001},{keys:createPhase4Keys({lookupKey:Buffer.alloc(32,71),auditKey:Buffer.alloc(32,99)})}])
   await assert.rejects(authenticateStage8AtomicRecovery({...options,...attack}),/AUTHENTICATION_FAILED|BINDING_REQUIRED/);
  const wrongKey=join(directory,'wrong-key');await writeFile(wrongKey,Buffer.alloc(32,45),{mode:0o600});await assert.rejects(authenticateStage8AtomicRecovery({...options,keyPath:wrongKey}),/IMAGE_AUTHENTICATION_FAILED/);
  await assert.rejects(verifyStage8AtomicRecovery({...options,environment:{},client:{execute(){throw Error('CALLER_CLIENT_FORBIDDEN');}}}),/OPTIONS_REQUIRED/);
  // The exact33 state is never presented as rollback proof and is not replayed.
  const original=join(directory,'original33.sqlite');
  // Keep the source encrypted artifacts intact; restoring a synthetic source33
  // for the read-only check authenticates the original SQL before local restore.
  const {authenticateProductionDump}=await import('../scripts/stage8-production-migrate.mjs'),decoded=await authenticateProductionDump({backupPath:join(directory,'source.enc'),keyPath,releaseSha:SHA,sourceSha:SOURCE,sourceDigest:manifest.planEvidence.sourceDigest});
  const Database=(await import('libsql')).default,source=new Database(original);try{source.exec(decoded.sql.toString('utf8'));}finally{source.close();decoded.sql.fill(0);}
  const observed=child('test/stage8AtomicRecoveryReadChild.mjs',directory,original);assert.equal(observed.status,0,observed.stdout+observed.stderr);assert.equal(resultJson(observed).status,'SOURCE33_OBSERVED_COMMIT_UNCERTAIN');assert.equal(resultJson(observed).commitVerified,false);
  const encrypted=await readFile(manifest.prepared35.path);encrypted[encrypted.length-18]^=1;await writeFile(manifest.prepared35.path,encrypted);await assert.rejects(authenticateStage8AtomicRecovery(options),/IMAGE_AUTHENTICATION_FAILED/);
 });
 assert.equal(network,0);
});

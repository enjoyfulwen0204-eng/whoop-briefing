import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';import {mkdir,symlink} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createDb,fixtureKeys} from './localDb.js';
import {executionProfile} from '../src/phase4Rollback.js';import {createBriefingEndpoint} from '../src/briefingEndpoint.js';
import {runExecutionPhase} from '../src/phase4Execution.js';import {BRIEFING_TRIGGER,signTriggerRequest} from '../src/briefingTriggerAuth.js';
const environment={PHASE4_EXECUTION_PROFILE:'RC2_V32_ROLLBACK',PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off',
 PHASE4_LOOKUP_KEY:Buffer.alloc(32,71).toString('hex'),PHASE4_AUDIT_KEY:Buffer.alloc(32,83).toString('hex')};
test('raw authoritative RC2 is incompatible with v32; reviewed candidate rollback profile supports legacy authenticated OFF/OFF sync with dedupe',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'p4-v32-rollback-')),db=createDb({url:`file:${join(dir,'db.sqlite')}`});
 t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});await db.migrate();
 const archive=join(dir,'rc2');await mkdir(archive);execFileSync('tar',['-x','-C',archive],{input:execFileSync('git',['archive','c364ea7a7586bcaafb3fccd66bc18a461643732c'],{maxBuffer:64*1024*1024})});
 await symlink(fileURLToPath(new URL('../node_modules',import.meta.url)),join(archive,'node_modules'));
 const {runMigrations}=await import(`${archive}/src/migrations.js`);
 await assert.rejects(()=>runMigrations(db.raw,{privacyKeys:fixtureKeys}),/schema_version_incompatible/);
 const secret='synthetic-rollback-secret-at-least-32',at=Date.now();let syncs=0,drains=0;
 const endpoint=createBriefingEndpoint({secret,environment,now:()=>at,runPhase:args=>runExecutionPhase({...args,db,environment,keys:fixtureKeys,
  env:{timezone:'Asia/Taipei',dryRun:true,maxUserConcurrency:1},deps:{runBriefing:async()=>{syncs++;return {syncComplete:true,syncOutcome:'NO_NEW_DATA_SUCCESS'};},runtime:{phase4Stage6:{drain:()=>{drains++;throw Error('ROLLBACK_DRAIN_FORBIDDEN');}}}}})});
 const requestId='rollback_legacy_signed_request',body='{}',timestamp=String(at);
 const req={method:'POST',url:BRIEFING_TRIGGER.PATH,headers:{'content-type':'application/json','x-briefing-request-id':requestId,
  'x-briefing-timestamp':timestamp,'x-briefing-signature':signTriggerRequest({timestamp,requestId,method:'POST',path:BRIEFING_TRIGGER.PATH,body},secret)}};
 const first=await endpoint(req,body);assert.equal(first.status,200);assert.equal(first.body.drainAuthorized,false);
 assert.deepEqual(await endpoint(req,body),first);assert.equal(syncs,1);assert.equal(drains,0);
 assert.equal((await db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0].v,32);
});
test('rollback profile fails closed on SHADOW, presentation, allowlist or unknown profile',()=>{
 assert.equal(executionProfile(environment),'RC2_V32_ROLLBACK');
 for(const change of [{PHASE4_BETA_SHADOW_RUNTIME:'on'},{PHASE4_PUBLIC_BETA_MODE:'all'},{PHASE4_PUBLIC_BETA_USER_IDS:'synthetic'},
  {PHASE4_EXECUTION_PROFILE:'unknown'}])assert.throws(()=>executionProfile({...environment,...change}));
});

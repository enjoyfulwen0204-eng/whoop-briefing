import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createOwnedDb} from './stage5OwnedDb.js';
const entry=fileURLToPath(new URL('../scripts/phase4-run.js',import.meta.url));
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'p4-github-cli-')),url=`file:${join(dir,'isolated.db')}`;
 const db=createOwnedDb({url});t.after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});await db.migrate({targetVersion:31});
 return {db,dir,url};}
function child(f,phase,event,extra={}){
 // Explicit environment and empty temporary cwd prevent local .env/provider access.
 const env={PATH:process.env.PATH,TMPDIR:tmpdir(),WHOOP_CLIENT_ID:'synthetic',WHOOP_CLIENT_SECRET:'synthetic',
  OPENROUTER_API_KEY:'synthetic',TELEGRAM_BOT_TOKEN:'synthetic',TELEGRAM_CHAT_ID:'1001',
  TURSO_DATABASE_URL:f.url,TURSO_AUTH_TOKEN:'synthetic',DRY_RUN:'1',TIMEZONE:'Asia/Taipei',
  PHASE4_LOOKUP_KEY:Buffer.alloc(32,71).toString('hex'),PHASE4_AUDIT_KEY:Buffer.alloc(32,83).toString('hex'),
  PHASE4_BETA_SHADOW_RUNTIME:'on',PHASE4_PUBLIC_BETA_MODE:'off',PHASE4_EXECUTION_PHASE:phase,
  GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:event,GITHUB_RUN_ID:'123456789012345',GITHUB_RUN_ATTEMPT:'1',
  GITHUB_OUTPUT:join(f.dir,'job-output'),...extra};
 const args=[...(extra.PRELOAD?['--import',extra.PRELOAD]:[]),entry];delete env.PRELOAD;
 const result=spawnSync(process.execPath,args,{cwd:f.dir,env,encoding:'utf8',timeout:30_000});
 const record=result.stdout?.split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return {};}}).find(r=>r.event==='phase4_cli_complete');
 return {...result,record};
}
for(const [event,source] of [['schedule','github'],['workflow_dispatch','manual']])test(`actual GitHub ${event} CLI preserves ${source} attribution, explicit outputs and distinct drain execution`,async t=>{
 const f=await fixture(t);await f.db.close();
 const sync=child(f,'SYNC',event);assert.equal(sync.status,0,sync.stderr);assert.equal(sync.record.source,source);assert.equal(sync.record.syncComplete,true);
 const fields=Object.fromEntries((await readFile(join(f.dir,'job-output'),'utf8')).trim().split('\n').map(line=>line.split('=')));
 assert.equal(fields.sync_complete,'true');assert.equal(fields.drain_authorized,'true');assert.match(fields.sync_handoff,/^[a-f0-9]{64}$/);
 assert.ok(!sync.stdout.includes(fields.sync_handoff),'handoff must not enter ordinary logs');
 const drain=child(f,'STAGE6_DRAIN',event,{PHASE4_SYNC_REQUEST_ID:fields.sync_request_id,PHASE4_SYNC_HANDOFF:fields.sync_handoff});
 assert.equal(drain.status,0,drain.stderr);assert.equal(drain.record.phase,'STAGE6_DRAIN');assert.equal(drain.record.source,source);assert.equal(drain.record.outcome,'NO_WORK');
});
test('actual failed-resource CLI exits nonzero with both dependency outputs false and no handoff',async t=>{
 const f=await fixture(t);await f.db.createUser({id:'synthetic-cli-user',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 await f.db.setLocale('synthetic-cli-user','en');await f.db.linkTelegram({userId:'synthetic-cli-user',chatId:'1001'});
 await f.db.saveTokens('synthetic-cli-user',{accessToken:'synthetic',refreshToken:'synthetic',expiresAt:new Date(Date.now()+3_600_000),whoopUserId:'12345'});
 await f.db.saveSyncState('synthetic-cli-user','sleep',{backfillComplete:true});
 await f.db.saveCapabilities('synthetic-cli-user',[{key:'sleep',status:'SUPPORTED'}],{expectedLifecycleGeneration:1});
 await f.db.close();
 const preload=join(f.dir,'transport.mjs');await writeFile(preload,`globalThis.fetch=async url=>{if(String(url).startsWith('https://api.prod.whoop.com/'))return new Response('{}',{status:403});throw new Error('UNEXPECTED_NETWORK_BLOCKED');};\n`);
 const failed=child(f,'SYNC','schedule',{PRELOAD:preload});assert.equal(failed.status,1,failed.stdout+failed.stderr);
 assert.equal(failed.record.outcome,'REQUIRED_RESOURCE_FAILED');assert.equal(failed.record.syncComplete,false);assert.equal(failed.record.drainAuthorized,false);
 const output=await readFile(join(f.dir,'job-output'),'utf8');assert.match(output,/sync_complete=false\ndrain_authorized=false/);assert.match(output,/sync_handoff=\n/);
 assert.ok(!failed.stdout.includes('synthetic-cli-user'));
});

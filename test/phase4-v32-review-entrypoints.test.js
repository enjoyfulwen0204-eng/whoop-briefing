import test from 'node:test';import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';
import {join} from 'node:path';import {fixture} from './v32ReviewFixture.js';
const entries=[['scripts/admin.js',['user:list']],['scripts/preflight.js',['--no-send']],['scripts/authorize.js',['--user=fixture','--code=fixture','--state=fixture']],
 ['src/bot/webhook.js',[]],['src/bot/index.js',[]],['src/index.js',[]],['scripts/phase4-run.js',[]],['scripts/health-status.js',[]],['scripts/phase0-status.js',[]],
 ['scripts/sync.js',[]],['scripts/probe-fields.js',[]],['scripts/whoop-webhook.js',['status']],['scripts/analytics.js',['status','--user=fixture']],['scripts/reconcile.js',['status','--user=fixture']]];
for(const [file,args] of entries)test(`v31 ${file} cannot advance schema or mutate rows`,async t=>{
 const {db,url,dir}=await fixture(t,31);const before=(await db.raw.execute("SELECT group_concat(version,',') v FROM schema_version")).rows[0].v;
 const env={PATH:process.env.PATH,HOME:dir,TURSO_DATABASE_URL:url,TURSO_AUTH_TOKEN:'fixture',
  PHASE4_LOOKUP_KEY:Buffer.alloc(32,71).toString('hex'),PHASE4_AUDIT_KEY:Buffer.alloc(32,83).toString('hex'),
  WHOOP_CLIENT_ID:'fixture',WHOOP_CLIENT_SECRET:'fixture',WHOOP_REDIRECT_URI:'http://127.0.0.1:9999/callback',
  OPENROUTER_API_KEY:'fixture',TELEGRAM_BOT_TOKEN:'fixture',TELEGRAM_CHAT_ID:'999',TELEGRAM_WEBHOOK_SECRET:'fixture',
  PHASE4_EXECUTION_PHASE:'SYNC',PHASE4_BETA_SHADOW_RUNTIME:'off',PHASE4_PUBLIC_BETA_MODE:'off'};
 let output='',code=0;try{output=execFileSync(process.execPath,[join(process.cwd(),file),...args],{cwd:dir,env,encoding:'utf8',timeout:15000,stdio:'pipe'});}catch(e){output=String(e.stdout)+String(e.stderr);code=e.status;}
 assert.notEqual(code,0,output);assert.match(output,/CONTROLLED_MIGRATION_REQUIRED|schema 版本 31|程式碼 32/,output);
 assert.equal((await db.raw.execute("SELECT group_concat(version,',') v FROM schema_version")).rows[0].v,before);
 assert.equal((await db.raw.execute("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'phase4_execution%'")).rows[0].n,0);
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_migration_checkpoints WHERE target_version=32')).rows[0].n,0);
 console.log(JSON.stringify({entrypoint:file,exit:code,schema:31,mutated:false}));
});
test('v32 normal read/admin/diagnostic commands run with original keys and do not rewrite schema/checkpoints/user data',async t=>{
 const {db,url,dir}=await fixture(t);await db.createUser({id:'fixture',displayName:'Synthetic',timezone:'Asia/Taipei',status:'ACTIVE'});
 const snapshot=async()=>JSON.stringify({version:(await db.raw.execute('SELECT * FROM schema_version')).rows,
  checkpoints:(await db.raw.execute('SELECT * FROM phase4_migration_checkpoints ORDER BY target_version,step_key')).rows,
  users:(await db.raw.execute('SELECT * FROM users')).rows});const before=await snapshot();
 const env={PATH:process.env.PATH,HOME:dir,TURSO_DATABASE_URL:url,TURSO_AUTH_TOKEN:'fixture',
  PHASE4_LOOKUP_KEY:Buffer.alloc(32,71).toString('hex'),PHASE4_AUDIT_KEY:Buffer.alloc(32,83).toString('hex')};
 for(const [file,args] of [['scripts/admin.js',['user:list']],['scripts/health-status.js',[]],['scripts/phase0-status.js',[]],
  ['scripts/analytics.js',['status','--user=fixture']],['scripts/reconcile.js',['status','--user=fixture']],['scripts/whoop-webhook.js',['status']]]){
  let output='',code=0;try{output=execFileSync(process.execPath,[join(process.cwd(),file),...args],{cwd:dir,env,encoding:'utf8',timeout:20000,stdio:'pipe'});}catch(e){output=String(e.stdout)+String(e.stderr);code=e.status;}
  assert.equal(code,0,`${file}: ${output}`);assert.equal(await snapshot(),before,file);
 }
 assert.equal((await db.raw.execute('SELECT count(*) n FROM phase4_executions')).rows[0].n,0);
});

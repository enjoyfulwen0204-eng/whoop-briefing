import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,chmod,rm,stat,writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {createClient} from '@libsql/client';
import {restoreStage8Sqlite} from '../scripts/stage8-sqlite-restore.mjs';
import {withStage8Maintenance} from '../scripts/stage8-maintenance-context.mjs';

test('fixed SQLite child restores authenticated stdin to protected DB with no plaintext SQL file',async t=>{
 const directory=await mkdtemp('/private/tmp/stage8-child-restore-');await chmod(directory,0o700);t.after(()=>rm(directory,{recursive:true,force:true}));
 const sourcePath=join(directory,'restore.sqlite');await restoreStage8Sqlite({sourcePath,sql:Buffer.from("BEGIN; CREATE TABLE synthetic(x TEXT); INSERT INTO synthetic VALUES('synthetic'); COMMIT;")});
 assert.equal((await stat(sourcePath)).mode&0o777,0o600);
 const db=createClient({url:'file:'+sourcePath});try{assert.equal((await db.execute('SELECT x FROM synthetic')).rows[0].x,'synthetic');}finally{db.close();}
});
test('original cancellation kills actual native restore child and awaits close',async t=>{
 const directory=await mkdtemp('/private/tmp/stage8-child-cancel-');await chmod(directory,0o700);t.after(()=>rm(directory,{recursive:true,force:true}));
 const sourcePath=join(directory,'restore.sqlite'),controller=new AbortController(),deadlineAt=Date.now()+10000;
 const raw={kind:'BOUNDED_WINDOW_CONTEXT_V1',phase:'MIGRATE_35',deadlineAt,assertBeforeMutation:async()=>undefined,
  dispatchMutation:async({prepare,dispatch})=>dispatch({prepared:await prepare(),deadlineAt,remainingMs:deadlineAt-Date.now(),signal:controller.signal})};
 await assert.rejects(withStage8Maintenance(raw,'MIGRATE_35',async maintenance=>{
  const timer=setTimeout(()=>controller.abort(),30);try{await restoreStage8Sqlite({sourcePath,maintenance,sql:Buffer.from('CREATE TABLE synthetic(x); INSERT INTO synthetic WITH RECURSIVE x(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<100000000) SELECT n FROM x;')});}finally{clearTimeout(timer);}
 }),/LOCAL_RESTORE_ABORTED/);
 const size=(await stat(sourcePath)).size;await new Promise(resolve=>setTimeout(resolve,30));assert.equal((await stat(sourcePath)).size,size);
});

test('installed SQLite safe mode denies meta-command and ATTACH file/shell authority',async t=>{
 const directory=await mkdtemp('/private/tmp/stage8-child-safe-');await chmod(directory,0o700);t.after(()=>rm(directory,{recursive:true,force:true}));
 const input=join(directory,'input.sql');await writeFile(input,'CREATE TABLE read_forbidden(x);',{mode:0o600});
 const cases=[
  ['shell',target=>`.shell /usr/bin/touch ${target}\n`],
  ['read',()=>`.read ${input}\n`],
  ['output',target=>`.output ${target}\nSELECT 'synthetic';\n`],
  ['attach',target=>`ATTACH DATABASE '${target}' AS other; CREATE TABLE other.forbidden(x);`],
  ['open',target=>`.open ${target}\nCREATE TABLE forbidden(x);`],
  ['nonce',target=>`.nonce \"\"\n.shell /usr/bin/touch ${target}\n`]
 ];
 for(const [name,sql] of cases){
  const target=join(directory,'forbidden-'+name),sourcePath=join(directory,'restore-'+name+'.sqlite');
  await assert.rejects(restoreStage8Sqlite({sourcePath,sql:Buffer.from(sql(target))}),/LOCAL_RESTORE_FAILED/,name);
  await assert.rejects(access(target),/ENOENT/,name);
 }
});

// Read only the explicitly pinned, non-secret source objects from local Git.
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {after} from 'node:test';
import {createRequire} from 'node:module';
export const A='9da21bb9e4f514f0f8325077acb8c65c4444fa44';
export const WORKER_SOURCE='ca4bff7b711737527ca6c4e306d4a3ef555c9f3b';
const root=fileURLToPath(new URL('../',import.meta.url));
function git(args){return execFileSync('git',args,{cwd:root,maxBuffer:16*1024*1024,env:{PATH:process.env.PATH,HOME:process.env.HOME},stdio:['ignore','pipe','pipe']});}
export async function frozenWorker(){
 const source=git(['show',WORKER_SOURCE+':cloudflare/briefing-scheduler/worker.js']);
 // This exact frozen Worker has no imports. Nothing is deployed or fetched.
 const dir=await mkdtemp(join(tmpdir(),'p0-immutable-worker-source-'));
 after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(join(dir,'worker.mjs'),source);
 return import(pathToFileURL(join(dir,'worker.mjs')));
}
export async function frozenA(t){
 const dir=await mkdtemp(join(tmpdir(),'p0-immutable-a-source-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 // Source only: never archive .env, evidence, logs, or the repository itself.
 execFileSync('/usr/bin/tar',['-xf','-','-C',dir],{input:git(['archive',A,'src']),stdio:['pipe','pipe','pipe']});
 await writeFile(join(dir,'package.json'),'{"type":"module"}\n');
 let modules=dirname(createRequire(import.meta.url).resolve('@libsql/client'));
 while(basename(modules)!=='node_modules'){const parent=dirname(modules);if(parent===modules)throw Error('LOCAL_DEPENDENCIES_UNAVAILABLE');modules=parent;}
 await symlink(modules,join(dir,'node_modules'));
 return {webhook:await import(pathToFileURL(join(dir,'src/bot/webhook.js'))),
  migrations:await import(pathToFileURL(join(dir,'src/migrations.js')))};
}

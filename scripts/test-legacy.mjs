// Historical fixtures are preserved, not part of current v33 acceptance.
// Empty environment + denied external network/.env access also apply here.
import {readdirSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=fileURLToPath(new URL('..',import.meta.url));
const files=readdirSync(join(root,'test/legacy'),{recursive:true}).filter(f=>/\.(js|mjs)$/.test(f)).map(f=>join(root,'test/legacy',f));
const scratch=mkdtempSync(join(tmpdir(),'whoop-legacy-'));
const profile='(version 1)(allow default)(deny network*)(allow network* (remote ip "localhost:*"))(deny file-read* (regex #"(^|/)\\.env($|\\.)"))';
const args=['--test','--test-concurrency=3','--test-timeout=180000','--test-reporter',join(root,'test/current-reporter.mjs'),...files];
if(process.argv.includes('--list')){console.log(files.map(f=>f.slice(root.length)).join('\n'));rmSync(scratch,{recursive:true,force:true});}
else {
 const env={PATH:process.env.PATH,HOME:scratch,TMPDIR:scratch,NODE_ENV:'test',CI:'true',NO_COLOR:'1'};
 const child=spawn(process.platform==='darwin'?'/usr/bin/sandbox-exec':process.execPath,process.platform==='darwin'?['-p',profile,process.execPath,...args]:args,{cwd:root,env,stdio:'inherit'});
 child.on('error',e=>{console.error(e.code??e.name);rmSync(scratch,{recursive:true,force:true});process.exitCode=1;});
 child.on('exit',(code,signal)=>{rmSync(scratch,{recursive:true,force:true});process.exitCode=signal?1:code??1;});
}

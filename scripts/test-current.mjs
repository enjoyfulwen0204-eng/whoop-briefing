import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=fileURLToPath(new URL('..',import.meta.url));
const files=readFileSync(join(root,'test/current-suite.txt'),'utf8').split('\n').map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));
if(new Set(files).size!==files.length||files.some(f=>!/^test\/[A-Za-z0-9.-]+\.test\.(js|mjs)$/.test(f)))throw Error('CURRENT_SUITE_INVALID');
const scratch=mkdtempSync(join(tmpdir(),'whoop-current-'));
const args=['--import',join(root,'test/stage7-recovery-loader.mjs'),'--test','--test-concurrency=3','--test-timeout=180000','--test-reporter',join(root,'test/current-reporter.mjs'),...files.map(f=>resolve(root,f))];
// Keep actual checkout identity, but inherit no credentials, provider config,
// .env, SSH agent or CLI authentication from the invoking shell.
const env={PATH:process.env.PATH,HOME:scratch,TMPDIR:scratch,NODE_ENV:'test',CI:'true',NO_COLOR:'1'};
const mac=process.platform==='darwin';
// Local HTTP fixtures may listen on loopback. No outbound provider access or
// real environment-file access is allowed, including spawned test processes.
const profile='(version 1)(allow default)(deny network*)(allow network* (remote ip "localhost:*"))(deny file-read* (regex #"(^|/)\\.env($|\\.)"))';
const child=spawn(mac?'/usr/bin/sandbox-exec':process.execPath,mac?['-p',profile,process.execPath,...args]:args,{cwd:root,env,stdio:'inherit'});
child.on('error',e=>{console.error(e.code??e.name);rmSync(scratch,{recursive:true,force:true});process.exitCode=1;});
child.on('exit',(code,signal)=>{rmSync(scratch,{recursive:true,force:true});process.exitCode=signal?1:code??1;});

import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {createWriteStream} from 'node:fs';import path from 'node:path';
// Isolated files, bounded process trees, immutable per-attempt evidence. Never
// loads dotenv or creates an application database. Run socket tests separately.
const output=process.env.PRE_STAGE7_OUTPUT,concurrency=Number(process.env.PRE_STAGE7_CONCURRENCY??3),timeoutMs=180000;
if(!output||!/^tmp\/[a-zA-Z0-9/_-]+$/.test(output)||!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw Error('HARNESS_CONFIG_INVALID');
await mkdir(output,{recursive:true});if((await readdir(output)).length)throw Error('FRESH_EVIDENCE_DIRECTORY_REQUIRED');
const files=process.argv.slice(2);if(!files.length||new Set(files).size!==files.length||files.some(f=>!/^test\/[\w-]+\.test\.js$/.test(f)))throw Error('EXPLICIT_UNIQUE_TEST_FILES_REQUIRED');
const hash=x=>createHash('sha256').update(x).digest('hex');
const identity={node:process.version,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),diffSha256:hash(execFileSync('git',['diff','HEAD'])),files,concurrency,timeoutMs};await writeFile(path.join(output,'inventory.json'),JSON.stringify(identity,null,2));
let index=0;const results=[];
async function worker(){while(index<files.length){const file=files[index++],log=path.join(output,path.basename(file)+'.tap'),chunks=[],stream=createWriteStream(log),started=Date.now();
 const command=[process.execPath,'--expose-gc','--test','--test-concurrency=1',file],env={...process.env};delete env.NODE_TEST_CONTEXT;
 const child=spawn(command[0],command.slice(1),{env,detached:true,stdio:['ignore','pipe','pipe']});let timedOut=false;
 const capture=x=>{chunks.push(x);stream.write(x);};child.stdout.on('data',capture);child.stderr.on('data',capture);
 const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}},timeoutMs);
 const exit=await new Promise(resolve=>{child.on('error',e=>resolve({error:e.code}));child.on('close',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);await new Promise(r=>stream.end(r));
 const text=Buffer.concat(chunks).toString(),cases=[...text.matchAll(/^\s*(not )?ok \d+ - (.+)$/gm)];
 const count=k=>{const m=[...text.matchAll(new RegExp(`^# ${k} (\\d+)$`,'gm'))].at(-1);return m?Number(m[1]):k==='tests'?cases.length:k==='pass'?cases.filter(x=>!x[1]).length:k==='fail'?cases.filter(x=>x[1]).length:0;};
 const classification=timedOut?'TIMEOUT':exit.code===0?'PASS':/SIGSEGV/.test(text)||exit.signal==='SIGSEGV'?'NATIVE_SIGSEGV':/EPERM|EACCES/.test(text)?'ENVIRONMENT_EPERM':/failureType: '(testCodeFailure|subtestsFailed)'/.test(text)?'ASSERTION_FAILURE':'HARNESS_FAILURE';
 const result={file,command,...exit,classification,tests:count('tests'),passed:count('pass'),failed:count('fail'),cancelled:count('cancelled'),skipped:count('skipped'),durationMs:Date.now()-started,log,sha256:hash(text),assertionFailures:cases.filter(x=>x[1]).map(x=>x[2])};results.push(result);await writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(result));
}}
await Promise.all(Array.from({length:concurrency},worker));process.exitCode=results.some(x=>x.classification!=='PASS')?1:0;

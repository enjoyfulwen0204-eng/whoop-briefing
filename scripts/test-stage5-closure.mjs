import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';

// One native SQLite test process at a time; preserve output even on a signal.
// This runner never opens the application database or loads environment files.
const output=process.env.STAGE5_TEST_OUTPUT??'/private/tmp/stage5-consolidated-closure/serialized';
const files=process.argv.slice(2);
if(!files.length)throw Error('EXPLICIT_TEST_FILES_REQUIRED');
const timeoutMs=Number(process.env.STAGE5_TEST_TIMEOUT_MS??300000);
if(!Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>600000)throw Error('INVALID_TEST_TIMEOUT');
await mkdir(output,{recursive:true});
const results=[];
for(const file of files) {
  if(!/^test\/[\w-]+\.test\.js$/.test(file))throw Error('TEST_FILE_REQUIRED');
  const started=Date.now(),chunks=[],log=path.join(output,path.basename(file)+'.log'),stream=createWriteStream(log);
  const grouped=process.platform!=='win32';
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const child=spawn(process.execPath,['--expose-gc','--test','--test-concurrency=1',file],{stdio:['ignore','pipe','pipe'],detached:grouped,env});
  const capture=chunk=>{chunks.push(chunk);stream.write(chunk);};
  child.stdout.on('data',capture);child.stderr.on('data',capture);
  let timedOut=false;
  const timer=setTimeout(()=>{
    timedOut=true;
    if(grouped) {try {process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
    else spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});
  },timeoutMs);
  const outcome=await new Promise(resolve=>{
    child.on('error',error=>resolve({error:error.code}));
    child.on('close',(code,signal)=>resolve({code,signal}));
  });
  clearTimeout(timer);
  await new Promise(resolve=>stream.end(resolve));
  const text=Buffer.concat(chunks).toString('utf8');
  const number=label=>{
    const summary=[...text.matchAll(new RegExp(`^# ${label} (\\d+)$`,'gm'))].at(-1);
    if(summary)return Number(summary[1]);
    if(!['tests','pass','fail'].includes(label))return 0;
    const all=[...text.matchAll(/^\s*(not )?ok \d+ - (.+)$/gm)];
    return label==='tests'?all.length:all.filter(match=>label==='pass'?!match[1]:Boolean(match[1])).length;
  };
  const classification=timedOut?'TIMEOUT':outcome.code===0?'PASS':/SIGSEGV/.test(text)||outcome.signal==='SIGSEGV'?'NATIVE_SIGSEGV'
    :/EPERM|EACCES/.test(text)?'ENVIRONMENT_EPERM':outcome.error?'HARNESS_ERROR'
      :/failureType: '(testCodeFailure|subtestsFailed)'/.test(text)?'ASSERTION_FAILURE':'HARNESS_FAILURE';
  const result={file,...outcome,classification,timeoutMs,tests:number('tests'),passed:number('pass'),failed:number('fail'),
    cancelled:number('cancelled'),skipped:number('skipped'),
    assertionFailures:[...text.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(match=>match[1]),durationMs:Date.now()-started,log};results.push(result);
  await writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(result));
}
process.exitCode=results.some(result=>result.classification!=='PASS')?1:0;

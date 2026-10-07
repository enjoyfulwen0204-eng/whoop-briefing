import {spawn} from 'node:child_process';import {writeFile,open,mkdir,readdir} from 'node:fs/promises';import path from 'node:path';import {pathToFileURL} from 'node:url';
const directory=process.env.STAGE5_STABILITY_OUTPUT??`tmp/v32-stage5-stability-${Date.now()}`;
await mkdir(directory,{recursive:true});
if((await readdir(directory)).length)throw Error('FRESH_EVIDENCE_DIRECTORY_REQUIRED');
const dir=pathToFileURL(path.resolve(directory)+path.sep),results=[];
for(let repetition=1;repetition<=20;repetition++){
 const log=new URL(`stage5-candidate-${repetition}.tap`,dir),handle=await open(log,'w'),started=Date.now();
 const grouped=process.platform!=='win32';
 const child=spawn(process.execPath,['--expose-gc','--test','--test-concurrency=1','test/phase4-stage5-review-b-process.test.js'],{detached:grouped,stdio:['ignore',handle.fd,handle.fd]});
 let timedOut=false;const timer=setTimeout(()=>{timedOut=true;if(grouped){try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}else child.kill('SIGKILL');},180000);
 const result=await new Promise(resolve=>child.on('close',(code,signal)=>resolve({repetition,code,signal,timedOut,durationMs:Date.now()-started,log:log.pathname})));
 clearTimeout(timer);await handle.close();results.push(result);await writeFile(new URL('stage5-repetitions.json',dir),JSON.stringify(results,null,2)+'\n');
 console.log(JSON.stringify(result));
 if(timedOut)break; // Do not leak descendants or reinterpret an interrupted run as a pass.
}
process.exitCode=results.some(r=>r.code!==0)?1:0;

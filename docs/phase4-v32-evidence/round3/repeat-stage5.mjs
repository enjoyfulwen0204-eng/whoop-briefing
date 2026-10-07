import {spawn} from 'node:child_process';import {writeFile,open} from 'node:fs/promises';
const dir=new URL('./',import.meta.url),results=[];
for(let repetition=1;repetition<=10;repetition++){
 const log=new URL(`stage5-candidate-${repetition}.tap`,dir),handle=await open(log,'w'),started=Date.now();
 const child=spawn(process.execPath,['--expose-gc','--test','--test-concurrency=1','test/phase4-stage5-review-b-process.test.js'],{stdio:['ignore',handle.fd,handle.fd]});
 let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},60000);
 const result=await new Promise(resolve=>child.on('close',(code,signal)=>resolve({repetition,code,signal,timedOut,durationMs:Date.now()-started,log:log.pathname})));
 clearTimeout(timer);await handle.close();results.push(result);await writeFile(new URL('stage5-repetitions.json',dir),JSON.stringify(results,null,2)+'\n');
 console.log(JSON.stringify(result));
 if(timedOut)break; // Do not leak descendants or reinterpret an interrupted run as a pass.
}
process.exitCode=results.some(r=>r.code!==0)?1:0;

import {register}from'node:module';import{readFileSync}from'node:fs';
if(process.platform!=='linux'||readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()!=='536870912'||!['stage6-linux-concurrency.mjs','stage6LinuxDrainChild.mjs'].some(x=>process.argv[1]?.endsWith('/test/'+x)))throw Error('SYNTHETIC_SERVICE_DIAGNOSTICS_ONLY');
const failures=[];globalThis.__stage6ServiceDiagnostics={capture(error,boundary){
 if(failures.length>=64)return;
 const message=error?.name==='TypeError'&&/^Cannot (?:read|convert|set) /.test(error.message)?error.message.replace(/(reading|setting) '[^']+'/g,"$1 '[property]'").slice(0,180):undefined;
 failures.push({at:Date.now(),boundary,name:error?.name,code:error?.code,message,causeCode:error?.cause?.code,stack:String(error?.stack??'').split('\n').slice(1).filter(x=>/^\s+at /.test(x)).slice(0,12)});
}};
process.once('beforeExit',()=>console.log('SERVICE_FAILURE_DIAGNOSTICS '+JSON.stringify(failures)));
register('./stage6ServiceDiagnosticsLoader.mjs',import.meta.url,{data:{root:new URL('../src/',import.meta.url).href}});

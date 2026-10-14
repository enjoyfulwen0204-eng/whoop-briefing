// Opt-in diagnostic loader; no grant, budget, SQL, receipt or algorithm change.
import {register} from 'node:module';
import {realpathSync,readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const allowed=['stage6-linux-qualification.mjs','stage6-linux-concurrency.mjs'];
const entry=realpathSync(process.argv[1]??'');
if(process.platform!=='linux'||!allowed.some(n=>entry===realpathSync(fileURLToPath(new URL(n,import.meta.url))))
 ||!process.execArgv.includes('--test')||process.execArgv.some(a=>/^--(?:eval|print|input-type)|^-[ep]$/.test(a))
 ||readFileSync('/sys/fs/cgroup/memory.max','utf8').trim()!=='536870912')throw Error('ISOLATED_SCHEDULING_PROFILE_ONLY');
const completed=[],active=new Map(),syncTotals=new Map();
const begin=label=>{const token={label,at:performance.now(),cpu:process.cpuUsage()};active.set(token,true);return token;};
const end=token=>{if(!token||!active.delete(token))return;const cpu=process.cpuUsage(token.cpu);completed.push({label:token.label,wallMs:performance.now()-token.at,cpuMs:(cpu.user+cpu.system)/1000});};
globalThis.__stage6SchedulingProfile={begin,end,sync(label,fn){const at=performance.now();try{return fn();}finally{const x=syncTotals.get(label)??{calls:0,wallMs:0};x.calls++;x.wallMs+=performance.now()-at;syncTotals.set(label,x);}},close(){for(const token of [...active.keys()]){end(token);completed.at(-1).incomplete=true;}const result={diagnosticOnly:true,phases:completed,syncTotals:Object.fromEntries(syncTotals)};writeFileSync('/qualification/phase-profile.json',JSON.stringify(result,null,2));console.log('SCHEDULING_PHASE_PROFILE '+JSON.stringify(result));}};
process.on('beforeExit',()=>globalThis.__stage6SchedulingProfile.close());
register(new URL('./stage6SchedulingProfileLoader.mjs',import.meta.url),{data:{root:new URL('../src/',import.meta.url).href}});

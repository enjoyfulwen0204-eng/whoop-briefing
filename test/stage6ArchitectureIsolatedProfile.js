import {register} from 'node:module';
import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
// Explicit Node test entrypoints only. An added filename argument cannot opt in.
const allowed=['stage6-runtime-target.test.js','stage6-late-unit-profile.mjs','stage6-short-crash-child.mjs','stage6-short-transaction-crash.mjs','stage6-short-transaction-security.mjs','stage6-short-transaction-prototype.mjs','stage6-raw-capacity-profile.test.js','stage6-architecture-six-job.mjs','stage6-prefix-data-prototype.mjs'];
let entry;
try{entry=realpathSync(resolve(process.argv[1]??''));}catch{}
const target=allowed.find(name=>entry===realpathSync(fileURLToPath(new URL(name,import.meta.url))));
const evalMode=process.execArgv.some(arg=>['-e','--eval','-p','--print','--input-type'].includes(arg)||arg.startsWith('--eval=')||arg.startsWith('--print=')||arg.startsWith('--input-type='));
const testRunner=process.execArgv.includes('--test')||process.env.NODE_TEST_CONTEXT==='child-v8';
const prototype=process.env.STAGE6_ISOLATED_PROTOTYPE==='prefix-terminal';
const extended=process.env.STAGE6_ISOLATED_EXTENDED;
if(!target||evalMode||!testRunner||(!prototype&&!['180','300'].includes(extended))
 ||(extended!==undefined&&(!['180','300'].includes(extended)||target!=='stage6-raw-capacity-profile.test.js'||process.env.RAW_PROFILE_TRIGGER!=='github')))
 throw Error('ISOLATED_ARCHITECTURE_TEST_ONLY');
const wallMs=extended===undefined?undefined:Number(extended)*1000,leaseMs=wallMs===undefined?undefined:wallMs+30000;
register(new URL('./stage6ArchitectureIsolatedLoader.js',import.meta.url),{data:{runtimeIntegrated:process.env.STAGE6_RUNTIME_SOURCE==='1',root:new URL('../src/',import.meta.url).href,wallMs,leaseMs,prototype,lateProfile:target==='stage6-late-unit-profile.mjs',retainRamScopes:target==='stage6-late-unit-profile.mjs'&&process.env.LATE_RETAIN_RAM_SCOPES==='1'}});
console.log('ISOLATED_ARCHITECTURE_MODEL '+JSON.stringify({prototype:prototype?'prefix-terminal':null,configuredWallMs:wallMs??null,effectiveWorkerMs:wallMs===undefined?null:wallMs-15000,initialLeaseMs:leaseMs??null,renewalsRequiredWithinBound:0,productionPolicyChanged:false,originalLeaseFencingRetained:true,prefixLimitUnchanged:128}));

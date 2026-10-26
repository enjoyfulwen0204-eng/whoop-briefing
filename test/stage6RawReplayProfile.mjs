// Closed, synthetic Linux diagnostic. Never prints identities, values or SQL.
import {register} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
assert.equal(process.platform,'linux');assert.equal(process.env.STAGE6_NATIVE_PREFIX_PROFILE,'1');
assert.equal(readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),'536870912');
const phases=new Set(['RAW_PREPARATION','METRIC_FAMILIES','ASSOCIATIONS','METRIC_PLAN','RECORDED_METRIC']);
const metrics=new Set(['recovery_score','hrv','rhr','sleep_performance','sleep_duration_minutes','sleep_efficiency','respiratory_rate','cycle_strain','body_energy']);
const scope=new AsyncLocalStorage(),totals=new Map();let enabled=false;
const entry=(phase,metric)=>{assert.ok(phases.has(phase));assert.ok(metrics.has(metric));const key=phase+':'+metric;if(!totals.has(key))totals.set(key,{phase,metric,calls:0,wallMs:0,httpRequests:0,httpMs:0,errors:0});return totals.get(key);};
globalThis.__stage6RawReplayProfile=Object.freeze({
 start(){totals.clear();enabled=true;},
 async measure(phase,metric,work){if(!enabled)return work();const row=entry(phase,metric),at=performance.now();row.calls++;try{return await scope.run(row,work);}catch(error){row.errors++;throw error;}finally{row.wallMs+=performance.now()-at;}},
 async fetch(work){const row=enabled?scope.getStore():null,at=performance.now();if(row)row.httpRequests++;try{return await work();}finally{if(row)row.httpMs+=performance.now()-at;}},
 snapshot(){return {contract:'one-genuine-prefix-native-raw-replay-profile-v1',diagnosticOnly:true,productionEvidence:false,capacityQualified:false,wholeRuntimeQualified:false,metricPhases:[...totals.values()].map(r=>({...r})),durationMeaning:'Nested wall/request observations overlap; sums are not additive CPU or server absolute transaction limits.'};},
});
register(new URL('./stage6RawReplayProfileLoader.mjs',import.meta.url),{data:{root:new URL('../src/',import.meta.url).href}});

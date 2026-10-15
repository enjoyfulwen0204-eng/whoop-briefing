// Test-only observations. Never changes SQL, authority, results or deadlines.
import {writeFileSync} from 'node:fs';
export function createSyntheticDiagnostics(path){
 const phases=[],active=new Map(),totals=new Map();
 const begin=label=>{const token={label,at:performance.now(),cpu:process.cpuUsage()};active.set(token,true);return token;};
 const end=token=>{if(!token||!active.delete(token))return;const cpu=process.cpuUsage(token.cpu);phases.push({label:token.label,wallMs:performance.now()-token.at,cpuMs:(cpu.user+cpu.system)/1000});};
 const api={begin,end,sync(label,fn){const at=performance.now();try{return fn();}finally{const total=totals.get(label)??{calls:0,wallMs:0};total.calls++;total.wallMs+=performance.now()-at;totals.set(label,total);}},close(){for(const t of [...active.keys()]){end(t);phases.at(-1).incomplete=true;}const result={diagnosticOnly:true,phases,syncTotals:Object.fromEntries(totals)};writeFileSync(path,JSON.stringify(result));if(globalThis.__stage6SyntheticDiagnostic===api)delete globalThis.__stage6SyntheticDiagnostic;return result;}};
 globalThis.__stage6SyntheticDiagnostic=api;return api;
}
export function instrumentSyntheticSource(file,source){
 const replace=(a,b)=>{if(source.split(a).length!==2)throw Error('SYNTHETIC_DIAGNOSTIC_ANCHOR_MISMATCH:'+file);source=source.replace(a,b);};
 if(file==='src/stage6ShortPublication.js'){
  replace('requireSettledOperation();const start=performance.now(),schema=',"requireSettledOperation();const profile=globalThis.__stage6SyntheticDiagnostic,snapshotPhase=profile?.begin('SNAPSHOT_PREPARATION');const start=performance.now(),schema=");
  replace('budget.assert();let db;',"budget.assert();profile?.end(snapshotPhase);const seedPhase=profile?.begin('RAM_IMPORT');let db;");
  replace('},keys);const effects=',"},keys);profile?.end(seedPhase);const calculationPhase=profile?.begin('ORIGINAL_RAM_CALCULATION');const effects=");
  replace('const owner=(await client.execute(',"profile?.end(calculationPhase);const planPhase=profile?.begin('PLAN_SEAL');const owner=(await client.execute(");
  replace('effects,result])});return plan;',"effects,result])});profile?.end(planPhase);return plan;");
  replace('async function publishDataUnit(client,plan,{beforeCommit}={}){',"async function publishDataUnit(client,plan,{beforeCommit}={}){const publicationPhase=globalThis.__stage6SyntheticDiagnostic?.begin('PUBLICATION_FENCING_AND_BATCH');");
  replace('p.execution.pending.delete(pending);return {workUsage:',"globalThis.__stage6SyntheticDiagnostic?.end(publicationPhase);p.execution.pending.delete(pending);return {workUsage:");
 }
 if(file==='src/phase4Keys.js')replace("const hmac = (key, value) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');","const hmac=(key,value)=>{const p=globalThis.__stage6SyntheticDiagnostic,json=p?p.sync('HMAC_JSON',()=>JSON.stringify(value)):JSON.stringify(value);return p?p.sync('HMAC',()=>createHmac('sha256',key).update(json).digest('hex')):createHmac('sha256',key).update(json).digest('hex');};");
 return source;
}

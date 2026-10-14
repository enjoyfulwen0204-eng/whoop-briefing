let root;
export function initialize(data){root=data.root;}
export async function load(url,context,nextLoad){
 const result=await nextLoad(url,context);if(!url.startsWith(root)||result.format!=='module')return result;let source=String(result.source);
 const replace=(before,after)=>{if(source.indexOf(before)<0||source.indexOf(before)!==source.lastIndexOf(before))throw Error('SCHEDULING_PROFILE_SOURCE_MISMATCH');source=source.replace(before,after);};
 if(url===root+'stage6ShortPublication.js'){
  replace('requireSettledOperation();const start=performance.now(),schema=',"requireSettledOperation();const profile=globalThis.__stage6SchedulingProfile,snapshotPhase=profile?.begin('SNAPSHOT_PREPARATION');const start=performance.now(),schema=");
  replace('budget.assert();let db;',"budget.assert();profile?.end(snapshotPhase);const seedPhase=profile?.begin('RAM_IMPORT');let db;");
  replace('},keys);const effects=',"},keys);profile?.end(seedPhase);const calculationPhase=profile?.begin('ORIGINAL_RAM_CALCULATION');const effects=");
  replace('const owner=(await client.execute(',"profile?.end(calculationPhase);const planPhase=profile?.begin('PLAN_SEAL');const owner=(await client.execute(");
  replace('effects,result])});return plan;',"effects,result])});profile?.end(planPhase);return plan;");
  replace('async function publishDataUnit(client,plan,{beforeCommit}={}){',"async function publishDataUnit(client,plan,{beforeCommit}={}){const publicationPhase=globalThis.__stage6SchedulingProfile?.begin('PUBLICATION_FENCING_AND_BATCH');");
  replace('p.execution.pending.delete(pending);return {workUsage:',"globalThis.__stage6SchedulingProfile?.end(publicationPhase);p.execution.pending.delete(pending);return {workUsage:");
 }
 if(url===root+'phase4Keys.js')replace("const hmac = (key, value) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');","const hmac=(key,value)=>{const p=globalThis.__stage6SchedulingProfile;const json=p?p.sync('HMAC_JSON',()=>JSON.stringify(value)):JSON.stringify(value);return p?p.sync('HMAC',()=>createHmac('sha256',key).update(json).digest('hex')):createHmac('sha256',key).update(json).digest('hex');};");
 return {...result,source};
}

/** Deterministic synthetic inputs; no provider data or credentials. */
export function bodyInput({asOf=Date.parse('2026-09-19T00:00:00.000Z'),days=30,timezone='Asia/Taipei'}={}) {
  const iso=ms=>new Date(ms).toISOString(),at=iso(asOf),sources={sleep:[],recovery:[],cycle:[],workout:[]};
  for(let n=0;n<=days;n++) {
    const wake=asOf-n*86400000,id=`sleep-${String(n).padStart(2,'0')}`,day=iso(wake).slice(0,10);
    sources.sleep.push({user_id:'a',id,health_date:day,start_at:iso(wake-8*3600000),end_at:iso(wake),nap:0,score_state:'SCORED',
      sleep_performance_percentage:50,updated_at:iso(wake),synced_at:at});
    const change=n===0?0:(n-15.5)*0.5;
    sources.recovery.push({user_id:'a',sleep_id:id,health_date:day,score_state:'SCORED',user_calibrating:0,
      hrv_rmssd_milli:50+change,resting_heart_rate:60+change,recovery_score:99,updated_at:iso(wake),synced_at:at});
  }
  sources.cycle.push({user_id:'a',id:'cycle-current',start_at:iso(asOf),end_at:null,strain:0,updated_at:at,synced_at:at});
  return {userId:'a',timezone,asOfEpochMs:asOf,authGeneration:1,lifecycleGeneration:1,sources,
    access:['sleep','recovery','cycle','workout'].map(resource=>({user_id:'a',resource,status:'ACCESSIBLE',auth_generation:1,lifecycle_generation:1})),
    sync:['sleep','recovery','cycle','workout'].map(resource=>({user_id:'a',resource,last_success_at:at,updated_at:at})),
    capabilities:['sleep_performance','hrv','rhr'].map(key=>({user_id:'a',key,status:'SUPPORTED',lifecycle_generation:1})),tombstones:[]};
}
export async function seedBodyInput(db,input=bodyInput()) {
  const at=new Date(input.asOfEpochMs).toISOString(),uid=input.userId;
  await db.raw.execute({sql:`INSERT INTO user_whoop_tokens(user_id,access_token,refresh_token,access_token_expires_at,updated_at,auth_generation)
    VALUES (?,'SYNTHETIC_NOT_A_TOKEN','SYNTHETIC_NOT_A_TOKEN',?,?,?)`,args:[uid,at,at,input.authGeneration]});
  const insert=async(table,row)=>{
    const fields=Object.keys(row);await db.raw.execute({sql:`INSERT INTO ${table}(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,args:fields.map(k=>row[k])});
  };
  for(const [type,table] of Object.entries({sleep:'whoop_sleeps',recovery:'whoop_recoveries',cycle:'whoop_cycles',workout:'whoop_workouts'}))
    for(const row of input.sources[type])await insert(table,row);
  for(const row of input.access)await insert('whoop_resource_access',{...row,checked_at:at});
  for(const row of input.sync)await insert('whoop_sync_state',row);
  for(const row of input.capabilities)await insert('whoop_capabilities',{...row,last_probed_at:at});
}

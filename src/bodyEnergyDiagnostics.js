import {validHealthDate,instant} from './bodyEnergyInputs.js';
// Ephemeral diagnostic projection only: never part of the score, manifest,
// reply proof or persisted result. Called after source revalidation.
export function logBodyEnergyRealignments({keys,userId,records=[]}){
 try{
  const user=keys.lookup(['companion-diagnostic-user-v1',userId]);
  if(!/^[a-f0-9]{64}$/.test(user))return;
  for(const row of records){
   if(!['main_sleep','main_recovery','baseline_sleep','baseline_recovery'].includes(row.record_kind)
    ||!['warning','reason'].includes(row.classification))continue;
   const record=keys.lookup(['body-energy-diagnostic-source-v1',userId,row.record_kind,row.id]);
   if(!/^[a-f0-9]{64}$/.test(record))continue;
   console.log(JSON.stringify({event:'body_energy_health_date_realignment',user,record,record_kind:row.record_kind,
    stored_health_date:validHealthDate(row.stored_health_date)?row.stored_health_date:null,
    computed_health_date:validHealthDate(row.computed_health_date)?row.computed_health_date:null,
    classification:row.classification,
    updated_at:instant(row.updated_at)===null?null:new Date(row.updated_at).toISOString(),
    synced_at:instant(row.synced_at)===null?null:new Date(row.synced_at).toISOString()}));
  }
 }catch{/* Diagnostic failures have no calculation or delivery authority. */}
}

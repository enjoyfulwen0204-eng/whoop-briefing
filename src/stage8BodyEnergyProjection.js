import {calculateBodyEnergy} from './bodyEnergy.js';
import {baselineOnlyProvisional,BODY_ENERGY_PROVISIONAL_POLICY} from './bodyEnergyProvisionalPolicy.js';

/** Data-only presentation after the caller authenticates the current artifact,
 * original producer and signed publication. This grants no read/publication
 * authority and does not replace the source/receipt/currentness checks. */
export function stage8BodyEnergyProjection(row){
 if(!row||!Number.isInteger(row.value)||row.value<0||row.value>100)return null;
 let manifest,calculation;
 try{manifest=JSON.parse(row.input_manifest_json);calculation=calculateBodyEnergy(manifest);}catch{return null;}
 if(row.value!==calculation.value||row.quality_state!==calculation.quality_state
  ||row.confidence!==calculation.confidence||row.algorithm_version!==calculation.algorithm_version)return null;
 const provisional=row.quality_state==='LIMITED';
 if(provisional?!baselineOnlyProvisional({row,manifest,calculation}):row.quality_state!=='AVAILABLE')return null;
 return Object.freeze({value:row.value,quality:row.quality_state,estimated:true,
  ...(provisional?{provisional:true,presentationPolicy:BODY_ENERGY_PROVISIONAL_POLICY.version}:{}),
  interpretation:'KELVIN_HEALTH_OS_ENGINEERING_ESTIMATE_NOT_MEDICAL_OR_REALTIME'});
}

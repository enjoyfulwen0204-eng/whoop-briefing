import { fail } from './phase4Core.js';
import { canonicalJson } from './phase4EntityStore.js';

const MAP={name:'name',hypothesis:'hypothesis',intervention:'intervention',targetMetrics:'target_metrics',
  protocol:'protocol_json',baselineStart:'baseline_start',baselineEnd:'baseline_end',startDate:'start_date',endDate:'end_date',result:'result_json'};
/** Provenance is a separate server-owned options argument, never inferred from
 * value shape, a previous leaf, or an LLM-produced experiment object. */
export function legacyExperimentAdapter({client,keys,foundation,transaction,privacy}) {
  async function owner(userId) {
    await transaction(()=>privacy.capture(userId));
    const stores=await foundation();return {stores,control:await stores.captureControl(userId)};
  }
  async function proofsFor(stores,control,fields,provenance) {
    const proofs={};
    if(!provenance)return proofs;
    if(provenance.kind!=='DIRECT'||!Array.isArray(provenance.fields)||!provenance.sourceUpdateKey
      ||!['EXPERIMENT_FLOW','EXPERIMENT_API'].includes(provenance.writerKind))fail('PHASE4_EXPERIMENT_PROVENANCE_REQUIRED');
    for(const field of provenance.fields) {
      if(!Object.hasOwn(fields,field))fail('PHASE4_EXPERIMENT_PROVENANCE_FIELD_MISMATCH');
      proofs[field]=await stores.experiments.assertDirect(control,{field,value:fields[field],sourceUpdateKey:provenance.sourceUpdateKey,writerKind:provenance.writerKind});
    }
    return proofs;
  }
  async function createExperiment(userId,value,{provenance=null,sourceUpdateKey=null,now=new Date()}={}) {
    const {stores,control}=await owner(userId);
    const fields=Object.fromEntries(Object.entries(MAP).filter(([key])=>Object.hasOwn(value,key)).map(([key,field])=>[field,value[key]]));
    const proofs=await proofsFor(stores,control,fields,provenance);
    const created=await stores.experiments.create(control,{fields,proofs,creationKey:sourceUpdateKey??provenance?.sourceUpdateKey??
      keys.lookup(['legacy-experiment-create-v1',control.userId,now.toISOString(),canonicalJson(fields)])});
    return created.experimentId;
  }
  async function updateExperiment(userId,id,patch,{provenance=null,sourceUpdateKey=null,now=new Date()}={}) {
    const {stores,control}=await owner(userId);
    if(Object.keys(patch).some(k=>!Object.hasOwn(MAP,k)&&k!=='status'))fail('PHASE4_EXPERIMENT_PATCH_INVALID');
    const fields=Object.fromEntries(Object.entries(patch).filter(([key])=>key!=='status').map(([key,value])=>[MAP[key],value]));
    const proofs=await proofsFor(stores,control,fields,provenance);
    return stores.experiments.writeNewFields(control,{experimentId:Number(id),fields,proofs,status:patch.status,
      sourceKey:sourceUpdateKey??provenance?.sourceUpdateKey??keys.lookup(['legacy-experiment-update-v1',control.userId,id,now.toISOString(),canonicalJson(patch)])});
  }
  async function getExperiment(userId,id) {
    const {stores,control}=await owner(userId);
    const result=await stores.experiments.read(control,Number(id));
    return result?{...result.row,privacyRedactedFields:result.redactedFields}:null;
  }
  async function listExperiments(userId,{status=null}={}) {
    const {stores,control}=await owner(userId);
    return transaction(async()=>{
      const rows=(await client.execute({sql:'SELECT id FROM experiments WHERE user_id=? AND (? IS NULL OR status=?) ORDER BY id DESC',args:[control.userId,status,status]})).rows;
      const values=[];for(const row of rows)values.push(await getExperiment(control.userId,row.id));return values;
    });
  }
  return {createExperiment,updateExperiment,getExperiment,listExperiments};
}

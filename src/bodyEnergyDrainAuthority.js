import {requireUserId} from './userContext.js';
import {requirePhase4Keys} from './phase4Keys.js';
const grants=new WeakMap();
const fail=()=>{throw Error('BODY_ENERGY_FINALIZED_DRAIN_REQUIRED');};
async function memory(db){const rows=(await db.raw.execute('PRAGMA database_list')).rows;
  if(db.raw.protocol!=='file'||rows.length!==1||rows[0].name!=='main'||rows[0].file!=='')fail();}
export async function authorizeBodyEnergyFinalizedDrain({db,keys,executionId,userId,assertExecution}={}){
  requirePhase4Keys(keys);const id=requireUserId(userId,'bodyEnergyDrainAuthority');
  if(typeof executionId!=='string'||typeof assertExecution!=='function')fail();assertExecution();
  const row=(await db.raw.execute({sql:`SELECT execution_id,identity_digest,scope_key,generation,release_sha,config_proof,
    result_digest,phase,state,execution_mode,finalized_at FROM phase4_executions WHERE execution_id=?`,args:[executionId]})).rows[0];
  if(!row||row.phase!=='STAGE6_DRAIN'||row.state!=='FINALIZED_SUCCESS'||row.execution_mode!=='SHADOW'
    ||!Number.isSafeInteger(row.finalized_at)||row.finalized_at>Date.now())fail();
  const signature=keys.lookup(['body-energy-finalized-drain-v1',row]);
  const grant=Object.freeze({});grants.set(grant,{db,connection:db.raw,userId:id,keys,executionId,signature,assertExecution,fixture:false});return grant;
}
/** Test-only trigger for the fixed fake transport on an owned empty-file DB.
 * It is never accepted by a qualified real-production publication grant. */
export async function authorizeBodyEnergyFixtureDrain({db,userId}={}){
  await memory(db);const grant=Object.freeze({});grants.set(grant,{db,connection:db.raw,userId:requireUserId(userId,'bodyEnergyFixtureDrain'),fixture:true});return grant;
}
export async function assertBodyEnergyFinalizedDrain(grant,db,userId,{fixture=false}={}){
  const authority=grants.get(grant);if(!authority||authority.db!==db||authority.connection!==db.raw||authority.userId!==userId||authority.fixture!==fixture)fail();
  if(fixture){await memory(db);return;}
  authority.assertExecution();
  const row=(await db.raw.execute({sql:`SELECT execution_id,identity_digest,scope_key,generation,release_sha,config_proof,
    result_digest,phase,state,execution_mode,finalized_at FROM phase4_executions WHERE execution_id=?`,args:[authority.executionId]})).rows[0];
  if(!row||row.state!=='FINALIZED_SUCCESS'||row.phase!=='STAGE6_DRAIN'||row.execution_mode!=='SHADOW'
    ||row.finalized_at>Date.now()||authority.keys.lookup(['body-energy-finalized-drain-v1',row])!==authority.signature)fail();
  authority.assertExecution();
}

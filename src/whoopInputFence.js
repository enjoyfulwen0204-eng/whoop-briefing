import {currentDurableExecution} from './phase4ExecutionContext.js';
const fail=()=>{throw Object.assign(Error('WHOOP_INPUT_FENCED'),{code:'WHOOP_INPUT_FENCED'});};
/** Authorization/privacy/calendar metadata only. The digest is never a cached
 * provider fragment and excludes source generation advanced by these writes. */
export async function captureWhoopInput({db,userId,expectedLifecycleGeneration,timezone}){
 const execution=currentDurableExecution();if(!execution)return null;
 execution.authority.assert();
 const row=(await db.raw.execute({sql:`SELECT u.id,u.status,u.lifecycle_generation,u.timezone,
  COALESCE(t.auth_generation,0) auth_generation,t.whoop_user_id,p.purge_generation,p.pending_purge_count
  FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id
  LEFT JOIN phase4_user_state p ON p.user_id=u.id WHERE u.id=?`,args:[userId]})).rows[0];
 execution.authority.assert();
 if(!row||row.id!==userId||row.status!=='ACTIVE'||row.timezone!==timezone||row.pending_purge_count!==0
  ||[row.lifecycle_generation,row.auth_generation,row.purge_generation].some(v=>!Number.isSafeInteger(v)||v<0)
  ||row.lifecycle_generation<1||expectedLifecycleGeneration!==null&&row.lifecycle_generation!==expectedLifecycleGeneration)fail();
 return execution.keys.lookup(['whoop-input-fence-v1',userId,row.lifecycle_generation,row.auth_generation,row.whoop_user_id??null,row.purge_generation,row.timezone]);
}
export async function assertWhoopInput(options,proof){
 if(proof!==null&&await captureWhoopInput(options)!==proof)fail();
}

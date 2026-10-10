import {assertExecutionWorkOwner,currentDurableExecution} from './phase4ExecutionContext.js';
const fail=()=>{throw Object.assign(Error('WHOOP_INPUT_FENCED'),{code:'WHOOP_INPUT_FENCED'});};
/** Authorization/privacy/calendar metadata only. The digest is never a cached
 * provider fragment and excludes source generation advanced by these writes. */
export async function captureWhoopInput({db,userId,expectedLifecycleGeneration,timezone,initialize=false}){
 const execution=currentDurableExecution();if(!execution)return null;
 execution.authority.assert();
 let row=(await db.raw.execute({sql:`SELECT u.id,u.status,u.lifecycle_generation,u.timezone,
  COALESCE(t.auth_generation,0) auth_generation,t.whoop_user_id,p.user_id state_user_id,p.purge_generation,p.pending_purge_count
  FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id
  LEFT JOIN phase4_user_state p ON p.user_id=u.id WHERE u.id=?`,args:[userId]})).rows[0];
 execution.authority.assert();
 if(!row||row.id!==userId||row.status!=='ACTIVE'||row.timezone!==timezone
  ||[row.lifecycle_generation,row.auth_generation].some(v=>!Number.isSafeInteger(v)||v<0)
  ||row.lifecycle_generation<1||expectedLifecycleGeneration!==null&&row.lifecycle_generation!==expectedLifecycleGeneration)fail();
 if(row.state_user_id===null&&initialize){
  if(typeof db.getCapabilities!=='function'||typeof db.withRuntimeFence!=='function')fail();
  const origin=[row.id,row.status,row.lifecycle_generation,row.timezone,row.auth_generation,row.whoop_user_id??null];
  const check=async(client=db.raw)=>{
   execution.authority.assert();await assertExecutionWorkOwner(client);
   const current=(await client.execute({sql:`SELECT u.id,u.status,u.lifecycle_generation,u.timezone,
     COALESCE(t.auth_generation,0) auth_generation,t.whoop_user_id FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id WHERE u.id=?`,args:[userId]})).rows[0];
   if(!current||JSON.stringify([current.id,current.status,current.lifecycle_generation,current.timezone,current.auth_generation,current.whoop_user_id??null])!==JSON.stringify(origin))fail();
   execution.authority.assert();
  };
  // Existing admitted privacy initializer owns atomic setup and schema defaults.
  // Never substitute a number for a missing authoritative epoch.
  await db.withRuntimeFence(check,()=>db.getCapabilities(userId));
  return captureWhoopInput({db,userId,expectedLifecycleGeneration,timezone,initialize:false});
 }
 if(row.state_user_id!==userId||row.pending_purge_count!==0||!Number.isSafeInteger(row.purge_generation)||row.purge_generation<0)fail();
 return execution.keys.lookup(['whoop-input-fence-v1',userId,row.lifecycle_generation,row.auth_generation,row.whoop_user_id??null,row.purge_generation,row.timezone]);
}
export async function assertWhoopInput(options,proof){
 if(proof!==null&&await captureWhoopInput({...options,initialize:false})!==proof)fail();
}

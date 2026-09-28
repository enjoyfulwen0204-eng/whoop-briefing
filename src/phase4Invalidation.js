/** Additional semantic mutations only. Existing WHOOP/Journal/privacy hooks
 * retain ownership of their own invalidations. No worker admission occurs here. */
export function createPhase4Invalidation({client,transaction,queue}) {
  const definitions={
    updateUser:{reason:'TIMEZONE_CHANGED',sql:'SELECT timezone FROM users WHERE id=?'},
    transitionUserLifecycle:{reason:'LIFECYCLE_CHANGED',sql:'SELECT status,lifecycle_generation FROM users WHERE id=?',object:true},
    saveTokens:{reason:'AUTH_CHANGED',sql:'SELECT auth_generation,scope FROM user_whoop_tokens WHERE user_id=?'},
    saveCapabilities:{reason:'SOURCE_CHANGED',sql:'SELECT key,status,lifecycle_generation FROM whoop_capabilities WHERE user_id=? ORDER BY key'},
    recordResourceAccess:{reason:'AUTH_CHANGED',sql:'SELECT resource,status,auth_generation,lifecycle_generation FROM whoop_resource_access WHERE user_id=? ORDER BY resource'},
  };
  function wrap(store) {
    return Object.fromEntries(Object.entries(store).map(([name,fn])=>{
      const definition=definitions[name];if(!definition)return [name,fn];
      return [name,async(...args)=>{
        const ready=(await client.execute("SELECT 1 FROM pragma_table_info('phase4_jobs') WHERE name='unresolved_since'")).rows.length;
        if(!ready)return fn(...args);
        return transaction(async()=>{
        const userId=definition.object?args[0]?.userId:args[0];
        const state=(await client.execute({sql:'SELECT source_generation FROM phase4_user_state WHERE user_id=?',args:[userId]})).rows[0];
        if(!state)return fn(...args);
        const before=JSON.stringify((await client.execute({sql:definition.sql,args:[userId]})).rows);
        const result=await fn(...args);
        const after=JSON.stringify((await client.execute({sql:definition.sql,args:[userId]})).rows);
        if(before!==after)await queue.advanceSource(userId,definition.reason,{removal:true});
        return result;
        });
      }];
    }));
  }
  return {wrap};
}

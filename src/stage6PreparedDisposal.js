// Erasure protection only. This marker has no processing authority or expiry
// based GC: an unresolved physical lifetime must block purge, not claim erasure.
export const PREPARED_DISPOSAL_EXPIRY='9999-12-31T23:59:59.999Z';
const kind='PREPARED_HEALTH_DISPOSAL_V1',hex=/^[a-f0-9]{64}$/;
const prefix=(keys,uid)=>`p4ctx:${keys.lookup(['context-tenant-v1',uid])}:prepared-disposal:`;
export function preparedDisposalFence(keys,userId,claim,purgeGeneration){
 const fields=[purgeGeneration,kind,claim.executionId,claim.identity,claim.owner,claim.generation],name=prefix(keys,userId)+claim.executionId;
 return {name,owner:JSON.stringify([...fields,keys.lookup(['prepared-health-disposal-v1',userId,name,fields])]),expiresAt:PREPARED_DISPOSAL_EXPIRY};
}
export function isPreparedDisposalFence(keys,userId,row,captured){
 const named=typeof row.name==='string'&&row.name.startsWith(prefix(keys,userId));
 if(!named&&captured?.[1]!==kind)return false;
 const fields=captured?.slice(0,6),valid=named&&Array.isArray(captured)&&captured.length===7&&Number.isSafeInteger(captured[0])&&captured[0]>=0
  &&captured[1]===kind&&typeof captured[2]==='string'&&row.name===prefix(keys,userId)+captured[2]
  &&hex.test(captured[3])&&typeof captured[4]==='string'&&captured[4].length>0&&Number.isSafeInteger(captured[5])&&captured[5]>0
  &&row.expires_at===PREPARED_DISPOSAL_EXPIRY&&captured[6]===keys.lookup(['prepared-health-disposal-v1',userId,row.name,fields]);
 if(!valid)throw Object.assign(Error('PHASE4_PREPARED_DISPOSAL_FENCE_CORRUPT'),{code:'PHASE4_PREPARED_DISPOSAL_FENCE_CORRUPT'});
 return true;
}

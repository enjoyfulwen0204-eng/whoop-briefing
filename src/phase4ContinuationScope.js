export const STAGE6_SHADOW_CONTINUATION_SCOPE='stage6-shadow';
export const SYNC_CONTINUATION_SCOPE='sync';
export const SYNC_STAGE6_CONTINUATION_SCOPE='sync-and-stage6-shadow';
export const scopeIncludesSync=scope=>[SYNC_CONTINUATION_SCOPE,SYNC_STAGE6_CONTINUATION_SCOPE].includes(scope);
export const scopeIncludesDrain=scope=>[STAGE6_SHADOW_CONTINUATION_SCOPE,SYNC_STAGE6_CONTINUATION_SCOPE].includes(scope);
/** An explicit scope is an authenticated configuration fence, not a grant.
 * Ordinary SYNC and OFF profiles retain their existing absent/off proof. */
export function continuationScope(environment={},executionMode) {
 const scope=environment.BRIEFING_CONTINUATION_SCOPE;
 if(scope===undefined||scope==='off')return null;
 if(scope===SYNC_CONTINUATION_SCOPE&&['OFF','SHADOW'].includes(executionMode))return scope;
 if(!scopeIncludesDrain(scope)||executionMode!=='SHADOW')
  throw Object.assign(Error('CONTINUATION_SCOPE_REJECTED'),{code:'CONTINUATION_SCOPE_REJECTED'});
 return scope;
}

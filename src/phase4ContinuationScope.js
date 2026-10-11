export const STAGE6_SHADOW_CONTINUATION_SCOPE='stage6-shadow';
/** An explicit scope is an authenticated configuration fence, not a grant.
 * Ordinary SYNC and OFF profiles retain their existing absent/off proof. */
export function continuationScope(environment={},executionMode) {
 const scope=environment.BRIEFING_CONTINUATION_SCOPE;
 if(scope===undefined||scope==='off')return null;
 if(scope!==STAGE6_SHADOW_CONTINUATION_SCOPE||executionMode!=='SHADOW')
  throw Object.assign(Error('CONTINUATION_SCOPE_REJECTED'),{code:'CONTINUATION_SCOPE_REJECTED'});
 return scope;
}

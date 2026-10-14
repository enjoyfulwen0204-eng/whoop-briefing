// Private synthetic RAM receiver lifecycle. No global request/budget scopes.
const owners=new WeakMap(),live=new Set();let created=0,closed=0,disabled=0,retainedEnabled=0;
export function ownRamScopes(client){if(owners.has(client))throw Error('RAM_SCOPE_OWNER_DUPLICATE');const owner={scopes:new Set(),terminal:false};owners.set(client,owner);live.add(owner);created++;}
export function shareRamScopes(base,executor){const owner=owners.get(base);if(owner)owners.set(executor,owner);}
export function registerRamScopes(client,...scopes){const owner=owners.get(client);if(!owner)return;if(owner.terminal)throw Error('RAM_SCOPE_OWNER_CLOSED');for(const s of scopes)owner.scopes.add(s);}
export function closeRamScopes(client,{retainForDiagnostic=false}={}){
 const owner=owners.get(client);if(!owner||owner.terminal)return;
 if(!client.closed)throw Error('RAM_SCOPE_CONNECTION_NOT_CLOSED');
 owner.terminal=true;closed++;for(const s of owner.scopes){if(retainForDiagnostic){if(s.enabled)retainedEnabled++;}else{s.disable();disabled++;}}
 owner.scopes.clear();live.delete(owner);
}
export function ramScopeCounters(){return {created,closed,disabled,retainedEnabled,liveOwners:live.size,liveScopes:[...live].reduce((n,o)=>n+o.scopes.size,0)};}

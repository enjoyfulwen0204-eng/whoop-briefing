// Receiver instance scopes only. Module-global execution/budget scopes never register.
const owners=new WeakMap(),live=new Set();let created=0,retired=0,disabled=0;
export function ownReceiverScopes(client){
 if(owners.has(client))throw Error('RECEIVER_OWNER_DUPLICATE');
 const owner={client,scopes:new Set(),active:0,closing:false,terminal:false};owners.set(client,owner);live.add(owner);created++;
}
export function shareReceiverScopes(base,alias){const owner=owners.get(base);if(owner)owners.set(alias,owner);}
function settle(owner){
 if(!owner.closing||owner.active||owner.terminal)return;
 if(!owner.client.closed)throw Error('RECEIVER_CONNECTION_NOT_CLOSED');
 owner.terminal=true;for(const scope of owner.scopes){scope.disable();disabled++;}
 owner.scopes.clear();live.delete(owner);retired++;
}
export function registerReceiverScopes(client,...scopes){
 const owner=owners.get(client);if(!owner)return;if(owner.closing)throw Error('RECEIVER_OWNER_CLOSED');
 for(const scope of scopes){if(owner.scopes.has(scope))continue;owner.scopes.add(scope);const run=scope.run.bind(scope);
  scope.run=function(store,fn,...args){
   if(owner.terminal)throw Error('RECEIVER_OWNER_CLOSED');owner.active++;
   const done=()=>{owner.active--;settle(owner);};let value;
   try{value=run(store,fn,...args);}catch(error){done();throw error;}
   if(value&&typeof value.then==='function')return Promise.resolve(value).finally(done);
   done();return value;
  };
 }
}
export function retireReceiverScopes(client){const owner=owners.get(client);if(!owner||owner.terminal)return;
 if(!client.closed)throw Error('RECEIVER_CONNECTION_NOT_CLOSED');owner.closing=true;settle(owner);
}
export function receiverScopeStatistics(){return {created,retired,disabled,liveReceivers:live.size,activeCallbacks:[...live].reduce((n,o)=>n+o.active,0),liveScopes:[...live].reduce((n,o)=>n+o.scopes.size,0)};}

import {AsyncLocalStorage} from 'node:async_hooks';
// Receiver instance scopes only. Module-global execution/budget scopes never register.
const same=Object.is,slotSymbol=Symbol;
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
 owner.sharedScope?.disable();owner.scopes.clear();live.delete(owner);retired++;
}
// Internal three-method scope facade. Distinct logical scopes keep distinct
// private slots, while one managed receiver uses one native propagation key.
// Native default ALS remains authoritative; no alternative backend/flags.
export function createReceiverScope(client){
 const owner=owners.get(client);
 if(!owner)return new AsyncLocalStorage();
 if(owner.closing)throw Error('RECEIVER_OWNER_CLOSED');
 if(!owner.sharedScope){const storage=new AsyncLocalStorage();
  owner.sharedScope={run:storage.run.bind(storage),get:storage.getStore.bind(storage),disable:storage.disable.bind(storage)};
 }
 const shared=owner.sharedScope,slot=slotSymbol();let enabled=false;
 const getStore=()=>{if(owner.terminal||!enabled)return undefined;
  for(let frame=shared.get();frame;frame=frame.parent)if(frame.slot===slot)return frame.value;
  return undefined;
 };
 // Keep only one current frame per logical slot. Rebuild only the private
 // prefix above the replaced slot; existing branches remain immutable.
 const withoutCurrentSlot=parent=>{
  let match=parent;while(match&&match.slot!==slot)match=match.parent;
  if(!match)return parent;
  let prefix=null;for(let f=parent;f!==match;f=f.parent)prefix={frame:f,previous:prefix};
  let tail=match.parent;for(let p=prefix;p;p=p.previous){const f=p.frame;tail={slot:f.slot,value:f.value,parent:tail};}
  return tail;
 };
 return {getStore,run(store,fn,...args){
  if(owner.terminal)throw Error('RECEIVER_OWNER_CLOSED');
  const parent=shared.get();
  // Native ALS returns early for an equal store, even disabled+undefined.
  // Do not re-enable a logical scope when native run would not enable it.
  if(same(getStore(),store))return shared.run(parent,fn,...args);
  enabled=true;return shared.run({slot,value:store,parent:withoutCurrentSlot(parent)},fn,...args);
 },disable(){enabled=false;}};
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

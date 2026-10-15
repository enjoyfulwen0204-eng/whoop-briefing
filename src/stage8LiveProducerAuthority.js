const grants=new WeakMap(),executions=new WeakMap();
const fail=()=>{throw Object.assign(Error('STAGE8_LIVE_PRODUCING_AUTHORITY_REQUIRED'),{code:'STAGE8_LIVE_PRODUCING_AUTHORITY_REQUIRED'});};
/** Server composition only. A request, SHADOW capability or read grant cannot
 * mint this identity. Allocation, release/config and tenant policy are bound. */
export async function authorizeStage8LiveProducer({db,keys,admission,releaseSha,configProof,enabled,eligible}={}){
 const {requireRuntimeAdmission,followRuntimeRenewal}=await import('./runtimeAdmission.js');
 if(requireRuntimeAdmission(db.raw,admission,keys,db.transaction)!==35||!/^([a-f0-9]{40})$/.test(releaseSha??'')
 ||!/^([a-f0-9]{64})$/.test(configProof??'')||typeof enabled!=='function'||typeof eligible!=='function'||!enabled())fail();
 const client=db.raw,transaction=db.transaction;let currentAdmission=admission;
 followRuntimeRenewal(client,admission,keys,transaction,next=>{currentAdmission=next;});
 const capability=Object.freeze({});grants.set(capability,Object.freeze({db,client,transaction,keys,get admission(){return currentAdmission;},assertAdmission:()=>requireRuntimeAdmission(client,currentAdmission,keys,transaction),releaseSha,configProof,enabled,eligible}));return capability;
}
export function liveProducerConfiguration(capability,client,keys,userId){
 const g=grants.get(capability);if(!g||g.client!==client||g.keys!==keys||!g.enabled()||(userId!==undefined&&!g.eligible(userId)))fail();
 if(g.assertAdmission()!==35)fail();return g;
}
export function hasLiveProducingAuthority(capability,client,keys,userId){try{return Boolean(liveProducerConfiguration(capability,client,keys,userId));}catch{return false;}}
export const liveScopeDigest=(keys,c)=>keys.lookup(['stage8-live-execution-scope-v1',c.userId,c.inputGeneration,c.sourceGeneration,
 c.lifecycleGeneration,c.authGeneration,c.purgeGeneration,c.algorithmSetVersion,c.timezone]);
export function registerLiveExecution(capability,execution,client,keys,userId,context){
 const g=liveProducerConfiguration(capability,client,keys,userId),claim=execution?.claim,request=claim?.request;
 if(!claim||!Object.isFrozen(claim)||!Object.isFrozen(request)||request.executionMode!=='LIVE'||request.phase!=='STAGE6_DRAIN'
  ||request.contract!=='stage8-live-producer-v1'||request.releaseSha!==g.releaseSha||request.configProof!==g.configProof
  ||context?.userId!==userId||context.executionMode!=='LIVE'||request.tenantScope!==liveScopeDigest(keys,context)
  ||claim.executionId!==request.requestId||claim.generation<1||!claim.owner||!execution.authority?.assert)fail();
 executions.set(execution,Object.freeze({capability,client,keys,userId,claim,request}));
}
export function isLiveExecution(execution,client,keys,userId,context){
 const g=executions.get(execution);if(!g||execution.claim!==g.claim||execution.claim?.request!==g.request||g.client!==client||(keys&&g.keys!==keys)||(userId!==undefined&&g.userId!==userId))return false;
 if(context&&liveScopeDigest(g.keys,context)!==g.request.tenantScope)return false;
 try{liveProducerConfiguration(g.capability,client,g.keys,g.userId);return true;}catch{return false;}
}

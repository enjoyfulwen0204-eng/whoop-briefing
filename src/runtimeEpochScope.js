/** The supervisor alone captures one authenticated
 * epoch BEFORE constructing business runtime; every primary/secondary receives
 * this same opaque scope. Constructors never infer a new scope from the DB.
 * The fixed production bootstrap owns observation and exact catalog admission.
 * Scope revocation closes admission; lifecycle drain owns native disposal.
 */
import {createOwnedCommitGuardedTransaction} from './commitSubmissionGuard.js';
import {requirePhase4Keys} from './phase4Keys.js';
import {shareReceiverScopes,retireReceiverScopes} from './receiverScopeLifetime.js';
import {assertSupervisorEpochAdmission,bindFixedEpochPermitClientFromAdmission,requireSupervisorEpochAdmissionCatalog} from './epochPermitClient.js';
const scopes=new WeakMap(),bindings=new WeakMap(),fail=code=>{throw Object.assign(Error(code),{code});};

/** A JSON/caller epoch label/token cannot mint a scope. Admission identity must
 * belong to the authenticated issuer, with the candidate's canonical key brand.
 * Same key bytes from a fresh canonical key object intentionally remain valid.
 */
export function createSupervisorRuntimeEpochScope({epochAdmission,keys}={}){
 const evidence=assertSupervisorEpochAdmission(epochAdmission,keys),scope=Object.freeze({contract:'stage8-supervisor-runtime-epoch-scope-v1',productionAuthority:'NONE'});
 scopes.set(scope,{epochAdmission,evidence,revoked:false,clients:new Set()});return scope;
}
function state(scope,keys){
 const s=scopes.get(scope);if(!s)fail('RUNTIME_EPOCH_ORIGINAL_OPAQUE_SCOPE_REQUIRED');requirePhase4Keys(keys);
 assertSupervisorEpochAdmission(s.epochAdmission,keys);if(s.revoked)fail('RUNTIME_EPOCH_SCOPE_PERMANENTLY_REVOKED');return s;
}
export function requireSupervisorRuntimeEpochScope(scope,keys,{url}={}){
 const s=state(scope,keys);if(url!==undefined){let actual;try{actual=new URL(url).href;}catch{fail('RUNTIME_EPOCH_EXACT_DATABASE_TARGET_REQUIRED');}if(actual!==s.evidence.targetUrl)fail('RUNTIME_EPOCH_EXACT_DATABASE_TARGET_REQUIRED');}
 return Object.freeze({productionAuthority:'NONE',epochLabel:s.evidence.epochLabel,schema:s.evidence.schema});
}
/** Called only by owned createDb/createOwnedFileDb, after native construction.
 * No constructor await or registry read. The raw native receiver is retained by
 * the R2 adapter closure, never exposed as stage6OwnedBinding(db).base.
 */
export function bindSupervisorRuntimeEpochOwnedClient({scope,keys,base,url}={}){
 requireSupervisorRuntimeEpochScope(scope,keys,{url});if(bindings.has(base))fail('RUNTIME_EPOCH_OWNED_RECEIVER_ALREADY_BOUND');const s=state(scope,keys),adapter=bindFixedEpochPermitClientFromAdmission({base,keys,admission:s.epochAdmission});let ended=false;
 const check=()=>{state(scope,keys);if(ended||adapter.closed)fail('RUNTIME_EPOCH_OWNED_CONNECTION_CLOSED');};
 const wrapTransaction=tx=>createOwnedCommitGuardedTransaction({transaction:tx,guard:check,closed:()=>s.revoked||ended||tx.closed});
 const client={
  protocol:adapter.protocol,epochLabel:s.evidence.epochLabel,get closed(){return s.revoked||ended||adapter.closed;},
  execute(...args){check();return adapter.execute(...args);},batch(...args){check();return adapter.batch(...args);},executeMultiple(...args){check();return adapter.executeMultiple(...args);},
  async transaction(...args){check();const tx=await adapter.transaction(...args);try{check();return wrapTransaction(tx);}catch(error){try{await tx.rollback();}catch{}tx.close();throw error;}},
  async reconnect(...args){check();await adapter.reconnect(...args);check();},
  close(){
   ended=true;try{return adapter.close();}finally{if(base.closed){retireReceiverScopes(base);s.clients.delete(client);}}
  },
 };
 Object.preventExtensions(client);bindings.set(base,{scope,base});bindings.set(client,{scope,base});s.clients.add(client);shareReceiverScopes(base,client);return client;
}
/** Permanent in-process revocation only. Native disposal belongs to the
 * managed lifecycle AFTER closeAdmission/stopBackground/waitForDrained. Closing
 * an open native transaction here can panic the installed local driver, and
 * closing any remote handle is not SQL cancellation. Already submitted packets
 * are fenced only by the separately committed durable DB epoch transition.
 */
export function revokeSupervisorRuntimeEpochScope(scope,keys){
 const s=scopes.get(scope);if(!s)fail('RUNTIME_EPOCH_ORIGINAL_OPAQUE_SCOPE_REQUIRED');assertSupervisorEpochAdmission(s.epochAdmission,keys);s.revoked=true;
 return Object.freeze({revoked:true,remainingOwnedConnections:s.clients.size,nativeDisposalRequested:false,remoteSqlCancelled:false});
}
export function supervisorRuntimeEpochScopeState(scope,keys){
 const s=scopes.get(scope);if(!s)fail('RUNTIME_EPOCH_ORIGINAL_OPAQUE_SCOPE_REQUIRED');assertSupervisorEpochAdmission(s.epochAdmission,keys);
 return Object.freeze({productionAuthority:'NONE',epochLabel:s.evidence.epochLabel,schema:s.evidence.schema,revoked:s.revoked,ownedConnections:s.clients.size});
}

/** Captured fixed manifest for canonical runtime admission. This export checks
 * permanent scope validity/key continuity, clones exact immutable trigger rows
 * and never reads provider state or adopts a newer phase/release.
 */
export function requireSupervisorRuntimeEpochCatalog(scope,keys){
 const s=state(scope,keys);return requireSupervisorEpochAdmissionCatalog(s.epochAdmission,keys);
}

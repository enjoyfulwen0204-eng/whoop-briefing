/** Fixed production epoch adapter. The authenticated bootstrap owns native
 * observation; captured scopes never refresh their original epoch token.
 * No local backup issuer, caller client or JSON transport can mint admission.
 */
import {requireProductionEpochBootstrap,PRODUCTION_EPOCH_TARGET} from './productionEpochBootstrap.js';
import {createHash} from 'node:crypto';
import {requirePhase4Keys} from './phase4Keys.js';
import {readOnlyStatement} from './processingTransaction.js';
const fail=code=>{throw Object.assign(Error(code),{code});};
const sha=x=>createHash('sha256').update(x).digest('hex'),json=JSON.stringify;
const ident=x=>{if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(x))fail('EPOCH_FIXED_IDENTIFIER_REQUIRED');return '"'+x+'"';};
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const supervisorAdmissions=new WeakMap();
// Split only supported application DML/reads. DDL, PRAGMA mutations, transaction
// control and unknown methods are fail-closed; they never reach the native SDK.
function split(sql){
 if(typeof sql!=='string'||sql.length>4*1024*1024)fail('EPOCH_BOUNDED_SQL_REQUIRED');const result=[];let start=0,quote=null,line=false,block=false;
 for(let i=0;i<sql.length;i++){const c=sql[i],n=sql[i+1];if(line){if(c==='\n')line=false;continue;}if(block){if(c==='*'&&n==='/'){block=false;i++;}continue;}if(quote){const end=quote==='['?']':quote;if(c===end){if(n===end)i++;else quote=null;}continue;}if(c==='-'&&n==='-'){line=true;i++;continue;}if(c==='/'&&n==='*'){block=true;i++;continue;}if(['\'', '"','`','['].includes(c)){quote=c;continue;}if(c===';'){const part=sql.slice(start,i).trim();if(part)result.push(part);start=i+1;}}
 if(quote||block)fail('EPOCH_COMPLETE_SQL_REQUIRED');const tail=sql.slice(start).trim();if(tail)result.push(tail);if(result.length>1000)fail('EPOCH_BOUNDED_SQL_REQUIRED');return result;
}
const firstWord=sql=>sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/,'').match(/^[A-Za-z_]+/)?.[0]?.toUpperCase();
function statement(input,args){
 const query=typeof input==='string'?{sql:input,args:args??[]}:Array.isArray(input)?{sql:input[0],args:input[1]??[]}:input;
 if(!query||typeof query.sql!=='string'||split(query.sql).length!==1)fail('EPOCH_SINGLE_APPLICATION_STATEMENT_REQUIRED');
 const copy={sql:query.sql,args:Array.isArray(query.args??[])?[...(query.args??[])]:{...query.args}},read=readOnlyStatement(copy);
 if(!read&&!['INSERT','UPDATE','DELETE','REPLACE','WITH'].includes(firstWord(copy.sql)))fail('EPOCH_APPLICATION_DML_ONLY');return {query:copy,read};
}
function buildFixedEpochPermitClient({base,keys,s,epoch}){
 const permit={key:s.permitKey,value:epoch.epochToken,updated_at:epoch.updated_at},insert={sql:'INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?)',args:[permit.key,permit.value,permit.updated_at]},remove={sql:'DELETE FROM telegram_state WHERE key=? AND value=? AND updated_at=?',args:[permit.key,permit.value,permit.updated_at]};
 const transactions=new Set();let ended=false;
 async function transaction(mode='write'){
  if(ended)fail('EPOCH_CLIENT_CLOSED');if(!['write','deferred','read'].includes(mode))fail('EPOCH_WRITE_TRANSACTION_REQUIRED');
  const raw=await base.transaction('write');let removed=false,phase='OPEN',active=0,restoring=null;
  try{if(ended)fail('EPOCH_CLIENT_CLOSED');await raw.execute(insert);}catch(error){try{await raw.rollback();}catch{}raw.close();throw error;}
  const requireOpen=()=>{if(phase!=='OPEN'||raw.closed)fail('EPOCH_TRANSACTION_NOT_OPEN');};
  async function ensure(){
   requireOpen();
   if(removed){
    if(!restoring)restoring=Promise.resolve().then(()=>raw.execute(insert)).then(()=>{removed=false;}).finally(()=>{restoring=null;});
    await restoring;requireOpen();
   }
  }
  async function operation(run){
   requireOpen();active++;
   try{await ensure();return await run();}catch(error){phase='FAILED';throw error;}finally{active--;}
  }
  const definiteBusy=error=>!raw.closed&&[error,error?.cause].some(e=>/^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(e?.code??''));
  const tx=Object.freeze({
   get closed(){return phase==='CLOSED'||raw.closed;},
   async execute(input,args){const q=statement(input,args);if(mode==='read'&&!q.read)fail('EPOCH_READ_TRANSACTION_MUTATION');return operation(()=>raw.execute(q.query));},
   async batch(inputs){const qs=inputs.map(q=>statement(q));if(mode==='read'&&qs.some(q=>!q.read))fail('EPOCH_READ_TRANSACTION_MUTATION');return operation(()=>raw.batch(qs.map(q=>q.query)));},
   async executeMultiple(sql){const qs=split(sql).map(q=>statement(q));if(mode==='read'&&qs.some(q=>!q.read))fail('EPOCH_READ_TRANSACTION_MUTATION');await operation(()=>raw.batch(qs.map(q=>q.query)));},
   async commit(){
    requireOpen();if(active)fail('EPOCH_TRANSACTION_OPERATIONS_PENDING');
    // The submission barrier precedes the first await, including permit removal.
    // No application operation can reinsert a permit while COMMIT is pending.
    phase='COMMITTING';
    try{
     if(!removed){const result=await raw.execute(remove);if(result.rowsAffected!==1)fail('EPOCH_PERMIT_TAIL_MISSING');removed=true;}
     await raw.commit();phase='CLOSED';transactions.delete(tx);
    }catch(error){
     // Only an explicit SQLite contention rejection on a still-open native
     // transaction permits final-check retry. Network/unknown outcomes stay shut.
     phase=phase==='CLOSED'?'CLOSED':definiteBusy(error)?'OPEN':'UNKNOWN';throw error;
    }
   },
   async rollback(){
    if(phase==='COMMITTING')fail('EPOCH_TRANSACTION_COMMIT_PENDING');
    phase='ROLLING_BACK';try{return await raw.rollback();}finally{phase='CLOSED';transactions.delete(tx);}
   },
   close(){phase='CLOSED';try{return raw.close();}finally{transactions.delete(tx);}},
  });transactions.add(tx);return tx;
 }
 // Standalone writes use the SDK's real one-request batch/BEGIN IMMEDIATE.
 // Its COMMIT is conditional on every step, including removal/tail CHECK.
 // Lost acknowledgement may leave business outcome unknown, never a committed
 // permit. No transaction-control SQL supplied by an application is accepted.
 const tailGuard=ident('stage8_permit_tail_'+keys.lookup(['stage8-transition-tail-guard-v1',s.attempt,epoch.label]).slice(0,20));
 async function ownWrite(queries){
  if(ended)fail('EPOCH_CLIENT_CLOSED');const results=await base.batch([
   {sql:`CREATE TEMP TABLE ${tailGuard}(ok INTEGER NOT NULL CHECK(ok=1))`,args:[]},insert,...queries,remove,
   {sql:`INSERT INTO temp.${tailGuard}(ok) SELECT CASE WHEN changes()=1 AND NOT EXISTS(SELECT 1 FROM telegram_state WHERE key=?) THEN 1 ELSE 0 END`,args:[permit.key]},
   {sql:`DROP TABLE temp.${tailGuard}`,args:[]},
  ],'write');return results.slice(2,2+queries.length);
 }
 // processingTransactions uses a Proxy that deliberately substitutes execute
 // and batch. Freezing these own properties would violate Proxy invariants.
 // The facade hides the native receiver and stays non-extensible instead.
 const client={
  protocol:base.protocol,epochLabel:epoch.label,get closed(){return ended||base.closed;},
  async execute(input,args){const q=statement(input,args);return q.read?base.execute(q.query):(await ownWrite([q.query]))[0];},
  async batch(inputs,mode='write'){const qs=inputs.map(q=>statement(q));if(mode==='read'&&qs.some(q=>!q.read))fail('EPOCH_READ_TRANSACTION_MUTATION');return qs.every(q=>q.read)?base.batch(qs.map(q=>q.query),mode):ownWrite(qs.map(q=>q.query));},
  transaction,
  async executeMultiple(sql){const qs=split(sql).map(q=>statement(q));if(qs.every(q=>q.read))await base.batch(qs.map(q=>q.query),'read');else await ownWrite(qs.map(q=>q.query));},
  async reconnect(){if(transactions.size)fail('EPOCH_ACTIVE_TRANSACTION_RECONNECT_FORBIDDEN');if(typeof base.reconnect!=='function')fail('EPOCH_RECONNECT_UNAVAILABLE');return base.reconnect();},
  close(){ended=true;for(const tx of transactions)tx.close();return base.close();},
 };return Object.preventExtensions(client);
}
/** Fixed-origin opaque production observation bridge. Only the imported
 * bootstrap's owned/native authenticated observation can enter this WeakMap.
 * Capture ONCE; later constructors/renewals use this immutable fixed state.
 * This read authority remains NONE, never a Production GO or migration grant.
 */
export function captureProductionSupervisorEpochAdmission(options={}){
 if(!options||Object.getPrototypeOf(options)!==Object.prototype||Object.keys(options).sort().join(',')!=='keys,observation')fail('EPOCH_ORIGINAL_PRODUCTION_OBSERVATION_REQUIRED');
 const {observation,keys}=options,a=requireProductionEpochBootstrap(observation,keys);
 if(a.productionAuthority!=='NONE'||a.targetUrl!==PRODUCTION_EPOCH_TARGET.databaseUrl||!Object.isFrozen(a.s)||!Object.isFrozen(a.epoch)||a.epoch.mode!=='BUSINESS'||!['C_BUSINESS35','D_ABORT33'].includes(a.epoch.label)||![33,35].includes(a.epoch.schema)||!/^([a-f0-9]{40})$/.test(a.releaseSha??''))fail('EPOCH_AUTHENTICATED_PRODUCTION_ADMISSION_REQUIRED');
 const expected=a.epoch.schema===33?a.s.sourceTriggers:a.s.targetTriggers;
 if(!Object.isFrozen(expected)||sha(json(expected))!==a.manifestSha)fail('EPOCH_EXACT_CAPTURED_MANIFEST_REQUIRED');
 const admission=Object.freeze({contract:'stage8-production-supervisor-epoch-admission-v1',productionAuthority:'NONE'});
 supervisorAdmissions.set(admission,{s:a.s,epoch:a.epoch,manifestSha:a.manifestSha,targetUrl:a.targetUrl,releaseSha:a.releaseSha});return admission;
}
function supervisorAdmission(admission,keys){
 const a=supervisorAdmissions.get(admission);if(!a)fail('EPOCH_ORIGINAL_OPAQUE_ADMISSION_REQUIRED');requirePhase4Keys(keys);
 if(keys.lookupCheckpoint()!==a.s.keys.lookupCheckpoint()||keys.auditCheckpoint()!==a.s.keys.auditCheckpoint())fail('EPOCH_SUPERVISOR_KEY_CONTINUITY_REQUIRED');return a;
}
export function assertSupervisorEpochAdmission(admission,keys){
 const a=supervisorAdmission(admission,keys);return Object.freeze({productionAuthority:'NONE',epochLabel:a.epoch.label,schema:a.epoch.schema,releaseSha:a.releaseSha,originalWindowId:a.s.originalWindowId,manifestSha256:a.manifestSha,targetUrl:a.targetUrl});
}
/** Synchronous binding from ONE already captured opaque epoch. NO metadata
 * query, token refresh, registry lookup or SQL submission occurs here. */
export function bindFixedEpochPermitClientFromAdmission({base,keys,admission}={}){
 const a=supervisorAdmission(admission,keys);if(!['file','http'].includes(base?.protocol))fail('EPOCH_OWNED_CLIENT_BINDING_REQUIRED');return buildFixedEpochPermitClient({base,keys,s:a.s,epoch:a.epoch});
}

/** Exact immutable catalog exception, chosen only by the captured epoch. No
 * caller prefix, name list, schema choice, SQL policy or fresh observation.
 * DDL is internal metadata; no native receiver or keys object is returned.
 */
export function requireSupervisorEpochAdmissionCatalog(admission,keys){
 const a=supervisorAdmission(admission,keys),statements=a.epoch.schema===33?a.s.sourceTriggers:a.s.targetTriggers;
 if(sha(json(statements))!==a.manifestSha)fail('EPOCH_EXACT_CAPTURED_MANIFEST_REQUIRED');
 const rows=statements.map(q=>{const m=/^CREATE TRIGGER "([^"]+)" BEFORE (?:INSERT|UPDATE|DELETE) ON "([^"]+)"/.exec(q.sql);if(!m||q.args.length)fail('EPOCH_FIXED_CAPTURED_TRIGGER_REQUIRED');return {type:'trigger',name:m[1],tbl_name:m[2],sql:q.sql};});
 return freeze({schema:a.epoch.schema,releaseSha:a.releaseSha,targetUrl:a.targetUrl,manifestSha256:a.manifestSha,rows});
}

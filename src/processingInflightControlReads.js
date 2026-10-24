import {isProxy} from 'node:util/types';
import {memoizedSqlSyntax} from './sqlSyntaxMemo.js';
import {cloneResult} from './processingReadSnapshot.js';
const ownership=`SELECT state,lease_owner,lease_expires_at,requested_generation,
 claimed_generation,scope_revision,claimed_scope_revision,claimed_purge_generation,claimed_lifecycle_generation,
 claimed_auth_generation FROM phase4_jobs WHERE user_id=? AND execution_mode=? AND job_kind=?`;
const tenant='SELECT 1 FROM resource_locks WHERE name=? AND owner=? AND expires_at=? AND expires_at>?';
const contextLease='SELECT owner FROM resource_locks WHERE name=? AND expires_at>?';
export const CONTEXT_LEASE_DATA_SQL='SELECT owner,expires_at FROM resource_locks WHERE name=?';
const normalized=s=>s.replace(/\s+/g,' ').trim();
// SQL text only: no tenant, argument, row, clock or authority is memoized.
// Keep the existing bounded parser contract enum0..3; the legacy time-filtered
// context query is a separate boolean parser. Dynamic checks stay below.
const ownershipSql=normalized(ownership);
function controlSqlShape(sql){
 const shape=normalized(sql);
 return shape===ownershipSql?1:shape===tenant?2:shape===CONTEXT_LEASE_DATA_SQL?3:0;
}
const legacyLeaseSqlShape=sql=>normalized(sql)===contextLease;
// These two exact non-health projections already have snapshot DATA keys.
// Share only a concurrent cold read; every caller repeats its own predicate.
// Keep the enum0..3 parser contract and the retained ownership pool unchanged.
const userStateSql=normalized(`SELECT u.id,u.status,u.timezone,u.lifecycle_generation,
 COALESCE(t.auth_generation,0) auth_generation,p.source_generation,p.purge_generation,p.pending_purge_count
 FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id
 LEFT JOIN phase4_user_state p ON p.user_id=u.id WHERE u.id=?`);
const principalReadinessSql=normalized(`SELECT u.status,o.state,COALESCE(t.auth_generation,0) auth_generation,p.pending_purge_count
 FROM users u JOIN phase4_user_state p ON p.user_id=u.id JOIN user_onboarding o ON o.user_id=u.id
 LEFT JOIN user_whoop_tokens t ON t.user_id=u.id WHERE u.id=?`);
const principalSqlShape=sql=>{const shape=normalized(sql);return shape===userStateSql||shape===principalReadinessSql;};

// Raw non-health DATA only. Every original clock/ownership/authority predicate
// still runs. Keep the entire original query and every clock argument in key.
export function inflightControlReadKey(statement,context){
 if(context?.executionMode!=='LIVE'||context.providerRequired!==true||typeof context.userId!=='string'
   ||!statement||typeof statement!=='object'||Array.isArray(statement))return null;
 const {sql,args}=statement;if(typeof sql!=='string'||!Array.isArray(args)
   ||args.some(value=>typeof value!=='string'||value.length>4096))return null;
 const shape=memoizedSqlSyntax(controlSqlShape,sql);
 const own=shape===1&&args.length===3&&args[0]===context.userId&&args[1]==='LIVE';
 const lock=shape===2&&args.length===4&&args[0]===`phase4-stage6-pass:${JSON.stringify([context.userId,'LIVE'])}`;
 // Name shape is an eligibility filter, never HMAC/tenant authority. The
 // genuine context brand/WeakMap and every original expiry/owner predicate
 // remain in phase4Cache; the pool also keys the exact context object.
 const lease=shape===0&&memoizedSqlSyntax(legacyLeaseSqlShape,sql)&&args.length===2&&/^p4ctx:[a-f0-9]{64}:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(args[0]);
 const leaseData=shape===3&&args.length===1&&(/^p4ctx:[a-f0-9]{64}:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(args[0])||args[0]===`phase4-stage6-pass:${JSON.stringify([context.userId,'LIVE'])}`);
 const principal=shape===0&&args.length===1&&args[0]===context.userId&&memoizedSqlSyntax(principalSqlShape,sql);
 if(!own&&!lock&&!lease&&!leaseData&&!principal)return null;
 const key=JSON.stringify([sql,args]);return Buffer.byteLength(key)<=8192?key:null;
}
// Exact source-control DATA only, separate from control-check eligibility.
// Descriptors avoid evaluating getters, proxies, coercions or serializers.
const sourceAccessSql=normalized(`SELECT status FROM whoop_resource_access
 WHERE user_id=? AND resource=? AND auth_generation=? AND lifecycle_generation=?`);
const sourceCapabilitySql=normalized(`SELECT 1 FROM whoop_capabilities
 WHERE user_id=? AND key=? AND lifecycle_generation=? AND status IN ('UNSUPPORTED','UNAVAILABLE')`);
const sourceTombstoneSql=normalized(`SELECT 1 FROM whoop_resource_tombstones
 WHERE user_id=? AND resource_type=? AND resource_id=? AND state='ACTIVE'`);
const sourceControlSqlShape=sql=>{const shape=normalized(sql);
 return shape===sourceAccessSql?1:shape===sourceCapabilitySql?2:shape===sourceTombstoneSql?3:0;};
const plainData=value=>value&&typeof value==='object'&&!isProxy(value)
 &&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const ownData=(value,key)=>{const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,'value')?d.value:undefined;};
export function inflightSourceControlReadKey(statement,context){
 if(!plainData(context)||ownData(context,'executionMode')!=='LIVE'||ownData(context,'providerRequired')!==true
  ||!plainData(statement)||Reflect.ownKeys(statement).length!==2)return null;
 const uid=ownData(context,'userId'),sql=ownData(statement,'sql'),args=ownData(statement,'args');
 if(typeof uid!=='string'||!uid||uid.length>4096||typeof sql!=='string'||sql.length>4096
  ||isProxy(args)||!Array.isArray(args)||Object.getPrototypeOf(args)!==Array.prototype
  ||args.length<3||args.length>4||Reflect.ownKeys(args).length!==args.length+1)return null;
 const values=[];for(let i=0;i<args.length;i++){
  const value=ownData(args,String(i));
  if(!(typeof value==='string'&&value.length<=4096||Number.isSafeInteger(value)&&value>=0))return null;
  values.push(value);
 }
 if(values[0]!==uid||!['sleep','recovery','cycle','workout'].includes(values[1]))return null;
 const shape=memoizedSqlSyntax(sourceControlSqlShape,sql),auth=ownData(context,'authGeneration'),life=ownData(context,'lifecycleGeneration');
 if(shape===1){if(values.length!==4||!Number.isSafeInteger(auth)||auth<1||!Number.isSafeInteger(life)||life<0
   ||values[2]!==auth||values[3]!==life)return null;}
 else if(shape===2){if(values.length!==3||!Number.isSafeInteger(life)||life<0||values[2]!==life)return null;}
 else if(shape===3){if(values.length!==3||typeof values[2]!=='string'||!values[2])return null;}
 else return null;
 const key=JSON.stringify(['source-control',sql,values]);return Buffer.byteLength(key)<=8192?key:null;
}
// The one clock-free ownership projection may retain raw ROW DATA. No lock,
// time-filtered query, authority predicate or successful guard is retained.
export function ownershipControlReadKey(statement,context){
 const key=inflightControlReadKey(statement,context);
 return key&&memoizedSqlSyntax(controlSqlShape,statement.sql)===1?key:null;
}
export function contextLeaseDataReadKey(statement,context){
 const key=inflightControlReadKey(statement,context);
 return key&&memoizedSqlSyntax(controlSqlShape,statement.sql)===3&&statement.args[0].startsWith('p4ctx:')?key:null;
}
// The tenant-pass namespace remains separate from context registry leases.
export function tenantLeaseDataReadKey(statement,context){
 const key=inflightControlReadKey(statement,context);
 return key&&memoizedSqlSyntax(controlSqlShape,statement.sql)===3
  &&statement.args[0]===`phase4-stage6-pass:${JSON.stringify([context.userId,'LIVE'])}`?key:null;
}
const canonicalTenantLeaseTime=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
 &&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
// ROW DATA only. Recompute all original owner, exact-expiry and current-time
// predicates on every invocation. Noncanonical TEXT uses original SQLite.
export function projectTenantLeaseData(row,expectedOwner,expectedExpiry,at){
 if(row===undefined)return {supported:true,owned:false};
 if(!row||typeof row!=='object'||isProxy(row)||![Object.prototype,null].includes(Object.getPrototypeOf(row)))return {supported:false};
 const d=Object.getOwnPropertyDescriptors(row),owner=d.owner,expiry=d.expires_at;
 if(!owner||!expiry||!Object.hasOwn(owner,'value')||!Object.hasOwn(expiry,'value')||typeof owner.value!=='string'
  ||typeof expectedOwner!=='string'||!canonicalTenantLeaseTime(expiry.value)||!canonicalTenantLeaseTime(expectedExpiry)
  ||!canonicalTenantLeaseTime(at))return {supported:false};
 return {supported:true,owned:owner.value===expectedOwner&&expiry.value===expectedExpiry&&expiry.value>at};
}
// No serializer or user method is invoked to admit a retained row. The
// installed ownership ResultSet contains only one row of primitive columns.
function ownershipDataMemo(){
 let scopes=new Map(),entries=0,bytes=0,epoch=0,closed=false;
 const array=(value,limit)=>{
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length>limit)return null;
  const d=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(d).length!==value.length+1)return null;
  const out=[];for(let i=0;i<value.length;i++){if(!d[i]||!Object.hasOwn(d[i],'value'))return null;out.push(d[i].value);}return out;
 };
 return {
  epoch:()=>epoch,
  get(scope,key){const entry=scopes.get(scope)?.get(key);return !closed&&entry?cloneResult(entry.result):undefined;},
  put(scope,key,result,observedEpoch){
   if(closed||epoch!==observedEpoch||entries>=128)return;
   try{
    const d=Object.getOwnPropertyDescriptors(result),fields=['columns','columnTypes','rows','rowsAffected','lastInsertRowid'];
    if(fields.some(name=>!d[name]||!Object.hasOwn(d[name],'value')))return;
    const columns=array(d.columns.value,16),types=array(d.columnTypes.value,16),rows=array(d.rows.value,1);
    if(!columns||!types||!rows||columns.some(x=>typeof x!=='string')||types.some(x=>typeof x!=='string'))return;
    let size=Buffer.byteLength(key)+256;
    for(const value of [...columns,...types]){if(value.length>4096)return;size+=Buffer.byteLength(value)+16;}
    for(const row of rows){
     if(!row||![Object.prototype,null].includes(Object.getPrototypeOf(row)))return;
     const values=Object.getOwnPropertyDescriptors(row),keys=Reflect.ownKeys(values);if(keys.length>32)return;
     for(const name of keys){const descriptor=values[name];if(typeof name!=='string'||!Object.hasOwn(descriptor,'value'))return;
      const value=descriptor.value,type=typeof value;if(value!==null&&!['undefined','string','number','boolean','bigint'].includes(type)||type==='number'&&!Number.isFinite(value))return;
      if(type==='string'&&value.length>4096||type==='bigint'&&String(value).length>40)return;size+=Buffer.byteLength(name)+16+(type==='string'?Buffer.byteLength(value):0);
     }
    }
    if(![d.rowsAffected.value,d.lastInsertRowid.value].every(x=>x===undefined||typeof x==='number'&&Number.isFinite(x)||typeof x==='bigint'))return;
    if([d.rowsAffected.value,d.lastInsertRowid.value].some(x=>typeof x==='bigint'&&String(x).length>40))return;
    if(size>16384||bytes+size>1048576)return;
    const snapshot=cloneResult(result),stored=scopes.get(scope)??new Map();if(stored.has(key))return;
    stored.set(key,{result:snapshot});scopes.set(scope,stored);entries++;bytes+=size;
   }catch{/* Unsupported DATA stays on its original uncached path. */}
  },
  clear(){scopes.clear();entries=0;bytes=0;epoch++;},
  close(){this.clear();closed=true;},
 };
}
// The existing pending pool remains pending-only for every other shape.
// One pool belongs to one original acknowledged write root. Callers opt in
// only under its original execution, budget and branded readonly check.
export function createInflightControlReads(){
 let contexts=new Map(),entries=0,closed=false;
 const data=ownershipDataMemo();let scopes=new Map(),scopeCount=0,epoch=null,revision=0;
 const clear=()=>{contexts.clear();entries=0;scopes.clear();scopeCount=0;data.clear();revision++;};
 const pool={
  clear,
  isOpen:()=>!closed,
  close(){closed=true;clear();data.close();},
  async ownership(context,marker,key,observedEpoch,read){
   if(closed||!key||!marker)return read();
   // Epochs advance only at original mutation boundaries. A late physical
   // result cannot populate a newer write snapshot or a terminal/closed root.
   if(epoch!==observedEpoch){if(epoch!==null&&observedEpoch<epoch)return read();clear();epoch=observedEpoch;}
   let markers=scopes.get(context),scope=markers?.get(marker);
   if(!scope){if(scopeCount>=64)return pool.run(context,marker,key,observedEpoch,read);
    scope={};markers??=new Map();markers.set(marker,scope);scopes.set(context,markers);scopeCount++;}
   const cached=data.get(scope,key);if(cached!==undefined)return cached;
   const currentRevision=revision,dataEpoch=data.epoch();
   const result=await pool.run(context,marker,key,observedEpoch,read);
   if(!closed&&revision===currentRevision&&epoch===observedEpoch)
    data.put(scope,key,result,dataEpoch);
   return result;
  },
  run(context,marker,key,epoch,read){
   if(closed||!key||!marker)return read();
   const identity=JSON.stringify([epoch,key]),markers=contexts.get(context),rows=markers?.get(marker),prior=rows?.get(identity);
   const copy=(result,joined)=>{try{return cloneResult(result);}catch(error){if(joined)throw error;return result;}};
   if(prior)return prior.promise.then(result=>copy(result,true));
   if(entries>=128)return read();
   // Submit synchronously in the original position, before another caller
   // can submit a mutation. No new queue, timer, retry or transaction exists.
   const value=read(),byMarker=markers??new Map(),pending=rows??new Map(),entry={};
   const remove=()=>{if(pending.get(identity)!==entry)return;pending.delete(identity);
    if(contexts.get(context)===byMarker&&byMarker.get(marker)===pending){entries--;if(!pending.size)byMarker.delete(marker);if(!byMarker.size)contexts.delete(context);}};
   entry.promise=Promise.resolve(value).then(result=>{remove();return result;},error=>{remove();throw error;});
   pending.set(identity,entry);byMarker.set(marker,pending);contexts.set(context,byMarker);entries++;
   return entry.promise.then(result=>copy(result,false));
  },
 };
 return pool;
}

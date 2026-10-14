// LOCAL SYNTHETIC PROTOTYPE ONLY. No production endpoint, schema addition or runtime import.
import {createClient} from '@libsql/client';
import * as applicationDb from '../src/db.js';
import {randomUUID} from 'node:crypto';import {fixtureKeys} from './localDb.js';
import {createPhase4Stage6,authorizeStage6ShadowWorker} from '../src/phase4Reanalysis.js';
import {currentDurableExecution,databaseNowMs,CommitIndeterminateError,requireSettledOperation} from '../src/phase4ExecutionContext.js';
import {reconcileExecution} from '../src/phase4ExecutionStore.js';
import {currentExecutionBudget} from '../src/executionBudget.js';
const clients=new WeakSet(),issued=new WeakMap(),quote=x=>'"'+x.replaceAll('"','""')+'"';
const fail=x=>{throw Object.assign(Error(x),{code:x});};
const json=x=>JSON.stringify(x),maxRows=1000,maxBytes=2*1024*1024;
export function isolatedPublicationClient(fetch){if(typeof fetch!=='function')fail('ISOLATED_FETCH_REQUIRED');const client=createClient({url:'https://isolated.invalid',fetch});clients.add(client);return client;}
const closure=`WITH RECURSIVE ids(id) AS (SELECT ? UNION SELECT producing_execution_id FROM phase4_execution_producers WHERE user_id=? AND execution_mode='SHADOW' UNION SELECT e.sync_execution_id FROM phase4_executions e JOIN ids ON e.execution_id=ids.id WHERE e.sync_execution_id IS NOT NULL) SELECT id FROM ids`;
function projection(table,columns,userId,executionId){
 if(table==='users')return {where:'id=?',args:[userId]};
 if(columns.includes('user_id'))return {where:'user_id=?',args:[userId]};
 if(table==='phase4_executions')return {where:`execution_id IN (${closure})`,args:[executionId,userId]};
 if(table==='phase4_execution_work_receipts')return {where:`execution_id IN (${closure})`,args:[executionId,userId]};
 if(table==='system_heartbeats')return {where:"scope IN ('global',?)",args:['user:'+userId]};
 if(table==='resource_locks'){const prefix=`p4ctx:${fixtureKeys.lookup(['context-tenant-v1',userId])}:`;return {where:'name=? OR substr(name,1,?)=?',args:[`phase4-stage6-pass:${JSON.stringify([userId,'SHADOW'])}`,prefix.length,prefix]};}
 if(['schema_version','phase4_migration_checkpoints','schema_migration_progress','migration_progress','schema_migration_steps'].includes(table))return {where:'1',args:[]};
 return {where:'0',args:[]};
}
function payloadQuery(table,columns,pk,filter){
 const select=`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)} WHERE ${filter.where} ORDER BY ${(pk.length?pk:columns).map(quote).join(',')} LIMIT ${maxRows+1}`;
 return {sql:select,args:filter.args};
}
async function prepareDataUnit({client,userId='a',maxItems=1},contextGuard){
 const execution=currentDurableExecution(),budget=currentExecutionBudget();if(!clients.has(client)||userId!=='a'||execution?.claim?.request?.phase!=='STAGE6_DRAIN'||execution?.claim?.request?.executionMode!=='SHADOW')fail('ISOLATED_TENANT_SCOPE_REQUIRED');if(!execution?.claim||!budget)fail('PREPARATION_AUTHORITY_REQUIRED');budget.assert();execution.authority.assert();
 requireSettledOperation();const start=performance.now(),schema=(await client.execute("SELECT type,name,tbl_name,sql,json_array(type,name,tbl_name,sql) encoded FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND type IN ('table','index','trigger') ORDER BY type,name")).rows;
 const tables=schema.filter(x=>x.type==='table'),infos=await client.batch(tables.map(t=>`PRAGMA table_info(${quote(t.name)})`),'deferred');
 const descriptors=tables.map((t,i)=>{const columns=infos[i].rows.map(x=>x.name),pk=infos[i].rows.filter(x=>x.pk).sort((a,b)=>a.pk-b.pk).map(x=>x.name),filter=projection(t.name,columns,userId,execution.claim.executionId);return {table:t.name,columns,pk,filter,query:payloadQuery(t.name,columns,pk,filter)};});
 // Opaque primary-key boundaries only; payload pages all share ONE read snapshot.
 const pending=descriptors.filter(d=>d.filter.where!=='0'),keys=new Map(pending.map(d=>[d,[]])),keyBytes=new Map(pending.map(d=>[d,[]]));let active=pending;
 while(active.length){
  const queries=active.map(d=>{if(!d.pk.length)fail('PREPARATION_PRIMARY_KEY_REQUIRED');const previous=keys.get(d).at(-1),range=previous?` AND (${d.pk.map(quote).join(',')})>(${d.pk.map(()=>'?').join(',')})`:'';return {sql:`SELECT ${d.pk.map(quote).join(',')},length(CAST(json_array(${d.columns.map(quote).join(',')}) AS BLOB))+${d.columns.length*64} __bounded_bytes FROM ${quote(d.table)} WHERE (${d.filter.where})${range} ORDER BY ${d.pk.map(quote).join(',')} LIMIT ${maxRows}`,args:[...d.filter.args,...(previous??[])]};});
  const observed=(await client.batch([contextGuard,...queries],'deferred')).slice(1),next=[];
  for(let i=0;i<active.length;i++){const d=active[i],rows=observed[i].rows.map(r=>d.pk.map(k=>r[k]));keys.get(d).push(...rows);keyBytes.get(d).push(...observed[i].rows.map(r=>r.__bounded_bytes));if(keys.get(d).length>16000)fail('PREPARATION_KEY_BOUNDS');if(rows.length===maxRows)next.push(d);}
  active=next;budget.assert();
 }
 const pages=[];
 for(const d of descriptors){
  const rowKeys=keys.get(d)??[],sizes=keyBytes.get(d)??[];
  if(!rowKeys.length){pages.push({d,query:d.query,filter:d.filter});continue;}
  let lower;
  for(let n=0;n<rowKeys.length;){let end=n,bytes=0;while(end<rowKeys.length&&end-n<250&&bytes+sizes[end]<=maxBytes){bytes+=sizes[end++];}if(end===n)fail('PREPARATION_ROW_BOUNDS:'+d.table);const upper=end<rowKeys.length?rowKeys[end-1]:null,parts=[`(${d.filter.where})`],args=[...d.filter.args];
   if(lower){parts.push(`(${d.pk.map(quote).join(',')})>(${d.pk.map(()=>'?').join(',')})`);args.push(...lower);}
   if(upper){parts.push(`(${d.pk.map(quote).join(',')})<=(${d.pk.map(()=>'?').join(',')})`);args.push(...upper);}
   pages.push({d,filter:{where:parts.join(' AND '),args},query:{sql:`SELECT ${d.columns.map(quote).join(',')} FROM ${quote(d.table)} WHERE ${parts.join(' AND ')} ORDER BY ${d.pk.map(quote).join(',')} LIMIT ${maxRows+1}`,args}});lower=upper;n=end;
  }
 }
 const prefixGroups=pages.filter(p=>p.d.filter.where!=='0').length;if(prefixGroups>128)fail('PREPARATION_PREFIX_GROUP_BOUNDS');
 // Metadata boundaries may be older. Recheck EVERY envelope in this SAME read
 // transaction, before the driver is allowed to fetch any health payload.
 const bytesFor=d=>`length(CAST(json_array(${d.columns.map(quote).join(',')}) AS BLOB))+${d.columns.length*64}`;
 const gates=pages.map(({d,filter})=>({sql:`SELECT json(CASE WHEN count(*)<=${maxRows} AND coalesce(sum(${bytesFor(d)}),0)<=${maxBytes} THEN 'true' ELSE 'PREPARATION_FRESH_PAGE_BOUNDS' END) FROM ${quote(d.table)} WHERE ${filter.where}`,args:filter.args}));
 const aggregate=descriptors.map(d=>`coalesce((SELECT sum(${bytesFor(d)}) FROM ${quote(d.table)} WHERE ${d.filter.where}),0)`);
 gates.push(assertion(`(${aggregate.join('+')})<=${16*1024*1024}`,descriptors.flatMap(d=>d.filter.args),'PREPARATION_FRESH_TOTAL_BOUNDS'));
 const observedSnapshot=await client.batch([contextGuard,...gates,...pages.map(p=>p.query)],'deferred'),snapshot=observedSnapshot.slice(gates.length+1);let totalBytes=0;
 for(const d of descriptors)d.rows=[];
 for(let i=0;i<pages.length;i++){const d=pages[i].d,rows=snapshot[i].rows.map(row=>d.columns.map(c=>row[c]));if(rows.some(row=>row.some(v=>v!==null&&!['string','number'].includes(typeof v))))fail('PREPARATION_SNAPSHOT_TYPE');const bytes=Buffer.byteLength(json(rows));totalBytes+=bytes;
  if(rows.length>maxRows||bytes>maxBytes)fail('PREPARATION_SNAPSHOT_BOUNDS:'+d.table+':'+rows.length+':'+bytes);d.rows.push(...rows);
 }
 for(const d of descriptors)d.payload=json(d.rows);
 const schemaStatement="SELECT json_group_array(json_array(type,name,tbl_name,sql)) payload FROM (SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND type IN ('table','index','trigger') ORDER BY type,name)";
 const schemaPayload='['+schema.map(s=>s.encoded).join(',')+']';
 if(totalBytes>16*1024*1024||descriptors.length>128)fail('PREPARATION_SNAPSHOT_BOUNDS');
 budget.assert();let db;
 try{
  if(typeof applicationDb.createIsolatedOwnedMemoryDb!=='function')fail('ISOLATED_MEMORY_FACTORY_REQUIRED');
  db=await applicationDb.createIsolatedOwnedMemoryDb(async seed=>{await seed.execute('PRAGMA foreign_keys=OFF');for(const s of schema.filter(x=>x.type==='table'))await seed.execute(s.sql);
  for(const d of descriptors)for(const row of d.rows)await seed.execute({sql:`INSERT INTO ${quote(d.table)}(${d.columns.map(quote).join(',')}) VALUES (${row.map(()=>'?').join(',')})`,args:row});
  for(const s of schema.filter(x=>x.type==='index'||x.type==='trigger'))await seed.execute(s.sql);await seed.execute('PRAGMA foreign_keys=ON');
  },fixtureKeys);const effects=[],originalExecute=db.raw.execute,originalBatch=db.raw.batch;
  const record=(stmt,result)=>{const sql=typeof stmt==='string'?stmt:stmt.sql;if(!/^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql))return;
   const effect={sql,args:typeof stmt==='string'?[]:stmt.args??[],rowsAffected:result.rowsAffected};
   if(db.processingTransactionActive())db.afterProcessingCommit(()=>effects.push(effect));else effects.push(effect);};
  db.raw.execute=async stmt=>{const at=performance.now(),result=await originalExecute(stmt);globalThis.__stage6LateProfile?.sql(stmt,result,performance.now()-at);record(stmt,result);return result;};
  db.raw.batch=async(stmts,...args)=>{const result=await originalBatch(stmts,...args);stmts.forEach((s,i)=>record(s,result[i]));return result;};
  const admission=await db.admitRuntime(),worker=await createPhase4Stage6({db,keys:fixtureKeys,admission,executionMode:'SHADOW',workerCapability:authorizeStage6ShadowWorker({executionMode:'SHADOW'})});
  const result=await worker.drain({triggerSource:'manual',userId,budget:{maxItems,maxItemsPerTenant:maxItems}});budget.assert();execution.authority.assert();
  if(result.failedJobs||!(result.processedItems||result.unitsCommitted||result.completedJobs))fail('PREPARATION_NO_COMPLETED_UNIT');
  const owner=(await client.execute({sql:'SELECT * FROM phase4_executions WHERE execution_id=?',args:[execution.claim.executionId]})).rows[0];
  if(owner?.owner!==execution.claim.owner||owner?.generation!==execution.claim.generation||owner?.state!=='ESTABLISHED')fail('REQUEST_OWNER_FENCED');
  const leaseDeadlines=[];
  for(const e of effects){
   if(/INSERT INTO resource_locks/i.test(e.sql)){const expiry=Date.parse(e.args[3]);if(!Number.isSafeInteger(expiry))fail('PREPARATION_LEASE_CONTRACT');leaseDeadlines.push(expiry);}
   if(/UPDATE phase4_jobs SET state='RUNNING',lease_owner=\?,lease_expires_at=\?/i.test(e.sql)){const expiry=Date.parse(e.args[1]);if(!Number.isSafeInteger(expiry))fail('PREPARATION_LEASE_CONTRACT');leaseDeadlines.push(expiry);}
  }
  if(!leaseDeadlines.length)fail('PREPARATION_LEASE_CONTRACT');
  const temporalDeadline=Math.min(...leaseDeadlines,budget.deadlineAt,owner.deadline_at,owner.lease_until);
  const plan=Object.freeze({userId,mode:'SHADOW',executionId:execution.claim.executionId,preparationMs:performance.now()-start,snapshotGroups:prefixGroups,snapshotBytes:totalBytes,effects:effects.length,result:structuredClone(result)});
  issued.set(plan,{client,execution,budget,contextGuard,schemaStatement,schemaPayload,temporalDeadline,descriptors,effects,owner,result:structuredClone(result),seal:fixtureKeys.lookup(['short-transaction-plan-v1',userId,execution.claim.executionId,descriptors.map(d=>[d.table,d.payload]),effects,result])});return plan;
 }finally{await db?.close();}
}
export async function prepareIsolatedUnit(options){
 const {client,userId='a'}=options,execution=currentDurableExecution(),budget=currentExecutionBudget();
 if(!clients.has(client)||userId!=='a'||execution?.claim?.request?.phase!=='STAGE6_DRAIN'||execution?.claim?.request?.executionMode!=='SHADOW')fail('ISOLATED_TENANT_SCOPE_REQUIRED');
 requireSettledOperation();budget?.assert();execution.authority.assert();
 const control=(await client.execute({sql:`SELECT p.purge_generation,${databaseNowMs} observed_at FROM phase4_user_state p JOIN users u ON u.id=p.user_id WHERE p.user_id=? AND u.status='ACTIVE' AND p.pending_purge_count=0`,args:[userId]})).rows[0];
 if(!control)fail('PREPARATION_AUTHORIZATION_REVOKED');
 const name=`p4ctx:${fixtureKeys.lookup(['context-tenant-v1',userId])}:short:${execution.claim.executionId}`,owner=json([control.purge_generation,'ACTIVE']),at=new Date(control.observed_at).toISOString(),expires=new Date(control.observed_at+900000).toISOString();
 const registration=fixtureKeys.lookup(['short-context-registration-v1',execution.claim.executionId]);execution.pending.add(registration);
 try{await client.batch([{sql:`INSERT INTO resource_locks(name,owner,acquired_at,expires_at) SELECT ?,?,?,? FROM users u JOIN phase4_user_state p ON p.user_id=u.id WHERE u.id=? AND u.status='ACTIVE' AND p.purge_generation=? AND p.pending_purge_count=0 AND EXISTS(SELECT 1 FROM phase4_executions e WHERE e.execution_id=? AND e.owner=? AND e.generation=? AND e.state='ESTABLISHED' AND e.lease_until>${databaseNowMs} AND e.deadline_at>${databaseNowMs})`,args:[name,owner,at,expires,userId,control.purge_generation,execution.claim.executionId,execution.claim.owner,execution.claim.generation]},assertion('changes()=1',[],'PREPARATION_CONTEXT_REJECTED')],'write');execution.pending.delete(registration);}
 catch(error){if(/^(SQLITE_ERROR|SQLITE_CONSTRAINT(?:_.*)?|TRANSACTION_TIMEOUT|SQL_PARSE_ERROR)$/.test(error?.code??'')){execution.pending.delete(registration);throw error;}execution.indeterminate=true;throw new CommitIndeterminateError();}
 const contextGuard=assertion(`EXISTS(SELECT 1 FROM resource_locks l JOIN users u ON u.id=? JOIN phase4_user_state p ON p.user_id=u.id WHERE l.name=? AND l.owner=? AND l.expires_at=? AND ${databaseNowMs}<? AND u.status='ACTIVE' AND p.pending_purge_count=0 AND p.purge_generation=?)`,[userId,name,owner,expires,Date.parse(expires),control.purge_generation],'PREPARATION_HEALTH_LEASE_REVOKED');
 const release=()=>client.execute({sql:'DELETE FROM resource_locks WHERE name=? AND owner=? AND expires_at=?',args:[name,owner,expires]});
 try{const plan=await prepareDataUnit(options,contextGuard);issued.get(plan).release=release;return plan;}
 catch(error){try{await release();}catch{}throw error;}
}
export async function disposeIsolatedPlan(plan){
 const p=issued.get(plan);if(!p)return;if(p.publishing)fail('PREPARATION_IN_FLIGHT');issued.delete(plan);
 for(const d of p.descriptors){d.rows.length=0;d.payload='';}p.effects.length=0;
 try{await p.release?.();}catch{/* RAM is dropped; original context lease TTL fences erasure until cleanup. */}
}
const assertion=(condition,args=[],label='SHORT_TRANSACTION_CONDITION_REJECTED')=>({sql:`SELECT json(CASE WHEN (${condition}) THEN 'true' ELSE '${label}' END) verified`,args});
async function publishDataUnit(client,plan,{beforeCommit}={}){
 const p=issued.get(plan);if(!p||client!==p.client||p.execution!==currentDurableExecution()||p.budget!==currentExecutionBudget())fail('PREPARATION_CAPABILITY_REQUIRED');
 requireSettledOperation();p.budget.assert();p.execution.authority.assert();if(p.budget.remainingMs()<5500)fail('PUBLICATION_HEADROOM_REQUIRED');
 if(p.seal!==fixtureKeys.lookup(['short-transaction-plan-v1',plan.userId,plan.executionId,p.descriptors.map(d=>[d.table,d.payload]),p.effects,p.result]))fail('PREPARATION_TAMPERED');
 const ownerCondition=`EXISTS(SELECT 1 FROM phase4_executions WHERE execution_id=? AND owner=? AND generation=? AND identity_digest=? AND scope_key=? AND state='ESTABLISHED' AND lease_until>${databaseNowMs} AND deadline_at>${databaseNowMs})`;
 const ownerArgs=[p.owner.execution_id,p.owner.owner,p.owner.generation,p.owner.identity_digest,p.owner.scope_key],timeGuard=assertion(`${databaseNowMs}<?`,[p.temporalDeadline],'SHORT_TRANSACTION_EXPIRED'),stmts=[p.contextGuard,assertion(`${databaseNowMs}+5500<?`,[p.temporalDeadline],'SHORT_TRANSACTION_HEADROOM_REJECTED'),assertion('(SELECT foreign_keys FROM pragma_foreign_keys())=1'),assertion('(SELECT ignore_check_constraints FROM pragma_ignore_check_constraints())=0'),assertion(ownerCondition,ownerArgs),timeGuard,assertion(`(${p.schemaStatement}) IS ?`,[p.schemaPayload],'SHORT_TRANSACTION_SCHEMA_CHANGED')];
 for(const d of p.descriptors){
  stmts.push(assertion(`(SELECT count(*) FROM ${quote(d.table)} WHERE ${d.filter.where})=?`,[...d.filter.args,d.rows.length]));
  for(const row of d.rows)stmts.push(assertion(`EXISTS(SELECT 1 FROM ${quote(d.table)} WHERE (${d.filter.where}) AND ${d.columns.map(c=>quote(c)+' IS ?').join(' AND ')})`,[...d.filter.args,...row]));
 }
 for(const effect of p.effects){stmts.push({sql:effect.sql,args:effect.args});stmts.push(assertion('changes()=?',[effect.rowsAffected],'SHORT_TRANSACTION_ZERO_ROW_REJECTED'));}
 stmts.push(assertion(ownerCondition,ownerArgs),timeGuard,p.contextGuard);
 await beforeCommit?.();p.budget.assert();p.execution.authority.assert();
 const started=performance.now(),pending=fixtureKeys.lookup(['short-publication-pending-v1',plan.executionId,p.seal]);p.execution.pending.add(pending);
 let transactionMs;
 try{await client.batch(stmts,'write');transactionMs=performance.now()-started;p.budget.assert();p.execution.authority.assert();}
 catch(error){
  if(/^(SQLITE_ERROR|SQLITE_CONSTRAINT(?:_.*)?|TRANSACTION_TIMEOUT|SQL_PARSE_ERROR)$/.test(error?.code??'')){p.execution.pending.delete(pending);throw error;}
  p.execution.indeterminate=true;
  try{p.execution.reconciliation=await reconcileExecution({raw:client},p.execution.claim.request,p.execution.claim.identity);}catch{p.execution.reconciliation={state:'RECONCILIATION_REQUIRED'};}
  throw new CommitIndeterminateError();
 }
 p.execution.pending.delete(pending);return {result:structuredClone(p.result),transactionMs,statements:stmts.length,preparationMs:plan.preparationMs,snapshotGroups:plan.snapshotGroups,snapshotBytes:plan.snapshotBytes};
}

export async function publishIsolatedUnit(client,plan,options){const p=issued.get(plan);if(p?.publishing)fail('PREPARATION_IN_FLIGHT');if(p)p.publishing=true;try{return await publishDataUnit(client,plan,options);}finally{if(p)p.publishing=false;await disposeIsolatedPlan(plan);}}

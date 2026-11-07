import {requirePhase4Keys} from './phase4Keys.js';
import {ERASURE_TABLES,assertErasureTables} from './erasureCatalog.js';
import {resolveErasureKvReadOnly,eraseFamilyProjection} from './erasureKvOwnership.js';
import {scanErasureExecutions,ownersForExecution} from './erasureExecutionScan.js';
import {classifySubjectReceipt} from './executionRetirement.js';
import {createIdentityStore} from './identityStore.js';
import {executionReferencePredicates,noReferenceAssertion} from './executionErasureReferences.js';

const fail=code=>{throw Object.assign(Error(code),{code});};
const ident=name=>{if(!/^[a-z][a-z0-9_]*$/.test(name))fail('ERASURE_SCHEMA_UNCLASSIFIED');return '"'+name+'"';};
const list=value=>String(value??'').split(',').map(s=>s.trim()).filter(Boolean);
const query=(sql,args=[])=>({sql,args});
const assertion=(condition,args)=>query(`SELECT CASE WHEN ${condition} THEN 1 ELSE json('ERASURE_FENCE_CHANGED') END`,args);

/** Server-owned maintenance primitive. This is not a new connection adapter.
 * The injected DB must already have passed strict v33 admission. No provider,
 * migration, environment-secret loader, transport or telemetry is imported. */
export function createUserErasure({db,keys,environment,now=()=>new Date(),family=null,revoke=null}){
 requirePhase4Keys(keys);
 const pendingKey=id=>'e1b:pending:'+keys.lookup(['e1b-erasure-pending-v1',id]);
 const seal=body=>JSON.stringify({body,signature:keys.lookup(['e1b-erasure-pending-v1',body])});
 const owners=list(environment.OWNER_USER_IDS),familyIds=list(environment.FAMILY_GROUP_USER_IDS);
 const identity=createIdentityStore(db.raw,{transaction:db.transaction,lifecycleLog:false});
 async function fence(id,{maintenance=false,expectedLife}={}){
  if(owners.includes(id))fail('ERASURE_OWNER_FORBIDDEN');
  if(maintenance&&familyIds.includes(id))fail('ERASURE_FAMILY_MAINTENANCE_FORBIDDEN');
  if(typeof db.transaction!=='function')fail('ERASURE_TRANSACTION_REQUIRED');
  return db.transaction(async()=>{
   const user=await identity.getUser(id);if(!user)return {status:'ALREADY_ABSENT',revoked:true};
   if(maintenance&&user.status!=='DISABLED'||expectedLife!==undefined&&user.lifecycleGeneration!==expectedLife)fail('ERASURE_ACTOR_FENCED');
   const token=(await db.raw.execute(query('SELECT access_token,refresh_token,auth_generation FROM user_whoop_tokens WHERE user_id=?',[id]))).rows[0];
   let revoked=true;
   if(token?.access_token){
    if(typeof revoke!=='function')fail('ERASURE_REVOKE_REQUIRED');
    const work=()=>revoke(token.access_token);
    revoked=db.outsideProcessingTransaction?await db.outsideProcessingTransaction('erasure-revoke:'+keys.lookup([id,token.auth_generation]),work):await work();
   }
   if(token&&(token.access_token||token.refresh_token)){
    const changed=await db.raw.execute(query("UPDATE user_whoop_tokens SET access_token='',refresh_token='',auth_generation=auth_generation+1,access_token_expires_at=?,updated_at=? WHERE user_id=? AND auth_generation=?",[now().toISOString(),now().toISOString(),id,token.auth_generation]));
    if(Number(changed.rowsAffected)!==1)fail('ERASURE_AUTH_CHANGED');
   }
   if(familyIds.includes(id)&&family)await family.store.revokeMember(id);
   const chats=(await db.raw.execute(query('SELECT telegram_chat_id FROM user_telegram WHERE user_id=?',[id]))).rows;
   for(const chat of chats)await identity.revokeTelegramLink(chat.telegram_chat_id);
   await identity.transitionUserLifecycle({userId:id,targetStatus:'DISABLED',expectedCurrentStatus:user.status,now:now()});
   const current=await identity.getUser(id),body={version:'e1b-v1',id,life:current.lifecycleGeneration,createdAt:now().toISOString(),status:'USER_ROWS'};
   await db.raw.execute(query('INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO NOTHING',[pendingKey(id),seal(body),now().toISOString()]));
   // Revoke the same coordination authority that stale SYNC/context writers
   // check, in the same fence transaction, before any erasure batch.
   const prefix='p4ctx:'+keys.lookup(['context-tenant-v1',id])+':';
   await db.raw.execute(query('DELETE FROM resource_locks WHERE name=? OR substr(name,1,?)=?',[`phase4:sync:${id}`,prefix.length,prefix]));
   return {status:'FENCED',revoked};
  });
 }
 async function schema(){
  const rows=(await db.raw.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') ORDER BY type,name")).rows;
  assertErasureTables(rows.filter(r=>r.type==='table').map(r=>r.name));
  if((await db.raw.execute('SELECT MAX(version) v FROM schema_version')).rows[0]?.v!==33)fail('ERASURE_V33_REQUIRED');
  if(rows.some(r=>r.type==='trigger'&&/AFTER\s+DELETE/i.test(r.sql)))fail('ERASURE_DELETE_SIDE_EFFECT_UNPROVEN');
  return rows;
 }
 async function readControl(){const users=(await db.raw.execute('SELECT id,status,lifecycle_generation,timezone,created_at FROM users LIMIT 101')).rows;if(users.length>100)fail('ERASURE_USER_BOUND');return users;}
 async function capture(id,{maintenance=false}={}){
  if(owners.includes(id))fail('ERASURE_OWNER_FORBIDDEN');
  if(maintenance&&familyIds.includes(id))fail('ERASURE_FAMILY_MAINTENANCE_FORBIDDEN');
  const users=await readControl(),subject=users.find(u=>u.id===id);
  if(!subject)return null;
  if(subject.status!=='DISABLED')fail('ERASURE_DISABLED_REQUIRED');
  const catalog=await schema();
  const chats=(await db.raw.execute(query('SELECT telegram_chat_id,status FROM user_telegram WHERE user_id=?',[id]))).rows;
  const providerIds=(await db.raw.execute(query('SELECT whoop_user_id FROM user_whoop_tokens WHERE user_id=? AND whoop_user_id IS NOT NULL',[id]))).rows;
  for(const r of providerIds)if((await db.raw.execute(query('SELECT 1 FROM user_whoop_tokens WHERE whoop_user_id=? AND user_id<>? LIMIT 1',[r.whoop_user_id,id]))).rows.length)fail('ERASURE_PROVIDER_OWNERSHIP_AMBIGUOUS');
  if(chats.some(r=>r.status==='ACTIVE'))fail('ERASURE_TELEGRAM_FENCE_REQUIRED');
  if((await db.raw.execute(query("SELECT 1 FROM user_whoop_tokens WHERE user_id=? AND (COALESCE(access_token,'')<>'' OR COALESCE(refresh_token,'')<>'')",[id]))).rows.length)fail('ERASURE_TOKEN_FENCE_REQUIRED');
  for(const table of ['app_state','whoop_tokens'])if(catalog.some(r=>r.name===table&&r.type==='table')&&(await db.raw.execute(`SELECT count(*) n FROM ${ident(table)}`)).rows[0].n)fail('ERASURE_LEGACY_OWNERSHIP_UNPROVEN');
  const kv=await resolveErasureKvReadOnly({client:db.raw,keys,users,familyIds});
  const plan={removeReceipts:[],pendingReceipts:[]},selected=new Map(),retainedAssertions=[];
  const subjectKeys=[pendingKey(id),...[...kv.owners].filter(([,ids])=>ids.has(id)).map(([k])=>k)];
  for await(const {execution:e,receipts,latestSequence,children} of scanErasureExecutions(db.raw)){
   const owners=ownersForExecution(keys,users,e,receipts),target=receipts.filter(r=>owners.get(r.receipt_key)===id);
   if(!target.length)continue;
   const predicates=await executionReferencePredicates(db.raw,{execution:e,receiptKeys:target.map(r=>r.receipt_key),subjectId:id,subjectKeys});
   for(const p of predicates){if((await db.raw.execute(p)).rows.length)fail('RECEIPT_RETAINED_BY_OTHER_SUBJECT');retainedAssertions.push(noReferenceAssertion(p));}
   const refs=children?['CHILD_EXECUTION']:[];
   if(['ESTABLISHED','WORK_COMMITTED'].includes(e.state)){
    const parentRefs=await executionReferencePredicates(db.raw,{execution:e,subjectId:id,subjectKeys,includeExecution:true});
    for(const p of parentRefs){if((await db.raw.execute(p)).rows.length)refs.push(p.table);else retainedAssertions.push(noReferenceAssertion(p));}
   }
   for(const r of target){
    const disposition=classifySubjectReceipt(e,{now:now().getTime(),latestSequence,readPathsClosed:true,retainedReferences:refs,ownershipVerified:true,retainedReceiptReferences:[]});
    if(disposition.action==='BLOCKED')fail(disposition.reason);
    (disposition.action==='DELETE'?plan.removeReceipts:plan.pendingReceipts).push(r.receipt_key);selected.set(r.receipt_key,e);
   }
  }
  const statements=[assertion("EXISTS(SELECT 1 FROM users WHERE id=? AND status='DISABLED' AND lifecycle_generation=?) AND NOT EXISTS(SELECT 1 FROM user_telegram WHERE user_id=? AND status='ACTIVE')",[id,subject.lifecycle_generation,id]),query('PRAGMA defer_foreign_keys=ON')];
  statements.push(...retainedAssertions);const mutations=[],tables=new Set();
  const remove=(table,where,args)=>{tables.add(table);mutations.push(query(`DELETE FROM ${ident(table)} WHERE ${where}`,args));};
  // The completed backfill cursor is not SYSTEM data: v21 stores a user ID,
  // and v23 stores an insight ID. Runtime admission only requires COMPLETE
  // for these two steps. Keep every checkpoint row, timestamp and key check;
  // redact only the target's cursor before its insight rows are removed.
  mutations.push(query(`UPDATE phase4_migration_checkpoints SET last_cursor=NULL
   WHERE postcondition_state='COMPLETE' AND
    ((target_version=21 AND step_key='tenant_metadata' AND last_cursor=?) OR
     (target_version=23 AND step_key='legacy_insights' AND last_cursor IN
      (SELECT CAST(id AS TEXT) FROM health_insights WHERE user_id=?)))`,[id,id]));
  // All direct selectors are literal inventory entries, not arbitrary table
  // names supplied by an operator or a callback.
  for(const [table,contract] of Object.entries(ERASURE_TABLES))if(contract.selector.startsWith('user_id = subject'))remove(table,'user_id=?',[id]);
  // Pending webhook events have not resolved their internal user_id yet.
  // The captured provider binding is checked again in the same atomic batch.
  for(const r of providerIds){
   statements.push(assertion('NOT EXISTS(SELECT 1 FROM user_whoop_tokens WHERE whoop_user_id=? AND user_id<>?)',[r.whoop_user_id,id]));
   remove('whoop_webhook_events','whoop_user_id=? AND (user_id IS NULL OR user_id=?)',[String(r.whoop_user_id),id]);
  }
  const chatIds=chats.map(r=>String(r.telegram_chat_id)),marks=chatIds.map(()=>'?').join(',');
  const opWhere=`owner_user_id=? OR json_extract(result_json,'$.userId')=?${chatIds.length?` OR json_extract(result_json,'$.chatId') IN (${marks}) OR update_id IN (SELECT update_id FROM telegram_processed_updates WHERE user_id IN (${marks}))`:''}`;
  remove('telegram_operations',opWhere,[id,id,...chatIds,...chatIds.map(c=>'tg:'+c)]);
  if(chatIds.length)remove('telegram_processed_updates',`user_id IN (${marks})`,chatIds.map(c=>'tg:'+c));
  for(const table of ['error_notifications','system_heartbeats'])remove(table,'scope=?',['user:'+id]);
  const contextPrefix='p4ctx:'+keys.lookup(['context-tenant-v1',id])+':';
  remove('resource_locks',`name=? OR substr(name,1,?)=?${chatIds.length?` OR name IN (${marks})`:''}`,[`phase4:sync:${id}`,contextPrefix.length,contextPrefix,...chatIds.map(c=>'telegram_lane:tg:'+c)]);
  const projection=eraseFamilyProjection({keys,resolution:kv,subject:id,familyIds});
  if(projection){const old=kv.familyEntry;statements.push(assertion('EXISTS(SELECT 1 FROM telegram_state WHERE key=? AND value=?)',[old.key,old.value]));mutations.push(query('UPDATE telegram_state SET value=?,updated_at=? WHERE key=?',[projection.value,now().toISOString(),projection.key]));}
  for(const [key,ids] of kv.owners)if(ids.has(id)&&key!==kv.familyConsentKey)remove('telegram_state','key=?',[key]);
  for(const key of plan.removeReceipts){
   const e=selected.get(key);
   statements.push(assertion('EXISTS(SELECT 1 FROM phase4_executions WHERE execution_id=? AND state=? AND generation=? AND lease_until=? AND deadline_at=? AND created_at=?)',[e.execution_id,e.state,e.generation,e.lease_until,e.deadline_at,e.created_at]));
   remove('phase4_execution_work_receipts','receipt_key=?',[key]);
  }
  remove('users','id=? AND status=\'DISABLED\' AND lifecycle_generation=?',[id,subject.lifecycle_generation]);
  // Keep only the minimum retry identity for still-live execution receipts.
  // No health facts, credentials, chat IDs or user-facing text are retained.
  if(plan.pendingReceipts.length){
   const body={version:'e1b-v1',id,life:subject.lifecycle_generation,createdAt:now().toISOString(),receipts:plan.pendingReceipts};
   mutations.push(query('INSERT INTO telegram_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',[pendingKey(id),seal(body),now().toISOString()]));
  }else remove('telegram_state','key=?',[pendingKey(id)]);
  const guards=catalog.filter(r=>r.type==='trigger'&&tables.has(r.tbl_name)&&/BEFORE\s+DELETE/i.test(r.sql));
  for(const r of guards)statements.push(query(`DROP TRIGGER ${ident(r.name)}`));
  statements.push(...mutations,...guards.map(r=>query(r.sql)));
  return {subject,catalog,statements,pending:plan.pendingReceipts.length,guardCount:guards.length};
 }
 async function eraseDisabled(id,options={}){
  const plan=await capture(id,options);if(!plan)return {status:'ALREADY_ABSENT',deleted:0,pending:0};
  let result;
  try{result=await db.raw.batch(plan.statements,'write');}
  catch{fail('ERASURE_ATOMIC_BATCH_FAILED');}
  const after=await schema();
  if(JSON.stringify(after)!==JSON.stringify(plan.catalog))fail('ERASURE_SCHEMA_CHANGED');
  if((await db.raw.execute('PRAGMA foreign_key_check')).rows.length)fail('ERASURE_FOREIGN_KEY_FAILED');
  // Subject-derived receipt overrides are personal rows too. Do not count
  // metadata SELECTs, cursor redaction or guard recreation as deleted rows.
  const deletedRows=result.reduce((n,r,i)=>n+(/^DELETE\b/i.test(plan.statements[i].sql)?Number(r.rowsAffected??0):0),0);
  return {status:plan.pending?'PENDING_RECEIPTS':'ERASED',deleted:result.reduce((n,r)=>n+Number(r.rowsAffected??0),0),deletedByClass:{USER:deletedRows,SHARED_OPERATIONAL:0,SYSTEM:0},pending:plan.pending,guards:plan.guardCount};
 }
 async function retryPending({budget,limit=5}={}){
  if(!budget||typeof budget.remainingMs!=='function'||typeof budget.assert!=='function')fail('ERASURE_BUDGET_REQUIRED');
  if(!Number.isInteger(limit)||limit<1||limit>10)fail('ERASURE_RETRY_BOUND_INVALID');
  const markers=(await db.raw.execute("SELECT key,value FROM telegram_state WHERE key LIKE 'e1b:pending:%' ORDER BY updated_at LIMIT 1001")).rows;
  if(markers.length>1000)fail('ERASURE_PENDING_BOUND_EXCEEDED');
  const result={completed:0,pending:0,deferred:0,overdue:0};
  for(const [index,row] of markers.entries()){
   let wire;try{wire=JSON.parse(row.value);}catch{fail('ERASURE_PENDING_INVALID');}
   const body=wire?.body;
   if(!body||body.version!=='e1b-v1'||typeof body.id!=='string'||!Number.isSafeInteger(body.life)||body.life<1
    ||!Number.isFinite(Date.parse(body.createdAt))||row.key!==pendingKey(body.id)||wire.signature!==keys.lookup(['e1b-erasure-pending-v1',body]))fail('ERASURE_PENDING_INVALID');
   if(now().getTime()-Date.parse(body.createdAt)>7*86400000)result.overdue++;
   if(index>=limit||budget.remainingMs()<15000){result.deferred++;continue;}
   budget.assert();
   const users=await readControl();
   if(users.some(u=>u.id===body.id)){
    const outcome=await eraseDisabled(body.id);result[outcome.pending?'pending':'completed']++;continue;
   }
   if(!Array.isArray(body.receipts)||body.receipts.some(k=>!/^[a-f0-9]{64}$/.test(k)))fail('ERASURE_PENDING_INVALID');
   const subject={id:body.id,lifecycle_generation:body.life},plan={removeReceipts:[],pendingReceipts:[]},selected=new Map(),assertions=[];
   const heldKeys=new Set(body.receipts);
   for await(const {execution:e,receipts,latestSequence,children} of scanErasureExecutions(db.raw,{budget})){
    const held=receipts.filter(r=>heldKeys.has(r.receipt_key));if(!held.length)continue;
    const owners=ownersForExecution(keys,[...users,subject],e,held);
    if(held.some(r=>owners.get(r.receipt_key)!==body.id))fail('ERASURE_PENDING_OWNERSHIP_UNPROVEN');
    const predicates=await executionReferencePredicates(db.raw,{execution:e,receiptKeys:held.map(r=>r.receipt_key),subjectId:body.id,subjectKeys:[row.key]});
    for(const p of predicates){budget.assert();if((await db.raw.execute(p)).rows.length)fail('RECEIPT_RETAINED_BY_OTHER_SUBJECT');assertions.push(noReferenceAssertion(p));}
    const refs=children?['CHILD_EXECUTION']:[];
    if(['ESTABLISHED','WORK_COMMITTED'].includes(e.state))for(const p of await executionReferencePredicates(db.raw,{execution:e,subjectId:body.id,subjectKeys:[row.key],includeExecution:true})){
     budget.assert();if((await db.raw.execute(p)).rows.length)refs.push(p.table);else assertions.push(noReferenceAssertion(p));
    }
    for(const r of held){const disposition=classifySubjectReceipt(e,{now:now().getTime(),latestSequence,readPathsClosed:true,retainedReferences:refs,ownershipVerified:true,retainedReceiptReferences:[]});
     if(disposition.action==='BLOCKED')fail(disposition.reason);
     (disposition.action==='DELETE'?plan.removeReceipts:plan.pendingReceipts).push(r.receipt_key);selected.set(r.receipt_key,e);
    }
   }
   const catalog=await schema(),guard=catalog.find(r=>r.name==='p4_execution_receipt_no_delete');
   if(!guard)fail('ERASURE_TRIGGER_UNPROVEN');
   const statements=[assertion('NOT EXISTS(SELECT 1 FROM users WHERE id=?) AND EXISTS(SELECT 1 FROM telegram_state WHERE key=? AND value=?)',[body.id,row.key,row.value]),...assertions];
   for(const key of plan.removeReceipts){const e=selected.get(key);
    statements.push(assertion('EXISTS(SELECT 1 FROM phase4_executions WHERE execution_id=? AND state=? AND generation=? AND lease_until=? AND deadline_at=?)',[e.execution_id,e.state,e.generation,e.lease_until,e.deadline_at]));
   }
   if(plan.removeReceipts.length){statements.push(query('DROP TRIGGER '+ident(guard.name)),...plan.removeReceipts.map(k=>query('DELETE FROM phase4_execution_work_receipts WHERE receipt_key=?',[k])),query(guard.sql));}
   if(plan.pendingReceipts.length)statements.push(query('UPDATE telegram_state SET value=?,updated_at=? WHERE key=?',[seal({...body,receipts:plan.pendingReceipts}),now().toISOString(),row.key]));
   else statements.push(query('DELETE FROM telegram_state WHERE key=?',[row.key]));
   budget.assert();await db.raw.batch(statements,'write');
   if(JSON.stringify(await schema())!==JSON.stringify(catalog))fail('ERASURE_SCHEMA_CHANGED');
   result[plan.pendingReceipts.length?'pending':'completed']++;
  }
  return result;
 }
 return Object.freeze({capture,eraseDisabled,fence,retryPending});
}

import {createHash} from 'node:crypto';
import {identifier} from './selectSnapshot.mjs';
import {createUserErasure} from '../../src/userErasure.js';
import {resolveErasureKvReadOnly} from '../../src/erasureKvOwnership.js';
import {scanErasureExecutions,ownersForExecution} from '../../src/erasureExecutionScan.js';
import {createOperationalRetention} from '../../src/operationalRetention.js';
import {classifyExecutionRetirement} from '../../src/executionRetirement.js';
import {readPhaseProgress} from '../../src/phase4ExecutionStore.js';
import {selectBodyEnergyInputs} from '../../src/bodyEnergyInputs.js';
import {calculateBodyEnergy} from '../../src/bodyEnergy.js';
import {calculateAssociations} from '../../src/onDemandAssociations.js';
import {computeDailyMetrics} from '../../src/dailyMetrics.js';
import {buildSupervised} from '../../src/prediction.js';
import {latestMemory,renderMemory} from '../../src/associationMemory.js';
import {summarizeJournalWeek,renderJournalWeek} from '../../src/stage7WeeklyReview.js';
import {TOPICS} from '../../src/stage7Registry.js';
import {localDate,addDays,completedWeeks} from '../../src/time.js';
import {createFamilySharing} from '../../src/familySharing.js';
import {assertErasureTables} from '../../src/erasureCatalog.js';

const fail=code=>{throw Object.assign(Error(code),{code});};
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v);
const hash=x=>createHash('sha256').update(json(x)).digest('hex');
const q=(sql,args=[])=>({sql,args});
const list=s=>String(s??'').split(',').map(s=>s.trim()).filter(Boolean);

/** Local-copy only. Hashes and identities never leave this process. The six
 * output comparisons use existing pure calculators and the family's actual
 * consent/render path; no application scheduler or provider is invoked. */
export async function rehearseLocal({db,keys,environment,at,admit,emit}){
 const client=db.raw,familyIds=list(environment.FAMILY_GROUP_USER_IDS),ownerIds=list(environment.OWNER_USER_IDS);
 const users=(await client.execute('SELECT * FROM users LIMIT 101')).rows;
 if(users.length>100)fail('REHEARSAL_USER_BOUND');
 const family=users.filter(u=>familyIds.includes(u.id)),subjects=users.filter(u=>u.status==='DISABLED'&&!familyIds.includes(u.id)&&!ownerIds.includes(u.id));
 if(family.length!==3||subjects.length!==5)fail('REHEARSAL_EXACT_COHORT_REQUIRED');
 const schema=async()=>(await client.execute("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') ORDER BY type,name")).rows;
 const beforeSchema=await schema(),tables=beforeSchema.filter(r=>r.type==='table');assertErasureTables(tables.map(t=>t.name));
 const columns=new Map();for(const t of tables)columns.set(t.name,(await client.execute(`PRAGMA table_info(${identifier(t.name)})`)).rows);
 const direct=tables.filter(t=>columns.get(t.name).some(c=>c.name==='user_id')&&t.name!=='telegram_processed_updates');
 function digestRows(table,where,args){
  const pk=columns.get(table).filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>identifier(c.name)).join(',')||'rowid';
  const digest=createHash('sha256');let count=0;
  for(const row of db.iterate(`SELECT * FROM ${identifier(table)} WHERE ${where} ORDER BY ${pk}`,args)){digest.update(json(row)+'\n');count++;}
  return {count,hash:digest.digest('hex')};
 }
 const boundedRows=async(table,id,limit=2000)=>{const rows=(await client.execute(q(`SELECT * FROM ${identifier(table)} WHERE user_id=? LIMIT ?`,[id,limit+1]))).rows;if(rows.length>limit)fail('REHEARSAL_CALCULATION_BOUND');return rows;};
 async function kvResolution(){
  return resolveErasureKvReadOnly({client,keys,users:(await client.execute('SELECT id,lifecycle_generation FROM users LIMIT 101')).rows,familyIds});
 }
 const beforeKv=await kvResolution(),subjectKeys=[...beforeKv.owners].filter(([,ids])=>subjects.some(s=>ids.has(s.id))).map(([key])=>key);
 const identifiers=[];
 for(const u of subjects){
  identifiers.push(u.id,u.display_name);
  for(const r of await boundedRows('user_telegram',u.id))identifiers.push(String(r.telegram_chat_id));
  for(const r of await boundedRows('user_whoop_tokens',u.id)){
   if(r.access_token||r.refresh_token)fail('REHEARSAL_DISABLED_TOKEN_PRESENT');
   if(r.whoop_user_id)identifiers.push(String(r.whoop_user_id));
  }
 }
 async function snapshot(){
  const current=(await client.execute('SELECT id,lifecycle_generation FROM users LIMIT 101')).rows,counts=new Map(family.map(u=>[u.id,0])),progress=[],pairs=new Set();
  let unfinished=0,protectedUnfinished=0;
  for await(const {execution,receipts,latestSequence,children} of scanErasureExecutions(client)){
   const owners=ownersForExecution(keys,current,execution,receipts);for(const id of owners.values())if(counts.has(id))counts.set(id,counts.get(id)+1);
   pairs.add(json([execution.phase,execution.trigger_source]));
   if(['ESTABLISHED','WORK_COMMITTED'].includes(execution.state)){
    unfinished++;const d=classifyExecutionRetirement(execution,{now:at.getTime(),latestSequence,readPathsClosed:true,retainedReferences:children?['CHILD_EXECUTION']:[],existingUserReceiptCount:owners.size});
    if(d.reasons.includes('EXISTING_USER_RECEIPT'))protectedUnfinished++;
   }
  }
  for(const pair of [...pairs].sort()){const [phase,source]=JSON.parse(pair);progress.push(await readPhaseProgress(db,phase,source));}
  const outputs=new Map(),all=[];
  for(const user of family){
   const directHashes={users:digestRows('users','id=?',[user.id])};for(const t of direct)directHashes[t.name]=digestRows(t.name,'user_id=?',[user.id]);
   const data={};for(const t of ['whoop_sleeps','whoop_recoveries','whoop_cycles','whoop_workouts','whoop_resource_access','whoop_sync_state','whoop_resource_tombstones','whoop_capabilities','journal_events','quick_action_interactions','health_insights','whoop_body_measurements'])data[t]=await boundedRows(t,user.id);
   const token=(await client.execute(q('SELECT auth_generation,whoop_user_id FROM user_whoop_tokens WHERE user_id=?',[user.id]))).rows[0];
   const today=localDate(at,user.timezone),selection=selectBodyEnergyInputs({userId:user.id,timezone:user.timezone,asOfEpochMs:at.getTime(),targetHealthDate:today,lifecycleGeneration:user.lifecycle_generation,authGeneration:token?.auth_generation,
    sources:{sleep:data.whoop_sleeps,recovery:data.whoop_recoveries,cycle:data.whoop_cycles,workout:data.whoop_workouts},sync:data.whoop_sync_state,access:data.whoop_resource_access,tombstones:data.whoop_resource_tombstones,capabilities:data.whoop_capabilities});
   const body=calculateBodyEnergy(selection.manifest);outputs.set(user.id,{calculation:body});
   const metrics=computeDailyMetrics({sleepRows:data.whoop_sleeps,recoveryRows:data.whoop_recoveries,cycleRows:data.whoop_cycles,workoutRows:data.whoop_workouts,bodyMeasurement:data.whoop_body_measurements.at(-1),timezone:user.timezone});
   const days=(await client.execute(q(`SELECT s.health_date,s.end_at,s.id,r.hrv_rmssd_milli hrv,r.recovery_score recovery,r.resting_heart_rate rhr,s.sleep_performance_percentage sleep_performance
    FROM whoop_sleeps s JOIN whoop_recoveries r ON r.user_id=s.user_id AND r.sleep_id=s.id JOIN user_whoop_tokens t ON t.user_id=s.user_id
    WHERE s.user_id=? AND s.health_date BETWEEN ? AND ? AND s.nap=0 AND s.score_state='SCORED' AND r.score_state='SCORED' AND COALESCE(r.user_calibrating,0)=0
    AND s.whoop_user_id=t.whoop_user_id AND r.whoop_user_id=t.whoop_user_id AND NOT EXISTS(SELECT 1 FROM whoop_resource_tombstones z WHERE z.user_id=s.user_id AND z.state='ACTIVE' AND ((z.resource_type='sleep' AND z.resource_id=s.id) OR (z.resource_type='recovery' AND z.resource_id=r.sleep_id))) ORDER BY s.end_at DESC LIMIT 1001`,[user.id,addDays(today,-89),today]))).rows;
   if(days.length>1000)fail('REHEARSAL_ASSOCIATION_BOUND');
   const associations=calculateAssociations({facts:data.journal_events,days:[...new Map([...days].reverse().map(d=>[d.health_date,d])).values()],today});
   const memory=await latestMemory({getRecentInsights:async()=>data.health_insights.filter(r=>!data.health_insights.some(n=>n.subject===r.subject&&n.id>r.id)).sort((a,b)=>b.id-a.id)},user.id);
   const week=completedWeeks(at,'Asia/Taipei').last,summary=summarizeJournalWeek({facts:data.journal_events,history:data.quick_action_interactions,topics:TOPICS,startDate:week.startDate,endDate:week.endDate});summary.onDemand=associations;
   all.push({directHashes,receipts:counts.get(user.id),digests:{body:hash(body),associations:hash(associations),memory:hash(memory.map(r=>renderMemory(r,'en',at))),prediction:hash(buildSupervised(metrics)),weekly:hash(renderJournalWeek(summary,'en'))}});
  }
  const familyDb={...db,getLocale:async id=>(await client.execute(q('SELECT locale FROM user_locales WHERE user_id=?',[id]))).rows[0]?.locale??'en'};
  for(const [method,table] of [['getSleeps','whoop_sleeps'],['getRecoveries','whoop_recoveries']])familyDb[method]=async(id,{from,to})=>(await client.execute(q(`SELECT * FROM ${table} WHERE user_id=? AND health_date BETWEEN ? AND ? ORDER BY health_date DESC LIMIT 1001`,[id,from,to]))).rows;
  const sharing=createFamilySharing({db:familyDb,keys,environment,now:()=>at,send:()=>fail('REHEARSAL_SEND_FORBIDDEN'),bodyEnergyFactory:async()=>({inspect:async({userId})=>outputs.get(userId)})});
  if(!sharing)fail('REHEARSAL_FAMILY_DISABLED');
  const previews=await sharing.previewReadOnly();for(const [i,u] of family.entries())all[i].digests.family=hash(previews.find(p=>p.recipient===u.id)??null);
  return {all,progress:hash(progress),unfinished,protectedUnfinished};
 }
 const before=await snapshot();emit({phase:'BEFORE',pass:true,users:3,tables:tables.length,unfinished:before.unfinished,protected_unfinished:before.protectedUnfinished});
 const engine=createUserErasure({db,keys,environment,now:()=>at});let deleted=0;
 for(const subject of subjects){await engine.fence(subject.id,{maintenance:true});const result=await engine.eraseDisabled(subject.id,{maintenance:true});if(result.status!=='ERASED'||result.pending)fail('REHEARSAL_SUBJECT_PENDING');deleted+=result.deleted;}
 emit({phase:'ERASURE',pass:true,users:5,deleted});
 const totals={retired:0,receipts:0,protected:0,blocked:0};let complete=false;
 for(let pass=0;pass<100;pass++){
  const end=Date.now()+90000,budget={remainingMs:()=>Math.max(0,end-Date.now()),assert(){if(Date.now()>=end)fail('REHEARSAL_RETENTION_BUDGET');}};
  const result=await createOperationalRetention({db,keys,now:()=>at,emit:()=>{}}).run({budget});for(const key of Object.keys(totals))totals[key]+=result[key];
  if(!result.deferred){complete=true;break;}
 }
 if(!complete)fail('REHEARSAL_RETENTION_INCOMPLETE');
 const after=await snapshot();
 if(hash(before.all)!==hash(after.all)||before.progress!==after.progress)fail('REHEARSAL_EXISTING_USER_CHANGED');
 let remaining=0;
 for(const t of tables){const text=columns.get(t.name).filter(c=>/TEXT/i.test(c.type));if(!text.length)continue;
  const conditions=[],args=[];for(const c of text)for(const id of [...new Set(identifiers.filter(Boolean))]){conditions.push(`instr(${identifier(c.name)},?)>0`);args.push(id);}
  if(conditions.length)remaining+=(await client.execute(q(`SELECT COUNT(*) n FROM ${identifier(t.name)} WHERE ${conditions.join(' OR ')}`,args))).rows[0].n;
 }
 for(const key of subjectKeys)remaining+=(await client.execute(q('SELECT COUNT(*) n FROM telegram_state WHERE key=?',[key]))).rows[0].n;
 if(remaining)fail('REHEARSAL_SUBJECT_SCAN_FAILED');
 if(hash(await schema())!==hash(beforeSchema))fail('REHEARSAL_SCHEMA_CHANGED');
 if((await client.execute('PRAGMA foreign_key_check')).rows.length||(await client.execute('PRAGMA integrity_check')).rows.some(r=>Object.values(r)[0]!=='ok'))fail('REHEARSAL_INTEGRITY_FAILED');
 await admit();
 emit({phase:'AFTER',pass:true,users_preserved:3,output_digest_kinds:6,remaining:0,schema_exact:true,integrity:true,foreign_key_violations:0,read_phase_progress:true,...totals,unfinished:after.unfinished,protected_unfinished:after.protectedUnfinished});
 return {pass:true};
}

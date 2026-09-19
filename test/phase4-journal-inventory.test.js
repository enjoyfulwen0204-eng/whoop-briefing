import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { V22_LEGACY_R_TABLES } from '../src/phase4V22Schema.js';
import { addPrivacyLink,HEALTH_REDACTED,REDACTED_RECEIPT } from '../src/phase4V22Backfill.js';

// Independent expected matrix: a newly added legacy R family must be classified
// here rather than silently receiving a vacuous marker-only test.
const expected={pending_questions:{question:HEALTH_REDACTED,context_json:'{}',original_message:null,answer_text:null,intent:null},
  telegram_operations:{result_json:REDACTED_RECEIPT},proactive_events:{message_text:null,reason_json:'{}',signals_json:'{}',health_date:HEALTH_REDACTED,outcome:null},
  health_insights:{statement:HEALTH_REDACTED,subject:HEALTH_REDACTED,insight_type:HEALTH_REDACTED,evidence_json:'{}',sample_count:null,effect_size:null,confidence:null},
  whoop_capabilities:{latest_value:null,sample_count:null,non_null_count:null,detail:null},
  healthspan_metrics:'REMOVED',healthspan_snapshots:'REMOVED',prediction_runs:'REMOVED',prediction_models:'REMOVED',analytics_daily_state:'REMOVED',
  analytics_invalidation:{affected_from:null,affected_to:null,resources:null,reasons:'HEALTH_SCOPE_REDACTED'},
  analytics_work_state:{summary_json:'{}',last_error_detail:null,range_from:null,range_to:null,range_generation:null,owner:null,lease_expires_at:null},
  analytics_runs:{detail_json:'{}',error_detail:null},report_runs:{detail:null,health_date:null,sleep_id:null,cycle_id:null},report_claims:{delivery_detail:null},
  briefing_evaluations:{reason:null,detail:null,target_health_date:null,observation_age_minutes:null},whoop_sync_state:{last_error:null},
  whoop_webhook_events:{last_error_detail:null},whoop_reconciliation_state:{last_error_detail:null},whoop_reconciliation_runs:{error_detail:null},
  user_onboarding:{failure_detail:null},ai_usage:{detail:null},system_heartbeats:{last_detail:null},proactive_agent_state:{last_checked_health_date:null,last_fingerprint:null}};
const ts='2026-09-19T00:00:00.000Z';
test('Journal deletion traverses every legacy plaintext family with exact sentinels/removal, tenant isolation and unrelated Journal preservation',async t=>{
  const f=await syntheticPhase4Fixture(t),{db,stores}=f;
  assert.deepEqual(Object.keys(expected).sort(),V22_LEGACY_R_TABLES.filter(t=>t!=='journal_events').sort());
  const facts={};
  for(const uid of ['a','b']) {
    const text='caffeine 100mg',control=await stores.captureControl(uid);
    facts[uid]=await stores.journal.create(control,{sourceEventKey:'inventory-fact',sourceText:text,candidate:{category:'caffeine',eventAt:ts,
      valueKind:'NUMERIC',numericValue:100,unit:'mg',exposureState:'EXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:14}});
    const source=(await db.raw.execute({sql:'SELECT privacy_artifact_id FROM journal_events WHERE user_id=?',args:[uid]})).rows[0].privacy_artifact_id;
    for(const [table,matrix] of Object.entries(expected)) {
      const info=(await db.raw.execute(`PRAGMA table_info(${table})`)).rows;
      const values={user_id:uid,owner_user_id:uid,scope:`user:${uid}`,class:'LIGHT',key:`synthetic-${uid}`,state:'RECEIVED',status:'SYNTHETIC',
        resource:'sleep',resource_type:'sleep',event_type:'sleep.updated',provider:'whoop',component:'fixture',report_type:'daily',
        local_date:'2026-09-19',health_date:'2026-09-19',result:'SUCCESS',metrics_json:'{}',result_json:JSON.stringify({userId:uid,reply:'synthetic secret'}),
        content_state:'PRESENT',source_linkage_state:'COMPLETE',privacy_artifact_id:`inventory-${uid}-${table}`,scope_kind:'HEALTH_DATE_RANGE',
        affected_from:'2026-09-18',affected_to:'2026-09-19',range_from:'2026-09-18',range_to:'2026-09-19',range_generation:7,
        update_id:uid==='a'?9801:9802,chat_id:uid==='a'?'123':'456',execution_mode:'LIVE'};
      const needed=info.filter(c=>c.name==='user_id'||c.name==='scope'||(c.notnull&&c.dflt_value===null&&!(c.pk&&c.type==='INTEGER'))
        ||Object.hasOwn(values,c.name)||matrix!=='REMOVED'&&Object.hasOwn(matrix,c.name));
      const row=Object.fromEntries(needed.map(c=>[c.name,Object.hasOwn(values,c.name)?values[c.name]:c.type==='INTEGER'?1:c.type==='REAL'?0.5:
        c.name.endsWith('_json')?'{"synthetic":"secret"}':c.name.endsWith('_at')?ts:`synthetic-${uid}`]));
      // In-flight operational metadata is intentionally present, then fenced.
      if(table==='analytics_invalidation')Object.assign(row,{generation:7});
      if(table==='analytics_work_state')Object.assign(row,{status:'PENDING',done_generation:2,range_generation:7});
      const fields=Object.keys(row);
      try {await db.raw.execute({sql:`INSERT INTO ${table}(${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,args:fields.map(k=>row[k])});}
      catch(error){throw new Error(`synthetic inventory setup: ${table}`,{cause:error});}
      await addPrivacyLink(db.raw,{userId:uid,mode:table==='pending_questions'?'LIVE':'SHARED',table,artifactId:row.privacy_artifact_id,
        sourceType:'JOURNAL_FACT',sourceId:source,at:ts});
    }
  }
  const before=new Map();for(const table of Object.keys(expected))before.set(table,JSON.stringify((await db.raw.execute({sql:`SELECT * FROM ${table} WHERE ${table==='telegram_operations'?'owner_user_id':table==='system_heartbeats'?'scope':'user_id'}=?`,args:[table==='system_heartbeats'?'user:b':'b']})).rows));
  const control=await stores.captureControl('a');
  const text='no alcohol',unrelated=await stores.journal.create(control,{sourceEventKey:'unrelated',sourceText:text,candidate:{category:'alcohol',eventAt:ts,
    valueKind:'PRESENCE',exposureState:'CONFIRMED_UNEXPOSED',extractionConfidence:1,excerptStart:0,excerptEnd:text.length}});
  const purge=await stores.journal.remove(control,{logicalFactId:facts.a.logicalFactId,idempotencyKey:'inventory-delete'});await stores.privacy.complete(control,purge.purgeId);
  for(const [table,matrix] of Object.entries(expected)) {
    const row=(await db.raw.execute({sql:`SELECT * FROM ${table} WHERE privacy_artifact_id=?`,args:[`inventory-a-${table}`]})).rows[0];
    if(matrix==='REMOVED')assert.equal(row,undefined,table);
    else {assert.equal(row.content_state,'REDACTED',table);assert.equal(row.content_digest_salt,null,table);
      for(const [field,value] of Object.entries(matrix))assert.equal(row[field],value,`${table}.${field}`);}
    const b=(await db.raw.execute({sql:`SELECT * FROM ${table} WHERE ${table==='telegram_operations'?'owner_user_id':table==='system_heartbeats'?'scope':'user_id'}=?`,args:[table==='system_heartbeats'?'user:b':'b']})).rows;
    assert.equal(JSON.stringify(b),before.get(table),`other tenant ${table}`);
  }
  const fresh=await stores.capture('a',{executionMode:'SHADOW'});assert.equal((await stores.journal.read(fresh,unrelated.logicalFactId)).row.category,'alcohol');
  assert.equal((await db.raw.execute("SELECT generation FROM analytics_invalidation WHERE user_id='a'")).rows[0].generation,7);
  assert.equal((await db.raw.execute("SELECT done_generation FROM analytics_work_state WHERE user_id='a'")).rows[0].done_generation,2);
  assert.equal((await db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixtureKeys } from './localDb.js';
import { createOwnedDb as createDb } from './stage5OwnedDb.js';
import { runMigrations, currentVersion } from './localMigrations.js';
import { PHASE4_MIGRATIONS } from '../src/phase4Schema.js';
import { assertPhase4Schema } from '../src/phase4Migrations.js';
import { createPhase4Foundation } from '../src/phase4Foundation.js';
import { legacyFixture, loadLegacyFixture } from './stage5LegacyFixture.js';
import { recoveryRefs,request as metricRequest } from './stage5HistoryFixture.js';

async function database(t,version=26) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stage5-v27-')),url=`file:${path.join(dir,'synthetic.db')}`;
  let db=createDb({url});
  // The existing owned fixture keeps native statement finalizers attached to
  // one live connection. SQL, transaction assertions and real reopen remain.
  t.after(async()=>{await db.close();fs.rmSync(dir,{recursive:true,force:true});});
  await db.migrate({targetVersion:version});return {get db(){return db;},async reopen(){await db.close();db=createDb({url});return db;}};
}
async function healthy(db) {
  assert.equal((await db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
  assert.deepEqual((await db.raw.execute('PRAGMA foreign_key_check')).rows,[]);
}

test('M: fresh, v26 and full v20 migrations create no historical receipts',async t=>{
  for(const from of [20,26,27])await t.test(`v${from}→v27`,async t=>{
    const f=await database(t,from);
    await f.db.createUser({id:'preserved',displayName:'Synthetic',timezone:'UTC',status:'ACTIVE'});
    const before=(await f.db.raw.execute('SELECT * FROM users')).rows;
    await f.db.migrate();await assertPhase4Schema(f.db.raw,27);await f.reopen();await f.db.migrate();
    assert.deepEqual((await f.db.raw.execute('SELECT * FROM users')).rows,before);
    assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_operation_receipts')).rows[0].n,0);
    await healthy(f.db);
  });
});

test('E/M: a genuine RC6 raw-time observation is reused without inserting a canonical alias',async t=>{
  const fixture=legacyFixture(t,{version:'rc6',shape:'metric',sourceSpelling:'2026-09-25T20:00:00+08:00'}),f=await database(t,26);
  await loadLegacyFixture(f.db,fixture);await f.db.migrate();
  const before=(await f.db.raw.execute('SELECT * FROM episode_observations')).rows;assert.equal(before.length,1);
  assert.match(before[0].source_version,/\+08:00/);
  // Equivalent WHOOP adapter normalization changes no physical observation.
  await f.db.raw.execute("UPDATE whoop_recoveries SET updated_at='2026-09-25T12:00:00.000Z' WHERE sleep_id='sleep-00'");
  const stores=await createPhase4Foundation({db:f.db,keys:fixtureKeys,now:()=>new Date('2026-09-25T12:01:00Z')}),c=await stores.capture('a',{executionMode:'SHADOW'});
  const ids=fixture.tables.whoop_recoveries.map(row=>row.sleep_id),refs=await recoveryRefs(stores,c,ids);
  const result=await stores.intelligence.analyzeMetric(c,metricRequest(refs[0],refs.slice(1),'2026-09-25T12:01:00.000Z'));
  assert.ok(result.episode);assert.deepEqual((await f.db.raw.execute('SELECT * FROM episode_observations')).rows,before);
  assert.equal((await f.db.raw.execute("SELECT count(*) n FROM phase4_operation_receipts WHERE operation_kind='analyzeMetric'")).rows[0].n,1);
});

test('M: every v27 durable migration interruption resumes exactly',async t=>{
  const migration=PHASE4_MIGRATIONS.find(migration=>migration.version===27);
  for(const [index,target] of [...migration.ddl,...migration.indexes,...migration.triggers,'VERSION_ROW'].entries())
    await t.test(`boundary ${index+1}`,async t=>{
      const f=await database(t),execute=f.db.raw.execute.bind(f.db.raw);let injected=false;
      const interrupted={execute:async statement=>{
        const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
        if(!injected&&(sql===target||target==='VERSION_ROW'&&sql.includes('INSERT INTO schema_version')&&statement.args?.[0]===27))
          {injected=true;throw Error('V27_INTERRUPTION');}return result;
      }};
      await assert.rejects(runMigrations(interrupted),/V27_INTERRUPTION/);assert.ok(injected);
      assert.equal(await currentVersion(f.db.raw),target==='VERSION_ROW'?27:26);
      await f.reopen();await f.db.migrate();await f.db.migrate();await assertPhase4Schema(f.db.raw,27);await healthy(f.db);
      assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_operation_receipts')).rows[0].n,0);
    });
});

test('M: exact schema drift fails closed',async t=>{
  const f=await database(t,27);
  await f.db.raw.execute('DROP INDEX p4_operation_receipt_generation');
  await assert.rejects(f.db.migrate(),/schema_postcondition_failed/);
});

// Historical binaries produce the fixtures, including raw representation
// aliases. Current code may authenticate them, but cannot invent a receipt.
for(const [version,shape,rawAlias] of [['pre25','metric',false],['v25','metric',false],['v25','association',false],['rc6','metric',false],['rc6','metric-null',false],
  ['rc6','association',false],['rc6','association-null',false],['rc7','association',false],['rc6','metric-null',true],['rc6','association',true]])
  test(`F/M: real ${version} ${shape}${rawAlias?' ambiguous aliases':''} cutover`,async t=>{
    const fixture=legacyFixture(t,{version,shape,rawAlias}),f=await database(t,26);
    await loadLegacyFixture(f.db,fixture);await f.db.migrate();await healthy(f.db);
    const stores=await createPhase4Foundation({db:f.db,keys:fixtureKeys,now:()=>new Date('2026-09-25T12:00:00.000Z')});
    const context=await stores.capture('a',{executionMode:'SHADOW'});
    async function bind(value) {
      if(value===null||typeof value!=='object')return value;
      if(value.type&&value.id&&value.executionMode)return (await stores.root(context,value.type,value.id)).ref;
      if(Array.isArray(value)){const array=[];for(const entry of value)array.push(await bind(entry));return array;}
      const object={};for(const [key,entry] of Object.entries(value))object[key]=await bind(entry);return object;
    }
    const request=await bind(fixture.request),before={};
    for(const table of ['evidence_runs','evidence_items','phase4_evidence_result_authorities','phase4_operation_receipts'])
      before[table]=(await f.db.raw.execute(`SELECT * FROM ${table}`)).rows;
    await assert.rejects(stores.intelligence[shape.startsWith('association')?'analyzeAssociationFamily':'analyzeMetric'](context,request),
      rawAlias?/LEGACY_IDENTITY_AMBIGUOUS/:/OPERATION_RESULT_UNAVAILABLE/);
    for(const [table,rows] of Object.entries(before))assert.deepEqual((await f.db.raw.execute(`SELECT * FROM ${table}`)).rows,rows);
    if(version==='v25'&&shape==='association') {
      // Pre-v26 has neither modern authority table populated nor v27 receipts.
      // Its original keyed manifests/revisions must carry purge independently.
      await f.db.raw.execute('DELETE FROM phase4_source_links');
      const fact=(await f.db.raw.execute('SELECT logical_fact_id FROM journal_events ORDER BY logical_fact_id LIMIT 1')).rows[0];
      const control=await stores.capturePrivacyControl('a'),purge=await stores.privacy.admit(control,
        {targetType:'JOURNAL_FACT',targetId:fact.logical_fact_id,idempotencyKey:'pre-v26-complete-closure'});
      await stores.privacy.redact(control,purge.purge_id);
      assert.equal((await stores.privacy.complete(control,purge.purge_id)).state,'COMPLETE');
      for(const table of ['evidence_runs','evidence_items','health_insights','insight_revisions'])
        assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${table} WHERE content_state='PRESENT'`)).rows[0].n,0,table);
      assert.equal((await f.db.raw.execute('SELECT count(*) n FROM phase4_operation_receipts')).rows[0].n,0);
    }
  });

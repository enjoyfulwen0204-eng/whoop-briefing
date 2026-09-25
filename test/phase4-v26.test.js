import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb,fixtureKeys } from './localDb.js';
import { runMigrations,currentVersion } from './localMigrations.js';
import { assertPhase4Schema } from '../src/phase4Migrations.js';
import { PHASE4_MIGRATIONS } from '../src/phase4Schema.js';
import { createPhase4Foundation } from '../src/phase4Foundation.js';
import { foundationFlags } from '../src/phase4Flags.js';
import { request,recoveryRefs,analyzeInserted } from './stage5HistoryFixture.js';

const TABLE='phase4_evidence_result_authorities',migration=PHASE4_MIGRATIONS.find(m=>m.version===26);
async function database(t,version=25) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whoop-rc6-v26-')),url=`file:${path.join(dir,'synthetic.db')}`;
  let db=createDb({url});t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  await db.migrate({targetVersion:version});return {get db(){return db;},reopen(){db.close();db=createDb({url});return db;}};
}
async function healthy(db) {
  assert.equal((await db.raw.execute('PRAGMA integrity_check')).rows[0].integrity_check,'ok');
  assert.deepEqual((await db.raw.execute('PRAGMA foreign_key_check')).rows,[]);
}

test('v26 fresh, v25→v26 and full production v20→v26 preserve data and create zero authority rows',async t=>{
  for(const from of [0,20,25])await t.test(`v${from}→v26`,async t=>{
    const f=await database(t,from||26);
    await f.db.createUser({id:'preserved',displayName:'Synthetic production fixture',timezone:'UTC',status:'ACTIVE'});
    const before=(await f.db.raw.execute('SELECT * FROM users')).rows;
    await f.db.migrate();await assertPhase4Schema(f.db.raw,26);
    assert.deepEqual((await f.db.raw.execute('SELECT * FROM users')).rows,before);
    assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${TABLE}`)).rows[0].n,0);
    const fields=(await f.db.raw.execute(`PRAGMA table_info(${TABLE})`)).rows;
    assert.deepEqual(fields.filter(c=>c.pk).map(c=>c.name),['user_id','execution_mode','evidence_item_id','result_scope']);
    assert.ok(fields.filter(c=>c.pk).every(c=>c.notnull===1));
    const definitions=(await f.db.raw.execute('SELECT type,name,sql FROM sqlite_master ORDER BY name')).rows;
    f.reopen();await f.db.migrate();assert.deepEqual((await f.db.raw.execute('SELECT type,name,sql FROM sqlite_master ORDER BY name')).rows,definitions);
    await healthy(f.db);
  });
});

test('v26 every table/index/trigger/version durable interruption reopens and resumes with exact definitions',async t=>{
  const statements=[...migration.ddl,...migration.indexes,...migration.triggers,'VERSION_ROW'];
  for(const [index,target] of statements.entries())await t.test(`boundary ${index+1}`,async t=>{
    const f=await database(t),execute=f.db.raw.execute.bind(f.db.raw);let injected=false;
    const interrupted={execute:async statement=>{
      const result=await execute(statement),sql=typeof statement==='string'?statement:statement.sql;
      if(!injected&&(sql===target||target==='VERSION_ROW'&&sql.includes('INSERT INTO schema_version')&&statement.args?.[0]===26))
        {injected=true;throw Error('RC6_INTERRUPTION');}return result;
    }};
    await assert.rejects(runMigrations(interrupted),/RC6_INTERRUPTION/);assert.ok(injected);
    assert.equal(await currentVersion(f.db.raw),target==='VERSION_ROW'?26:25);
    f.reopen();await f.db.migrate();await f.db.migrate();await assertPhase4Schema(f.db.raw,26);await healthy(f.db);
    assert.equal((await f.db.raw.execute('SELECT count(*) n FROM schema_version WHERE version=26')).rows[0].n,1);
    assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${TABLE}`)).rows[0].n,0);
  });
});

test('v26 real starting-HEAD R1/R2/R3 cutover: no backfill, first new B→R4 survives restart, reused legacy A remains unavailable',async t=>{
  const f=await database(t),fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/stage5-v25-cutover.json',import.meta.url),'utf8'));
  assert.equal(fixture.source_sha,'769d323ffa20f0f744960a0c47c3da1cac827e3b');
  // Load a frozen synthetic dump, then restore/verify every exact v25 guard.
  // No application migration receives permission to drop these guards.
  const triggers=(await f.db.raw.execute("SELECT name,sql FROM sqlite_master WHERE type='trigger'")).rows;
  for(const row of triggers)await f.db.raw.execute(`DROP TRIGGER ${row.name}`);
  await f.db.raw.execute('PRAGMA foreign_keys=OFF');
  for(const [table,{columns,rows}] of Object.entries(fixture.tables))for(const values of rows)
    await f.db.raw.execute({sql:`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`,args:values});
  await f.db.raw.execute('PRAGMA foreign_keys=ON');for(const row of triggers)await f.db.raw.execute(row.sql);
  await assertPhase4Schema(f.db.raw,25);await healthy(f.db);
  const tables=['evidence_items','evidence_runs','episode_events','episode_evidence','phase4_episode_revisions','observation_episodes'],before={};
  for(const table of tables)before[table]=(await f.db.raw.execute(`SELECT * FROM ${table}`)).rows;
  await f.db.migrate();for(const table of tables)assert.deepEqual((await f.db.raw.execute(`SELECT * FROM ${table}`)).rows,before[table]);
  assert.equal((await f.db.raw.execute(`SELECT count(*) n FROM ${TABLE}`)).rows[0].n,0);
  let now=new Date('2026-09-28T12:00:00.000Z');
  const stores=await createPhase4Foundation({db:f.db,keys:fixtureKeys,now:()=>now}),context=await stores.capture('a',{executionMode:'SHADOW'});
  const recoveryIds=Array.from({length:31},(_,i)=>`sleep-${String(i).padStart(2,'0')}`),refs=await recoveryRefs(stores,context,recoveryIds);
  await assert.rejects(stores.intelligence.analyzeMetric(context,request(refs[0],refs.slice(1))),/EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE/);
  const adapter={db:f.db,stores,recoveryIds,setNow(value){now=new Date(value);}};
  const b=await analyzeInserted(adapter,{id:'cutover-B',value:0,healthDate:'2026-09-28',observedAt:'2026-09-28T10:00:00.000Z',asOfUtc:now.toISOString(),
    baselineIds:['third','next-low',...recoveryIds.slice(0,28)]});
  assert.equal(b.episode.episode.row.revision,4);
  const rows=(await f.db.raw.execute(`SELECT * FROM ${TABLE}`)).rows;assert.equal(rows.length,1);
  assert.equal(rows[0].evidence_item_id,b.item.row.evidence_item_id);assert.equal(JSON.parse(rows[0].original_result_json).revision,4);
  const legacyItem=before.evidence_items[0],a=await stores.readArtifact(context,'evidence_items',{evidence_item_id:legacyItem.evidence_item_id});
  await stores.episodes.revise(context,{episodeId:b.episode.episode.row.episode_id,expectedRevision:4,toState:b.episode.episode.row.state,
    patch:{current_confidence:.42},sourceRefs:[a.ref,(await stores.readArtifact(context,'evidence_items',{evidence_item_id:b.item.row.evidence_item_id})).ref],reasonCode:'NEW_EVIDENCE',semanticAt:now.toISOString()});
  f.reopen();const restarted=await createPhase4Foundation({db:f.db,keys:fixtureKeys,now:()=>now}),c=await restarted.capture('a',{executionMode:'SHADOW'});
  const fresh=await recoveryRefs(restarted,c,['cutover-B','third','next-low',...recoveryIds.slice(0,28)]);
  const replay=await restarted.intelligence.analyzeMetric(c,request(fresh[0],fresh.slice(1),now.toISOString()));
  assert.equal(replay.episode.episode.row.revision,4);
  const old=await recoveryRefs(restarted,c,recoveryIds);
  await assert.rejects(restarted.intelligence.analyzeMetric(c,request(old[0],old.slice(1))),/EVIDENCE_RESULT_AUTHORITY_UNAVAILABLE/);
  assert.deepEqual((await f.db.raw.execute(`SELECT * FROM ${TABLE}`)).rows,rows);await healthy(f.db);
});

test('v26 drift is rejected and all phase4 defaults remain off',async t=>{
  const f=await database(t,26);await f.db.raw.execute('DROP INDEX p4_result_authority_run');
  await assert.rejects(f.db.migrate(),/postcondition_failed/);assert.equal(await currentVersion(f.db.raw),26);
  assert.ok(Object.values(foundationFlags({})).every(value=>value===false));
});

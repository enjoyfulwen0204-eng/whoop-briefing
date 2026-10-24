import test from 'node:test';
import assert from 'node:assert/strict';
import {supportedRawDisjointSql,RAW_SOURCE_TABLES} from '../src/processingRawSourceEffects.js';
const tables=new Set([...RAW_SOURCE_TABLES,'evidence_runs','evidence_items','phase4_source_links',
 'schema_version','phase4_jobs','resource_locks','stage8_live_execution_producers','observation_episodes']);
test('fixed bound-value derived writes and original producing-execution upsert are classified only as DATA-disjoint syntax',()=>{
 for(const sql of [
  'INSERT INTO evidence_runs(user_id,execution_mode,state) VALUES (?,?,?)',
  'INSERT OR IGNORE INTO evidence_items(user_id,item_key,value) VALUES (?,?,?)',
  "INSERT INTO phase4_source_links(user_id,artifact_type,source_id) VALUES (?,?,'recovery') ON CONFLICT DO NOTHING",
  `INSERT INTO stage8_live_execution_producers(user_id,execution_mode,input_generation,producing_execution_id,producing_generation,execution_seq,tenant_proof)
   VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,execution_mode,input_generation,producing_execution_id) DO UPDATE SET
   producing_execution_id=excluded.producing_execution_id,producing_generation=excluded.producing_generation,
   execution_seq=excluded.execution_seq,tenant_proof=excluded.tenant_proof`,
  'UPDATE observation_episodes SET state=?,revision=revision+1,updated_at=? WHERE user_id=? AND revision=?',
  'DELETE FROM resource_locks WHERE name=? AND owner=?',
  'INSERT INTO evidence_items VALUES (?,NULL,-2,+3,4.2e-3)',
 ])assert.equal(supportedRawDisjointSql(sql,tables),true,sql);
});
test('all four source targets, source replace/upsert and schema or savepoint changes close retention',()=>{
 for(const table of RAW_SOURCE_TABLES)for(const sql of [
  `INSERT INTO ${table}(user_id,id) VALUES (?,?)`,
  `UPDATE ${table} SET user_id=? WHERE id=?`,
  `DELETE FROM ${table} WHERE user_id=?`,
  `INSERT OR REPLACE INTO ${table} VALUES (?,?)`,
  `INSERT INTO ${table} VALUES (?,?) ON CONFLICT DO UPDATE SET id=excluded.id`,
 ])assert.equal(supportedRawDisjointSql(sql,tables),false,sql);
 for(const sql of ['CREATE TRIGGER surprise AFTER INSERT ON evidence_items BEGIN UPDATE whoop_sleeps SET raw_json=NULL; END',
  'PRAGMA writable_schema=1','PRAGMA foreign_keys=OFF','PRAGMA foreign_keys(0)',
  'ATTACH DATABASE ? AS other','DETACH DATABASE other','SAVEPOINT x','ROLLBACK TO x','RELEASE x',
  'VACUUM','ANALYZE','REINDEX','UPDATE missing_table SET value=?'])
  assert.equal(supportedRawDisjointSql(sql,tables),false,sql);
});
test('function effects, quoted function names, derived replace, CTE writes and second statements are unsupported',()=>{
 for(const sql of [
  'INSERT INTO evidence_items VALUES (side_effect(?))',
  'UPDATE evidence_items SET value=side_effect(?) WHERE user_id=?',
  'DELETE FROM evidence_items WHERE side_effect(user_id)',
  "SELECT load_extension('x')","SELECT eval('UPDATE whoop_sleeps SET raw_json=NULL')",
  "SELECT 'eval'('UPDATE whoop_sleeps SET raw_json=NULL')",
  'SELECT "eval"(?)','SELECT `eval`(?)','SELECT [eval](?)',
  'SELECT FILTER(?)','SELECT OVER(?)','DELETE FROM evidence_items WHERE FILTER(?)',
  'SELECT ? REGEXP ?','SELECT ? LIKE ?','SELECT ? GLOB ?','SELECT ? MATCH ?',
  "SELECT ? -> '$.x'","SELECT ? ->> '$.x'",
  'DELETE FROM evidence_items WHERE user_id GLOB ?',
  'SELECT CURRENT_DATE','SELECT CURRENT_TIME','SELECT CURRENT_TIMESTAMP',
  'UPDATE evidence_items SET value=CURRENT_TIMESTAMP',
  'UPDATE evidence_items SET value=? WHERE OVER(?)',
  'SELECT * FROM evidence_items ORDER BY user_id COLLATE provider_extra',
  'DELETE FROM evidence_items WHERE user_id COLLATE provider_extra=?',
  'UPDATE evidence_items SET value=? WHERE user_id COLLATE NOCASE=?',
  'INSERT OR REPLACE INTO evidence_items VALUES (?)',
  'WITH c AS (SELECT 1) UPDATE evidence_items SET value=?',
  'WITH expected(execution_id,receipt_key) AS (VALUES (side_effect(?),?)) SELECT * FROM expected',
  'WITH expected(execution_id,receipt_key) AS (VALUES (?,?)) DELETE FROM evidence_items',
  'WITH expected(other,receipt_key) AS (VALUES (?,?)) SELECT * FROM expected',
  'SELECT 1; UPDATE whoop_sleeps SET raw_json=NULL',
  'UPDATE evidence_items SET value=?; DELETE FROM whoop_sleeps',
  'SELECT /* unexpected */ 1','SELECT 1 -- unexpected',
  'INSERT INTO evidence_items VALUES (?) RETURNING user_id',
  'INSERT INTO evidence_items SELECT * FROM whoop_sleeps',
 ])assert.equal(supportedRawDisjointSql(sql,tables),false,sql);
});
test('same exact data reads and fixed read-only pragmas have no execution authority',()=>{
 for(const sql of ['SELECT * FROM whoop_recoveries WHERE user_id=? AND sleep_id=?',
  "SELECT count(*) n FROM phase4_jobs WHERE user_id=? AND state IN ('PENDING','RUNNING')",
  'SELECT MAX(version) v FROM schema_version','SELECT CAST(? AS INTEGER)',
  'SELECT * FROM evidence_items WHERE user_id=? AND (value=? OR value IS NULL)',
  'SELECT json_array(user_id,value) FROM (SELECT user_id,value FROM evidence_items) WHERE user_id>? COLLATE BINARY ORDER BY user_id COLLATE BINARY',
  'WITH expected(execution_id,receipt_key) AS (VALUES (?,?),(?,?)) SELECT r.* FROM expected x JOIN evidence_items r ON r.user_id=x.execution_id WHERE r.value=?',
  'PRAGMA foreign_keys','PRAGMA table_info(evidence_items)','PRAGMA database_list'])
  assert.equal(supportedRawDisjointSql(sql,tables),true,sql);
 assert.equal(supportedRawDisjointSql('SELECT * FROM whoop_sleeps',null),false);
 assert.equal(supportedRawDisjointSql('SELECT * FROM whoop_sleeps',{}),false);
 let calls=0;assert.equal(supportedRawDisjointSql({toString(){calls++;return 'SELECT 1';}},tables),false);
 assert.equal(calls,0);assert.equal(supportedRawDisjointSql('SELECT '+ 'x'.repeat(8192),tables),false);
});

test('every nested relation, module, pragma target and unparsed relation group closes DATA',()=>{
 for(const sql of [
  'SELECT * FROM evil_module','SELECT * FROM evil_module(?)',
  'SELECT 1 IN evil_module','SELECT 1 IN evil_module(?)',
  'SELECT 1 NOT IN evil_module','SELECT * FROM evidence_items WHERE user_id IN evil_module',
  'SELECT * FROM evidence_items JOIN evil_module ON 1',
  'SELECT * FROM evidence_items,evil_module',
  'SELECT * FROM (evidence_items JOIN evil_module)',
  'SELECT * FROM (SELECT * FROM evil_module)',
  'SELECT * FROM evidence_items WHERE EXISTS(SELECT 1 FROM evil_module)',
  'SELECT * FROM evidence_items UNION SELECT * FROM evil_module',
  'SELECT * FROM main.evidence_items',
  'SELECT * FROM evidence_items INDEXED BY unknown_index',
  'SELECT * FROM JSON_EACH','PRAGMA table_info(evil_module)',
  'PRAGMA index_info(evil_module)',
  'WITH expected(execution_id,receipt_key) AS (VALUES (?,?)) SELECT * FROM expected JOIN evil_module ON 1',
 ])assert.equal(supportedRawDisjointSql(sql,tables),false,sql);
 for(const sql of ['SELECT * FROM JSON_EACH(?)',
  'SELECT * FROM evidence_items WHERE EXISTS(SELECT 1 FROM phase4_jobs)',
  'SELECT * FROM (SELECT * FROM evidence_items UNION SELECT * FROM evidence_items)',
  'SELECT * FROM evidence_items e JOIN JSON_EACH(?) j ON e.user_id=j.value',
 ])assert.equal(supportedRawDisjointSql(sql,tables),true,sql);
});

test('only finite existing exact-real transport CAST chains are supported as VALUES atoms',()=>{
 for(const sql of [
  'INSERT INTO evidence_items(value) VALUES ((CAST(? AS REAL)/CAST(? AS REAL)))',
  'UPDATE evidence_items SET value=(CAST(? AS REAL)*CAST(? AS REAL)/CAST(? AS REAL)) WHERE user_id=?',
 ])assert.equal(supportedRawDisjointSql(sql,tables),true,sql);
 for(const expr of ['(CAST(side_effect(?) AS REAL))','(CAST((SELECT 1) AS REAL))',
  '(CAST(? AS REAL)+CAST(? AS REAL))','(CAST(? AS INTEGER)/CAST(? AS REAL))',
  '(CAST(? AS REAL)/evil(?))','(CAST(? AS REAL)'+ '/CAST(? AS REAL)'.repeat(19)+')',
 ])assert.equal(supportedRawDisjointSql('INSERT INTO evidence_items(value) VALUES ('+expr+')',tables),false,expr);
});

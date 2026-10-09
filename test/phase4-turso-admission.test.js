import test from 'node:test';
import assert from 'node:assert/strict';
import {deliveryFixture,fixtureKeys} from './deliveryDefaultFixture.js';
import {admitRuntime} from '../src/runtimeAdmission.js';
import {inRuntimeMetadata,withRuntimeMetadata} from '../src/runtimeMetadataContext.js';
import {createDb as createFixtureDb} from './localDb.js';

const constraintRead='SELECT ignore_check_constraints FROM pragma_ignore_check_constraints()';

test('HTTP admission retains five actual reads when the provider rejects direct CHECK PRAGMA',async t=>{
 const {db}=await deliveryFixture(t),execute=db.raw.execute,queries=[];
 db.raw.execute=async statement=>{
  const sql=typeof statement==='string'?statement:statement.sql;queries.push(sql);
  if(sql==='PRAGMA ignore_check_constraints')throw Object.assign(Error('SQL not allowed statement: PRAGMA ignore_check_constraints'),{code:'SQL_PARSE_ERROR'});
  return execute(statement);
 };
 const capability=await admitRuntime(db.raw,fixtureKeys);
 assert.equal(db.requireRuntimeAdmission(capability),32);
 assert.equal(queries.length,5);
 assert.equal(queries.filter(sql=>sql===constraintRead).length,1);
 assert.ok(queries.every(sql=>sql.startsWith('SELECT ')||sql==='PRAGMA foreign_keys'));
});

test('table-function admission still rejects disabled CHECK enforcement on the actual connection',async t=>{
 const db=createFixtureDb({url:':memory:'});t.after(()=>db.close());await db.migrate();
 await db.raw.execute('PRAGMA ignore_check_constraints=ON');
 assert.equal((await db.raw.execute(constraintRead)).rows[0].ignore_check_constraints,1);
 await assert.rejects(()=>admitRuntime(db.raw,fixtureKeys),/PHASE4_CHECK_CONSTRAINTS_DISABLED/);
 await db.raw.execute('PRAGMA ignore_check_constraints=OFF');
 await admitRuntime(db.raw,fixtureKeys);
});

for(const rows of [[],[{}],[{ignore_check_constraints:1}],[{ignore_check_constraints:null}],
 [{ignore_check_constraints:false}],[{ignore_check_constraints:'0'}],[{ignore_check_constraints:0},{ignore_check_constraints:0}]])
 test(`constraint state is required, never inferred from an unavailable read: ${JSON.stringify(rows)}`,async t=>{
  const {db}=await deliveryFixture(t),execute=db.raw.execute;
  db.raw.execute=async statement=>(typeof statement==='string'?statement:statement.sql)===constraintRead?{rows}:execute(statement);
  await assert.rejects(()=>admitRuntime(db.raw,fixtureKeys),/PHASE4_CHECK_CONSTRAINTS_DISABLED/);
 });

test('metadata exemption remains scoped to the exact read-only constraint query',()=>{
 assert.equal(inRuntimeMetadata(constraintRead),false);
 withRuntimeMetadata(()=>{
  assert.equal(inRuntimeMetadata(constraintRead),true);
  for(const sql of ['PRAGMA ignore_check_constraints','PRAGMA ignore_check_constraints=OFF',
   constraintRead+' WHERE 1=1','SELECT * FROM pragma_ignore_check_constraints',
   constraintRead+'; UPDATE users SET status=\'ACTIVE\'',
   'SELECT user_id FROM user_whoop_tokens'])assert.equal(inRuntimeMetadata(sql),false,sql);
 });
});

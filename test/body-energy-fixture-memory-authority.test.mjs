import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
import {syntheticPhase4Fixture} from './phase4Fixture.js';import {createDb} from '../src/db.js';
import {authorizeBodyEnergyFixturePublication,assertBodyEnergyPublication} from '../src/bodyEnergyQualificationAuthority.js';
test('fixture authority allows only its memory main and optional internal temp schema, with fresh checks',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35,ownedConnection:true});
 const rows=(await f.db.raw.execute('PRAGMA database_list')).rows;assert.ok(rows.some(r=>r.name==='temp'));assert.ok(rows.every(r=>r.file===''));
 const grant=await authorizeBodyEnergyFixturePublication({db:f.db,userIds:['a']});assert.equal((await assertBodyEnergyPublication(grant,f.db,'a')).fixture,true);
 await f.db.raw.execute("ATTACH DATABASE ':memory:' AS extra");
 await assert.rejects(assertBodyEnergyPublication(grant,f.db,'a'),/FIXTURE_MEMORY_REQUIRED/);
 await assert.rejects(authorizeBodyEnergyFixturePublication({db:f.db,userIds:['a']}),/FIXTURE_MEMORY_REQUIRED/);
 await f.db.raw.execute('DETACH DATABASE extra');assert.equal((await assertBodyEnergyPublication(grant,f.db,'a')).fixture,true);
});
test('file-backed and provider destinations never obtain fixture publication authority',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'body-fixture-authority-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=createDb({url:pathToFileURL(join(dir,'empty.db')).href});t.after(()=>db.close());
 await assert.rejects(authorizeBodyEnergyFixturePublication({db,userIds:['a']}),/FIXTURE_MEMORY_REQUIRED/);
 const remote={raw:{protocol:'https',execute:()=>{throw Error('MUST_NOT_CONNECT');}}};
 await assert.rejects(authorizeBodyEnergyFixturePublication({db:remote,userIds:['a']}),/FIXTURE_MEMORY_REQUIRED/);
});

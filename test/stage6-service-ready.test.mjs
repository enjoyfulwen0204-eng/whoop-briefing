import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';
import {seedServiceReadyFixture} from './stage6ServiceReadyFixture.mjs';
const retained=process.env.STAGE6_SYNTHETIC_RETAINED_DB;
test('retained synthetic tenant enrolls through real service contracts without promoting historical receipts',{skip:!retained},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'stage6-ready-')),target=join(directory,'checkpoint.sqlite');
 try{
  // SQLite backup reads committed WAL content. immutable=1 is forbidden here.
  const copied=spawnSync('python3',['-c',"import sqlite3,sys; s=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()",resolve(retained),target],{encoding:'utf8'});assert.equal(copied.status,0,copied.stderr);
  const result=await seedServiceReadyFixture('file:'+target);assert.equal(result.identities.length,4);assert.equal(result.identities[0].authGeneration,2);assert.equal(result.preservedReceiptCount,19);assert.equal(result.journalAfter,'wal');assert.equal(result.busyTimeoutMs,0);
  assert.ok(result.afterJobs.every(j=>j.full_scan_cursor===null&&j.completed_generation===0));
  if(process.env.STAGE6_READINESS_EVIDENCE)await writeFile(process.env.STAGE6_READINESS_EVIDENCE,JSON.stringify(result,null,2));
 }finally{await rm(directory,{recursive:true,force:true});}
});

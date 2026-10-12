import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
test('opaque Journal callback is durable across three separate Node processes with stale replay rejected',()=>{
 const dir=mkdtempSync(join(tmpdir(),'stage7-process-'));try{
  for(const mode of ['create','resolve','stale']){
   const child=spawnSync(process.execPath,['test/stage7Process.js',mode,join(dir,'synthetic.db'),join(dir,'synthetic-packet.json')],{encoding:'utf8',timeout:30000});
   assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/PASS/);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

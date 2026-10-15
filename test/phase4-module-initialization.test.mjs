import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
for(const path of ['src/stage7Cards.js','src/bodyEnergyQualificationAuthority.js','src/stage8LiveProducer.js','src/phase4Redaction.js'])test('fresh process module initialization: '+path,()=>{
 const result=spawnSync(process.execPath,['--input-type=module','-e','await import('+JSON.stringify(new URL('../'+path,import.meta.url).href)+');'],{encoding:'utf8',timeout:10000});
 assert.equal(result.error,undefined);assert.equal(result.signal,null,result.stderr);assert.equal(result.status,0,result.stderr);
});

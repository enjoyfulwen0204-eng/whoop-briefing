import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('bounded actual main: final readonly guards, single batch, late commit/uncertain readonly reconciliation',async t=>{
 for(const mode of ['success','deadline-in-last-read','deadline-in-final-guard','late-after-commit','late-before-commit','abort-after-commit'])await t.test(mode,()=>{
  const child=spawnSync(process.execPath,['--experimental-test-module-mocks','test/stage8BoundedMigrationChild.mjs',mode],{cwd:new URL('../',import.meta.url),encoding:'utf8',env:Object.fromEntries(Object.entries(process.env).filter(([name])=>name!=='NODE_TEST_CONTEXT')),timeout:60000});
  assert.equal(child.status,0,child.stdout+child.stderr);const result=JSON.parse(child.stdout.trim().split('\n').at(-1));assert.equal(result.status,'PASS');
 });
});

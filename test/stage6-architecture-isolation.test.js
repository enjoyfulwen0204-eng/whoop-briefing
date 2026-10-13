import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../',import.meta.url)),preloader='./test/stage6ArchitectureIsolatedProfile.js';
for(const [name,args] of [
 ['ordinary service entry',['server.js','test/stage6-raw-capacity-profile.test.js']],
 ['eval with appended approved test',['-e','console.log("NON_TEST_ENTRY_ACCEPTED")','server.js','test/stage6-raw-capacity-profile.test.js']],
 ['eval spoofing argv1',['-e','console.log("NON_TEST_ENTRY_ACCEPTED")','test/stage6-raw-capacity-profile.test.js']],
])test('isolated preloader rejects '+name,()=>{
 const r=spawnSync(process.execPath,['--import',preloader,...args],{cwd,encoding:'utf8',env:{...process.env,STAGE6_ISOLATED_EXTENDED:'180',RAW_PROFILE_TRIGGER:'github'}});
 assert.notEqual(r.status,0);assert.match(r.stderr,/ISOLATED_ARCHITECTURE_TEST_ONLY/);assert.doesNotMatch(r.stdout,/NON_TEST_ENTRY_ACCEPTED|ISOLATED_ARCHITECTURE_MODEL/);
});

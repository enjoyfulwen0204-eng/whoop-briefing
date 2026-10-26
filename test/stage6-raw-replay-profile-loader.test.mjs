import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {initialize,load} from './stage6RawReplayProfileLoader.mjs';
const root=new URL('../src/',import.meta.url).href;initialize({root});
for(const name of ['phase4Reanalysis.js','phase4IntelligenceStore.js'])test('closed diagnostic anchors parse without executing application: '+name,async()=>{
 const url=root+name,source=await readFile(new URL(url),'utf8');
 const transformed=await load(url,{},async()=>({format:'module',source}));
 assert.notEqual(transformed.source,source);assert.ok(transformed.source.includes('__stage6RawReplayProfile.measure'));
 const syntax=spawnSync(process.execPath,['--input-type=module','--check'],{input:transformed.source,encoding:'utf8',timeout:5000});
 assert.equal(syntax.status,0,syntax.stderr);
 await assert.rejects(load(url,{},async()=>({format:'module',source:''})),/RAW_REPLAY_PROFILE_SOURCE_MISMATCH/);
 await assert.rejects(load(url,{},async()=>({format:'module',source:source+'\n'+source})),/RAW_REPLAY_PROFILE_SOURCE_MISMATCH/);
});
test('unrelated module bytes remain identical',async()=>{
 const value={format:'module',source:'export const unaffected=1;'};
 assert.deepEqual(await load(root+'unrelated.js',{},async()=>value),value);
});

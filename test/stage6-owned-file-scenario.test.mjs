import test from 'node:test';import assert from 'node:assert/strict';
import {ownedFileScenario,scenarioInput,assertPreservedGenerations,assertCurrentOriginalReplay} from './stage6-owned-file-scenario.mjs';
test('closed three-tenant fixture has 23 original synthetic sources with separate IDs and actual recovery/sleep relationships',()=>{
 const s=ownedFileScenario('three-tenant'),ids=new Set();let count=0;
 for(const uid of s.users){const input=scenarioInput(s,uid,Date.now()-1000);assert.equal(input.userId,uid);
  for(const rows of [...Object.values(input.sources),input.access,input.sync,input.capabilities])for(const row of rows)assert.equal(row.user_id,uid);
  for(const recovery of input.sources.recovery)assert.ok(input.sources.sleep.some(row=>row.id===recovery.sleep_id));
  for(const row of [...input.sources.sleep,...input.sources.cycle]){assert.equal(ids.has(row.id),false);ids.add(row.id);}
  count+=Object.values(input.sources).reduce((n,rows)=>n+rows.length,0);
 }assert.equal(count,23);assert.equal(s.jobs,6);assert.throws(()=>ownedFileScenario('four'));assert.throws(()=>scenarioInput(s,'d',Date.now()));
});
test('verified original result replay without a currently valid publication cannot pass the FILE reader gate',()=>{
 assertCurrentOriginalReplay({replayed:true,publication:{status:'CURRENT'}});
 for(const value of [{replayed:true,publication:{status:'ANALYSIS_UPDATING'}},{replayed:true},{replayed:false,publication:{status:'CURRENT'}}])assert.throws(()=>assertCurrentOriginalReplay(value));
});
test('original representative fixture remains 17 rows and existing generations cannot be replaced',()=>{
 const s=ownedFileScenario(),input=scenarioInput(s,'a',Date.now());assert.equal(input.sources.sleep[0].id,'sleep-00');assert.equal(Object.values(input.sources).flat().length,17);
 assertPreservedGenerations({a:'old'},{a:'old',b:'new'});assert.throws(()=>assertPreservedGenerations({a:'old'},{a:'new'}));
});

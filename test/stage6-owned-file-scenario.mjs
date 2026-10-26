import assert from 'node:assert/strict';
import {bodyInput} from './bodyEnergyFixture.js';
const cases=Object.freeze({
 representative:Object.freeze({name:'representative',users:Object.freeze(['a']),sources:17,jobs:2}),
 'three-tenant':Object.freeze({name:'three-tenant',users:Object.freeze(['a','b','c']),sources:23,jobs:6}),
});
export function ownedFileScenario(name='representative'){assert.ok(Object.hasOwn(cases,name),'CLOSED_FILE_SCENARIO_REQUIRED');return cases[name];}
export function scenarioInput(scenario,uid,asOf){
 assert.ok(scenario===cases[scenario.name]&&scenario.users.includes(uid));
 const input=bodyInput({asOf,days:uid==='a'?7:0});
 if(scenario.name==='representative')return input;
 const row=value=>({...value,user_id:uid,...(value.id?{id:uid+'-'+value.id}:{}),...(value.sleep_id?{sleep_id:uid+'-'+value.sleep_id}:{})});
 return {...input,userId:uid,sources:Object.fromEntries(Object.entries(input.sources).map(([kind,rows])=>[kind,rows.map(row)])),access:input.access.map(row),sync:input.sync.map(row),capabilities:input.capabilities.map(row)};
}
export function assertPreservedGenerations(before,after){for(const [id,digest]of Object.entries(before))assert.equal(after[id],digest,'ORIGINAL_GENERATION_CHANGED');}
export function assertCurrentOriginalReplay(value){assert.equal(value.replayed,true);assert.equal(value.publication?.status,'CURRENT','ORIGINAL_REPLAY_CURRENT_PUBLICATION_REQUIRED');}

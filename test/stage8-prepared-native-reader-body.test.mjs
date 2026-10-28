import test from 'node:test';
import assert from 'node:assert/strict';
import {bodyInput} from './bodyEnergyFixture.js';
import {selectBodyEnergyInputs} from '../src/bodyEnergyInputs.js';
import {calculateBodyEnergy} from '../src/bodyEnergy.js';
import {nativeReaderBodyExpectation as check} from './stage8-prepared-native-reader-body.mjs';
function fixture(){
 const input=bodyInput({days:27});for(const sync of input.sync)sync.last_success_at=new Date(input.asOfEpochMs-85*60000).toISOString();
 const {manifest}=selectBodyEnergyInputs(input),calculation=calculateBodyEnergy(manifest);
 const row={user_id:'a',execution_mode:'LIVE',as_of_epoch_ms:manifest.as_of_epoch_ms,input_manifest_json:JSON.stringify(manifest),
  value:calculation.value,quality_state:calculation.quality_state,confidence:calculation.confidence,algorithm_version:calculation.algorithm_version};
 return {at:input.asOfEpochMs,value:{tables:[{name:'body_energy_results',columns:Object.keys(row),rows:[Object.values(row)]}]}};
}
test('fresh and expired native reader scopes retain the original inclusive freshness boundary',()=>{
 const {at,value}=fixture(),before=JSON.stringify(value),last=at+5*60000;
 assert.equal(check(value,last).expectedItems,1);assert.throws(()=>check(value,last,'EXPIRED_LIMITED'));
 assert.throws(()=>check(value,last+1),/FRESH_BODY_FIXTURE_REQUIRED/);
 const stale=check(value,last+1,'EXPIRED_LIMITED');assert.equal(stale.expectedItems,0);assert.equal(stale.positiveLimitedQualified,false);assert.equal(stale.staleExclusionQualified,true);
 assert.equal(JSON.stringify(value),before,'NO_FIXTURE_TIME_OR_DATA_MUTATION');
});
test('an invalid or missing capture cannot become an expired-body qualification',()=>{
 for(const mutation of [f=>f.tables[0].rows.pop(),f=>f.tables[0].rows.push(f.tables[0].rows[0]),f=>f.tables[0].rows[0][0]='other',
  f=>f.tables[0].rows[0][1]='SHADOW',f=>f.tables[0].rows[0][4]++]){
  const {at,value}=fixture();mutation(value);assert.throws(()=>check(value,at+86400000,'EXPIRED_LIMITED'));
 }
 const {at,value}=fixture();for(const mode of ['AUTO',null])assert.throws(()=>check(value,at,mode));
 for(const now of [NaN,Infinity,at-1])assert.throws(()=>check(value,now));
});

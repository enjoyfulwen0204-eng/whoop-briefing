// Explicit synthetic fixture scope, never runtime authority or a clock change.
import assert from 'node:assert/strict';
import {stage8BodyEnergyProjection} from '../src/stage8BodyEnergyProjection.js';
import {BODY_ENERGY_RELEASE_CRITERIA} from '../src/bodyEnergyReleaseCriteria.js';
export function nativeReaderBodyExpectation(fixture,asOfEpochMs,mode='FRESH_LIMITED'){
 assert.ok(['FRESH_LIMITED','EXPIRED_LIMITED'].includes(mode));
 assert.ok(Number.isSafeInteger(asOfEpochMs));
 const tables=fixture.tables.filter(table=>table.name==='body_energy_results');assert.equal(tables.length,1);
 const rows=tables[0].rows.map(values=>Object.fromEntries(tables[0].columns.map((column,i)=>[column,values[i]])));
 assert.equal(rows.length,1,'EXACT_ORIGINAL_BODY_CAPTURE');const row=rows[0];
 assert.equal(row.user_id,'a');assert.equal(row.execution_mode,'LIVE');
 const original=stage8BodyEnergyProjection(row,row.as_of_epoch_ms);
 assert.ok(original?.quality==='LIMITED'&&original.provisional===true&&original.estimated===true,'GENUINE_ORIGINAL_LIMITED_CAPTURE');
 const manifest=JSON.parse(row.input_manifest_json),ages=[manifest.sync.sleep.age_ms,manifest.sync.recovery.age_ms,manifest.load.sync.age_ms];
 assert.ok(ages.every(age=>Number.isFinite(age)&&age>=0));
 const lastFreshAt=row.as_of_epoch_ms+BODY_ENERGY_RELEASE_CRITERIA.freshMaximumMs-Math.max(0,...ages);
 const current=stage8BodyEnergyProjection(row,asOfEpochMs);
 if(mode==='FRESH_LIMITED'){
  assert.ok(asOfEpochMs>=row.as_of_epoch_ms&&asOfEpochMs<=lastFreshAt&&current,'FRESH_BODY_FIXTURE_REQUIRED');
 }else{
  assert.ok(asOfEpochMs>lastFreshAt,'ORIGINAL_BODY_FRESHNESS_MUST_HAVE_EXPIRED');
  assert.equal(current,null,'EXPIRED_BODY_MUST_BE_EXCLUDED');
 }
 return Object.freeze({mode,fixtureAsOfEpochMs:row.as_of_epoch_ms,scopeAsOfEpochMs:asOfEpochMs,lastFreshAt,
  expectedItems:mode==='FRESH_LIMITED'?1:0,positiveLimitedQualified:mode==='FRESH_LIMITED',staleExclusionQualified:mode==='EXPIRED_LIMITED'});
}

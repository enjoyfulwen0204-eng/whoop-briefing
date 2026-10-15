import test from 'node:test';
import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
import {insertCoverage} from './stage5AssociationFixture.js';
import {validateCoverageNode} from '../src/phase4CoverageLineage.js';
for(const at of ['2026-10-15T15:59:00.000Z','2026-10-15T16:01:00.000Z'])test('synthetic coverage remains a completed assertion across Taipei midnight '+at,async t=>{
 const f=await syntheticPhase4Fixture(t,{now:()=>new Date(at)});
 await insertCoverage(f,{startDate:'2026-10-13',endDate:at.includes('16:')?'2026-10-15':'2026-10-14',recordedAt:at});
 const row=(await f.db.raw.execute('SELECT * FROM journal_coverage_windows')).rows[0];
 assert.equal(validateCoverageNode(row,'a'),row);
 assert.ok(Date.parse(row.window_end_utc)<=Date.parse(row.created_at));
 assert.equal(row.window_end_utc,at.includes('16:')?at:'2026-10-15T00:00:00.000Z');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyFixture } from './stage5LegacyFixture.js';

for(let iteration=1;iteration<=12;iteration++)test(`T002: isolated RC6 metric-null fixture ${iteration}/12`,t=>{
  let outcome;
  const fixture=legacyFixture(t,{version:'rc6',shape:'metric-null',onExit:value=>{outcome=value;t.diagnostic(JSON.stringify(value));}});
  assert.equal(fixture.version,'8e377dc');
  assert.equal(fixture.tables.evidence_runs.length,1);
  assert.equal(fixture.tables.evidence_runs[0].state,'COMPLETED');
  assert.equal(fixture.tables.evidence_items.length,1);
  assert.equal(fixture.tables.observation_episodes,undefined);
  assert.equal(fixture.tables.phase4_operation_receipts,undefined);
  assert.equal(fixture.request.baselineSources.length,0);
  assert.equal(outcome.assertions,'COMPLETED');
  assert.deepEqual(outcome.ownership,{connections:0,closeCalls:1,cleanup:'CLOSED'});
  assert.equal(outcome.status,0);assert.equal(outcome.signal,null);
  assert.equal(outcome.error,null);assert.equal(outcome.orphan,false);
});

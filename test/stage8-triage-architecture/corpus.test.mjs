import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {interpretUrgentSymptoms,TRIAGE_DECISION} from '../../src/bot/triage.js';
const corpus=JSON.parse(fs.readFileSync(new URL('./independent-corpus.json',import.meta.url)));
assert.equal(corpus.distinctCases,94);assert.equal(new Set(corpus.cases.map(c=>c.text)).size,94);
for(const c of corpus.cases)test(c.id+' '+c.cause,()=>{
 const r=interpretUrgentSymptoms(c.text);
 assert.equal(r.urgent,c.expectedUrgent);
 assert.equal(r.decision!==TRIAGE_DECISION.CLEARLY_NONURGENT,c.expectedUrgent);
 for(const m of r.mentions){
  assert.ok(m.evidence);assert.ok(['ACTUAL','TOPIC','UNRESOLVED'].includes(m.evidence.assertion));
  assert.ok(['CURRENT','PAST','UNKNOWN'].includes(m.evidence.temporal));
  assert.ok(['POSITIVE','NEGATED'].includes(m.evidence.polarity));
  assert.ok(m.evidence.relationship);
 }
});

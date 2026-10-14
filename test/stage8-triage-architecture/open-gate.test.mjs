import test from 'node:test';import assert from 'node:assert/strict';
import {interpretUrgentSymptoms} from '../../src/bot/triage.js';
// These expectations are deliberately retained as failures. Architecture
// correction is NO-GO until predicate ownership survives these transformations.
const cases=[
 'I had chest pain yesterday whereas my friend has difficulty breathing.',
 'I had chest pain yesterday whereas I have difficulty breathing.',
 '我昨天胸痛然而我呼吸困難。',
];
for(const [i,text] of cases.entries())test('OPEN later-current-predicate-'+(i+1),()=>{
 assert.equal(interpretUrgentSymptoms(text).urgent,true);
});

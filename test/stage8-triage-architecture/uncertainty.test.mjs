import test from 'node:test';import assert from 'node:assert/strict';
import {interpretUrgentSymptoms,TRIAGE_DECISION} from '../../src/bot/triage.js';
const cases=[
 ['POSSIBLE_CURRENT_URGENT','I wonder if I have chest pain.'],
 ['POSSIBLE_CURRENT_URGENT','I am not sure whether I have difficulty breathing.'],
 ['POSSIBLE_CURRENT_URGENT','Tôi không chắc tôi có đau ngực.'],
 ['POSSIBLE_CURRENT_URGENT','我不確定我有胸痛。'],
 ['CURRENT_URGENT','I want to know if my current chest pain is dangerous.'],
 ['CLEARLY_NONURGENT','If I have chest pain now, what should I do?'],
 ['CLEARLY_NONURGENT','I am learning what to do if I have chest pain now.'],
 ['CURRENT_URGENT','I have chest pain after feeling fine yesterday.'],
 ['CURRENT_URGENT','I have chest pain and I am asking what causes it.'],
 ['CLEARLY_NONURGENT','My chest pain has not returned.'],
 ['CLEARLY_NONURGENT','My chest pain has resolved and has not returned.'],
 ['CURRENT_URGENT','My chest pain has resolved and it has returned now.'],
 ['CLEARLY_NONURGENT','I have no chest pain, or any difficulty breathing, or dizziness.'],
 ['CURRENT_URGENT','I have no chest pain, but I do have difficulty breathing.'],
 ['CURRENT_URGENT','I am not only having chest pain but difficulty breathing.'],
 ['CURRENT_URGENT','I had chest pain. It was gone. I am experiencing it now.'],
];
for(const [i,[expected,text]] of cases.entries())test('assertion-currentness-'+(i+1),()=>{
 assert.equal(interpretUrgentSymptoms(text).decision,TRIAGE_DECISION[expected]);
});

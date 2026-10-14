import fs from 'node:fs';import test from 'node:test';import assert from 'node:assert/strict';
import {interpretUrgentSymptoms as parse,assessUrgency,TRIAGE_LIMITS} from '../../src/bot/triage.js';
const corpus=JSON.parse(fs.readFileSync(new URL('./cases.json',import.meta.url)));
for(const [category,cases]of Object.entries({multilingual:corpus.cases,metamorphic:corpus.metamorphic,benignWarning:corpus.benignWarnings}))for(const c of cases)test(category+' '+c.id,()=>{
 const r=parse(c.text);assert.equal(r.decision,c.expected,JSON.stringify(r));assert.equal(assessUrgency(c.text).decision,r.decision);
 const g=r.ownership;assert.ok(g);assert.ok(r.safetyGate);const ps=new Map(g.predicates.map(p=>[p.id,p]));
 for(const [xs,key]of[[g.symptoms,'symptomIds'],[g.operators,'operatorIds']])for(const x of xs){assert.ok(ps.get(x.ownerPredicateId));assert.equal(g.predicates.filter(p=>p[key].includes(x.id)).length,1);}
 if(c.expected==='CLEARLY_NONURGENT'){assert.equal(r.safetyGate.unresolved.length,0);assert.equal(r.safetyGate.continuations.length,0);assert.equal(r.safetyGate.exclusions.length,r.safetyGate.candidateIds.length);}
 for(const c of r.safetyGate.continuations){assert.equal(ps.get(c.sourcePredicateId).actorId,c.actorId);assert.equal(ps.get(c.predicateId).actorId,c.actorId);assert.ok(g.links.some(l=>l.id===c.linkId));for(const id of c.operatorIds)assert.equal(g.operators.find(o=>o.id===id).ownerPredicateId,c.predicateId);assert.equal(ps.get(c.predicateId).symptomIds.length,0);}
 for(const p of ps.values()){assert.ok(Object.isFrozen(r.mentions.find(m=>m.predicateId===p.id)?.evidence??Object.freeze({})));assert.ok(p.operatorIds.length<=TRIAGE_LIMITS.operators);}
});
test('reducer inspection data never escapes the three-state ingress adapter',()=>{const r=assessUrgency('My chest pain started yesterday and is still present.');assert.deepEqual(Object.keys(r).sort(),['decision','excluded','matched','urgent']);});
test('CURRENT evidence wins over unresolved or excluded candidates',()=>{for(const tail of ['I had chest pain yesterday.','My friend has no chest pain.','It is unclear.'])assert.equal(parse('I have difficulty breathing. '+tail).decision,'CURRENT_URGENT');});
test('unmatched outcome cannot retire positive evidence',()=>{const r=parse('I have chest pain. My job has resolved.');assert.equal(r.decision,'CURRENT_URGENT');assert.ok(!r.ownership.links.some(l=>l.type==='OUTCOME'));});

test('unaccounted resolution argument cannot prove absence',()=>assert.equal(parse('I have chest pain the headache has resolved.').decision,'POSSIBLE_CURRENT_URGENT'));
test('weak pair with unresolved time remains POSSIBLE',()=>assert.equal(parse('I have palpitations. I have had dizziness.').decision,'POSSIBLE_CURRENT_URGENT'));

for(const text of ['My chest pain started yesterday and persists.','我昨天胸痛而且持續。','Tôi đau ngực hôm qua và vẫn còn.','My chest pain started yesterday and 持續。'])test('missing parser operators do not exclude '+text,()=>assert.equal(parse(text).decision,'POSSIBLE_CURRENT_URGENT'));

for(const [text,decision]of [['My chest pain resolved and has returned badly.','CURRENT_URGENT'],['我胸痛好了而且又出現很嚴重。','POSSIBLE_CURRENT_URGENT'],['Tôi đã hết đau ngực và có tái phát nghiêm trọng.','CURRENT_URGENT']])test('closed ancestor cannot exclude new continuation '+text,()=>assert.equal(parse(text).decision,decision));

test('unaccounted argument between prior outcome and symptom is uncertain',()=>assert.equal(parse('I am fine except chest pain.').decision,'POSSIBLE_CURRENT_URGENT'));

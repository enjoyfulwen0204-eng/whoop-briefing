import test from 'node:test';
import assert from 'node:assert/strict';
import {interpretUrgentSymptoms as parse} from '../../src/bot/triage.js';
const negative='「呼吸困難」是我現在還沒有感到的症狀。';
const educational='我想了解胸痛的一般原因。';
test('compound negative owns its modifier, predicate and referenced symptom',()=>{
 const r=parse(negative),g=r.ownership,op=g.operators.find(o=>o.type==='negative'&&o.word==='還沒有');
 assert.ok(op);assert.equal(negative.slice(op.span.start,op.span.end),'還沒有');
 const p=g.predicates.find(p=>p.id===op.ownerPredicateId),m=r.mentions.find(m=>m.predicateId===p.id);
 assert.equal(p.actorId,'SELF');assert.equal(p.epistemic,false);assert.equal(m.state,'NEGATED');assert.equal(m.evidence.polarity,'NEGATED');
 assert.ok(g.links.some(l=>l.type==='QUOTE_COMPLEMENT'&&l.fromPredicateId===p.referenceId&&l.toPredicateId===p.id));
 assert.ok(r.safetyGate.exclusions.some(x=>x.predicateId===p.id&&x.proof==='OWNED_NEGATION'));assert.equal(r.decision,'CLEARLY_NONURGENT');
});
test('horizontal spacing stays within the compound negative span',()=>{
 for(const gap of [' ','\t','\u3000']){const text=negative.replace('還沒有','還'+gap+'沒有'),r=parse(text),op=r.ownership.operators.find(o=>o.type==='negative'&&o.word.startsWith('還'));assert.ok(op);assert.equal(text.slice(op.span.start,op.span.end),'還'+gap+'沒有');assert.equal(r.decision,'CLEARLY_NONURGENT');}
});
test('general educational intent and topic are owned by the same nonclinical predicate',()=>{
 const r=parse(educational),g=r.ownership,ops=g.operators.filter(o=>o.type==='education');assert.ok(ops.some(o=>o.word==='想了解'));assert.ok(ops.some(o=>o.word==='一般'));assert.equal(new Set(ops.map(o=>o.ownerPredicateId)).size,1);
 const p=g.predicates.find(p=>p.id===ops[0].ownerPredicateId);assert.equal(p.actorId,'SELF');assert.equal(p.assertion,'TOPIC');assert.equal(p.frame,'EDUCATIONAL');assert.equal(r.mentions[0].state,'EDUCATIONAL');assert.equal(r.decision,'CLEARLY_NONURGENT');
});
test('a current assertion after intent owns its own evidence',()=>{
 const text='我想了解為什麼我現在胸痛。',r=parse(text),g=r.ownership,m=r.mentions.find(m=>m.state==='CURRENT');assert.ok(m);const intent=g.operators.find(o=>o.word==='想了解'),now=g.operators.find(o=>o.word==='現在');assert.ok(intent&&now);assert.notEqual(intent.ownerPredicateId,now.ownerPredicateId);assert.equal(now.ownerPredicateId,m.predicateId);assert.equal(r.decision,'CURRENT_URGENT');
});
test('negation cannot reach a subsequent independent OTHER assertion',()=>{
 const r=parse(negative+'我朋友安娜現在胸痛。'),g=r.ownership,m=r.mentions.find(m=>m.state==='CURRENT'&&m.evidence.actorId==='OTHER:my friend:安娜');assert.ok(m);assert.ok(!g.operators.some(o=>o.type==='negative'&&o.ownerPredicateId===m.predicateId));assert.equal(r.decision,'CURRENT_URGENT');
});
test('intent alone or owned current experience cannot exclude a plausible serious symptom',()=>{
 for(const text of ['我想了解胸痛的原因。','我想了解現在胸痛的一般原因。','我想了解有胸痛的一般原因。']){const r=parse(text);assert.equal(r.urgent,true);assert.ok(!r.safetyGate.exclusions.some(x=>x.proof==='LOCAL_EDUCATION'));}
});
test('compound negation does not prove an unrelated quote argument',()=>{
 const r=parse('「呼吸困難」是我現在還沒有感到的頭痛。');assert.equal(r.decision,'POSSIBLE_CURRENT_URGENT');assert.ok(r.safetyGate.unresolved.length);assert.ok(!r.safetyGate.exclusions.some(x=>x.proof==='OWNED_NEGATION'));
});

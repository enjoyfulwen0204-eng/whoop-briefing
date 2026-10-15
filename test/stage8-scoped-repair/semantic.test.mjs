import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {interpretUrgentSymptoms as parse} from '../../src/bot/triage.js';
const cases=JSON.parse(fs.readFileSync(new URL('./independent-cases.json',import.meta.url)));
const contract=JSON.parse(fs.readFileSync(new URL('./contract.json',import.meta.url)));
export function owned(r){
 const g=r.ownership;assert.ok(g);const ps=new Map(g.predicates.map(p=>[p.id,p]));
 for(const [xs,k] of [[g.symptoms,'symptomIds'],[g.operators,'operatorIds']])for(const x of xs){const p=ps.get(x.ownerPredicateId);assert.ok(p);assert.equal(g.predicates.filter(p=>p[k].includes(x.id)).length,1);assert.ok(x.span.start>=p.ownedSpan.start&&x.span.end<=p.ownedSpan.end);}
 for(const l of g.links){assert.ok(ps.has(l.fromPredicateId));assert.ok(ps.has(l.toPredicateId));}
 return g;
}
for(const c of cases)test('independent semantic '+c.id+' '+c.text,()=>{const r=parse(c.text);if(c.expected==='SAFETY')assert.equal(r.urgent,true);else assert.equal(r.decision,c.expected);if(r.ownership)owned(r);});
for(const c of contract.mandatory)test('frozen scoped finding '+c.finding,()=>{
 const r=parse(c.text),g=owned(r);assert.equal(r.decision,c.expected);
 const ps=g.predicates,ops=g.operators;
 if(c.finding==='PO-H01'){assert.equal(ps[1].symptomIds.length,0);assert.equal(ps[2].referenceId,ps[1].id);assert.equal(r.mentions[0].state,'CURRENT');assert.ok(!g.links.some(l=>l.type==='OUTCOME'));assert.ok(!g.links.some(l=>l.type==='REFERENCE'&&l.fromPredicateId===ps[0].id));}
 if(c.finding==='PO-H02'){assert.equal(ps[0].actorId,'OTHER:my friend:ana');assert.equal(ps[1].actorId,'OTHER:my friend:bo');assert.equal(r.mentions[0].state,'CURRENT');assert.ok(!g.links.some(l=>l.type==='OUTCOME'));}
 if(c.finding==='PO-H03'){assert.equal(ps[0].aspect,'ONGOING_PERFECT');assert.equal(c.text.slice(ps[0].headSpan.start,ps[0].headSpan.end),'have');assert.equal(r.mentions[0].evidence.temporal,'CURRENT');assert.equal(ops.find(o=>o.word==='since').ownerPredicateId,ps[0].id);}
 if(c.finding==='PO-H04'){assert.equal(ps.length,3);assert.equal(ps[0].frame,'HYPOTHETICAL');assert.equal(ps[2].frame,'ACTUAL');assert.equal(ops.find(o=>o.word==='now').ownerPredicateId,ps[2].id);assert.ok(!g.links.some(l=>l.type==='FRAME'&&l.toPredicateId===ps[2].id));}
 if(c.finding==='PO-H05'){assert.equal(ops.find(o=>o.word==='yesterday').ownerPredicateId,ps[0].id);assert.equal(r.mentions[1].evidence.temporal,'CURRENT');}
 if(c.finding==='PO-H06'){assert.equal(ops.find(o=>o.word==='cannot').ownerPredicateId,ps[0].id);assert.equal(ops.find(o=>o.word==='do not').ownerPredicateId,ps[1].id);assert.equal(r.mentions[0].evidence.polarity,'UNKNOWN');assert.equal(r.mentions[0].evidence.temporal,'UNKNOWN');assert.ok(g.links.some(l=>l.type==='FRAME'&&l.fromPredicateId===ps[0].id&&l.toPredicateId===ps[1].id));}
 if(c.finding==='PO-M01'){assert.equal(ps.length,1);assert.deepEqual(g.symptoms.map(s=>s.ownerPredicateId),['P1','P1']);assert.ok(r.mentions.every(m=>m.state==='NEGATED'));}
});

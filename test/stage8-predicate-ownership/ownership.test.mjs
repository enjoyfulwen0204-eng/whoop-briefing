import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {interpretUrgentSymptoms as parse,TRIAGE_LIMITS,TRIAGE_GRAMMAR_VERSION} from '../../src/bot/triage.js';
const contract=JSON.parse(fs.readFileSync(new URL('./contract.json',import.meta.url)));
const corpus=JSON.parse(fs.readFileSync(new URL('../stage8-triage-architecture/independent-corpus.json',import.meta.url)));
function ownership(result){
 const g=result.ownership;assert.ok(g);assert.equal(g.version,TRIAGE_GRAMMAR_VERSION);
 assert.ok(g.predicates.length<=TRIAGE_LIMITS.predicates);assert.ok(g.operators.length<=TRIAGE_LIMITS.operators);assert.ok(g.links.length<=TRIAGE_LIMITS.links);
 const nodes=new Map(g.predicates.map(p=>[p.id,p]));
 for(const [items,field] of [[g.symptoms,'symptomIds'],[g.operators,'operatorIds']]){
  assert.equal(new Set(items.map(x=>x.id)).size,items.length);
  for(const x of items){const p=nodes.get(x.ownerPredicateId);assert.ok(p);assert.equal(g.predicates.filter(p=>p[field].includes(x.id)).length,1);assert.ok(x.span.start>=p.ownedSpan.start&&x.span.end<=p.ownedSpan.end,JSON.stringify({x,p}));}
 }
 for(const l of g.links){assert.ok(nodes.has(l.fromPredicateId));assert.ok(nodes.has(l.toPredicateId));assert.ok(l.span.start>=0&&l.span.end>=l.span.start);}
 for(const m of result.mentions)assert.ok(Object.isFrozen(m.evidence));
 return g;
}
for(const [i,c] of contract.cases.entries())test('frozen ownership '+(i+1),()=>{
 const r=parse(c.text),g=ownership(r);assert.equal(r.decision,c.decision);assert.equal(g.predicates.length,c.predicates.length);
 for(const [j,p] of g.predicates.entries()){
  const expected=c.predicates[j];assert.equal(p.actor,expected.actor);assert.equal(c.text.slice(p.headSpan.start,p.headSpan.end),expected.head);
  assert.deepEqual(g.symptoms.filter(s=>s.ownerPredicateId===p.id).map(s=>s.kind),expected.symptoms);
  assert.deepEqual([...new Set(g.operators.filter(o=>o.ownerPredicateId===p.id&&o.type!=='actor').map(o=>o.word))],expected.operators);
 }
 assert.ok(!g.links.some(l=>l.type==='OUTCOME'));
});
for(const c of corpus.cases)test('preserved ownership invariant '+c.id,()=>{const r=parse(c.text);ownership(r);assert.equal(r.urgent,c.expectedUrgent);});
const families=[
 {past:'I had chest pain yesterday',fine:'I was fine yesterday',current:'I have difficulty breathing',other:'my friend has difficulty breathing',negative:'I do not have difficulty breathing',resolved:'my difficulty breathing has resolved',join:' whereas '},
 {past:'我昨天胸痛',fine:'我昨天沒事',current:'我呼吸困難',other:'我朋友呼吸困難',negative:'我沒有呼吸困難',resolved:'我呼吸困難已經好了',join:'然而'},
 {past:'Tôi đau ngực hôm qua',fine:'Tôi ổn hôm qua',current:'tôi khó thở',other:'bạn tôi khó thở',negative:'tôi không khó thở',resolved:'tôi đã hết khó thở',join:' trong khi '},
 {past:'我昨天胸痛',fine:'I was fine yesterday',current:'tôi khó thở',other:'my friend has difficulty breathing',negative:'tôi không khó thở',resolved:'my difficulty breathing has resolved',join:' whereas '},
];
for(const [i,f] of families.entries())for(const [name,value,decision,actor] of [
 ['SELF',f.current,'CURRENT_URGENT','SELF'],['OTHER',f.other,'CURRENT_URGENT','my friend'],['negated',f.negative,'CLEARLY_NONURGENT','SELF'],['resolved',f.resolved,'CLEARLY_NONURGENT','SELF'],
])for(const order of ['past-first','current-first'])test('ownership metamorphic '+i+' '+name+' '+order,()=>{
 const text=order==='past-first'?f.past+f.join+value:value+f.join+f.past;
 const r=parse(text),g=ownership(r);assert.equal(r.decision,decision,JSON.stringify(r));
 const p=g.predicates.find(p=>g.symptoms.some(s=>s.ownerPredicateId===p.id&&s.kind==='breathing'));
 assert.equal(p.actor,actor);assert.ok(!g.operators.some(o=>o.ownerPredicateId===p.id&&o.type==='pastTime'));
});
for(const [i,f] of families.entries())test('non-symptom past consumes its own operators '+i,()=>{const r=parse(f.fine+f.join+f.current),g=ownership(r);assert.equal(r.decision,'CURRENT_URGENT');const p=g.predicates.find(p=>p.symptomIds.length);assert.ok(!g.operators.some(o=>o.ownerPredicateId===p.id&&['pastTime','pastPredicate','resolution'].includes(o.type)));});
const relational=[
 ['CLEARLY_NONURGENT','I am not having chest pain or difficulty breathing.'],
 ['CURRENT_URGENT','I have chest pain or no difficulty breathing.'],
 ['CURRENT_URGENT','I have chest pain. My friend has chest pain that has resolved.'],
 ['CLEARLY_NONURGENT','I have chest pain and difficulty breathing. They have resolved.'],
 ['CURRENT_URGENT','I want to learn about "chest pain", which I am having right now.'],
 ['CURRENT_URGENT','He tells me "I have chest pain right now" and needs help.'],
 ['CLEARLY_NONURGENT','What does "I have chest pain" mean?'],
 ['CLEARLY_NONURGENT','If he says "I have chest pain", what should I do?'],
 ['POSSIBLE_CURRENT_URGENT','I wonder if I have chest pain.'],
 ['POSSIBLE_CURRENT_URGENT','chest pain'],
 ['CURRENT_URGENT','My friend has palpitations. My friend is dizzy.'],
 ['CLEARLY_NONURGENT','My friend has palpitations. My mother is dizzy.'],
 ['CURRENT_URGENT','I have chest pain after feeling fine yesterday.'],
 ['CLEARLY_NONURGENT','I had chest pain and it returned last year.'],
 ['CURRENT_URGENT','I have chest pain. It has resolved. It has returned now.'],
 ['CURRENT_URGENT','I have chest pain. My chest pain resolved yesterday.'],
 ['POSSIBLE_CURRENT_URGENT','I have "chest pain'],
];
for(const [i,[decision,text]] of relational.entries())test('owned relationships '+i,()=>{const r=parse(text);assert.equal(r.decision,decision,JSON.stringify(r));if(r.ownership)ownership(r);});
test('report quote first person is the reporter',()=>{const r=parse('He tells me "I have chest pain right now"');const g=ownership(r);assert.equal(r.mentions[0].actor,'he');assert.ok(g.links.some(l=>l.type==='REPORT'));assert.equal(g.predicates.find(p=>p.symptomIds.length).actor,'he');});
test('other outcome cannot change SELF evidence or create an outcome link',()=>{const r=parse('I have chest pain. My friend has chest pain that has resolved.');const g=ownership(r);assert.equal(r.mentions[0].evidence.resolution,'UNKNOWN');assert.equal(r.mentions[0].state,'CURRENT');assert.ok(!g.links.some(l=>l.type==='OUTCOME'&&l.toPredicateId===r.mentions[0].predicateId));});
test('latest outcome changes active state and preserves original evidence',()=>{const r=parse('I have chest pain. My chest pain has resolved now.');const g=ownership(r);assert.equal(r.mentions[0].evidence.resolution,'UNKNOWN');assert.equal(r.mentions[0].state,'RESOLVED');assert.ok(g.links.some(l=>l.type==='OUTCOME'));});
for(const [name,text] of [
 ['characters','x'.repeat(TRIAGE_LIMITS.characters+1)],
 ['predicates',('I am fine whereas ').repeat(TRIAGE_LIMITS.predicates+1)+'I have chest pain'],
 ['operators',('not yesterday now ').repeat(TRIAGE_LIMITS.operators)+'chest pain'],
 ['mentions',('chest pain, ').repeat(TRIAGE_LIMITS.mentions+1)],
 ['quote-depth',('「『').repeat(9)+'chest pain'+('』」').repeat(9)],
])test('bounded '+name,()=>{const r=parse(text);assert.equal(r.decision,'POSSIBLE_CURRENT_URGENT');assert.equal(r.reason,'scope_limit');});
test('unknown modifiers do not terminate owned negation',()=>{const r=parse('I am not having '+('extraordinarily '.repeat(12))+'chest pain or difficulty breathing');assert.equal(r.decision,'CLEARLY_NONURGENT');ownership(r);});
for(const [i,[decision,text]] of [
 ['CURRENT_URGENT','I had chest pain yesterday whereas have difficulty breathing.'],
 ['POSSIBLE_CURRENT_URGENT','I had chest pain yesterday whereas difficulty breathing.'],
 ['POSSIBLE_CURRENT_URGENT','我昨天胸痛然而呼吸困難。'],
 ['CLEARLY_NONURGENT','I had chest pain yesterday whereas now I do not have difficulty breathing.'],
 ['CLEARLY_NONURGENT','我昨天胸痛然而現在我沒有呼吸困難。'],
 ['CURRENT_URGENT','Tôi đau ngực hôm qua trong khi bây giờ tôi khó thở.'],
 ['POSSIBLE_CURRENT_URGENT','He says "She says \'I have chest pain\'"'],
].entries())test('head and modifier ownership '+i,()=>{const r=parse(text);assert.equal(r.decision,decision,JSON.stringify(r));if(r.ownership)ownership(r);});
test('leading current modifier belongs to the later subject',()=>{const text='I had chest pain yesterday whereas now I do not have difficulty breathing.';const g=ownership(parse(text));const now=g.operators.find(o=>o.word==='now');assert.equal(g.predicates.find(p=>p.id===now.ownerPredicateId).symptomIds.map(id=>g.symptoms.find(s=>s.id===id).kind).join(','),'breathing');});
for(const [i,[decision,text]] of [
 ['CLEARLY_NONURGENT','I do not feel my chest pain.'],
 ['CLEARLY_NONURGENT','I am not experiencing my chest pain or difficulty breathing.'],
 ['CLEARLY_NONURGENT',"She doesn't feel her chest pain."],
 ['CURRENT_URGENT','I was fine yesterday whereas my chest pain is severe.'],
].entries())test('object possessor does not create a new subject '+i,()=>{const r=parse(text);assert.equal(r.decision,decision,JSON.stringify(r));ownership(r);});

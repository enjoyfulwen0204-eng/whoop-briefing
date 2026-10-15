import test from 'node:test';import assert from 'node:assert/strict';
import {interpretUrgentSymptoms as parse} from '../../src/bot/triage.js';
const cases=[];const add=(family,text,expected)=>cases.push({family,text,expected});
for(const symptom of ['chest pain','difficulty breathing'])for(const subject of ['I','My friend Ana'])for(const barrier of ['I had a headache yesterday.','My friend Bo has a rash.','The article describes a headache.']){
 add('reference barrier',subject+(subject==='I'?' have ':' has ')+symptom+'. '+barrier+' It has resolved.','CURRENT_URGENT');
}
for(const [a,b] of [['Ana','Bo'],['Alice','Bob'],['Bình','An']])for(const outcome of ['has no chest pain','has chest pain that has resolved','no longer has chest pain']){
 add('distinct identity',`My friend ${a} has chest pain. My friend ${b} ${outcome}.`,'CURRENT_URGENT');
 add('same identity',`My friend ${a} has chest pain. My friend ${a} ${outcome}.`,'CLEARLY_NONURGENT');
}
for(const [a,b,expected] of [['Ana','Bo','CLEARLY_NONURGENT'],['Ana','Ana','CURRENT_URGENT']])add('weak actor identity',`My friend ${a} has palpitations. My friend ${b} is dizzy.`,expected);
for(const symptom of ['chest pain','difficulty breathing'])for(const duration of ['since this morning','since yesterday','for the last ten minutes']){
 add('ongoing aspect',`I have had ${symptom} ${duration}.`,'CURRENT_URGENT');
 add('ongoing negated',`I have not had ${symptom} ${duration}.`,'CLEARLY_NONURGENT');
}
for(const symptom of ['chest pain','difficulty breathing']){
 add('completed history',`I had ${symptom} yesterday.`,'CLEARLY_NONURGENT');
 add('perfect uncertainty',`I have had ${symptom}.`,'POSSIBLE_CURRENT_URGENT');
 add('historical outcome',`I have had ${symptom} since this morning; it resolved yesterday.`,'CURRENT_URGENT');
}
for(const gap of [' ','. ','; ',' whereas '])for(const second of ['I have difficulty breathing.','I do not have difficulty breathing.'])add('temporal punctuation','I had chest pain yesterday'+gap+second,second.startsWith('I do not')?'CLEARLY_NONURGENT':'CURRENT_URGENT');
for(const text of ['If chest pain is dangerous, I have chest pain now.','What causes chest pain? I have chest pain now.','If chest pain is dangerous: I have chest pain now.','如果胸痛很危險，我現在胸痛。','Nếu đau ngực nguy hiểm, tôi đang đau ngực.'])add('local frame',text,'CURRENT_URGENT');
for(const text of ['If I have chest pain now, what should I do?','If I have chest pain and I cannot breathe now, what should I do?','What causes chest pain in general?'])add('proven frame',text,'CLEARLY_NONURGENT');
for(const inner of ['I do not have chest pain','my chest pain has resolved','I have no difficulty breathing'])for(const outer of ['I cannot say that ','I cannot confirm that ','I do not know whether '])add('epistemic negation',outer+inner+'.','POSSIBLE_CURRENT_URGENT');
for(const text of ['我無法確定我沒有胸痛。','Tôi không thể nói rằng tôi không đau ngực.'])add('epistemic multilingual',text,'POSSIBLE_CURRENT_URGENT');
for(const actor of [['I','my'],['She','her']])for(const coord of ['or','and','nor']){
 const text=`${actor[0]} ${actor[0]==='I'?'am':'is'} not experiencing ${actor[1]} chest pain ${coord} ${actor[1]} difficulty breathing.`;
 add('object list',text,'CLEARLY_NONURGENT');add('reported object list',`My friend Ana says "${text}"`,'CLEARLY_NONURGENT');
}
for(const text of ['我沒有胸痛和我的呼吸困難。','Tôi không có đau ngực và tôi không khó thở.'])add('multilingual object list',text,'CLEARLY_NONURGENT');
for(const text of ['I am not experiencing my chest pain or my friend has difficulty breathing.','She is not experiencing her chest pain but she has difficulty breathing.'])add('independent subject after object',text,'CURRENT_URGENT');
for(const text of ['My friend Ana says "I have had chest pain since this morning".','What does "I have had chest pain since this morning" mean?'])add('quote aspect',text,text.startsWith('What')?'CLEARLY_NONURGENT':'CURRENT_URGENT');
for(const [i,c] of cases.entries())test('scoped metamorphic '+i+' '+c.family,()=>{const r=parse(c.text);assert.equal(r.decision,c.expected,JSON.stringify({c,r}));if(r.ownership){for(const l of r.ownership.links.filter(l=>l.type==='OUTCOME')){const a=r.ownership.predicates.find(p=>p.id===l.fromPredicateId),b=r.ownership.predicates.find(p=>p.id===l.toPredicateId);assert.equal(a.actorId,b.actorId);assert.ok(a.actorId);}}});
for(const [text,expected] of [
 ['my friend ana has chest pain. my friend bo has no chest pain.','CURRENT_URGENT'],
 ['my friend ana has chest pain. My friend Ana has no chest pain.','CLEARLY_NONURGENT'],
 ['MY FRIEND ANA HAS CHEST PAIN. MY FRIEND BO HAS NO CHEST PAIN.','CURRENT_URGENT'],
 ['my friend bình has chest pain. My friend Bình has no chest pain.','CLEARLY_NONURGENT'],
 ['My friend Ana-1 has chest pain. My friend Bo-2 has no chest pain.','CURRENT_URGENT'],
])test('actor identity normalization '+text,()=>assert.equal(parse(text).decision,expected));

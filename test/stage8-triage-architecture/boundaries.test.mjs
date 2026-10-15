import test from 'node:test';import assert from 'node:assert/strict';
import {interpretUrgentSymptoms,TRIAGE_DECISION,TRIAGE_LIMITS} from '../../src/bot/triage.js';
const cases=[
 [true,'I have chest pain although I was healthy last week.'],
 [true,'I have chest pain after I experienced a headache yesterday.'],
 [true,'I have chest pain, but my friend had it last week.'],
 [true,'Tôi đau ngực dù hôm qua tôi khỏe.'],
 [true,'我胸痛，雖然以前很健康。'],
 [false,'I am not having exceptionally uncomfortable chest pain or difficulty breathing.'],
 [false,'Tôi không có đau ngực, khó thở hoặc sắp ngất.'],
 [false,'我沒有胸痛、呼吸困難或快昏倒。'],
 [true,'I am not having chest pain, but I have difficulty breathing.'],
 [true,'Tôi không đau ngực, nhưng tôi khó thở.'],
 [true,'我沒有胸痛，但是我呼吸困難。'],
 [false,'My chest pain and difficulty breathing have completely disappeared.'],
 [false,'Tôi đã hết hoàn toàn đau ngực và khó thở.'],
 [false,'我胸痛和呼吸困難都完全消失了。'],
 [true,'I have chest pain. It has gone. It is back now.'],
 [true,'我胸痛。現在好了。它現在又出現。'],
 [true,'Tôi đau ngực. Nó đã hết. Nó đang trở lại.'],
 [true,'I have "chest pain".'],
 [true,'I am asking about "chest pain", which I am experiencing.'],
 [true,'Tôi đang "đau ngực" và tìm hiểu HRV.'],
 [true,'我目前「呼吸困難」並且想知道 HRV。'],
 [false,'The textbook uses "I have chest pain" as an example.'],
 [false,'A fictional patient has difficulty breathing. She has chest pain.'],
 [true,'A fictional patient has chest pain. I have difficulty breathing now.'],
 [false,'I want to learn about chest pain and difficulty breathing in general.'],
 [false,'What is chest pain? Or difficulty breathing?'],
 [false,'If I have chest pain, and I am struggling to breathe, what should I do?'],
 [true,'If I have chest pain, what should I do? I am struggling to breathe.'],
 [true,'I want to learn about chest pain. I am experiencing it.'],
 [false,'I want to learn about chest pain. "I am experiencing it" is an example.'],
 [true,'My chest pain is not gone.'],
 [true,'My chest pain has never resolved.'],
 [true,'I have chest pain. My headache has completely resolved.'],
 [false,'My friend had chest pain yesterday. My mother had difficulty breathing last week.'],
 [true,'Tôi đã hết đau ngực nhưng I have difficulty breathing.'],
 [true,'我沒有胸痛，但 tôi không thể thở.'],
];
for(const [i,[expected,text]] of cases.entries())test('new-boundary-'+String(i+1).padStart(3,'0'),()=>{
 assert.equal(interpretUrgentSymptoms(text).urgent,expected);
});
const current=['I have chest pain.','Tôi đang đau ngực.','我現在胸痛。'];
const negated=['I am not having chest pain.','Tôi không đau ngực.','我沒有胸痛。'];
const resolved=['My chest pain has resolved.','Tôi đã hết đau ngực.','我胸痛已經好了。'];
const quoted=['I have "chest pain" now.','Tôi đang "đau ngực".','我目前「胸痛」。'];
const education=['I want to learn about HRV, but I have chest pain.','Tôi muốn tìm hiểu HRV nhưng tôi đau ngực.','我想知道 HRV，但我胸痛。'];
const withPast=['I have chest pain although I felt fine yesterday.','Tôi đau ngực dù trước đây khỏe.','我胸痛雖然以前沒事。'];
for(let i=0;i<3;i++)test('metamorphic-equivalence-'+i,()=>{
 for(const text of [current[i],quoted[i],education[i],withPast[i]])assert.equal(interpretUrgentSymptoms(text).decision,TRIAGE_DECISION.CURRENT_URGENT);
 for(const text of [negated[i],resolved[i]])assert.equal(interpretUrgentSymptoms(text).decision,TRIAGE_DECISION.CLEARLY_NONURGENT);
});
test('three decisions distinguish assertion from possible currentness and bound overflow',()=>{
 assert.equal(interpretUrgentSymptoms('I have chest pain.').decision,TRIAGE_DECISION.CURRENT_URGENT);
 assert.equal(interpretUrgentSymptoms('chest pain').decision,TRIAGE_DECISION.POSSIBLE_CURRENT_URGENT);
 assert.equal(interpretUrgentSymptoms('What causes chest pain in general?').decision,TRIAGE_DECISION.CLEARLY_NONURGENT);
 assert.equal(interpretUrgentSymptoms('x'.repeat(TRIAGE_LIMITS.characters+1)).decision,TRIAGE_DECISION.POSSIBLE_CURRENT_URGENT);
});
const predicateCases=[
 [true,'I have chest pain whereas my friend had difficulty breathing yesterday.'],
 [true,'I have chest pain whereas my friend has difficulty breathing that has resolved.'],
 [true,'I have chest pain; my friend is fine now.'],
 [true,'I have chest pain except my difficulty breathing is gone.'],
 [true,'我胸痛，朋友的呼吸困難好了。'],
 [true,'Tôi đau ngực, bạn tôi đã hết khó thở.'],
 [false,'He says "I do not have chest pain or difficulty breathing".'],
 [true,'He says "I do not have chest pain but I cannot breathe".'],
];
for(const [i,[expected,text]] of predicateCases.entries())test('separate-predicate-'+(i+1),()=>assert.equal(interpretUrgentSymptoms(text).urgent,expected));
const outcomeCases=[
 [false,'I have chest pain. My chest pain has resolved now.'],
 [false,'I have chest pain. I am not having chest pain now.'],
 [true,'I have chest pain. My chest pain resolved yesterday.'],
 [true,'I have chest pain. My friend has chest pain that has resolved.'],
 [true,'I have chest pain and difficulty breathing. My chest pain is gone now.'],
 [false,'Tôi đau ngực. Tôi đã hết đau ngực.'],
 [false,'我胸痛。我的胸痛現在好了。'],
 [true,'My chest pain has resolved. It is back now.'],
];
for(const [i,[expected,text]] of outcomeCases.entries())test('same-subject-outcome-'+(i+1),()=>assert.equal(interpretUrgentSymptoms(text).urgent,expected));

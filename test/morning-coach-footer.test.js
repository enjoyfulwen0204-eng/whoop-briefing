import test from 'node:test';import assert from 'node:assert/strict';
import {morningCoachFooter,validMorningFooter,repeatsMorning} from '../src/morningCoachFooter.js';
const db={getRecentInsights:async()=>[]},text='💪 恢復 65%\n🌙 睡眠 7.4h\n🔋 Body Energy：47/100\n今天可以維持平常的節奏。';
const replies={'zh-TW':'把今天最費心的工作安排在精神最好的時段。晚餐後放下手機，留點安靜的收尾時間。',en:'Plan your most demanding work for when you feel most alert. Put your phone away after dinner and leave some quiet time to wind down.',vi:'Hãy làm việc cần tập trung khi cảm thấy tỉnh táo nhất. Sau bữa tối, cất điện thoại và dành thời gian yên tĩnh để thư giãn.'};
for(const locale of ['zh-TW','en','vi'])test(`new coach prose is guarded and original report remains byte-for-byte (${locale})`,async()=>{
 const tail=await morningCoachFooter({text,locale,db,userId:'synthetic',coach:{footerText:async()=>replies[locale]}});
 assert.match(tail,/💬/);assert.ok(tail.endsWith(replies[locale]));assert.equal((text+tail).slice(0,text.length),text);
});
test('unsupported numbers/metrics, diagnosis, treatment and causal claims are rejected',()=>{
 for(const value of ['今天走 9999 步。晚餐後放鬆。','你的 HRV 是 65ms。今天多休息。','你感染了疾病。今天多休息。','請服用安眠藥。今晚早睡。','壓力導致睡不好。晚餐後放鬆。','Take medication tonight. Rest afterward.','Bạn mắc bệnh. Hãy nghỉ ngơi.','Việc này dẫn đến mệt mỏi. Hãy nghỉ ngơi.'])assert.equal(validMorningFooter(value,text,text,'zh-TW'),false,value);
});
test('exact and near-duplicate sentences are omitted; threshold is punctuation-insensitive Dice >= .72',()=>{
 assert.equal(repeatsMorning('今天可以維持平常的節奏！晚餐後放鬆。',text),true);
 assert.equal(repeatsMorning('今天仍可以維持平常的節奏。晚餐後放鬆。',text),true);
 assert.equal(repeatsMorning(replies['zh-TW'],text),false);
});
test('English and Vietnamese linking words cannot move a valid number onto another metric',()=>{
 const context='Recovery 65%. Sleep performance 99%.';
 assert.equal(validMorningFooter('Your Recovery is 99%. Take a relaxed walk this evening.',context,context,'en'),false);
 assert.equal(validMorningFooter('Phục hồi đạt 99%. Hãy dành thời gian thư giãn.',context,context,'vi'),false);
 assert.equal(validMorningFooter('Blood oxygen is 99%. Take a relaxed walk this evening.',context,context,'en'),false);
});
test('failure, timeout or invalid output omits only the optional tail',async()=>{
 for(const footerText of [async()=>null,async()=>{throw Error('SYNTHETIC');},async()=>text])assert.equal(await morningCoachFooter({text,locale:'zh-TW',db,userId:'a',coach:{footerText}}),'');
 assert.equal(await morningCoachFooter({text,locale:'zh-TW',db,userId:'a',timeoutMs:5,coach:{footerText:async()=>new Promise(r=>setTimeout(()=>r(replies['zh-TW']),30))}}),'');
});

import {fixtureKeys} from './localDb.js';
import {withExecutionBudget} from '../src/executionBudget.js';
const diagnosticCases=[
 ['LLM_UNAVAILABLE',{coach:{}}],
 ['FORMAT',{answer:null}],['FORMAT',{answer:{private:'PRIVATE_SENTINEL'}}],
 ['LENGTH',{answer:'a'.repeat(651)+'. Take a break.'}],
 ['REPEAT',{answer:'今天可以維持平常的節奏。晚餐後放鬆。'}],
 ['VALIDATION:unsupported_number',{answer:'Walk for 9876h. Leave time to unwind.'}],
 ['VALIDATION:diagnosis_language',{answer:'你感染了疾病。今天多休息。'}],
 ['VALIDATION:treatment_advice',{answer:'Take medication tonight. Rest afterward.'}],
 ['VALIDATION:causal_language',{answer:'壓力導致睡不好。晚餐後放鬆。'}],
 ['VALIDATION:medical_language',{answer:'Bạn mắc bệnh. Hãy nghỉ ngơi.'}],
 ['FACT_CHECK',{answer:'Try counting 9876 slowly. Leave time to unwind.'}],
 ['LLM_ERROR',{error:Object.assign(Error('PRIVATE_SENTINEL 9876'),{code:'PRIVATE_SENTINEL'})}],
 ['CONTEXT_ERROR',{db:{getRecentInsights:async()=>{throw Error('PRIVATE_SENTINEL');}}}],
 ['SNAPSHOT_CHANGED',{coach:{footerText:async()=>replies.en,assertSnapshot:async()=>{throw Error('PRIVATE_SENTINEL');}}}],
];
for(const [expected,options] of diagnosticCases)test(`footer omission logs only classification ${expected}`,async t=>{
 const logs=[];t.mock.method(console,'log',line=>logs.push(JSON.parse(line)));
 const coach=options.coach??{footerText:async()=>{if(options.error)throw options.error;return options.answer;}};
 assert.equal(await morningCoachFooter({text,locale:'en',db:options.db??db,userId:'PRIVATE_USER',keys:fixtureKeys,coach}),'');
 assert.equal(logs.length,1);assert.equal(logs[0].reason,expected);
 assert.equal(logs[0].user,fixtureKeys.lookup(['companion-diagnostic-user-v1','PRIVATE_USER']));
 assert.ok(logs[0].llm_duration_ms>=0);assert.deepEqual(Object.keys(logs[0]).sort(),['context_duration_ms','event','llm_duration_ms','reason','user']);
 assert.doesNotMatch(JSON.stringify(logs),/PRIVATE_|9876|恢復|Body Energy|Walk|medication/);
});
test('low budget, timeout and insight change each emit exactly once; late LLM completion cannot emit again',async t=>{
 const logs=[];t.mock.method(console,'log',line=>logs.push(JSON.parse(line)));
 const args={text,locale:'en',db,userId:'PRIVATE_USER',keys:fixtureKeys,coach:{footerText:async()=>replies.en}};
 await withExecutionBudget({remainingMs:()=>100},()=>morningCoachFooter(args));
 assert.equal(logs.pop().reason,'BUDGET_TOO_LOW');
 await morningCoachFooter({...args,timeoutMs:10,coach:{footerText:async()=>new Promise(resolve=>setTimeout(()=>resolve(replies.en),50))}});
 assert.equal(logs[0].reason,'TIMEOUT');assert.ok(logs[0].llm_duration_ms>=1);assert.ok(logs[0].llm_duration_ms<50);
 await new Promise(resolve=>setTimeout(resolve,70));assert.equal(logs.length,1);logs.length=0;
 const row={id:'private-insight',subject:'synthetic',status:'SUPPORTED',version:1,evidence_json:JSON.stringify({version:'b2-memory-v1',view:{topics:[]}})};
 await morningCoachFooter({...args,db:{getRecentInsights:async()=>[row],getInsight:async()=>({...row,version:2})}});
 assert.equal(logs.length,1);assert.equal(logs[0].reason,'INSIGHT_CHANGED');
});

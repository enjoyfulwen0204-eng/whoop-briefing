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

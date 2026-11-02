import test from 'node:test';import assert from 'node:assert/strict';
import {morningCoachFooter} from '../src/morningCoachFooter.js';
import {buildFragmentCatalogue} from '../src/narrativePlan.js';
const briefing={stage:'cold',metrics:[],localDate:'2026-11-02'};
const db={getRecentInsights:async()=>[]};
for(const locale of ['zh-TW','en','vi'])test(`footer uses closed input sentences and leaves original report byte-for-byte (${locale})`,async()=>{
 const c=buildFragmentCatalogue(briefing,{locale}),original=c.fragments.map(f=>f.text).join('\n')+'\n🔋 Body Energy: 47/100';
 const tail=await morningCoachFooter({text:original,briefing,locale,db,coach:{footerPlan:async f=>({order:f.slice(0,2).map(x=>x.id)})},userId:'synthetic'});
 assert.match(tail,/💬/);assert.equal((original+tail).slice(0,original.length),original);
 for(const f of c.fragments.slice(0,2))assert.ok(tail.includes(f.text));
});
test('invented metric, number, text or unsupported ID is rejected; request failure omits only footer',async()=>{
 const text=buildFragmentCatalogue(briefing).fragments.map(f=>f.text).join('\n');
 for(const plan of [{order:['invented_99','invented_hrv']},{order:['f_cold_facts','f_cold_baseline'],text:'Recovery 99%'},{order:['f_cold_facts','f_cold_facts']},null])assert.equal(await morningCoachFooter({text,briefing,locale:'zh-TW',db,userId:'a',coach:{footerPlan:async()=>plan}}),'');
 assert.equal(await morningCoachFooter({text,briefing,locale:'zh-TW',db,userId:'a',coach:{footerPlan:async()=>{throw Error('SYNTHETIC');}}}),'');
});
test('deadline cancels optional work and leaves report; no late footer after timeout',async()=>{
 const text=buildFragmentCatalogue(briefing).fragments.map(f=>f.text).join('\n');
 assert.equal(await morningCoachFooter({text,briefing,locale:'zh-TW',db,userId:'a',timeoutMs:5,coach:{footerPlan:async()=>new Promise(resolve=>setTimeout(()=>resolve({order:['f_cold_facts','f_cold_baseline']}),30))}}),'');
});

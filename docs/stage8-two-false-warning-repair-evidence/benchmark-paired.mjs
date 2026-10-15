import fs from 'node:fs';import {performance} from 'node:perf_hooks';
const root='/Users/kelvin/.codex/worktrees/stage8-two-false-warning-repair/whoop-briefing';
const base=await import('./baseline/triage.mjs'),candidate=await import(root+'/src/bot/triage.js');
const cases=JSON.parse(fs.readFileSync(root+'/test/stage8-two-false-warning-repair/cases.json')).cases.map(c=>c.text);
const shapes={focused:cases,originalNegation:[cases[0]],originalEducation:['我想了解胸痛的一般原因。'],nearLimit:['I am not having '+('exceptionally '.repeat(560))+'chest pain.']};
const result={node:process.version,pairedSamples:1000,warmupsPerVersion:200,ordering:'AB/BA alternating per pair, same input per pair; concurrent local test load',measurements:{}};
for(const [shape,texts]of Object.entries(shapes)){
 const samples={baseline:[],candidate:[]};
 for(let i=0;i<200;i++){base.interpretUrgentSymptoms(texts[i%texts.length]);candidate.interpretUrgentSymptoms(texts[i%texts.length]);}
 for(let i=0;i<1000;i++)for(const [name,parse]of (i%2? [['candidate',candidate.interpretUrgentSymptoms],['baseline',base.interpretUrgentSymptoms]]:[['baseline',base.interpretUrgentSymptoms],['candidate',candidate.interpretUrgentSymptoms]])){
  const t=performance.now();parse(texts[i%texts.length]);samples[name].push(performance.now()-t);
 }
 result.measurements[shape]=Object.fromEntries(Object.entries(samples).map(([k,v])=>{v.sort((a,b)=>a-b);return[k,{p50ms:v[500],p95ms:v[950],maxMs:v.at(-1)}];}));
}
const retained=[];global.gc();let before=process.memoryUsage().heapUsed;
for(let batch=0;batch<8;batch++){for(let i=0;i<1000;i++)candidate.interpretUrgentSymptoms(cases[i%cases.length]);global.gc();const heap=process.memoryUsage().heapUsed;retained.push({batch:batch+1,parses:(batch+1)*1000,heapUsed:heap,deltaFromStart:heap-before});}
result.candidateRetainedHeapBatches=retained;
console.log(JSON.stringify(result,null,2));

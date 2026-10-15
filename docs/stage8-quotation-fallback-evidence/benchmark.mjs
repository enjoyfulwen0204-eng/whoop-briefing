import fs from 'node:fs';import {performance} from 'node:perf_hooks';
const source=process.argv[2],{interpretUrgentSymptoms:parse}=await import(source+'/src/bot/triage.js');
const root='/Users/kelvin/.codex/worktrees/stage8-gate-adjudicated-repair/whoop-briefing/';
const ordinary=JSON.parse(fs.readFileSync(root+'test/stage8-safety-gate/cases.json')).cases.map(c=>c.text);
const quoted=JSON.parse(fs.readFileSync(root+'test/stage8-adjudicated-repair/new-cases.json')).cases.filter(c=>c.text.includes('"')||c.text.includes('「')).map(c=>c.text);
const fallback=JSON.parse(fs.readFileSync('/private/tmp/stage8-quotation-fallback/frozen-cases.json')).cases.map(c=>c.text);
const shapes={ordinary,quoted,fallback,quoted40:['\"chest pain\" is precisely what I am feeling now. '.repeat(40)],predicates80:['I have chest pain. '.repeat(80)],operatorOverflow120:['I have chest pain. '.repeat(120)],nearCharacterLimit:['I am not having '+('exceptionally '.repeat(560))+'chest pain.'],characterOverflow:['x'.repeat(8193)]};
const result={source,node:process.version,samplesPerShape:500,warmupsPerShape:100,concurrentHostTests:true,measurements:{}};
for(const [name,texts]of Object.entries(shapes)){
 for(let i=0;i<100;i++)parse(texts[i%texts.length]);global.gc();const before=process.memoryUsage(),samples=[];let peak=before.heapUsed;const decisions={},reasons={};
 for(let i=0;i<500;i++){const start=performance.now(),r=parse(texts[i%texts.length]);samples.push(performance.now()-start);decisions[r.decision]=(decisions[r.decision]??0)+1;if(r.reason)reasons[r.reason]=(reasons[r.reason]??0)+1;if(i%25===0)peak=Math.max(peak,process.memoryUsage().heapUsed);}
 global.gc();const after=process.memoryUsage();samples.sort((a,b)=>a-b);
 result.measurements[name]={characters:Math.max(...texts.map(t=>t.length)),p50ms:samples[250],p95ms:samples[475],maxMs:samples.at(-1),retainedHeapDeltaBytes:after.heapUsed-before.heapUsed,sampledTransientGrowthBytes:peak-before.heapUsed,rssBytes:after.rss,decisions,reasons};
}
console.log(JSON.stringify(result,null,2));

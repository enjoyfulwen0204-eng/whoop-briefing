import fs from 'node:fs';import {performance} from 'node:perf_hooks';
const source=process.argv[2],{interpretUrgentSymptoms:parse}=await import(source+'/src/bot/triage.js');
const corpus=JSON.parse(fs.readFileSync('/Users/kelvin/.codex/worktrees/stage8-conservative-safety-gate/whoop-briefing/test/stage8-safety-gate/cases.json'));
const shapes={normal:corpus.cases.map(c=>c.text),boundedPredicates:[Array.from({length:120},()=> 'I have chest pain.').join(' ')],boundedText:['I am not having '+('exceptionally '.repeat(560))+'chest pain.'],overflow:['x'.repeat(8193)]};
const result={source,node:process.version,units:'milliseconds per parse',measurements:{}};
for(const [shape,texts] of Object.entries(shapes)){
 for(let i=0;i<100;i++)parse(texts[i%texts.length]);global.gc();const before=process.memoryUsage();const samples=[];let maxHeap=before.heapUsed;
 for(let i=0;i<500;i++){const start=performance.now();parse(texts[i%texts.length]);samples.push(performance.now()-start);if(i%25===0)maxHeap=Math.max(maxHeap,process.memoryUsage().heapUsed);}
 global.gc();const after=process.memoryUsage();samples.sort((a,b)=>a-b);
 result.measurements[shape]={samples:samples.length,characters:Math.max(...texts.map(s=>s.length)),p50:samples[250],p95:samples[475],max:samples.at(-1),heapAfterGCBytes:after.heapUsed,heapRetainedDeltaBytes:after.heapUsed-before.heapUsed,sampledHeapGrowthBytes:maxHeap-before.heapUsed,rssBytes:after.rss};
}
console.log(JSON.stringify(result,null,2));

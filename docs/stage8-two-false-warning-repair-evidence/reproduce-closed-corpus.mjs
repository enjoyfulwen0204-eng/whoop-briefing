import fs from 'node:fs';import assert from 'node:assert/strict';
const root='/Users/kelvin/.codex/worktrees/stage8-two-false-warning-repair/whoop-briefing';
const {interpretUrgentSymptoms:parse}=await import(root+'/src/bot/triage.js');
const {interpretUrgentSymptoms:before}=await import('./baseline/triage.mjs');
const rows=[];
for(const [dir,name]of [['stage8-quotation-fallback','cases'],['stage8-quotation-fallback','local-frame-cases'],['stage8-final-quotation-repair','cases']]){
 const c=JSON.parse(fs.readFileSync(root+'/test/'+dir+'/'+name+'.json'));
 for(const x of [...c.cases,...c.metamorphic]){const r=parse(x.text),b=before(x.text);assert.equal(x.expected==='SAFETY'?r.urgent:r.decision,x.expected==='SAFETY'?true:x.expected,JSON.stringify({x,r}));const g=structuredClone(r.ownership),p=structuredClone(b.ownership);delete g?.version;delete p?.version;if(!/想了解|還[^\S\r\n]*沒有/u.test(x.text))assert.deepEqual(g,p,'Unrelated ownership changed '+x.id);rows.push({...x,corpus:dir+'/'+name,before:b.decision,after:r.decision,ownership:r.ownership,safetyGate:r.safetyGate});}
}
fs.writeFileSync('/private/tmp/stage8-two-false-warning-repair/final/preserved-semantic-traces.json',JSON.stringify({rows:rows.length,passCount:rows.length,failCount:0,unchangedUntouchedPredicateGraphs:true,results:rows},null,2));console.log('Preserved semantic corpus',rows.length,'PASS');

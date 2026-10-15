import fs from 'node:fs';import crypto from 'node:crypto';
import {interpretUrgentSymptoms as after} from '/Users/kelvin/.codex/worktrees/stage8-gate-adjudicated-repair/whoop-briefing/src/bot/triage.js';
import {interpretUrgentSymptoms as before} from '/Users/kelvin/.codex/worktrees/stage8-conservative-safety-gate/whoop-briefing/src/bot/triage.js';
const root='/Users/kelvin/.codex/worktrees/stage8-gate-adjudicated-repair/whoop-briefing/',out=root+'docs/stage8-adjudicated-repair-evidence/';
const read=p=>JSON.parse(fs.readFileSync(root+p));const independent=read('test/stage8-adjudicated-repair/independent86.json'),newCases=read('test/stage8-adjudicated-repair/new-cases.json');
const groups={independent86:independent,newCases49:newCases.cases,newMetamorphic81:newCases.metamorphic};const analysis={corpusRowsNotAdditionalTestCounts:true,realWorldRatesNotEstablished:true,groups:{}};
for(const [id,cs]of Object.entries(groups)){
 const rows=cs.map(c=>{const r=after(c.text),urgent=c.expected!=='CLEARLY_NONURGENT',pass=c.expected==='SAFETY'?r.urgent:r.decision===c.expected;return {...c,actual:r.decision,urgent:r.urgent,pass,expectedUrgent:urgent};});
 const pos=rows.filter(r=>r.expectedUrgent),neg=rows.filter(r=>!r.expectedUrgent);analysis.groups[id]={cases:rows.length,positive:pos.length,negative:neg.length,pass:rows.filter(r=>r.pass).length,fail:rows.filter(r=>!r.pass).length,falseNegative:pos.filter(r=>!r.urgent).length,falsePositive:neg.filter(r=>r.urgent).length,precisionErrors:rows.filter(r=>!r.pass&&r.urgent===r.expectedUrgent),failures:rows.filter(r=>!r.pass)};
 fs.writeFileSync(out+id+'-before-after.json',JSON.stringify(cs.map(c=>({...c,before:before(c.text),after:after(c.text)})),null,2)+'\n');
}
const benign=read('test/stage8-safety-gate/cases.json').benignWarnings;analysis.benignConservativeWarnings=benign.map(c=>({id:c.id,text:c.text,before:before(c.text).decision,after:after(c.text).decision,clinicalBenignWarning:true}));
fs.writeFileSync(out+'analysis.json',JSON.stringify(analysis,null,2)+'\n');console.log(JSON.stringify(analysis,null,2));

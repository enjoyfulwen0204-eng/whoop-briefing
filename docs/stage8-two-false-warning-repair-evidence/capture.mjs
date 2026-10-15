import fs from 'node:fs';import crypto from 'node:crypto';
const root='/Users/kelvin/.codex/worktrees/stage8-two-false-warning-repair/whoop-briefing';
const {interpretUrgentSymptoms:parse}=await import(root+'/src/bot/triage.js');
const c=JSON.parse(fs.readFileSync(root+'/test/stage8-two-false-warning-repair/cases.json'));
const rows=[...c.cases,...c.metamorphic].map(c=>({...c,result:parse(c.text)}));
const sourceHashes=Object.fromEntries(['src/bot/triage.js','src/bot/safetyGate.js'].map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(root+'/'+p)).digest('hex')]));
fs.writeFileSync(process.argv[2],JSON.stringify({sourceHashes,rows},null,2));

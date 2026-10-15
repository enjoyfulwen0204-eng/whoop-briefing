import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {interpretUrgentSymptoms as parse} from '../../src/bot/triage.js';
const load=name=>JSON.parse(fs.readFileSync(new URL(name,import.meta.url)));
const corpus=load('./cases.json');
for(const [family,rows]of [['focused',[...corpus.cases,...corpus.metamorphic]],['independent48',load('./independent48.json').cases],['independent-reduced8',load('./independent-reduced8.json').cases]])
 for(const c of rows)test('two false warnings '+family+' '+c.id,()=>{const r=parse(c.text);if(c.expected==='SAFETY')assert.equal(r.urgent,true,JSON.stringify({c,r}));else assert.equal(r.decision,c.expected,JSON.stringify({c,r}));});

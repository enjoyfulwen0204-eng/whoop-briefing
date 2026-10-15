import fs from 'node:fs';import test from 'node:test';import assert from 'node:assert/strict';
import {interpretUrgentSymptoms as parse} from '../../src/bot/triage.js';
const corpus=JSON.parse(fs.readFileSync(new URL('./cases.json',import.meta.url)));
for(const c of [...corpus.cases,...corpus.metamorphic])test('final quotation ownership '+c.id,()=>{const r=parse(c.text);if(c.expected==='SAFETY')assert.notEqual(r.decision,'CLEARLY_NONURGENT',JSON.stringify({c,r}));else assert.equal(r.decision,c.expected,JSON.stringify({c,r}));});

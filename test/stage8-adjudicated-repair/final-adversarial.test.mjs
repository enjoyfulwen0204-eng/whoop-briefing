import fs from 'node:fs';import test from 'node:test';import assert from 'node:assert/strict';
import {interpretUrgentSymptoms as parse} from '../../src/bot/triage.js';
const cases=JSON.parse(fs.readFileSync(new URL('./final-adversarial-cases.json',import.meta.url)));
for(const c of cases)test('residual quote probe '+c.id,()=>{const r=parse(c.text);assert.equal(r.decision,c.expected,JSON.stringify({c,r}));});

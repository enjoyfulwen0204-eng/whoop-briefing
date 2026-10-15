import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {instrumentSyntheticSource} from './stage6SyntheticDiagnostics.mjs';
test('diagnostic transforms preserve all original publication guards and algorithm calls',async()=>{
 const file='src/stage6ShortPublication.js',source=await readFile(new URL('../'+file,import.meta.url),'utf8'),observed=instrumentSyntheticSource(file,source);
 for(const guard of ["if(p.budget.remainingMs()<5500)fail('PUBLICATION_HEADROOM_REQUIRED')","client.batch(stmts,'write')","worker.drain({triggerSource,userId,budget:{maxItems,maxItemsPerTenant:maxItems}})","assertion('changes()=?',[effect.rowsAffected],'SHORT_TRANSACTION_ZERO_ROW_REJECTED')"]){assert.equal(observed.split(guard).length,source.split(guard).length);assert.ok(observed.includes(guard));}
 assert.throws(()=>instrumentSyntheticSource(file,source.replace('budget.assert();let db;','')),/ANCHOR_MISMATCH/);
 assert.equal(instrumentSyntheticSource('src/unrelated.js',source),source);
});
test('HMAC instrumentation returns the exact original hash operation without changing values',async()=>{
 const file='src/phase4Keys.js',source=await readFile(new URL('../'+file,import.meta.url),'utf8'),observed=instrumentSyntheticSource(file,source);assert.ok(observed.includes("createHmac('sha256',key).update(json).digest('hex')"));assert.ok(observed.includes('JSON.stringify(value)'));assert.ok(observed.includes('PHASE4_SYNTHETIC_KEYS_REJECTED'));
});

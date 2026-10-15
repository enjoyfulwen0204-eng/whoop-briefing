import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {instrumentSyntheticSource} from './stage6SyntheticDiagnostics.mjs';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createSyntheticDiagnostics} from './stage6SyntheticDiagnostics.mjs';
test('family exception diagnostics retain identifiers/frames without exception messages or payloads',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'s6-family-diagnostic-'));try{const p=join(dir,'result.json'),d=createSyntheticDiagnostics(p,'synthetic-operation'),error=Object.assign(Error('PRIVATE_HEALTH_VALUE_AND_TOKEN'),{code:'PHASE4_SOURCE_UNAVAILABLE'});error.stack='Error PRIVATE_HEALTH_VALUE_AND_TOKEN\n at privateFunction (/private/data/secret-value.js:1:2)\n at fail (file:///app/src/phase4Core.js:34:37)';
 d.failure(error,{workGeneration:11,failureStage:'METRIC_FAMILY'});const out=d.close(),raw=await readFile(p,'utf8');assert.ok(!raw.includes('PRIVATE_HEALTH')&&!raw.includes('private/data'));assert.deepEqual(out.failures,[{operationId:'synthetic-operation',workGeneration:11,failureStage:'METRIC_FAMILY',type:'Error',code:'PHASE4_SOURCE_UNAVAILABLE',frames:['src/phase4Core.js:34:37']}]);assert.equal(globalThis.__stage6SyntheticDiagnostic,undefined);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('diagnostic transforms preserve all original publication guards and algorithm calls',async()=>{
 const file='src/stage6ShortPublication.js',source=await readFile(new URL('../'+file,import.meta.url),'utf8'),observed=instrumentSyntheticSource(file,source);
 for(const guard of ["if(p.budget.remainingMs()<5500)fail('PUBLICATION_HEADROOM_REQUIRED')","client.batch(stmts,'write')","worker.drain({triggerSource,userId,budget:{maxItems,maxItemsPerTenant:maxItems}})","assertion('changes()=?',[effect.rowsAffected],'SHORT_TRANSACTION_ZERO_ROW_REJECTED')"]){assert.equal(observed.split(guard).length,source.split(guard).length);assert.ok(observed.includes(guard));}
 assert.throws(()=>instrumentSyntheticSource(file,source.replace('budget.assert();let db;','')),/ANCHOR_MISMATCH/);
 assert.equal(instrumentSyntheticSource('src/unrelated.js',source),source);
});
test('HMAC instrumentation returns the exact original hash operation without changing values',async()=>{
 const file='src/phase4Keys.js',source=await readFile(new URL('../'+file,import.meta.url),'utf8'),observed=instrumentSyntheticSource(file,source);assert.ok(observed.includes("createHmac('sha256',key).update(json).digest('hex')"));assert.ok(observed.includes('JSON.stringify(value)'));assert.ok(observed.includes('PHASE4_SYNTHETIC_KEYS_REJECTED'));
});
test('nested diagnostic scopes retain exact family and association work boundaries',async()=>{
 const file='src/phase4Reanalysis.js',source=await readFile(new URL('../'+file,import.meta.url),'utf8'),observed=instrumentSyntheticSource(file,source);
 for(const text of ["workKind:'stage6.family'","workKind:'stage6.associations'","if(unit.created)return",'stores.intelligence.analyzeAssociationFamily(context,'])assert.equal(observed.split(text).length,source.split(text).length);
 for(const phase of ['RAW_METRIC_SUBUNIT','METRIC_FAMILIES','ASSOCIATIONS'])assert.ok(observed.includes("begin('"+phase+"')"));
});

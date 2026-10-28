import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {nativeImportGraph} from './stage8-prepared-native-imports.mjs';
test('native import preflight includes re-exports and never evaluates source side effects',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'r22-static-imports-'));
 try{
  await writeFile(join(dir,'entry.mjs'),"export * from './dependency.mjs';globalThis.r22UnexpectedImportEvaluation=true;");
  await writeFile(join(dir,'dependency.mjs'),"throw Error('SOURCE_MUST_NOT_BE_EVALUATED');");
  assert.deepEqual(nativeImportGraph(dir,'entry.mjs'),['dependency.mjs','entry.mjs']);assert.equal(globalThis.r22UnexpectedImportEvaluation,undefined);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('missing or escaping static dependency fails before any application evaluation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'r22-static-imports-'));
 try{
  await writeFile(join(dir,'entry.mjs'),"import './missing.mjs';");assert.throws(()=>nativeImportGraph(dir,'entry.mjs'),/MISSING_STATIC_DEPENDENCY/);
  await writeFile(join(dir,'entry.mjs'),"export * from '../outside.mjs';");assert.throws(()=>nativeImportGraph(dir,'entry.mjs'),/IMPORT_ESCAPES_SOURCE_ROOT/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

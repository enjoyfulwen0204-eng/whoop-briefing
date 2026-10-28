import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureKeys as keys} from './localDb.js';
import {preparedDisposalFence,preparedReadDisposalFence,isPreparedDisposalFence,PREPARED_DISPOSAL_EXPIRY} from '../src/stage6PreparedDisposal.js';
import {createPhase4ContextRegistry} from '../src/phase4Cache.js';
const claim=Object.freeze({executionId:'synthetic-original-execution',identity:'a'.repeat(64),owner:'original-owner',generation:1});
const row=()=>{const hold=preparedDisposalFence(keys,'a',claim,2);return {name:hold.name,owner:hold.owner,expires_at:hold.expiresAt};};

test('signed prepared disposal hold binds tenant, original execution and original purge generation',()=>{
 const original=row();assert.equal(isPreparedDisposalFence(keys,'a',original,JSON.parse(original.owner)),true);
 assert.throws(()=>isPreparedDisposalFence(keys,'b',original,JSON.parse(original.owner)),/FENCE_CORRUPT/);
 for(const index of [0,2,3,4,5,6]){
  const fields=JSON.parse(original.owner);fields[index]=typeof fields[index]==='number'?fields[index]+1:fields[index]+'changed';
  assert.throws(()=>isPreparedDisposalFence(keys,'a',{...original,owner:JSON.stringify(fields)},fields),/FENCE_CORRUPT/);
 }
 assert.throws(()=>isPreparedDisposalFence(keys,'a',{...original,expires_at:'2050-01-01T00:00:00.000Z'},JSON.parse(original.owner)),/FENCE_CORRUPT/);
});

test('permanent disposal hold blocks a later purge even at its timestamp and never receives TTL deletion',async()=>{
 const original=row();let reads=0;
 const registry=createPhase4ContextRegistry({keys,timestamp:()=>PREPARED_DISPOSAL_EXPIRY,client:{execute:async statement=>{
  assert.match(statement.sql,/^SELECT name,owner,expires_at FROM resource_locks/);reads++;return {rows:[original]};
 }}});
 assert.equal(await registry.pending('a',3),1);assert.equal(await registry.pending('a',2),0);assert.equal(reads,2);
 assert.equal(original.owner,row().owner);
});

test('read disposal holds have a distinct signed lifetime with no execution authority',async()=>{
 const hold=preparedReadDisposalFence(keys,'a',{readId:'synthetic-read',identity:'b'.repeat(64),owner:'reader-owner',purgeGeneration:2}),
  original={name:hold.name,owner:hold.owner,expires_at:hold.expiresAt},fields=JSON.parse(original.owner);
 assert.equal(fields.length,6);assert.equal(fields[1],'PREPARED_DERIVED_READ_DISPOSAL_V1');
 assert.equal(isPreparedDisposalFence(keys,'a',original,fields),true);
 assert.throws(()=>isPreparedDisposalFence(keys,'b',original,fields),/FENCE_CORRUPT/);
 for(let index=0;index<fields.length;index++){
  const changed=[...fields];changed[index]=typeof changed[index]==='number'?changed[index]+1:changed[index]+'changed';
  assert.throws(()=>isPreparedDisposalFence(keys,'a',{...original,owner:JSON.stringify(changed)},changed),/FENCE_CORRUPT/);
 }
 assert.throws(()=>isPreparedDisposalFence(keys,'a',{...original,expires_at:'2050-01-01T00:00:00.000Z'},fields),/FENCE_CORRUPT/);
 const registry=createPhase4ContextRegistry({keys,timestamp:()=>PREPARED_DISPOSAL_EXPIRY,client:{execute:async statement=>{
  assert.match(statement.sql,/^SELECT name,owner,expires_at FROM resource_locks/);return {rows:[original]};
 }}});
 assert.equal(await registry.pending('a',3),1);assert.equal(await registry.pending('a',2),0);
});

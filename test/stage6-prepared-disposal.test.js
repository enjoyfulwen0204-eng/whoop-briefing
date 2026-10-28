import test from 'node:test';
import assert from 'node:assert/strict';
import {fixtureKeys as keys} from './localDb.js';
import {preparedDisposalFence,isPreparedDisposalFence,PREPARED_DISPOSAL_EXPIRY} from '../src/stage6PreparedDisposal.js';
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

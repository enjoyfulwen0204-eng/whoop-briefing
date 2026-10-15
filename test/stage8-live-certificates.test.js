import test from 'node:test';import assert from 'node:assert/strict';
import {syntheticPhase4Fixture} from './phase4Fixture.js';
const hash='a'.repeat(64),proofs=JSON.stringify(['RECOMPUTE_DERIVED','REPAIR_CURRENTNESS'].map(jobKind=>({jobKind,receiptKey:hash,completionHmac:hash})));
const insert=(db,row,verb='INSERT')=>{const fields=Object.keys(row);return db.raw.execute({sql:`${verb} INTO stage8_live_publications(${fields.join(',')}) VALUES(${fields.map(()=>'?')})`,args:fields.map(k=>row[k])});};
test('certificate schema enforces closed metadata, immutable/no-replace, safe numbers and deferred original ACK FK',async t=>{
 const f=await syntheticPhase4Fixture(t,{targetVersion:35}),base={user_id:'a',execution_mode:'LIVE',input_generation:1,scope_hash:hash,producer_hash:hash,artifact_hash:hash,proofs_json:proofs,issued_at:100,expires_at:200,publication_hmac:hash};
 await insert(f.db,base);
 await t.test('replacement cannot bypass immutability with recursive_triggers off',async()=>{await f.db.raw.execute('PRAGMA recursive_triggers=OFF');await assert.rejects(insert(f.db,{...base,artifact_hash:'b'.repeat(64)},'INSERT OR REPLACE'),/certificate_immutable/);});
 await t.test('immutable update and delete',async()=>{await assert.rejects(f.db.raw.execute('UPDATE stage8_live_publications SET expires_at=300'),/immutable/);await assert.rejects(f.db.raw.execute('DELETE FROM stage8_live_publications'),/immutable/);});
 await t.test('duplicate job proofs rejected',()=>assert.rejects(insert(f.db,{...base,input_generation:2,proofs_json:JSON.stringify([JSON.parse(proofs)[0],JSON.parse(proofs)[0]])}),/proof_shape/));
 await t.test('extra health text or duplicate object keys rejected',async()=>{await assert.rejects(insert(f.db,{...base,input_generation:2,proofs_json:proofs.replace('"jobKind":','"healthText":"private","jobKind":')}),/proof_shape/);await assert.rejects(insert(f.db,{...base,input_generation:2,proofs_json:proofs.replace('"jobKind":','"jobKind":"RECOMPUTE_DERIVED","jobKind":')}),/proof_shape/);});
 await t.test('fractional and unsafe generations rejected',async()=>{for(const value of [1.5,9007199254740992])await assert.rejects(insert(f.db,{...base,input_generation:value}),/CHECK/);});
 await t.test('fractional clocks and excessive TTL rejected',async()=>{for(const patch of [{issued_at:1.5},{expires_at:900101},{issued_at:0},{expires_at:100}])await assert.rejects(insert(f.db,{...base,input_generation:2,...patch}),/CHECK/);});
 await t.test('canonical hash and proof values required',async()=>{for(const patch of [{scope_hash:'Z'.repeat(64)},{publication_hmac:'A'.repeat(64)},{proofs_json:proofs.replace(hash,'x'.repeat(64))}])await assert.rejects(insert(f.db,{...base,input_generation:2,...patch}),/CHECK|proof_shape/);});
 await t.test('completion without original receipt cannot commit',async()=>{await assert.rejects(f.db.transaction(()=>f.db.raw.execute({sql:`INSERT INTO stage8_live_job_completions VALUES(?,'LIVE',1,'RECOMPUTE_DERIVED',0,?,?,1,?,?,100,50,?)`,args:['a',hash,'missing-execution',hash,hash,hash]})),/FOREIGN KEY/);});
 await t.test('existing35 startup validates without default upgrade or downgrade',async()=>{const result=await f.db.migrate();assert.equal(result.from,35);assert.equal(result.to,35);assert.equal(result.skipped,true);await assert.rejects(f.db.migrate({targetVersion:34}),/schema_version_incompatible/);});
});

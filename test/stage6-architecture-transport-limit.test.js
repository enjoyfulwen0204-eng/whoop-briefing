// Scaled transaction-lifetime model; not a measured provider limit.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {hranaTransport} from './hranaTransport.js';
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'independent-txn-cap-')),h=hranaTransport('file:'+join(dir,'db.sqlite'),{transactionMaxMs:20});let baton;
 t.after(async()=>{h.close();await rm(dir,{recursive:true,force:true});});
 const sql=async text=>{const body={requests:[{type:'execute',stmt:{sql:text,args:[],want_rows:true}}],...(baton?{baton}:{})},r=await (await h.fetch({json:async()=>body})).json();baton=r.baton;return r.results[0];};
 await sql('CREATE TABLE evidence(value INTEGER)');return {h,sql};
}
test('configured total transaction age rejects next SQL and rolls back pending writes',async t=>{const f=await fixture(t);
 await f.sql('BEGIN IMMEDIATE');await f.sql('INSERT INTO evidence VALUES(1)');await new Promise(r=>setTimeout(r,35));
 const end=await f.sql('COMMIT');assert.equal(end.type,'error');assert.equal(end.error.code,'TRANSACTION_TIMEOUT');
 const rows=await f.sql('SELECT count(*) n FROM evidence');assert.equal(rows.response.result.rows[0][0].value,'0');
});
test('time spent in an awaited COMMIT fault hook cannot bypass configured transaction ceiling',async t=>{const f=await fixture(t);
 await f.sql('BEGIN IMMEDIATE');await f.sql('INSERT INTO evidence VALUES(1)');f.h.arm({before:async()=>new Promise(r=>setTimeout(r,35))});
 const end=await f.sql('COMMIT');assert.equal(end.type,'error');assert.equal(end.error.code,'TRANSACTION_TIMEOUT');
});

test('delayed lost acknowledgement after durable COMMIT preserves committed work',async t=>{const f=await fixture(t);
 await f.sql('BEGIN IMMEDIATE');await f.sql('INSERT INTO evidence VALUES(1)');
 f.h.arm({after:async()=>new Promise(r=>setTimeout(r,35)),loseAcknowledgement:true});
 await assert.rejects(f.sql('COMMIT'),/SYNTHETIC_COMMIT_ACK_LOST/);
 const rows=await f.sql('SELECT count(*) n FROM evidence');assert.equal(rows.response.result.rows[0][0].value,'1');
});

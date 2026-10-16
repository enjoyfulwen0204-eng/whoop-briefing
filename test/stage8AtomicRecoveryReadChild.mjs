import {mock} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import * as libsql from '@libsql/client';
import {fixtureKeys} from './localDb.js';

const [directory,sourceOverride]=process.argv.slice(2),host='whoop-briefing-enjoyfulwen0204-eng.aws-ap-northeast-1.turso.io';let reads=0,writes=0;
globalThis.fetch=()=>{throw Error('REAL_NETWORK_FORBIDDEN');};
mock.module('@libsql/client',{namedExports:{...libsql,createClient:options=>{
 assert.equal(options.url,'libsql://'+host);assert.equal(options.authToken,'synthetic-only');
 const client=libsql.createClient({url:'file:'+(sourceOverride??join(directory,'source.sqlite')),intMode:'number'}),execute=client.execute.bind(client),batch=client.batch.bind(client);
 const read=statement=>{const sql=typeof statement==='string'?statement:statement.sql;if(!/^(SELECT|PRAGMA)\b/i.test(sql.trim())){writes++;throw Error('READ_ONLY_SQL_REQUIRED');}reads++;};
 client.execute=statement=>{read(statement);return execute(statement);};
 client.batch=(statements,mode)=>{assert.equal(mode,'read');for(const statement of statements)read(statement);return batch(statements,mode);};
 return client;
}}});
const {verifyStage8AtomicRecovery}=await import('../scripts/stage8-atomic-recovery.mjs');
const result=await verifyStage8AtomicRecovery({manifestPath:join(directory,'source.enc.atomic-precommit.json'),keyPath:join(directory,'key'),keys:fixtureKeys,
 releaseSha:'a'.repeat(40),sourceSha:'b'.repeat(40),environment:{TURSO_DATABASE_URL:'libsql://'+host,TURSO_AUTH_TOKEN:'synthetic-only'}});
assert.ok(reads>0);assert.equal(writes,0);console.log(JSON.stringify({...result,syntheticReads:reads,syntheticWriteAttempts:writes}));

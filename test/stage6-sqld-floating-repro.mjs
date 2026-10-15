import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@libsql/client';

// Explicit diagnostic only: the HTTP case is a known FAIL on pinned
// sqld v0.24.33. Public numeric literal, no app tables, grants or health data.
const roundTrip=async client=>{
 const value=(await client.execute('SELECT 0.9048374180359595 value')).rows[0].value;
 return (await client.execute({sql:'SELECT 0.9048374180359595 IS ? same',args:[value]})).rows[0].same;
};
test('native exact REAL round trip retains snapshot equality',async()=>{
 const client=createClient({url:'file::memory:'});
 try{assert.equal(await roundTrip(client),1);}finally{client.close();}
});
test('HTTP exact REAL round trip must retain snapshot equality (known fixture blocker)',async()=>{
 const client=createClient({url:'http://sqld-control:8080'});
 try{assert.equal(await roundTrip(client),1,'snapshot IS guard must not reject an unchanged public REAL');}finally{client.close();}
});

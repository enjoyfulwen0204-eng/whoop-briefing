import {fileURLToPath} from 'node:url';
import test from 'node:test';import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../..',import.meta.url));const {stage8Fixture}=await import(root+'/test/stage8Fixture.js');
test('Native ordinary health questions in all three languages remain functional',async t=>{
 const f=await stage8Fixture(t);for(const [locale,text] of [['zh-TW','今天我的 HRV 多少？'],['vi','HRV của tôi hôm nay là bao nhiêu?'],['en','What is my HRV today?']]){await f.db.setLocale('a',locale);const r=await f.app.handle({...f.input,text});console.log('ORDINARY_PROBE',JSON.stringify({locale,text,reply:r?.text}));assert.match(r.text,/HRV: 50\.0/);}
});

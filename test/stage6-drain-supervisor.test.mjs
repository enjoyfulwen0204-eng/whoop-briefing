import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
import {superviseDrainChild} from './stage6LinuxDrainSupervisor.mjs';
const child=code=>spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','ignore','ipc']});
for(const [name,code] of [['exit0',"process.once('message',()=>process.exit(0))"],['signal',"process.once('message',()=>process.kill(process.pid,'SIGTERM'))"]])
 test('premature '+name+' settles as a finite failure',async()=>{await assert.rejects(superviseDrainChild(child(code),{}, {timeoutMs:2000}),/DRAIN_CHILD_PREMATURE_EXIT/);});
test('reply without termination cannot remove the original bound',async()=>{const c=child("process.once('message',()=>process.send({result:{ok:true},scopes:{} }));setInterval(()=>{},1000)");await assert.rejects(superviseDrainChild(c,{}, {timeoutMs:200}),/ORIGINAL_OVERALL_BOUND_EXCEEDED/);});
test('valid reply and clean termination are required together',async()=>{const c=child("process.once('message',()=>process.send({result:{ok:true},scopes:{}},()=>process.disconnect()))");assert.deepEqual(await superviseDrainChild(c,{}, {timeoutMs:2000}),{result:{ok:true},scopes:{}});});

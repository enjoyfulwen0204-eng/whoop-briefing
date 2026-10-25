import test from 'node:test';import assert from 'node:assert/strict';
import {resourcePacket,validateChildResourceSample,validateChildResourceShape,SEMI4_ARGV,SEMI4_TOKEN} from './stage6-native-child-resource-profile.mjs';
import {projectChildResources} from '../tools/stage8-qualification/first17-work-supervisor.mjs';
import {spawnSync} from 'node:child_process';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath} from 'node:url';
const sha='c'.repeat(40),input=()=>({candidateSha:sha,pid:123,parentPid:456,node:'v22.23.2',platform:'linux',architecture:'x64',
 argv:[...SEMI4_ARGV],nodeOptions:undefined,startupHeapLimitBytes:113246208,exitSampleHeapLimitBytes:113246208,maxRSSKiB:200000,exitCode:0});
test('closed child packet converts documented KiB and binds exact original child',()=>{
 const p=resourcePacket(input());assert.equal(p.rssHighWaterToExitSampleBytes,204800000);assert.equal(validateChildResourceSample(p,sha,{pid:123,parentPid:456}),true);
});
test('sample heap and RSS high-water bounds accepted; over-bound observations refused',()=>{
 for(const [heap,rss,accepted]of [[192*1024*1024,384*1024,true],[192*1024*1024+1,384*1024,false],[192*1024*1024,384*1024+1,false]]){
  const p=resourcePacket({...input(),startupHeapLimitBytes:heap,exitSampleHeapLimitBytes:heap,maxRSSKiB:rss});
  if(accepted)assert.equal(validateChildResourceSample(p,sha),true);else assert.throws(()=>validateChildResourceSample(p,sha));
 }
});
test('old flags, extra flags, NODE_OPTIONS and wrong platform cannot claim selected profile',()=>{
 for(const change of [{argv:SEMI4_ARGV.map(x=>x==='--max-semi-space-size=4'?'--max-semi-space-size=2':x)},
  {argv:[...SEMI4_ARGV,'--experimental-async-context-frame']},{nodeOptions:'--max-semi-space-size=4'},
  {platform:'darwin'},{node:'v23.0.0'},{architecture:'arm64'}])assert.throws(()=>validateChildResourceSample(resourcePacket({...input(),...change}),sha));
});
test('wrong child/candidate, invalid heap delta, exit failure and unknown fields refuse',()=>{
 const p=resourcePacket(input());assert.throws(()=>validateChildResourceSample(p,'d'.repeat(40)));
 assert.throws(()=>validateChildResourceSample(p,sha,{pid:999,parentPid:456}));assert.throws(()=>validateChildResourceSample(p,sha,{pid:123,parentPid:999}));
 for(const change of [{exitSampleHeapLimitBytes:113246209},{rssHighWaterToExitSampleBytes:0},{rssHighWaterToExitSampleBytes:NaN},{productionEvidence:true},
  {EOFQualified:true},{sixJobCompletionQualified:true},{capacityQualified:true},{exitCode:1},{extra:'PRIVATE_CANARY'},
  {rssHighWaterScope:'CONTAINER_PEAK'},{fullLifetimeRSSBoundVerified:true},{fullLifetimeHeapBoundVerified:true},{samplePoint:'AFTER_PHYSICAL_EXIT'},{rssHighWaterSource:'CURRENT_RSS'}])assert.throws(()=>validateChildResourceSample({...p,...change},sha));
});
test('invalid API numbers refuse without printing unexpected raw strings',()=>{
 for(const change of [{maxRSSKiB:NaN},{maxRSSKiB:-1},{maxRSSKiB:Number.MAX_SAFE_INTEGER},{startupHeapLimitBytes:0},
  {pid:0},{exitCode:undefined},{candidateSha:'PRIVATE_CANARY'}])assert.throws(()=>resourcePacket({...input(),...change}));
 const p=resourcePacket({...input(),node:'PRIVATE_CANARY',platform:'PRIVATE_CANARY',architecture:'PRIVATE_CANARY',argv:['PRIVATE_CANARY']});
 assert.equal(JSON.stringify(p).includes('PRIVATE_CANARY'),false);
});
test('projection preserves safe over-bound counters; missing, duplicate, wrong-child or extra fields are UNKNOWN',()=>{
 const prefix='STAGE6_CHILD_RESOURCE_PROFILE ',p=resourcePacket(input()),line=prefix+JSON.stringify(p),identity={pid:123,parentPid:456};
 assert.equal(projectChildResources(line,sha,identity).status,'OBSERVED_SAMPLE_WITHIN_SELECTED_MEMORY_BOUNDS');
 const over=resourcePacket({...input(),maxRSSKiB:384*1024+1}),result=projectChildResources(prefix+JSON.stringify(over),sha,identity);
 assert.equal(result.status,'OBSERVED_SAMPLE_OUTSIDE_SELECTED_MEMORY_PROFILE');assert.equal(result.packet.rssHighWaterToExitSampleBytes,over.rssHighWaterToExitSampleBytes);
 for(const raw of ['',line+'\n'+line,prefix+JSON.stringify({...p,pid:999}),prefix+JSON.stringify({...p,extra:'PRIVATE_CANARY'})]){
  const result=projectChildResources(raw,sha,identity);assert.equal(result.status,'UNKNOWN_RESOURCE_OBSERVATION');
  assert.equal(result.packet,null);assert.equal(JSON.stringify(result).includes('PRIVATE_CANARY'),false);
 }
});
test('real empty child emits exactly one main-process packet with original PID and actual V8 metadata',()=>{
 const dir=mkdtempSync(join(tmpdir(),'stage6-resource-empty-')),file=join(dir,'empty.mjs');
 try{
  writeFileSync(file,'// Empty metadata-only control; no application or SQL workload.\n',{mode:0o600});
  const result=spawnSync(process.execPath,[...SEMI4_ARGV,file],{cwd:fileURLToPath(new URL('../',import.meta.url)),
   env:{PATH:process.env.PATH,HOME:tmpdir(),LANG:'C.UTF-8',NODE_ENV:'test',STAGE6_CHILD_PROFILE:SEMI4_TOKEN,EXPECTED_CANDIDATE_SHA:sha},
   encoding:'utf8',timeout:10000});assert.equal(result.status,0);assert.equal(result.error,undefined);
  const lines=result.stdout.split('\n').filter(l=>l.startsWith('STAGE6_CHILD_RESOURCE_PROFILE '));assert.equal(lines.length,1);
  const packet=JSON.parse(lines[0].slice('STAGE6_CHILD_RESOURCE_PROFILE '.length));
  assert.equal(validateChildResourceShape(packet,sha,{pid:result.pid,parentPid:process.pid}),true);
  assert.equal(packet.argvMatchesSelectedProfile,true);assert.equal(packet.startupHeapLimitBytes,packet.exitSampleHeapLimitBytes);
  assert.ok(packet.startupHeapLimitBytes>0);assert.ok(packet.rssHighWaterToExitSampleBytes>0);assert.equal(packet.exitCode,0);
  // Local platform remains its actual closed label; this empty control proves
  // sensor plumbing only, never Linux workload/192MiB/384MiB capacity.
 }finally{rmSync(dir,{recursive:true,force:true});}
});

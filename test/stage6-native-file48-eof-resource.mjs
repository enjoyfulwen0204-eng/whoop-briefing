// Test-only process metadata. No health data, SQL, authority or outcome changes.
import assert from 'node:assert/strict';
import {getHeapStatistics} from 'node:v8';
import {writeSync} from 'node:fs';
import {isMainThread} from 'node:worker_threads';

export const FILE48_TOKEN='ONE_ORIGINAL_FILE48_POSITIVE_EOF_V1';
export const FILE48_ARGV=Object.freeze(['--import','./test/stage6-native-file48-eof-resource.mjs','--max-old-space-size=48','--max-semi-space-size=4']);
const integer=n=>Number.isSafeInteger(n)&&n>=0;
export function resourcePacket({candidateSha,pid,parentPid,node,platform,architecture,argv,nodeOptions,
 startupHeapLimitBytes,exitSampleHeapLimitBytes,maxRSSKiB,exitCode}){
 assert.match(candidateSha??'',/^[a-f0-9]{40}$/);
 for(const n of [pid,parentPid,startupHeapLimitBytes,exitSampleHeapLimitBytes,maxRSSKiB])assert.ok(integer(n)&&n>0);
 assert.ok(integer(maxRSSKiB*1024));assert.ok(integer(exitCode)&&exitCode<=255);
 return {contract:'one-native-child-file48-eof-resource-observation-v1',candidateSha,pid,parentPid,
  node:node==='v22.23.2'?node:'OTHER',platform:platform==='linux'?platform:'OTHER',
  architecture:architecture==='x64'?architecture:'OTHER',
  argvMatchesSelectedProfile:Array.isArray(argv)&&argv.length===FILE48_ARGV.length&&argv.every((x,i)=>x===FILE48_ARGV[i])&&!nodeOptions,
  selectedOldSpaceMiB:48,selectedSemiSpaceMiB:4,startupHeapLimitBytes,exitSampleHeapLimitBytes,
  rssHighWaterToExitSampleBytes:maxRSSKiB*1024,rssHighWaterScope:'THIS_NODE_PROCESS_THROUGH_EXIT_CALLBACK_SAMPLE_NOT_LATER_HANDLERS_PHYSICAL_EXIT_OWNED_SQLD_OR_CONTAINER',
  rssHighWaterSource:'PROCESS_RESOURCE_USAGE_MAXRSS_KIB_TIMES_1024_AT_EXIT_CALLBACK_SAMPLE',exitCode,
  samplePoint:'REGISTERED_MAIN_THREAD_EXIT_CALLBACK',fullLifetimeRSSBoundVerified:false,fullLifetimeHeapBoundVerified:false,
  productionEvidence:false,EOFQualified:false,sixJobCompletionQualified:false,capacityQualified:false};
}
export function validateChildResourceShape(p,candidateSha,{pid,parentPid}={}){
 assert.ok(p&&typeof p==='object'&&!Array.isArray(p));
 assert.deepEqual(Reflect.ownKeys(p).sort(),['contract','candidateSha','pid','parentPid','node','platform','architecture',
  'argvMatchesSelectedProfile','selectedOldSpaceMiB','selectedSemiSpaceMiB','startupHeapLimitBytes','exitSampleHeapLimitBytes',
  'rssHighWaterToExitSampleBytes','rssHighWaterScope','rssHighWaterSource','exitCode','samplePoint','fullLifetimeRSSBoundVerified','fullLifetimeHeapBoundVerified','productionEvidence','EOFQualified','sixJobCompletionQualified','capacityQualified'].sort());
 assert.equal(p.contract,'one-native-child-file48-eof-resource-observation-v1');assert.match(candidateSha??'',/^[a-f0-9]{40}$/);assert.equal(p.candidateSha,candidateSha);
 for(const n of [p.pid,p.parentPid])assert.ok(integer(n)&&n>0);
 if(pid!==undefined)assert.equal(p.pid,pid);if(parentPid!==undefined)assert.equal(p.parentPid,parentPid);
 assert.ok(['v22.23.2','OTHER'].includes(p.node));assert.ok(['linux','OTHER'].includes(p.platform));assert.ok(['x64','OTHER'].includes(p.architecture));
 assert.equal(typeof p.argvMatchesSelectedProfile,'boolean');assert.equal(p.selectedOldSpaceMiB,48);assert.equal(p.selectedSemiSpaceMiB,4);
 for(const n of [p.startupHeapLimitBytes,p.exitSampleHeapLimitBytes,p.rssHighWaterToExitSampleBytes])assert.ok(integer(n)&&n>0);
 assert.equal(p.rssHighWaterScope,'THIS_NODE_PROCESS_THROUGH_EXIT_CALLBACK_SAMPLE_NOT_LATER_HANDLERS_PHYSICAL_EXIT_OWNED_SQLD_OR_CONTAINER');
 assert.equal(p.rssHighWaterSource,'PROCESS_RESOURCE_USAGE_MAXRSS_KIB_TIMES_1024_AT_EXIT_CALLBACK_SAMPLE');assert.ok(integer(p.exitCode)&&p.exitCode<=255);
 assert.equal(p.samplePoint,'REGISTERED_MAIN_THREAD_EXIT_CALLBACK');
 for(const k of ['fullLifetimeRSSBoundVerified','fullLifetimeHeapBoundVerified'])assert.equal(p[k],false);
 for(const k of ['productionEvidence','EOFQualified','sixJobCompletionQualified','capacityQualified'])assert.equal(p[k],false);
 return true;
}
export function validateChildResourceSample(p,candidateSha,identity){
 validateChildResourceShape(p,candidateSha,identity);
 assert.equal(p.node,'v22.23.2');assert.equal(p.platform,'linux');assert.equal(p.architecture,'x64');assert.equal(p.argvMatchesSelectedProfile,true);
 assert.ok(p.startupHeapLimitBytes<=64*1024*1024);assert.equal(p.startupHeapLimitBytes,p.exitSampleHeapLimitBytes);
 assert.ok(p.rssHighWaterToExitSampleBytes<=384*1024*1024);assert.equal(p.exitCode,0);return true;
}

// The supervisor sets this exact test-only token in its closed child env.
// Pure unit imports do not install listeners. Exit capture is synchronous;
// killed/crashed children without a packet remain UNKNOWN, never acknowledged.
// Counters end at this listener sample; later exit listeners/physical exit are
// outside this observation. This never establishes a full-lifetime RSS bound.
if(isMainThread&&process.env.STAGE6_CHILD_PROFILE===FILE48_TOKEN){
 const start=getHeapStatistics().heap_size_limit,sha=process.env.EXPECTED_CANDIDATE_SHA;
 const usage=process.resourceUsage.bind(process),stats=getHeapStatistics,write=writeSync;
 const initial={candidateSha:sha,pid:process.pid,parentPid:process.ppid,node:process.version,
  platform:process.platform,architecture:process.arch,argv:[...process.execArgv],nodeOptions:process.env.NODE_OPTIONS,
  startupHeapLimitBytes:start};
 process.once('exit',exitCode=>{
  const packet=resourcePacket({...initial,exitSampleHeapLimitBytes:stats().heap_size_limit,maxRSSKiB:usage().maxRSS,exitCode});
  write(1,'STAGE6_FILE48_EOF_CHILD_RESOURCE '+JSON.stringify(packet)+'\n');
 });
}

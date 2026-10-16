// Pure metadata validator plus opt-in real-container preflight. Importing this
// module does not inspect the host, register tests, create a DB or start work.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,posix} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {runningReleaseSha} from '../src/phase4Release.js';

const decodeMountPath=value=>value.replace(/\\([0-7]{3})/g,(_match,octal)=>String.fromCharCode(parseInt(octal,8)));
export function parseOfflineMountInfo(text){
 assert.equal(typeof text,'string','ACTUAL_MOUNTINFO_REQUIRED');
 return text.trim().split('\n').filter(Boolean).map(line=>{
  const columns=line.split(' '),separator=columns.indexOf('-');
  assert.ok(separator>=6&&columns.length>=separator+4,'MOUNTINFO_INVALID');
  return {path:decodeMountPath(columns[4]),options:columns[5].split(',')};
 });
}
export function assertOfflineLiveLinuxPreflight(metadata){
 assert.equal(metadata.platform,'linux','LINUX_CONTAINER_REQUIRED');
 assert.equal(metadata.container,true,'ISOLATED_CONTAINER_REQUIRED');
 assert.match(metadata.nodeVersion??'',/^v22\.\d+\.\d+$/,'NODE_22_REQUIRED');
 assert.deepEqual([...metadata.interfaces].sort(),['lo'],'NETWORK_NONE_REQUIRED');
 assert.equal(metadata.memoryMax,'536870912','EXACT_512_MIB_CGROUP_REQUIRED');
 assert.equal(metadata.swapMax,'0','ZERO_SWAP_REQUIRED');
 const cpu=String(metadata.cpuMax??'').trim().split(/\s+/);
 assert.ok(cpu.length===2&&cpu.every(value=>/^[1-9][0-9]*$/.test(value)),'FINITE_POSITIVE_CPU_QUOTA_REQUIRED');
 assert.ok(cpu.every(value=>Number.isSafeInteger(Number(value))),'SAFE_CPU_QUOTA_REQUIRED');
 assert.equal(BigInt(cpu[0])*2n,BigInt(cpu[1]),'EXACT_HALF_CPU_REQUIRED');
 assert.deepEqual(metadata.forbiddenEnvironment??[],[],'EXTERNAL_ENVIRONMENT_FORBIDDEN');
 assert.ok(posix.isAbsolute(metadata.root)&&metadata.root===posix.normalize(metadata.root),'CANONICAL_CHECKOUT_ROOT_REQUIRED');
 assert.equal(metadata.cwd,metadata.root,'REAL_CHECKOUT_CWD_REQUIRED');
 assert.equal(metadata.gitFile,true,'REAL_WORKTREE_GIT_FILE_REQUIRED');
 assert.equal(metadata.gitCommonDirectory,true,'REAL_PRIMARY_GIT_DIRECTORY_REQUIRED');
 assert.ok(posix.isAbsolute(metadata.gitCommonDir)&&metadata.gitCommonDir===posix.normalize(metadata.gitCommonDir),'CANONICAL_PRIMARY_GIT_REQUIRED');
 assert.match(metadata.releaseSha??'',/^[a-f0-9]{40}$/,'REAL_CHECKOUT_HEAD_REQUIRED');
 const mounts=parseOfflineMountInfo(metadata.mountInfo),required=[`${metadata.root}/src`,`${metadata.root}/test`,`${metadata.root}/package.json`,`${metadata.root}/.git`,metadata.gitCommonDir];
 const readOnlyMounts=[];
 for(const path of required){
  const matches=mounts.filter(mount=>mount.path===path);
  assert.equal(matches.length,1,`EXACT_READONLY_MOUNT_REQUIRED:${path}`);
  assert.ok(matches[0].options.includes('ro')&&!matches[0].options.includes('rw'),`READONLY_MOUNT_REQUIRED:${path}`);
  assert.ok(!mounts.some(mount=>mount.path.startsWith(path+'/')&&(!mount.options.includes('ro')||mount.options.includes('rw'))),`WRITABLE_NESTED_SOURCE_MOUNT_FORBIDDEN:${path}`);
  readOnlyMounts.push(path);
 }
 const output=metadata.output;
 assert.equal(output.path,'/qualification','FIXED_OUTPUT_ROOT_REQUIRED');
 assert.equal(output.realPath,output.path,'OUTPUT_SYMLINK_FORBIDDEN');
 assert.equal(output.isDirectory,true,'PRIVATE_OUTPUT_DIRECTORY_REQUIRED');
 assert.equal(output.mode,0o700,'PRIVATE_OUTPUT_MODE_0700_REQUIRED');
 assert.ok(Number.isSafeInteger(output.uid)&&output.uid>=0,'OUTPUT_OWNER_REQUIRED');
 const outputMount=mounts.filter(mount=>mount.path===output.path);
 assert.equal(outputMount.length,1,'EXACT_OUTPUT_MOUNT_REQUIRED');
 assert.ok(outputMount[0].options.includes('rw')&&!outputMount[0].options.includes('ro'),'WRITABLE_OUTPUT_MOUNT_REQUIRED');
 if(metadata.stage==='initial')assert.deepEqual(output.entries,[],'FRESH_EMPTY_OUTPUT_REQUIRED');
 else{
  assert.ok(['profile','running'].includes(metadata.stage),'PREFLIGHT_STAGE_REQUIRED');
  assert.deepEqual([...output.entries].sort(),['dense','empty'],'ONLY_FRESH_PROFILE_DIRECTORIES_ALLOWED');
  assert.ok(['empty','dense'].includes(metadata.profile),'EXPLICIT_PROFILE_REQUIRED');
  assert.equal(output.profileRealPath,`${output.path}/${metadata.profile}`,'PROFILE_SYMLINK_FORBIDDEN');
  assert.equal(output.profileIsDirectory,true,'PRIVATE_PROFILE_DIRECTORY_REQUIRED');
  assert.equal(output.profileMode,0o700,'PRIVATE_PROFILE_MODE_0700_REQUIRED');
  if(metadata.stage==='profile')assert.deepEqual(output.profileEntries,[],'FRESH_EMPTY_PROFILE_REQUIRED');
  else assert.deepEqual([...output.profileEntries].sort(),['physical','run.tap','sqld.log'],'ONLY_FRESH_RUNNING_PROFILE_ALLOWED');
 }
 return Object.freeze({qualificationScope:'LOCAL_PRODUCER_AND_SQLD_COMBINED_CGROUP_ONLY',nodeVersion:metadata.nodeVersion,releaseSha:metadata.releaseSha,memoryMaxBytes:536870912,swapMaxBytes:0,
  cpuQuota:Number(cpu[0]),cpuPeriod:Number(cpu[1]),readOnlyMounts,outputMode:'0700',stage:metadata.stage});
}
export function collectOfflineLiveLinuxPreflight({root,stage='initial',profile=null}){
 const checkout=realpathSync(root),gitEnv={...process.env};for(const name of Object.keys(gitEnv))if(name.startsWith('GIT_'))delete gitEnv[name];
 const common=execFileSync('git',['rev-parse','--git-common-dir'],{cwd:checkout,env:gitEnv,encoding:'utf8',timeout:2000,stdio:['ignore','pipe','pipe']}).trim();
 const gitCommonDir=realpathSync(resolve(checkout,common)),output=lstatSync('/qualification');
 const forbidden=['PHASE4_RELEASE_SHA','RENDER_GIT_COMMIT','GITHUB_ACTIONS','TURSO_DATABASE_URL','TURSO_AUTH_TOKEN','TELEGRAM_BOT_TOKEN','WHOOP_CLIENT_ID','WHOOP_CLIENT_SECRET','OPENROUTER_API_KEY'];
 const result={platform:process.platform,container:existsSync('/.dockerenv'),nodeVersion:process.version,interfaces:readdirSync('/sys/class/net'),
  memoryMax:readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),swapMax:readFileSync('/sys/fs/cgroup/memory.swap.max','utf8').trim(),cpuMax:readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim(),
  mountInfo:readFileSync('/proc/self/mountinfo','utf8'),forbiddenEnvironment:Object.keys(process.env).filter(name=>(name.startsWith('GIT_')||forbidden.includes(name))&&process.env[name]),
  root:checkout,cwd:realpathSync(process.cwd()),gitFile:lstatSync(resolve(checkout,'.git')).isFile(),gitCommonDir,gitCommonDirectory:lstatSync(gitCommonDir).isDirectory(),releaseSha:runningReleaseSha({}),stage,profile,
  output:{path:'/qualification',realPath:realpathSync('/qualification'),isDirectory:output.isDirectory(),mode:output.mode&0o777,uid:output.uid,entries:readdirSync('/qualification')}};
 if(stage!=='initial'){
  assert.ok(['empty','dense'].includes(profile),'EXPLICIT_PROFILE_REQUIRED');const path=`/qualification/${profile}`,info=lstatSync(path);
  Object.assign(result.output,{profileRealPath:realpathSync(path),profileIsDirectory:info.isDirectory(),profileMode:info.mode&0o777,profileEntries:readdirSync(path)});
 }
 return result;
}

const direct=process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href;
if(direct&&process.argv[2]==='--check'){
 const root=fileURLToPath(new URL('..',import.meta.url)),stage=process.argv[3]??'initial',profile=process.argv[4]??null;
 console.log('STAGE8_OFFLINE_PREFLIGHT '+JSON.stringify(assertOfflineLiveLinuxPreflight(collectOfflineLiveLinuxPreflight({root,stage,profile}))));
}else if(direct){
 const {default:test}=await import('node:test');
 const root='/fixture',common='/owner/project/.git';
 const line=(id,path,options='ro')=>`${id} 1 0:99 / ${path} ${options},relatime - virtiofs synthetic rw`;
 const fixture=()=>({platform:'linux',container:true,nodeVersion:'v22.23.2',interfaces:['lo'],memoryMax:'536870912',swapMax:'0',cpuMax:'50000 100000',forbiddenEnvironment:[],
  root,cwd:root,gitFile:true,gitCommonDirectory:true,gitCommonDir:common,releaseSha:'a'.repeat(40),stage:'initial',profile:null,
  mountInfo:[`${root}/src`,`${root}/test`,`${root}/package.json`,`${root}/.git`,common].map((path,index)=>line(index+2,path)).concat(line(9,'/qualification','rw')).join('\n'),
  output:{path:'/qualification',realPath:'/qualification',isDirectory:true,mode:0o700,uid:501,entries:[]}});
 test('exact offline Linux resource/mount profile passes without inspecting the real host',()=>{
  const value=assertOfflineLiveLinuxPreflight(fixture());assert.equal(value.memoryMaxBytes,536870912);assert.equal(value.cpuQuota,50000);assert.equal(value.readOnlyMounts.length,5);
 });
 for(const [name,change] of [
  ['unlimited memory',m=>{m.memoryMax='max';}],['wrong memory',m=>{m.memoryMax='1073741824';}],['swap',m=>{m.swapMax='536870912';}],
  ['unlimited CPU',m=>{m.cpuMax='max 100000';}],['wrong CPU',m=>{m.cpuMax='100000 100000';}],['zero quota',m=>{m.cpuMax='0 100000';}],
  ['zero period',m=>{m.cpuMax='50000 0';}],['unsafe quota',m=>{m.cpuMax='10000000000000000000 20000000000000000000';}],
  ['Node24',m=>{m.nodeVersion='v24.0.0';}],['malformed Node22',m=>{m.nodeVersion='v22.unverified';}],['external interface',m=>{m.interfaces.push('eth0');}],
  ['not container',m=>{m.container=false;}],['injected identity',m=>{m.forbiddenEnvironment=['GIT_DIR'];}],['private mode',m=>{m.output.mode=0o755;}],
  ['stale output',m=>{m.output.entries=['prior-report.json'];}],['output symlink',m=>{m.output.realPath='/private/other';}],
  ['wrong checkout',m=>{m.cwd='/app';}],['missing worktree file',m=>{m.gitFile=false;}],['missing primary Git',m=>{m.gitCommonDirectory=false;}],
 ])test(`reject ${name} before any database construction`,()=>{const metadata=fixture();change(metadata);assert.throws(()=>assertOfflineLiveLinuxPreflight(metadata));});
 for(const path of [`${root}/src`,`${root}/test`,`${root}/package.json`,`${root}/.git`,common]){
  test(`reject writable mount ${path}`,()=>{const metadata=fixture();metadata.mountInfo=metadata.mountInfo.replace(`${path} ro,`,`${path} rw,`);assert.throws(()=>assertOfflineLiveLinuxPreflight(metadata),/READONLY_MOUNT_REQUIRED/);});
  test(`reject missing mount ${path}`,()=>{const metadata=fixture();metadata.mountInfo=metadata.mountInfo.split('\n').filter(row=>!row.includes(` ${path} `)).join('\n');assert.throws(()=>assertOfflineLiveLinuxPreflight(metadata),/EXACT_READONLY_MOUNT_REQUIRED/);});
 }
 test('reject writable nested source and readonly output mounts',()=>{
  const nested=fixture();nested.mountInfo+='\n'+line(10,root+'/src/nested','rw');assert.throws(()=>assertOfflineLiveLinuxPreflight(nested),/WRITABLE_NESTED_SOURCE_MOUNT_FORBIDDEN/);
  const output=fixture();output.mountInfo=output.mountInfo.replace('/qualification rw,','/qualification ro,');assert.throws(()=>assertOfflineLiveLinuxPreflight(output),/WRITABLE_OUTPUT_MOUNT_REQUIRED/);
 });
 test('profile freshness is distinct from an already running fresh database',()=>{
  const metadata=fixture();metadata.stage='profile';metadata.profile='empty';Object.assign(metadata.output,{entries:['empty','dense'],profileRealPath:'/qualification/empty',profileIsDirectory:true,profileMode:0o700,profileEntries:[]});
  assertOfflineLiveLinuxPreflight(metadata);metadata.output.profileEntries=['report.json'];assert.throws(()=>assertOfflineLiveLinuxPreflight(metadata),/FRESH_EMPTY_PROFILE_REQUIRED/);
  metadata.stage='running';metadata.output.profileEntries=['physical','sqld.log','run.tap'];assertOfflineLiveLinuxPreflight(metadata);
  metadata.output.profileMode=0o755;assert.throws(()=>assertOfflineLiveLinuxPreflight(metadata),/PRIVATE_PROFILE_MODE_0700_REQUIRED/);
 });
 test('mountinfo decodes kernel-escaped paths and rejects malformed metadata',()=>{
  assert.equal(parseOfflineMountInfo(line(1,'/fixture\\040space/src'))[0].path,'/fixture space/src');assert.throws(()=>parseOfflineMountInfo('invalid'),/MOUNTINFO_INVALID/);
 });
}

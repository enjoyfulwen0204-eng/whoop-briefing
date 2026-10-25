// Sensor compatibility only. No Stage6/health fixture, SQL, authority or results.
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {parseOwnedStat,parseCPUStat} from './stage6-native-recovery17-cost.mjs';
const integer=n=>Number.isSafeInteger(n)&&n>=0;
export function inspectOwnedSensors({child,readText=p=>readFileSync(p,'utf8'),cpu=()=>process.cpuUsage(),ticks=()=>Number(execFileSync('/usr/bin/getconf',['CLK_TCK'],{encoding:'utf8',timeout:1000,maxBuffer:1024}).trim())}){
 const checks=Object.fromEntries(['ownedChild','clockTicks','rootCgroups','quota','ownedStat','containerStat','clientCounters','monotonicEndpoints'].map(k=>[k,'UNKNOWN']));
 const check=(name,fn)=>{try{checks[name]=fn()===true?'PASS':'FAIL';}catch{checks[name]='UNKNOWN';}};
 const capturedPID=child?.pid;
 const alive=()=>child?.spawnfile==='/usr/local/bin/isolated-sqld'&&Array.isArray(child.spawnargs)&&child.spawnargs[0]===child.spawnfile&&integer(capturedPID)&&capturedPID>0&&child.pid===capturedPID&&child.exitCode===null&&child.signalCode===null;
 check('ownedChild',alive);if(checks.ownedChild!=='PASS')return {checks,knownDottedExtensionSeen:null,legacySyntaxWouldReject:null};
 check('clockTicks',()=>{const h=ticks();return integer(h)&&h>0&&h<=1000000;});
 let first,last,dotted=null,legacy=null;
 for(let endpoint=0;endpoint<2;endpoint++){
  if(!alive()){checks.ownedChild='FAIL';return {checks,knownDottedExtensionSeen:dotted,legacySyntaxWouldReject:legacy};}
  const statuses={};const c=(name,fn)=>{try{statuses[name]=fn()===true?'PASS':'FAIL';}catch{statuses[name]='UNKNOWN';}};
  let stat,container,client;
  c('rootCgroups',()=>readText('/proc/self/cgroup').trim()==='0::/'&&readText('/proc/'+capturedPID+'/cgroup').trim()==='0::/');
  c('quota',()=>readText('/sys/fs/cgroup/cpu.max').trim()==='50000 100000');
  c('ownedStat',()=>{stat=parseOwnedStat(readText('/proc/'+capturedPID+'/stat'),capturedPID);return true;});
  c('containerStat',()=>{const text=readText('/sys/fs/cgroup/cpu.stat');container=parseCPUStat(text);dotted=(dotted??false)||/^core_sched\.force_idle_usec\s+\d+$/m.test(text);legacy=(legacy??false)||!text.trim().split('\n').every(line=>/^\w+\s+\d+$/.test(line));return true;});
  c('clientCounters',()=>{client=cpu();return integer(client.user)&&integer(client.system);});
  for(const [key,status]of Object.entries(statuses))checks[key]=endpoint===0?status:checks[key]==='PASS'&&status==='PASS'?'PASS':checks[key]==='UNKNOWN'||status==='UNKNOWN'?'UNKNOWN':'FAIL';
  if(!alive())checks.ownedChild='FAIL';
  if(endpoint===0)first={stat,container,client};else last={stat,container,client};
 }
 check('monotonicEndpoints',()=>alive()&&first.stat.start===last.stat.start&&last.stat.user>=first.stat.user&&last.stat.system>=first.stat.system
  &&last.client.user>=first.client.user&&last.client.system>=first.client.system&&Object.keys(first.container).every(k=>last.container[k]>=first.container[k]));
 return {checks,knownDottedExtensionSeen:dotted,legacySyntaxWouldReject:legacy};
}
const within=async(p,ms)=>{let timer;try{return await Promise.race([p.then(()=>true),new Promise(r=>{timer=setTimeout(()=>r(false),ms);})]);}finally{clearTimeout(timer);}};
async function main(){
 const candidateSHA=process.env.EXPECTED_CANDIDATE_SHA;let directory,child,closed,observation=null,removed=false,ownedChildExited=false;
 const began=performance.now();
 try{
  if(!/^[a-f0-9]{40}$/.test(candidateSHA??'')||process.platform!=='linux'||process.arch!=='x64'||process.version!=='v22.23.2')throw Error('FIXED_NATIVE_CONTEXT_REQUIRED');
  directory=await mkdtemp('/tmp/stage6-cpu-sensor-');
  child=spawn('/usr/local/bin/isolated-sqld',['-d',directory+'/empty','--http-listen-addr','127.0.0.1:18080','--no-welcome'],{stdio:'ignore',env:{PATH:process.env.PATH,HOME:'/tmp',LANG:'C.UTF-8'}});
  closed=new Promise(resolve=>child.once('close',resolve));child.on('error',()=>{});
  if(!await within(once(child,'spawn'),2000))throw Error('OWNED_SPAWN_UNKNOWN');
  observation=inspectOwnedSensors({child});
 }catch{}
 finally{
  if(child){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');ownedChildExited=await within(closed,2000);if(!ownedChildExited){child.kill('SIGKILL');ownedChildExited=await within(closed,2000);}}
  if(ownedChildExited&&directory){await rm(directory,{recursive:true,force:true});removed=true;}
 }
 const compatible=observation&&Object.values(observation.checks).every(x=>x==='PASS')&&ownedChildExited&&removed;
 const result={contract:'native-cpu-sensor-compatibility-no-health-work-v1',candidateSHA,status:compatible?'SENSOR_COMPATIBLE_NO_WORK':'SENSOR_UNKNOWN_NO_WORK',observation,ownedChildExited,ownedTemporaryDirectoryRemoved:removed,elapsedMs:performance.now()-began,previousRunRootCauseProven:false,healthWorkloadsExecuted:0,applicationSQLStatementsIssued:0,productionEvidence:false,EOFQualified:false,sixJobCompletionQualified:false,capacityQualified:false};
 console.log('STAGE6_NATIVE_CPU_SENSOR '+JSON.stringify(result));process.exitCode=compatible?0:2;
}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1])main();

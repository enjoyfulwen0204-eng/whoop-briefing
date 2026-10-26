// Fresh representative FILE computation and exact-ID cold-process replay.
// Component only: this is not the Production Hrana path or six-job capacity.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,rm,readFile,lstat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fixtureKeys as keys} from './localDb.js';
import {NATIVE_LIMITS} from './stage6-linux-native-contract.mjs';
import {createOwnedChildCleanup} from './stage6-owned-child-cleanup.mjs';
import {ownedFileScenario,assertPreservedGenerations} from './stage6-owned-file-scenario.mjs';
const scenario=ownedFileScenario(process.env.STAGE6_FILE_SCENARIO??'representative');
const MAX_CALLS=NATIVE_LIMITS.maximumCalls,MAX_LOG=524288;
const sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();assert.match(sha,/^[a-f0-9]{40}$/);
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
async function call(directory,mode,ordinal,deadline){
 const remaining=deadline-performance.now();assert.ok(remaining>25000,'OWNED_CHILD_CLEANUP_RESERVE_REQUIRED');
 const child=spawn(process.execPath,['--expose-gc','--max-old-space-size=128','--max-semi-space-size=4','test/stage6-owned-file-eof-worker.mjs',directory,mode,String(ordinal),scenario.name],
  {detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PHASE4_RELEASE_SHA:sha}});
 const cleanup=createOwnedChildCleanup(child),buffers=[],errors=[];let bytes=0,overflow=false,timedOut=false,spawnError=null,
  physicalClosed=false,groupAbsent=false,groupChecked=false,primaryFailure;
 const collect=target=>chunk=>{bytes+=chunk.length;if(bytes>MAX_LOG){overflow=true;cleanup.stop();return;}target.push(chunk);};
 child.stdout.on('data',collect(buffers));child.stderr.on('data',collect(errors));child.once('error',e=>{spawnError=e.code??e.name;cleanup.stop();});
 let terminal;child.once('close',(code,signal)=>{terminal={code,signal};});
 const cancelled=()=>{timedOut=true;cleanup.stop();};process.on('SIGTERM',cancelled);process.on('SIGINT',cancelled);
 const timer=setTimeout(cancelled,Math.min(70000,remaining-20000));
 try{
  physicalClosed=await cleanup.waitClosed();if(physicalClosed){groupAbsent=await cleanup.waitGroupAbsent();groupChecked=true;}
  if(!physicalClosed||!groupAbsent)throw Object.assign(Error('OWNED_FILE_CHILD_JOIN_UNKNOWN'),{unjoined:true});
  const output=Buffer.concat(buffers),stderr=Buffer.concat(errors),lines=output.toString().split('\n').filter(s=>s.startsWith('OWNED_FILE_EOF_CHILD '));
  let packet;try{assert.equal(lines.length,1);packet=JSON.parse(lines[0].slice('OWNED_FILE_EOF_CHILD '.length));}catch{console.log('OWNED_FILE_INVALID_CHILD '+JSON.stringify({mode,ordinal,terminal,bytes,stdoutSHA256:hash(output),stderrSHA256:hash(stderr),stderrTail:stderr.toString().slice(-2000)}));throw Error('OWNED_FILE_CHILD_PACKET_REQUIRED');}
  console.log('OWNED_FILE_JOINED_CHILD '+JSON.stringify({mode,ordinal,terminal,physicallyClosed:physicalClosed,groupAbsent,bytes,stdoutSHA256:hash(output),stderrSHA256:hash(stderr),cleanup:cleanup.status(),packet}));
  assert.equal(overflow,false);assert.equal(timedOut,false);assert.equal(cleanup.status().killRequested,false);assert.equal(spawnError,null);assert.deepEqual(terminal,{code:0,signal:null});
  assert.equal(packet.contract,'owned-file-eof-physical-child-v1');assert.equal(packet.mode,mode);assert.equal(packet.ordinal,ordinal);assert.equal(packet.sha,sha);assert.equal(packet.scenario,scenario.name);assert.equal(packet.failed,false);assert.equal(packet.closed,true);
  const file=join(directory,'ack-'+ordinal+'.json');assert.equal((await lstat(file)).isSymbolicLink(),false);const raw=await readFile(file);assert.ok(raw.length<65536);
  const ack=JSON.parse(raw),{seal,...body}=ack;assert.equal(seal,keys.lookup(['owned-file-eof-ack-v1',body]));assert.equal(ack.mode,mode);assert.equal(ack.ordinal,ordinal);assert.equal(ack.sha,sha);assert.equal(ack.scenario,scenario.name);assert.equal(ack.closed,true);assert.equal(ack.ready,packet.ready);
  if(mode!=='INIT'){assert.equal(ack.observation.armed,true);assert.equal(ack.observation.firstFailure,null);assert.equal(ack.observation.openTransactions,0);assert.equal(ack.observation.rejected,0);assert.equal(ack.observation.receivers,1);assert.ok(ack.observation.maxDurationMs<5000);assert.ok(ack.observation.committed+ack.observation.rolledBack>0);}
  return ack;
 }catch(error){primaryFailure=error;throw error;}
 finally{
  clearTimeout(timer);
  if(!cleanup.status().closed)cleanup.stop();physicalClosed=await cleanup.waitClosed();
  if(!groupChecked){groupAbsent=await cleanup.waitGroupAbsent();groupChecked=true;}
  cleanup.dispose();process.removeListener('SIGTERM',cancelled);process.removeListener('SIGINT',cancelled);
  if(!physicalClosed||!groupAbsent)throw Object.assign(Error('OWNED_FILE_CHILD_JOIN_UNKNOWN'),{unjoined:true,cause:primaryFailure});
 }
}
test('fresh original FILE '+scenario.name+' reaches full EOF and replays every first identity in a new physical process',{timeout:NATIVE_LIMITS.wallMs},async()=>{
 const directory=await realpath(await mkdtemp(join(tmpdir(),'healthos-owned-file-eof-'))),started=performance.now(),deadline=started+NATIVE_LIMITS.wallMs-50000;let prior,workCalls=0,replay,maxMs=0,transactions=0,unjoined=false;
 try{
  prior=await call(directory,'INIT',0,deadline);
  for(let ordinal=1;ordinal<MAX_CALLS-scenario.users.length;ordinal++){
   assert.ok(performance.now()<deadline);const next=await call(directory,'WORK',ordinal,deadline);workCalls++;
   assert.equal(next.state.sourceDigest,prior.state.sourceDigest);assertPreservedGenerations(prior.state.generations,next.state.generations);
   for(const [table,entries]of Object.entries(prior.state.originals))for(const [id,digest]of Object.entries(entries))assert.equal(next.state.originals[table][id],digest);
   for(const [id,digest]of Object.entries(prior.state.executions))assert.equal(next.state.executions[id],digest);
   maxMs=Math.max(maxMs,next.observation.maxDurationMs);transactions+=next.observation.committed+next.observation.rolledBack;prior=next;if(prior.ready)break;
  }
  assert.equal(prior.ready,true,'FULL_SOURCE_FAMILY_EOF_NOT_REACHED');assert.ok(workCalls+1<=MAX_CALLS);
  assert.ok(workCalls+scenario.users.length+1<=MAX_CALLS);
  for(let index=0;index<scenario.users.length;index++){replay=await call(directory,'REPLAY',workCalls+index+1,deadline);assert.equal(replay.ready,true);assert.deepEqual(replay.state,prior.state);assert.equal(replay.replayedUsers.length,index+1);maxMs=Math.max(maxMs,replay.observation.maxDurationMs);transactions+=replay.observation.committed+replay.observation.rolledBack;prior=replay;}
  console.log('OWNED_FILE_REPRESENTATIVE_EOF '+JSON.stringify({contract:'fresh-original-owned-file-full-eof-cold-replay-v1',sha,scenario:scenario.name,tenants:scenario.users.length,sourceRows:scenario.sources,applicableJobs:scenario.jobs,completedJobs:scenario.jobs,trueEOF:true,
   workCalls,exactOriginalIdentityColdProcessReplay:true,allOriginalFinalizedExecutionsPreserved:true,sourceAndGenerationsPreserved:true,
   observedWorkTransactions:transactions,maxTransactionMs:maxMs,allObservedWorkTransactionsBelow5s:maxMs<5000,physicalProcessesJoined:workCalls+scenario.users.length+1,
   originalPerCallDeadlineMs:45000,originalLeaseMs:60000,elapsedMs:performance.now()-started,typed:replay.typed,
   transport:'ORIGINAL_OWNED_FILE_NATIVE_SQLITE',explicitNativeBeginTransactionsOnly:true,absoluteTransactionInterruption:'UNKNOWN',implicitSQLiteTransactions:'UNKNOWN',powerLossOrMidCommitCrash:false,nativeHranaQualified:false,sixFileJobsQualified:scenario.jobs===6,sixHistoricalProductionShadowJobsQualified:false,capacityQualified:false,productionEvidence:false}));
 }catch(error){unjoined=error.unjoined===true;throw error;}finally{if(!unjoined)await rm(directory,{recursive:true,force:true});}
});

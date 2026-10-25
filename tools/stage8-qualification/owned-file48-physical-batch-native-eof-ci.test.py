"""Pure gates and ownership fault witnesses; no DB, provider, actual children or workload."""
import importlib.util,pathlib,unittest,json,re,subprocess,os
from unittest.mock import patch
p=pathlib.Path(__file__).with_name('owned-file48-physical-batch-native-eof-ci.py');s=importlib.util.spec_from_file_location('batch_control',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ROOT=pathlib.Path(__file__).resolve().parents[2]
class Gate(unittest.TestCase):
 def setUp(self):self.env={'GITHUB_REPOSITORY':m.h.REPOSITORY,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':m.REF,'QUALIFICATION_MODE':m.MODE,'POSITIVE_HYBRID_EOF_INTENT':m.INTENT,'QUALIFICATION_REPOSITORY_PRIVATE':'false','CANDIDATE_SHA':'c'*40,'GITHUB_SHA':'c'*40,'QUALIFICATION_WORKFLOW_SHA':'c'*40,'GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':'123','RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_JOB':'native-file48-single-call-eof'}
 def test_closed_execution_identity(self):
  self.assertEqual(m.validate(self.env,'Linux','x86_64',1001,1001),'c'*40)
  for key in self.env:
   e=self.env.copy();del e[key]
   with self.subTest(key=key),self.assertRaises(AssertionError):m.validate(e,'Linux','x86_64',1001,1001)
  for k,v in [('GITHUB_REF','refs/heads/diagnostic/stage6-file48-prepared-eof-20261026'),('POSITIVE_HYBRID_EOF_INTENT','one-original-owned-file48-prepared-native-eof-and-replay-v1'),('GITHUB_JOB','native-owned-file48-prepared-eof'),('GITHUB_RUN_ATTEMPT','2'),('GITHUB_SHA','d'*40),('QUALIFICATION_REPOSITORY_PRIVATE','true')]:
   with self.subTest(key=k),self.assertRaises(AssertionError):m.validate({**self.env,k:v},'Linux','x86_64',1001,1001)
  for args in [('Darwin','arm64',501,20),('Linux','aarch64',1001,1001),('Linux','x86_64',0,1001),('Linux','x86_64',1001,0)]:
   with self.subTest(args=args),self.assertRaises(AssertionError):m.validate(self.env,*args)
 def test_exact_six_file_source_gate(self):
  allowed=['M\t'+p for p in [m.WORKER,m.BATCH_CONTROL,m.WRAPPER,m.CONTROL,m.UNIT,m.WORKFLOW]]
  def execute(changes=allowed,parent=m.BASE,dirty='',head='c'*40,app=''):
   def fake(args,*rest):
    cmd=args[3:]
    if cmd==['rev-parse','HEAD']:return head
    if cmd==['rev-parse','HEAD^']:return parent
    if cmd[0]=='status':return dirty
    if cmd[:3]==['diff','--name-status','--no-renames']:return '\n'.join(changes)
    if cmd[0]=='diff':return app
    raise AssertionError('unexpected_git_command')
   with patch.object(m.h,'run',fake):m.source_gate(ROOT,'c'*40)
  execute()
  for options in [dict(changes=allowed+['M\tsrc/db.js']),dict(changes=allowed[:-1]),dict(parent='b'*40),dict(dirty='?? extra'),dict(head='d'*40),dict(app='changed')]:
   with self.subTest(options=options),self.assertRaises(AssertionError):execute(**options)
 def test_workflow_append_and_unchanged_outer_limits(self):
  # Candidate retains all old workflow text and appends exactly its strict job.
  candidate=(ROOT/m.WORKFLOW).read_text();marker='\n  native-file48-single-call-eof:\n';self.assertEqual(candidate.count(marker),1);added=candidate[candidate.index(marker):]
  self.assertIn(m.REF,added);self.assertIn(m.INTENT,added);self.assertIn('github.run_attempt == 1',added)
  control=(ROOT/m.CONTROL).read_text();wrapper=(ROOT/m.WRAPPER).read_text();batch=(ROOT/m.BATCH_CONTROL).read_text()
  for value in ["'--memory','512m'","'--memory-swap','512m'","'--cpus','0.5'","'--network','none'","'330s'","timeout=350"]:self.assertIn(value,control)
  self.assertIn("child.kill('SIGTERM'),300000",wrapper);self.assertIn('started<300000',wrapper);self.assertEqual(batch.count('deadline=started+120000'),1);self.assertNotIn('deadline=performance.now()+120000',batch)
  self.assertIn("await issue('INIT',0)",batch);self.assertIn("await issue('VERIFY',ordinal)",batch);self.assertIn('if(!result.ok)',batch)
 def test_original_math_and_full_eof_tail_preserved(self):
  original=(ROOT/'test/stage6-owned-file-prepared-native-eof.mjs').read_text();worker=(ROOT/m.WORKER).read_text();candidate=(ROOT/m.TEST).read_text()
  helper=lambda v:v[v.index('function preparationBudgetFor'):v.index('\nfunction failureClassification')] if '\nfunction failureClassification' in v else v[v.index('function preparationBudgetFor'):v.index('\nasync function preserveOriginal')]
  self.assertEqual(helper(worker),helper(original));self.assertIn('preparationBudget=preparationBudgetFor(pending,sourceCatalog)',worker)
  self.assertEqual(worker.count('await db.migrate({targetVersion:35})'),1);self.assertIn("if(mode==='INIT')await core.initializeTenant",worker);self.assertIn("if(mode==='INIT')await worker.rolloutAlgorithm",worker)
  self.assertIn('if(boundaryReady(pending)){ready=true;break;}',worker);self.assertIn('assert.ok(ordinal+j<64',worker)
  start=" stage='VERIFY_GENUINE_FILE_PREPARATION'";old=original[original.index(start):];new=candidate[candidate.index(start):]
  new=new.replace("one-owned-file-batched-native-hrana-positive-eof-component-v1","one-owned-file-prepared-native-hrana-positive-eof-component-v1")
  metadata="preparationLifecycle:'PHYSICAL_JOINED_BATCHES',physicalPreparationBatches:physicalPreparation.batches,physicalPreparationChildrenJoined:physicalPreparation.physicalChildrenJoined,allPhysicalBatchAcksAndResourceSamplesVerified:true,physicalPreparationEvidence:physicalPreparation.evidence,"
  self.assertEqual(new.count(metadata),1);new=new.replace(metadata,'');self.assertEqual(new,old)
 def test_supervisor_parser_closed_case_and_identity(self):
  packet={'contract':'one-physical-batch-file48-prepared-native-eof-supervisor-v1','candidateSha':'c'*40,'status':'FAILED_OR_UNKNOWN_NO_QUALIFICATION'};prefix='STAGE6_PHYSICAL_BATCH_FILE48_NATIVE_EOF_SUPERVISOR ';raw=prefix+json.dumps(packet)
  self.assertEqual(m.parse_original_supervisor(raw,'c'*40),packet)
  for bad in [raw+'\n'+raw,prefix+json.dumps({**packet,'candidateSha':'d'*40}),prefix+json.dumps({**packet,'contract':'old'}),prefix+'notJSON']:
   with self.assertRaises((AssertionError,ValueError)):m.parse_original_supervisor(bad,'c'*40)
class PureNode(unittest.TestCase):
 def node(self,body):
  # Existing node22 on PATH in CI. Inherited env stripped of credentials/options.
  r=subprocess.run(['node','--input-type=module','-e',body],cwd=ROOT,capture_output=True,text=True,timeout=20,env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'HOME':'/tmp','LANG':'C.UTF-8','NODE_ENV':'test'})
  self.assertEqual(r.returncode,0,r.stderr[-6000:]);return r.stdout
 def prefix(self):
  source=(ROOT/m.BATCH_CONTROL).read_text();pure=source[source.index('const HEX='):source.index('async function until')].replace('export ','')
  return "import assert from 'node:assert/strict';import {createHash,createHmac} from 'node:crypto';import {readFileSync} from 'node:fs';\n"+pure+"\nconst sha='c'.repeat(40),H='a'.repeat(64),keys={lookup:v=>createHmac('sha256',Buffer.alloc(32,71)).update(JSON.stringify(v)).digest('hex')};const fp={durableDigest:H,sourceDigest:H,generationDigest:H,executionCount:1,receiptCount:15,jobsCount:2,sourceRows:160};\nconst packet={contract:'native-physical-owned-file-batch-child-v1',mode:'BATCH',ordinal:0,pid:123,parentPID:122,closed:true,failed:false,failureType:null,completedCalls:1,sourceAcknowledgments:12,unitsCommitted:0,ready:true,descriptorSHA256:H,after:fp,catalogDigest:H,elapsedMs:1,memory:{rss:1,heapUsed:1,heapTotal:1,external:1},productionEvidence:false,LinuxQualification:false,EOFQualified:false,capacityQualified:false};\n"
 def test_typed_rows_packet_and_authenticated_ack(self):
  self.node(self.prefix()+r'''
assert.equal(canonicalOwnedRow({a:1,b:'x'}),canonicalOwnedRow({b:'x',a:1}));
assert.notEqual(canonicalOwnedRow({a:1}),canonicalOwnedRow({a:'1'}));assert.notEqual(canonicalOwnedRow({a:null}),canonicalOwnedRow({a:'null'}));
assert.equal(canonicalOwnedRow({a:new Uint8Array([2,3])}),canonicalOwnedRow({a:new Uint8Array([1,2,3,4]).subarray(1,3)}));
for(const a of [NaN,Infinity,{},undefined])assert.throws(()=>canonicalOwnedRow({a}));
const identity={mode:'BATCH',ordinal:0,pid:123,parentPID:122};assert.equal(validateBatchPacket(packet,identity),true);
for(const p of [{...packet,pid:124},{...packet,completedCalls:2},{...packet,sourceAcknowledgments:13},{...packet,after:{...fp,privateHealth:'forbidden'}},{...packet,memory:{...packet.memory,journal:'forbidden'}},{...packet,capacityQualified:true}])assert.throws(()=>validateBatchPacket(p,identity));
const failed={...packet,failed:true,failureType:'Error',descriptorSHA256:null};assert.equal(validateBatchPacket(failed,identity),true);
assert.throws(()=>validateBatchPacket({...failed,after:{...fp,privateHealth:'forbidden'}},identity));
const body={contract:'native-owned-file-batch-durable-ack-v1',selected:'batch-0',mode:'BATCH',ordinal:0,nextOrdinal:1,snapshot:fp,catalogDigest:H,closed:true,ready:true};const ack={...body,seal:keys.lookup(['native-owned-file-batch-ack-v1',body])};assert.deepEqual(validateBatchAck(ack,packet,keys),body);
for(const a of [{...ack,seal:'0'.repeat(64)},{...ack,nextOrdinal:2},{...ack,privateHealth:'forbidden'}])assert.throws(()=>validateBatchAck(a,packet,keys));
''')
 def test_real_ownership_fault_paths_and_negative_packet_preservation(self):
  source=(ROOT/m.BATCH_CONTROL).read_text();start=source.index('async function until');end=source.index('export async function runOwnedPreparationBatches');ownership=source[start:end]
  # The original infinite fail-closed hold is only replaced in this fake witness
  # to make the unknown-join assertion finite; real source cannot advance.
  self.assertEqual(ownership.count('await new Promise(()=>{});'),1);ownership=ownership.replace('await new Promise(()=>{});',"throw Error('TEST_ONLY_UNKNOWN_JOIN_HOLD');")
  body=self.prefix()+"import {EventEmitter} from 'node:events';import {join} from 'node:path';import {resourcePacket,validateChildResourceShape,validateChildResourceSample,FILE48_ARGV,FILE48_TOKEN} from './test/stage6-native-file48-eof-resource.mjs';\nconst implementation="+json.dumps(ownership)+";\n"+r'''
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
async function scenario(kind){
 let clock=0,children=0,raw=null,signals=[],timers=[],child;const fakeProcess={pid:122,execPath:'/fake/node',env:{PATH:'/fake'},kill(pid,signal){assert.equal(pid,-123);signals.push(signal);if(kind!=='unknown'&&(signal==='SIGKILL'||kind!=='kill'))queueMicrotask(()=>child.emit('close',null,signal));}};
 const spawn=()=>{children++;child=new EventEmitter();child.pid=123;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  if(kind==='setup')child.stdout=null;
  else queueMicrotask(()=>{
   if(['stdout','kill','unknown'].includes(kind)){child.stdout.emit('error',Error('private data must never project'));return;}
   if(kind==='deadline')return;
   const fail=kind==='failed',p={...packet,failed:fail,failureType:fail?'Error':null,descriptorSHA256:fail?null:H};
   const descriptor={contract:'native-owned-file-batch-durable-ack-v1',selected:'batch-0',mode:'BATCH',ordinal:0,nextOrdinal:1,snapshot:fp,catalogDigest:H,closed:true,ready:true};raw=Buffer.from(JSON.stringify({...descriptor,seal:keys.lookup(['native-owned-file-batch-ack-v1',descriptor])}));if(!fail)p.descriptorSHA256=createHash('sha256').update(raw).digest('hex');
   const resource=resourcePacket({candidateSha:sha,pid:123,parentPid:122,node:'v22.23.2',platform:'linux',architecture:'x64',argv:[...FILE48_ARGV],startupHeapLimitBytes:62914560,exitSampleHeapLimitBytes:62914560,maxRSSKiB:150000,exitCode:fail?2:0});
   child.stdout.emit('data',Buffer.from('STAGE6_NATIVE_PHYSICAL_BATCH_PACKET '+JSON.stringify(kind==='malformed'?{...p,health:'forbidden'}:p)+'\nSTAGE6_FILE48_EOF_CHILD_RESOURCE '+JSON.stringify(resource)+'\n'));child.emit('close',fail?2:0,null);
  });return child;
 };
 const fakeTimer=(cb,ms)=>{timers.push(ms);return setTimeout(()=>{clock+=ms;cb();},0);};
 const factory=new AsyncFunction('assert','spawn','process','performance','setTimeout','clearTimeout','createHash','FILE48_ARGV','FILE48_TOKEN','ROOT','lstat','readFile','join','validateBatchPacket','validateBatchAck','validateChildResourceShape','validateChildResourceSample','console',implementation+'\nreturn runOne;');
 const run=await factory(assert,spawn,fakeProcess,{now:()=>clock},fakeTimer,clearTimeout,createHash,FILE48_ARGV,FILE48_TOKEN,'/fake/repo',async()=>({isSymbolicLink:()=>false}),async()=>raw,join,validateBatchPacket,validateBatchAck,validateChildResourceShape,validateChildResourceSample,{log:()=>{}});
 let result,error;try{result=await run({directory:'/fake/root',mode:'BATCH',ordinal:0,previous:'init',deadline:1000,candidateSha:sha,keys});}catch(e){error=e.message;}
 assert.equal(children,1);return {result,error,signals,timers};
}
let r=await scenario('success');assert.equal(r.result.ok,true);assert.equal(r.result.ack.nextOrdinal,1);assert.deepEqual(r.signals,[]);
r=await scenario('failed');assert.equal(r.result.ok,false);assert.equal(r.result.evidence.packet.failed,true);assert.equal(r.result.evidence.resource.exitCode,2);assert.equal(r.result.ack,null);
r=await scenario('malformed');assert.equal(r.result.ok,false);assert.equal(r.result.evidence.packet,null);assert.equal(r.result.evidence.resource.exitCode,0);
for(const type of ['setup','stdout']){r=await scenario(type);assert.equal(r.result.ok,false);assert.deepEqual(r.signals,['SIGTERM']);assert.equal(r.result.evidence.physicalChildJoined,true);assert.equal(r.result.evidence.pid,123);}
r=await scenario('kill');assert.equal(r.result.ok,false);assert.deepEqual(r.signals,['SIGTERM','SIGKILL']);assert.equal(r.result.evidence.physicalChildJoined,true);
r=await scenario('deadline');assert.equal(r.result.ok,false);assert.equal(r.result.evidence.error,'BATCH_AGGREGATE_DEADLINE');assert.deepEqual(r.signals,['SIGTERM']);
r=await scenario('unknown');assert.equal(r.error,'TEST_ONLY_UNKNOWN_JOIN_HOLD');assert.equal(r.result,undefined);assert.deepEqual(r.signals,['SIGTERM','SIGKILL']);
console.log('EIGHT_PURE_OWNERSHIP_CASES_NO_ACTUAL_CHILDREN');
'''
  self.assertIn('EIGHT_PURE_OWNERSHIP_CASES',self.node(body))
 def test_real_supervisor_physical_evidence_and_resource_schema(self):
  body=self.prefix()+"import {resourcePacket,FILE48_ARGV} from './test/stage6-native-file48-eof-resource.mjs';import {validatePhysicalPreparationEvidence} from './tools/stage8-qualification/owned-file48-physical-batch-native-eof-supervisor.mjs';\n"+r'''
function evidence(mode,ordinal,pid,calls,ready,receipts){const p={...packet,mode,ordinal,pid,completedCalls:calls,ready,sourceAcknowledgments:mode==='BATCH'?12:0,after:{...fp,executionCount:ordinal+calls,receiptCount:receipts}};return {mode,ordinal,pid,parentPID:122,terminal:{code:0,signal:null},physicalChildJoined:true,TERMRequested:false,KILLRequested:false,error:null,totalLogBytes:1000,stdoutSHA256:H,stderrSHA256:H,packet:p,resource:resourcePacket({candidateSha:sha,pid,parentPid:122,node:'v22.23.2',platform:'linux',architecture:'x64',argv:[...FILE48_ARGV],startupHeapLimitBytes:62914560,exitSampleHeapLimitBytes:62914560,maxRSSKiB:150000,exitCode:0})};}
const report={preparationLifecycle:'PHYSICAL_JOINED_BATCHES',allPhysicalBatchAcksAndResourceSamplesVerified:true,physicalPreparationBatches:1,physicalPreparationChildrenJoined:3,setupProducerCalls:1,physicalPreparationEvidence:[evidence('INIT',0,123,0,false,0),evidence('BATCH',0,124,1,true,15),evidence('VERIFY',1,125,0,true,15)]};assert.equal(validatePhysicalPreparationEvidence(report,sha,122),true);
for(const mutation of [r=>r.physicalPreparationEvidence[1].pid=123,r=>r.physicalPreparationEvidence[1].TERMRequested=true,r=>r.physicalPreparationEvidence[1].packet.after.sourceDigest='b'.repeat(64),r=>r.physicalPreparationEvidence[2].packet.after.receiptCount=30,r=>r.physicalPreparationEvidence[1].packet.ready=false,r=>r.physicalPreparationEvidence[1].resource.fullLifetimeRSSBoundVerified=true,r=>r.physicalPreparationEvidence[1].packet.memory.health='forbidden']){const changed=structuredClone(report);mutation(changed);assert.throws(()=>validatePhysicalPreparationEvidence(changed,sha,122));}
const rows=[evidence('INIT',0,200,0,false,0)];for(let i=0;i<64;i++)rows.push(evidence('BATCH',i,201+i,1,i===63,15*(i+1)));rows.push(evidence('VERIFY',64,265,0,true,960));const maximum={preparationLifecycle:'PHYSICAL_JOINED_BATCHES',allPhysicalBatchAcksAndResourceSamplesVerified:true,physicalPreparationBatches:64,physicalPreparationChildrenJoined:66,setupProducerCalls:64,physicalPreparationEvidence:rows};assert.equal(validatePhysicalPreparationEvidence(maximum,sha,122),true);assert.ok(JSON.stringify(maximum).length<262144);assert.throws(()=>validatePhysicalPreparationEvidence({...maximum,physicalPreparationBatches:65},sha,122));
'''
  self.node(body)

 def test_failure_projection_preserves_only_closed_metadata(self):
  self.node(self.prefix()+"import {resourcePacket,FILE48_ARGV} from './test/stage6-native-file48-eof-resource.mjs';import {projectBatchFailure} from './tools/stage8-qualification/owned-file48-physical-batch-native-eof-supervisor.mjs';\n"+r''' 
const failed={...packet,failed:true,failureType:'Error',descriptorSHA256:null};
const resource=resourcePacket({candidateSha:sha,pid:123,parentPid:122,node:'v22.23.2',platform:'linux',architecture:'x64',argv:[...FILE48_ARGV],startupHeapLimitBytes:62914560,exitSampleHeapLimitBytes:62914560,maxRSSKiB:150000,exitCode:2});
const evidence={mode:'BATCH',ordinal:0,pid:123,parentPID:122,terminal:{code:2,signal:null},physicalChildJoined:true,TERMRequested:false,KILLRequested:false,error:'BATCH_ACK_RESOURCE_OR_JOIN_INVALID',totalLogBytes:2000,stdoutSHA256:H,stderrSHA256:H,packet:failed,resource};
const frame=x=>'STAGE6_NATIVE_BATCH_FAILURE '+JSON.stringify(x);let p=projectBatchFailure(frame(evidence),sha,122);assert.equal(p.status,'FAILED_BATCH_METADATA_PRESERVED_NO_QUALIFICATION');assert.deepEqual(p.evidence,evidence);assert.equal(p.evidence.resource.exitCode,2);assert.equal(p.productionEvidence,false);
for(const mutate of [e=>e.parentPID=121,e=>e.packet.after.privateHealth='forbidden',e=>e.packet.memory.journal='forbidden',e=>e.resource.raw='forbidden',e=>e.error='private error data',e=>e.terminal.signal='private health data',e=>e.packet.productionEvidence=true]){const e=structuredClone(evidence);mutate(e);p=projectBatchFailure(frame(e),sha,122);assert.equal(p.status,'INVALID_BATCH_FAILURE_MARKER_NO_PROJECTION');assert.equal(p.evidence,null);assert.equal(JSON.stringify(p).includes('forbidden'),false);}
const unknown={mode:'BATCH',ordinal:2,pid:123,physicalChildJoined:false,productionEvidence:false};const u='STAGE6_NATIVE_BATCH_JOIN_UNKNOWN '+JSON.stringify(unknown);p=projectBatchFailure(u,sha,122);assert.equal(p.status,'PHYSICAL_JOIN_UNKNOWN_NO_ADVANCE');assert.deepEqual(p.joinUnknown,unknown);
assert.equal(projectBatchFailure(u+'\n'+frame(evidence),sha,122).status,'INVALID_BATCH_FAILURE_MARKER_NO_PROJECTION');assert.equal(projectBatchFailure('',sha,122).status,'NO_BATCH_FAILURE_MARKER');
''')
 def test_real_aggregate_runner_does_not_advance_after_failed_child(self):
  source=(ROOT/m.BATCH_CONTROL).read_text();body=source[source.index('export async function runOwnedPreparationBatches'):].replace('export ','')
  self.node(self.prefix()+"const implementation="+json.dumps(body)+";\n"+r''' 
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;const root='/tmp/healthos-local-owned-file-batch-test',issued=[];
const runOne=async arg=>{issued.push(arg);if(arg.mode==='INIT')return {ok:true,evidence:{mode:'INIT'},ack:{selected:'init',snapshot:{...fp,executionCount:0,receiptCount:0},ready:false,catalogDigest:H}};return {ok:false,evidence:{mode:'BATCH'},ack:null};};
const factory=new AsyncFunction('assert','process','performance','execFileSync','ROOT','realpath','tmpdir','dirname','basename','lstat','runOne','console',bodySafe(implementation)+'\nreturn runOwnedPreparationBatches;');
function bodySafe(v){return v;}
const runner=await factory(assert,{platform:'linux',arch:'x64',version:'v22.23.2'},{now:()=>10},()=>sha,'/fake',async v=>v,()=>'/tmp',()=>'/tmp',()=>root.slice(5),async()=>({isSymbolicLink:()=>false}),runOne,{log:()=>{}});
await assert.rejects(()=>runner({directory:root,keys,started:0,candidateSha:sha}),/OWNED_PREPARATION_BATCH_FAILED/);assert.equal(issued.length,2);assert.deepEqual(issued.map(x=>[x.mode,x.ordinal,x.previous,x.deadline]),[['INIT',0,'NONE',120000],['BATCH',0,'init',120000]]);
''')

if __name__=='__main__':unittest.main()

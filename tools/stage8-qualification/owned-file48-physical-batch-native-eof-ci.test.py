"""Pure gates and ownership fault witnesses; no DB, provider, actual children or workload."""
import importlib.util,pathlib,unittest,json,re,subprocess,os
from unittest.mock import patch
p=pathlib.Path(__file__).with_name('owned-file48-physical-batch-native-eof-ci.py');s=importlib.util.spec_from_file_location('batch_control',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ROOT=pathlib.Path(__file__).resolve().parents[2]
class Gate(unittest.TestCase):
 def setUp(self):self.env={'GITHUB_REPOSITORY':m.h.REPOSITORY,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':m.REF,'QUALIFICATION_MODE':m.MODE,'POSITIVE_HYBRID_EOF_INTENT':m.INTENT,'QUALIFICATION_REPOSITORY_PRIVATE':'false','CANDIDATE_SHA':'c'*40,'GITHUB_SHA':'c'*40,'QUALIFICATION_WORKFLOW_SHA':'c'*40,'GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':'123','RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_JOB':'native-file48-eof-failure-profile'}
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
  allowed=['M\t'+p for p in [m.TEST,m.WRAPPER,m.CONTROL,m.UNIT,m.WORKFLOW]]+['A\t'+m.FAILURE_PROFILE]
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
  candidate=(ROOT/m.WORKFLOW).read_text();marker='\n  native-file48-eof-failure-profile:\n';self.assertEqual(candidate.count(marker),1);added=candidate[candidate.index(marker):]
  self.assertIn(m.REF,added);self.assertIn(m.INTENT,added);self.assertIn('github.run_attempt == 1',added)
  control=(ROOT/m.CONTROL).read_text();wrapper=(ROOT/m.WRAPPER).read_text();batch=(ROOT/m.BATCH_CONTROL).read_text()
  for value in ["'--memory','512m'","'--memory-swap','512m'","'--cpus','0.5'","'--network','none'","'330s'","timeout=350"]:self.assertIn(value,control)
  self.assertIn("child.kill('SIGTERM'),300000",wrapper);self.assertIn('started<300000',wrapper);self.assertEqual(batch.count('deadline=started+120000'),1);self.assertNotIn('deadline=performance.now()+120000',batch)
  self.assertIn("await issue('INIT',0)",batch);self.assertNotIn("await issue('VERIFY',ordinal)",batch);self.assertIn('evidence.length,batches+1',batch);self.assertIn('if(!result.ok)',batch)
 def test_original_math_and_full_eof_tail_preserved(self):
  original=(ROOT/'test/stage6-owned-file-prepared-native-eof.mjs').read_text();worker=(ROOT/m.WORKER).read_text();candidate=(ROOT/m.TEST).read_text()
  helper=lambda v:v[v.index('function preparationBudgetFor'):v.index('\nfunction failureClassification')] if '\nfunction failureClassification' in v else v[v.index('function preparationBudgetFor'):v.index('\nasync function preserveOriginal')]
  self.assertIn('remainingACKs+=catalog.length-index-1',helper(worker));self.assertIn('maxJobs:1,maxItems:1,maxItemsPerTenant:1',helper(worker));self.assertIn('preparationBudget=preparationBudgetFor(pending,sourceCatalog)',worker)
  self.assertEqual(worker.count('await db.migrate({targetVersion:35})'),1);self.assertIn("if(mode==='INIT')await core.initializeTenant",worker);self.assertIn("if(mode==='INIT')await worker.rolloutAlgorithm",worker)
  self.assertIn('if(boundaryReady(pending)){ready=true;break;}',worker);self.assertIn('assert.ok(ordinal+j<64',worker)
  start=" stage='VERIFY_GENUINE_FILE_PREPARATION'";old=original[original.index(start):];new=candidate[candidate.index(start):]
  new=new.replace("one-owned-file-batched-parent-verified-native-hrana-positive-eof-component-v1","one-owned-file-prepared-native-hrana-positive-eof-component-v1")
  begin=new.index(' // Fresh parent connection opens');end=new.index(" stage='ONE_SQLD_LEGACY_STARTUP';",begin);new=new[:begin]+new[end:]
  metadata="preparationLifecycle:'PHYSICAL_JOINED_BATCHES_FRESH_PARENT_VERIFIED',parentFileVerification,physicalPreparationBatches:physicalPreparation.batches,physicalPreparationChildrenJoined:physicalPreparation.physicalChildrenJoined,allPhysicalBatchAcksAndResourceSamplesVerified:true,physicalPreparationEvidence:physicalPreparation.evidence,"
  self.assertEqual(new.count(metadata),1);new=new.replace(metadata,'');new=new.replace("let eofDiagnostic=null;try{if(b)eofDiagnostic=collectEOFFailureDiagnostic(b.snapshot());}catch{}",'').replace('progress:{...progress},eofDiagnostic,elapsedMs:','progress:{...progress},elapsedMs:');self.assertEqual(new,old)
 def test_supervisor_parser_closed_case_and_identity(self):
  packet={'contract':'one-physical-batch-file48-parent-verified-native-eof-supervisor-v1','candidateSha':'c'*40,'status':'FAILED_OR_UNKNOWN_NO_QUALIFICATION'};prefix='STAGE6_PHYSICAL_BATCH_FILE48_NATIVE_EOF_SUPERVISOR ';raw=prefix+json.dumps(packet)
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
  return "import assert from 'node:assert/strict';import {createHash,createHmac} from 'node:crypto';import {readFileSync} from 'node:fs';\n"+pure+"\nconst sha='c'.repeat(40),H='a'.repeat(64),keys={lookup:v=>createHmac('sha256',Buffer.alloc(32,71)).update(JSON.stringify(v)).digest('hex')};const fp={durableDigest:H,sourceDigest:H,generationDigest:H,executionCount:1,receiptCount:15,jobsCount:2,sourceRows:160};\nconst packet={contract:'native-physical-owned-file-batch-child-v1',mode:'BATCH',ordinal:0,pid:123,parentPID:122,closed:true,failed:false,failureType:null,completedCalls:1,callsWithUnitsOrCompletedJobs:0,sourceAcknowledgments:12,unitsCommitted:0,ready:true,descriptorSHA256:H,after:fp,catalogDigest:H,elapsedMs:1,memory:{rss:1,heapUsed:1,heapTotal:1,external:1},productionEvidence:false,LinuxQualification:false,EOFQualified:false,capacityQualified:false};\n"
 def test_typed_rows_packet_and_authenticated_ack(self):
  self.node(self.prefix()+r'''
assert.equal(canonicalOwnedRow({a:1,b:'x'}),canonicalOwnedRow({b:'x',a:1}));
assert.notEqual(canonicalOwnedRow({a:1}),canonicalOwnedRow({a:'1'}));assert.notEqual(canonicalOwnedRow({a:null}),canonicalOwnedRow({a:'null'}));
assert.equal(canonicalOwnedRow({a:new Uint8Array([2,3])}),canonicalOwnedRow({a:new Uint8Array([1,2,3,4]).subarray(1,3)}));
for(const a of [NaN,Infinity,{},undefined])assert.throws(()=>canonicalOwnedRow({a}));
const identity={mode:'BATCH',ordinal:0,pid:123,parentPID:122};assert.equal(validateBatchPacket(packet,identity),true);
for(const p of [{...packet,pid:124},{...packet,callsWithUnitsOrCompletedJobs:2},{...packet,sourceAcknowledgments:49},{...packet,after:{...fp,privateHealth:'forbidden'}},{...packet,memory:{...packet.memory,journal:'forbidden'}},{...packet,capacityQualified:true}])assert.throws(()=>validateBatchPacket(p,identity));
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


 def parent_prefix(self):
  return self.prefix()+"import {resourcePacket,FILE48_ARGV} from './test/stage6-native-file48-eof-resource.mjs';import {validatePhysicalPreparationEvidence,validateFreshParentFileVerification} from './tools/stage8-qualification/owned-file48-physical-batch-native-eof-supervisor.mjs';\n"+r"""
function evidence(mode,ordinal,pid,calls,ready,receipts){const p={...packet,mode,ordinal,pid,completedCalls:calls,ready,sourceAcknowledgments:mode==='BATCH'?12:0,after:{...fp,executionCount:ordinal+calls,receiptCount:receipts}};return {mode,ordinal,pid,parentPID:122,terminal:{code:0,signal:null},physicalChildJoined:true,TERMRequested:false,KILLRequested:false,error:null,totalLogBytes:1000,stdoutSHA256:H,stderrSHA256:H,packet:p,resource:resourcePacket({candidateSha:sha,pid,parentPid:122,node:'v22.23.2',platform:'linux',architecture:'x64',argv:[...FILE48_ARGV],startupHeapLimitBytes:62914560,exitSampleHeapLimitBytes:62914560,maxRSSKiB:150000,exitCode:0})};}
function proof(e){return {contract:'fresh-parent-owned-file-verification-v1',candidateSha:sha,parentPID:122,finalWorkerPID:e.pid,finalWorkerOrdinal:e.ordinal,lastWorkerDescriptorSHA256:e.packet.descriptorSHA256,snapshot:structuredClone(e.packet.after),schemaVersion:35,freshAdmissionVerified:true,quickCheckPassed:true,authenticatedLastChildFingerprintMatches:true,allTypedApplicationRowsAndSchemaCaptured:true,fileClientClosed:true,WALAndSHMVerified:true,applicationTables:12,elapsedMs:1000};}
function report(rows){return {preparationLifecycle:'PHYSICAL_JOINED_BATCHES_FRESH_PARENT_VERIFIED',parentFileVerification:proof(rows.at(-1)),originalApplicationTablesPreserved:12,allPhysicalBatchAcksAndResourceSamplesVerified:true,physicalPreparationBatches:rows.length-1,physicalPreparationChildrenJoined:rows.length,setupProducerCalls:rows.at(-1).packet.after.executionCount,physicalPreparationEvidence:rows};}
"""
 def test_real_supervisor_physical_evidence_and_resource_schema(self):
  self.node(self.parent_prefix()+r"""
const r=report([evidence('INIT',0,123,0,false,0),evidence('BATCH',0,124,1,true,15)]);assert.equal(validatePhysicalPreparationEvidence(r,sha,122),true);
for(const mutation of [r=>r.physicalPreparationEvidence[1].pid=123,r=>r.physicalPreparationEvidence[1].TERMRequested=true,r=>r.physicalPreparationEvidence[1].packet.after.sourceDigest='b'.repeat(64),r=>r.parentFileVerification.snapshot.receiptCount=30,r=>r.physicalPreparationEvidence[1].packet.ready=false,r=>r.physicalPreparationEvidence[1].resource.fullLifetimeRSSBoundVerified=true,r=>r.physicalPreparationEvidence[1].packet.memory.health='forbidden',r=>r.physicalPreparationChildrenJoined=3]){const changed=structuredClone(r);mutation(changed);assert.throws(()=>validatePhysicalPreparationEvidence(changed,sha,122));}
const rows=[evidence('INIT',0,200,0,false,0)];for(let i=0;i<64;i++)rows.push(evidence('BATCH',i,201+i,1,i===63,15*(i+1)));const maximum=report(rows);assert.equal(validatePhysicalPreparationEvidence(maximum,sha,122),true);assert.ok(JSON.stringify(maximum).length<262144);assert.throws(()=>validatePhysicalPreparationEvidence({...maximum,physicalPreparationBatches:65},sha,122));
const oldExtra=structuredClone(r);oldExtra.physicalPreparationEvidence.push(evidence('VERIFY',1,125,0,true,15));oldExtra.physicalPreparationChildrenJoined++;assert.throws(()=>validatePhysicalPreparationEvidence(oldExtra,sha,122));
""")
 def test_fresh_parent_verification_closed_identity_and_failure_guards(self):
  self.node(self.parent_prefix()+r"""
const e=evidence('BATCH',0,124,1,true,15),p=proof(e),args={candidateSha:sha,parentPID:122,lastEvidence:e,applicationTables:12};assert.equal(validateFreshParentFileVerification(p,args),true);
for(const mutate of [v=>v.candidateSha='d'.repeat(40),v=>v.parentPID=123,v=>v.finalWorkerPID=125,v=>v.finalWorkerOrdinal=1,v=>v.lastWorkerDescriptorSHA256='b'.repeat(64),v=>v.schemaVersion=33,v=>v.snapshot.generationDigest='b'.repeat(64),v=>v.snapshot.privateHealth='forbidden',v=>v.freshAdmissionVerified=false,v=>v.quickCheckPassed=false,v=>v.authenticatedLastChildFingerprintMatches=false,v=>v.allTypedApplicationRowsAndSchemaCaptured=false,v=>v.fileClientClosed=false,v=>v.WALAndSHMVerified=false,v=>v.elapsedMs=120000,v=>v.elapsedMs=NaN,v=>v.applicationTables=13,v=>v.privateHealth='forbidden']){const v=structuredClone(p);mutate(v);assert.throws(()=>validateFreshParentFileVerification(v,args));}
assert.throws(()=>validateFreshParentFileVerification(p,{...args,lastEvidence:{...e,pid:122}}));assert.throws(()=>validateFreshParentFileVerification(p,{...args,lastEvidence:{...e,physicalChildJoined:false}}));assert.throws(()=>validateFreshParentFileVerification(p,{...args,lastEvidence:{...e,terminal:{code:0,signal:'SIGTERM'}}}));
""")
 def test_actual_parent_file_guard_never_enters_sqld_after_failed_readback(self):
  source=(ROOT/m.TEST).read_text();start=source.index(' let setupCalls=physicalPreparation.workCalls');end=source.index(" stage='ONE_SQLD_LEGACY_STARTUP';",start)+len(" stage='ONE_SQLD_LEGACY_STARTUP';");segment=source[start:end]
  self.node(self.parent_prefix()+"import {join} from 'node:path';import {pathToFileURL} from 'node:url';const segment="+json.dumps(segment)+";\n"+r"""
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const prep={workCalls:1,ready:true,snapshot:structuredClone(fp),evidence:[evidence('INIT',0,123,0,false,0),evidence('BATCH',0,124,1,true,15)]};let clock=0;
const factory=new AsyncFunction('assert','keys','physicalPreparation','createOwnedFileDb','pathToFileURL','join','directory','fingerprintOwnedFile','performance','allRows','verifyLiveExecutionResult','canonicalRow','stat','physicalBatchReleaseSha','process','setImmediate','Buffer',`let db,stage='BOUNDED_PHYSICAL_FILE_PREPARATION',progress={},started=0;try{${segment};return {stage,proof:parentFileVerification};}catch(error){return {stage,error:error.message,proof:null};}`);
async function seam(kind){clock=0;let opened=0,closed=0,admitted=0;
 const fake={raw:{protocol:'file',execute:async sql=>{
  if(sql==='SELECT max(version) n FROM schema_version')return {rows:[{n:kind==='schema'?33:35}]};
  if(sql==='PRAGMA quick_check')return {rows:[{quick_check:kind==='integrity'?'bad':'ok'}]};
  if(sql.includes('count(*) n FROM phase4_jobs'))return {rows:[{n:1}]};
  if(sql.includes('count(*) n FROM observation_episodes'))return {rows:[{n:1}]};
  if(sql.includes("SELECT type,name,tbl_name,sql"))return {rows:[{type:'table',name:'synthetic_rows',tbl_name:'synthetic_rows',sql:'CREATE TABLE synthetic_rows(a)'}]};
  if(sql.includes("SELECT name FROM sqlite_master"))return {rows:[{name:'synthetic_rows'}]};
  if(sql==='SELECT * FROM synthetic_rows')return {rows:[{a:1}]};
  throw Error('UNEXPECTED_SQL');}},admitRuntime:async()=>{admitted++;if(kind==='admission')throw Error('ADMISSION_FAIL');},close:async()=>{closed++;if(kind==='close')throw Error('CLOSE_FAIL');if(kind==='time')clock=120000;}};
 const r=await factory(assert,keys,prep,()=>{opened++;return fake;},pathToFileURL,join,'/tmp/synthetic',async()=>kind==='fingerprint'?{...fp,sourceDigest:'b'.repeat(64)}:structuredClone(fp),{now:()=>clock},async table=>table==='stage8_live_executions'?[{state:'FINALIZED_SUCCESS'}]:[{synthetic:1}],()=>{if(kind==='signature')throw Error('SIGNATURE_FAIL');},JSON.stringify,async()=>({size:kind==='wal'?1:0}),()=>sha,{pid:122},setImmediate,Buffer);return {...r,opened,closed,admitted};}
let r=await seam('ok');assert.equal(r.stage,'ONE_SQLD_LEGACY_STARTUP',JSON.stringify(r));assert.equal(r.proof.fileClientClosed,true);assert.equal(r.proof.applicationTables,1);assert.equal(r.opened,1);assert.equal(r.admitted,1);assert.equal(r.closed,1);assert.equal(r.proof.parentPID,122);assert.equal(r.proof.lastWorkerDescriptorSHA256,H);
for(const kind of ['admission','schema','integrity','fingerprint','signature','close','wal','time']){r=await seam(kind);assert.notEqual(r.stage,'ONE_SQLD_LEGACY_STARTUP',kind);assert.equal(r.proof,null);assert.equal(typeof r.error,'string');}
console.log('NINE_ACTUAL_PARENT_GUARD_SEAMS_NO_DB_OR_CHILDREN');
""")


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


 def planner_prefix(self):
  source=(ROOT/m.WORKER).read_text()
  helper=source[source.index('function preparationBudgetFor'):source.index('\nasync function preserveOriginal')]
  loop=source[source.index('   for(let j=0;j<2;j++){'):source.index('\n   await preserveOriginal(before)')]
  return "import assert from 'node:assert/strict';\nconst STAGE8_LIVE_DRAIN_BUDGET={maxItemsPerTenant:12},last=JSON.stringify(['workout','workout-39']);\nconst catalog=Array.from({length:160},(_,i)=>JSON.stringify(['synthetic',String(i)])).concat(last);\nconst boundaryReady=pending=>pending.length===1&&pending[0].full_scan_cursor===last;\n"+helper+"\nconst originalLoop="+json.dumps(loop)+";\n"
 def test_actual_adaptive_planner_catalog_cursor_and_zero_tail_boundaries(self):
  self.node(self.planner_prefix()+r"""
const rows=(...cursors)=>cursors.map(full_scan_cursor=>({full_scan_cursor}));
assert.deepEqual(preparationBudgetFor(rows(null,null),catalog),{maxItems:12,maxItemsPerTenant:12});
assert.deepEqual(preparationBudgetFor(rows(catalog.at(-2),last),catalog),{maxItems:1,maxItemsPerTenant:12});
assert.deepEqual(preparationBudgetFor(rows(catalog.at(-3),catalog.at(-4)),catalog),{maxItems:5,maxItemsPerTenant:12});
assert.deepEqual(preparationBudgetFor(rows(last,last),catalog),{maxJobs:1,maxItems:1,maxItemsPerTenant:1});
assert.deepEqual(preparationBudgetFor(rows(catalog.at(-2)),catalog),{maxItems:1,maxItemsPerTenant:12});
assert.throws(()=>preparationBudgetFor(rows(last),catalog),/ORIGINAL_NONEMPTY_CURSOR_REQUIRED/);
for(const pending of [[],rows(null,null,null),rows(undefined),rows('foreign'),[{}]])assert.throws(()=>preparationBudgetFor(pending,catalog));
for(const bad of [null,[],[last,last],[1,last],['bad'],Array(512).fill('x').concat(last)])assert.throws(()=>preparationBudgetFor(rows(null),bad));
// Exact catalog cursor position drives ACK count; no score or work-unit estimate.
for(let i=0;i<catalog.length-1;i++)assert.equal(preparationBudgetFor(rows(catalog[i]),catalog).maxItems,Math.min(12,catalog.length-i-1));
console.log('ACTUAL_HELPER_BOUNDARIES_NO_DATABASE');
""")
 def test_actual_worker_loop_rechecks_last_eof_and_stops_after_heavy_call(self):
  self.node(self.planner_prefix()+r"""
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const make=()=>new AsyncFunction('assert','db','boundaryReady','preparationBudgetFor','sourceCatalog','runPreparation',`let ready=false,completedCalls=0,callsWithUnitsOrCompletedJobs=0,sourceAcknowledgments=0,unitsCommitted=0,preparationBudget=null;const ordinal=0;const wrapped=async arg=>runPreparation(arg,preparationBudget);${originalLoop.replace('await runPreparation(','await wrapped(')};return {ready,completedCalls,callsWithUnitsOrCompletedJobs,sourceAcknowledgments,unitsCommitted};`);
const rows=(...cursors)=>cursors.map(full_scan_cursor=>({full_scan_cursor}));
async function seam(states,results){let reads=0,calls=[];const result=await make()(assert,{raw:{execute:async()=>({rows:states[Math.min(reads++,states.length-1)]})}},boundaryReady,preparationBudgetFor,catalog,async(arg,budget)=>{calls.push({arg,budget});const v=results[calls.length-1];assert.ok(v,'UNEXPECTED_EXTRA_CALL');return {replayed:false,result:{jobsFailed:0,itemsProcessed:0,unitsCommitted:0,jobsCompleted:0,...v}};});return {result,calls,reads};}
let v=await seam([rows(null,null)],[{itemsProcessed:4,unitsCommitted:8}]);assert.equal(v.calls.length,1);assert.equal(v.result.callsWithUnitsOrCompletedJobs,1);assert.equal(v.result.unitsCommitted,8);
v=await seam([rows(last,last)],[{jobsCompleted:1}]);assert.equal(v.calls.length,1);assert.deepEqual(v.calls[0].budget,{maxJobs:1,maxItems:1,maxItemsPerTenant:1});assert.equal(v.result.callsWithUnitsOrCompletedJobs,1);
// First ACK-only call reaches last pending cursor: guard prevents any EOF call.
v=await seam([rows(catalog.at(-2)),rows(last)],[{itemsProcessed:1}]);assert.equal(v.calls.length,1);assert.equal(v.reads,2);assert.equal(v.result.ready,true);assert.equal(v.result.callsWithUnitsOrCompletedJobs,0);
// Two cheap calls share a process; second call gets a fresh exact tail budget.
v=await seam([rows(catalog.at(-3),last),rows(catalog.at(-2),last)],[{itemsProcessed:1},{itemsProcessed:1}]);assert.equal(v.calls.length,2);assert.deepEqual(v.calls.map(x=>x.budget.maxItems),[2,1]);assert.deepEqual(v.calls.map(x=>x.arg.requestId),['synthetic-native-adaptive-prepare-0','synthetic-native-adaptive-prepare-1']);
// If two jobs reach EOF after cheap first call, second may finish only one.
v=await seam([rows(catalog.at(-2),last),rows(last,last)],[{itemsProcessed:1},{jobsCompleted:1}]);assert.equal(v.calls.length,2);assert.equal(v.calls[1].budget.maxJobs,1);assert.equal(v.result.callsWithUnitsOrCompletedJobs,1);
await assert.rejects(()=>seam([rows('foreign')],[{}]),/SYNTHETIC_PROGRESS_CURSOR_INVALID/);
await assert.rejects(()=>seam([[]],[{}]),/ORIGINAL_NONEMPTY_CURSOR_REQUIRED/);
console.log('SEVEN_ACTUAL_LOOP_SEAMS_NO_DATABASE');
""")
 def test_adaptive_two_call_packet_and_counter_rejection(self):
  self.node(self.prefix()+r"""
const identity={mode:'BATCH',ordinal:0,pid:123,parentPID:122};
const two={...packet,completedCalls:2,callsWithUnitsOrCompletedJobs:1,sourceAcknowledgments:16,unitsCommitted:8,after:{...fp,executionCount:2}};
assert.equal(validateBatchPacket(two,identity),true);
for(const bad of [{...two,callsWithUnitsOrCompletedJobs:0},{...two,callsWithUnitsOrCompletedJobs:-1},{...two,callsWithUnitsOrCompletedJobs:1.5},{...two,callsWithUnitsOrCompletedJobs:'1'},{...two,callsWithUnitsOrCompletedJobs:2},{...two,completedCalls:3},{...two,sourceAcknowledgments:41},{...two,extraPrivate:'forbidden'}])assert.throws(()=>validateBatchPacket(bad,identity));
""")


 def failure_profile_prefix(self):
  return "import assert from 'node:assert/strict';import {createAttribution} from './test/stage6-native-attribution.mjs';import {collectEOFFailureDiagnostic,projectFailureProgress,projectEOFFailure} from './test/stage6-native-eof-failure-profile.mjs';\n"+r"""
const snapshot=createAttribution().snapshot();snapshot.adapter={terminalComplete:true,retainedStreams:0};
Object.assign(snapshot.bins.GENUINE_ORIGINAL_PRODUCER_CALL,{requests:40,submittedStatements:95});Object.assign(snapshot.bins.GENUINE_ORIGINAL_PRODUCER_CALL.transactions,{begun:2,committed:2,maxDurationUpperBoundMs:6001,atOrAbove5s:1});
const sample={startedPhase:'GENUINE_ORIGINAL_PRODUCER_CALL',endedPhase:'GENUINE_ORIGINAL_PRODUCER_CALL',outerWorkUnit:'ORIGINAL_PRODUCER_RUN',callOrdinal:1,requestOrdinal:1,beginStatementOrdinal:0,innerSemanticWorkUnit:'UNKNOWN_NOT_INSTRUMENTED',lastStorageCategory:'EXECUTION_CONTROL',outcome:'committed',durationUpperBoundMs:6001};snapshot.transactionSamples=[sample,{...sample,requestOrdinal:2,durationUpperBoundMs:2000}];
const diagnostic=collectEOFFailureDiagnostic(snapshot);assert.ok(diagnostic);
const progress={check:'EOF_TX_5S_COUNT',eofSnapshotState:'TERMINAL',eofRequests:40,eofTransactions:2,eofAtOrAbove5s:1,eofMaxUpperMs:6001,eofOpen:0,eofUnknownTerminal:0,lastPendingJobs:null};
const failure={stage:'JOINED_CLIENT_CLEANUP',type:'AssertionError',code:'ERR_ASSERTION',classification:'OTHER_ASSERTION',progress,eofDiagnostic:diagnostic,elapsedMs:160000};const frame=v=>'STAGE6_FILE_PREPARED_NATIVE_EOF_FAILURE '+JSON.stringify(v);
"""
 def test_closed_failure_progress_and_optional_observation_privacy(self):
  self.node(self.failure_profile_prefix()+r"""
let v=projectEOFFailure(frame(failure));assert.equal(v.failure.progress.check,'EOF_TX_5S_COUNT');assert.equal(v.failure.eofDiagnostic.eof.transactions.atOrAbove5s,1);assert.equal(v.failure.eofDiagnostic.selectedSamples[0].durationUpperBoundMs,6001);assert.equal(v.EOFQualified,false);assert.equal(v.failure.eofDiagnostic.EOFQualified,false);
for(const change of [{privateHealth:15},{check:'PRIVATE_HEALTH'},{eofRequests:true},{eofMaxUpperMs:Infinity},{eofOpen:-1},{eofSnapshotState:'arbitrary'}])assert.equal(projectFailureProgress({...progress,...change}),null);
let accessed=0;const getter={...progress};Object.defineProperty(getter,'check',{enumerable:true,get(){accessed++;return 'EOF_TX_5S_COUNT';}});assert.equal(projectFailureProgress(getter),null);assert.equal(accessed,0);
for(const change of [d=>d.privateHealth='forbidden',d=>d.eof.categories.privateHealth={submitted:1,executed:1},d=>d.selectedSamples[0].rawSQL='forbidden',d=>d.selectedSamples[0].outcome='private',d=>d.selectedSamples[0].durationUpperBoundMs=-1,d=>d.selectedSamples=Array(9).fill(sample),d=>d.capacityQualified=true]){const d=structuredClone(diagnostic);change(d);v=projectEOFFailure(frame({...failure,eofDiagnostic:d}));assert.equal(v.failure.eofDiagnostic,null);assert.equal(v.failure.progress.check,'EOF_TX_5S_COUNT');assert.equal(JSON.stringify(v).includes('forbidden'),false);}
for(const mutate of [f=>f.privateHealth='forbidden',f=>f.stage='PRIVATE_HEALTH',f=>f.elapsedMs=-1]){const f=structuredClone(failure);mutate(f);v=projectEOFFailure(frame(f));assert.equal(v.failure,null);assert.equal(JSON.stringify(v).includes('forbidden'),false);}
assert.equal(projectEOFFailure(frame(failure)+'\n'+frame(failure)).failure,null);assert.equal(projectEOFFailure('STAGE6_FILE_PREPARED_NATIVE_EOF_FAILURE notJSON').failure,null);
const incomplete=structuredClone(snapshot);incomplete.physicalTerminalObservationComplete=false;incomplete.adapter.terminalComplete=false;incomplete.adapter.retainedStreams=1;incomplete.droppedTransactionSamples=3;incomplete.transactionSampleCoverageComplete=false;v=collectEOFFailureDiagnostic(incomplete);assert.equal(v.physicalTerminalObservationComplete,false);assert.equal(v.adapterTerminalComplete,false);assert.equal(v.transactionSampleCoverageComplete,false);assert.equal(v.sampleCountDropped,3);assert.equal(v.EOFQualified,false);
const many=structuredClone(snapshot);many.transactionSamples=Array.from({length:64},(_,i)=>({...sample,requestOrdinal:i,durationUpperBoundMs:i}));v=collectEOFFailureDiagnostic(many);assert.equal(v.sampleCountRetained,64);assert.equal(v.selectedSamples.length,8);assert.equal(v.selectedSamples[0].durationUpperBoundMs,63);many.transactionSamples.push(sample);assert.equal(collectEOFFailureDiagnostic(many),null);
""")
 def test_failure_counters_survive_child_supervisor_ci_summary_wire(self):
  raw=self.node(self.failure_profile_prefix()+r"""
const projected=projectEOFFailure(frame(failure));assert.ok(projected.failure);console.log(JSON.stringify({contract:'one-physical-batch-file48-parent-verified-native-eof-supervisor-v1',candidateSha:'c'.repeat(40),status:'FAILED_OR_UNKNOWN_NO_QUALIFICATION',failure:projected.failure,failureProjectionStatus:projected.status}));
""")
  wrapper=json.loads(raw);original=m.parse_original_supervisor('STAGE6_PHYSICAL_BATCH_FILE48_NATIVE_EOF_SUPERVISOR '+raw,'c'*40)
  self.assertEqual(original,wrapper)
  summary={'contract':'one-physical-batch-file48-parent-verified-native-eof-ci-v1','candidateSha':'c'*40,'runId':'123','attempt':1,'status':'FAILED_OR_UNKNOWN_NO_QUALIFICATION','observed':original,'EOFQualified':False,'sixJobCompletionQualified':False,'capacityQualified':False,'productionEvidence':False}
  # Same wire encoding and marker split used by the private original collector.
  marker='STAGE6_PHYSICAL_BATCH_FILE48_NATIVE_EOF_SAFE_SUMMARY ';wire='timestamp '+marker+json.dumps(summary);lines=[x for x in wire.splitlines()if marker in x];self.assertEqual(len(lines),1);collected=json.loads(lines[0].split(marker,1)[1]);self.assertEqual(collected,summary)
  observation=collected['observed']['failure'];self.assertEqual(observation['progress']['check'],'EOF_TX_5S_COUNT');self.assertEqual(observation['eofDiagnostic']['eof']['transactions']['atOrAbove5s'],1);self.assertEqual(observation['eofDiagnostic']['selectedSamples'][0]['durationUpperBoundMs'],6001);self.assertFalse(collected['EOFQualified'])

 def test_actual_supervisor_main_and_ci_failure_wire(self):
  # Execute the unchanged supervisor main body with inert child/fs/cgroup seams.
  # No child process, database, Docker, provider, or real filesystem log is used.
  raw=self.node(self.failure_profile_prefix()+r"""
import {readFileSync} from 'node:fs';import {EventEmitter} from 'node:events';import {createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';
import {validateChildResourceSample,validateChildResourceShape} from './test/stage6-native-file48-eof-resource.mjs';
const source=readFileSync('./tools/stage8-qualification/owned-file48-physical-batch-native-eof-supervisor.mjs','utf8');
const body=source.slice(source.indexOf('export function projectChildResources'),source.lastIndexOf("if(process.argv[1]")).replace(/^export /gm,'');
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;const factory=new AsyncFunction('projectEOFFailure','spawn','execFileSync','readFile','stat','open','rm','createHash','networkInterfaces','assert','pathToFileURL','validateChildResourceSample','validateChildResourceShape','process','performance','setTimeout','clearTimeout','console',body+'\nawait main();');
const fixture=readFileSync('./test/stage6-owned-file-batched-prepared-native-eof.mjs','utf8'),catchStart=fixture.indexOf('}catch(error){capturePreparationProgress('),catchEnd=fixture.indexOf('\nfinally{',catchStart);assert.ok(catchStart>0&&catchEnd>catchStart);
const catchBody=fixture.slice(catchStart+'}catch(error){'.length,catchEnd-1),childLines=[];
const catchFactory=new Function('capturePreparationProgress','progress','b','collectEOFFailureDiagnostic','stage','error','failureClassification','performance','started','console','let failure=null;'+catchBody+';return failure;');
const childPacket=catchFactory(()=>{},progress,{snapshot:()=>snapshot},collectEOFFailureDiagnostic,'JOINED_CLIENT_CLEANUP',{name:'AssertionError',code:'ERR_ASSERTION'},()=> 'OTHER_ASSERTION',{now:()=>160000},0,{log:v=>childLines.push(v)});
assert.equal(childLines.length,1);assert.equal(childPacket.progress.check,'EOF_TX_5S_COUNT');assert.equal(childPacket.eofDiagnostic.eof.transactions.atOrAbove5s,1);
const childRaw=childLines[0]+'\nSTAGE6_FILE_PREPARED_NATIVE_EOF_TERMINAL '+JSON.stringify({closed:true,ownedServerExited:true,clientTerminalComplete:true,retainedStreams:0,physicalTerminalObservationComplete:true})+'\n';
const calls=[],logs=[],fakeProcess={pid:200,env:{EXPECTED_CANDIDATE_SHA:'c'.repeat(40),PATH:'/fake'},platform:'linux',arch:'x64',version:'v22.23.2',execPath:'/fake/node'};
const spawn=()=>{calls.push('spawn');const c=new EventEmitter();c.pid=201;queueMicrotask(()=>c.emit('close',1,null));return c;};
const readFile=async path=>path.endsWith('.log')?childRaw:({'memory.max':'536870912','memory.swap.max':'0','cpu.max':'50000 100000','memory.events':'oom 0\noom_kill 0','memory.peak':'495000000'})[path.split('/').at(-1)];
await factory(projectEOFFailure,spawn,()=> 'c'.repeat(40),readFile,async()=>({size:Buffer.byteLength(childRaw)}),async()=>({fd:99,close:async()=>calls.push('close')}),async()=>calls.push('rm'),createHash,()=>({lo:[]}),assert,pathToFileURL,validateChildResourceSample,validateChildResourceShape,fakeProcess,{now:()=>170000},()=>99,()=>{}, {log:s=>{assert.ok(calls.includes('rm'));logs.push(s);}});
assert.equal(fakeProcess.exitCode,2);assert.deepEqual(calls,['spawn','close','rm']);assert.equal(logs.length,1);assert.equal(logs[0].includes('STAGE6_FILE_PREPARED_NATIVE_EOF_FAILURE '),false);
const wire=JSON.parse(logs[0].split('STAGE6_PHYSICAL_BATCH_FILE48_NATIVE_EOF_SUPERVISOR ')[1]);assert.equal(wire.failure.progress.check,'EOF_TX_5S_COUNT');assert.equal(wire.failure.eofDiagnostic.eof.transactions.atOrAbove5s,1);assert.equal(wire.status,'FAILED_OR_UNKNOWN_NO_QUALIFICATION');console.log(logs[0]);
""")
  import tempfile,io,contextlib
  from types import SimpleNamespace
  supervisor=m.parse_original_supervisor(raw,'c'*40)
  with tempfile.TemporaryDirectory(prefix='closed-eof-wire-') as td:
   root=pathlib.Path(td);source=root/'source';source.mkdir();(source/'.git').mkdir();(source/'tools/stage8-qualification').mkdir(parents=True)
   for f in ['package.json','package-lock.json','tools/stage8-qualification/Dockerfile.native-empty-ci']:(source/f).write_text('inert fixture')
   sandbox=root/'sandbox';cid='a'*64
   def command(args,*unused):
    if args[:2]==['docker','build']:return ''
    if args[:3]==['docker','image','inspect']:return json.dumps([{'Architecture':'amd64','Os':'linux','Id':'test-image'}])
    if args[:2]==['docker','ps']:return ''
    if args[:2]==['docker','create']:(sandbox/'container.cid').write_text(cid);return cid
    if args[:2]==['docker','inspect']:return json.dumps([{'State':{'Running':False,'ExitCode':2,'OOMKilled':False}}])
    raise AssertionError('UNEXPECTED_COMMAND')
   output=io.StringIO()
   with patch.dict(m.os.environ,self.env if hasattr(self,'env') else {'GITHUB_RUN_ID':'123'},clear=True),patch.object(m,'validate',return_value='c'*40),patch.object(m.h,'paths',return_value=(sandbox,'inert-wire')),patch.object(m,'source_gate'),patch.object(m.h,'run',side_effect=command),patch.object(m.h,'write'),patch.object(m.h,'cleanup',return_value=True),patch.object(m.subprocess,'run',return_value=SimpleNamespace(stdout=raw,returncode=2)),patch.object(m.sys,'argv',['ci','--run',str(source)]),contextlib.redirect_stdout(output):
    self.assertEqual(m.main(),2)
   marker='STAGE6_PHYSICAL_BATCH_FILE48_NATIVE_EOF_SAFE_SUMMARY ';wire=output.getvalue();self.assertEqual(wire.count(marker),1);summary=json.loads(wire.split(marker)[1]);self.assertEqual(summary['observed'],supervisor);self.assertEqual(summary['status'],'FAILED_OR_UNKNOWN_NO_QUALIFICATION');self.assertTrue(summary['cleanupConfirmed']);self.assertFalse(summary['EOFQualified']);self.assertEqual(summary['observed']['failure']['eofDiagnostic']['eof']['transactions']['atOrAbove5s'],1)

if __name__=='__main__':unittest.main()

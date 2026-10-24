import importlib.util,pathlib,unittest,subprocess,json
p=pathlib.Path(__file__).with_name('first17-work-ci.py');s=importlib.util.spec_from_file_location('work_control',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Gate(unittest.TestCase):
 def setUp(self):self.env={'GITHUB_REPOSITORY':m.h.REPOSITORY,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':m.REF,'QUALIFICATION_MODE':m.MODE,'FIRST20_DIAGNOSTIC_INTENT':m.INTENT,'QUALIFICATION_REPOSITORY_PRIVATE':'false','CANDIDATE_SHA':'c'*40,'GITHUB_SHA':'c'*40,'QUALIFICATION_WORKFLOW_SHA':'c'*40,'GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':'123','RUNNER_OS':'Linux','RUNNER_ARCH':'X64'}
 def call(self,e=None,system='Linux',machine='x86_64',uid=1001,gid=1001):return m.validate(self.env if e is None else e,system,machine,uid,gid)
 def test_exact_diagnostic_scope(self):self.assertEqual(self.call(),'c'*40)
 def test_missing_fields_refused(self):
  for k in self.env:
   with self.subTest(k=k):
    e=self.env.copy();del e[k]
    with self.assertRaises(AssertionError):self.call(e)
 def test_old_or_mutated_authority_refused(self):
  for k,v in [('GITHUB_REF','refs/heads/diagnostic/stage6-native-memo-duplicate-20261024'),('FIRST20_DIAGNOSTIC_INTENT','one-original-memo-duplicate-repair-contrast-v1'),('GITHUB_REF','refs/heads/diagnostic/stage6-native-recovery-cpu-20261024'),('FIRST20_DIAGNOSTIC_INTENT','one-original-current-recovery-cpu-window-v1'),('GITHUB_REF','refs/heads/diagnostic/stage6-native-tenant-data-20261024'),('FIRST20_DIAGNOSTIC_INTENT','one-original-tenant-data-repair-contrast-v1'),('GITHUB_REF','refs/heads/diagnostic/stage6-native-first17-work-20261024'),('FIRST20_DIAGNOSTIC_INTENT','one-original-current-first17-work-diagnostic-v1'),('GITHUB_REF','refs/heads/diagnostic/stage6-native-lease-data-eof-20261024'),('FIRST20_DIAGNOSTIC_INTENT','one-original-context-lease-data-positive-eof-and-replay-v1'),('GITHUB_REF','refs/heads/main'),('QUALIFICATION_MODE','native-positive-hybrid-eof'),('GITHUB_RUN_ATTEMPT','2'),('GITHUB_SHA','d'*40),('QUALIFICATION_WORKFLOW_SHA','d'*40),('QUALIFICATION_REPOSITORY_PRIVATE','true'),('GITHUB_RUN_ID','1;bad')]:
   with self.subTest(k=k,v=v):
    with self.assertRaises(AssertionError):self.call({**self.env,k:v})
 def test_non_native_or_root_refused(self):
  for args in [('Darwin','arm64',1001,1001),('Linux','aarch64',1001,1001),('Linux','x86_64',0,1001),('Linux','x86_64',1001,0)]:
   with self.subTest(args=args):
    with self.assertRaises(AssertionError):self.call(None,*args)
 def test_pure_cpu_and_closed_source_transforms(self):
  root=pathlib.Path(__file__).resolve().parents[2]
  r=subprocess.run(['node','--test',str(root/'test/stage6-native-work-join.test.mjs'),str(root/'test/processing-read-snapshot-duplicate.test.mjs')],capture_output=True,text=True,timeout=30)
  self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertIn('# fail 0',r.stdout)
 def test_fixture_contains_only17_cpu_work_and_no_eof_result_claim(self):
  root=pathlib.Path(__file__).resolve().parents[2];source=(root/'test/stage6-native-first17-work.mjs').read_text()
  self.assertEqual(source.count('for(let i=0;i<17;i++)'),1);self.assertIn('started<240000',source);self.assertNotIn("stage='GENUINE_NATIVE_EOF'",source);self.assertNotIn('exactReplayVerified:true',source)
  self.assertNotIn('profileCpuWork',source);self.assertIn('correlation.preparation(i+1',source);self.assertIn('EOFQualified:false,sixJobCompletionQualified:false,capacityQualified:false',source)
 def test_exact_child_heap_observation_is_mandatory_and_not_capacity(self):
  root=pathlib.Path(__file__).resolve().parents[2]
  fixture=(root/'test/stage6-native-first17-work.mjs').read_text();supervisor=(root/'tools/stage8-qualification/first17-work-supervisor.mjs').read_text()
  self.assertIn("assert.deepEqual(controlledHeapArgs,['--max-old-space-size=128','--max-semi-space-size=2'])",fixture)
  self.assertIn("assert.equal(process.env.NODE_OPTIONS,undefined)",fixture)
  self.assertIn('heapSizeLimitBytes:getHeapStatistics().heap_size_limit',fixture)
  self.assertIn("assert.equal(v.heapControls.oldSpaceMiB,128)",supervisor)
  self.assertIn("assert.deepEqual(v.heapControls.execArgv,['--max-old-space-size=128','--max-semi-space-size=2'])",supervisor)
  self.assertIn('v.heapControls.heapSizeLimitBytes<=144*1048576',supervisor)
  self.assertIn("'--max-old-space-size=128'",supervisor);self.assertNotIn("'--max-old-space-size=96'",supervisor)
  self.assertIn("assert.equal(await read('memory.max'),'536870912')",supervisor)
  self.assertIn("assert.equal(await read('memory.swap.max'),'0')",supervisor)
  self.assertIn("assert.equal(await read('cpu.max'),'50000 100000')",supervisor)
 def test_actual_heap_schema_refuses_old_missing_argv_and_false_qualification(self):
  root=pathlib.Path(__file__).resolve().parents[2]
  script=r"""
import assert from 'node:assert/strict';
import {validateDiagnostic} from './tools/stage8-qualification/first17-work-supervisor.mjs';
const v={contract:'one-native-first17-work-diagnostic-v1',status:'DIAGNOSTIC_FIRST17_COMPLETE_NO_QUALIFICATION',applicationSource:'8a4d3765a55c52ffd160431395c066d9564e35bd',diagnosticLegs:Array.from({length:17},(_,i)=>({ordinal:i+1,kind:'RETURNED_CANONICAL_PREPARATION',postconditionsNotYetChecked:true,replayed:false,wallMs:1,processedItems:0,unitsCommitted:0,failedJobs:0})),heapControls:{oldSpaceMiB:128,semiSpaceMiB:2,execArgv:['--max-old-space-size=128','--max-semi-space-size=2'],heapSizeLimitBytes:140509184},preparationTransactions:{begun:1,committed:1,rolledBack:0,unknownTerminal:0,open:0,sumDurationUpperBoundMs:1,maxDurationUpperBoundMs:1,atOrAbove5s:0},httpRequests:1,statementCount:1,maxPreparations:17,sourceHealthRows:160,users:1,addedLatencyMs:0,cpuProfilerUsed:false,productionEvidence:false,EOFQualified:false,sixJobCompletionQualified:false,capacityQualified:false,elapsedMs:1,ownedServerExited:true,originalPostconditionsPassed:true};
assert.equal(validateDiagnostic(v),true);
const reject=fn=>{const x=structuredClone(v);fn(x);assert.throws(()=>validateDiagnostic(x));};
for(const size of [96,160])reject(x=>x.heapControls.oldSpaceMiB=size);
reject(x=>delete x.heapControls);reject(x=>delete x.heapControls.heapSizeLimitBytes);
reject(x=>x.heapControls.heapSizeLimitBytes=1024);reject(x=>x.heapControls.heapSizeLimitBytes=200*1048576);
reject(x=>x.heapControls.execArgv[0]='--max-old-space-size=96');reject(x=>x.heapControls.execArgv.push('--max-old-space-size=160'));
reject(x=>x.heapControls.semiSpaceMiB=4);reject(x=>x.heapControls.extra='unapproved');
for(const flag of ['productionEvidence','EOFQualified','sixJobCompletionQualified','capacityQualified','cpuProfilerUsed'])reject(x=>x[flag]=true);
console.log('16 heap-schema positive/negative boundary checks PASS');
"""
  r=subprocess.run(['node','--input-type=module','-e',script],cwd=root,capture_output=True,text=True,timeout=30)
  self.assertEqual(r.returncode,0,r.stdout+r.stderr)
if __name__=='__main__':unittest.main()

import importlib.util,pathlib,unittest
p=pathlib.Path(__file__).with_name('first20-ci.py');s=importlib.util.spec_from_file_location('new_control',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Gate(unittest.TestCase):
 def setUp(self):self.env={'GITHUB_REPOSITORY':m.h.REPOSITORY,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':m.REF,'QUALIFICATION_MODE':m.MODE,'FIRST20_DIAGNOSTIC_INTENT':m.INTENT,'QUALIFICATION_REPOSITORY_PRIVATE':'false','CANDIDATE_SHA':'c'*40,'GITHUB_SHA':'c'*40,'QUALIFICATION_WORKFLOW_SHA':'c'*40,'GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':'123','RUNNER_OS':'Linux','RUNNER_ARCH':'X64'}
 def call(self,e=None,system='Linux',machine='x86_64',uid=1001,gid=1001):return m.validate(self.env if e is None else e,system,machine,uid,gid)
 def test_exact_new_scope(self):self.assertEqual(self.call(),'c'*40)
 def test_every_missing_authority_field_refused(self):
  for k in self.env:
   with self.subTest(key=k):
    e=self.env.copy();del e[k]
    with self.assertRaises(AssertionError):self.call(e)
 def test_old_runs_or_other_identity_or_private_refused(self):
  for k,v in [('GITHUB_REF','refs/heads/diagnostic/stage6-native-appcause-20261023'),('FIRST20_DIAGNOSTIC_INTENT','one-original-first20-appcause-diagnostic-v1'),('GITHUB_REF',m.h.REF),('GITHUB_REF','refs/heads/main'),('QUALIFICATION_MODE',m.h.MODE),('FIRST20_DIAGNOSTIC_INTENT',m.h.INTENT),('GITHUB_RUN_ATTEMPT','2'),('GITHUB_SHA','d'*40),('QUALIFICATION_WORKFLOW_SHA','d'*40),('QUALIFICATION_REPOSITORY_PRIVATE','true'),('GITHUB_RUN_ID','1;bad')]:
   with self.subTest(key=k,value=v):
    with self.assertRaises(AssertionError):self.call({**self.env,k:v})
 def test_non_native_root_refused(self):
  for a in [('Darwin','arm64',1001,1001),('Linux','aarch64',1001,1001),('Linux','x86_64',0,1001),('Linux','x86_64',1001,0)]:
   with self.subTest(args=a):
    with self.assertRaises(AssertionError):self.call(None,*a)
 def test_exact_finite_observation_dispositions(self):
  import re,subprocess
  source=pathlib.Path(__file__).with_name('first20-supervisor.mjs').read_text()
  definition=re.search(r"function validateObservation\(v\)\{[\s\S]*?\n\}",source).group(0)
  witness="import assert from 'node:assert/strict';\n"+definition+"\n"+r"""
const leg=i=>({ordinal:i,outcome:'PARTIAL',processedItems:6,unitsCommitted:0,completedJobs:0,failedJobs:0,remainingJobs:2,failures:[]});
const base={instrumentedOriginalMapper:true,finiteOriginalApplicationFailures:[],finiteFailureDropped:0,contract:'one-native-first20-appcause-diagnostic-v1',maxPreparations:20,syntheticWHOOPRows:160,status:'DIAGNOSTIC_FIRST20_NO_WORKER_FAILURE',preparations:Array.from({length:20},(_,i)=>leg(i+1)),productionEvidence:false,EOFQualified:false,sixJobCompletionQualified:false,capacityQualified:false};assert.equal(validateObservation(base),true);
for(const change of [v=>v.preparations.pop(),v=>v.preparations[1].ordinal=1,v=>v.productionEvidence=true,v=>v.EOFQualified=true,v=>v.capacityQualified=true,v=>v.preparations[0].failedJobs=1]){const v=structuredClone(base);change(v);assert.throws(()=>validateObservation(v));}
const failed=structuredClone(base);failed.status='DIAGNOSTIC_WORKER_FAILURE_OBSERVED';failed.preparations.pop();failed.preparations.at(-1).failedJobs=1;failed.preparations.at(-1).failures=[{kind:'RECOMPUTE_DERIVED',code:'OTHER'}];assert.equal(validateObservation(failed),true);failed.preparations.at(-1).failures[0].code='UNREVIEWED_PRIVATE_TEXT';assert.throws(()=>validateObservation(failed));console.log('EXACT_FINITE_DISPOSITIONS_PASS');
"""
  result=subprocess.run(['node','--input-type=module','-e',witness],capture_output=True,text=True,timeout=15)
  self.assertEqual(result.returncode,0,result.stderr);self.assertIn('EXACT_FINITE_DISPOSITIONS_PASS',result.stdout)
if __name__=='__main__':unittest.main()

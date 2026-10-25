import importlib.util,pathlib,unittest,subprocess,json
p=pathlib.Path(__file__).with_name('first17-work-ci.py');s=importlib.util.spec_from_file_location('work_control',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Gate(unittest.TestCase):
 def setUp(self):self.env={'GITHUB_REPOSITORY':m.h.REPOSITORY,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':m.REF,'QUALIFICATION_MODE':m.MODE,'FIRST20_DIAGNOSTIC_INTENT':m.INTENT,'QUALIFICATION_REPOSITORY_PRIVATE':'false','CANDIDATE_SHA':'c'*40,'GITHUB_SHA':'c'*40,'QUALIFICATION_WORKFLOW_SHA':'c'*40,'GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':'123','RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_JOB':'native-raw-syntax-plan-first17-diagnostic'}
 def call(self,e=None,system='Linux',machine='x86_64',uid=1001,gid=1001):return m.validate(self.env if e is None else e,system,machine,uid,gid)
 def test_exact_diagnostic_scope(self):self.assertEqual(self.call(),'c'*40)
 def test_missing_fields_refused(self):
  for k in self.env:
   with self.subTest(k=k):
    e=self.env.copy();del e[k]
    with self.assertRaises(AssertionError):self.call(e)
 def test_old_or_mutated_authority_refused(self):
  for k,v in [('GITHUB_REF','refs/heads/diagnostic/stage6-recovery17-cost-parser-20261025'),('FIRST20_DIAGNOSTIC_INTENT','one-original-recovery17-cpu-cost-parser-v2'),('GITHUB_JOB','native-recovery17-cost-parser-diagnostic'),('GITHUB_JOB','native-recovery17-cpu-cost-diagnostic'),('GITHUB_REF','refs/heads/diagnostic/stage6-recovery17-cpu-cost-20261025'),('FIRST20_DIAGNOSTIC_INTENT','one-original-recovery17-cpu-cost-v1'),('GITHUB_REF','refs/heads/diagnostic/stage6-expected-literal-first17-20261025'),('FIRST20_DIAGNOSTIC_INTENT','one-original-expected-literal-first17-v1'),('GITHUB_REF','refs/heads/diagnostic/stage6-expected-ddl-first17-20261025'),('FIRST20_DIAGNOSTIC_INTENT','one-original-expected-ddl-first17-v1'),('GITHUB_REF','refs/heads/diagnostic/stage6-raw-data-first17-20261025'),('FIRST20_DIAGNOSTIC_INTENT','one-original-raw-data-lifetime-first17-v1'),('GITHUB_REF','refs/heads/diagnostic/stage6-native-family-phases-20261024'),('FIRST20_DIAGNOSTIC_INTENT','one-original-recovery-family-phase-observation-v1'),('GITHUB_REF','refs/heads/diagnostic/stage6-native-source-control-20261024'),('FIRST20_DIAGNOSTIC_INTENT','one-original-source-control-pending-repair-v1'),('GITHUB_REF','refs/heads/diagnostic/stage6-native-tenant-data-20261024'),('FIRST20_DIAGNOSTIC_INTENT','one-original-tenant-data-repair-contrast-v1'),('GITHUB_REF','refs/heads/diagnostic/stage6-native-first17-work-20261024'),('FIRST20_DIAGNOSTIC_INTENT','one-original-current-first17-work-diagnostic-v1'),('GITHUB_REF','refs/heads/diagnostic/stage6-native-lease-data-eof-20261024'),('FIRST20_DIAGNOSTIC_INTENT','one-original-context-lease-data-positive-eof-and-replay-v1'),('GITHUB_REF','refs/heads/main'),('QUALIFICATION_MODE','native-positive-hybrid-eof'),('GITHUB_RUN_ATTEMPT','2'),('GITHUB_SHA','d'*40),('QUALIFICATION_WORKFLOW_SHA','d'*40),('QUALIFICATION_REPOSITORY_PRIVATE','true'),('GITHUB_RUN_ID','1;bad')]:
   with self.subTest(k=k,v=v):
    with self.assertRaises(AssertionError):self.call({**self.env,k:v})
 def test_non_native_or_root_refused(self):
  for args in [('Darwin','arm64',1001,1001),('Linux','aarch64',1001,1001),('Linux','x86_64',0,1001),('Linux','x86_64',1001,0)]:
   with self.subTest(args=args):
    with self.assertRaises(AssertionError):self.call(None,*args)
 def test_pure_cpu_and_closed_source_transforms(self):
  root=pathlib.Path(__file__).resolve().parents[2]
  r=subprocess.run(['node','--test',str(root/'test/stage6-raw-disjoint-plan.test.mjs'),str(root/'test/stage6-native-recovery17-cost.test.mjs'),str(root/'test/stage6-native-work-join.test.mjs'),str(root/'test/processing-read-snapshot-duplicate.test.mjs'),str(root/'test/stage6-native-family-phases.test.mjs'),str(root/'test/stage6-native-family-phase-control.test.mjs')],capture_output=True,text=True,timeout=30)
  self.assertEqual(r.returncode,0,r.stdout+r.stderr);self.assertIn('# fail 0',r.stdout)
 def test_fixture_contains_only17_cpu_work_and_no_eof_result_claim(self):
  root=pathlib.Path(__file__).resolve().parents[2];source=(root/'test/stage6-native-first17-work.mjs').read_text()
  self.assertEqual(source.count('for(let i=0;i<17;i++)'),1);self.assertIn('started<240000',source);self.assertNotIn("stage='GENUINE_NATIVE_EOF'",source);self.assertNotIn('exactReplayVerified:true',source)
  self.assertNotIn('profileCpuWork',source);self.assertIn('correlation.preparation(i+1',source);self.assertIn('EOFQualified:false,sixJobCompletionQualified:false,capacityQualified:false',source)
if __name__=='__main__':unittest.main()

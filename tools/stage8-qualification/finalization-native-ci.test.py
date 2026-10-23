import importlib.util,pathlib,unittest
p=pathlib.Path(__file__).with_name('finalization-native-ci.py');s=importlib.util.spec_from_file_location('control',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Gate(unittest.TestCase):
 def setUp(self):
  self.env={'GITHUB_REPOSITORY':m.REPOSITORY,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':m.REF,'QUALIFICATION_MODE':m.MODE,'FINALIZATION_REGRESSION_INTENT':m.INTENT,'QUALIFICATION_REPOSITORY_PRIVATE':'false','CANDIDATE_SHA':'a'*40,'GITHUB_SHA':'a'*40,'QUALIFICATION_WORKFLOW_SHA':'a'*40,'GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1','RUNNER_OS':'Linux','RUNNER_ARCH':'X64'}
 def call(self,e=None,system='Linux',machine='x86_64',uid=1001,gid=1001):return m.validate(self.env if e is None else e,system,machine,uid,gid)
 def test_approved_exact_context(self):self.assertEqual(self.call(),'a'*40)
 def test_every_authority_field_rejects_missing(self):
  for key in self.env:
   with self.subTest(key=key):
    env=self.env.copy();del env[key]
    with self.assertRaises(AssertionError):self.call(env)
 def test_production_and_old_modes_and_attempts_rejected(self):
  for key,value in [('GITHUB_REF','refs/heads/main'),('GITHUB_REF','refs/heads/repair/unattended-20261020'),('QUALIFICATION_MODE','native-empty-restart'),('GITHUB_RUN_ATTEMPT','2'),('QUALIFICATION_REPOSITORY_PRIVATE','true'),('FINALIZATION_REGRESSION_INTENT','')]:
   with self.subTest(key=key,value=value):
    env={**self.env,key:value}
    with self.assertRaises(AssertionError):self.call(env)
 def test_digest_mismatch_or_injection_rejected(self):
  for key,value in [('CANDIDATE_SHA','x'*40),('GITHUB_SHA','b'*40),('QUALIFICATION_WORKFLOW_SHA','b'*40),('GITHUB_RUN_ID','1;echo bad')]:
   with self.subTest(key=key):
    with self.assertRaises(AssertionError):self.call({**self.env,key:value})
 def test_non_native_and_root_rejected(self):
  for args in [('Darwin','arm64',1001,1001),('Linux','aarch64',1001,1001),('Linux','x86_64',0,1001),('Linux','x86_64',1001,0)]:
   with self.subTest(args=args):
    with self.assertRaises(AssertionError):self.call(None,*args)
if __name__=='__main__':unittest.main()

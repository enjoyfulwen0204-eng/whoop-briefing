import pathlib,importlib.util,unittest,copy,math
p=pathlib.Path(__file__).with_name('cpu-sensor-ci.py');s=importlib.util.spec_from_file_location('sensor_control',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Gates(unittest.TestCase):
 def setUp(self):
  self.env={'GITHUB_REPOSITORY':m.h.REPOSITORY,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':m.REF,'QUALIFICATION_MODE':m.MODE,'FIRST20_DIAGNOSTIC_INTENT':m.INTENT,'QUALIFICATION_REPOSITORY_PRIVATE':'false','CANDIDATE_SHA':'a'*40,'GITHUB_SHA':'a'*40,'QUALIFICATION_WORKFLOW_SHA':'a'*40,'GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':'123','RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_JOB':'native-cpu-sensor-diagnostic'}
  self.value={'contract':'native-cpu-sensor-compatibility-no-health-work-v1','candidateSHA':'a'*40,'status':'SENSOR_COMPATIBLE_NO_WORK','observation':{'checks':dict.fromkeys(['ownedChild','clockTicks','rootCgroups','quota','ownedStat','containerStat','clientCounters','monotonicEndpoints'],'PASS'),'knownDottedExtensionSeen':True,'legacySyntaxWouldReject':True},'ownedChildExited':True,'ownedTemporaryDirectoryRemoved':True,'elapsedMs':40,'previousRunRootCauseProven':False,'healthWorkloadsExecuted':0,'applicationSQLStatementsIssued':0,'productionEvidence':False,'EOFQualified':False,'sixJobCompletionQualified':False,'capacityQualified':False}
 def test_fixed_identity(self):self.assertEqual(m.validate(self.env,'Linux','x86_64',1001,1001),'a'*40)
 def test_missing_or_changed_authority(self):
  for key in self.env:
   with self.subTest(missing=key):
    changed=self.env.copy();del changed[key]
    with self.assertRaises(AssertionError):m.validate(changed,'Linux','x86_64',1001,1001)
  for key,value in [('GITHUB_REF','refs/heads/diagnostic/stage6-recovery17-cpu-cost-20261025'),('FIRST20_DIAGNOSTIC_INTENT','one-original-recovery17-cpu-cost-v1'),('GITHUB_RUN_ATTEMPT','2'),('GITHUB_SHA','b'*40),('GITHUB_JOB','other')]:
   with self.subTest(changed=key):
    with self.assertRaises(AssertionError):m.validate({**self.env,key:value},'Linux','x86_64',1001,1001)
 def test_non_native_or_root(self):
  for args in [('Darwin','arm64',1001,1001),('Linux','aarch64',1001,1001),('Linux','x86_64',0,1001),('Linux','x86_64',1001,0)]:
   with self.assertRaises(AssertionError):m.validate(self.env,*args)
 def test_closed_valid_sensor_only(self):self.assertTrue(m.validate_observed(self.value,'a'*40))
 def test_missing_extra_or_unsafe_output(self):
  for key in self.value:
   v=copy.deepcopy(self.value);del v[key]
   with self.subTest(missing=key):
    with self.assertRaises(AssertionError):m.validate_observed(v,'a'*40)
  for key,value in [('candidateSHA','b'*40),('productionEvidence',True),('previousRunRootCauseProven',True),('healthWorkloadsExecuted',False),('applicationSQLStatementsIssued',1),('elapsedMs',math.nan),('elapsedMs',math.inf),('elapsedMs',-1),('elapsedMs',True),('ownedChildExited',False),('rawSQL','PRIVATE')]:
   v=copy.deepcopy(self.value);v[key]=value
   with self.subTest(changed=key):
    with self.assertRaises(AssertionError):m.validate_observed(v,'a'*40)
 def test_unknowns_remain_negative(self):
  for key in self.value['observation']['checks']:
   for state in ['UNKNOWN','FAIL']:
    v=copy.deepcopy(self.value);v['observation']['checks'][key]=state
    with self.assertRaises(AssertionError):m.validate_observed(v,'a'*40)
    v['status']='SENSOR_UNKNOWN_NO_WORK';self.assertTrue(m.validate_observed(v,'a'*40))
  v=copy.deepcopy(self.value);v['observation']=None;v['status']='SENSOR_UNKNOWN_NO_WORK';self.assertTrue(m.validate_observed(v,'a'*40))
if __name__=='__main__':unittest.main()

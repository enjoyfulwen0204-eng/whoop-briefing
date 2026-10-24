"""Principal snapshot repair gates: fake tools only; no Docker, Git, native DB or network."""
import importlib.util,json,pathlib,tempfile,unittest,hashlib,re
from unittest.mock import patch
HERE=pathlib.Path(__file__).parent;ROOT=HERE.parent.parent
spec=importlib.util.spec_from_file_location('principal_snapshot_repair_control',HERE/'native-empty-principal-snapshot-repair-ci.py')
control=importlib.util.module_from_spec(spec);spec.loader.exec_module(control)
EXPECTED_SHA='c'*40
ENV={'NATIVE_PRINCIPAL_SNAPSHOT_REPAIR_RUN_INTENT':'one-original-empty-120s-principal-snapshot-repair-v1','GITHUB_REPOSITORY':control.REPOSITORY,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':control.REF,'QUALIFICATION_MODE':'native-empty-principal-snapshot-repair','QUALIFICATION_REPOSITORY_PRIVATE':'false','CANDIDATE_SHA':EXPECTED_SHA,'GITHUB_SHA':EXPECTED_SHA,'QUALIFICATION_WORKFLOW_SHA':EXPECTED_SHA,'RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1'}
ALLOWED=['M\tsrc/processingReadSnapshot.js','M\tsrc/processingTransaction.js','M\t.github/workflows/stage8-live-linux-qualification.yml','A\t'+control.REGRESSION_TEST,'A\ttools/stage8-qualification/native-empty-principal-snapshot-repair-ci.py','A\ttools/stage8-qualification/native-empty-principal-snapshot-repair-ci.test.py']
APPLICATION='\n'.join('M\t'+p for p in sorted(control.REPAIR_SOURCE_HASHES))
OLD_JOB_HASHES={'qualify': 'a83fd02c0c02715d9a1c1ef229dbb92c05a689d8788006d5492c0e4cf89e17e1', 'native-empty-restart': 'd525affc956e231e4601031c8c91be1eb665b72f2ca4c32b16c52c4a41d00317', 'one-original-attribution-diagnostic': '3249c659a70bdd4f3c1a43295c04d2891a4aa655d83be329714c5b04bba11051', 'schema-metadata-repair-verification': 'a1fb10a08e7a4ade0b0d48e408dec59e424586fea3e8b9593bf26150844c2db8'}
ORIGINAL_FIXED_HASHES={'test/stage6-linux-native-diagnostic.mjs': '06e84dd0910b3083fc64c6993a0fa43c65311e64f74a2a893edcffcbd0dfc2b9', 'test/stage6-linux-native-diagnostic.sh': 'ce2e16bdf452abe025bb8b31ff7643333dd10dc169b61fd80559111cb117c2c8', 'test/stage6-native-diagnostic-contract.mjs': 'b10566ebb3ed4a3bc2e5e3463316fd5c08d63db411f0f4c1d44ea95533376534', 'test/stage6-native-diagnostic-observer.mjs': '533e3286e7b37f9b1bc604ef4ce902dc2747bbf27e86660b098d8850587cb2d4', 'test/stage6-native-attribution.mjs': 'fb0db1b5f3821f014c45116fec704f93dce27d7b1be7a80567313303b4f37334', 'tools/stage8-qualification/native-empty-diagnostic-ci.py': '342365ba1b228413dad7fb203bdbb0be5f8ff9cce60dcac77dbb3f5e58da2496', 'tools/stage8-qualification/native-empty-diagnostic-ci.test.py': 'ab35c46a3a7037cf788176f9d1ace5b5509e7ce93042c1d33994e70e0f48e6a8', 'tools/stage8-qualification/native-empty-metadata-repair-ci.py': '1526b15242dbb48a8abea8a37301d803529f9697b818df0d169221ab382dcebe', 'tools/stage8-qualification/native-empty-metadata-repair-ci.test.py': 'd2dcf744ed2eade0860c90bab894fcd0c78faab8755186badaa402dd4485a4a8', 'tools/stage8-qualification/Dockerfile.native-empty-ci': 'a4f79af6c9e40765d677c3f7472c004ab0c9085403692f7ad438761246d36d78'}
class RepairControlTests(unittest.TestCase):
 def valid_gate(self,changes=None):
  with patch.dict(control.os.environ,{**ENV,**(changes or {})},clear=True),patch.object(control.platform,'system',return_value='Linux'),patch.object(control.platform,'machine',return_value='x86_64'),patch.object(control.os,'getuid',return_value=1001),patch.object(control.os,'getgid',return_value=1001),patch.object(control,'run',side_effect=AssertionError('NO_REAL_GIT_DOCKER_NETWORK')):
   return control.gate()
 def fake_source(self,src=APPLICATION,changed=None,badpin=None,test_delta=None,bad_source=None,parent=None):
  calls=[]
  def fake(args,seconds=10):
   self.assertEqual(args[0],'git');calls.append(args)
   if 'diff' in args:
    if args[-2:]==['--','src']:return src
    if args[-2:]==['--','test']:return 'A\t'+control.REGRESSION_TEST if test_delta is None else test_delta
    return '\n'.join(ALLOWED if changed is None else changed)
   self.assertIn('rev-parse',args)
   if args[-1]==EXPECTED_SHA+'^':return parent if parent is not None else control.REPAIR_BASE
   return 'WRONG' if badpin and args[-1]==EXPECTED_SHA+':'+badpin else 'SAME_PIN'
  def fake_sha(path):
   rel=str(path.relative_to('/synthetic-checkout'))
   return '0'*64 if rel==bad_source else control.REGRESSION_TEST_SHA256 if rel==control.REGRESSION_TEST else control.REPAIR_SOURCE_HASHES[rel]
  with patch.object(control,'run',fake),patch.object(control,'sha',fake_sha),patch.object(control.subprocess,'run',side_effect=AssertionError('NO_REAL_PROCESS')):
   control.repair_sources(pathlib.Path('/synthetic-checkout'),EXPECTED_SHA)
  return calls
 def test_explicit_mode_branch_intent_attempt_and_same_three_shas(self):
  self.assertEqual(self.valid_gate(),EXPECTED_SHA)
  for key,value in [('NATIVE_PRINCIPAL_SNAPSHOT_REPAIR_RUN_INTENT','one-original-empty-120s-metadata-repair-v1'),('GITHUB_REF','refs/heads/diagnostic/schema-metadata-snapshot-20261020'),('QUALIFICATION_MODE','native-empty-metadata-repair'),('GITHUB_SHA','d'*40),('QUALIFICATION_WORKFLOW_SHA','e'*40),('QUALIFICATION_REPOSITORY_PRIVATE','true'),('GITHUB_RUN_ATTEMPT','2'),('RUNNER_ARCH','ARM64')]:
   with self.subTest(key=key),self.assertRaises(AssertionError):self.valid_gate({key:value})
 def test_no_intent_rejects_before_source_or_tools(self):
  with patch.dict(control.os.environ,{},clear=True),patch.object(control,'run',side_effect=AssertionError('NO_TOOLS')),patch.object(control,'paths',side_effect=AssertionError('NO_PATHS')):
   with self.assertRaisesRegex(AssertionError,'EXPLICIT_SEPARATE_PRINCIPAL_SNAPSHOT_REPAIR'):control.main()
 def test_exact_three_source_hashes_parent_and_six_file_batch(self):
  self.assertTrue(self.fake_source())
  for src in ['',APPLICATION+'\nM\tsrc/stage8LiveProducer.js',APPLICATION.replace('M\tsrc/processingTransaction.js','D\tsrc/processingTransaction.js')]:
   with self.subTest(src=src),self.assertRaisesRegex(AssertionError,'EXACT_THREE_REVIEWED_APPLICATION'):self.fake_source(src=src)
  for extra in ['A\t.private-health.json','M\tpackage-lock.json','M\ttest/stage6-linux-native-diagnostic.mjs']:
   with self.subTest(extra=extra),self.assertRaisesRegex(AssertionError,'EXACT_NEW_REPAIR_VERIFICATION_BATCH'):self.fake_source(changed=ALLOWED+[extra])
  with self.assertRaisesRegex(AssertionError,'EXACT_REVIEWED_REPAIR_PARENT'):self.fake_source(parent='d'*40)
  for path in control.REPAIR_SOURCE_HASHES:
   with self.subTest(path=path),self.assertRaisesRegex(AssertionError,'EXACT_REVIEWED_REPAIR_SOURCE_SHA'):self.fake_source(bad_source=path)
 def test_only_new_public_test_delta_and_all_old_inputs_immutable(self):
  for delta in ['', 'A\t'+control.REGRESSION_TEST+'\nM\ttest/fixture.js','M\t'+control.REGRESSION_TEST]:
   with self.subTest(delta=delta),self.assertRaisesRegex(AssertionError,'EXACT_ONE_NEW_TEST'):self.fake_source(test_delta=delta)
  with self.assertRaisesRegex(AssertionError,'EXACT_REVIEWED_PUBLIC_REGRESSION_TEST_SHA'):self.fake_source(bad_source=control.REGRESSION_TEST)
  for path in ['scripts','package.json','package-lock.json',*ORIGINAL_FIXED_HASHES]:
   with self.subTest(path=path),self.assertRaises(AssertionError):self.fake_source(badpin=path)
  for path,pin in control.REPAIR_SOURCE_HASHES.items():self.assertEqual(control.sha(ROOT/path),pin)
  self.assertEqual(control.sha(ROOT/control.REGRESSION_TEST),control.REGRESSION_TEST_SHA256)
 def test_old_jobs_and_fixtures_exact_only_new_job_authority(self):
  workflow=(ROOT/'.github/workflows/stage8-live-linux-qualification.yml').read_text()
  for name,expected in OLD_JOB_HASHES.items():
   start=workflow.index('  '+name+':\n');following=[m.start() for m in re.finditer(r'^  [a-z][a-z0-9-]+:\n',workflow,re.M) if m.start()>start];body=workflow[start:min(following) if following else len(workflow)].rstrip()+'\n'
   self.assertEqual(hashlib.sha256(body.encode()).hexdigest(),expected)
  new=workflow[workflow.index('  principal-snapshot-repair-verification:\n'):]
  for text in ["inputs.mode == 'native-empty-principal-snapshot-repair'",'inputs.candidate_sha == github.sha && github.workflow_sha == github.sha',control.REF,'one-original-empty-120s-principal-snapshot-repair-v1','persist-credentials: false','runs-on: ubuntu-24.04']:self.assertIn(text,new)
  self.assertIn('permissions:\n  contents: read\n',workflow);self.assertEqual(new.count('uses:'),1)
  for denied in ['upload-artifact','actions/cache','secrets.','id-token:','contents: write','pull_request','workflow_run']:self.assertNotIn(denied,new)
  for path,expected in ORIGINAL_FIXED_HASHES.items():self.assertEqual(hashlib.sha256((ROOT/path).read_bytes()).hexdigest(),expected)
 def test_resource_wall_and_unknown_retention_unchanged(self):
  source=(HERE/'native-empty-principal-snapshot-repair-ci.py').read_text()
  for required in ["child.wait(timeout=120)","time.monotonic()-at>120","--network','none'","--memory','536870912'","--memory-swap','536870912'","--cpus','0.5'","--pids-limit','128'","--read-only'","--cap-drop','ALL'","NO_FORCE_REMOVAL","'capacityQualified':False","'DIAGNOSTIC_WALL_OR_SETTLEMENT_UNKNOWN_RUNTIME_RETAINED'"]:self.assertIn(required,source)
  for denied in ["docker','kill", "docker','stop", "docker','rm','-f",'system prune','container prune','volume prune']:self.assertNotIn(denied,source)
  self.assertNotIn('/'+'Users/',source)
 def test_cleanup_only_cannot_run_original_or_source_checks(self):
  with tempfile.TemporaryDirectory() as temporary:
   sandbox=pathlib.Path(temporary)
   with patch.object(control,'gate',return_value=EXPECTED_SHA),patch.object(control.sys,'argv',['control','--cleanup-only']),patch.object(control,'paths',return_value=(sandbox,'owned','image')),patch.object(control,'owned_cleanup',return_value=True) as cleanup,patch.object(control,'repair_sources',side_effect=AssertionError('NO_SOURCE_ORIGINAL_RUN')),patch.object(control,'run',side_effect=AssertionError('NO_TOOLS')),patch.object(control.subprocess,'Popen',side_effect=AssertionError('NO_ORIGINAL_CALL')):
    self.assertEqual(control.main(),0);cleanup.assert_called_once_with(sandbox,'owned')
if __name__=='__main__':unittest.main(verbosity=2)

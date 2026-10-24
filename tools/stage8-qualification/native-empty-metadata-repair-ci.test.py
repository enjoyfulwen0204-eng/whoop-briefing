"""New repair source/branch/permission pure controls. Never Docker/Git/network."""
import importlib.util,json,pathlib,tempfile,unittest,hashlib,re
from unittest.mock import patch
HERE=pathlib.Path(__file__).parent;ROOT=HERE.parent.parent
spec=importlib.util.spec_from_file_location('metadata_repair_control',HERE/'native-empty-metadata-repair-ci.py')
control=importlib.util.module_from_spec(spec);spec.loader.exec_module(control)
EXPECTED_SHA='c'*40
ENV={'NATIVE_METADATA_REPAIR_RUN_INTENT':'one-original-empty-120s-metadata-repair-v1','GITHUB_REPOSITORY':control.REPOSITORY,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':control.REF,'QUALIFICATION_MODE':'native-empty-metadata-repair','QUALIFICATION_REPOSITORY_PRIVATE':'false','CANDIDATE_SHA':EXPECTED_SHA,'GITHUB_SHA':EXPECTED_SHA,'QUALIFICATION_WORKFLOW_SHA':EXPECTED_SHA,'RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_RUN_ID':'123','GITHUB_RUN_ATTEMPT':'1'}
ALLOWED=['M\tsrc/phase4Migrations.js','M\t.github/workflows/stage8-live-linux-qualification.yml','A\ttools/stage8-qualification/native-empty-metadata-repair-ci.py','A\ttools/stage8-qualification/native-empty-metadata-repair-ci.test.py']
OLD_JOB_HASHES={'qualify': 'a83fd02c0c02715d9a1c1ef229dbb92c05a689d8788006d5492c0e4cf89e17e1', 'native-empty-restart': 'd525affc956e231e4601031c8c91be1eb665b72f2ca4c32b16c52c4a41d00317', 'one-original-attribution-diagnostic': '3249c659a70bdd4f3c1a43295c04d2891a4aa655d83be329714c5b04bba11051'}
ORIGINAL_FIXED_HASHES={'test/stage6-linux-native-diagnostic.mjs': '06e84dd0910b3083fc64c6993a0fa43c65311e64f74a2a893edcffcbd0dfc2b9', 'test/stage6-linux-native-diagnostic.sh': 'ce2e16bdf452abe025bb8b31ff7643333dd10dc169b61fd80559111cb117c2c8', 'test/stage6-native-diagnostic-contract.mjs': 'b10566ebb3ed4a3bc2e5e3463316fd5c08d63db411f0f4c1d44ea95533376534', 'test/stage6-native-diagnostic-observer.mjs': '533e3286e7b37f9b1bc604ef4ce902dc2747bbf27e86660b098d8850587cb2d4', 'test/stage6-native-attribution.mjs': 'fb0db1b5f3821f014c45116fec704f93dce27d7b1be7a80567313303b4f37334', 'tools/stage8-qualification/native-empty-diagnostic-ci.py': '342365ba1b228413dad7fb203bdbb0be5f8ff9cce60dcac77dbb3f5e58da2496', 'tools/stage8-qualification/native-empty-diagnostic-ci.test.py': 'ab35c46a3a7037cf788176f9d1ace5b5509e7ce93042c1d33994e70e0f48e6a8', 'tools/stage8-qualification/Dockerfile.native-empty-ci': 'a4f79af6c9e40765d677c3f7472c004ab0c9085403692f7ad438761246d36d78'}
class RepairControlTests(unittest.TestCase):
 def valid_gate(self,changes=None):
  with patch.dict(control.os.environ,{**ENV,**(changes or {})},clear=True),patch.object(control.platform,'system',return_value='Linux'),patch.object(control.platform,'machine',return_value='x86_64'),patch.object(control.os,'getuid',return_value=1001),patch.object(control.os,'getgid',return_value=1001),patch.object(control,'run',side_effect=AssertionError('NO_REAL_GIT_DOCKER_NETWORK')):
   return control.gate()
 def fake_source(self,src='M\tsrc/phase4Migrations.js',changed=None,badpin=None):
  calls=[]
  def fake(args,seconds=10):
   self.assertEqual(args[0],'git');calls.append(args)
   if 'diff' in args:return src if args[-2:]==['--','src'] else '\n'.join(ALLOWED if changed is None else changed)
   self.assertIn('rev-parse',args);return 'WRONG' if badpin and args[-1]==EXPECTED_SHA+':'+badpin else 'SAME_PIN'
  with patch.object(control,'run',fake),patch.object(control,'sha',return_value=control.REPAIR_SOURCE_SHA256),patch.object(control.subprocess,'run',side_effect=AssertionError('NO_REAL_PROCESS')):
   control.repair_sources(pathlib.Path('/synthetic-checkout'),EXPECTED_SHA)
  return calls
 def test_new_mode_branch_intent_and_three_sha_gate(self):
  self.assertEqual(self.valid_gate(),EXPECTED_SHA)
  for key,value in [('NATIVE_METADATA_REPAIR_RUN_INTENT','one-original-empty-120s-v1'),('GITHUB_REF','refs/heads/diagnostic/native-empty-attribution-20261020'),('QUALIFICATION_MODE','native-empty-attribution'),('GITHUB_SHA','d'*40),('QUALIFICATION_WORKFLOW_SHA','e'*40),('QUALIFICATION_REPOSITORY_PRIVATE','true'),('GITHUB_RUN_ATTEMPT','2'),('RUNNER_ARCH','ARM64')]:
   with self.subTest(key=key),self.assertRaises(AssertionError):self.valid_gate({key:value})
 def test_no_intent_main_refuses_before_source_or_tools(self):
  with patch.dict(control.os.environ,{},clear=True),patch.object(control,'run',side_effect=AssertionError('NO_TOOLS')),patch.object(control,'paths',side_effect=AssertionError('NO_PATHS')):
   with self.assertRaisesRegex(AssertionError,'EXPLICIT_SEPARATE_METADATA_REPAIR'):control.main()
 def test_exact_one_approved_source_delta_and_original_inputs_required(self):
  self.assertTrue(self.fake_source())
  for src in ['', 'M\tsrc/phase4Migrations.js\nM\tsrc/stage8LiveProducer.js','D\tsrc/phase4Migrations.js','R100\tsrc/phase4Migrations.js\tsrc/other.js']:
   with self.subTest(src=src),self.assertRaisesRegex(AssertionError,'EXACT_ONE_REVIEWED_APPLICATION'):self.fake_source(src=src)
  for extra in ['A\t.private-health.json','M\tpackage-lock.json','M\ttest/stage6-linux-native-diagnostic.mjs']:
   with self.subTest(extra=extra),self.assertRaisesRegex(AssertionError,'EXACT_NEW_REPAIR_VERIFICATION_BATCH'):self.fake_source(changed=ALLOWED+[extra])
  for path in ['test','scripts','package.json','package-lock.json','tools/stage8-qualification/Dockerfile.native-empty-ci','tools/stage8-qualification/native-empty-diagnostic-ci.py']:
   with self.subTest(path=path),self.assertRaises(AssertionError):self.fake_source(badpin=path)
 def test_approved_source_bytes_are_mandatory_and_materialized_exactly(self):
  self.assertEqual(control.sha(ROOT/'src/phase4Migrations.js'),control.REPAIR_SOURCE_SHA256)
  with patch.object(control,'run',return_value='M\tsrc/phase4Migrations.js'),patch.object(control,'sha',return_value='0'*64):
   with self.assertRaisesRegex(AssertionError,'EXACT_REVIEWED_METADATA_REPAIR_SHA'):control.repair_sources(pathlib.Path('/synthetic-checkout'),EXPECTED_SHA)
 def test_old_jobs_and_fixtures_remain_exact_with_only_new_job_authority(self):
  workflow=(ROOT/'.github/workflows/stage8-live-linux-qualification.yml').read_text()
  for name,expected in OLD_JOB_HASHES.items():
   start=workflow.index('  '+name+':\n');following=[m.start() for m in re.finditer(r'^  [a-z][a-z0-9-]+:\n',workflow,re.M) if m.start()>start];body=workflow[start:min(following) if following else len(workflow)].rstrip()+'\n'
   self.assertEqual(hashlib.sha256(body.encode()).hexdigest(),expected)
  new=workflow[workflow.index('  schema-metadata-repair-verification:\n'):]
  self.assertIn("inputs.mode == 'native-empty-metadata-repair'",new);self.assertIn('inputs.candidate_sha == github.sha && github.workflow_sha == github.sha',new)
  self.assertIn('permissions:\n  contents: read\n',workflow);self.assertEqual(new.count('uses:'),1);self.assertIn('persist-credentials: false',new);self.assertIn('runs-on: ubuntu-24.04',new)
  for denied in ['upload-artifact','actions/cache','secrets.','id-token:','contents: write','pull_request','workflow_run']:self.assertNotIn(denied,new)
  for path,expected in ORIGINAL_FIXED_HASHES.items():self.assertEqual(hashlib.sha256((ROOT/path).read_bytes()).hexdigest(),expected)
 def test_resources_deadline_and_unresolved_cleanup_not_expanded(self):
  source=(HERE/'native-empty-metadata-repair-ci.py').read_text()
  for required in ["child.wait(timeout=120)","time.monotonic()-at>120","--network','none'","--memory','536870912'","--cpus','0.5'","--pids-limit','128'","--read-only'","--cap-drop','ALL'","NO_FORCE_REMOVAL","'capacityQualified':False","'DIAGNOSTIC_WALL_OR_SETTLEMENT_UNKNOWN_RUNTIME_RETAINED'"]:self.assertIn(required,source)
  for denied in ["docker','kill", "docker','stop", "docker','rm','-f",'system prune','container prune','volume prune']:self.assertNotIn(denied,source)
  self.assertNotIn('/'+'Users/',source);self.assertNotIn('WHOOP-'+'Private-Recovery',source)
if __name__=='__main__':unittest.main(verbosity=2)

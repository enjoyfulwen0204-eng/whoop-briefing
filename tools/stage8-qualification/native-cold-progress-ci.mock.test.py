"""Pure/fake source tests. No controller main, Git, Docker, native, DB or network."""
import base64,contextlib,copy,importlib.util,io,json,pathlib,tempfile,unittest
from unittest.mock import patch
HERE=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('cold_control',HERE/'native-cold-progress-ci.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
H=lambda n:format(n,'064x')
RAW=lambda value:c.canonical(value).encode()

def bundles():
 env={'CANDIDATE_SHA':'a'*40,'GITHUB_SHA':'a'*40,'QUALIFICATION_WORKFLOW_SHA':'a'*40}
 review={'contract':'stage6-native-cold-host-independent-source-review-v1','sourceReady':True,'executionAuthorized':False,'applicationBaselineSha':c.APP_BASE,'sourceManifestSha256':H(1),'reviewOriginSha256':H(2),'profile':c.PROFILE}
 review_raw=RAW(review)
 choice={'contract':'root-technical-native-cold-progress-source-choice-v1','sourceGO':True,'nativeExecutionGO':True,'candidateSha':'a'*40,'applicationBaselineSha':c.APP_BASE,'sourceManifestSha256':H(1),'independentSourceReviewSha256':c.digest(review_raw),'operationId':H(3),'issuedAtMs':1000,'expiresAtMs':2000,'profile':c.PROFILE,'maximumDispatchAttempts':1,'maximumRunAttempts':1,'maximumOriginalCalls':3,'processLegs':2,'nativeWallMs':300000,'buildMaximumSeconds':360,'syntheticOnly':True,'productionActionsAuthorized':False,'maintenanceAuthorized':False,'newOwnerMaintenanceApprovalClaimed':False}
 choice_raw=RAW(choice)
 selection={'candidateSha':'a'*40,'applicationBaselineSha':c.APP_BASE,'sourceManifestSha256':H(1),'rootChoiceSha256':c.digest(choice_raw),'independentReviewSha256':c.digest(review_raw),'operationId':H(3),'repository':c.REPOSITORY,'ref':c.REF,'mode':c.MODE,'profile':c.PROFILE}
 intent={'contract':'root-one-original-native-cold-dispatch-intent-v1','dispatchGO':True,**selection,'maximumDispatchAttempts':1,'automaticRedispatchAllowed':False,'selectionSha256':c.digest(RAW(selection))}
 return env,choice,review,intent

def binding():
 env,choice,review,intent=bundles();return c.validate_bundles(env,RAW(choice),RAW(review),RAW(intent),1500)

def reports():
 bind=binding();host={'nativeStartedMonotonicNs':'1000000000000','candidateSha':bind['candidateSha']}
 bins={phase:{'requestErrors':0,'responseErrors':0,'unknownReplies':0,'transactions':{'open':0,'unknownTerminal':0}} for phase in c.PHASES}
 resources={'node':'v22.23.2','architecture':'x64','platform':'linux','nativeHost':host,'memoryMax':'536870912','swapMax':'0','cpuMax':'50000 100000','interfaces':['lo'],'memoryPeak':'123456','memoryEvents':'oom 0\noom_kill 0\n'}
 attribution={'adapter':{'terminalComplete':True,'coverageComplete':True,'activeFetches':0,'unresolvedStreams':0,'droppedObservations':0,'unknownProtocolReplies':0},'physicalTerminalObservationComplete':True,'bins':bins}
 common={'candidateSha':bind['candidateSha'],'applicationBaselineSha':c.APP_BASE,'activationHash':H(5),'productionEvidence':False,'capacityQualified':False,'wholeJobCompletionQualified':False,'actualNativeQualified':False,'resources':resources,'attribution':attribution,'serverPid':99,'physicalIdentityHash':H(8)}
 state={'initialized':True,'inputGeneration':2,'lastCompletedGeneration':0,'sourceRows':0,'outboundMessages':0,'pilotLedgers':0,'currentPublications':0,'jobs':[{'kind':kind,'state':'PENDING','requestedGeneration':2,'completedGeneration':0} for kind in ['RECOMPUTE_DERIVED','REPAIR_CURRENTNESS']]}
 carry={'callsStarted':2,'pidA':101,'requestIds':c.REQUESTS,'deadlineMs':1300000.0,'afterA':state,'steps':[{'selectedJobKind':'RECOMPUTE_DERIVED'},{'selectedJobKind':'REPAIR_CURRENTNESS'}]}
 a={**copy.deepcopy(common),'phase':'A','callsStarted':2,'pid':101,'status':'TWO_PRODUCTIVE_ORIGINALS_AWAIT_NEW_OS_LEG','carry':carry,'canonicalBoundaryDigest':c.digest(RAW(state))}
 b={**copy.deepcopy(common),'phase':'B','callsStarted':3,'pid':202,'status':'ACTUAL_THREE_ORIGINAL_CALLS_COLD_PARTIAL_METADATA_OBSERVED','metadataProof':{'callsStarted':3,'sameGeneration':True,'originalReceiptsPreserved':True,'coldCursorResumeMetadataObserved':True,'originalJobsCompleted':0,'actualNativeQualified':False,'capacityQualified':False,'wholeJobCompletionQualified':False,'steps':[{'selectedJobKind':'RECOMPUTE_DERIVED'}]}}
 return bind,host,a,b

class PureContracts(unittest.TestCase):
 def setUp(self):
  self.no_run=patch.object(c.subprocess,'run',side_effect=AssertionError('EXTERNAL_SUBPROCESS_FORBIDDEN'));self.no_run.start()
  self.no_popen=patch.object(c.subprocess,'Popen',side_effect=AssertionError('EXTERNAL_SUBPROCESS_FORBIDDEN'));self.no_popen.start()
 def tearDown(self):self.no_popen.stop();self.no_run.stop()
 def test_exact_new_scope_binds_candidate_review_choice_and_dispatch(self):
  got=binding();self.assertEqual(got['candidateSha'],'a'*40);self.assertNotEqual(got['candidateSha'],c.APP_BASE)
 def test_old_consumed_or_wrong_scope_cannot_be_reinterpreted(self):
  env,choice,review,intent=bundles()
  for change in [lambda x:x.update(profile='one-original-empty-120s-v1'),lambda x:x.update(maximumOriginalCalls=1),lambda x:x.update(maximumOriginalCalls=24),lambda x:x.update(nativeWallMs=900000),lambda x:x.update(nativeWallMs=120000),lambda x:x.update(processLegs=1),lambda x:x.update(maximumDispatchAttempts=2),lambda x:x.update(maximumRunAttempts=2),lambda x:x.update(productionActionsAuthorized=True),lambda x:x.update(maintenanceAuthorized=True),lambda x:x.update(newOwnerMaintenanceApprovalClaimed=True),lambda x:x.update(candidateSha=c.APP_BASE),lambda x:x.update(syntheticOnly=1),lambda x:x.update(sourceGO=False),lambda x:x.update(nativeExecutionGO=False)]:
   with self.subTest(change=change):
    altered=copy.deepcopy(choice);change(altered)
    with self.assertRaises(AssertionError):c.validate_bundles(env,RAW(altered),RAW(review),RAW(intent),1500)
 def test_modified_review_bytes_or_missing_real_review_refuse(self):
  env,choice,review,intent=bundles()
  for raw in [b'{}',RAW({**review,'executionAuthorized':True}),RAW({**review,'sourceReady':False}),RAW({**review,'sourceManifestSha256':H(99)})]:
   with self.assertRaises(AssertionError):c.validate_bundles(env,RAW(choice),raw,RAW(intent),1500)
 def test_choice_intent_candidate_manifest_or_selection_rebinding_refuses(self):
  env,choice,review,intent=bundles()
  for key,value in [('rootChoiceSha256',H(77)),('sourceManifestSha256',H(77)),('operationId',H(77)),('candidateSha','b'*40),('independentReviewSha256',H(77)),('ref','refs/heads/main'),('profile','OLD_SCOPE'),('selectionSha256',H(77)),('maximumDispatchAttempts',2),('automaticRedispatchAllowed',True),('dispatchGO',False)]:
   with self.subTest(key=key):
    changed={**intent,key:value}
    with self.assertRaises(AssertionError):c.validate_bundles(env,RAW(choice),RAW(review),RAW(changed),1500)
 def test_no_native_after_original_choice_expiry_and_cleanup_not_launch(self):
  env,choice,review,intent=bundles()
  for now in [999,2000,3000]:
   with self.assertRaises(AssertionError):c.validate_bundles(env,RAW(choice),RAW(review),RAW(intent),now)
  self.assertEqual(c.validate_bundles(env,RAW(choice),RAW(review),RAW(intent),3000,launch=False)['candidateSha'],'a'*40)
 def test_no_head_spoof_or_workflow_version_injection(self):
  env,choice,review,intent=bundles()
  for field in ['CANDIDATE_SHA','GITHUB_SHA','QUALIFICATION_WORKFLOW_SHA']:
   with self.assertRaises(AssertionError):c.validate_bundles({**env,field:'b'*40},RAW(choice),RAW(review),RAW(intent),1500)
 def test_root_bundles_are_finite_and_explicit(self):
  for value in [None,'','not-base64','A'*20001,base64.b64encode(b'[]').decode()]:
   with self.assertRaises(Exception):c.decode_bundle(value)
  raw,value=c.decode_bundle(base64.b64encode(b'{"synthetic":true}').decode());self.assertEqual(value,{'synthetic':True})
 def test_unknown_extra_root_payload_refuses(self):
  env,choice,review,intent=bundles()
  with self.assertRaises(AssertionError):c.validate_bundles(env,RAW({**choice,'health':'SYNTHETIC_PRIVATE_CANARY'}),RAW(review),RAW(intent),1500)
 def test_excess_window_or_boolean_counts_refuse(self):
  env,choice,review,intent=bundles()
  for fields in [{'expiresAtMs':1801001},{'issuedAtMs':True},{'maximumDispatchAttempts':True}]:
   with self.assertRaises(AssertionError):c.validate_bundles(env,RAW({**choice,**fields}),RAW(review),RAW(intent),1500)
 def test_manual_context_and_root_bundle_gate_runs_without_external_io(self):
  env,choice,review,intent=bundles();env.update({'GITHUB_REPOSITORY':c.REPOSITORY,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':c.REF,'QUALIFICATION_MODE':c.MODE,'QUALIFICATION_REPOSITORY_PRIVATE':'false','NATIVE_COLD_RUN_INTENT':c.PROFILE,'RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':'123'})
  for key,value in [('ROOT_NATIVE_COLD_CHOICE_B64',choice),('ROOT_NATIVE_COLD_REVIEW_B64',review),('ROOT_NATIVE_COLD_INTENT_B64',intent)]:env[key]=base64.b64encode(RAW(value)).decode()
  with patch.object(c.platform,'system',return_value='Linux'),patch.object(c.platform,'machine',return_value='x86_64'),patch.object(c.os,'getuid',return_value=1001),patch.object(c.os,'getgid',return_value=1001),patch.object(c.time,'time_ns',return_value=1500000000):
   self.assertEqual(c.gate(env)['candidateSha'],'a'*40)
   for key,value in [('GITHUB_RUN_ATTEMPT','2'),('GITHUB_EVENT_NAME','schedule'),('GITHUB_REF','refs/heads/main'),('QUALIFICATION_MODE','native-empty-restart'),('NATIVE_COLD_RUN_INTENT','one-original-empty-120s-v1'),('ROOT_NATIVE_COLD_CHOICE_B64','')]:
    with self.subTest(key=key),self.assertRaises(Exception):c.gate({**env,key:value})
 def test_runtime_mounts_cover_every_pinned_baseline_and_native_source_path(self):
  root=pathlib.PurePosixPath('/synthetic-owned/checkout');common=pathlib.PurePosixPath('/synthetic-owner/.git');args=c.readonly_source_mount_args(root,common)
  self.assertEqual(len(args),16);mounts=[]
  for n in range(0,len(args),2):
   self.assertEqual(args[n],'--mount');fields=args[n+1].split(',');self.assertEqual(fields[0],'type=bind');self.assertEqual(fields[-1],'readonly');values=dict(f.split('=',1) for f in fields[1:-1]);self.assertEqual(values['src'],values['dst']);mounts.append(pathlib.PurePosixPath(values['dst']))
  baseline=json.loads((HERE.parents[1]/'test/stage6-ca01-application-source-manifest.json').read_text());required=set(baseline['files'])|set(baseline['reusedHarnessFiles'])|set(c.RUNTIME_PATHS)
  def missing(available):return sorted(name for name in required if not any(root/name==m or m in (root/name).parents for m in available))
  self.assertEqual(missing(mounts),[])
  tool=root/'tools/stage8-qualification/Dockerfile.native-empty-ci';self.assertIn(tool,mounts)
  self.assertEqual(missing([m for m in mounts if m!=tool]),['tools/stage8-qualification/Dockerfile.native-empty-ci'])
 def test_runtime_tool_mount_is_one_pinned_readonly_file_without_expanding_tools_tree(self):
  root=pathlib.PurePosixPath('/synthetic-owned/checkout');args=c.readonly_source_mount_args(root,pathlib.PurePosixPath('/synthetic-owner/.git'))
  tools=[value for value in args if '/tools' in value];self.assertEqual(tools,['type=bind,src=/synthetic-owned/checkout/tools/stage8-qualification/Dockerfile.native-empty-ci,dst=/synthetic-owned/checkout/tools/stage8-qualification/Dockerfile.native-empty-ci,readonly'])
 def test_exact_fake_report_contract_is_observation_only(self):
  bind,host,a,b=reports();self.assertTrue(c.validate_reports(a,b,bind,H(5),host,220000));self.assertFalse(b['metadataProof']['actualNativeQualified'])
 def test_same_pid_owner_file_identity_or_deadline_reset_refuse(self):
  bind,host,a,b=reports()
  for mutate in [lambda x:x.update(pid=101),lambda x:x.update(serverPid=100),lambda x:x.update(physicalIdentityHash=H(99)),lambda x:x.update(activationHash=H(99)),lambda x:x.update(callsStarted=4)]:
   changed=copy.deepcopy(b);mutate(changed)
   with self.assertRaises(AssertionError):c.validate_reports(a,changed,bind,H(5),host,220000)
  changed=copy.deepcopy(a);changed['carry']['deadlineMs']+=1
  with self.assertRaises(AssertionError):c.validate_reports(changed,b,bind,H(5),host,220000)
 def test_exact_300s_or_unknown_terminal_never_qualifies(self):
  bind,host,a,b=reports()
  for elapsed in [300000,300001]:
   with self.assertRaises(AssertionError):c.validate_reports(a,b,bind,H(5),host,elapsed)
  for mutate in [lambda r:r['attribution']['adapter'].update(terminalComplete=False),lambda r:r['attribution']['adapter'].update(unknownProtocolReplies=1),lambda r:r['attribution'].update(bins={}),lambda r:r['attribution']['bins']['READBACK']['transactions'].update(open=1),lambda r:r['resources'].update(memoryEvents='oom 1\noom_kill 0'),lambda r:r['resources'].update(interfaces=['lo','eth0']),lambda r:r.update(capacityQualified=True)]:
   changed=copy.deepcopy(b);mutate(changed)
   with self.assertRaises(AssertionError):c.validate_reports(a,changed,bind,H(5),host,220000)
 def test_completion_source_rows_or_canonical_boundary_change_refuses(self):
  bind,host,a,b=reports()
  for mutate in [lambda x:x['carry']['afterA'].update(sourceRows=1),lambda x:x['carry']['afterA']['jobs'][0].update(state='COMPLETED'),lambda x:x.update(canonicalBoundaryDigest=H(99))]:
   changed=copy.deepcopy(a);mutate(changed)
   with self.assertRaises(AssertionError):c.validate_reports(changed,b,bind,H(5),host,220000)
 def test_only_three_new_original_call_intents_no_retry_or_pid_rebinding(self):
  bind,host,a,b=reports();records=[{'activationHash':H(5),'candidateSha':bind['candidateSha'],'ordinal':n,'requestIdentityHash':H(50+n),'maximumRetries':0,'pid':101 if n<3 else 202} for n in [1,2,3]]
  self.assertTrue(c.validate_call_intents(records,bind,H(5),a,b))
  for mutate in [lambda r:r.append(copy.deepcopy(r[2])),lambda r:r[2].update(pid=101),lambda r:r[2].update(maximumRetries=1),lambda r:r[2].update(requestIdentityHash=r[0]['requestIdentityHash']),lambda r:r[2].update(ordinal=4)]:
   changed=copy.deepcopy(records);mutate(changed)
   with self.assertRaises(AssertionError):c.validate_call_intents(changed,bind,H(5),a,b)
 def test_closed_public_projection_never_emits_unknown_strings(self):
  canary='SYNTHETIC_PRIVATE_CANARY';result={'candidateSha':canary,'status':canary,'controlFailureCode':canary,'health':canary};source={'failure':{'code':canary},'resources':{'memoryPeak':canary},'secret':canary}
  text=json.dumps(c.safe_summary(result,source,source));self.assertNotIn(canary,text);self.assertNotIn('secret',text);self.assertIn('UNKNOWN',text)
 def test_once_reservation_never_overwrites_or_refunds(self):
  with tempfile.TemporaryDirectory() as tmp:
   path=pathlib.Path(tmp)/'one-original.private.json';first=c.once(path,{'synthetic':True})
   with self.assertRaises(FileExistsError):c.once(path,{'synthetic':False})
   self.assertEqual(c.sha(path),first)

class FakeDocker:
 def __init__(self,name,binding,image='sha256:'+H(6),running=False):self.name=name;self.binding=binding;self.cid=H(7);self.image=image;self.running=running;self.exists=True;self.commands=[]
 def run(self,args,seconds=10):
  self.commands.append(args);assert not any(x in args for x in ['-f','kill','stop','--force'])
  if args[:2]==['docker','ps']:return self.cid if self.exists else ''
  if args[:3]==['docker','container','inspect']:return json.dumps([{'Id':self.cid,'Name':'/'+self.name,'Image':self.image,'Config':{'Labels':{'healthos.stage6.native-cold':self.name,'healthos.stage6.intent':self.binding['intentSha256']}},'State':{'Running':self.running}}])
  if args[:2]==['docker','rm']:assert args==['docker','rm',self.cid];self.exists=False;return self.cid
  raise AssertionError('UNEXPECTED_FAKE_COMMAND')

class OwnedCleanup(unittest.TestCase):
 def fixture(self,tmp,running=False,stage='terminal',capture=True,exit_code=0):
  sandbox=pathlib.Path(tmp);bind=binding();name='synthetic-owned-one';fake=FakeDocker(name,bind,running=running)
  c.once(sandbox/'original-operation.private.json',{'contract':'one-original-three-call-cold-ci-operation-v1','candidateSha':bind['candidateSha'],'choiceSha256':bind['choiceSha256'],'intentSha256':bind['intentSha256'],'operationId':bind['operationId'],'runId':'12345','runAttempt':1,'maximumDispatchAttempts':1,'maximumOriginalCalls':3,'automaticRedispatchAllowed':False})
  c.record_not_invoked(sandbox,name,bind)
  if stage!='not-invoked':
   c.once(sandbox/'owned-runtime-state.private.json',{'candidateSha':bind['candidateSha'],'intentSha256':bind['intentSha256'],'name':name,'imageId':'sha256:'+H(6)})
   c.launch_intent(sandbox,name,bind,['SYNTHETIC_DOCKER_RUN_ONLY'])
   if capture:
    (sandbox/'container.cid').write_text(fake.cid);(sandbox/'container.cid').chmod(0o600)
   if stage=='terminal':c.record_launch_terminal(sandbox,name,bind,exit_code)
  else:fake.exists=False
  return sandbox,bind,name,fake
 def cleanup(self,sandbox,bind,name,fake,cleanup_only):
  with patch.object(c,'run',fake.run),patch.object(c,'gate',return_value=bind),patch.object(c,'paths',return_value=(sandbox,name,'SYNTHETIC_IMAGE')),patch.object(c.sys,'argv',['SYNTHETIC_CONTROLLER','--cleanup-only']):
   return c.main()==0 if cleanup_only else c.owned_cleanup(sandbox,name,bind)
 def test_only_original_terminal_captured_stopped_owner_removed_and_idempotent(self):
  for cleanup_only in [False,True]:
   with self.subTest(cleanup_only=cleanup_only),tempfile.TemporaryDirectory() as tmp:
    sandbox,bind,name,fake=self.fixture(tmp)
    self.assertTrue(self.cleanup(sandbox,bind,name,fake,cleanup_only));self.assertTrue(self.cleanup(sandbox,bind,name,fake,cleanup_only))
    self.assertEqual([x for x in fake.commands if x[:2]==['docker','rm']],[['docker','rm',fake.cid]])
    self.assertTrue((sandbox/'owned-container-removed.private.json').is_file())
 def test_pending_launch_no_cid_empty_ps_never_clears_including_cleanup_only(self):
  for cleanup_only in [False,True]:
   with self.subTest(cleanup_only=cleanup_only),tempfile.TemporaryDirectory() as tmp:
    sandbox,bind,name,fake=self.fixture(tmp,stage='pending',capture=False);fake.exists=False
    with self.assertRaises(AssertionError):self.cleanup(sandbox,bind,name,fake,cleanup_only)
    self.assertEqual(fake.commands,[]);self.assertTrue((sandbox/'launch-intent.private.json').is_file())
 def test_terminal_nonzero_launch_no_cid_empty_ps_never_clears_including_cleanup_only(self):
  for cleanup_only in [False,True]:
   with self.subTest(cleanup_only=cleanup_only),tempfile.TemporaryDirectory() as tmp:
    sandbox,bind,name,fake=self.fixture(tmp,capture=False,exit_code=2);fake.exists=False
    with self.assertRaisesRegex(AssertionError,'INVOKED_WITHOUT_ORIGINAL_CAPTURED_CID_RETAINED'):self.cleanup(sandbox,bind,name,fake,cleanup_only)
    self.assertEqual(fake.commands,[])
 def test_positive_durable_never_invoked_state_can_clear_including_cleanup_only(self):
  for cleanup_only in [False,True]:
   with self.subTest(cleanup_only=cleanup_only),tempfile.TemporaryDirectory() as tmp:
    sandbox,bind,name,fake=self.fixture(tmp,stage='not-invoked')
    self.assertTrue(self.cleanup(sandbox,bind,name,fake,cleanup_only));self.assertFalse(any(x[:2]==['docker','rm'] for x in fake.commands))
 def test_absence_alone_no_launch_authority_or_cleanup_only_success(self):
  for cleanup_only in [False,True]:
   with self.subTest(cleanup_only=cleanup_only),tempfile.TemporaryDirectory() as tmp:
    sandbox=pathlib.Path(tmp);bind=binding();name='synthetic-owned-one';fake=FakeDocker(name,bind);fake.exists=False
    with self.assertRaises(AssertionError):self.cleanup(sandbox,bind,name,fake,cleanup_only)
    self.assertEqual(fake.commands,[])
  with tempfile.TemporaryDirectory() as tmp:
   sandbox=pathlib.Path(tmp)/'absent';bind=binding();fake=FakeDocker('synthetic-owned-one',bind)
   with self.assertRaisesRegex(AssertionError,'ORIGINAL_OWNERSHIP_PROVENANCE_REQUIRED'):self.cleanup(sandbox,bind,fake.name,fake,True)
 def test_pending_launch_captured_cid_does_not_claim_cli_settlement(self):
  with tempfile.TemporaryDirectory() as tmp:
   sandbox,bind,name,fake=self.fixture(tmp,stage='pending')
   with self.assertRaises(AssertionError):self.cleanup(sandbox,bind,name,fake,False)
   self.assertEqual(fake.commands,[])
 def test_running_or_wrong_image_retained_without_termination(self):
  for running,image in [(True,'sha256:'+H(6)),(False,'sha256:'+H(99))]:
   with self.subTest(running=running),tempfile.TemporaryDirectory() as tmp:
    sandbox,bind,name,fake=self.fixture(tmp,running);fake.image=image
    with self.assertRaises(AssertionError):self.cleanup(sandbox,bind,name,fake,False)
    self.assertFalse(any(x[:2]==['docker','rm'] for x in fake.commands));self.assertTrue(fake.exists)
 def test_missing_original_capture_cannot_be_repaired_by_later_cid(self):
  with tempfile.TemporaryDirectory() as tmp:
   sandbox,bind,name,fake=self.fixture(tmp,capture=False,exit_code=2)
   (sandbox/'container.cid').write_text(fake.cid);(sandbox/'container.cid').chmod(0o600)
   with self.assertRaisesRegex(AssertionError,'INVOKED_WITHOUT_ORIGINAL_CAPTURED_CID_RETAINED'):self.cleanup(sandbox,bind,name,fake,False)
   self.assertEqual(fake.commands,[])
 def test_changed_terminal_intent_or_original_operation_refuses(self):
  for filename,field,value in [('launch-terminal.private.json','launchIntentSha256',H(99)),('launch-intent.private.json','runtimeStateSha256',H(99)),('original-operation.private.json','operationId',H(99))]:
   with self.subTest(filename=filename),tempfile.TemporaryDirectory() as tmp:
    sandbox,bind,name,fake=self.fixture(tmp);path=sandbox/filename;record=json.loads(path.read_text());record[field]=value;path.write_text(json.dumps(record))
    with self.assertRaises(AssertionError):self.cleanup(sandbox,bind,name,fake,False)
    self.assertEqual(fake.commands,[])
 def test_captured_terminal_cid_absent_without_original_removal_witness_is_unknown(self):
  with tempfile.TemporaryDirectory() as tmp:
   sandbox,bind,name,fake=self.fixture(tmp);fake.exists=False
   with self.assertRaisesRegex(AssertionError,'ORIGINAL_CONTAINER_SETTLEMENT_UNOBSERVED_RETAINED'):self.cleanup(sandbox,bind,name,fake,False)
   self.assertFalse(any(x[:2]==['docker','rm'] for x in fake.commands))


class DiagnosticObservation(unittest.TestCase):
 def record(self,**changes):
  return {'contract':'stage6-native-cold-diagnostic-record-v1','phase':'A','stage':'APP_FAILURE','callIntents':2,'elapsedMs':100,'failureCode':'ERR_ASSERTION','errorMessageSha256':H(123),'terminalComplete':False,'activeFetches':1,'unresolvedStreams':1,'unknownProtocolReplies':0,**changes}
 def collector(self,tmp):return c.DiagnosticCollector(pathlib.Path(tmp),binding())
 def test_failure_progress_published_before_wait_even_when_owner_never_settles(self):
  with tempfile.TemporaryDirectory() as tmp:
   out=io.StringIO();collector=self.collector(tmp);c.once(pathlib.Path(tmp)/'A-progress-01.private.json',self.record());clock=[0]
   class Child:
    def wait(self,timeout):
     self.assertion=timeout;assert timeout<=1 and 'APP_FAILURE' in out.getvalue();clock[0]+=1000000000;raise c.subprocess.TimeoutExpired('SYNTHETIC_ONLY',timeout)
   with contextlib.redirect_stdout(out),patch.object(c.time,'monotonic_ns',side_effect=lambda:clock[0]):self.assertIsNone(c.wait_with_diagnostics(Child(),3000000000,collector))
   self.assertEqual(out.getvalue().count('"event":"PROGRESS"'),1);self.assertIn('"event":"HOST_TIMEOUT"',out.getvalue());self.assertIn('"sqlOwnerSettlement":"UNKNOWN"',out.getvalue())
 def test_available_application_report_is_read_before_nonzero_exit_and_not_self_accepted(self):
  with tempfile.TemporaryDirectory() as tmp:
   collector=self.collector(tmp);out=io.StringIO();bind,host,a,b=reports();a.update(contract='stage6-three-call-two-os-cold-progress-proposal-v1',failure={'code':'ERR_ASSERTION','messageSha256':H(123),'message':'SYNTHETIC_PRIVATE_CANARY'})
   c.once(pathlib.Path(tmp)/'A-result.private.json',a)
   class Child:
    def wait(self,timeout):return 2
   with contextlib.redirect_stdout(out),patch.object(c.time,'monotonic_ns',return_value=0),patch.object(c,'validate_reports',side_effect=AssertionError('NOT_AN_ACCEPTANCE_PATH')):
    self.assertEqual(c.wait_with_diagnostics(Child(),300000000000,collector),2)
   self.assertEqual(collector.reports['A']['callsStarted'],2);self.assertNotIn('B',collector.reports);self.assertIn('"callsStarted":2',out.getvalue());self.assertNotIn('SYNTHETIC_PRIVATE_CANARY',out.getvalue())
 def test_old_dae_branch_is_not_the_new_observation_source_context(self):
  self.assertEqual(c.REF,'refs/heads/diagnostic/native-cold-integer-timeout-20261020')
  env,choice,review,intent=bundles();intent['ref']='refs/heads/diagnostic/native-cold-continuation-20261020'
  with self.assertRaises(AssertionError):c.validate_bundles(env,RAW(choice),RAW(review),RAW(intent),1500)
 def test_missing_reports_and_counts_are_unknown_never_zero(self):
  with tempfile.TemporaryDirectory() as tmp:
   with contextlib.redirect_stdout(io.StringIO()):a,b=self.collector(tmp).collect()
   summary=c.safe_summary({},a,b);self.assertIsNone(summary['callsStartedA']);self.assertIsNone(summary['callsStartedB']);self.assertIsNone(summary['A']['terminalComplete']);self.assertIsNone(summary['A']['activeFetches'])
 def test_malformed_or_private_injected_progress_never_leaks_raw_values_and_can_later_be_read(self):
  with tempfile.TemporaryDirectory() as tmp:
   collector=self.collector(tmp);path=pathlib.Path(tmp)/'A-progress-01.private.json';path.write_text('{"message":"SYNTHETIC_PRIVATE_CANARY"');path.chmod(0o600);out=io.StringIO()
   with contextlib.redirect_stdout(out):collector.collect();collector.collect()
   self.assertEqual(out.getvalue().count('METADATA_UNREADABLE'),1);self.assertNotIn('SYNTHETIC_PRIVATE_CANARY',out.getvalue())
   path.write_text(json.dumps(self.record()))
   with contextlib.redirect_stdout(out):collector.collect();collector.collect()
   self.assertEqual(out.getvalue().count('"event":"PROGRESS"'),1)
 def test_closed_progress_schema_refuses_extra_raw_fields_unknown_enums_or_nonfinite_counts(self):
  for changes in [{'stage':'SYNTHETIC_PRIVATE_CANARY'},{'message':'SYNTHETIC_PRIVATE_CANARY'},{'callIntents':False},{'callIntents':4},{'activeFetches':float('inf')},{'failureCode':'SYNTHETIC_PRIVATE_CANARY'},{'errorMessageSha256':'SYNTHETIC_PRIVATE_CANARY'},{'phase':'UNKNOWN'}]:
   with self.subTest(changes=changes),self.assertRaises(AssertionError):c.diagnostic_projection(self.record(**changes))
 def test_report_projection_is_closed_and_never_claims_unknown_diagnostics_settled(self):
  row=c.report_projection('B',{'callsStarted':'SYNTHETIC_PRIVATE_CANARY','failure':{'code':'SYNTHETIC_PRIVATE_CANARY','message':'SYNTHETIC_PRIVATE_CANARY'},'attribution':{'adapter':{'terminalComplete':'true'}}})
  self.assertIsNone(row['callsStarted']);self.assertIsNone(row['terminalComplete']);self.assertEqual(row['failureCode'],'UNKNOWN');self.assertNotIn('SYNTHETIC_PRIVATE_CANARY',json.dumps(row))
 def test_public_diagnostic_limit_is_finite(self):
  with tempfile.TemporaryDirectory() as tmp:
   collector=self.collector(tmp);out=io.StringIO()
   with contextlib.redirect_stdout(out):
    for _ in range(200):collector.emit('HOST_TIMEOUT')
   self.assertEqual(len(out.getvalue().splitlines()),96)

if __name__=='__main__':unittest.main()

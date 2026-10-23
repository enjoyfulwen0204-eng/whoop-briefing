"""UNACTIVATED source proposal. Importing performs no Git/Docker/network work.

Launch requires NEW Root technical choice + independent source review + one
original dispatch intent, supplied by an explicit authorized manual event.
This is not a global anti-abuse counter: Root's immutable intent/wire/ACK/run
reconciliation must enforce one original dispatch. Run attempt one alone does not.
"""
import base64,hashlib,itertools,json,math,os,pathlib,platform,re,shutil,subprocess,sys,time

APP_BASE='ca01f63d2bd948f24a3a0400decdaca898811f39'
REPOSITORY='enjoyfulwen0204-eng/whoop-briefing'
REF='refs/heads/diagnostic/native-cold-owned-delivery-20261023'
MODE='native-empty-cold-progress'
PROFILE='three-original-calls-two-os-300s-v1'
REQUESTS=['native-cold-progress-original-1','native-cold-progress-original-2','native-cold-progress-original-3']
NODE_IMAGE='node@sha256:ae9f58d5c9f5a537110310be6b3cf67cf9c67146a3bb9310c0cb515fe71c8392'
SQLD_IMAGE='ghcr.io/tursodatabase/libsql-server@sha256:756fb4d34447cfa9507dceb3a8e680435d7f2173e2aa680f44a1329e774f7d31'
BASELINE_PATH='test/stage6-ca01-application-source-manifest.json'
MANIFEST_PATH='tools/stage8-qualification/native-cold-reviewed-source-manifest.json'
RUNTIME_PATHS=['test/stage6-native-cold-progress.mjs','test/stage6-cold-progress-contract.proposal.mjs','test/stage6-native-cold-progress.sh','test/stage6-cold-three-attribution.proposal.mjs','test/stage6-cold-three-observer.proposal.mjs','test/stage6-cold-diagnostic-metadata.proposal.mjs','test/stage6-native-cold-entry.proposal.mjs','test/stage6-cold-budget-attribution.proposal.mjs']
CONTROLLER_PATH='tools/stage8-qualification/native-cold-progress-ci.py'
WORKFLOW_PATH='.github/workflows/stage8-live-linux-qualification.yml'
HEX40=re.compile(r'^[a-f0-9]{40}$');HEX64=re.compile(r'^[a-f0-9]{64}$')
PHASES=['SETUP_SCHEMA1_TO35_SYNTHETIC_ONLY','SETUP_EMPTY_FIXTURE','ADMISSION_AND_COMPOSITION','GENUINE_ORIGINAL_PRODUCER_CALL','READBACK','EXACT_ORIGINAL_REPLAY','CLEANUP','UNKNOWN']
STATUSES=['UNQUALIFIED','BUILD_FAILED_OR_UNKNOWN','NATIVE_RUNNING','NATIVE_OR_SETTLEMENT_UNKNOWN_RETAINED','METADATA_OBSERVED_PENDING_INDEPENDENT_ACTUAL_REVIEW','NEGATIVE_OR_INCOMPLETE_METADATA','CLEANUP_UNCONFIRMED','SOURCE_CHANGED_OR_UNAVAILABLE','ORIGINAL_300S_WALL_UNQUALIFIED']

def require(condition,code):
 if not condition:raise AssertionError(code)
def digest(raw):return hashlib.sha256(raw).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def sha(path):return digest(path.read_bytes())
def exact_keys(value,keys):require(type(value) is dict and set(value)==set(keys),'EXACT_OBJECT_FIELDS_REQUIRED')
def safe_number(value):return value if type(value) in [int,float] and math.isfinite(value) and 0<=value<10**12 else None
def private_json(path,limit=1024*1024):
 require(not path.is_symlink() and path.is_file(),'REGULAR_PRIVATE_FILE_REQUIRED')
 st=path.stat();require(st.st_uid==os.getuid() and st.st_mode&0o077==0 and st.st_size<=limit,'PRIVATE_OWNER_MODE_BOUND_REQUIRED')
 raw=path.read_bytes();return raw,json.loads(raw)
def once(path,value):
 raw=(json.dumps(value,indent=2)+'\n').encode();fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 try:
  with os.fdopen(fd,'wb') as stream:stream.write(raw);stream.flush();os.fsync(stream.fileno())
 finally:
  directory=os.open(path.parent,os.O_RDONLY)
  try:os.fsync(directory)
  finally:os.close(directory)
 return digest(raw)
def decode_bundle(text):
 require(type(text) is str and 0<len(text)<=20000,'BOUNDED_EXPLICIT_ROOT_BUNDLE_REQUIRED')
 raw=base64.b64decode(text,validate=True);require(len(raw)<=14000,'BOUNDED_ROOT_BUNDLE_BYTES_REQUIRED')
 value=json.loads(raw);require(type(value) is dict,'ROOT_BUNDLE_OBJECT_REQUIRED');return raw,value

def validate_bundles(env,choice_raw,review_raw,intent_raw,now_ms,launch=True):
 """Pure validation; no external state or authority is minted by this helper."""
 choice=json.loads(choice_raw);review=json.loads(review_raw);intent=json.loads(intent_raw)
 exact_keys(choice,['contract','sourceGO','nativeExecutionGO','candidateSha','applicationBaselineSha','sourceManifestSha256','independentSourceReviewSha256','operationId','issuedAtMs','expiresAtMs','profile','maximumDispatchAttempts','maximumRunAttempts','maximumOriginalCalls','processLegs','nativeWallMs','buildMaximumSeconds','syntheticOnly','productionActionsAuthorized','maintenanceAuthorized','newOwnerMaintenanceApprovalClaimed'])
 require(choice['contract']=='root-technical-native-cold-progress-source-choice-v1','NEW_ROOT_TECHNICAL_CHOICE_REQUIRED')
 require(choice['sourceGO'] is True and choice['nativeExecutionGO'] is True,'EXPLICIT_ROOT_SOURCE_AND_NATIVE_TECHNICAL_CHOICE_REQUIRED')
 candidate=env.get('CANDIDATE_SHA','');require(bool(HEX40.fullmatch(candidate)),'ACTUAL_CANDIDATE_SHA_REQUIRED')
 require(candidate==choice['candidateSha']==env.get('GITHUB_SHA')==env.get('QUALIFICATION_WORKFLOW_SHA'),'SAME_ACTUAL_CANDIDATE_WORKFLOW_REQUIRED')
 require(choice['applicationBaselineSha']==APP_BASE and candidate!=APP_BASE,'HARNESS_HEAD_DISTINCT_FROM_CA01_BASE_REQUIRED')
 for field in ['sourceManifestSha256','independentSourceReviewSha256','operationId']:require(bool(HEX64.fullmatch(str(choice[field]))),'EXACT_SHA256_BINDING_REQUIRED')
 require(type(choice['issuedAtMs']) is int and type(choice['expiresAtMs']) is int and 0<choice['expiresAtMs']-choice['issuedAtMs']<=1800000,'FINITE_NEW_ROOT_CHOICE_WINDOW_REQUIRED')
 if launch:require(choice['issuedAtMs']<=now_ms<choice['expiresAtMs'],'ROOT_CHOICE_NOT_CURRENT')
 expected={'profile':PROFILE,'maximumDispatchAttempts':1,'maximumRunAttempts':1,'maximumOriginalCalls':3,'processLegs':2,'nativeWallMs':300000,'buildMaximumSeconds':360,'syntheticOnly':True,'productionActionsAuthorized':False,'maintenanceAuthorized':False,'newOwnerMaintenanceApprovalClaimed':False}
 for key,value in expected.items():require(type(choice[key]) is type(value) and choice[key]==value,'FIXED_NEW_PROFILE_SCOPE_REQUIRED')
 require(digest(review_raw)==choice['independentSourceReviewSha256'],'ACTUAL_INDEPENDENT_REVIEW_BYTES_REQUIRED')
 exact_keys(review,['contract','sourceReady','executionAuthorized','applicationBaselineSha','sourceManifestSha256','reviewOriginSha256','profile'])
 require(review['contract']=='stage6-native-cold-host-independent-source-review-v1' and review['sourceReady'] is True and review['executionAuthorized'] is False,'INDEPENDENT_SOURCE_REVIEW_NOT_NATIVE_GRANT')
 require(review['profile']==PROFILE and review['applicationBaselineSha']==APP_BASE and review['sourceManifestSha256']==choice['sourceManifestSha256'] and bool(HEX64.fullmatch(str(review['reviewOriginSha256']))),'EXACT_REVIEW_SOURCE_BINDINGS_REQUIRED')
 exact_keys(intent,['contract','dispatchGO','candidateSha','applicationBaselineSha','sourceManifestSha256','rootChoiceSha256','independentReviewSha256','operationId','repository','ref','mode','profile','maximumDispatchAttempts','automaticRedispatchAllowed','selectionSha256'])
 selection={'candidateSha':candidate,'applicationBaselineSha':APP_BASE,'sourceManifestSha256':choice['sourceManifestSha256'],'rootChoiceSha256':digest(choice_raw),'independentReviewSha256':digest(review_raw),'operationId':choice['operationId'],'repository':REPOSITORY,'ref':REF,'mode':MODE,'profile':PROFILE}
 require(intent['contract']=='root-one-original-native-cold-dispatch-intent-v1' and intent['dispatchGO'] is True,'NEW_ONE_ORIGINAL_DISPATCH_INTENT_REQUIRED')
 for key,value in selection.items():require(intent[key]==value,'DISPATCH_SELECTION_BINDING_REQUIRED')
 require(type(intent['maximumDispatchAttempts']) is int and intent['maximumDispatchAttempts']==1 and intent['automaticRedispatchAllowed'] is False,'NO_DISPATCH_RETRY_AUTHORITY')
 require(intent['selectionSha256']==digest(canonical(selection).encode()),'CANONICAL_DISPATCH_SELECTION_REQUIRED')
 return {'candidateSha':candidate,'choice':choice,'choiceSha256':digest(choice_raw),'reviewSha256':digest(review_raw),'intentSha256':digest(intent_raw),'operationId':choice['operationId']}

def gate(env=None,launch=True):
 env=os.environ if env is None else env
 fixed={'GITHUB_REPOSITORY':REPOSITORY,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':REF,'QUALIFICATION_MODE':MODE,'QUALIFICATION_REPOSITORY_PRIVATE':'false','NATIVE_COLD_RUN_INTENT':PROFILE,'RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_RUN_ATTEMPT':'1'}
 for key,value in fixed.items():require(env.get(key)==value,'EXACT_NEW_MANUAL_CI_CONTEXT_REQUIRED')
 require(bool(re.fullmatch(r'[1-9][0-9]*',env.get('GITHUB_RUN_ID',''))),'ACTUAL_ORIGINAL_RUN_ID_REQUIRED')
 require(platform.system()=='Linux' and platform.machine()=='x86_64' and os.getuid()>0 and os.getgid()>0,'ACTUAL_UNPRIVILEGED_LINUX_AMD64_HOST_REQUIRED')
 choice_raw,_=decode_bundle(env.get('ROOT_NATIVE_COLD_CHOICE_B64'));review_raw,_=decode_bundle(env.get('ROOT_NATIVE_COLD_REVIEW_B64'));intent_raw,_=decode_bundle(env.get('ROOT_NATIVE_COLD_INTENT_B64'))
 return validate_bundles(env,choice_raw,review_raw,intent_raw,time.time_ns()//1000000,launch)

def run(args,seconds=10):
 env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')} if args[0]=='git' else None
 return subprocess.run(args,env=env,check=True,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=seconds).stdout.strip()
def clean_head(path,expected):
 require(run(['git','--no-optional-locks','-C',str(path),'rev-parse','--verify','HEAD^{commit}'],2)==expected,'REAL_HEAD_MUST_MATCH_CANDIDATE')
 require(not run(['git','--no-optional-locks','-C',str(path),'status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none'],5),'CLEAN_FROZEN_SOURCE_REQUIRED')
def validate_source(root,binding):
 raw=(root/MANIFEST_PATH).read_bytes();manifest=json.loads(raw)
 require(digest(raw)==binding['choice']['sourceManifestSha256'],'REVIEWED_SOURCE_MANIFEST_BYTES_REQUIRED')
 exact_keys(manifest,['contract','applicationBaselineSha','profile','files'])
 require(manifest['contract']=='stage6-native-cold-reviewed-source-manifest-v1' and manifest['applicationBaselineSha']==APP_BASE and manifest['profile']==PROFILE,'EXACT_SOURCE_MANIFEST_SCOPE_REQUIRED')
 required=set(RUNTIME_PATHS+[BASELINE_PATH,CONTROLLER_PATH,WORKFLOW_PATH,'tools/stage8-qualification/native-cold-progress-ci.mock.test.py','test/stage6-cold-progress-contract.mock.test.mjs','test/stage6-cold-three-observer.mock.test.mjs','test/stage6-cold-diagnostic-metadata.mock.test.mjs','test/stage6-native-cold-integer-timeout.mock.test.mjs','test/stage6-cold-budget-attribution.mock.test.mjs','test/stage6-owned-delivery.mock.test.mjs'])
 require(type(manifest['files']) is dict and set(manifest['files'])==required,'EXACT_FINITE_REVIEWED_SOURCE_SET_REQUIRED')
 for name,pin in manifest['files'].items():require(bool(HEX64.fullmatch(str(pin))) and sha(root/name)==pin,'APPROVED_SOURCE_BYTES_REQUIRED')
 baseline_raw=(root/BASELINE_PATH).read_bytes();baseline=json.loads(baseline_raw)
 require(baseline['applicationBaselineSha']==APP_BASE and len(baseline['files'])==360 and len(baseline['reusedHarnessFiles'])==7,'EXACT_CA01_APPLICATION_MANIFEST_REQUIRED')
 for name,pin in {**baseline['files'],**baseline['reusedHarnessFiles']}.items():
  require((name.startswith(('src/','test/','tools/')) or name in ['package.json','package-lock.json']) and '..' not in name.split('/') and bool(HEX64.fullmatch(str(pin))),'SAFE_BASELINE_PATH_REQUIRED')
  require(sha(root/name)==pin,'CA01_APP_AND_REUSED_HELPERS_IMMUTABLE')
 require(run(['git','-C',str(root),'rev-parse',binding['candidateSha']+':src'])==run(['git','-C',str(root),'rev-parse',APP_BASE+':src']),'EXACT_CA01_SRC_TREE_REQUIRED')
 return manifest,baseline_raw
def public_lock(path):
 from urllib.parse import urlsplit
 lock=json.loads(path.read_text());require(lock.get('lockfileVersion') in [2,3] and len(lock.get('packages',{}))<10000,'BOUNDED_PUBLIC_LOCK_REQUIRED')
 for item in lock.get('packages',{}).values():
  require(not item.get('link'),'NO_LINKED_DEPENDENCY')
  if 'resolved' in item:
   url=urlsplit(item['resolved']);require(url.scheme=='https' and url.hostname=='registry.npmjs.org' and not(url.username or url.password or url.query or url.fragment),'PUBLIC_NPM_LOCK_ONLY')
def paths(env):
 root=pathlib.Path(env['RUNNER_TEMP']).resolve();require(root.is_dir(),'ACTUAL_RUNNER_TEMP_REQUIRED');suffix=env['GITHUB_RUN_ID']+'-'+env['GITHUB_RUN_ATTEMPT']
 return root/('stage6-native-cold-'+suffix),'stage6-native-cold-'+suffix,'stage6-native-cold:'+suffix
def readonly_source_mount_args(checkout,common):
 # Exact baseline tool file is runtime evidence, not an image-build artifact.
 paths=[checkout/'src',checkout/'test',checkout/'scripts',checkout/'package.json',checkout/'package-lock.json',checkout/'.git',common,checkout/'tools/stage8-qualification/Dockerfile.native-empty-ci']
 args=[]
 for path in paths:args+=['--mount','type=bind,src='+str(path)+',dst='+str(path)+',readonly']
 return args

def launch_context(sandbox,name,binding):
 raw,operation=private_json(sandbox/'original-operation.private.json',4096)
 exact_keys(operation,['contract','candidateSha','choiceSha256','intentSha256','operationId','runId','runAttempt','maximumDispatchAttempts','maximumOriginalCalls','automaticRedispatchAllowed'])
 require(operation['contract']=='one-original-three-call-cold-ci-operation-v1','ORIGINAL_OPERATION_REQUIRED')
 for key in ['candidateSha','choiceSha256','intentSha256','operationId']:require(operation[key]==binding[key],'EXACT_ORIGINAL_OPERATION_REQUIRED')
 require(type(operation['runId']) is str and re.fullmatch(r'[1-9][0-9]*',operation['runId']) and operation['runAttempt']==1 and type(operation['runAttempt']) is int,'ORIGINAL_RUN_ID_REQUIRED')
 require(type(operation['maximumDispatchAttempts']) is int and operation['maximumDispatchAttempts']==1 and type(operation['maximumOriginalCalls']) is int and operation['maximumOriginalCalls']==3 and operation['automaticRedispatchAllowed'] is False,'ORIGINAL_SPENT_OPERATION_SCOPE_REQUIRED')
 return {'candidateSha':binding['candidateSha'],'intentSha256':binding['intentSha256'],'operationId':binding['operationId'],'originalOperationSha256':digest(raw),'name':name}
def bound_record(path,contract,context,extra):
 raw,value=private_json(path,8192);exact_keys(value,['contract',*context,*extra])
 require(value['contract']==contract,'EXACT_LAUNCH_PROVENANCE_CONTRACT_REQUIRED')
 for key,expected in context.items():require(value[key]==expected,'EXACT_ORIGINAL_LAUNCH_PROVENANCE_REQUIRED')
 return raw,value
def captured_cid(sandbox):
 path=sandbox/'container.cid'
 if not path.exists() and not path.is_symlink():return None
 require(not path.is_symlink() and path.is_file(),'REGULAR_CAPTURED_CID_REQUIRED')
 st=path.stat();require(st.st_uid==os.getuid() and st.st_mode&0o077==0 and st.st_size<=65,'PRIVATE_BOUNDED_CAPTURED_CID_REQUIRED')
 value=path.read_text().strip();require(bool(HEX64.fullmatch(value)),'EXACT_CAPTURED_CID_REQUIRED');return value
def record_not_invoked(sandbox,name,binding):
 # Positive durable state, before this source can invoke its sole docker run.
 return once(sandbox/'launch-not-invoked.private.json',{'contract':'stage6-original-native-launch-not-invoked-v1',**launch_context(sandbox,name,binding)})
def launch_intent(sandbox,name,binding,args):
 context=launch_context(sandbox,name,binding)
 bound_record(sandbox/'launch-not-invoked.private.json','stage6-original-native-launch-not-invoked-v1',context,[])
 raw,state=private_json(sandbox/'owned-runtime-state.private.json',4096)
 exact_keys(state,['candidateSha','intentSha256','name','imageId'])
 require(state['candidateSha']==context['candidateSha'] and state['intentSha256']==context['intentSha256'] and state['name']==name and type(state['imageId']) is str and HEX64.fullmatch(state['imageId'].removeprefix('sha256:')),'EXACT_OWNED_RUNTIME_STATE_REQUIRED')
 # O_EXCL + file/parent fsync must return BEFORE Popen. Any intent, including
 # a torn/unreadable one, irrevocably invalidates the NOT_INVOKED state.
 return once(sandbox/'launch-intent.private.json',{'contract':'stage6-original-native-launch-intent-v1',**context,'runtimeStateSha256':digest(raw),'commandSha256':digest(canonical(args).encode())})
def original_launch(sandbox,name,binding):
 context=launch_context(sandbox,name,binding)
 bound_record(sandbox/'launch-not-invoked.private.json','stage6-original-native-launch-not-invoked-v1',context,[])
 raw,intent=bound_record(sandbox/'launch-intent.private.json','stage6-original-native-launch-intent-v1',context,['runtimeStateSha256','commandSha256'])
 for key in ['runtimeStateSha256','commandSha256']:require(type(intent[key]) is str and HEX64.fullmatch(intent[key]),'EXACT_LAUNCH_DIGEST_REQUIRED')
 state_raw,state=private_json(sandbox/'owned-runtime-state.private.json',4096);exact_keys(state,['candidateSha','intentSha256','name','imageId'])
 require(digest(state_raw)==intent['runtimeStateSha256'] and state['candidateSha']==context['candidateSha'] and state['intentSha256']==context['intentSha256'] and state['name']==name,'ORIGINAL_RUNTIME_STATE_BYTES_REQUIRED')
 require(type(state['imageId']) is str and state['imageId'].startswith('sha256:') and HEX64.fullmatch(state['imageId'][7:]),'EXACT_ORIGINAL_IMAGE_REQUIRED')
 return context,raw,intent,state
def record_launch_terminal(sandbox,name,binding,code):
 # Called only after wait() on the original Popen returned an actual integer.
 # A nonzero CLI exit never proves that Docker's create POST did not take effect.
 require(type(code) is int and -255<=code<=255,'ACTUAL_TERMINAL_DOCKER_CLI_CODE_REQUIRED')
 context,raw,intent,state=original_launch(sandbox,name,binding)
 return once(sandbox/'launch-terminal.private.json',{'contract':'stage6-original-native-launch-terminal-v1',**context,'launchIntentSha256':digest(raw),'cliExitCode':code,'capturedOriginalCid':captured_cid(sandbox)})
def owned_cleanup(sandbox,name,binding):
 context=launch_context(sandbox,name,binding)
 bound_record(sandbox/'launch-not-invoked.private.json','stage6-original-native-launch-not-invoked-v1',context,[])
 intentpath=sandbox/'launch-intent.private.json'
 if not intentpath.exists() and not intentpath.is_symlink():
  # Absence alone is never a never-invoked witness. The positive initial state
  # and source ordering establish it; contradictory evidence must still refuse.
  require(not (sandbox/'launch-terminal.private.json').exists() and not (sandbox/'launch-terminal.private.json').is_symlink() and captured_cid(sandbox) is None,'CONTRADICTORY_NOT_INVOKED_STATE')
  require(not run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$']),'NOT_INVOKED_NAME_COLLISION_RETAINED')
  return True
 context,intent_raw,intent,state=original_launch(sandbox,name,binding)
 terminal_raw,terminal=bound_record(sandbox/'launch-terminal.private.json','stage6-original-native-launch-terminal-v1',context,['launchIntentSha256','cliExitCode','capturedOriginalCid'])
 require(terminal['launchIntentSha256']==digest(intent_raw) and type(terminal['cliExitCode']) is int and -255<=terminal['cliExitCode']<=255,'GENUINE_ORIGINAL_TERMINAL_LAUNCH_REQUIRED')
 captured=captured_cid(sandbox)
 require(type(terminal['capturedOriginalCid']) is str and HEX64.fullmatch(terminal['capturedOriginalCid']) and captured==terminal['capturedOriginalCid'],'INVOKED_WITHOUT_ORIGINAL_CAPTURED_CID_RETAINED')
 removal_context={**context,'launchTerminalSha256':digest(terminal_raw),'capturedOriginalCid':captured,'runtimeStateSha256':intent['runtimeStateSha256']}
 observed=run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$'])
 present=run(['docker','ps','-aq','--no-trunc','--filter','id='+captured])
 removed=sandbox/'owned-container-removed.private.json'
 if removed.exists() or removed.is_symlink():
  bound_record(removed,'stage6-original-stopped-owned-container-removed-v1',removal_context,[])
  require(not observed and not present,'REMOVED_ORIGINAL_ID_OR_NAME_REAPPEARED_RETAINED')
  return True
 # Terminal CLI + captured CID does not prove daemon/container settlement by
 # itself. Observe the exact original image, labels and stopped state before rm.
 require(present==captured and observed==captured,'ORIGINAL_CONTAINER_SETTLEMENT_UNOBSERVED_RETAINED')
 info=json.loads(run(['docker','container','inspect',captured]))[0]
 require(info['Id']==captured and info['Name']=='/'+name and info['Image']==state['imageId'],'EXACT_OWNED_CONTAINER_REQUIRED')
 labels=info['Config']['Labels'];require(labels.get('healthos.stage6.native-cold')==name and labels.get('healthos.stage6.intent')==binding['intentSha256'],'EXACT_OWNED_LABELS_REQUIRED')
 require(info['State']['Running'] is False,'OWNED_RUNNING_OR_UNKNOWN_RETAIN_NO_FORCE_REMOVAL')
 run(['docker','rm',captured],15)
 require(not run(['docker','ps','-aq','--no-trunc','--filter','id='+captured]),'OWNED_CID_STILL_PRESENT')
 require(not run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$']),'OWNED_NAME_STILL_PRESENT')
 once(removed,{'contract':'stage6-original-stopped-owned-container-removed-v1',**removal_context})
 return True

def check_terminal(report):
 attribution=report.get('attribution',{});adapter=attribution.get('adapter',{})
 require(adapter.get('terminalComplete') is True and adapter.get('coverageComplete') is True,'ACTUAL_TERMINAL_TRANSPORT_OBSERVATION_REQUIRED')
 for key in ['activeFetches','unresolvedStreams','droppedObservations','unknownProtocolReplies']:require(type(adapter.get(key)) is int and adapter[key]==0,'NO_UNKNOWN_NATIVE_ACK_REQUIRED')
 require(type(attribution.get('bins')) is dict and set(attribution['bins'])==set(PHASES),'COMPLETE_PHASE_OBSERVATIONS_REQUIRED')
 require(attribution.get('physicalTerminalObservationComplete') is True,'PHYSICAL_TERMINAL_COVERAGE_REQUIRED')
 for row in attribution['bins'].values():
  for key in ['requestErrors','responseErrors','unknownReplies']:require(type(row.get(key)) in [int,float] and row[key]==0,'NO_PHYSICAL_REQUEST_REPLY_ERROR')
  require(row.get('transactions',{}).get('open')==0 and row.get('transactions',{}).get('unknownTerminal')==0,'ALL_OBSERVED_TRANSACTIONS_TERMINAL')
 resources=report.get('resources',{});require(resources.get('node')=='v22.23.2' and resources.get('architecture')=='x64' and resources.get('platform')=='linux','ACTUAL_NATIVE_RUNTIME_REQUIRED')
 require(resources.get('memoryMax')=='536870912' and resources.get('swapMax')=='0' and resources.get('cpuMax')=='50000 100000' and resources.get('interfaces')==['lo'],'EXACT_OFFLINE_NATIVE_RESOURCE_LIMITS_REQUIRED')
 peak=resources.get('memoryPeak','');require(type(peak) is str and peak.isdigit() and 0<int(peak)<=536870912,'NATIVE_MEMORY_PEAK_REQUIRED')
 events=dict(line.split() for line in str(resources.get('memoryEvents','')).splitlines() if len(line.split())==2)
 require(events.get('oom')=='0' and events.get('oom_kill')=='0','NO_NATIVE_OOM_REQUIRED')

def validate_reports(a,b,binding,activation_sha,host,elapsed_ms):
 require(0<elapsed_ms<300000,'ORIGINAL_NATIVE_WALL_INCLUDES_SETTLEMENT_AND_READBACK')
 require(a.get('status')=='TWO_PRODUCTIVE_ORIGINALS_AWAIT_NEW_OS_LEG' and b.get('status')=='ACTUAL_THREE_ORIGINAL_CALLS_COLD_PARTIAL_METADATA_OBSERVED','ACTUAL_BOUNDED_PARTIAL_METADATA_REQUIRED')
 for phase,report,calls in [('A',a,2),('B',b,3)]:
  require(report.get('phase')==phase and report.get('callsStarted')==calls and report.get('candidateSha')==binding['candidateSha'] and report.get('applicationBaselineSha')==APP_BASE and report.get('activationHash')==activation_sha,'SAME_ACTUAL_ORIGINAL_OPERATION_REQUIRED')
  for flag in ['productionEvidence','capacityQualified','wholeJobCompletionQualified','actualNativeQualified']:require(report.get(flag) is False,'NO_SELF_QUALIFICATION_ALLOWED')
  require(report.get('resources',{}).get('nativeHost')==host,'EXACT_ACTUAL_HOST_OBSERVATIONS_REQUIRED');check_terminal(report)
 require(type(a.get('pid')) is int and a['pid']>0 and type(b.get('pid')) is int and b['pid']>0 and a['pid']!=b['pid'],'ACTUAL_DISTINCT_APPLICATION_PIDS_REQUIRED')
 require(type(a.get('serverPid')) is int and a['serverPid']>0 and a['serverPid']==b.get('serverPid'),'SAME_PERSISTENT_SQLITE_OWNER_REQUIRED')
 require(bool(HEX64.fullmatch(str(a.get('physicalIdentityHash')))) and a['physicalIdentityHash']==b.get('physicalIdentityHash'),'SAME_SQLITE_PHYSICAL_IDENTITY_REQUIRED')
 carry=a.get('carry',{});require(carry.get('callsStarted')==2 and carry.get('pidA')==a['pid'] and carry.get('requestIds')==REQUESTS,'FIXED_THREE_ORIGINAL_REQUESTS_REQUIRED')
 require(carry.get('deadlineMs')==float(int(host['nativeStartedMonotonicNs']))/1000000+300000,'NO_NATIVE_DEADLINE_RESET')
 state=carry.get('afterA',{});require(state.get('lastCompletedGeneration')==0 and state.get('initialized') is True,'GENUINE_INITIALIZED_PENDING_CONTEXT_REQUIRED')
 for field in ['sourceRows','outboundMessages','pilotLedgers','currentPublications']:require(type(state.get(field)) is int and state[field]==0,'EMPTY_PENDING_ONLY_SCOPE_REQUIRED')
 require(len(state.get('jobs',[]))==2 and all(j.get('state')=='PENDING' and j.get('requestedGeneration')==state.get('inputGeneration') and j.get('completedGeneration')==0 for j in state['jobs']),'BOTH_ORIGINAL_JOBS_PENDING_REQUIRED')
 require(digest(canonical(state).encode())==a.get('canonicalBoundaryDigest'),'AUTHENTICATED_BOUNDARY_DIGEST_REQUIRED')
 proof=b.get('metadataProof',{});require(type(proof.get('originalJobsCompleted')) is int and proof['originalJobsCompleted']==0,'NOT_WHOLE_JOB_QUALIFICATION')
 require(proof.get('callsStarted')==3 and proof.get('sameGeneration') is True and proof.get('originalReceiptsPreserved') is True and proof.get('coldCursorResumeMetadataObserved') is True,'COLD_ORIGINAL_CURSOR_RECEIPT_METADATA_REQUIRED')
 require(proof.get('actualNativeQualified') is False and proof.get('capacityQualified') is False and proof.get('wholeJobCompletionQualified') is False,'PROVENANCE_NOT_SELF_APPROVED')
 require([step.get('selectedJobKind') for step in carry.get('steps',[])]==['RECOMPUTE_DERIVED','REPAIR_CURRENTNESS'] and [step.get('selectedJobKind') for step in proof.get('steps',[])]==['RECOMPUTE_DERIVED'],'ACTUAL_CANONICAL_JOB_SELECTION_REQUIRED')
 return True

def validate_call_intents(records,binding,activation_sha,a,b):
 require(type(records) is list and len(records)==3,'EXACT_THREE_EXCLUSIVE_CALL_INTENTS_REQUIRED')
 hashes=[]
 for n,record in enumerate(records,1):
  exact_keys(record,['activationHash','candidateSha','ordinal','requestIdentityHash','maximumRetries','pid'])
  require(record['activationHash']==activation_sha and record['candidateSha']==binding['candidateSha'] and type(record['ordinal']) is int and record['ordinal']==n,'ORIGINAL_CALL_INTENT_BINDING_REQUIRED')
  require(type(record['maximumRetries']) is int and record['maximumRetries']==0 and record['pid']==(a['pid'] if n<=2 else b['pid']),'NO_RETRY_OR_PROCESS_REBINDING')
  require(bool(HEX64.fullmatch(str(record['requestIdentityHash']))),'OPAQUE_ORIGINAL_REQUEST_IDENTITY_REQUIRED');hashes.append(record['requestIdentityHash'])
 require(len(set(hashes))==3,'THREE_DISTINCT_ORIGINAL_IDENTITIES_REQUIRED')
 return True


# Diagnostic records are not receipts, acceptance, provider/SQLD settlement or
# permission. Unknown counts stay None; arbitrary messages/keys/paths never print.
DIAGNOSTIC_FIELDS=['contract','phase','stage','callIntents','elapsedMs','failureCode','errorMessageSha256','terminalComplete','activeFetches','unresolvedStreams','unknownProtocolReplies']
NATIVE_DIAGNOSTIC_STAGES=['APP_IMPORT_ENTER','APP_BOOTSTRAP_FAILURE','APP_ENTER','SETUP_ENTER','SETUP_RETURNED','ADMISSION_ENTER','ADMISSION_RETURNED','COLD_BOUNDARY_ENTER','COLD_BOUNDARY_RETURNED','CALL_INTENT_DURABLE','CALL_RETURNED','LEG_METADATA_READY','APP_FAILURE','DB_CLOSE_ENTER','DB_CLOSE_RETURNED','TRANSPORT_IDLE_ENTER','TRANSPORT_IDLE_RETURNED','REPORT_WRITTEN','WORK_BOUND_REACHED']
SHELL_DIAGNOSTIC_STAGES=['SHELL_ENTERED','BOOTSTRAP_REFUSED','SQLD_STARTED','SQLD_READY','SQLD_READINESS_FAILED_WAIT_UNKNOWN','A_STARTED','A_FAILED_WAIT_UNKNOWN','A_RETURNED','B_STARTED','B_FAILED_WAIT_UNKNOWN','B_RETURNED','GRACEFUL_OWNER_STOP_REQUESTED','SQLD_PROCESS_EXIT_OBSERVED','OWNER_EXIT_UNCONFIRMED','A_FAILED_TRANSPORT_SETTLED','B_FAILED_TRANSPORT_SETTLED']
def mapping(value):return value if type(value) is dict else {}
def known_count(value,maximum):return value if type(value) is int and 0<=value<=maximum else None
def diagnostic_projection(record):
 exact_keys(record,DIAGNOSTIC_FIELDS);require(record['contract']=='stage6-native-cold-diagnostic-record-v1','DIAGNOSTIC_CONTRACT_REQUIRED')
 phase=record['phase'];require(phase in ['A','B','SHELL'],'FINITE_DIAGNOSTIC_PHASE_REQUIRED')
 require(record['stage'] in (SHELL_DIAGNOSTIC_STAGES if phase=='SHELL' else NATIVE_DIAGNOSTIC_STAGES),'FINITE_DIAGNOSTIC_STAGE_REQUIRED')
 for key in ['callIntents','activeFetches','unresolvedStreams','unknownProtocolReplies']:
  require(record[key] is None or known_count(record[key],3 if key=='callIntents' else 999999999) is not None,'FINITE_DIAGNOSTIC_COUNT_REQUIRED')
 require(record['elapsedMs'] is None or safe_number(record['elapsedMs']) is not None,'FINITE_DIAGNOSTIC_TIME_REQUIRED')
 require(record['terminalComplete'] is None or type(record['terminalComplete']) is bool,'OBSERVED_TERMINAL_OR_UNKNOWN_REQUIRED')
 require(record['failureCode'] is None or record['failureCode'] in ['ERR_ASSERTION','NATIVE_COLD_PROOF_REFUSED'],'FINITE_DIAGNOSTIC_FAILURE_REQUIRED')
 require(record['errorMessageSha256'] is None or type(record['errorMessageSha256']) is str and HEX64.fullmatch(record['errorMessageSha256']),'HASH_ONLY_DIAGNOSTIC_ERROR_REQUIRED')
 return {key:record[key] for key in DIAGNOSTIC_FIELDS if key!='contract'}
def report_projection(label,report):
 report=mapping(report);resources=mapping(report.get('resources'));adapter=mapping(mapping(report.get('attribution')).get('adapter'));failure=mapping(report.get('failure'))
 code=failure.get('code');error_hash=failure.get('messageSha256')
 return {'phase':label,'reportAvailable':bool(report),'callsStarted':known_count(report.get('callsStarted'),3),'terminalComplete':adapter.get('terminalComplete') if type(adapter.get('terminalComplete')) is bool else None,'transportInvocations':safe_number(adapter.get('transportInvocations')),'unknownProtocolReplies':known_count(adapter.get('unknownProtocolReplies'),999999999),'activeFetches':known_count(adapter.get('activeFetches'),999999999),'unresolvedStreams':known_count(adapter.get('unresolvedStreams'),999999999),'memoryPeakBytes':int(resources['memoryPeak']) if type(resources.get('memoryPeak')) is str and resources['memoryPeak'].isdigit() and len(resources['memoryPeak'])<=10 else None,'failureCode':code if type(code) is str and code in ['ERR_ASSERTION','NATIVE_COLD_PROOF_REFUSED'] else 'UNKNOWN','errorMessageSha256':error_hash if type(error_hash) is str and HEX64.fullmatch(error_hash) else None}
ATTR_CATEGORIES=['TX_BEGIN','TX_COMMIT','TX_ROLLBACK','DDL','PRAGMA','SCHEMA_CATALOG','SCHEMA_VERSION','MIGRATION_METADATA','AUTHORITY_ASSERTION','PRINCIPAL_READINESS','CONTEXT_LEASE_RELEASE','EXECUTION_CONTROL','OPERATION_RECEIPT','CONTEXT_LEASE','QUEUE_CONTROL','FAMILY_DIRECTORY','SOURCE_DATA','DERIVED_DATA','OTHER']
ATTR_UNITS=['CREATE_DB','MIGRATE','SEED_EMPTY_FIXTURE','RUNTIME_ADMISSION','BUILD_LIVE_PRODUCER','ORIGINAL_PRODUCER_RUN','READBACK','ORIGINAL_REQUEST_REPLAY','CLEANUP','UNKNOWN']
FRAME_BASENAMES=['stage8LiveProducer.js','stage8LiveExecution.js','phase4Cache.js','executionBudget.js','processingTransaction.js','db.js','phase4Reanalysis.js','phase4Core.js','phase4QueueStore.js','phase4ExecutionContext.js','phase4Coordination.js']
ATTR_CODES=['NONE','OTHER','UNKNOWN','SYNC_TIMEOUT','SYNC_CANCELLED','PHASE4_DRAIN_DEADLINE_REACHED','COMMIT_INDETERMINATE','RUNTIME_REPLACEMENT_REQUIRED','SQLITE_BUSY','SQLITE_LOCKED','PHASE4_LIVE_NOT_AUTHORIZED','STAGE8_LIVE_PRINCIPAL_FENCED']
FETCH_CALLSITE_TAGS=['LIVE_PRODUCER','LIVE_EXECUTION','PROCESSING_TRANSACTION','CORE_CONTEXT','DB_HTTP','KNOWN_APP_SOURCE','UNKNOWN']
BUDGET_WIDTHS=['MS_5000','MS_10000','MS_15000','MS_45000','MS_50000','MS_70000','OTHER','NONE','UNKNOWN']
ATTR_COUNTS=['requests','submittedStatements','observedExecutedStatements','requestErrors','responseErrors','unknownReplies']
ATTR_TIMES=['sumRequestDurationMs','maxRequestDurationMs','sumInjectedDelayMs','phaseWallMs']
TX_COUNTS=['begun','committed','rolledBack','unknownTerminal','open','atOrAbove5s']
TX_TIMES=['sumDurationUpperBoundMs','maxDurationUpperBoundMs']
def nullable_number(value,maximum=1e12,integer=False):
 return value is None or type(value) in ([int] if integer else [int,float]) and math.isfinite(value) and 0<=value<maximum
def checked_numbers(value,fields,maximum=1e12,integer=False):
 for field in fields:require(nullable_number(value[field],maximum,integer),'BOUNDED_ATTRIBUTION_NUMBER_REQUIRED')
def checked_bools(value,fields):
 for field in fields:require(value[field] is None or type(value[field]) is bool,'OBSERVED_ATTRIBUTION_BOOLEAN_OR_UNKNOWN_REQUIRED')
def finite_enum(value,allowed):require(type(value) is str and value in allowed,'CLOSED_ATTRIBUTION_ENUM_REQUIRED')
def budget_attribution_projection(record):
 # Validate every nested key/value before any public output. No raw SQL,
 # request data, identity, free message or arbitrary string can pass this shape.
 exact_keys(record,['contract','productionEvidence','actualNativeQualified','wholeJobCompletionQualified','capacityQualified','candidateSha','phase','stage','callIntents','elapsedMs','failureCode','errorMessageSha256','typedFailureCode','safeFrames','coverage','adapter','phaseBins','fetchBudgets'])
 for field in ['productionEvidence','actualNativeQualified','wholeJobCompletionQualified','capacityQualified']:require(record[field] is False,'DIAGNOSTICS_CANNOT_QUALIFY_NATIVE_OR_PRODUCTION')
 require(record['contract']=='stage6-native-cold-budget-attribution-v3' and type(record['candidateSha']) is str and HEX40.fullmatch(record['candidateSha']),'BOUND_BUDGET_ATTRIBUTION_REQUIRED')
 finite_enum(record['phase'],['A','B']);finite_enum(record['stage'],['LEG_METADATA_READY','APP_FAILURE']);checked_numbers(record,['callIntents'],4,True);checked_numbers(record,['elapsedMs'])
 require(record['failureCode'] is None or record['failureCode'] in ['ERR_ASSERTION','NATIVE_COLD_PROOF_REFUSED','UNKNOWN'],'CLOSED_ATTRIBUTION_FAILURE_CODE_REQUIRED');require(record['errorMessageSha256'] is None or type(record['errorMessageSha256']) is str and HEX64.fullmatch(record['errorMessageSha256']),'HASH_ONLY_ATTRIBUTION_FAILURE_REQUIRED')
 finite_enum(record['typedFailureCode'],ATTR_CODES);frames=record['safeFrames'];require(type(frames) is list and len(frames)<=8,'FINITE_SAFE_FRAME_BOUND_REQUIRED')
 for frame in frames:
  exact_keys(frame,['sourceBasename','line']);finite_enum(frame['sourceBasename'],FRAME_BASENAMES);require(type(frame['line']) is int and 1<=frame['line']<=1000000,'FINITE_SAFE_FRAME_LINE_REQUIRED')
 coverage=record['coverage'];coverage_counts=['inflightRequests','pendingAcknowledgedBegins','unsettledTransactions','droppedObservations','droppedTransactionSamples'];coverage_flags=['physicalTerminalObservationComplete','observationCoverageComplete','allRequestsSettled','allAcknowledgedBeginsLinked','allTransactionsSettled','allRepliesKnown','allTransactionTerminalsKnown','transactionSampleCoverageComplete'];exact_keys(coverage,coverage_counts+coverage_flags);checked_numbers(coverage,coverage_counts,1e9,True);checked_bools(coverage,coverage_flags)
 adapter=record['adapter'];counts=['activeFetches','transportInvocations','responsesObserved','unresolvedStreams','droppedObservations','unknownProtocolReplies'];flags=['terminalComplete','coverageComplete'];exact_keys(adapter,counts+flags+['delivery']);checked_numbers(adapter,counts,1e9,True);checked_bools(adapter,flags)
 delivery=adapter['delivery'];exact_keys(delivery,['contract','startedRequests','notSent','sentReply','unknown','pending','coverageComplete']);require(delivery['contract']=='owned-native-request-delivery-v1','OWNED_DELIVERY_CONTRACT_REQUIRED');checked_numbers(delivery,['startedRequests','notSent','sentReply','unknown','pending'],1e9,True);checked_bools(delivery,['coverageComplete'])
 bins=record['phaseBins'];require(type(bins) is list and len(bins)<=len(PHASES),'FINITE_PHASE_BIN_BOUND_REQUIRED');seen=set()
 for row in bins:
  exact_keys(row,['phase',*ATTR_COUNTS,*ATTR_TIMES,'lastKnownOuterWorkUnit','lastStorageCategory','lastTypedCode','categories','transactions']);finite_enum(row['phase'],PHASES);require(row['phase'] not in seen,'DISTINCT_PHASE_BINS_REQUIRED');seen.add(row['phase']);checked_numbers(row,ATTR_COUNTS,1e9,True);checked_numbers(row,ATTR_TIMES)
  finite_enum(row['lastKnownOuterWorkUnit'],ATTR_UNITS);finite_enum(row['lastStorageCategory'],ATTR_CATEGORIES+['UNKNOWN']);finite_enum(row['lastTypedCode'],ATTR_CODES)
  categories=row['categories'];require(type(categories) is list and len(categories)<=len(ATTR_CATEGORIES),'FINITE_CATEGORY_BIN_BOUND_REQUIRED');seen_categories=set()
  for item in categories:
   exact_keys(item,['category','submitted','executed']);finite_enum(item['category'],ATTR_CATEGORIES);require(item['category'] not in seen_categories,'DISTINCT_CATEGORY_BINS_REQUIRED');seen_categories.add(item['category']);checked_numbers(item,['submitted','executed'],1e9,True)
  tx=row['transactions'];exact_keys(tx,TX_COUNTS+TX_TIMES);checked_numbers(tx,TX_COUNTS,1e9,True);checked_numbers(tx,TX_TIMES)
 budget=record['fetchBudgets'];exact_keys(budget,['captures','droppedCaptures','inflight','recentEvictions','widthBins','recentEntries','firstFailedEntry']);checked_numbers(budget,['captures','droppedCaptures','inflight','recentEvictions'],1e9,True)
 widths=budget['widthBins'];require(type(widths) is list and len(widths)==len(BUDGET_WIDTHS),'COMPLETE_FINITE_WIDTH_BINS_REQUIRED');seen_widths=set()
 for row in widths:
  fields=['captures','settled','requestErrors','abortedAtEntry','abortedAtSettlement'];exact_keys(row,['widthBucket',*fields,'lastTypedErrorCode']);finite_enum(row['widthBucket'],BUDGET_WIDTHS);require(row['widthBucket'] not in seen_widths,'DISTINCT_WIDTH_BINS_REQUIRED');seen_widths.add(row['widthBucket']);checked_numbers(row,fields,1e9,True);finite_enum(row['lastTypedErrorCode'],ATTR_CODES)
 entries=budget['recentEntries'];require(type(entries) is list and len(entries)<=8,'FINITE_RECENT_BUDGET_BOUND_REQUIRED')
 first=budget['firstFailedEntry'];require(first is None or type(first) is dict,'FIRST_FAILED_ENTRY_OR_UNKNOWN_REQUIRED')
 for row in entries+([] if first is None else [first]):
  number_fields=['widthMs','remainingMs','remainingMsAtSettlement'];clock_fields=['workRemainingMs','outerRemainingMs','workRemainingMsAtSettlement','outerRemainingMsAtSettlement'];flags=['signalAborted','settled','requestError','signalAbortedAtSettlement'];exact_keys(row,['phase','callOrdinal','widthBucket',*number_fields,*clock_fields,'elapsedMs',*flags,'typedErrorCode','callsiteTag','fetchEntryFrames','deliveryClass']);finite_enum(row['phase'],PHASES);finite_enum(row['widthBucket'],BUDGET_WIDTHS);finite_enum(row['typedErrorCode'],ATTR_CODES);checked_numbers(row,['callOrdinal'],4,True);checked_numbers(row,number_fields,225001);checked_numbers(row,clock_fields,300001);checked_numbers(row,['elapsedMs']);checked_bools(row,flags)
  finite_enum(row['deliveryClass'],['NOT_SENT','SENT_REPLY','UNKNOWN']);finite_enum(row['callsiteTag'],FETCH_CALLSITE_TAGS);frames=row['fetchEntryFrames'];require(type(frames) is list and len(frames)<=8,'FINITE_FETCH_ENTRY_FRAME_BOUND_REQUIRED');seen_frames=set()
  for frame in frames:
   exact_keys(frame,['sourceBasename','line']);finite_enum(frame['sourceBasename'],FRAME_BASENAMES);require(type(frame['line']) is int and 1<=frame['line']<=1000000,'FINITE_FETCH_ENTRY_FRAME_LINE_REQUIRED');identity=(frame['sourceBasename'],frame['line']);require(identity not in seen_frames,'DISTINCT_FETCH_ENTRY_FRAMES_REQUIRED');seen_frames.add(identity)
  tags={'stage8LiveProducer.js':'LIVE_PRODUCER','stage8LiveExecution.js':'LIVE_EXECUTION','processingTransaction.js':'PROCESSING_TRANSACTION','phase4Core.js':'CORE_CONTEXT','db.js':'DB_HTTP'}
  selected=next((frame for frame in frames if frame['sourceBasename'] in ['stage8LiveProducer.js','stage8LiveExecution.js']),frames[0] if frames else None)
  require(row['callsiteTag']==(tags.get(selected['sourceBasename'],'KNOWN_APP_SOURCE') if selected else 'UNKNOWN'),'FETCH_TAG_MUST_MATCH_NATIVE_FRAME_PROJECTION')
 if first is not None:require(first['settled'] is True and first['requestError'] is True,'FIRST_ENTRY_MUST_BE_OBSERVED_FAILED_SETTLEMENT')
 return {key:value for key,value in record.items() if key!='contract'}
class DiagnosticCollector:
 def __init__(self,output,binding):self.output=output;self.binding=binding;self.seen=set();self.faults=set();self.reports={};self.budgetAttributions={};self.emitted=0
 def emit(self,event,metadata=None):
  require(event in ['PROGRESS','APP_REPORT','METADATA_UNREADABLE','RECORD_LIMIT','HOST_NATIVE_LAUNCH','HOST_TIMEOUT','HOST_CONTROL_REFUSED','BUDGET_ATTRIBUTION'],'FINITE_PUBLIC_DIAGNOSTIC_EVENT_REQUIRED')
  if self.emitted>=96:return
  self.emitted+=1
  value={'contract':'stage6-native-cold-diagnostic-public-v1','candidateSha':self.binding['candidateSha'],'event':event,'metadata':metadata,'sqlOwnerSettlement':'UNKNOWN','productionEvidence':False,'actualNativeQualified':False,'wholeJobCompletionQualified':False,'capacityQualified':False}
  print('STAGE6_NATIVE_COLD_DIAGNOSTIC '+json.dumps(value,separators=(',',':')),flush=True)
 def unreadable(self,key):
  if key not in self.faults:self.faults.add(key);self.emit('METADATA_UNREADABLE')
 def collect(self):
  paths=list(itertools.islice(itertools.chain(self.output.glob('[AB]-progress-*.private.json'),self.output.glob('shell-progress-*.private.json')),65))
  if len(paths)>64:self.unreadable('LIMIT');self.emit('RECORD_LIMIT');paths=paths[:64]
  for path in sorted(paths):
   if path.name in self.seen:continue
   if not re.fullmatch(r'(?:[AB]-progress-(?:0[0-9]|1[0-9]|2[0-4])|shell-progress-(?:0[1-9]|1[0-4]))\.private\.json',path.name):self.unreadable('NAME');continue
   try:
    _,record=private_json(path,4096);projected=diagnostic_projection(record);self.seen.add(path.name);self.emit('PROGRESS',projected)
   except Exception:self.unreadable(path.name)
  for label in ['A','B']:
   path=self.output/(label+'-budget-attribution.private.json')
   if label in self.budgetAttributions or not path.exists():continue
   try:
    _,record=private_json(path,32768);projected=budget_attribution_projection(record)
    require(record['candidateSha']==self.binding['candidateSha'] and record['phase']==label,'SAME_ACTUAL_BUDGET_ATTRIBUTION_REQUIRED')
    self.budgetAttributions[label]=projected;self.emit('BUDGET_ATTRIBUTION',projected)
   except Exception:self.unreadable('BUDGET_ATTRIBUTION_'+label)
  for label in ['A','B']:
   path=self.output/(label+'-result.private.json')
   if label in self.reports or not path.exists():continue
   try:
    _,report=private_json(path,8*1024*1024)
    require(type(report) is dict and report.get('contract')=='stage6-three-call-two-os-cold-progress-proposal-v1' and report.get('phase')==label and report.get('candidateSha')==self.binding['candidateSha'],'BOUND_PRIVATE_APP_REPORT_REQUIRED')
    self.reports[label]=report;self.emit('APP_REPORT',report_projection(label,report))
   except Exception:self.unreadable('REPORT_'+label)
  return self.reports.get('A'),self.reports.get('B')
def wait_with_diagnostics(child,deadline_ns,collector):
 # Each wait yields up to one second; finite302 passes, no busy/convergence loop.
 for _ in range(302):
  collector.collect();remaining=(deadline_ns-time.monotonic_ns())/1000000000
  if remaining<=0:collector.emit('HOST_TIMEOUT');return None
  try:
   code=child.wait(timeout=min(1.0,remaining));collector.collect();return code
  except subprocess.TimeoutExpired:pass
 collector.emit('HOST_TIMEOUT');return None

def safe_summary(result,a=None,b=None):
 """Closed public projection; all raw activation/identity/SQLite/logs stay private."""
 def enum(value,values):return value if type(value) is str and value in values else 'UNKNOWN'
 out={'contract':'stage6-native-cold-progress-ci-safe-summary-v1','candidateSha':result.get('candidateSha') if HEX40.fullmatch(str(result.get('candidateSha',''))) else None,'applicationBaselineSha':APP_BASE,'profile':PROFILE,'status':enum(result.get('status'),STATUSES),'productionEvidence':False,'actualNativeQualified':False,'wholeJobCompletionQualified':False,'capacityQualified':False,'serverEnforcedAbsoluteTransactionLimit':'UNKNOWN','callsStartedA':known_count(mapping(a).get('callsStarted'),3),'callsStartedB':known_count(mapping(b).get('callsStarted'),3),'nativeRuntimeMs':safe_number(result.get('nativeRuntimeMs')),'exitCode':safe_number(result.get('exitCode')),'buildCompleted':result.get('buildCompleted') is True,'ownedRuntimeCleanupConfirmed':result.get('ownedRuntimeCleanupConfirmed') is True,'worktreeCleanupConfirmed':result.get('worktreeCleanupConfirmed') is True,'cleanHeadUnchanged':result.get('cleanHeadUnchanged') is True,'coldApplicationPidDifferent':type((a or {}).get('pid')) is int and type((b or {}).get('pid')) is int and a['pid']!=b['pid'],'samePersistentSqliteOwner':type((a or {}).get('serverPid')) is int and (a or {}).get('serverPid')==(b or {}).get('serverPid'),'controlFailureCode':enum(result.get('controlFailureCode'),['CONTROL_REFUSED','CONTROL_TIMEOUT','CONTROL_SUBPROCESS_ERROR','NONE'])}
 for label,report in [('A',a),('B',b)]:out[label]=report_projection(label,report)
 return out

def main():
 require(len(sys.argv) in [2,3] and sys.argv[1] in ['--run','--cleanup-only'],'EXPLICIT_NEW_CONTROLLER_MODE_REQUIRED')
 launch=sys.argv[1]=='--run';binding=gate(launch=launch) # Before any Git/Docker/source/provider I/O.
 sandbox,name,image=paths(os.environ)
 if not launch:
  require(sandbox.is_dir() and not sandbox.is_symlink(),'ORIGINAL_OWNERSHIP_PROVENANCE_REQUIRED')
  owned_cleanup(sandbox,name,binding)
  return 0
 require(len(sys.argv)==3,'EXPLICIT_IMMUTABLE_SOURCE_PATH_REQUIRED');source=pathlib.Path(sys.argv[2]).resolve();workspace=pathlib.Path(os.environ['GITHUB_WORKSPACE']).resolve()
 require(source==workspace/'candidate-repository' and (source/'.git').is_dir() and not (source/'.git').is_symlink(),'ACTUAL_CI_CHECKOUT_REQUIRED')
 expected=binding['candidateSha'];origin=run(['git','-C',str(source),'remote','get-url','origin']);require(origin.removesuffix('.git')=='https://github.com/'+REPOSITORY,'EXACT_PUBLIC_SOURCE_ORIGIN_REQUIRED')
 clean_head(source,expected);manifest,baseline_raw=validate_source(source,binding);public_lock(source/'package-lock.json')
 require(not run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$']),'NO_EXISTING_RUNTIME_REUSE')
 sandbox.mkdir(mode=0o700);once(sandbox/'original-operation.private.json',{'contract':'one-original-three-call-cold-ci-operation-v1','candidateSha':expected,'choiceSha256':binding['choiceSha256'],'intentSha256':binding['intentSha256'],'operationId':binding['operationId'],'runId':os.environ['GITHUB_RUN_ID'],'runAttempt':1,'maximumDispatchAttempts':1,'maximumOriginalCalls':3,'automaticRedispatchAllowed':False})
 record_not_invoked(sandbox,name,binding)
 checkout=sandbox/'candidate';context=sandbox/'context';context.mkdir(mode=0o700);output=sandbox/'output';output.mkdir(mode=0o700)
 result={'candidateSha':expected,'status':'UNQUALIFIED','buildCompleted':False,'ownedRuntimeCleanupConfirmed':False,'worktreeCleanupConfirmed':False,'cleanHeadUnchanged':False,'controlFailureCode':'NONE'};a=b=None;native_started=None;collector=None
 try:
  run(['git','-C',str(source),'worktree','add','--detach',str(checkout),expected],30);clean_head(checkout,expected);validate_source(checkout,binding)
  common=pathlib.Path(run(['git','-C',str(checkout),'rev-parse','--git-common-dir']));common=(checkout/common).resolve() if not common.is_absolute() else common.resolve();require(common.is_dir(),'REAL_GIT_COMMON_DIRECTORY_REQUIRED')
  for path in [checkout,common,output]:require(not any(c in str(path) for c in ['\n','\r',',',':']),'SAFE_MOUNT_PATHS_REQUIRED')
  for name_copy in ['package.json','package-lock.json']:shutil.copyfile(checkout/name_copy,context/name_copy)
  dockerfile=source/'tools/stage8-qualification/Dockerfile.native-empty-ci';text=dockerfile.read_text();require(('FROM '+NODE_IMAGE+'\n') in text and ('FROM '+SQLD_IMAGE+' AS sqld\n') in text,'EXACT_OFFICIAL_OCI_CHILDREN_REQUIRED');shutil.copyfile(dockerfile,context/'Dockerfile')
  build=['docker','build','--force-rm','--pull','--platform','linux/amd64','--network','default','--tag',image,'--build-arg','QUALIFICATION_ROOT='+str(checkout),'--build-arg','QUALIFICATION_UID='+str(os.getuid()),'--build-arg','QUALIFICATION_GID='+str(os.getgid()),str(context)]
  result['status']='BUILD_FAILED_OR_UNKNOWN'
  with (sandbox/'build.private.log').open('w') as log:subprocess.run(build,check=True,stdout=log,stderr=subprocess.STDOUT,timeout=360)
  result['buildCompleted']=True;docker_arch=run(['docker','info','--format','{{.Architecture}}']);require(docker_arch in ['x86_64','amd64'],'ACTUAL_NATIVE_DOCKER_ARCH_REQUIRED')
  info=json.loads(run(['docker','image','inspect',image]))[0];require(info['Os']=='linux' and info['Architecture']=='amd64' and bool(HEX64.fullmatch(info['Id'].removeprefix('sha256:'))),'ACTUAL_LINUX_AMD64_IMAGE_REQUIRED')
  activation={'contract':'root-technical-native-cold-progress-source-activation-v1','sourceGO':True,'independentReviewAcceptedByRoot':True,'independentSourceReviewSha256':binding['reviewSha256'],'applicationBaselineSha':APP_BASE,'candidateSha':expected,'maximumOriginalCalls':3,'processLegs':2,'maximumWallMs':300000,'maintenanceAuthorized':False,'productionActionsAuthorized':False,'newOwnerMaintenanceApprovalClaimed':False,'requestIds':REQUESTS,'maximumAttempts':1,'syntheticOnly':True,'applicationSourceManifestSha256':digest(baseline_raw),'proposalSourcePins':{path:manifest['files'][path] for path in RUNTIME_PATHS}}
  activation_path=sandbox/'native-activation.private.json';activation_sha=once(activation_path,activation)
  baseline_path=sandbox/'baseline.private.json';fd=os.open(baseline_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'wb') as stream:stream.write(baseline_raw);stream.flush();os.fsync(stream.fileno())
  once(sandbox/'owned-runtime-state.private.json',{'candidateSha':expected,'intentSha256':binding['intentSha256'],'name':name,'imageId':info['Id']})
  args=['docker','run','--cidfile',str(sandbox/'container.cid'),'--name',name,'--label','healthos.stage6.native-cold='+name,'--label','healthos.stage6.intent='+binding['intentSha256'],'--platform','linux/amd64','--network','none','--memory','536870912','--memory-swap','536870912','--cpus','0.5','--pids-limit','128','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--cgroupns','private','--user',str(os.getuid())+':'+str(os.getgid()),'--tmpfs','/tmp:rw,nosuid,nodev,mode=1777,size=67108864','--workdir',str(checkout)]
  args+=readonly_source_mount_args(checkout,common)
  host_path=sandbox/'native-host-proof.private.json';args+=['--mount','type=bind,src='+str(host_path)+',dst=/native-host-proof.json,readonly','--mount','type=bind,src='+str(activation_path)+',dst=/native-cold-source-activation.json,readonly','--mount','type=bind,src='+str(baseline_path)+',dst=/ca01-application-source-manifest.json,readonly','--mount','type=bind,src='+str(output)+',dst=/qualification','--entrypoint','/bin/sh',image,'-c','exec /bin/sh test/stage6-native-cold-progress.sh']
  clean_head(source,expected);clean_head(checkout,expected);validate_source(checkout,binding)
  require(binding['choice']['issuedAtMs']<=time.time_ns()//1000000<binding['choice']['expiresAtMs'],'ORIGINAL_ROOT_CHOICE_EXPIRED_BEFORE_NATIVE_START')
  native_started=time.monotonic_ns();deadline_ns=native_started+300000000000
  host={'contract':'stage6-native-host-observation-v1','diagnosticContract':PROFILE,'monotonicClock':'LINUX_CLOCK_MONOTONIC_SHARED_KERNEL','candidateSha':expected,'platform':sys.platform,'machine':platform.machine(),'runnerArchitecture':os.environ['RUNNER_ARCH'],'dockerArchitecture':docker_arch,'imageArchitecture':info['Architecture'],'requestedPlatform':'linux/amd64','nativeStartedMonotonicNs':str(native_started)};once(host_path,host)
  result['status']='NATIVE_RUNNING';collector=DiagnosticCollector(output,binding);collector.emit('HOST_NATIVE_LAUNCH')
  with (sandbox/'container.private.log').open('w') as log:
   launch_intent(sandbox,name,binding,args)
   child=subprocess.Popen(args,stdout=log,stderr=subprocess.STDOUT)
   result['exitCode']=wait_with_diagnostics(child,deadline_ns,collector)
   if result['exitCode'] is not None:record_launch_terminal(sandbox,name,binding,result['exitCode'])
   a,b=collector.collect()
   if result['exitCode'] is None:result['status']='NATIVE_OR_SETTLEMENT_UNKNOWN_RETAINED'
  result['nativeRuntimeMs']=(time.monotonic_ns()-native_started)/1000000
  if result.get('exitCode')==0:
   require(set(collector.budgetAttributions)=={'A','B'} and all(collector.budgetAttributions[label]['stage']=='LEG_METADATA_READY' and collector.budgetAttributions[label]['callIntents']==calls for label,calls in [('A',2),('B',3)]),'COMPLETE_BOUNDED_ATTRIBUTION_METADATA_REQUIRED_OR_UNKNOWN')
   require(a is not None and b is not None,'BOTH_ACTUAL_REPORTS_REQUIRED_FOR_ACCEPTANCE')
   validate_reports(a,b,binding,activation_sha,host,result['nativeRuntimeMs'])
   call_files=sorted(output.glob('original-call-*.intent.private.json'));require([f.name for f in call_files]==['original-call-1.intent.private.json','original-call-2.intent.private.json','original-call-3.intent.private.json'],'NO_FOURTH_ORIGINAL_OR_CHANGED_CALL_SET')
   validate_call_intents([private_json(f)[1] for f in call_files],binding,activation_sha,a,b);result['status']='METADATA_OBSERVED_PENDING_INDEPENDENT_ACTUAL_REVIEW'
  elif result.get('exitCode') is not None:result['status']='NEGATIVE_OR_INCOMPLETE_METADATA'
 except Exception as error:
  if collector is not None:collector.emit('HOST_CONTROL_REFUSED');a,b=collector.collect()
  result['status']='NEGATIVE_OR_INCOMPLETE_METADATA'
  result['controlFailureCode']='CONTROL_TIMEOUT' if isinstance(error,subprocess.TimeoutExpired) else 'CONTROL_SUBPROCESS_ERROR' if isinstance(error,subprocess.CalledProcessError) else 'CONTROL_REFUSED'
  result['controlFailureMessageSha256']=digest(str(error).encode())
 finally:
  if collector is not None:a,b=collector.collect()
  try:owned_cleanup(sandbox,name,binding);result['ownedRuntimeCleanupConfirmed']=True
  except Exception:result['status']='CLEANUP_UNCONFIRMED'
  try:clean_head(source,expected);clean_head(checkout,expected);validate_source(checkout,binding);result['cleanHeadUnchanged']=True
  except Exception:result['status']='SOURCE_CHANGED_OR_UNAVAILABLE'
  if result['ownedRuntimeCleanupConfirmed'] and result['cleanHeadUnchanged'] and (checkout/'.git').is_file():
   try:run(['git','-C',str(source),'worktree','remove',str(checkout)],30);result['worktreeCleanupConfirmed']=not checkout.exists()
   except Exception:result['status']='CLEANUP_UNCONFIRMED'
  else:result['worktreeCleanupConfirmed']=not checkout.exists()
  if not result['ownedRuntimeCleanupConfirmed'] or not result['worktreeCleanupConfirmed']:result['status']='CLEANUP_UNCONFIRMED'
  if native_started is not None:
   result['nativeRuntimeMs']=(time.monotonic_ns()-native_started)/1000000
   if result['nativeRuntimeMs']>=300000:result['status']='ORIGINAL_300S_WALL_UNQUALIFIED'
  summary=safe_summary(result,a,b);once(sandbox/'safe-summary.private.json',summary)
  if native_started is not None and (time.monotonic_ns()-native_started)>=300000000000:
   result['nativeRuntimeMs']=(time.monotonic_ns()-native_started)/1000000;result['status']='ORIGINAL_300S_WALL_UNQUALIFIED';summary=safe_summary(result,a,b);once(sandbox/'safe-summary-final-wall.private.json',summary)
  print('STAGE6_NATIVE_COLD_PROGRESS_SAFE_SUMMARY '+json.dumps(summary,separators=(',',':')),flush=True)
 return 0 if result['status']=='METADATA_OBSERVED_PENDING_INDEPENDENT_ACTUAL_REVIEW' else 2

if __name__=='__main__':
 os.umask(0o077)
 try:sys.exit(main())
 except Exception as error:
  print('STAGE6_NATIVE_COLD_PROGRESS_START_REFUSED '+json.dumps({'code':'CONTROL_START_REFUSED','messageSha256':digest(str(error).encode()),'nativeQualified':False,'capacityQualified':False},separators=(',',':')));sys.exit(2)

"""Private diagnostic-only concrete wiring. No import-time Docker/Git/network action.
Requires Root materialization, independent review and a separate explicit one-call run intent.
"""
import hashlib,json,os,pathlib,platform,re,shutil,subprocess,sys,time
SOURCE_STATUS='PRIVATE_DIAGNOSTIC_WIRING_REQUIRES_ROOT_RUN_INTENT'
APP_BASE='b1a0f06e6f8070a7bb2f5ca2ace17f3ebaa4289c'
REPOSITORY='enjoyfulwen0204-eng/whoop-briefing'
REF='refs/heads/diagnostic/native-empty-attribution-20261020'
NODE_IMAGE='node@sha256:ae9f58d5c9f5a537110310be6b3cf67cf9c67146a3bb9310c0cb515fe71c8392'
SQLD_IMAGE='ghcr.io/tursodatabase/libsql-server@sha256:756fb4d34447cfa9507dceb3a8e680435d7f2173e2aa680f44a1329e774f7d31'
HEX40=re.compile(r'^[a-f0-9]{40}$');HEX64=re.compile(r'^[a-f0-9]{64}$')
def run(args,seconds=10):
 env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')} if args[0]=='git' else None
 return subprocess.run(args,env=env,check=True,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=seconds).stdout.strip()
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def write(path,data):path.write_text(json.dumps(data,indent=2)+'\n');path.chmod(0o600)
def gate():
 assert SOURCE_STATUS=='PRIVATE_DIAGNOSTIC_WIRING_REQUIRES_ROOT_RUN_INTENT'
 assert os.environ.get('NATIVE_DIAGNOSTIC_RUN_INTENT')=='one-original-empty-120s-v1','EXPLICIT_SEPARATE_DIAGNOSTIC_RUN_INTENT_REQUIRED'
 for image in [NODE_IMAGE,SQLD_IMAGE]:assert re.fullmatch(r'(node|ghcr.io/tursodatabase/libsql-server)@sha256:[a-f0-9]{64}',image),'OFFICIAL_OCI_CHILD_PINS_REQUIRED'
 assert os.environ.get('GITHUB_REPOSITORY')==REPOSITORY
 assert os.environ.get('GITHUB_EVENT_NAME')=='workflow_dispatch'
 assert os.environ.get('GITHUB_REF')==REF
 assert os.environ.get('QUALIFICATION_MODE')=='native-empty-attribution'
 assert os.environ.get('QUALIFICATION_REPOSITORY_PRIVATE')=='false','PUBLIC_REPOSITORY_COST_SCOPE_REQUIRED'
 expected=os.environ.get('CANDIDATE_SHA','');assert HEX40.fullmatch(expected)
 assert expected==os.environ.get('GITHUB_SHA')==os.environ.get('QUALIFICATION_WORKFLOW_SHA'),'SAME_REVIEWED_WORKFLOW_AND_CANDIDATE_SHA_REQUIRED'
 assert platform.system()=='Linux' and platform.machine()=='x86_64'
 assert os.environ.get('RUNNER_OS')=='Linux' and os.environ.get('RUNNER_ARCH')=='X64'
 assert os.getuid()>0 and os.getgid()>0
 for key in ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT']:assert re.fullmatch(r'[1-9][0-9]*',os.environ.get(key,''))
 assert os.environ.get('GITHUB_RUN_ATTEMPT')=='1','NO_DIAGNOSTIC_RETRY_CAMPAIGN'
 return expected
def clean_head(path,expected):
 assert run(['git','--no-optional-locks','-C',str(path),'rev-parse','--verify','HEAD^{commit}'],2)==expected
 assert not run(['git','--no-optional-locks','-C',str(path),'status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none'],5),'CLEAN_TRACKED_AND_UNTRACKED_REQUIRED'
def paths():
 root=pathlib.Path(os.environ['RUNNER_TEMP']).resolve();assert root.is_dir()
 suffix=os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']
 return root/('stage6-diagnostic-'+suffix),'stage6-diagnostic-'+suffix,'stage6-diagnostic:'+suffix

def public_lock(path):
 from urllib.parse import urlsplit
 lock=json.loads(path.read_text());assert lock.get('lockfileVersion') in [2,3]
 assert len(lock.get('packages',{}))<10000
 for item in lock.get('packages',{}).values():
  assert not item.get('link'),'NO_LINKED_DEPENDENCY'
  if 'resolved' in item:
   u=urlsplit(item['resolved']);assert u.scheme=='https' and u.hostname=='registry.npmjs.org' and not u.username and not u.password and not u.query and not u.fragment,'PUBLIC_NPM_LOCK_ONLY'

def owned_cleanup(sandbox,name):
 observed=run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$'])
 cidpath=sandbox/'container.cid';captured=cidpath.read_text().strip() if cidpath.exists() else None
 assert captured or not observed,'MISSING_CREATED_CID_COLLISION_NO_REMOVAL'
 if captured:
  assert HEX64.fullmatch(captured),'CAPTURED_CREATION_CID_REQUIRED'
  present=run(['docker','ps','-aq','--no-trunc','--filter','id='+captured])
  if present:
   state=json.loads((sandbox/'owned-runtime-state.json').read_text())
   assert state['name']==name and state['candidateSha']==os.environ['CANDIDATE_SHA']
   info=json.loads(run(['docker','container','inspect',captured]))[0]
   assert info['Id']==captured and info['Name']=='/'+name and info['Image']==state['imageId']
   assert info['Config']['Labels'].get('healthos.stage6.native-diagnostic')==name
   assert info['State']['Running'] is False,'RUNNING_OR_UNKNOWN_OWNED_RUNTIME_REQUIRES_ROOT_DISPOSITION_NO_FORCE_REMOVAL'
   subprocess.run(['docker','rm',captured],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
  assert not run(['docker','ps','-aq','--no-trunc','--filter','id='+captured])
 assert not run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$'])
 return True

def read_report(path):
 if not path.is_file():return None
 assert not path.is_symlink() and path.stat().st_size<=8*1024*1024
 return json.loads(path.read_text())
def safe_number(value):return value if type(value) in [int,float] and 0<=value<10**12 else None

PHASES=['SETUP_SCHEMA1_TO35_SYNTHETIC_ONLY','SETUP_EMPTY_FIXTURE','ADMISSION_AND_COMPOSITION','GENUINE_ORIGINAL_PRODUCER_CALL','READBACK','EXACT_ORIGINAL_REPLAY','CLEANUP','UNKNOWN']
CATEGORIES=['TX_BEGIN','TX_COMMIT','TX_ROLLBACK','DDL','PRAGMA','SCHEMA_CATALOG','SCHEMA_VERSION','MIGRATION_METADATA','AUTHORITY_ASSERTION','PRINCIPAL_READINESS','CONTEXT_LEASE_RELEASE','EXECUTION_CONTROL','OPERATION_RECEIPT','CONTEXT_LEASE','QUEUE_CONTROL','FAMILY_DIRECTORY','SOURCE_DATA','DERIVED_DATA','OTHER']
UNITS=['CREATE_DB','MIGRATE','SEED_EMPTY_FIXTURE','RUNTIME_ADMISSION','BUILD_LIVE_PRODUCER','ORIGINAL_PRODUCER_RUN','READBACK','ORIGINAL_REQUEST_REPLAY','CLEANUP','UNKNOWN']
EXECUTION_STATES=['ESTABLISHED','WORK_COMMITTED','FINALIZED_SUCCESS','FINALIZED_FAILURE','UNKNOWN']
OUTCOMES=['COMPLETE','PARTIAL','NO_WORK','NO_ELIGIBLE_WORK','BUDGET_EXHAUSTED','FAILED','UNKNOWN']
CODES=['SYNC_TIMEOUT','SYNC_CANCELLED','PHASE4_DRAIN_DEADLINE_REACHED','COMMIT_INDETERMINATE','RUNTIME_REPLACEMENT_REQUIRED','SQLITE_BUSY','SQLITE_LOCKED','PHASE4_LIVE_NOT_AUTHORIZED','STAGE8_LIVE_PRINCIPAL_FENCED','OTHER','NONE']
def safe_enum(value,values):return value if value in values else 'UNKNOWN'
def safe_bool(value):return value if type(value) is bool else None
def numbers(value,keys):return {k:safe_number((value or {}).get(k)) for k in keys}
def safe_progress(value):
 if not isinstance(value,dict) or value.get('readbackStatus')!='OBSERVED':return {'readbackStatus':'UNKNOWN'}
 out={'readbackStatus':'OBSERVED',**numbers(value,['originalJobsCompleted','sourceRows','outboundMessages','pilotLedgers','currentPublications','inputGeneration','lastCompletedGeneration','computationGenerationLag','executionWorkReceiptCount'])}
 out['currentComputation']=safe_bool(value.get('currentComputation'))
 execution=value.get('execution') or {}
 out['execution']={'executionState':safe_enum(execution.get('executionState'),EXECUTION_STATES),'executionStateKnown':safe_bool(execution.get('executionStateKnown')),'terminalStateObserved':safe_bool(execution.get('terminalStateObserved')),'resultOutcome':safe_enum(execution.get('resultOutcome'),OUTCOMES),'callAcknowledgement':safe_enum(execution.get('callAcknowledgement'),['RETURNED','THREW','ACK_LOST','UNKNOWN'])}
 out['executionWorkReceiptReadback']=safe_enum(value.get('executionWorkReceiptReadback'),['OBSERVED','NONE','UNKNOWN'])
 out['jobs']=[]
 for kind in ['RECOMPUTE_DERIVED','REPAIR_CURRENTNESS']:
  rows=[j for j in value.get('jobs',[]) if isinstance(j,dict) and j.get('kind')==kind]
  if len(rows)!=1:out['jobs'].append({'kind':kind,'state':'UNKNOWN'});continue
  j=rows[0];out['jobs'].append({'kind':kind,'state':safe_enum(j.get('state'),['PENDING','RUNNING','RETRY_WAIT','REPAIR_REQUIRED','COMPLETED','UNKNOWN']),**numbers(j,['generationLag','requestedGeneration','completedGeneration']),'observed':safe_bool(j.get('observed')),'generationEquality':safe_bool(j.get('generationEquality')),'hasFullScanCursor':safe_bool(j.get('hasFullScanCursor')),'cursorSha256':j.get('cursorSha256') if HEX64.fullmatch(str(j.get('cursorSha256',''))) else None})
 return out
OPERATIONS=['PHASE_ADMISSION','PHASE_CLAIM','PHASE_WORK','PHASE_SETTLEMENT','WEBHOOK_DRAIN','ONBOARDING','USER_RUN','USER_MAINTENANCE','WHOOP_AUTH','DAILY_REPORT','WEEKLY_REPORT','WHOOP_SYNC','FAST_RECONCILIATION','PROACTIVE','ANALYSIS_INPUTS','PREDICTION','HEALTHSPAN','SYSTEM_MAINTENANCE','DB_QUERY','DB_METADATA','RUNTIME_READMISSION','DB_HTTP','WHOOP_HTTP','WHOOP_BODY','MODEL_HTTP','MODEL_BODY','TELEGRAM_HTTP','TELEGRAM_BODY']
FRAMES=['stage8LiveProducer.js','stage8LiveExecution.js','phase4Cache.js','executionBudget.js','processingTransaction.js','db.js','phase4Reanalysis.js','phase4Core.js','phase4QueueStore.js','phase4ExecutionContext.js','phase4Coordination.js']
def safe_telemetry(value):
 value=value if isinstance(value,dict) else {};summary=value.get('summary') or {}
 return {'summary':{'outcome':safe_enum(summary.get('outcome'),OUTCOMES+['TIMEOUT','CANCELLED','COMMIT_INDETERMINATE','COMPLETE_SUCCESS','NO_NEW_DATA_SUCCESS','INTENTIONALLY_INAPPLICABLE','REQUIRED_RESOURCE_FAILED','AUTH_FAILED','DISABLED','POLICY_DEFERRED']),**numbers(summary,['query_count','metadata_query_count','runtime_readmissions','db_http_requests','whoop_requests','model_requests','telegram_requests','retry_count','duration_ms','operation_count','outstanding_operations','dropped_events'])},'totals':{op:numbers(fields,['count','completed_operations','failed_operations','timed_out','cancelled','duration_ms','max_duration_ms']) for op,fields in (value.get('totals') or {}).items() if op in OPERATIONS},'outstanding':{op:numbers(fields,['count','duration_ms']) for op,fields in (value.get('outstanding') or {}).items() if op in OPERATIONS},'invalidEnumEvents':safe_number(value.get('invalidEnumEvents'))}
def safe_failure(value):
 value=value if isinstance(value,dict) else {}
 return {'phase':safe_enum(value.get('phase'),PHASES),'code':safe_enum(value.get('code'),CODES),'sourceSites':{'producerContextCleanupFrameObserved':safe_bool((value.get('sourceSites') or {}).get('producerContextCleanupFrameObserved')),'sharedContextReleaseFrameObserved':safe_bool((value.get('sourceSites') or {}).get('sharedContextReleaseFrameObserved')),'innerSemanticWorkUnit':'UNKNOWN_NOT_INSTRUMENTED','interpretation':'PINNED_SOURCE_FRAME_EVIDENCE_ONLY'},'frames':[{'sourceBasename':f['sourceBasename'],'line':f['line']} for f in value.get('frames',[])[:8] if isinstance(f,dict) and f.get('sourceBasename') in FRAMES and type(f.get('line')) is int and 1<=f['line']<=1000000]}
def signed_number(value):return value if type(value) in [int,float] and -10**12<value<10**12 else None
def safe_delta(value):
 if not isinstance(value,dict) or value.get('status')!='OBSERVED':return {'status':'UNKNOWN'}
 out={'status':'OBSERVED',**{k:signed_number(value.get(k)) for k in ['inputGenerationDelta','completedGenerationDelta','originalJobsCompletedDelta']},'jobs':[]}
 for kind in ['RECOMPUTE_DERIVED','REPAIR_CURRENTNESS']:
  rows=[j for j in value.get('jobs',[]) if isinstance(j,dict) and j.get('kind')==kind];j=rows[0] if len(rows)==1 else {}
  out['jobs'].append({'kind':kind,'cursorChanged':safe_bool(j.get('cursorChanged')),**{k:signed_number(j.get(k)) for k in ['requestedGenerationDelta','completedGenerationDelta']}})
 return out
def safe_summary(result,source):
 source=source or {};failure=source.get('failure') or {};attribution=source.get('attribution') or {}
 out={k:result.get(k) for k in ['contract','candidateSha','status','stage','buildCompleted','nativeRuntimeSeconds','exitCode','cleanupConfirmed','cleanHeadUnchanged']}
 out.update({'productionEvidence':False,'capacityQualified':False,'scope':'ONE_EMPTY_ORIGINAL_CALL_DIAGNOSTIC_ONLY_NO_REPLAY','serverEnforcedAbsoluteTransactionLimit':'UNKNOWN','callsStarted':safe_number(source.get('callsStarted')) if source.get('observationPoint')=='AFTER_AWAITED_CLEANUP' else None,'observationPoint':safe_enum(source.get('observationPoint'),['BEFORE_ORIGINAL_INVOCATION','JOINING_OWNED_CLEANUP','AFTER_AWAITED_CLEANUP','UNKNOWN']),'originalCallReturned':safe_bool(source.get('originalCallReturned')),'before':safe_progress(source.get('before')),'after':safe_progress(source.get('after')),'failure':{'phase':safe_enum(failure.get('phase'),PHASES),'code':safe_enum(failure.get('code'),CODES)}})
 out['failure']=safe_failure(source.get('failure'));out['readbackFailure']=safe_failure(source.get('readbackFailure'));out['cleanupFailure']=safe_failure(source.get('cleanupFailure'))
 out['progressDelta']=safe_delta(source.get('progressDelta'));returned=source.get('returned') or {};out['returned']={'resultOutcome':safe_enum(returned.get('resultOutcome'),OUTCOMES),**numbers(returned,['itemsProcessed','jobsCompleted','jobsFailed','remainingJobs','unitsCommitted'])}
 out['skipReason']=source.get('skipReason') if source.get('skipReason')=='SETUP_AND_OBSERVATION_LEFT_INSUFFICIENT_ORIGINAL_CALL_RESERVE' else None
 out['controlFailureType']=safe_enum(result.get('controlFailureType'),['CalledProcessError','TimeoutExpired','AssertionError','RuntimeError','FileNotFoundError','ValueError'])
 out['telemetry']=safe_telemetry(source.get('telemetry'))
 resources=source.get('resources') or {};events=dict(line.split() for line in str(resources.get('memoryEvents','')).splitlines() if len(line.split())==2)
 out['resources']={'node':resources.get('node') if resources.get('node')=='v22.23.2' else None,'architecture':safe_enum(resources.get('architecture'),['x64','arm64']),**{key:safe_number(int(str(resources.get(field,'')))) if str(resources.get(field,'')).isdigit() else None for key,field in [('memoryPeakBytes','memoryPeak'),('memoryMaxBytes','memoryMax'),('swapMaxBytes','swapMax')]},'cpuMax':resources.get('cpuMax') if resources.get('cpuMax')=='50000 100000' else None,'oom':safe_number(int(events['oom'])) if str(events.get('oom','')).isdigit() else None,'oomKills':safe_number(int(events['oom_kill'])) if str(events.get('oom_kill','')).isdigit() else None}
 out['final']={**numbers(source.get('final'),['elapsedMs']),**{k:safe_bool((source.get('final') or {}).get(k)) for k in ['wallCompliant','cleanupJoined','terminalKnown','withinBoundAndSettled']}}
 out['attribution']={**numbers(attribution,['inflightRequests','pendingAcknowledgedBegins','unsettledTransactions','droppedObservations','droppedTransactionSamples']),**{k:safe_bool(attribution.get(k)) for k in ['transactionSampleCoverageComplete','physicalTerminalObservationComplete','observationCoverageComplete','allRequestsSettled','allAcknowledgedBeginsLinked','allTransactionsSettled','allRepliesKnown','allTransactionTerminalsKnown','terminalObservationComplete','attributionComplete']},'adapter':{**numbers(attribution.get('adapter'),['activeFetches','transportInvocations','responsesObserved','retainedStreams','unresolvedStreams','droppedObservations','unknownProtocolReplies']),**{k:safe_bool((attribution.get('adapter') or {}).get(k)) for k in ['coverageComplete','terminalComplete','attributionComplete']}},'bins':{}}
 for phase in PHASES:
  b=(attribution.get('bins') or {}).get(phase) or {};out['attribution']['bins'][phase]={**numbers(b,['requests','submittedStatements','observedExecutedStatements','requestErrors','responseErrors','unknownReplies','sumRequestDurationMs','maxRequestDurationMs','sumInjectedDelayMs','phaseWallMs']),'lastKnownOuterWorkUnit':safe_enum(b.get('lastKnownOuterWorkUnit'),UNITS),'lastStorageCategory':safe_enum(b.get('lastStorageCategory'),CATEGORIES),'lastTypedCode':safe_enum(b.get('lastTypedCode'),CODES),'transactions':numbers(b.get('transactions'),['begun','committed','rolledBack','unknownTerminal','open','sumDurationUpperBoundMs','maxDurationUpperBoundMs','atOrAbove5s']),'categories':{cat:numbers((b.get('categories') or {}).get(cat),['submitted','executed']) for cat in CATEGORIES}}
 out['attribution']['transactionSamples']=[{'startedPhase':safe_enum(x.get('startedPhase'),PHASES),'endedPhase':safe_enum(x.get('endedPhase'),PHASES),'outerWorkUnit':safe_enum(x.get('outerWorkUnit'),UNITS),'lastStorageCategory':safe_enum(x.get('lastStorageCategory'),CATEGORIES),'outcome':safe_enum(x.get('outcome'),['committed','rolledBack','unknownTerminal']),**numbers(x,['callOrdinal','requestOrdinal','beginStatementOrdinal','durationUpperBoundMs'])} for x in (attribution.get('transactionSamples') or [])[:64] if isinstance(x,dict)]
 return out

def main():
 expected=gate() # Pending gate FIRST, before any Git/Docker/provider/source I/O.
 assert len(sys.argv) in [2,3] and sys.argv[1] in ['--run','--cleanup-only']
 sandbox,name,image=paths()
 if sys.argv[1]=='--cleanup-only':
  if sandbox.exists():owned_cleanup(sandbox,name)
  return 0
 assert len(sys.argv)==3
 source=pathlib.Path(sys.argv[2]).resolve();workspace=pathlib.Path(os.environ['GITHUB_WORKSPACE']).resolve();assert source==workspace/'candidate-repository'
 assert (source/'.git').is_dir() and not (source/'.git').is_symlink()
 origin=run(['git','-C',str(source),'remote','get-url','origin']);assert origin.removesuffix('.git')=='https://github.com/'+REPOSITORY
 clean_head(source,expected);public_lock(source/'package-lock.json')
 assert run(['git','-C',str(source),'rev-parse',expected+':src'])==run(['git','-C',str(source),'rev-parse',APP_BASE+':src']),'EXACT_B1_APPLICATION_TREE_REQUIRED'
 for path in ['test/bodyEnergyFixture.js','test/stage8LiveLinuxFixture.js','test/stage6-linux-native-contract.mjs','tools/stage8-qualification/Dockerfile.native-empty-ci','package.json','package-lock.json']:
  assert run(['git','-C',str(source),'rev-parse',expected+':'+path])==run(['git','-C',str(source),'rev-parse',APP_BASE+':'+path]),'ORIGINAL_INPUT_DRIVER_AND_RESOURCE_CONTRACT_REQUIRED'
 assert not run(['docker','ps','-aq','--filter','name=^/'+name+'$'])
 sandbox.mkdir(mode=0o700);checkout=sandbox/'candidate';context=sandbox/'context';context.mkdir(mode=0o700);output=sandbox/'output';output.mkdir(mode=0o700)
 result={'contract':'stage6-native-empty-attribution-diagnostic-ci-v1','candidateSha':expected,'productionEvidence':False,'status':'UNQUALIFIED','stage':'CHECKOUT','buildCompleted':False,'cleanupConfirmed':False,'cleanHeadUnchanged':False}
 try:
  run(['git','-C',str(source),'worktree','add','--detach',str(checkout),expected],30)
  clean_head(checkout,expected);assert (checkout/'.git').is_file()
  common=pathlib.Path(run(['git','-C',str(checkout),'rev-parse','--git-common-dir']));common=(checkout/common).resolve() if not common.is_absolute() else common.resolve();assert common.is_dir()
  for path in [checkout,common,output]:assert not any(c in str(path) for c in ['\n','\r',',',':'])
  for file in ['package.json','package-lock.json']:shutil.copyfile(checkout/file,context/file)
  dockerfile=source/'tools/stage8-qualification/Dockerfile.native-empty-ci'
  text=dockerfile.read_text();assert ('FROM '+NODE_IMAGE+'\n') in text and ('FROM '+SQLD_IMAGE+' AS sqld\n') in text,'EXACT_OFFICIAL_OCI_CHILDREN_REQUIRED'
  shutil.copyfile(dockerfile,context/'Dockerfile')
  clean_head(source,expected);clean_head(checkout,expected)
  build=['docker','build','--force-rm','--pull','--platform','linux/amd64','--network','default','--tag',image,'--build-arg','QUALIFICATION_ROOT='+str(checkout),'--build-arg','QUALIFICATION_UID='+str(os.getuid()),'--build-arg','QUALIFICATION_GID='+str(os.getgid()),str(context)]
  result['stage']='IMAGE_BUILD'
  with (sandbox/'build.log').open('w') as log:subprocess.run(build,check=True,stdout=log,stderr=subprocess.STDOUT,timeout=360)
  result['buildCompleted']=True
  docker_arch=run(['docker','info','--format','{{.Architecture}}']);assert docker_arch in ['x86_64','amd64']
  info=json.loads(run(['docker','image','inspect',image]))[0];assert info['Os']=='linux' and info['Architecture']=='amd64'
  host={'diagnosticContract':'one-original-empty-120s-v1','monotonicClock':'LINUX_CLOCK_MONOTONIC_SHARED_KERNEL','contract':'stage6-native-host-observation-v1','candidateSha':expected,'platform':sys.platform,'machine':platform.machine(),'runnerArchitecture':os.environ['RUNNER_ARCH'],'dockerArchitecture':docker_arch,'imageArchitecture':info['Architecture'],'requestedPlatform':'linux/amd64'}
  proof=sandbox/'native-host-proof.json';write(proof,host);write(sandbox/'owned-runtime-state.json',{'candidateSha':expected,'name':name,'imageId':info['Id']})
  args=['docker','run','--cidfile',str(sandbox/'container.cid'),'--name',name,'--label','healthos.stage6.native-diagnostic='+name,'--platform','linux/amd64','--network','none','--memory','536870912','--memory-swap','536870912','--cpus','0.5','--pids-limit','128','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--cgroupns','private','--user',str(os.getuid())+':'+str(os.getgid()),'--tmpfs','/tmp:rw,nosuid,nodev,mode=1777,size=67108864','--workdir',str(checkout)]
  for path in [checkout/'src',checkout/'test',checkout/'scripts',checkout/'package.json',checkout/'package-lock.json',checkout/'.git',common]:args+=['--mount','type=bind,src='+str(path)+',dst='+str(path)+',readonly']
  args+=['--mount','type=bind,src='+str(proof)+',dst=/native-host-proof.json,readonly','--mount','type=bind,src='+str(output)+',dst=/qualification','--entrypoint','/bin/sh',image,'-c','exec /bin/sh test/stage6-linux-native-diagnostic.sh']
  clean_head(source,expected);clean_head(checkout,expected);result['stage']='NATIVE_RUNTIME';at=time.monotonic();host['nativeStartedMonotonicNs']=str(time.monotonic_ns());write(proof,host)
  with (sandbox/'container.log').open('w') as log:
   child=subprocess.Popen(args,stdout=log,stderr=subprocess.STDOUT)
   try:result['exitCode']=child.wait(timeout=120)
   except subprocess.TimeoutExpired:
    # Deadline expiration is not a join. Retain captured runtime; no terminate/kill/rm-f or replay.
    result['status']='DIAGNOSTIC_WALL_OR_SETTLEMENT_UNKNOWN_RUNTIME_RETAINED';result['exitCode']=None
  result['nativeRuntimeSeconds']=round(time.monotonic()-at,3)
  result['stage']='READBACK'
  diagnostic=read_report(output/'diagnostic-report.json')
  if result['exitCode']==0 and diagnostic and diagnostic.get('final',{}).get('withinBoundAndSettled') is True and result['nativeRuntimeSeconds']<=120:result['status']='DIAGNOSTIC_OBSERVATIONS_COLLECTED_NO_CAPACITY_QUALIFICATION'

 except Exception as error:
  result['controlFailureType']=type(error).__name__;result['controlFailureMessageSha256']=hashlib.sha256(str(error).encode()).hexdigest()
 finally:
  try:owned_cleanup(sandbox,name);result['cleanupConfirmed']=True
  except Exception:result['status']='CLEANUP_UNCONFIRMED_NO_QUALIFICATION'
  try:clean_head(source,expected);clean_head(checkout,expected);result['cleanHeadUnchanged']=True
  except Exception:result['status']='SOURCE_CHANGED_OR_UNAVAILABLE_NO_QUALIFICATION'
  result['ownedRuntimeCleanupConfirmed']=result['cleanupConfirmed'];result['worktreeCleanupConfirmed']=not checkout.exists()
  if result['cleanupConfirmed'] and result['cleanHeadUnchanged'] and (checkout/'.git').is_file():
   try:run(['git','-C',str(source),'worktree','remove','--force',str(checkout)],30);result['worktreeCleanupConfirmed']=not checkout.exists()
   except Exception:result['worktreeCleanupConfirmed']=False
  result['cleanupConfirmed']=result['ownedRuntimeCleanupConfirmed'] and result['worktreeCleanupConfirmed']
  if not result['cleanupConfirmed']:result['status']='CLEANUP_UNCONFIRMED_NO_QUALIFICATION'
  if 'at' in locals():result['nativeRuntimeSeconds']=round(time.monotonic()-at,3)
  if result.get('nativeRuntimeSeconds',0)>120:result['status']='DIAGNOSTIC_WALL_OR_SETTLEMENT_UNQUALIFIED'
  summary=safe_summary(result,read_report(output/'diagnostic-report.json'))
  write(sandbox/'sanitized-summary.json',summary)
  if 'at' in locals() and time.monotonic()-at>120:
   result['nativeRuntimeSeconds']=round(time.monotonic()-at,3);result['status']='DIAGNOSTIC_WALL_OR_SETTLEMENT_UNQUALIFIED';summary=safe_summary(result,read_report(output/'diagnostic-report.json'));write(sandbox/'sanitized-summary.json',summary)
  print('STAGE6_NATIVE_DIAGNOSTIC_SAFE_SUMMARY '+json.dumps(summary,separators=(',',':')))
 return 0 if result['status']=='DIAGNOSTIC_OBSERVATIONS_COLLECTED_NO_CAPACITY_QUALIFICATION' else 2
if __name__=='__main__':
 os.umask(0o077)
 sys.exit(main())

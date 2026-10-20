"""PENDING source proposal. No import-time Docker/Git/network action.
Only the reviewed manual job on the fixed engineering branch may execute.
"""
import hashlib,json,os,pathlib,platform,re,shutil,subprocess,sys,time
SOURCE_STATUS='ROOT_REVIEWED_NATIVE_EMPTY_CI'
REPOSITORY='enjoyfulwen0204-eng/whoop-briefing'
REF='refs/heads/repair/unattended-20261020'
NODE_IMAGE='node@sha256:ae9f58d5c9f5a537110310be6b3cf67cf9c67146a3bb9310c0cb515fe71c8392'
SQLD_IMAGE='ghcr.io/tursodatabase/libsql-server@sha256:756fb4d34447cfa9507dceb3a8e680435d7f2173e2aa680f44a1329e774f7d31'
HEX40=re.compile(r'^[a-f0-9]{40}$');HEX64=re.compile(r'^[a-f0-9]{64}$')
def run(args,seconds=10):
 env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')} if args[0]=='git' else None
 return subprocess.run(args,env=env,check=True,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=seconds).stdout.strip()
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def write(path,data):path.write_text(json.dumps(data,indent=2)+'\n');path.chmod(0o600)
def gate():
 assert SOURCE_STATUS=='ROOT_REVIEWED_NATIVE_EMPTY_CI','SOURCE_AND_COST_REVIEW_PENDING'
 for image in [NODE_IMAGE,SQLD_IMAGE]:assert re.fullmatch(r'(node|ghcr.io/tursodatabase/libsql-server)@sha256:[a-f0-9]{64}',image),'OFFICIAL_OCI_CHILD_PINS_REQUIRED'
 assert os.environ.get('GITHUB_REPOSITORY')==REPOSITORY
 assert os.environ.get('GITHUB_EVENT_NAME')=='workflow_dispatch'
 assert os.environ.get('GITHUB_REF')==REF
 assert os.environ.get('QUALIFICATION_MODE')=='native-empty-restart'
 assert os.environ.get('QUALIFICATION_REPOSITORY_PRIVATE')=='false','PUBLIC_REPOSITORY_COST_SCOPE_REQUIRED'
 expected=os.environ.get('CANDIDATE_SHA','');assert HEX40.fullmatch(expected)
 assert expected==os.environ.get('GITHUB_SHA')==os.environ.get('QUALIFICATION_WORKFLOW_SHA'),'SAME_REVIEWED_WORKFLOW_AND_CANDIDATE_SHA_REQUIRED'
 assert platform.system()=='Linux' and platform.machine()=='x86_64'
 assert os.environ.get('RUNNER_OS')=='Linux' and os.environ.get('RUNNER_ARCH')=='X64'
 assert os.getuid()>0 and os.getgid()>0
 for key in ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT']:assert re.fullmatch(r'[1-9][0-9]*',os.environ.get(key,''))
 return expected
def clean_head(path,expected):
 assert run(['git','--no-optional-locks','-C',str(path),'rev-parse','--verify','HEAD^{commit}'],2)==expected
 assert not run(['git','--no-optional-locks','-C',str(path),'status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none'],5),'CLEAN_TRACKED_AND_UNTRACKED_REQUIRED'
def paths():
 root=pathlib.Path(os.environ['RUNNER_TEMP']).resolve();assert root.is_dir()
 suffix=os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']
 return root/('stage6-native-'+suffix),'stage6-native-'+suffix,'stage6-native:'+suffix

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
   assert info['Config']['Labels'].get('healthos.stage6.native-ci')==name
   subprocess.run(['docker','rm','-f',captured],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
  assert not run(['docker','ps','-aq','--no-trunc','--filter','id='+captured])
 assert not run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$'])
 return True

def read_report(path):
 if not path.is_file():return None
 assert not path.is_symlink() and path.stat().st_size<=8*1024*1024
 return json.loads(path.read_text())
def safe_number(value):return value if type(value) in [int,float] and 0<=value<10**12 else None

def safe_summary(result,producer,restart):
 source=restart or producer or {};failure=source.get('failure') or {}
 code=failure.get('code');phase=failure.get('phase')
 allowed_codes={'ERR_ASSERTION','Error','AssertionError','SYNC_TIMEOUT','SYNC_CANCELLED','COMMIT_INDETERMINATE','TRANSACTION_TIMEOUT','STAGE8_LIVE_PUBLICATION_FENCED','PHASE4_DRAIN_DEADLINE_REACHED','STAGE8_LIVE_PRINCIPAL_FENCED'}
 allowed_phases=['SETUP_SCHEMA1_TO35_SYNTHETIC_ONLY','GENUINE_LIVE_PRODUCER','COLD_REPLAY']
 output={k:result.get(k) for k in ['contract','productionEvidence','candidateSha','status','stage','buildCompleted','nativeRuntimeSeconds','exitCode','cleanupConfirmed','cleanHeadUnchanged']}
 output.update({'scope':'ONE_EMPTY_SYNTHETIC_USER_NATIVE_HOST_MATCH_ONLY','serverEnforcedAbsoluteTransactionLimit':'UNKNOWN','productionCapacityQualified':False,'genuineCallsStarted':safe_number(source.get('callsStarted')),'originalJobsCompleted':safe_number(source.get('originalJobsCompleted',source.get('lastObserved',{}).get('originalJobsCompleted'))),'currentPublications':safe_number(source.get('currentPublications',source.get('lastObserved',{}).get('currentPublications'))),'coldProcessRestartObserved':source.get('coldProcessRestart') is True,'exactOriginalIdentityReplayObserved':source.get('exactOriginalIdentityReplay') is True,'failurePhase':phase if phase in allowed_phases else None,'failureCode':code if code in allowed_codes else 'OTHER' if code is not None else None,'failureMessageSha256':failure.get('messageSha256') if re.fullmatch(r'[a-f0-9]{64}',str(failure.get('messageSha256',''))) else None})
 resources=source.get('resources') or {};host=resources.get('nativeHost') or {}
 output.update({'sourceRows':safe_number(source.get('sourceRows',source.get('lastObserved',{}).get('sourceRows'))),'outboundMessages':safe_number(source.get('outboundMessages',source.get('lastObserved',{}).get('outboundMessages'))),'pilotLedgers':safe_number(source.get('pilotLedgers',source.get('lastObserved',{}).get('pilotLedgers'))),'replayPreservedCanonicalMetadataObserved':source.get('replayPreservedCanonicalMetadata') if type(source.get('replayPreservedCanonicalMetadata')) is bool else None,'allFourTypedReadersCurrentObserved':source.get('typedCurrentKinds')==['BODY_ENERGY','EPISODES','EVIDENCE','INSIGHTS'] if 'typedCurrentKinds' in source else None})
 output['controlFailureType']=result.get('controlFailureType') if result.get('controlFailureType') in ['CalledProcessError','TimeoutExpired','AssertionError','RuntimeError','FileNotFoundError','ValueError'] else None
 output['controlFailureMessageSha256']=result.get('controlFailureMessageSha256') if re.fullmatch(r'[a-f0-9]{64}',str(result.get('controlFailureMessageSha256',''))) else None
 output['resources']={'node':resources.get('node') if resources.get('node')=='v22.23.2' else None,'architecture':resources.get('architecture') if resources.get('architecture') in ['x64','arm64'] else None,'memoryPeakBytes':safe_number(int(resources['memoryPeak'])) if str(resources.get('memoryPeak','')).isdigit() else None,'hostMachine':host.get('machine') if host.get('machine') in ['x86_64','aarch64'] else None,'imageArchitecture':host.get('imageArchitecture') if host.get('imageArchitecture') in ['amd64','arm64'] else None,'requestedPlatform':host.get('requestedPlatform') if host.get('requestedPlatform') in ['linux/amd64','linux/arm64'] else None}
 events=dict(x.split() for x in str(resources.get('memoryEvents','')).split('\n') if len(x.split())==2)
 output['resources'].update({'memoryMaxBytes':safe_number(int(resources['memoryMax'])) if str(resources.get('memoryMax','')).isdigit() else None,'swapMaxBytes':safe_number(int(resources['swapMax'])) if str(resources.get('swapMax','')).isdigit() else None,'cpuMax':resources.get('cpuMax') if resources.get('cpuMax')=='50000 100000' else None,'oom':safe_number(int(events['oom'])) if str(events.get('oom','')).isdigit() else None,'oomKills':safe_number(int(events['oom_kill'])) if str(events.get('oom_kill','')).isdigit() else None})
 output['http']={}
 for label,http in [('producer',source.get('producerHttp') or (producer or {}).get('http')),('restart',source.get('restartHttp') or (restart or {}).get('http'))]:
  if not isinstance(http,dict):output['http'][label]=None;continue
  output['http'][label]={k:safe_number(http.get(k)) for k in ['requests','requestErrors','responseErrors','openTransactions','droppedTransactions']}
  tx=http.get('transactions') or [];valid=[x.get('durationUpperBoundMs') for x in tx if type(x.get('durationUpperBoundMs')) in [int,float] and x['durationUpperBoundMs']>=0]
  output['http'][label].update({'observedTransactions':len(tx),'maximumDurationUpperBoundMs':max(valid) if valid else None,'atOrAbove5s':sum(v>=5000 for v in valid),'unwitnessedTerminalCount':sum(x.get('outcome') not in ['COMMIT','ROLLBACK'] for x in tx),'atOrAbove5sByPhase':{phase:sum(x.get('phase')==phase and type(x.get('durationUpperBoundMs')) in [int,float] and x['durationUpperBoundMs']>=5000 for x in tx) for phase in allowed_phases}})
 return output

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
 assert not run(['docker','ps','-aq','--filter','name=^/'+name+'$'])
 sandbox.mkdir(mode=0o700);checkout=sandbox/'candidate';context=sandbox/'context';context.mkdir(mode=0o700);output=sandbox/'output';output.mkdir(mode=0o700)
 result={'contract':'stage6-native-empty-ci-v1','candidateSha':expected,'productionEvidence':False,'status':'UNQUALIFIED','stage':'CHECKOUT','buildCompleted':False,'cleanupConfirmed':False,'cleanHeadUnchanged':False}
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
  host={'contract':'stage6-native-host-observation-v1','candidateSha':expected,'platform':sys.platform,'machine':platform.machine(),'runnerArchitecture':os.environ['RUNNER_ARCH'],'dockerArchitecture':docker_arch,'imageArchitecture':info['Architecture'],'requestedPlatform':'linux/amd64'}
  proof=sandbox/'native-host-proof.json';write(proof,host);write(sandbox/'owned-runtime-state.json',{'candidateSha':expected,'name':name,'imageId':info['Id']})
  args=['docker','run','--cidfile',str(sandbox/'container.cid'),'--name',name,'--label','healthos.stage6.native-ci='+name,'--platform','linux/amd64','--network','none','--memory','536870912','--memory-swap','536870912','--cpus','0.5','--pids-limit','128','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--cgroupns','private','--user',str(os.getuid())+':'+str(os.getgid()),'--tmpfs','/tmp:rw,nosuid,nodev,mode=1777,size=67108864','--workdir',str(checkout)]
  for path in [checkout/'src',checkout/'test',checkout/'scripts',checkout/'package.json',checkout/'package-lock.json',checkout/'.git',common]:args+=['--mount','type=bind,src='+str(path)+',dst='+str(path)+',readonly']
  args+=['--mount','type=bind,src='+str(proof)+',dst=/native-host-proof.json,readonly','--mount','type=bind,src='+str(output)+',dst=/qualification','--entrypoint','/bin/sh',image,'-c','exec /bin/sh test/stage6-linux-native.sh']
  clean_head(source,expected);clean_head(checkout,expected);result['stage']='NATIVE_RUNTIME';at=time.monotonic()
  with (sandbox/'container.log').open('w') as log:
   child=subprocess.Popen(args,stdout=log,stderr=subprocess.STDOUT)
   try:result['exitCode']=child.wait(timeout=900)
   except subprocess.TimeoutExpired:
    result['status']='HOST_WALL_STOP_ORIGINAL_INFLIGHT_UNKNOWN';child.terminate()
    try:child.wait(timeout=3)
    except subprocess.TimeoutExpired:child.kill();child.wait(timeout=3)
    result['exitCode']=None
  result['nativeRuntimeSeconds']=round(time.monotonic()-at,3)
  result['stage']='READBACK'
  restart=read_report(output/'restart-report.json')
  if result['exitCode']==0 and restart and restart.get('status')=='ACTUAL_LINUX_EMPTY_CURRENT_COLD_REPLAY_OBSERVED':result['status']='ONE_EMPTY_NATIVE_HOST_CURRENT_AND_COLD_REPLAY_OBSERVED'
 except Exception as error:
  result['controlFailureType']=type(error).__name__;result['controlFailureMessageSha256']=hashlib.sha256(str(error).encode()).hexdigest()
 finally:
  try:owned_cleanup(sandbox,name);result['cleanupConfirmed']=True
  except Exception:result['status']='CLEANUP_UNCONFIRMED_NO_QUALIFICATION'
  try:clean_head(source,expected);clean_head(checkout,expected);result['cleanHeadUnchanged']=True
  except Exception:result['status']='SOURCE_CHANGED_OR_UNAVAILABLE_NO_QUALIFICATION'
  summary=safe_summary(result,read_report(output/'produce-report.json'),read_report(output/'restart-report.json'))
  write(sandbox/'sanitized-summary.json',summary);print('STAGE6_NATIVE_SAFE_SUMMARY '+json.dumps(summary,separators=(',',':')))
  if result['cleanupConfirmed'] and (checkout/'.git').is_file():run(['git','-C',str(source),'worktree','remove','--force',str(checkout)],30)
 return 0 if result['status']=='ONE_EMPTY_NATIVE_HOST_CURRENT_AND_COLD_REPLAY_OBSERVED' else 2
if __name__=='__main__':
 os.umask(0o077)
 sys.exit(main())

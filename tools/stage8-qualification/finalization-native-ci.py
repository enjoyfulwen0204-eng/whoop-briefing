"""One isolated Linux regression, not Production or dense-capacity qualification.
Importing performs no action. Never reuses earlier native diagnostic identities.
"""
import hashlib,json,os,pathlib,platform,re,shutil,subprocess,sys,time
BASE='32c2aa00027a09c04c4d4bf641e400818cd790ce'
REPOSITORY='enjoyfulwen0204-eng/whoop-briefing'
REF='refs/heads/repair/stage6-finalization-20261023'
MODE='native-finalization-six-empty'
INTENT='one-six-empty-and-modeled-eof-v1'
CONTROL='tools/stage8-qualification/finalization-native-ci.py'
WRAPPER='tools/stage8-qualification/finalization-native.mjs'
UNIT='tools/stage8-qualification/finalization-native-ci.test.py'
WORKFLOW='.github/workflows/stage8-live-linux-qualification.yml'
HEX40=re.compile(r'^[a-f0-9]{40}$');HEX64=re.compile(r'^[a-f0-9]{64}$')
def validate(e,system,machine,uid,gid):
 assert e.get('GITHUB_REPOSITORY')==REPOSITORY
 assert e.get('GITHUB_EVENT_NAME')=='workflow_dispatch'
 assert e.get('GITHUB_REF')==REF
 assert e.get('QUALIFICATION_MODE')==MODE
 assert e.get('FINALIZATION_REGRESSION_INTENT')==INTENT
 assert e.get('QUALIFICATION_REPOSITORY_PRIVATE')=='false','PUBLIC_REPOSITORY_ONLY_NO_PAID_SCOPE'
 sha=e.get('CANDIDATE_SHA','');assert HEX40.fullmatch(sha)
 assert sha==e.get('GITHUB_SHA')==e.get('QUALIFICATION_WORKFLOW_SHA')
 assert e.get('GITHUB_RUN_ATTEMPT')=='1','NO_RETRY_CAMPAIGN'
 assert re.fullmatch(r'[1-9][0-9]*',e.get('GITHUB_RUN_ID',''))
 assert system=='Linux' and machine=='x86_64'
 assert e.get('RUNNER_OS')=='Linux' and e.get('RUNNER_ARCH')=='X64'
 assert uid>0 and gid>0
 return sha

def run(args,seconds=10):
 env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')} if args[0]=='git' else None
 return subprocess.run(args,check=True,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=seconds,env=env).stdout.strip()
def write(path,value):path.write_text(json.dumps(value,indent=2)+'\n');path.chmod(0o600)
def public_lock(path):
 from urllib.parse import urlsplit
 lock=json.loads(path.read_text());assert lock.get('lockfileVersion') in [2,3]
 assert len(lock.get('packages',{}))<10000
 for item in lock.get('packages',{}).values():
  assert not item.get('link')
  if 'resolved' in item:
   u=urlsplit(item['resolved']);assert u.scheme=='https' and u.hostname=='registry.npmjs.org' and not u.username and not u.password and not u.query and not u.fragment

def source_gate(source,expected):
 assert run(['git','-C',str(source),'rev-parse','HEAD'])==expected
 assert not run(['git','-C',str(source),'status','--porcelain=v1','--untracked-files=all'])
 assert run(['git','-C',str(source),'rev-parse','HEAD^'])==BASE,'EXACT_REVIEWED_APPLICATION_PARENT_REQUIRED'
 allowed={'M\t'+WORKFLOW,'A\t'+CONTROL,'A\t'+WRAPPER,'A\t'+UNIT}
 changed=run(['git','-C',str(source),'diff','--name-status','--no-renames',BASE,'HEAD']).splitlines()
 assert len(changed)==len(allowed) and set(changed)==allowed,'APPLICATION_TESTS_DEPENDENCIES_AND_PRIOR_CONTROLS_UNCHANGED'
 assert hashlib.sha256((source/'package-lock.json').read_bytes()).hexdigest()=='79b263e14c52cb67a1adae0a3ff5102d44b9ffa801990b2f7ad3d30125d9ee2e'
 public_lock(source/'package-lock.json')

def paths():
 root=pathlib.Path(os.environ['RUNNER_TEMP']).resolve();assert root.is_dir()
 name='stage6-finalization-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']
 return root/name,name

def cleanup(sandbox,name):
 cidpath=sandbox/'container.cid';observed=run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$'])
 if not cidpath.exists():assert not observed;return True
 cid=cidpath.read_text().strip();assert HEX64.fullmatch(cid)
 present=run(['docker','ps','-aq','--no-trunc','--filter','id='+cid])
 if present:
  saved=json.loads((sandbox/'created.json').read_text());info=json.loads(run(['docker','inspect',cid]))[0]
  assert saved['id']==info['Id']==cid and info['Name']=='/'+name and saved['name']==name
  assert saved['imageId']==info['Image'] and saved['candidateSha']==os.environ['CANDIDATE_SHA']
  assert info['Config']['Labels'].get('healthos.stage6.finalization')==name
  assert info['Config']['Labels'].get('healthos.candidate')==saved['candidateSha']
  assert info['State']['Running'] is False,'DO_NOT_REMOVE_RUNNING_OR_UNKNOWN_CONTAINER'
  run(['docker','rm',cid],15)
 assert not run(['docker','ps','-aq','--no-trunc','--filter','id='+cid])
 assert not run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$'])
 return True

def main():
 expected=validate(os.environ,platform.system(),platform.machine(),os.getuid(),os.getgid());sandbox,name=paths()
 if sys.argv[1:]==['--cleanup-only']:
  if sandbox.exists():cleanup(sandbox,name)
  return 0
 assert len(sys.argv)==3 and sys.argv[1]=='--run'
 source=pathlib.Path(sys.argv[2]).resolve();assert source.is_dir() and (source/'.git').is_dir()
 source_gate(source,expected);sandbox.mkdir(mode=0o700);context=sandbox/'context';context.mkdir(mode=0o700)
 for f in ['package.json','package-lock.json']:shutil.copyfile(source/f,context/f)
 shutil.copyfile(source/'tools/stage8-qualification/Dockerfile.native-empty-ci',context/'Dockerfile')
 result={'contract':'stage6-finalization-native-regression-v1','candidateSha':expected,'applicationParent':BASE,'runId':os.environ['GITHUB_RUN_ID'],'attempt':1,'productionEvidence':False,'denseCapacityQualified':False,'hostedTursoDeadlineVerified':False,'status':'NOT_STARTED','cleanupConfirmed':False}
 try:
  run(['docker','build','--platform','linux/amd64','--build-arg','QUALIFICATION_ROOT=/candidate','--build-arg','QUALIFICATION_UID='+str(os.getuid()),'--build-arg','QUALIFICATION_GID='+str(os.getgid()),'-t',name+':one',str(context)],420)
  image=json.loads(run(['docker','image','inspect',name+':one']))[0];assert image['Architecture']=='amd64' and image['Os']=='linux'
  assert not run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$'])
  args=['docker','create','--name',name,'--cidfile',str(sandbox/'container.cid'),'--label','healthos.stage6.finalization='+name,'--label','healthos.candidate='+expected,'--user',str(os.getuid())+':'+str(os.getgid()),'--memory','512m','--memory-swap','512m','--cpus','0.5','--pids-limit','64','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,noexec,nosuid,size=192m','--mount','type=bind,src='+str(source)+',dst=/source,readonly','--env','EXPECTED_CANDIDATE_SHA='+expected,image['Id'],'timeout','--signal=TERM','--kill-after=5s','220s','bash','-euc','cp -R --remove-destination /source/. /candidate/\ncd /candidate\nexec node tools/stage8-qualification/finalization-native.mjs']
  cid=run(args,20);assert HEX64.fullmatch(cid)
  assert (sandbox/'container.cid').read_text().strip()==cid
  write(sandbox/'created.json',{'id':cid,'name':name,'imageId':image['Id'],'candidateSha':expected})
  result['status']='STARTED_ONE_ORIGINAL_REGRESSION';at=time.monotonic()
  output=run(['docker','start','-a',cid],240);result['nativeRuntimeSeconds']=round(time.monotonic()-at,3)
  lines=[s for s in output.splitlines() if s.startswith('STAGE6_FINALIZATION_NATIVE_RESULT ')]
  assert len(lines)==1 and len(lines[0])<16384
  report=json.loads(lines[0].split(' ',1)[1]);assert report['candidateSha']==expected
  result['observed']=report
  state=json.loads(run(['docker','inspect',cid]))[0]['State'];assert state['Running'] is False and state['ExitCode']==0 and state.get('OOMKilled') is False
  assert report['status']=='PASS_EMPTY_SIX_JOB_AND_MODELED_EOF_ONLY'
  source_gate(source,expected);result['status']='PASS_EMPTY_SIX_JOB_AND_MODELED_EOF_ONLY'
 except Exception as error:
  result['status']='FAILED_OR_UNKNOWN_NO_QUALIFICATION';result['failureType']=type(error).__name__
 finally:
  try:result['cleanupConfirmed']=cleanup(sandbox,name)
  except Exception as error:result['cleanupFailureType']=type(error).__name__
  if not result['cleanupConfirmed']:result['status']='CLEANUP_UNCONFIRMED_NO_QUALIFICATION'
  write(sandbox/'sanitized-summary.json',result)
  print('STAGE6_FINALIZATION_NATIVE_SAFE_SUMMARY '+json.dumps(result,separators=(',',':')))
 return 0 if result['status']=='PASS_EMPTY_SIX_JOB_AND_MODELED_EOF_ONLY' else 2
if __name__=='__main__':
 os.umask(0o077);sys.exit(main())

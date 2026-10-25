"""One FILE-prepared positive HTTP EOF component and exact replay under new test48/4; never original HTTP preparation, six-job or capacity qualification.
No old run/attempt is resumed. Importing performs no action.
"""
import importlib.util,pathlib,os,platform,re,subprocess,sys,json,time,shutil,hashlib
ROOT=pathlib.Path(__file__).resolve().parent
_spec=importlib.util.spec_from_file_location('original_finalization_helpers',ROOT/'finalization-native-ci.py');h=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(h)
BASE='0a2926a3ba399448484671a6def771a08bc08571'
REF='refs/heads/diagnostic/stage6-file48-prepared-eof-20261026'
MODE='native-positive-hybrid-eof'
INTENT='one-original-owned-file48-prepared-native-eof-and-replay-v1'
CONTROL='tools/stage8-qualification/owned-file48-prepared-native-eof-ci.py';WRAPPER='tools/stage8-qualification/owned-file48-prepared-native-eof-supervisor.mjs';UNIT='tools/stage8-qualification/owned-file48-prepared-native-eof-ci.test.py';TEST='test/stage6-owned-file-prepared-native-eof.mjs';RESOURCE='test/stage6-native-file48-eof-resource.mjs';WORKFLOW=h.WORKFLOW

RESOURCE_PINS={'test/stage6-owned-file-prepared-native-eof.mjs': 'f67fca13689e131338c9d563682bb15651773954f7b7677c19ab16155731525f', 'tools/stage8-qualification/owned-file48-prepared-native-eof-supervisor.mjs': 'd404b27d74f8e95c54b480ef3816407606c33f24a95848a2d34ab9fd95d80e90', 'src/stage8LiveDrainPolicy.js': 'c427b0a5e536c462c8c92cc763254d5eeb31f9bdfa9deb305e8b44593420f938', 'test/stage6-native-file48-eof-resource.mjs': '3f55d71a5855de49d87bc068fff1a813fd3b3cd80297ff88250af46712fc4d16'}

def validate(e,system,machine,uid,gid):
 assert e.get('GITHUB_REPOSITORY')==h.REPOSITORY and e.get('GITHUB_EVENT_NAME')=='workflow_dispatch'
 assert e.get('GITHUB_REF')==REF and e.get('QUALIFICATION_MODE')==MODE and e.get('POSITIVE_HYBRID_EOF_INTENT')==INTENT
 assert e.get('QUALIFICATION_REPOSITORY_PRIVATE')=='false'
 expected=e.get('CANDIDATE_SHA','');assert h.HEX40.fullmatch(expected)
 assert expected==e.get('GITHUB_SHA')==e.get('QUALIFICATION_WORKFLOW_SHA')
 assert e.get('GITHUB_RUN_ATTEMPT')=='1' and re.fullmatch(r'[1-9][0-9]*',e.get('GITHUB_RUN_ID',''))
 assert system=='Linux' and machine=='x86_64' and uid>0 and gid>0
 assert e.get('RUNNER_OS')=='Linux' and e.get('RUNNER_ARCH')=='X64' and e.get('GITHUB_JOB')=='native-owned-file48-prepared-eof'
 return expected

def source_gate(source,expected):
 assert h.run(['git','-C',str(source),'rev-parse','HEAD'])==expected
 assert not h.run(['git','-C',str(source),'status','--porcelain=v1','--untracked-files=all'])
 assert h.run(['git','-C',str(source),'rev-parse','HEAD^'])==BASE
 allowed={'A\ttest/stage6-native-file48-eof-resource.mjs', 'A\ttools/stage8-qualification/owned-file48-prepared-native-eof-ci.test.py', 'M\t.github/workflows/stage8-live-linux-qualification.yml', 'A\ttools/stage8-qualification/owned-file48-prepared-native-eof-supervisor.mjs', 'A\ttools/stage8-qualification/owned-file48-prepared-native-eof-ci.py'};changed=h.run(['git','-C',str(source),'diff','--name-status','--no-renames',BASE,'HEAD']).splitlines();assert len(changed)==len(allowed) and set(changed)==allowed
 assert not h.run(['git','-C',str(source),'diff',BASE,'HEAD','--','src','scripts','package.json','package-lock.json','tools/stage8-qualification/finalization-native-ci.py','tools/stage8-qualification/Dockerfile.native-empty-ci','test/stage6-native-live12-semi4-positive-eof.mjs','test/stage6-native-semi4-eof-resource.mjs','test/stage6-owned-file-prepared-native-eof.mjs'])
 for name,digest in RESOURCE_PINS.items():assert hashlib.sha256((source/name).read_bytes()).hexdigest()==digest
 h.public_lock(source/'package-lock.json')

def parse_original_supervisor(raw,expected):
 assert isinstance(raw,str) and len(raw)<16*1024*1024 and h.HEX40.fullmatch(expected)
 prefix='STAGE6_OWNED_FILE48_NATIVE_EOF_SUPERVISOR '
 lines=[line for line in raw.splitlines() if line.startswith(prefix)]
 assert len(lines)==1 and len(lines[0])<131072
 observed=json.loads(lines[0][len(prefix):])
 assert isinstance(observed,dict) and observed.get('candidateSha')==expected
 assert observed.get('contract')=='one-owned-file48-prepared-native-eof-supervisor-v1'
 return observed

def main():
 expected=validate(os.environ,platform.system(),platform.machine(),os.getuid(),os.getgid());sandbox,name=h.paths()
 if sys.argv[1:]==['--cleanup-only']:
  if sandbox.exists():h.cleanup(sandbox,name)
  return 0
 assert len(sys.argv)==3 and sys.argv[1]=='--run';source=pathlib.Path(sys.argv[2]).resolve();assert (source/'.git').is_dir();source_gate(source,expected)
 sandbox.mkdir(mode=0o700);context=sandbox/'context';context.mkdir(mode=0o700)
 for f in ['package.json','package-lock.json']:shutil.copyfile(source/f,context/f)
 shutil.copyfile(source/'tools/stage8-qualification/Dockerfile.native-empty-ci',context/'Dockerfile')
 result={'contract':'one-owned-file48-prepared-native-eof-ci-v1','candidateSha':expected,'controlParent':BASE,'applicationSource':expected,'runId':os.environ['GITHUB_RUN_ID'],'attempt':1,'status':'NOT_STARTED','productionEvidence':False,'denseCapacityQualified':False,'EOFQualified':False,'sixJobCompletionQualified':False,'capacityQualified':False,'cleanupConfirmed':False}
 try:
  h.run(['docker','build','--platform','linux/amd64','--build-arg','QUALIFICATION_ROOT=/candidate','--build-arg','QUALIFICATION_UID='+str(os.getuid()),'--build-arg','QUALIFICATION_GID='+str(os.getgid()),'-t',name+':one',str(context)],420)
  image=json.loads(h.run(['docker','image','inspect',name+':one']))[0];assert image['Architecture']=='amd64' and image['Os']=='linux'
  assert not h.run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$'])
  cid=h.run(['docker','create','--name',name,'--cidfile',str(sandbox/'container.cid'),'--label','healthos.stage6.finalization='+name,'--label','healthos.candidate='+expected,'--user',str(os.getuid())+':'+str(os.getgid()),'--memory','512m','--memory-swap','512m','--cpus','0.5','--pids-limit','64','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,noexec,nosuid,size=192m','--mount','type=bind,src='+str(source)+',dst=/source,readonly','--env','EXPECTED_CANDIDATE_SHA='+expected,image['Id'],'timeout','--signal=TERM','--kill-after=5s','330s','bash','-euc','cp -R --remove-destination /source/. /candidate/\ncd /candidate\nexec node tools/stage8-qualification/owned-file48-prepared-native-eof-supervisor.mjs'],20)
  assert h.HEX64.fullmatch(cid) and (sandbox/'container.cid').read_text().strip()==cid
  h.write(sandbox/'created.json',{'id':cid,'name':name,'imageId':image['Id'],'candidateSha':expected});at=time.monotonic();result['status']='STARTED_ONE_ORIGINAL_FILE_PREPARED_NATIVE_EOF'
  p=subprocess.run(['docker','start','-a',cid],capture_output=True,text=True,timeout=350);result['nativeRuntimeSeconds']=round(time.monotonic()-at,3);result['containerStartExitCode']=p.returncode
  observed=parse_original_supervisor(p.stdout,expected);result['observed']=observed
  state=json.loads(h.run(['docker','inspect',cid]))[0]['State'];assert state['Running'] is False and state['ExitCode']==0 and not state['OOMKilled'] and p.returncode==0
  assert observed['status']=='PASS_FILE48_PREPARED_NATIVE_SQLD_EOF_COMPONENT_ONLY';source_gate(source,expected);result['status']='PASS_FILE48_PREPARED_NATIVE_SQLD_EOF_COMPONENT_ONLY'
 except Exception as error:result['status']='FAILED_OR_UNKNOWN_NO_QUALIFICATION';result['failureType']=type(error).__name__
 finally:
  try:result['cleanupConfirmed']=h.cleanup(sandbox,name)
  except Exception as error:result['cleanupFailureType']=type(error).__name__
  if not result['cleanupConfirmed']:result['status']='CLEANUP_UNCONFIRMED_NO_QUALIFICATION'
  h.write(sandbox/'sanitized-summary.json',result);print('STAGE6_OWNED_FILE48_NATIVE_EOF_SAFE_SUMMARY '+json.dumps(result,separators=(',',':')))
 return 0 if result['status']=='PASS_FILE48_PREPARED_NATIVE_SQLD_EOF_COMPONENT_ONLY' else 2
if __name__=='__main__':os.umask(0o077);sys.exit(main())

"""One bounded positive EOF and exact replay regression under NEW test-only 96/4 profile; never six-job or capacity qualification.
No old run/attempt is resumed. Importing performs no action.
"""
import importlib.util,pathlib,os,platform,re,subprocess,sys,json,time,shutil,hashlib
ROOT=pathlib.Path(__file__).resolve().parent
_spec=importlib.util.spec_from_file_location('original_finalization_helpers',ROOT/'finalization-native-ci.py');h=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(h)
BASE='808f6b3dc8fe8c1382f6c085dfb062da0da8de4a'
REF='refs/heads/diagnostic/stage6-live12-semi4-positive-eof-20261025'
MODE='native-positive-hybrid-eof'
INTENT='one-original-live12-semi4-positive-eof-and-replay-v1'
CONTROL='tools/stage8-qualification/live12-semi4-positive-eof-ci.py';WRAPPER='tools/stage8-qualification/live12-semi4-positive-eof-supervisor.mjs';UNIT='tools/stage8-qualification/live12-semi4-positive-eof-ci.test.py';TEST='test/stage6-native-live12-semi4-positive-eof.mjs';WORKFLOW=h.WORKFLOW

RESOURCE_PINS={'src/stage8LiveDrainPolicy.js': 'c427b0a5e536c462c8c92cc763254d5eeb31f9bdfa9deb305e8b44593420f938', 'src/stage8LiveProducer.js': '59930ea747c1041897e76e44a4d145104cf834ad3a37ccd058a6cad576f005f1', 'test/stage8-live-unit-budget.test.mjs': 'a190eecb93dbe57b5f8d3940544da7f1c7fa6492bf9fee7cfb8a5e43f58a66ce', 'test/stage8-live-drain-policy.test.mjs': '2cce7260f2fe8adf5d6f4cc6f803d427aadf905ddbac8c032b89c5095218db91', 'test/stage6-native-live12-semi4-positive-eof.mjs': 'f74a0e2c3b0b1f582540b737a3d0c392a4df075e4827d8c90cccb1531287eb48', 'tools/stage8-qualification/live12-semi4-positive-eof-supervisor.mjs': 'a691e7ae723078c93e656ad11bbdd6e5a6b85cc92771105e4164bfb4730e45a1'}

def validate(e,system,machine,uid,gid):
 assert e.get('GITHUB_REPOSITORY')==h.REPOSITORY and e.get('GITHUB_EVENT_NAME')=='workflow_dispatch'
 assert e.get('GITHUB_REF')==REF and e.get('QUALIFICATION_MODE')==MODE and e.get('POSITIVE_HYBRID_EOF_INTENT')==INTENT
 assert e.get('QUALIFICATION_REPOSITORY_PRIVATE')=='false'
 expected=e.get('CANDIDATE_SHA','');assert h.HEX40.fullmatch(expected)
 assert expected==e.get('GITHUB_SHA')==e.get('QUALIFICATION_WORKFLOW_SHA')
 assert e.get('GITHUB_RUN_ATTEMPT')=='1' and re.fullmatch(r'[1-9][0-9]*',e.get('GITHUB_RUN_ID',''))
 assert system=='Linux' and machine=='x86_64' and uid>0 and gid>0
 assert e.get('RUNNER_OS')=='Linux' and e.get('RUNNER_ARCH')=='X64' and e.get('GITHUB_JOB')=='native-live12-semi4-positive-eof'
 return expected

def source_gate(source,expected):
 assert h.run(['git','-C',str(source),'rev-parse','HEAD'])==expected
 assert not h.run(['git','-C',str(source),'status','--porcelain=v1','--untracked-files=all'])
 assert h.run(['git','-C',str(source),'rev-parse','HEAD^'])==BASE
 allowed={'M\ttest/stage8-live-unit-budget.test.mjs', 'A\ttools/stage8-qualification/live12-semi4-positive-eof-ci.test.py', 'M\tsrc/stage8LiveProducer.js', 'A\ttools/stage8-qualification/live12-semi4-positive-eof-ci.py', 'A\ttools/stage8-qualification/live12-semi4-positive-eof-supervisor.mjs', 'M\t.github/workflows/stage8-live-linux-qualification.yml', 'A\tsrc/stage8LiveDrainPolicy.js', 'A\ttest/stage8-live-drain-policy.test.mjs', 'A\ttest/stage6-native-live12-semi4-positive-eof.mjs'};changed=h.run(['git','-C',str(source),'diff','--name-status','--no-renames',BASE,'HEAD']).splitlines();assert len(changed)==len(allowed) and set(changed)==allowed
 assert not h.run(['git','-C',str(source),'diff',BASE,'HEAD','--','scripts','package.json','package-lock.json','tools/stage8-qualification/finalization-native-ci.py','tools/stage8-qualification/Dockerfile.native-empty-ci','test/stage6-native-positive-eof-hrana.mjs','test/stage6-native-semi4-positive-eof.mjs','test/stage6-native-semi4-eof-resource.mjs'])
 appChanges=h.run(['git','-C',str(source),'diff','--name-only',BASE,'HEAD','--','src']).splitlines();assert set(appChanges)=={'src/stage8LiveDrainPolicy.js','src/stage8LiveProducer.js'} and len(appChanges)==2
 for name,digest in RESOURCE_PINS.items():assert hashlib.sha256((source/name).read_bytes()).hexdigest()==digest
 h.public_lock(source/'package-lock.json')

def main():
 expected=validate(os.environ,platform.system(),platform.machine(),os.getuid(),os.getgid());sandbox,name=h.paths()
 if sys.argv[1:]==['--cleanup-only']:
  if sandbox.exists():h.cleanup(sandbox,name)
  return 0
 assert len(sys.argv)==3 and sys.argv[1]=='--run';source=pathlib.Path(sys.argv[2]).resolve();assert (source/'.git').is_dir();source_gate(source,expected)
 sandbox.mkdir(mode=0o700);context=sandbox/'context';context.mkdir(mode=0o700)
 for f in ['package.json','package-lock.json']:shutil.copyfile(source/f,context/f)
 shutil.copyfile(source/'tools/stage8-qualification/Dockerfile.native-empty-ci',context/'Dockerfile')
 result={'contract':'one-native-live12-semi4-positive-eof-ci-v1','candidateSha':expected,'controlParent':BASE,'applicationSource':expected,'runId':os.environ['GITHUB_RUN_ID'],'attempt':1,'status':'NOT_STARTED','productionEvidence':False,'denseCapacityQualified':False,'EOFQualified':False,'sixJobCompletionQualified':False,'capacityQualified':False,'cleanupConfirmed':False}
 try:
  h.run(['docker','build','--platform','linux/amd64','--build-arg','QUALIFICATION_ROOT=/candidate','--build-arg','QUALIFICATION_UID='+str(os.getuid()),'--build-arg','QUALIFICATION_GID='+str(os.getgid()),'-t',name+':one',str(context)],420)
  image=json.loads(h.run(['docker','image','inspect',name+':one']))[0];assert image['Architecture']=='amd64' and image['Os']=='linux'
  assert not h.run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$'])
  cid=h.run(['docker','create','--name',name,'--cidfile',str(sandbox/'container.cid'),'--label','healthos.stage6.finalization='+name,'--label','healthos.candidate='+expected,'--user',str(os.getuid())+':'+str(os.getgid()),'--memory','512m','--memory-swap','512m','--cpus','0.5','--pids-limit','64','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,noexec,nosuid,size=192m','--mount','type=bind,src='+str(source)+',dst=/source,readonly','--env','EXPECTED_CANDIDATE_SHA='+expected,image['Id'],'timeout','--signal=TERM','--kill-after=5s','330s','bash','-euc','cp -R --remove-destination /source/. /candidate/\ncd /candidate\nexec node tools/stage8-qualification/live12-semi4-positive-eof-supervisor.mjs'],20)
  assert h.HEX64.fullmatch(cid) and (sandbox/'container.cid').read_text().strip()==cid
  h.write(sandbox/'created.json',{'id':cid,'name':name,'imageId':image['Id'],'candidateSha':expected});at=time.monotonic();result['status']='STARTED_ONE_ORIGINAL_LIVE12_SEMI4_POSITIVE_EOF'
  p=subprocess.run(['docker','start','-a',cid],capture_output=True,text=True,timeout=350);result['nativeRuntimeSeconds']=round(time.monotonic()-at,3);result['containerStartExitCode']=p.returncode
  lines=[x for x in p.stdout.splitlines() if x.startswith('STAGE6_LIVE12_SEMI4_POSITIVE_EOF_SUPERVISOR ')];assert len(lines)==1 and len(lines[0])<131072
  observed=json.loads(lines[0].split(' ',1)[1]);assert observed['candidateSha']==expected;result['observed']=observed
  state=json.loads(h.run(['docker','inspect',cid]))[0]['State'];assert state['Running'] is False and state['ExitCode']==0 and not state['OOMKilled'] and p.returncode==0
  assert observed['status']=='PASS_NATIVE_SQLD_POSITIVE_EOF_ONE_USER_ONLY';source_gate(source,expected);result['status']='PASS_NATIVE_SQLD_POSITIVE_EOF_ONE_USER_ONLY'
 except Exception as error:result['status']='FAILED_OR_UNKNOWN_NO_QUALIFICATION';result['failureType']=type(error).__name__
 finally:
  try:result['cleanupConfirmed']=h.cleanup(sandbox,name)
  except Exception as error:result['cleanupFailureType']=type(error).__name__
  if not result['cleanupConfirmed']:result['status']='CLEANUP_UNCONFIRMED_NO_QUALIFICATION'
  h.write(sandbox/'sanitized-summary.json',result);print('STAGE6_LIVE12_SEMI4_POSITIVE_EOF_SAFE_SUMMARY '+json.dumps(result,separators=(',',':')))
 return 0 if result['status']=='PASS_NATIVE_SQLD_POSITIVE_EOF_ONE_USER_ONLY' else 2
if __name__=='__main__':os.umask(0o077);sys.exit(main())

"""One bounded native SQLD first17 named-work/native transaction diagnostic; never EOF or capacity qualification.
No old run/attempt is resumed. Importing performs no action.
"""
import importlib.util,pathlib,os,platform,re,subprocess,sys,json,time,shutil,hashlib
ROOT=pathlib.Path(__file__).resolve().parent
_spec=importlib.util.spec_from_file_location('original_finalization_helpers',ROOT/'finalization-native-ci.py');h=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(h)
BASE='decfb2ee3fc1d81a57756b19926c315d4c56b0f6'
REF='refs/heads/diagnostic/stage6-expected-literal-first17-20261025'
MODE='native-first20-appcause'
INTENT='one-original-expected-literal-first17-v1'
CONTROL='tools/stage8-qualification/first17-work-ci.py';WRAPPER='tools/stage8-qualification/first17-work-supervisor.mjs';UNIT='tools/stage8-qualification/first17-work-ci.test.py';TEST='test/stage6-native-first17-work.mjs';WORKFLOW=h.WORKFLOW

def validate(e,system,machine,uid,gid):
 assert e.get('GITHUB_REPOSITORY')==h.REPOSITORY and e.get('GITHUB_EVENT_NAME')=='workflow_dispatch'
 assert e.get('GITHUB_REF')==REF and e.get('QUALIFICATION_MODE')==MODE and e.get('FIRST20_DIAGNOSTIC_INTENT')==INTENT
 assert e.get('QUALIFICATION_REPOSITORY_PRIVATE')=='false'
 expected=e.get('CANDIDATE_SHA','');assert h.HEX40.fullmatch(expected)
 assert expected==e.get('GITHUB_SHA')==e.get('QUALIFICATION_WORKFLOW_SHA')
 assert e.get('GITHUB_RUN_ATTEMPT')=='1' and re.fullmatch(r'[1-9][0-9]*',e.get('GITHUB_RUN_ID',''))
 assert system=='Linux' and machine=='x86_64' and uid>0 and gid>0
 assert e.get('RUNNER_OS')=='Linux' and e.get('RUNNER_ARCH')=='X64'
 return expected

def source_gate(source,expected):
 assert h.run(['git','-C',str(source),'rev-parse','HEAD'])==expected
 assert not h.run(['git','-C',str(source),'status','--porcelain=v1','--untracked-files=all'])
 assert h.run(['git','-C',str(source),'rev-parse','HEAD^'])==BASE
 allowed={'M\tsrc/runtimeAdmission.js', 'M\ttest/stage6-raw-expected-compile.test.mjs', 'M\ttools/stage8-qualification/first17-work-ci.py', 'M\t.github/workflows/stage8-live-linux-qualification.yml', 'M\ttools/stage8-qualification/first17-work-ci.test.py'};changed=h.run(['git','-C',str(source),'diff','--name-status','--no-renames',BASE,'HEAD']).splitlines();assert len(changed)==len(allowed) and set(changed)==allowed
 assert not h.run(['git','-C',str(source),'diff',BASE,'HEAD','--','scripts','package.json','package-lock.json','tools/stage8-qualification/finalization-native-ci.py','tools/stage8-qualification/Dockerfile.native-empty-ci'])
 for name,digest in {'src/runtimeAdmission.js': '91b91d30deb7c86ef4be6808610894bafbbdbc48fae168d6517a33350dae63ff', 'src/processingRawSourceEffects.js': '53734b17549820bd159801cd17f4b8136733ba754ed936635a4ccdf0c5325cbc', 'src/processingReadSnapshot.js': 'd7226e04929da160e1fac9708c468fbee3312da45bb4fc1d9a3ae6ed8d19cab8', 'src/processingTransaction.js': 'e9b7ac23dcf7460b7197f17a0b1d8ce9b86ba1df395123f9a84c3fdf4d9f3f9b', 'src/phase4Core.js': 'ff0e850f47475c3b5f1d56a54581886686f35f94dcc64e35c4afc55926d9f9eb', 'src/db.js': '5a7bed48a2341a15bde233d28b5960675a34edadccdc6c3ac76bbb3b2e5f538c'}.items():assert hashlib.sha256((source/name).read_bytes()).hexdigest()==digest
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
 result={'contract':'one-native-first17-work-ci-v1','candidateSha':expected,'controlParent':BASE,'applicationSource':expected,'runId':os.environ['GITHUB_RUN_ID'],'attempt':1,'status':'NOT_STARTED','productionEvidence':False,'denseCapacityQualified':False,'EOFQualified':False,'sixJobCompletionQualified':False,'capacityQualified':False,'cleanupConfirmed':False}
 try:
  h.run(['docker','build','--platform','linux/amd64','--build-arg','QUALIFICATION_ROOT=/candidate','--build-arg','QUALIFICATION_UID='+str(os.getuid()),'--build-arg','QUALIFICATION_GID='+str(os.getgid()),'-t',name+':one',str(context)],420)
  image=json.loads(h.run(['docker','image','inspect',name+':one']))[0];assert image['Architecture']=='amd64' and image['Os']=='linux'
  assert not h.run(['docker','ps','-aq','--no-trunc','--filter','name=^/'+name+'$'])
  cid=h.run(['docker','create','--name',name,'--cidfile',str(sandbox/'container.cid'),'--label','healthos.stage6.finalization='+name,'--label','healthos.candidate='+expected,'--user',str(os.getuid())+':'+str(os.getgid()),'--memory','512m','--memory-swap','512m','--cpus','0.5','--pids-limit','64','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,noexec,nosuid,size=192m','--mount','type=bind,src='+str(source)+',dst=/source,readonly','--env','EXPECTED_CANDIDATE_SHA='+expected,image['Id'],'timeout','--signal=TERM','--kill-after=5s','330s','bash','-euc','cp -R --remove-destination /source/. /candidate/\ncd /candidate\nexec node tools/stage8-qualification/first17-work-supervisor.mjs'],20)
  assert h.HEX64.fullmatch(cid) and (sandbox/'container.cid').read_text().strip()==cid
  h.write(sandbox/'created.json',{'id':cid,'name':name,'imageId':image['Id'],'candidateSha':expected});at=time.monotonic();result['status']='STARTED_ONE_ORIGINAL_FIRST17_WORK_DIAGNOSTIC'
  p=subprocess.run(['docker','start','-a',cid],capture_output=True,text=True,timeout=350);result['nativeRuntimeSeconds']=round(time.monotonic()-at,3);result['containerStartExitCode']=p.returncode
  lines=[x for x in p.stdout.splitlines() if x.startswith('STAGE6_FIRST17_WORK_SUPERVISOR ')];assert len(lines)==1 and len(lines[0])<131072
  observed=json.loads(lines[0].split(' ',1)[1]);assert observed['candidateSha']==expected;result['observed']=observed
  state=json.loads(h.run(['docker','inspect',cid]))[0]['State'];assert state['Running'] is False and state['ExitCode']==0 and not state['OOMKilled'] and p.returncode==0
  assert observed['status']=='DIAGNOSTIC_FIRST17_COMPLETE_NO_QUALIFICATION';source_gate(source,expected);result['status']='DIAGNOSTIC_FIRST17_COMPLETE_NO_QUALIFICATION'
 except Exception as error:result['status']='FAILED_OR_UNKNOWN_NO_QUALIFICATION';result['failureType']=type(error).__name__
 finally:
  try:result['cleanupConfirmed']=h.cleanup(sandbox,name)
  except Exception as error:result['cleanupFailureType']=type(error).__name__
  if not result['cleanupConfirmed']:result['status']='CLEANUP_UNCONFIRMED_NO_QUALIFICATION'
  h.write(sandbox/'sanitized-summary.json',result);print('STAGE6_FIRST17_WORK_SAFE_SUMMARY '+json.dumps(result,separators=(',',':')))
 return 0 if result['status']=='DIAGNOSTIC_FIRST17_COMPLETE_NO_QUALIFICATION' else 2
if __name__=='__main__':os.umask(0o077);sys.exit(main())

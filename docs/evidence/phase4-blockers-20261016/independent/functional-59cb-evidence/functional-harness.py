from pathlib import Path
import subprocess,os,time,signal,json,hashlib,datetime,shutil,re
root=Path('/private/tmp/phase4-final-independent-review/functional-59cb-checkout');out=Path('/private/tmp/phase4-final-independent-review/functional-59cb-evidence');sha='59cb485d3858ef4d48024c718e547222d9a3e294'
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def h(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def binding():
 files=sorted([p for d in ['src','test'] for p in (root/d).rglob('*') if p.is_file()]+[root/'package.json',root/'package-lock.json'])
 return {'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'srcTree':subprocess.check_output(['git','rev-parse','HEAD:src'],cwd=root,text=True).strip(),'files':{str(p.relative_to(root)):h(p) for p in files},'trackedDiff':subprocess.check_output(['git','diff','--stat'],cwd=root,text=True).strip()}
before=binding();assert before['head']==sha and before['trackedDiff']==''
(out/'binding-before.json').write_text(json.dumps(before,indent=2)+'\n')
node=shutil.which('node');common={'sourceSha':sha,'srcTree':before['srcTree'],'nodePath':str(Path(node).resolve()),'nodeVersion':subprocess.check_output([node,'--version'],text=True).strip(),'classification':'INDEPENDENT_FUNCTIONAL_ONLY_NOT_PRODUCTION_CAPACITY_OR_NATIVE_REPAIR','perFileOuterCeilingSeconds':900,'nodeFileTimeoutMs':890000,'runtimeBudgetChanges':False,'extraGcOrProfilerFlags':False,'nodeOptionsPresent':bool(os.environ.get('NODE_OPTIONS'))}
assert not os.environ.get('NODE_OPTIONS'),'Unexpected NODE_OPTIONS; no hidden instrumentation accepted'
(out/'run-manifest.json').write_text(json.dumps(common,indent=2)+'\n')
for label,file in [('weekly','test/stage8-live-weekly-functional.test.js'),('owned-classes','test/stage8-owned-live-classes.test.mjs')]:
 pressure=subprocess.run(['memory_pressure','-Q'],text=True,capture_output=True)
 pm=re.search(r'memory free percentage:\s*(\d+)%',pressure.stdout)
 if pm and int(pm.group(1))<25:
  (out/(label+'-resource-blocked.json')).write_text(json.dumps({'atUTC':now(),'classification':'NOT_STARTED_INSUFFICIENT_LOCAL_MEMORY_HEADROOM','memoryPressureOutput':pressure.stdout},indent=2)+'\n');break
 identity=binding();assert identity==before,'Source identity changed before run'
 command=[node,'--test','--test-concurrency=1','--test-timeout=890000',file]
 start=now();clock=time.monotonic();record={**common,'file':file,'command':command,'startedAtUTC':start,'memoryPressureBefore':pressure.stdout,'runOrdinal':1}
 (out/(label+'-start.json')).write_text(json.dumps(record,indent=2)+'\n')
 timedout=False
 with (out/(label+'.tap')).open('wb') as log:
  child=subprocess.Popen(command,cwd=root,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  (out/'current.json').write_text(json.dumps({'label':label,'pid':child.pid,'startedAtUTC':start},indent=2)+'\n')
  while True:
   pid,status,usage=os.wait4(child.pid,os.WNOHANG)
   if pid:break
   if time.monotonic()-clock>=900:
    timedout=True
    try:os.killpg(child.pid,signal.SIGKILL)
    except ProcessLookupError:pass
    pid,status,usage=os.wait4(child.pid,0);break
   time.sleep(.25)
  code=os.waitstatus_to_exitcode(status);child.returncode=code
 after=binding();same=after==before
 result={**record,'completedAtUTC':now(),'elapsedSeconds':time.monotonic()-clock,'exitCode':code,'outerTimedOut':timedout,'sourceIdentityUnchanged':same,'rusageWait4':{'maxRssBytesDarwin':usage.ru_maxrss,'userCpuSeconds':usage.ru_utime,'systemCpuSeconds':usage.ru_stime,'majorPageFaults':usage.ru_majflt,'minorPageFaults':usage.ru_minflt,'voluntaryContextSwitches':usage.ru_nvcsw,'involuntaryContextSwitches':usage.ru_nivcsw},'tapSha256':h(out/(label+'.tap'))}
 (out/(label+'-result.json')).write_text(json.dumps(result,indent=2)+'\n')
 (out/(label+'-binding-after.json')).write_text(json.dumps(after,indent=2)+'\n')
 print(json.dumps({'label':label,'exitCode':code,'elapsedSeconds':result['elapsedSeconds'],'peakRssBytesDarwin':usage.ru_maxrss,'outerTimedOut':timedout,'sourceIdentityUnchanged':same}),flush=True)
 assert same,'Source changed during functional test'
(out/'harness-finished.json').write_text(json.dumps({'completedAtUTC':now()},indent=2)+'\n')

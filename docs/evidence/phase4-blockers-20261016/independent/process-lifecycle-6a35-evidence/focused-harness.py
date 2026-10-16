from pathlib import Path
import subprocess,os,time,signal,json,hashlib,datetime,shutil
root=Path('/private/tmp/phase4-final-independent-review/process-lifecycle-6a35-checkout');out=Path('/private/tmp/phase4-final-independent-review/process-lifecycle-6a35-evidence')
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
def binding():
 files=sorted([p for d in ['src','test'] for p in (root/d).rglob('*') if p.is_file()]+[root/'package.json',root/'package-lock.json'])
 return {'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'srcTree':subprocess.check_output(['git','rev-parse','HEAD:src'],cwd=root,text=True).strip(),'testTree':subprocess.check_output(['git','rev-parse','HEAD:test'],cwd=root,text=True).strip(),'files':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files},'trackedDiff':subprocess.check_output(['git','diff','--stat'],cwd=root,text=True).strip()}
before=json.loads((out/'binding-before.json').read_text());assert binding()==before
node=shutil.which('node');assert not os.environ.get('NODE_OPTIONS')
for label,file in [('webhook','test/stage8-webhook-lifecycle.test.mjs'),('restart','test/stage8-real-process-restart.test.mjs')]:
 assert binding()==before
 cmd=[node,'--test','--test-concurrency=1','--test-timeout=180000',file];started=now();clock=time.monotonic();timedout=False
 with (out/(label+'.tap')).open('wb') as log:
  child=subprocess.Popen(cmd,cwd=root,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  (out/'current.json').write_text(json.dumps({'label':label,'pid':child.pid,'startedAtUTC':started},indent=2)+'\n')
  while True:
   pid,status,r=os.wait4(child.pid,os.WNOHANG)
   if pid:break
   if time.monotonic()-clock>=190:
    timedout=True
    try:os.killpg(child.pid,signal.SIGKILL)
    except ProcessLookupError:pass
    pid,status,r=os.wait4(child.pid,0);break
   time.sleep(.25)
  code=os.waitstatus_to_exitcode(status);child.returncode=code
 after=binding();result={'sourceSha':before['head'],'srcTree':before['srcTree'],'testTree':before['testTree'],'command':cmd,'nodePath':str(Path(node).resolve()),'nodeVersion':subprocess.check_output([node,'--version'],text=True).strip(),'startedAtUTC':started,'completedAtUTC':now(),'elapsedSeconds':time.monotonic()-clock,'exitCode':code,'outerTimedOut':timedout,'sourceIdentityUnchanged':after==before,'rusageWait4':{'maxRssBytesDarwin':r.ru_maxrss,'userCpuSeconds':r.ru_utime,'systemCpuSeconds':r.ru_stime},'classification':'INDEPENDENT_SYNTHETIC_PROCESS_LIFETIME_NOT_PRODUCTION_CONTAINMENT_OR_CAPACITY','tapSha256':hashlib.sha256((out/(label+'.tap')).read_bytes()).hexdigest()}
 (out/(label+'-result.json')).write_text(json.dumps(result,indent=2)+'\n');(out/(label+'-binding-after.json')).write_text(json.dumps(after,indent=2)+'\n');print(json.dumps(result),flush=True);assert after==before
(out/'finished.json').write_text(json.dumps({'completedAtUTC':now()},indent=2)+'\n')

from pathlib import Path
import re,json,hashlib,subprocess,os,signal,time,threading,datetime
root=Path('/Users/kelvin/.codex/worktrees/phase4-final-integration/whoop-briefing');out=Path('/private/tmp/phase4-blockers-20261016')
def absolute_imports(s):return re.sub(r"from '(\.[^']+)'",lambda m:"from '"+(root/'test'/m.group(1)).resolve().as_uri()+"'",s)
f=absolute_imports((root/'test/phase4Fixture.js').read_text()).replace("from 'libsql'","from 'file:///Users/kelvin/Desktop/whoop-briefing/node_modules/libsql/index.js'").replace("from '@libsql/client/sqlite3'","from 'file:///Users/kelvin/Desktop/whoop-briefing/node_modules/@libsql/client/lib-esm/sqlite3.js'")
f="import {writeSync as diagnosticWrite} from 'node:fs';\n"+f
f=f.replace("global.gc?.();await new Promise(resolve=>setImmediate(resolve));\n    await new Promise(resolve=>setImmediate(resolve));",'''diagnosticMark('COLLECT_BEFORE_GC');global.gc?.();diagnosticMark('COLLECT_AFTER_GC');
    await new Promise(resolve=>setImmediate(()=>{diagnosticMark('IMMEDIATE1_CALLBACK');resolve();}));diagnosticMark('AFTER_IMMEDIATE1');
    await new Promise(resolve=>setImmediate(()=>{diagnosticMark('IMMEDIATE2_CALLBACK');resolve();}));diagnosticMark('AFTER_IMMEDIATE2');''')
f=f.replace('await collectStatements();db.close();','diagnosticMark(\'FIXTURE_AFTER_ENTER\');await collectStatements();diagnosticMark(\'DB_CLOSE_BEFORE\');db.close();diagnosticMark(\'DB_CLOSE_RETURNED\');')
f+='''\nfunction diagnosticMark(value){diagnosticWrite(1,'# NATIVE_TEARDOWN_MARK '+JSON.stringify({at:new Date().toISOString(),pid:process.pid,value,gcType:typeof global.gc,execArgv:process.execArgv,nodeOptionsPresent:Boolean(process.env.NODE_OPTIONS),memory:process.memoryUsage()})+'\\n');}\n'''
fp=out/'native-teardown-observed-fixture.mjs';fp.write_text(f)
s=absolute_imports((root/'test/stage8-post-sync.test.js').read_text()).replace((root/'test/phase4Fixture.js').as_uri(),fp.as_uri())
tp=out/'native-teardown-observed.test.mjs';tp.write_text(s)
identity=subprocess.check_output(['git','rev-parse','HEAD','HEAD:src'],cwd=root,text=True).splitlines()
(out/'native-teardown-sample-identity.json').write_text(json.dumps({'source':identity[0],'srcTree':identity[1],'originalFixtureSha256':hashlib.sha256((root/'test/phase4Fixture.js').read_bytes()).hexdigest(),'fixtureSha256':hashlib.sha256(fp.read_bytes()).hexdigest(),'testSha256':hashlib.sha256(tp.read_bytes()).hexdigest(),'classification':'OBSERVATION_ONLY_NO_ACCEPTANCE; same180s deadline; no GC/timer/lifetime repair; one1s native stack sample of own synthetic worker'},indent=2)+'\n')
start=time.monotonic();started=datetime.datetime.now(datetime.timezone.utc).isoformat();sample={}
with (out/'native-teardown-sample.tap').open('w') as log:
 child=subprocess.Popen(['/Users/kelvin/.local/node/bin/node','--test','--test-concurrency=1','--test-timeout=180000','--test-name-pattern=genuine finalized',str(tp)],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,start_new_session=True)
 def collect():
  sampled=False
  for line in child.stdout:
   log.write(line);log.flush()
   if not sampled and 'NATIVE_TEARDOWN_MARK ' in line:
    try:v=json.loads(line.split('NATIVE_TEARDOWN_MARK ',1)[1])
    except:continue
    if v.get('value')=='COLLECT_AFTER_GC':
     sampled=True;sample['targetPid']=v['pid'];sample['trigger']=v;sample['startedAtUTC']=datetime.datetime.now(datetime.timezone.utc).isoformat()
     r=subprocess.run(['/usr/bin/sample',str(v['pid']),'1','1','-file',str(out/'native-teardown-stack.txt')],capture_output=True,text=True,timeout=10)
     sample.update(returncode=r.returncode,stdout=r.stdout[-2000:],stderr=r.stderr[-2000:])
 thread=threading.Thread(target=collect);thread.start()
 def stop():
  try:os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError:pass
 timer=threading.Timer(195,stop);timer.start();_,status,usage=os.wait4(child.pid,0);timer.cancel();thread.join(12);child.returncode=os.waitstatus_to_exitcode(status)
result={'source':identity[0],'srcTree':identity[1],'startedAtUTC':started,'completedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'returncode':child.returncode,'durationSeconds':time.monotonic()-start,'maxRssBytesDarwin':usage.ru_maxrss,'userCpuSeconds':usage.ru_utime,'systemCpuSeconds':usage.ru_stime,'sourceIdentityUnchanged':identity==subprocess.check_output(['git','rev-parse','HEAD','HEAD:src'],cwd=root,text=True).splitlines(),'sample':sample,'classification':'NATIVE_DIAGNOSTIC_ONLY_NOT_CAPACITY_OR_ACCEPTANCE'}
(out/'native-teardown-sample-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))

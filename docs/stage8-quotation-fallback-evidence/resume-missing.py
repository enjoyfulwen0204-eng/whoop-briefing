from pathlib import Path
import subprocess,json,concurrent.futures,gzip,hashlib,time
root=Path('/Users/kelvin/.codex/worktrees/stage8-quotation-safety-fallback/whoop-briefing');p=Path('/private/tmp/stage8-quotation-fallback');out=p/'final';saved=p/'capacity-interrupted';saved.mkdir(exist_ok=True)
commands=json.loads((p/'commands.json').read_text());order=['integration','scoped','regression','legacy-ingress0','legacy-ingress1','legacy-ingress2','adjudicated-ingress0','adjudicated-ingress1','adjudicated-ingress2','polling','processor','stop-processor','name'];pending=[id for id in order if not (out/(id+'.exit')).exists()]
all_missing=[id for id in commands if not (out/(id+'.exit')).exists()];assert set(pending)==set(all_missing)
manifest={'reason':'Selected model at capacity; previous execution sessions unavailable, no task test processes remain','runtimeUnchanged':True,'completedCommandsPreserved':[id for id in commands if id not in pending],'resumedCommands':pending,'archivedBeforeResuming':[],'maxConcurrentProcesses':3}
for f in sorted(out.iterdir()):
 if not f.is_file():continue
 if any(f.name.startswith(id+'.') for id in pending) or any(f.name.startswith('legacy-processor-'+str(i)) for i in range(3)) or f.name.startswith('new-processor-'):
  b=f.read_bytes();z=gzip.compress(b,mtime=0);(saved/(f.name+'.gz')).write_bytes(z);manifest['archivedBeforeResuming'].append({'file':f.name,'sha256':hashlib.sha256(b).hexdigest()})
(p/'resume-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
def run(id):
 begin=time.time();(out/(id+'.resume-start')).write_text(str(begin))
 with (out/(id+'.tap')).open('wb') as f:r=subprocess.run(commands[id],shell=True,executable='/bin/zsh',cwd=root,stdout=f,stderr=subprocess.STDOUT)
 (out/(id+'.exit')).write_text(str(r.returncode)+'\n');print(id,'exit',r.returncode,'seconds',round(time.time()-begin,2),flush=True)
print('Resume only:',pending,flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:list(executor.map(run,pending))

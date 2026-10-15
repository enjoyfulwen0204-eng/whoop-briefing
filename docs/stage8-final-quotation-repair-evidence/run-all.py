import json,subprocess,pathlib,concurrent.futures,time,re
root=pathlib.Path('/Users/kelvin/.codex/worktrees/stage8-final-quotation-repair/whoop-briefing');out=pathlib.Path('/private/tmp/stage8-final-quotation-repair');commands=json.load(open(out/'commands.json'))
def run(item):
 name,command=item;start=time.time();(out/'final'/f'{name}.start').write_text(str(start))
 with open(out/'final'/f'{name}.tap','w') as f:r=subprocess.run(command,cwd=root,shell=True,executable='/bin/zsh',stdout=f,stderr=subprocess.STDOUT)
 s=(out/'final'/f'{name}.tap').read_text();counts={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|cancelled|skipped) (\d+)$',s,re.M)}
 row=dict(name=name,command=command,exitCode=r.returncode,seconds=time.time()-start,**counts);(out/'final'/f'{name}.exit.json').write_text(json.dumps(row,indent=2)+'\n');print(json.dumps(row),flush=True);return row
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:rows=list(pool.map(run,commands.items()))
(out/'completed-runs.json').write_text(json.dumps(rows,indent=2)+'\n')

from pathlib import Path
import json,subprocess,concurrent.futures,time
root=Path('/Users/kelvin/.codex/worktrees/stage8-quotation-safety-fallback/whoop-briefing');p=Path('/private/tmp/stage8-quotation-fallback');out=p/'final'
commands=json.loads((root/'docs/stage8-adjudicated-repair-evidence/commands.json').read_text())
commands['quotation-semantic']='node --test test/stage8-quotation-fallback/semantic.test.mjs'
for i in range(3):commands['quotation-ingress'+str(i)]=f'STAGE8_GATE_TEST_SHARD={i} node --test test/stage8-quotation-fallback/processor.test.mjs'
(p/'commands.json').write_text(json.dumps(commands,indent=2)+'\n')
commands['local-frame']='node --test --test-concurrency=2 test/stage8-quotation-fallback/local-frame.test.mjs test/stage8-quotation-fallback/scope-processor.test.mjs'
(p/'commands.json').write_text(json.dumps(commands,indent=2)+'\n')
order=['final-adversarial','quotation-semantic','quotation-ingress0','quotation-ingress1','quotation-ingress2','adjudicated-semantic','gate-semantic','new-semantic','safety','integration','scoped','regression','legacy-ingress0','legacy-ingress1','legacy-ingress2','adjudicated-ingress0','adjudicated-ingress1','adjudicated-ingress2','polling','processor','stop-processor','name','local-frame']
assert len(order)==len(commands) and set(order)==set(commands)
def run(id):
 begin=time.time();(out/(id+'.start')).write_text(str(begin))
 with (out/(id+'.tap')).open('wb') as f:r=subprocess.run(commands[id],shell=True,executable='/bin/zsh',cwd=root,stdout=f,stderr=subprocess.STDOUT)
 (out/(id+'.exit')).write_text(str(r.returncode)+'\n');print(id,'exit',r.returncode,'seconds',round(time.time()-begin,2),flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:list(executor.map(run,order))

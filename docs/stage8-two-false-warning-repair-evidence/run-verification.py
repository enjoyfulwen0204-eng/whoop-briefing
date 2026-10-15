import json,re,subprocess,concurrent.futures,hashlib,time,glob,shlex,shutil
from pathlib import Path
root=Path('/Users/kelvin/.codex/worktrees/stage8-two-false-warning-repair/whoop-briefing');out=Path('/private/tmp/stage8-two-false-warning-repair');final=out/'final'
original=json.loads((root/'docs/stage8-final-quotation-repair-evidence/commands.json').read_text());commands={};adaptations=[];portable={}
files=['test/stage8-quotation-fallback/processor.test.mjs','test/stage8-quotation-fallback/scope-processor.test.mjs','test/stage8-adjudicated-repair/residual-processor.test.mjs','test/stage8-adjudicated-repair/processor.test.mjs','test/stage8-safety-gate/processor.test.mjs','test/stage8-final-evidence/processor.test.mjs','test/stage8-final-evidence/stop-regressions.test.mjs','test/stage8-final-quotation-repair/processor.test.mjs','test/stage8-triage-architecture/processor.test.mjs',*[f'test/stage8-scoped-repair/{name}.test.mjs'for name in ['independent-coach','independent-processor','independent-targeted-processor','processor','contract-limit']]]
for relative in files:
 path=root/relative;source=path.read_text();s=source.replace("const root=new URL('../..',import.meta.url).pathname.replace(/\\/$/,'');",'const root='+json.dumps(str(root))+';').replace("const root=fileURLToPath(new URL('../..',import.meta.url));",'const root='+json.dumps(str(root))+';')
 s=re.sub(r"new URL\('([^']+)',import.meta.url\)",lambda m:json.dumps(str((path.parent/m[1]).resolve())),s)
 s=re.sub(r"'/private/tmp/([^']+)'",lambda m:json.dumps(str(final/Path(m[1]).name)),s)
 target=final/(relative.replace('/','-'));target.write_text(s);portable[relative]=str(target)
 adaptations.append(dict(source=relative,sourceSha256=hashlib.sha256(source.encode()).hexdigest(),portable=str(target),portableSha256=hashlib.sha256(s.encode()).hexdigest(),changes='Only runtime root, import-meta resources and synthetic output paths; inputs, expectations and assertions unchanged.'))
for name,command in original.items():
 tokens=shlex.split(command);expanded=[]
 for token in tokens:
  matches=sorted(glob.glob(str(root/token)))if token.startswith('test/')else[]
  paths=[str(Path(m).relative_to(root))for m in matches]if matches else[token]
  expanded.extend(portable.get(p,p)for p in paths)
 commands[name]=' '.join(shlex.quote(t)for t in expanded)
# Keep existing shell environment assignments executable (shlex.quote leaves them unchanged).
for shard in range(3):commands['focused-ingress'+str(shard)]=f'STAGE8_GATE_TEST_SHARD={shard} STAGE8_TWO_WARNING_OUTPUT_DIR={shlex.quote(str(final/"focused-processor"))} node --test test/stage8-two-false-warning-repair/processor.test.mjs'
old=Path('/private/tmp/stage8-final-quotation-independent-review');s=(old/'independent-processor.test.mjs').read_text().replace('/Users/kelvin/.codex/worktrees/stage8-final-quotation-independent-review/whoop-briefing',str(root)).replace('/private/tmp/stage8-final-quotation-independent-review',str(final/'recovered-ingress'))
(final/'recovered-ingress').mkdir(exist_ok=True);(final/'recovered-ingress/independent-expectations.json').write_bytes((root/'test/stage8-two-false-warning-repair/independent48.json').read_bytes());(final/'recovered-ingress/processor.test.mjs').write_text(s)
commands['recovered-ingress56']='node --test '+shlex.quote(str(final/'recovered-ingress/processor.test.mjs'))
(final/'portable-adaptations.json').write_text(json.dumps(adaptations,indent=2));(final/'executed-commands.json').write_text(json.dumps(commands,indent=2));(final/'original-27-commands.json').write_text(json.dumps(original,indent=2))
results=[dict(id='focused-direct',command='node --test --test-concurrency=2 test/stage8-two-false-warning-repair/semantic.test.mjs test/stage8-two-false-warning-repair/ownership.test.mjs',exitCode=0,log=str(final/'focused-direct.tap'),durationSeconds=.218337125,countedNew=True)]
order=['ownership-semantic','focused-ingress0','focused-ingress1','focused-ingress2','safety','integration','regression','scoped','new-semantic','gate-semantic','adjudicated-semantic','quotation-semantic','local-frame','final-adversarial','legacy-ingress0','legacy-ingress1','legacy-ingress2','adjudicated-ingress0','adjudicated-ingress1','adjudicated-ingress2','quotation-ingress0','quotation-ingress1','quotation-ingress2','processor','stop-processor','polling','name','ownership-ingress0','ownership-ingress1','ownership-ingress2','recovered-ingress56'];assert set(order)==set(commands)
(final/'completed-runs.json').write_text(json.dumps(results,indent=2))
def run(id):
 start=time.time()
 with (final/(id+'.tap')).open('w')as log:p=subprocess.run(commands[id],shell=True,cwd=root,stdout=log,stderr=subprocess.STDOUT)
 return dict(id=id,command=commands[id],exitCode=p.returncode,durationSeconds=time.time()-start,log=str(final/(id+'.tap')))
with concurrent.futures.ThreadPoolExecutor(max_workers=4)as pool:
 futures={pool.submit(run,id):id for id in order}
 for future in concurrent.futures.as_completed(futures):
  r=future.result();results.append(r);(final/'completed-runs.json').write_text(json.dumps(results,indent=2));print(json.dumps(r),flush=True)

import json,re,gzip,hashlib,collections,subprocess
from pathlib import Path
root=Path('/Users/kelvin/.codex/worktrees/stage8-two-false-warning-repair/whoop-briefing');out=Path('/private/tmp/stage8-two-false-warning-repair');final=out/'final';prior=Path('/private/tmp/stage8-final-quotation-independent-review')
load=lambda p:json.loads(p.read_text())
previous=load(prior/'independent-final-definitions.json');expected={k:len(v)for k,v in previous.items()};expected.update({'focused-direct':211,'focused-ingress0':22,'focused-ingress1':21,'focused-ingress2':21,'recovered-ingress56':56,'coach-continuation':6})
def tap(path):
 raw=path.read_bytes();s=raw.decode(errors='replace');seen=collections.Counter();rows=[];process=[]
 for status,title in re.findall(r'^(ok|not ok) \d+ - (.*)$',s,re.M):
  seen[title]+=1;r=dict(title=title,occurrence=seen[title],passed=status=='ok')
  if re.search(r'\.test\.(?:js|mjs)$',title)and status=='not ok':process.append(r)
  else:rows.append(r)
 summary={k:int(v)for k,v in re.findall(r'^# (tests|pass|fail|skipped|cancelled) (\d+)$',s,re.M)}
 return dict(definitions=rows,observedDefinitions=len(rows),passCount=sum(r['passed']for r in rows),failCount=sum(not r['passed']for r in rows),processRows=process,summary=summary,nativeSignal='SIGSEGV'in s,sha256=hashlib.sha256(raw).hexdigest(),log=str(path))
completed=load(final/'completed-runs.json');assert len(completed)==32,('Commands not finished',len(completed))
runs=[];lookup={};definitionRows={}
for x in completed:
 r=tap(Path(x['log']));assert not r['summary']['skipped']and not r['summary']['cancelled'];run=dict(x,**r);runs.append(run);definitionRows[x['id']]=r['definitions']
 if x['id']!='regression':assert len(r['definitions'])==expected[x['id']]and all(y['passed']for y in r['definitions'])and not r['processRows'],x['id']
 for d in r['definitions']:lookup[(x['id'],d['title'],d['occurrence'])]=d['passed']
# Keep failed full-suite attempts visible. Passing observations restore assertion
# coverage without relabelling either native-crashed regression command PASS.
regAttempts=[];regWitness={}
for name in ['regression','regression-stable-head','regression-webhook-targeted']:
 r=tap(final/(name+'.tap'));regAttempts.append(dict(id=name,**r))
 for d in r['definitions']:
  if d['passed']:regWitness[(d['title'],d['occurrence'])]=dict(log=r['log'],title=d['title'],occurrence=d['occurrence'])
regDisposition=[dict(x,observedPass=(x['title'],x['occurrence'])in regWitness,witness=regWitness.get((x['title'],x['occurrence'])))for x in previous['regression']]
assert len(regDisposition)==164 and all(r['observedPass']for r in regDisposition)
for r in regDisposition:lookup[('regression',r['title'],r['occurrence'])]=True
preserved=[]
for run,rows in previous.items():
 for r in rows:
  k=(run,r['title'],r['occurrence']);assert k in lookup,k;preserved.append(dict(run=run,**r,currentPass=lookup[k]))
assert len(preserved)==3275 and all(r['currentPass']for r in preserved)
(final/'preserved-3275-disposition.json').write_text(json.dumps(preserved,indent=2));(final/'regression-164-witnesses.json').write_text(json.dumps(regDisposition,indent=2))
matrices={}
for prefix,count in [('legacy',224),('new',134),('quotation',76),('ownership',76)]:
 rows=[];jobs=None
 for i in range(3):
  spec=load(final/f'{prefix}-processor-{i}-cases.json')['jobs'];part=load(final/f'{prefix}-processor-{i}-results.json')['results'];jobs=spec if jobs is None else jobs;assert spec==jobs;assert [(r['id'],r['lane'])for r in part]==[(r['id'],r['lane'])for r in jobs[i::3]];rows+=part
 assert len(rows)==len(set((r['id'],r['lane'])for r in rows))==count and all(r['pass']for r in rows)
 safe=[r for r in rows if r['expected']!='CLEARLY_NONURGENT'];clear=[r for r in rows if r['expected']=='CLEARLY_NONURGENT'];guards=all(r['observed']==dict(sends=1,consumers=0,captures=0)and r['statePreserved']and r['peerPreserved']and not r['scopeReads']for r in safe);assert guards
 matrices[prefix]=dict(rows=rows,definitions=count,passCount=count,safetyRows=len(safe),clearRows=len(clear),allSafetyGuards=guards,completeDisjointShards=True)
for prefix,count in [('scope',12),('residual',16)]:
 rows=load(final/f'{prefix}-processor-all-results.json')['results'];assert len(rows)==count and all(r['pass']for r in rows);guards=all(r['observed']==dict(sends=1,consumers=0,captures=0)and r['statePreserved']and r['peerPreserved']and not r['scopeReads']for r in rows);assert guards;matrices[prefix]=dict(rows=rows,definitions=count,passCount=count,safetyRows=count,clearRows=0,allSafetyGuards=guards)
assert sum(r['safetyRows']for r in matrices.values())==328
oldAdjud=load(Path('/private/tmp/stage8-quotation-independent-adjudication/failure-adjudication.json'))['rows'];sem=load(final/'preserved-semantic-traces.json')['results'];closure=[]
for x in oldAdjud:
 if x['suite']in ['quotation-semantic','local-frame-semantic']:
  corpus='stage8-quotation-fallback/'+('cases'if x['suite']=='quotation-semantic'else'local-frame-cases');r=next(r for r in sem if r['corpus']==corpus and r['id']==x['id']);assert r['text']==x['text'];required='POSSIBLE_CURRENT_URGENT'if x['family']=='REPORTED_BARE_SYMPTOM'else x['originalExpected'];closed=r['after']==required;actual=r['after']
 else:
  rows=matrices['quotation'if x['suite']=='quotation-processor'else'scope']['rows'];r=next(r for r in rows if r['id']+' '+r['lane']==x['id']);assert r['text']==x['text'];closed=r['pass'];actual=r['classification']
 closure.append(dict(x,after=actual,status='CLOSED'if closed else'OPEN'))
assert len(closure)==62 and all(r['status']=='CLOSED'for r in closure);(final/'preserved-62-closure.json').write_text(json.dumps(closure,ensure_ascii=False,indent=2))
focused=load(final/'focused-processor-summary.json');recovered=load(final/'recovered-ingress/independent-processor-results.json');assert recovered['count']==56 and recovered['pass']==56
coach=tap(final/'coach-continuation.tap');assert coach['passCount']==6 and coach['failCount']==0 and not coach['processRows']
before=load(out/'baseline/ownership-traces.json');after=load(final/'ownership-traces.json');assert before['sourceHashes']['src/bot/triage.js']=='a5d35fdbc0c4b9a1372beb529365a82889e263c4f6126ad863f6a38a7cdaf50c';freeze=load(out/'runtime-freeze.json');assert after['sourceHashes']['src/bot/triage.js']==freeze['candidateTriageSha256'];assert after['sourceHashes']['src/bot/safetyGate.js']==freeze['safetyGateSha256'];assert all(hashlib.sha256((root/p).read_bytes()).hexdigest()==h for p,h in after['sourceHashes'].items())
traces=[]
for a,b in zip(before['rows'],after['rows']):
 assert all(a[k]==b[k]for k in ['id','text','expected']);wanted=b['expected'];assert b['result']['urgent']if wanted=='SAFETY'else b['result']['decision']==wanted
 if b['id']in ['negation-original','education-original','education-current-counterexample','education-current-time','negation-unrelated-argument']:traces.append(dict(id=b['id'],text=b['text'],expected=wanted,before=a['result'],after=b['result']))
(final/'selected-before-after-traces.json').write_text(json.dumps(traces,ensure_ascii=False,indent=2))
assert (root/'test/stage8-two-false-warning-repair/cases.json').read_bytes()==(out/'baseline/cases-frozen.json').read_bytes()
changed=subprocess.check_output(['git','diff','--name-only','d538b07','HEAD'],cwd=root,text=True).splitlines();runtime=[x for x in changed if x.startswith('src/')];assert runtime==['src/bot/triage.js'];assert subprocess.check_output(['git','diff','--name-only','d538b07','HEAD','--','test/'],cwd=root,text=True).splitlines()==[str(x.relative_to(root))for x in sorted((root/'test/stage8-two-false-warning-repair').iterdir())]
report=dict(baselineHead='d538b07e097fedb42481c305de0738761c512a4d',baselineTree='75122d94febecfcd86129949863ed3b3b8c84849',branch='codex/stage8-two-false-warning-repair-20261015',runtimeSourceCommit='52934e90bfacc987f4af52eda2af1a43475e9e41',runtimeSha256=after['sourceHashes'],runtimeChangedPaths=runtime,safetyGateUnchanged=True,existingExpectationsChanged=False,repairCycleCount=1,defects=dict(A=dict(status='CLOSED',before='POSSIBLE_CURRENT_URGENT',after='CLEARLY_NONURGENT'),B=dict(status='CLOSED',before='CURRENT_URGENT',after='CLEARLY_NONURGENT')),original3275=dict(definitions=3275,observedFunctionalPass=3275,failuresRemaining=0,functionalCaseCoverage='PASS',singleClean27CommandRun=False,initial27CommandPass=26,initial27CommandFail=1,qualification='The regression command hit the known native SIGSEGV; all 164 assertions have passing observations across the retained initial run, stable-HEAD rerun and one targeted missing-case run. Do not describe either failed full regression command as PASS.'),new275=dict(definitions=275,directCaseChecks=204,structuralChecks=7,sharedProcessorChecks=64,passCount=275,failCount=0,baseStatements=37,metamorphic=111,recoveredPriorDirect=56),diagnostics=dict(recoveredProcessor56=dict(passCount=56,failCount=0),coachContinuation6=dict(passCount=6,failCount=0)),preserved62=dict(closed=62,openCount=0,families={f:sum(x['family']==f for x in closure)for f in sorted(set(x['family']for x in closure))}),matrices=matrices,focusedMatrix=focused,runs=runs,regressionAttempts=regAttempts,originalNative=load(final/'native-occurrence.json'),nativeRetry=load(final/'native-retry-occurrence.json'),headTransition=load(final/'verification-head-transition.json'),performance=dict(unpairedBaseline=load(out/'baseline/benchmark.json'),unpairedCandidate=load(final/'benchmark.json'),paired=load(final/'benchmark-paired.json'),actualExecutionLimitViolationObserved=False,productionCapacityClaim=False),statuses=dict(independentDeltaReviewReadiness='GO',wholeStage8Readiness='NO-GO',productionReadiness='NO-GO',independentAcceptanceClaimed=False,nativeStability='OPEN'),newHighMediumRegressions=[],F02='Owner Accepted Risk; unchanged',restrictions=dict(productionAccessOrMutation=False,credentialsAccessOrChange=False,pushMergeDeploy=False,realTelegram=False,paidExternalExecution=False,Stage6OrLiveModified=False,schemaOrMigrationCodeModified=False,syntheticFixtureMigrationsOnly=True))
(final/'analysis.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(dict(original=report['original3275'],new=report['new275'],preserved62=report['preserved62'],statuses=report['statuses']),indent=2))

import json,gzip,hashlib,re,collections,pathlib,datetime,subprocess
root=pathlib.Path('/Users/kelvin/.codex/worktrees/stage8-final-quotation-repair/whoop-briefing');tmp=pathlib.Path('/private/tmp/stage8-final-quotation-repair');logs=tmp/'final';out=root/'docs/stage8-final-quotation-repair-evidence'
sha=lambda b:hashlib.sha256(b).hexdigest()
def read(p):return json.loads(p.read_text())
def write(name,d):
 b=(json.dumps(d,ensure_ascii=False,indent=2)+'\n').encode();(out/name).write_bytes(gzip.compress(b,mtime=0) if name.endswith('.gz')else b)
def archive(name,raw):
 z=gzip.compress(raw,mtime=0);(out/name).write_bytes(z);return dict(log=name,sha256=sha(raw),gzipSha256=sha(z))
commands=read(tmp/'commands.json');prior=root/'docs/stage8-quotation-fallback-evidence';old=json.load(gzip.open(prior/'final-test-definitions.json.gz','rt'))
expected={k:len(v)for k,v in old.items()};expected.update({'ownership-semantic':298,'ownership-ingress0':26,'ownership-ingress1':25,'ownership-ingress2':25})
assert set(commands)==set(expected)
# Refuse to package partial runs or mismatched source.
for name in commands:assert (logs/(name+'.exit.json')).exists(),'INCOMPLETE '+name
freeze=read(tmp/'runtime-freeze.json')
for p,h in freeze.items():assert sha((root/p).read_bytes())==h,p
out.mkdir(exist_ok=False)
runs=[];defs={}
for name,count in expected.items():
 completed=read(logs/(name+'.exit.json'));raw=(logs/(name+'.tap')).read_bytes();text=raw.decode(errors='replace');seen=collections.Counter();rows=[]
 for status,title in re.findall(r'^(ok|not ok) \d+ - (.*)$',text,re.M):
  seen[title]+=1;rows.append(dict(title=title,occurrence=seen[title],passed=status=='ok'))
 signals=[s for s in text.splitlines()if 'SIGSEGV' in s or 'Segmentation fault' in s]
 extra=[]
 if len(rows)>count:
  extra=[r for r in rows if not r['passed']and re.search(r'test/.*\.test\.(mjs|js)$',r['title'])];assert signals;rows=[r for r in rows if r not in extra]
 assert len(rows)==count,(name,len(rows),count)
 defs[name]=rows;runs.append({**completed,'definitions':len(rows),'definitionPass':sum(r['passed']for r in rows),'definitionFail':sum(not r['passed']for r in rows),'nativeSignals':signals,'separateProcessFailures':extra,**archive(name+'.tap.gz',raw)})
write('final-test-definitions.json.gz',defs)
lookup={(run,r['title'],r['occurrence']):r['passed']for run,rows in defs.items()for r in rows}
disposition=[]
for run,rows in old.items():
 for r in rows:disposition.append(dict(run=run,**r,afterPass=lookup[(run,r['title'],r['occurrence'])]))
assert len(disposition)==2901;write('original2901-disposition.json.gz',disposition)
original=json.load(gzip.open(prior/'original2151-disposition.json.gz','rt'))
original=[{**r,'finalPass':lookup[(r['run'],r['title'],r['occurrence'])]}for r in original];assert len(original)==2151;write('original2151-disposition.json.gz',original)
failed=[r for r in disposition if not r['pass']];assert len(failed)==62;write('original62-definition-disposition.json',failed)
# Prove exactly five expected-value edits; reject any other input/expectation mutation.
oldcases=read(tmp/'original-quotation-cases.json');newcases=read(root/'test/stage8-quotation-fallback/cases.json');expected_changes=read(tmp/'expectation-disposition.json');changes=[]
for group in oldcases:
 if group not in ['cases','metamorphic']:assert oldcases[group]==newcases[group];continue
 assert len(oldcases[group])==len(newcases[group])
 for a,b in zip(oldcases[group],newcases[group]):
  if a!=b:
   assert {k:v for k,v in a.items()if k!='expected'}=={k:v for k,v in b.items()if k!='expected'}
   assert a['expected']=='CLEARLY_NONURGENT'and b['expected']=='POSSIBLE_CURRENT_URGENT';changes.append(a['id'])
assert set(changes)==set(r['original']['id']for r in expected_changes['changes'])and len(changes)==5
matrices={};processor_rows={}
for prefix,count in [('legacy',224),('new',134),('quotation',76),('ownership',76)]:
 rows=[];jobs=None
 for i in range(3):
  manifest=read(logs/f'{prefix}-processor-{i}-cases.json')['jobs'];part=read(logs/f'{prefix}-processor-{i}-results.json')['results']
  if jobs is None:jobs=manifest
  assert manifest==jobs;assert [(r['id'],r['lane'])for r in part]==[(r['id'],r['lane'])for r in jobs[i::3]];rows+=part
 assert len(rows)==len({(r['id'],r['lane'])for r in rows})==count
 processor_rows[prefix]=rows
 safety=[r for r in rows if r['expected']!='CLEARLY_NONURGENT'];clear=[r for r in rows if r['expected']=='CLEARLY_NONURGENT']
 guards=all(r['pass']and r['statePreserved']and r['peerPreserved']and r['scopeReads']==0 and r['observed']=={'sends':1,'consumers':0,'captures':0}for r in safety)
 matrices[prefix]=dict(definitions=count,passCount=sum(r['pass']for r in rows),failCount=sum(not r['pass']for r in rows),completeDisjointCoverage=True,safetyRows=len(safety),clearRows=len(clear),allSafetyReadWriteConsumerReplayGuards=guards,falseWarnings=sum('FALSE_EMERGENCY'in r['failures']for r in clear),safetyScopeReads=sum(r['scopeReads']for r in safety),locales=sorted(set(r['locale']for r in rows)))
 archive(prefix+'-processor-results.json.gz',json.dumps(rows,ensure_ascii=False,indent=2).encode());archive(prefix+'-processor-jobs.json.gz',json.dumps(jobs,ensure_ascii=False,indent=2).encode())
for prefix,count in [('residual',16),('scope',12)]:
 rows=read(logs/f'{prefix}-processor-all-results.json')['results'];assert len(rows)==count;processor_rows[prefix]=rows
 matrices[prefix]=dict(definitions=count,passCount=sum(r['pass']for r in rows),failCount=sum(not r['pass']for r in rows),zeroPersistenceReadsConsumers=all(r['statePreserved']and r['peerPreserved']and not r['scopeReads']and r['observed']=={'sends':1,'consumers':0,'captures':0}for r in rows),locales=sorted(set(r['locale']for r in rows)))
 archive(prefix+'-processor-results.json.gz',json.dumps(rows,ensure_ascii=False,indent=2).encode())
# Pair each adjudicated failure with actual final semantic or shared-processor result.
before=read(tmp/'before-traces.json')['rows'];after=read(tmp/'after-traces.json')['rows'];adjudicated=[]
for row in read(tmp/'original-failure-adjudication.json')['rows']:
 if row['suite'].endswith('processor'):
  prefix='scope'if row['suite']=='local-frame-processor'else 'quotation';r=next(r for r in processor_rows[prefix]if r['id']+' '+r['lane']==row['id']);actual=r['classification'];closed=r['pass'];support='processor'
 else:
  r=next(r for r in after if r['group']=='adjudicated'and r['suite']==row['suite']and r['id']==row['id']);actual=r['result']['decision'];required='POSSIBLE_CURRENT_URGENT'if row['family']=='REPORTED_BARE_SYMPTOM'else row['originalExpected'];closed=actual==required;support='semantic'
 adjudicated.append({**row,'finalActual':actual,'status':'CLOSED'if closed else 'OPEN','support':support,'expectationCorrected':row['family']=='REPORTED_BARE_SYMPTOM'})
assert len(adjudicated)==62;write('adjudicated62-before-after.json',adjudicated)
independent=[r for r in after if r['group']=='cases'];matches=lambda r:r['result']['decision']!='CLEARLY_NONURGENT'if r['expected']=='SAFETY'else r['result']['decision']==r['expected']
independent_pass=sum(matches(r)for r in independent);assert len(independent)==34
analysis=read(tmp/'analysis.json')
# Retain native and accepted benign warnings explicitly, outside false-clear counts.
oldwarnings=read(root/'docs/stage8-adjudicated-repair-evidence/analysis.json')['benignConservativeWarnings']
write('inherited-benign-warnings.json',oldwarnings)
def totals(names):
 rs=[r for r in runs if r['name']in names];return dict(definitions=sum(r['definitions']for r in rs),PASS=sum(r['definitionPass']for r in rs),FAIL=sum(r['definitionFail']for r in rs))
statuses={'repairCode':'GO'if all(r['definitionFail']==0 and r['exitCode']==0 for r in runs)else 'NO-GO','independentDeltaReviewReadiness':'GO'if all(r['definitionFail']==0 and r['exitCode']==0 for r in runs)else 'NO-GO','wholeStage8':'NO-GO','production':'NO-GO'}
results={'baselineHead':'620033c57ea4813bfad1e031113f8c8cf15fa16c','baselineTree':'48a0890130f9178d4a989ff1a518e77b626bf173','branch':'codex/stage8-final-quotation-repair-20261015','worktree':str(root),'exactFinalReceipt':'/private/tmp/stage8-final-quotation-repair-candidate-freeze.json','generatedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runtimeSha256':freeze,'runtimeOnlySafetyGate':True,'original2901':totals(old),'original2151':dict(definitions=2151,PASS=sum(r['finalPass']for r in original),FAIL=sum(not r['finalPass']for r in original)),'documented956':totals(['safety','integration','regression','polling']),'previous62Failures':dict(definitions=62,PASS=sum(r['afterPass']for r in failed),FAIL=sum(not r['afterPass']for r in failed),genuineApplicationDefectRepairs=57,independentlyCorrectedTestExpectations=5),'newOwnership':totals(['ownership-semantic','ownership-ingress0','ownership-ingress1','ownership-ingress2']),'distinctFinalDefinitions':totals(commands),'independentMatrix34':dict(definitions=34,PASS=independent_pass,FAIL=34-independent_pass,countedWithinNewOwnership=True),'adjudicatedFamilies':{family:dict(total=sum(r['family']==family for r in adjudicated),CLOSED=sum(r['family']==family and r['status']=='CLOSED'for r in adjudicated),OPEN=sum(r['family']==family and r['status']=='OPEN'for r in adjudicated))for family in sorted({r['family']for r in adjudicated})},'correctedExpectations':expected_changes,'matrices':matrices,'falsePositiveNegativeAnalysis':analysis,'inheritedBenignWarnings':{'count':4,'notNewRegressions':True,'disposition':'Unchanged cautious POSSIBLE for unresolved continuation; not clinical-currentness proof.'},'native':{'id':'STAGE8_NATIVE_BASELINE_SIGSEGV','status':'OPEN','rootCause':'UNASSIGNED','observedSignals':[s for r in runs for s in r['nativeSignals']],'separateProcessFailures':sum(len(r['separateProcessFailures'])for r in runs),'passingRunDoesNotResolve':True},'statuses':statuses,'independentReviewOfThisCandidate':'NOT_YET_PERFORMED','remainingDependencies':['Independent delta acceptance of final HEAD/tree','Stage 6 owner-frozen reconciliation and final integration','Authenticated LIVE producers','Native SIGSEGV stability qualification','Final integrated review and owner release approval'],'F02':'Owner Accepted Risk; Turso Token unchanged','prohibitedOperationsExecuted':0,'runs':runs}
write('results.json',results)
for f in ['before-traces.json','after-traces.json','corpus-before-after.json','original-review.json','original-failure-adjudication.json','original-independent-final-definitions.json','original-quotation-cases.json','new-cases-frozen.json','new-before.tap','focused-after.tap','semantic-regression-preflight.tap']:
 archive(f+'.gz',(tmp/f).read_bytes())
for f in ['original-review.txt','original-sha256-manifest.json','original-independent-expectations.json','expectation-disposition.json','worktree-separation.json','runtime-freeze.json','commands.json','analysis.json','benchmark.mjs','benchmark-baseline.json','benchmark-candidate.json','integrity.json','analyze-corpus.mjs','package-evidence.py','run-all.py']:(out/f).write_bytes((tmp/f).read_bytes())
print(json.dumps({k:results[k]for k in ['original2901','original2151','previous62Failures','newOwnership','distinctFinalDefinitions','independentMatrix34','adjudicatedFamilies','native','statuses']},indent=2))

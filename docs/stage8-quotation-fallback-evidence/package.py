import json,gzip,hashlib,re,subprocess,collections,datetime
from pathlib import Path
root=Path('/Users/kelvin/.codex/worktrees/stage8-quotation-safety-fallback/whoop-briefing');tmp=Path('/private/tmp/stage8-quotation-fallback');logs=tmp/'final';out=root/'docs/stage8-quotation-fallback-evidence'
sha=lambda b:hashlib.sha256(b).hexdigest()
def read(p):return json.loads(p.read_text())
def save(name,data):
 b=(json.dumps(data,ensure_ascii=False,indent=2)+'\n').encode()
 if name.endswith('.gz'):b=gzip.compress(b,mtime=0)
 (out/name).write_bytes(b)
def archive(name,b):
 z=gzip.compress(b,mtime=0);(out/name).write_bytes(z);return {'log':name,'sha256':sha(b),'gzipSha256':sha(z)}
def tap(text):
 seen=collections.Counter();rows=[]
 for status,title in re.findall(r'^(ok|not ok) \d+ - (.*)$',text,re.M):seen[title]+=1;rows.append({'title':title,'occurrence':seen[title],'pass':status=='ok'})
 return rows
out.mkdir(exist_ok=True)
commands=read(tmp/'commands.json');expected={'safety':576,'integration':200,'regression':164,'polling':16,'scoped':348,'name':1,'new-semantic':195,'processor':25,'stop-processor':12,'gate-semantic':417,'legacy-ingress0':75,'legacy-ingress1':75,'legacy-ingress2':74,'adjudicated-semantic':221,'adjudicated-ingress0':45,'adjudicated-ingress1':45,'adjudicated-ingress2':44,'final-adversarial':27,'quotation-semantic':235,'quotation-ingress0':26,'quotation-ingress1':25,'quotation-ingress2':25,'local-frame':30}
assert set(commands)==set(expected)
runs=[];all_rows={}
for id,count in expected.items():
 assert (logs/(id+'.exit')).exists(),'RUNNING '+id
 raw=(logs/(id+'.tap')).read_bytes();text=raw.decode(errors='replace');rows=tap(text);native=[s for s in text.splitlines() if 'SIGSEGV' in s or 'Segmentation fault' in s]
 process_rows=[]
 if len(rows)>count:
  process_rows=[r for r in rows if not r['pass'] and re.search(r'test/.*\.test\.(?:mjs|js)$',r['title'])];assert native,(id,'extra TAP rows without native evidence');rows=[r for r in rows if r not in process_rows]
 assert len(rows)==count,(id,len(rows),count)
 summary={key:int(re.findall('^# '+key+r' (\d+)$',text,re.M)[-1]) for key in ['tests','pass','fail','cancelled','skipped']}
 assert not summary['cancelled'] and not summary['skipped']
 runs.append({'id':id,'command':commands[id],'exitCode':int((logs/(id+'.exit')).read_text()),'definitions':len(rows),'pass':sum(r['pass'] for r in rows),'fail':sum(not r['pass'] for r in rows),'rawTapSummary':summary,'separateNativeProcessFailures':process_rows,'nativeSignals':native,**archive(id+'.tap.gz',raw),'countedFinal':True})
 all_rows[id]=rows
save('final-test-definitions.json.gz',all_rows)
# Match every previously accepted and failed definition; no omitting old cases.
prior=root/'docs/stage8-adjudicated-repair-evidence';oldrows=json.loads(gzip.decompress((prior/'final-test-definitions.json.gz').read_bytes()))
disposition=[]
for id,rows in oldrows.items():
 final={(r['title'],r['occurrence']):r for r in all_rows[id]}
 for row in rows:
  actual=final[(row['title'],row['occurrence'])];disposition.append({'run':id,'title':row['title'],'occurrence':row['occurrence'],'beforePass':row['pass'],'afterPass':actual['pass']})
assert len(disposition)==2560
original=json.loads(gzip.decompress((prior/'original-2151-and-27-disposition.json.gz').read_bytes()))
match={(r['run'],r['title'],r['occurrence']):r['afterPass'] for r in disposition}
preserved=[{**r,'nowPass':match[(r['run'],r['title'],r['occurrence'])]} for r in original['previouslyPassing']];assert len(preserved)==2151
save('previous2560-disposition.json.gz',disposition);save('original2151-disposition.json.gz',preserved)
# All processor job partitions must be complete and disjoint, including failing controls.
matrices={}
for prefix,tests in [('legacy',224),('new',134),('quotation',76)]:
 rows=[];jobs=None
 for shard in range(3):
  spec=read(logs/f'{prefix}-processor-{shard}-cases.json')['jobs']
  if jobs is None:jobs=spec
  assert jobs==spec
  part=read(logs/f'{prefix}-processor-{shard}-results.json')['results'];assert len(part)==len(jobs[shard::3])
  assert [(r['id'],r['lane']) for r in part]==[(r['id'],r['lane']) for r in jobs[shard::3]]
  rows+=part
 assert len(rows)==tests and len(set((r['id'],r['lane']) for r in rows))==tests
 archive(prefix+'-processor-results.json.gz',json.dumps(rows,ensure_ascii=False,indent=2).encode());archive(prefix+'-processor-jobs.json.gz',json.dumps(jobs,ensure_ascii=False,indent=2).encode())
 safety=[r for r in rows if r['expected']!='CLEARLY_NONURGENT'];clear=[r for r in rows if r['expected']=='CLEARLY_NONURGENT']
 guards=all(r['statePreserved'] and r['peerPreserved'] and not r['scopeReads'] and r['observed']=={'sends':1,'consumers':0,'captures':0} for r in safety)
 assert guards
 matrices[prefix]={'tests':tests,'pass':sum(r['pass'] for r in rows),'fail':sum(not r['pass'] for r in rows),'completeDisjointCoverage':True,'safetyRows':len(safety),'allSafetyStateReadConsumerReplayGuardsPass':guards,'clearRows':len(clear),'falseWarnings':sum('FALSE_EMERGENCY' in r['failures'] for r in clear),'failures':[r for r in rows if not r['pass']]}
residual=read(logs/'residual-processor-all-results.json')['results'];assert len(residual)==16
archive('residual-processor-results.json.gz',json.dumps(residual,ensure_ascii=False,indent=2).encode())
assert all(r['pass'] and r['statePreserved'] and r['peerPreserved'] and not r['scopeReads'] and r['observed']=={'sends':1,'consumers':0,'captures':0} for r in residual)
matrices['residual']={'tests':16,'pass':sum(r['pass'] for r in residual),'fail':sum(not r['pass'] for r in residual),'safetyRows':16,'zeroNameNoteProfilePeerWritesAndScopeReadsAndOrdinaryConsumers':True,'locales':sorted(set(r['locale'] for r in residual))}
scope=read(logs/'scope-processor-all-results.json')['results'];assert len(scope)==12
scope_jobs=read(logs/'scope-processor-all-cases.json')['jobs'];assert [(r['id'],r['lane']) for r in scope]==[(r['id'],r['lane']) for r in scope_jobs]
archive('scope-processor-jobs.json.gz',json.dumps(scope_jobs,ensure_ascii=False,indent=2).encode())
archive('scope-processor-results.json.gz',json.dumps(scope,ensure_ascii=False,indent=2).encode())
matrices['localFrame']={'tests':12,'pass':sum(r['pass'] for r in scope),'fail':sum(not r['pass'] for r in scope),'ordinaryConsumerEntries':sum(bool(r['observed']['consumers']) for r in scope),'identityCaptureEntries':sum(bool(r['observed']['captures']) for r in scope),'scopedHealthReads':sum(r['scopeReads'] for r in scope),'stateChanges':sum(not r['statePreserved'] for r in scope),'nameStateChanges':sum(r['lane']=='name' and not r['statePreserved'] for r in scope),'noteStateChanges':sum(r['lane']=='note' and not r['statePreserved'] for r in scope),'peerIsolationPass':all(r['peerPreserved'] for r in scope)}
# Preserve the failed baseline reproduction and frozen expectations verbatim.
for f in sorted((tmp/'before').iterdir()):
 if f.is_file():
  if f.name.endswith('.gz'):(out/('before-'+f.name)).write_bytes(f.read_bytes())
  else:archive('before-'+f.name+'.gz',f.read_bytes())
for name in ['analysis.json','worktree-separation.json','runtime-freeze.json','benchmark.mjs','benchmark-baseline.json','benchmark-candidate.json','commands.json','analyze.mjs','freeze-cases.py','run-all.py','package.py','frozen-cases.json','new-before-after.json.gz','residual-before-after.json.gz','local-frame-frozen.json','local-frame-before-after.json.gz','analysis-before-local-frame.json','resume-manifest.json','resume-missing.py','integrity.json']:(out/name).write_bytes((tmp/name).read_bytes())
archive('focused-preflight.tap.gz',(logs/'focused-semantic.tap').read_bytes())
for file in sorted((tmp/'capacity-interrupted').iterdir()):
 if file.is_file():(out/('capacity-interrupted-'+file.name)).write_bytes(file.read_bytes())

freeze=read(tmp/'runtime-freeze.json')
for path,h in freeze['sha256'].items():assert sha((root/path).read_bytes())==h,path
changed=subprocess.check_output(['git','diff','--name-only'],cwd=root,text=True).splitlines();allowed=['src/bot/safetyGate.js','test/stage8-safety-gate/processor.test.mjs','test/stage8-adjudicated-repair/processor.test.mjs','test/stage8-adjudicated-repair/residual-processor.test.mjs'];assert sorted(changed)==sorted(allowed),changed
for path in allowed[1:]:
 before=subprocess.check_output(['git','show','10b68fa:'+path],cwd=root).decode();after=(root/path).read_text().replace('/private/tmp/stage8-quotation-fallback/final/','/private/tmp/stage8-adjudicated-repair/');assert before==after,path
assert (root/'test/stage8-quotation-fallback/cases.json').read_bytes()==(tmp/'frozen-cases.json').read_bytes()
# Old evidence is protected by Git blob hashes; no previous artifact is edited.
old_evidence=subprocess.check_output(['git','ls-tree','-r','10b68fa','--','docs/stage8-adjudicated-repair-evidence','docs/stage8-safety-gate-evidence','docs/stage8-final-evidence'],cwd=root,text=True).splitlines()
for line in old_evidence:
 meta,path=line.split('\t');blob=meta.split()[2];actual=subprocess.check_output(['git','hash-object',path],cwd=root,text=True).strip();assert blob==actual,path
analysis=read(tmp/'analysis.json');oldids=list(oldrows)
def total(ids):
 rs=[r for r in runs if r['id'] in ids];return {'tests':sum(r['definitions'] for r in rs),'pass':sum(r['pass'] for r in rs),'fail':sum(r['fail'] for r in rs)}
results={'baselineHead':'10b68fa5f4f9501c424ad4c16b4bab0eae500595','baselineTree':'38801eb22cb14318f0a0486e915107d58b1b7097','branch':'codex/stage8-quotation-fallback-20261015','worktree':str(root),'finalReceipt':'/private/tmp/stage8-quotation-fallback-candidate-freeze.json','generatedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runtimeSha256':freeze['sha256'],'runtimeEditsStopped':True,'stopConditionTriggered':True,'noFurtherRuntimeEditsAfterObservedNewFalsePositive':True,'fourResidualSemantics':analysis['residual4'],'sixteenResidualProcessor':matrices['residual'],'existing2560':total(oldids),'original2151':{'tests':2151,'pass':sum(r['nowPass'] for r in preserved),'fail':sum(not r['nowPass'] for r in preserved)},'previouslyPassing2540':{'tests':2540,'pass':sum(r['afterPass'] for r in disposition if r['beforePass']),'fail':sum(not r['afterPass'] for r in disposition if r['beforePass'])},'previous20Failures':{'tests':20,'pass':sum(r['afterPass'] for r in disposition if not r['beforePass']),'fail':sum(not r['afterPass'] for r in disposition if not r['beforePass'])},'documented956':total(['safety','integration','regression','polling']),'newSemantic235':total(['quotation-semantic']),'newProcessor76':total(['quotation-ingress0','quotation-ingress1','quotation-ingress2']),'distinctFinalTestDefinitions':total(list(commands)),'allRawTapIncludingNativeProcessFailures':{key:sum(r['rawTapSummary'][key] for r in runs) for key in ['tests','pass','fail','cancelled','skipped']},'matrices':matrices,'tradeoff':analysis,'expectationsChanged':0,'priorEvidenceFilesByteIdentical':len(old_evidence),'existingTestChangesOnlyOutputDestinations':True,'native':{'id':'STAGE8_NATIVE_BASELINE_SIGSEGV','status':'OPEN','rootCause':'UNASSIGNED','observedThisCycle':any(r['nativeSignals'] for r in runs),'processFailures':sum(len(r['separateNativeProcessFailures']) for r in runs),'passingRunDoesNotResolve':True,'baselineEvidence':'../stage8-adjudicated-repair-evidence/results.json'},'statuses':{'repairCode':'NO-GO','independentAcceptanceReviewReadiness':'NO-GO','wholeStage8':'NO-GO','production':'NO-GO'},'remainingDependencies':['Introduced High quotation-conditional false-clear family','Introduced Chinese quoted-negation false-positive family','Preexisting multilingual hypothetical quote-framing defects','Independent adjudication of five disputed author-created negative expectations','Stage 6 reconciliation and integration','Authenticated LIVE producers','Native SIGSEGV qualification','Independent final integrated review'],'F02':'Owner Accepted Risk; Turso Token unchanged','productionPushMergeRealMigrationPaidExecutionRealTelegramCredentialChanges':0,'runs':runs,'diagnosticPreflightCountedFinal':False}
assert results['distinctFinalTestDefinitions']['tests']==2901
results['localFrame30']=total(['local-frame'])
results['capacityResume']=read(tmp/'resume-manifest.json')
results['regressionPermissionRerun']={'originalRestrictedRun':{'pass':163,'fail':1,'reason':'listen EPERM 0.0.0.0'},'finalRun':total(['regression']),'runtimeChanged':False,'countedOriginalAsDiagnosticOnly':True}
for file in (tmp/'diagnostics').glob('*'):
 if file.is_file():
  if file.name.endswith('.gz'):(out/('diagnostic-'+file.name)).write_bytes(file.read_bytes())
  else:archive('diagnostic-'+file.name+'.gz',file.read_bytes())
save('results.json',results)
print(json.dumps({key:results[key] for key in ['original2151','previouslyPassing2540','previous20Failures','existing2560','documented956','newSemantic235','newProcessor76','distinctFinalTestDefinitions','allRawTapIncludingNativeProcessFailures','native','statuses']},indent=2))

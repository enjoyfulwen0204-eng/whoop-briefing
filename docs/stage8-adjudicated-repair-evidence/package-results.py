import json,gzip,hashlib,re,subprocess,collections,datetime
from pathlib import Path
root=Path('/Users/kelvin/.codex/worktrees/stage8-gate-adjudicated-repair/whoop-briefing')
tmp=Path('/private/tmp/stage8-adjudicated-repair')
out=root/'docs/stage8-adjudicated-repair-evidence'
base=root/'docs/stage8-safety-gate-evidence'
sha=lambda b:hashlib.sha256(b).hexdigest()
def read(p):return json.loads(p.read_text())
def save(n,d): (out/n).write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
def gzsave(n,b):
 z=gzip.compress(b,mtime=0);(out/n).write_bytes(z);return {'log':n,'sha256':sha(b),'gzipSha256':sha(z)}
def tap_rows(text):
 rows=[];seen=collections.Counter()
 for status,title in re.findall(r'^(ok|not ok) \d+ - (.*)$',text,re.M):
  seen[title]+=1;rows.append({'title':title,'occurrence':seen[title],'pass':status=='ok'})
 return rows
commands=read(tmp/'commands.json')
old_ids=['safety','integration','regression','polling','scoped','name','new-semantic','processor','stop-processor','gate-semantic','legacy-ingress0','legacy-ingress1','legacy-ingress2']
new_ids=['adjudicated-semantic','adjudicated-ingress0','adjudicated-ingress1','adjudicated-ingress2','final-adversarial']
runs=[];rows_by_id={}
for id in old_ids+new_ids:
 log_id=id+'-final' if id.startswith('adjudicated-ingress') else id
 assert (tmp/(log_id+'.exit')).exists(), f'RUNNING {log_id}'
 raw=(tmp/(log_id+'.tap')).read_bytes();txt=raw.decode(errors='replace')
 counts={k:int(re.findall(r'^# '+k+r' (\d+)$',txt,re.M)[-1]) for k in ['tests','pass','fail','cancelled','skipped']}
 rows=tap_rows(txt);assert len(rows)==counts['tests'],(id,len(rows),counts)
 assert sum(r['pass'] for r in rows)==counts['pass']
 native=[l for l in txt.splitlines() if 'SIGSEGV' in l or 'Segmentation fault' in l]
 result={'id':id,'command':commands[id],'exitCode':int((tmp/(log_id+'.exit')).read_text()),**counts,**gzsave(id+'.tap.gz',raw),'failures':[r for r in rows if not r['pass']],'nativeSignals':native,'countedFinal':True,'corpus':'baseline2178' if id in old_ids else 'new382'}
 runs.append(result);rows_by_id[id]=rows
save('final-test-definitions.json',rows_by_id)
# Prove each originally passing title, preserving duplicate occurrence identity.
before=read(base/'results.json');preserved=[];repaired=[];native_before=[]
for run in before['runs']:
 if not run.get('countedFinal'):continue
 id=run['id'];id2=id.replace('ingress-shard','legacy-ingress')
 raw=gzip.decompress((base/run['log']).read_bytes()).decode(errors='replace')
 after={(r['title'],r['occurrence']):r for r in rows_by_id[id2]}
 for row in tap_rows(raw):
  key=(row['title'],row['occurrence'])
  if key not in after:
   assert id=='polling' and not row['pass'] and row['title']=='test/bot-polling.test.js', (id,key)
   native_before.append({'run':id,**row,'classification':'existing native cleanup process failure; not a test definition'});continue
  record={'run':id2,**row,'beforePass':row['pass'],'afterPass':after[key]['pass']};record.pop('pass')
  (preserved if row['pass'] else repaired).append(record)
assert len(preserved)==2151,len(preserved)
assert len(repaired)==27,len(repaired)
assert sum(len(rows_by_id[id]) for id in old_ids)==2178
save('original-2151-and-27-disposition.json',{'previouslyPassing':preserved,'previouslyFailing':repaired,'separateNativeProcessFailure':native_before})
# Fifteen earlier frozen prototype counterexamples retain exact definitions.
closures=[]
for old in read(root/'docs/stage8-final-evidence/results.json')['runs']:
 if not old.get('countedFinal'):continue
 for bad in old.get('failures',[]):
  title=re.sub(r'^not ok \d+ - ','',bad)
  matches=[r for r in rows_by_id[old['id']] if r['title']==title]
  assert len(matches)==1,(old['id'],title,matches)
  closures.append({'run':old['id'],'originalFailure':bad,'after':'PASS' if matches[0]['pass'] else 'FAIL'})
assert len(closures)==15,len(closures)
# Combine partitioned actual processor results and verify exact identity coverage.
ingress={}
for kind,total in [('legacy',224),('new',134)]:
 records=[];jobs=None;keys=[]
 for shard in range(3):
  manifest=read(tmp/f'{kind}-processor-{shard}-cases.json')['jobs']
  if jobs is None:jobs=manifest
  assert manifest==jobs
  expected=jobs[shard::3]
  part=read(tmp/f'{kind}-processor-{shard}-results.json')
  assert len(part['results'])==len(expected)
  for actual,want in zip(part['results'],expected):
   assert (actual['id'],actual['lane'])==(want['id'],want['lane'])
   keys.append((actual['id'],actual['lane']));records.append(actual)
 assert len(jobs)==total and len(records)==total and len(set(keys))==total
 safety=[r for r in records if r['expected']!='CLEARLY_NONURGENT'];clear=[r for r in records if r['expected']=='CLEARLY_NONURGENT']
 guards=all(r['statePreserved'] and r['peerPreserved'] and r['scopeReads']==0 and r['observed']=={'sends':1,'consumers':0,'captures':0} for r in safety)
 assert guards
 summaries={}
 for label,subset in [('all',records),('safety',safety),('clear',clear)]:
  summaries[label]={'tests':len(subset),'pass':sum(r['pass'] for r in subset),'fail':sum(not r['pass'] for r in subset)}
 if kind=='new':
  for reviewed in [True,False]:
   subset=[r for r in records if r['reviewed']==reviewed];summaries['reviewed50' if reviewed else 'new84']={'tests':len(subset),'pass':sum(r['pass'] for r in subset),'fail':sum(not r['pass'] for r in subset)}
 ingress[kind]={**summaries,'completeNoOverlapOrOmission':True,'zeroUnauthorizedStateOrProfileWritesInSafety':guards,'zeroScopedHealthReadsInSafety':guards,'zeroOrdinaryConsumersAndIdentityCaptureInSafety':guards,'peerIsolationAndReplayPass':all(r['peerPreserved'] and 'TRANSPORT_REPLAY' not in r['failures'] for r in records),'invalidNameRejectedAndValidContinuation': [r for r in records if r.get('invalidName')]}
 gzsave(kind+'-processor-results.json.gz',json.dumps(records,ensure_ascii=False,indent=2).encode())
 gzsave(kind+'-processor-jobs.json.gz',json.dumps(jobs,ensure_ascii=False,indent=2).encode())
# Residual High failures: preserve failing outcomes, with no changed expectations.
residual=read(tmp/'residual-processor-all-results.json')['results']
assert len(residual)==16
residual_manifest=read(tmp/'residual-processor-all-cases.json')['jobs'];assert len(residual_manifest)==16
assert [(r['id'],r['lane']) for r in residual]==[(r['id'],r['lane']) for r in residual_manifest]
ingress['residualHigh16']={'tests':16,'pass':sum(r['pass'] for r in residual),'fail':sum(not r['pass'] for r in residual),'ordinaryHealthReads':sum(r['scopeReads'] for r in residual),'ordinaryConsumerEntries':sum(bool(r['observed']['consumers']) for r in residual),'stateChangedCases':sum(not r['statePreserved'] for r in residual),'peerIsolationPass':all(r['peerPreserved'] for r in residual),'byLane':{lane:{'cases':sum(r['lane']==lane for r in residual),'stateChanged':sum(r['lane']==lane and not r['statePreserved'] for r in residual),'healthReads':sum(r['scopeReads'] for r in residual if r['lane']==lane)} for lane in ['name','note','coach','health']},'failuresRetained':True}
gzsave('residual-processor-results.json.gz',json.dumps(residual,ensure_ascii=False,indent=2).encode())
gzsave('residual-processor-jobs.json.gz',json.dumps(residual_manifest,ensure_ascii=False,indent=2).encode())
residual_direct=read(tmp/'residual-before-after.json');save('residual-before-after.json',residual_direct)
save('final-adversarial-cases-frozen-before-execution.json',read(tmp/'final-adversarial-cases.json'))
# Keep failed/superseded evidence, with no double-counting of reruns.
diagnostics=[]
for phase in ['first-runtime','second-runtime']:
 for f in sorted((tmp/phase).rglob('*')):
  if not f.is_file():continue
  n='diagnostic-'+phase+'-'+str(f.relative_to(tmp/phase)).replace('/','_')+'.gz'
  record=gzsave(n,f.read_bytes());diagnostics.append({'phase':phase,'countedFinal':False,**record})
for id in ['adjudicated-ingress0','adjudicated-ingress1','adjudicated-ingress2','semantic-frozen-preflight']:
 for ext in ['tap','exit']:
  p=tmp/(id+'.'+ext)
  if p.exists():diagnostics.append({'phase':'author-harness-initial' if id.startswith('adjudicated-ingress') else 'preflight','countedFinal':False,**gzsave('diagnostic-'+p.name+'.gz',p.read_bytes())})
# Source integrity and hash receipt.
freeze=read(tmp/'runtime-freeze.json')
for p,hashval in freeze.items():assert sha((root/p).read_bytes())==hashval,(p,hashval)
source_sha={p:sha((root/p).read_bytes()) for p in ['src/bot/triage.js','src/bot/safetyGate.js']}
expected_old_changes=['src/bot/triage.js','test/stage8-safety-gate/cases.json','test/stage8-safety-gate/processor.test.mjs']
changed=subprocess.check_output(['git','diff','--name-only'],cwd=root,text=True).splitlines();assert sorted(changed)==sorted(expected_old_changes),changed
old_sha={}
for prefix in ['docs/stage8-final-evidence/','docs/stage8-safety-gate-evidence/']:
 paths=subprocess.check_output(['git','ls-tree','-r','--name-only','b69a9d6',prefix],cwd=root,text=True).splitlines()
 for p in paths:
  orig=subprocess.check_output(['git','show','b69a9d6:'+p],cwd=root);assert orig==(root/p).read_bytes(),p;old_sha[p]=sha(orig)
assert len(old_sha)==92,len(old_sha)
save('unchanged-prior-evidence-sha256.json',old_sha)
# Structured final distinct totals; aggregate only once.
def total(ids):
 selected=[r for r in runs if r['id'] in ids];return {k:sum(r[k] for r in selected) for k in ['tests','pass','fail','cancelled','skipped']}
original=total(old_ids);new=total(new_ids);all_=total(old_ids+new_ids)
assert original['tests']==2178 and new['tests']==382 and all_['tests']==2560
native={'id':'STAGE8_NATIVE_BASELINE_SIGSEGV','classification':'B_EXISTING_BASELINE_DEFECT','status':'OPEN','rootCause':'UNASSIGNED','originalCandidateObservation':before['native'],'observedThisRepairCycle':any(r['nativeSignals'] for r in runs),'newNativeFailureObserved':any(r['nativeSignals'] for r in runs),'passingRunsDoNotResolveIt':True}
analysis=read(out/'analysis.json')
positive=[r for r in residual_direct if r['expected']!='CLEARLY_NONURGENT'];negative=[r for r in residual_direct if r['expected']=='CLEARLY_NONURGENT']
analysis['finalAdversarial11']={'cases':11,'positive':len(positive),'negative':len(negative),'pass':sum(r['after']['decision']==r['expected'] for r in residual_direct),'fail':sum(r['after']['decision']!=r['expected'] for r in residual_direct),'falseNegative':sum(not r['after']['urgent'] for r in positive),'falsePositive':sum(r['after']['urgent'] for r in negative),'newlyIntroducedFalseNegatives':sum(r['before']['urgent'] and not r['after']['urgent'] for r in positive),'conclusion':'Remaining High defect; bounded stop condition triggered. No further runtime edits.'}
analysis['overallDirectRows']={'cases':227,'positive':146,'negative':81,'falseNegative':4,'falsePositive':0,'benignConservativeWarningsSeparate':4,'populationRatesNotEstablished':True}
save('final-analysis.json',analysis)

results={
 'baselineHead':'b69a9d64785a38de220da4ca36f48aa4180b4820','baselineTree':'63eef422008d88a00be309d5365b6b2f65adf57a','successorBranch':'codex/stage8-gate-adjudicated-repair-20261015','successorWorktree':str(root),'finalCommitReceipt':'/private/tmp/stage8-adjudicated-safety-gate-candidate-freeze.json','generatedAtUTC':datetime.datetime.now(datetime.timezone.utc).isoformat(),'node':'v22.23.2','runtimeSha256':source_sha,'runtimeEditsStopped':True,
 'defects':{'CG-H01':'OPEN: exact requested examples pass, but unrecognized outside quote-complement phrases still falsely clear current/plausible assertions','CG-M01':'CLOSED on NFC/NFD and local resolution corpus','CG-M02':'CLOSED on educational/reported clinical contrast corpus','CG-L01':'CLOSED on metric suffix and native paraphrase corpus'},
 'independentReviewCompletedForSuccessor':False,
 'invalidExpectations':{'count':20,'disposition':'Only independently adjudicated standalone quotation outcomes changed; all original values and failures retained','correctedTestPass':sum(r['afterPass'] for r in repaired if r['run']=='gate-semantic'),'applicationRepairPass':sum(r['afterPass'] for r in repaired if r['run']!='gate-semantic'),'authority':'independent-review-reference.json / invalid-expectation-adjudication.json'},
 'original2151PreviouslyPassing':{'tests':len(preserved),'pass':sum(r['afterPass'] for r in preserved),'fail':sum(not r['afterPass'] for r in preserved)},'original27FailureDisposition':{'tests':27,'pass':sum(r['afterPass'] for r in repaired),'fail':sum(not r['afterPass'] for r in repaired)},'originalAll2178':original,'documented956':total(['safety','integration','regression','polling']),'newSemantic221':total(['adjudicated-semantic']),'finalAdversarial27':total(['final-adversarial']),'freshDirect11':analysis['finalAdversarial11'],'freshRealProcessor16':ingress['residualHigh16'],'newActualProcessor134':total([n for n in new_ids if n.startswith('adjudicated-ingress')]),'distinctFinalTestDefinitions':all_,'finalTapIncludingNativeProcessFailures':all_.copy(),
 'olderFrozen15Counterexamples':{'tests':15,'pass':sum(r['after']=='PASS' for r in closures),'fail':sum(r['after']!='PASS' for r in closures),'closures':closures},'actualProcessor':ingress,
 'directCorpusRates':analysis,'newlyIntroducedRegressionsObserved':[],'remainingHighSafetyFalseNegatives':[r['id'] for r in residual_direct if r['expected']!='CLEARLY_NONURGENT' and not r['after']['urgent']],'boundedStopTriggered':True,'remainingMechanism':'quoteComplement rejects unrecognized connecting prefixes; no unresolved reference is recorded. The quoted symptom retains QUOTED_MENTION exclusion while the outside SELF current/uncertain predicate has no symptom. This unsupported relationship is therefore treated as absence. No further lexical/runtime edits attempted.',
 'authorHarnessCorrections':{'frozenExpectationsOtherThanAdjudicated20Changed':0,'newClearName70GraphemeInput':'unchanged 64-grapheme limit rejects; preserved invalid reply/session/profile, then valid name continuation/replay passes; original harness failure retained','NFDContinuation':'compare to existing normalization functions; original reviewer source preserved'},
 'native':native,'statuses':{'repairCode':'GO' if not all_['fail'] else 'NO-GO','independentDeltaReviewReadiness':'GO' if not all_['fail'] else 'NO-GO','wholeStage8':'NO-GO','production':'NO-GO'},'remainingDependencies':['Stage 6 owner-frozen reconciliation/capacity/authority/raw DOMAIN and receipt requirements','Authenticated LIVE analysis producers','Independent review of this exact successor','Final integrated semantic and stability qualification','Existing native SIGSEGV root cause and qualification'],
 'F02':'Owner Accepted Risk; Turso Token unchanged','productionMutations':0,'pushMergeDeployRealMigrationsRealTelegramPaidExecutionCredentialChanges':0,'runs':runs,'diagnosticReruns':diagnostics
}
save('results.json',results)
# Full reproducibility helpers kept as source, without secrets.
for p in ['commands.json','record-evidence.mjs','package-results.py']:
 (out/p).write_bytes((tmp/p).read_bytes())
# Compress verbose evidence without changing a single input, assertion or trace.
for name in ['independent86-before-after.json', 'newMetamorphic81-before-after.json', 'newCases49-before-after.json', 'before-reviewed86.json', 'before-direct.json', 'original-2151-and-27-disposition.json', 'final-test-definitions.json', 'residual-before-after.json']:
 p=out/name
 if p.exists():
  gzsave(name+'.gz',p.read_bytes());p.unlink()
print(json.dumps({k:results[k] for k in ['original2151PreviouslyPassing','original27FailureDisposition','originalAll2178','documented956','newSemantic221','newActualProcessor134','distinctFinalTestDefinitions','statuses']},indent=2));print('ingress',json.dumps({k:{label:value for label,value in d.items() if label in ['all','safety','clear','reviewed50','new84']} for k,d in ingress.items()},indent=2));print('native observed',native['newNativeFailureObserved'])

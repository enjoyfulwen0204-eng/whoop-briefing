import importlib.util,pathlib,unittest
p=pathlib.Path(__file__).with_name('positive-eof-ci.py');s=importlib.util.spec_from_file_location('new_control',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Gate(unittest.TestCase):
 def setUp(self):self.env={'GITHUB_REPOSITORY':m.h.REPOSITORY,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':m.REF,'QUALIFICATION_MODE':m.MODE,'POSITIVE_HYBRID_EOF_INTENT':m.INTENT,'QUALIFICATION_REPOSITORY_PRIVATE':'false','CANDIDATE_SHA':'c'*40,'GITHUB_SHA':'c'*40,'QUALIFICATION_WORKFLOW_SHA':'c'*40,'GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':'123','RUNNER_OS':'Linux','RUNNER_ARCH':'X64'}
 def call(self,e=None,system='Linux',machine='x86_64',uid=1001,gid=1001):return m.validate(self.env if e is None else e,system,machine,uid,gid)
 def test_exact_new_scope(self):self.assertEqual(self.call(),'c'*40)
 def test_every_missing_authority_field_refused(self):
  for k in self.env:
   with self.subTest(key=k):
    e=self.env.copy();del e[k]
    with self.assertRaises(AssertionError):self.call(e)
 def test_old_runs_or_other_identity_or_private_refused(self):
  for k,v in [('GITHUB_REF','refs/heads/diagnostic/stage6-native-joined-close-20261024'),('POSITIVE_HYBRID_EOF_INTENT','one-original-joined-close-positive-eof-and-replay-v1'),('GITHUB_REF','refs/heads/diagnostic/stage6-native-context-eof-20261024'),('POSITIVE_HYBRID_EOF_INTENT','one-original-context-lease-positive-eof-and-replay-v1'),('GITHUB_REF','refs/heads/diagnostic/stage6-native-ownership-eof-20261024'),('POSITIVE_HYBRID_EOF_INTENT','one-original-ownership-data-positive-eof-and-replay-v1'),('GITHUB_REF',m.h.REF),('GITHUB_REF','refs/heads/main'),('QUALIFICATION_MODE',m.h.MODE),('POSITIVE_HYBRID_EOF_INTENT',m.h.INTENT),('GITHUB_RUN_ATTEMPT','2'),('GITHUB_SHA','d'*40),('QUALIFICATION_WORKFLOW_SHA','d'*40),('QUALIFICATION_REPOSITORY_PRIVATE','true'),('GITHUB_RUN_ID','1;bad')]:
   with self.subTest(key=k,value=v):
    with self.assertRaises(AssertionError):self.call({**self.env,k:v})
 def test_non_native_root_refused(self):
  for a in [('Darwin','arm64',1001,1001),('Linux','aarch64',1001,1001),('Linux','x86_64',0,1001),('Linux','x86_64',1001,0)]:
   with self.subTest(args=a):
    with self.assertRaises(AssertionError):self.call(None,*a)
 def test_exact_hybrid_policy_never_coarsely_crosses_eof(self):
  import json,re,subprocess
  source=pathlib.Path(__file__).resolve().parents[2]/'test/stage6-native-positive-eof-hrana.mjs'
  definition=re.search(r"function preparationBudgetFor\(pending,catalog\)\{[\s\S]*?\n\}",source.read_text()).group(0)
  witness="import assert from 'node:assert/strict';\n"+definition+"\n"+r"""
const catalog=Array.from({length:40},(_,i)=>JSON.stringify(['workout','workout-'+String(i).padStart(2,'0')]));
assert.deepEqual(preparationBudgetFor([{full_scan_cursor:null}],catalog),{maxItemsPerTenant:6});
for(let i=0;i<catalog.length;i++){const remaining=catalog.length-i-1,b=preparationBudgetFor([{full_scan_cursor:catalog[i]}],catalog);assert.equal(b.maxItemsPerTenant,remaining<=6?1:6);if(b.maxItemsPerTenant===6)assert.ok(remaining-6>=1);}
assert.equal(preparationBudgetFor([{full_scan_cursor:catalog[5]},{full_scan_cursor:catalog[39]}],catalog).maxItemsPerTenant,1);
assert.throws(()=>preparationBudgetFor([{full_scan_cursor:'UNKNOWN'}],catalog),/SYNTHETIC_PROGRESS_CURSOR_INVALID/);
assert.throws(()=>preparationBudgetFor([{full_scan_cursor:null}],[]),/SYNTHETIC_PROGRESS_CATALOG_INVALID/);
assert.throws(()=>preparationBudgetFor([{full_scan_cursor:null}],['same','same']),/SYNTHETIC_PROGRESS_CATALOG_INVALID/);
console.log('EXACT_HYBRID_POLICY_BOUNDARIES_PASS');
"""
  result=subprocess.run(['node','--input-type=module','-e',witness],capture_output=True,text=True,timeout=15)
  self.assertEqual(result.returncode,0,result.stderr);self.assertIn('EXACT_HYBRID_POLICY_BOUNDARIES_PASS',result.stdout)
 def test_preparation_transaction_bound_is_closed_and_failclosed(self):
  import re,subprocess
  source=pathlib.Path(__file__).with_name('positive-eof-supervisor.mjs')
  definition=re.search(r"function validatePreparationTransactions\(t\)\{[\s\S]*?\n\}",source.read_text()).group(0)
  witness="import assert from 'node:assert/strict';\n"+definition+"\n"+r"""
const valid={begun:3,committed:2,rolledBack:1,unknownTerminal:0,open:0,sumDurationUpperBoundMs:5000,maxDurationUpperBoundMs:4999,atOrAbove5s:0};
assert.equal(validatePreparationTransactions(valid),true);
for(const invalid of [null,[],{...valid,extra:1},{...valid,begun:0},{...valid,committed:1},{...valid,open:1},{...valid,unknownTerminal:1},{...valid,atOrAbove5s:1},{...valid,maxDurationUpperBoundMs:5000},{...valid,maxDurationUpperBoundMs:0},{...valid,sumDurationUpperBoundMs:4998},{...valid,committed:1.1},{...valid,rolledBack:-1},{...valid,sumDurationUpperBoundMs:NaN}])assert.throws(()=>validatePreparationTransactions(invalid));
for(const key of Object.keys(valid)){const missing={...valid};delete missing[key];assert.throws(()=>validatePreparationTransactions(missing));}
console.log('PREPARATION_TRANSACTION_BOUND_FAILCLOSED_PASS');
"""
  result=subprocess.run(['node','--input-type=module','-e',witness],capture_output=True,text=True,timeout=15)
  self.assertEqual(result.returncode,0,result.stderr);self.assertIn('PREPARATION_TRANSACTION_BOUND_FAILCLOSED_PASS',result.stdout)
 def test_provisional_preparation_progress_never_exports_unknown_values(self):
  import re,subprocess
  source=pathlib.Path(__file__).resolve().parents[2]/'test/stage6-native-positive-eof-hrana.mjs'
  definition=re.search(r"function capturePreparationProgress\(terminal=false\)\{[\s\S]*?\n\}",source.read_text()).group(0)
  witness="import assert from 'node:assert/strict';\n"+definition+"\n"+r"""
const progress={preparationSnapshotState:'NOT_STARTED'};let a={snapshot(){throw Error('private_unknown_error');}};
capturePreparationProgress();assert.deepEqual(progress,{preparationSnapshotState:'NOT_STARTED'});
progress.preparationSnapshotState='PROVISIONAL';capturePreparationProgress();assert.deepEqual(progress,{preparationSnapshotState:'UNKNOWN'});
a={snapshot:()=>({bins:{GENUINE_ORIGINAL_PRODUCER_CALL:{transactions:{begun:8,maxDurationUpperBoundMs:9500,atOrAbove5s:1,unknownTerminal:0,open:1,privateUnknown:'never_export'}}}})};
capturePreparationProgress();assert.deepEqual(progress,{preparationSnapshotState:'PROVISIONAL',preparationTransactionCount:8,preparationMaxUpperMs:9500,preparationAtOrAbove5s:1,preparationUnknown:0,preparationOpen:1});
capturePreparationProgress(true);assert.equal(progress.preparationSnapshotState,'TERMINAL');
a={snapshot:()=>({bins:{GENUINE_ORIGINAL_PRODUCER_CALL:{transactions:{begun:NaN}}}})};capturePreparationProgress();assert.equal(progress.preparationSnapshotState,'UNKNOWN');assert.ok(Object.values(progress).every(v=>typeof v==='string'||Number.isFinite(v)));assert.ok(!JSON.stringify(progress).includes('private'));
console.log('PREPARATION_PROVISIONAL_SAFE_PROGRESS_PASS');
"""
  result=subprocess.run(['node','--input-type=module','-e',witness],capture_output=True,text=True,timeout=15)
  self.assertEqual(result.returncode,0,result.stderr);self.assertIn('PREPARATION_PROVISIONAL_SAFE_PROGRESS_PASS',result.stdout)
 def test_bounded_physical_join_faults(self):
  import subprocess
  source=pathlib.Path(__file__).resolve().parents[2]/'test/stage6-native-join-barrier.test.mjs'
  result=subprocess.run(['node','--test',str(source)],capture_output=True,text=True,timeout=15)
  self.assertEqual(result.returncode,0,result.stdout+result.stderr);self.assertIn('# pass 13',result.stdout)
if __name__=='__main__':unittest.main()

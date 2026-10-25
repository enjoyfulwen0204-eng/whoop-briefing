import importlib.util,pathlib,unittest,json,re,subprocess
from unittest.mock import patch
p=pathlib.Path(__file__).with_name('owned-file-prepared-native-eof-ci.py');s=importlib.util.spec_from_file_location('owned_file_control',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ROOT=pathlib.Path(__file__).resolve().parents[2]
class Gate(unittest.TestCase):
 def setUp(self):self.env={'GITHUB_REPOSITORY':m.h.REPOSITORY,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':m.REF,'QUALIFICATION_MODE':m.MODE,'POSITIVE_HYBRID_EOF_INTENT':m.INTENT,'QUALIFICATION_REPOSITORY_PRIVATE':'false','CANDIDATE_SHA':'c'*40,'GITHUB_SHA':'c'*40,'QUALIFICATION_WORKFLOW_SHA':'c'*40,'GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':'123','RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_JOB':'native-owned-file-prepared-eof'}
 def call(self,e=None,system='Linux',machine='x86_64',uid=1001,gid=1001):return m.validate(self.env if e is None else e,system,machine,uid,gid)
 def test_exact_scope_and_missing_fields(self):
  self.assertEqual(self.call(),'c'*40);self.assertEqual(m.TEST,'test/stage6-owned-file-prepared-native-eof.mjs');self.assertIn("'contract':'one-owned-file-prepared-native-eof-ci-v1'",(ROOT/m.CONTROL).read_text())
  for key in self.env:
   e=self.env.copy();del e[key]
   with self.subTest(key=key),self.assertRaises(AssertionError):self.call(e)
 def test_old_cases_attempts_and_non_native_are_refused(self):
  for key,value in [('GITHUB_REF','refs/heads/diagnostic/stage6-live12-semi4-positive-eof-20261025'),('POSITIVE_HYBRID_EOF_INTENT','one-original-live12-semi4-positive-eof-and-replay-v1'),('GITHUB_JOB','native-live12-semi4-positive-eof'),('GITHUB_RUN_ATTEMPT','2'),('GITHUB_SHA','d'*40),('QUALIFICATION_REPOSITORY_PRIVATE','true')]:
   with self.subTest(key=key),self.assertRaises(AssertionError):self.call({**self.env,key:value})
  for args in [('Darwin','arm64',501,20),('Linux','aarch64',1001,1001),('Linux','x86_64',0,1001),('Linux','x86_64',1001,0)]:
   with self.subTest(args=args),self.assertRaises(AssertionError):self.call(None,*args)
 def test_source_gate_requires_exact_five_files_and_no_app_change(self):
  allowed=['A\t'+m.TEST,'A\t'+m.WRAPPER,'A\t'+m.CONTROL,'A\t'+m.UNIT,'M\t'+m.WORKFLOW]
  def execute(changes=allowed,parent=m.BASE,dirty='',head='c'*40):
   def fake(args,*rest):
    cmd=args[3:]
    if cmd==['rev-parse','HEAD']:return head
    if cmd==['rev-parse','HEAD^']:return parent
    if cmd[0]=='status':return dirty
    if cmd[:3]==['diff','--name-status','--no-renames']:return '\n'.join(changes)
    if cmd[0]=='diff':return ''
    raise AssertionError('unexpected_git_command')
   with patch.object(m.h,'run',fake):m.source_gate(ROOT,'c'*40)
  execute()
  for options in [dict(changes=allowed+['M\tsrc/db.js']),dict(changes=allowed[:-1]),dict(parent='b'*40),dict(dirty='?? extra'),dict(head='d'*40)]:
   with self.subTest(options=options),self.assertRaises(AssertionError):execute(**options)
 def test_original_driver_and_policy_are_unchanged(self):
  original=(ROOT/'test/stage6-native-live12-semi4-positive-eof.mjs').read_text();candidate=(ROOT/m.TEST).read_text()
  extract=lambda text:text[text.index('function preparationBudgetFor'):text.index('\nfunction failureClassification')]
  self.assertEqual(extract(candidate),extract(original))
  a=' const admission=await db.admitRuntime(),releaseSha=';b=' for(let i=0;i<'
  self.assertEqual(candidate[candidate.index(a):candidate.index(b,candidate.index(a))],original[original.index(a):original.index(b,original.index(a))])
  self.assertEqual(candidate.count('started<120000'),2);self.assertEqual(candidate.count('started<180000'),1)
  self.assertIn('for(let i=0;i<64;i++)',candidate);self.assertNotIn('preparationTransactions,',candidate)
  self.assertIn("preparationTransport:'OWNED_NATIVE_FILE_NOT_HTTP'",candidate);self.assertIn('originalHTTPPreparationQualified:false',candidate)
 def test_typed_snapshot_detects_blob_and_type_changes(self):
  source=(ROOT/m.TEST).read_text();definition=re.search(r'function canonicalRow\(row\)\{[\s\S]*?\n\}',source).group(0)
  witness="import assert from 'node:assert/strict';\n"+definition+"\n"+r'''
assert.equal(canonicalRow({a:1,b:'x'}),canonicalRow({b:'x',a:1}));
assert.notEqual(canonicalRow({a:1}),canonicalRow({a:'1'}));
assert.notEqual(canonicalRow({a:null}),canonicalRow({a:'null'}));
const bytes=new Uint8Array([3,4,5]);assert.equal(canonicalRow({a:bytes}),canonicalRow({a:bytes.buffer}));
assert.equal(canonicalRow({a:new Uint8Array([9,3,4,5,9]).subarray(1,4)}),canonicalRow({a:bytes}));
assert.notEqual(canonicalRow({a:bytes}),canonicalRow({a:new Uint8Array([3,4,6])}));
for(const a of [NaN,Infinity,{},undefined])assert.throws(()=>canonicalRow({a}));
console.log('TYPED_BLOB_AND_VALUE_MUTATIONS_DETECTED');
'''
  result=subprocess.run(['node','--input-type=module','-e',witness],capture_output=True,text=True,timeout=10);self.assertEqual(result.returncode,0,result.stderr)
 def test_new_workflow_is_only_append_and_retains_resource_boundaries(self):
  old=subprocess.check_output(['git','show',m.BASE+':'+m.WORKFLOW],cwd=ROOT).decode();candidate=(ROOT/m.WORKFLOW).read_text();self.assertTrue(candidate.startswith(old+'\n'))
  added=candidate[len(old)+1:];self.assertEqual(added.count('  native-owned-file-prepared-eof:\n'),1);self.assertIn(m.REF,added);self.assertIn(m.INTENT,added)
  wrapper=(ROOT/m.WRAPPER).read_text();control=(ROOT/m.CONTROL).read_text();self.assertIn("child.kill('SIGTERM'),300000",wrapper);self.assertIn('started<300000',wrapper)
  for value in ["'--memory','512m'","'--memory-swap','512m'","'--cpus','0.5'","'--network','none'","'330s'","timeout=350"]:self.assertIn(value,control)
  self.assertNotIn('validatePreparationTransactions(',wrapper);self.assertNotIn("'priorClientTerminalComplete'",wrapper);self.assertIn("observed.originalHTTPPreparationQualified,false",wrapper)
 def test_real_supervisor_parser_accepts_new_and_refuses_old_or_wrong_identity(self):
  packet={'contract':'one-owned-file-prepared-native-eof-supervisor-v1','candidateSha':'c'*40,'status':'FAILED_OR_UNKNOWN_NO_QUALIFICATION'}
  prefix='STAGE6_OWNED_FILE_NATIVE_EOF_SUPERVISOR '
  raw=prefix+json.dumps(packet)
  self.assertEqual(m.parse_original_supervisor(raw,'c'*40),packet)
  for bad in ['STAGE6_LIVE12_SEMI4_POSITIVE_EOF_SUPERVISOR '+json.dumps(packet),raw+'\n'+raw,prefix+json.dumps({**packet,'candidateSha':'d'*40}),prefix+json.dumps({**packet,'contract':'old-scope'}),prefix+'notJSON']:
   with self.subTest(bad=bad),self.assertRaises((AssertionError,ValueError)):m.parse_original_supervisor(bad,'c'*40)
  self.assertIn('observed=parse_original_supervisor(p.stdout,expected);result[\'observed\']=observed',(ROOT/m.CONTROL).read_text())
if __name__=='__main__':unittest.main()

import importlib.util,pathlib,unittest,json,subprocess
from unittest.mock import patch
p=pathlib.Path(__file__).with_name('owned-file-bootstrap-memory-ci.py');s=importlib.util.spec_from_file_location('bootstrap_control',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
ROOT=pathlib.Path(__file__).resolve().parents[2]
class Gate(unittest.TestCase):
 def setUp(self):self.env={'GITHUB_REPOSITORY':m.h.REPOSITORY,'GITHUB_EVENT_NAME':'workflow_dispatch','GITHUB_REF':m.REF,'QUALIFICATION_MODE':m.MODE,'POSITIVE_HYBRID_EOF_INTENT':m.INTENT,'QUALIFICATION_REPOSITORY_PRIVATE':'false','CANDIDATE_SHA':'c'*40,'GITHUB_SHA':'c'*40,'QUALIFICATION_WORKFLOW_SHA':'c'*40,'GITHUB_RUN_ATTEMPT':'1','GITHUB_RUN_ID':'123','RUNNER_OS':'Linux','RUNNER_ARCH':'X64','GITHUB_JOB':'native-owned-file-bootstrap-memory'}
 def test_identity_and_all_fields(self):
  self.assertEqual(m.validate(self.env,'Linux','x86_64',1001,1001),'c'*40)
  for key in self.env:
   e=self.env.copy();del e[key]
   with self.subTest(key=key),self.assertRaises(AssertionError):m.validate(e,'Linux','x86_64',1001,1001)
  for key,value in [('GITHUB_RUN_ATTEMPT','2'),('GITHUB_REF','refs/heads/diagnostic/stage6-owned-file-prepared-eof-20261025'),('QUALIFICATION_REPOSITORY_PRIVATE','true'),('CANDIDATE_SHA','d'*40)]:
   with self.subTest(key=key),self.assertRaises(AssertionError):m.validate({**self.env,key:value},'Linux','x86_64',1001,1001)
 def test_exact_source_gate(self):
  allowed=['A\t'+m.TEST,'A\t'+m.WRAPPER,'A\t'+m.CONTROL,'A\t'+m.UNIT,'M\t'+m.WORKFLOW]
  def check(changes=allowed,parent=m.BASE,dirty=''):
   def fake(args,*rest):
    cmd=args[3:]
    if cmd==['rev-parse','HEAD']:return 'c'*40
    if cmd==['rev-parse','HEAD^']:return parent
    if cmd[0]=='status':return dirty
    if cmd[:3]==['diff','--name-status','--no-renames']:return '\n'.join(changes)
    if cmd[0]=='diff':return ''
    raise AssertionError('unexpected_git_command')
   with patch.object(m.h,'run',fake):m.source_gate(ROOT,'c'*40)
  check()
  for options in [dict(changes=allowed+['M\tsrc/db.js']),dict(parent='a'*40),dict(dirty='?? raw')]:
   with self.subTest(options=options),self.assertRaises(AssertionError):check(**options)
 def test_closed_original_summary_parser(self):
  prefix='STAGE6_BOOTSTRAP_MEMORY_SUPERVISOR ';x={'candidateSha':'c'*40,'contract':'one-owned-file-bootstrap-memory-supervisor-v1','status':'DIAGNOSTIC_COMPLETE_NOT_QUALIFICATION'};raw=prefix+json.dumps(x);self.assertEqual(m.parse_original_supervisor(raw,'c'*40),x)
  for bad in [raw+'\n'+raw,prefix+json.dumps({**x,'candidateSha':'d'*40}),prefix+json.dumps({**x,'contract':'old'}),prefix+'notJSON']:
   with self.subTest(bad=bad),self.assertRaises((AssertionError,ValueError)):m.parse_original_supervisor(bad,'c'*40)
 def test_missing_summary_preserves_only_closed_outer_metadata(self):
  raw='STAGE6_BOOTSTRAP_OBSERVED_STAGE '+json.dumps({'stage':'BEFORE_MIGRATE','elapsedMs':12})
  out=m.preserve_outer_observations(raw);self.assertEqual(len(out['observedStages']),1);self.assertFalse(out['malformedMetadata'])
  out=m.preserve_outer_observations(raw+'\nSTAGE6_BOOTSTRAP_OBSERVED_STAGE '+json.dumps({'stage':'private-user','elapsedMs':12}));self.assertTrue(out['malformedMetadata']);self.assertEqual(len(out['observedStages']),1)
  out=m.preserve_outer_observations('untrusted raw data');self.assertEqual(out['observedEndpoints'],[]);self.assertEqual(out['observedStages'],[])
 def test_nested_shapes_preserve_prior_valid_observation(self):
  prefix='STAGE6_BOOTSTRAP_OBSERVED_STAGE '+json.dumps({'stage':'BEFORE_MIGRATE','elapsedMs':12})+'\n'
  cg={k:0 for k in ['currentBytes','peakBytes','anonBytes','fileBytes','shmemBytes','kernelBytes','file_mappedBytes','oom','oomKills']}
  endpoint={'point':'PERIODIC','elapsedMs':13,'cgroup':cg,'scratch':{'count':0,'bytes':0},'child':{'status':'NOT_OBSERVED'}}
  good=m.preserve_outer_observations(prefix+'STAGE6_BOOTSTRAP_ENDPOINT '+json.dumps(endpoint));self.assertFalse(good['malformedMetadata']);self.assertEqual(len(good['observedEndpoints']),1)
  for field,values in [('cgroup',[list(cg),None,1,'no']),('scratch',[['count','bytes'],None,1,'no']),('child',[['status'],None,1,'no'])]:
   for value in values:
    with self.subTest(field=field,value=value):
     out=m.preserve_outer_observations(prefix+'STAGE6_BOOTSTRAP_ENDPOINT '+json.dumps({**endpoint,field:value}));self.assertTrue(out['malformedMetadata']);self.assertEqual(len(out['observedStages']),1);self.assertEqual(out['observedEndpoints'],[])
 def test_bounded_fixed_stage_and_pid_identity_parser(self):
  url=(ROOT/m.WRAPPER).as_uri()
  witness="import assert from 'node:assert/strict';import {parseStage,parseProcStat} from "+json.dumps(url)+";\n"+r"""
assert.deepEqual(parseStage('STAGE6_BOOTSTRAP_STAGE {"stage":"BEFORE_CONSTRUCTOR"}'),{stage:'BEFORE_CONSTRUCTOR'});
for(const line of ['STAGE6_BOOTSTRAP_STAGE {"stage":"private user"}','STAGE6_BOOTSTRAP_STAGE {"stage":"AFTER_SEED","raw":"no"}','STAGE6_BOOTSTRAP_STAGE notJSON'])assert.throws(()=>parseStage(line));
assert.equal(parseStage('raw untrusted line'),null);
const cols=['R',...Array(18).fill('0'),'123',...Array(4).fill('0')];assert.equal(parseProcStat('42 (odd ) name) '+cols.join(' '),42),123);assert.throws(()=>parseProcStat('42 (x) '+cols.join(' '),43));
"""
  p=subprocess.run(['node','--input-type=module','-e',witness],capture_output=True,text=True,timeout=10);self.assertEqual(p.returncode,0,p.stderr)
 def test_workflow_append_and_resource_scope(self):
  old=subprocess.check_output(['git','show',m.BASE+':'+m.WORKFLOW],cwd=ROOT).decode();new=(ROOT/m.WORKFLOW).read_text();self.assertTrue(new.startswith(old+'\n'));added=new[len(old):];self.assertIn(m.REF,added);self.assertIn(m.INTENT,added)
  c=(ROOT/m.CONTROL).read_text();p=(ROOT/m.WRAPPER).read_text();f=(ROOT/m.TEST).read_text()
  for value in ["'--memory','512m'","'--memory-swap','512m'","'--cpus','0.5'","'--network','none'","'55s'","timeout=70"]:self.assertIn(value,c)
  self.assertIn('},30000)',p);self.assertIn("sample('BEFORE_SOURCE_COPY')",p);self.assertIn("sample('AFTER_SOURCE_COPY')",p);self.assertIn('for(let i=0;i<2;i++)',f);self.assertNotIn("spawn('/usr/local/bin/isolated-sqld'",f);self.assertIn('EOFQualified:false',f)
 def test_original_direct_runner_authority_and_cleanup_byte_inverse(self):
  original=(ROOT/'test/stage6-owned-file-prepared-native-eof.mjs').read_text();f=(ROOT/m.TEST).read_text();a=' const admission=await db.admitRuntime(),releaseSha=';b=' for(let i=0;i<'
  self.assertEqual(f[f.index(a):f.index(b,f.index(a))].rstrip().removesuffix("mark('AFTER_LIVE_SETUP');").rstrip(),original[original.index(a):original.index(b,original.index(a))].rstrip())
if __name__=='__main__':unittest.main()

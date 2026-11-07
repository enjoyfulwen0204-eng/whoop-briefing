import test from 'node:test';
import assert from 'node:assert/strict';
import {runRehearsal} from '../tools/e1b/rehearse.mjs';
import {fail, failureFields} from '../tools/e1b/rehearsalDiagnostics.mjs';
import {RECOVERY_PRODUCTION_HOST} from '../src/recoveryPolicy.js';

const candidate = 'a'.repeat(40), base = 'b'.repeat(40);
const privateText = 'PRIVATE_FIXTURE_NEVER_LOG';
const external = () => { throw Object.assign(new TypeError(privateText), {code:'ATTACKER_CHOSEN', name:privateText}); };
function fixture() {
  const env = {E1B_ONE_OFF_JOB:'1', RENDER_SERVICE_ID:'srv-dahs71qd0e5s738n94c0',
    E1B_CANDIDATE_SHA:candidate, E1B_EXPECTED_BASE_SHA:base, PHASE4_RELEASE_SHA:base, RENDER_GIT_COMMIT:base,
    TURSO_DATABASE_URL:'libsql://'+RECOVERY_PRODUCTION_HOST, TURSO_AUTH_TOKEN:privateText,
    PHASE4_EXECUTION_PROFILE:'STAGE8_SCHEMA_TRANSITION', PHASE4_LOOKUP_KEY:privateText, PHASE4_AUDIT_KEY:privateText};
  const ops = {readHead:()=>candidate, phase4AuthorityKeys:()=>({}), createSchemaTransitionRuntimeProfile:()=>({}),
    mkdtemp:async()=>'/synthetic', rm:async()=>{}, exportSelectSnapshot:async({onReadStart})=>{onReadStart();return {tables:2,rows:5};},
    localAdapter:()=>({raw:{close(){}}}), denyRehearsalNetwork(){}, bindConnectionLifetime(){}, admitRuntime(){}, rehearseLocal(){}};
  const records = [];
  return {env,ops,now:()=>Date.parse('2026-11-07T06:14:00Z'),emit:r=>records.push(r),records};
}

for (const [step,code,change] of [
  ['JOB_IDENTITY','REHEARSAL_JOB_REQUIRED',f=>delete f.env.RENDER_SERVICE_ID],
  ['SHA','REHEARSAL_SHA_REQUIRED',f=>f.env.E1B_CANDIDATE_SHA=privateText],
  ['BUILD_MATCH','REHEARSAL_BUILD_MISMATCH',f=>f.env.RENDER_GIT_COMMIT=privateText],
  ['DB_IDENTITY','REHEARSAL_DATABASE_IDENTITY_MISMATCH',f=>f.env.TURSO_DATABASE_URL='https://synthetic.invalid'],
  ['START_WINDOW','JOB_WINDOW_CLOSED',f=>f.now=()=>Date.parse('2026-11-07T16:14:00Z')],
  ['AFTER_CRON','REHEARSAL_AFTER_CRON_REQUIRED',f=>f.now=()=>Date.parse('2026-11-07T06:13:00Z')],
  ['KEYS','UNCLASSIFIED',f=>f.ops.phase4AuthorityKeys=external],
  ['RUNTIME_PROFILE','UNCLASSIFIED',f=>f.ops.createSchemaTransitionRuntimeProfile=external],
  ['TMPDIR','UNCLASSIFIED',f=>f.ops.mkdtemp=external],
  ['EXPORT_CONNECT','SNAPSHOT_CURSOR_UNAVAILABLE',f=>f.ops.exportSelectSnapshot=()=>fail('SNAPSHOT_CURSOR_UNAVAILABLE')],
  ['EXPORT_READ','UNCLASSIFIED',f=>f.ops.exportSelectSnapshot=({onReadStart})=>{onReadStart();external();}],
  ['LOCAL_ADMIT','UNCLASSIFIED',f=>f.ops.admitRuntime=external],
  ['REHEARSE','REHEARSAL_SUBJECT_SCAN_FAILED',f=>f.ops.rehearseLocal=()=>fail('REHEARSAL_SUBJECT_SCAN_FAILED')],
]) test('failure identifies '+step+' without exposing private error or input',async()=>{
  const f=fixture();change(f);
  assert.equal(await runRehearsal(f),false);
  assert.deepEqual(f.records.at(-1),{phase:'COMPLETE',pass:false,step,code,error_class:code==='UNCLASSIFIED'?'TypeError':'Error',duration_ms:0});
  assert.doesNotMatch(JSON.stringify(f.records),/PRIVATE_FIXTURE_NEVER_LOG|ATTACKER_CHOSEN|libsql:\/\/|srv-dah/);
});

test('diagnostic codes require original issuer and valid syntax',()=>{
  for(const value of ['not safe','XY','X'.repeat(65)]){
    assert.throws(()=>fail(value),e=>failureFields(e).code==='UNCLASSIFIED');
  }
  const e=Object.assign(new RangeError(privateText),{name:privateText,code:'SNAPSHOT_CURSOR_UNAVAILABLE'});
  assert.deepEqual(failureFields(e),{code:'UNCLASSIFIED',error_class:'RangeError'});
  assert.deepEqual(failureFields(privateText),{code:'UNCLASSIFIED',error_class:'Unknown'});
});

for (const invalid of [true,false]) test('preflight collects independent booleans without touching disk or DB; invalid='+invalid,async()=>{
  const f=fixture();f.env.E1B_PREFLIGHT_ONLY='1';f.now=()=>Date.parse('2026-11-07T00:08:00Z');
  if(invalid){delete f.env.RENDER_SERVICE_ID;f.env.PHASE4_EXECUTION_PROFILE=privateText;f.env.TURSO_DATABASE_URL='invalid'+privateText;}
  for(const name of ['mkdtemp','exportSelectSnapshot','localAdapter','rehearseLocal'])f.ops[name]=()=>assert.fail('preflight executed '+name);
  assert.equal(await runRehearsal(f),!invalid);
  const [checks,result]=f.records;assert.equal(checks.phase,'PREFLIGHT');
  assert.ok(Object.entries(checks).every(([k,v])=>k==='phase'||typeof v==='boolean'));
  for(const name of ['START_WINDOW','AFTER_CRON'])assert.equal(checks[name],false);
  for(const name of ['SERVICE_ID_PRESENT','SERVICE_ID_MATCH','DB_HOST_MATCH','EXECUTION_PROFILE_MATCH','PROFILE_FIELDS_VALID','RUNTIME_PROFILE'])assert.equal(checks[name],!invalid);
  for(const name of ['BASE_SHA_VALID','CLONE_HEAD_MATCH','RENDER_COMMIT_MATCH','RELEASE_SHA_MATCH','DB_URL_PRESENT','LOOKUP_KEY_PRESENT','AUDIT_KEY_PRESENT'])assert.equal(checks[name],true);
  assert.equal(result.pass,!invalid);assert.doesNotMatch(JSON.stringify(f.records),/PRIVATE_FIXTURE_NEVER_LOG|srv-dah|libsql:\/\//);
});

test('protocol-only mode never constructs a DB client or touches a row, even outside export hours', async()=>{
  const f=fixture();f.env.E1B_EXPORT_PROBE_ONLY='1';f.now=()=>Date.parse('2026-11-07T16:24:00Z');
  let probes=0; f.ops.probeExportProtocol=async()=>{probes++;};
  for(const name of ['mkdtemp','exportSelectSnapshot','localAdapter','rehearseLocal']) f.ops[name]=external;
  assert.equal(await runRehearsal(f),true);assert.equal(probes,1);
  f.now=()=>Date.parse('2026-11-07T16:10:00Z');
  assert.equal(await runRehearsal(f),false);assert.equal(probes,1);
  f.now=()=>Date.parse('2026-11-07T16:24:00Z');delete f.env.RENDER_SERVICE_ID;
  assert.equal(await runRehearsal(f),false);assert.equal(probes,1);
});

import {probeExportProtocol} from '../tools/e1b/exportProbe.mjs';
for(const mode of ['absent','same','cross','throw']) test('protocol probe sends no SQL, follows no redirects and redacts '+mode,async()=>{
  const records=[],requests=[];
  const fetchImpl=async(url,init)=>{
    requests.push(url.pathname);
    assert.equal(url.origin,'https://'+RECOVERY_PRODUCTION_HOST);assert.equal(init.redirect,'manual');
    if(init.method==='POST'){
      assert.equal(init.headers.authorization,'Bearer '+privateText);
      if(url.pathname==='/v3/cursor')assert.deepEqual(JSON.parse(init.body),{baton:null,batch:{steps:[]}});
      else assert.deepEqual([...init.body],[0x12,0]);
    } else {assert.equal(init.method,'GET');assert.equal(init.headers,undefined);assert.equal(init.body,undefined);}
    if(mode==='throw')external();
    const redirect=mode==='same'||mode==='cross';
    const location=mode==='same'?'/'+privateText:'https://example.invalid/'+privateText;
    return new Response(privateText,{status:redirect?307:404,headers:{location}});
  };
  await probeExportProtocol({url:'libsql://'+RECOVERY_PRODUCTION_HOST,token:privateText,fetchImpl,emit:r=>records.push(r)});
  assert.deepEqual(requests,mode==='absent'?['/v3-protobuf','/v3','/v3-protobuf/cursor','/v3/cursor']:['/v3-protobuf','/v3']);
  for(const r of records){
    assert.equal(r.redirected,mode==='same'||mode==='cross');assert.equal(r.redirect_same_origin,mode==='same');
    assert.equal(r.fetch_threw,mode==='throw');assert.equal(r.error_class,mode==='throw'?'TypeError':null);
    assert.equal(r.http_status,mode==='throw'?null:r.redirected?307:404);
  }
  assert.doesNotMatch(JSON.stringify(records),/PRIVATE_FIXTURE|https?:|libsql:|example.invalid/);
});

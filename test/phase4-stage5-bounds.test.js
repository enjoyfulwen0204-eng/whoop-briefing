import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,request } from './stage5HistoryFixture.js';
import { call } from './stage5ClosureFixture.js';
import { createResultAuthority,REQUIRED_ROOT_BUDGET } from '../src/phase4ResultAuthority.js';

test('F: discovery fetches scoped cap+1 and never calculates or writes on overflow',async t=>{
  const f=await setup(t),req=request(f.initialRefs[0],f.initialRefs.slice(1)),execute=f.db.raw.execute;
  for(const [table,limit] of [['evidence_runs',501],['phase4_evidence_result_authorities',1001]]) {
    let observed=false;
    f.db.raw.execute=async statement=>{
      const sql=typeof statement==='string'?statement:statement.sql;
      if(sql.startsWith(`SELECT * FROM ${table} WHERE user_id=? AND execution_mode=?\n      AND input_generation=? ORDER BY`)) {
        assert.deepEqual(statement.args,['a','SHADOW',f.context.inputGeneration,limit]);observed=true;
        return {rows:Array.from({length:limit},()=>({}))};
      }
      return execute(statement);
    };
    await assert.rejects(call(f,'intelligence','analyzeMetric',req),/LEGACY_DISCOVERY_UNAVAILABLE/);
    assert.equal(observed,true,table);f.db.raw.execute=execute;
    for(const entity of ['evidence_runs','evidence_items','phase4_operation_receipts'])
      assert.equal((await execute(`SELECT count(*) n FROM ${entity}`)).rows[0].n,0);
  }
});

test('K: root bounds reject complete overflows and deduplicate repeated dependencies',async()=>{
  // The root resolver is a deterministic in-memory adapter. No database field
  // limit masks the independent manifest count/byte guards under test.
  const row=id=>({id,updated_at:'2026-09-25T12:00:00.000Z',synced_at:null,score_state:'SCORED'});
  const core={client:{},keys:{digest:()=> '0'.repeat(64)},
    revalidateSources:async(context,ids)=>ids.map(id=>({id,type:'recovery',mode:'SHARED',row:row(id)})),
    root:async(context,type,id)=>({row:row(id)})};
  const authority=createResultAuthority(core),context={userId:'a',executionMode:'SHADOW'};
  const one=await authority.captureRoots(context,Array(10001).fill('same'),'salt');
  assert.equal(one.root_count,1);assert.equal(one.roots.length,1);
  await assert.rejects(authority.captureRoots(context,Array.from({length:REQUIRED_ROOT_BUDGET.count+1},(_,i)=>String(i)),'salt'),
    /REQUIRED_ROOT_BOUNDS_UNAVAILABLE/);
  await assert.rejects(authority.captureRoots(context,['x'.repeat(REQUIRED_ROOT_BUDGET.bytes+1)],'salt'),/REQUIRED_ROOT_BOUNDS_UNAVAILABLE/);
});

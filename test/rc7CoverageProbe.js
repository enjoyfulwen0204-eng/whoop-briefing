import assert from 'node:assert/strict';
import { setup,insertCoverage } from './stage5AssociationFixture.js';
const cleanup=[],t={after(fn){cleanup.push(fn);}},f=await setup(t,{days:2,createFacts:false});
try {
  const n=Number(process.argv[2]??1),ids=['coverage-caffeine'];
  for(let i=1;i<n;i++)ids.push(await insertCoverage(f,{id:`cycle-${i}`,startDate:'2026-09-23',endDate:'2026-09-24'}));
  for(let i=0;i<n;i++)await f.db.raw.execute({sql:'UPDATE journal_coverage_windows SET supersedes_coverage_window_id=? WHERE user_id=? AND coverage_window_id=?',args:[ids[(i+1)%n],'a',ids[i]]});
  const {core,stores}=await f.restart(),c=await stores.capture('a',{executionMode:'SHADOW'});
  await assert.rejects(core.validateHistoricalJournal(c,{type:'JOURNAL_COVERAGE',id:ids[0],historicalAsOf:'2026-09-25T12:00:00.000Z',row:null}),/PHASE4_COVERAGE_LINEAGE_INVALID/);
  process.stdout.write('PHASE4_COVERAGE_LINEAGE_INVALID\n');
} finally {for(const fn of cleanup)fn();}

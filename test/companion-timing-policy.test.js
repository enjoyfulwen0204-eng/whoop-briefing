import test from 'node:test';import assert from 'node:assert/strict';
import {companionSchedulerSlots,inCompanionQuietHours,selectCompanionInvitation} from '../src/companionTimingPolicy.js';
const ms=s=>Date.parse(s),base={now:ms('2026-10-13T01:00:00Z'),wakeAt:ms('2026-10-13T00:00:00Z'),briefAt:ms('2026-10-13T00:35:00Z'),journalAt:ms('2026-10-13T00:40:00Z'),healthDay:'2026-10-13',timezone:'Asia/Taipei',seed:'a'.repeat(64)};
test('actual44 dailycoarse opportunities only and deterministic futurewake4to6h selection',()=>{
 assert.equal(companionSchedulerSlots(ms('2026-10-13T00:00Z'),ms('2026-10-13T23:59Z')).length,44);
 const v=selectCompanionInvitation(base);assert.deepEqual(selectCompanionInvitation(base),v);
 assert.equal(v.state,'SCHEDULED');assert.ok(v.selectedAt>=base.wakeAt+4*3600000&&v.selectedAt<=base.wakeAt+6*3600000);
 assert.equal(new Date(v.selectedAt).getUTCMinutes(),10);
});
test('late Journal, late planning and quietperiod skip; no catchup afterwindow',()=>{
 assert.equal(selectCompanionInvitation({...base,now:ms('2026-10-13T05:00Z'),journalAt:ms('2026-10-13T04:30Z')}).state,'SKIPPED');
 assert.equal(selectCompanionInvitation({...base,now:ms('2026-10-13T06:01Z')}).state,'SKIPPED');
 const late={...base,now:ms('2026-10-13T10:00Z'),wakeAt:ms('2026-10-13T09:00Z'),briefAt:ms('2026-10-13T09:35Z'),journalAt:ms('2026-10-13T09:40Z')};
 const v=selectCompanionInvitation(late);assert.equal(v.selectedAt,ms('2026-10-13T13:10Z'));
 assert.equal(selectCompanionInvitation({...late,now:ms('2026-10-13T13:11Z')}).state,'SKIPPED');
});
test('quiet hours use usertimezone acrossDST, midnight andexactboundaries',()=>{
 assert.equal(inCompanionQuietHours(ms('2026-11-01T05:30Z'),'America/New_York'),true);
 assert.equal(inCompanionQuietHours(ms('2026-11-01T06:30Z'),'America/New_York'),true);
 assert.equal(inCompanionQuietHours(ms('2026-10-13T14:00Z'),'Asia/Taipei'),true);
 assert.equal(inCompanionQuietHours(ms('2026-10-13T00:00Z'),'Asia/Taipei'),false);
 assert.equal(inCompanionQuietHours(ms('2026-10-13T02:00Z'),'Asia/Taipei','10:00','11:00'),true);
 assert.equal(inCompanionQuietHours(ms('2026-10-13T03:00Z'),'Asia/Taipei','10:00','11:00'),false);
});
test('futurewake, wronghealthday, invalidquietformat orunboundeddefaults are rejected',()=>{
 assert.throws(()=>selectCompanionInvitation({...base,wakeAt:base.now+1}),/AUTHORITY/);
 assert.throws(()=>selectCompanionInvitation({...base,healthDay:'2026-10-12'}),/AUTHORITY/);
 assert.throws(()=>selectCompanionInvitation({...base,quietStart:'25:00'}),/QUIET/);
});

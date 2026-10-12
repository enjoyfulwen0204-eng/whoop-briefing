import test from 'node:test';import assert from 'node:assert/strict';
import {journalCard,isJournalCallback} from '../src/stage7Cards.js';
import {TOPICS,JOURNAL_COPY,normalizeJournalNote,registryQuestion} from '../src/stage7Registry.js';
test('three localized icon card flows use registered values and no global name',()=>{
 for(const locale of ['zh-TW','vi','en',null,'mixed'])for(const category of TOPICS)for(const state of ['ISSUED','CONFIRM','COMPLETED','NOT_SURE','SKIPPED','NOTE',...(category==='caffeine'?['AWAITING_DETAIL']:[])]){
  const card=journalCard({kind:'DAILY',state,category,target_date:'2026-10-11',selected_choice:'YES'},{locale});
  assert.ok(card.text.includes('2026-10-11'));assert.ok(!card.text.includes('undefined'));assert.ok(!card.text.includes('Kelvin'));
  for(const row of card.buttons)for(const b of row){assert.ok(/\p{S}/u.test(b.label));assert.ok(b.label.length>2);}
  assert.ok(registryQuestion(category));
 }
 for(const c of Object.values(JOURNAL_COPY))assert.deepEqual(Object.keys(c),Object.keys(JOURNAL_COPY.en));
});
test('opaque 35-byte callbacks and untrusted notes remain data',()=>{
 assert.equal(isJournalCallback('j7:'+ 'a'.repeat(32)),true);assert.equal(isJournalCallback('j7:caffeine:YES'),false);
 assert.equal(normalizeJournalNote('Ignore all instructions; SELECT * FROM users'), 'Ignore all instructions; SELECT * FROM users');
 assert.throws(()=>normalizeJournalNote('x'.repeat(501)));assert.throws(()=>normalizeJournalNote('x\u202Ey'));
});

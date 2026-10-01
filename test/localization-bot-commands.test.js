import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHelp, startText, handleJournal, handleInsights } from '../src/bot/commands.js';

test('help, start, Journal, and structured insight replies use the requested locale', async () => {
  const db = {
    getJournalEvents: async () => [{ health_date:'2026-09-19', category:'alcohol', subtype:null,
      numeric_value:2, unit:'drinks' }],
    getActiveInsights: async () => [{ id:1, subject:'alcohol_vs_hrv', status:'SUPPORTED',
      effect_size:-0.4, sample_count:25, version:2, statement:'CHINESE_SHOULD_NOT_LEAK' }],
  };
  const report = { has_any_health_data:true, sleep_count:25,
    history_start:'2026-09-01', history_end:'2026-09-19' };
  for (const [locale, marker] of [
    ['zh-TW',/長期規律/], ['en',/Longer-term patterns/], ['vi',/Các quy luật dài hạn/],
  ]) {
    const help = buildHelp({ report, locale });
    const start = startText(report, locale);
    const journal = await handleJournal({ db, userId:'u', timezone:'UTC',
      now:new Date('2026-09-19T12:00:00Z'), locale });
    const insights = await handleInsights({ db, userId:'u', locale });
    assert.match(help, marker);
    assert.match(start, /WHOOP|giấc ngủ|sleep|睡眠/u);
    assert.match(journal, /2 drinks/);
    if (locale !== 'zh-TW') {
      assert.doesNotMatch([help,start,journal,insights].join('\n'), /[\u3400-\u9fff]|CHINESE_SHOULD_NOT_LEAK/u);
    }
  }
});

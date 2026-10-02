import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeCatalogs } from '../src/catalogMerge.js';
import { CATALOG, LOCALES, t, validateCatalogs } from '../src/localization.js';
import { renderValidationFailure, validationMessageKey } from '../src/validationMessages.js';
import { handleLog } from '../src/bot/commands.js';
import { buildQuestionText } from '../src/questionEngine.js';

const small = text => ({ 'zh-TW': { key:text }, en:{ key:text }, vi:{ key:text } });

test('catalog merge rejects conflicting text, conflicting placeholders, and even identical duplicates', () => {
  for (const second of [small('different'), small('{other}'), small('{value}')]) {
    assert.throws(() => mergeCatalogs([['first',small('{value}')],['second',second]]),
      /LOCALIZATION_DUPLICATE_KEY:zh-TW:key:first:second/);
  }
  assert.equal(validateCatalogs(), true);
  const counts = LOCALES.map(locale => Object.keys(CATALOG[locale]).length);
  assert.equal(new Set(counts).size, 1);
  assert.ok(counts[0] >= 700);
  assert.throws(() => mergeCatalogs([['bad',{...small('ok'),fr:{key:'ok'}}]]),
    /LOCALIZATION_LOCALE_UNSUPPORTED/);
  assert.throws(() => validateCatalogs({...CATALOG,fr:{}}),
    /LOCALIZATION_LOCALE_UNSUPPORTED_OR_MISSING/);
  assert.throws(() => validateCatalogs({
    'zh-TW': { key:'{value}' },en:{key:'{other}'},vi:{key:'{value}'},
  }), /LOCALIZATION_PLACEHOLDER_MISMATCH/);
  assert.throws(() => validateCatalogs({
    'zh-TW': { key:'ok' },en:{},vi:{key:'ok'},
  }), /LOCALIZATION_CATALOG_INCOMPLETE/);
});

test('journal validation outcomes render only localized public copy', async () => {
  const cases = [
    ['negative_numeric_value','validation.negative'],
    ['UNKNOWN_UNIT','validation.unit'],
    ['VALUE_REQUIRED','validation.required'],
    ['unknown_category:unsupported','validation.unsupported'],
    ['UNEXPECTED_PRIVATE_CODE','validation.generic'],
    ['__proto__','validation.generic'],
  ];
  for (const locale of LOCALES) {
    for (const [code,key] of cases) {
      assert.equal(validationMessageKey(code),key);
      const text = renderValidationFailure(locale,[code]);
      assert.equal(text,t(locale,key));
      assert.doesNotMatch(text, /negative_numeric_value|UNKNOWN_UNIT|VALUE_REQUIRED|unknown_category|UNEXPECTED_PRIVATE_CODE/);
      assert.doesNotMatch(text, /[A-Z]{3,}_[A-Z_]+|[a-z]+_[a-z_]+/);
      if (locale !== 'zh-TW') assert.doesNotMatch(text,/[\u3400-\u9fff]/u);
    }
    const actual = await handleLog({ db:{ addJournalEvent:()=>{ throw Error('should not write'); } },
      userId:'alice',argsText:'alcohol -3 drinks',timezone:'Asia/Taipei',
      now:new Date('2026-09-19T12:00:00Z'),locale });
    assert.equal(actual,t(locale,'validation.negative'));
    const unsupported = await handleLog({ db:{ addJournalEvent:()=>{ throw Error('should not write'); } },
      userId:'alice',argsText:'unsupported_category 3',timezone:'Asia/Taipei',
      now:new Date('2026-09-19T12:00:00Z'),locale });
    assert.equal(unsupported,t(locale,'validation.unsupported'));
  }
});

test('English proactive degree precedes the comparison direction', () => {
  const sentence = buildQuestionText({ category:'alcohol',
    signal:{metric:'hrv',direction:'low',level:'STRONG'},locale:'en' });
  assert.match(sentence,/Your HRV is quite a bit lower than usual today\./);
  assert.doesNotMatch(sentence,/lower by quite a bit than/);
});

test('user-facing renderers have no alternate Traditional Chinese locale branch', () => {
  const paths = [
    'src/assertionRenderer.js','src/bot/answer.js','src/bot/commands.js',
    'src/briefingStatus.js','src/dataQuality.js','src/evidence.js',
    'src/healthspanEngine.js','src/journal.js','src/proactiveMessages.js',
    'src/proactiveReanalysis.js','src/questionEngine.js','src/usage.js',
  ];
  for (const path of paths) assert.doesNotMatch(readFileSync(new URL(`../${path}`,import.meta.url),'utf8'),
    /locale\s*(?:===|!==)\s*['"]zh-TW['"]/,
    path);
});

import assert from 'node:assert/strict';
import { syntheticPhase4Fixture } from './phase4Fixture.js';
import { bodyInput, seedBodyInput } from './bodyEnergyFixture.js';
import { addDays } from '../src/time.js';

const nowMs = Date.parse('2026-09-25T12:00:00.000Z');

async function insertCoverage(f, { startDate, endDate, id = 'coverage-caffeine' }) {
  const state = (await f.db.raw.execute("SELECT u.lifecycle_generation,COALESCE(t.auth_generation,0) auth_generation,p.purge_generation,c.input_generation FROM users u LEFT JOIN user_whoop_tokens t ON t.user_id=u.id JOIN phase4_user_state p ON p.user_id=u.id JOIN phase4_computation_state c ON c.user_id=u.id AND c.execution_mode='SHADOW' WHERE u.id='a'")).rows[0];
  const at = new Date(nowMs).toISOString(), privacyId = f.keys.lookup(['synthetic-coverage', id]);
  await f.db.raw.execute({ sql: `INSERT INTO journal_coverage_windows(user_id,coverage_window_id,window_start_utc,window_end_utc,
    health_date_start,health_date_end,recorded_timezone,factor_set_version,factor_keys_json,source_event_key,confirmation_text_hash,
    parser_version,normalizer_version,lifecycle_generation,auth_generation,input_generation,status,revision,answer_confidence,
    created_at,updated_at,content_state,source_linkage_state,privacy_artifact_id,content_digest_salt,purge_generation)
    VALUES ('a',?,?,?,?,?,'Asia/Taipei','journal-factors-v1','["caffeine"]',?,'synthetic-confirmation',
    'journal-candidate-v1','journal-normalizer-v1',?,?,?,'ACTIVE',1,1,?,?,'PRESENT','COMPLETE',?,?,?)`,
  args: [id, `${startDate}T00:00:00.000Z`, `${addDays(endDate, 1)}T00:00:00.000Z`, startDate, endDate,
    `coverage-source-${id}`, state.lifecycle_generation, state.auth_generation, state.input_generation, at, at,
    privacyId, f.keys.newSalt(), state.purge_generation] });
  return id;
}

async function setup(t, { days = 60, createFacts = true,wallClock=nowMs } = {}) {
  let clock = new Date(wallClock);
  const f = await syntheticPhase4Fixture(t, { now: () => clock });
  const input = bodyInput({ asOf: nowMs, days: days - 1 });
  for (let index = 0; index < input.sources.recovery.length; index += 1) {
    input.sources.recovery[index].recovery_score = index % 2 === 0 ? 40 : 50;
  }
  await f.db.transaction(() => seedBodyInput(f.db, input));
  const logicalFacts = [], control = await f.stores.captureControl('a');
  if (createFacts) for (let index = 0; index < input.sources.recovery.length; index += 2) {
    const factorDate = addDays(input.sources.recovery[index].health_date, -1), eventAt = `${factorDate}T13:00:00.000Z`;
    const sourceText = `caffeine at ${eventAt}`;
    const created = await f.stores.journal.create(control, { sourceEventKey: `caffeine-${index}`, sourceText,
      candidate: { category: 'caffeine', eventAt, valueKind: 'PRESENCE', exposureState: 'EXPOSED', extractionConfidence: 1,
        excerptStart: 0, excerptEnd: [...sourceText].length } });
    assert.equal(created.status, 'ACCEPT'); logicalFacts.push(created.logicalFactId);
  }
  const factorDates = input.sources.recovery.map(row => addDays(row.health_date, -1)).sort();
  const coverageId = await insertCoverage(f, { startDate: factorDates[0], endDate: factorDates.at(-1) });
  const context = await f.stores.capture('a', { executionMode: 'SHADOW' });
  const outcomeRefs = [];
  for (const row of input.sources.recovery) outcomeRefs.push((await f.stores.root(context, 'recovery', row.sleep_id)).ref);
  const factRows = (await f.db.raw.execute("SELECT logical_fact_id,privacy_artifact_id FROM journal_events WHERE user_id='a' AND fact_status='ACTIVE' ORDER BY health_date")).rows;
  const factRefs = [];
  for (const row of factRows) factRefs.push((await f.stores.root(context, 'JOURNAL_FACT', row.privacy_artifact_id)).ref);
  const coverageRef = (await f.stores.root(context, 'JOURNAL_COVERAGE', coverageId)).ref;
  return { ...f, context, control, input, outcomeRefs, factRefs, coverageRef, logicalFacts,
    setNow(value) { clock = new Date(value); } };
}

function hypothesis(f, indexes) {
  return { factor: 'caffeine', outcomeMetric: 'recovery_score', lagDays: 1,
    comparisonHealthDates: indexes.map(index=>f.input.sources.recovery[index].health_date),
    outcomeSources: indexes.map(index => f.outcomeRefs[index]), journalFactSources: f.factRefs, coverageSources: [f.coverageRef] };
}
const family = (name, hypothesisValue, asOfUtc = new Date(nowMs).toISOString()) => ({
  asOfUtc, multipleTestingFamily: name, hypotheses: [hypothesisValue],
});

export { setup, hypothesis, family, insertCoverage };

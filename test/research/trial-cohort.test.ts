import assert from 'node:assert/strict';
import test from 'node:test';
import { captureFixture, epoch } from './capture-fixture.js';
import { TrialCohort } from '../../src/research/trial-cohort.js';
import { OutcomeCollector } from '../../src/research/outcome-collector.js';
import type { MarketScreen } from '../../src/decision/market-screen.js';

void test('market-eligible risk rejection gets an immutable diagnostic anchor, never a formal opportunity or send', async () => {
  const { storage, research, fact } = await captureFixture();
  try {
    const screen: MarketScreen = {
      atMs: epoch,
      factId: fact.factId,
      activation: 'PASS',
      values: { price: '1' },
      conditions: []
    };
    const risk = {
      kind: 'risk' as const,
      reason: 'entrapment_limit',
      expiresAtMs: epoch + 30000,
      factIds: [fact.factId]
    };
    const cohort = new TrialCohort(storage, 'run', 'model', 1);
    assert.equal(await cohort.register(fact, { ...screen, activation: 'FAIL' }, risk), null);
    const id = await cohort.register(fact, screen, risk);
    assert.ok(id);
    assert.equal(
      await new TrialCohort(storage, 'run', 'model', 1).register(
        fact,
        { ...screen, atMs: epoch + 10000, values: { price: '0.5' } },
        null
      ),
      null
    );
    assert.deepEqual(
      storage.db
        .prepare('SELECT price,available_at_ms,track FROM evaluation_baselines WHERE baseline_id=?')
        .get(id),
      { price: '1', available_at_ms: epoch, track: 'candidate_reference_v1' }
    );
    const second = { ...fact, token: '0x' + 'd'.repeat(40) };
    assert.equal(await cohort.register(second, screen, null), null);
    assert.deepEqual(
      storage.db
        .prepare(
          'SELECT status,COUNT(*) n FROM research_trial_cohorts GROUP BY status ORDER BY status'
        )
        .all(),
      [
        { status: 'RESOURCE_EXCLUDED', n: 1 },
        { status: 'SELECTED', n: 1 }
      ]
    );
    for (const table of ['signals', 'research_engine_states', 'publication_token_locks'])
      assert.equal(
        (storage.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n,
        0
      );
    let now = epoch + 30000,
      captures = 0;
    const capture = () => {
      captures++;
      return Promise.reject(new Error('unavailable'));
    };
    const candidates = new OutcomeCollector(research, () => now, capture, undefined, 'candidates');
    const published = new OutcomeCollector(research, () => now, capture, undefined, 'published');
    await candidates.scheduleNext(id);
    await candidates.scheduleNext(id);
    assert.equal(
      (storage.db.prepare('SELECT COUNT(*) n FROM research_outcome_tasks').get() as { n: number })
        .n,
      4
    );
    assert.equal(await candidates.tick(), false); // Wait for the whole candle, including its close.
    now += 1100;
    assert.equal(await published.tick(), false);
    assert.equal(await candidates.tick(), true);
    assert.equal(captures, 1);
  } finally {
    storage.close();
  }
});

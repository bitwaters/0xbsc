import assert from 'node:assert/strict';
import test from 'node:test';
import { captureFixture, epoch } from './capture-fixture.js';
import { TrialCohort } from '../../src/research/trial-cohort.js';
import { OutcomeCollector } from '../../src/research/outcome-collector.js';
import type { MarketScreen } from '../../src/decision/market-screen.js';
import { createMarketFact } from '../../src/gmgn/facts.js';

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

void test('restart catches up the full frozen path without replaying every missed polling coordinate', async () => {
  const { storage, research, fact } = await captureFixture();
  try {
    const id = await new TrialCohort(storage, 'run', 'model').register(
      fact,
      {
        atMs: epoch,
        factId: fact.factId,
        activation: 'PASS',
        values: { price: '1' },
        conditions: []
      },
      null
    );
    assert.ok(id);
    let capturedFrom: number | undefined;
    const collector = new OutcomeCollector(
      research,
      () => epoch + 301000,
      (address, poolRevision, from, to) => {
        capturedFrom = from;
        return Promise.resolve(
          createMarketFact({
            poolRevision,
            request: {
              method: 'GET',
              path: '/v1/market/token_kline',
              query: { address, from, to, resolution: '30s' }
            },
            response: {
              data: {
                list: Array.from({ length: 10 }, (_, i) => ({
                  time: epoch + i * 30000,
                  open: '1',
                  close: '1',
                  low: i === 1 ? '0.85' : '1',
                  high: i === 8 ? '1.5' : '1',
                  volume: '100'
                }))
              }
            },
            attemptId: 'catchup',
            purpose: 'outcome',
            queuedAtMs: epoch + 301000,
            requestedAtMs: epoch + 301000,
            receivedAtMs: epoch + 301000
          })
        );
      }
    );
    await collector.scheduleNext(id);
    assert.deepEqual(
      storage.db
        .prepare('SELECT DISTINCT horizon_at_ms,due_at_ms FROM research_outcome_tasks')
        .all(),
      [{ horizon_at_ms: epoch + 300000, due_at_ms: epoch + 301000 }]
    );
    const trace = storage.db
      .prepare(
        "SELECT metadata_json FROM operation_traces WHERE stage='result' AND json_extract(metadata_json,'$.reason')='CATCHUP_FULL_PATH'"
      )
      .get() as { metadata_json: string };
    assert.equal(
      (JSON.parse(trace.metadata_json) as { skippedObservationPoints: number })
        .skippedObservationPoints,
      9
    );
    assert.deepEqual(
      storage.db
        .prepare('SELECT price,available_at_ms FROM evaluation_baselines WHERE baseline_id=?')
        .get(id),
      { price: '1', available_at_ms: epoch }
    );
    await collector.scheduleNext(id);
    assert.equal(
      (storage.db.prepare('SELECT COUNT(*) n FROM research_outcome_tasks').get() as { n: number })
        .n,
      4
    );
    assert.equal(await collector.tick(), true);
    assert.equal(capturedFrom, epoch);
    const result = storage.db
      .prepare("SELECT result_json FROM research_outcome_tasks WHERE status='DONE'")
      .get() as { result_json: string };
    assert.equal((JSON.parse(result.result_json) as { outcome: string }).outcome, 'SL');
  } finally {
    storage.close();
  }
});

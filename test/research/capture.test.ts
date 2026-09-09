import assert from 'node:assert/strict';
import test from 'node:test';
import { captureFixture, token, pool, epoch } from './capture-fixture.js';
import { MeasurementStore } from '../../src/research/measurement-store.js';
import { BaselineSampler } from '../../src/research/baseline-sampler.js';
import { OutcomeCollector } from '../../src/research/outcome-collector.js';
import { createMarketFact } from '../../src/gmgn/facts.js';
import type { QuoteObservation } from '../../src/research/measurement.js';
const input = {
  runId: 'run',
  opportunityId: 'op',
  token,
  poolRevision: pool,
  preparationComplete: true,
  confirmation: { kind: 'SIMULATED' as const, preparedAtMs: epoch }
};

void test('collector restart resumes an old baseline after a completed cadence without changing its coordinate', async () => {
  const { storage, research, fact } = await captureFixture();
  try {
    const store = new MeasurementStore(storage);
    const id = await store.begin({
      runId: 'run',
      opportunityId: 'op',
      track: 'post_confirmation_market_v1',
      confirmationAtMs: epoch,
      confirmationKind: 'ACTUAL'
    });
    await store.settle(id, {
      status: 'VALID',
      reason: 'fixture',
      price: '1',
      availableAtMs: epoch,
      sourceAtMs: epoch,
      factId: fact.factId
    });
    for (const target of [1.3, 1.5, 2, 3]) {
      const taskId = await store.schedule(id, target, epoch + 30000, epoch + 31000);
      await store.claim(taskId, epoch + 31000);
      await store.finish(taskId, { outcome: 'CENSORED', reason: 'HORIZON_PENDING' });
    }
    const original = storage.db.prepare('SELECT * FROM evaluation_baselines').get();
    const collector = new OutcomeCollector(
      research,
      () => epoch + 120000,
      () => Promise.reject(new Error('recovery must not call the API')),
      undefined,
      'published'
    );
    await collector.recover();
    await collector.recover();
    assert.deepEqual(
      storage.db
        .prepare(
          "SELECT COUNT(*) n,MIN(horizon_at_ms) at FROM research_outcome_tasks WHERE status='PENDING'"
        )
        .get(),
      { n: 4, at: epoch + 120000 }
    );
    assert.deepEqual(storage.db.prepare('SELECT * FROM evaluation_baselines').get(), original);
  } finally {
    storage.close();
  }
});

void test('a later Kline gap cannot erase a proven first touch, but an earlier gap prevents it', async () => {
  for (const gapBeforeTouch of [false, true]) {
    const { storage, research, fact } = await captureFixture();
    try {
      const store = new MeasurementStore(storage);
      const id = await store.begin({
        runId: 'run',
        opportunityId: 'op',
        track: 'post_confirmation_market_v1',
        confirmationAtMs: epoch,
        confirmationKind: 'ACTUAL'
      });
      await store.settle(id, {
        status: 'VALID',
        reason: 'fixture',
        price: '1',
        availableAtMs: epoch,
        sourceAtMs: epoch,
        factId: fact.factId
      });
      let attempts = 0;
      const collector = new OutcomeCollector(
        research,
        () => epoch + 91000,
        (address, poolRevision, from, to) =>
          Promise.resolve(
            createMarketFact({
              poolRevision,
              request: {
                method: 'GET',
                path: '/v1/market/token_kline',
                query: { address, from, to, resolution: '30s' }
              },
              response: {
                data: {
                  list: [0, 60000].map((offset) => ({
                    time: epoch + offset,
                    open: '1',
                    low: '1',
                    high: (gapBeforeTouch ? offset > 0 : offset === 0) ? '1.4' : '1.1',
                    close: '1',
                    volume: '10'
                  }))
                }
              },
              attemptId: 'gap-' + ++attempts,
              purpose: 'outcome',
              queuedAtMs: epoch + 90000,
              requestedAtMs: epoch + 90000,
              receivedAtMs: epoch + 90100
            })
          )
      );
      await store.schedule(id, 1.3, epoch + 90000, epoch + 91000);
      await collector.tick();
      const row = storage.db
        .prepare('SELECT result_json FROM research_outcome_tasks WHERE result_json IS NOT NULL')
        .get() as { result_json: string };
      const result = JSON.parse(row.result_json) as { outcome: string; reason: string };
      assert.equal(result.outcome, gapBeforeTouch ? 'UNKNOWN' : 'TP');
      assert.equal(result.reason, gapBeforeTouch ? 'PATH_GAP_OR_OVERLAP' : 'TARGET_FIRST');
    } finally {
      storage.close();
    }
  }
});
void test('sampler persists pending before physical calls and terminal baselines never request again', async () => {
  const { storage, research, fact } = await captureFixture();
  let now = epoch,
    calls = 0;
  try {
    const store = new MeasurementStore(storage);
    const sampler = new BaselineSampler(store, {
      now: () => now,
      random: () => 0.5,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      }
    });
    const capture = {
      market: async () => {
        calls++;
        assert.ok(now >= epoch + 1000);
        assert.equal(
          (
            storage.db
              .prepare("SELECT COUNT(*) AS n FROM evaluation_baselines WHERE status='PENDING'")
              .get() as { n: number }
          ).n,
          2
        );
        now += 100;
        const f = {
          ...fact,
          factId: 'market',
          attemptId: 'market',
          requestedAtMs: now - 100,
          queuedAtMs: now - 100,
          receivedAtMs: now,
          sourceAtMs: now - 100,
          qualityFlags: []
        };
        await research.recordFact(f, 'run', 2 ** 30);
        return f;
      },
      quote: () => {
        calls++;
        now += 100;
        return Promise.resolve({
          factId: fact.factId,
          chain: 'bsc',
          token,
          poolRevision: pool,
          wallet: 'wallet',
          inputAsset: 'usd',
          outputAsset: token,
          direction: 'buy',
          inputAmount: '10',
          outputAmount: '10',
          inputUsd: '10',
          outputUsd: '9.99',
          slippage: '1',
          semantics: 'fixture',
          requestedAtMs: now - 100,
          receivedAtMs: now
        } as QuoteObservation);
      }
    };
    const ids = await sampler.sample(input, capture);
    assert.equal(calls, 2);
    assert.equal(ids.confirmationAtMs, epoch + 1000);
    assert.equal(await sampler.sample(input, capture).then((r) => r.status), 'ALREADY_TERMINAL');
    assert.equal(calls, 2);
    assert.equal(
      (
        storage.db
          .prepare("SELECT COUNT(*) AS n FROM evaluation_baselines WHERE status='VALID'")
          .get() as { n: number }
      ).n,
      2
    );
  } finally {
    storage.close();
  }
});
void test('physical attempt reservations and deadline survive a new sampler instance', async () => {
  const { storage } = await captureFixture();
  try {
    const store = new MeasurementStore(storage),
      common = {
        runId: 'run',
        opportunityId: 'op',
        confirmationKind: 'SIMULATED' as const,
        confirmationAtMs: epoch + 1000
      };
    const market = await store.begin({ ...common, track: 'post_confirmation_market_v1' }),
      quote = await store.begin({ ...common, track: 'post_confirmation_quote_v1' });
    assert.equal(await store.claimBaselineAttempt(market, epoch + 999), false);
    assert.equal(await store.claimBaselineAttempt(market, epoch + 1000), true);
    assert.equal(await store.claimBaselineAttempt(market, epoch + 1000), true);
    assert.equal(await store.claimBaselineAttempt(market, epoch + 1000), false);
    await store.claimBaselineAttempt(quote, epoch + 1000);
    const sampler = new BaselineSampler(store, {
      now: () => epoch + 7000,
      random: () => 0.5,
      sleep: () => Promise.resolve()
    });
    let calls = 0;
    const unexpected = () => {
      calls++;
      return Promise.reject(new Error('unexpected network'));
    };
    const result = await sampler.sample(input, { market: unexpected, quote: unexpected });
    assert.equal(result.status, 'BASELINE_DEADLINE_EXPIRED');
    assert.equal(calls, 0);
    assert.equal(
      (
        storage.db
          .prepare("SELECT COUNT(*) AS n FROM evaluation_baselines WHERE status='MISSING'")
          .get() as { n: number }
      ).n,
      3
    );
  } finally {
    storage.close();
  }
});
void test('four outcome targets reuse one physical range and schedule only the next cadence', async () => {
  const { storage, research, fact } = await captureFixture();
  let calls = 0;
  try {
    const m = new MeasurementStore(storage);
    const id = await m.begin({
      runId: 'run',
      opportunityId: 'op',
      track: 'post_confirmation_market_v1',
      confirmationAtMs: epoch,
      confirmationKind: 'ACTUAL'
    });
    await m.settle(id, {
      status: 'VALID',
      reason: 'fixture',
      price: '1',
      availableAtMs: epoch,
      sourceAtMs: epoch,
      factId: fact.factId
    });
    const collector = new OutcomeCollector(
      research,
      () => epoch + 31100,
      (address, p, fromMs, toMs) => {
        calls++;
        return Promise.resolve(
          createMarketFact({
            poolRevision: p,
            request: {
              method: 'GET',
              path: '/v1/market/token_kline',
              query: { address, from: fromMs, to: toMs, resolution: '30s' }
            },
            response: {
              data: {
                list: [
                  { time: fromMs, open: '1', low: '1', high: '1.4', close: '1.3', volume: '100' }
                ]
              }
            },
            attemptId: 'kline',
            purpose: 'outcome',
            queuedAtMs: epoch + 30000,
            requestedAtMs: epoch + 30000,
            receivedAtMs: epoch + 30100
          })
        );
      }
    );
    await collector.scheduleNext(id);
    await collector.scheduleNext(id);
    assert.equal(
      (storage.db.prepare('SELECT COUNT(*) n FROM research_outcome_tasks').get() as { n: number })
        .n,
      4
    );
    for (let i = 0; i < 4; i++) assert.equal(await collector.tick(), true);
    assert.equal(calls, 1);
    assert.deepEqual(
      storage.db
        .prepare(
          'SELECT status,COUNT(*) AS n FROM research_outcome_tasks GROUP BY status ORDER BY status'
        )
        .all(),
      [
        { status: 'DONE', n: 4 },
        { status: 'PENDING', n: 3 }
      ]
    );
    const row = storage.db
      .prepare(
        "SELECT result_json FROM research_outcome_tasks WHERE target='1.3' AND status='DONE'"
      )
      .get() as { result_json: string };
    assert.equal((JSON.parse(row.result_json) as { outcome: string }).outcome, 'TP');
  } finally {
    storage.close();
  }
});

void test('missing preparation persists no virtual confirmation, sends no requests and cannot overwrite a valid confirmation', async () => {
  const { storage } = await captureFixture();
  try {
    const m = new MeasurementStore(storage),
      clock = { now: () => epoch, random: () => 0.5, sleep: () => Promise.resolve() };
    const sampler = new BaselineSampler(m, clock);
    const capture = {
      market: () => Promise.reject(new Error('unexpected')),
      quote: () => Promise.reject(new Error('unexpected'))
    };
    const result = await sampler.sample(
      {
        runId: 'run',
        opportunityId: 'op',
        token,
        poolRevision: pool,
        preparationComplete: false,
        confirmation: { kind: 'SIMULATED', preparedAtMs: epoch }
      },
      capture
    );
    assert.equal(result.confirmationAtMs, null);
    assert.deepEqual(
      storage.db
        .prepare('SELECT DISTINCT confirmation_at_ms,reason FROM evaluation_baselines')
        .all(),
      [{ confirmation_at_ms: null, reason: 'MISSING_PREPARATION' }]
    );
    await assert.rejects(
      m.begin({
        runId: 'run',
        opportunityId: 'op',
        track: 'post_confirmation_market_v1',
        confirmationAtMs: epoch + 1000,
        confirmationKind: 'SIMULATED'
      }),
      /CONFIRMATION_CHANGED/
    );
  } finally {
    storage.close();
  }
});

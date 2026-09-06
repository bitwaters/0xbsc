import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { evaluateAndStoreOutcome, evaluateOutcome } from '../../src/evaluation/outcomes.js';
import { Storage } from '../../src/storage/database.js';
import { outcomeFixtures } from './fixtures.js';

void test('keeps market and executable returns separate', () => {
  const outcome = evaluateOutcome(
    '100',
    '120',
    '10',
    '9',
    [{ high: '125', low: '95', close: '120' }],
    '0.3',
    '-0.1'
  );
  assert.equal(outcome.marketReturn?.toString(), '0.2');
  assert.equal(outcome.executableReturn?.toString(), '-0.1');
  assert.equal(outcome.mfe?.toString(), '0.25');
  assert.equal(outcome.mae?.toString(), '-0.05');
});

void test('marks same-candle TP and SL as ambiguous', () => {
  const outcome = evaluateOutcome(
    '100',
    null,
    null,
    null,
    [{ high: '120', low: '80', close: '100' }],
    '0.1',
    '-0.1'
  );
  assert.equal(outcome.tpSl, 'ambiguous_same_candle');
  assert.equal(outcome.executableReturn, null);
});

void test('stores distinct market and executable results with same-candle ambiguity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-outcome-store-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  try {
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg', '{}', 1);
    storage.db
      .prepare(
        "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', '0xoutcome', 1, 1)"
      )
      .run();
    storage.db
      .prepare(
        "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES ('ep-outcome', 'bsc', '0xoutcome', 'revival', 'SENT', 'cfg', 1, 1)"
      )
      .run();
    storage.db
      .prepare(
        "INSERT INTO signals (id, episode_id, config_revision_id, delivery_state, quote_snapshot_json, decision_json, created_at_ms, updated_at_ms) VALUES ('sig-outcome', 'ep-outcome', 'cfg', 'SENT', '{}', '{}', 1, 1)"
      )
      .run();
    await storage.scheduleResultTasks({
      episodeId: 'ep-outcome',
      signalId: 'sig-outcome',
      score: 80,
      hardSafetyPassed: true,
      formal: true,
      narrative: false,
      fromMs: 1,
      checkpointsMinutes: [1],
      narrativeCheckpointsMinutes: []
    });
    await evaluateAndStoreOutcome(storage, {
      taskId: 1,
      episodeId: 'ep-outcome',
      signalId: 'sig-outcome',
      checkpointMinutes: 1,
      entryMarketPrice: '100',
      exitMarketPrice: '120',
      entryExecutableUsd: '10',
      exitExecutableUsd: '9',
      candles: [{ high: '120', low: '80', close: '100' }],
      takeProfit: '0.1',
      stopLoss: '-0.1',
      nowMs: 2
    });
    const row = storage.db.prepare('SELECT data_json AS data FROM price_samples').get() as {
      data: string;
    };
    assert.match(row.data, /"marketReturn":"0.2"/);
    assert.match(row.data, /"executableReturn":"-0.1"/);
    assert.match(row.data, /"tpSl":"ambiguous_same_candle"/);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('has deterministic profit, loss, rug/no-exit and ambiguous outcome fixtures', () => {
  for (const fixture of outcomeFixtures) {
    const outcome = evaluateOutcome(
      fixture.entryMarketPrice,
      fixture.exitMarketPrice,
      fixture.entryExecutableUsd,
      fixture.exitExecutableUsd,
      fixture.candles,
      fixture.takeProfit,
      fixture.stopLoss
    );
    assert.equal(
      outcome.marketReturn?.toString() ?? null,
      fixture.expected.marketReturn,
      fixture.name
    );
    assert.equal(
      outcome.executableReturn?.toString() ?? null,
      fixture.expected.executableReturn,
      fixture.name
    );
    assert.equal(outcome.tpSl, fixture.expected.tpSl, fixture.name);
  }
});

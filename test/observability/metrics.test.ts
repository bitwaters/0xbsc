import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apiMetricEndpoint, MetricsCollector } from '../../src/observability/metrics.js';
import { Storage } from '../../src/storage/database.js';

void test('combines runtime and durable health metrics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-metrics-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  try {
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg', '{}', 1);
    storage.db
      .prepare(
        "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', '0xmetrics', 1, 1)"
      )
      .run();
    storage.db
      .prepare(
        "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES ('ep-metrics', 'bsc', '0xmetrics', 'revival', 'OBSERVING', 'cfg', 1, 1)"
      )
      .run();
    storage.db
      .prepare(
        "INSERT INTO signals (id, episode_id, config_revision_id, delivery_state, quote_snapshot_json, decision_json, created_at_ms, updated_at_ms) VALUES ('sig-metrics', 'ep-metrics', 'cfg', 'DELIVERY_UNKNOWN', '{}', '{}', 1, 1)"
      )
      .run();
    storage.db
      .prepare(
        "INSERT INTO price_samples (episode_id, signal_id, task_kind, due_at_ms, created_at_ms, updated_at_ms) VALUES ('ep-metrics', 'sig-metrics', 'outcome_1m', 1, 1, 1)"
      )
      .run();
    const metrics = new MetricsCollector();
    metrics.increment('discovered', 4);
    metrics.increment('deduplicated', 1);
    metrics.increment('deepAnalyses', 2);
    metrics.increment('safetyRejected', 5);
    metrics.increment('staleCandidates', 3);
    metrics.increment('quoteRejections', 4);
    assert.deepEqual(await metrics.snapshot(storage, 1), {
      discovered: 4,
      deduplicated: 1,
      deepAnalyses: 2,
      safetyRejected: 5,
      staleCandidates: 3,
      quoteRejections: 4,
      activeEpisodes: 1,
      signals: 1,
      deliveryFailures: 0,
      preSendCancellations: 0,
      preparationFailures: 0,
      deliveryUnknown: 1,
      dueTaskBacklog: 1,
      deduplicationRate: 0.25
    });
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('maps every weighted GMGN path to its configured observability endpoint', () => {
  assert.deepEqual(
    [
      '/v1/market/rank',
      '/v1/market/hot_searches',
      '/v1/user/smartmoney',
      '/v1/market/token_top_holders',
      '/v1/market/token_top_traders'
    ].map(apiMetricEndpoint),
    ['trending', 'hot', 'smart_money', 'holders', 'traders']
  );
});

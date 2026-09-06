import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { preserveUnsentEvaluationContext } from '../../src/evaluation/unsent.js';
import { Storage } from '../../src/storage/database.js';

void test('preserves unsent false-negative context without backfilling a Telegram signal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-unsent-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  try {
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg', '{}', 1);
    storage.db
      .prepare(
        "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', '0xunsent', 1, 1)"
      )
      .run();
    storage.db
      .prepare(
        "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES ('ep-unsent', 'bsc', '0xunsent', 'revival', 'EXPIRED', 'cfg', 1, 1)"
      )
      .run();
    storage.db
      .prepare(
        "UPDATE episodes SET feature_snapshot_json = '{\"score\":68}' WHERE id = 'ep-unsent'"
      )
      .run();
    assert.equal(
      await preserveUnsentEvaluationContext(storage, {
        episodeId: 'ep-unsent',
        rejectionReason: 'quote_cost',
        featureSnapshot: { score: 72 },
        configRevisionId: 'cfg',
        nowMs: 2
      }),
      true
    );
    const preserved = storage.db
      .prepare(
        'SELECT rejection_reason AS reason, feature_snapshot_json AS feature, config_revision_id AS revision FROM episodes'
      )
      .get() as { reason: string; feature: string; revision: string };
    assert.equal(preserved.reason, 'quote_cost');
    assert.equal(preserved.revision, 'cfg');
    assert.deepEqual(JSON.parse(preserved.feature), {
      score: 72,
      initial_decision: { score: 68 },
      latest_decision: { score: 72 }
    });
    await preserveUnsentEvaluationContext(storage, {
      episodeId: 'ep-unsent',
      rejectionReason: 'still_unsent',
      featureSnapshot: { score: 75 },
      configRevisionId: 'cfg',
      nowMs: 3
    });
    const updated = JSON.parse(
      (
        storage.db
          .prepare("SELECT feature_snapshot_json AS feature FROM episodes WHERE id = 'ep-unsent'")
          .get() as { feature: string }
      ).feature
    ) as Record<string, unknown>;
    assert.deepEqual(updated.initial_decision, { score: 68 });
    assert.deepEqual(updated.latest_decision, { score: 75 });
    await storage.scheduleResultTasks({
      episodeId: 'ep-unsent',
      signalId: null,
      score: 72,
      hardSafetyPassed: true,
      formal: false,
      narrative: false,
      fromMs: 2,
      checkpointsMinutes: [1],
      narrativeCheckpointsMinutes: []
    });
    await storage.recordOutcomeCheckpoint({
      taskId: 1,
      episodeId: 'ep-unsent',
      signalId: null,
      checkpointMinutes: 1,
      requestedAtMs: 60_002,
      completedAtMs: 60_003,
      data: { candles: [{ close: '2' }] }
    });
    await storage.attachOutcomeEvaluation({
      taskId: 1,
      episodeId: 'ep-unsent',
      signalId: null,
      checkpointMinutes: 1,
      outcome: { marketReturn: '1', executableReturn: null },
      nowMs: 60_004
    });
    assert.match(
      (
        storage.db
          .prepare("SELECT data_json AS data FROM price_samples WHERE task_kind = 'outcome_1m'")
          .get() as { data: string }
      ).data,
      /"marketReturn":"1"/
    );
    assert.deepEqual(storage.db.prepare('SELECT COUNT(*) AS count FROM signals').get(), {
      count: 0
    });
    storage.db
      .prepare(
        "INSERT INTO signals (id, episode_id, config_revision_id, delivery_state, quote_snapshot_json, decision_json, created_at_ms, updated_at_ms) VALUES ('sig-unsent', 'ep-unsent', 'cfg', 'SENT', '{}', '{}', 3, 3)"
      )
      .run();
    assert.equal(
      await preserveUnsentEvaluationContext(storage, {
        episodeId: 'ep-unsent',
        rejectionReason: 'later',
        featureSnapshot: {},
        configRevisionId: 'cfg',
        nowMs: 4
      }),
      false
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scheduleEvaluationTasks } from '../../src/evaluation/tasks.js';
import { Storage } from '../../src/storage/database.js';

void test('creates only durable formal and 65+ unsent result tasks without a second pool', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-evaluation-tasks-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  try {
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg', '{}', 1_000);
    for (const id of ['formal', 'unsent', 'low', 'unsafe']) {
      const token = `0x${id}`;
      storage.db
        .prepare(
          "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', ?, ?, ?)"
        )
        .run(token, 1_000, 1_000);
      storage.db
        .prepare(
          "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES (?, 'bsc', ?, 'revival', 'OBSERVING', 'cfg', ?, ?)"
        )
        .run(id, token, 1_000, 1_000);
    }
    const base = {
      hardSafetyPassed: true,
      narrative: false,
      fromMs: 1_000,
      checkpointsMinutes: [1, 5],
      narrativeCheckpointsMinutes: [120]
    };
    assert.equal(
      await scheduleEvaluationTasks(storage, {
        ...base,
        episodeId: 'formal',
        signalId: null,
        score: 80,
        formal: true
      }),
      2
    );
    assert.equal(
      await scheduleEvaluationTasks(storage, {
        ...base,
        episodeId: 'unsent',
        signalId: null,
        score: 65,
        formal: false
      }),
      2
    );
    assert.equal(
      await scheduleEvaluationTasks(storage, {
        ...base,
        episodeId: 'low',
        signalId: null,
        score: 64,
        formal: false
      }),
      0
    );
    storage.db
      .prepare("UPDATE episodes SET feature_snapshot_json = ? WHERE id = 'formal'")
      .run(JSON.stringify({ features: { priceUsd: '1.25' } }));
    storage.db
      .prepare(
        "INSERT INTO signals (id, episode_id, config_revision_id, delivery_state, quote_snapshot_json, decision_json, created_at_ms, updated_at_ms) VALUES ('sig-upgrade', 'unsent', 'cfg', 'SENT', '{}', '{}', 3, 3)"
      )
      .run();
    assert.equal(
      await scheduleEvaluationTasks(storage, {
        ...base,
        episodeId: 'unsent',
        signalId: 'sig-upgrade',
        score: 80,
        formal: true,
        fromMs: 5_000
      }),
      2
    );
    assert.deepEqual(
      storage.db
        .prepare(
          "SELECT signal_id AS signalId, task_kind AS taskKind, due_at_ms AS dueAtMs FROM price_samples WHERE episode_id = 'unsent' ORDER BY due_at_ms"
        )
        .all(),
      [
        { signalId: null, taskKind: 'outcome_1m', dueAtMs: 61_000 },
        { signalId: 'sig-upgrade', taskKind: 'outcome_1m', dueAtMs: 65_000 },
        { signalId: null, taskKind: 'outcome_5m', dueAtMs: 301_000 },
        { signalId: 'sig-upgrade', taskKind: 'outcome_5m', dueAtMs: 305_000 }
      ]
    );
    assert.equal(
      await scheduleEvaluationTasks(storage, {
        ...base,
        episodeId: 'unsafe',
        signalId: null,
        score: 90,
        formal: true,
        hardSafetyPassed: false
      }),
      0
    );
    assert.deepEqual(
      storage.db
        .prepare(
          'SELECT episode_id AS episodeId, COUNT(*) AS count FROM price_samples GROUP BY episode_id ORDER BY episode_id'
        )
        .all(),
      [
        { episodeId: 'formal', count: 2 },
        { episodeId: 'unsent', count: 4 }
      ]
    );
    const due = await storage.dueOutcomeTasks(61_000);
    assert.equal(due.length, 2);
    assert.equal(
      due[0]?.entryMarketPrice,
      null,
      'later feature snapshots cannot invent the original price'
    );
    assert.equal(due[0]?.entryAtMs, 1_000);
    assert.equal(due[0]?.targetAtMs, 61_000);
    assert.equal(
      await scheduleEvaluationTasks(storage, {
        ...base,
        episodeId: 'unsent',
        signalId: null,
        score: 65,
        formal: false,
        fromMs: 2_000
      }),
      0
    );
    assert.deepEqual(
      storage.db
        .prepare(
          "SELECT signal_id AS signalId, task_kind AS taskKind, due_at_ms AS dueAtMs FROM price_samples WHERE episode_id = 'unsent' ORDER BY due_at_ms"
        )
        .all(),
      [
        { signalId: null, taskKind: 'outcome_1m', dueAtMs: 61_000 },
        { signalId: 'sig-upgrade', taskKind: 'outcome_1m', dueAtMs: 65_000 },
        { signalId: null, taskKind: 'outcome_5m', dueAtMs: 301_000 },
        { signalId: 'sig-upgrade', taskKind: 'outcome_5m', dueAtMs: 305_000 }
      ]
    );
    assert.equal(
      await scheduleEvaluationTasks(storage, {
        ...base,
        episodeId: 'unsent',
        signalId: null,
        score: 65,
        formal: false,
        narrative: true,
        checkpointsMinutes: [120],
        narrativeCheckpointsMinutes: [240],
        maxUnsentTrackingMinutes: 60
      }),
      0
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

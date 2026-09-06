import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Decimal } from 'decimal.js';
import Database from 'better-sqlite3';
import { serializeJson, Storage } from '../../src/storage/database.js';
import {
  KeyedSerialExecutor,
  SnapshotDeduplicator,
  normalizeEvent
} from '../../src/discovery/events.js';
import { canContributeToDecision } from '../../src/gmgn/signal-mapping.js';

async function withStorage(run: (storage: Storage) => void | Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-storage-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  try {
    await run(storage);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
}

void test('migrates WAL database and enforces event, Episode and signal uniqueness', async () => {
  await withStorage((storage) => {
    const now = Date.now();
    const insertToken = storage.db.prepare(
      "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', ?, ?, ?)"
    );
    insertToken.run('0x1', now, now);
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg', '{}', now);
    storage.db
      .prepare(
        "INSERT INTO events (event_key, chain, token_address, source, observed_at_ms, evidence_family, strength, expires_at_ms, normalized_json) VALUES (?, 'bsc', '0x1', 'signal', ?, 'capital', 'strong', ?, '{}')"
      )
      .run('event-1', now, now + 1);
    assert.throws(() =>
      storage.db
        .prepare(
          "INSERT INTO events (event_key, chain, token_address, source, observed_at_ms, evidence_family, strength, expires_at_ms, normalized_json) VALUES (?, 'bsc', '0x1', 'signal', ?, 'capital', 'strong', ?, '{}')"
        )
        .run('event-1', now, now + 1)
    );
    storage.db
      .prepare(
        "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES ('ep-1', 'bsc', '0x1', 'new_launch', 'OBSERVING', 'cfg', ?, ?)"
      )
      .run(now, now);
    assert.throws(() =>
      storage.db
        .prepare(
          "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES ('ep-2', 'bsc', '0x1', 'new_launch', 'OBSERVING', 'cfg', ?, ?)"
        )
        .run(now, now)
    );
    storage.db
      .prepare(
        "INSERT INTO signals (id, episode_id, config_revision_id, delivery_state, quote_snapshot_json, decision_json, created_at_ms, updated_at_ms) VALUES ('sig-1', 'ep-1', 'cfg', 'PENDING', '{}', '{}', ?, ?)"
      )
      .run(now, now);
    assert.throws(() =>
      storage.db
        .prepare(
          "INSERT INTO signals (id, episode_id, config_revision_id, delivery_state, quote_snapshot_json, decision_json, created_at_ms, updated_at_ms) VALUES ('sig-2', 'ep-1', 'cfg', 'PENDING', '{}', '{}', ?, ?)"
        )
        .run(now, now)
    );
    const journalMode = storage.db.pragma('journal_mode', { simple: true }) as string;
    assert.equal(journalMode, 'wal');
  });
});

void test('stores an idempotent secret-free configuration revision', async () => {
  await withStorage(async (storage) => {
    await storage.recordConfigRevision('cfg-runtime', { gmgn: { api_key: '[REDACTED]' } }, 100);
    await storage.recordConfigRevision('cfg-runtime', { changed: true }, 200);
    assert.deepEqual(
      storage.db
        .prepare(
          'SELECT revision_id AS id, sanitized_snapshot_json AS snapshot, created_at_ms AS createdAtMs FROM config_revisions'
        )
        .all(),
      [{ id: 'cfg-runtime', snapshot: '{"gmgn":{"api_key":"[REDACTED]"}}', createdAtMs: 100 }]
    );
  });
});

void test('recovers the serialized write queue after an injected SQLite writer lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-storage-lock-'));
  const path = join(directory, 'signal.db');
  const storage = await Storage.open(path);
  const locker = new Database(path);
  try {
    storage.db.pragma('busy_timeout = 1');
    locker.exec('BEGIN IMMEDIATE');
    await assert.rejects(storage.recordConfigRevision('locked', '{}', 1), /database is locked/);
    locker.exec('COMMIT');
    await storage.recordConfigRevision('recovered', '{}', 2);
    assert.deepEqual(
      storage.db
        .prepare(
          'SELECT revision_id AS revisionId, created_at_ms AS createdAtMs FROM config_revisions WHERE revision_id = ?'
        )
        .get('recovered'),
      { revisionId: 'recovered', createdAtMs: 2 }
    );
  } finally {
    try {
      locker.exec('ROLLBACK');
    } catch {
      // The successful path has already committed the lock transaction.
    }
    locker.close();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('serializes writes and restores durable active work', async () => {
  await withStorage(async (storage) => {
    const now = 1000;
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        storage.write(() =>
          storage.db
            .prepare(
              'INSERT INTO api_stats (endpoint, minute_at_ms, request_count, weight_sum, success_count, error_count) VALUES (?, ?, 1, 1, 1, 0)'
            )
            .run(`endpoint-${index}`, now)
        )
      )
    );
    assert.equal(
      (storage.db.prepare('SELECT COUNT(*) AS count FROM api_stats').get() as { count: number })
        .count,
      20
    );
    storage.db
      .prepare(
        "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', '0x2', ?, ?)"
      )
      .run(now, now);
    storage.db
      .prepare('INSERT INTO config_revisions VALUES (?, ?, ?)')
      .run('cfg-recover', '{}', now);
    storage.db
      .prepare(
        "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, next_evaluation_at_ms, created_at_ms, updated_at_ms) VALUES ('ep-recover', 'bsc', '0x2', 'revival', 'OBSERVING', 'cfg-recover', ?, ?, ?)"
      )
      .run(now + 10, now, now);
    storage.db
      .prepare(
        "INSERT INTO signals (id, episode_id, config_revision_id, delivery_state, quote_snapshot_json, decision_json, created_at_ms, updated_at_ms) VALUES ('sig-recover', 'ep-recover', 'cfg-recover', 'PENDING', '{}', '{}', ?, ?)"
      )
      .run(now, now);
    storage.db
      .prepare(
        "INSERT INTO price_samples (episode_id, signal_id, task_kind, due_at_ms, created_at_ms, updated_at_ms) VALUES ('ep-recover', 'sig-recover', 'outcome_1m', ?, ?, ?)"
      )
      .run(now, now, now);
    storage.db
      .prepare(
        "INSERT INTO events (event_key, chain, token_address, source, poll_key, snapshot_hash, snapshot_sequence, observed_at_ms, evidence_family, strength, expires_at_ms, normalized_json) VALUES ('snap-recover', 'bsc', '0x2', 'trending', 'trending:1m', 'hash-a', 7, ?, 'attention', 'weak', ?, '{}')"
      )
      .run(now, now + 1);
    storage.db
      .prepare(
        "INSERT INTO events (event_key, chain, token_address, source, poll_key, snapshot_hash, snapshot_sequence, observed_at_ms, evidence_family, strength, expires_at_ms, normalized_json) VALUES ('snap-recover-new', 'bsc', '0x2', 'trending', 'trending:1m', 'hash-b', 8, ?, 'attention', 'weak', ?, '{}')"
      )
      .run(now + 1, now + 2);
    const recovered = await storage.recover(now);
    assert.deepEqual(recovered.activeEpisodes, [
      {
        id: 'ep-recover',
        chain: 'bsc',
        tokenAddress: '0x2',
        route: 'revival',
        state: 'OBSERVING',
        nextEvaluationAtMs: now + 10
      }
    ]);
    assert.deepEqual(recovered.pendingOutbox, [
      { id: 'sig-recover', episodeId: 'ep-recover', deliveryState: 'PENDING', retryCount: 0 }
    ]);
    assert.deepEqual(recovered.dueResultTasks, [
      {
        id: 1,
        episodeId: 'ep-recover',
        signalId: 'sig-recover',
        taskKind: 'outcome_1m',
        dueAtMs: now
      }
    ]);
    assert.deepEqual(recovered.snapshots, [
      {
        source: 'trending',
        pollKey: 'trending:1m',
        tokenAddress: '0x2',
        snapshotHash: 'hash-b',
        snapshotSequence: 8,
        expiresAtMs: now + 2
      }
    ]);
  });
});

void test('claims one active route Episode and permanently limits successful new-launch signals', async () => {
  await withStorage(async (storage) => {
    const now = 1_000;
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg-claim', '{}', now);
    const base = { tokenAddress: '0xClaim', configRevisionId: 'cfg-claim', nowMs: now };
    const claims = await Promise.all([
      storage.claimEpisode({ ...base, id: 'claim-1', route: 'revival' }),
      storage.claimEpisode({ ...base, id: 'claim-2', route: 'revival' })
    ]);
    assert.deepEqual(claims.sort(), ['already_active', 'created']);
    storage.db
      .prepare("UPDATE episodes SET state = 'SENT', ended_at_ms = ? WHERE id = 'claim-1'")
      .run(now + 1);
    assert.equal(
      await storage.claimEpisode({ ...base, id: 'new-launch-1', route: 'new_launch' }),
      'created'
    );
    storage.db
      .prepare("UPDATE episodes SET state = 'SENT', ended_at_ms = ? WHERE id = 'new-launch-1'")
      .run(now + 2);
    assert.equal(
      await storage.claimEpisode({ ...base, id: 'new-launch-2', route: 'new_launch' }),
      'new_launch_already_sent'
    );
  });
});

void test('requires a fresh decisive trigger and route reset before terminal Episode re-entry', async () => {
  await withStorage(async (storage) => {
    const now = 10_000;
    storage.db
      .prepare('INSERT INTO config_revisions VALUES (?, ?, ?)')
      .run('cfg-reentry', '{}', now);
    await storage.claimEpisode({
      id: 'reentry-first',
      tokenAddress: '0xreentry',
      route: 'revival',
      configRevisionId: 'cfg-reentry',
      nowMs: now
    });
    storage.db
      .prepare("UPDATE episodes SET state = 'REJECTED', ended_at_ms = ? WHERE id = ?")
      .run(now + 100, 'reentry-first');
    const input = {
      tokenAddress: '0xreentry',
      route: 'revival' as const,
      configRevisionId: 'cfg-reentry',
      nowMs: now + 200,
      decisiveWindowMs: 1_000,
      resetSatisfied: true
    };
    assert.equal(
      await storage.claimEpisode({ ...input, id: 'reentry-stale', triggerAtMs: now + 100 }),
      'reentry_not_allowed'
    );
    assert.equal(
      await storage.claimEpisode({
        ...input,
        id: 'reentry-no-reset',
        triggerAtMs: now + 150,
        resetSatisfied: false
      }),
      'reentry_not_allowed'
    );
    assert.equal(
      await storage.claimEpisode({ ...input, id: 'reentry-fresh', triggerAtMs: now + 150 }),
      'created'
    );
  });
});

void test('debounces repeated terminal safety rejection until its source TTL expires', async () => {
  await withStorage(async (storage) => {
    const now = 10_000;
    storage.db
      .prepare('INSERT INTO config_revisions VALUES (?, ?, ?)')
      .run('cfg-cooldown', '{}', now);
    await storage.claimEpisode({
      id: 'cooldown-first',
      tokenAddress: '0xcooldown',
      route: 'revival',
      configRevisionId: 'cfg-cooldown',
      nowMs: now
    });
    storage.db
      .prepare(
        "UPDATE episodes SET state = 'REJECTED', rejection_reason = ?, ended_at_ms = ? WHERE id = ?"
      )
      .run('coordinated_smart_money_exit_unverified', now + 100, 'cooldown-first');
    const input = {
      tokenAddress: '0xcooldown',
      route: 'revival' as const,
      configRevisionId: 'cfg-cooldown',
      triggerAtMs: now + 150,
      decisiveWindowMs: 1_000,
      resetSatisfied: true,
      reentryCooldownMsByReason: { coordinated_smart_money_exit_unverified: 500 }
    };
    assert.equal(
      await storage.claimEpisode({ ...input, id: 'cooldown-blocked', nowMs: now + 200 }),
      'reentry_not_allowed'
    );
    assert.equal(
      await storage.claimEpisode({ ...input, id: 'cooldown-open', nowMs: now + 650 }),
      'created'
    );
  });
});

void test('moves a newly claimed Episode into observation exactly once', async () => {
  await withStorage(async (storage) => {
    const now = 10;
    storage.db
      .prepare('INSERT INTO config_revisions VALUES (?, ?, ?)')
      .run('cfg-observe', '{}', now);
    assert.equal(
      await storage.claimEpisode({
        id: 'observe-1',
        tokenAddress: '0xobserve',
        route: 'revival',
        configRevisionId: 'cfg-observe',
        nowMs: now
      }),
      'created'
    );
    assert.equal(await storage.beginObservation('observe-1', now + 1), true);
    assert.equal(await storage.beginObservation('observe-1', now + 2), false);
    assert.equal(
      (
        storage.db.prepare('SELECT state FROM episodes WHERE id = ?').get('observe-1') as {
          state: string;
        }
      ).state,
      'OBSERVING'
    );
  });
});

void test('persists first low score and expires only after the second consecutive observation failure', async () => {
  await withStorage(async (storage) => {
    const now = 10;
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg-low', '{}', now);
    await storage.claimEpisode({
      id: 'low-1',
      tokenAddress: '0xlow',
      route: 'revival',
      configRevisionId: 'cfg-low',
      nowMs: now
    });
    await storage.beginObservation('low-1', now + 1);
    const low = (time: number) =>
      storage.recordEpisodeDecision({
        episodeId: 'low-1',
        decision: 'rejected',
        score: 64,
        completeness: 1,
        decisiveTriggerAtMs: null,
        featureSnapshot: {},
        nowMs: time
      });
    assert.equal(await low(now + 2), true);
    assert.equal(await storage.rescheduleObservation('low-1', now + 30_000, now + 2), true);
    assert.deepEqual(
      storage.db
        .prepare(
          'SELECT state, low_score_checks AS lowScoreChecks, next_evaluation_at_ms AS nextEvaluationAtMs, ended_at_ms AS endedAtMs FROM episodes WHERE id = ?'
        )
        .get('low-1'),
      { state: 'OBSERVING', lowScoreChecks: 1, nextEvaluationAtMs: now + 30_000, endedAtMs: null }
    );
    assert.equal(await low(now + 3), true);
    assert.deepEqual(
      storage.db
        .prepare(
          'SELECT state, low_score_checks AS lowScoreChecks, ended_at_ms AS endedAtMs FROM episodes WHERE id = ?'
        )
        .get('low-1'),
      { state: 'EXPIRED', lowScoreChecks: 2, endedAtMs: now + 3 }
    );
  });
});

void test('enforces durable observation capacity and preserves demoted Episode history', async () => {
  await withStorage(async (storage) => {
    const now = 20;
    storage.db
      .prepare('INSERT INTO config_revisions VALUES (?, ?, ?)')
      .run('cfg-capacity', '{}', now);
    const claim = async (id: string, token: string, score: number) => {
      await storage.claimEpisode({
        id,
        tokenAddress: token,
        route: 'revival',
        configRevisionId: 'cfg-capacity',
        nowMs: now
      });
      return storage.admitObservation({
        episodeId: id,
        route: 'revival',
        score,
        completeness: 0.8,
        evidenceFreshness: 1,
        capacity: 2,
        softRouteTarget: 1,
        nextEvaluationAtMs: now + score + 30_000,
        expiresAtMs: now + 60_000,
        nowMs: now + score
      });
    };
    assert.deepEqual(await claim('capacity-low', '0xcapacity1', 65), { admitted: true });
    assert.deepEqual(await claim('capacity-high', '0xcapacity2', 75), { admitted: true });
    assert.deepEqual(await claim('capacity-weaker', '0xcapacity3', 64), { admitted: false });
    assert.deepEqual(await claim('capacity-best', '0xcapacity4', 85), {
      admitted: true,
      demotedId: 'capacity-low'
    });
    assert.deepEqual(
      storage.db
        .prepare('SELECT state, rejection_reason AS reason FROM episodes WHERE id = ?')
        .get('capacity-low'),
      { state: 'EXPIRED', reason: 'observation_capacity_demoted' }
    );
    assert.equal(
      (
        storage.db
          .prepare(
            "SELECT COUNT(*) AS count FROM episodes WHERE state = 'OBSERVING' AND ended_at_ms IS NULL"
          )
          .get() as { count: number }
      ).count,
      2
    );
  });
});

void test('restores the latest persisted event for a due observation after restart-safe scheduling', async () => {
  await withStorage(async (storage) => {
    const now = 100;
    await storage.persistDiscoveryEvent(
      normalizeEvent({
        chain: 'bsc',
        tokenAddress: '0xdue',
        source: 'signal',
        sourceEventId: 'due',
        sourceEventAtMs: now,
        observedAtMs: now,
        evidenceFamily: 'capital',
        strength: 'strong',
        expiresAtMs: now + 60_000,
        rawPayloadRef: 'sha256:due',
        payload: { amount: 1 }
      })
    );
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg-due', '{}', now);
    await storage.claimEpisode({
      id: 'due-1',
      tokenAddress: '0xdue',
      route: 'revival',
      configRevisionId: 'cfg-due',
      nowMs: now
    });
    await storage.admitObservation({
      episodeId: 'due-1',
      route: 'revival',
      score: 70,
      completeness: 0.8,
      evidenceFreshness: 1,
      capacity: 60,
      softRouteTarget: 20,
      nextEvaluationAtMs: now + 10,
      expiresAtMs: now + 60_000,
      nowMs: now
    });
    const due = await storage.dueObservationEvents(now + 10);
    assert.equal(due.length, 1);
    assert.deepEqual(due[0]?.payload, { amount: 1 });
    assert.equal(due[0]?.tokenAddress, '0xdue');
    assert.equal(due[0]?.episodeId, 'due-1');
    assert.equal(due[0]?.observationScore, null);
  });
});

void test('expires observations durably once their route deadline passes', async () => {
  await withStorage(async (storage) => {
    const now = 100;
    storage.db
      .prepare('INSERT INTO config_revisions VALUES (?, ?, ?)')
      .run('cfg-expiry', '{}', now);
    await storage.claimEpisode({
      id: 'expiry-1',
      tokenAddress: '0xexpiry',
      route: 'new_launch',
      configRevisionId: 'cfg-expiry',
      nowMs: now
    });
    await storage.admitObservation({
      episodeId: 'expiry-1',
      route: 'new_launch',
      score: 70,
      completeness: 0.8,
      evidenceFreshness: 1,
      capacity: 60,
      softRouteTarget: 20,
      nextEvaluationAtMs: now + 1,
      expiresAtMs: now + 10,
      nowMs: now
    });
    assert.equal(await storage.expireObservations(now + 9), 0);
    assert.equal(await storage.expireObservations(now + 10), 1);
    assert.deepEqual(
      storage.db
        .prepare('SELECT state, rejection_reason AS reason FROM episodes WHERE id = ?')
        .get('expiry-1'),
      { state: 'EXPIRED', reason: 'observation_expired' }
    );
  });
});

void test('expires one due observation immediately when its evidence is gone', async () => {
  await withStorage(async (storage) => {
    const now = 100;
    storage.db
      .prepare('INSERT INTO config_revisions VALUES (?, ?, ?)')
      .run('cfg-evidence-expiry', '{}', now);
    await storage.claimEpisode({
      id: 'evidence-expiry-1',
      tokenAddress: '0xevidence-expiry',
      route: 'continuation',
      configRevisionId: 'cfg-evidence-expiry',
      nowMs: now
    });
    await storage.admitObservation({
      episodeId: 'evidence-expiry-1',
      route: 'continuation',
      score: 70,
      completeness: 1,
      evidenceFreshness: 2,
      capacity: 60,
      softRouteTarget: 20,
      nextEvaluationAtMs: now + 1,
      expiresAtMs: now + 60_000,
      nowMs: now
    });
    assert.equal(
      await storage.expireObservation('evidence-expiry-1', 'evidence_expired', now + 1),
      true
    );
    assert.deepEqual(
      storage.db
        .prepare(
          'SELECT state, rejection_reason AS reason, next_evaluation_at_ms AS nextAt FROM episodes WHERE id = ?'
        )
        .get('evidence-expiry-1'),
      { state: 'EXPIRED', reason: 'evidence_expired', nextAt: null }
    );
  });
});

void test('restores only unexpired persisted evidence for decision recovery', async () => {
  await withStorage(async (storage) => {
    const event = (key: string, expiresAtMs: number) =>
      normalizeEvent({
        chain: 'bsc',
        tokenAddress: '0xevidence',
        source: 'signal',
        sourceEventId: key,
        observedAtMs: 10,
        sourceEventAtMs: 10,
        evidenceFamily: 'capital',
        strength: 'strong',
        expiresAtMs,
        rawPayloadRef: 'sha256:test',
        payload: { key }
      });
    await storage.persistDiscoveryEvent(event('fresh', 100));
    await storage.persistDiscoveryEvent(event('expired', 20));
    const restored = await storage.activeEvidenceEvents(50);
    assert.deepEqual(
      restored.map((item) => item.key),
      ['signal:fresh:0xevidence']
    );
  });
});

void test('serializes same-token database ingestion while allowing separate-token work to overlap', async () => {
  await withStorage(async (storage) => {
    const executor = new KeyedSerialExecutor();
    const entered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const event = (tokenAddress: string, sourceEventId: string) =>
      normalizeEvent({
        chain: 'bsc',
        tokenAddress,
        source: 'signal',
        sourceEventId,
        observedAtMs: 1,
        sourceEventAtMs: 1,
        evidenceFamily: 'capital',
        strength: 'weak',
        expiresAtMs: 2,
        rawPayloadRef: 'redacted:event',
        payload: { sourceEventId }
      });
    const first = executor.enqueue('0xa', async () => {
      entered.push('a-first');
      await gate;
      return storage.persistDiscoveryEvent(event('0xa', 'same'));
    });
    const duplicate = executor.enqueue('0xa', () =>
      storage.persistDiscoveryEvent(event('0xa', 'same'))
    );
    const parallel = executor.enqueue('0xb', async () => {
      entered.push('b');
      return storage.persistDiscoveryEvent(event('0xb', 'other'));
    });
    assert.equal(await parallel, true);
    assert.deepEqual(entered, ['a-first', 'b']);
    release();
    assert.deepEqual(await Promise.all([first, duplicate]), [true, false]);
  });
});

void test('atomically creates a pending Outbox signal and advances a ready Episode once', async () => {
  await withStorage(async (storage) => {
    const now = 1_000;
    storage.db
      .prepare('INSERT INTO config_revisions VALUES (?, ?, ?)')
      .run('cfg-outbox', '{}', now);
    storage.db
      .prepare(
        "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', '0xoutbox', ?, ?)"
      )
      .run(now, now);
    storage.db
      .prepare(
        "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES ('ep-outbox', 'bsc', '0xoutbox', 'continuation', 'READY', 'cfg-outbox', ?, ?)"
      )
      .run(now, now);
    const input = {
      signalId: 'sig-outbox',
      episodeId: 'ep-outbox',
      configRevisionId: 'cfg-outbox',
      quoteSnapshot: { tier: 10, cost: '0.01' },
      decision: { score: 80 },
      nowMs: now + 1
    };
    assert.equal(await storage.createSignalOutbox(input), 'created');
    assert.equal(await storage.createSignalOutbox(input), 'episode_not_ready');
    assert.deepEqual(
      storage.db.prepare('SELECT state FROM episodes WHERE id = ?').get('ep-outbox'),
      { state: 'DELIVERY_PENDING' }
    );
    assert.deepEqual(
      storage.db
        .prepare(
          'SELECT id, delivery_state AS deliveryState, quote_snapshot_json AS quoteSnapshot FROM signals'
        )
        .get(),
      { id: 'sig-outbox', deliveryState: 'PENDING', quoteSnapshot: '{"tier":10,"cost":"0.01"}' }
    );
    assert.deepEqual(
      storage.db
        .prepare('SELECT feature_snapshot_json AS snapshot FROM episodes WHERE id = ?')
        .get('ep-outbox'),
      { snapshot: '{"quote_gate":{"tier":10,"cost":"0.01"}}' }
    );
    storage.db
      .prepare(
        `INSERT INTO events (
          event_key, chain, token_address, source, observed_at_ms, evidence_family, strength,
          expires_at_ms, raw_payload_ref, normalized_json
        ) VALUES ('event-outbox', 'bsc', '0xoutbox', 'signal', ?, 'capital', 'strong', ?, 'ref', '{}')`
      )
      .run(now, now + 1_000);
    assert.equal((await storage.latestEventForSignal('sig-outbox'))?.key, 'event-outbox');
  });
});

void test('keeps a confirmed delivery terminal when a stale failure races afterward', async () => {
  await withStorage(async (storage) => {
    const now = 2_000;
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg-race', '{}', now);
    storage.db
      .prepare(
        "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', '0xrace', ?, ?)"
      )
      .run(now, now);
    storage.db
      .prepare(
        "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES ('ep-race', 'bsc', '0xrace', 'continuation', 'READY', 'cfg-race', ?, ?)"
      )
      .run(now, now);
    await storage.createSignalOutbox({
      signalId: 'sig-race',
      episodeId: 'ep-race',
      configRevisionId: 'cfg-race',
      quoteSnapshot: {},
      decision: {},
      nowMs: now + 1
    });
    assert.equal(
      await storage.confirmTelegramDelivery({
        signalId: 'sig-race',
        chatId: '-100',
        messageId: 9,
        nowMs: now + 2
      }),
      true
    );
    await storage.recordDeliveryFailure('sig-race', 'late failure', now + 3);
    assert.deepEqual(
      storage.db
        .prepare('SELECT state, ended_at_ms AS endedAtMs FROM episodes WHERE id = ?')
        .get('ep-race'),
      { state: 'SENT', endedAtMs: now + 2 }
    );
  });
});

void test('rolls back the Episode transition when an Outbox insert crashes', async () => {
  await withStorage(async (storage) => {
    const now = 1_000;
    storage.db
      .prepare('INSERT INTO config_revisions VALUES (?, ?, ?)')
      .run('cfg-rollback', '{}', now);
    for (const token of ['0xexisting', '0xrollback']) {
      storage.db
        .prepare(
          "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', ?, ?, ?)"
        )
        .run(token, now, now);
    }
    for (const [episodeId, token] of [
      ['ep-existing', '0xexisting'],
      ['ep-rollback', '0xrollback']
    ]) {
      storage.db
        .prepare(
          "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES (?, 'bsc', ?, 'continuation', 'READY', 'cfg-rollback', ?, ?)"
        )
        .run(episodeId, token, now, now);
    }
    assert.equal(
      await storage.createSignalOutbox({
        signalId: 'sig-conflict',
        episodeId: 'ep-existing',
        configRevisionId: 'cfg-rollback',
        quoteSnapshot: {},
        decision: {},
        nowMs: now
      }),
      'created'
    );
    await assert.rejects(
      storage.createSignalOutbox({
        signalId: 'sig-conflict',
        episodeId: 'ep-rollback',
        configRevisionId: 'cfg-rollback',
        quoteSnapshot: {},
        decision: {},
        nowMs: now + 1
      }),
      /UNIQUE constraint failed/
    );
    assert.deepEqual(
      storage.db.prepare('SELECT state FROM episodes WHERE id = ?').get('ep-rollback'),
      { state: 'READY' }
    );
    assert.deepEqual(
      storage.db
        .prepare('SELECT COUNT(*) AS count FROM signals WHERE episode_id = ?')
        .get('ep-rollback'),
      { count: 0 }
    );
  });
});

void test('preserves decimal and integer precision in JSON fields', () => {
  assert.equal(
    serializeJson({ amount: 900719925474099312345n, price: new Decimal('1.2300') }),
    '{"amount":"900719925474099312345","price":"1.23"}'
  );
  assert.throws(() => serializeJson(Infinity), /finite/);
});

void test('persists a discovery snapshot and deduplicates it after a SQLite restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-snapshot-restart-'));
  const path = join(directory, 'signal.db');
  const input = {
    chain: 'bsc' as const,
    tokenAddress: '0xSnapshot',
    source: 'trending' as const,
    sourceEventAtMs: null,
    observedAtMs: 100,
    evidenceFamily: 'attention' as const,
    strength: 'weak' as const,
    expiresAtMs: 200,
    rawPayloadRef: 'redacted:snapshot',
    payload: { rank: 4 },
    pollKey: 'trending:1m'
  };
  const first = await Storage.open(path);
  try {
    const deduplicator = new SnapshotDeduplicator();
    const event = await deduplicator.ingest(input, (candidate) =>
      first.persistDiscoveryEvent(candidate)
    );
    assert.equal(event?.snapshotSequence, 1);
  } finally {
    first.close();
  }
  const restarted = await Storage.open(path);
  try {
    const state = await restarted.recover(100);
    const deduplicator = new SnapshotDeduplicator(state.snapshots);
    assert.equal(
      await deduplicator.ingest(input, (candidate) => restarted.persistDiscoveryEvent(candidate)),
      null
    );
    const changed = await deduplicator.ingest({ ...input, payload: { rank: 3 } }, (candidate) =>
      restarted.persistDiscoveryEvent(candidate)
    );
    assert.equal(changed?.snapshotSequence, 2);
    const recoveredAfterChange = await restarted.recover(100);
    assert.deepEqual(recoveredAfterChange.snapshots, [
      {
        source: 'trending',
        pollKey: 'trending:1m',
        tokenAddress: '0xsnapshot',
        snapshotHash: changed?.snapshotHash,
        snapshotSequence: 2,
        expiresAtMs: changed?.expiresAtMs
      }
    ]);
    assert.equal(
      (restarted.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number })
        .count,
      2
    );
  } finally {
    restarted.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('retains an unknown Signal type for audit without allowing it to contribute to a decision', async () => {
  await withStorage(async (storage) => {
    const event = normalizeEvent({
      chain: 'bsc',
      tokenAddress: '0xUnknownSignal',
      source: 'signal',
      sourceEventId: 'gmgn-unknown-999',
      sourceEventAtMs: 100,
      observedAtMs: 101,
      evidenceFamily: 'attention',
      strength: 'weak',
      expiresAtMs: 200,
      rawPayloadRef: 'redacted:gmgn-signal',
      payload: { signal_type: 999, id: 'gmgn-unknown-999' }
    });
    assert.equal(await storage.persistDiscoveryEvent(event), true);
    const stored = storage.db
      .prepare('SELECT normalized_json AS payload FROM events WHERE event_key = ?')
      .get(event.key) as { payload: string };
    assert.deepEqual(JSON.parse(stored.payload), { signal_type: 999, id: 'gmgn-unknown-999' });
    assert.equal(canContributeToDecision(999), false);
  });
});

void test('recovers active Episode, Outbox and due work after a database restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-restart-'));
  const path = join(directory, 'signal.db');
  const now = 5000;
  const first = await Storage.open(path);
  try {
    first.db
      .prepare(
        "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', '0x3', ?, ?)"
      )
      .run(now, now);
    first.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg-restart', '{}', now);
    first.db
      .prepare(
        "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES ('ep-restart', 'bsc', '0x3', 'continuation', 'READY', 'cfg-restart', ?, ?)"
      )
      .run(now, now);
    first.db
      .prepare(
        "INSERT INTO signals (id, episode_id, config_revision_id, delivery_state, quote_snapshot_json, decision_json, created_at_ms, updated_at_ms) VALUES ('sig-restart', 'ep-restart', 'cfg-restart', 'DELIVERY_UNKNOWN', '{}', '{}', ?, ?)"
      )
      .run(now, now);
    first.db
      .prepare(
        "INSERT INTO price_samples (episode_id, signal_id, task_kind, due_at_ms, created_at_ms, updated_at_ms) VALUES ('ep-restart', 'sig-restart', 'outcome_5m', ?, ?, ?)"
      )
      .run(now, now, now);
  } finally {
    first.close();
  }
  const restarted = await Storage.open(path);
  try {
    const state = await restarted.recover(now);
    assert.equal(state.activeEpisodes[0]?.id, 'ep-restart');
    assert.deepEqual(state.pendingOutbox, [
      {
        id: 'sig-restart',
        episodeId: 'ep-restart',
        deliveryState: 'DELIVERY_UNKNOWN',
        retryCount: 0
      }
    ]);
    assert.equal(state.dueResultTasks[0]?.taskKind, 'outcome_5m');
  } finally {
    restarted.close();
    await rm(directory, { recursive: true, force: true });
  }
});

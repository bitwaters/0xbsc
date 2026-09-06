import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Storage } from '../../src/storage/database.js';
async function seed(storage: Storage) {
  storage.db.prepare('INSERT INTO config_revisions VALUES (?,?,?)').run('cfg', '{}', 1);
  storage.db
    .prepare(
      "INSERT INTO tokens(chain,address,first_seen_at_ms,updated_at_ms) VALUES('bsc','0xq',1,1)"
    )
    .run();
  await storage.claimEpisode({
    id: 'ep',
    tokenAddress: '0xq',
    route: 'new_launch',
    configRevisionId: 'cfg',
    nowMs: 1000
  });
}
void test('retry and safety rejection cannot move the frozen unsent entry or target', async () => {
  const storage = await Storage.open(':memory:');
  try {
    await seed(storage);
    await storage.recordEpisodeDecision({
      episodeId: 'ep',
      decision: 'observing',
      score: 75,
      completeness: 1,
      decisiveTriggerAtMs: 1000,
      featureSnapshot: { features: { priceUsd: 1 } },
      nowMs: 1000
    });
    await storage.scheduleResultTasks({
      episodeId: 'ep',
      signalId: null,
      score: 75,
      hardSafetyPassed: true,
      formal: false,
      narrative: false,
      fromMs: 2000,
      checkpointsMinutes: [1],
      narrativeCheckpointsMinutes: []
    });
    const before = (await storage.dueOutcomeTasks(61_000))[0]!;
    assert.equal(before.entryMarketPrice, '1');
    assert.equal(before.entryAtMs, 1000);
    assert.equal(before.targetAtMs, 61_000);
    await storage.deferPriceSampleTask(before.taskId, 300_000, 61_000);
    await storage.rejectEpisodeSafetyGate({
      episodeId: 'ep',
      reason: 'risk',
      snapshot: { features: { priceUsd: 2 } },
      nowMs: 70_000
    });
    assert.equal((await storage.dueOutcomeTasks(299_999)).length, 0);
    const after = (await storage.dueOutcomeTasks(300_000))[0]!;
    assert.equal(after.entryAtMs, before.entryAtMs);
    assert.equal(after.targetAtMs, before.targetAtMs);
    assert.equal(after.entryMarketPrice, '1');
    const row = storage.db
      .prepare(
        "SELECT json_extract(feature_snapshot_json,'$.initial_decision.features.priceUsd') AS p FROM episodes WHERE id='ep'"
      )
      .get() as { p: number };
    assert.equal(row.p, 1);
  } finally {
    storage.close();
  }
});
void test('soft failure grace never resets itself and explicit terminal risk remains terminal', async () => {
  const storage = await Storage.open(':memory:');
  try {
    await seed(storage);
    assert.equal(await storage.holdObservation('ep', 'evidence_expired', 1000, 60_000), true);
    assert.equal(
      await storage.holdObservation('ep', 'route_no_longer_qualified', 31_000, 60_000),
      true
    );
    assert.equal(
      await storage.holdObservation('ep', 'route_no_longer_qualified', 61_000, 60_000),
      false
    );
    assert.equal(
      await storage.holdObservation('ep', 'route_no_longer_qualified', 62_000, 60_000),
      false
    );
  } finally {
    storage.close();
  }
});
void test('migration preserves legacy values and supports idempotent restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'quality-migration-'));
  const migrations = join(dir, 'migrations');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(migrations);
  const source = new URL('../../src/storage/migrations/', import.meta.url);
  for (const name of await readdir(source))
    if (name < '011')
      await writeFile(join(migrations, name), await readFile(new URL(name, source)));
  let storage = await Storage.open(join(dir, 'db'), migrations);
  try {
    await seed(storage);
    storage.db
      .prepare(
        "INSERT INTO price_samples(episode_id,task_kind,due_at_ms,status,data_json,created_at_ms,updated_at_ms) VALUES('ep','outcome_1m',1000,'COMPLETE','{\"old\":true}',1,1)"
      )
      .run();
    storage.close();
    storage = await Storage.open(join(dir, 'db'));
    const row = storage.db
      .prepare(
        'SELECT quality_version AS version,data_json AS data,due_at_ms AS due FROM price_samples'
      )
      .get();
    assert.deepEqual(row, { version: 'legacy', data: '{"old":true}', due: 1000 });
    assert.deepEqual(storage.db.pragma('foreign_key_check'), []);
    storage.close();
    storage = await Storage.open(join(dir, 'db'));
    assert.equal(
      (storage.db.prepare('SELECT count(*) AS n FROM price_samples').get() as { n: number }).n,
      1
    );
  } finally {
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});
void test('risk changes reach sent signals independently of active Episodes and do not loop edits', async () => {
  const storage = await Storage.open(':memory:');
  try {
    await seed(storage);
    storage.db.prepare("UPDATE episodes SET state='SENT',ended_at_ms=2 WHERE id='ep'").run();
    storage.db
      .prepare(
        "INSERT INTO signals(id,episode_id,config_revision_id,delivery_state,quote_snapshot_json,decision_json,created_at_ms,updated_at_ms) VALUES('sig','ep','cfg','SENT','{}','{}',1,1)"
      )
      .run();
    await storage.recordSentRisk('0xq', 'failed', 'honeypot', 1000);
    await storage.recordSentRisk('0xq', 'failed', 'honeypot', 2000);
    assert.equal(
      (storage.db.prepare('SELECT count(*) AS n FROM price_samples').get() as { n: number }).n,
      1
    );
    const row = storage.db
      .prepare("SELECT json_extract(decision_json,'$.riskStatus.status') AS status FROM signals")
      .get();
    assert.deepEqual(row, { status: 'failed' });
  } finally {
    storage.close();
  }
});
void test('path report keeps unknown samples in coverage and separates revisions', async () => {
  const { pathQualityReport } = await import('../../src/evaluation/report.js');
  const storage = await Storage.open(':memory:');
  try {
    await seed(storage);
    storage.db
      .prepare(
        "INSERT INTO price_samples(episode_id,task_kind,due_at_ms,status,data_json,created_at_ms,updated_at_ms) VALUES('ep','outcome_1m',60000,'COMPLETE',?,0,0)"
      )
      .run(
        JSON.stringify({
          outcome: {
            path: {
              coverage: 'complete',
              maxMultiple: '2',
              maxEntryDrop: '0.05',
              barriers: [{ multiple: 2, stopLoss: 0.2, status: 'TP' }]
            }
          }
        })
      );
    const report = pathQualityReport(storage.db);
    assert.equal(report.status, 'ok');
    if (report.status === 'ok') {
      const group = report.groups!['cfg:unsent:new_launch']!;
      assert.equal(group.total, 1);
      assert.equal(group.maxMultipleMedian, 2);
      assert.equal(group.barriers['2/0.2']?.hitRate, 1);
    }
  } finally {
    storage.close();
  }
});
void test('prewatch is bounded, persists snapshots, and only hot candidates get accelerated polling', async () => {
  const { normalizeEvent } = await import('../../src/discovery/events.js');
  const storage = await Storage.open(':memory:');
  try {
    const event = normalizeEvent({
      chain: 'bsc',
      tokenAddress: '0xabc',
      source: 'hot',
      observedAtMs: 1000,
      sourceEventAtMs: null,
      evidenceFamily: 'attention',
      strength: 'weak',
      expiresAtMs: 1_000_000,
      rawPayloadRef: 'x',
      payload: {}
    });
    await storage.watchCandidate(event, 1000, 1, 900_000, 60_000, 'attention');
    await storage.watchCandidate(
      { ...event, tokenAddress: '0xdef' },
      1000,
      1,
      900_000,
      60_000,
      'attention'
    );
    assert.equal((await storage.dueCandidateWatches(61_000, 60_000)).length, 1);
    await storage.updateWatchSnapshot(
      event.tokenAddress,
      61_000,
      { price: 1 },
      true,
      1,
      10_000,
      60_000
    );
    assert.equal((await storage.dueCandidateWatches(71_000, 60_000)).length, 1);
  } finally {
    storage.close();
  }
});
void test('retention preserves referenced token events and unreferenced source recovery snapshots', async () => {
  const storage = await Storage.open(':memory:');
  try {
    await seed(storage);
    storage.db
      .prepare(
        "INSERT INTO tokens(chain,address,first_seen_at_ms,updated_at_ms) VALUES('bsc','0xfree',0,0)"
      )
      .run();
    const insert = storage.db.prepare(
      "INSERT INTO events(event_key,chain,token_address,source,poll_key,observed_at_ms,evidence_family,strength,expires_at_ms,normalized_json) VALUES(?,'bsc',?,'hot','hot:1m',?,'attention','weak',100,'{}')"
    );
    insert.run('q', '0xq', 1);
    insert.run('f1', '0xfree', 1);
    insert.run('f2', '0xfree', 2);
    const result = await storage.retainAudit(864000000, 1);
    assert.equal(result.events, 1);
    assert.deepEqual(storage.db.prepare('SELECT event_key AS k FROM events ORDER BY k').all(), [
      { k: 'f2' },
      { k: 'q' }
    ]);
  } finally {
    storage.close();
  }
});

void test('pending-only cohorts expose configured barriers without borrowing another revision thresholds', async () => {
  const { pathQualityReport } = await import('../../src/evaluation/report.js');
  const storage = await Storage.open(':memory:');
  try {
    await seed(storage);
    storage.db
      .prepare('UPDATE config_revisions SET sanitized_snapshot_json=?')
      .run(JSON.stringify({ evaluation: { target_multiples: [1.5], stop_loss_percent: 0.2 } }));
    storage.db
      .prepare(
        "INSERT INTO price_samples(episode_id,task_kind,due_at_ms,created_at_ms,updated_at_ms) VALUES('ep','outcome_1m',60000,0,0)"
      )
      .run();
    const report = pathQualityReport(storage.db);
    assert.equal(report.groups?.['cfg:unsent:new_launch']?.barriers['1.5/0.2']?.pending, 1);
    assert.equal(report.groups?.['cfg:unsent:new_launch']?.barriers['1.5/0.2']?.hitRate, null);
  } finally {
    storage.close();
  }
});

void test('a Quote 429 returns READY to scheduled observation without changing entry or extending expiry', async () => {
  const { withCandidateRecovery } = await import('../../src/decision/recovery.js');
  const { GmgnError } = await import('../../src/gmgn/client.js');
  const storage = await Storage.open(':memory:');
  try {
    await seed(storage);
    storage.db
      .prepare(
        "INSERT INTO events(event_key,chain,token_address,source,observed_at_ms,evidence_family,strength,expires_at_ms,normalized_json) VALUES('retry-event','bsc','0xq','hot',1000,'attention','weak',61000,'{}')"
      )
      .run();
    await storage.recordEpisodeDecision({
      episodeId: 'ep',
      decision: 'formal',
      score: 90,
      completeness: 1,
      decisiveTriggerAtMs: 1000,
      featureSnapshot: { features: { priceUsd: 1 } },
      nowMs: 1000,
      readyReevaluationAtMs: 2000,
      readyExpiresAtMs: 61000
    });
    const failure = new GmgnError('rate_limit', 'limited', 429, 5000);
    await assert.rejects(
      withCandidateRecovery(
        storage,
        '0xq',
        () => 1100,
        () => Promise.reject(failure)
      ),
      (error) => error === failure
    );
    assert.deepEqual(
      storage.db
        .prepare(
          'SELECT state,next_evaluation_at_ms AS retry,expires_at_ms AS expiry,evaluation_entry_price AS price,rejection_reason AS reason FROM episodes'
        )
        .get(),
      {
        state: 'OBSERVING',
        retry: 5250,
        expiry: 61000,
        price: '1',
        reason: 'candidate_rate_limit_retry'
      }
    );
    assert.equal((await storage.dueObservationEvents(5249)).length, 0);
    assert.equal((await storage.dueObservationEvents(5250)).length, 1);
    assert.equal(
      (storage.db.prepare('SELECT count(*) AS n FROM signals').get() as { n: number }).n,
      0
    );
    assert.equal(await storage.expireObservations(61000), 1);
  } finally {
    storage.close();
  }
});

void test('READY has a bounded watchdog even if processing exits without an exception', async () => {
  const storage = await Storage.open(':memory:');
  try {
    await seed(storage);
    storage.db
      .prepare(
        "INSERT INTO events(event_key,chain,token_address,source,observed_at_ms,evidence_family,strength,expires_at_ms,normalized_json) VALUES('ready-event','bsc','0xq','hot',1000,'attention','weak',61000,'{}')"
      )
      .run();
    await storage.recordEpisodeDecision({
      episodeId: 'ep',
      decision: 'formal',
      score: 90,
      completeness: 1,
      decisiveTriggerAtMs: 1000,
      featureSnapshot: {},
      nowMs: 1000,
      readyReevaluationAtMs: 2000,
      readyExpiresAtMs: 61000
    });
    assert.equal((await storage.dueObservationEvents(1999)).length, 0);
    assert.equal((await storage.dueObservationEvents(2000)).length, 1);
    await storage.recordEpisodeDecision({
      episodeId: 'ep',
      decision: 'formal',
      score: 90,
      completeness: 1,
      decisiveTriggerAtMs: 1000,
      featureSnapshot: {},
      nowMs: 3000,
      readyReevaluationAtMs: 4000,
      readyExpiresAtMs: 90000
    });
    assert.equal(
      (
        storage.db.prepare('SELECT expires_at_ms AS expiry FROM episodes').get() as {
          expiry: number;
        }
      ).expiry,
      61000
    );
    assert.equal(await storage.expireObservations(61000), 1);
    assert.equal((await storage.dueObservationEvents(62000)).length, 0);
  } finally {
    storage.close();
  }
});

void test('restart recovers orphan READY once, and expires an old deadline without replaying a signal', async () => {
  const storage = await Storage.open(':memory:');
  const expiry = { new_launch: 15, revival: 30, continuation: 15 };
  try {
    await seed(storage);
    storage.db
      .prepare(
        "UPDATE episodes SET state='READY',next_evaluation_at_ms=NULL,expires_at_ms=NULL WHERE id='ep'"
      )
      .run();
    assert.equal(await storage.recoverReadyCandidates(2000, expiry), 1);
    assert.deepEqual(
      storage.db
        .prepare('SELECT state,next_evaluation_at_ms AS next,expires_at_ms AS expiry FROM episodes')
        .get(),
      { state: 'OBSERVING', next: 3000, expiry: 901000 }
    );
    assert.equal(await storage.recoverReadyCandidates(2000, expiry), 0);
    storage.db.prepare("UPDATE episodes SET state='READY' WHERE id='ep'").run();
    assert.equal(await storage.recoverReadyCandidates(901000, expiry), 1);
    assert.deepEqual(
      storage.db
        .prepare('SELECT state,next_evaluation_at_ms AS next,ended_at_ms AS ended FROM episodes')
        .get(),
      { state: 'EXPIRED', next: null, ended: 901000 }
    );
    assert.equal(
      (storage.db.prepare('SELECT count(*) AS n FROM signals').get() as { n: number }).n,
      0
    );
  } finally {
    storage.close();
  }
});

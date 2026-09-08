import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { setImmediate as yieldToIO } from 'node:timers/promises';
import { Storage } from '../../src/storage/database.js';
import { ResearchStorage } from '../../src/research/storage.js';
import { ResearchRecorder } from '../../src/research/recorder.js';
import { normalizeEvent } from '../../src/discovery/events.js';

const event = (i: number) =>
  normalizeEvent({
    chain: 'bsc',
    tokenAddress: '0x' + i.toString(16).padStart(40, '0'),
    source: 'trending',
    sourceEventId: String(i),
    sourceEventAtMs: null,
    observedAtMs: 1000,
    evidenceFamily: 'attention',
    strength: 'weak',
    expiresAtMs: 61000,
    rawPayloadRef: 'test',
    payload: {}
  });

void test('quota calibration keeps concurrent reservations and rejects writes before exhaustion', async () => {
  const storage = await Storage.open(':memory:');
  try {
    const r = new ResearchStorage(storage);
    await r.startRun('run', {}, 0);
    r.calibrateQuota(100000, 0);
    const checkpoint = r.quotaCheckpoint();
    await r.recordUniverse(event(1), 'run', 'seed', 20, 1000000);
    const reserved = r.quotaCheckpoint();
    assert.ok(reserved > checkpoint);
    r.calibrateQuota(110000, checkpoint);
    assert.equal(r.quotaBytes(), 110000 + reserved - checkpoint);
    await r.recordUniverse(event(2), 'run', 'seed', 20, r.quotaBytes()! + 1);
    assert.equal(
      (storage.db.prepare('SELECT count(*) n FROM research_universe').get() as { n: number }).n,
      1
    );
    assert.deepEqual(storage.db.prepare('SELECT status FROM research_runs').get(), {
      status: 'STORAGE_BUDGET_EXHAUSTED'
    });
  } finally {
    storage.close();
  }
});

void test('large research database does not cause per-event scans or starve I/O', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'research-perf-'));
  const storage = await Storage.open(join(dir, 'perf.sqlite'));
  const recorder = new ResearchRecorder(
    storage,
    { mode: 'observe', run_id: 'perf', max_storage_bytes: 2 ** 31 },
    () => undefined
  );
  try {
    // Default fixture is small; run RESEARCH_PERF_MB=750 for production-scale evidence.
    const mb = Number(process.env.RESEARCH_PERF_MB ?? 4);
    const payload = JSON.stringify({ padding: 'x'.repeat(1024 * 1024) });
    const insert = storage.db.prepare(
      `INSERT INTO research_facts(fact_id,attempt_id,endpoint,chain,token,pool_revision,purpose,queued_at_ms,requested_at_ms,received_at_ms,semantic_hash,envelope_json,payload_json) VALUES (?,?,'info','bsc',NULL,'unresolved','shared_collection',0,0,0,'hash','{}',?)`
    );
    storage.db.transaction(() => {
      for (let i = 0; i < mb; i++) insert.run('f' + i, 'a' + i, payload);
    })();
    await recorder.research.startRun('perf', recorder.config, 1000);
    const universe = storage.db.prepare(
      "INSERT INTO research_universe VALUES ('bsc',?,'unresolved',0,0,'fixture','discovered','UNKNOWN')"
    );
    const sample = storage.db.prepare(
      "INSERT INTO research_sampling VALUES ('perf','bsc',?,'unresolved',?,'discovered',0,'RESOURCE_EXCLUDED',0)"
    );
    storage.db.transaction(() => {
      for (let i = 100; i < 10100; i++) {
        const token = '0x' + i.toString(16).padStart(40, '0');
        universe.run(token);
        sample.run(token, String(i).padStart(64, '0'));
      }
    })();
    await recorder.start(1000);
    assert.equal(recorder.stoppedReason, null);
    // If the hot path regresses to scanning even once, this fails independently of timing.
    recorder.research.estimatedBytes = () => {
      throw new Error('HOT_PATH_PAGE_SCAN');
    };
    let turns = 0;
    const timer = setInterval(() => turns++, 1);
    const started = performance.now();
    for (let i = 0; i < 100; i++) recorder.event(event(i));
    while (recorder.pending) await yieldToIO();
    clearInterval(timer);
    const durationMs = performance.now() - started;
    assert.equal(recorder.stoppedReason, null);
    assert.equal(
      (storage.db.prepare('SELECT count(*) n FROM research_universe').get() as { n: number }).n,
      10100
    );
    assert.ok(turns > 1, 'I/O timers must run during research batch');
    assert.ok(durationMs < 3000, `100 event batch exceeded 3s: ${durationMs}`);
    console.log(
      JSON.stringify({
        event: 'research_performance',
        databasePayloadMiB: mb,
        candidates: 100,
        durationMs,
        ioTurns: turns
      })
    );
  } finally {
    recorder.close();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

void test('audit retention uses bounded time and recovery indexes even with no expired data', async () => {
  const storage = await Storage.open(':memory:');
  try {
    const plan = storage.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT e.id FROM events e
      WHERE e.observed_at_ms<? AND e.expires_at_ms<?
      AND NOT EXISTS(SELECT 1 FROM episodes ep WHERE ep.chain=e.chain AND ep.token_address=e.token_address)
      AND EXISTS(SELECT 1 FROM events newer WHERE newer.chain=e.chain AND newer.token_address=e.token_address AND newer.source=e.source AND newer.poll_key IS e.poll_key AND newer.id>e.id) LIMIT ?`
      )
      .all(1000, 2000, 500) as { detail: string }[];
    const details = plan.map((row) => row.detail).join('\n');
    assert.match(details, /events_retention_time/);
    assert.match(details, /events_retention_recovery/);
    assert.match(details, /episodes_retention_token/);
    assert.doesNotMatch(details, /SCAN e\b|AUTOMATIC/);
    assert.deepEqual(await storage.retainAudit(2000, 7), { events: 0, traces: 0 });
  } finally {
    storage.close();
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Storage } from '../../src/storage/database.js';

void test('aggregates successful API calls while retaining failures and slow calls individually', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-api-stats-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  try {
    await storage.recordApiObservation({
      endpoint: 'quote',
      occurredAtMs: 1_000,
      weight: 2,
      status: 200,
      latencyMs: 10,
      kind: 'success'
    });
    await storage.recordApiObservation({
      endpoint: 'quote',
      occurredAtMs: 2_000,
      weight: 2,
      status: 200,
      latencyMs: 20,
      kind: 'success'
    });
    await storage.recordApiObservation({
      endpoint: 'quote',
      occurredAtMs: 3_000,
      weight: 2,
      status: 429,
      latencyMs: 30,
      kind: 'rate_limit',
      retryCount: 1,
      detail: 'cooldown'
    });
    await storage.recordApiObservation({
      endpoint: 'quote',
      occurredAtMs: 4_000,
      weight: 2,
      status: 200,
      latencyMs: 1_500,
      kind: 'success',
      slowThresholdMs: 1_000
    });
    assert.deepEqual(await storage.apiMinuteStats('quote', 0), {
      endpoint: 'quote',
      minuteAtMs: 0,
      requestCount: 4,
      weightSum: 8,
      successCount: 3,
      errorCount: 1,
      statusCounts: { '200': 3, '429': 1 },
      p50: 20,
      p95: 1500
    });
    assert.deepEqual(
      storage.db.prepare('SELECT kind, retry_count AS retries FROM api_failures ORDER BY id').all(),
      [
        { kind: 'rate_limit', retries: 1 },
        { kind: 'slow', retries: 0 }
      ]
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('physical attempt audit retains correlation and rate-limit evidence with bounded retention', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-attempt-audit-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  try {
    await storage.recordApiObservation({
      endpoint: 'quote',
      occurredAtMs: 2000,
      weight: 2,
      status: 200,
      latencyMs: 1000,
      kind: 'success',
      retryCount: 1,
      attempt: {
        id: 'attempt-1',
        startedAtMs: 1000,
        queuedAtMs: 500,
        weight: 2,
        priority: 'formal',
        availableWeight: 18,
        inFlight: 1,
        correlationId: 'candidate-1',
        rateLimit: null
      }
    });
    const row = storage.db.prepare('SELECT metadata_json FROM api_attempts').get() as {
      metadata_json: string;
    };
    assert.equal(
      (JSON.parse(row.metadata_json) as { correlationId: string }).correlationId,
      'candidate-1'
    );
    await storage.retainAudit(86_402_000, 7);
    assert.equal(
      (storage.db.prepare('SELECT count(*) AS n FROM api_attempts').get() as { n: number }).n,
      0
    );
    assert.equal((await storage.apiMinuteStats('quote', 0))?.weightSum, 2);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

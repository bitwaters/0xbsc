import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OperationTimeline } from '../../src/observability/timeline.js';
import { Storage } from '../../src/storage/database.js';

void test('persists a correlated end-to-end stage timeline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-timeline-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  try {
    let now = 1_000;
    const timeline = new OperationTimeline(storage, 'corr-1', () => now++);
    for (const stage of [
      'source_event',
      'observation',
      'queue',
      'api_batch',
      'decision',
      'outbox',
      'telegram_request',
      'telegram_confirmation',
      'result'
    ] as const)
      await timeline.record(stage, { stage });
    assert.deepEqual(
      (await storage.operationTraces('corr-1')).map((trace) => trace.stage),
      [
        'source_event',
        'observation',
        'queue',
        'api_batch',
        'decision',
        'outbox',
        'telegram_request',
        'telegram_confirmation',
        'result'
      ]
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

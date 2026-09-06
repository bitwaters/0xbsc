import assert from 'node:assert/strict';
import test from 'node:test';
import { ObservationPool } from '../../src/decision/observation-pool.js';
import { KeyedSerialExecutor, SnapshotDeduplicator } from '../../src/discovery/events.js';
import { GmgnScheduler, type Clock } from '../../src/gmgn/scheduler.js';
import { OutboxDeliveryService } from '../../src/delivery/outbox.js';
import { TelegramClient } from '../../src/delivery/telegram.js';
import { scheduleEvaluationTasks } from '../../src/evaluation/tasks.js';
import { Storage } from '../../src/storage/database.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

class ReplayClock implements Clock {
  value = 0;
  now(): number {
    return this.value;
  }
  sleep(ms: number): Promise<void> {
    this.value += ms;
    return Promise.resolve();
  }
  random(): number {
    return 0.5;
  }
}

const sources = ['signal', 'trenches', 'trending', 'hot', 'smart_money', 'kol'] as const;

void test('replays a six-source burst with capacity, weighted scheduling and duplicate guards', async () => {
  const clock = new ReplayClock();
  const scheduler = new GmgnScheduler(clock, 14, 20);
  const pool = new ObservationPool(60, 20);
  const deduplicator = new SnapshotDeduplicator();
  const executed: string[] = [];
  let releaseBlocker!: () => void;
  const blocker = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });

  const active = scheduler.schedule({
    key: 'replay:blocker',
    priority: 'formal' as const,
    weight: 1,
    run: async () => {
      await blocker;
      executed.push('blocker');
    }
  });
  await Promise.resolve();

  const requests = sources.map((source, sourceIndex) =>
    scheduler.schedule({
      key: `replay:${source}`,
      priority: source === 'signal' ? ('formal' as const) : ('discovery' as const),
      weight: source === 'signal' ? 3 : 1,
      run: async () => {
        executed.push(source);
        for (let offset = 0; offset < 10; offset += 1) {
          const tokenAddress = `0x${sourceIndex}${offset}`;
          const admitted = pool.admit({
            id: `${source}:${offset}`,
            route: offset % 3 === 0 ? 'revival' : 'new_launch',
            score: 70 + offset,
            completeness: 0.8,
            evidenceFreshness: 1,
            active: true
          });
          assert.equal(admitted.admitted, true);
          const event = await deduplicator.ingest(
            {
              chain: 'bsc',
              tokenAddress,
              source,
              sourceEventAtMs: null,
              observedAtMs: offset,
              evidenceFamily: 'attention',
              strength: 'weak',
              expiresAtMs: 1_000,
              rawPayloadRef: `replay:${source}:${offset}`,
              payload: { source, offset },
              pollKey: `replay:${source}`
            },
            () => Promise.resolve(true)
          );
          assert.ok(event);
        }
      }
    })
  );
  const duplicate = scheduler.schedule({
    key: 'replay:trending',
    priority: 'discovery' as const,
    weight: 1,
    run: () => Promise.resolve()
  });

  releaseBlocker();
  await Promise.all([active, ...requests]);
  await assert.rejects(duplicate, /already running/);
  assert.equal(pool.active.length, 60);
  assert.deepEqual(new Set(executed), new Set(['blocker', ...sources]));

  const duplicateEvent = await deduplicator.ingest(
    {
      chain: 'bsc',
      tokenAddress: '0x20',
      source: 'trending',
      sourceEventAtMs: null,
      observedAtMs: 20,
      evidenceFamily: 'attention',
      strength: 'weak',
      expiresAtMs: 1_000,
      rawPayloadRef: 'replay:trending:0',
      payload: { source: 'trending', offset: 0 },
      pollKey: 'replay:trending'
    },
    () => Promise.resolve(true)
  );
  assert.equal(duplicateEvent, null);
});

void test('keeps same-token replay work ordered while separate tokens progress independently', async () => {
  const executor = new KeyedSerialExecutor();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const first = executor.enqueue('0xsame', async () => {
    events.push('same:first:start');
    await firstGate;
    events.push('same:first:end');
  });
  const second = executor.enqueue('0xsame', () => {
    events.push('same:second');
  });
  const other = executor.enqueue('0xother', () => {
    events.push('other:first');
  });

  await other;
  assert.deepEqual(events, ['same:first:start', 'other:first']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['same:first:start', 'other:first', 'same:first:end', 'same:second']);
});

void test('runs captured input through durable decision, delivery and result-task dry run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-dry-run-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  try {
    const now = 1_000;
    await storage.recordConfigRevision('cfg', { captured: true }, now);
    await storage.claimEpisode({
      id: 'ep',
      tokenAddress: '0xdry',
      route: 'continuation',
      configRevisionId: 'cfg',
      nowMs: now
    });
    await storage.recordEpisodeDecision({
      episodeId: 'ep',
      decision: 'formal',
      score: 82,
      completeness: 0.8,
      decisiveTriggerAtMs: now,
      featureSnapshot: { captured: true },
      nowMs: now
    });
    await storage.createSignalOutbox({
      signalId: 'sig',
      episodeId: 'ep',
      configRevisionId: 'cfg',
      quoteSnapshot: { accepted: true },
      decision: { correlationId: 'dry' },
      nowMs: now
    });
    for (const stage of ['source_event', 'decision', 'outbox'] as const)
      await storage.recordOperationTrace({ correlationId: 'dry', stage, occurredAtMs: now });
    let finished!: () => void;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const sent: string[] = [];
    const service = new OutboxDeliveryService({
      storage,
      chatId: '-100',
      now: () => now + 1,
      telegram: new TelegramClient({
        botToken: 'test',
        transport: () =>
          Promise.resolve({
            status: 200,
            body: { ok: true, result: { message_id: 7, chat: { id: '-100' } } }
          })
      }),
      render: (signal) => {
        const text = `DRY ${signal.id}`;
        sent.push(text);
        return { text };
      },
      revalidateBeforeUnknownRetry: () => Promise.resolve(true),
      onTrace: (signal, stage, occurredAtMs) =>
        storage.recordOperationTrace({
          correlationId: (signal.decision as { correlationId: string }).correlationId,
          stage,
          occurredAtMs
        }),
      onConfirmed: async (signal, confirmedAtMs) => {
        await scheduleEvaluationTasks(storage, {
          episodeId: signal.episodeId,
          signalId: signal.id,
          score: 82,
          hardSafetyPassed: true,
          formal: true,
          narrative: false,
          fromMs: confirmedAtMs,
          checkpointsMinutes: [1, 5],
          narrativeCheckpointsMinutes: []
        });
        finished();
      }
    });
    await service.recoverAndDeliver();
    await done;
    assert.deepEqual(sent, ['DRY sig']);
    assert.deepEqual(
      storage.db
        .prepare('SELECT delivery_state AS state, telegram_message_id AS messageId FROM signals')
        .get(),
      { state: 'SENT', messageId: '7' }
    );
    assert.equal(
      (
        storage.db
          .prepare("SELECT COUNT(*) AS count FROM price_samples WHERE task_kind LIKE 'outcome_%'")
          .get() as { count: number }
      ).count,
      2
    );
    assert.deepEqual(
      (await storage.operationTraces('dry')).map((trace) => trace.stage),
      ['source_event', 'decision', 'outbox', 'telegram_request', 'telegram_confirmation']
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

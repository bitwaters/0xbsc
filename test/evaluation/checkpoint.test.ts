import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureOutcomeCheckpoint } from '../../src/evaluation/checkpoint.js';
import { Storage } from '../../src/storage/database.js';
import { timingFixtures } from './fixtures.js';

async function setup(): Promise<{ storage: Storage; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-checkpoint-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  const now = 1_000;
  storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg', '{}', now);
  storage.db
    .prepare(
      "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', '0xcheckpoint', ?, ?)"
    )
    .run(now, now);
  storage.db
    .prepare(
      "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES ('ep-checkpoint', 'bsc', '0xcheckpoint', 'revival', 'SENT', 'cfg', ?, ?)"
    )
    .run(now, now);
  storage.db
    .prepare(
      "INSERT INTO signals (id, episode_id, config_revision_id, delivery_state, quote_snapshot_json, decision_json, created_at_ms, updated_at_ms) VALUES ('sig-checkpoint', 'ep-checkpoint', 'cfg', 'SENT', '{}', '{}', ?, ?)"
    )
    .run(now, now);
  await storage.scheduleResultTasks({
    episodeId: 'ep-checkpoint',
    signalId: 'sig-checkpoint',
    score: 80,
    hardSafetyPassed: true,
    formal: true,
    narrative: false,
    fromMs: now,
    checkpointsMinutes: [1],
    narrativeCheckpointsMinutes: []
  });
  await storage.recordEntryQuote({
    episodeId: 'ep-checkpoint',
    signalId: 'sig-checkpoint',
    sizeUsd: 10,
    confirmedAtMs: now,
    requestedAtMs: now,
    completedAtMs: now,
    quote: { inputUsd: '10', outputTokenAmount: '123' },
    error: null
  });
  return { storage, directory };
}

void test('captures paths for all samples but exits only formal signals and marks late starts', async () => {
  const { storage, directory } = await setup();
  try {
    let sellCalls = 0;
    const dependencies = {
      candles: () => Promise.resolve([{ high: '2', low: '1', close: '1.5' }]),
      buy: () => Promise.reject(new Error('not used')),
      sell: () => {
        sellCalls += 1;
        return Promise.resolve({
          inputUsd: '10',
          outputUsd: '9',
          configuredSlippagePercent: '1',
          routeAvailable: true,
          direction: 'sell' as const,
          costSemanticsVersion: 'gmgn-bsc-quote-2026-09-03-v1' as const
        });
      }
    };
    const formal = await captureOutcomeCheckpoint(storage, dependencies, dependencies, {
      taskId: 1,
      episodeId: 'ep-checkpoint',
      signalId: 'sig-checkpoint',
      formal: true,
      checkpointMinutes: 1,
      entryAtMs: 1_000,
      targetAtMs: timingFixtures.lateExit.targetAtMs,
      now: () => timingFixtures.lateExit.requestedAtMs
    });
    assert.equal(formal.exitLate, true);
    assert.equal(sellCalls, 1);
    const unsent = await captureOutcomeCheckpoint(storage, dependencies, dependencies, {
      taskId: 1,
      episodeId: 'ep-checkpoint',
      signalId: null,
      formal: false,
      checkpointMinutes: 1,
      entryAtMs: 1_000,
      targetAtMs: 1_000,
      now: () => 2_000
    });
    assert.equal(unsent.exitQuotes.length, 0);
    assert.equal(sellCalls, 1);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('a late checkpoint never extends its requested market window to retry time', async () => {
  const { storage, directory } = await setup();
  try {
    let range: unknown;
    await captureOutcomeCheckpoint(
      storage,
      {
        candles: (input) => {
          range = input;
          return Promise.resolve([]);
        }
      },
      {
        buy: () => Promise.reject(new Error('unused')),
        sell: () => Promise.reject(new Error('unused'))
      },
      {
        taskId: 1,
        episodeId: 'ep-checkpoint',
        signalId: null,
        formal: false,
        checkpointMinutes: 1,
        entryAtMs: 1000,
        targetAtMs: 61_000,
        now: () => 600_000
      }
    );
    assert.deepEqual(range, { episodeId: 'ep-checkpoint', fromMs: 1000, toMs: 61_000 });
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('a quote requested on time but completed late is not a timely executable result', async () => {
  const { storage, directory } = await setup();
  try {
    let nowMs = 61_000;
    const result = await captureOutcomeCheckpoint(
      storage,
      { candles: () => Promise.resolve([]) },
      {
        buy: () => Promise.reject(new Error('unused')),
        sell: () => {
          nowMs = 80_000;
          return Promise.resolve({
            inputUsd: '10',
            outputUsd: '11',
            configuredSlippagePercent: '1',
            routeAvailable: true,
            direction: 'sell' as const,
            costSemanticsVersion: 'gmgn-bsc-quote-2026-09-03-v1' as const
          });
        }
      },
      {
        taskId: 1,
        episodeId: 'ep-checkpoint',
        signalId: 'sig-checkpoint',
        formal: true,
        checkpointMinutes: 1,
        entryAtMs: 1000,
        targetAtMs: 61_000,
        now: () => nowMs
      }
    );
    assert.equal(result.exitLate, false);
    assert.equal(result.exitQuotes[0]?.late, true);
    assert.equal(result.exitQuotes[0]?.completedAtMs, 80_000);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('path repairs retain original executable quotes, frozen coordinates and initial evidence', async () => {
  const { storage, directory } = await setup();
  try {
    let nowMs = 61_000,
      calls = 0;
    const quotes = {
      buy: () => Promise.reject(new Error('unused')),
      sell: () => {
        calls++;
        return Promise.resolve({
          inputUsd: '10',
          outputUsd: '11',
          configuredSlippagePercent: '1',
          routeAvailable: true,
          direction: 'sell' as const,
          costSemanticsVersion: 'gmgn-bsc-quote-2026-09-03-v1' as const
        });
      }
    };
    const make = (timeMs: number) => ({
      timeMs,
      intervalMs: 30_000,
      completed: true,
      high: '2',
      low: '1',
      close: '1.5'
    });
    const input = {
      taskId: 1,
      episodeId: 'ep-checkpoint',
      signalId: 'sig-checkpoint',
      formal: true,
      checkpointMinutes: 1,
      entryAtMs: 1000,
      targetAtMs: 61_000,
      now: () => nowMs
    };
    const first = await captureOutcomeCheckpoint(
      storage,
      { candles: () => Promise.resolve([make(0)]) },
      quotes,
      input
    );
    nowMs = 121_000;
    const second = await captureOutcomeCheckpoint(
      storage,
      { candles: () => Promise.resolve([make(30_000), make(60_000)]) },
      quotes,
      input
    );
    assert.equal(calls, 1);
    assert.deepEqual(second.exitQuotes, first.exitQuotes);
    assert.equal(second.exitLate, first.exitLate);
    assert.equal(second.candles.length, 3);
    const row = storage.db
      .prepare(
        'SELECT path_capture_attempts AS attempts,initial_checkpoint_json AS original,entry_at_ms AS entry,target_at_ms AS target FROM price_samples WHERE id=1'
      )
      .get() as { attempts: number; original: string; entry: number; target: number };
    assert.equal(row.attempts, 2);
    assert.deepEqual((JSON.parse(row.original) as { candles: unknown }).candles, first.candles);
    assert.equal(row.entry, 1000);
    assert.equal(row.target, 61_000);
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

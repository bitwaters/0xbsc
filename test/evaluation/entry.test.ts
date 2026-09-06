import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { capturePostConfirmationEntryQuotes } from '../../src/evaluation/entry.js';
import { Storage } from '../../src/storage/database.js';
import { timingFixtures } from './fixtures.js';

void test('captures all post-confirmation entry Quotes concurrently and identifies late starts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gmgn-entry-'));
  const storage = await Storage.open(join(directory, 'signal.db'));
  try {
    const now = 1_000;
    storage.db.prepare('INSERT INTO config_revisions VALUES (?, ?, ?)').run('cfg', '{}', now);
    storage.db
      .prepare(
        "INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms) VALUES ('bsc', '0xentry', ?, ?)"
      )
      .run(now, now);
    storage.db
      .prepare(
        "INSERT INTO episodes (id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms) VALUES ('ep-entry', 'bsc', '0xentry', 'revival', 'SENT', 'cfg', ?, ?)"
      )
      .run(now, now);
    storage.db
      .prepare(
        "INSERT INTO signals (id, episode_id, config_revision_id, delivery_state, quote_snapshot_json, decision_json, created_at_ms, updated_at_ms) VALUES ('sig-entry', 'ep-entry', 'cfg', 'SENT', '{}', '{}', ?, ?)"
      )
      .run(now, now);
    const starts = [1_000, 1_100, timingFixtures.lateEntry.requestedAtMs];
    const clock = () => starts.shift() ?? 7_000;
    const result = await capturePostConfirmationEntryQuotes(
      storage,
      {
        buy: (sizeUsd) =>
          Promise.resolve({
            inputUsd: String(sizeUsd),
            outputUsd: String(sizeUsd - 1),
            outputTokenAmount: '10',
            configuredSlippagePercent: '1',
            routeAvailable: true,
            direction: 'buy',
            costSemanticsVersion: 'gmgn-bsc-quote-2026-09-03-v1'
          }),
        sell: () => Promise.reject(new Error('not used'))
      },
      {
        episodeId: 'ep-entry',
        signalId: 'sig-entry',
        confirmedAtMs: 1_000,
        sizesUsd: [10, 50, 100],
        now: clock
      }
    );
    assert.deepEqual(
      result.map((item) => item.primaryExecutableCohort),
      [true, true, false]
    );
    const rows = storage.db
      .prepare('SELECT task_kind AS kind, data_json AS data FROM price_samples ORDER BY task_kind')
      .all() as Array<{ kind: string; data: string }>;
    assert.equal(rows.length, 3);
    assert.ok(
      rows.some(
        (row) =>
          row.kind === 'entry_quote_100u' && row.data.includes('"primaryExecutableCohort":false')
      )
    );
  } finally {
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../../src/storage/database.js';
import { ResearchStorage } from '../../src/research/storage.js';
import { freezeDataset } from '../../src/research/dataset.js';
void test('dataset cutoff and token identity are immutable across pools and final use', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dataset-'));
  const s = await Storage.open(join(directory, 'test.sqlite'));
  try {
    const r = new ResearchStorage(s);
    await r.startRun('dev', { mode: 'observe' }, 0);
    await r.startRun('select', { mode: 'observe' }, 0);
    s.db
      .prepare(
        "INSERT INTO research_universe VALUES ('bsc','token','pool1',10,10,'event','discovered','UNKNOWN')"
      )
      .run();
    const plan = {
      datasetId: 'd',
      runId: 'dev',
      use: 'development' as const,
      startAtMs: 0,
      cutoffAtMs: 100,
      frozenAtMs: 86400100
    };
    const manifest = await freezeDataset(r, plan);
    assert.deepEqual(await freezeDataset(r, plan), manifest);
    s.db
      .prepare(
        "INSERT INTO research_universe VALUES ('bsc','token','pool2',200,200,'event2','discovered','UNKNOWN')"
      )
      .run();
    await freezeDataset(r, {
      ...plan,
      datasetId: 's',
      runId: 'select',
      use: 'selection',
      cutoffAtMs: 300,
      frozenAtMs: 86400300
    });
    assert.equal(
      (s.db.prepare('SELECT COUNT(*) AS n FROM dataset_memberships').get() as { n: number }).n,
      1
    );
    await assert.rejects(freezeDataset(r, { ...plan, cutoffAtMs: 99 }), /ALREADY_FROZEN/);
    await assert.rejects(
      freezeDataset(r, { ...plan, datasetId: 'f', use: 'final' }),
      /FINAL_RUN_NOT_PREREGISTERED/
    );
    s.db.prepare('UPDATE dataset_memberships SET consumed=1').run();
    assert.throws(
      () => s.db.prepare('UPDATE dataset_memberships SET consumed=0').run(),
      /cannot be reset/
    );
  } finally {
    s.close();
    await rm(directory, { recursive: true, force: true });
  }
});

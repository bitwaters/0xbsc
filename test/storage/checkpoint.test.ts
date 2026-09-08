import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Storage } from '../../src/storage/database.js';
import { startCheckpointWorker } from '../../src/storage/checkpoint.js';

void test('background checkpoints preserve FULL durability, tolerate readers and restore automatic safety on close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wal-worker-'));
  const path = join(dir, 'test.sqlite');
  const storage = await Storage.open(path);
  storage.db.pragma('synchronous=FULL');
  storage.db.exec(
    "CREATE TABLE checkpoint_fixture (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO checkpoint_fixture VALUES (1,'old')"
  );
  const reader = new Database(path, { readonly: true });
  const checkpoint = await startCheckpointWorker(storage.db, 50);
  const wait = async (test: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!test()) {
      if (Date.now() > deadline) throw new Error('checkpoint test timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    assert.equal(storage.db.pragma('synchronous', { simple: true }), 2);
    assert.equal(storage.db.pragma('wal_autocheckpoint', { simple: true }), 0);
    reader.exec('BEGIN');
    reader.prepare('SELECT value FROM checkpoint_fixture').get();
    storage.db.prepare('UPDATE checkpoint_fixture SET value=?').run('x'.repeat(2 * 1024 * 1024));
    await wait(() => checkpoint.snapshot().backlogBytes > 0);
    assert.equal(checkpoint.snapshot().failure, null);
    reader.exec('COMMIT');
    await wait(() => checkpoint.snapshot().backlogBytes === 0);
    assert.equal(
      (storage.db.prepare('SELECT length(value) n FROM checkpoint_fixture').get() as { n: number })
        .n,
      2 * 1024 * 1024
    );
    await checkpoint.close();
    assert.equal(storage.db.pragma('wal_autocheckpoint', { simple: true }), 1000);
    assert.equal(storage.db.pragma('synchronous', { simple: true }), 2);
  } finally {
    await checkpoint.close();
    reader.close();
    storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});

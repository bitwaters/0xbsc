import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../../src/storage/database.js';
void test('foreground acquires write lock before reading a snapshot while background commit is pending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trial-writer-'));
  const storage = await Storage.open(join(directory, 'data.db'));
  storage.db.exec(
    'CREATE TABLE contention_counter(n INTEGER); INSERT INTO contention_counter VALUES(0)'
  );
  const worker = new Worker(
    `const {parentPort,workerData}=require('node:worker_threads');const D=require('better-sqlite3');const d=new D(workerData);d.pragma('busy_timeout=5000');try {d.exec('BEGIN IMMEDIATE; UPDATE contention_counter SET n=1');parentPort.postMessage('locked');setTimeout(()=>{try{d.exec('COMMIT');parentPort.postMessage('done');}catch(e){parentPort.postMessage(e.code);}finally{d.close();}},100);}catch(e){parentPort.postMessage(e.code);d.close();}`,
    { eval: true, workerData: storage.db.name }
  );
  const done = new Promise<void>((resolve, reject) => {
    worker.on('message', (m) => {
      if (m === 'done') resolve();
      else if (m !== 'locked') reject(new Error(String(m)));
    });
    worker.once('error', reject);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once('message', (m) => (m === 'locked' ? resolve() : reject(new Error(String(m)))));
      worker.once('error', reject);
    });
    // DEFERRED would read n=0 and then fail upgrading its snapshot while the other writer owns the lock.
    // IMMEDIATE waits before SELECT, reads the committed n=1, and commits n=2.
    await storage.transaction(() => {
      const n = (storage.db.prepare('SELECT n FROM contention_counter').get() as { n: number }).n;
      assert.equal(n, 1);
      storage.db.prepare('UPDATE contention_counter SET n=?').run(n + 1);
    });
    await done;
    assert.equal(
      (storage.db.prepare('SELECT n FROM contention_counter').get() as { n: number }).n,
      2
    );
    assert.equal(storage.db.pragma('synchronous', { simple: true }), 2);
  } finally {
    await worker.terminate();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../../src/storage/database.js';
void test('foreground read-modify-write transactions survive concurrent background SQLite commits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trial-writer-'));
  const storage = await Storage.open(join(directory, 'data.db'));
  storage.db.exec(
    'CREATE TABLE contention_counter(n INTEGER); INSERT INTO contention_counter VALUES(0)'
  );
  const worker = new Worker(
    `const {parentPort,workerData}=require('node:worker_threads');const D=require('better-sqlite3');const d=new D(workerData);d.pragma('busy_timeout=5000');parentPort.postMessage('ready');parentPort.once('message',()=>{try{for(let i=0;i<100;i++){d.prepare('UPDATE contention_counter SET n=n+1').run();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);}parentPort.postMessage('done');}catch(e){parentPort.postMessage(e.code);}finally{d.close();}});`,
    { eval: true, workerData: storage.db.name }
  );
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once('message', () => resolve());
      worker.once('error', reject);
    });
    const done = new Promise<unknown>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    worker.postMessage('start');
    for (let i = 0; i < 100; i++)
      await storage.transaction(() => {
        const n = (storage.db.prepare('SELECT n FROM contention_counter').get() as { n: number }).n;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        storage.db.prepare('UPDATE contention_counter SET n=?').run(n + 1);
      });
    assert.equal(await done, 'done');
    assert.equal(
      (storage.db.prepare('SELECT n FROM contention_counter').get() as { n: number }).n,
      200
    );
    assert.equal(storage.db.pragma('synchronous', { simple: true }), 2);
  } finally {
    await worker.terminate();
    storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});

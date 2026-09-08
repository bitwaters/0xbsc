import { Worker } from 'node:worker_threads';
import type { SqliteDatabase } from './database.js';

interface CheckpointSample {
  atMs: number;
  busy: number;
  log: number;
  checkpointed: number;
  durationMs: number;
  pageSize: number;
}

/** Move automatic COMMIT checkpoints off the event loop without changing synchronous=FULL. */
export async function startCheckpointWorker(db: SqliteDatabase, intervalMs = 1000) {
  const previous = Number(db.pragma('wal_autocheckpoint', { simple: true })) || 1000;
  let sample: CheckpointSample | null = null;
  let failure: string | null = null;
  let closed = false;
  let background = false;
  const startedAtMs = Date.now();
  const restore = (reason: string) => {
    failure = reason;
    background = false;
    if (!closed && db.open) db.pragma(`wal_autocheckpoint=${previous}`);
    void worker.terminate();
  };
  const worker = new Worker(
    `
    const { parentPort, workerData: d } = require('node:worker_threads');
    const Database = require('better-sqlite3');
    const db = new Database(d.path, {fileMustExist:true});
    db.pragma('busy_timeout=0');
    db.pragma('wal_autocheckpoint=0');
    const pageSize = Number(db.pragma('page_size', {simple:true}));
    parentPort.postMessage({ready:true});
    setInterval(() => {
      const start=performance.now();
      try {
        const row=db.pragma('wal_checkpoint(PASSIVE)')[0];
        parentPort.postMessage({atMs:Date.now(),...row,durationMs:performance.now()-start,pageSize});
      } catch { parentPort.postMessage({error:'CHECKPOINT_FAILED'}); }
    }, d.intervalMs);
  `,
    { eval: true, workerData: { path: db.name, intervalMs } }
  );
  worker.unref();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      restore('CHECKPOINT_START_TIMEOUT');
      void worker.terminate();
      reject(new Error('CHECKPOINT_START_TIMEOUT'));
    }, 10000);
    worker.on('message', (message: CheckpointSample & { ready?: boolean; error?: string }) => {
      if (message.ready) {
        clearTimeout(timeout);
        if (closed) return;
        db.pragma('wal_autocheckpoint=0');
        background = true;
        resolve();
      } else if (message.error) restore('CHECKPOINT_FAILED');
      else sample = message;
    });
    worker.on('error', () => {
      clearTimeout(timeout);
      restore('CHECKPOINT_WORKER_FAILED');
      reject(new Error('CHECKPOINT_WORKER_FAILED'));
    });
    worker.on('exit', () => {
      clearTimeout(timeout);
      if (!closed) {
        restore('CHECKPOINT_WORKER_EXIT');
        reject(new Error('CHECKPOINT_WORKER_EXIT'));
      }
    });
  });
  const watchdog = setInterval(() => {
    if (Date.now() - (sample?.atMs ?? startedAtMs) > 15000) restore('CHECKPOINT_HEARTBEAT_STALE');
  }, 5000);
  watchdog.unref();
  return {
    snapshot: () => ({
      mode: background ? 'background' : 'sqlite_auto',
      failure,
      ...sample,
      backlogBytes: sample ? Math.max(0, sample.log - sample.checkpointed) * sample.pageSize : 0
    }),
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(watchdog);
      if (db.open) db.pragma(`wal_autocheckpoint=${previous}`);
      await worker.terminate();
    }
  };
}

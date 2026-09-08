import { Worker } from 'node:worker_threads';
import type { Storage } from '../storage/database.js';

/** SQLite scans and archive filesystem work must not run on the bot's event loop. */
export function measureResearchInBackground(
  storage: Storage,
  directory: string,
  maxBytes: number,
  maintain = false
): Promise<number> {
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const modules = {
    storage: new URL(`../storage/database.${extension}`, import.meta.url).href,
    research: new URL(`./storage.${extension}`, import.meta.url).href,
    archive: new URL(`./archive.${extension}`, import.meta.url).href
  };
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `
      const { parentPort, workerData: d } = require('node:worker_threads');
      (async () => {
        const load = d.typescript
          ? (url) => import('tsx/esm/api').then(m => m.tsImport(url, d.modules.storage))
          : (url) => import(url);
        const { Storage } = await load(d.modules.storage);
        const { ResearchStorage } = await load(d.modules.research);
        const { ResearchArchive } = await load(d.modules.archive);
        const storage = await Storage.open(d.path);
        try {
          const research = new ResearchStorage(storage);
          if (d.maintain) await new ResearchArchive(research, d.directory).maintain(Date.now(), d.maxBytes);
          const bytes = research.estimatedBytes();
          parentPort.postMessage({ bytes });
        } finally { storage.close(); }
      })().catch(() => { parentPort.postMessage({ error: 'RESEARCH_MAINTENANCE_FAILED' }); });
    `,
      {
        eval: true,
        workerData: {
          path: storage.db.name,
          directory,
          maxBytes,
          maintain,
          modules,
          typescript: extension === 'ts'
        }
      }
    );
    let received = false;
    const timeout = setTimeout(() => {
      void worker.terminate();
      reject(new Error('RESEARCH_MAINTENANCE_TIMEOUT'));
    }, 30000);
    worker.once('message', (message: { bytes?: number; error?: string }) => {
      received = true;
      clearTimeout(timeout);
      if (typeof message.bytes === 'number' && Number.isFinite(message.bytes))
        resolve(message.bytes);
      else reject(new Error(message.error ?? 'RESEARCH_MAINTENANCE_FAILED'));
    });
    worker.once('error', (error) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error('RESEARCH_MAINTENANCE_FAILED'));
    });
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0 || !received) reject(new Error('RESEARCH_MAINTENANCE_EXIT'));
    });
  });
}

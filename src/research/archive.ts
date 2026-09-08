import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MarketFact } from '../gmgn/facts.js';
import type { ResearchStorage } from './storage.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export class ResearchArchive {
  constructor(
    private readonly research: ResearchStorage,
    private readonly directory: string
  ) {}
  pin(runId: string, factIds: readonly string[], maxBytes: number): Promise<void> {
    return this.research.storage.transaction(() => {
      if (this.research.estimatedBytes() + factIds.length * 4096 > maxBytes) {
        this.research.storage.db
          .prepare("UPDATE research_runs SET status='INCONCLUSIVE' WHERE run_id=?")
          .run(runId);
        return;
      }
      for (const id of factIds)
        this.research.storage.db
          .prepare('INSERT OR IGNORE INTO research_fact_references(run_id,fact_id) VALUES (?,?)')
          .run(runId, id);
    });
  }
  /** At most 100 payloads/4MiB per call; no network is performed inside the write queue. */
  maintain(nowMs: number, maxBytes: number): Promise<{ pruned: number; archived: number }> {
    return this.research.storage.write(() => {
      const db = this.research.storage.db;
      const pruned = db
        .prepare(
          `DELETE FROM research_facts WHERE fact_id IN (
        SELECT fact_id FROM research_facts f WHERE received_at_ms<?
        AND NOT EXISTS(SELECT 1 FROM research_fact_references r WHERE r.fact_id=f.fact_id)
        AND NOT EXISTS(SELECT 1 FROM market_opportunities o WHERE o.activation_fact_id=f.fact_id)
        AND NOT EXISTS(SELECT 1 FROM evaluation_baselines b WHERE b.fact_id=f.fact_id)
        AND NOT EXISTS(SELECT 1 FROM research_capture_ranges c WHERE c.fact_id=f.fact_id)
        AND archive_id IS NULL LIMIT 100)`
        )
        .run(nowMs - 7 * 86400000).changes;
      const rows = db
        .prepare(
          `SELECT fact_id,payload_json FROM research_facts f WHERE payload_json IS NOT NULL
        AND EXISTS(SELECT 1 FROM research_fact_references r WHERE r.fact_id=f.fact_id) ORDER BY fact_id LIMIT 100`
        )
        .all() as { fact_id: string; payload_json: string }[];
      const selected: typeof rows = [];
      let size = 0;
      for (const row of rows) {
        size += Buffer.byteLength(row.payload_json) + 256;
        if (size > 4 * 1024 ** 2) break;
        selected.push(row);
      }
      if (!selected.length) return { pruned, archived: 0 };
      const text = JSON.stringify(
        Object.fromEntries(selected.map((r) => [r.fact_id, JSON.parse(r.payload_json) as unknown]))
      );
      const bytes = Buffer.byteLength(text),
        id = sha(text);
      if (this.research.estimatedBytes() + bytes + 16384 > maxBytes) {
        db.prepare(
          "UPDATE research_runs SET status='INCONCLUSIVE' WHERE run_id IN (SELECT DISTINCT run_id FROM research_fact_references) AND status='ACTIVE'"
        ).run();
        return { pruned, archived: 0 };
      }
      // Reserve archive bytes durably before filesystem writes. A crash cannot hide
      // an orphan file from the quota; payloads stay online until verification succeeds.
      db.prepare(
        'INSERT OR IGNORE INTO research_archives(archive_id,path,sha256,bytes,created_at_ms) VALUES (?,?,?,?,?)'
      ).run(id, `${id}.json`, id, bytes, nowMs);
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, `${id}.json`);
      try {
        writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }
      if (sha(readFileSync(path, 'utf8')) !== id) throw new Error('archive checksum mismatch');
      db.transaction(() => {
        for (const row of selected)
          db.prepare(
            'UPDATE research_facts SET archive_id=?,payload_json=NULL WHERE fact_id=? AND payload_json IS NOT NULL'
          ).run(id, row.fact_id);
      })();
      return { pruned, archived: selected.length };
    });
  }
  resolve(factId: string): Promise<MarketFact> {
    return this.research.storage.write(() => {
      const row = this.research.storage.db
        .prepare('SELECT envelope_json,payload_json,archive_id FROM research_facts WHERE fact_id=?')
        .get(factId) as
        | { envelope_json: string; payload_json: string | null; archive_id: string | null }
        | undefined;
      if (!row) throw new Error('research fact missing');
      let payload: unknown;
      if (row.payload_json !== null) payload = JSON.parse(row.payload_json) as unknown;
      else {
        if (!row.archive_id || !/^[a-f0-9]{64}$/.test(row.archive_id))
          throw new Error('invalid archive identity');
        const path = join(this.directory, `${row.archive_id}.json`);
        if (statSync(path).size > 4 * 1024 ** 2 + 65536)
          throw new Error('archive exceeds batch bound');
        const text = readFileSync(path, 'utf8');
        if (sha(text) !== row.archive_id) throw new Error('archive checksum mismatch');
        payload = (JSON.parse(text) as Record<string, unknown>)[factId];
        if (payload === undefined) throw new Error('archive fact missing');
      }
      return { ...JSON.parse(row.envelope_json), payload } as MarketFact;
    });
  }
}

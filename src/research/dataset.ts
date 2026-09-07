import { canonicalJson } from '../discovery/events.js';
import type { ResearchStorage } from './storage.js';
import { hashValue, measurementProtocol } from './protocol.js';

export interface DatasetPlan {
  datasetId: string;
  runId: string;
  use: 'development' | 'selection' | 'final';
  startAtMs: number;
  cutoffAtMs: number;
  frozenAtMs: number;
}
export async function freezeDataset(
  research: ResearchStorage,
  plan: DatasetPlan,
  maxBytes = 2 * 1024 ** 3
) {
  if (
    !['development', 'selection', 'final'].includes(plan.use) ||
    ![plan.startAtMs, plan.cutoffAtMs, plan.frozenAtMs].every(Number.isSafeInteger) ||
    plan.startAtMs < 0 ||
    plan.frozenAtMs > Date.now() ||
    plan.cutoffAtMs <= plan.startAtMs ||
    plan.frozenAtMs < plan.cutoffAtMs + measurementProtocol.horizonMs
  )
    throw new Error('DATASET_WINDOW_OR_MATURITY_INVALID');
  return research.storage.transaction(() => {
    const db = research.storage.db;
    const existing = db
      .prepare('SELECT manifest_json FROM research_datasets WHERE dataset_id=?')
      .get(plan.datasetId) as { manifest_json: string } | undefined;
    if (existing) {
      const manifest = JSON.parse(existing.manifest_json) as { plan: DatasetPlan };
      if (canonicalJson(manifest.plan) !== canonicalJson(plan))
        throw new Error('DATASET_ALREADY_FROZEN');
      return JSON.parse(existing.manifest_json) as unknown;
    }
    const run = db
      .prepare('SELECT stage,status,created_at_ms,consumed FROM research_runs WHERE run_id=?')
      .get(plan.runId) as
      { stage: string; status: string; created_at_ms: number; consumed: number } | undefined;
    if (!run || run.consumed || !['ACTIVE', 'CLOSED'].includes(run.status))
      throw new Error('RUN_NOT_ELIGIBLE');
    if (plan.use === 'final' && (run.stage !== 'D' || plan.startAtMs < run.created_at_ms))
      throw new Error('FINAL_RUN_NOT_PREREGISTERED');
    // First seen is across pools: relaunches never masquerade as new independent tokens.
    const universe = db
      .prepare(
        `SELECT chain,token,MIN(first_seen_at_ms) AS first_seen FROM research_universe
      GROUP BY chain,token HAVING MIN(first_seen_at_ms)>=? AND MIN(first_seen_at_ms)<? ORDER BY chain,token`
      )
      .all(plan.startAtMs, plan.cutoffAtMs) as {
      chain: string;
      token: string;
      first_seen: number;
    }[];
    const selected = universe.filter(
      (t) =>
        !db
          .prepare('SELECT 1 FROM dataset_memberships WHERE chain=? AND token=?')
          .get(t.chain, t.token)
    );
    const excluded = universe
      .filter((t) => !selected.includes(t))
      .map((t) => ({ ...t, reason: 'TOKEN_ALREADY_USED' }));
    const facts = selected.flatMap(
      (t) =>
        db
          .prepare(
            `SELECT fact_id,semantic_hash FROM research_facts
      WHERE chain=? AND token=? AND received_at_ms>=? AND received_at_ms<=? ORDER BY received_at_ms,fact_id`
          )
          .all(
            t.chain,
            t.token,
            plan.startAtMs,
            plan.cutoffAtMs + measurementProtocol.horizonMs
          ) as { fact_id: string; semantic_hash: string }[]
    );
    const manifest = {
      version: 1,
      plan,
      tokens: selected,
      excluded,
      facts,
      priceBaselineSupport: 'UNAVAILABLE',
      replayOnly: plan.use !== 'final'
    };
    if (
      research.estimatedBytes() +
        Buffer.byteLength(canonicalJson(manifest)) +
        facts.length * 512 +
        selected.length * 512 +
        16384 >
      maxBytes
    )
      throw new Error('DATASET_STORAGE_BUDGET');
    const hash = hashValue(manifest);
    db.prepare(
      `INSERT INTO research_datasets(dataset_id,run_id,use_group,start_at_ms,cutoff_at_ms,frozen_at_ms,manifest_hash,manifest_json)
      VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      plan.datasetId,
      plan.runId,
      plan.use,
      plan.startAtMs,
      plan.cutoffAtMs,
      plan.frozenAtMs,
      hash,
      canonicalJson(manifest)
    );
    for (const t of selected)
      db.prepare(
        'INSERT INTO dataset_memberships(chain,token,use_group,run_id,dataset_hash) VALUES (?,?,?,?,?)'
      ).run(t.chain, t.token, plan.use, plan.runId, hash);
    for (const f of facts)
      db.prepare('INSERT OR IGNORE INTO research_fact_references(run_id,fact_id) VALUES (?,?)').run(
        plan.runId,
        f.fact_id
      );
    return manifest;
  });
}

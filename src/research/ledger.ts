import type { SqliteDatabase } from '../storage/database.js';
import { hashValue, protocolHash, outcomes, type Outcome } from './protocol.js';
import type { ValidationArm, ValidationPair } from './validation.js';

export interface DatasetManifest {
  plan: { runId: string; use: string; startAtMs: number; cutoffAtMs: number; frozenAtMs: number };
  tokens: { chain: string; token: string }[];
  facts: { fact_id: string; semantic_hash: string }[];
}
/** The CLI derives paired rows from the frozen DB ledger; it never certifies a user-supplied rate/CSV. */
export function pairedLedger(
  db: SqliteDatabase,
  dataset: DatasetManifest,
  modelHash: string,
  controlHash: string,
  diagnostic = false
) {
  const track = diagnostic ? 'decision_market_replay_v1' : 'post_confirmation_market_v1';
  const evidenceIds: string[] = [];
  const arm = (token: string, hash: string): ValidationArm | null => {
    const q = db
      .prepare(
        `SELECT d.opportunity_id,d.decision_id FROM funnel_decisions d JOIN market_opportunities o ON o.opportunity_id=d.opportunity_id
      WHERE d.run_id=? AND o.chain='bsc' AND o.token=? AND o.model_hash=? AND d.evaluation_at_ms>=? AND d.evaluation_at_ms<?
      AND json_extract(d.decision_json,'$.status')='MARKET_QUALIFIED' ORDER BY d.evaluation_at_ms,d.decision_id LIMIT 1`
      )
      .get(dataset.plan.runId, token, hash, dataset.plan.startAtMs, dataset.plan.cutoffAtMs) as
      { opportunity_id: string; decision_id: string } | undefined;
    if (!q) return null;
    evidenceIds.push(q.decision_id);
    const baseline = db
      .prepare(
        `SELECT baseline_id,status,fact_id,confirmation_at_ms,details_json FROM evaluation_baselines
      WHERE run_id=? AND opportunity_id=? AND track=? AND protocol_hash=?`
      )
      .get(dataset.plan.runId, q.opportunity_id, track, protocolHash(track)) as
      | {
          baseline_id: string;
          status: string;
          fact_id: string | null;
          confirmation_at_ms: number | null;
          details_json: string;
        }
      | undefined;
    const allowedFacts = new Set(dataset.facts.map((f) => f.fact_id));
    const valid =
      baseline?.status === 'VALID' &&
      baseline.confirmation_at_ms !== null &&
      baseline.fact_id !== null &&
      (diagnostic ||
        (JSON.parse(baseline.details_json) as { confirmationKind?: string }).confirmationKind ===
          'SIMULATED') &&
      allowedFacts.has(baseline.fact_id);
    const target = (t: number): Outcome => {
      if (!valid || !baseline) return 'MISSING_BASELINE';
      const rows = db
        .prepare(
          `SELECT task_id,result_json FROM research_outcome_tasks WHERE baseline_id=? AND target=? AND status='DONE'
        ORDER BY horizon_at_ms,task_id`
        )
        .all(baseline.baseline_id, String(t)) as { task_id: string; result_json: string | null }[];
      let last: Outcome = 'CENSORED';
      for (const row of rows) {
        if (!row.result_json) continue;
        const r = JSON.parse(row.result_json) as {
          outcome: Outcome;
          factIds?: string[];
          capturedAtMs?: number;
        };
        if (
          !outcomes.includes(r.outcome) ||
          !r.factIds?.length ||
          r.factIds.some((id) => !allowedFacts.has(id)) ||
          !r.capturedAtMs ||
          r.capturedAtMs > dataset.plan.frozenAtMs
        )
          continue;
        evidenceIds.push(row.task_id);
        last = r.outcome;
        if (['TP', 'SL', 'UNKNOWN'].includes(last)) break;
      }
      return last;
    };
    const prep = db
      .prepare(
        "SELECT manifest_hash,manifest_json FROM research_registrations WHERE registration_id=? AND kind='dry_preparation'"
      )
      .get(hashValue([dataset.plan.runId, q.opportunity_id, 'preparation'])) as
      { manifest_hash: string; manifest_json: string } | undefined;
    const raw = prep
      ? (JSON.parse(prep.manifest_json) as {
          result: { status: string; outbox: string | null };
          quotes: { factId: string }[];
        })
      : null;
    if (prep && hashValue(raw) !== prep.manifest_hash) throw new Error('PREPARATION_HASH_MISMATCH');
    const complete = raw?.result.status === 'DRY_READY';
    const snapshot =
      complete && raw.result.outbox
        ? (JSON.parse(raw.result.outbox) as { preparation: { roundTripLoss: string } })
        : null;
    const loss = snapshot ? Number(snapshot.preparation.roundTripLoss) : null;
    const costValid =
      complete &&
      raw.quotes.length >= 2 &&
      raw.quotes.every((f) => allowedFacts.has(f.factId)) &&
      loss !== null &&
      Number.isFinite(loss) &&
      loss >= 0 &&
      loss <= 1;
    const post = db
      .prepare(
        `SELECT fact_id,status FROM evaluation_baselines WHERE run_id=? AND opportunity_id=? AND track='post_confirmation_quote_v1' AND protocol_hash=?`
      )
      .get(dataset.plan.runId, q.opportunity_id, protocolHash('post_confirmation_quote_v1')) as
      { fact_id: string; status: string } | undefined;
    if (!diagnostic && !complete)
      return {
        baselineValid: false,
        tp13: 'MISSING_BASELINE',
        tp2: 'MISSING_BASELINE',
        preparationFailed: true,
        roundTripLoss: null,
        costEvidenceValid: false,
        postBuyValid: false,
        safetyBypassed: false
      };
    return {
      baselineValid: !!valid,
      tp13: target(1.3),
      tp2: target(2),
      preparationFailed: !diagnostic && !complete,
      roundTripLoss: costValid ? loss : null,
      costEvidenceValid: !diagnostic && !!costValid,
      postBuyValid:
        !diagnostic && complete && post?.status === 'VALID' && allowedFacts.has(post.fact_id),
      safetyBypassed: false
    };
  };
  const pairs: ValidationPair[] = dataset.tokens.map((t) => {
    if (t.chain !== 'bsc' || !/^0x[a-f0-9]{40}$/.test(t.token))
      throw new Error('DATASET_TOKEN_INVALID');
    return { token: t.token, model: arm(t.token, modelHash), control: arm(t.token, controlHash) };
  });
  return { pairs, evidenceHash: hashValue(evidenceIds.sort()) };
}

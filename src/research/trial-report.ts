import type { SqliteDatabase } from '../storage/database.js';
import { outcomes, type Outcome } from './protocol.js';

/** Read-only, aggregate report. Trial card diagnostics never become a promotion certificate. */
export function trialReport(db: SqliteDatabase, runId: string) {
  const run = db
    .prepare('SELECT manifest_json,status,created_at_ms FROM research_runs WHERE run_id=?')
    .get(runId) as { manifest_json: string; status: string; created_at_ms: number } | undefined;
  if (!run) throw new Error('TRIAL_RUN_NOT_FOUND');
  const manifest = JSON.parse(run.manifest_json) as {
    engine?: string;
    model?: { id?: string };
    codeHash?: string;
  };
  if (manifest.engine !== 'trial') throw new Error('NOT_A_TRIAL_RUN');
  const signals = db
    .prepare(
      "SELECT id,delivery_state,json_extract(decision_json,'$.context.opportunityId') AS opportunityId FROM signals WHERE decision_format='opportunity-v1' AND json_extract(decision_json,'$.runId')=?"
    )
    .all(runId) as { id: string; delivery_state: string; opportunityId: string }[];
  const delivered = signals.filter((s) => s.delivery_state === 'SENT');
  const deliveryCounts: Record<string, number> = {};
  for (const s of signals)
    deliveryCounts[s.delivery_state] = (deliveryCounts[s.delivery_state] ?? 0) + 1;
  const resultTargets = [1.3, 1.5, 2, 3].map((target) => {
    const counts = Object.fromEntries(outcomes.map((o) => [o, 0])) as Record<Outcome, number>;
    for (const signal of delivered) {
      const baseline = db
        .prepare(
          "SELECT baseline_id,status FROM evaluation_baselines WHERE run_id=? AND opportunity_id=? AND track='trial_card_reference_v1'"
        )
        .get(runId, signal.opportunityId) as { baseline_id: string; status: string } | undefined;
      if (!baseline || baseline.status !== 'VALID') {
        counts.MISSING_BASELINE++;
        continue;
      }
      const rows = db
        .prepare(
          'SELECT result_json FROM research_outcome_tasks WHERE baseline_id=? AND target=? AND result_json IS NOT NULL ORDER BY horizon_at_ms'
        )
        .all(baseline.baseline_id, String(target)) as { result_json: string }[];
      const results = rows.map((r) => JSON.parse(r.result_json) as { outcome?: Outcome });
      const certain = results.find((r) => r.outcome === 'TP' || r.outcome === 'SL');
      const outcome = certain?.outcome ?? results.at(-1)?.outcome ?? 'CENSORED';
      counts[outcomes.includes(outcome) ? outcome : 'UNKNOWN']++;
    }
    const n = delivered.length,
      known = counts.TP + counts.SL;
    return {
      target,
      stopMultiple: 0.9,
      all: n,
      counts,
      confirmedSuccessProportion: n ? counts.TP / n : null,
      conditionalHitRate: known ? counts.TP / known : null
    };
  });
  const reasons = db
    .prepare(
      "SELECT json_extract(metadata_json,'$.reason') AS reason,COUNT(*) AS count,COUNT(DISTINCT json_extract(metadata_json,'$.token')) AS tokens,COUNT(DISTINCT json_extract(metadata_json,'$.opportunityId')) AS opportunities FROM operation_traces WHERE stage='trial_funnel' AND occurred_at_ms>=? AND json_extract(metadata_json,'$.runId')=? GROUP BY reason ORDER BY count DESC"
    )
    .all(run.created_at_ms, runId);
  const coverage = db
    .prepare(
      `WITH t AS (
    SELECT json_extract(metadata_json,'$.token') AS token,
      MAX(json_extract(metadata_json,'$.reason') IN ('QUEUED','WATCHED','RESOURCE_EXCLUDED')) AS discovered,
      MAX(json_extract(metadata_json,'$.reason')='WATCHED') AS observed,
      MAX(json_extract(metadata_json,'$.reason')='INFO_OBSERVED') AS fetched,
      MAX(json_extract(metadata_json,'$.reason')='WAITING_EXPIRED') AS expired
    FROM operation_traces WHERE stage='trial_funnel' AND occurred_at_ms>=? AND json_extract(metadata_json,'$.runId')=?
    GROUP BY token)
    SELECT COALESCE(SUM(discovered),0) AS discoveredTokens,COALESCE(SUM(observed),0) AS observedTokens,
      COALESCE(SUM(fetched),0) AS infoFetchedTokens,
      COALESCE(SUM(discovered AND NOT observed),0) AS neverObservedTokens,
      COALESCE(SUM(expired AND NOT observed),0) AS expiredNeverObservedTokens FROM t`
    )
    .get(run.created_at_ms, runId);
  const quoteBaselines = db
    .prepare(
      "SELECT status,COUNT(*) AS count FROM evaluation_baselines WHERE run_id=? AND track='post_confirmation_quote_v1' GROUP BY status"
    )
    .all(runId);
  const quoteExits = db
    .prepare(
      "SELECT e.status,COUNT(*) AS count,SUM(CASE WHEN json_extract(e.result_json,'$.multiple') IS NOT NULL THEN 1 ELSE 0 END) AS measured FROM research_quote_exits e JOIN evaluation_baselines b ON b.baseline_id=e.baseline_id WHERE b.run_id=? GROUP BY e.status"
    )
    .all(runId);
  return {
    runId,
    modelId: manifest.model?.id,
    codeHash: manifest.codeHash,
    status: run.status,
    validation: 'UNVALIDATED_TRIAL',
    promotionCertificate: false,
    deliveryCounts,
    coverage,
    reasons,
    cardReference: {
      label: '相对冻结卡片参考价的诊断；来源时钟未知，不代表确认后可成交收益',
      targets: resultTargets
    },
    postConfirmationMarket: { status: 'UNVERIFIED', reason: 'PRICE_SOURCE_TIME_UNVERIFIED' },
    postConfirmationQuote: {
      label: '确认后同数量报价模拟，非真实成交',
      baselines: quoteBaselines,
      exits: quoteExits
    }
  };
}

import { decimalValue, type MarketFact } from '../gmgn/facts.js';
import type { MarketScreen } from '../decision/market-screen.js';
import type { RiskFinding } from '../decision/risk-screen.js';
import type { Storage } from '../storage/database.js';
import { hashValue, protocolHash } from './protocol.js';

/** First eligible market observation, including rejected tokens. Never creates a delivery. */
export class TrialCohort {
  constructor(
    private readonly storage: Storage,
    private readonly runId: string,
    private readonly modelHash: string,
    private readonly capacity = 20
  ) {}
  register(fact: MarketFact, screen: MarketScreen, risk: RiskFinding | null) {
    if (screen.activation !== 'PASS') return Promise.resolve(null);
    if (
      screen.factId !== fact.factId ||
      !decimalValue(screen.values.price)?.gt(0) ||
      fact.endpoint !== 'info' ||
      !fact.token ||
      fact.poolRevision === 'unresolved' ||
      !Number.isSafeInteger(screen.atMs) ||
      screen.atMs < fact.receivedAtMs
    )
      return Promise.reject(new Error('CANDIDATE_BASELINE_IDENTITY'));
    const key = hashValue(['candidate_reference_v1', this.runId, fact.token, fact.poolRevision]);
    return this.storage.transaction(() => {
      const db = this.storage.db;
      const previous = db
        .prepare('SELECT baseline_id FROM research_trial_cohorts WHERE cohort_id=?')
        .get(key) as { baseline_id: string | null } | undefined;
      if (previous) return null;
      const active = db
        .prepare(
          `SELECT COUNT(*) n FROM evaluation_baselines b
        WHERE track='candidate_reference_v1' AND status='VALID' AND available_at_ms>?
        AND (SELECT COUNT(DISTINCT target) FROM research_outcome_tasks t
          WHERE t.baseline_id=b.baseline_id AND (json_extract(result_json,'$.outcome') IN ('TP','SL')
          OR (json_extract(result_json,'$.outcome')='UNKNOWN' AND json_extract(result_json,'$.reason')
          IN ('BOUNDARY_TOUCH_ORDER','SAME_CANDLE_ORDER','CONFLICTING_CANDLE'))))<4`
        )
        .get(screen.atMs - 86400000) as { n: number };
      const selected = active.n < this.capacity;
      const id = selected ? hashValue([key, 'baseline']) : null;
      if (selected) {
        const diagnosticModel = hashValue(['candidate_reference_v1', this.modelHash]);
        db.prepare(
          `INSERT INTO market_opportunities
          (opportunity_id,chain,token,pool_revision,model_hash,activation_fact_id,anchor_price,anchor_at_ms,state,version,reason,state_json)
          VALUES (?,'bsc',?,?,?,?,?,?,'START_CANDIDATE',1,'CANDIDATE_DIAGNOSTIC',?)`
        ).run(
          key,
          fact.token,
          fact.poolRevision,
          diagnosticModel,
          fact.factId,
          screen.values.price,
          screen.atMs,
          JSON.stringify({
            diagnostic: true,
            token: fact.token,
            poolRevision: fact.poolRevision,
            modelHash: diagnosticModel,
            activationFactId: fact.factId,
            anchorPrice: screen.values.price,
            anchorAtMs: screen.atMs
          })
        );
        db.prepare(
          `INSERT INTO evaluation_baselines
          (baseline_id,run_id,opportunity_id,track,protocol_hash,confirmation_at_ms,deadline_at_ms,status,reason,price,available_at_ms,fact_id,details_json)
          VALUES (?,?,?,'candidate_reference_v1',?,?,?,'VALID','UNVERIFIED_SOURCE_CANDIDATE_DIAGNOSTIC',?,?,?,?)`
        ).run(
          id,
          this.runId,
          key,
          protocolHash('candidate_reference_v1'),
          screen.atMs,
          screen.atMs,
          screen.values.price,
          screen.atMs,
          fact.factId,
          JSON.stringify({ confirmationKind: 'DECISION', sourceAtMs: null })
        );
      }
      db.prepare(
        `INSERT INTO research_trial_cohorts
        (cohort_id,run_id,token,pool_revision,decision_at_ms,baseline_id,status,screen_json,risk_json)
        VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(
        key,
        this.runId,
        fact.token,
        fact.poolRevision,
        screen.atMs,
        id,
        selected ? 'SELECTED' : 'RESOURCE_EXCLUDED',
        JSON.stringify(screen),
        JSON.stringify(risk)
      );
      return id;
    });
  }
}

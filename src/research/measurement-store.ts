import type { Storage } from '../storage/database.js';
import { canonicalJson } from '../discovery/events.js';
import {
  hashValue,
  protocolHash,
  measurementProtocol as p,
  type BaselineTrack
} from './protocol.js';
import type { BaselineValue } from './measurement.js';
import { decimalValue } from '../gmgn/facts.js';

/** All baseline and task transitions share the same SQLite writer and immutable coordinates. */
export class MeasurementStore {
  constructor(private readonly storage: Storage) {}
  missingPreparation(runId: string, opportunityId: string, decisionAtMs: number) {
    if (!Number.isSafeInteger(decisionAtMs) || decisionAtMs < 0)
      throw new Error('INVALID_PREPARATION_TIME');
    return this.storage.transaction(() => {
      const ids = {} as Record<'marketId' | 'quoteId' | 'cardId', string>;
      for (const [key, track] of [
        ['marketId', 'post_confirmation_market_v1'],
        ['quoteId', 'post_confirmation_quote_v1'],
        ['cardId', 'card_reference_legacy']
      ] as const) {
        const id = hashValue([runId, opportunityId, track, protocolHash(track)]);
        ids[key] = id;
        const prior = this.storage.db
          .prepare(
            'SELECT confirmation_at_ms,deadline_at_ms,reason FROM evaluation_baselines WHERE baseline_id=?'
          )
          .get(id) as
          { confirmation_at_ms: number | null; deadline_at_ms: number; reason: string } | undefined;
        if (
          prior &&
          (prior.confirmation_at_ms !== null ||
            prior.deadline_at_ms !== decisionAtMs ||
            prior.reason !== 'MISSING_PREPARATION')
        )
          throw new Error('BASELINE_CONFIRMATION_CHANGED');
        this.storage.db
          .prepare(
            `INSERT OR IGNORE INTO evaluation_baselines(baseline_id,run_id,opportunity_id,track,protocol_hash,
          confirmation_at_ms,deadline_at_ms,status,reason,details_json) VALUES (?,?,?,?,?,NULL,?,'MISSING','MISSING_PREPARATION',?)`
          )
          .run(
            id,
            runId,
            opportunityId,
            track,
            protocolHash(track),
            decisionAtMs,
            canonicalJson({ confirmationKind: 'NONE', decisionAtMs })
          );
      }
      return ids;
    });
  }
  isPending(id: string): Promise<boolean> {
    return this.storage.write(() =>
      Boolean(
        this.storage.db
          .prepare("SELECT 1 FROM evaluation_baselines WHERE baseline_id=? AND status='PENDING'")
          .get(id)
      )
    );
  }
  claimBaselineAttempt(id: string, nowMs: number): Promise<boolean> {
    return this.storage.transaction(() => {
      const row = this.storage.db
        .prepare(
          "SELECT track,deadline_at_ms,confirmation_at_ms FROM evaluation_baselines WHERE baseline_id=? AND status='PENDING'"
        )
        .get(id) as
        { track: string; deadline_at_ms: number; confirmation_at_ms: number } | undefined;
      if (!row || nowMs < row.confirmation_at_ms || nowMs >= row.deadline_at_ms) return false;
      const count = (
        this.storage.db
          .prepare('SELECT COUNT(*) AS n FROM research_baseline_attempts WHERE baseline_id=?')
          .get(id) as { n: number }
      ).n;
      const maximum =
        row.track === 'post_confirmation_market_v1' ? p.marketAttempts : p.quoteAttempts;
      if (count >= maximum) return false;
      this.storage.db
        .prepare('INSERT INTO research_baseline_attempts VALUES (?,?,?)')
        .run(id, count + 1, nowMs);
      return true;
    });
  }
  begin(input: {
    runId: string;
    opportunityId: string;
    track: BaselineTrack;
    confirmationAtMs: number;
    confirmationKind: 'ACTUAL' | 'SIMULATED' | 'DECISION';
  }) {
    if (
      !Number.isSafeInteger(input.confirmationAtMs) ||
      input.confirmationAtMs < 0 ||
      (input.track === 'decision_market_replay_v1') !== (input.confirmationKind === 'DECISION')
    )
      throw new Error('BASELINE_CONFIRMATION_PROTOCOL');
    const id = hashValue([
      input.runId,
      input.opportunityId,
      input.track,
      protocolHash(input.track)
    ]);
    return this.storage.transaction(() => {
      const prior = this.storage.db
        .prepare(
          'SELECT confirmation_at_ms,details_json FROM evaluation_baselines WHERE baseline_id=?'
        )
        .get(id) as { confirmation_at_ms: number; details_json: string } | undefined;
      const details = canonicalJson({ confirmationKind: input.confirmationKind });
      if (
        prior &&
        (prior.confirmation_at_ms !== input.confirmationAtMs ||
          (JSON.parse(prior.details_json) as { confirmationKind: string }).confirmationKind !==
            input.confirmationKind)
      )
        throw new Error('BASELINE_CONFIRMATION_CHANGED');
      this.storage.db
        .prepare(
          `INSERT OR IGNORE INTO evaluation_baselines(baseline_id,run_id,opportunity_id,track,protocol_hash,confirmation_at_ms,deadline_at_ms,status,details_json)
        VALUES (?,?,?,?,?,?,?,'PENDING',?)`
        )
        .run(
          id,
          input.runId,
          input.opportunityId,
          input.track,
          protocolHash(input.track),
          input.confirmationAtMs,
          input.confirmationAtMs +
            (input.track === 'decision_market_replay_v1' ? 0 : p.baselineDeadlineMs),
          details
        );
      return id;
    });
  }
  settle(id: string, value: BaselineValue) {
    if (value.status === 'PENDING') return Promise.resolve(false);
    if (
      value.status === 'VALID' &&
      (!decimalValue(value.price)?.gt(0) || !Number.isSafeInteger(value.availableAtMs))
    )
      return Promise.reject(new Error('INVALID_BASELINE_VALUE'));
    return this.storage.write(
      () =>
        this.storage.db
          .prepare(
            `UPDATE evaluation_baselines SET status=?,reason=?,price=?,available_at_ms=?,fact_id=?,
      details_json=json_set(details_json,'$.sourceAtMs',?) WHERE baseline_id=? AND status='PENDING'
      AND (?!='VALID' OR track='card_reference_legacy' OR (? IS NOT NULL AND ?>=confirmation_at_ms AND ?<=deadline_at_ms))`
          )
          .run(
            value.status,
            value.reason,
            value.price,
            value.availableAtMs,
            value.factId,
            value.sourceAtMs,
            id,
            value.status,
            value.availableAtMs,
            value.availableAtMs,
            value.availableAtMs
          ).changes === 1
    );
  }
  recover(nowMs: number) {
    return this.storage.write(() => {
      this.storage.db
        .prepare(
          `UPDATE research_outcome_tasks SET
        status=CASE WHEN attempts<3 THEN 'PENDING' ELSE 'DONE' END,
        result_json=CASE WHEN attempts<3 THEN result_json ELSE '{"outcome":"CENSORED","reason":"CAPTURE_RESTART_EXHAUSTED"}' END
        WHERE status='RUNNING'`
        )
        .run();
      return this.storage.db
        .prepare(
          `UPDATE evaluation_baselines SET status='MISSING',reason='BASELINE_DEADLINE_EXPIRED'
      WHERE status='PENDING' AND deadline_at_ms<=?`
        )
        .run(nowMs).changes;
    });
  }
  schedule(baselineId: string, target: number, observationAtMs: number, dueAtMs: number) {
    if (
      !p.targets.includes(target as 1.3 | 1.5 | 2 | 3) ||
      !Number.isSafeInteger(observationAtMs) ||
      !Number.isSafeInteger(dueAtMs) ||
      dueAtMs < observationAtMs
    )
      return Promise.reject(new Error('INVALID_OUTCOME_COORDINATES'));
    const id = hashValue([baselineId, target, observationAtMs, 'market']);
    return this.storage.transaction(() => {
      const existing = this.storage.db
        .prepare('SELECT task_id FROM research_outcome_tasks WHERE task_id=?')
        .get(id);
      if (existing) return id;
      const baseline = this.storage.db
        .prepare(
          "SELECT available_at_ms FROM evaluation_baselines WHERE baseline_id=? AND status='VALID'"
        )
        .get(baselineId) as { available_at_ms: number } | undefined;
      if (
        !baseline ||
        observationAtMs <= baseline.available_at_ms ||
        observationAtMs > baseline.available_at_ms + p.horizonMs
      )
        throw new Error('OUTCOME_OUTSIDE_BASELINE_HORIZON');
      const active = this.storage.db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM research_outcome_tasks WHERE status IN ('PENDING','RUNNING')) + (SELECT COUNT(*) FROM research_quote_exits WHERE status IN ('PENDING','RUNNING')) AS n"
        )
        .get() as { n: number };
      this.storage.db
        .prepare(
          `INSERT INTO research_outcome_tasks(task_id,baseline_id,target,horizon_at_ms,task_kind,due_at_ms,status)
        VALUES (?,?,?,?,'market',?,?)`
        )
        .run(
          id,
          baselineId,
          String(target),
          observationAtMs,
          dueAtMs,
          active.n >= p.hotTasks ? 'RESOURCE_EXCLUDED' : 'PENDING'
        );
      return id;
    });
  }
  claim(id: string, nowMs: number) {
    return this.storage.write(
      () =>
        this.storage.db
          .prepare(
            `UPDATE research_outcome_tasks SET attempts=attempts+1,status='RUNNING'
      WHERE task_id=? AND status='PENDING' AND due_at_ms<=? AND attempts<3`
          )
          .run(id, nowMs).changes === 1
    );
  }
  finish(id: string, result: unknown, retryAtMs?: number) {
    return this.storage.write(
      () =>
        this.storage.db
          .prepare(
            `UPDATE research_outcome_tasks SET
      status=CASE WHEN ? IS NOT NULL AND attempts<3 THEN 'PENDING' ELSE 'DONE' END,
      due_at_ms=COALESCE(?,due_at_ms),result_json=? WHERE task_id=? AND status='RUNNING'`
          )
          .run(retryAtMs ?? null, retryAtMs ?? null, canonicalJson(result), id).changes === 1
    );
  }
}

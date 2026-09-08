import type { Storage } from '../storage/database.js';
import { hashValue, measurementProtocol as p } from './protocol.js';
import { pairedQuoteReturn, type QuoteObservation } from './measurement.js';

export class QuoteExitCollector {
  private running = false;
  constructor(
    private readonly storage: Storage,
    private readonly now: () => number,
    private readonly sell: (
      opportunityId: string,
      buy: QuoteObservation
    ) => Promise<QuoteObservation>
  ) {}
  async schedule(baselineId: string, kind: string, atMs: number) {
    if (!Number.isSafeInteger(atMs) || !/^(audit60s|target_(1\.3|1\.5|2|3))$/.test(kind))
      throw new Error('EXIT_COORDINATES');
    return this.storage.transaction(() => {
      const db = this.storage.db;
      const b = db
        .prepare(
          "SELECT available_at_ms FROM evaluation_baselines WHERE baseline_id=? AND track='post_confirmation_quote_v1' AND status='VALID'"
        )
        .get(baselineId) as { available_at_ms: number } | undefined;
      if (!b || atMs < b.available_at_ms || atMs > b.available_at_ms + p.horizonMs) return false;
      const n = (
        db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM research_quote_exits WHERE status IN ('PENDING','RUNNING'))+
        (SELECT COUNT(*) FROM research_outcome_tasks WHERE status IN ('PENDING','RUNNING')) AS n`
          )
          .get() as { n: number }
      ).n;
      return (
        db
          .prepare('INSERT OR IGNORE INTO research_quote_exits VALUES (?,?,?,?,?,NULL)')
          .run(
            hashValue([baselineId, kind]),
            baselineId,
            atMs,
            kind,
            n >= p.hotTasks ? 'RESOURCE_EXCLUDED' : 'PENDING'
          ).changes === 1
      );
    });
  }
  recover() {
    return this.storage.write(
      () =>
        this.storage.db
          .prepare(
            `UPDATE research_quote_exits SET status='DONE',
      result_json='{"reason":"RESTART_AFTER_EXIT_ATTEMPT","multiple":null}' WHERE status='RUNNING'`
          )
          .run().changes
    );
  }
  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const row = await this.storage.transaction(() => {
        const row = this.storage.db
          .prepare(
            `SELECT e.*,b.opportunity_id,b.run_id,b.available_at_ms,b.fact_id FROM research_quote_exits e
          JOIN evaluation_baselines b ON b.baseline_id=e.baseline_id WHERE e.status='PENDING' AND e.observation_at_ms<=?
          ORDER BY e.observation_at_ms,e.exit_id LIMIT 1`
          )
          .get(this.now()) as
          | {
              exit_id: string;
              fact_id: string;
              observation_at_ms: number;
              opportunity_id: string;
              run_id: string;
              available_at_ms: number;
            }
          | undefined;
        if (row)
          this.storage.db
            .prepare(
              "UPDATE research_quote_exits SET status='RUNNING' WHERE exit_id=? AND status='PENDING'"
            )
            .run(row.exit_id);
        return row;
      });
      if (!row) return false;
      let result: unknown = {
        multiple: null,
        reason: 'EXIT_RESOURCE_OR_DATA_MISSING',
        observationAtMs: row.observation_at_ms
      };
      try {
        if (this.now() > row.available_at_ms + p.horizonMs) throw new Error('EXIT_HORIZON_EXPIRED');
        const original = (await this.storage.write(() =>
          this.storage.db
            .prepare('SELECT manifest_json FROM research_registrations WHERE registration_id=?')
            .get(hashValue([row.run_id, row.opportunity_id, 'baseline_quotes']))
        )) as { manifest_json: string } | undefined;
        const buys = original ? (JSON.parse(original.manifest_json) as QuoteObservation[]) : [];
        const buy = buys.find((q) => q.direction === 'buy' && q.factId === row.fact_id);
        if (!buy) throw new Error('BASELINE_QUOTE_MISSING');
        const sell = await this.sell(row.opportunity_id, buy);
        const multiple = pairedQuoteReturn(buy, sell);
        result = {
          multiple,
          reason: multiple === null ? 'EXIT_PAIR_INVALID' : 'SIMULATED_EXIT_NOT_FILL',
          observationAtMs: row.observation_at_ms,
          availableAtMs: sell.receivedAtMs,
          lateByMs: Math.max(0, sell.receivedAtMs - row.observation_at_ms),
          buyFactId: buy.factId,
          sell
        };
      } catch {
        /* Keep explicit missing outcome; no logical-time retry. */
      }
      await this.storage.write(() =>
        this.storage.db
          .prepare(
            "UPDATE research_quote_exits SET status='DONE',result_json=? WHERE exit_id=? AND status='RUNNING'"
          )
          .run(JSON.stringify(result), row.exit_id)
      );
      return true;
    } finally {
      this.running = false;
    }
  }
}

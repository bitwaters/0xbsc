import { dirname, join } from 'node:path';
import type { MarketFact } from '../gmgn/facts.js';
import { GmgnError } from '../gmgn/errors.js';
import type { ResearchStorage } from './storage.js';
import { ResearchArchive } from './archive.js';
import { MeasurementStore } from './measurement-store.js';
import {
  firstTouch,
  observationCoordinates,
  type BaselineValue,
  type PathCandle
} from './measurement.js';
import { hashValue, measurementProtocol as p } from './protocol.js';

interface TaskRow {
  task_id: string;
  baseline_id: string;
  target: string;
  horizon_at_ms: number;
  attempts: number;
  token: string;
  pool_revision: string;
  run_id: string;
  price: string;
  available_at_ms: number;
  fact_id: string;
  details_json: string;
}
export class OutcomeCollector {
  private running = false;
  private readonly store: MeasurementStore;
  private readonly archive: ResearchArchive;
  constructor(
    private readonly research: ResearchStorage,
    private readonly now: () => number,
    private readonly capture: (
      token: string,
      pool: string,
      fromMs: number,
      toMs: number
    ) => Promise<MarketFact>,
    private readonly onTouch?: (
      marketBaselineId: string,
      target: number,
      atMs: number
    ) => Promise<void>,
    private readonly scope: 'all' | 'published' | 'candidates' = 'all'
  ) {
    this.store = new MeasurementStore(research.storage);
    this.archive = new ResearchArchive(
      research,
      join(dirname(research.storage.db.name), 'research-archives')
    );
  }
  /** Enqueue only the next cadence, rather than occupying the bounded queue with an entire day. */
  async scheduleNext(baselineId: string) {
    if (
      this.research.storage.db
        .prepare(
          `SELECT 1 FROM research_outcome_tasks
      WHERE baseline_id=? AND status IN ('PENDING','RUNNING') LIMIT 1`
        )
        .get(baselineId)
    )
      return;
    const row = (await this.research.storage.write(() =>
      this.research.storage.db
        .prepare(
          `SELECT available_at_ms,track,
      (SELECT MAX(horizon_at_ms) FROM research_outcome_tasks WHERE baseline_id=b.baseline_id) AS last
      FROM evaluation_baselines b WHERE baseline_id=? AND status='VALID'`
        )
        .get(baselineId)
    )) as { available_at_ms: number; track: string; last: number | null } | undefined;
    if (
      !row ||
      ![
        'post_confirmation_market_v1',
        'decision_market_replay_v1',
        'trial_card_reference_v1',
        'candidate_reference_v1'
      ].includes(row.track)
    )
      return;
    const next = observationCoordinates(row.available_at_ms).find(
      (at) => at > (row.last ?? row.available_at_ms)
    );
    if (next === undefined) return;
    for (const target of p.targets) {
      const resolved = this.research.storage.db
        .prepare(
          `SELECT 1 FROM research_outcome_tasks
        WHERE baseline_id=? AND target=? AND (json_extract(result_json,'$.outcome') IN ('TP','SL')
        OR (json_extract(result_json,'$.outcome')='UNKNOWN' AND json_extract(result_json,'$.reason')
        IN ('BOUNDARY_TOUCH_ORDER','SAME_CANDLE_ORDER','CONFLICTING_CANDLE'))) LIMIT 1`
        )
        .get(baselineId, String(target));
      if (!resolved)
        await this.store.schedule(baselineId, target, next, Math.ceil(next / 30000) * 30000 + 1000);
    }
  }
  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      const task = (await this.research.storage.write(() =>
        this.research.storage.db
          .prepare(
            `SELECT t.*,b.run_id,b.price,b.available_at_ms,b.fact_id,b.details_json,o.token,o.pool_revision
        FROM research_outcome_tasks t JOIN evaluation_baselines b ON b.baseline_id=t.baseline_id
        JOIN market_opportunities o ON o.opportunity_id=b.opportunity_id
        WHERE t.status='PENDING' AND t.task_kind='market' AND t.due_at_ms<=?
        AND (?='all' OR (?='candidates' AND b.track='candidate_reference_v1')
          OR (?='published' AND b.track!='candidate_reference_v1'))
        ORDER BY t.due_at_ms,t.task_id LIMIT 1`
          )
          .get(this.now(), this.scope, this.scope, this.scope)
      )) as TaskRow | undefined;
      if (!task || !(await this.store.claim(task.task_id, this.now()))) return false;
      const end = task.available_at_ms + p.horizonMs;
      if (this.now() > end + 7200000) {
        await this.store.finish(task.task_id, {
          outcome: 'CENSORED',
          reason: 'CAPTURE_DEADLINE_EXPIRED'
        });
        return true;
      }
      const from = Math.floor(task.available_at_ms / 30000) * 30000;
      const to = Math.ceil(task.horizon_at_ms / 30000) * 30000;
      // Bound each request to the API's list capacity; stored segments are reused across all targets.
      const segments: { from: number; to: number }[] = [];
      for (let cursor = from; cursor < to; cursor += 1800000)
        segments.push({ from: cursor, to: Math.min(cursor + 1800000, to) });
      const facts: MarketFact[] = [];
      let captures = 0;
      try {
        for (const segment of segments) {
          const key = hashValue([
            'closed-candle-v2',
            'bsc',
            task.token,
            task.pool_revision,
            segment.from,
            segment.to,
            '30s'
          ]);
          const cached = (await this.research.storage.write(() =>
            this.research.storage.db
              .prepare('SELECT fact_id FROM research_capture_ranges WHERE cache_key=?')
              .get(key)
          )) as { fact_id: string } | undefined;
          if (cached) {
            facts.push(await this.archive.resolve(cached.fact_id));
            continue;
          }
          // One new physical capture per task attempt; retries cannot silently multiply the three-capture bound.
          if (captures >= 1) continue;
          captures++;
          const fact = await this.capture(task.token, task.pool_revision, segment.from, segment.to);
          if (
            fact.endpoint !== 'kline' ||
            fact.token !== task.token ||
            fact.poolRevision !== task.pool_revision ||
            fact.request.from !== segment.from ||
            fact.request.to !== segment.to ||
            fact.request.resolution !== '30s' ||
            fact.receivedAtMs > this.now()
          )
            throw new Error('OUTCOME_FACT_IDENTITY');
          if (!(await this.research.recordFact(fact, task.run_id, 2 * 1024 ** 3))) {
            const existing = await this.research.storage.write(() =>
              this.research.storage.db
                .prepare('SELECT 1 FROM research_facts WHERE fact_id=?')
                .get(fact.factId)
            );
            if (!existing) throw new Error('CAPTURE_STORAGE_EXCLUDED');
          }
          await this.archive.pin(task.run_id, [fact.factId], 2 * 1024 ** 3);
          const rows = Array.isArray(fact.payload.list)
            ? (fact.payload.list as Record<string, unknown>[])
            : [];
          const times = rows
            .map((c) => {
              const t = Number(c.time);
              return t;
            })
            .sort((a, b) => a - b);
          if (
            !fact.qualityFlags.length &&
            segment.to <= fact.requestedAtMs &&
            times[0] === segment.from &&
            times.at(-1)! + 30000 === segment.to &&
            times.every((at, i) => at === segment.from + i * 30000)
          )
            await this.research.storage.write(() =>
              this.research.storage.db
                .prepare('INSERT OR IGNORE INTO research_capture_ranges VALUES (?,?,?,?,?,?,?,?)')
                .run(
                  key,
                  'bsc',
                  task.token,
                  task.pool_revision,
                  segment.from,
                  segment.to,
                  fact.receivedAtMs,
                  fact.factId
                )
            );
          facts.push(fact);
        }
        const candles: PathCandle[] = facts
          .filter((f) => !f.qualityFlags.length)
          .flatMap((f) => {
            const rows = Array.isArray(f.payload.list)
              ? (f.payload.list as Record<string, unknown>[])
              : [];
            return rows.map((c) => {
              const time = Number(c.time);
              const startMs = time;
              return {
                startMs,
                endMs: startMs + 30000,
                receivedAtMs: f.receivedAtMs,
                open: String(c.open),
                high: String(c.high),
                low: String(c.low),
                close: String(c.close)
              };
            });
          });
        const baseline: BaselineValue = {
          status: 'VALID',
          reason: 'FROZEN',
          price: task.price,
          availableAtMs: task.available_at_ms,
          sourceAtMs: (JSON.parse(task.details_json) as { sourceAtMs?: number }).sourceAtMs ?? null,
          factId: task.fact_id
        };
        const result = firstTouch(baseline, Number(task.target), candles, this.now());
        if (['TP', 'SL'].includes(result.outcome))
          await this.onTouch?.(task.baseline_id, Number(task.target), this.now());
        const incomplete =
          ['UNKNOWN', 'CENSORED'].includes(result.outcome) &&
          (facts.length < segments.length || candles.length * 30000 < to - from);
        await this.store.finish(
          task.task_id,
          {
            ...result,
            observationAtMs: task.horizon_at_ms,
            capturedAtMs: this.now(),
            factIds: facts.map((f) => f.factId)
          },
          incomplete ? this.now() + 1000 : undefined
        );
      } catch (error) {
        const cause =
          error instanceof GmgnError
            ? `API_${error.kind}`
            : error instanceof Error &&
                [
                  'EXECUTION_NOT_EVALUATED_RESOURCE',
                  'RESEARCH_ADMISSION_DISABLED',
                  'OUTCOME_POOL_CHANGED',
                  'CAPTURE_STORAGE_EXCLUDED',
                  'OUTCOME_FACT_IDENTITY'
                ].includes(error.message)
              ? error.message
              : 'CAPTURE_ERROR';
        await this.store.finish(
          task.task_id,
          {
            outcome: 'CENSORED',
            reason: 'CAPTURE_UNAVAILABLE',
            cause,
            observationAtMs: task.horizon_at_ms
          },
          this.now() + 1000
        );
      }
      const pending = await this.research.storage.write(() =>
        this.research.storage.db
          .prepare(
            `SELECT 1 FROM research_outcome_tasks WHERE baseline_id=?
        AND horizon_at_ms=? AND status IN ('PENDING','RUNNING')`
          )
          .get(task.baseline_id, task.horizon_at_ms)
      );
      if (!pending) await this.scheduleNext(task.baseline_id);
      return true;
    } finally {
      this.running = false;
    }
  }
}

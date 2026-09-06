import type { ApiObservation } from '../gmgn/client.js';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { NormalizedEvent } from '../discovery/events.js';
import type { RouteName } from '../config/types.js';

export type SqliteDatabase = Database.Database;

export interface RecoveryState {
  activeEpisodes: Array<{
    id: string;
    chain: 'bsc';
    tokenAddress: string;
    route: string;
    state: string;
    nextEvaluationAtMs: number | null;
  }>;
  pendingOutbox: Array<{
    id: string;
    episodeId: string;
    deliveryState: string;
    retryCount: number;
  }>;
  dueResultTasks: Array<{
    id: number;
    episodeId: string;
    signalId: string | null;
    taskKind: string;
    dueAtMs: number;
  }>;
  snapshots: Array<{
    source: string;
    pollKey: string;
    tokenAddress: string;
    snapshotHash: string;
    snapshotSequence: number;
    expiresAtMs: number;
  }>;
}

export interface PendingOutboxSignal {
  id: string;
  episodeId: string;
  deliveryState: 'PENDING' | 'DELIVERY_UNKNOWN';
  retryCount: number;
  quoteSnapshot: unknown;
  decision: unknown;
}

export interface EntryQuoteForExit {
  sizeUsd: number;
  outputTokenAmount: string;
  inputUsd: string;
}

export interface DueOutcomeTask {
  taskId: number;
  episodeId: string;
  signalId: string | null;
  tokenAddress: string;
  taskKind: string;
  dueAtMs: number;
  entryMarketPrice: string | null;
  entryAtMs: number;
  targetAtMs: number;
  qualityVersion: string;
  pathCaptureAttempts: number;
  horizonAtMs: number;
  evaluationPolicy: {
    target_multiples?: number[];
    take_profit_percent?: number;
    stop_loss_percent?: number;
  } | null;
}

export interface OperationTrace {
  correlationId: string;
  stage:
    | 'source_event'
    | 'observation'
    | 'queue'
    | 'api_batch'
    | 'decision'
    | 'outbox'
    | 'telegram_request'
    | 'telegram_confirmation'
    | 'result';
  occurredAtMs: number;
  metadata?: unknown;
}

export interface ApiMinuteStats {
  endpoint: string;
  minuteAtMs: number;
  requestCount: number;
  weightSum: number;
  successCount: number;
  errorCount: number;
  statusCounts: Record<string, number>;
  p50: number | null;
  p95: number | null;
}

export interface DurableMetricCounts {
  activeEpisodes: number;
  signals: number;
  deliveryFailures: number;
  preSendCancellations: number;
  preparationFailures: number;
  deliveryUnknown: number;
  dueTaskBacklog: number;
}

export class SerializedWriteQueue {
  #tail: Promise<void> = Promise.resolve();

  enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

export class Storage {
  readonly writes = new SerializedWriteQueue();
  readonly db: SqliteDatabase;

  private constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
  }

  static async open(
    path: string,
    migrationDirectory = join(dirname(import.meta.filename), 'migrations')
  ): Promise<Storage> {
    const storage = new Storage(path);
    try {
      await storage.migrate(migrationDirectory);
      return storage;
    } catch (error) {
      storage.close();
      throw error;
    }
  }

  async migrate(migrationDirectory: string): Promise<void> {
    const migrations = (await readdir(migrationDirectory))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at_ms INTEGER NOT NULL)'
    );
    for (const filename of migrations) {
      const sql = await readFile(join(migrationDirectory, filename), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const applied = this.db
        .prepare('SELECT checksum FROM schema_migrations WHERE id = ?')
        .get(filename) as { checksum: string } | undefined;
      if (applied && applied.checksum !== checksum)
        throw new Error(`migration checksum changed: ${filename}`);
      if (!applied)
        this.db.transaction(() => {
          this.db.exec(sql);
          this.db
            .prepare('INSERT INTO schema_migrations (id, checksum, applied_at_ms) VALUES (?, ?, ?)')
            .run(filename, checksum, Date.now());
        })();
    }
  }

  write<T>(operation: () => T): Promise<T> {
    return this.writes.enqueue(operation);
  }

  transaction<T>(operation: () => T): Promise<T> {
    return this.write(this.db.transaction(operation));
  }

  recordConfigRevision(id: string, snapshot: unknown, nowMs: number): Promise<void> {
    return this.write(() => {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO config_revisions (revision_id, sanitized_snapshot_json, created_at_ms) VALUES (?, ?, ?)'
        )
        .run(id, serializeJson(snapshot), nowMs);
    });
  }

  persistDiscoveryEvent(event: NormalizedEvent): Promise<boolean> {
    return this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(chain, address) DO UPDATE SET updated_at_ms = excluded.updated_at_ms`
        )
        .run(event.chain, event.tokenAddress, event.observedAtMs, event.observedAtMs);
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO events (
            event_key, chain, token_address, source, source_event_id, poll_key, snapshot_hash,
            snapshot_sequence, source_event_at_ms, observed_at_ms, evidence_family, strength,
            expires_at_ms, raw_payload_ref, normalized_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.key,
          event.chain,
          event.tokenAddress,
          event.source,
          event.sourceEventId ?? null,
          event.pollKey ?? null,
          event.snapshotHash ?? null,
          event.snapshotSequence ?? null,
          event.sourceEventAtMs,
          event.observedAtMs,
          event.evidenceFamily,
          event.strength,
          event.expiresAtMs,
          event.rawPayloadRef,
          serializeJson(event.payload)
        );
      return inserted.changes === 1;
    });
  }

  claimEpisode(input: {
    id: string;
    tokenAddress: string;
    route: RouteName;
    configRevisionId: string;
    nowMs: number;
    triggerAtMs?: number | null;
    decisiveWindowMs?: number;
    resetSatisfied?: boolean;
    reentryCooldownMsByReason?: Readonly<Record<string, number>>;
  }): Promise<'created' | 'already_active' | 'new_launch_already_sent' | 'reentry_not_allowed'> {
    return this.transaction(() => {
      if (input.route === 'new_launch') {
        const sent = this.db
          .prepare(
            `SELECT 1 FROM episodes
             WHERE chain = 'bsc' AND token_address = ? AND route = 'new_launch'
               AND (state = 'SENT' OR id IN (SELECT episode_id FROM signals WHERE delivery_state = 'SENT'))
             LIMIT 1`
          )
          .get(input.tokenAddress.toLowerCase());
        if (sent) return 'new_launch_already_sent';
      }
      const previous = this.db
        .prepare(
          `SELECT state, ended_at_ms AS endedAtMs, rejection_reason AS rejectionReason FROM episodes
           WHERE chain = 'bsc' AND token_address = ? AND route = ? AND ended_at_ms IS NOT NULL
           ORDER BY ended_at_ms DESC, created_at_ms DESC LIMIT 1`
        )
        .get(input.tokenAddress.toLowerCase(), input.route) as
        { state: string; endedAtMs: number; rejectionReason: string | null } | undefined;
      if (previous) {
        const rejectionCooldownMs = previous.rejectionReason
          ? input.reentryCooldownMsByReason?.[previous.rejectionReason]
          : undefined;
        if (
          rejectionCooldownMs !== undefined &&
          input.nowMs - previous.endedAtMs < rejectionCooldownMs
        )
          return 'reentry_not_allowed';
        const freshTrigger =
          input.triggerAtMs !== undefined &&
          input.triggerAtMs !== null &&
          input.decisiveWindowMs !== undefined &&
          input.triggerAtMs > previous.endedAtMs &&
          input.triggerAtMs <= input.nowMs &&
          input.nowMs - input.triggerAtMs <= input.decisiveWindowMs;
        if (
          !['REJECTED', 'EXPIRED'].includes(previous.state) ||
          !freshTrigger ||
          input.resetSatisfied !== true
        )
          return 'reentry_not_allowed';
      }
      this.db
        .prepare(
          `INSERT INTO tokens (chain, address, first_seen_at_ms, updated_at_ms)
           VALUES ('bsc', ?, ?, ?)
           ON CONFLICT(chain, address) DO UPDATE SET updated_at_ms = excluded.updated_at_ms`
        )
        .run(input.tokenAddress.toLowerCase(), input.nowMs, input.nowMs);
      try {
        this.db
          .prepare(
            `INSERT INTO episodes (
              id, chain, token_address, route, state, config_revision_id, created_at_ms, updated_at_ms
            ) VALUES (?, 'bsc', ?, ?, 'DISCOVERED', ?, ?, ?)`
          )
          .run(
            input.id,
            input.tokenAddress.toLowerCase(),
            input.route,
            input.configRevisionId,
            input.nowMs,
            input.nowMs
          );
        return 'created';
      } catch (error) {
        if (
          error instanceof Error &&
          /UNIQUE constraint failed: episodes\.chain, episodes\.token_address, episodes\.route/.test(
            error.message
          )
        )
          return 'already_active';
        throw error;
      }
    });
  }

  beginObservation(episodeId: string, nowMs: number): Promise<boolean> {
    return this.write(
      () =>
        this.db
          .prepare(
            "UPDATE episodes SET state = 'OBSERVING', updated_at_ms = ? WHERE id = ? AND state = 'DISCOVERED'"
          )
          .run(nowMs, episodeId).changes === 1
    );
  }

  admitObservation(input: {
    episodeId: string;
    route: RouteName;
    score: number;
    completeness: number;
    evidenceFreshness: number;
    capacity: number;
    softRouteTarget: number;
    nextEvaluationAtMs: number;
    expiresAtMs: number;
    nowMs: number;
  }): Promise<{ admitted: boolean; demotedId?: string }> {
    return this.write(() => {
      const quality = input.score * 1_000 + input.completeness * 100 + input.evidenceFreshness;
      const current = this.db
        .prepare('SELECT state FROM episodes WHERE id = ?')
        .get(input.episodeId) as { state: string } | undefined;
      if (!current || !['DISCOVERED', 'OBSERVING', 'READY'].includes(current.state))
        return { admitted: false };
      if (current.state === 'OBSERVING') {
        this.db
          .prepare(
            'UPDATE episodes SET observation_quality = ?, next_evaluation_at_ms = ?, expires_at_ms = MAX(expires_at_ms, ?), updated_at_ms = ? WHERE id = ?'
          )
          .run(quality, input.nextEvaluationAtMs, input.expiresAtMs, input.nowMs, input.episodeId);
        return { admitted: true };
      }
      const active = this.db
        .prepare(
          `SELECT id, route, observation_quality AS quality FROM episodes
           WHERE state = 'OBSERVING' AND ended_at_ms IS NULL`
        )
        .all() as Array<{ id: string; route: RouteName; quality: number | null }>;
      if (active.length < input.capacity) {
        this.db
          .prepare(
            "UPDATE episodes SET state = 'OBSERVING', observation_quality = ?, next_evaluation_at_ms = ?, expires_at_ms = ?, updated_at_ms = ? WHERE id = ? AND state IN ('DISCOVERED', 'READY')"
          )
          .run(quality, input.nextEvaluationAtMs, input.expiresAtMs, input.nowMs, input.episodeId);
        return { admitted: true };
      }
      const counts = new Map<RouteName, number>();
      for (const item of active) counts.set(item.route, (counts.get(item.route) ?? 0) + 1);
      const ranked = active
        .map((item) => ({
          ...item,
          rank:
            (item.quality ?? Number.NEGATIVE_INFINITY) -
            ((counts.get(item.route) ?? 0) > input.softRouteTarget ? 0.001 : 0)
        }))
        .sort((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
      const lowest = ranked[0];
      const candidateRank =
        quality - ((counts.get(input.route) ?? 0) >= input.softRouteTarget ? 0.001 : 0);
      if (!lowest || candidateRank <= lowest.rank) return { admitted: false };
      this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE episodes SET state = 'EXPIRED', rejection_reason = 'observation_capacity_demoted', updated_at_ms = ?, ended_at_ms = ? WHERE id = ? AND state = 'OBSERVING'"
          )
          .run(input.nowMs, input.nowMs, lowest.id);
        this.db
          .prepare(
            "UPDATE episodes SET state = 'OBSERVING', observation_quality = ?, next_evaluation_at_ms = ?, expires_at_ms = ?, updated_at_ms = ? WHERE id = ? AND state IN ('DISCOVERED', 'READY')"
          )
          .run(quality, input.nextEvaluationAtMs, input.expiresAtMs, input.nowMs, input.episodeId);
      })();
      return { admitted: true, demotedId: lowest.id };
    });
  }

  activeEpisodeId(tokenAddress: string, route: RouteName): Promise<string | null> {
    return this.write(() => {
      const row = this.db
        .prepare(
          `SELECT id FROM episodes
           WHERE chain = 'bsc' AND token_address = ? AND route = ? AND ended_at_ms IS NULL
           LIMIT 1`
        )
        .get(tokenAddress.toLowerCase(), route) as { id: string } | undefined;
      return row?.id ?? null;
    });
  }

  rescheduleObservation(
    episodeId: string,
    nextEvaluationAtMs: number,
    nowMs: number
  ): Promise<boolean> {
    return this.write(
      () =>
        this.db
          .prepare(
            "UPDATE episodes SET next_evaluation_at_ms = ?, updated_at_ms = ? WHERE id = ? AND state IN ('OBSERVING','READY') AND ended_at_ms IS NULL"
          )
          .run(nextEvaluationAtMs, nowMs, episodeId).changes === 1
    );
  }

  expireObservation(episodeId: string, reason: string, nowMs: number): Promise<boolean> {
    return this.write(
      () =>
        this.db
          .prepare(
            "UPDATE episodes SET state = 'EXPIRED', rejection_reason = ?, next_evaluation_at_ms = NULL, updated_at_ms = ?, ended_at_ms = ? WHERE id = ? AND state = 'OBSERVING' AND ended_at_ms IS NULL"
          )
          .run(reason, nowMs, nowMs, episodeId).changes === 1
    );
  }

  dueObservationEvents(
    nowMs: number,
    limit = 60
  ): Promise<Array<NormalizedEvent & { episodeId: string; observationScore: number | null }>> {
    return this.write(() => {
      const rows = this.db
        .prepare(
          `SELECT ep.id AS episodeId, ep.score AS observationScore,
                  e.event_key AS key, e.chain, e.token_address AS tokenAddress, e.source,
                  e.source_event_at_ms AS sourceEventAtMs, e.observed_at_ms AS observedAtMs,
                  e.evidence_family AS evidenceFamily, e.strength, e.expires_at_ms AS expiresAtMs,
                  e.raw_payload_ref AS rawPayloadRef, e.normalized_json AS payload,
                  e.source_event_id AS sourceEventId, e.poll_key AS pollKey,
                  e.snapshot_hash AS snapshotHash, e.snapshot_sequence AS snapshotSequence
             FROM episodes ep JOIN events e ON e.id = (
               SELECT id FROM events WHERE chain = ep.chain AND token_address = ep.token_address
               ORDER BY observed_at_ms DESC, id DESC LIMIT 1
             )
            WHERE ep.state IN ('OBSERVING','READY') AND ep.ended_at_ms IS NULL AND ep.next_evaluation_at_ms IS NOT NULL
              AND ep.next_evaluation_at_ms <= ?
            ORDER BY ep.next_evaluation_at_ms ASC LIMIT ?`
        )
        .all(nowMs, limit) as Array<
        Omit<NormalizedEvent, 'payload'> & {
          episodeId: string;
          observationScore: number | null;
          payload: string;
        }
      >;
      return rows.flatMap((row) => {
        try {
          const payload = JSON.parse(row.payload) as Record<string, unknown>;
          return [{ ...row, payload }];
        } catch {
          return [];
        }
      });
    });
  }

  expireObservations(nowMs: number): Promise<number> {
    return this.write(
      () =>
        this.db
          .prepare(
            "UPDATE episodes SET state = 'EXPIRED', rejection_reason = 'observation_expired', updated_at_ms = ?, ended_at_ms = ? WHERE state IN ('OBSERVING','READY') AND ended_at_ms IS NULL AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?"
          )
          .run(nowMs, nowMs, nowMs).changes
    );
  }

  recordEpisodeDecision(input: {
    episodeId: string;
    decision: 'rejected' | 'observing' | 'formal';
    score: number;
    completeness: number;
    decisiveTriggerAtMs: number | null;
    featureSnapshot: unknown;
    nowMs: number;
    readyReevaluationAtMs?: number;
    readyExpiresAtMs?: number;
  }): Promise<boolean> {
    return this.write(() => {
      const current = this.db
        .prepare(
          'SELECT state, low_score_checks AS lowScoreChecks, feature_snapshot_json AS snapshot FROM episodes WHERE id = ?'
        )
        .get(input.episodeId) as
        { state: string; lowScoreChecks: number; snapshot: string } | undefined;
      if (!current || !['DISCOVERED', 'OBSERVING', 'READY'].includes(current.state)) return false;
      if (input.score >= 65) {
        const features = recordValue(recordValue(input.featureSnapshot)?.features);
        const price = decimalString(features?.priceUsd);
        this.db
          .prepare(
            `UPDATE episodes SET evaluation_entry_at_ms = ?, evaluation_entry_price = ?
          WHERE id = ? AND evaluation_entry_at_ms IS NULL`
          )
          .run(input.nowMs, price, input.episodeId);
      }
      this.db
        .prepare('UPDATE episodes SET soft_failure_since_ms=NULL WHERE id=?')
        .run(input.episodeId);
      const belowObservation = input.decision === 'rejected';
      const lowScoreChecks =
        belowObservation && current.state !== 'DISCOVERED' ? current.lowScoreChecks + 1 : 0;
      const state =
        input.decision === 'formal'
          ? 'READY'
          : input.decision === 'observing'
            ? 'OBSERVING'
            : current.state === 'DISCOVERED'
              ? 'REJECTED'
              : lowScoreChecks >= 2
                ? 'EXPIRED'
                : 'OBSERVING';
      const existing = JSON.parse(current.snapshot) as unknown;
      const existingRecord =
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? (existing as Record<string, unknown>)
          : {};
      const latestRecord =
        input.featureSnapshot &&
        typeof input.featureSnapshot === 'object' &&
        !Array.isArray(input.featureSnapshot)
          ? (input.featureSnapshot as Record<string, unknown>)
          : { value: input.featureSnapshot };
      const initialDecision =
        existingRecord.initial_decision ??
        (Object.keys(existingRecord).length > 0 ? existing : input.featureSnapshot);
      const result = this.db
        .prepare(
          `UPDATE episodes
             SET state = ?, score = ?, completeness = ?, decisive_trigger_at_ms = ?,
                 feature_snapshot_json = ?, rejection_reason = ?, low_score_checks = ?, updated_at_ms = ?,
                 next_evaluation_at_ms = CASE WHEN ? = 'READY' THEN ? ELSE next_evaluation_at_ms END,
                 expires_at_ms = CASE WHEN ? = 'READY' THEN COALESCE(expires_at_ms, ?) ELSE expires_at_ms END,
                 ended_at_ms = CASE WHEN ? IN ('REJECTED', 'EXPIRED') THEN ? ELSE NULL END
           WHERE id = ?
             AND state IN ('DISCOVERED', 'OBSERVING', 'READY')`
        )
        .run(
          state,
          input.score,
          input.completeness,
          input.decisiveTriggerAtMs,
          serializeJson({
            ...latestRecord,
            initial_decision: initialDecision,
            latest_decision: input.featureSnapshot
          }),
          belowObservation ? 'score_below_observation_threshold' : null,
          lowScoreChecks,
          input.nowMs,
          state,
          input.readyReevaluationAtMs ?? input.nowMs + 30_000,
          state,
          input.readyExpiresAtMs ?? input.nowMs + 15 * 60_000,
          state,
          input.nowMs,
          input.episodeId
        );
      return result.changes === 1;
    });
  }

  /** A transient candidate failure must not strand a formally scored Episode. */
  deferReadyCandidate(
    tokenAddress: string,
    reason: string,
    nowMs: number,
    retryAtMs: number
  ): Promise<number> {
    return this.write(
      () =>
        this.db
          .prepare(
            `UPDATE episodes SET
      state=CASE WHEN expires_at_ms<=? THEN 'EXPIRED' ELSE 'OBSERVING' END,
      ended_at_ms=CASE WHEN expires_at_ms<=? THEN ? ELSE NULL END,
      next_evaluation_at_ms=CASE WHEN expires_at_ms<=? THEN NULL ELSE MIN(?,expires_at_ms) END,
      rejection_reason=?, updated_at_ms=?,
      feature_snapshot_json=json_set(feature_snapshot_json,'$.transient_failure',json(?))
      WHERE token_address=? AND state='READY' AND ended_at_ms IS NULL
      AND NOT EXISTS(SELECT 1 FROM signals WHERE episode_id=episodes.id)`
          )
          .run(
            nowMs,
            nowMs,
            nowMs,
            nowMs,
            Math.max(nowMs + 1000, retryAtMs),
            reason,
            nowMs,
            serializeJson({ reason, atMs: nowMs, retryAtMs }),
            tokenAddress.toLowerCase()
          ).changes
    );
  }

  /** Restart recovery schedules fresh validation; it never delivers an old READY decision. */
  recoverReadyCandidates(nowMs: number, expiryMinutes: Record<RouteName, number>): Promise<number> {
    return this.transaction(() => {
      this.db
        .prepare(
          `UPDATE episodes SET expires_at_ms=COALESCE(expires_at_ms,
        created_at_ms+60000*CASE route WHEN 'revival' THEN ? WHEN 'continuation' THEN ? ELSE ? END)
        WHERE state='READY' AND ended_at_ms IS NULL`
        )
        .run(expiryMinutes.revival, expiryMinutes.continuation, expiryMinutes.new_launch);
      return this.db
        .prepare(
          `UPDATE episodes SET
        state=CASE WHEN expires_at_ms<=? THEN 'EXPIRED' ELSE 'OBSERVING' END,
        ended_at_ms=CASE WHEN expires_at_ms<=? THEN ? ELSE NULL END,
        next_evaluation_at_ms=CASE WHEN expires_at_ms<=? THEN NULL ELSE MIN(expires_at_ms,MAX(?,COALESCE(next_evaluation_at_ms,?))) END,
        rejection_reason=CASE WHEN expires_at_ms<=? THEN 'observation_expired' ELSE 'ready_revalidation_required' END,
        updated_at_ms=? WHERE state='READY' AND ended_at_ms IS NULL
        AND NOT EXISTS(SELECT 1 FROM signals WHERE episode_id=episodes.id)`
        )
        .run(nowMs, nowMs, nowMs, nowMs, nowMs + 1000, nowMs + 1000, nowMs, nowMs).changes;
    });
  }

  recordEpisodeQuoteGate(input: {
    episodeId: string;
    quoteResult: unknown;
    accepted: boolean;
    temporaryCostFailure: boolean;
    nowMs: number;
  }): Promise<boolean> {
    const state = input.accepted ? 'READY' : input.temporaryCostFailure ? 'OBSERVING' : 'REJECTED';
    return this.write(() => {
      const row = this.db
        .prepare('SELECT feature_snapshot_json AS snapshot FROM episodes WHERE id = ?')
        .get(input.episodeId) as { snapshot: string } | undefined;
      if (!row) return false;
      const snapshot = JSON.parse(row.snapshot) as Record<string, unknown>;
      const result = this.db
        .prepare(
          `UPDATE episodes
             SET state = ?, feature_snapshot_json = ?, rejection_reason = ?, updated_at_ms = ?,
                 ended_at_ms = CASE WHEN ? = 'REJECTED' THEN ? ELSE NULL END
           WHERE id = ? AND state IN ('READY', 'OBSERVING')`
        )
        .run(
          state,
          serializeJson({ ...snapshot, quote_gate: input.quoteResult }),
          input.accepted
            ? null
            : input.temporaryCostFailure
              ? 'quote_cost_temporary'
              : 'quote_route_unavailable',
          input.nowMs,
          state,
          input.nowMs,
          input.episodeId
        );
      return result.changes === 1;
    });
  }

  rejectEpisodeSafetyGate(input: {
    episodeId: string;
    reason: string;
    snapshot: unknown;
    nowMs: number;
  }): Promise<boolean> {
    return this.write(() => {
      const result = this.db
        .prepare(
          `UPDATE episodes
             SET state = 'REJECTED', feature_snapshot_json = json_set(feature_snapshot_json, '$.safety_rejection', json(?)), rejection_reason = ?,
                 updated_at_ms = ?, ended_at_ms = ?
           WHERE id = ? AND state IN ('DISCOVERED', 'OBSERVING', 'READY')`
        )
        .run(
          serializeJson(input.snapshot),
          input.reason,
          input.nowMs,
          input.nowMs,
          input.episodeId
        );
      return result.changes === 1;
    });
  }

  createSignalOutbox(input: {
    signalId: string;
    episodeId: string;
    configRevisionId: string;
    quoteSnapshot: unknown;
    decision: unknown;
    nowMs: number;
  }): Promise<'created' | 'already_exists' | 'episode_not_ready'> {
    return this.transaction(() => {
      const episode = this.db
        .prepare('SELECT state, config_revision_id AS configRevisionId FROM episodes WHERE id = ?')
        .get(input.episodeId) as { state: string; configRevisionId: string } | undefined;
      if (
        !episode ||
        episode.state !== 'READY' ||
        episode.configRevisionId !== input.configRevisionId
      )
        return 'episode_not_ready';
      const existing = this.db
        .prepare('SELECT 1 FROM signals WHERE episode_id = ?')
        .get(input.episodeId);
      if (existing) return 'already_exists';
      const moved = this.db
        .prepare(
          `UPDATE episodes
             SET state = 'DELIVERY_PENDING', feature_snapshot_json = ?, updated_at_ms = ?
           WHERE id = ? AND state = 'READY'`
        )
        .run(
          serializeJson({
            ...JSON.parse(
              (
                this.db
                  .prepare('SELECT feature_snapshot_json AS snapshot FROM episodes WHERE id = ?')
                  .get(input.episodeId) as { snapshot: string }
              ).snapshot
            ),
            quote_gate: input.quoteSnapshot
          }),
          input.nowMs,
          input.episodeId
        );
      if (moved.changes !== 1) return 'episode_not_ready';
      this.db
        .prepare(
          `INSERT INTO signals (
            id, episode_id, config_revision_id, delivery_state, quote_snapshot_json, decision_json,
            created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?)`
        )
        .run(
          input.signalId,
          input.episodeId,
          input.configRevisionId,
          serializeJson(input.quoteSnapshot),
          serializeJson(input.decision),
          input.nowMs,
          input.nowMs
        );
      return 'created';
    });
  }

  claimTelegramCallback(input: {
    updateId: number;
    signalId: string;
    chatId: string | number;
    messageId: number;
    action: 'copy' | 'refresh' | 'bought' | 'stop' | 'delete';
    userId: string | number;
    nowMs: number;
  }): Promise<'claimed' | 'duplicate_update' | 'unassociated_message' | 'duplicate_action'> {
    return this.transaction(() => {
      const update = this.db
        .prepare('INSERT OR IGNORE INTO telegram_updates (update_id, received_at_ms) VALUES (?, ?)')
        .run(input.updateId, input.nowMs);
      if (update.changes !== 1) return 'duplicate_update';
      const signal = this.db
        .prepare(
          `SELECT id FROM signals
           WHERE id = ? AND telegram_chat_id = ? AND telegram_message_id = ?`
        )
        .get(input.signalId, String(input.chatId), String(input.messageId));
      if (!signal) return 'unassociated_message';
      if (!['copy', 'refresh'].includes(input.action)) {
        const action = this.db
          .prepare(
            'INSERT OR IGNORE INTO signal_actions (signal_id, action, user_id, created_at_ms) VALUES (?, ?, ?, ?)'
          )
          .run(input.signalId, input.action, String(input.userId), input.nowMs);
        if (action.changes !== 1) return 'duplicate_action';
      }
      if (input.action === 'stop')
        this.db
          .prepare(
            'UPDATE signals SET telegram_tracking_stopped = 1, updated_at_ms = ? WHERE id = ?'
          )
          .run(input.nowMs, input.signalId);
      return 'claimed';
    });
  }

  recordIgnoredTelegramUpdate(updateId: number, nowMs: number): Promise<boolean> {
    return this.write(
      () =>
        this.db
          .prepare(
            'INSERT OR IGNORE INTO telegram_updates (update_id, received_at_ms) VALUES (?, ?)'
          )
          .run(updateId, nowMs).changes === 1
    );
  }

  releaseTelegramCallbackAction(
    signalId: string,
    action: 'copy' | 'refresh' | 'bought' | 'stop' | 'delete',
    userId: string | number
  ): Promise<void> {
    return this.write(() => {
      this.db
        .prepare('DELETE FROM signal_actions WHERE signal_id = ? AND action = ? AND user_id = ?')
        .run(signalId, action, String(userId));
    });
  }

  tokenAddressForSignal(signalId: string): Promise<string | null> {
    return this.write(() => {
      const row = this.db
        .prepare(
          'SELECT episode.token_address AS tokenAddress FROM signals AS signal JOIN episodes AS episode ON episode.id = signal.episode_id WHERE signal.id = ?'
        )
        .get(signalId) as { tokenAddress: string } | undefined;
      return row?.tokenAddress ?? null;
    });
  }

  updatePendingSignalMarket(
    signalId: string,
    presentation: unknown,
    quoteSnapshot: unknown,
    nowMs: number
  ): Promise<PendingOutboxSignal | null> {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT id, episode_id AS episodeId, delivery_state AS deliveryState,
                  retry_count AS retryCount, quote_snapshot_json AS quoteSnapshot,
                  decision_json AS decision
           FROM signals WHERE id = ? AND delivery_state IN ('PENDING', 'DELIVERY_UNKNOWN')`
        )
        .get(signalId) as
        | (Omit<PendingOutboxSignal, 'quoteSnapshot' | 'decision'> & {
            quoteSnapshot: string;
            decision: string;
          })
        | undefined;
      if (!row) return null;
      const decision = JSON.parse(row.decision) as Record<string, unknown>;
      decision.presentation = presentation;
      const nextQuote = quoteSnapshot ?? (JSON.parse(row.quoteSnapshot) as unknown);
      const updated = this.db
        .prepare(
          `UPDATE signals SET decision_json = ?, quote_snapshot_json = ?, updated_at_ms = ?
           WHERE id = ? AND delivery_state IN ('PENDING', 'DELIVERY_UNKNOWN')`
        )
        .run(serializeJson(decision), serializeJson(nextQuote), nowMs, signalId);
      return updated.changes === 1 ? { ...row, decision, quoteSnapshot: nextQuote } : null;
    });
  }

  markTelegramMessageDeleted(signalId: string, nowMs: number): Promise<boolean> {
    return this.write(
      () =>
        this.db
          .prepare(
            'UPDATE signals SET telegram_deleted = 1, updated_at_ms = ? WHERE id = ? AND telegram_deleted = 0'
          )
          .run(nowMs, signalId).changes === 1
    );
  }

  lastTelegramUpdateId(): Promise<number | null> {
    return this.write(() => {
      const row = this.db
        .prepare('SELECT MAX(update_id) AS updateId FROM telegram_updates')
        .get() as { updateId: number | null };
      return row.updateId;
    });
  }

  pendingOutboxSignals(nowMs = Date.now()): Promise<PendingOutboxSignal[]> {
    return this.write(
      () =>
        this.db
          .prepare(
            `SELECT id, episode_id AS episodeId, delivery_state AS deliveryState, retry_count AS retryCount,
                  quote_snapshot_json AS quoteSnapshot, decision_json AS decision
           FROM signals
           WHERE delivery_state IN ('PENDING', 'DELIVERY_UNKNOWN')
             AND (next_delivery_attempt_at_ms IS NULL OR next_delivery_attempt_at_ms <= ?)
           ORDER BY created_at_ms, id`
          )
          .all(nowMs)
          .map((row) => {
            const candidate = row as Omit<PendingOutboxSignal, 'quoteSnapshot' | 'decision'> & {
              quoteSnapshot: string;
              decision: string;
            };
            return {
              ...candidate,
              quoteSnapshot: JSON.parse(candidate.quoteSnapshot) as unknown,
              decision: JSON.parse(candidate.decision) as unknown
            };
          }) as PendingOutboxSignal[]
    );
  }

  claimUnknownDeliveryRetry(signalId: string, nowMs: number): Promise<boolean> {
    return this.write(
      () =>
        this.db
          .prepare(
            `UPDATE signals SET retry_count = retry_count + 1, possible_duplicate = 1,
             delivery_attempted_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND delivery_state = 'DELIVERY_UNKNOWN' AND retry_count = 0`
          )
          .run(nowMs, nowMs, signalId).changes === 1
    );
  }

  recordDeliveryUnknown(signalId: string, error: string, nowMs: number): Promise<void> {
    return this.write(() => {
      this.db
        .prepare(
          `UPDATE signals SET delivery_state = 'DELIVERY_UNKNOWN', last_delivery_error = ?,
             delivery_attempted_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND delivery_state IN ('PENDING', 'DELIVERY_UNKNOWN')`
        )
        .run(error, nowMs, nowMs, signalId);
    });
  }

  deferRateLimitedDelivery(
    signalId: string,
    error: string,
    retryAtMs: number,
    nowMs: number
  ): Promise<void> {
    return this.write(() => {
      this.db
        .prepare(
          `UPDATE signals SET last_delivery_error = ?, delivery_attempted_at_ms = ?,
             next_delivery_attempt_at_ms = ?, updated_at_ms = ?,
             retry_count = CASE
               WHEN delivery_state = 'DELIVERY_UNKNOWN' AND retry_count = 1 THEN 0
               ELSE retry_count
             END
           WHERE id = ? AND delivery_state IN ('PENDING', 'DELIVERY_UNKNOWN')`
        )
        .run(error, nowMs, retryAtMs, nowMs, signalId);
    });
  }

  recordPreSendCancellation(signalId: string, reason: string, nowMs: number): Promise<void> {
    return this.recordDeliveryFailure(signalId, reason, nowMs, 'pre_send_cancelled');
  }

  recordDeliveryFailure(
    signalId: string,
    error: string,
    nowMs: number,
    kind: 'pre_send_cancelled' | 'preparation_failed' | 'telegram_failed' = 'telegram_failed'
  ): Promise<void> {
    return this.transaction(() => {
      const signal = this.db
        .prepare('SELECT episode_id AS episodeId FROM signals WHERE id = ?')
        .get(signalId) as { episodeId: string } | undefined;
      if (!signal) return;
      const updated = this.db
        .prepare(
          `UPDATE signals SET delivery_state = 'SEND_FAILED', last_delivery_error = ?,
             delivery_attempted_at_ms = CASE WHEN ? = 'telegram_failed' THEN ? ELSE delivery_attempted_at_ms END,
             delivery_failure_kind = ?, updated_at_ms = ?
           WHERE id = ? AND delivery_state IN ('PENDING', 'DELIVERY_UNKNOWN')`
        )
        .run(error, kind, nowMs, kind, nowMs, signalId);
      if (updated.changes !== 1) return;
      this.db
        .prepare(
          "UPDATE episodes SET state = 'SEND_FAILED', updated_at_ms = ?, ended_at_ms = ? WHERE id = ? AND state = 'DELIVERY_PENDING'"
        )
        .run(nowMs, nowMs, signal.episodeId);
    });
  }

  recordDeliverySnapshot(
    signal: PendingOutboxSignal,
    payload: unknown,
    requestAtMs: number
  ): Promise<string> {
    return this.write(() => {
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO signal_delivery_snapshots
        (id,signal_id,request_at_ms,payload_json,decision_json,quote_snapshot_json) VALUES (?,?,?,?,?,?)`
        )
        .run(
          id,
          signal.id,
          requestAtMs,
          serializeJson(payload),
          serializeJson(signal.decision),
          serializeJson(signal.quoteSnapshot)
        );
      return id;
    });
  }

  confirmTelegramDelivery(input: {
    signalId: string;
    chatId: string | number;
    messageId: number;
    nowMs: number;
    snapshotId?: string;
    narrative?: boolean;
    outcomeCheckpointsMinutes?: readonly number[];
    narrativeOutcomeCheckpointsMinutes?: readonly number[];
  }): Promise<boolean> {
    return this.transaction(() => {
      const signal = this.db
        .prepare(
          'SELECT episode_id AS episodeId, decision_json AS decision FROM signals WHERE id = ?'
        )
        .get(input.signalId) as { episodeId: string; decision: string } | undefined;
      if (!signal) return false;
      const snapshot =
        input.snapshotId === undefined
          ? undefined
          : (this.db
              .prepare(
                'SELECT decision_json AS decision FROM signal_delivery_snapshots WHERE id=? AND signal_id=?'
              )
              .get(input.snapshotId, input.signalId) as { decision: string } | undefined);
      if (input.snapshotId !== undefined && !snapshot)
        throw new Error('delivery snapshot does not match signal');
      const decision = JSON.parse(snapshot?.decision ?? signal.decision) as Record<string, unknown>;
      const presentation = recordValue(decision.presentation);
      const features = recordValue(decision.features);
      const entryMarketPrice = decimalString(presentation?.priceUsd ?? features?.priceUsd);
      if (entryMarketPrice !== null) {
        decision.marketEntryPriceUsd = entryMarketPrice;
        decision.marketEntryAtMs = input.nowMs;
      }
      const updated = this.db
        .prepare(
          `UPDATE signals SET delivery_state = 'SENT', telegram_chat_id = ?, telegram_message_id = ?,
             telegram_confirmed_at_ms = ?, decision_json = ?, confirmed_snapshot_id = ?, last_delivery_error = NULL, updated_at_ms = ?
           WHERE id = ? AND delivery_state IN ('PENDING', 'DELIVERY_UNKNOWN')`
        )
        .run(
          String(input.chatId),
          String(input.messageId),
          input.nowMs,
          serializeJson(decision),
          input.snapshotId ?? null,
          input.nowMs,
          input.signalId
        );
      if (updated.changes !== 1) return false;
      this.db
        .prepare(
          "UPDATE episodes SET state = 'SENT', updated_at_ms = ?, ended_at_ms = ? WHERE id = ? AND state = 'DELIVERY_PENDING'"
        )
        .run(input.nowMs, input.nowMs, signal.episodeId);
      const statement = this.db.prepare(
        `INSERT OR IGNORE INTO price_samples (
          episode_id, signal_id, task_kind, due_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)`
      );
      const outcomeMinutes = [
        ...(input.outcomeCheckpointsMinutes ?? []),
        ...(input.narrative ? (input.narrativeOutcomeCheckpointsMinutes ?? []) : [])
      ];
      for (const minute of outcomeMinutes) {
        const taskKind = `outcome_${minute}m`;
        const dueAtMs = input.nowMs + minute * 60_000;
        statement.run(
          signal.episodeId,
          input.signalId,
          taskKind,
          dueAtMs,
          input.nowMs,
          input.nowMs
        );
      }
      if (outcomeMinutes.length)
        this.db
          .prepare(
            `UPDATE price_samples SET horizon_at_ms=entry_at_ms+?
        WHERE signal_id=? AND task_kind LIKE 'outcome_%' AND horizon_at_ms IS NULL AND quality_version='path-v2'`
          )
          .run(Math.max(...outcomeMinutes) * 60_000, input.signalId);
      return true;
    });
  }

  deferPriceSampleTask(taskId: number, retryAtMs: number, nowMs: number): Promise<void> {
    return this.write(() => {
      this.db
        .prepare(
          "UPDATE price_samples SET next_attempt_at_ms = ?, requested_at_ms = ?, updated_at_ms = ? WHERE id = ? AND status = 'PENDING'"
        )
        .run(retryAtMs, nowMs, nowMs, taskId);
    });
  }

  scheduleResultTasks(input: {
    episodeId: string;
    signalId: string | null;
    score: number;
    hardSafetyPassed: boolean;
    formal: boolean;
    narrative: boolean;
    fromMs: number;
    checkpointsMinutes: readonly number[];
    narrativeCheckpointsMinutes: readonly number[];
  }): Promise<number> {
    if (!input.hardSafetyPassed || (!input.formal && input.score < 65)) return Promise.resolve(0);
    const minutes = [
      ...input.checkpointsMinutes,
      ...(input.narrative ? input.narrativeCheckpointsMinutes : [])
    ];
    return this.transaction(() => {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO price_samples (
          episode_id, signal_id, task_kind, due_at_ms, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)`
      );
      let created = 0;
      for (const minute of minutes) {
        const taskKind = `outcome_${minute}m`;
        const dueAtMs = input.fromMs + minute * 60_000;
        const result = insert.run(
          input.episodeId,
          input.signalId,
          taskKind,
          dueAtMs,
          input.fromMs,
          input.fromMs
        );
        created += result.changes;
      }
      if (minutes.length)
        this.db
          .prepare(
            `UPDATE price_samples SET horizon_at_ms=entry_at_ms+?
        WHERE episode_id=? AND signal_id IS ? AND task_kind LIKE 'outcome_%' AND horizon_at_ms IS NULL AND quality_version='path-v2'`
          )
          .run(Math.max(...minutes) * 60_000, input.episodeId, input.signalId);
      return created;
    });
  }

  dueOutcomeTasks(nowMs: number): Promise<DueOutcomeTask[]> {
    return this.write(() =>
      this.db
        .prepare(
          `SELECT sample.id AS taskId, sample.episode_id AS episodeId, sample.signal_id AS signalId,
                    episode.token_address AS tokenAddress, sample.task_kind AS taskKind,
                    sample.due_at_ms AS dueAtMs, sample.entry_at_ms AS entryAtMs,
                    sample.target_at_ms AS targetAtMs, sample.entry_market_price AS frozenPrice,
                    sample.quality_version AS qualityVersion, sample.path_capture_attempts AS pathCaptureAttempts, sample.horizon_at_ms AS horizonAtMs, sample.evaluation_policy_json AS evaluationPolicyJson, episode.feature_snapshot_json AS episodeSnapshot,
                    signal.decision_json AS signalDecision
             FROM price_samples AS sample JOIN episodes AS episode ON episode.id = sample.episode_id
             LEFT JOIN signals AS signal ON signal.id = sample.signal_id
             WHERE sample.status = 'PENDING' AND sample.task_kind LIKE 'outcome_%'
               AND COALESCE(sample.next_attempt_at_ms, sample.target_at_ms, sample.due_at_ms) <= ?
             ORDER BY sample.due_at_ms, sample.id`
        )
        .all(nowMs)
        .map((row) => {
          const candidate = row as Omit<DueOutcomeTask, 'entryMarketPrice'> & {
            frozenPrice: string | null;
            evaluationPolicyJson: string | null;
            episodeSnapshot: string;
            signalDecision: string | null;
          };
          return {
            taskId: candidate.taskId,
            episodeId: candidate.episodeId,
            signalId: candidate.signalId,
            tokenAddress: candidate.tokenAddress,
            taskKind: candidate.taskKind,
            dueAtMs: candidate.dueAtMs,
            entryAtMs: candidate.entryAtMs,
            targetAtMs: candidate.targetAtMs,
            qualityVersion: candidate.qualityVersion,
            pathCaptureAttempts: candidate.pathCaptureAttempts,
            horizonAtMs: candidate.horizonAtMs,
            evaluationPolicy: candidate.evaluationPolicyJson
              ? (JSON.parse(candidate.evaluationPolicyJson) as DueOutcomeTask['evaluationPolicy'])
              : null,
            entryMarketPrice: decimalString(candidate.frozenPrice)
          };
        })
    );
  }

  recordEntryQuote(input: {
    episodeId: string;
    signalId: string;
    sizeUsd: number;
    confirmedAtMs: number;
    requestedAtMs: number;
    completedAtMs: number;
    quote: unknown;
    error: string | null;
  }): Promise<void> {
    return this.write(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO price_samples (
            episode_id, signal_id, task_kind, due_at_ms, status, requested_at_ms, completed_at_ms,
            data_json, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.episodeId,
          input.signalId,
          `entry_quote_${input.sizeUsd}u`,
          input.confirmedAtMs,
          input.error === null ? 'COMPLETE' : 'FAILED',
          input.requestedAtMs,
          input.completedAtMs,
          serializeJson({
            quote: input.quote,
            error: input.error,
            primaryExecutableCohort: input.requestedAtMs - input.confirmedAtMs <= 5_000
          }),
          input.confirmedAtMs,
          input.completedAtMs
        );
    });
  }

  completedEntryQuotes(signalId: string): Promise<EntryQuoteForExit[]> {
    return this.write(() =>
      (
        this.db
          .prepare(
            `SELECT task_kind AS taskKind, data_json AS data FROM price_samples
           WHERE signal_id = ? AND task_kind LIKE 'entry_quote_%' AND status = 'COMPLETE'
           ORDER BY task_kind`
          )
          .all(signalId) as Array<{ taskKind: string; data: string }>
      ).flatMap((row) => {
        const parsed = JSON.parse(row.data) as {
          primaryExecutableCohort?: boolean;
          quote?: { outputTokenAmount?: unknown; inputUsd?: unknown };
        };
        const match = /^entry_quote_(\d+)u$/.exec(row.taskKind);
        const amount = parsed.quote?.outputTokenAmount;
        const inputUsd = parsed.quote?.inputUsd;
        return match &&
          parsed.primaryExecutableCohort === true &&
          typeof amount === 'string' &&
          amount.length > 0 &&
          typeof inputUsd === 'string'
          ? [{ sizeUsd: Number(match[1]), outputTokenAmount: amount, inputUsd }]
          : [];
      })
    );
  }

  readOutcomeCheckpoint(
    taskId: number,
    episodeId: string,
    signalId: string | null
  ): Promise<unknown> {
    return this.write(() => {
      const row = this.db
        .prepare(
          'SELECT data_json AS data FROM price_samples WHERE id=? AND episode_id=? AND signal_id IS ?'
        )
        .get(taskId, episodeId, signalId) as { data: string | null } | undefined;
      return row?.data ? (JSON.parse(row.data) as unknown) : null;
    });
  }

  /** One bounded repair of recent pre-upgrade results, without touching legacy entries. */
  requeueIncompletePaths(nowMs: number): Promise<number> {
    return this.write(
      () =>
        this.db
          .prepare(
            `UPDATE price_samples SET
      initial_checkpoint_json=COALESCE(initial_checkpoint_json,data_json),status='PENDING',next_attempt_at_ms=?
      WHERE id IN (SELECT id FROM price_samples WHERE quality_version='path-v2' AND status='COMPLETE'
        AND path_capture_attempts=0 AND entry_market_price IS NOT NULL AND target_at_ms>=?
        AND json_extract(data_json,'$.outcome.path.coverage')='incomplete' ORDER BY target_at_ms DESC LIMIT 100)`
          )
          .run(nowMs, nowMs - 24 * 3600000).changes
    );
  }

  recordOutcomeCheckpoint(input: {
    taskId: number;
    episodeId: string;
    signalId: string | null;
    checkpointMinutes: number;
    requestedAtMs: number;
    completedAtMs: number;
    data: unknown;
  }): Promise<void> {
    return this.write(() => {
      this.db
        .prepare(
          `UPDATE price_samples SET requested_at_ms = ?, completed_at_ms = ?,
             initial_checkpoint_json=COALESCE(initial_checkpoint_json,data_json),
             path_capture_attempts=path_capture_attempts+1, data_json = ?, updated_at_ms = ?
           WHERE id = ? AND episode_id = ? AND signal_id IS ? AND task_kind = ? AND status = 'PENDING'`
        )
        .run(
          input.requestedAtMs,
          input.completedAtMs,
          serializeJson(input.data),
          input.completedAtMs,
          input.taskId,
          input.episodeId,
          input.signalId,
          `outcome_${input.checkpointMinutes}m`
        );
    });
  }

  attachOutcomeEvaluation(input: {
    taskId: number;
    episodeId: string;
    signalId: string | null;
    checkpointMinutes: number;
    outcome: unknown;
    nowMs: number;
    retryAtMs?: number | null;
  }): Promise<void> {
    return this.write(() => {
      const row = this.db
        .prepare(
          'SELECT data_json AS data FROM price_samples WHERE id = ? AND episode_id = ? AND signal_id IS ? AND task_kind = ?'
        )
        .get(
          input.taskId,
          input.episodeId,
          input.signalId,
          `outcome_${input.checkpointMinutes}m`
        ) as { data: string | null } | undefined;
      if (!row) return;
      const existing = row.data === null ? {} : (JSON.parse(row.data) as Record<string, unknown>);
      this.db
        .prepare(
          "UPDATE price_samples SET status = ?, next_attempt_at_ms = ?, data_json = ?, updated_at_ms = ? WHERE id = ? AND episode_id = ? AND signal_id IS ? AND task_kind = ? AND status = 'PENDING'"
        )
        .run(
          input.retryAtMs == null ? 'COMPLETE' : 'PENDING',
          input.retryAtMs ?? null,
          serializeJson({ ...existing, outcome: input.outcome }),
          input.nowMs,
          input.taskId,
          input.episodeId,
          input.signalId,
          `outcome_${input.checkpointMinutes}m`
        );
    });
  }

  preserveUnsentEvaluationContext(input: {
    episodeId: string;
    rejectionReason: string;
    featureSnapshot: unknown;
    configRevisionId: string;
    nowMs: number;
  }): Promise<boolean> {
    return this.transaction(() => {
      const hasSignal = this.db
        .prepare('SELECT 1 FROM signals WHERE episode_id = ?')
        .get(input.episodeId);
      if (hasSignal) return false;
      const current = this.db
        .prepare('SELECT feature_snapshot_json AS snapshot FROM episodes WHERE id = ?')
        .get(input.episodeId) as { snapshot: string } | undefined;
      if (!current) return false;
      const existing = JSON.parse(current.snapshot) as unknown;
      const existingRecord =
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? (existing as Record<string, unknown>)
          : {};
      const latestRecord =
        input.featureSnapshot &&
        typeof input.featureSnapshot === 'object' &&
        !Array.isArray(input.featureSnapshot)
          ? (input.featureSnapshot as Record<string, unknown>)
          : { value: input.featureSnapshot };
      const initialDecision = existingRecord.initial_decision ?? existing;
      return (
        this.db
          .prepare(
            `UPDATE episodes SET rejection_reason = ?, feature_snapshot_json = ?, config_revision_id = ?,
             updated_at_ms = ? WHERE id = ?`
          )
          .run(
            input.rejectionReason,
            serializeJson({
              ...latestRecord,
              initial_decision: initialDecision,
              latest_decision: input.featureSnapshot
            }),
            input.configRevisionId,
            input.nowMs,
            input.episodeId
          ).changes === 1
      );
    });
  }

  recordOperationTrace(trace: OperationTrace): Promise<void> {
    return this.write(() => {
      this.db
        .prepare(
          'INSERT INTO operation_traces (correlation_id, stage, occurred_at_ms, metadata_json) VALUES (?, ?, ?, ?)'
        )
        .run(
          trace.correlationId,
          trace.stage,
          trace.occurredAtMs,
          serializeJson(trace.metadata ?? {})
        );
    });
  }

  operationTraces(correlationId: string): Promise<OperationTrace[]> {
    return this.write(() =>
      (
        this.db
          .prepare(
            'SELECT correlation_id AS correlationId, stage, occurred_at_ms AS occurredAtMs, metadata_json AS metadata FROM operation_traces WHERE correlation_id = ? ORDER BY occurred_at_ms, id'
          )
          .all(correlationId) as Array<OperationTrace & { metadata: string }>
      ).map((row) => ({ ...row, metadata: JSON.parse(row.metadata) as unknown }))
    );
  }

  recordApiObservation(input: {
    endpoint: string;
    occurredAtMs: number;
    weight: number;
    status: number | null;
    latencyMs: number;
    kind: 'success' | 'rate_limit' | 'retry' | 'timeout' | 'error' | 'slow';
    retryCount?: number;
    detail?: string;
    slowThresholdMs?: number;
    attempt?: ApiObservation['attempt'];
  }): Promise<void> {
    return this.transaction(() => {
      if (input.attempt)
        this.db
          .prepare(
            `INSERT INTO api_attempts
        (id,endpoint,started_at_ms,completed_at_ms,status,kind,metadata_json) VALUES (?,?,?,?,?,?,?)`
          )
          .run(
            input.attempt.id,
            input.endpoint,
            input.attempt.startedAtMs,
            input.occurredAtMs,
            input.status,
            input.kind,
            serializeJson({ ...input.attempt, retryCount: input.retryCount ?? 0 })
          );
      const minuteAtMs = Math.floor(input.occurredAtMs / 60_000) * 60_000;
      const current = this.db
        .prepare(
          'SELECT latency_samples_json AS latencies, status_counts_json AS statuses FROM api_stats WHERE endpoint = ? AND minute_at_ms = ?'
        )
        .get(input.endpoint, minuteAtMs) as { latencies: string; statuses: string } | undefined;
      const latencies = current ? (JSON.parse(current.latencies) as number[]) : [];
      const statuses = current ? (JSON.parse(current.statuses) as Record<string, number>) : {};
      const successful =
        input.kind === 'success' &&
        input.status !== null &&
        input.status >= 200 &&
        input.status < 300;
      if (input.status !== null)
        statuses[String(input.status)] = (statuses[String(input.status)] ?? 0) + 1;
      if (successful) latencies.push(input.latencyMs);
      this.db
        .prepare(
          `INSERT INTO api_stats (
             endpoint, minute_at_ms, request_count, weight_sum, success_count, error_count,
             latency_samples_json, status_counts_json
           ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
           ON CONFLICT(endpoint, minute_at_ms) DO UPDATE SET
             request_count = request_count + 1, weight_sum = weight_sum + excluded.weight_sum,
             success_count = success_count + excluded.success_count, error_count = error_count + excluded.error_count,
             latency_samples_json = excluded.latency_samples_json, status_counts_json = excluded.status_counts_json`
        )
        .run(
          input.endpoint,
          minuteAtMs,
          input.weight,
          successful ? 1 : 0,
          successful ? 0 : 1,
          serializeJson(latencies.slice(-1_000)),
          serializeJson(statuses)
        );
      const slow = input.latencyMs >= (input.slowThresholdMs ?? 1_000);
      if (!successful || slow)
        this.db
          .prepare(
            'INSERT INTO api_failures (endpoint, occurred_at_ms, status, kind, retry_count, latency_ms, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .run(
            input.endpoint,
            input.occurredAtMs,
            input.status,
            slow && successful ? 'slow' : input.kind,
            input.retryCount ?? 0,
            input.latencyMs,
            input.detail ?? ''
          );
    });
  }

  apiMinuteStats(endpoint: string, minuteAtMs: number): Promise<ApiMinuteStats | null> {
    return this.write(() => {
      const row = this.db
        .prepare(
          `SELECT endpoint, minute_at_ms AS minuteAtMs, request_count AS requestCount, weight_sum AS weightSum,
                  success_count AS successCount, error_count AS errorCount, latency_samples_json AS latencies,
                  status_counts_json AS statuses FROM api_stats WHERE endpoint = ? AND minute_at_ms = ?`
        )
        .get(endpoint, minuteAtMs) as
        | (Omit<ApiMinuteStats, 'statusCounts' | 'p50' | 'p95'> & {
            latencies: string;
            statuses: string;
          })
        | undefined;
      if (!row) return null;
      const values = JSON.parse(row.latencies) as number[];
      return {
        endpoint: row.endpoint,
        minuteAtMs: row.minuteAtMs,
        requestCount: row.requestCount,
        weightSum: row.weightSum,
        successCount: row.successCount,
        errorCount: row.errorCount,
        statusCounts: JSON.parse(row.statuses) as Record<string, number>,
        p50: percentileValue(values, 0.5),
        p95: percentileValue(values, 0.95)
      };
    });
  }

  durableMetricCounts(nowMs: number): Promise<DurableMetricCounts> {
    return this.write(() => ({
      activeEpisodes: (
        this.db
          .prepare('SELECT COUNT(*) AS count FROM episodes WHERE ended_at_ms IS NULL')
          .get() as { count: number }
      ).count,
      signals: (this.db.prepare('SELECT COUNT(*) AS count FROM signals').get() as { count: number })
        .count,
      deliveryFailures: (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM signals WHERE delivery_state='SEND_FAILED' AND delivery_failure_kind='telegram_failed'"
          )
          .get() as { count: number }
      ).count,
      preSendCancellations: (
        this.db
          .prepare(
            "SELECT count(*) AS n FROM signals WHERE delivery_failure_kind='pre_send_cancelled'"
          )
          .get() as { n: number }
      ).n,
      preparationFailures: (
        this.db
          .prepare(
            "SELECT count(*) AS n FROM signals WHERE delivery_failure_kind='preparation_failed'"
          )
          .get() as { n: number }
      ).n,
      deliveryUnknown: (
        this.db
          .prepare("SELECT count(*) AS n FROM signals WHERE delivery_state='DELIVERY_UNKNOWN'")
          .get() as { n: number }
      ).n,
      dueTaskBacklog: (
        this.db
          .prepare(
            "SELECT COUNT(*) AS count FROM price_samples WHERE status = 'PENDING' AND COALESCE(next_attempt_at_ms,target_at_ms,due_at_ms) <= ?"
          )
          .get(nowMs) as { count: number }
      ).count
    }));
  }

  async recover(nowMs = Date.now()): Promise<RecoveryState> {
    return this.write(() => ({
      activeEpisodes: this.db
        .prepare(
          'SELECT id, chain, token_address AS tokenAddress, route, state, next_evaluation_at_ms AS nextEvaluationAtMs FROM episodes WHERE ended_at_ms IS NULL'
        )
        .all() as RecoveryState['activeEpisodes'],
      pendingOutbox: this.db
        .prepare(
          "SELECT id, episode_id AS episodeId, delivery_state AS deliveryState, retry_count AS retryCount FROM signals WHERE delivery_state IN ('PENDING', 'DELIVERY_UNKNOWN')"
        )
        .all() as RecoveryState['pendingOutbox'],
      dueResultTasks: this.db
        .prepare(
          "SELECT id, episode_id AS episodeId, signal_id AS signalId, task_kind AS taskKind, due_at_ms AS dueAtMs FROM price_samples WHERE status = 'PENDING' AND COALESCE(next_attempt_at_ms,target_at_ms,due_at_ms) <= ? ORDER BY due_at_ms"
        )
        .all(nowMs) as RecoveryState['dueResultTasks'],
      snapshots: this.db
        .prepare(
          // SQLite takes the bare columns from the row containing the single
          // MAX value, while the grouping index keeps restart recovery linear.
          `SELECT source, poll_key AS pollKey, token_address AS tokenAddress,
                  snapshot_hash AS snapshotHash, MAX(snapshot_sequence) AS snapshotSequence,
                  expires_at_ms AS expiresAtMs
           FROM events
           WHERE poll_key IS NOT NULL
           GROUP BY source, poll_key, token_address`
        )
        .all() as RecoveryState['snapshots']
    }));
  }

  activeEvidenceEvents(nowMs: number): Promise<NormalizedEvent[]> {
    return this.write(() =>
      (
        this.db
          .prepare(
            `SELECT event_key AS key, chain, token_address AS tokenAddress, source,
                    source_event_at_ms AS sourceEventAtMs, observed_at_ms AS observedAtMs,
                    evidence_family AS evidenceFamily, strength, expires_at_ms AS expiresAtMs,
                    raw_payload_ref AS rawPayloadRef, normalized_json AS payload,
                    source_event_id AS sourceEventId, poll_key AS pollKey,
                    snapshot_hash AS snapshotHash, snapshot_sequence AS snapshotSequence
             FROM events WHERE expires_at_ms > ? ORDER BY observed_at_ms, id`
          )
          .all(nowMs) as Array<Omit<NormalizedEvent, 'payload'> & { payload: string }>
      ).map((row) => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }))
    );
  }

  latestEventForSignal(signalId: string): Promise<NormalizedEvent | null> {
    return this.write(() => {
      const row = this.db
        .prepare(
          `SELECT event_key AS key, event.chain, event.token_address AS tokenAddress, event.source,
                  event.source_event_at_ms AS sourceEventAtMs, event.observed_at_ms AS observedAtMs,
                  event.evidence_family AS evidenceFamily, event.strength, event.expires_at_ms AS expiresAtMs,
                  event.raw_payload_ref AS rawPayloadRef, event.normalized_json AS payload,
                  event.source_event_id AS sourceEventId, event.poll_key AS pollKey,
                  event.snapshot_hash AS snapshotHash, event.snapshot_sequence AS snapshotSequence
             FROM signals JOIN episodes ON episodes.id = signals.episode_id
             JOIN events AS event ON event.id = (
               SELECT id FROM events
                WHERE chain = episodes.chain AND token_address = episodes.token_address
                ORDER BY observed_at_ms DESC, id DESC LIMIT 1
             )
            WHERE signals.id = ?`
        )
        .get(signalId) as (Omit<NormalizedEvent, 'payload'> & { payload: string }) | undefined;
      return row ? { ...row, payload: JSON.parse(row.payload) as Record<string, unknown> } : null;
    });
  }

  sentSignalIdForEpisode(episodeId: string): Promise<string | null> {
    return this.write(() => {
      const row = this.db
        .prepare("SELECT id FROM signals WHERE episode_id = ? AND delivery_state = 'SENT'")
        .get(episodeId) as { id: string } | undefined;
      return row?.id ?? null;
    });
  }

  holdObservation(
    episodeId: string,
    reason: string,
    nowMs: number,
    graceMs: number
  ): Promise<boolean> {
    return this.write(() => {
      const row = this.db
        .prepare(
          'SELECT soft_failure_since_ms AS since, expires_at_ms AS expiry FROM episodes WHERE id=? AND ended_at_ms IS NULL'
        )
        .get(episodeId) as { since: number | null; expiry: number | null } | undefined;
      if (!row) return false;
      const since = row.since ?? nowMs,
        keep = nowMs - since < graceMs && (row.expiry === null || nowMs < row.expiry);
      this.db
        .prepare(
          `UPDATE episodes SET state=?, rejection_reason=?,soft_failure_since_ms=?,
        next_evaluation_at_ms=?,ended_at_ms=?,updated_at_ms=? WHERE id=? AND ended_at_ms IS NULL`
        )
        .run(
          keep ? 'OBSERVING' : 'EXPIRED',
          reason,
          since,
          keep ? Math.min(nowMs + 30_000, since + graceMs) : null,
          keep ? null : nowMs,
          nowMs,
          episodeId
        );
      return keep;
    });
  }

  watchCandidate(
    event: NormalizedEvent,
    nowMs: number,
    capacity: number,
    expiryMs: number,
    intervalMs: number,
    reason: string
  ): Promise<void> {
    return this.write(() => {
      this.db.prepare('DELETE FROM candidate_watches WHERE expires_at_ms<=?').run(nowMs);
      if (
        this.db
          .prepare('SELECT 1 FROM candidate_watches WHERE token_address=?')
          .get(event.tokenAddress)
      ) {
        this.db
          .prepare('UPDATE candidate_watches SET event_json=?,last_reason=? WHERE token_address=?')
          .run(serializeJson(event), reason, event.tokenAddress);
        return;
      }
      const count = (
        this.db.prepare('SELECT count(*) AS n FROM candidate_watches').get() as { n: number }
      ).n;
      if (count >= capacity) return;
      this.db
        .prepare(
          'INSERT INTO candidate_watches(token_address,event_json,first_seen_at_ms,expires_at_ms,next_evaluation_at_ms,last_reason) VALUES (?,?,?,?,?,?)'
        )
        .run(
          event.tokenAddress,
          serializeJson(event),
          nowMs,
          nowMs + expiryMs,
          nowMs + intervalMs,
          reason
        );
    });
  }
  removeCandidateWatch(tokenAddress: string): Promise<void> {
    return this.write(() => {
      this.db.prepare('DELETE FROM candidate_watches WHERE token_address=?').run(tokenAddress);
    });
  }

  dueCandidateWatches(nowMs: number, intervalMs: number): Promise<NormalizedEvent[]> {
    return this.write(() => {
      this.db.prepare('DELETE FROM candidate_watches WHERE expires_at_ms<=?').run(nowMs);
      const rows = this.db
        .prepare(
          'SELECT token_address AS token,event_json AS event FROM candidate_watches WHERE next_evaluation_at_ms<=? ORDER BY next_evaluation_at_ms LIMIT 4'
        )
        .all(nowMs) as { token: string; event: string }[];
      for (const row of rows)
        this.db
          .prepare('UPDATE candidate_watches SET next_evaluation_at_ms=? WHERE token_address=?')
          .run(nowMs + intervalMs, row.token);
      return rows.map((row) => JSON.parse(row.event) as NormalizedEvent);
    });
  }

  updateWatchSnapshot(
    token: string,
    nowMs: number,
    snapshot: unknown,
    hot: boolean,
    hotCapacity: number,
    hotIntervalMs: number,
    warmIntervalMs: number
  ): Promise<void> {
    return this.write(() => {
      const row = this.db
        .prepare('SELECT priority FROM candidate_watches WHERE token_address=?')
        .get(token) as { priority: number } | undefined;
      if (!row) return;
      const count = (
        this.db
          .prepare(
            'SELECT count(*) AS n FROM candidate_watches WHERE priority=1 AND expires_at_ms>?'
          )
          .get(nowMs) as { n: number }
      ).n;
      const priority = hot && (row.priority === 1 || count < hotCapacity) ? 1 : 0;
      this.db
        .prepare(
          'UPDATE candidate_watches SET priority=?,snapshot_json=?,next_evaluation_at_ms=? WHERE token_address=?'
        )
        .run(
          priority,
          serializeJson(snapshot),
          nowMs + (priority ? hotIntervalMs : warmIntervalMs),
          token
        );
    });
  }
  recordShadowDecision(
    token: string,
    episodeId: string | null,
    revision: string,
    nowMs: number,
    decision: unknown
  ): Promise<void> {
    return this.write(() => {
      this.db
        .prepare(
          'INSERT INTO shadow_decisions(token_address,episode_id,observed_at_ms,config_revision_id,decision_json) VALUES (?,?,?,?,?)'
        )
        .run(token, episodeId, nowMs, revision, serializeJson(decision));
    });
  }
  recordSentRisk(
    token: string,
    status: 'passed' | 'failed' | 'unknown',
    reason: string | null,
    nowMs: number
  ): Promise<void> {
    return this.write(() => {
      this.db
        .prepare(
          `UPDATE signals SET decision_json=json_set(decision_json,'$.riskStatus',json(?)),updated_at_ms=?
        WHERE delivery_state='SENT' AND episode_id IN (SELECT id FROM episodes WHERE token_address=?)`
        )
        .run(serializeJson({ status, reason, checkedAtMs: nowMs }), nowMs, token);
    });
  }
  retainAudit(
    nowMs: number,
    days: number,
    batch = 500
  ): Promise<{ events: number; traces: number }> {
    return this.write(() => {
      // Detailed physical attempts are a bounded diagnostic window; minute totals persist.
      this.db
        .prepare(
          'DELETE FROM api_attempts WHERE id IN (SELECT id FROM api_attempts WHERE started_at_ms < ? ORDER BY started_at_ms LIMIT 10000)'
        )
        .run(nowMs - 86_400_000);

      const cutoff = nowMs - days * 86400000;
      // Never remove rows for tokens with Episodes or the latest source snapshot needed by recovery.
      const events = this.db
        .prepare(
          `DELETE FROM events WHERE id IN (SELECT e.id FROM events e
        WHERE e.observed_at_ms<? AND e.expires_at_ms<? AND NOT EXISTS(SELECT 1 FROM episodes ep WHERE ep.chain=e.chain AND ep.token_address=e.token_address)
        AND EXISTS(SELECT 1 FROM events newer WHERE newer.token_address=e.token_address AND newer.source=e.source AND newer.poll_key IS e.poll_key AND newer.id>e.id) LIMIT ?)`
        )
        .run(cutoff, nowMs, batch).changes;
      const traces = this.db
        .prepare(
          `DELETE FROM operation_traces WHERE id IN (SELECT t.id FROM operation_traces t
        WHERE t.occurred_at_ms<? AND NOT EXISTS(SELECT 1 FROM signals s WHERE json_extract(s.decision_json,'$.correlationId')=t.correlation_id)
        AND NOT EXISTS(SELECT 1 FROM operation_traces o JOIN episodes e ON e.token_address=json_extract(o.metadata_json,'$.tokenAddress') WHERE o.correlation_id=t.correlation_id)
        LIMIT ?)`
        )
        .run(cutoff, batch).changes;
      return { events, traces };
    });
  }

  expireOutdatedConfiguration(revisionId: string, nowMs: number): Promise<void> {
    return this.write(() => {
      this.db
        .prepare(
          `UPDATE episodes SET state='EXPIRED',ended_at_ms=?,updated_at_ms=?,rejection_reason='configuration_changed'
        WHERE ended_at_ms IS NULL AND state IN ('DISCOVERED','OBSERVING','READY') AND config_revision_id<>?`
        )
        .run(nowMs, nowMs, revisionId);
      this.db
        .prepare(
          `UPDATE signals SET delivery_state='SEND_FAILED',last_delivery_error='configuration_changed',updated_at_ms=?
        WHERE delivery_state IN ('PENDING','DELIVERY_UNKNOWN') AND config_revision_id<>?`
        )
        .run(nowMs, revisionId);
      this.db
        .prepare(
          `UPDATE episodes SET state='SEND_FAILED',ended_at_ms=?,updated_at_ms=?,rejection_reason='configuration_changed'
        WHERE state='DELIVERY_PENDING' AND id IN (SELECT episode_id FROM signals WHERE last_delivery_error='configuration_changed')`
        )
        .run(nowMs, nowMs);
    });
  }
  close(): void {
    this.db.close();
  }
}

export function serializeJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (typeof candidate === 'bigint') return candidate.toString();
    if (Decimal.isDecimal(candidate)) return candidate.toFixed();
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === 'object')
      return Object.fromEntries(
        Object.entries(candidate).map(([key, item]) => [key, normalize(item)])
      );
    if (typeof candidate === 'number' && !Number.isFinite(candidate))
      throw new TypeError('JSON values must be finite');
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decimalString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const decimal = new Decimal(value);
    return decimal.isFinite() && decimal.greaterThan(0) ? decimal.toString() : null;
  } catch {
    return null;
  }
}

function percentileValue(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
}

import { createHash } from 'node:crypto';
import type { Storage } from '../storage/database.js';
import type { MarketFact } from '../gmgn/facts.js';
import { canonicalJson } from '../discovery/events.js';
import type { NormalizedEvent } from '../discovery/events.js';
import type { OpportunityState } from '../decision/opportunity.js';

export class ResearchStorage {
  constructor(readonly storage: Storage) {}
  private quota: { bytes: number; reserved: number } | null = null;
  quotaCheckpoint(): number {
    return this.quota?.reserved ?? 0;
  }
  calibrateQuota(bytes: number, checkpoint: number): void {
    const reserved = this.quota?.reserved ?? 0;
    this.quota = { bytes: bytes + Math.max(0, reserved - checkpoint), reserved };
  }
  /** Conservative reservations between off-thread page measurements; never release on failure. */
  private reserveBytes(bytes: number, maxBytes: number): boolean {
    if (!this.quota) return this.estimatedBytes() + bytes <= maxBytes;
    if (this.quota.bytes + bytes > maxBytes) return false;
    this.quota.bytes += bytes;
    this.quota.reserved += bytes;
    return true;
  }
  reserveReferenceBytes(count: number, maxBytes: number): boolean {
    return this.reserveBytes(count * 4096, maxBytes);
  }
  quotaBytes(): number | null {
    return this.quota?.bytes ?? null;
  }
  saveOpportunity(
    runId: string,
    state: OpportunityState,
    expectedVersion: number
  ): Promise<boolean> {
    return this.storage.transaction(() => {
      const db = this.storage.db;
      const prior = db
        .prepare(
          'SELECT version FROM research_engine_states WHERE run_id=? AND model_hash=? AND token=? AND pool_revision=?'
        )
        .get(runId, state.modelHash, state.token, state.poolRevision) as
        { version: number } | undefined;
      if ((prior?.version ?? 0) !== expectedVersion || state.version !== expectedVersion + 1)
        return false;
      if (state.opportunityId) {
        const existing = db
          .prepare('SELECT state_json FROM market_opportunities WHERE opportunity_id=?')
          .get(state.opportunityId) as { state_json: string } | undefined;
        if (existing) {
          const original = JSON.parse(existing.state_json) as OpportunityState;
          for (const key of [
            'modelHash',
            'token',
            'poolRevision',
            'activationFactId',
            'anchorPrice',
            'anchorAtMs'
          ] as const) {
            if (original[key] !== state[key]) throw new Error('OPPORTUNITY_IDENTITY_CHANGED');
          }
        }
      }
      db.prepare(
        `INSERT INTO research_engine_states(run_id,model_hash,token,pool_revision,version,state_json) VALUES (?,?,?,?,?,?) ON CONFLICT(run_id,model_hash,token,pool_revision) DO UPDATE SET version=excluded.version,state_json=excluded.state_json`
      ).run(
        runId,
        state.modelHash,
        state.token,
        state.poolRevision,
        state.version,
        canonicalJson(state)
      );
      if (state.opportunityId && state.status !== 'WATCHING') {
        db.prepare(
          `INSERT INTO market_opportunities(opportunity_id,chain,token,pool_revision,model_hash,activation_fact_id,anchor_price,anchor_at_ms,state,version,state_json) VALUES (?,'bsc',?,?,?,?,?,?,?,?,?) ON CONFLICT(opportunity_id) DO UPDATE SET state=excluded.state,version=excluded.version,state_json=excluded.state_json`
        ).run(
          state.opportunityId,
          state.token,
          state.poolRevision,
          state.modelHash,
          state.activationFactId,
          state.anchorPrice,
          state.anchorAtMs,
          state.status,
          state.version,
          canonicalJson(state)
        );
      }
      return true;
    });
  }
  loadOpportunity(
    runId: string,
    modelHash: string,
    token: string,
    poolRevision: string
  ): Promise<OpportunityState | null> {
    return this.storage.write(() => {
      const row = this.storage.db
        .prepare(
          'SELECT state_json FROM research_engine_states WHERE run_id=? AND model_hash=? AND token=? AND pool_revision=?'
        )
        .get(runId, modelHash, token, poolRevision) as { state_json: string } | undefined;
      return row ? (JSON.parse(row.state_json) as OpportunityState) : null;
    });
  }
  startRun(runId: string, manifest: unknown, nowMs: number): Promise<void> {
    const json = canonicalJson(manifest),
      hash = createHash('sha256').update(json).digest('hex');
    return this.storage.transaction(() => {
      const existing = this.storage.db
        .prepare('SELECT manifest_hash FROM research_runs WHERE run_id=?')
        .get(runId) as { manifest_hash: string } | undefined;
      if (existing && existing.manifest_hash !== hash)
        throw new Error('research run manifest changed');
      this.storage.db
        .prepare(
          "INSERT OR IGNORE INTO research_runs(run_id,stage,manifest_json,manifest_hash,created_at_ms) VALUES (?,'A',?,?,?)"
        )
        .run(runId, json, hash, nowMs);
    });
  }
  recordFact(fact: MarketFact, runId: string, maxBytes: number): Promise<boolean> {
    return this.storage.transaction(() => this.writeFact(fact, runId, maxBytes));
  }
  recordFactsBatch(
    facts: readonly MarketFact[],
    runId: string,
    maxBytes: number,
    referenceRun = false
  ): Promise<boolean[]> {
    if (facts.length > 50) return Promise.reject(new Error('FACT_BATCH_BOUND'));
    return this.storage.transaction(() =>
      facts.map((fact) => {
        const inserted = this.writeFact(fact, runId, maxBytes);
        if (
          referenceRun &&
          (inserted ||
            this.storage.db
              .prepare('SELECT 1 FROM research_facts WHERE fact_id=?')
              .get(fact.factId))
        ) {
          const known = this.storage.db
            .prepare('SELECT 1 FROM research_fact_references WHERE run_id=? AND fact_id=?')
            .get(runId, fact.factId);
          if (!known) {
            if (!this.reserveReferenceBytes(1, maxBytes))
              throw new Error('TRIAL_FACT_REFERENCE_STORAGE_UNAVAILABLE');
            this.storage.db
              .prepare('INSERT INTO research_fact_references(run_id,fact_id) VALUES (?,?)')
              .run(runId, fact.factId);
          }
        }
        return inserted;
      })
    );
  }
  private writeFact(fact: MarketFact, runId: string, maxBytes: number): boolean {
    const run = this.storage.db
      .prepare('SELECT status FROM research_runs WHERE run_id=?')
      .get(runId) as { status: string } | undefined;
    if (!run || run.status !== 'ACTIVE') return false;
    const { payload, ...envelope } = fact;
    const payloadJson = canonicalJson(payload),
      envelopeJson = canonicalJson(envelope);
    const existing = this.storage.db
      .prepare(
        'SELECT fact_id,semantic_hash,envelope_json FROM research_facts WHERE attempt_id=? AND endpoint=?'
      )
      .get(fact.attemptId, fact.endpoint) as
      { fact_id: string; semantic_hash: string; envelope_json: string } | undefined;
    if (
      existing &&
      (existing.fact_id !== fact.factId ||
        existing.semantic_hash !== fact.semanticHash ||
        existing.envelope_json !== envelopeJson)
    )
      throw new Error('conflicting physical response');
    if (existing) return false;
    if (
      !this.reserveBytes(
        2 * (Buffer.byteLength(payloadJson) + Buffer.byteLength(envelopeJson)) + 65536,
        maxBytes
      )
    ) {
      this.storage.db
        .prepare("UPDATE research_runs SET status='STORAGE_BUDGET_EXHAUSTED' WHERE run_id=?")
        .run(runId);
      return false;
    }

    return (
      this.storage.db
        .prepare(
          `INSERT OR IGNORE INTO research_facts(fact_id,attempt_id,endpoint,chain,token,pool_revision,purpose,queued_at_ms,requested_at_ms,received_at_ms,semantic_hash,envelope_json,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          fact.factId,
          fact.attemptId,
          fact.endpoint,
          fact.chain,
          fact.token,
          fact.poolRevision,
          fact.purpose,
          fact.queuedAtMs,
          fact.requestedAtMs,
          fact.receivedAtMs,
          fact.semanticHash,
          envelopeJson,
          payloadJson
        ).changes === 1
    );
  }
  /** Count research table and index pages, plus registered archive bytes. */
  estimatedBytes(): number {
    const row = this.storage.db
      .prepare(
        "SELECT COALESCE(SUM(pgsize),0) AS n FROM dbstat WHERE name IN (SELECT name FROM sqlite_schema WHERE tbl_name LIKE 'research_%' OR tbl_name IN ('market_opportunities','funnel_decisions','evaluation_baselines','dataset_memberships','promotion_certificates'))"
      )
      .get() as { n: number };
    const archive = this.storage.db
      .prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM research_archives')
      .get() as { n: number };
    return row.n + archive.n;
  }
  factsAt(token: string, atMs: number): Promise<MarketFact[]> {
    return this.storage.write(() =>
      (
        this.storage.db
          .prepare(
            'SELECT envelope_json,payload_json FROM research_facts WHERE token=? AND received_at_ms<=? ORDER BY received_at_ms,fact_id'
          )
          .all(token.toLowerCase(), atMs) as {
          envelope_json: string;
          payload_json: string | null;
        }[]
      ).map((row) => {
        if (row.payload_json === null) throw new Error('archived fact requires archive resolver');
        return {
          ...(JSON.parse(row.envelope_json) as Omit<MarketFact, 'payload'>),
          payload: JSON.parse(row.payload_json) as Record<string, unknown>
        };
      })
    );
  }
  recordUniverse(
    event: NormalizedEvent,
    runId: string,
    seed: string,
    capacity = 20,
    maxBytes = 2 * 1024 ** 3
  ): Promise<void> {
    return this.recordUniverseBatch([event], runId, seed, capacity, maxBytes);
  }
  /** One small research-only transaction; no formal publication writes are batched. */
  recordUniverseBatch(
    events: readonly NormalizedEvent[],
    runId: string,
    seed: string,
    capacity = 20,
    maxBytes = 2 * 1024 ** 3
  ): Promise<void> {
    if (events.length > 50) return Promise.reject(new Error('RESEARCH_BATCH_TOO_LARGE'));
    return this.storage.transaction(() => {
      for (const event of events) this.writeUniverse(event, runId, seed, capacity, maxBytes);
    });
  }
  private writeUniverse(
    event: NormalizedEvent,
    runId: string,
    seed: string,
    capacity: number,
    maxBytes: number
  ): void {
    const run = this.storage.db
      .prepare('SELECT status,sampling_epoch FROM research_runs WHERE run_id=?')
      .get(runId) as { status: string; sampling_epoch: number } | undefined;
    if (!run || run.status !== 'ACTIVE') return;
    const known = this.storage.db
      .prepare(
        'SELECT 1 FROM research_sampling WHERE run_id=? AND chain=? AND token=? AND pool_revision=?'
      )
      .get(
        runId,
        event.chain,
        event.tokenAddress,
        typeof event.payload.biggest_pool_address === 'string' &&
          /^0x[0-9a-f]{40}$/i.test(event.payload.biggest_pool_address)
          ? event.payload.biggest_pool_address.toLowerCase()
          : 'unresolved'
      );
    if (!this.reserveBytes(known ? 128 : 65536 + 2 * Buffer.byteLength(event.key), maxBytes)) {
      this.storage.db
        .prepare("UPDATE research_runs SET status='STORAGE_BUDGET_EXHAUSTED' WHERE run_id=?")
        .run(runId);
      return;
    }
    const pool =
      typeof event.payload.biggest_pool_address === 'string' &&
      /^0x[0-9a-f]{40}$/i.test(event.payload.biggest_pool_address)
        ? event.payload.biggest_pool_address.toLowerCase()
        : 'unresolved';
    const stratum =
      event.decisionEligible === false || event.payload.contrary === true
        ? 'risk_observation'
        : 'discovered';
    this.storage.db
      .prepare(
        `INSERT INTO research_universe(chain,token,pool_revision,first_seen_at_ms,latest_seen_at_ms,first_event_key,stratum) VALUES (?,?,?,?,?,?,?) ON CONFLICT(chain,token,pool_revision) DO UPDATE SET latest_seen_at_ms=MAX(latest_seen_at_ms,excluded.latest_seen_at_ms)`
      )
      .run(
        event.chain,
        event.tokenAddress,
        pool,
        event.observedAtMs,
        event.observedAtMs,
        event.key,
        stratum
      );
    const hash = createHash('sha256')
      .update(canonicalJson([seed, event.chain, event.tokenAddress, pool]))
      .digest('hex');
    this.storage.db
      .prepare(
        `INSERT OR IGNORE INTO research_sampling(run_id,chain,token,pool_revision,sample_key,stratum,inclusion_probability,status,updated_at_ms) VALUES (?,?,?,?,?,?,0,'RESOURCE_EXCLUDED',?)`
      )
      .run(runId, event.chain, event.tokenAddress, pool, hash, stratum, event.observedAtMs);
    const epoch = Math.floor(event.observedAtMs / 60000);
    // Freeze one sampling frame per minute. Incoming events still enter the universe,
    // but cannot force an O(universe) rebalance on every physical response.
    if (run.sampling_epoch === epoch) return;
    this.storage.db
      .prepare('UPDATE research_runs SET sampling_epoch=? WHERE run_id=?')
      .run(epoch, runId);
    const rows = this.storage.db
      .prepare(
        'SELECT rowid,stratum,sample_key FROM research_sampling WHERE run_id=? ORDER BY stratum,sample_key'
      )
      .all(runId) as { rowid: number; stratum: string; sample_key: string }[];
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const group = groups.get(row.stratum) ?? [];
      group.push(row);
      groups.set(row.stratum, group);
    }
    const rotated = [...groups.values()].map((group) => {
      const offset = (epoch * capacity) % group.length;
      return [...group.slice(offset), ...group.slice(0, offset)];
    });
    const selected = new Set<number>();
    for (let rank = 0; rank < rows.length && selected.size < capacity; rank++)
      for (const group of rotated) {
        const row = group[rank];
        if (row && selected.size < capacity) selected.add(row.rowid);
      }
    const updateSample = this.storage.db.prepare(
      'UPDATE research_sampling SET status=?,inclusion_probability=?,updated_at_ms=? WHERE rowid=?'
    );
    for (const group of groups.values()) {
      const probability = group.filter((row) => selected.has(row.rowid)).length / group.length;
      for (const row of group)
        updateSample.run(
          selected.has(row.rowid) ? 'SELECTED' : 'RESOURCE_EXCLUDED',
          probability,
          event.observedAtMs,
          row.rowid
        );
    }
  }
}

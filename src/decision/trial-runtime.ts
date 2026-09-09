import { TrialRotation, type WaitingCandidate } from './trial-rotation.js';
import { screenInfo, screenBasic, type RiskFinding } from './risk-screen.js';
import { marketScreen, type MarketScreen } from './market-screen.js';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { RuntimeConfig } from '../config/types.js';
import type { CandidateGmgnApi } from '../gmgn/api.js';
import type { Clock } from '../gmgn/scheduler.js';
import { withGmgnContext } from '../gmgn/context.js';
import { responseFact, GmgnError } from '../gmgn/client.js';
import type { MarketFact } from '../gmgn/facts.js';
import type { NormalizedEvent } from '../discovery/events.js';
import type { PendingOutboxSignal, Storage } from '../storage/database.js';
import type { BusinessHealth } from '../observability/business-health.js';
import { ResearchStorage } from '../research/storage.js';
import { measureResearchInBackground } from '../research/maintenance.js';
import { MeasurementStore } from '../research/measurement-store.js';
import { OutcomeCollector } from '../research/outcome-collector.js';
import { QuoteExitCollector } from '../research/quote-exits.js';
import { TrialCohort } from '../research/trial-cohort.js';
import { quoteBaseline } from '../research/measurement.js';
import { hashValue } from '../research/protocol.js';
import { semanticBuild } from '../research/contracts.js';
import { watchingState, evaluateOpportunity, type OpportunityState } from './opportunity.js';
import { LiveOpportunityAdapter } from './live-adapter.js';
import { prepareDryOpportunity, riskPolicyHash } from './preparation.js';
import {
  loadPublicationModel,
  enqueueTrial,
  trialDecision,
  readTrialDecision
} from '../delivery/trial-publication.js';

const MAX_BYTES = 2 * 1024 ** 3;
interface Watch {
  token: string;
  key: string;
  revisit?: boolean;
  queuedAtMs: number;
  basicAtMs?: number;
  firstAtMs: number;
  seenAtMs: number;
  dueAtMs: number;
  activated: boolean;
  facts: MarketFact[];
  trader?: MarketFact;
  pool?: string;
}
/** One formal market engine; activated candidates receive timely confirmation before exploration. */
export class TrialRuntime {
  readonly model;
  readonly research;
  readonly runId;
  readonly measurements;
  readonly outcomes;
  readonly exits;
  readonly candidateOutcomes;
  readonly cohort;
  private watches = new Map<string, Watch>();
  private running = false;
  private readonly processing = new Set<string>();
  private closed = false;
  private maintenanceRunning = false;
  private lastMaintenance = 0;
  private lastTickAtMs: number | null = null;
  private counts: Record<string, number> = {};
  private failure: string | null = null;
  private readonly codeHash = semanticBuild().hash;
  private universeRecorded = new Map<string, number>();
  private readonly rotation = new TrialRotation();
  private readonly rejected = new Map<string, { expiresAtMs: number; details: RiskFinding }>();
  private maxAdmissionWaitMs = 0;
  private universePending: { atMs: number; metadata: Record<string, unknown> }[] = [];
  constructor(
    private readonly storage: Storage,
    private readonly config: RuntimeConfig,
    private readonly revision: string,
    private readonly api: CandidateGmgnApi,
    private readonly clock: Clock,
    private readonly health?: BusinessHealth
  ) {
    this.model = loadPublicationModel(config)!;
    this.runId =
      'trial-' +
      this.model.hash.slice(0, 16) +
      '-' +
      riskPolicyHash(config).slice(0, 8) +
      '-' +
      this.codeHash.slice(0, 8);
    this.research = new ResearchStorage(storage);
    this.measurements = new MeasurementStore(storage);
    this.cohort = new TrialCohort(storage, this.runId, this.model.hash);
    this.outcomes = new OutcomeCollector(
      this.research,
      () => clock.now(),
      (token, pool, fromMs, toMs) => this.captureOutcome(token, pool, fromMs, toMs, false),
      async (baselineId, target, atMs) => {
        const paired = this.storage.db
          .prepare(
            `SELECT q.baseline_id FROM evaluation_baselines q
          JOIN evaluation_baselines c ON c.opportunity_id=q.opportunity_id AND c.run_id=q.run_id
          WHERE c.baseline_id=? AND q.track='post_confirmation_quote_v1' AND q.status='VALID'`
          )
          .get(baselineId) as { baseline_id: string } | undefined;
        if (paired) await this.exits.schedule(paired.baseline_id, `target_${target}`, atMs);
      },
      'published'
    );
    this.candidateOutcomes = new OutcomeCollector(
      this.research,
      () => clock.now(),
      (token, pool, fromMs, toMs) => this.captureOutcome(token, pool, fromMs, toMs, true),
      undefined,
      'candidates'
    );
    this.exits = new QuoteExitCollector(
      storage,
      () => clock.now(),
      async (opportunityId, buy) => {
        const row = storage.db
          .prepare('SELECT state_json FROM market_opportunities WHERE opportunity_id=?')
          .get(opportunityId) as { state_json: string } | undefined;
        if (!row) throw new Error('OPPORTUNITY_MISSING');
        const state = JSON.parse(row.state_json) as OpportunityState;
        const adapter = new LiveOpportunityAdapter(api, config, [], {} as MarketFact, () =>
          clock.now()
        );
        const { decisionContext } = await import('./dry-publisher.js');
        return withGmgnContext(
          { priority: 'evaluation', purpose: 'outcome', deadlineMs: clock.now() + 5000 },
          async () => {
            const info = await adapter.fact(() => api.token('/v1/token/info', state.token));
            if (info.poolRevision !== state.poolRevision) throw new Error('EXIT_POOL_CHANGED');
            const sell = await adapter.sell(decisionContext(state, riskPolicyHash(config)), buy);
            await this.saveFacts(adapter.facts);
            return sell;
          }
        );
      }
    );
  }
  private captureOutcome(
    token: string,
    pool: string,
    fromMs: number,
    toMs: number,
    research: boolean
  ) {
    return withGmgnContext(
      { research, priority: 'evaluation', purpose: 'outcome', deadlineMs: this.clock.now() + 5000 },
      async () => {
        const info = responseFact(await this.api.token('/v1/token/info', token));
        if (!info || info.poolRevision !== pool) throw new Error('OUTCOME_POOL_CHANGED');
        await this.saveFact(info);
        const fact = responseFact(await this.api.kline(token, '30s', { fromMs, toMs }));
        if (!fact || fact.poolRevision !== pool) throw new Error('OUTCOME_POOL_CHANGED');
        return fact;
      }
    );
  }
  async start() {
    await this.research.startRun(
      this.runId,
      {
        codeHash: this.codeHash,
        engine: 'trial',
        validation: 'UNVALIDATED',
        model: this.model.manifest,
        riskHash: riskPolicyHash(this.config),
        maxWatched: 50,
        admission: {
          policy: 'fresh-and-revisit-fifo-v2',
          maximumFreshStreak: 3,
          capacity: this.rotation.capacity,
          staleMs: this.rotation.liveMs
        },
        riskScreen: 'existing-info-and-basic-limits-v1',
        marketWorkers: 3,
        candidateDiagnostics: {
          track: 'candidate_reference_v1',
          activeCapacity: 20,
          budget: 'research'
        },
        inactiveRotationMs: 30000,
        readmissionDelayMs: 30000,
        pollMs: 10000
      },
      this.clock.now()
    );
    const saved = this.storage.db
      .prepare('SELECT value_json FROM trial_runtime_checkpoints WHERE state_key=?')
      .get(this.rotationKey()) as { value_json: string } | undefined;
    if (saved)
      this.rotation.restore(JSON.parse(saved.value_json) as WaitingCandidate[], this.clock.now());
    const cached = this.storage.db
      .prepare(
        'SELECT token,pool_revision,expires_at_ms,details_json FROM trial_risk_rejections WHERE risk_hash=? AND expires_at_ms>?'
      )
      .all(riskPolicyHash(this.config), this.clock.now()) as {
      token: string;
      pool_revision: string;
      expires_at_ms: number;
      details_json: string;
    }[];
    for (const row of cached)
      this.rejected.set(row.token + row.pool_revision, {
        expiresAtMs: row.expires_at_ms,
        details: JSON.parse(row.details_json) as RiskFinding
      });
    await this.calibrate();
    await this.measurements.recover(this.clock.now());
    await this.outcomes.recover();
    await this.candidateOutcomes.recover();
    await this.exits.recover();
    // Confirmed sends whose follow-up was interrupted retain MISSING, never a later lower entry.
    const sent = this.storage.db
      .prepare(
        "SELECT id,episode_id AS episodeId,decision_json AS decision,quote_snapshot_json AS quoteSnapshot,telegram_confirmed_at_ms AS atMs FROM signals WHERE decision_format='opportunity-v1' AND delivery_state='SENT' AND telegram_confirmed_at_ms>=?"
      )
      .all(this.clock.now() - 93600000) as {
      id: string;
      episodeId: string;
      decision: string;
      quoteSnapshot: string;
      atMs: number;
    }[];
    for (const row of sent)
      await this.confirmed(
        {
          id: row.id,
          episodeId: row.episodeId,
          decision: JSON.parse(row.decision),
          quoteSnapshot: JSON.parse(row.quoteSnapshot),
          deliveryState: 'PENDING',
          retryCount: 0
        },
        row.atMs
      );
  }
  observe(event: NormalizedEvent) {
    if (this.closed || event.decisionEligible === false) return;
    const now = this.clock.now(),
      existing = this.watches.get(event.tokenAddress);
    const hint = event.payload?.biggest_pool_address;
    const pool =
      typeof hint === 'string' && /^0x[0-9a-f]{40}$/i.test(hint) ? hint.toLowerCase() : undefined;
    if (existing) {
      existing.seenAtMs = now;
      if (pool && existing.pool && pool !== existing.pool) {
        delete existing.pool;
        delete existing.trader;
        delete existing.basicAtMs;
        existing.facts = [];
      }
      return;
    }
    // The checkpoint must fit both the waiting queue and all occupied slots.
    if (
      !this.rotation.has(event.tokenAddress) &&
      this.rotation.size + this.watches.size >= this.rotation.capacity
    ) {
      this.count('WAITING_CAPACITY_EXCLUDED');
      this.recordUniverse(event, 'RESOURCE_EXCLUDED');
      return;
    }
    const status = this.rotation.observe({
      tokenAddress: event.tokenAddress,
      key: event.key ?? '',
      ...(pool ? { pool } : {}),
      firstQueuedAtMs: now,
      seenAtMs: now,
      eligibleAtMs: now
    });
    if (status === 'queued') {
      this.count('QUEUED');
      this.recordUniverse(event, 'QUEUED');
    }
    if (status === 'overflow') {
      this.count('WAITING_CAPACITY_EXCLUDED');
      this.recordUniverse(event, 'RESOURCE_EXCLUDED');
    }
  }
  private rotationKey() {
    return 'fifo-v1:' + this.model.hash + ':' + riskPolicyHash(this.config);
  }
  private async checkpointRotation() {
    const now = this.clock.now();
    const rows = this.rotation.entries();
    for (const w of this.watches.values())
      rows.push({
        tokenAddress: w.token,
        key: w.key,
        firstQueuedAtMs: w.queuedAtMs,
        seenAtMs: w.seenAtMs,
        eligibleAtMs: now,
        revisit: w.revisit ?? false,
        ...(w.pool ? { pool: w.pool } : {})
      });
    await this.storage.transaction(() => {
      this.storage.db
        .prepare(
          'INSERT INTO trial_runtime_checkpoints VALUES (?,?,?) ON CONFLICT(state_key) DO UPDATE SET updated_at_ms=excluded.updated_at_ms,value_json=excluded.value_json'
        )
        .run(this.rotationKey(), now, JSON.stringify(rows));
      this.storage.db.prepare('DELETE FROM trial_risk_rejections WHERE expires_at_ms<=?').run(now);
    });
    for (const [k, v] of this.rejected) if (v.expiresAtMs <= now) this.rejected.delete(k);
  }
  private release(w: Watch, eligibleAtMs = this.clock.now() + 30000) {
    this.watches.delete(w.token);
    const status = this.rotation.observe({
      tokenAddress: w.token,
      key: w.key,
      firstQueuedAtMs: this.clock.now(),
      seenAtMs: w.seenAtMs,
      eligibleAtMs,
      revisit: true,
      ...(w.pool ? { pool: w.pool } : {})
    });
    if (status === 'overflow') {
      this.count('WAITING_CAPACITY_EXCLUDED');
      this.recordUniverse({ tokenAddress: w.token, key: w.key }, 'RESOURCE_EXCLUDED');
    }
  }
  private admit() {
    const now = this.clock.now();
    // Bounded work even after a discovery burst or thousands of expired queue entries.
    for (let i = 0; i < 50 && this.watches.size < 50; i++) {
      const { candidate, expired } = this.rotation.take(now);
      for (const row of expired) {
        this.count('WAITING_EXPIRED');
        this.recordUniverse(row, 'WAITING_EXPIRED');
      }
      if (!candidate) {
        if (expired.length) continue;
        break;
      }
      const wait = now - candidate.firstQueuedAtMs;
      this.maxAdmissionWaitMs = Math.max(this.maxAdmissionWaitMs, wait);
      this.watches.set(candidate.tokenAddress, {
        token: candidate.tokenAddress,
        key: candidate.key,
        revisit: candidate.revisit ?? false,
        queuedAtMs: candidate.firstQueuedAtMs,
        firstAtMs: now,
        seenAtMs: candidate.seenAtMs,
        dueAtMs: now,
        activated: false,
        facts: [],
        ...(candidate.pool ? { pool: candidate.pool } : {})
      });
      this.count('DISCOVERED');
      this.recordUniverse(candidate, 'WATCHED', { waitMs: wait });
    }
  }
  private recordUniverse(
    event: Pick<NormalizedEvent, 'tokenAddress' | 'key'>,
    status: string,
    extra: Record<string, unknown> = {}
  ) {
    const now = this.clock.now(),
      key = event.tokenAddress + status;
    if (now - (this.universeRecorded.get(key) ?? -Infinity) < 60000) return;
    // Evict oldest dedup keys individually; clearing the map re-logs every discovery burst.
    if (this.universeRecorded.size >= 60000)
      this.universeRecorded.delete(this.universeRecorded.keys().next().value!);
    this.universeRecorded.set(key, now);
    if (this.universePending.length >= this.rotation.capacity * 2) {
      this.failure = 'TRIAL_UNIVERSE_BACKLOG';
      return;
    }
    this.universePending.push({
      atMs: now,
      metadata: {
        runId: this.runId,
        token: event.tokenAddress,
        eventKey: event.key,
        reason: status,
        ...extra
      }
    });
  }
  private async reject(w: Watch, finding: RiskFinding, screen?: MarketScreen) {
    const now = this.clock.now();
    this.count(finding.reason);
    this.count('EARLY_RISK_REJECTED');
    const prior = w.pool
      ? await this.research.loadOpportunity(this.runId, this.model.hash, w.token, w.pool)
      : null;
    if (prior && ['START_CANDIDATE', 'READY'].includes(prior.status))
      await this.research.saveOpportunity(
        this.runId,
        {
          ...prior,
          status: 'INVALIDATED',
          resetArmed: false,
          lastEvaluationAtMs: now,
          version: prior.version + 1
        },
        prior.version
      );
    await this.storage.transaction(() => {
      if (w.pool && finding.expiresAtMs > now)
        this.storage.db
          .prepare(
            'INSERT INTO trial_risk_rejections VALUES (?,?,?,?,?,?) ON CONFLICT(risk_hash,token,pool_revision) DO UPDATE SET reason=excluded.reason,expires_at_ms=excluded.expires_at_ms,details_json=excluded.details_json'
          )
          .run(
            riskPolicyHash(this.config),
            w.token,
            w.pool,
            finding.reason,
            finding.expiresAtMs,
            JSON.stringify(finding)
          );
      this.storage.db
        .prepare(
          "INSERT INTO operation_traces(correlation_id,stage,occurred_at_ms,metadata_json) VALUES (?,'trial_funnel',?,?)"
        )
        .run(
          randomUUID(),
          now,
          JSON.stringify({
            runId: this.runId,
            token: w.token,
            reason: finding.reason,
            stage: 'EARLY_SAFETY',
            details: finding,
            marketScreen: screen,
            opportunityId: prior?.opportunityId
          })
        );
    });
    if (w.pool && finding.expiresAtMs > now)
      this.rejected.set(w.token + w.pool, { expiresAtMs: finding.expiresAtMs, details: finding });
    this.release(w, Math.max(now, finding.expiresAtMs));
  }
  private async drainUniverse() {
    const batch = this.universePending.slice(0, 200);
    if (!batch.length) return;
    await this.storage.transaction(() => {
      const insert = this.storage.db.prepare(
        "INSERT INTO operation_traces(correlation_id,stage,occurred_at_ms,metadata_json) VALUES (?,'trial_funnel',?,?)"
      );
      for (const row of batch) insert.run(randomUUID(), row.atMs, JSON.stringify(row.metadata));
    });
    this.universePending.splice(0, batch.length);
  }

  private count(reason: string) {
    this.counts[reason] = (this.counts[reason] ?? 0) + 1;
  }
  snapshot() {
    return {
      engine: 'trial',
      codeHash: this.codeHash,
      modelId: this.model.manifest.id,
      modelHash: this.model.hash,
      runId: this.runId,
      validation: 'UNVALIDATED',
      watching: this.watches.size,
      waiting: this.rotation.size,
      riskCacheEntries: this.rejected.size,
      maxAdmissionWaitMs: this.maxAdmissionWaitMs,
      activatedWatching: [...this.watches.values()].filter((w) => w.activated).length,
      pendingUniverseWrites: this.universePending.length,
      running: this.running || this.processing.size > 0,
      activeMarketWorkers: this.processing.size,
      factStorage: { bytes: this.research.quotaBytes(), maximumBytes: MAX_BYTES },
      lastTickAtMs: this.lastTickAtMs,
      failure: this.failure,
      counts: this.counts
    };
  }
  private async saveFact(fact: MarketFact) {
    await this.saveFacts([fact]);
  }
  private async saveFacts(facts: readonly MarketFact[]) {
    const results = await this.research.recordFactsBatch(facts, this.runId, MAX_BYTES, true);
    for (const [index, ok] of results.entries())
      if (
        !ok &&
        !this.storage.db
          .prepare('SELECT 1 FROM research_facts WHERE fact_id=?')
          .get(facts[index]!.factId)
      )
        throw new Error('TRIAL_FACT_STORAGE_UNAVAILABLE');
  }
  private async calibrate() {
    await this.checkpointRotation();
    const checkpoint = this.research.quotaCheckpoint();
    const bytes =
      this.storage.db.name === ':memory:'
        ? this.research.estimatedBytes()
        : await measureResearchInBackground(
            this.storage,
            join(dirname(this.storage.db.name), 'research-archives'),
            MAX_BYTES,
            true
          );
    this.research.calibrateQuota(bytes, checkpoint);
    this.lastMaintenance = this.clock.now();
  }
  async tick() {
    if (this.running || this.processing.size >= 3 || this.closed || this.failure) return;
    if (this.clock.now() - this.lastMaintenance > 60000 && !this.maintenanceRunning) {
      this.maintenanceRunning = true;
      void this.calibrate()
        .catch(() => {
          this.failure = 'TRIAL_MAINTENANCE_FAILED';
        })
        .finally(() => {
          this.maintenanceRunning = false;
        });
    }
    this.running = true;
    let dispatchOwned = true;
    let processingToken: string | undefined;
    this.lastTickAtMs = this.clock.now();
    try {
      await this.drainUniverse();
      for (const [key, w] of this.watches)
        if (
          !this.processing.has(key) &&
          (this.clock.now() - w.seenAtMs > 120000 || this.clock.now() - w.firstAtMs > 600000)
        )
          this.watches.delete(key);
      this.admit();
      const watch = [...this.watches.values()]
        .filter((w) => w.dueAtMs <= this.clock.now() && !this.processing.has(w.token))
        .sort(
          (a, b) =>
            Number(b.activated) - Number(a.activated) ||
            a.dueAtMs - b.dueAtMs ||
            a.token.localeCompare(b.token)
        )[0];
      if (!watch) return;
      watch.dueAtMs = this.clock.now() + 10000;
      if (
        this.storage.db
          .prepare("SELECT 1 FROM publication_token_locks WHERE chain='bsc' AND token=?")
          .get(watch.token)
      ) {
        this.watches.delete(watch.token);
        this.count('TOKEN_ALREADY_DELIVERED_OR_UNKNOWN');
        return;
      }
      const cached = watch.pool ? this.rejected.get(watch.token + watch.pool) : undefined;
      if (cached && cached.expiresAtMs > this.clock.now()) {
        this.count('RISK_CACHE_HIT');
        this.recordUniverse({ tokenAddress: watch.token, key: watch.key }, 'RISK_CACHE_HIT', {
          cachedReason: cached.details.reason,
          until: cached.expiresAtMs
        });
        this.release(watch, cached.expiresAtMs);
        return;
      }
      processingToken = watch.token;
      this.processing.add(watch.token);
      this.running = false;
      dispatchOwned = false;
      await withGmgnContext(
        { priority: 'candidate', purpose: 'legacy_formal', deadlineMs: this.clock.now() + 30000 },
        async () => {
          const info = responseFact(await this.api.token('/v1/token/info', watch.token));
          if (!info) {
            this.count('INFO_UNAVAILABLE');
            this.release(watch);
            return;
          }
          await this.saveFact(info);
          this.recordUniverse({ tokenAddress: watch.token, key: watch.key }, 'INFO_OBSERVED', {
            lane: watch.revisit ? 'revisit' : 'fresh',
            waitMs: this.clock.now() - watch.queuedAtMs
          });
          if (info.poolRevision === 'unresolved') {
            this.recordUniverse(
              { tokenAddress: watch.token, key: watch.key },
              'INFO_POOL_UNRESOLVED',
              { factId: info.factId }
            );
            this.count('INFO_UNAVAILABLE');
            this.release(watch);
            return;
          }
          if (watch.pool && watch.pool !== info.poolRevision) {
            watch.facts = [];
            delete watch.trader;
            delete watch.basicAtMs;
          }
          const oldPools = this.storage.db
            .prepare(
              "SELECT state_json FROM research_engine_states WHERE run_id=? AND model_hash=? AND token=? AND pool_revision<>? AND json_extract(state_json,'$.status') IN ('START_CANDIDATE','READY')"
            )
            .all(this.runId, this.model.hash, watch.token, info.poolRevision) as {
            state_json: string;
          }[];
          for (const row of oldPools) {
            const old = JSON.parse(row.state_json) as OpportunityState;
            await this.research.saveOpportunity(
              this.runId,
              {
                ...old,
                status: 'INVALIDATED',
                resetArmed: false,
                lastEvaluationAtMs: this.clock.now(),
                version: old.version + 1
              },
              old.version
            );
          }
          watch.pool = info.poolRevision;
          const screen = marketScreen(this.model.manifest, info, this.clock.now());
          this.count('SCREEN_MARKET_' + screen.activation);
          const infoRisk = screenInfo(info, this.config, this.clock.now());
          const baseline = await this.cohort.register(info, screen, infoRisk);
          if (baseline) {
            await this.candidateOutcomes.scheduleNext(baseline);
            this.count('CANDIDATE_BASELINE_REGISTERED');
          }
          if (infoRisk) {
            this.count('SCREEN_RISK_' + infoRisk.kind.toUpperCase());
            await this.reject(watch, infoRisk, screen);
            return;
          }
          this.count('SCREEN_RISK_PASS');
          watch.facts = [
            ...watch.facts.filter((f) => this.clock.now() - f.receivedAtMs <= 60000),
            info
          ];
          const previous =
            (await this.research.loadOpportunity(
              this.runId,
              this.model.hash,
              watch.token,
              info.poolRevision
            )) ?? watchingState(watch.token, info.poolRevision, this.model.hash);
          const evaluationAtMs = this.clock.now();
          const decision = evaluateOpportunity(
            previous,
            {
              model: this.model.manifest,
              token: watch.token,
              poolRevision: info.poolRevision,
              facts: watch.facts,
              evaluationAtMs
            },
            this.model.hash
          );
          watch.activated = decision.stageResults.activation === 'PASS';
          this.count(decision.reason);
          for (const [stage, result] of Object.entries(decision.stageResults))
            this.count(`${stage}_${result}`);
          if (
            decision.state.version !== previous.version &&
            !(await this.research.saveOpportunity(this.runId, decision.state, previous.version))
          )
            return;
          await this.storage.recordOperationTrace({
            correlationId: randomUUID(),
            stage: 'trial_funnel',
            occurredAtMs: this.clock.now(),
            metadata: {
              runId: this.runId,
              token: watch.token,
              modelHash: this.model.hash,
              reason: decision.reason,
              stages: decision.stageResults,
              requiredFacts: decision.requiredFacts,
              marketScreen: screen,
              evaluationAtMs,
              inputFactIds: watch.facts.map((f) => f.factId),
              previousState: previous,
              opportunityId: decision.state.opportunityId
            }
          });
          if (
            decision.stageResults.activation === 'FAIL' ||
            ['INVALIDATED', 'MISSED', 'CONSUMED'].includes(decision.state.status)
          ) {
            this.release(watch);
            this.count('INACTIVE_WATCH_ROTATED');
            return;
          }
          if (!watch.activated && this.clock.now() - watch.firstAtMs >= 30000) {
            this.count('DATA_WAIT_ROTATED');
            this.recordUniverse({ tokenAddress: watch.token, key: watch.key }, 'DATA_WAIT_ROTATED');
            this.release(watch);
            return;
          }
          if (
            decision.stageResults.activation === 'PASS' &&
            (!watch.basicAtMs ||
              this.clock.now() - watch.basicAtMs >=
                this.config.quote.security_pool_max_age_seconds * 1000)
          ) {
            const security = responseFact(await this.api.token('/v1/token/security', watch.token));
            const pool = responseFact(await this.api.token('/v1/token/pool_info', watch.token));
            const received = [security, pool].filter((f): f is MarketFact => !!f);
            await this.saveFacts(received);
            if (!security || !pool) {
              this.count('BASIC_FACT_MISSING');
              this.release(watch);
              return;
            }
            const basic = screenBasic(info, security, pool, this.config, this.clock.now());
            if (basic) {
              await this.reject(watch, basic);
              return;
            }
            watch.basicAtMs = Math.min(
              info.requestedAtMs,
              security.requestedAtMs,
              pool.requestedAtMs
            );
            this.count('BASIC_SAFETY_PASS');
          }
          if (decision.state.status !== 'READY' || decision.reason === 'DATA_WAIT') return;
          const now = this.clock.now(),
            minimum =
              (this.config.security.lazy_deep.coordinated_exit.min_snapshot_interval_seconds ??
                10) * 1000;
          if (
            !watch.trader ||
            now - watch.trader.receivedAtMs >
              this.config.security.lazy_deep.coordinated_exit.max_activity_age_seconds * 1000
          ) {
            // Warm a comparable trader snapshot; no quote is requested before full safety.
            const raw = await this.api.traders(watch.token);
            const trader = responseFact(raw);
            if (!trader) throw new Error('TRADER_FACT_MISSING');
            await this.saveFact(trader);
            watch.trader = trader;
            this.count('TRADER_BASELINE_WAIT');
            return;
          }
          if (now - watch.trader.receivedAtMs < minimum) {
            this.count('TRADER_BASELINE_WAIT');
            return;
          }
          const adapter = new LiveOpportunityAdapter(
            this.api,
            this.config,
            watch.facts,
            watch.trader,
            () => this.clock.now()
          );
          this.health?.safetyStarted();
          const result = await withGmgnContext({ priority: 'formal' }, () =>
            prepareDryOpportunity({
              manifest: this.model.manifest,
              state: decision.state,
              config: this.config,
              now: () => this.clock.now(),
              adapter
            })
          );
          this.health?.safetyFinished();
          await this.storage.recordOperationTrace({
            correlationId: randomUUID(),
            stage: 'trial_funnel',
            occurredAtMs: this.clock.now(),
            metadata: {
              runId: this.runId,
              token: watch.token,
              opportunityId: decision.state.opportunityId,
              reason: result.status === 'DRY_READY' ? 'PREPARATION_PASS' : result.reason,
              qualification: result.qualification,
              details: result.details,
              inputFactIds: [...watch.facts, ...adapter.facts, watch.trader].map((f) => f.factId),
              previousState: decision.state
            }
          });
          this.count(result.status === 'DRY_READY' ? 'PREPARATION_PASS' : result.reason);
          const preparedAtMs = this.clock.now();
          await this.saveFacts(adapter.facts);
          if (result.status === 'CANCELLED') {
            await this.research.saveOpportunity(this.runId, result.state, decision.state.version);
            this.release(watch);
            return;
          }
          const d = trialDecision({
            runId: this.runId,
            prepared: result,
            modelId: this.model.manifest.id,
            preparedAtMs,
            evidence: {
              marketFacts: watch.facts,
              traderBaseline: watch.trader,
              facts: adapter.facts,
              quotes: adapter.quotes
            }
          });
          const id = await enqueueTrial(this.storage, d, this.revision);
          if (id) {
            this.count('OUTBOX_CREATED');
            await this.research.saveOpportunity(
              this.runId,
              { ...result.state, status: 'CONSUMED', version: decision.state.version + 1 },
              decision.state.version
            );
            this.watches.delete(watch.token);
          }
        }
      );
    } catch (error) {
      const reason =
        error instanceof GmgnError
          ? `API_${error.kind}`
          : error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : 'TRIAL_PROCESSING_FAILED';
      this.count(reason);
      if (reason.includes('STORAGE') || reason.includes('SQLITE')) this.failure = reason;
      await this.storage.recordOperationTrace({
        correlationId: randomUUID(),
        stage: 'trial_error',
        occurredAtMs: this.clock.now(),
        metadata: { runId: this.runId, reason }
      });
    } finally {
      if (dispatchOwned) this.running = false;
      if (processingToken) this.processing.delete(processingToken);
    }
  }
  private outcomesRunning = false;
  async outcomeTick() {
    if (this.outcomesRunning || this.closed) return;
    this.outcomesRunning = true;
    try {
      if (!(await this.exits.tick()) && !(await this.outcomes.tick()))
        await this.candidateOutcomes.tick();
    } finally {
      this.outcomesRunning = false;
    }
  }
  async confirmed(signal: PendingOutboxSignal, confirmedAtMs: number) {
    if (
      !this.storage.db
        .prepare(
          "SELECT 1 FROM signals WHERE id=? AND delivery_state='SENT' AND telegram_confirmed_at_ms=?"
        )
        .get(signal.id, confirmedAtMs)
    )
      throw new Error('ACTUAL_CONFIRMATION_NOT_PERSISTED');
    const d = readTrialDecision(signal.decision),
      opportunityId = d.context.opportunityId;
    const common = {
      runId: d.runId,
      opportunityId,
      confirmationAtMs: confirmedAtMs,
      confirmationKind: 'ACTUAL' as const
    };
    const cardId = await this.measurements.begin({ ...common, track: 'trial_card_reference_v1' });
    const facts = (d.evidence as { facts: MarketFact[] }).facts;
    const cardFact = facts.filter((f) => f.endpoint === 'info').at(-1)!;
    await this.measurements.settle(cardId, {
      status: 'VALID',
      reason: 'UNVERIFIED_SOURCE_CARD_DIAGNOSTIC_ONLY',
      price: d.referencePrice,
      availableAtMs: d.referenceAtMs,
      sourceAtMs: null,
      factId: cardFact.factId
    });
    const marketId = await this.measurements.begin({
      ...common,
      track: 'post_confirmation_market_v1'
    });
    await this.measurements.settle(marketId, {
      status: 'UNVERIFIED',
      reason: 'PRICE_SOURCE_TIME_UNVERIFIED',
      price: null,
      availableAtMs: null,
      sourceAtMs: null,
      factId: null
    });
    const quoteId = await this.measurements.begin({
      ...common,
      track: 'post_confirmation_quote_v1'
    });
    if (await this.measurements.isPending(quoteId)) {
      try {
        if (d.runId !== this.runId) throw new Error('BASELINE_RUN_CHANGED');
        if (this.clock.now() >= confirmedAtMs + 5000) throw new Error('BASELINE_DEADLINE_EXPIRED');
        if (!(await this.measurements.claimBaselineAttempt(quoteId, this.clock.now())))
          throw new Error('BASELINE_ATTEMPT_EXHAUSTED');
        const adapter = new LiveOpportunityAdapter(
          this.api,
          this.config,
          [],
          {} as MarketFact,
          () => this.clock.now()
        );
        const buy = await withGmgnContext(
          { priority: 'evaluation', purpose: 'baseline', deadlineMs: confirmedAtMs + 5000 },
          async () => {
            const info = await adapter.fact(() => this.api.token('/v1/token/info', d.tokenAddress));
            if (info.poolRevision !== d.context.poolRevision)
              throw new Error('BASELINE_POOL_CHANGED');
            return adapter.buy(d.context);
          }
        );
        await this.saveFacts(adapter.facts);
        await this.storage.write(() =>
          this.storage.db
            .prepare('INSERT OR IGNORE INTO research_registrations VALUES (?,?,?,?,?,?)')
            .run(
              hashValue([d.runId, opportunityId, 'baseline_quotes']),
              'baseline_quotes',
              d.runId,
              this.clock.now(),
              hashValue([buy]),
              JSON.stringify([buy])
            )
        );
        await this.measurements.settle(quoteId, quoteBaseline(buy, confirmedAtMs));
      } catch {
        await this.measurements.settle(quoteId, {
          status: 'MISSING',
          reason: 'CONFIRMATION_QUOTE_UNAVAILABLE',
          price: null,
          availableAtMs: null,
          sourceAtMs: null,
          factId: null
        });
      }
    }
    await this.outcomes.scheduleNext(cardId);
    await this.exits.schedule(quoteId, 'audit60s', confirmedAtMs + 60000);
  }
  async close() {
    this.closed = true;
    while (this.running || this.processing.size || this.outcomesRunning || this.maintenanceRunning)
      await this.clock.sleep(50);
    while (this.universePending.length) await this.drainUniverse();
    await this.checkpointRotation();
  }
}

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
  firstAtMs: number;
  seenAtMs: number;
  dueAtMs: number;
  facts: MarketFact[];
  trader?: MarketFact;
  pool?: string;
}
/** One formal market engine, with fixed fair polling and a bounded candidate set. */
export class TrialRuntime {
  readonly model;
  readonly research;
  readonly runId;
  readonly measurements;
  readonly outcomes;
  readonly exits;
  private watches = new Map<string, Watch>();
  private running = false;
  private closed = false;
  private maintenanceRunning = false;
  private lastMaintenance = 0;
  private lastTickAtMs: number | null = null;
  private counts: Record<string, number> = {};
  private failure: string | null = null;
  private readonly codeHash = semanticBuild().hash;
  private universeRecorded = new Map<string, number>();
  private admissionAfter = new Map<string, number>();
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
    this.outcomes = new OutcomeCollector(
      this.research,
      () => clock.now(),
      async (token, pool, fromMs, toMs) => {
        const fact = responseFact(
          await withGmgnContext(
            { priority: 'evaluation', purpose: 'outcome', deadlineMs: clock.now() + 5000 },
            async () => {
              const info = responseFact(await api.token('/v1/token/info', token));
              if (!info || info.poolRevision !== pool) throw new Error('OUTCOME_POOL_CHANGED');
              await this.saveFact(info);
              return api.kline(token, '30s', { fromMs, toMs });
            }
          )
        );
        if (!fact || fact.poolRevision !== pool) throw new Error('OUTCOME_POOL_CHANGED');
        return fact;
      },
      async (baselineId, target, atMs) => {
        const paired = this.storage.db
          .prepare(
            `SELECT q.baseline_id FROM evaluation_baselines q
          JOIN evaluation_baselines c ON c.opportunity_id=q.opportunity_id AND c.run_id=q.run_id
          WHERE c.baseline_id=? AND q.track='post_confirmation_quote_v1' AND q.status='VALID'`
          )
          .get(baselineId) as { baseline_id: string } | undefined;
        if (paired) await this.exits.schedule(paired.baseline_id, `target_${target}`, atMs);
      }
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
        const adapter = new LiveOpportunityAdapter(api, config, [], {} as MarketFact);
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
        inactiveRotationMs: 30000,
        readmissionDelayMs: 30000,
        pollMs: 10000
      },
      this.clock.now()
    );
    await this.calibrate();
    await this.measurements.recover(this.clock.now());
    await this.exits.recover();
    // Confirmed sends whose follow-up was interrupted retain MISSING, never a later lower entry.
    const sent = this.storage.db
      .prepare(
        "SELECT id,episode_id AS episodeId,decision_json AS decision,quote_snapshot_json AS quoteSnapshot,telegram_confirmed_at_ms AS atMs FROM signals WHERE decision_format='opportunity-v1' AND delivery_state='SENT' AND json_extract(decision_json,'$.runId')=?"
      )
      .all(this.runId) as {
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
    if (existing) {
      existing.seenAtMs = now;
      return;
    }
    if ((this.admissionAfter.get(event.tokenAddress) ?? 0) > now) return;
    this.admissionAfter.delete(event.tokenAddress);
    if (this.watches.size >= 50) {
      this.recordUniverse(event, 'RESOURCE_EXCLUDED');
      this.count('WATCH_CAPACITY_EXCLUDED');
      return;
    }
    this.watches.set(event.tokenAddress, {
      token: event.tokenAddress,
      firstAtMs: now,
      seenAtMs: now,
      dueAtMs: now,
      facts: []
    });
    this.recordUniverse(event, 'WATCHED');
    this.count('DISCOVERED');
  }
  private recordUniverse(event: NormalizedEvent, status: string) {
    const now = this.clock.now(),
      key = event.tokenAddress + status;
    if (now - (this.universeRecorded.get(key) ?? -Infinity) < 60000) return;
    if (this.universeRecorded.size >= 2000) this.universeRecorded.clear();
    this.universeRecorded.set(key, now);
    if (this.universePending.length >= 2000) {
      this.failure = 'TRIAL_UNIVERSE_BACKLOG';
      return;
    }
    this.universePending.push({
      atMs: now,
      metadata: {
        runId: this.runId,
        token: event.tokenAddress,
        eventKey: event.key,
        reason: status
      }
    });
  }
  private async drainUniverse() {
    const batch = this.universePending.slice(0, 50);
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
      pendingUniverseWrites: this.universePending.length,
      running: this.running,
      lastTickAtMs: this.lastTickAtMs,
      failure: this.failure,
      counts: this.counts
    };
  }
  private async saveFact(fact: MarketFact) {
    const ok = await this.research.recordFact(fact, this.runId, MAX_BYTES);
    if (
      !ok &&
      !this.storage.db.prepare('SELECT 1 FROM research_facts WHERE fact_id=?').get(fact.factId)
    )
      throw new Error('TRIAL_FACT_STORAGE_UNAVAILABLE');
  }
  private async saveFacts(facts: readonly MarketFact[]) {
    const results = await this.research.recordFactsBatch(facts, this.runId, MAX_BYTES);
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
    if (this.running || this.closed || this.failure) return;
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
    this.lastTickAtMs = this.clock.now();
    try {
      await this.drainUniverse();
      for (const [key, w] of this.watches)
        if (this.clock.now() - w.seenAtMs > 120000 || this.clock.now() - w.firstAtMs > 600000)
          this.watches.delete(key);
      const watch = [...this.watches.values()]
        .filter((w) => w.dueAtMs <= this.clock.now())
        .sort((a, b) => a.dueAtMs - b.dueAtMs || a.token.localeCompare(b.token))[0];
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
      await withGmgnContext(
        { priority: 'candidate', purpose: 'legacy_formal', deadlineMs: this.clock.now() + 30000 },
        async () => {
          const info = responseFact(await this.api.token('/v1/token/info', watch.token));
          if (!info || info.poolRevision === 'unresolved') {
            this.count('INFO_UNAVAILABLE');
            return;
          }
          await this.saveFact(info);
          if (watch.pool && watch.pool !== info.poolRevision) {
            watch.facts = [];
            delete watch.trader;
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
          const decision = evaluateOpportunity(
            previous,
            {
              model: this.model.manifest,
              token: watch.token,
              poolRevision: info.poolRevision,
              facts: watch.facts,
              evaluationAtMs: this.clock.now()
            },
            this.model.hash
          );
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
              opportunityId: decision.state.opportunityId
            }
          });
          if (
            decision.state.status === 'WATCHING' &&
            this.clock.now() - watch.firstAtMs >= 30000 &&
            watch.facts.length >= 2
          ) {
            this.watches.delete(watch.token);
            if (this.admissionAfter.size >= 2000) this.admissionAfter.clear();
            this.admissionAfter.set(watch.token, this.clock.now() + 30000);
            this.count('INACTIVE_WATCH_ROTATED');
            return;
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
            watch.trader
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
              qualification: result.qualification
            }
          });
          this.count(result.status === 'DRY_READY' ? 'PREPARATION_PASS' : result.reason);
          const preparedAtMs = this.clock.now();
          await this.saveFacts(adapter.facts);
          if (result.status === 'CANCELLED') {
            await this.research.saveOpportunity(this.runId, result.state, decision.state.version);
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
        metadata: { reason }
      });
    } finally {
      this.running = false;
    }
  }
  private outcomesRunning = false;
  async outcomeTick() {
    if (this.outcomesRunning || this.closed) return;
    this.outcomesRunning = true;
    try {
      if (!(await this.exits.tick())) await this.outcomes.tick();
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
    if (d.modelHash !== this.model.hash || d.runId !== this.runId) return;
    const common = {
      runId: this.runId,
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
        if (this.clock.now() >= confirmedAtMs + 5000) throw new Error('BASELINE_DEADLINE_EXPIRED');
        if (!(await this.measurements.claimBaselineAttempt(quoteId, this.clock.now())))
          throw new Error('BASELINE_ATTEMPT_EXHAUSTED');
        const adapter = new LiveOpportunityAdapter(this.api, this.config, [], {} as MarketFact);
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
              hashValue([this.runId, opportunityId, 'baseline_quotes']),
              'baseline_quotes',
              this.runId,
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
    while (this.running || this.outcomesRunning || this.maintenanceRunning)
      await this.clock.sleep(50);
    while (this.universePending.length) await this.drainUniverse();
  }
}

import type { PendingOutboxSignal } from '../storage/database.js';
import { controlPolicyHash } from './selection.js';
import { readFileSync } from 'node:fs';
import { Decimal } from 'decimal.js';
import type { RuntimeConfig } from '../config/types.js';
import type { CandidateGmgnApi } from '../gmgn/api.js';
import { responseFact } from '../gmgn/client.js';
import { withGmgnContext } from '../gmgn/context.js';
import type { Clock } from '../gmgn/scheduler.js';
import type { MarketFact, RequestPurpose } from '../gmgn/facts.js';
import { parseGmgnQuote } from '../gmgn/quote.js';
import { WBNB_ADDRESS, usdToWbnbAtoms } from '../quote/gmgn-provider.js';
import { validateModel } from '../decision/model.js';
import { evaluateOpportunity, watchingState } from '../decision/opportunity.js';
import { prepareDryOpportunity, type RiskBundle } from '../decision/preparation.js';
import { decisionContext, type DecisionContext } from '../decision/dry-publisher.js';
import type { OpportunityState } from '../decision/opportunity.js';
import { riskPolicyHash } from '../decision/preparation.js';
import { assessCoordinatedExit, type TraderSnapshot } from '../safety/coordinated-exit.js';
import { hashValue } from './protocol.js';
import type { QuoteObservation } from './measurement.js';
import { BaselineSampler } from './baseline-sampler.js';
import { MeasurementStore } from './measurement-store.js';
import { OutcomeCollector } from './outcome-collector.js';
import type { ResearchRecorder } from './recorder.js';
import { ResearchArchive } from './archive.js';
import { dirname, join } from 'node:path';
import { researchBudgetContractHash } from './budget-check.js';
import { QuoteExitCollector } from './quote-exits.js';
import { ResearchQuoteCache } from './quote-cache.js';

export function loadResearchModel(config: RuntimeConfig) {
  const r = config.research;
  if (!r || ['off', 'observe'].includes(r.mode)) return null;
  const limits = config.gmgn.rate_limit;
  if (
    limits.soft_weight_per_second !== 14 ||
    limits.hard_weight_per_second !== 20 ||
    limits.burst_reserve_weight < 6
  )
    throw new Error('RESEARCH_RESOURCE_POLICY_MISMATCH');
  if (r.mode === 'collect') return null;
  if (!r.manifest_path || !r.budget_evidence_path)
    throw new Error('SHADOW_MANIFEST_AND_BUDGET_REQUIRED');
  const evidence = JSON.parse(readFileSync(r.budget_evidence_path, 'utf8')) as Record<
    string,
    unknown
  >;
  const { evidenceHash, ...body } = evidence;
  if (
    evidenceHash !== hashValue(body) ||
    evidence.status !== 'PASS' ||
    evidence.productionEnablement !== true ||
    evidence.runtimeContractHash !== researchBudgetContractHash() ||
    evidence.scope !== 'RECORDED_ARRIVAL_MOCK_TRANSPORT' ||
    evidence.quoteGapMs !== (limits.quote_completion_gap_ms ?? 1000)
  )
    throw new Error('SHADOW_BUDGET_EVIDENCE_INVALID');
  return validateModel(JSON.parse(readFileSync(r.manifest_path, 'utf8')) as unknown);
}

/** The application owns one runtime. All additional traffic re-enters its existing physical scheduler. */
export class ResearchRuntime {
  private running = false;
  private readonly lastPoll = new Map<string, number>();
  private readonly baselines: BaselineSampler;
  private readonly outcomes: OutcomeCollector;
  private readonly model: ReturnType<typeof loadResearchModel>;
  private readonly exits: QuoteExitCollector;
  private readonly quoteCache = new ResearchQuoteCache();
  private readonly marketRevisions = new Map<string, string>();
  constructor(
    private readonly recorder: ResearchRecorder,
    private readonly config: RuntimeConfig,
    private readonly api: CandidateGmgnApi,
    private readonly clock: Clock
  ) {
    this.model = loadResearchModel(config);
    this.baselines = new BaselineSampler(new MeasurementStore(recorder.research.storage), clock);
    this.exits = new QuoteExitCollector(
      recorder.research.storage,
      () => clock.now(),
      async (opportunityId, buy) => {
        const row = (await recorder.research.storage.write(() =>
          recorder.research.storage.db
            .prepare('SELECT state_json FROM market_opportunities WHERE opportunity_id=?')
            .get(opportunityId)
        )) as { state_json: string } | undefined;
        if (!row) throw new Error('EXIT_OPPORTUNITY_MISSING');
        return this.quote(
          decisionContext(JSON.parse(row.state_json) as OpportunityState, riskPolicyHash(config)),
          buy,
          undefined,
          true,
          'outcome'
        );
      }
    );
    this.outcomes = new OutcomeCollector(
      recorder.research,
      () => clock.now(),
      (token, pool, from, to) =>
        this.fact('outcome', () => api.kline(token, '30s', { fromMs: from, toMs: to })).then(
          (f) => {
            if (f.poolRevision !== pool) throw new Error('OUTCOME_POOL_CHANGED');
            return f;
          }
        ),
      async (marketId, target, atMs) => {
        const row = (await recorder.research.storage.write(() =>
          recorder.research.storage.db
            .prepare(
              `SELECT q.baseline_id FROM evaluation_baselines m JOIN evaluation_baselines q
          ON q.run_id=m.run_id AND q.opportunity_id=m.opportunity_id AND q.track='post_confirmation_quote_v1' WHERE m.baseline_id=?`
            )
            .get(marketId)
        )) as { baseline_id: string } | undefined;
        if (row) await this.exits.schedule(row.baseline_id, `target_${target}`, atMs);
      }
    );
  }
  async start() {
    const storage = this.recorder.research.storage,
      runId = this.recorder.config.run_id;
    const preparations = storage.db
      .prepare(
        "SELECT manifest_json,manifest_hash FROM research_registrations WHERE dataset_hash=? AND kind='dry_preparation'"
      )
      .all(runId) as { manifest_json: string; manifest_hash: string }[];
    const measurements = new MeasurementStore(storage);
    for (const row of preparations) {
      const record = JSON.parse(row.manifest_json) as {
        preparedAtMs: number;
        result: { status: string; context: DecisionContext };
      };
      if (hashValue(record) !== row.manifest_hash || !Number.isSafeInteger(record.preparedAtMs))
        throw new Error('PREPARATION_RECOVERY_UNVERIFIED');
      const ctx = record.result.context;
      const state = await this.recorder.research.loadOpportunity(
        runId,
        ctx.modelHash,
        ctx.token,
        ctx.poolRevision
      );
      if (state?.opportunityId === ctx.opportunityId && state.status === 'READY')
        await this.recorder.research.saveOpportunity(
          runId,
          {
            ...state,
            status: record.result.status === 'DRY_READY' ? 'CONSUMED' : 'INVALIDATED',
            resetArmed: false,
            version: state.version + 1
          },
          state.version
        );
      const hasBaseline = storage.db
        .prepare('SELECT 1 FROM evaluation_baselines WHERE run_id=? AND opportunity_id=? LIMIT 1')
        .get(runId, ctx.opportunityId);
      if (!hasBaseline) {
        if (record.result.status !== 'DRY_READY')
          await measurements.missingPreparation(runId, ctx.opportunityId, record.preparedAtMs);
        else
          for (const track of [
            'post_confirmation_market_v1',
            'post_confirmation_quote_v1',
            'card_reference_legacy'
          ] as const) {
            const id = await measurements.begin({
              runId,
              opportunityId: ctx.opportunityId,
              track,
              confirmationKind: 'SIMULATED',
              confirmationAtMs: record.preparedAtMs + 1000
            });
            await measurements.settle(id, {
              status: 'MISSING',
              reason: 'RESTART_AFTER_PREPARATION',
              price: null,
              availableAtMs: null,
              sourceAtMs: null,
              factId: null
            });
          }
      }
    }
    await new MeasurementStore(this.recorder.research.storage).recover(this.clock.now());
    await this.exits.recover();
    await this.recorder.research.storage.write(() =>
      this.recorder.research.storage.db
        .prepare(
          `UPDATE evaluation_baselines
      SET status='MISSING',reason='RESTART_PENDING_CAPTURE' WHERE run_id=? AND status='PENDING'`
        )
        .run(this.recorder.config.run_id)
    );
  }
  /** ACTUAL is a separate measurement cohort. It does not invent a pre-preparation control opportunity. */
  async confirmed(signal: PendingOutboxSignal, confirmedAtMs: number) {
    if (
      !['collect', 'execute_shadow'].includes(this.recorder.config.mode) ||
      this.recorder.stoppedReason
    )
      return;
    const r = this.recorder.research,
      runId = this.recorder.config.run_id;
    const saved = r.storage.db
      .prepare(
        "SELECT e.token_address FROM signals s JOIN episodes e ON e.id=s.episode_id WHERE s.id=? AND s.delivery_state='SENT' AND s.telegram_confirmed_at_ms=?"
      )
      .get(signal.id, confirmedAtMs) as { token_address: string } | undefined;
    if (!saved) throw new Error('ACTUAL_CONFIRMATION_NOT_PERSISTED');
    const row = r.storage.db
      .prepare(
        "SELECT fact_id FROM research_facts WHERE token=? AND endpoint='info' AND received_at_ms<=? ORDER BY received_at_ms DESC,fact_id DESC LIMIT 1"
      )
      .get(saved.token_address, confirmedAtMs) as { fact_id: string } | undefined;
    if (!row) throw new Error('ACTUAL_ANCHOR_FACT_MISSING');
    const fact = await this.recorder.archive.resolve(row.fact_id);
    const price = (fact.payload.price as { price?: string } | undefined)?.price;
    if (!price || fact.poolRevision === 'unresolved') throw new Error('ACTUAL_ANCHOR_UNVERIFIED');
    const state: OpportunityState = {
      ...watchingState(saved.token_address, fact.poolRevision, controlPolicyHash(this.config)),
      opportunityId: hashValue([runId, signal.id, 'actual']),
      activationFactId: fact.factId,
      anchorPrice: String(price),
      anchorAtMs: fact.receivedAtMs,
      status: 'CONSUMED',
      version: 1
    };
    // Unique by signal; duplicate hook/restart cannot shift the already frozen coordinate.
    await r.saveOpportunity(runId, state, 0);
    const occupied = this.running;
    if (!occupied) this.running = true;
    const quotes: QuoteObservation[] = [];
    try {
      const sample = await this.baselines.sample(
        {
          runId,
          opportunityId: state.opportunityId!,
          token: saved.token_address,
          poolRevision: fact.poolRevision,
          confirmation: { kind: 'ACTUAL', atMs: confirmedAtMs },
          preparationComplete: true
        },
        {
          market: (deadline) =>
            occupied
              ? Promise.reject(new Error('RESOURCE_EXCLUDED'))
              : this.fact(
                  'baseline',
                  () => this.api.token('/v1/token/info', saved.token_address),
                  deadline
                ),
          quote: async (deadline) => {
            if (occupied) throw new Error('RESOURCE_EXCLUDED');
            const q = await this.quote(
              decisionContext(state, riskPolicyHash(this.config)),
              undefined,
              deadline,
              true,
              'baseline'
            );
            quotes.push(q);
            return q;
          }
        }
      );
      await r.storage.write(() =>
        r.storage.db
          .prepare('INSERT OR IGNORE INTO research_registrations VALUES (?,?,?,?,?,?)')
          .run(
            hashValue([runId, state.opportunityId, 'baseline_quotes']),
            'baseline_quotes',
            runId,
            this.clock.now(),
            hashValue(quotes),
            JSON.stringify(quotes)
          )
      );
      await this.outcomes.scheduleNext(sample.marketId);
      await this.exits.schedule(sample.quoteId, 'audit60s', confirmedAtMs + 60000);
    } finally {
      if (!occupied) this.running = false;
    }
  }
  private async fact(
    purpose: RequestPurpose,
    request: () => Promise<unknown>,
    deadline = this.clock.now() + 5000
  ) {
    const raw = await withGmgnContext(
      { research: true, purpose, priority: 'evaluation', deadlineMs: deadline },
      request
    );
    const fact = responseFact(raw);
    if (!fact) throw new Error('PHYSICAL_FACT_MISSING');
    if (fact.endpoint === 'info' && fact.token)
      this.marketRevisions.set(fact.token, fact.semanticHash);
    await this.recorder.research.recordFact(
      fact,
      this.recorder.config.run_id,
      this.recorder.config.max_storage_bytes
    );
    if (
      !(await this.recorder.research.storage.write(() =>
        this.recorder.research.storage.db
          .prepare('SELECT 1 FROM research_facts WHERE fact_id=?')
          .get(fact.factId)
      ))
    )
      throw new Error('RESEARCH_STORAGE_EXCLUDED');
    return fact;
  }
  async tick() {
    if (
      this.running ||
      this.recorder.stoppedReason ||
      !['collect', 'execute_shadow'].includes(this.recorder.config.mode)
    )
      return;
    if (
      this.recorder.research.estimatedBytes() + 1048576 >=
      this.recorder.config.max_storage_bytes
    ) {
      this.recorder.stop('RESEARCH_STORAGE_BUDGET');
      return;
    }
    this.running = true;
    const decisionAtMs = this.clock.now();
    let currentToken: string | null = null;
    let currentOpportunity: string | null = null;
    try {
      if (await this.exits.tick()) return;
      if (await this.outcomes.tick()) return;
      const candidates = (await this.recorder.research.storage.write(() =>
        this.recorder.research.storage.db
          .prepare(
            "SELECT DISTINCT token,sample_key FROM research_sampling WHERE run_id=? AND status='SELECTED' ORDER BY sample_key,token LIMIT 20"
          )
          .all(this.recorder.config.run_id)
      )) as { token: string; sample_key: string }[];
      const token = candidates.find(
        (c) => this.clock.now() - (this.lastPoll.get(c.token) ?? -Infinity) >= 30000
      )?.token;
      if (!token) return;
      currentToken = token;
      this.lastPoll.set(token, this.clock.now());
      for (const [key, at] of this.lastPoll)
        if (this.clock.now() - at > 3600000) {
          this.lastPoll.delete(key);
          this.marketRevisions.delete(key);
        }
      const info = await this.fact('shared_collection', () =>
        this.api.token('/v1/token/info', token)
      );
      if (!this.model || info.poolRevision === 'unresolved') return;
      const r = this.recorder.research,
        runId = this.recorder.config.run_id;
      const previous =
        (await r.loadOpportunity(runId, this.model.hash, token, info.poolRevision)) ??
        watchingState(token, info.poolRevision, this.model.hash);
      const ids = (await r.storage.write(() =>
        r.storage.db
          .prepare(
            'SELECT fact_id FROM research_facts WHERE token=? AND received_at_ms BETWEEN ? AND ? ORDER BY received_at_ms,fact_id LIMIT 5001'
          )
          .all(token, this.clock.now() - 86400000, this.clock.now())
      )) as { fact_id: string }[];
      if (ids.length > 5000) throw new Error('RESEARCH_FACT_WINDOW_RESOURCE_EXCLUDED');
      const archive = new ResearchArchive(r, join(dirname(r.storage.db.name), 'research-archives'));
      const facts: MarketFact[] = [];
      for (const id of ids) facts.push(await archive.resolve(id.fact_id));
      const decision = evaluateOpportunity(
        previous,
        {
          model: this.model.manifest,
          token,
          poolRevision: info.poolRevision,
          facts,
          evaluationAtMs: this.clock.now()
        },
        this.model.hash
      );
      if (
        decision.state.version === previous.version ||
        !(await r.saveOpportunity(runId, decision.state, previous.version))
      )
        return;
      if (decision.state.status !== 'READY') return;
      const opportunityId = decision.state.opportunityId!;
      currentOpportunity = opportunityId;
      const existingPreparation = await r.storage.write(() =>
        r.storage.db
          .prepare('SELECT 1 FROM research_registrations WHERE registration_id=?')
          .get(hashValue([runId, opportunityId, 'preparation']))
      );
      if (existingPreparation) return; // A crash after preparation must not shift its confirmation coordinate.
      await r.storage.write(() =>
        r.storage.db
          .prepare(`INSERT OR IGNORE INTO funnel_decisions VALUES (?,?,?,?,?,?)`)
          .run(
            hashValue([runId, opportunityId, info.factId]),
            runId,
            opportunityId,
            hashValue(facts.map((f) => f.factId)),
            this.clock.now(),
            JSON.stringify(decision)
          )
      );
      let savedQuotes: QuoteObservation[] = [];
      let previousRisk: RiskBundle | undefined;
      const quote = async (
        context: Readonly<DecisionContext>,
        buy?: QuoteObservation,
        deadline?: number
      ) => {
        const result = await this.quote(
          context,
          buy,
          deadline,
          deadline !== undefined,
          deadline !== undefined ? 'baseline' : 'shadow_execution'
        );
        savedQuotes.push(result);
        return result;
      };
      const result = await prepareDryOpportunity({
        manifest: this.model.manifest,
        state: decision.state,
        config: this.config,
        now: () => this.clock.now(),
        adapter: {
          capture: async (ctx) => {
            previousRisk = await this.capture(ctx, facts, previousRisk);
            return previousRisk;
          },
          buy: (ctx) => quote(ctx),
          sell: (ctx, buy) => quote(ctx, buy)
        }
      });
      const preparedAtMs = this.clock.now();
      if (result.qualification)
        await r.storage.write(() =>
          r.storage.db.prepare('INSERT OR IGNORE INTO funnel_decisions VALUES (?,?,?,?,?,?)').run(
            hashValue([runId, opportunityId, 'qualified']),
            runId,
            opportunityId,
            hashValue(result.qualification!.factIds),
            result.qualification!.atMs,
            JSON.stringify({
              status: 'MARKET_QUALIFIED',
              qualification: result.qualification,
              modelHash: this.model!.hash,
              riskHash: riskPolicyHash(this.config)
            })
          )
        );
      await r.storage.write(() =>
        r.storage.db
          .prepare('INSERT OR IGNORE INTO research_registrations VALUES (?,?,?,?,?,?)')
          .run(
            hashValue([runId, opportunityId, 'preparation']),
            'dry_preparation',
            runId,
            this.clock.now(),
            hashValue({ result, quotes: savedQuotes, preparedAtMs }),
            JSON.stringify({ result, quotes: savedQuotes, preparedAtMs })
          )
      );
      if (result.status === 'CANCELLED') {
        await r.saveOpportunity(runId, result.state, decision.state.version);
      } else {
        await r.saveOpportunity(
          runId,
          { ...result.state, status: 'CONSUMED', version: decision.state.version + 1 },
          decision.state.version
        );
      }
      savedQuotes = [];
      const sample = await this.baselines.sample(
        {
          ...(result.outbox
            ? {
                card: (
                  JSON.parse(result.outbox) as {
                    entry: { price: string; availableAtMs: number; factId: string };
                  }
                ).entry
              }
            : {}),
          runId,
          opportunityId,
          token,
          poolRevision: info.poolRevision,
          preparationComplete: result.status === 'DRY_READY',
          confirmation: { kind: 'SIMULATED', preparedAtMs }
        },
        {
          market: (deadline) =>
            this.fact('baseline', () => this.api.token('/v1/token/info', token), deadline),
          quote: (deadline) => quote(result.context, undefined, deadline)
        }
      );
      await r.storage.write(() =>
        r.storage.db
          .prepare('INSERT OR IGNORE INTO research_registrations VALUES (?,?,?,?,?,?)')
          .run(
            hashValue([runId, opportunityId, 'baseline_quotes']),
            'baseline_quotes',
            runId,
            this.clock.now(),
            hashValue(savedQuotes),
            JSON.stringify(savedQuotes)
          )
      );
      await this.outcomes.scheduleNext(sample.marketId);
      const quoteBaseline = (await r.storage.write(() =>
        r.storage.db
          .prepare(
            "SELECT available_at_ms FROM evaluation_baselines WHERE baseline_id=? AND status='VALID'"
          )
          .get(sample.quoteId)
      )) as { available_at_ms: number } | undefined;
      if (quoteBaseline)
        await this.exits.schedule(
          sample.quoteId,
          'audit60s',
          quoteBaseline.available_at_ms + 60000
        );
    } catch {
      // Exclusions remain tied to the original sampling time; never become formal market rejections.
      const exclusion = {
        reason: 'RESOURCE_OR_DATA_UNAVAILABLE',
        token: currentToken,
        opportunityId: currentOpportunity,
        decisionAtMs
      };
      await this.recorder.research.storage.write(() =>
        this.recorder.research.storage.db
          .prepare('INSERT OR IGNORE INTO research_registrations VALUES (?,?,?,?,?,?)')
          .run(
            hashValue([this.recorder.config.run_id, decisionAtMs, 'resource']),
            'resource_exclusion',
            this.recorder.config.run_id,
            decisionAtMs,
            hashValue(exclusion),
            JSON.stringify(exclusion)
          )
      );
    } finally {
      this.running = false;
    }
  }
  private async capture(
    context: Readonly<DecisionContext>,
    priorFacts: MarketFact[],
    previous?: RiskBundle
  ): Promise<RiskBundle> {
    const token = context.token;
    const info = await this.fact('shadow_execution', () => this.api.token('/v1/token/info', token));
    const security = await this.fact('shadow_execution', () =>
      this.api.token('/v1/token/security', token)
    );
    const pool = await this.fact('shadow_execution', () =>
      this.api.token('/v1/token/pool_info', token)
    );
    if (previous)
      return {
        ...previous,
        info,
        security,
        pool,
        poolRevision: info.poolRevision,
        facts: [...priorFacts, info]
      };
    const holders = await this.fact('shadow_execution', () => this.api.holders(token));
    const traders = await this.fact('shadow_execution', () => this.api.traders(token));
    const creator =
      (info.payload.dev as { creator_address?: string } | undefined)?.creator_address ??
      (info.payload.pool as { creator?: string } | undefined)?.creator;
    if (!creator) throw new Error('CREATOR_MISSING');
    const created = await this.fact('shadow_execution', () => this.api.createdTokens(creator));
    const prior = priorFacts
      .filter(
        (f) =>
          f.endpoint === 'traders' &&
          f.poolRevision === context.poolRevision &&
          f.receivedAtMs < traders.requestedAtMs
      )
      .at(-1);
    const traderBaseline: TraderSnapshot | undefined = prior
      ? {
          atMs: prior.receivedAtMs,
          wallets: assessCoordinatedExit(
            Array.isArray(prior.payload.list)
              ? (prior.payload.list as Record<string, unknown>[])
              : [],
            undefined,
            prior.receivedAtMs,
            this.config.security.lazy_deep.coordinated_exit
          ).snapshot.wallets
        }
      : undefined;
    return {
      token,
      poolRevision: info.poolRevision,
      info,
      security,
      pool,
      holders,
      traders,
      created,
      facts: [...priorFacts, info],
      ...(traderBaseline ? { traderBaseline } : {})
    };
  }
  private async quote(
    context: Readonly<DecisionContext>,
    buy?: QuoteObservation,
    deadline = this.clock.now() + 5000,
    fresh = false,
    purpose: RequestPurpose = 'shadow_execution'
  ): Promise<QuoteObservation> {
    let inputAmount = buy?.outputAmount;
    if (!inputAmount) {
      const gas = await this.fact(purpose, () => this.api.gas(), deadline);
      inputAmount = usdToWbnbAtoms(10, new Decimal(String(gas.payload.native_token_usd_price)));
    }
    const query = {
      fromAddress: this.config.gmgn.quote_wallet,
      inputToken: buy ? context.token : WBNB_ADDRESS,
      outputToken: buy ? WBNB_ADDRESS : context.token,
      inputAmount,
      slippagePercent: this.config.quote.max_slippage_percent * 100
    };
    const identity = {
      ...(!buy ? { requestedNotionalUsd: '10' as const } : {}),
      chain: 'bsc' as const,
      token: context.token,
      poolRevision: context.poolRevision,
      wallet: query.fromAddress,
      inputAsset: query.inputToken,
      outputAsset: query.outputToken,
      direction: buy ? ('sell' as const) : ('buy' as const),
      inputAmount,
      slippage: String(query.slippagePercent),
      semantics: 'gmgn-bsc-quote-2026-09-03-v1'
    };
    const revision = this.marketRevisions.get(context.token) ?? context.activationFactId;
    const cached = fresh
      ? null
      : this.quoteCache.find({
          quote: identity,
          decisionAtMs: this.clock.now(),
          requestedMaxAgeMs: this.config.quote.max_age_seconds * 1000,
          marketRevision: revision,
          minimumRequestedAtMs: buy?.receivedAtMs ?? 0
        });
    if (cached) return cached;
    const raw = await withGmgnContext(
      { research: true, purpose, priority: 'evaluation', deadlineMs: deadline },
      () => this.api.quote(query)
    );
    const fact = responseFact(raw),
      parsed = parseGmgnQuote(raw);
    if (!fact || !parsed.routeAvailable) throw new Error('QUOTE_PHYSICAL_FACT_MISSING');
    await this.recorder.research.recordFact(
      fact,
      this.recorder.config.run_id,
      this.recorder.config.max_storage_bytes
    );
    const observation: QuoteObservation = {
      ...(!buy ? { requestedNotionalUsd: '10' as const } : {}),
      factId: fact.factId,
      chain: 'bsc',
      token: context.token,
      poolRevision: context.poolRevision,
      wallet: query.fromAddress,
      inputAsset: query.inputToken,
      outputAsset: query.outputToken,
      direction: buy ? 'sell' : 'buy',
      inputAmount,
      outputAmount: parsed.outputTokenAmount,
      inputUsd: parsed.inputUsd,
      outputUsd: parsed.outputUsd,
      slippage: parsed.configuredSlippagePercent,
      semantics: parsed.costSemanticsVersion,
      requestedAtMs: fact.requestedAtMs,
      receivedAtMs: fact.receivedAtMs
    };
    this.quoteCache.record(observation, revision);
    return observation;
  }
}

import { Decimal } from 'decimal.js';
import type { RuntimeConfig } from '../config/types.js';
import type { CandidateGmgnApi } from '../gmgn/api.js';
import { responseFact } from '../gmgn/client.js';
import type { MarketFact } from '../gmgn/facts.js';
import { parseGmgnQuote } from '../gmgn/quote.js';
import { WBNB_ADDRESS, usdToWbnbAtoms } from '../quote/gmgn-provider.js';
import type { QuoteObservation } from '../research/measurement.js';
import type { DecisionContext } from './dry-publisher.js';
import type { PreparationAdapter, RiskBundle } from './preparation.js';
import { creatorAddress, screenBasic } from './risk-screen.js';
import { PreparationFailure } from './dry-publisher.js';
import { assessCoordinatedExit } from '../safety/coordinated-exit.js';

/** The live adapter uses the common client/scheduler; no second key or transport. */
export class LiveOpportunityAdapter implements PreparationAdapter {
  readonly facts: MarketFact[] = [];
  readonly quotes: QuoteObservation[] = [];
  private previous: RiskBundle | undefined;
  constructor(
    private readonly api: CandidateGmgnApi,
    private readonly config: RuntimeConfig,
    private readonly priorFacts: MarketFact[],
    private readonly traderBaseline: MarketFact,
    private readonly now: () => number = Date.now
  ) {}
  async fact(request: () => Promise<unknown>): Promise<MarketFact> {
    const fact = responseFact(await request());
    if (!fact)
      throw new PreparationFailure('PHYSICAL_FACT_MISSING', null, {
        stage: 'CAPTURE',
        kind: 'data'
      });
    this.facts.push(fact);
    return fact;
  }
  async capture(ctx: Readonly<DecisionContext>): Promise<RiskBundle> {
    const token = ctx.token;
    // Info establishes the actual pool before token risk facts are requested.
    const info = await this.fact(() => this.api.token('/v1/token/info', token));
    const security = await this.fact(() => this.api.token('/v1/token/security', token));
    const pool = await this.fact(() => this.api.token('/v1/token/pool_info', token));
    const basic = screenBasic(info, security, pool, this.config, this.now());
    if (basic)
      throw new PreparationFailure(basic.reason, null, { stage: 'BASIC_SAFETY', ...basic });
    if (this.previous)
      return {
        ...this.previous,
        info,
        security,
        pool,
        poolRevision: info.poolRevision,
        facts: [...this.priorFacts, ...this.facts.filter((f) => f.endpoint === 'info')]
      };
    const holders = await this.fact(() => this.api.holders(token));
    const traders = await this.fact(() => this.api.traders(token));
    const creator = creatorAddress(info);
    if (!creator)
      throw new PreparationFailure('CREATOR_MISSING', null, {
        stage: 'BASIC_SAFETY',
        kind: 'data',
        factIds: [info.factId]
      });
    const created = await this.fact(() => this.api.createdTokens(creator));
    const prior = this.traderBaseline;
    if (
      prior.token !== token ||
      prior.poolRevision !== ctx.poolRevision ||
      prior.receivedAtMs >= traders.requestedAtMs
    )
      throw new PreparationFailure('TRADER_BASELINE_IDENTITY', null, {
        stage: 'TRADER_BASELINE',
        kind: 'data',
        factIds: [prior.factId, traders.factId]
      });
    const traderBaseline = {
      atMs: prior.receivedAtMs,
      wallets: assessCoordinatedExit(
        Array.isArray(prior.payload.list) ? (prior.payload.list as Record<string, unknown>[]) : [],
        undefined,
        prior.receivedAtMs,
        this.config.security.lazy_deep.coordinated_exit
      ).snapshot.wallets
    };
    this.previous = {
      token,
      poolRevision: info.poolRevision,
      info,
      security,
      pool,
      holders,
      traders,
      created,
      traderBaseline,
      facts: [...this.priorFacts, ...this.facts.filter((f) => f.endpoint === 'info')]
    };
    return this.previous;
  }
  buy(ctx: Readonly<DecisionContext>) {
    return this.quote(ctx);
  }
  sell(ctx: Readonly<DecisionContext>, buy: QuoteObservation) {
    return this.quote(ctx, buy);
  }
  private async quote(
    ctx: Readonly<DecisionContext>,
    buy?: QuoteObservation
  ): Promise<QuoteObservation> {
    const gas = buy ? undefined : await this.fact(() => this.api.gas());
    const inputAmount =
      buy?.outputAmount ??
      usdToWbnbAtoms(10, new Decimal(String(gas!.payload.native_token_usd_price)));
    const query = {
      fromAddress: this.config.gmgn.quote_wallet,
      inputToken: buy ? ctx.token : WBNB_ADDRESS,
      outputToken: buy ? WBNB_ADDRESS : ctx.token,
      inputAmount,
      slippagePercent: this.config.quote.max_slippage_percent * 100
    };
    const raw = await this.api.quote(query),
      fact = responseFact(raw),
      parsed = parseGmgnQuote(raw);
    if (!fact || !parsed.routeAvailable)
      throw new PreparationFailure('QUOTE_UNAVAILABLE', null, { stage: 'QUOTE', kind: 'data' });
    this.facts.push(fact);
    const result: QuoteObservation = {
      ...(!buy ? { requestedNotionalUsd: '10' as const } : {}),
      factId: fact.factId,
      chain: 'bsc',
      token: ctx.token,
      poolRevision: ctx.poolRevision,
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
    this.quotes.push(result);
    return result;
  }
}

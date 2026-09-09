import type { RuntimeConfig } from '../config/types.js';
import type { CandidateGmgnApi } from '../gmgn/api.js';
import type { MarketFact } from '../gmgn/facts.js';
import { decimalValue } from '../gmgn/facts.js';
import { GmgnError } from '../gmgn/errors.js';
import { LazySafetyRuntime } from '../safety/lazy-runtime.js';
import type { TraderSnapshot } from '../safety/coordinated-exit.js';
import { evaluateTier } from '../quote/gate.js';
import { hashValue } from '../research/protocol.js';
import { pairedQuoteReturn, type QuoteObservation } from '../research/measurement.js';
import {
  dryPublish,
  PreparationFailure,
  type DecisionContext,
  type DryPreparation
} from './dry-publisher.js';
import { evaluateOpportunity } from './opportunity.js';
import { creatorAddress, factProblem, screenBasic, type RiskFinding } from './risk-screen.js';

export interface RiskBundle {
  token: string;
  poolRevision: string;
  facts: MarketFact[];
  info: MarketFact;
  security: MarketFact;
  pool: MarketFact;
  holders: MarketFact;
  traders: MarketFact;
  created: MarketFact;
  traderBaseline?: TraderSnapshot;
}
export function riskPolicyHash(config: RuntimeConfig): string {
  return hashValue({
    security: config.security,
    quote: config.quote,
    riskDataTtl: config.scoring?.data_ttl_seconds,
    semantics: 'legacy-risk-preparation-v1'
  });
}
export async function assessRiskBundle(
  bundle: RiskBundle,
  context: Readonly<DecisionContext>,
  config: RuntimeConfig,
  nowMs: number
): Promise<string | null> {
  return (await riskBundleFinding(bundle, context, config, nowMs))?.reason ?? null;
}
async function riskBundleFinding(
  bundle: RiskBundle,
  context: Readonly<DecisionContext>,
  config: RuntimeConfig,
  nowMs: number
): Promise<RiskFinding | null> {
  const base = {
    factIds: [
      bundle.info,
      bundle.security,
      bundle.pool,
      bundle.holders,
      bundle.traders,
      bundle.created
    ].map((f) => f.factId),
    expiresAtMs: nowMs
  };
  if (bundle.token !== context.token || bundle.poolRevision !== context.poolRevision)
    return { ...base, kind: 'data', reason: 'RISK_POOL_OR_TOKEN_CHANGED' };
  const items = [
    [bundle.info, 'info', config.quote.security_pool_max_age_seconds * 1000],
    [bundle.security, 'security', config.quote.security_pool_max_age_seconds * 1000],
    [bundle.pool, 'pool', config.quote.security_pool_max_age_seconds * 1000],
    [bundle.holders, 'holders', (config.scoring?.data_ttl_seconds.holders ?? 300) * 1000],
    [
      bundle.traders,
      'traders',
      config.security.lazy_deep.coordinated_exit.max_activity_age_seconds * 1000
    ],
    [bundle.created, 'created_tokens', (config.scoring?.data_ttl_seconds.creator ?? 3600) * 1000]
  ] as const;
  for (const [fact, endpoint, ttl] of items) {
    const bad = factProblem(fact, endpoint, context.token, context.poolRevision, ttl, nowMs);
    if (bad) return bad;
  }
  const creator = creatorAddress(bundle.info);
  if (
    !creator ||
    typeof bundle.created.request.wallet_address !== 'string' ||
    bundle.created.request.wallet_address.toLowerCase() !== creator.toLowerCase()
  )
    return {
      ...base,
      kind: 'data',
      endpoint: 'created_tokens',
      reason: 'CREATOR_FACT_IDENTITY_MISMATCH'
    };
  const basic = screenBasic(bundle.info, bundle.security, bundle.pool, config, nowMs);
  if (basic) return basic;
  // Reuse the exact legacy holder/creator/coordinated-exit semantics without its market routes.
  const unavailable = () => Promise.reject(new Error('UNEXPECTED_RISK_API'));
  const api: CandidateGmgnApi = {
    token: unavailable,
    kline: unavailable,
    gas: unavailable,
    quote: unavailable,
    holders: () => Promise.resolve(bundle.holders.payload),
    traders: () => Promise.resolve(bundle.traders.payload),
    createdTokens: () => Promise.resolve(bundle.created.payload)
  };
  const lazy = new LazySafetyRuntime(config, api, () => bundle.traders.receivedAtMs);
  if (bundle.traderBaseline)
    lazy.traderSnapshots.set(context.token.toLowerCase(), bundle.traderBaseline);
  const result = await lazy.evaluate(context.token, bundle.info.payload);
  return result.allowed
    ? null
    : { ...base, kind: 'risk', reason: result.reason ?? 'LAZY_RISK_UNVERIFIED' };
}
export interface PreparationAdapter {
  capture(context: Readonly<DecisionContext>): Promise<RiskBundle>;
  buy(context: Readonly<DecisionContext>): Promise<QuoteObservation>;
  sell(context: Readonly<DecisionContext>, buy: QuoteObservation): Promise<QuoteObservation>;
}
/** Full dry path: safety -> 10U buy -> same-quantity sell -> final safety -> original market model. */
export async function prepareDryOpportunity(
  input: Omit<Parameters<typeof dryPublish>[0], 'riskHash' | 'prepare'> & {
    config: RuntimeConfig;
    adapter: PreparationAdapter;
  }
) {
  const riskHash = riskPolicyHash(input.config);
  return dryPublish({
    manifest: input.manifest,
    state: input.state,
    now: input.now,
    riskHash,
    prepare: async (context): Promise<DryPreparation> => {
      let qualification: DryPreparation['qualification'] | null = null;
      let stage = 'INITIAL_SAFETY';
      try {
        const check = async (bundle: RiskBundle) => {
          const error = await riskBundleFinding(bundle, context, input.config, input.now());
          if (error)
            throw new PreparationFailure(error.reason, qualification, {
              stage,
              ...error
            });
        };
        const initial = await input.adapter.capture(context);
        await check(initial);
        const marketAtMs = input.now();
        const market = evaluateOpportunity(
          input.state,
          {
            model: input.manifest,
            token: context.token,
            poolRevision: initial.poolRevision,
            evaluationAtMs: marketAtMs,
            facts: [...initial.facts.filter((f) => f.factId !== initial.info.factId), initial.info]
          },
          context.modelHash
        );
        if (
          market.reason === 'DATA_WAIT' ||
          market.state.status !== 'READY' ||
          market.stageResults.entry !== 'PASS' ||
          market.stageResults.confirmation !== 'PASS' ||
          market.stageResults.invalidation !== 'FAIL'
        )
          throw new PreparationFailure('MARKET_CHANGED_BEFORE_PREPARATION', null, {
            stage: 'INITIAL_MARKET',
            kind: 'market',
            decision: market,
            inputFactIds: [
              ...initial.facts.filter((f) => f.factId !== initial.info.factId),
              initial.info
            ].map((f) => f.factId),
            evaluationAtMs: marketAtMs
          });
        qualification = {
          atMs: input.now(),
          factIds: [
            initial.info,
            initial.security,
            initial.pool,
            initial.holders,
            initial.traders,
            initial.created
          ].map((f) => f.factId)
        };
        stage = 'EXECUTION';
        const buy = await input.adapter.buy(context);
        const sell = await input.adapter.sell(context, structuredClone(buy));
        stage = 'FINAL_RECHECK';
        const final = await input.adapter.capture(context);
        await check(final);
        const now = input.now();
        if (
          !decimalValue(buy.inputUsd)?.gt(0) ||
          (buy.requestedNotionalUsd !== '10' && !decimalValue(buy.inputUsd)?.eq(10)) ||
          !decimalValue(buy.outputAmount)?.gt(0) ||
          [buy, sell].some(
            (q) =>
              q.token !== context.token ||
              q.poolRevision !== context.poolRevision ||
              q.semantics !== 'gmgn-bsc-quote-2026-09-03-v1' ||
              q.wallet.toLowerCase() !== input.config.gmgn.quote_wallet.toLowerCase() ||
              q.receivedAtMs > now ||
              now - q.requestedAtMs > input.config.quote.max_age_seconds * 1000
          ) ||
          pairedQuoteReturn(buy, sell) === null
        )
          throw new PreparationFailure('PREPARATION_QUOTE_PAIR_INVALID', qualification, {
            stage: 'QUOTE_PAIR',
            kind: 'data',
            factIds: [buy.factId, sell.factId]
          });
        const leg = (q: QuoteObservation) => ({
          direction: q.direction,
          inputUsd: q.inputUsd,
          outputUsd: q.outputUsd,
          configuredSlippagePercent: q.slippage,
          routeAvailable: true,
          costSemanticsVersion: 'gmgn-bsc-quote-2026-09-03-v1' as const
        });
        const decision = evaluateTier(leg(buy), leg(sell), {
          sizeUsd: 10,
          maxOneWayLoss: input.config.quote.max_one_way_loss['10'],
          maxRoundTripLoss: input.config.quote.max_round_trip_loss['10'],
          maxSlippage: input.config.quote.max_slippage_percent
        });
        if (!decision.passes)
          throw new PreparationFailure('PREPARATION_COST_FAILED', qualification, {
            stage: 'COST',
            kind: 'cost',
            cost: decision,
            factIds: [buy.factId, sell.factId],
            limits: {
              oneWay: input.config.quote.max_one_way_loss['10'],
              roundTrip: input.config.quote.max_round_trip_loss['10'],
              slippage: input.config.quote.max_slippage_percent
            }
          });
        return {
          qualification,
          requestedNotionalUsd: '10',
          status: 'PASS',
          riskHash,
          checkedAtMs: now,
          latestFacts: [...final.facts.filter((f) => f.factId !== final.info.factId), final.info],
          reason: 'FROZEN_RISK_AND_ENTRY_RECHECK',
          buyUsd: buy.inputUsd,
          sellUsd: sell.outputUsd,
          tokenQuantity: buy.outputAmount,
          quoteReceivedAtMs: sell.receivedAtMs
        };
      } catch (error) {
        if (error instanceof PreparationFailure)
          throw new PreparationFailure(error.message, error.qualification ?? qualification, {
            stage,
            ...error.details
          });
        throw new PreparationFailure(
          error instanceof GmgnError ? `API_${error.kind}` : `PREPARATION_${stage}_FAILED`,
          qualification,
          {
            stage,
            kind: 'error',
            cause: error instanceof GmgnError ? error.kind : 'UNCLASSIFIED_ERROR'
          }
        );
      }
    }
  });
}

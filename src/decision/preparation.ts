import type { RuntimeConfig } from '../config/types.js';
import type { CandidateGmgnApi } from '../gmgn/api.js';
import type { MarketFact } from '../gmgn/facts.js';
import { decimalValue } from '../gmgn/facts.js';
import { adaptGmgnSafety } from '../safety/gmgn-adapter.js';
import { evaluateDeepSafety } from '../safety/deep-gate.js';
import { evaluatePermissionAndLpSafety } from '../safety/permission-gate.js';
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
  if (bundle.token !== context.token || bundle.poolRevision !== context.poolRevision)
    return 'RISK_POOL_OR_TOKEN_CHANGED';
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
    if (
      fact.endpoint !== endpoint ||
      !Number.isSafeInteger(fact.requestedAtMs) ||
      fact.requestedAtMs > fact.receivedAtMs ||
      fact.receivedAtMs > nowMs ||
      nowMs - fact.requestedAtMs > ttl ||
      (endpoint !== 'created_tokens' &&
        (fact.token !== context.token || fact.poolRevision !== context.poolRevision)) ||
      fact.qualityFlags.some(
        (f) => !['PRICE_SOURCE_TIME_UNVERIFIED', 'TOP_WALLET_COVERAGE_ONLY'].includes(f)
      )
    )
      return 'RISK_FACT_UNVERIFIED_OR_STALE';
  }
  const creator =
    (bundle.info.payload.dev as { creator_address?: string } | undefined)?.creator_address ??
    (bundle.info.payload.pool as { creator?: string } | undefined)?.creator;
  if (!creator || bundle.created.request.wallet_address !== creator)
    return 'CREATOR_FACT_IDENTITY_MISMATCH';
  const adapted = adaptGmgnSafety({
    info: bundle.info.payload,
    security: bundle.security.payload,
    pool: bundle.pool.payload
  });
  const s = config.security;
  const deep = evaluateDeepSafety(
    adapted.deep,
    {
      maxBuyTax: s.max_buy_tax,
      maxSellTax: s.max_sell_tax,
      maxTop10Percent: s.max_top10_percent,
      maxTeamPercent: s.max_team_percent,
      maxEntrapmentPercent: s.max_entrapment_percent,
      maxBundlerPercent: s.max_bundler_percent,
      maxSniperPercent: s.max_sniper_percent,
      fatalFlags: s.fatal_flags
    },
    new Set(s.fatal_flags)
  );
  if (!deep.allowed) return deep.reason ?? 'DEEP_RISK_FAILED';
  const permission = evaluatePermissionAndLpSafety(
    adapted.permission,
    s.min_lp_locked_or_burned_percent
  );
  if (!permission.allowed) return permission.reason ?? 'PERMISSION_FAILED';
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
  return result.allowed ? null : (result.reason ?? 'LAZY_RISK_UNVERIFIED');
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
          const error = await assessRiskBundle(bundle, context, input.config, input.now());
          if (error) throw new PreparationFailure(error, qualification);
        };
        const initial = await input.adapter.capture(context);
        await check(initial);
        const market = evaluateOpportunity(
          input.state,
          {
            model: input.manifest,
            token: context.token,
            poolRevision: initial.poolRevision,
            evaluationAtMs: input.now(),
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
          throw new PreparationFailure('MARKET_CHANGED_BEFORE_PREPARATION');
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
          throw new Error('PREPARATION_QUOTE_PAIR_INVALID');
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
        if (!decision.passes) throw new Error(decision.reason ?? 'PREPARATION_COST_FAILED');
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
        if (error instanceof PreparationFailure) throw error;
        throw new PreparationFailure(`PREPARATION_${stage}_FAILED`, qualification);
      }
    }
  });
}

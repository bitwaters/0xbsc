import { Decimal } from 'decimal.js';
import type { ParsedGmgnQuote } from '../gmgn/quote.js';

export type QuoteDirection = 'buy' | 'sell';
export interface QuoteLeg {
  requestedAtMs?: number;
  completedAtMs?: number;
  direction: QuoteDirection;
  inputUsd: string;
  outputUsd: string;
  /** GMGN's requested-tolerance percentage, not observed price impact. */
  configuredSlippagePercent: string;
  routeAvailable: boolean;
  costSemanticsVersion: ParsedGmgnQuote['costSemanticsVersion'];
}
export interface BuyQuote extends QuoteLeg {
  outputTokenAmount: string;
}
export interface QuoteProvider {
  buy(sizeUsd: number): Promise<BuyQuote>;
  sell(tokenAmount: string): Promise<QuoteLeg>;
}
export interface BidirectionalQuote {
  sizeUsd: number;
  buy: BuyQuote;
  sell: QuoteLeg;
}
export interface TierPolicy {
  sizeUsd: number;
  maxOneWayLoss: number;
  maxRoundTripLoss: number;
  maxSlippage: number;
}
export interface TierDecision {
  sizeUsd: number;
  passes: boolean;
  routeFailure: boolean;
  buyOneWayLoss: Decimal;
  sellOneWayLoss: Decimal;
  oneWayLoss: Decimal;
  roundTripLoss: Decimal;
  requestedSlippage: Decimal;
  reason: string | null;
}
export interface QuoteRetryPolicy {
  minimumIntervalMs: number;
  materialPriceChange: number;
  materialLiquidityChange: number;
}

export function evaluateTier(buy: QuoteLeg, sell: QuoteLeg, policy: TierPolicy): TierDecision {
  if (
    !buy.routeAvailable ||
    !sell.routeAvailable ||
    buy.direction !== 'buy' ||
    sell.direction !== 'sell'
  )
    return {
      sizeUsd: policy.sizeUsd,
      passes: false,
      routeFailure: true,
      buyOneWayLoss: new Decimal(1),
      sellOneWayLoss: new Decimal(1),
      oneWayLoss: new Decimal(1),
      roundTripLoss: new Decimal(1),
      requestedSlippage: new Decimal(1),
      reason:
        !buy.routeAvailable || !sell.routeAvailable ? 'unsellable_route' : 'invalid_route_direction'
    };
  const buyInput = new Decimal(buy.inputUsd),
    buyOutput = new Decimal(buy.outputUsd),
    sellInput = new Decimal(sell.inputUsd),
    sellOutput = new Decimal(sell.outputUsd);
  if (buyInput.lte(0) || buyOutput.lte(0) || sellInput.lte(0) || sellOutput.lte(0))
    throw new RangeError('Quote USD values must be positive');
  const buyOneWayLoss = Decimal.max(0, buyInput.minus(buyOutput).div(buyInput));
  const sellOneWayLoss = Decimal.max(0, sellInput.minus(sellOutput).div(sellInput));
  const roundTripLoss = Decimal.max(0, buyInput.minus(sellOutput).div(buyInput));
  const requestedSlippage = Decimal.max(
    requestedSlippageRate(buy.configuredSlippagePercent),
    requestedSlippageRate(sell.configuredSlippagePercent)
  );
  const passes =
    buyOneWayLoss.lte(policy.maxOneWayLoss) &&
    sellOneWayLoss.lte(policy.maxOneWayLoss) &&
    roundTripLoss.lte(policy.maxRoundTripLoss) &&
    requestedSlippage.lte(policy.maxSlippage);
  return {
    sizeUsd: policy.sizeUsd,
    passes,
    routeFailure: false,
    buyOneWayLoss,
    sellOneWayLoss,
    oneWayLoss: Decimal.max(buyOneWayLoss, sellOneWayLoss),
    roundTripLoss,
    requestedSlippage,
    reason: passes ? null : 'cost_or_requested_slippage_limit'
  };
}

export function quoteLegFromGmgn(quote: ParsedGmgnQuote, direction: QuoteDirection): QuoteLeg {
  return {
    direction,
    inputUsd: quote.inputUsd,
    outputUsd: quote.outputUsd,
    configuredSlippagePercent: quote.configuredSlippagePercent,
    routeAvailable: quote.routeAvailable,
    costSemanticsVersion: quote.costSemanticsVersion
  };
}

function requestedSlippageRate(percent: string): Decimal {
  const rate = new Decimal(percent).div(100);
  if (!rate.isFinite() || rate.lt(0))
    throw new RangeError('Quote requested slippage must be non-negative');
  return rate;
}

export async function quoteConfiguredPositions(
  provider: QuoteProvider,
  sizesUsd: readonly [number, number, number]
): Promise<BidirectionalQuote[]> {
  const buys = await Promise.all(sizesUsd.map((sizeUsd) => provider.buy(sizeUsd)));
  const amounts = buys.map((buy) => {
    const amount = new Decimal(buy.outputTokenAmount);
    if (!amount.isFinite() || amount.lte(0))
      throw new RangeError('buy Quote token amount must be positive');
    return amount.toFixed();
  });
  const sells = await Promise.all(amounts.map((amount) => provider.sell(amount)));
  return sizesUsd.map((sizeUsd, index) => ({
    sizeUsd,
    buy: buys[index]!,
    sell: sells[index]!
  }));
}

export function decidePositions(decisions: TierDecision[]): {
  accepted: boolean;
  maxSafePosition: number | null;
  temporaryCostFailure: boolean;
} {
  const minimum = decisions.find((decision) => decision.sizeUsd === 10);
  if (!minimum) throw new Error('10U decision is required');
  if (decisions.some((decision) => decision.routeFailure))
    return { accepted: false, maxSafePosition: null, temporaryCostFailure: false };
  if (minimum.routeFailure)
    return { accepted: false, maxSafePosition: null, temporaryCostFailure: false };
  if (!minimum.passes)
    return { accepted: false, maxSafePosition: null, temporaryCostFailure: true };
  return {
    accepted: true,
    maxSafePosition: Math.max(
      ...decisions.filter((decision) => decision.passes).map((decision) => decision.sizeUsd)
    ),
    temporaryCostFailure: false
  };
}

export function shouldRetryQuote(
  lastAttemptAtMs: number | null,
  nowMs: number,
  previous: { priceUsd: Decimal.Value; liquidityUsd: Decimal.Value } | null,
  current: { priceUsd: Decimal.Value; liquidityUsd: Decimal.Value },
  policy: QuoteRetryPolicy
): boolean {
  if (lastAttemptAtMs === null || previous === null) return true;
  if (nowMs - lastAttemptAtMs < policy.minimumIntervalMs) return false;
  const priceBefore = new Decimal(previous.priceUsd);
  const liquidityBefore = new Decimal(previous.liquidityUsd);
  const priceNow = new Decimal(current.priceUsd);
  const liquidityNow = new Decimal(current.liquidityUsd);
  if (priceBefore.lte(0) || liquidityBefore.lte(0) || priceNow.lte(0) || liquidityNow.lte(0))
    return false;
  const priceChange = priceNow.minus(priceBefore).abs().div(priceBefore);
  const liquidityChange = liquidityNow.minus(liquidityBefore).abs().div(liquidityBefore);
  return (
    priceChange.gte(policy.materialPriceChange) ||
    liquidityChange.gte(policy.materialLiquidityChange)
  );
}

export type FinalFreshnessDecision =
  'fresh' | 'refresh_security_pool' | 'refresh_quote' | 'stale_trigger';

export function quoteAllowsDelivery(input: {
  accepted: boolean;
  finalSafetyAllowed: boolean;
  finalFreshness: FinalFreshnessDecision | null;
  observationAdmissionRejected: boolean;
}): boolean {
  return (
    input.accepted &&
    input.finalSafetyAllowed &&
    input.finalFreshness === 'fresh' &&
    !input.observationAdmissionRejected
  );
}

export function finalFreshnessDecision(input: {
  nowMs: number;
  securityAtMs: number;
  poolAtMs: number;
  quoteAtMs: number;
  triggerAtMs: number;
  securityPoolMaxAgeMs: number;
  quoteMaxAgeMs: number;
  decisiveWindowMs: number;
}): FinalFreshnessDecision {
  if (input.nowMs - input.triggerAtMs > input.decisiveWindowMs) return 'stale_trigger';
  if (
    input.nowMs - input.securityAtMs > input.securityPoolMaxAgeMs ||
    input.nowMs - input.poolAtMs > input.securityPoolMaxAgeMs
  )
    return 'refresh_security_pool';
  if (input.nowMs - input.quoteAtMs > input.quoteMaxAgeMs) return 'refresh_quote';
  return 'fresh';
}

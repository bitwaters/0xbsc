import { withGmgnContext } from '../gmgn/context.js';
import type { RuntimeConfig } from '../config/types.js';
import type { CandidateGmgnApi } from '../gmgn/api.js';
import {
  decidePositions,
  evaluateTier,
  quoteConfiguredPositions,
  shouldRetryQuote,
  type TierDecision
} from './gate.js';
import { GmgnQuoteProvider } from './gmgn-provider.js';

export interface QuoteGateResult {
  accepted: boolean;
  temporaryCostFailure: boolean;
  maxSafePosition: number | null;
  decisions: TierDecision[];
  quotedAtMs: number;
}

/** Executes only read-only GMGN Quote/Gas requests; it has no signing or trade capability. */
export class QuoteGateRuntime {
  #temporaryFailures = new Map<
    string,
    {
      attemptedAtMs: number;
      market: { priceUsd: number; liquidityUsd: number };
      result: QuoteGateResult;
    }
  >();
  constructor(
    private readonly config: RuntimeConfig,
    private readonly api: CandidateGmgnApi,
    private readonly now: () => number = Date.now
  ) {}

  evaluate(
    tokenAddress: string,
    market?: { priceUsd: number; liquidityUsd: number },
    options: { force?: boolean } = {}
  ): Promise<QuoteGateResult> {
    return withGmgnContext({ deadlineMs: this.now() + 30_000 }, () =>
      this.evaluateWithinDeadline(tokenAddress, market, options)
    );
  }

  private async evaluateWithinDeadline(
    tokenAddress: string,
    market?: { priceUsd: number; liquidityUsd: number },
    options: { force?: boolean } = {}
  ): Promise<QuoteGateResult> {
    const previous = this.#temporaryFailures.get(tokenAddress.toLowerCase());
    const nowMs = this.now();
    if (
      previous &&
      market &&
      !options.force &&
      !shouldRetryQuote(previous.attemptedAtMs, nowMs, previous.market, market, {
        minimumIntervalMs: this.config.quote.retry_minimum_seconds * 1_000,
        materialPriceChange: this.config.quote.material_price_change_percent,
        materialLiquidityChange: this.config.quote.material_liquidity_change_percent
      })
    )
      return previous.result;
    const provider = await GmgnQuoteProvider.create({
      api: this.api,
      config: this.config,
      tokenAddress,
      now: this.now
    });
    const positions = await quoteConfiguredPositions(provider, this.config.quote.position_usd);
    const decisions = positions.map(({ sizeUsd, buy, sell }) =>
      evaluateTier(buy, sell, {
        sizeUsd,
        maxOneWayLoss: this.config.quote.max_one_way_loss[String(sizeUsd) as '10' | '50' | '100'],
        maxRoundTripLoss:
          this.config.quote.max_round_trip_loss[String(sizeUsd) as '10' | '50' | '100'],
        maxSlippage: this.config.quote.max_slippage_percent
      })
    );
    const completedAtMs = this.now();
    // The oldest physical leg determines freshness; completion cannot rejuvenate early legs.
    const legs = positions.flatMap((position) => [position.buy, position.sell]);
    const quotedAtMs = Math.min(...legs.map((leg) => leg.requestedAtMs ?? nowMs));
    const result = {
      ...decidePositions(decisions),
      decisions,
      quotedAtMs,
      completedAtMs,
      legTimings: legs.map((leg) => ({
        direction: leg.direction,
        requestedAtMs: leg.requestedAtMs,
        completedAtMs: leg.completedAtMs
      }))
    };
    if (result.temporaryCostFailure && market)
      this.#temporaryFailures.set(tokenAddress.toLowerCase(), {
        attemptedAtMs: completedAtMs,
        market,
        result
      });
    else this.#temporaryFailures.delete(tokenAddress.toLowerCase());
    return result;
  }
}

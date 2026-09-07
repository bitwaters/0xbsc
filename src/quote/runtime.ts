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
  #serial: Promise<unknown> = Promise.resolve();
  #fullApprovals = new Map<string, number>();
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
    options: { force?: boolean; full?: boolean } = {}
  ): Promise<QuoteGateResult> {
    const deadlineMs = this.now() + 30_000;
    const run = this.#serial.then(() =>
      withGmgnContext({ deadlineMs }, () =>
        this.evaluateWithinDeadline(tokenAddress, market, options)
      )
    );
    this.#serial = run.catch(() => undefined);
    return run;
  }

  private async evaluateWithinDeadline(
    tokenAddress: string,
    market?: { priceUsd: number; liquidityUsd: number },
    options: { force?: boolean; full?: boolean } = {}
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
    for (const [key, approvedAt] of this.#fullApprovals)
      if (nowMs - approvedAt > 30_000) this.#fullApprovals.delete(key);
    const minimumOnly =
      options.force === true &&
      !options.full &&
      this.#fullApprovals.has(tokenAddress.toLowerCase());
    const provider = await GmgnQuoteProvider.create({
      api: this.api,
      config: this.config,
      tokenAddress,
      now: this.now
    });
    const positions = await quoteConfiguredPositions(
      provider,
      minimumOnly ? [10] : this.config.quote.position_usd
    );
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
    // Only a fresh 10U round trip admits delivery. Older optional tiers are never advertised as current capacity.
    const legs = positions.flatMap((position) => [position.buy, position.sell]);
    const minimum = positions.find((position) => position.sizeUsd === 10)!;
    const quotedAtMs = Math.min(
      minimum.buy.requestedAtMs ?? nowMs,
      minimum.sell.requestedAtMs ?? nowMs
    );
    const ageLimit = (this.config.quote.max_age_seconds ?? 5) * 1000;
    const freshSizes = new Set(
      positions
        .filter(
          (position) =>
            completedAtMs -
              Math.min(position.buy.requestedAtMs ?? nowMs, position.sell.requestedAtMs ?? nowMs) <=
            ageLimit
        )
        .map((position) => position.sizeUsd)
    );
    const capacity = decisions
      .filter((d) => d.passes && freshSizes.has(d.sizeUsd))
      .map((d) => d.sizeUsd);
    const decision = decidePositions(decisions);
    const result = {
      ...decision,
      maxSafePosition: decision.accepted && capacity.length ? Math.max(...capacity) : null,
      refreshedMinimumOnly: minimumOnly,
      allTiersQuotedAtMs: Math.min(...legs.map((leg) => leg.requestedAtMs ?? nowMs)),
      decisions,
      quotedAtMs,
      completedAtMs,
      tierTimings: positions.map((position) => ({
        sizeUsd: position.sizeUsd,
        requestedAtMs: Math.min(
          position.buy.requestedAtMs ?? nowMs,
          position.sell.requestedAtMs ?? nowMs
        )
      })),
      legTimings: legs.map((leg) => ({
        direction: leg.direction,
        requestedAtMs: leg.requestedAtMs,
        completedAtMs: leg.completedAtMs
      }))
    };
    if (!result.accepted) this.#fullApprovals.delete(tokenAddress.toLowerCase());
    else if (!minimumOnly) this.#fullApprovals.set(tokenAddress.toLowerCase(), completedAtMs);
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

/** Capacity is re-aged at final preparation, not frozen when the Quote group completes. */
export function freshQuoteCapacity(
  snapshot: Record<string, unknown>,
  nowMs: number,
  maxAgeMs: number
): number | null {
  if (snapshot.accepted !== true) return null;
  const fresh = (at: unknown) =>
    typeof at === 'number' && Number.isFinite(at) && at <= nowMs && nowMs - at <= maxAgeMs;
  if (!fresh(snapshot.quotedAtMs)) return null;
  if (!Array.isArray(snapshot.tierTimings) || !Array.isArray(snapshot.decisions)) return 10;
  const timings = snapshot.tierTimings as Array<{ sizeUsd?: unknown; requestedAtMs?: unknown }>;
  const decisions = snapshot.decisions as Array<{ sizeUsd?: unknown; passes?: unknown }>;
  const sizes = decisions
    .filter(
      (d) =>
        d?.passes === true &&
        typeof d.sizeUsd === 'number' &&
        timings.some((t) => t?.sizeUsd === d.sizeUsd && fresh(t.requestedAtMs))
    )
    .map((d) => d.sizeUsd as number);
  return sizes.includes(10) ? Math.max(...sizes) : null;
}

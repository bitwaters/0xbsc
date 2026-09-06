export interface CompletedCandle {
  timeMs?: number;
  intervalMs?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
  swaps: number | null;
  completed: boolean;
}

export interface PriceFeatureThresholds {
  dormancyWindowCandles: number;
  dormancyMaxAverageVolumeUsd: number;
  dormancyMaxAverageSwaps: number;
  revivalBaselineCandles: number;
  revivalMinAbsoluteVolumeUsd: number;
  revivalMinAbsoluteSwaps: number;
  revivalVolumeMultiple: number;
  revivalSwapsMultiple: number;
  breakoutLookbackCandles: number;
  breakoutMinimumRate: number;
  trendLookbackCandles: number;
  trendMinimumGrowthRate: number;
  pullbackMaxRetraceRate: number;
  pullbackMaxVolumeRatio: number;
  restartMinimumVolumeRatio: number;
  verticalPumpWindowCandles: number;
  verticalPumpMaximumGrowthRate: number;
}

function completed(candles: readonly CompletedCandle[]): CompletedCandle[] {
  return candles.filter((candle) => candle.completed);
}
function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}
function validPriceVolume(candle: CompletedCandle): boolean {
  return (
    [candle.open, candle.high, candle.low, candle.close, candle.volumeUsd].every(Number.isFinite) &&
    candle.open > 0 &&
    candle.high > 0 &&
    candle.low > 0 &&
    candle.close > 0 &&
    candle.volumeUsd >= 0
  );
}
function validSwaps(candle: CompletedCandle): candle is CompletedCandle & { swaps: number } {
  return candle.swaps !== null && Number.isFinite(candle.swaps) && candle.swaps >= 0;
}

export function isDormant(
  candles: readonly CompletedCandle[],
  thresholds: PriceFeatureThresholds
): boolean {
  const sample = completed(candles).slice(-thresholds.dormancyWindowCandles);
  return (
    sample.length === thresholds.dormancyWindowCandles &&
    sample.every(validPriceVolume) &&
    average(sample.map((candle) => candle.volumeUsd)) <= thresholds.dormancyMaxAverageVolumeUsd &&
    (sample.every((candle) => candle.swaps === null) ||
      (sample.every(validSwaps) &&
        average(sample.map((candle) => candle.swaps)) <= thresholds.dormancyMaxAverageSwaps))
  );
}

export function isRevivalActivity(
  current: CompletedCandle,
  history: readonly CompletedCandle[],
  thresholds: PriceFeatureThresholds
): boolean {
  if (!validPriceVolume(current) || !validSwaps(current)) return false;
  const baseline = completed(history).slice(-thresholds.revivalBaselineCandles);
  const enoughBaseline =
    baseline.length === thresholds.revivalBaselineCandles && baseline.every(validPriceVolume);
  const volumeBaseline = average(baseline.map((candle) => candle.volumeUsd));
  const hasSwapBaseline = baseline.every(validSwaps);
  const swapsBaseline = hasSwapBaseline ? average(baseline.map((candle) => candle.swaps)) : 0;
  const volumeQualified =
    enoughBaseline && volumeBaseline > 0
      ? current.volumeUsd >= volumeBaseline * thresholds.revivalVolumeMultiple
      : current.volumeUsd >= thresholds.revivalMinAbsoluteVolumeUsd;
  const swapsQualified =
    enoughBaseline && hasSwapBaseline && swapsBaseline > 0
      ? current.swaps >= swapsBaseline * thresholds.revivalSwapsMultiple
      : current.swaps >= thresholds.revivalMinAbsoluteSwaps;
  return volumeQualified && swapsQualified;
}

export function isBreakout(
  current: CompletedCandle,
  history: readonly CompletedCandle[],
  thresholds: PriceFeatureThresholds
): boolean {
  const sample = completed(history).slice(-thresholds.breakoutLookbackCandles);
  if (
    !validPriceVolume(current) ||
    sample.length !== thresholds.breakoutLookbackCandles ||
    !sample.every(validPriceVolume)
  )
    return false;
  return (
    current.close >
    Math.max(...sample.map((candle) => candle.high)) * (1 + thresholds.breakoutMinimumRate)
  );
}

export function isUpwardTrend(
  candles: readonly CompletedCandle[],
  thresholds: PriceFeatureThresholds
): boolean {
  const sample = completed(candles).slice(-thresholds.trendLookbackCandles);
  const first = sample[0];
  const last = sample.at(-1);
  if (
    sample.length !== thresholds.trendLookbackCandles ||
    !sample.every(validPriceVolume) ||
    !first ||
    !last ||
    first.close <= 0
  )
    return false;
  return last.close >= first.close * (1 + thresholds.trendMinimumGrowthRate);
}

export function isHealthyPullback(
  peakPrice: number,
  pullbackLow: number,
  priorSupport: number,
  pullbackVolumeUsd: number,
  trendAverageVolumeUsd: number,
  thresholds: PriceFeatureThresholds
): boolean {
  if (
    ![peakPrice, pullbackLow, priorSupport, pullbackVolumeUsd, trendAverageVolumeUsd].every(
      Number.isFinite
    )
  )
    return false;
  if (peakPrice <= 0 || trendAverageVolumeUsd <= 0) return false;
  return (
    pullbackLow >= priorSupport &&
    (peakPrice - pullbackLow) / peakPrice <= thresholds.pullbackMaxRetraceRate &&
    pullbackVolumeUsd <= trendAverageVolumeUsd * thresholds.pullbackMaxVolumeRatio
  );
}

export function isRestart(
  current: CompletedCandle,
  pullbackRangeHigh: number,
  pullbackAverageVolumeUsd: number,
  thresholds: PriceFeatureThresholds
): boolean {
  return (
    validPriceVolume(current) &&
    Number.isFinite(pullbackRangeHigh) &&
    Number.isFinite(pullbackAverageVolumeUsd) &&
    current.close > pullbackRangeHigh &&
    current.volumeUsd >= pullbackAverageVolumeUsd * thresholds.restartMinimumVolumeRatio
  );
}

export function isVerticalPump(
  candles: readonly CompletedCandle[],
  thresholds: PriceFeatureThresholds
): boolean {
  const sample = completed(candles).slice(-thresholds.verticalPumpWindowCandles);
  const first = sample[0];
  const last = sample.at(-1);
  if (
    sample.length !== thresholds.verticalPumpWindowCandles ||
    !sample.every(validPriceVolume) ||
    !first ||
    !last ||
    first.close <= 0
  )
    return false;
  return last.close / first.close - 1 >= thresholds.verticalPumpMaximumGrowthRate;
}

export interface TimedFeature<T> {
  value: T;
  observedAtMs: number;
}
export interface SharedFeatures {
  candles: TimedFeature<CompletedCandle[]> | null;
  liquidityUsd: TimedFeature<number> | null;
  ageHours: TimedFeature<number> | null;
  netBuyUsd: TimedFeature<number> | null;
  attention: TimedFeature<number> | null;
  top10HolderRate: TimedFeature<number> | null;
  creatorTokenCount: TimedFeature<number> | null;
}
export function isFreshFeature<T>(
  feature: TimedFeature<T> | null,
  nowMs: number,
  ttlMs: number
): boolean {
  return feature !== null && nowMs >= feature.observedAtMs && nowMs - feature.observedAtMs <= ttlMs;
}

/**
 * Small, in-process cache for feature inputs.  Consumers must provide their
 * clock and the field-specific TTL at every read, so cached data can never be
 * silently treated as current by the scoring path.
 */
export class FreshFeatureCache {
  readonly #entries = new Map<string, TimedFeature<unknown>>();

  set<T>(key: string, value: T, observedAtMs: number): void {
    this.#entries.set(key, { value, observedAtMs });
  }

  getFresh<T>(key: string, nowMs: number, ttlMs: number): TimedFeature<T> | null {
    const feature = this.#entries.get(key);
    if (!feature || !isFreshFeature(feature, nowMs, ttlMs)) {
      if (feature && nowMs >= feature.observedAtMs && nowMs - feature.observedAtMs > ttlMs)
        this.#entries.delete(key);
      return null;
    }
    return feature as TimedFeature<T>;
  }
}

export function extractSharedFeatures(input: {
  observedAtMs: number;
  kline?: unknown[];
  info?: Record<string, unknown>;
  holders?: Record<string, unknown>;
  creator?: Record<string, unknown>;
  attention?: Record<string, unknown>;
}): SharedFeatures {
  const numeric = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const timed = <T>(value: T | null): TimedFeature<T> | null =>
    value === null ? null : { value, observedAtMs: input.observedAtMs };
  const info = input.info ?? {};
  const created = numeric(info.created_timestamp ?? info.open_timestamp);
  const candles = (input.kline ?? []).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const values = [
      numeric(row.open),
      numeric(row.high),
      numeric(row.low),
      numeric(row.close),
      numeric(row.volume ?? row.volume_usd)
    ];
    return values.every((value): value is number => value !== null)
      ? [
          {
            open: values[0]!,
            high: values[1]!,
            low: values[2]!,
            close: values[3]!,
            volumeUsd: values[4]!,
            swaps: numeric(row.swaps ?? row.swap_count),
            completed: row.completed !== false
          }
        ]
      : [];
  });
  return {
    candles: timed(candles.length ? candles : null),
    liquidityUsd: timed(numeric(info.liquidity ?? info.liquidity_usd)),
    ageHours: timed(
      created === null
        ? null
        : Math.max(
            0,
            (input.observedAtMs - (created < 10_000_000_000 ? created * 1000 : created)) / 3600000
          )
    ),
    netBuyUsd: timed(numeric(info.net_buy_1h ?? info.net_buy_usd)),
    attention: timed(numeric(input.attention?.visiting_count ?? input.attention?.callout_count)),
    top10HolderRate: timed(numeric(input.holders?.top_10_holder_rate)),
    creatorTokenCount: timed(
      numeric(input.creator?.creator_created_count ?? input.creator?.created_count)
    )
  };
}

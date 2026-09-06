import type { RouteFeatures } from './routes.js';
import {
  isBreakout,
  isDormant,
  isHealthyPullback,
  isRestart,
  isRevivalActivity,
  isUpwardTrend,
  isVerticalPump,
  type CompletedCandle,
  type PriceFeatureThresholds
} from './features.js';

export function adaptGmgnCandles(
  response: unknown,
  observedAtMs: number,
  _currentSwaps?: number,
  resolutionMs = 30_000
): CompletedCandle[] {
  const data = dataRecord(response);
  const rows: unknown[] = Array.isArray(data.list) ? data.list : [];
  const intervalMs = resolutionMs;
  const candles = new Map<number, CompletedCandle>();
  for (const row of rows) {
    const item = record(row);
    if (!item) continue;
    const time = finite(item.time);
    const values = [item.open, item.high, item.low, item.close, item.volume ?? item.volume_usd].map(
      finite
    );
    if (time === null || values.some((value) => value === null)) continue;
    const [open, high, low, close, volumeUsd] = values as number[];
    if (
      !open ||
      !high ||
      !low ||
      !close ||
      volumeUsd === undefined ||
      volumeUsd < 0 ||
      low > Math.min(open, close) ||
      high < Math.max(open, close) ||
      low > high
    )
      continue;
    // The audited GMGN Kline contract uses milliseconds, not token creation seconds.
    candles.set(time, {
      timeMs: time,
      intervalMs,
      open,
      high,
      low,
      close,
      volumeUsd,
      swaps: finite(item.swaps ?? item.swap_count),
      completed: item.completed !== false && time + intervalMs <= observedAtMs
    });
  }
  return [...candles.values()].sort((a, b) => a.timeMs! - b.timeMs!);
}

export function deriveKlineRouteSignals(
  candles: readonly CompletedCandle[],
  thresholds: PriceFeatureThresholds
): {
  dormant: boolean;
  revivalActivity: boolean;
  breakout: boolean;
  upwardTrend: boolean;
  healthyPullback: boolean;
  restartVolume: boolean;
  verticalPump: boolean;
} {
  candles = candles.filter((candle) => candle.completed);
  const current = candles.at(-1);
  const history = candles.slice(0, -1);
  const pullback = history.at(-1);
  const trend = history.slice(0, -1);
  const peak = trend.length ? Math.max(...trend.map((candle) => candle.high)) : Number.NaN;
  const support = trend.length ? Math.min(...trend.map((candle) => candle.low)) : Number.NaN;
  const trendAverageVolume = trend.length
    ? trend.reduce((total, candle) => total + candle.volumeUsd, 0) / trend.length
    : Number.NaN;
  const healthyPullback =
    pullback !== undefined &&
    isHealthyPullback(
      peak,
      pullback.low,
      support,
      pullback.volumeUsd,
      trendAverageVolume,
      thresholds
    );
  return {
    // A revival's current candle must not be part of the dormant baseline:
    // including it would make every legitimate volume spike erase its own proof.
    dormant: isDormant(history, thresholds),
    revivalActivity: current ? isRevivalActivity(current, history, thresholds) : false,
    breakout: current ? isBreakout(current, history, thresholds) : false,
    upwardTrend: isUpwardTrend(candles, thresholds),
    healthyPullback,
    restartVolume:
      current !== undefined && pullback !== undefined
        ? isRestart(current, pullback.high, pullback.volumeUsd, thresholds)
        : false,
    verticalPump: isVerticalPump(candles, thresholds)
  };
}

export function adaptGmgnRouteFeatures(input: {
  info: unknown;
  nowMs: number;
  evidenceGatePassed: boolean;
  hasCompletedDormancy: boolean;
  revivalVolumeQualified: boolean;
  revivalSwapsQualified: boolean;
  structureBreakout: boolean;
  additionalRevivalConfirmation: boolean;
  upwardTrend: boolean;
  healthyPullback: boolean;
  restartVolume: boolean;
  smartMoneyExit: boolean;
  quoteDeteriorated: boolean;
  verticalPump: boolean;
  supportingGrowthObserved?: boolean;
}): RouteFeatures | null {
  const info = dataRecord(input.info);
  const ageMs = tokenAgeMs(input.info, input.nowMs);
  const liquidityUsd = finite(info.liquidity);
  const price = record(info.price);
  const priceUsd = finite(price?.price);
  if (ageMs === null || liquidityUsd === null || !price) return null;
  const buys = finite(price.buys_1m);
  const swaps = finite(price.swaps_1m);
  const volume = finite(price.volume_1m);
  const priorVolume = finite(price.volume_5m);
  const launchpadStatus = finite(info.launchpad_status);
  return {
    ageMs,
    liquidityUsd,
    ...(priceUsd !== null ? { priceUsd } : {}),
    firstLaunchStage: launchpadStatus === 1 || launchpadStatus === 2,
    validPool:
      typeof info.biggest_pool_address === 'string' && info.biggest_pool_address.length > 0,
    realTrading: buys !== null && swaps !== null && buys > 0 && swaps > 0,
    growthObserved:
      volume !== null && priorVolume !== null && volume > 0 && volume > priorVolume / 5,
    evidenceGatePassed: input.evidenceGatePassed,
    hasCompletedDormancy: input.hasCompletedDormancy,
    revivalVolumeQualified: input.revivalVolumeQualified,
    revivalSwapsQualified: input.revivalSwapsQualified,
    structureBreakout: input.structureBreakout,
    additionalRevivalConfirmation: input.additionalRevivalConfirmation,
    upwardTrend: input.upwardTrend,
    healthyPullback: input.healthyPullback,
    restartVolume: input.restartVolume,
    smartMoneyExit: input.smartMoneyExit,
    quoteDeteriorated: input.quoteDeteriorated,
    verticalPump: input.verticalPump
  };
}

export function tokenAgeMs(infoResponse: unknown, nowMs: number): number | null {
  const info = dataRecord(infoResponse);
  return ageFrom(info.creation_timestamp ?? info.open_timestamp, nowMs);
}

function dataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  let root = value as Record<string, unknown>;
  for (let depth = 0; depth < 3; depth += 1) {
    const nested = record(root.data);
    if (!nested) break;
    root = nested;
  }
  return root;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function ageFrom(value: unknown, nowMs: number): number | null {
  const timestamp = finite(value);
  if (timestamp === null) return null;
  const milliseconds = timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
  return milliseconds <= nowMs ? nowMs - milliseconds : null;
}

export function currentInfoSwaps(infoResponse: unknown): number | null {
  const info = dataRecord(infoResponse);
  return finite(record(info.price)?.swaps_5m);
}

export function rollingRevivalActivity(
  infoResponse: unknown,
  history: CompletedCandle[],
  nowMs: number,
  thresholds: PriceFeatureThresholds
): boolean {
  const price = record(dataRecord(infoResponse).price);
  const close = finite(price?.price),
    volumeUsd = finite(price?.volume_5m),
    swaps = finite(price?.swaps_5m);
  if (close === null || volumeUsd === null || swaps === null) return false;
  const baseline = history.filter(
    (c) =>
      c.timeMs !== undefined &&
      c.intervalMs === 300_000 &&
      c.timeMs + c.intervalMs <= nowMs - 300_000
  );
  return isRevivalActivity(
    { open: close, high: close, low: close, close, volumeUsd, swaps, completed: true },
    baseline,
    thresholds
  );
}

export function usablePool(response: unknown, infoResponse: unknown): boolean {
  const pool = dataRecord(response),
    info = dataRecord(infoResponse);
  const address = pool.pool_address ?? pool.address;
  return (
    typeof address === 'string' &&
    typeof info.biggest_pool_address === 'string' &&
    address.toLowerCase() === info.biggest_pool_address.toLowerCase() &&
    (finite(pool.liquidity) ?? 0) > 0
  );
}

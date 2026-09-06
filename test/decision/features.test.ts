import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractSharedFeatures,
  FreshFeatureCache,
  isBreakout,
  isDormant,
  isFreshFeature,
  isHealthyPullback,
  isRestart,
  isRevivalActivity,
  isUpwardTrend,
  isVerticalPump,
  type CompletedCandle,
  type PriceFeatureThresholds
} from '../../src/decision/features.js';

const thresholds: PriceFeatureThresholds = {
  dormancyWindowCandles: 3,
  dormancyMaxAverageVolumeUsd: 10,
  dormancyMaxAverageSwaps: 2,
  revivalBaselineCandles: 3,
  revivalMinAbsoluteVolumeUsd: 100,
  revivalMinAbsoluteSwaps: 10,
  revivalVolumeMultiple: 3,
  revivalSwapsMultiple: 2,
  breakoutLookbackCandles: 3,
  breakoutMinimumRate: 0,
  trendLookbackCandles: 3,
  trendMinimumGrowthRate: 0.1,
  pullbackMaxRetraceRate: 0.25,
  pullbackMaxVolumeRatio: 0.8,
  restartMinimumVolumeRatio: 1.5,
  verticalPumpWindowCandles: 3,
  verticalPumpMaximumGrowthRate: 0.5
};
function candle(close: number, volumeUsd = 5, swaps = 1): CompletedCandle {
  return { open: close, high: close, low: close, close, volumeUsd, swaps, completed: true };
}

void test('calculates dormancy, revival with zero-baseline fallback, and structure breakout', () => {
  const dormant = [candle(10), candle(10), candle(10)];
  assert.equal(isDormant(dormant, thresholds), true);
  assert.equal(isRevivalActivity(candle(11, 100, 10), dormant, thresholds), true);
  assert.equal(isRevivalActivity(candle(11, 14, 2), dormant, thresholds), false);
  assert.equal(isBreakout(candle(12), [candle(10), candle(11), candle(11.5)], thresholds), true);
});

void test('calculates upward trend, healthy pullback, restart and vertical-pump rejection', () => {
  assert.equal(isUpwardTrend([candle(10), candle(10.5), candle(11)], thresholds), true);
  assert.equal(isHealthyPullback(120, 100, 95, 70, 100, thresholds), true);
  assert.equal(isHealthyPullback(120, 80, 95, 70, 100, thresholds), false);
  assert.equal(isRestart(candle(111, 150), 110, 100, thresholds), true);
  assert.equal(isVerticalPump([candle(10), candle(12), candle(15)], thresholds), true);
});

void test('uses OHLCV-only live Klines for trend rules and absolute swap fallback for revival', () => {
  const history = [candle(10), candle(10), candle(10)].map((item) => ({ ...item, swaps: null }));
  assert.equal(isDormant(history, thresholds), true);
  assert.equal(
    isUpwardTrend(
      [candle(10), candle(10.5), candle(11)].map((item) => ({ ...item, swaps: null })),
      thresholds
    ),
    true
  );
  assert.equal(
    isRevivalActivity({ ...candle(12, 100, 10), completed: false }, history, thresholds),
    true
  );
  assert.equal(
    isRevivalActivity({ ...candle(12, 100, 1), completed: false }, history, thresholds),
    false
  );
});

void test('extracts shared route features and only returns cache values while fresh', () => {
  const observedAtMs = 1_700_000_000_000;
  const features = extractSharedFeatures({
    observedAtMs,
    kline: [
      {
        open: '1',
        high: '1.5',
        low: '0.9',
        close: '1.2',
        volume_usd: '400',
        swap_count: '12'
      },
      { open: 'bad' }
    ],
    info: {
      liquidity_usd: '20000',
      created_timestamp: String((observedAtMs - 2 * 3600000) / 1000),
      net_buy_1h: '1250'
    },
    attention: { visiting_count: '85' },
    holders: { top_10_holder_rate: '0.35' },
    creator: { creator_created_count: '3' }
  });

  assert.deepEqual(features.candles?.value, [
    { open: 1, high: 1.5, low: 0.9, close: 1.2, volumeUsd: 400, swaps: 12, completed: true }
  ]);
  assert.equal(features.liquidityUsd?.value, 20000);
  assert.equal(features.ageHours?.value, 2);
  assert.equal(features.netBuyUsd?.value, 1250);
  assert.equal(features.attention?.value, 85);
  assert.equal(features.top10HolderRate?.value, 0.35);
  assert.equal(features.creatorTokenCount?.value, 3);
  assert.equal(isFreshFeature(features.liquidityUsd, observedAtMs + 30_000, 30_000), true);
  assert.equal(isFreshFeature(features.liquidityUsd, observedAtMs + 30_001, 30_000), false);

  const cache = new FreshFeatureCache();
  const liquidity = features.liquidityUsd;
  assert.ok(liquidity);
  cache.set('token:liquidity', liquidity.value, observedAtMs);
  assert.equal(
    cache.getFresh<number>('token:liquidity', observedAtMs + 30_000, 30_000)?.value,
    20000
  );
  assert.equal(cache.getFresh<number>('token:liquidity', observedAtMs + 30_001, 30_000), null);
  assert.equal(cache.getFresh<number>('token:liquidity', observedAtMs + 30_001, 30_000), null);
});

void test('fails closed for empty or invalid shared feature inputs', () => {
  const features = extractSharedFeatures({
    observedAtMs: 1000,
    kline: [{ open: 1, high: 2, low: 0, close: 1 }],
    info: { liquidity_usd: 'unknown', created_timestamp: 'future' },
    holders: { top_10_holder_rate: 'not-a-rate' }
  });
  assert.equal(features.candles, null);
  assert.equal(features.liquidityUsd, null);
  assert.equal(features.ageHours, null);
  assert.equal(features.top10HolderRate, null);
});

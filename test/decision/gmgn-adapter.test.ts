import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adaptGmgnCandles,
  adaptGmgnRouteFeatures,
  deriveKlineRouteSignals
} from '../../src/decision/gmgn-adapter.js';

const fixed = {
  evidenceGatePassed: true,
  hasCompletedDormancy: false,
  revivalVolumeQualified: false,
  revivalSwapsQualified: false,
  structureBreakout: false,
  additionalRevivalConfirmation: false,
  upwardTrend: false,
  healthyPullback: false,
  restartVolume: false,
  smartMoneyExit: false,
  quoteDeteriorated: false,
  verticalPump: false
};

void test('adapts audited Info lifecycle, liquidity and trading fields without guessing missing data', () => {
  const features = adaptGmgnRouteFeatures({
    info: {
      data: {
        creation_timestamp: 100,
        liquidity: '20000',
        biggest_pool_address: '0xpool',
        launchpad_status: 1,
        price: {
          buys_1m: 2,
          sells_1m: 1,
          swaps_1m: 3,
          volume_1m: '100',
          volume_5m: '200'
        }
      }
    },
    nowMs: 200_000,
    ...fixed
  });
  assert.equal(features?.ageMs, 100_000);
  assert.equal(features?.liquidityUsd, 20000);
  assert.equal(features?.firstLaunchStage, true);
  assert.equal(features?.realTrading, true);
  assert.equal(features?.growthObserved, true);
  assert.equal(
    adaptGmgnRouteFeatures({
      info: { data: { liquidity: '20000', price: {} } },
      nowMs: 1,
      ...fixed
    }),
    null
  );
});

void test('requires real volume growth even with strong capital support', () => {
  const features = adaptGmgnRouteFeatures({
    info: {
      data: {
        creation_timestamp: 100,
        liquidity: '20000',
        biggest_pool_address: '0xpool',
        launchpad_status: 1,
        price: {
          buys_1m: 3,
          sells_1m: 0,
          swaps_1m: 3,
          volume_1m: '20',
          volume_5m: '200'
        }
      }
    },
    nowMs: 200_000,
    ...fixed,
    supportingGrowthObserved: true
  });
  assert.equal(features?.realTrading, true);
  assert.equal(features?.growthObserved, false);
});

void test('normalizes only complete numeric Kline rows from the audited list envelope', () => {
  assert.deepEqual(
    adaptGmgnCandles(
      {
        data: {
          list: [
            { time: 0, open: '1', high: '2', low: '0.5', close: '1.5', volume: '100', swaps: '8' },
            { open: 'bad' }
          ]
        }
      },
      30_000
    ),
    [
      {
        timeMs: 0,
        intervalMs: 30_000,
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volumeUsd: 100,
        swaps: 8,
        completed: true
      }
    ]
  );
  assert.deepEqual(adaptGmgnCandles({ data: { list: [] } }, 1), []);
});

void test('unwraps the live double envelope, keeps OHLCV without historical swaps and excludes the open window', () => {
  assert.deepEqual(
    adaptGmgnCandles(
      {
        data: {
          code: 0,
          data: {
            list: [
              { time: 60_000, open: '1', high: '2', low: '1', close: '2', volume: '100' },
              { time: 120_000, open: '2', high: '3', low: '2', close: '3', volume: '200' }
            ]
          }
        }
      },
      150_000,
      12,
      60_000
    ),
    [
      {
        timeMs: 60_000,
        intervalMs: 60_000,
        open: 1,
        high: 2,
        low: 1,
        close: 2,
        volumeUsd: 100,
        swaps: null,
        completed: true
      },
      {
        timeMs: 120_000,
        intervalMs: 60_000,
        open: 2,
        high: 3,
        low: 2,
        close: 3,
        volumeUsd: 200,
        swaps: null,
        completed: false
      }
    ]
  );
});

void test('uses YAML-derived Kline thresholds for route signals', () => {
  const thresholds = {
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
  const signals = deriveKlineRouteSignals(
    [
      { open: 10, high: 10, low: 10, close: 10, volumeUsd: 5, swaps: 1, completed: true },
      { open: 10, high: 10, low: 10, close: 10, volumeUsd: 5, swaps: 1, completed: true },
      { open: 10, high: 10, low: 10, close: 10, volumeUsd: 5, swaps: 1, completed: true },
      { open: 12, high: 12, low: 12, close: 12, volumeUsd: 100, swaps: 10, completed: true }
    ],
    thresholds
  );
  assert.equal(signals.revivalActivity, true);
  assert.equal(signals.breakout, true);
  assert.equal(signals.upwardTrend, true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { RouteClassifyOptions } from '../../src/decision/runtime.js';
import type { RuntimeConfig } from '../../src/config/types.js';
import { RouteRuntime } from '../../src/decision/runtime.js';
import type { NormalizedEvent } from '../../src/discovery/events.js';

const nowMs = 10_000_000;
const config = {
  strategy: {
    new_launch_max_age_hours: 24,
    new_launch_min_liquidity_usd: 10_000,
    revival_min_age_hours: 24,
    revival_min_liquidity_usd: 20_000,
    continuation_min_liquidity_usd: 30_000,
    dormancy_window_candles: 3,
    dormancy_max_average_volume_usd: 10,
    dormancy_max_average_swaps: 2,
    revival_baseline_candles: 3,
    revival_min_absolute_volume_usd: 100,
    revival_min_absolute_swaps: 10,
    revival_volume_multiple: 3,
    revival_swaps_multiple: 2,
    breakout_lookback_candles: 3,
    breakout_minimum_rate: 0,
    trend_lookback_candles: 3,
    trend_minimum_growth_rate: 0.1,
    pullback_max_retrace_rate: 0.25,
    pullback_max_volume_ratio: 0.8,
    restart_minimum_volume_ratio: 1.5,
    vertical_pump_window_candles: 3,
    vertical_pump_maximum_growth_rate: 0.5
  },
  evidence: {
    ttl_seconds: { lifecycle: 600, structure: 180, capital: 300, attention: 600, narrative: 1800 }
  },
  scoring: {
    observation_threshold: 65,
    formal_threshold: 80,
    min_completeness: 0.7,
    data_ttl_seconds: { info: 30, pool: 30, kline: 60, traders: 180, holders: 300, creator: 3600 },
    route_weights: {
      new_launch: {
        lifecycle: 20,
        structure: 25,
        capital: 25,
        attention: 15,
        quality: 10,
        freshness: 5
      },
      revival: {
        lifecycle: 5,
        structure: 30,
        capital: 30,
        attention: 20,
        quality: 10,
        freshness: 5
      },
      continuation: {
        lifecycle: 0,
        structure: 40,
        capital: 30,
        attention: 10,
        quality: 10,
        freshness: 10
      }
    },
    decisive_trigger_seconds: { new_launch: 90, revival: 120, continuation: 60 }
  }
} as unknown as RuntimeConfig;

config.security = {
  lazy_deep: { creator_history_max_penalty_points: 5 }
} as RuntimeConfig['security'];

const info = {
  data: {
    creation_timestamp: (nowMs - 3_600_000) / 1_000,
    liquidity: '20000',
    biggest_pool_address: '0xpool',
    launchpad_status: 1,
    price: {
      price: '1.2',
      buys_1m: 2,
      sells_1m: 1,
      swaps_1m: 3,
      volume_1m: '100',
      volume_5m: '200'
    }
  }
};
const kline = {
  data: {
    list: [
      {
        time: nowMs - 90_000,
        open: '1',
        high: '1',
        low: '1',
        close: '1',
        volume: '10',
        swaps: '2'
      },
      {
        time: nowMs - 60_000,
        open: '1',
        high: '1.1',
        low: '1',
        close: '1.1',
        volume: '11',
        swaps: '2'
      },
      {
        time: nowMs - 30_000,
        open: '1.1',
        high: '1.2',
        low: '1.1',
        close: '1.2',
        volume: '12',
        swaps: '3'
      }
    ]
  }
};

class TestedRuntime extends RouteRuntime {
  override classify(
    event: NormalizedEvent,
    knownInfo?: unknown,
    options: RouteClassifyOptions = {}
  ) {
    return super.classify(event, knownInfo, {
      pool: { data: { address: '0xpool', liquidity: '20000' } },
      poolObservedAtMs: nowMs,
      infoObservedAtMs: nowMs,
      ...options
    });
  }
}
function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    key: `event-${overrides.source ?? 'signal'}-${overrides.evidenceFamily ?? 'capital'}`,
    chain: 'bsc',
    tokenAddress: '0xtoken',
    source: 'signal',
    sourceEventAtMs: nowMs,
    observedAtMs: nowMs,
    evidenceFamily: 'capital',
    strength: 'strong',
    expiresAtMs: nowMs + 300_000,
    rawPayloadRef: 'sha256:test',
    payload: {},
    ...overrides
  };
}

void test('aggregates cross-source evidence before promoting a route to formal', async () => {
  const runtime = new TestedRuntime(
    config,
    { token: () => Promise.resolve(info), kline: () => Promise.resolve(kline) } as never,
    () => nowMs
  );
  const first = await runtime.classify(event());
  assert.equal(first.route, 'new_launch');
  assert.equal(first.decision, 'observing');
  assert.equal(first.evidenceFamilies, 1);
  const second = await runtime.classify(
    event({ source: 'trending', evidenceFamily: 'attention', strength: 'weak' })
  );
  assert.equal(second.route, 'new_launch');
  assert.equal(second.decision, 'formal');
  assert.equal(second.evidenceFamilies, 2);
  assert.ok(second.score && second.score.score >= 80);
});

void test('caps an elevated creator-history adjustment at five points without vetoing the route', async () => {
  const runtime = new TestedRuntime(
    config,
    { token: () => Promise.resolve(info), kline: () => Promise.resolve(kline) } as never,
    () => nowMs
  );
  await runtime.classify(event());
  const preliminary = await runtime.classify(
    event({ source: 'trending', evidenceFamily: 'attention', strength: 'weak' })
  );
  assert.equal(preliminary.score?.score, 92.5);
  const adjusted = runtime.applyCreatorHistoryQuality(preliminary, 0.5);
  assert.equal(adjusted.score?.score, 87.5);
  assert.equal(adjusted.decision, 'formal');
});

void test('contrary evidence immediately revokes its family and blocks the entry gate', async () => {
  const runtime = new TestedRuntime(
    config,
    { token: () => Promise.resolve(info), kline: () => Promise.resolve(kline) } as never,
    () => nowMs
  );
  await runtime.classify(event());
  const reversed = await runtime.classify(event({ payload: { contrary: true } }));
  assert.equal(reversed.route, null);
  assert.equal(reversed.evidenceFamilies, 0);
});

void test('treats two fresh weak families as a decisive trigger when their score qualifies', async () => {
  const runtime = new TestedRuntime(
    config,
    { token: () => Promise.resolve(info), kline: () => Promise.resolve(kline) } as never,
    () => nowMs
  );
  await runtime.classify(event({ strength: 'weak' }));
  const second = await runtime.classify(
    event({ source: 'trending', evidenceFamily: 'attention', strength: 'weak' })
  );
  assert.equal(second.decision, 'formal');
  assert.equal(second.decisiveTriggerAtMs, nowMs);
});

void test('does not spend candidate API capacity on one weak evidence family', async () => {
  let calls = 0;
  const runtime = new TestedRuntime(
    config,
    {
      token: () => {
        calls += 1;
        return Promise.resolve(info);
      },
      kline: () => {
        calls += 1;
        return Promise.resolve(kline);
      }
    } as never,
    () => nowMs
  );
  const result = await runtime.classify(event({ strength: 'weak' }));
  assert.equal(result.route, null);
  assert.equal(result.evidenceFamilies, 1);
  assert.equal(calls, 0);
});

void test('reuses Kline inside the observation interval and refreshes it when forced', async () => {
  let calls = 0;
  const runtime = new TestedRuntime(
    config,
    {
      token: () => Promise.resolve(info),
      kline: () => {
        calls += 1;
        return Promise.resolve(kline);
      }
    } as never,
    () => nowMs
  );
  await runtime.classify(event());
  await runtime.classify(
    event({ source: 'trending', evidenceFamily: 'attention', strength: 'weak' })
  );
  assert.equal(calls, 1);
  await runtime.classify(event({ source: 'signal', evidenceFamily: 'structure' }), undefined, {
    forceKline: true
  });
  assert.equal(calls, 2);
});

void test('measures cached Kline freshness at analysis completion time', async () => {
  let currentMs = nowMs;
  const runtime = new TestedRuntime(
    config,
    {
      token: () => Promise.resolve(info),
      kline: () => {
        currentMs += 1_000;
        return Promise.resolve(kline);
      }
    } as never,
    () => currentMs
  );
  const result = await runtime.classify(event());
  assert.equal(result.score?.completeness, 1);
  assert.equal(result.decision, 'observing');
});

void test('uses 30s Kline for launch/continuation and adds 5m Kline for revival-age tokens', async () => {
  const resolutions: string[] = [];
  const api = {
    token: () => Promise.resolve(info),
    kline: (_address: string, resolution: string) => {
      resolutions.push(resolution);
      return Promise.resolve(kline);
    }
  } as never;
  const runtime = new TestedRuntime(config, api, () => nowMs);
  await runtime.classify(event());
  assert.deepEqual(resolutions, ['30s']);

  const oldInfo = {
    data: {
      ...info.data,
      creation_timestamp: (nowMs - 25 * 3_600_000) / 1_000
    }
  };
  const oldResolutions: string[] = [];
  const oldRuntime = new TestedRuntime(
    config,
    {
      token: () => Promise.resolve(oldInfo),
      kline: (_address: string, resolution: string) => {
        oldResolutions.push(resolution);
        return Promise.resolve(kline);
      }
    } as never,
    () => nowMs
  );
  await oldRuntime.classify(event(), oldInfo);
  assert.deepEqual(oldResolutions.sort(), ['30s', '5m']);
});

void test('keeps an old-token momentum breakout observation-only until continuation confirms', async () => {
  const oldInfo = {
    data: {
      ...info.data,
      creation_timestamp: (nowMs - 48 * 3_600_000) / 1_000
    }
  };
  const momentumKline = {
    data: {
      list: [
        {
          time: nowMs - 120_000,
          open: '1',
          high: '1',
          low: '1',
          close: '1',
          volume: '10',
          swaps: '2'
        },
        {
          time: nowMs - 90_000,
          open: '1',
          high: '1.05',
          low: '1',
          close: '1.05',
          volume: '11',
          swaps: '2'
        },
        {
          time: nowMs - 60_000,
          open: '1.05',
          high: '1.1',
          low: '1.04',
          close: '1.1',
          volume: '12',
          swaps: '3'
        },
        {
          time: nowMs - 30_000,
          open: '1.1',
          high: '1.25',
          low: '1.1',
          close: '1.25',
          volume: '20',
          swaps: '5'
        }
      ]
    }
  };
  const runtime = new TestedRuntime(
    config,
    {
      token: () => Promise.resolve(oldInfo),
      kline: () => Promise.resolve(momentumKline)
    } as never,
    () => nowMs
  );
  const evaluation = await runtime.classify(event(), oldInfo);
  assert.equal(evaluation.route, 'continuation');
  assert.equal(evaluation.observationOnly, true);
  assert.equal(evaluation.decision, 'observing');
  assert.ok(evaluation.score && evaluation.score.score >= 80);
});

void test('missing candles or pool data cannot qualify formally and creator adjustment cannot bypass that gate', async () => {
  for (const value of [kline, { data: { list: [] } }]) {
    const runtime = new RouteRuntime(
      config,
      { token: () => Promise.resolve(info), kline: () => Promise.resolve(value) } as never,
      () => nowMs
    );
    await runtime.classify(event());
    const result = await runtime.classify(
      event({ source: 'trending', evidenceFamily: 'attention', strength: 'weak' })
    );
    assert.notEqual(result.decision, 'formal');
    assert.ok(result.score!.completeness < 1);
    assert.notEqual(runtime.applyCreatorHistoryQuality(result, 0.5).decision, 'formal');
  }
});
void test('recent attention does not rejuvenate an old capital trigger', async () => {
  const runtime = new TestedRuntime(
    config,
    { token: () => Promise.resolve(info), kline: () => Promise.resolve(kline) } as never,
    () => nowMs
  );
  await runtime.classify(event({ sourceEventAtMs: nowMs - 100_000 }));
  const result = await runtime.classify(
    event({ source: 'hot', evidenceFamily: 'attention', strength: 'weak' })
  );
  assert.equal(result.decisiveTriggerAtMs, nowMs - 100_000);
  assert.equal(result.decision, 'observing');
});

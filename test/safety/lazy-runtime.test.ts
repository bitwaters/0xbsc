import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeConfig } from '../../src/config/types.js';
import { LazySafetyRuntime } from '../../src/safety/lazy-runtime.js';

const config = {
  security: {
    lazy_deep: {
      max_single_non_pool_holder_percent: 0.2,
      max_suspicious_holder_percent: 0.1,
      max_creator_hold_percent: 0.1,
      max_creator_created_tokens: 5,
      min_creator_open_ratio: 0.5,
      creator_history_max_penalty_points: 5,
      coordinated_exit: {
        min_tagged_wallets: 3,
        min_each_sell_percent: 0.05,
        min_total_sell_percent: 0.2,
        max_activity_age_seconds: 180,
        max_activity_spread_seconds: 60,
        recognized_wallet_tags: ['smart_money', 'kol']
      }
    }
  }
} as RuntimeConfig;

const info = {
  data: {
    pool_address: '0xpool',
    dev: { creator_address: '0xcreator' },
    stat: { creator_created_count: 2, creator_hold_rate: 0.05 }
  }
};

function api(overrides: Partial<Record<'holders' | 'traders' | 'createdTokens', unknown>> = {}) {
  return {
    holders: () =>
      Promise.resolve(
        overrides.holders ?? {
          data: {
            list: [
              { address: '0xpool', amount_percentage: 0.8, is_suspicious: false },
              { address: '0xuser', amount_percentage: 0.2, is_suspicious: false }
            ]
          }
        }
      ),
    traders: () =>
      Promise.resolve(
        overrides.traders ?? {
          data: { list: [{ tags: [], maker_token_tags: [], sell_amount_percentage: 0 }] }
        }
      ),
    createdTokens: () => Promise.resolve(overrides.createdTokens ?? { data: { open_ratio: 0.75 } })
  };
}

void test('admits complete GMGN deep-safety responses below conservative thresholds', async () => {
  const result = await new LazySafetyRuntime(config, api() as never).evaluate('0xtoken', info);
  assert.deepEqual(result, {
    allowed: true,
    reason: null,
    fetched: true,
    creatorHistory: {
      createdTokens: 2,
      openRatio: 0.75,
      risk: 'healthy',
      qualityLevel: 1
    }
  });
});

void test('rejects concentrated holders, direct creator holdings, coordinated recent net exits and shape drift', async () => {
  const nowMs = 2_000_000_000_000;
  const cases: Array<[string, Parameters<typeof api>[0], string]> = [
    [
      'holder',
      {
        holders: {
          data: {
            list: [
              { address: '0xpool', amount_percentage: 0.7, is_suspicious: false },
              { address: '0xwhale', amount_percentage: 0.21, is_suspicious: false }
            ]
          }
        }
      },
      'holders_single_wallet_limit'
    ],
    ['creator_hold', {}, 'creator_direct_hold_unverified'],
    [
      'exit',
      {
        traders: {
          data: {
            list: [
              {
                tags: ['smart_money'],
                maker_token_tags: [],
                sell_amount_percentage: 8,
                netflow_usd: -10,
                last_active_timestamp: nowMs / 1_000
              },
              {
                tags: ['smart_money'],
                maker_token_tags: [],
                sell_amount_percentage: 8,
                netflow_usd: -20,
                last_active_timestamp: nowMs / 1_000 - 20
              },
              {
                tags: ['kol'],
                maker_token_tags: [],
                sell_amount_percentage: 8,
                netflow_usd: -30,
                last_active_timestamp: nowMs / 1_000 - 40
              }
            ]
          }
        }
      },
      'trader_fields_invalid'
    ],
    [
      'drift',
      { holders: { data: { list: [{ address: '0xpool', amount_percentage: 0.8 }] } } },
      'holders_wallets_missing'
    ]
  ];
  for (const [name, overrides, reason] of cases) {
    const candidateInfo =
      name === 'creator_hold'
        ? {
            ...info,
            data: { ...info.data, stat: { creator_created_count: 2, creator_hold_rate: 0.11 } }
          }
        : info;
    const result = await new LazySafetyRuntime(
      config,
      api(overrides) as never,
      () => nowMs
    ).evaluate('0xtoken', candidateInfo);
    assert.equal(result.allowed, false, name);
    assert.equal(result.reason, reason, name);
  }
});

void test('does not label cumulative netflow as a confirmed recent exit', async () => {
  const nowMs = 2_000_000_000_000;
  const row = (lastActiveSeconds: number, netflowUsd: number) => ({
    tags: ['smart_money'],
    maker_token_tags: [],
    sell_amount_percentage: 8,
    netflow_usd: netflowUsd,
    last_active_timestamp: lastActiveSeconds
  });
  const cases = [
    [row(nowMs / 1_000 - 181, -10), row(nowMs / 1_000 - 182, -10), row(nowMs / 1_000 - 183, -10)],
    [row(nowMs / 1_000, -10), row(nowMs / 1_000 - 61, -10), row(nowMs / 1_000 - 120, -10)],
    [row(nowMs / 1_000, 10), row(nowMs / 1_000 - 10, -10), row(nowMs / 1_000 - 20, -10)]
  ];
  for (const list of cases) {
    const result = await new LazySafetyRuntime(
      config,
      api({ traders: { data: { list } } }) as never,
      () => nowMs
    ).evaluate('0xtoken', info);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'trader_fields_invalid');
  }
});

void test('converts prolific low-open creator history into a score adjustment instead of a veto', async () => {
  const prolificInfo = {
    ...info,
    data: { ...info.data, stat: { creator_created_count: 1_059, creator_hold_rate: 0.05 } }
  };
  const result = await new LazySafetyRuntime(
    config,
    api({ createdTokens: { data: { open_ratio: 0.011 } } }) as never
  ).evaluate('0xtoken', prolificInfo);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.creatorHistory, {
    createdTokens: 1_059,
    openRatio: 0.011,
    risk: 'elevated',
    qualityLevel: 0.5
  });
});

void test('does not penalize token count alone when the creator open ratio is healthy', async () => {
  const prolificInfo = {
    ...info,
    data: { ...info.data, stat: { creator_created_count: 1_059, creator_hold_rate: 0.05 } }
  };
  const result = await new LazySafetyRuntime(
    config,
    api({ createdTokens: { data: { open_ratio: 0.5 } } }) as never
  ).evaluate('0xtoken', prolificInfo);
  assert.equal(result.creatorHistory?.risk, 'healthy');
  assert.equal(result.creatorHistory?.qualityLevel, 1);
});

void test('checks the trader cache before spending a second API request', async () => {
  let now = 1000;
  let calls = 0;
  const source = api();
  const runtime = new LazySafetyRuntime(
    config,
    {
      ...source,
      traders: () => {
        calls++;
        return source.traders();
      }
    } as never,
    () => now
  );
  await runtime.evaluate('0xtoken', info);
  now += 1000;
  await runtime.evaluate('0xtoken', info);
  assert.equal(calls, 1);
  now += 10000;
  await runtime.evaluate('0xtoken', info);
  assert.equal(calls, 2);
});

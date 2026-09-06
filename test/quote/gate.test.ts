import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decidePositions,
  evaluateTier,
  finalFreshnessDecision,
  quoteAllowsDelivery,
  quoteLegFromGmgn,
  quoteConfiguredPositions,
  shouldRetryQuote
} from '../../src/quote/gate.js';

const policy = (sizeUsd: number) => ({
  sizeUsd,
  maxOneWayLoss: sizeUsd === 10 ? 0.02 : sizeUsd === 50 ? 0.03 : 0.05,
  maxRoundTripLoss: sizeUsd === 10 ? 0.05 : sizeUsd === 50 ? 0.06 : 0.08,
  maxSlippage: 0.05
});

void test('quotes every configured buy position then sells its exact arbitrary-precision amount', async () => {
  const sellAmounts: string[] = [];
  const quoted = await quoteConfiguredPositions(
    {
      buy: (sizeUsd) =>
        Promise.resolve({
          inputUsd: String(sizeUsd),
          outputUsd: String(sizeUsd),
          outputTokenAmount: `${sizeUsd}.123456789012345678901`,
          configuredSlippagePercent: '1',
          routeAvailable: true,
          direction: 'buy',
          costSemanticsVersion: 'gmgn-bsc-quote-2026-09-03-v1'
        }),
      sell: (tokenAmount) => {
        sellAmounts.push(tokenAmount);
        return Promise.resolve({
          inputUsd: '1',
          outputUsd: '1',
          configuredSlippagePercent: '1',
          routeAvailable: true,
          direction: 'sell',
          costSemanticsVersion: 'gmgn-bsc-quote-2026-09-03-v1'
        });
      }
    },
    [10, 50, 100]
  );
  assert.deepEqual(
    quoted.map((entry) => entry.sizeUsd),
    [10, 50, 100]
  );
  assert.deepEqual(sellAmounts, [
    '10.123456789012345678901',
    '50.123456789012345678901',
    '100.123456789012345678901'
  ]);
});

void test('retries a sellable cost failure only after a material change and configured interval', () => {
  const policy = {
    minimumIntervalMs: 30_000,
    materialPriceChange: 0.05,
    materialLiquidityChange: 0.1
  };
  assert.equal(shouldRetryQuote(null, 0, null, { priceUsd: 1, liquidityUsd: 100 }, policy), true);
  assert.equal(
    shouldRetryQuote(
      0,
      29_999,
      { priceUsd: 1, liquidityUsd: 100 },
      { priceUsd: 1.2, liquidityUsd: 100 },
      policy
    ),
    false
  );
  assert.equal(
    shouldRetryQuote(
      0,
      30_000,
      { priceUsd: 1, liquidityUsd: 100 },
      { priceUsd: 1.05, liquidityUsd: 100 },
      policy
    ),
    true
  );
});

void test('requires fresh Security, Pool and Quote data immediately before delivery', () => {
  const base = {
    nowMs: 100_000,
    securityAtMs: 70_000,
    poolAtMs: 70_000,
    quoteAtMs: 95_000,
    triggerAtMs: 99_000,
    securityPoolMaxAgeMs: 30_000,
    quoteMaxAgeMs: 5_000,
    decisiveWindowMs: 90_000
  };
  assert.equal(finalFreshnessDecision(base), 'fresh');
  assert.equal(finalFreshnessDecision({ ...base, quoteAtMs: 94_999 }), 'refresh_quote');
  assert.equal(finalFreshnessDecision({ ...base, poolAtMs: 69_999 }), 'refresh_security_pool');
  assert.equal(finalFreshnessDecision({ ...base, triggerAtMs: 9_999 }), 'stale_trigger');
});

void test('never allows a rejected Quote to reach the delivery Outbox', () => {
  const accepted = {
    accepted: true,
    finalSafetyAllowed: true,
    finalFreshness: 'fresh' as const,
    observationAdmissionRejected: false
  };
  assert.equal(quoteAllowsDelivery(accepted), true);
  assert.equal(quoteAllowsDelivery({ ...accepted, accepted: false }), false);
  assert.equal(quoteAllowsDelivery({ ...accepted, finalSafetyAllowed: false }), false);
  assert.equal(quoteAllowsDelivery({ ...accepted, finalFreshness: 'stale_trigger' }), false);
  assert.equal(quoteAllowsDelivery({ ...accepted, observationAdmissionRejected: true }), false);
});
const leg = (
  outputUsd: string,
  routeAvailable = true,
  direction: 'buy' | 'sell' = 'buy',
  inputUsd = '10'
) => ({
  direction,
  inputUsd,
  outputUsd,
  configuredSlippagePercent: '1',
  routeAvailable,
  costSemanticsVersion: 'gmgn-bsc-quote-2026-09-03-v1' as const
});

void test('accepts a 10U route and independently calculates maximum safe position', () => {
  const ten = evaluateTier(leg('9.9'), leg('9.75', true, 'sell', '9.9'), policy(10));
  const fifty = {
    ...evaluateTier(leg('9.8'), leg('9.51', true, 'sell', '9.8'), policy(50)),
    sizeUsd: 50
  };
  const hundred = {
    ...evaluateTier(leg('9.8'), leg('9.4', true, 'sell', '9.8'), policy(100)),
    sizeUsd: 100
  };
  assert.deepEqual(decidePositions([ten, fifty, hundred]), {
    accepted: true,
    maxSafePosition: 100,
    temporaryCostFailure: false
  });
});

void test('requires 10U while independently retaining the largest larger tier within its boundary', () => {
  const ten = evaluateTier(leg('9.9'), leg('9.75', true, 'sell', '9.9'), policy(10));
  const fifty = {
    ...evaluateTier(leg('9.8'), leg('9.51', true, 'sell', '9.8'), policy(50)),
    sizeUsd: 50
  };
  const hundred = {
    ...evaluateTier(leg('9.8'), leg('9.1', true, 'sell', '9.8'), policy(100)),
    sizeUsd: 100
  };
  assert.equal(
    evaluateTier(leg('9.8'), leg('9.5', true, 'sell', '9.8'), policy(10)).roundTripLoss.toString(),
    '0.05'
  );
  assert.deepEqual(decidePositions([ten, fifty, hundred]), {
    accepted: true,
    maxSafePosition: 50,
    temporaryCostFailure: false
  });
  assert.deepEqual(decidePositions([{ ...ten, passes: false }]), {
    accepted: false,
    maxSafePosition: null,
    temporaryCostFailure: true
  });
});

void test('rejects unsellable routes and keeps temporary cost failure observable', () => {
  const routeFailure = evaluateTier(leg('9.9'), leg('0', false, 'sell'), policy(10));
  assert.deepEqual(decidePositions([routeFailure]), {
    accepted: false,
    maxSafePosition: null,
    temporaryCostFailure: false
  });
  const tooCostly = evaluateTier(leg('9.7'), leg('9.3', true, 'sell', '9.7'), policy(10));
  assert.deepEqual(decidePositions([tooCostly]), {
    accepted: false,
    maxSafePosition: null,
    temporaryCostFailure: true
  });
  const tenPasses = evaluateTier(leg('9.9'), leg('9.6', true, 'sell'), policy(10));
  const largeRouteFails = {
    ...evaluateTier(leg('9.9'), leg('0', false, 'sell'), policy(50)),
    sizeUsd: 50
  };
  assert.deepEqual(decidePositions([tenPasses, largeRouteFails]), {
    accepted: false,
    maxSafePosition: null,
    temporaryCostFailure: false
  });
});

void test('uses GMGN USD fields once, validates directions, and treats requested slippage as a percent', () => {
  const buy = quoteLegFromGmgn(
    {
      inputUsd: '10',
      outputUsd: '9.9',
      outputTokenAmount: '100',
      routeAvailable: true,
      configuredSlippagePercent: '5',
      gasLimit: null,
      costSemanticsVersion: 'gmgn-bsc-quote-2026-09-03-v1'
    },
    'buy'
  );
  const sell = quoteLegFromGmgn(
    {
      inputUsd: '9.9',
      outputUsd: '9.6',
      outputTokenAmount: '0',
      routeAvailable: true,
      configuredSlippagePercent: '5',
      gasLimit: null,
      costSemanticsVersion: 'gmgn-bsc-quote-2026-09-03-v1'
    },
    'sell'
  );
  const decision = evaluateTier(buy, sell, policy(10));
  assert.equal(decision.buyOneWayLoss.toString(), '0.01');
  assert.equal(decision.sellOneWayLoss.toString(), '0.03030303030303030303');
  assert.equal(decision.roundTripLoss.toString(), '0.04');
  assert.equal(decision.requestedSlippage.toString(), '0.05');
  assert.equal(decision.passes, false);
  assert.equal(decision.reason, 'cost_or_requested_slippage_limit');
  assert.equal(
    evaluateTier({ ...buy, direction: 'sell' }, sell, policy(10)).reason,
    'invalid_route_direction'
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeConfig } from '../../src/config/types.js';
import { freshQuoteCapacity, QuoteGateRuntime } from '../../src/quote/runtime.js';

const config = {
  gmgn: { quote_wallet: '0x0000000000000000000000000000000000000001' },
  quote: {
    position_usd: [10, 50, 100],
    max_slippage_percent: 0.05,
    max_one_way_loss: { '10': 0.02, '50': 0.03, '100': 0.05 },
    max_round_trip_loss: { '10': 0.05, '50': 0.06, '100': 0.08 },
    retry_minimum_seconds: 30,
    material_price_change_percent: 0.05,
    material_liquidity_change_percent: 0.1
  }
} as unknown as RuntimeConfig;

void test('optional capacity ages out during preparation even while the mandatory quote stays fresh', () => {
  const quote = {
    accepted: true,
    quotedAtMs: 4000,
    decisions: [
      { sizeUsd: 10, passes: true },
      { sizeUsd: 100, passes: true }
    ],
    tierTimings: [
      { sizeUsd: 10, requestedAtMs: 4000 },
      { sizeUsd: 100, requestedAtMs: 1000 }
    ]
  };
  assert.equal(freshQuoteCapacity(quote, 5000, 5000), 100);
  assert.equal(freshQuoteCapacity(quote, 6001, 5000), 10);
  assert.equal(freshQuoteCapacity(quote, 9001, 5000), null);
  assert.equal(
    freshQuoteCapacity({ accepted: true, quotedAtMs: 4000, maxSafePosition: 100 }, 5000, 5000),
    10
  );
});

void test('slow full gates retain fresh 10U timing, and a recent full approval needs only two final requests', async () => {
  let now = 0;
  const requests: Array<Record<string, unknown>> = [];
  let failed = false;
  const runtime = new QuoteGateRuntime(
    config,
    {
      gas: () => Promise.resolve({ data: { native_token_usd_price: '300' } }),
      quote: (request: Record<string, unknown>) => {
        requests.push(request);
        now += 1500;
        return Promise.resolve({
          code: 0,
          data: {
            output_amount: '123',
            slippage: 2,
            tx: { amount_in_usd: '10', amount_out_usd: failed ? '8.5' : '9.9', gas_limit: '21000' }
          }
        });
      }
    } as never,
    () => now
  );
  const full = await runtime.evaluate('0xtoken');
  assert.equal(full.accepted, true);
  assert.equal(now - full.quotedAtMs, 3000);
  assert.equal(
    full.maxSafePosition,
    10,
    'older optional capacity must not be presented as current'
  );
  const refreshed = await runtime.evaluate('0xtoken', undefined, { force: true });
  assert.equal(refreshed.accepted, true);
  assert.equal(refreshed.decisions.length, 1);
  assert.equal(requests.length, 8);
  failed = true;
  const rejected = await runtime.evaluate('0xtoken', undefined, { force: true });
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.maxSafePosition, null);
  failed = false;
  const recovered = await runtime.evaluate('0xtoken', undefined, { force: true });
  assert.equal(recovered.decisions.length, 3, 'failed refresh requires full validation again');
  now += 30_001;
  assert.equal((await runtime.evaluate('0xtoken', undefined, { force: true })).decisions.length, 3);
});

void test('fresh 10U does not bypass a failed large-tier route, including forced revalidation', async () => {
  let calls = 0;
  const runtime = new QuoteGateRuntime(
    config,
    {
      gas: () => Promise.resolve({ data: { native_token_usd_price: '300' } }),
      quote: () => {
        const largeSell = calls++ % 6 === 1;
        return Promise.resolve({
          code: 0,
          data: {
            output_amount: largeSell ? '0' : '123',
            slippage: 2,
            tx: { amount_in_usd: '10', amount_out_usd: largeSell ? '0' : '9.9', gas_limit: '21000' }
          }
        });
      }
    } as never,
    () => 0
  );
  const initial = await runtime.evaluate('0xtoken');
  assert.equal(initial.accepted, false);
  assert.equal(initial.maxSafePosition, null);
  const forced = await runtime.evaluate('0xtoken', undefined, { force: true });
  assert.equal(forced.accepted, false);
  assert.equal(calls, 12);
});

void test('runs all three buy and matching sell Quotes before accepting a formal candidate', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const runtime = new QuoteGateRuntime(
    config,
    {
      gas: () => Promise.resolve({ data: { native_token_usd_price: '300' } }),
      quote: (request: Record<string, unknown>) => {
        requests.push(request);
        const sell = request.inputToken === '0xtoken';
        const inputUsd = sell ? 10 : 10;
        return Promise.resolve({
          code: 0,
          data: {
            output_amount: sell ? '1000000000000000' : '123',
            slippage: 2,
            tx: { amount_in_usd: String(inputUsd), amount_out_usd: '9.9', gas_limit: '21000' }
          }
        });
      }
    } as never,
    () => 123
  );
  const result = await runtime.evaluate('0xtoken');
  assert.equal(result.accepted, true);
  assert.equal(result.maxSafePosition, 100);
  assert.equal(result.decisions.length, 3);
  assert.equal(requests.length, 6);
  assert.equal(requests.filter((request) => request.inputToken === '0xtoken').length, 3);
});

void test('retries a temporary cost failure only after interval and material market movement', async () => {
  let now = 0;
  let calls = 0;
  const runtime = new QuoteGateRuntime(
    config,
    {
      gas: () => Promise.resolve({ data: { native_token_usd_price: '300' } }),
      quote: (request: Record<string, unknown>) => {
        calls += 1;
        const sell = request.inputToken === '0xtoken';
        return Promise.resolve({
          code: 0,
          data: {
            output_amount: sell ? '1000000000000000' : '123',
            slippage: 2,
            tx: { amount_in_usd: '10', amount_out_usd: '8.5', gas_limit: '21000' }
          }
        });
      }
    } as never,
    () => now
  );
  assert.equal(
    (await runtime.evaluate('0xtoken', { priceUsd: 1, liquidityUsd: 100 })).temporaryCostFailure,
    true
  );
  assert.equal(calls, 6);
  now = 31_000;
  await runtime.evaluate('0xtoken', { priceUsd: 1.02, liquidityUsd: 100 });
  assert.equal(calls, 6);
  await runtime.evaluate('0xtoken', { priceUsd: 1.06, liquidityUsd: 100 });
  assert.equal(calls, 12);
});

void test('forces a final freshness quote recheck despite a temporary-failure retry backoff', async () => {
  let calls = 0;
  const runtime = new QuoteGateRuntime(
    config,
    {
      gas: () => Promise.resolve({ data: { native_token_usd_price: '300' } }),
      quote: (request: Record<string, unknown>) => {
        calls += 1;
        const sell = request.inputToken === '0xtoken';
        return Promise.resolve({
          code: 0,
          data: {
            output_amount: sell ? '1000000000000000' : '123',
            slippage: 2,
            tx: { amount_in_usd: '10', amount_out_usd: '8.5', gas_limit: '21000' }
          }
        });
      }
    } as never,
    () => 0
  );
  await runtime.evaluate('0xtoken', { priceUsd: 1, liquidityUsd: 100 });
  await runtime.evaluate('0xtoken', { priceUsd: 1, liquidityUsd: 100 }, { force: true });
  assert.equal(calls, 12);
});

void test('uses the oldest mandatory 10U leg without rejuvenating it at completion', async () => {
  let now = 100;
  const runtime = new QuoteGateRuntime(
    config,
    {
      gas: () => Promise.resolve({ data: { native_token_usd_price: '300' } }),
      quote: (request: Record<string, unknown>) => {
        now += 150;
        const sell = request.inputToken === '0xtoken';
        return Promise.resolve({
          code: 0,
          data: {
            output_amount: sell ? '1000000000000000' : '123',
            slippage: 2,
            tx: { amount_in_usd: '10', amount_out_usd: '9.9', gas_limit: '21000' }
          }
        });
      }
    } as never,
    () => now
  );
  assert.equal((await runtime.evaluate('0xtoken')).quotedAtMs, 700);
});

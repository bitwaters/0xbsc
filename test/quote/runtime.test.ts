import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeConfig } from '../../src/config/types.js';
import { QuoteGateRuntime } from '../../src/quote/runtime.js';

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

void test('does not rejuvenate the oldest quote leg when the group finishes', async () => {
  let now = 100;
  const runtime = new QuoteGateRuntime(
    config,
    {
      gas: () => Promise.resolve({ data: { native_token_usd_price: '300' } }),
      quote: (request: Record<string, unknown>) => {
        now = 250;
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
  assert.equal((await runtime.evaluate('0xtoken')).quotedAtMs, 100);
});

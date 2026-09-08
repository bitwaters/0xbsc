import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { runtimeConfigSchema } from '../../src/config/load.js';
import { createMarketFact } from '../../src/gmgn/facts.js';
import { validateModel } from '../../src/decision/model.js';
import { watchingState, evaluateOpportunity } from '../../src/decision/opportunity.js';
import { prepareDryOpportunity, type RiskBundle } from '../../src/decision/preparation.js';
import type { QuoteObservation } from '../../src/research/measurement.js';
const token = '0x' + 'a'.repeat(40),
  pool = '0x' + 'b'.repeat(40),
  creator = '0x' + 'c'.repeat(40);
const config = runtimeConfigSchema.parse(parse(readFileSync('config.example.yaml', 'utf8')));
const model = validateModel({
  version: 1,
  id: 'fixture',
  fields: { price: { source: 'info.price.price', ttl_ms: 10000, require_source_time: false } },
  parameters: {},
  price_field: 'price',
  activation: { constant: true },
  confirmation: { constant: true },
  invalidation: { constant: false },
  reset: { constant: true },
  entry: { op: 'gt', args: [{ field: 'price' }, { constant: 1 }] },
  max_opportunity_ms: 60000
});
function bundle(at = 20000): RiskBundle {
  const fact = (path: string, data: unknown) =>
    createMarketFact({
      poolRevision: pool,
      request: {
        method: 'GET',
        path,
        query: path.includes('created') ? { wallet_address: creator } : { address: token }
      },
      response: { data },
      attemptId: path + at,
      requestedAtMs: at - 100,
      queuedAtMs: at - 100,
      receivedAtMs: at,
      purpose: 'shadow_execution'
    });
  const info = fact('/v1/token/info', {
    biggest_pool_address: pool,
    liquidity: 100000,
    price: { price: '1.3' },
    dev: { creator_address: creator },
    stat: {
      dev_team_hold_rate: 0,
      top_entrapment_trader_percentage: 0,
      top_bundler_trader_percentage: 0,
      top70_sniper_hold_rate: 0,
      creator_hold_rate: 0.01,
      creator_created_count: 2
    }
  });
  return {
    token,
    poolRevision: pool,
    facts: [info],
    info,
    security: fact('/v1/token/security', {
      buy_tax: 0,
      sell_tax: 0,
      top_10_holder_rate: 0.01,
      can_not_sell: false,
      is_renounced: true,
      renounced_mint: true,
      lock_summary: { lock_percent: 1 }
    }),
    pool: fact('/v1/token/pool_info', { address: pool }),
    holders: fact('/v1/market/token_top_holders', {
      list: [{ address: creator, amount_percentage: 0.01, is_suspicious: false }]
    }),
    traders: fact('/v1/market/token_top_traders', { list: [] }),
    created: fact('/v1/user/created_tokens', { open_ratio: 0.9 })
  };
}
const buy: QuoteObservation = {
  factId: 'buy',
  chain: 'bsc',
  token,
  poolRevision: pool,
  wallet: config.gmgn.quote_wallet,
  inputAsset: 'usd',
  outputAsset: token,
  direction: 'buy',
  inputAmount: '10000000',
  outputAmount: '7',
  inputUsd: '10',
  outputUsd: '9.99',
  slippage: '1',
  semantics: 'gmgn-bsc-quote-2026-09-03-v1',
  requestedAtMs: 20100,
  receivedAtMs: 20200
};
const sell: QuoteObservation = {
  ...buy,
  factId: 'sell',
  direction: 'sell',
  inputAsset: token,
  outputAsset: 'usd',
  inputAmount: '7',
  outputAmount: '9900000',
  inputUsd: '9.99',
  outputUsd: '9.9',
  requestedAtMs: 20300,
  receivedAtMs: 20400
};
async function run(
  change?: (b: RiskBundle) => void,
  quote: QuoteObservation = sell,
  initialChange?: (b: RiskBundle) => void
) {
  const initial = bundle();
  const state = evaluateOpportunity(
    watchingState(token, pool, model.hash),
    {
      model: model.manifest,
      facts: [initial.info],
      evaluationAtMs: 20000,
      token,
      poolRevision: pool
    },
    model.hash
  ).state;
  let calls = 0,
    buyCalls = 0;
  const result = await prepareDryOpportunity({
    config,
    manifest: model.manifest,
    state,
    now: () => 20500,
    adapter: {
      capture: () => {
        const b = bundle(++calls === 1 ? 20000 : 20500);
        if (calls === 2) change?.(b);
        if (calls === 1) initialChange?.(b);
        return Promise.resolve(b);
      },
      buy: () => {
        buyCalls++;
        return Promise.resolve(buy);
      },
      sell: () => Promise.resolve(quote)
    }
  });
  return { result, state, buyCalls };
}
void test('complete preparation applies frozen safety and actual quote cost before frozen dry card', async () => {
  const { result, state } = await run();
  assert.equal(result.status, 'DRY_READY');
  const snapshot = JSON.parse(result.outbox) as {
    sendEnabled: boolean;
    context: { opportunityId: string };
    preparation: { roundTripLoss: string };
  };
  assert.equal(snapshot.sendEnabled, false);
  assert.equal(snapshot.context.opportunityId, state.opportunityId);
  assert.equal(snapshot.preparation.roundTripLoss, '0.01');
});
void test('final risk, pool, market and matched-quantity failures cancel the same opportunity', async () => {
  const cases: ((b: RiskBundle) => void)[] = [
    (b) => {
      b.poolRevision = 'different';
    },
    (b) => {
      b.security.payload.buy_tax = 1;
    },
    (b) => {
      b.info.payload.price = { price: '0.5' };
    },
    (b) => {
      b.traders.payload.list = [{ address: creator, tags: ['smart_money'] }];
    },
    (b) => {
      b.created.request.wallet_address = token;
    }
  ];
  for (const change of cases) {
    const { result, state } = await run(change);
    assert.equal(result.status, 'CANCELLED');
    assert.equal(result.state.opportunityId, state.opportunityId);
    assert.equal(result.state.anchorPrice, state.anchorPrice);
  }
  assert.equal((await run(undefined, { ...sell, inputAmount: '6' })).result.status, 'CANCELLED');
  assert.equal((await run(undefined, { ...sell, outputUsd: '1' })).result.status, 'CANCELLED');
});

void test('unsafe initial candidates never become qualified or request quotes; later preparation failures retain qualification', async () => {
  const unsafe = await run(undefined, sell, (b) => {
    b.security.payload.buy_tax = 1;
  });
  assert.equal(unsafe.result.status, 'CANCELLED');
  assert.equal(unsafe.result.qualification, null);
  assert.equal(unsafe.buyCalls, 0);
  const failed = await run(undefined, { ...sell, outputUsd: '1' });
  assert.equal(failed.result.status, 'CANCELLED');
  assert.ok(failed.result.qualification);
  assert.equal(failed.buyCalls, 1);
});

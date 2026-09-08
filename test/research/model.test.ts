import assert from 'node:assert/strict';
import test from 'node:test';
import { validateModel, evaluateExpression } from '../../src/decision/model.js';
import { evaluateOpportunity, watchingState } from '../../src/decision/opportunity.js';
import { createMarketFact } from '../../src/gmgn/facts.js';
const token = '0x' + 'a'.repeat(40),
  pool = '0x' + 'b'.repeat(40);
const definition = {
  version: 1,
  id: 'test_only',
  fields: { price: { source: 'info.price.price', ttl_ms: 10000, require_source_time: false } },
  parameters: { start: 1.2 },
  price_field: 'price',
  activation: { op: 'gt', args: [{ field: 'price' }, { parameter: 'start' }] },
  confirmation: { constant: true },
  invalidation: { constant: false },
  reset: { op: 'lt', args: [{ field: 'price' }, { constant: 1 }] },
  entry: { constant: true },
  max_opportunity_ms: 10000
};
const fact = (price: string, time: number) =>
  createMarketFact({
    request: { method: 'GET', path: '/v1/token/info', query: { address: token } },
    response: { data: { price: { price }, liquidity: '100', biggest_pool_address: pool } },
    purpose: 'legacy_formal',
    attemptId: String(time),
    queuedAtMs: time - 1,
    requestedAtMs: time - 1,
    receivedAtMs: time
  });
void test('complete manifests reject omissions, arbitrary code and unsupported source clocks', () => {
  assert.throws(
    () => validateModel({ ...definition, reset: undefined }),
    /MODEL_EXPRESSION_INVALID/
  );
  assert.throws(() =>
    validateModel({ ...definition, entry: { op: 'eval', args: ['process.exit()'] } })
  );
  assert.throws(
    () =>
      validateModel({
        ...definition,
        fields: { price: { source: 'unique_new_buyers', ttl_ms: 1000, require_source_time: false } }
      }),
    /UNSUPPORTED_FEATURE/
  );
  assert.throws(
    () =>
      validateModel({
        ...definition,
        fields: { price: { source: 'info.price.price', ttl_ms: 1000, require_source_time: true } }
      }),
    /SOURCE_TIME_UNVERIFIED/
  );
});
void test('opportunity anchors stay fixed across replay, cached input, refresh and expiry', () => {
  const { manifest, hash } = validateModel(definition);
  const f = fact('1.3', 1000),
    input = { model: manifest, facts: [f], evaluationAtMs: 1000, token, poolRevision: pool };
  const initial = watchingState(token, pool, hash);
  const ready = evaluateOpportunity(initial, input, hash);
  assert.equal(ready.state.status, 'READY');
  assert.equal(ready.state.anchorPrice, '1.3');
  assert.deepEqual(evaluateOpportunity(initial, input, hash), ready);
  assert.equal(
    evaluateOpportunity(ready.state, { ...input, evaluationAtMs: 2000 }, hash).reason,
    'NO_NEW_FACT'
  );
  const refresh = evaluateOpportunity(
    ready.state,
    { ...input, facts: [f, fact('1.5', 2000)], evaluationAtMs: 2000 },
    hash
  );
  assert.equal(refresh.state.anchorPrice, '1.3');
  assert.equal(refresh.state.opportunityId, ready.state.opportunityId);
  const expired = evaluateOpportunity(refresh.state, { ...input, evaluationAtMs: 11000 }, hash);
  assert.equal(expired.state.status, 'MISSED');
  assert.equal(expired.state.anchorAtMs, 1000);
  const restarted = evaluateOpportunity(
    expired.state,
    { ...input, facts: [fact('1.7', 12000)], evaluationAtMs: 12000 },
    hash
  );
  assert.equal(restarted.reason, 'RESET_REQUIRED');
  const reset = evaluateOpportunity(
    restarted.state,
    { ...input, facts: [fact('0.9', 13000)], evaluationAtMs: 13000 },
    hash
  );
  assert.equal(reset.reason, 'RESET_OBSERVED');
  const again = evaluateOpportunity(
    reset.state,
    { ...input, facts: [fact('1.4', 14000)], evaluationAtMs: 14000 },
    hash
  );
  assert.notEqual(again.state.opportunityId, ready.state.opportunityId);
});
void test('future responses and missing fields remain UNKNOWN and never become free confirmations', () => {
  const { manifest, hash } = validateModel(definition);
  const input = {
    model: manifest,
    facts: [fact('2', 2000)],
    evaluationAtMs: 1000,
    token,
    poolRevision: pool
  };
  assert.equal(
    evaluateOpportunity(watchingState(token, pool, hash), input, hash).reason,
    'DATA_WAIT'
  );
  assert.equal(
    evaluateExpression({ op: 'div', args: [{ constant: 1 }, { constant: 0 }] }, input),
    null
  );
});

void test('pool migration invalidates the old opportunity without adopting a new anchor', () => {
  const { manifest, hash } = validateModel(definition),
    f = fact('1.3', 1000);
  const input = { model: manifest, facts: [f], evaluationAtMs: 1000, token, poolRevision: pool };
  const ready = evaluateOpportunity(watchingState(token, pool, hash), input, hash);
  const migrated = evaluateOpportunity(
    ready.state,
    { ...input, poolRevision: 'new-pool', evaluationAtMs: 2000 },
    hash
  );
  assert.equal(migrated.state.status, 'INVALIDATED');
  assert.equal(migrated.state.anchorPrice, '1.3');
  assert.equal(migrated.state.poolRevision, pool);
});

void test('elapsed windows can invalidate READY even with the same cached price fact', () => {
  const { manifest, hash } = validateModel({
    ...definition,
    entry: {
      op: 'lt',
      args: [
        { window: { field: 'price', ms: 1500, aggregate: 'min', min_samples: 1 } },
        { constant: 1 }
      ]
    }
  });
  const facts = [fact('0.5', 800), fact('1.3', 1000)];
  const input = { model: manifest, facts, evaluationAtMs: 1000, token, poolRevision: pool };
  const ready = evaluateOpportunity(watchingState(token, pool, hash), input, hash);
  assert.equal(ready.state.status, 'READY');
  const invalid = evaluateOpportunity(ready.state, { ...input, evaluationAtMs: 2400 }, hash);
  assert.equal(invalid.state.status, 'INVALIDATED');
  assert.equal(invalid.reason, 'CACHED_MARKET_INVALIDATED');
});

void test('dry publisher freezes entry context and preparation failure cannot create another route', async () => {
  const { dryPublish } = await import('../../src/decision/dry-publisher.js');
  const { manifest, hash } = validateModel(definition);
  const f = fact('1.3', 1000);
  const state = evaluateOpportunity(
    watchingState(token, pool, hash),
    { model: manifest, facts: [f], evaluationAtMs: 1000, token, poolRevision: pool },
    hash
  ).state;
  const result = await dryPublish({
    manifest,
    state,
    riskHash: 'a'.repeat(64),
    now: () => 1500,
    prepare: () =>
      Promise.resolve({
        status: 'PASS',
        riskHash: 'a'.repeat(64),
        checkedAtMs: 1400,
        latestFacts: [f],
        reason: 'fixture',
        buyUsd: '10',
        sellUsd: '9.9',
        tokenQuantity: '7',
        quoteReceivedAtMs: 1400
      })
  });
  assert.equal(result.status, 'DRY_READY');
  assert.equal(typeof result.outbox, 'string');
  assert.equal((JSON.parse(result.outbox) as { sendEnabled: boolean }).sendEnabled, false);
  const failed = await dryPublish({
    manifest,
    state,
    riskHash: 'a'.repeat(64),
    now: () => 1500,
    prepare: () => Promise.reject(new Error('source unavailable'))
  });
  assert.equal(failed.status, 'CANCELLED');
  assert.equal(failed.context.opportunityId, state.opportunityId);
  assert.equal(failed.state.anchorPrice, state.anchorPrice);
});

void test('a refreshed READY price cannot move the original entry anchor', () => {
  const model = validateModel({ ...definition, max_entry_anchor_multiple: 1.08 });
  const first = fact('1.3', 1000);
  const state = evaluateOpportunity(
    watchingState(token, pool, model.hash),
    { model: model.manifest, token, poolRevision: pool, facts: [first], evaluationAtMs: 1000 },
    model.hash
  ).state;
  assert.equal(state.status, 'READY');
  const next = evaluateOpportunity(
    state,
    {
      model: model.manifest,
      token,
      poolRevision: pool,
      facts: [first, fact('1.5', 2000)],
      evaluationAtMs: 2000
    },
    model.hash
  );
  assert.equal(next.reason, 'ANCHOR_ENTRY_EXCEEDED');
  assert.equal(next.state.status, 'INVALIDATED');
  assert.equal(next.state.anchorPrice, '1.3');
});

void test('first activation fixes the anchor before the confirmation window has enough samples', () => {
  const model = validateModel({
    ...definition,
    max_entry_anchor_multiple: 1.08,
    confirmation: {
      op: 'gte',
      args: [
        { field: 'price' },
        { window: { field: 'price', ms: 30000, aggregate: 'mean', min_samples: 2 } }
      ]
    }
  });
  const first = fact('1.3', 1000);
  const input = {
    model: model.manifest,
    token,
    poolRevision: pool,
    facts: [first],
    evaluationAtMs: 1000
  };
  const started = evaluateOpportunity(watchingState(token, pool, model.hash), input, model.hash);
  assert.equal(started.reason, 'DATA_WAIT');
  assert.equal(started.state.status, 'START_CANDIDATE');
  assert.equal(started.state.anchorPrice, '1.3');
  assert.equal(started.state.anchorAtMs, 1000);
  assert.equal(evaluateOpportunity(started.state, input, model.hash).reason, 'DATA_WAIT');
  const tooLate = evaluateOpportunity(
    started.state,
    { ...input, facts: [first, fact('1.5', 2000)], evaluationAtMs: 2000 },
    model.hash
  );
  assert.equal(tooLate.reason, 'ANCHOR_ENTRY_EXCEEDED');
  assert.equal(tooLate.state.anchorPrice, '1.3');
  assert.equal(tooLate.state.anchorAtMs, 1000);
});

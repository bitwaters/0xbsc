import assert from 'node:assert/strict';
import test from 'node:test';
import { GmgnClient, responseFact, responseTiming } from '../../src/gmgn/client.js';
import { createMarketFact, independentConfirmation, knownRatio } from '../../src/gmgn/facts.js';
import type { MarketFact } from '../../src/gmgn/facts.js';
import { withGmgnContext } from '../../src/gmgn/context.js';
import { GmgnApi } from '../../src/gmgn/api.js';
const request = {
  method: 'GET' as const,
  path: '/v1/token/info',
  query: { address: '0x' + 'a'.repeat(40) }
};
const times = {
  attemptId: 'a',
  queuedAtMs: 100,
  requestedAtMs: 200,
  receivedAtMs: 300,
  purpose: 'legacy_formal' as const
};

void test('source timestamps cannot be manufactured from creation or HTTP time, and credentials are allowlisted out', () => {
  const fact = createMarketFact({
    request,
    response: {
      data: {
        price: { price: '1', volume_1m: '-1', source_at: 290 },
        liquidity: '10',
        creation_timestamp: 290,
        api_key: 'SECRET',
        tx: { private_key: 'SECRET' }
      }
    },
    ...times
  });
  assert.equal(fact.sourceAtMs, null);
  assert.equal(fact.sourceTimeStatus, 'UNKNOWN');
  assert.equal(JSON.stringify(fact).includes('SECRET'), false);
  assert.ok(fact.qualityFlags.includes('INVALID_NUMBER:volume_1m'));
  assert.equal(knownRatio('1', '0'), null);
  assert.equal(knownRatio(true, '1'), null);
  assert.equal(knownRatio('1', '4'), '0.25');
  assert.equal(
    independentConfirmation(fact, { ...fact, factId: 'different', receivedAtMs: 400 }),
    false
  );
});
void test('each successful physical response carries original attempt time and purpose, cache reads do not create facts', async () => {
  let now = 1000;
  const captured: MarketFact[] = [];
  const client = new GmgnClient({
    baseUrl: 'https://example.invalid',
    apiKey: 'SECRET',
    now: () => now,
    transport: () => {
      now += 20;
      return Promise.resolve({
        status: 200,
        headers: {},
        body: { code: 0, data: { native_token_usd_price: '600', api_key: 'SECRET' } }
      });
    },
    onFact: (f) => captured.push(f)
  });
  const api = new GmgnApi(client, 5000, () => now);
  const first = await withGmgnContext({ purpose: 'baseline' }, () => api.gas());
  const second = await api.gas();
  assert.equal(first, second);
  assert.equal(captured.length, 1);
  assert.equal(responseFact(second)?.purpose, 'baseline');
  assert.deepEqual(responseTiming(first), { requestedAtMs: 1000, completedAtMs: 1020 });
  assert.equal(responseFact(first)?.requestedAtMs, 1000);
  assert.equal(responseFact(first)?.receivedAtMs, 1020);
});
void test('recording failure does not retry a successful request or change formal response', async () => {
  let attempts = 0,
    errors = 0;
  const client = new GmgnClient({
    baseUrl: 'https://example.invalid',
    apiKey: 'SECRET',
    transport: () => {
      attempts++;
      return Promise.resolve({
        status: 200,
        headers: {},
        body: { code: 0, data: { price: { price: '1' } } }
      });
    },
    onFact: () => {
      throw new Error('disk failure');
    },
    onFactError: () => {
      errors++;
    }
  });
  const result = await client.read(request);
  assert.deepEqual(result, { code: 0, data: { price: { price: '1' } } });
  assert.equal(attempts, 1);
  assert.equal(errors, 1);
});
void test('Kline time units, gaps and conflicting duplicate timestamps remain explicit', () => {
  const time = 1788800000000;
  const candle = { time, open: '1', high: '2', low: '0.5', close: '1', volume: '10' };
  const fact = createMarketFact({
    request: { method: 'GET', path: '/v1/market/token_kline', query: { resolution: '30s' } },
    response: {
      data: { list: [candle, { ...candle, high: '3' }, { ...candle, time: time + 60000 }] }
    },
    ...times,
    receivedAtMs: time + 90000
  });
  assert.ok(fact.qualityFlags.includes('CANDLE_GAP'));
  assert.ok(fact.qualityFlags.includes('CONFLICTING_CANDLE'));
});

void test('recorded Info schema has price values but no proven price-source clock', async () => {
  const { readFile } = await import('node:fs/promises');
  const recorded = JSON.parse(
    await readFile(new URL('../fixtures/research-contract-shapes.json', import.meta.url), 'utf8')
  ) as { kind: string; responses: { path: string; shape: Record<string, unknown> }[] };
  assert.equal(recorded.kind, 'recorded_shapes_not_raw_payloads');
  const info = recorded.responses.find((r) => r.path === '/v1/token/info');
  assert.ok(info);
  const price = info.shape.price as Record<string, unknown>;
  assert.equal(price.price, 'string');
  assert.equal(
    Object.keys(price).some((k) => /timestamp|updated_at|source_at/.test(k)),
    false
  );
});

void test('ancillary facts inherit only the pool known at physical dispatch and flag truncated lists', () => {
  const pool = '0x' + 'b'.repeat(40);
  const input = {
    request: {
      method: 'GET' as const,
      path: '/v1/market/token_kline',
      query: { address: '0x' + 'a'.repeat(40), resolution: '30s' }
    },
    poolRevision: pool,
    response: { data: { list: [] } },
    purpose: 'outcome' as const,
    attemptId: 'pool-bound',
    queuedAtMs: 1000,
    requestedAtMs: 1000,
    receivedAtMs: 2000
  };
  assert.equal(createMarketFact(input).poolRevision, pool);
  assert.equal(
    createMarketFact({
      ...input,
      response: { data: { list: Array.from({ length: 2001 }, () => ({})) } }
    }).qualityFlags.includes('ARRAY_TRUNCATED'),
    true
  );
});

void test('discovery facts normalize rank arrays, grouped hot tokens, signals and trenches before allowlisting', () => {
  const row = {
    address: '0x' + 'a'.repeat(40),
    signal_type: 1,
    timestamp: 1000,
    secret: 'must-not-record'
  };
  const cases = [
    { path: '/v1/market/rank', data: { rank: [row] } },
    { path: '/v1/market/hot_searches', data: [{ interval: '1m', tokens: [row] }] },
    { path: '/v1/market/token_signal', data: [row] },
    { path: '/v1/trenches', data: { new: [row], complete: [] } }
  ];
  for (const c of cases) {
    const f = createMarketFact({
      request: { method: 'GET', path: c.path },
      response: { code: 0, data: c.data },
      purpose: 'shared_collection',
      attemptId: c.path,
      queuedAtMs: 1000,
      requestedAtMs: 1000,
      receivedAtMs: 2000
    });
    assert.equal((f.payload.list as unknown[]).length, 1);
    assert.equal(f.qualityFlags.includes('UNSUPPORTED_PAYLOAD_SHAPE'), false);
    assert.doesNotMatch(JSON.stringify(f), /must-not-record/);
  }
});

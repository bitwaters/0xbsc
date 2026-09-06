import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { GmgnApi } from '../../src/gmgn/api.js';
import { GmgnClient, type RequestInput } from '../../src/gmgn/client.js';
import {
  endpointWeights,
  maximumRows,
  truncateRows,
  validateSignalTypes
} from '../../src/gmgn/limits.js';

void test('rejects GMGN production-rejected Signal types and oversized groups', () => {
  assert.throws(() => validateSignalTypes([14]), /14/);
  assert.throws(() => validateSignalTypes([15, 16]), /15, 16/);
  assert.doesNotThrow(() => validateSignalTypes([1, 21]));
});

void test('locally caps source rows at their verified limits', () => {
  assert.equal(truncateRows(Array.from({ length: 101 }), maximumRows.holders).length, 100);
  assert.equal(truncateRows(Array.from({ length: 60 }), maximumRows.trenches).length, 50);
});

void test('keeps the official Phase 1 endpoint-weight table in code and the only YAML source', () => {
  const official = {
    trending: 1,
    info: 1,
    security: 1,
    pool: 1,
    smartMoney: 1,
    kol: 1,
    gas: 1,
    kline: 2,
    quote: 2,
    createdTokens: 2,
    trenches: 3,
    hot: 3,
    marketSignal: 3,
    holders: 5,
    traders: 5
  };
  assert.deepEqual(endpointWeights, official);
  const example = parse(readFileSync('config.example.yaml', 'utf8')) as {
    gmgn: { endpoint_weights: Record<string, number> };
  };
  assert.deepEqual(example.gmgn.endpoint_weights, {
    trending: 1,
    info: 1,
    security: 1,
    pool: 1,
    smart_money: 1,
    kol: 1,
    gas: 1,
    kline: 2,
    quote: 2,
    created_tokens: 2,
    trenches: 3,
    hot: 3,
    market_signal: 3,
    holders: 5,
    traders: 5
  });
});

void test('caps every bounded adapter request and rejects a Signal group over 50 types', async () => {
  const requests: RequestInput[] = [];
  const api = new GmgnApi(
    new GmgnClient({
      baseUrl: 'https://example.invalid',
      apiKey: 'test-key',
      transport: (input) => {
        requests.push(input);
        return Promise.resolve({ status: 200, headers: {}, body: { code: 0, data: [] } });
      }
    })
  );
  assert.throws(
    () => api.signals([{ signalTypes: Array.from({ length: 51 }, (_, index) => index + 100) }]),
    /over 50 types/
  );
  await Promise.all([
    api.smartMoney(101),
    api.kol(101),
    api.holders('0xabc', 101),
    api.traders('0xabc', 101)
  ]);
  assert.deepEqual(
    requests.map((request) => request.query?.limit),
    [100, 100, 100, 100]
  );
});

void test('continues local accounting when a successful GMGN response has no quota headers', async () => {
  const client = new GmgnClient({
    baseUrl: 'https://example.invalid',
    apiKey: 'test-key',
    transport: () => Promise.resolve({ status: 200, headers: {}, body: { code: 0, data: [] } })
  });
  assert.deepEqual(await client.read({ method: 'GET', path: '/v1/market/rank' }), {
    code: 0,
    data: []
  });
  assert.equal(client.cooldownUntilMs, 0);
});

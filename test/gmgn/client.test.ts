import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GmgnClient,
  GmgnError,
  gmgnRetryDeadline,
  parseRateLimitReset
} from '../../src/gmgn/client.js';

void test('retries one read-only network failure and never exposes its API key', async () => {
  let calls = 0;
  const receivedHeaders: Array<Record<string, string>> = [];
  const observations: Array<{ kind: string; status: number | null; retryCount: number }> = [];
  const client = new GmgnClient({
    baseUrl: 'https://openapi.gmgn.ai',
    apiKey: 'private-key',
    transport: (input, headers) => {
      receivedHeaders.push(headers);
      assert.equal(typeof input.query?.timestamp, 'number');
      assert.match(String(input.query?.client_id ?? ''), /^[0-9a-f-]{36}$/);
      calls += 1;
      if (calls === 1) return Promise.reject(new Error('private-key connection failed'));
      return Promise.resolve({ status: 200, headers: {}, body: { ok: true } });
    },
    onObservation: (observation) =>
      observations.push({
        kind: observation.kind,
        status: observation.status,
        retryCount: observation.retryCount
      })
  });
  assert.deepEqual(await client.read({ method: 'GET', path: '/v1/market/token_info' }), {
    ok: true
  });
  assert.equal(calls, 2);
  assert.equal(receivedHeaders[0]?.['x-apikey'], 'private-key');
  assert.equal(receivedHeaders[0]?.authorization, undefined);
  assert.deepEqual(observations, [
    { kind: 'retry', status: null, retryCount: 0 },
    { kind: 'success', status: 200, retryCount: 1 }
  ]);
});

void test('honors a 429 reset cooldown without retrying', async () => {
  let now = 1_000;
  const client = new GmgnClient({
    baseUrl: 'https://openapi.gmgn.ai',
    apiKey: 'secret',
    now: () => now,
    transport: () =>
      Promise.resolve({ status: 429, headers: { 'x-ratelimit-reset': '5' }, body: {} })
  });
  await assert.rejects(
    client.read({ method: 'GET', path: '/x' }),
    (error: unknown) => error instanceof GmgnError && error.retryAtMs === 5_250
  );
  now = 2_000;
  await assert.rejects(client.read({ method: 'GET', path: '/x' }), /cooling down/);
  assert.equal(parseRateLimitReset(undefined, now), 32_000);
});

void test('uses the server rate-limit deadline with a safety margin for background retries', () => {
  assert.equal(
    gmgnRetryDeadline(new GmgnError('rate_limit', 'slow down', 429, 9_000), 1_000),
    9_250
  );
  assert.equal(gmgnRetryDeadline(new GmgnError('rate_limit', 'stale', 429, 500), 1_000), 2_000);
  assert.equal(gmgnRetryDeadline(new Error('network'), 1_000), 31_000);
});

void test('HTTP success with a business error is not counted as a usable response', async () => {
  const kinds: string[] = [];
  const client = new GmgnClient({
    baseUrl: 'https://openapi.gmgn.ai',
    apiKey: 'secret',
    transport: () =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: { code: 500, data: null, message: 'secret' }
      }),
    onObservation: (o) => kinds.push(o.kind)
  });
  await assert.rejects(client.read({ method: 'GET', path: '/v1/token/info' }), /business code/);
  assert.deepEqual(kinds, ['error']);
});

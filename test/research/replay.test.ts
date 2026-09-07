import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { replay } from '../../src/research/replay.js';
import { runtimeConfigSchema } from '../../src/config/load.js';
import { createMarketFact } from '../../src/gmgn/facts.js';
const token = '0x' + 'a'.repeat(40),
  pool = '0x' + 'b'.repeat(40);
const model = {
  version: 1,
  id: 'fixture',
  fields: { price: { source: 'info.price.price', ttl_ms: 10000, require_source_time: false } },
  parameters: {},
  price_field: 'price',
  activation: { op: 'gt', args: [{ field: 'price' }, { constant: 1 }] },
  confirmation: { constant: true },
  invalidation: { constant: false },
  reset: { constant: true },
  entry: { constant: true },
  max_opportunity_ms: 10000
};
const fact = (time: number, price: string) =>
  createMarketFact({
    request: { method: 'GET', path: '/v1/token/info', query: { address: token } },
    response: { data: { price: { price }, liquidity: '100', biggest_pool_address: pool } },
    purpose: 'legacy_formal',
    attemptId: String(time),
    queuedAtMs: time - 1,
    requestedAtMs: time - 1,
    receivedAtMs: time
  });
void test('offline replay is deterministic, rejects conflicting identities and ignores future returns', async () => {
  const input = {
    models: [model],
    facts: [fact(1000, '1.3')],
    frames: [{ token, poolRevision: pool, atMs: 1000 }],
    events: [],
    legacyConfig: runtimeConfigSchema.parse(parse(readFileSync('config.example.yaml', 'utf8')))
  };
  const result = await replay(input);
  assert.deepEqual(result, await replay(input));
  assert.deepEqual(result, await replay({ ...input, facts: [...input.facts, fact(2000, '0.5')] }));
  assert.equal(result.networkRequests, 0);
  assert.equal(result.promotion, 'NOT_EVALUATED');
  await assert.rejects(
    replay({ ...input, facts: [...input.facts, { ...input.facts[0]!, receivedAtMs: 2000 }] }),
    /CONFLICTING_FACT/
  );
});

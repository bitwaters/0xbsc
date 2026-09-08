import assert from 'node:assert/strict';
import test from 'node:test';
import { generateCandidates } from '../../src/research/candidates.js';
const template = {
  version: 1,
  id: 'candidate',
  fields: { price: { source: 'info.price.price', ttl_ms: 10000, require_source_time: false } },
  parameters: { threshold: 1 },
  price_field: 'price',
  activation: { op: 'gt', args: [{ field: 'price' }, { parameter: 'threshold' }] },
  confirmation: { constant: true },
  invalidation: { constant: false },
  reset: { constant: true },
  entry: { constant: true },
  max_opportunity_ms: 30000
};
const input = {
  developmentDatasetHash: 'a'.repeat(64),
  cutoffAtMs: 1000,
  observations: [1, 2, 3, 4].map((value) => ({ field: 'price', value, availableAtMs: 1000 })),
  groups: [
    {
      method: 'immediate',
      template,
      combinations: [
        { threshold: { kind: 'quantile', field: 'price', q: 0.5 } },
        { threshold: { kind: 'business', value: 4, rationale: 'registered comparison' } }
      ]
    }
  ]
};
void test('finite candidate generation is deterministic, complete and never uses future values', () => {
  const report = generateCandidates(input);
  assert.deepEqual(report, generateCandidates(input));
  assert.equal(report.candidates.length, 2);
  assert.equal(report.candidates[0]!.manifest.parameters.threshold, 2);
  assert.throws(() => generateCandidates({ ...input, cutoffAtMs: 999 }), /FUTURE/);
  assert.throws(() => generateCandidates({ ...input, groups: Array(4).fill(input.groups[0]) }));
  assert.equal(
    generateCandidates({
      ...input,
      observations: [],
      groups: [
        {
          ...input.groups[0],
          combinations: [{ threshold: { kind: 'quantile', field: 'unsupported', q: 0.5 } }]
        }
      ]
    }).status,
    'NO_PROMOTABLE_MODEL'
  );
});

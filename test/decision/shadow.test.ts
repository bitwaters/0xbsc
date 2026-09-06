import assert from 'node:assert/strict';
import test from 'node:test';
import { ShadowEvaluator, type ShadowPolicy } from '../../src/decision/shadow.js';
import type { RouteEvaluation } from '../../src/decision/runtime.js';
const policy = {
  enabled: true,
  minimum_buy_share: 0.6,
  confirmations: 3,
  minimum_spacing_seconds: 10,
  max_sample_age_seconds: 60,
  formal_threshold: 80,
  early_age_minutes: 15,
  early_observe_only: true
} as ShadowPolicy;
const info = {
  data: {
    price: {
      price: '1',
      buy_volume_1m: '70',
      sell_volume_1m: '30',
      buy_volume_5m: '300',
      sell_volume_5m: '200'
    }
  }
};
const evaluation = {
  route: 'new_launch',
  decision: 'observing',
  score: { score: 75, completeness: 1 },
  evidence: [{ family: 'attention' }],
  features: { ageMs: 3600_000, growthObserved: true, upwardTrend: true }
} as RouteEvaluation;
void test('V2 requires spaced market confirmation and never authorizes Telegram delivery', () => {
  const engine = new ShadowEvaluator(policy);
  assert.equal(engine.evaluate('0x', info, evaluation, 1000).candidateQualified, false);
  assert.equal(engine.evaluate('0x', info, evaluation, 1001).samples.length, 1);
  engine.evaluate('0x', info, evaluation, 11_000);
  const result = engine.evaluate('0x', info, evaluation, 21_000);
  assert.equal(result.candidateQualified, true);
  assert.equal(result.deliveryQualified, false);
  assert.equal(result.decisiveTriggerAtMs, 21_000);
  assert.equal(
    engine.evaluate('0x', info, evaluation, 31_000).decisiveTriggerAtMs,
    21_000,
    'persistent strength does not rejuvenate trigger'
  );
});
void test('early-age and missing flow inputs remain unqualified in shadow', () => {
  const engine = new ShadowEvaluator(policy);
  const early = { ...evaluation, features: { ...evaluation.features!, ageMs: 60_000 } };
  for (const t of [1000, 11_000, 21_000]) engine.evaluate('0x', info, early, t);
  assert.equal(engine.evaluate('0x', info, early, 22_000).candidateQualified, false);
  const missing = engine.evaluate('0x', { data: { price: { price: '1' } } }, evaluation, 31_000);
  assert.ok(missing.reasons.includes('flow_unconfirmed'));
});

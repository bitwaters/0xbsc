import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluatePaired,
  selectModel,
  type ValidationArm,
  type ValidationPair
} from '../../src/research/validation.js';
const arm = (win: boolean): ValidationArm => ({
  baselineValid: true,
  tp13: win ? 'TP' : 'SL',
  tp2: win ? 'TP' : 'SL',
  preparationFailed: false,
  roundTripLoss: 0.01,
  costEvidenceValid: true,
  postBuyValid: true,
  safetyBypassed: false
});
const pairs = (n: number): ValidationPair[] =>
  Array.from({ length: n }, (_, i) => ({
    token: '0x' + i.toString(16).padStart(40, '0'),
    model: arm(true),
    control: arm(false)
  }));
void test('small all-winning samples and missing preparation do not promote', () => {
  assert.equal(evaluatePaired(pairs(1), 'a'.repeat(64)).status, 'INCONCLUSIVE');
  const rows = pairs(100).map((p) => ({
    ...p,
    model: {
      ...arm(false),
      baselineValid: false,
      tp13: 'MISSING_BASELINE' as const,
      tp2: 'MISSING_BASELINE' as const,
      preparationFailed: true,
      costEvidenceValid: false,
      roundTripLoss: null,
      postBuyValid: false
    }
  }));
  const report = evaluatePaired(rows, 'a'.repeat(64));
  assert.equal(report.model.n, 100);
  assert.equal(report.status, 'INCONCLUSIVE');
  assert.throws(() => evaluatePaired([...pairs(1), ...pairs(1)], 'a'.repeat(64)), /DUPLICATE/);
});
void test('paired bootstrap is deterministic and cannot trade poorer costs for market TP', () => {
  const a = evaluatePaired(pairs(100), 'a'.repeat(64));
  assert.equal(a.status, 'PASS');
  assert.equal(a.promotionCertificate, false);
  assert.deepEqual(a, evaluatePaired(pairs(100), 'a'.repeat(64)));
  const expensive = pairs(100).map((p) => ({ ...p, model: { ...p.model!, roundTripLoss: 0.04 } }));
  assert.equal(evaluatePaired(expensive, 'a'.repeat(64)).status, 'FAIL');
});
void test('worst-case unknown allocation can eliminate apparent improvement', () => {
  const rows = pairs(100).map((p, i) => ({
    ...p,
    model: arm(i < 70),
    control:
      i < 80
        ? arm(i < 60)
        : { ...arm(false), baselineValid: false, tp13: 'UNKNOWN' as const, tp2: 'UNKNOWN' as const }
  }));
  assert.equal(evaluatePaired(rows, 'a'.repeat(64)).reason, 'INCONCLUSIVE_MISSINGNESS');
});
void test('selection requires common universe/control and deterministic tie break', () => {
  assert.equal(
    selectModel([{ hash: 'a'.repeat(64), conditions: 1, pairs: pairs(1) }]).status,
    'NO_PROMOTABLE_MODEL'
  );
  assert.equal(
    selectModel([
      { hash: 'b'.repeat(64), conditions: 1, pairs: pairs(100) },
      { hash: 'a'.repeat(64), conditions: 1, pairs: pairs(100) }
    ]).selectedHash,
    'a'.repeat(64)
  );
  assert.throws(
    () =>
      selectModel([
        { hash: 'b'.repeat(64), conditions: 1, pairs: pairs(100) },
        { hash: 'a'.repeat(64), conditions: 1, pairs: pairs(101) }
      ]),
    /CONTROL_OR_UNIVERSE_CHANGED/
  );
});

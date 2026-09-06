import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateDimensionLevels,
  dataTtlMs,
  decideRoute,
  isFreshField,
  passesFormalGate,
  requiredTtlMs,
  routeWindowsMs,
  scoreRoute
} from '../../src/decision/scoring.js';

const weights = {
  lifecycle: 20,
  structure: 25,
  capital: 25,
  attention: 15,
  quality: 10,
  freshness: 5
} as const;
const levels = {
  lifecycle: 1,
  structure: 1,
  capital: 1,
  attention: 0.5,
  quality: 0.5,
  freshness: 1
} as const;

void test('calculates three-level fixed scores and freshness-weighted completeness', () => {
  const result = scoreRoute(weights, levels, [
    { weight: 30, available: true, fresh: true },
    { weight: 70, available: true, fresh: false }
  ]);
  assert.equal(result.score, 87.5);
  assert.equal(result.completeness, 0.3);
  assert.equal(requiredTtlMs.creator, 3_600_000);
  assert.equal(dataTtlMs('kline'), 60_000);
  assert.equal(isFreshField('info', 70, 100), true);
  assert.equal(isFreshField('info', 69_999, 100_000), false);
  assert.deepEqual(
    aggregateDimensionLevels([
      { dimension: 'capital', source: 'smart_money', level: 0.5 },
      { dimension: 'capital', source: 'smart_money', level: 1 },
      { dimension: 'capital', source: 'kol', level: 0.5 },
      { dimension: 'attention', source: 'hot', level: 0.5 }
    ]),
    { lifecycle: 0, structure: 0, capital: 1, attention: 0.5, quality: 0, freshness: 0 }
  );
  assert.equal(
    scoreRoute(weights, levels, [
      { weight: 20, available: true, fresh: true },
      { weight: 30, available: false, fresh: false },
      { weight: 50, available: true, fresh: true }
    ]).completeness,
    0.7
  );
});

void test('formal gate requires score, completeness, independent evidence, and fresh trigger', () => {
  const qualified = { score: 80, completeness: 0.7 };
  assert.equal(passesFormalGate(qualified, 2, 100, 150, routeWindowsMs.new_launch), true);
  assert.equal(passesFormalGate(qualified, 1, 100, 150, routeWindowsMs.new_launch), false);
  assert.equal(passesFormalGate(qualified, 2, 0, 90_001, routeWindowsMs.new_launch), false);
  assert.equal(
    passesFormalGate({ score: 90, completeness: 0.69 }, 2, 100, 150, routeWindowsMs.new_launch),
    false
  );
});

void test('keeps 65+ candidates observing until all formal gates pass in their route window', () => {
  const thresholds = {
    observationThreshold: 65,
    formalThreshold: 80,
    minimumCompleteness: 0.7,
    decisiveWindowsMs: routeWindowsMs
  };
  assert.equal(
    decideRoute({ score: 64.99, completeness: 1 }, 2, 100, 100, 'new_launch', thresholds),
    'rejected'
  );
  assert.equal(
    decideRoute({ score: 65, completeness: 0.2 }, 1, null, 100, 'new_launch', thresholds),
    'observing'
  );
  assert.equal(
    decideRoute({ score: 80, completeness: 0.7 }, 2, 0, 90_000, 'new_launch', thresholds),
    'formal'
  );
  assert.equal(
    decideRoute({ score: 80, completeness: 0.7 }, 2, 0, 90_001, 'new_launch', thresholds),
    'observing'
  );
  assert.equal(
    decideRoute({ score: 80, completeness: 0.7 }, 2, 0, 120_000, 'revival', thresholds),
    'formal'
  );
  assert.equal(
    decideRoute({ score: 80, completeness: 0.7 }, 2, 0, 60_000, 'continuation', thresholds),
    'formal'
  );
});

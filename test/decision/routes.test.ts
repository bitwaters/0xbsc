import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyObservationRoute,
  classifyRoute,
  type RouteFeatures,
  type RouteThresholds
} from '../../src/decision/routes.js';

const thresholds: RouteThresholds = {
  newLaunchMaxAgeHours: 24,
  newLaunchMinLiquidityUsd: 10_000,
  revivalMinAgeHours: 24,
  revivalMinLiquidityUsd: 20_000,
  continuationMinLiquidityUsd: 30_000
};
const allFeatures: RouteFeatures = {
  ageMs: 24 * 3_600_000,
  liquidityUsd: 30_000,
  firstLaunchStage: true,
  validPool: true,
  realTrading: true,
  growthObserved: true,
  evidenceGatePassed: true,
  hasCompletedDormancy: true,
  revivalVolumeQualified: true,
  revivalSwapsQualified: true,
  structureBreakout: true,
  additionalRevivalConfirmation: true,
  upwardTrend: true,
  healthyPullback: true,
  restartVolume: true,
  smartMoneyExit: false,
  quoteDeteriorated: false,
  verticalPump: false
};

void test('assigns exactly one primary route in new-launch, revival, continuation priority order', () => {
  assert.equal(classifyRoute(allFeatures, thresholds), 'new_launch');
  assert.equal(
    classifyRoute(
      { ...allFeatures, ageMs: 24 * 3_600_000 + 1, firstLaunchStage: false },
      thresholds
    ),
    'revival'
  );
  assert.equal(
    classifyRoute(
      {
        ...allFeatures,
        ageMs: 24 * 3_600_000 + 1,
        firstLaunchStage: false,
        hasCompletedDormancy: false,
        revivalVolumeQualified: false
      },
      thresholds
    ),
    'continuation'
  );
});

void test('admits an old-token breakout only as a continuation observation candidate', () => {
  const momentum = {
    ...allFeatures,
    ageMs: 48 * 3_600_000,
    firstLaunchStage: false,
    hasCompletedDormancy: false,
    revivalVolumeQualified: false,
    revivalSwapsQualified: false,
    healthyPullback: false,
    restartVolume: false,
    verticalPump: true
  };
  assert.equal(classifyRoute(momentum, thresholds), null);
  assert.equal(classifyObservationRoute(momentum, thresholds), 'continuation');
  assert.equal(classifyObservationRoute({ ...momentum, liquidityUsd: 19_999 }, thresholds), null);
  assert.equal(classifyObservationRoute({ ...momentum, realTrading: false }, thresholds), null);
});

void test('respects age and liquidity boundaries and rejects incomplete route semantics', () => {
  assert.equal(classifyRoute({ ...allFeatures, liquidityUsd: 9_999.99 }, thresholds), null);
  assert.equal(
    classifyRoute({ ...allFeatures, validPool: false, upwardTrend: false }, thresholds),
    null
  );
  assert.equal(
    classifyRoute(
      { ...allFeatures, ageMs: 24 * 3_600_000 + 1, verticalPump: true, firstLaunchStage: false },
      thresholds
    ),
    'revival'
  );
  assert.equal(
    classifyRoute({ ...allFeatures, growthObserved: false, upwardTrend: false }, thresholds),
    null
  );
});
